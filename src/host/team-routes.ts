/** Authenticated, bounded HTTP adapter for the versioned Expert Teams wire API. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { authorizeManageRequest, resolveManageToken } from './auth.ts'
import type { TeamAction, TeamWireResponse } from '../team-wire.ts'
import type { PlanExecutionAuthorization } from '../plan-authorization.ts'

const PREFIX = '/plugins/dsh-expert-library/teams'
const MAX_BODY = 128 * 1024
const MAX_TEXT = 16 * 1024
const PATCH_FIELDS = new Set(['team_name', 'goal', 'data', 'city', 'period', 'profile', 'tasks', 'report_bundle'])

export interface TeamRouteRequest {
  readonly action: TeamAction
  readonly captainSessionId: string
  readonly teamId?: string
  readonly planId?: string
  readonly expectedDigest?: string
  readonly expectedRevision?: number
  readonly patch?: Record<string, unknown>
  readonly reason?: string
}
export interface TeamRouteTarget {
  readonly stateRoot: string
  /** Omitted for a staged plan that has not materialized a team yet. */
  readonly teamId?: string
  readonly planId?: string
  readonly captainSessionId: string
  readonly archived: boolean
}
export interface TeamRouteRuntime {
  readonly getToken?: () => string | undefined
  /** Native DSH HostConnection auth. Returns HTTP status when refused. */
  readonly hostAuth?: (request: IncomingMessage) => number | undefined
  /** Resolve fresh durable identity; return undefined for unknown/foreign ids. */
  readonly resolve: (captainSessionId: string, teamId?: string, planId?: string) => Promise<TeamRouteTarget | undefined>
  readonly read: (target: TeamRouteTarget) => Promise<TeamWireResponse>
  readonly action: (target: TeamRouteTarget, request: TeamRouteRequest) => Promise<TeamWireResponse>
  readonly authorization?: (captain: string, action: 'read' | 'authorize' | 'revoke', input?: Record<string, unknown>) => Promise<PlanExecutionAuthorization | undefined>
}

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}
function error(res: ServerResponse, status: number, code: string): void {
  // Deliberately fixed strings: route errors must not disclose paths, team ids,
  // stack traces or identity lookup details.
  reply(res, status, { version: 1, ok: false, error: { code, message: code } })
}
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  const text = Array.isArray(value) ? value[0] : value
  return typeof text === 'string' && text.trim() !== '' ? text.trim() : undefined
}
function validId(value: unknown): value is string {
  // Team ids are user-named and routinely Chinese (智见点评-…), so the class is
  // Unicode letters/digits plus the ASCII punctuation already in use. Path
  // safety (readTeam joins `<stateRoot>/<teamId>/team.json`) holds because the
  // class admits no separators, and whole-segment `.`/`..` are rejected.
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value !== '.' && value !== '..'
    && /^[\p{L}\p{N}._:-]+$/u.test(value)
}
function sameOrigin(req: IncomingMessage): boolean {
  const origin = header(req, 'origin')
  // A missing Origin is allowed for non-browser local clients; the literal
  // `null` origin is never same-origin and must not bypass CSRF protection.
  if (origin === 'null') return false
  if (origin === undefined) return true
  const host = header(req, 'host')
  try { return host !== undefined && new URL(origin).host === host && /^https?:$/u.test(new URL(origin).protocol) } catch { return false }
}
async function body(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []; let size = 0; let done = false
    const finish = (value: Record<string, unknown> | undefined) => { if (!done) { done = true; resolve(value) } }
    req.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > MAX_BODY) finish(undefined); else chunks.push(Buffer.from(chunk)) })
    req.on('error', () => finish(undefined))
    req.on('end', () => { try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); finish(typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined) } catch { finish(undefined) } })
  })
}
function parseRequest(input: Record<string, unknown>): TeamRouteRequest | undefined {
  const action = input.action
  const captainSessionId = input.captainSessionId
  if (!['edit', 'approve', 'discard', 'halt', 'resume', 'archive'].includes(String(action)) || !validId(captainSessionId)) return undefined
  if ((input.teamId !== undefined && !validId(input.teamId)) || (input.planId !== undefined && !validId(input.planId))) return undefined
  const patch = input.patch
  if (patch !== undefined && (typeof patch !== 'object' || patch === null || Array.isArray(patch))) return undefined
  if (patch !== undefined && Object.keys(patch as Record<string, unknown>).some(key => !PATCH_FIELDS.has(key))) return undefined
  for (const value of Object.values((patch ?? {}) as Record<string, unknown>)) if (typeof value === 'string' && value.length > MAX_TEXT) return undefined
  const expectedRevision = Number.isSafeInteger(input.expectedRevision) ? input.expectedRevision as number : undefined
  const expectedDigest = typeof input.expectedDigest === 'string' && input.expectedDigest.trim() !== '' ? input.expectedDigest.trim() : undefined
  if ((action === 'edit' || action === 'approve' || action === 'discard')
    && (!validId(input.planId) || expectedDigest === undefined || expectedRevision === undefined || expectedRevision < 0)) return undefined
  return { action: action as TeamAction, captainSessionId, ...(validId(input.teamId) ? { teamId: input.teamId } : {}), ...(validId(input.planId) ? { planId: input.planId } : {}), ...(expectedDigest === undefined ? {} : { expectedDigest }), ...(expectedRevision === undefined ? {} : { expectedRevision }), ...(patch === undefined ? {} : { patch: patch as Record<string, unknown> }), ...(typeof input.reason === 'string' ? { reason: input.reason.slice(0, MAX_TEXT) } : {}) }
}

/** Handle `/plugins/dsh-expert-library/teams` and its subpaths. */
export async function handleTeamRoutes(req: IncomingMessage, res: ServerResponse, url: URL, runtime: TeamRouteRuntime): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/u, '')
  if (path !== PREFIX) return false
  const nativeAuth = runtime.hostAuth?.(req)
  if (nativeAuth !== undefined) { error(res, nativeAuth === 403 ? 403 : 401, nativeAuth === 403 ? 'TEAM_FORBIDDEN' : 'TEAM_UNAUTHORIZED'); return true }
  // When the host supplies its native browser predicate, an undefined result
  // means the signed browser session and Host/Origin fence already passed.
  // Do not apply the legacy loopback/token fence afterward: public DSH Web
  // requests legitimately use a remote authority and no plugin token.
  if (runtime.hostAuth === undefined) {
    const auth = authorizeManageRequest({ headers: req.headers, remoteAddress: req.socket?.remoteAddress }, resolveManageToken(runtime.getToken?.()))
    if (!auth.ok) { error(res, 401, 'TEAM_UNAUTHORIZED'); return true }
  }
  const method = req.method ?? 'GET'
  if (method === 'GET') {
    const captain = url.searchParams.get('captainSessionId')
    const teamId = url.searchParams.get('teamId') ?? undefined
    const planId = url.searchParams.get('planId') ?? undefined
    if (!validId(captain) || (teamId !== undefined && !validId(teamId)) || (planId !== undefined && !validId(planId))) { error(res, 400, 'TEAM_INVALID_INPUT'); return true }
    if (url.searchParams.get('authorization') === '1') {
      if (teamId !== undefined || planId !== undefined || runtime.authorization === undefined) { error(res, 400, 'TEAM_INVALID_INPUT'); return true }
      try { reply(res, 200, { version: 1, authorization: await runtime.authorization(captain, 'read') ?? null }) }
      catch { error(res, 400, 'PLAN_AUTHORIZATION_FAILED') }
      return true
    }
    const target = await runtime.resolve(captain, teamId, planId)
    if (target === undefined || target.captainSessionId !== captain) { error(res, 404, 'TEAM_NOT_FOUND'); return true }
    try { reply(res, 200, await runtime.read(target)) } catch { error(res, 400, 'TEAM_ACTION_FAILED') }
    return true
  }
  if (method !== 'POST') { error(res, 405, 'TEAM_METHOD_NOT_ALLOWED'); return true }
  if (!sameOrigin(req)) { error(res, 403, 'TEAM_CSRF_REJECTED'); return true }
  const parsed = await body(req)
  if (parsed === undefined) { error(res, 413, 'TEAM_BODY_TOO_LARGE'); return true }
  if (parsed.action === 'authorize-plan-execution' || parsed.action === 'revoke-plan-execution') {
    if (runtime.authorization === undefined || !validId(parsed.captainSessionId) || parsed.teamId !== undefined || parsed.planId !== undefined) { error(res, 400, 'TEAM_INVALID_INPUT'); return true }
    try { reply(res, 200, { version: 1, ok: true, authorization: await runtime.authorization(parsed.captainSessionId,
      parsed.action === 'authorize-plan-execution' ? 'authorize' : 'revoke', parsed) ?? null }) }
    catch (cause) { const detail = cause instanceof Error ? cause.message : ''; error(res, /EXISTS|CONFLICT|MISMATCH/u.test(detail) ? 409 : 400, 'PLAN_AUTHORIZATION_FAILED') }
    return true
  }
  const request = parseRequest(parsed)
  if (request === undefined) { error(res, 400, 'TEAM_INVALID_INPUT'); return true }
  const target = await runtime.resolve(request.captainSessionId, request.teamId, request.planId)
  if (target === undefined || target.captainSessionId !== request.captainSessionId) { error(res, 404, 'TEAM_NOT_FOUND'); return true }
  try { reply(res, 200, { ok: true, ...(await runtime.action(target, request)) }) } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : ''
    const code = /digest|revision|CAS|stale/u.test(message) ? 'TEAM_CAS_CONFLICT' : /not found/u.test(message) ? 'TEAM_NOT_FOUND' : 'TEAM_ACTION_FAILED'
    error(res, code === 'TEAM_CAS_CONFLICT' ? 409 : code === 'TEAM_NOT_FOUND' ? 404 : 400, code)
  }
  return true
}

export { PREFIX as TEAM_ROUTES_PREFIX }
