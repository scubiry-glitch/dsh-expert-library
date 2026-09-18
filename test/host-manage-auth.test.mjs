/**
 * Write-surface authorization tests for `/plugins/dsh-expert-library/manage/*`.
 *
 * The fence exists because the Harness browser-auth gate does not cover
 * `/plugins/*` (measured on the live rc.1 gateway: `GET /` → 401 without a
 * cookie, the manage route → 200). The load-bearing case is the reverse-proxy
 * one: nginx terminates the public domain on this same host, so a public
 * request arrives from 127.0.0.1 with a loopback-looking socket — only the
 * authority plus the forwarding headers tell the two apart.
 *
 * Hermetic: no network, no real credentials (sentinel token strings only).
 *
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MANAGE_TOKEN_ENV,
  MANAGE_TOKEN_HEADER,
  authorityHostname,
  authorizeManageRequest,
  isLoopbackAddress,
  resolveManageToken,
} from '../lib/host/auth.js'

const TOKEN = 'sentinel-manage-token-not-a-real-secret'

/** Build a request view with sane loopback defaults. */
function request(overrides = {}) {
  const { headers = {}, remoteAddress = '127.0.0.1', ...rest } = overrides
  return { headers: { host: '127.0.0.1:3080', ...headers }, remoteAddress, ...rest }
}

// ── 1. Authority parsing ────────────────────────────────────────────────────

test('authorityHostname strips the port, lowercases, and unwraps IPv6 brackets', () => {
  assert.equal(authorityHostname('127.0.0.1:3080'), '127.0.0.1')
  assert.equal(authorityHostname('LOCALHOST:3080'), 'localhost')
  assert.equal(authorityHostname('[::1]:3080'), '::1')
  assert.equal(authorityHostname('[::1]'), '::1')
  assert.equal(authorityHostname('yy.meizu.life'), 'yy.meizu.life')
  // A bare IPv6 literal has no port to strip — several colons is not a port.
  assert.equal(authorityHostname('::1'), '::1')
  assert.equal(authorityHostname(''), undefined)
  assert.equal(authorityHostname(undefined), undefined)
})

test('isLoopbackAddress accepts the whole 127/8 block and IPv4-mapped forms', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.1.2.3'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('10.0.0.1'), false)
  assert.equal(isLoopbackAddress('192.168.1.5'), false)
  assert.equal(isLoopbackAddress(undefined), false)
})

// ── 2. Loopback is admitted ─────────────────────────────────────────────────

test('a plain loopback request is admitted', () => {
  const decision = authorizeManageRequest(request(), undefined)
  assert.equal(decision.ok, true)
  assert.equal(decision.via, 'loopback')
})

test('localhost and bracketed IPv6 loopback are admitted too', () => {
  assert.equal(authorizeManageRequest(request({ headers: { host: 'localhost:3080' } }), undefined).ok, true)
  assert.equal(authorizeManageRequest(request({ headers: { host: '[::1]:3080' } }), undefined).ok, true)
})

// ── 3. The reverse-proxy case (the reason this module exists) ───────────────

test('a forwarded request is refused even though its socket is loopback', () => {
  // nginx proxies the public domain to 127.0.0.1:3080, so remoteAddress is
  // loopback here — the forwarding header is the only honest signal.
  const decision = authorizeManageRequest(request({
    headers: { host: '127.0.0.1:3080', 'x-forwarded-for': '203.0.113.7' },
  }), undefined)
  assert.equal(decision.ok, false)
  assert.match(decision.reason, /forwarded/)
})

test('a forwarded request is refused even when its authority claims loopback', () => {
  // Host-rewrite bypass attempt: authority says 127.0.0.1, but the hop left
  // its mark. Must not be trusted.
  for (const header of ['x-real-ip', 'forwarded', 'cf-connecting-ip', 'x-forwarded-host']) {
    const decision = authorizeManageRequest(request({ headers: { host: '127.0.0.1:3080', [header]: 'x' } }), undefined)
    assert.equal(decision.ok, false, `${header} must disqualify loopback trust`)
  }
})

test('the public authority is refused without a token', () => {
  const decision = authorizeManageRequest(request({ headers: { host: 'yy.meizu.life' } }), undefined)
  assert.equal(decision.ok, false)
  assert.match(decision.reason, /non-loopback/)
})

test('a loopback authority on a non-loopback socket is refused', () => {
  const decision = authorizeManageRequest(request({ remoteAddress: '10.1.2.3' }), undefined)
  assert.equal(decision.ok, false)
})

// ── 4. Token admits remote access ───────────────────────────────────────────

test('a valid token admits a non-loopback request', () => {
  const decision = authorizeManageRequest(
    request({ headers: { host: 'yy.meizu.life', [MANAGE_TOKEN_HEADER]: TOKEN } }),
    TOKEN,
  )
  assert.equal(decision.ok, true)
  assert.equal(decision.via, 'token')
})

test('an Authorization: Bearer token is accepted as well', () => {
  const decision = authorizeManageRequest(
    request({ headers: { host: 'yy.meizu.life', authorization: `Bearer ${TOKEN}` } }),
    TOKEN,
  )
  assert.equal(decision.ok, true)
  assert.equal(decision.via, 'token')
})

test('a forwarded request carrying the token is admitted as a remote operator', () => {
  // The token path is exactly how a deliberate remote operator gets in, so a
  // forwarding hop must not disqualify it.
  const decision = authorizeManageRequest(
    request({ headers: { host: 'yy.meizu.life', 'x-forwarded-for': '203.0.113.7', [MANAGE_TOKEN_HEADER]: TOKEN } }),
    TOKEN,
  )
  assert.equal(decision.ok, true)
  assert.equal(decision.via, 'token')
})

// ── 5. Fail-closed on every near miss ───────────────────────────────────────

test('a wrong token is refused, including a same-prefix and an empty one', () => {
  for (const presented of [`${TOKEN}-x`, TOKEN.slice(0, -1), '', 'x']) {
    const decision = authorizeManageRequest(
      request({ headers: { host: 'yy.meizu.life', [MANAGE_TOKEN_HEADER]: presented } }),
      TOKEN,
    )
    assert.equal(decision.ok, false, `token ${JSON.stringify(presented)} must not be admitted`)
  }
})

test('a token presentation that is missing entirely is refused', () => {
  const decision = authorizeManageRequest(request({ headers: { host: 'yy.meizu.life' } }), TOKEN)
  assert.equal(decision.ok, false)
})

test('an unset or blank token leaves the surface loopback-only', () => {
  for (const configured of [undefined, '', '   ']) {
    const decision = authorizeManageRequest(
      request({ headers: { host: 'yy.meizu.life', [MANAGE_TOKEN_HEADER]: TOKEN } }),
      configured,
    )
    assert.equal(decision.ok, false, 'no configured token must mean no remote access at all')
  }
})

// ── 6. Token resolution ─────────────────────────────────────────────────────

test('resolveManageToken prefers the environment over config and trims', () => {
  const previous = process.env[MANAGE_TOKEN_ENV]
  try {
    process.env[MANAGE_TOKEN_ENV] = `  ${TOKEN}  `
    assert.equal(resolveManageToken('from-config'), TOKEN)
    delete process.env[MANAGE_TOKEN_ENV]
    assert.equal(resolveManageToken('  from-config  '), 'from-config')
    assert.equal(resolveManageToken(''), undefined)
    assert.equal(resolveManageToken('   '), undefined)
    assert.equal(resolveManageToken(undefined), undefined)
  } finally {
    if (previous === undefined) delete process.env[MANAGE_TOKEN_ENV]
    else process.env[MANAGE_TOKEN_ENV] = previous
  }
})
