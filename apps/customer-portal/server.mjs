import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AccountStore } from './account-store.mjs'
import { resolveAccountBackend } from './backend-routing.mjs'
import { readConfig } from './config.mjs'
import { createDshGateway } from './dsh-gateway.mjs'
import { createCapabilityManagement } from './capability-management.mjs'
import { createLoginAttempts } from './login-attempts.mjs'
import { createModelUsageClient } from './model-usage.mjs'
import { createOidcClient } from './oidc-client.mjs'
import { createCustomerPreview } from './c-preview.mjs'
import { createCustomerHistoricalPreviews } from './c-historical-previews.mjs'
import { createSessionDeliverables } from './session-deliverables.mjs'
import { createResidentialDemoWorkspace } from './residential-demo-workspace.mjs'
import { readSessionActivity } from './session-activity.mjs'
import { titleFromUserMessage } from './session-title.mjs'
import { addOsaServiceCards, osaDemoPlan } from './osa-service-cards.mjs'

const dist = new URL('./dist/', import.meta.url)
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/login', ['index.html', 'text/html; charset=utf-8']],
  ['/app', ['index.html', 'text/html; charset=utf-8']],
  ['/share', ['index.html', 'text/html; charset=utf-8']],
  ['/preview', ['index.html', 'text/html; charset=utf-8']],
  ['/manage', ['manage.html', 'text/html; charset=utf-8']],
  ['/demo/loading', ['loader-demo.html', 'text/html; charset=utf-8']],
  ['/demo/loading.css', ['loader-demo.css', 'text/css; charset=utf-8']],
  ['/demo/loading.js', ['loader-demo.js', 'text/javascript; charset=utf-8']],
  ['/assets/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/assets/manage.js', ['manage.js', 'text/javascript; charset=utf-8']],
  ['/assets/manage.css', ['manage.css', 'text/css; charset=utf-8']],
  ['/assets/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/assets/marked.umd.js', ['assets/marked.umd.js', 'text/javascript; charset=utf-8']],
  ['/assets/purify.min.js', ['assets/purify.min.js', 'text/javascript; charset=utf-8']],
  ['/assets/coordinator.webp', ['assets/coordinator.webp', 'image/webp']],
  ['/assets/coordinator-avatar.webp', ['assets/coordinator-avatar.webp', 'image/webp']],
  ['/favicon.ico', ['favicon.ico', 'image/x-icon']],
])
const baseHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'self' https://static.cloudflareinsights.com/beacon.min.js https://static.cloudflareinsights.com/beacon.min.js/; style-src 'self'; img-src 'self' blob:; frame-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

function send(res, status, body, type, headers = {}) {
  res.writeHead(status, { ...baseHeaders, 'content-type': type, ...headers })
  res.end(body)
}

const json = (res, status, body, headers) => send(res, status, JSON.stringify(body), 'application/json; charset=utf-8', headers)
const cookieValue = (req, name) => (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1)
const sessionCookie = (token, age) => `__Host-zhijian-session=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`
const attemptCookie = (token, age) => `__Host-zhijian-login=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`
const csrfCookie = (token, age) => `__Host-zhijian-csrf=${token}; Path=/; Secure; SameSite=Strict; Max-Age=${age}`
const SESSION_PATH = /^\/api\/sessions\/([0-9a-f-]{36})\/messages$/i
const ATTACHMENT_PATH = /^\/api\/sessions\/([0-9a-f-]{36})\/attachments$/i
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const DATA_PATH = /^\/api\/sessions\/([0-9a-f-]{36})\/datasets(?:\/(\d{13}-[0-9a-f-]{36}))?$/i
const WORKSPACE_PATH = /^\/api\/sessions\/([0-9a-f-]{36})\/workspace$/i
const WORKSPACE_MODELS_PATH = /^\/api\/sessions\/([0-9a-f-]{36})\/workspace\/models$/i
const CONVERSATION_MODEL_PATH = /^\/api\/sessions\/([0-9a-f-]{36})\/model$/i
const WORKSPACE_ACTION_PATH = /^\/api\/sessions\/([0-9a-f-]{36})\/workspace\/action$/i
const WORKSPACE_DOCUMENT_PATH = /^\/api\/sessions\/([0-9a-f-]{36})\/workspace\/documents\/([^/]+)\/([^/]+)(?:\/(preview|download))?$/i
const QUESTION_PATH = /^\/api\/sessions\/([0-9a-f-]{36})\/question$/i
const APPROVAL_PATH = /^\/api\/sessions\/([0-9a-f-]{36})\/approval$/i
const SESSION_METADATA_PATH = /^\/api\/sessions\/([0-9a-f-]{36})$/i
const SESSION_GROUP_PATH = /^\/api\/session-groups\/([0-9a-f-]{36})$/i
const SESSION_SHARES_PATH = /^\/api\/sessions\/([0-9a-f-]{36})\/shares$/i
const SHARE_PATH = /^\/api\/shares\/([0-9a-f-]{36})$/i
const RESIDENTIAL_V2_FILE_PATH = /^\/api\/residential-v2\/files\/(rv2-[0-9a-f]{24})\/((?:price_full|price_external|rent_full|rent_external)-[0-9a-f]{12})$/

async function precedingConversation(gateway, runtime, sessionId, firstSeq, firstPage) {
  if (!Number.isSafeInteger(firstSeq) || firstSeq <= 0) return []
  const messages = []
  let cursor = -1
  for (let pageNo = 0; pageNo < 100; pageNo++) {
    const page = pageNo === 0 && firstPage ? firstPage
      : await gateway.conversation(runtime, sessionId, cursor, false)
    if (!Array.isArray(page?.messages) || !Number.isSafeInteger(page.nextCursor)) return null
    for (const message of page.messages) {
      if (Number.isSafeInteger(message?.seq) && message.seq < firstSeq) messages.push(message)
    }
    if (page.messages.some(message => message?.seq >= firstSeq) || page.hasMore === false) {
      return messages.sort((a, b) => a.seq - b.seq)
    }
    if (page.hasMore !== true || page.nextCursor <= cursor) return null
    cursor = page.nextCursor
  }
  return null
}

function decorateSession(store, principal, session) {
  const preference = store.sessionPreference(principal, session.id)
  return { ...session, title: preference?.titleOverride ?? session.title,
    pinned: !!preference?.pinned, favorite: !!preference?.favorite, archived: !!preference?.archived,
    groupId: preference?.groupId ?? null }
}

function sortSessions(sessions) {
  return sessions.sort((a, b) => Number(b.pinned) - Number(a.pinned)
    || Number(b.favorite) - Number(a.favorite) || b.createdAt - a.createdAt)
}

async function readJson(req, limit = 24_000) {
  const chunks = []; let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) return undefined
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch { return undefined }
}

export function createPortalServer(config, services = {}) {
  const store = services.store
  const oidc = services.oidc
  const attempts = services.attempts ?? createLoginAttempts()
  const authReady = !!(store && oidc)
  const phase = authReady ? (config.researchEnabledBackends?.length ? 'S1-research' : 'S1-auth') : 'S0'
  const gateway = services.gateway ?? createDshGateway(config)
  const capabilityManagement = services.capabilityManagement ?? createCapabilityManagement(config)
  const usage = services.usage ?? createModelUsageClient(config)
  const preview = services.preview ?? createCustomerPreview()
  const historicalPreviews = services.historicalPreviews ?? createCustomerHistoricalPreviews()
  const deliverables = services.deliverables ?? createSessionDeliverables()
  const residentialDemoWorkspace = services.residentialDemoWorkspace ?? createResidentialDemoWorkspace()
  const residentialV2Fetch = services.residentialV2Fetch ?? fetch
  const previews = [preview, ...historicalPreviews]
  const activityCache = new Map()
  const osaPlanCache = new Map()
  const legacyActivityBackends = new Map()
  async function accountSessionActivity(principal) {
    const sessions = store.listResearchSessions(principal)
    if (!sessions.length) return { items: [], hasUnknown: false }
    const signature = sessions.map(session => session.id).join(',')
    const cached = activityCache.get(principal.accountId)
    if (cached?.signature === signature) {
      if (cached.pending) return cached.pending
      if (Date.now() - cached.checkedAt < (cached.result.hasUnknown ? 30_000 : 2_000)) return cached.result
    }
    const runtime = resolveAccountBackend(principal, config)
    const readLegacyActivity = () => readSessionActivity(sessions, async session => {
      const row = store.getResearchSession(principal, session.id)
      if (!row?.dsh_session_id) throw new Error('SESSION_NOT_FOUND')
      return gateway.activity(runtime, row.dsh_session_id, 5_000)
    })
    const pending = gateway.activityBatch && (legacyActivityBackends.get(runtime.backendRef) ?? 0) < Date.now() ? (async () => {
      const items = []
      let hasUnknown = false
      for (let offset = 0; offset < sessions.length; offset += 50) {
        const chunk = sessions.slice(offset, offset + 50)
        const rows = chunk.map(session => ({ session,
          dshId: store.getResearchSession(principal, session.id)?.dsh_session_id }))
        const bound = rows.filter(row => row.dshId)
        if (bound.length !== rows.length) hasUnknown = true
        if (!bound.length) continue
        try {
          const result = await gateway.activityBatch(runtime, bound.map(row => row.dshId), 8_000)
          if (!Array.isArray(result?.items) || result.items.length !== bound.length) throw new Error('INVALID_ACTIVITY_BATCH')
          const states = new Map(result.items.map(item => [item.sessionId, item.running]))
          if (states.size !== bound.length || bound.some(row => typeof states.get(row.dshId) !== 'boolean'))
            throw new Error('INVALID_ACTIVITY_BATCH')
          for (const row of bound) items.push({ id: row.session.id, running: states.get(row.dshId) })
        } catch (error) {
          if (error?.status === 404 || error?.status === 405) {
            legacyActivityBackends.set(runtime.backendRef, Date.now() + 10 * 60_000)
            return readLegacyActivity()
          }
          hasUnknown = true
        }
      }
      return { items, hasUnknown }
    })() : readLegacyActivity()
    activityCache.set(principal.accountId, { signature, pending })
    try {
      const result = await pending
      activityCache.set(principal.accountId, { signature, result, checkedAt: Date.now() })
      return result
    } catch (error) {
      activityCache.delete(principal.accountId)
      throw error
    }
  }
  function requestAccess(req) {
    const authorization = req.headers.authorization
    if (authorization !== undefined) {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)
      return match && authReady ? store.resolveShareLink(match[1]) : undefined
    }
    return authReady ? store.resolveBrowserSession(cookieValue(req, '__Host-zhijian-session')) : undefined
  }
  function canWrite(req, access) {
    if (!access || req.headers.origin !== config.publicOrigin) return false
    if (access.shareId) return access.permission === 'collaborate' && !access.preview
    return store.verifyCsrf(cookieValue(req, '__Host-zhijian-session'), req.headers['x-csrf-token'])
  }
  function accessibleSession(access, id) {
    if (!access || (access.shareId && access.sessionId !== id)) return undefined
    return access.shareId ? store.getSharedResearchSession(access, id) : store.getResearchSession(access, id)
  }
  return createServer(async (req, res) => {
    const requestHost = req.headers.host
    const configuredHost = new URL(config.publicOrigin).host
    const loopbackHost = requestHost && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(requestHost)
    if (requestHost !== configuredHost && !loopbackHost) {
      send(res, 421, 'Misdirected Request', 'text/plain; charset=utf-8')
      return
    }
    let pathname
    try { pathname = new URL(req.url ?? '/', config.publicOrigin).pathname } catch {
      send(res, 400, 'Bad Request', 'text/plain; charset=utf-8')
      return
    }
    // Older DSH replies link to its loopback-only workspace-file route. Resolve
    // those links solely against files explicitly published for this session.
    if (pathname === '/plugins/dsh-expert-library/workspace-file') {
      if (req.method !== 'GET') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      const principal = authReady ? store.resolveBrowserSession(cookieValue(req, '__Host-zhijian-session')) : undefined
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      const params = new URL(req.url ?? '/', config.publicOrigin).searchParams
      const dshId = params.get('sessionId') ?? ''
      const match = /^session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(dshId)
      const rawPath = params.get('path') ?? ''
      const segments = rawPath.split('/')
      if (!match || !rawPath || rawPath.length > 512 || segments.some(part => !part || part === '.' || part === '..' || part.includes('\\')))
        return json(res, 404, { error: 'DOCUMENT_NOT_FOUND' })
      const row = store.getResearchSession(principal, match[1])
      if (!row?.dsh_session_id || row.dsh_session_id !== dshId)
        return json(res, 404, { error: 'DOCUMENT_NOT_FOUND' })
      const name = segments.at(-1)
      const published = (await deliverables.list(principal.slug, row.id)).find(item =>
        item.name === name && item.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      if (!published) return json(res, 404, { error: 'DOCUMENT_NOT_FOUND' })
      const location = `/api/sessions/${row.id}/workspace/documents/conversation/${published.id}/download`
      return send(res, 302, '', 'text/plain; charset=utf-8', { location })
    }
    if (pathname === '/healthz') {
      if (req.method !== 'GET') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      json(res, 200, { ok: true, phase })
      return
    }
    if (pathname === '/api/bootstrap') {
      if (req.method !== 'GET') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      const principal = requestAccess(req)
      let researchReady = false
      if (principal && config.gatewayTokenDir) {
        try { resolveAccountBackend(principal, config); researchReady = true } catch { /* not provisioned */ }
      }
      json(res, 200, { authenticated: !!principal, loginProviders: authReady ? ['developer-center'] : [],
        phase, researchReady, ...(principal ? { user: {
          displayName: principal.shareId ? '共享访客' : principal.displayName,
          accountName: principal.slug, role: principal.shareId ? 'guest' : principal.role,
        }, ...(principal.shareId ? { share: { permission: principal.permission, expiresAt: principal.expiresAt } } : {}) } : {}) })
      return
    }
    if (pathname === '/api/usage') {
      if (req.method !== 'GET') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      if (req.headers.authorization) return json(res, 403, { error: 'SHARE_SCOPE_DENIED' })
      const token = cookieValue(req, '__Host-zhijian-session')
      const principal = authReady ? store.resolveBrowserSession(token) : undefined
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      let runtime
      try { runtime = resolveAccountBackend(principal, config) } catch { return json(res, 503, { error: 'RESEARCH_UNAVAILABLE' }) }
      try { return json(res, 200, { accountName: principal.slug, ...(await usage(runtime.backendRef)) }) }
      catch { return json(res, 503, { error: 'USAGE_UNAVAILABLE' }) }
    }
    if (pathname === '/api/capabilities/settings' || pathname.startsWith('/api/capabilities/')) {
      if (req.headers.authorization) return json(res, 403, { error: 'SHARE_SCOPE_DENIED' })
      const principal = authReady ? store.resolveBrowserSession(cookieValue(req, '__Host-zhijian-session')) : undefined
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      if (principal.role !== 'admin') return json(res, 403, { error: 'ADMIN_REQUIRED' })
      if (!['GET', 'PUT', 'POST', 'DELETE'].includes(req.method ?? '')) return json(res, 405, { error: 'METHOD_NOT_ALLOWED' })
      if (req.method !== 'GET' && !canWrite(req, principal)) return json(res, 403, { error: 'CSRF_INVALID' })
      let runtime
      try { runtime = resolveAccountBackend(principal, config) } catch { return json(res, 503, { error: 'CAPABILITY_BACKEND_UNAVAILABLE' }) }
      const name = pathname.slice('/api/capabilities/'.length)
      if (name === 'settings') {
        if (req.method === 'GET') {
          try { return json(res, 200, await gateway.adminSettings(runtime)) }
          catch { return json(res, 503, { error: 'SETTINGS_UNAVAILABLE' }) }
        }
        if (req.method !== 'PUT') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' })
        const body = await readJson(req, 32_000)
        if (!body || !Number.isSafeInteger(body.revision) || typeof body.section !== 'string'
          || !body.value || typeof body.value !== 'object' || Array.isArray(body.value)) return json(res, 400, { error: 'INVALID_SETTINGS' })
        try { return json(res, 200, await gateway.updateAdminSettings(runtime, body)) }
        catch (error) { return json(res, error?.status === 409 ? 409 : 400, { error: error?.status === 409 ? 'SETTINGS_CONFLICT' : 'INVALID_SETTINGS' }) }
      }
      if (name === 'models') {
        if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' })
        try { return json(res, 200, await gateway.adminModels(runtime)) }
        catch { return json(res, 503, { error: 'MODELS_UNAVAILABLE' }) }
      }
      if (name === 'usage') {
        if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' })
        const url = new URL(req.url, config.publicOrigin)
        const days = url.searchParams.get('days') ?? '7'
        if (url.searchParams.size > 1 || !['7', '30'].includes(days)) return json(res, 400, { error: 'INVALID_RANGE' })
        try { return json(res, 200, await gateway.adminUsage(runtime, Number(days))) }
        catch { return json(res, 503, { error: 'USAGE_UNAVAILABLE' }) }
      }
      if (name === 'skills-install') {
        if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' })
        const body = await readJson(req, 22_400_000)
        if (!body || typeof body.id !== 'string' || typeof body.data !== 'string'
          || Object.keys(body).some(key => !['id', 'data'].includes(key))) return json(res, 400, { error: 'INVALID_SKILL' })
        try { const result = await capabilityManagement.uploadSkill(runtime, body.id, body.data)
          return json(res, result.status, result.data) }
        catch { return json(res, 400, { error: 'INVALID_SKILL' }) }
      }
      if (req.method === 'GET' ? !capabilityManagement.readable(name) : !capabilityManagement.writable(name, req.method))
        return json(res, 404, { error: 'CAPABILITY_ROUTE_UNKNOWN' })
      const url = new URL(req.url, config.publicOrigin)
      const id = req.method === 'DELETE' || name === 'pack-preview' ? url.searchParams.get('id') : undefined
      if ((req.method === 'DELETE' || name === 'pack-preview') && (!id || url.searchParams.size !== 1))
        return json(res, 400, { error: 'CAPABILITY_INVALID_ID' })
      const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readJson(req, 64_000)
      if (req.method !== 'GET' && req.method !== 'DELETE' && !body) return json(res, 400, { error: 'CAPABILITY_INVALID_BODY' })
      try {
        const result = await capabilityManagement.call(runtime, req.method, name, body, id)
        return json(res, result.status, result.data)
      } catch { return json(res, 503, { error: 'CAPABILITY_UNAVAILABLE' }) }
    }
    if (pathname === '/api/auth/start') {
      if (req.method !== 'GET') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      if (!authReady) return json(res, 503, { error: 'LOGIN_UNAVAILABLE' })
      try {
        const attempt = attempts.begin()
        const location = await oidc.start(attempt)
        return send(res, 302, '', 'text/plain; charset=utf-8', { location, 'set-cookie': attemptCookie(attempt.browser, 600) })
      } catch { return json(res, 503, { error: 'LOGIN_UNAVAILABLE' }) }
    }
    if (pathname === '/api/auth/callback') {
      if (req.method !== 'GET') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      if (!authReady) return json(res, 503, { error: 'LOGIN_UNAVAILABLE' })
      const callback = new URL(req.url, config.publicOrigin)
      if (callback.searchParams.getAll('state').length !== 1 || callback.searchParams.getAll('code').length !== 1) return json(res, 400, { error: 'LOGIN_INVALID' })
      const attempt = attempts.take(callback.searchParams.get('state'), cookieValue(req, '__Host-zhijian-login'))
      if (!attempt) return json(res, 401, { error: 'LOGIN_EXPIRED' }, { 'set-cookie': attemptCookie('', 0) })
      try {
        const identity = await oidc.finish({ callbackUrl: callback.href, ...attempt })
        const account = store.accountForIdentity(identity.issuer, identity.subject)
        if (!account) {
          store.recordPendingIdentity(identity)
          return send(res, 302, '', 'text/plain; charset=utf-8', { location: '/login?status=pending', 'set-cookie': attemptCookie('', 0) })
        }
        const login = store.issueBrowserSession({ issuer: identity.issuer, subject: identity.subject, accountId: account.accountId })
        if (!login) return json(res, 403, { error: 'ACCOUNT_NOT_PROVISIONED' }, { 'set-cookie': attemptCookie('', 0) })
        return send(res, 302, '', 'text/plain; charset=utf-8', { location: '/app', 'set-cookie': [attemptCookie('', 0), sessionCookie(login.token, 8 * 60 * 60), csrfCookie(login.csrf, 8 * 60 * 60)] })
      } catch { return json(res, 401, { error: 'LOGIN_FAILED' }, { 'set-cookie': attemptCookie('', 0) }) }
    }
    const shareListMatch = pathname.match(SESSION_SHARES_PATH)
    if (shareListMatch) {
      if (!['GET', 'POST'].includes(req.method)) return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      if (req.headers.authorization) return json(res, 403, { error: 'SHARE_SCOPE_DENIED' })
      const token = cookieValue(req, '__Host-zhijian-session')
      const principal = authReady ? store.resolveBrowserSession(token) : undefined
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      const id = shareListMatch[1]
      const row = store.getResearchSession(principal, id)
      const previewItem = previews.find(item => item.session.id === id && item.visible(principal))
      const isPreview = !row?.dsh_session_id && !!(previewItem && await previewItem.available())
      if (!row?.dsh_session_id && !isPreview) return json(res, 404, { error: 'SESSION_NOT_FOUND' })
      if (req.method === 'GET') return json(res, 200, { shares: store.listShareLinks(principal, id) })
      if (req.headers.origin !== config.publicOrigin || !store.verifyCsrf(token, req.headers['x-csrf-token']))
        return json(res, 403, { error: 'CSRF_INVALID' })
      const body = await readJson(req, 2_000)
      if (!body || !['read', 'collaborate'].includes(body.permission)
        || !Number.isSafeInteger(body.days) || body.days < 1 || body.days > 365
        || (isPreview && body.permission !== 'read')) return json(res, 400, { error: 'INVALID_SHARE_OPTIONS' })
      const share = store.createShareLink(principal, id, { permission: body.permission, days: body.days, preview: isPreview })
      return json(res, 201, { share: { id: share.id, permission: share.permission, createdAt: share.createdAt,
        expiresAt: share.expiresAt }, token: share.token })
    }
    const shareMatch = pathname.match(SHARE_PATH)
    if (shareMatch) {
      if (req.method !== 'DELETE') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      if (req.headers.authorization) return json(res, 403, { error: 'SHARE_SCOPE_DENIED' })
      const token = cookieValue(req, '__Host-zhijian-session')
      const principal = authReady ? store.resolveBrowserSession(token) : undefined
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      if (req.headers.origin !== config.publicOrigin || !store.verifyCsrf(token, req.headers['x-csrf-token']))
        return json(res, 403, { error: 'CSRF_INVALID' })
      if (!store.revokeShareLink(principal, shareMatch[1])) return json(res, 404, { error: 'SHARE_NOT_FOUND' })
      return json(res, 200, { revoked: true })
    }
    if (pathname === '/api/sessions/activity') {
      if (req.method !== 'GET') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      if (req.headers.authorization) return json(res, 403, { error: 'SHARE_SCOPE_DENIED' })
      const principal = authReady ? store.resolveBrowserSession(cookieValue(req, '__Host-zhijian-session')) : undefined
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      try { return json(res, 200, await accountSessionActivity(principal)) }
      catch { return json(res, 503, { error: 'ACTIVITY_UNAVAILABLE' }) }
    }
    if (pathname === '/api/sessions') {
      const token = cookieValue(req, '__Host-zhijian-session')
      const principal = requestAccess(req)
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      if (req.method === 'GET') {
        if (principal.shareId) {
          if (principal.preview) {
            const item = previews.find(item => item.session.id === principal.sessionId && item.visible(principal))
            return json(res, 200, { sessions: item && await item.available() ? [item.session] : [] })
          }
          const shared = store.getSharedResearchSession(principal, principal.sessionId)
          return json(res, 200, { sessions: shared ? [{ id: shared.id, title: shared.sharedTitle,
            createdAt: shared.created_at, shared: true }] : [] })
        }
        const availablePreviews = await Promise.all(previews.map(async item =>
          item.visible(principal) && await item.available() ? item.session : null))
        const sessions = [...store.listResearchSessions(principal), ...availablePreviews.filter(Boolean)]
        return json(res, 200, { sessions: sortSessions(sessions.map(session => decorateSession(store, principal, session))),
          groups: store.listSessionGroups(principal) })
      }
      if (req.method !== 'POST') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      if (principal.shareId) return json(res, 403, { error: 'SHARE_SCOPE_DENIED' })
      if (req.headers.origin !== config.publicOrigin || !store.verifyCsrf(token, req.headers['x-csrf-token'])) return json(res, 403, { error: 'CSRF_INVALID' })
      const body = await readJson(req, 4_000)
      if (!body || typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId)
        || (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200))) return json(res, 400, { error: 'INVALID_REQUEST' })
      let runtime
      try { runtime = resolveAccountBackend(principal, config) } catch { return json(res, 503, { error: 'RESEARCH_UNAVAILABLE' }) }
      try {
        const row = store.createResearchSession({ principal, requestId: body.requestId, title: body.title ?? '新会话' })
        const dshSessionId = `session-${row.id}`
        const created = await gateway.createSession(runtime, dshSessionId)
        if (created.sessionId !== dshSessionId) throw new Error('DSH session mismatch')
        store.bindDshSession(principal, row.id, dshSessionId)
        return json(res, 201, { session: { id: row.id, title: row.title, createdAt: row.created_at } })
      } catch { return json(res, 503, { error: 'RESEARCH_UNAVAILABLE' }) }
    }
    if (pathname === '/api/session-groups' || SESSION_GROUP_PATH.test(pathname)) {
      if (req.headers.authorization) return json(res, 403, { error: 'SHARE_SCOPE_DENIED' })
      const token = cookieValue(req, '__Host-zhijian-session')
      const principal = authReady ? store.resolveBrowserSession(token) : undefined
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      if (req.headers.origin !== config.publicOrigin || !store.verifyCsrf(token, req.headers['x-csrf-token']))
        return json(res, 403, { error: 'CSRF_INVALID' })
      const groupId = pathname.match(SESSION_GROUP_PATH)?.[1]
      if (!groupId && req.method !== 'POST' || groupId && !['PATCH', 'DELETE'].includes(req.method))
        return json(res, 405, { error: 'METHOD_NOT_ALLOWED' })
      if (req.method === 'DELETE') {
        if (!store.deleteSessionGroup(principal, groupId)) return json(res, 404, { error: 'GROUP_NOT_FOUND' })
        return json(res, 200, { deleted: true })
      }
      const body = await readJson(req, 1_000)
      const name = typeof body?.name === 'string' ? body.name.trim() : ''
      if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name))
        return json(res, 400, { error: 'INVALID_GROUP_NAME' })
      try {
        if (groupId) {
          if (!store.renameSessionGroup(principal, groupId, name)) return json(res, 404, { error: 'GROUP_NOT_FOUND' })
          return json(res, 200, { group: { id: groupId, name } })
        }
        return json(res, 201, { group: store.createSessionGroup(principal, name) })
      } catch (error) {
        if (String(error).includes('UNIQUE constraint failed')) return json(res, 409, { error: 'GROUP_NAME_EXISTS' })
        throw error
      }
    }
    const metadataMatch = pathname.match(SESSION_METADATA_PATH)
    if (metadataMatch) {
      if (req.method !== 'PATCH') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      if (req.headers.authorization) return json(res, 403, { error: 'SHARE_SCOPE_DENIED' })
      const token = cookieValue(req, '__Host-zhijian-session')
      const principal = authReady ? store.resolveBrowserSession(token) : undefined
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      if (req.headers.origin !== config.publicOrigin || !store.verifyCsrf(token, req.headers['x-csrf-token']))
        return json(res, 403, { error: 'CSRF_INVALID' })
      const id = metadataMatch[1]
      const row = store.getResearchSession(principal, id)
      const previewItem = previews.find(item => item.session.id === id && item.visible(principal))
      const session = row?.dsh_session_id ? { id: row.id, title: row.title, createdAt: row.created_at }
        : previewItem && await previewItem.available() ? previewItem.session : undefined
      if (!session) return json(res, 404, { error: 'SESSION_NOT_FOUND' })
      const changes = await readJson(req, 2_000)
      if (!changes || !Object.keys(changes).length || Object.keys(changes).some(key => !['title', 'pinned', 'favorite', 'archived', 'groupId'].includes(key))
        || (Object.hasOwn(changes, 'title') && (typeof changes.title !== 'string'
          || !changes.title.trim() || changes.title.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(changes.title)))
        || (Object.hasOwn(changes, 'pinned') && typeof changes.pinned !== 'boolean')
        || (Object.hasOwn(changes, 'favorite') && typeof changes.favorite !== 'boolean')
        || (Object.hasOwn(changes, 'archived') && typeof changes.archived !== 'boolean')
        || (Object.hasOwn(changes, 'groupId') && changes.groupId !== null &&
          (typeof changes.groupId !== 'string' || !/^[0-9a-f-]{36}$/i.test(changes.groupId))))
        return json(res, 400, { error: 'INVALID_SESSION_METADATA' })
      if (Object.hasOwn(changes, 'title')) changes.title = changes.title.trim()
      if (changes.groupId && !store.listSessionGroups(principal).some(group => group.id === changes.groupId))
        return json(res, 400, { error: 'GROUP_NOT_FOUND' })
      store.updateSessionPreference(principal, id, changes)
      return json(res, 200, { session: decorateSession(store, principal, session) })
    }
    if (pathname === '/api/mentions') {
      if (req.method !== 'GET') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      const principal = requestAccess(req)
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      if (principal.shareId && principal.permission !== 'collaborate') return json(res, 200, { items: [] })
      let runtime
      try { runtime = resolveAccountBackend(principal, config) } catch { return json(res, 503, { error: 'RESEARCH_UNAVAILABLE' }) }
      try { return json(res, 200, await gateway.mentions(runtime)) }
      catch { return json(res, 503, { error: 'MENTIONS_UNAVAILABLE' }) }
    }
    const residentialFile = RESIDENTIAL_V2_FILE_PATH.exec(pathname)
    if (residentialFile) {
      if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' })
      const principal = requestAccess(req)
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      if (principal.shareId || principal.backendRef !== 'zhijian-demo-c')
        return json(res, 404, { error: 'FILE_NOT_FOUND' })
      try {
        const upstream = await residentialV2Fetch(`http://127.0.0.1:8793/internal-files/${residentialFile[1]}/${residentialFile[2]}`,
          { signal: AbortSignal.timeout(15_000), cache: 'no-store' })
        if (!upstream.ok) return json(res, upstream.status === 404 ? 404 : 503, { error: 'FILE_UNAVAILABLE' })
        const length = Number(upstream.headers.get('content-length'))
        const expectedHash = upstream.headers.get('x-content-sha256')
        if (!Number.isSafeInteger(length) || length < 1 || length > 20 * 1024 * 1024
          || !/^[0-9a-f]{64}$/.test(expectedHash ?? '')) return json(res, 503, { error: 'FILE_INVALID' })
        const bytes = Buffer.from(await upstream.arrayBuffer())
        if (bytes.length !== length || createHash('sha256').update(bytes).digest('hex') !== expectedHash)
          return json(res, 503, { error: 'FILE_CHECKSUM_MISMATCH' })
        return send(res, 200, bytes,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          { 'content-disposition': `attachment; filename="${residentialFile[2]}.docx"` })
      } catch { return json(res, 503, { error: 'FILE_UNAVAILABLE' }) }
    }
    const selectedPreview = previews.find(item => pathname.startsWith(`/api/sessions/${item.session.id}/`))
    if (selectedPreview) {
      const previewPrefix = `/api/sessions/${selectedPreview.session.id}/`
      const principal = requestAccess(req)
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      if (!selectedPreview.visible(principal) || (principal.shareId &&
        (principal.sessionId !== selectedPreview.session.id || !principal.preview))) return json(res, 404, { error: 'SESSION_NOT_FOUND' })
      if (req.method !== 'GET') return json(res, 405, { error: 'READ_ONLY_PREVIEW' })
      const suffix = pathname.slice(previewPrefix.length)
      if (suffix === 'workspace') {
        try { return json(res, 200, await selectedPreview.workspace()) }
        catch { return json(res, 503, { error: 'PREVIEW_UNAVAILABLE' }) }
      }
      if (suffix === 'messages') {
        const params = new URL(req.url, config.publicOrigin).searchParams
        const after = Number(params.get('after') ?? '-1')
        const latest = params.get('latest') === '1'
        const before = params.has('before') ? Number(params.get('before')) : undefined
        if (!Number.isSafeInteger(after) || after < -1 || (params.has('latest') && !latest)
          || (latest && after !== -1) || (before !== undefined && (!latest || !Number.isSafeInteger(before) || before < 0)))
          return json(res, 400, { error: 'INVALID_CURSOR' })
        if (selectedPreview.messages) {
          try { return json(res, 200, await selectedPreview.messages(after, latest, before)) }
          catch { return json(res, 503, { error: 'PREVIEW_UNAVAILABLE' }) }
        }
        return json(res, 200, { messages: [], nextCursor: Math.max(after, 0), hasMore: false, turnFailures: [] })
      }
      if (suffix === 'question') return json(res, 200, { question: null })
      if (suffix === 'datasets') return json(res, 200, { items: [], hasMore: false })
      if (suffix === 'workspace/models') return json(res, 200, { models: [] })
      if (suffix === 'model') return json(res, 200, { selected: null, models: [] })
      const documentMatch = /^workspace\/documents\/([^/]+)\/([^/]+)(?:\/(preview))?$/u.exec(suffix)
      if (documentMatch) {
        let taskId, artifactId
        try { taskId = decodeURIComponent(documentMatch[1]); artifactId = decodeURIComponent(documentMatch[2]) }
        catch { return json(res, 404, { error: 'DOCUMENT_NOT_FOUND' }) }
        try {
          const item = await selectedPreview.document(taskId, artifactId)
          if (!item) return json(res, 404, { error: 'DOCUMENT_NOT_FOUND' })
          if (documentMatch[3]) {
            if (item.mediaType !== 'text/html' || !/\.html$/i.test(item.name)) return json(res, 404, { error: 'DOCUMENT_NOT_FOUND' })
            const content = item.encoding === 'base64' ? Buffer.from(item.content, 'base64') : item.content
            const allowScripts = selectedPreview.allowsScripts?.(artifactId) === true
            return send(res, 200, content, 'text/html; charset=utf-8', {
              'x-frame-options': 'SAMEORIGIN',
              'content-security-policy': `sandbox${allowScripts ? ' allow-scripts' : ''}; default-src 'none'; script-src ${allowScripts ? "'unsafe-inline'" : "'none'"}; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
            })
          }
          return json(res, 200, { document: item })
        } catch { return json(res, 503, { error: 'PREVIEW_UNAVAILABLE' }) }
      }
      return json(res, 404, { error: 'NOT_FOUND' })
    }
    const workspaceMatch = WORKSPACE_PATH.exec(pathname)
    if (workspaceMatch) {
      if (req.method !== 'GET') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      const principal = requestAccess(req)
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      const row = accessibleSession(principal, workspaceMatch[1])
      if (!row?.dsh_session_id) return json(res, 404, { error: 'SESSION_NOT_FOUND' })
      let runtime
      try { runtime = resolveAccountBackend(principal, config) } catch { return json(res, 503, { error: 'RESEARCH_UNAVAILABLE' }) }
      try {
        const [state, localDocuments] = await Promise.all([
          gateway.workspace(runtime, row.dsh_session_id),
          deliverables.list(principal.slug, row.id),
        ])
        const residentialDemo = !state.plan && !state.team
          ? await residentialDemoWorkspace.forSession({ backendRef: principal.backendRef,
            shareId: principal.shareId, sessionId: row.id, runtime, gateway }) : undefined
        return json(res, 200, { ...state, documents: [...(state.documents ?? []), ...localDocuments],
          ...(residentialDemo ? { residentialDemo } : {}) })
      }
      catch { return json(res, 503, { error: 'WORKSPACE_UNAVAILABLE' }) }
    }
    const conversationModelMatch = CONVERSATION_MODEL_PATH.exec(pathname)
    if (conversationModelMatch) {
      if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      const principal = requestAccess(req)
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      const row = accessibleSession(principal, conversationModelMatch[1])
      if (!row?.dsh_session_id) return json(res, 404, { error: 'SESSION_NOT_FOUND' })
      if (req.method === 'POST' && !canWrite(req, principal)) return json(res, 403, { error: principal.shareId ? 'READ_ONLY_SHARE' : 'CSRF_INVALID' })
      let runtime
      try { runtime = resolveAccountBackend(principal, config) } catch { return json(res, 503, { error: 'RESEARCH_UNAVAILABLE' }) }
      if (req.method === 'GET') {
        try { return json(res, 200, await gateway.conversationModel(runtime, row.dsh_session_id)) }
        catch { return json(res, 503, { error: 'MODELS_UNAVAILABLE' }) }
      }
      const selection = await readJson(req)
      if (!selection || Object.keys(selection).some(key => !['provider', 'model'].includes(key))
        || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return json(res, 400, { error: 'INVALID_REQUEST' })
      try { return json(res, 200, await gateway.selectConversationModel(runtime, row.dsh_session_id, selection)) }
      catch { return json(res, 400, { error: 'MODEL_UNAVAILABLE' }) }
    }
    const workspaceModelsMatch = WORKSPACE_MODELS_PATH.exec(pathname)
    if (workspaceModelsMatch) {
      if (req.method !== 'GET') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      const principal = requestAccess(req)
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      const row = accessibleSession(principal, workspaceModelsMatch[1])
      if (!row?.dsh_session_id) return json(res, 404, { error: 'SESSION_NOT_FOUND' })
      let runtime
      try { runtime = resolveAccountBackend(principal, config) } catch { return json(res, 503, { error: 'RESEARCH_UNAVAILABLE' }) }
      try { return json(res, 200, await gateway.models(runtime, row.dsh_session_id)) }
      catch { return json(res, 503, { error: 'MODELS_UNAVAILABLE' }) }
    }
    const workspaceActionMatch = WORKSPACE_ACTION_PATH.exec(pathname)
    if (workspaceActionMatch) {
      if (req.method !== 'POST') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      const principal = requestAccess(req)
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      const row = accessibleSession(principal, workspaceActionMatch[1])
      if (!row?.dsh_session_id) return json(res, 404, { error: 'SESSION_NOT_FOUND' })
      if (!canWrite(req, principal)) return json(res, 403, { error: principal.shareId ? 'READ_ONLY_SHARE' : 'CSRF_INVALID' })
      const action = await readJson(req, 128_000)
      if (!action || !['edit', 'approve', 'choose', 'halt', 'resume', 'sync-context'].includes(action.action)) return json(res, 400, { error: 'INVALID_REQUEST' })
      let runtime
      try { runtime = resolveAccountBackend(principal, config) } catch { return json(res, 503, { error: 'RESEARCH_UNAVAILABLE' }) }
      try { return json(res, 200, await gateway.workspaceAction(runtime, row.dsh_session_id, action)) }
      catch (error) { return json(res, error?.status === 409 ? 409 : error?.status === 400 ? 400 : 503,
        { error: error?.status === 409 ? 'WORKSPACE_STALE' : error?.code || 'WORKSPACE_ACTION_FAILED' }) }
    }
    const workspaceDocumentMatch = WORKSPACE_DOCUMENT_PATH.exec(pathname)
    if (workspaceDocumentMatch) {
      if (req.method !== 'GET') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      const principal = requestAccess(req)
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      const row = accessibleSession(principal, workspaceDocumentMatch[1])
      if (!row?.dsh_session_id) return json(res, 404, { error: 'SESSION_NOT_FOUND' })
      let taskId, artifactId
      try { taskId = decodeURIComponent(workspaceDocumentMatch[2]); artifactId = decodeURIComponent(workspaceDocumentMatch[3]) }
      catch { return json(res, 404, { error: 'DOCUMENT_NOT_FOUND' }) }
      const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 256
        && value !== '.' && value !== '..' && /^[\p{L}\p{N}._:-]+$/u.test(value)
      if (!valid(taskId) || !valid(artifactId)) return json(res, 404, { error: 'DOCUMENT_NOT_FOUND' })
      let runtime
      try { runtime = resolveAccountBackend(principal, config) } catch { return json(res, 503, { error: 'RESEARCH_UNAVAILABLE' }) }
      try {
        const local = taskId === 'conversation'
          ? await deliverables.document(principal.slug, row.id, taskId, artifactId) : undefined
        if (taskId === 'conversation' && !local) return json(res, 404, { error: 'DOCUMENT_NOT_FOUND' })
        const result = local ? { document: local } : await gateway.document(runtime, row.dsh_session_id, taskId, artifactId)
        const item = result?.document
        const binaryPreview = workspaceDocumentMatch[4] === 'preview'
          && item?.mediaType === 'application/pdf' && /\.pdf$/i.test(item.name)
        if (workspaceDocumentMatch[4] === 'download' || binaryPreview) {
          if (typeof item?.content !== 'string' || typeof item.name !== 'string')
            return json(res, 404, { error: 'DOCUMENT_NOT_FOUND' })
          const bytes = item.encoding === 'base64' ? Buffer.from(item.content, 'base64') : Buffer.from(item.content, 'utf8')
          const name = item.name.split(/[\\/]/).at(-1).slice(0, 180).replace(/[\x00-\x1f\x7f"\\;]/g, '_') || 'document'
          const fallback = name.replace(/[^\x20-\x7e]/g, '_')
          const encodedName = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
          const mediaType = binaryPreview ? 'application/pdf'
            : /^[\w.+-]+\/[\w.+-]+$/.test(item.mediaType) ? item.mediaType : 'application/octet-stream'
          return send(res, 200, bytes, mediaType, {
            'content-length': String(bytes.length),
            'content-disposition': `${binaryPreview ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodedName}`,
            ...(binaryPreview ? { 'x-frame-options': 'SAMEORIGIN' } : {}),
          })
        }
        if (workspaceDocumentMatch[4] === 'preview') {
          if (item?.mediaType !== 'text/html' || !/\.html$/i.test(item.name) || typeof item.content !== 'string')
            return json(res, 404, { error: 'DOCUMENT_NOT_FOUND' })
          const content = item.encoding === 'base64' ? Buffer.from(item.content, 'base64') : item.content
          return send(res, 200, content, 'text/html; charset=utf-8', {
            'x-frame-options': 'SAMEORIGIN',
            'content-security-policy': "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
          })
        }
        return json(res, 200, result)
      }
      catch (error) { return json(res, error?.status === 404 ? 404 : 503,
        { error: error?.status === 404 ? 'DOCUMENT_NOT_FOUND' : 'DOCUMENT_UNAVAILABLE' }) }
    }
    const dataMatch = DATA_PATH.exec(pathname)
    if (dataMatch) {
      if (req.method !== 'GET') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      const principal = requestAccess(req)
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      const row = accessibleSession(principal, dataMatch[1])
      if (!row?.dsh_session_id) return json(res, 404, { error: 'SESSION_NOT_FOUND' })
      let runtime
      try { runtime = resolveAccountBackend(principal, config) } catch { return json(res, 503, { error: 'RESEARCH_UNAVAILABLE' }) }
      const query = new URL(req.url, config.publicOrigin).searchParams
      try {
        if (dataMatch[2]) {
          const offset = Number(query.get('offset') ?? '0')
          if (!Number.isSafeInteger(offset) || offset < 0) return json(res, 400, { error: 'INVALID_CURSOR' })
          return json(res, 200, await gateway.readDataset(runtime, row.dsh_session_id, dataMatch[2], offset))
        }
        const before = query.get('before') ?? undefined
        if (before && !/^\d{13}-[0-9a-f-]{36}$/i.test(before)) return json(res, 400, { error: 'INVALID_CURSOR' })
        return json(res, 200, await gateway.listDatasets(runtime, row.dsh_session_id, before))
      } catch (error) { return json(res, error?.status === 404 ? 404 : 503, { error: error?.status === 404 ? 'DATA_NOT_FOUND' : 'DATA_UNAVAILABLE' }) }
    }
    const questionMatch = QUESTION_PATH.exec(pathname)
    if (questionMatch) {
      const principal = requestAccess(req)
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      const row = accessibleSession(principal, questionMatch[1])
      if (!row?.dsh_session_id) return json(res, 404, { error: 'SESSION_NOT_FOUND' })
      let runtime
      try { runtime = resolveAccountBackend(principal, config) } catch { return json(res, 503, { error: 'RESEARCH_UNAVAILABLE' }) }
      if (req.method === 'GET') {
        try { return json(res, 200, await gateway.pendingQuestion(runtime, row.dsh_session_id)) }
        catch { return json(res, 503, { error: 'QUESTION_UNAVAILABLE' }) }
      }
      if (req.method === 'POST') {
        if (!canWrite(req, principal)) return json(res, 403, { error: principal.shareId ? 'READ_ONLY_SHARE' : 'CSRF_INVALID' })
        const body = await readJson(req)
        if (!body || typeof body.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.requestId)
          || !Array.isArray(body.answers)) return json(res, 400, { error: 'INVALID_REQUEST' })
        try { return json(res, 200, await gateway.answerQuestion(runtime, row.dsh_session_id, body.requestId, body.answers)) }
        catch (error) { return json(res, error?.status === 409 ? 409 : 503,
          { error: error?.status === 409 ? 'QUESTION_NOT_PENDING' : 'QUESTION_UNAVAILABLE' }) }
      }
      return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
    }
    const approvalMatch = APPROVAL_PATH.exec(pathname)
    if (approvalMatch) {
      const principal = requestAccess(req)
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      const row = accessibleSession(principal, approvalMatch[1])
      if (!row?.dsh_session_id || principal.backendRef !== 'zhijian-demo-c') return json(res, 404, { error: 'SESSION_NOT_FOUND' })
      let runtime
      try { runtime = resolveAccountBackend(principal, config) } catch { return json(res, 503, { error: 'RESEARCH_UNAVAILABLE' }) }
      if (req.method === 'GET') {
        try { return json(res, 200, await gateway.pendingApproval(runtime, row.dsh_session_id)) }
        catch { return json(res, 503, { error: 'APPROVAL_UNAVAILABLE' }) }
      }
      if (req.method === 'POST') {
        if (!canWrite(req, principal)) return json(res, 403, { error: principal.shareId ? 'READ_ONLY_SHARE' : 'CSRF_INVALID' })
        const body = await readJson(req)
        if (!body || Object.keys(body).some(key => !['id', 'decision'].includes(key))
          || typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.id)
          || !['allowed-once', 'rejected'].includes(body.decision)) return json(res, 400, { error: 'INVALID_REQUEST' })
        try { return json(res, 200, await gateway.answerApproval(runtime, row.dsh_session_id, body.id, body.decision)) }
        catch (error) { return json(res, error?.status === 409 ? 409 : 503,
          { error: error?.status === 409 ? 'APPROVAL_NOT_PENDING' : 'APPROVAL_UNAVAILABLE' }) }
      }
      return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
    }
    const conversationMatch = SESSION_PATH.exec(pathname)
    const attachmentMatch = ATTACHMENT_PATH.exec(pathname)
    if (attachmentMatch) {
      if (req.method !== 'POST' && req.method !== 'DELETE') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      const principal = requestAccess(req)
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      const row = accessibleSession(principal, attachmentMatch[1])
      if (!row?.dsh_session_id) return json(res, 404, { error: 'SESSION_NOT_FOUND' })
      if (!canWrite(req, principal)) return json(res, 403, { error: principal.shareId ? 'READ_ONLY_SHARE' : 'CSRF_INVALID' })
      let runtime
      try { runtime = resolveAccountBackend(principal, config) } catch { return json(res, 503, { error: 'RESEARCH_UNAVAILABLE' }) }
      if (req.method === 'DELETE') {
        const body = await readJson(req, 1024)
        if (!body || Object.keys(body).some(key => key !== 'path') || typeof body.path !== 'string')
          return json(res, 400, { error: 'INVALID_ATTACHMENT' })
        try { return json(res, 200, await gateway.removeAttachment(runtime, row.dsh_session_id, body.path)) }
        catch (error) { return json(res, error?.status === 404 ? 404 : 503,
          { error: error?.status === 404 ? 'ATTACHMENT_NOT_FOUND' : 'ATTACHMENT_UNAVAILABLE' }) }
      }
      const body = await readJson(req, Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 1024)
      if (!body || Object.keys(body).some(key => !['name', 'data'].includes(key))
        || typeof body.name !== 'string' || typeof body.data !== 'string') return json(res, 400, { error: 'INVALID_ATTACHMENT' })
      try { return json(res, 201, await gateway.uploadAttachment(runtime, row.dsh_session_id, body.name, body.data)) }
      catch (error) { return json(res, error?.status === 400 ? 400 : 503,
        { error: error?.status === 400 ? 'INVALID_ATTACHMENT' : 'ATTACHMENT_UNAVAILABLE' }) }
    }
    if (conversationMatch) {
      const principal = requestAccess(req)
      if (!principal) return json(res, 401, { error: 'UNAUTHENTICATED' })
      const row = accessibleSession(principal, conversationMatch[1])
      if (!row?.dsh_session_id) return json(res, 404, { error: 'SESSION_NOT_FOUND' })
      let runtime
      try { runtime = resolveAccountBackend(principal, config) } catch { return json(res, 503, { error: 'RESEARCH_UNAVAILABLE' }) }
      if (req.method === 'GET') {
        const params = new URL(req.url, config.publicOrigin).searchParams
        const after = Number(params.get('after') ?? '-1')
        const latest = params.get('latest') === '1'
        const before = params.has('before') ? Number(params.get('before')) : undefined
        if (!Number.isSafeInteger(after) || after < -1 || (params.has('latest') && !latest)
          || (latest && after !== -1) || (before !== undefined && (!latest || !Number.isSafeInteger(before) || before < 0)))
          return json(res, 400, { error: 'INVALID_CURSOR' })
        try {
          const page = await gateway.conversation(runtime, row.dsh_session_id, after, latest, before)
          if (!principal.shareId && after === -1 && before === undefined && !page.hasEarlier && row.title === '新会话') {
            const suggestion = page.messages?.filter(message => message.role === 'user')
              .map(message => titleFromUserMessage(message.text)).find(Boolean)
            if (suggestion) {
              try { store.setAutomaticSessionTitle(principal, row.id, suggestion) } catch { /* keep conversation readable */ }
            }
          }
          let resultPage = page
          if (principal.backendRef === 'zhijian-demo-c' && row.title?.startsWith('客户专家Agent ·')) {
            const key = `${principal.accountId}:${row.id}`
            let planId = osaPlanCache.get(key) ?? osaDemoPlan(page.messages)
            let seedPage
            if (!planId && (latest || after > -1)) {
              try {
                seedPage = await gateway.conversation(runtime, row.dsh_session_id, -1, false)
                planId = osaDemoPlan(seedPage.messages)
              } catch { /* cards are optional; keep the conversation readable */ }
            }
            if (planId) {
              osaPlanCache.set(key, planId)
              if (osaPlanCache.size > 256) osaPlanCache.delete(osaPlanCache.keys().next().value)
              const first = page.messages?.[0]
              let preceding = []
              try { preceding = await precedingConversation(gateway, runtime, row.dsh_session_id, first?.seq, seedPage) }
              catch { preceding = null }
              // If history cannot be reconstructed, withholding cards avoids repeating stale advice.
              if (preceding) resultPage = addOsaServiceCards(page, planId, preceding)
            }
          }
          const sessionTitle = !principal.shareId ? decorateSession(store, principal,
            store.getResearchSession(principal, row.id)).title : undefined
          return json(res, 200, { ...resultPage, ...(sessionTitle ? { sessionTitle } : {}) })
        }
        catch { return json(res, 503, { error: 'RESEARCH_UNAVAILABLE' }) }
      }
      if (req.method === 'POST') {
        if (!canWrite(req, principal)) return json(res, 403, { error: principal.shareId ? 'READ_ONLY_SHARE' : 'CSRF_INVALID' })
        const body = await readJson(req)
        if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20_000
          || typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId)) return json(res, 400, { error: 'INVALID_REQUEST' })
        if (body.mentions !== undefined && (!Array.isArray(body.mentions) || body.mentions.length > 4))
          return json(res, 400, { error: 'MENTION_UNAVAILABLE' })
        try {
          const result = await gateway.sendMessage(runtime, row.dsh_session_id, body.text, body.requestId, body.mentions ?? [])
          if (result.accepted === true && !principal.shareId) {
            const suggestion = titleFromUserMessage(body.text)
            if (suggestion) {
              try { store.setAutomaticSessionTitle(principal, row.id, suggestion) } catch { /* accepted message still succeeds */ }
            }
          }
          const sessionTitle = !principal.shareId ? decorateSession(store, principal,
            store.getResearchSession(principal, row.id)).title : undefined
          return json(res, 202, { ...result, ...(sessionTitle ? { sessionTitle } : {}) })
        }
        catch (error) { return json(res, error?.code === 'MENTION_UNAVAILABLE' ? 400 : 503,
          { error: error?.code === 'MENTION_UNAVAILABLE' ? 'MENTION_UNAVAILABLE' : 'RESEARCH_UNAVAILABLE' }) }
      }
      return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
    }
    if (pathname === '/api/auth/logout') {
      if (req.method !== 'POST') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      if (req.headers.authorization) return json(res, 403, { error: 'SHARE_SCOPE_DENIED' })
      const token = cookieValue(req, '__Host-zhijian-session')
      if (!authReady || !store.resolveBrowserSession(token)) return json(res, 401, { error: 'UNAUTHENTICATED' })
      if (req.headers.origin !== config.publicOrigin || !store.verifyCsrf(token, req.headers['x-csrf-token'])) return json(res, 403, { error: 'CSRF_INVALID' })
      store.revokeBrowserSession(token)
      return json(res, 200, { ok: true }, { 'set-cookie': [sessionCookie('', 0), csrfCookie('', 0)] })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
      return
    }
    const portrait = /^\/assets\/portraits\/([a-z0-9-]+\.webp)$/i.exec(pathname)
    const item = portrait ? [`assets/portraits/${portrait[1]}`, 'image/webp'] : assets.get(pathname)
    if (!item) {
      send(res, 404, 'Not Found', 'text/plain; charset=utf-8')
      return
    }
    try {
      const data = await readFile(new URL(item[0], dist))
      const hash = createHash('sha256').update(data).digest('hex')
      const etag = `"${hash}"`
      const version = new URL(req.url, config.publicOrigin).searchParams.get('v')
      const staticAsset = pathname.startsWith('/assets/') || pathname === '/favicon.ico' || pathname === '/demo/loading.css' || pathname === '/demo/loading.js'
      const cacheControl = !staticAsset ? 'no-store' : version === hash.slice(0, 12)
        ? 'public, max-age=31536000, immutable' : 'public, no-cache'
      const headers = { ...baseHeaders, 'cache-control': cacheControl, etag, 'content-type': item[1] }
      if (staticAsset && req.headers['if-none-match']?.split(',').some(value => value.trim() === etag)) {
        res.writeHead(304, headers)
        return res.end()
      }
      res.writeHead(200, headers)
      if (req.method === 'HEAD') res.end()
      else res.end(data)
    } catch {
      send(res, 503, 'Build output unavailable', 'text/plain; charset=utf-8')
    }
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  try {
    const config = readConfig()
    if (config.oidcIssuer) process.umask(0o077)
    const services = config.oidcIssuer ? {
      store: new AccountStore(config.accountDbPath),
      oidc: createOidcClient({ issuer: config.oidcIssuer, clientId: config.oidcClientId,
        redirectUri: `${config.publicOrigin}/api/auth/callback` }),
    } : {}
    const server = createPortalServer(config, services)
    server.listen(config.port, config.host, () => {
      process.stdout.write(`Customer portal listening on ${config.host}:${config.port}; public origin ${config.publicOrigin}\n`)
    })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unable to start portal'}\n`)
    process.exitCode = 1
  }
}
