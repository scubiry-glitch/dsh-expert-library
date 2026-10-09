/** Standalone center HTTP boundary. No DSH cookies, Host-derived redirects,
 * bootstrap route, session bypass or in-process Git/worker execution. */
import { createServer, type IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { CenterDatabase } from './database.js'
import { IdentityError, type IdentityService, type HumanPrincipal, type OrganizationRole } from './auth.js'
import type { createSubmissionService, SubmissionInput } from './submissions.js'
import { createDistributionHandler, isDistributionHostRequest, type DistributionHttpOptions } from './distribution-http.js'
import type { CatalogPrincipal } from './catalog.js'
import { createWebHandler } from './web.js'

export interface CenterServerOptions {
  database: CenterDatabase
  identity: IdentityService
  submissions: ReturnType<typeof createSubmissionService>
  publicOrigin: string
  /** An explicit development option; still restricted to loopback HTTP. */
  allowLoopbackHttp?: boolean
  maxBodyBytes?: number
  distribution?: DistributionHttpOptions
}
class HttpError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}
type Body = Record<string, unknown>
function fields(body: Body, permitted: readonly string[]) {
  if (Object.keys(body).some(key => !permitted.includes(key))) throw new HttpError('INVALID_INPUT', 400)
}
function string(body: Body, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || !value.length) throw new HttpError('INVALID_INPUT', 400)
  return value
}
function expectedVersion(body: Body) {
  const value = body.expectedVersion
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new HttpError('INVALID_INPUT', 400)
  return value
}
function requestKey(request: IncomingMessage) {
  const value = request.headers['idempotency-key']
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) throw new HttpError('IDEMPOTENCY_KEY_REQUIRED', 400)
  return value
}
function query(url: URL, allowed: string[]) {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError('INVALID_INPUT', 400)
}
function cookie(request: IncomingMessage, name: string): string | undefined {
  const matching = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.slice(0, value.indexOf('=')) === name)
  if (matching.length > 1) throw new HttpError('COOKIE_INVALID', 400)
  return matching[0]?.slice(name.length + 1)
}
async function jsonBody(request: IncomingMessage, limit: number): Promise<Body> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new HttpError('JSON_REQUIRED', 415)
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new HttpError('CONTENT_ENCODING_UNSUPPORTED', 415)
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) { request.resume(); throw new HttpError('BODY_TOO_LARGE', 413) }
  const chunks: Buffer[] = []; let size = 0
  await new Promise<void>((resolve, reject) => {
    let finished = false
    request.on('data', chunk => {
      if (finished) return
      const bytes = Buffer.from(chunk); size += bytes.length
      if (size > limit) { finished = true; chunks.length = 0; reject(new HttpError('BODY_TOO_LARGE', 413)); return }
      chunks.push(bytes)
    })
    request.on('end', () => { if (!finished) { finished = true; resolve() } })
    request.on('error', () => { if (!finished) { finished = true; reject(new HttpError('BODY_INVALID', 400)) } })
    request.on('aborted', () => { if (!finished) { finished = true; reject(new HttpError('BODY_INVALID', 400)) } })
  })
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('Expected object')
    return value
  } catch { throw new HttpError('JSON_INVALID', 400) }
}
function classify(error: unknown): { code: string; status: number; message: string } {
  const value = error as { code?: unknown; status?: unknown; statusCode?: unknown }
  let code = typeof value?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ? value.code : 'INTERNAL_ERROR'
  const candidate = value?.status ?? value?.statusCode
  let status = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500
  if (value?.code === '23505') { code = 'RESOURCE_CONFLICT'; status = 409 }
  if (value?.code === '23503' || value?.code === '23514') { code = 'INVALID_INPUT'; status = 400 }
  if (['INVALID_CONTRACT', 'INVALID_VERSION', 'INVALID_SEMVER', 'INVALID_CANONICAL_VALUE', 'INVALID_INPUT'].includes(code)) status = 400
  if (error instanceof URIError) { code = 'INVALID_URL'; status = 400 }
  const message = status === 401 ? 'Authentication is required.' : status === 403 ? 'This request is not permitted.'
    : status === 404 ? 'Resource not found.' : status === 409 ? 'Resource changed or conflicts with this request.'
      : status >= 500 ? 'The service could not complete the request.' : 'The request is invalid.'
  return { code, status, message }
}

export function createCenterServer(options: CenterServerOptions) {
  const origin = new URL(options.publicOrigin)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
  const secure = origin.protocol === 'https:'
  if (origin.username || origin.password || origin.hash || origin.search || origin.pathname !== '/' || (!secure && !(options.allowLoopbackHttp === true && loopback && origin.protocol === 'http:'))) {
    throw new Error('Center HTTP requires an HTTPS public origin; development HTTP requires explicit loopback opt-in')
  }
  const limit = options.maxBodyBytes ?? 131072
  if (!Number.isSafeInteger(limit) || limit < 1024 || limit > 1048576) throw new Error('Invalid HTTP body limit')
  const names = {
    session: secure ? '__Host-pack-center-session' : 'pack-center-dev-session',
    csrf: secure ? '__Host-pack-center-csrf' : 'pack-center-dev-csrf',
    login: secure ? '__Host-pack-center-login' : 'pack-center-dev-login',
  }
  const serializeCookie = (name: string, value: string, expiresAt: Date, httpOnly: boolean) => `${name}=${value}; Path=/; SameSite=Lax; Expires=${expiresAt.toUTCString()}${httpOnly ? '; HttpOnly' : ''}${secure ? '; Secure' : ''}`
  const expired = new Date(0)
  const clear = (name: string, httpOnly: boolean) => serializeCookie(name, '', expired, httpOnly)
  const { identity, submissions, database } = options
  const distribution = options.distribution && createDistributionHandler(options.distribution)
  const web = createWebHandler()

  const server = createServer(async (request, response) => {
    const requestId = randomUUID()
    let actor: CatalogPrincipal | undefined
    let route = 'unknown'
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Pragma', 'no-cache')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    response.setHeader('X-Request-Id', requestId)
    if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000')
    function send(status: number, body: unknown) {
      response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(body))
    }
    async function authenticated(mutation = false): Promise<HumanPrincipal> {
      const token = cookie(request, names.session)
      if (!token) throw new IdentityError('UNAUTHENTICATED', 'Authentication is required', 401)
      const principal = await identity.authenticateSession(token, { requireCsrf: mutation, csrfToken: typeof request.headers['x-csrf-token'] === 'string' ? request.headers['x-csrf-token'] : undefined })
      actor = principal
      return principal
    }
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new HttpError('INVALID_URL', 400)
      const rawPath = decodeURIComponent(request.url.split('?')[0]!)
      if (rawPath.includes('\\') || rawPath.includes('\0') || /(?:^|\/)\.\.?(?:\/|$)/.test(rawPath)) throw new HttpError('INVALID_URL', 400)
      const url = new URL(request.url, origin.origin)
      if (url.origin !== origin.origin || url.username || url.password || url.hash) throw new HttpError('INVALID_URL', 400)
      const path = url.pathname
      const method = request.method ?? ''
      const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method)
      if (method === 'OPTIONS') throw new HttpError('CORS_DENIED', 403)
      if (request.headers.authorization !== undefined && request.headers.cookie !== undefined) throw new HttpError('AMBIGUOUS_AUTHENTICATION', 400)
      // A Bearer header must never fall back to human cookies or legacy routes.
      if (request.headers.authorization !== undefined && (!distribution || !path.startsWith('/api/v1/'))) throw new HttpError('HUMAN_AUTHENTICATION_REQUIRED', 403)
      // Callback navigation is cross-site by design. No other endpoint supports
      // CORS; browser mutations require an exact Origin. Narrow, authenticated
      // host distribution routes and one-time binding exchange have no browser headers.
      const publicDocument = path === '/' && ['GET', 'HEAD'].includes(method)
      if (path !== '/api/auth/callback' && !publicDocument && !(distribution && isDistributionHostRequest(request, url))) {
        if ((mutation && request.headers.origin !== origin.origin) || (request.headers.origin && request.headers.origin !== origin.origin)
          || request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError('ORIGIN_DENIED', 403)
      }
      if (distribution && await distribution({ request, response, url, method, human: authenticated,
        machine: async token => { const principal = await options.distribution!.deployments.authenticateToken(token); actor = principal; return principal },
        jsonBody: () => jsonBody(request, limit), send, requestKey: () => requestKey(request), setRoute: label => { route = label } })) return
      if (web(url, method, response)) return
      if (path === '/health' && method === 'GET') { route = 'health'; query(url, []); send(200, { status: 'ok' }); return }
      if (path === '/api/auth/login' && method === 'POST') {
        route = 'auth.login'; query(url, [])
        const body = await jsonBody(request, limit); fields(body, ['invitationToken'])
        if (body.invitationToken !== undefined && typeof body.invitationToken !== 'string') throw new HttpError('INVALID_INPUT', 400)
        const login = await identity.beginLogin({ invitationToken: body.invitationToken as string | undefined })
        response.setHeader('Set-Cookie', serializeCookie(names.login, login.loginCookie, login.expiresAt, true))
        send(200, { authorizationUrl: login.authorizationUrl, expiresAt: login.expiresAt }); return
      }
      if (path === '/api/auth/callback' && method === 'GET') {
        route = 'auth.callback'
        const loginCookie = cookie(request, names.login)
        response.setHeader('Set-Cookie', clear(names.login, true))
        if (!loginCookie) throw new IdentityError('OIDC_LOGIN_FAILED', 'Login browser cookie is missing', 401)
        const result = await identity.finishLogin({ callbackUrl: url.href, loginCookie })
        response.setHeader('Set-Cookie', [clear(names.login, true), serializeCookie(names.session, result.sessionToken, result.expiresAt, true), serializeCookie(names.csrf, result.csrfToken, result.expiresAt, false)])
        // Only browser navigation changes to HTML flow; API clients retain JSON.
        // Fixed local redirect: never echo arbitrary returnTo/query/Host values.
        if (/(?:^|,)\s*text\/html(?:\s*;|\s*,|\s*$)/i.test(request.headers.accept ?? '')) {
          response.statusCode = 303; response.setHeader('Location', '/'); response.end(); return
        }
        send(200, { principal: result.principal, csrfToken: result.csrfToken, expiresAt: result.expiresAt }); return
      }
      if (path === '/api/me' && method === 'GET') {
        route = 'auth.me'; query(url, [])
        send(200, { principal: await authenticated(), csrfCookieName: names.csrf }); return
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        route = 'auth.logout'; query(url, []); await authenticated(true)
        fields(await jsonBody(request, limit), [])
        await identity.revokeSession(cookie(request, names.session)!)
        response.setHeader('Set-Cookie', [clear(names.session, true), clear(names.csrf, false), clear(names.login, true)])
        send(200, { loggedOut: true }); return
      }
      if (path === '/api/organizations' && ['GET', 'POST'].includes(method)) {
        route = 'organizations'; query(url, []); const principal = await authenticated(mutation)
        if (method === 'GET') send(200, { items: await identity.listOrganizations(principal) })
        else {
          const body = await jsonBody(request, limit); fields(body, ['id', 'slug', 'name'])
          send(201, await identity.createOrganization(principal, { id: string(body, 'id'), slug: string(body, 'slug'), name: string(body, 'name') }))
        }
        return
      }
      const orgRoute = /^\/api\/organizations\/([^/]+)\/(members|invitations|status|review-scopes)$/.exec(path)
      if (orgRoute && ['GET', 'POST'].includes(method)) {
        route = `organizations.${orgRoute[2]}`; query(url, []); const principal = await authenticated(mutation)
        const organizationId = decodeURIComponent(orgRoute[1]!)
        if (method === 'GET') {
          if (orgRoute[2] === 'members') send(200, { items: await identity.listMemberships(principal, organizationId) })
          else if (orgRoute[2] === 'invitations') send(200, { items: await identity.listInvitations(principal, organizationId) })
          else throw new HttpError('NOT_FOUND', 404)
          return
        }
        const body = await jsonBody(request, limit)
        if (orgRoute[2] === 'members') {
          fields(body, ['userId', 'roles', 'status'])
          await identity.setMembership(principal, { organizationId, userId: string(body, 'userId'), roles: body.roles as OrganizationRole[], status: string(body, 'status') as 'active' | 'disabled' })
          send(200, { updated: true })
        } else if (orgRoute[2] === 'invitations') {
          fields(body, ['roles', 'expiresInMs'])
          send(201, await identity.createInvitation(principal, { organizationId, roles: body.roles as OrganizationRole[], expiresInMs: body.expiresInMs as number | undefined }))
        } else if (orgRoute[2] === 'status') {
          fields(body, ['status'])
          await identity.setOrganizationStatus(principal, { organizationId, status: string(body, 'status') as 'active' | 'disabled' }); send(200, { updated: true })
        } else {
          fields(body, ['reviewerId', 'granted'])
          await identity.setReviewScope(principal, { organizationId, reviewerId: string(body, 'reviewerId'), granted: body.granted as boolean }); send(200, { updated: true })
        }
        return
      }
      const invitation = /^\/api\/invitations\/([^/]+)\/revoke$/.exec(path)
      if (invitation && method === 'POST') {
        route = 'invitations.revoke'; query(url, []); const principal = await authenticated(true); fields(await jsonBody(request, limit), [])
        await identity.revokeInvitation(principal, decodeURIComponent(invitation[1]!)); send(200, { revoked: true }); return
      }
      const user = /^\/api\/users\/([^/]+)\/(status|developer)$/.exec(path)
      if (user && method === 'POST') {
        route = `users.${user[2]}`; query(url, []); const principal = await authenticated(true); const body = await jsonBody(request, limit)
        const targetUser = decodeURIComponent(user[1]!)
        if (user[2] === 'status') {
          fields(body, ['status'])
          await identity.setUserStatus(principal, { userId: targetUser, status: string(body, 'status') as 'active' | 'disabled' }); send(200, { updated: true }); return
        }
        fields(body, ['developer'])
        if (typeof body.developer !== 'boolean') throw new HttpError('INVALID_INPUT', 400)
        await identity.setDeveloper(principal, { userId: targetUser, developer: body.developer }); send(200, { updated: true }); return
      }
      const userPermission = /^\/api\/users\/([^/]+)\/(platform-admin|permissions)$/.exec(path)
      if (userPermission) {
        const targetUser = decodeURIComponent(userPermission[1]!)
        if (userPermission[2] === 'permissions' && method === 'GET') {
          route = 'users.permissions'; query(url, []); const principal = await authenticated()
          send(200, await identity.listUserPermissions(principal, targetUser)); return
        }
        if (userPermission[2] === 'platform-admin' && method === 'POST') {
          route = 'users.platform-admin'; query(url, []); const principal = await authenticated(true)
          const body = await jsonBody(request, limit); fields(body, ['platformAdmin'])
          if (typeof body.platformAdmin !== 'boolean') throw new HttpError('INVALID_INPUT', 400)
          await identity.setPlatformAdmin(principal, { userId: targetUser, platformAdmin: body.platformAdmin }); send(200, { updated: true }); return
        }
      }
      if (path === '/api/audit' && method === 'GET') {
        route = 'audit.list'; query(url, ['limit', 'beforeId', 'actorId'])
        const principal = await authenticated()
        const rawLimit = url.searchParams.get('limit')
        if (rawLimit !== null && !/^[1-9][0-9]*$/.test(rawLimit)) throw new HttpError('INVALID_INPUT', 400)
        send(200, await identity.listAuditEvents(principal, {
          limit: rawLimit === null ? undefined : Number(rawLimit),
          beforeId: url.searchParams.get('beforeId') ?? undefined,
          actorId: url.searchParams.get('actorId') ?? undefined,
        }))
        return
      }
      if (path === '/api/users' && method === 'GET') {
        route = 'users.list'; query(url, ['query', 'limit', 'beforeId'])
        const principal = await authenticated()
        const rawLimit = url.searchParams.get('limit')
        if (rawLimit !== null && !/^[1-9][0-9]*$/.test(rawLimit)) throw new HttpError('INVALID_INPUT', 400)
        send(200, { items: await identity.listUsers(principal, {
          query: url.searchParams.get('query') ?? undefined,
          limit: rawLimit === null ? undefined : Number(rawLimit),
          beforeId: url.searchParams.get('beforeId') ?? undefined,
        }) })
        return
      }
      if (path === '/api/submissions' && ['GET', 'POST'].includes(method)) {
        route = 'submissions'; const principal = await authenticated(mutation)
        if (method === 'GET') {
          query(url, ['organizationId', 'limit', 'beforeId', 'status', 'packId', 'groupBy', 'afterPack'])
          const organizationId = url.searchParams.get('organizationId')
          if (!organizationId) throw new HttpError('INVALID_INPUT', 400)
          const rawLimit = url.searchParams.get('limit')
          if (rawLimit !== null && !/^[1-9][0-9]*$/.test(rawLimit)) throw new HttpError('INVALID_INPUT', 400)
          const rawStatus = url.searchParams.get('status')
          const status = rawStatus === null ? undefined : rawStatus.split(',').map(value => value.trim()).filter(Boolean)
          if (status !== undefined && !status.length) throw new HttpError('INVALID_INPUT', 400)
          const packId = url.searchParams.get('packId') ?? undefined
          const rawGroupBy = url.searchParams.get('groupBy')
          const groupBy = rawGroupBy === null || rawGroupBy === '' ? undefined : rawGroupBy === 'pack' ? 'pack' as const : undefined
          if (rawGroupBy !== null && rawGroupBy !== '' && groupBy === undefined) throw new HttpError('INVALID_INPUT', 400)
          const afterPack = url.searchParams.get('afterPack') ?? undefined
          send(200, await submissions.list(principal, organizationId, { limit: rawLimit === null ? undefined : Number(rawLimit), beforeId: url.searchParams.get('beforeId') ?? undefined, status, packId, groupBy, afterPack }))
        } else {
          query(url, [])
          send(201, await submissions.create(principal, await jsonBody(request, limit) as unknown as SubmissionInput, requestKey(request)))
        }
        return
      }
      if (path === '/api/reviews' && method === 'GET') {
        route = 'reviews'; query(url, ['organizationId', 'limit', 'beforeId']); const principal = await authenticated()
        const organizationId = url.searchParams.get('organizationId')
        const rawLimit = url.searchParams.get('limit')
        if (!organizationId || (rawLimit !== null && !/^[1-9][0-9]*$/.test(rawLimit))) throw new HttpError('INVALID_INPUT', 400)
        send(200, await submissions.listReviewQueue(principal, organizationId, { limit: rawLimit === null ? undefined : Number(rawLimit), beforeId: url.searchParams.get('beforeId') ?? undefined })); return
      }
      const submission = /^\/api\/submissions\/([^/]+)(?:\/(validate|submit|withdraw|review|review-config|retry-publication|upstream|preview-fetch))?$/.exec(path)
      if (submission) {
        route = `submissions.${submission[2] ?? 'get'}`; query(url, []); const principal = await authenticated(mutation)
        const submissionId = decodeURIComponent(submission[1]!)
        if (!submission[2] && method === 'GET') { send(200, await submissions.get(principal, submissionId)); return }
        if (submission[2] === 'upstream' && method === 'GET') { send(200, await submissions.upstreamCheck(principal, submissionId)); return }
        if (submission[2] === 'preview-fetch' && method === 'POST') {
          const body = await jsonBody(request, limit); fields(body, ['ref'])
          const ref = typeof body.ref === 'string' ? body.ref : ''
          route = 'submissions.preview-fetch'
          send(200, await submissions.fetchPreview(principal, submissionId, ref)); return
        }
        if (!submission[2] && method === 'PATCH') {
          const key = requestKey(request); const body = await jsonBody(request, limit); const version = expectedVersion(body)
          fields(body, ['expectedVersion', 'version', 'source', 'notes', 'license', 'distribution', 'requiresPlugin', 'dependencyReleaseIds', 'builtinDependencies'])
          const { expectedVersion: _, ...editable } = body
          send(200, await submissions.updateDraft(principal, submissionId, version, editable as unknown as Parameters<typeof submissions.updateDraft>[3], key)); return
        }
        if (!submission[2] || method !== 'POST') throw new HttpError('NOT_FOUND', 404)
        const key = requestKey(request)
        const body = await jsonBody(request, limit)
        if (submission[2] === 'retry-publication') {
          fields(body, ['expectedReleaseVersion'])
          const version = expectedVersion({ expectedVersion: body.expectedReleaseVersion })
          send(202, await submissions.retryPublication(principal, submissionId, version, key)); return
        }
        if (submission[2] === 'review-config') {
          fields(body, ['enabled'])
          send(200, await submissions.setAutoReview(principal, submissionId, body.enabled, key)); return
        }
        const version = expectedVersion(body)
        if (submission[2] === 'review') {
          fields(body, ['expectedVersion', 'contentTreeSha256', 'decision', 'comment'])
          send(200, await submissions.review(principal, submissionId, { expectedVersion: version, contentTreeSha256: string(body, 'contentTreeSha256'), decision: string(body, 'decision') as 'approved' | 'changes_requested' | 'rejected', comment: string(body, 'comment') }, key))
        } else {
          fields(body, ['expectedVersion'])
          if (submission[2] === 'validate') send(202, await submissions.startValidation(principal, submissionId, version, key))
          else if (submission[2] === 'submit') send(200, await submissions.submit(principal, submissionId, version, key))
          else send(200, await submissions.withdraw(principal, submissionId, version, key))
        }
        return
      }
      const packOwners = /^\/api\/packs\/([^/]+)\/owners(?:\/([^/]+))?$/.exec(path)
      if (packOwners && ['GET', 'POST', 'DELETE'].includes(method)) {
        route = `packs.owners.${method.toLowerCase()}`; query(url, []); const principal = await authenticated(mutation)
        const packId = decodeURIComponent(packOwners[1]!)
        if (method === 'GET') { send(200, { items: await identity.listPackOwnerships(principal, packId) }); return }
        const key = requestKey(request)
        if (method === 'POST') {
          const body = await jsonBody(request, limit); fields(body, ['userId', 'role'])
          send(201, await identity.grantPackRole(principal, { packId, userId: string(body, 'userId'), role: string(body, 'role') as 'owner' | 'maintainer' }, key))
        } else {
          fields(await jsonBody(request, limit), [])
          const targetUser = packOwners[2] ? decodeURIComponent(packOwners[2]) : ''
          if (!targetUser) throw new HttpError('INVALID_INPUT', 400)
          await identity.revokePackRole(principal, { packId, userId: targetUser }, key)
          send(200, { revoked: true })
        }
        return
      }
      if (path === '/api/pack-visibility' && method === 'POST') {
        route = 'pack.visibility.set'; query(url, []); const principal = await authenticated(true)
        const body = await jsonBody(request, limit); fields(body, ['organizationId', 'scope', 'packIds'])
        if (body.packIds !== undefined && !Array.isArray(body.packIds)) throw new HttpError('INVALID_INPUT', 400)
        send(201, await identity.setPackVisibility(principal, { organizationId: string(body, 'organizationId'), scope: string(body, 'scope') as 'all' | 'list', packIds: body.packIds as string[] | undefined }, requestKey(request)))
        return
      }
      const visibilityRoute = /^\/api\/organizations\/([^/]+)\/pack-visibility(?:\/disable)?$/.exec(path)
      if (visibilityRoute && ['GET', 'POST'].includes(method)) {
        route = `pack.visibility.${visibilityRoute[2] ? 'disable' : 'get'}`; query(url, []); const principal = await authenticated(mutation)
        const organizationId = decodeURIComponent(visibilityRoute[1]!)
        if (method === 'GET') { send(200, await identity.getPackVisibility(principal, organizationId)); return }
        fields(await jsonBody(request, limit), [])
        await identity.disablePackVisibility(principal, { organizationId }, requestKey(request))
        send(200, { disabled: true }); return
      }
      throw new HttpError('NOT_FOUND', 404)
    } catch (error) {
      const failure = classify(error)
      // Only controlled route labels, status and error code enter the audit.
      // Never log URLs/query strings, Cookie, authorization codes, invite/session
      // tokens, CSRF values, request bodies or raw exception messages/stacks.
      try {
        await database.query(`INSERT INTO audit_events(actor_kind,actor_id,action,object_kind,object_id,outcome,details)
          VALUES ($1,$2,'http.request','http_route',$3,$4,$5::jsonb)`,
        [actor?.kind ?? 'system', actor?.kind === 'human' ? actor.userId : actor?.deploymentId ?? 'http-anonymous', route, [401, 403, 404].includes(failure.status) ? 'denied' : 'failed', JSON.stringify({ requestId, method: request.method, code: failure.code, status: failure.status })])
      } catch { /* A failing database must not leak its connection details. */ }
      if (!response.destroyed && !response.headersSent && route === 'auth.callback' && request.method === 'GET'
        && /(?:^|,)\s*text\/html(?:\s*;|\s*,|\s*$)/i.test(request.headers.accept ?? '')) {
        // A fixed public login screen, with no code/state/error values in its URL.
        response.statusCode = 303; response.setHeader('Location', '/#/login-error'); response.end()
      }
      else if (!response.destroyed && !response.headersSent) send(failure.status, { error: { code: failure.code, message: failure.message, requestId } })
      else if (!response.destroyed) response.destroy()
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  server.keepAliveTimeout = 5000
  server.maxHeadersCount = 100
  return server
}
