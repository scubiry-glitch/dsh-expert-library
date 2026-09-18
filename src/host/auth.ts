/**
 * Authorization for the plugin's write surface (`/plugins/dsh-expert-library/manage/*`).
 *
 * Why this exists (verified 2026-09-18 against the running gateway):
 * Harness rc.1 mounts a browser-auth gate, but it covers only the index and
 * RPC surfaces — `/plugins/*` is **not** gated. Measured on the live process:
 * `GET /` without a cookie → 401, while
 * `GET /plugins/dsh-expert-library/manage/knowledge-roots` without a cookie →
 * 200, on both the loopback and the public authority. Every `/manage/*` route
 * (including the skill-zip install) is therefore reachable unauthenticated
 * from the public internet, and the plugin owns its own fence.
 *
 * Loopback alone cannot be the test: nginx terminates the public domain on the
 * same machine and proxies to 127.0.0.1:3080, so `remoteAddress` is loopback
 * for public traffic too. The discriminator is the request authority — the
 * same signal rc.1's own BrowserAuth binds its session cookie to — combined
 * with the absence of forwarding headers.
 *
 * The platform does not expose its own predicate to plugins (`browserAuth` is
 * private to HostConnectionService), and this dependency tree is a deliberate
 * rc.1/rc.8 mix, so reaching into it would be fragile as well as unavailable.
 *
 * @module dsh-expert-library/host/auth
 */

import { timingSafeEqual } from 'node:crypto'

/** Hostnames that mean "this process's own loopback listener". */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * Headers that prove an intermediary forwarded the request. Their presence
 * disqualifies loopback trust: a reverse-proxied public request arrives from
 * 127.0.0.1, and this is what tells the two apart.
 */
const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
] as const

/** Header carrying the shared manage token (checked before `authorization`). */
export const MANAGE_TOKEN_HEADER = 'x-expert-library-manage-token'

/** Environment variable read as the manage token when config has none. */
export const MANAGE_TOKEN_ENV = 'DSH_EXPERT_LIBRARY_MANAGE_TOKEN'

/** The minimal request surface the decision needs (keeps this module pure). */
export interface ManageAuthRequest {
  readonly headers: Record<string, string | string[] | undefined>
  /** `req.socket.remoteAddress`; absent when the carrier is not a socket. */
  readonly remoteAddress?: string | undefined
}

/** Why a request was admitted, or why it was refused. */
export type ManageAuthOutcome =
  | { readonly ok: true; readonly via: 'loopback' | 'token' }
  | { readonly ok: false; readonly reason: string }

/** First value of a possibly-repeated header, trimmed. */
function headerValue(headers: ManageAuthRequest['headers'], name: string): string | undefined {
  const raw = headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Hostname of an HTTP authority, port stripped and lowercased. Bracketed IPv6
 * (`[::1]:3080`) and a bare `[::1]` both reduce to `::1`.
 */
export function authorityHostname(authority: string | undefined): string | undefined {
  if (authority === undefined) return undefined
  const value = authority.trim().toLowerCase()
  if (value === '') return undefined
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? undefined : value.slice(1, end)
  }
  const colon = value.lastIndexOf(':')
  // A single colon with digits after it is a port; anything else (several
  // colons) is a bare IPv6 literal, which has no port to strip.
  if (colon !== -1 && value.indexOf(':') === colon) return value.slice(0, colon)
  return value
}

/** Whether an address is a loopback literal, including IPv4-mapped IPv6. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const value = address.trim().toLowerCase()
  if (value === '::1') return true
  const mapped = value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value
  if (mapped === '127.0.0.1') return true
  // 127.0.0.0/8 is loopback in full.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(mapped)
}

/** Constant-time token comparison that never throws on a length mismatch. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Read the presented token: dedicated header first, then `Authorization: Bearer`. */
function presentedToken(headers: ManageAuthRequest['headers']): string | undefined {
  const direct = headerValue(headers, MANAGE_TOKEN_HEADER)
  if (direct !== undefined) return direct
  const authorization = headerValue(headers, 'authorization')
  if (authorization === undefined) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(authorization)
  return match?.[1]?.trim()
}

/**
 * Decide whether one `/manage/*` request may proceed. Fail-closed: anything
 * that is not provably local, or provably holding the token, is refused.
 *
 * @param req - request headers and the carrier's remote address.
 * @param token - configured shared token; empty/undefined disables remote access entirely.
 * @returns the decision, with the reason on refusal.
 */
export function authorizeManageRequest(
  req: ManageAuthRequest,
  token: string | undefined,
): ManageAuthOutcome {
  const forwarded = FORWARDING_HEADERS.find(name => headerValue(req.headers, name) !== undefined)
  if (forwarded === undefined) {
    const hostname = authorityHostname(headerValue(req.headers, 'host'))
    if (hostname !== undefined && LOOPBACK_HOSTNAMES.has(hostname) && isLoopbackAddress(req.remoteAddress)) {
      return { ok: true, via: 'loopback' }
    }
  }

  // A forwarded request is never local, even when its authority claims to be:
  // the forwarding header is the one signal a loopback authority cannot fake.
  const expected = token?.trim() ?? ''
  if (expected !== '') {
    const presented = presentedToken(req.headers)
    if (presented !== undefined && tokenMatches(presented, expected)) {
      return { ok: true, via: 'token' }
    }
    return { ok: false, reason: forwarded === undefined ? 'non-loopback authority' : `forwarded (${forwarded})` }
  }
  return {
    ok: false,
    reason: forwarded !== undefined
      ? `forwarded (${forwarded}) and no manage token is configured`
      : 'non-loopback authority and no manage token is configured',
  }
}

/**
 * Resolve the manage token: environment first (preferred — keeps the secret
 * out of the settings file), then explicit config. Never logged.
 *
 * @param configured - token from plugin config, when the operator set one.
 */
export function resolveManageToken(configured: string | undefined): string | undefined {
  const fromEnv = process.env[MANAGE_TOKEN_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const value = configured?.trim()
  return value === undefined || value === '' ? undefined : value
}
