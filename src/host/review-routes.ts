import { openReviewStream } from './review-stream.ts'
import type { ConversationPage } from './review-conversation.ts'
import type { ReviewSessionEvent } from './review-event-hub.ts'
import { readReviewContext } from './review-context.ts'
import { readStagedPlan } from '../staged-plan.ts'
import type { SharedTaskContext } from '../types.ts'
import { reviewPresentation } from './review-presentation.ts'
import { isRegisteredPortrait, hasPortraitAvatar } from '../review-portraits.ts'
/** Standalone Expert Teams review page and its scoped bearer-token API. */
import { listReviewDocuments, readReviewDocument } from './review-documents.ts'
import { reviewDocumentDigest, verifyReviewDocumentShare } from './review-document-share.ts'
import { publishReviewDocument } from './review-publication.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { TeamRouteRequest, TeamRouteRuntime, TeamRouteTarget } from './team-routes.ts'
import { exchangeReviewAccess, issueReviewAccess, revokeReviewAccess, revokeSessionReviewAccess, verifyReviewAccess, type ReviewAccessRecord } from './review-access.ts'

export const REVIEW_PREFIX = '/plugins/dsh-expert-library/review'
const COOKIE = 'expert_review_session_'
const ACCESS_ID = /^[a-f0-9]{24}$/u
const MAX_BODY = 128 * 1024
const VERSIONED_ASSET_CACHE = 'public, max-age=31536000, immutable'
const SHARED_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
}
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export interface ReviewRouteRuntime extends Pick<TeamRouteRuntime, 'hostAuth' | 'resolve' | 'read' | 'action' | 'modelCatalog'> {
  readonly stateRoots: () => readonly string[]
  readonly publicRenderRoot?: string
  readonly sendMessage?: (captainSessionId: string, text: string, requestId: string) => Promise<{ accepted: true }>
  readonly conversation?: (captainSessionId: string, after: number, latest?: boolean, before?: number) => Promise<ConversationPage>
  readonly contextSnapshot?: (captainSessionId: string, previous?: SharedTaskContext) => Promise<SharedTaskContext>
  readonly subscribeState?: (target: TeamRouteTarget, listener: () => void) => () => void
  readonly subscribeSession?: (captainSessionId: string, listener: (event: ReviewSessionEvent) => void) => () => void
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...SHARED_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(value))
}
function fail(res: ServerResponse, status: number, code: string): void { json(res, status, { ok: false, error: code }) }
function text(res: ServerResponse, status: number, value: string, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...SHARED_HEADERS, 'content-type': contentType, ...headers })
  res.end(value)
}
function header(req: IncomingMessage, key: string): string | undefined {
  const value = req.headers[key]
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
}
function sameOrigin(req: IncomingMessage): boolean {
  const origin = header(req, 'origin')
  const host = header(req, 'host')
  if (origin === undefined || host === undefined || origin === 'null') return false
  try {
    const parsed = new URL(origin)
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
    return parsed.host === host && (parsed.protocol === 'https:' || (local && parsed.protocol === 'http:')) && parsed.pathname === '/'
  } catch { return false }
}
function cookie(req: IncomingMessage, accessId: string): string | undefined {
  const raw = header(req, 'cookie') ?? ''
  if (raw.length > 8192) return undefined
  const name = `${COOKIE}${accessId}=`
  const item = raw.split(';').map(value => value.trim()).find(value => value.startsWith(name))
  return item?.slice(name.length)
}
function setCookie(req: IncomingMessage, accessId: string, value: string, seconds: number): string {
  // HTTP is permitted only on exact loopback origins by sameOrigin().
  const secure = header(req, 'origin')?.startsWith('https://') ? ' Secure;' : ''
  return `${COOKIE}${accessId}=${value}; Max-Age=${seconds}; Path=${REVIEW_PREFIX}; HttpOnly;${secure} SameSite=Strict`
}
async function body(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []; let size = 0; let done = false
    const finish = (value: Record<string, unknown> | undefined) => { if (!done) { done = true; resolve(value) } }
    req.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > MAX_BODY) finish(undefined); else chunks.push(Buffer.from(chunk)) })
    req.on('error', () => finish(undefined))
    req.on('end', () => {
      if (done) return
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        finish(value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined)
      } catch { finish(undefined) }
    })
  })
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value !== '.' && value !== '..' && /^[\p{L}\p{N}._:-]+$/u.test(value)
}
async function targetFor(runtime: ReviewRouteRuntime, grant: ReviewAccessRecord): Promise<TeamRouteTarget | undefined> {
  if (grant.teamId !== undefined) return runtime.resolve(grant.captainSessionId, grant.teamId, grant.planId)
  if (grant.planId === undefined) return undefined
  const staged = await runtime.resolve(grant.captainSessionId, undefined, grant.planId)
  if (staged === undefined) return undefined
  const wire = await runtime.read(staged)
  const appliedTeamId = wire.plan?.appliedTeamId
  return appliedTeamId === undefined ? staged : runtime.resolve(grant.captainSessionId, appliedTeamId, grant.planId)
}
async function asset(name: 'index.fast.html' | 'review.js' | 'review.css' | 'shared-document.html' | 'shared-document.js'): Promise<string> {
  return readFile(new URL(`../../assets/review/${name}`, import.meta.url), 'utf8')
}
function assetVersion(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** All review traffic is fenced here; the general team API remains Host-cookie-only. */
export async function handleReviewRoutes(req: IncomingMessage, res: ServerResponse, url: URL, runtime: ReviewRouteRuntime): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/u, '')
  if (path !== REVIEW_PREFIX && !path.startsWith(`${REVIEW_PREFIX}/`)) return false
  const method = req.method ?? 'GET'
  const portrait=/^\/plugins\/dsh-expert-library\/review\/portraits\/([a-z0-9-]+)\.webp$/.exec(path)
  const portraitId=portrait?.[1]??''
  const knownPortrait=isRegisteredPortrait(portraitId)||(portraitId.endsWith('-avatar')&&hasPortraitAvatar(portraitId.slice(0,-7)))
  if(method==='GET'&&portrait&&knownPortrait){
    try{const data=await readFile(new URL(`../../assets/review/portraits/${portrait[1]}.webp`,import.meta.url));res.writeHead(200,{'content-type':'image/webp','cache-control':'public, max-age=86400','x-content-type-options':'nosniff'});res.end(data)}catch{fail(res,404,'REVIEW_NOT_FOUND')}return true
  }
  if (method === 'GET' && [REVIEW_PREFIX, `${REVIEW_PREFIX}/review.js`, `${REVIEW_PREFIX}/review.css`, `${REVIEW_PREFIX}/document`, `${REVIEW_PREFIX}/shared-document.js`].includes(path)) {
    const name = path === REVIEW_PREFIX ? 'index.fast.html' : path.endsWith('/document') ? 'shared-document.html' : path.endsWith('shared-document.js') ? 'shared-document.js' : path.endsWith('.js') ? 'review.js' : 'review.css'
    try {
      if (name === 'shared-document.html') {
        const [html, js] = await Promise.all([asset(name), asset('shared-document.js')])
        text(res, 200, html.replace('__SHARED_DOCUMENT_JS_VERSION__', assetVersion(js)), 'text/html; charset=utf-8', {
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src blob:; frame-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        })
      } else if (name === 'index.fast.html') {
        const [html, js, css] = await Promise.all([asset('index.fast.html'), asset('review.js'), asset('review.css')])
        const page = html.replace('__REVIEW_JS_VERSION__', assetVersion(js)).replace('__REVIEW_CSS_VERSION__', assetVersion(css))
        text(res, 200, page, 'text/html; charset=utf-8', { 'content-security-policy': PAGE_CSP })
      } else {
        const content = await asset(name)
        const cache = url.searchParams.get('v') === assetVersion(content) ? VERSIONED_ASSET_CACHE : 'no-store'
        text(res, 200, content, name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', { 'cache-control': cache })
      }
    }
    catch { fail(res, 503, 'REVIEW_PAGE_UNAVAILABLE') }
    return true
  }
  if (!path.startsWith(`${REVIEW_PREFIX}/api/`)) { fail(res, 404, 'REVIEW_NOT_FOUND'); return true }
  if (path === `${REVIEW_PREFIX}/api/shared-document`) {
    if (method !== 'POST') { fail(res, 405, 'REVIEW_METHOD_NOT_ALLOWED'); return true }
    if (!sameOrigin(req)) { fail(res, 403, 'REVIEW_CSRF_REJECTED'); return true }
    const input = await body(req)
    const share = typeof input?.token === 'string' ? await verifyReviewDocumentShare(runtime.stateRoots(), input.token) : undefined
    if (!share) { fail(res, 401, 'DOCUMENT_SHARE_INVALID'); return true }
    try {
      const { record } = share
      const target = await runtime.resolve(record.captainSessionId, record.teamId)
      if (!target || target.stateRoot !== share.stateRoot || target.teamId !== record.teamId || target.captainSessionId !== record.captainSessionId) throw Error('DOCUMENT_UNAVAILABLE')
      const document = await readReviewDocument(target, record.taskId, record.artifactId)
      if (typeof document.content !== 'string' || typeof document.name !== 'string') throw Error('DOCUMENT_UNAVAILABLE')
      if (reviewDocumentDigest({ content: document.content, encoding: document.encoding }) !== record.documentSha256) throw Error('DOCUMENT_CHANGED')
      json(res, 200, { ok: true, document, expiresAt: record.expiresAt })
    } catch { fail(res, 410, 'DOCUMENT_SHARE_UNAVAILABLE') }
    return true
  }
  if (path === `${REVIEW_PREFIX}/api/issue` || path === `${REVIEW_PREFIX}/api/revoke`) {
    const refusal = runtime.hostAuth?.(req) ?? (runtime.hostAuth === undefined ? 401 : undefined)
    if (refusal !== undefined) { fail(res, refusal === 403 ? 403 : 401, 'REVIEW_HOST_AUTH_REQUIRED'); return true }
    if (method !== 'POST') { fail(res, 405, 'REVIEW_METHOD_NOT_ALLOWED'); return true }
    if (!sameOrigin(req)) { fail(res, 403, 'REVIEW_CSRF_REJECTED'); return true }
    const input = await body(req)
    if (input === undefined || !id(input.captainSessionId) || (input.planId !== undefined && !id(input.planId)) || (input.teamId !== undefined && !id(input.teamId))) { fail(res, 400, 'REVIEW_INVALID_INPUT'); return true }
    const target = await runtime.resolve(input.captainSessionId, input.teamId as string | undefined, input.planId as string | undefined)
    if (target === undefined || target.captainSessionId !== input.captainSessionId || target.archived) { fail(res, 404, 'REVIEW_TARGET_NOT_FOUND'); return true }
    if (path.endsWith('/revoke')) {
      const count = await revokeSessionReviewAccess(target.stateRoot, target.captainSessionId)
      json(res, 200, { ok: true, revoked: count }); return true
    }
    if (target.planId === undefined && target.teamId === undefined) { fail(res, 400, 'REVIEW_TARGET_NOT_READY'); return true }
    const issued = await issueReviewAccess(target.stateRoot, { captainSessionId: target.captainSessionId, ...(target.planId === undefined ? {} : { planId: target.planId }), ...(target.teamId === undefined ? {} : { teamId: target.teamId }) })
    json(res, 200, { ok: true, token: issued.token, expiresAt: issued.expiresAt, path: REVIEW_PREFIX }); return true
  }
  if (path === `${REVIEW_PREFIX}/api/exchange`) {
    if (method !== 'POST') { fail(res, 405, 'REVIEW_METHOD_NOT_ALLOWED'); return true }
    if (!sameOrigin(req)) { fail(res, 403, 'REVIEW_CSRF_REJECTED'); return true }
    const input = await body(req)
    const exchanged = typeof input?.token === 'string' ? await exchangeReviewAccess(runtime.stateRoots(), input.token) : undefined
    if (exchanged === undefined) { fail(res, 401, 'REVIEW_TOKEN_INVALID'); return true }
    json(res, 200, { ok: true, accessId: exchanged.record.id, expiresAt: exchanged.record.expiresAt }, { 'set-cookie': setCookie(req, exchanged.record.id, exchanged.cookie, Math.ceil((exchanged.record.expiresAt - Date.now()) / 1000)) })
    return true
  }
  const accessId = url.searchParams.get('access')
  if (accessId === null || !ACCESS_ID.test(accessId)) { fail(res, 401, 'REVIEW_LOGIN_REQUIRED'); return true }
  const access = await verifyReviewAccess(runtime.stateRoots(), cookie(req, accessId))
  if (access === undefined || access.record.id !== accessId) { fail(res, 401, 'REVIEW_LOGIN_REQUIRED'); return true }
  if (path === `${REVIEW_PREFIX}/api/document-share`) {
    if (method !== 'POST') { fail(res, 405, 'REVIEW_METHOD_NOT_ALLOWED'); return true }
    if (!sameOrigin(req)) { fail(res, 403, 'REVIEW_CSRF_REJECTED'); return true }
    const input = await body(req)
    if (!id(input?.taskId) || !id(input?.artifactId)) { fail(res, 400, 'REVIEW_INVALID_INPUT'); return true }
    const target = await targetFor(runtime, access.record)
    if (!target?.teamId || target.stateRoot !== access.stateRoot) { fail(res, 404, 'REVIEW_TARGET_NOT_FOUND'); return true }
    try {
      const documents = await listReviewDocuments(target)
      if (!documents.some(item => item.taskId === input.taskId && item.id === input.artifactId && !('draft' in item && item.draft === true))) throw Error('DOCUMENT_UNAVAILABLE')
      const document = await readReviewDocument(target, input.taskId, input.artifactId)
      if (typeof document.content !== 'string' || typeof document.name !== 'string') throw Error('DOCUMENT_UNAVAILABLE')
      const published = await publishReviewDocument(runtime.publicRenderRoot ?? '/var/www/dsh-render', {
        captainSessionId: target.captainSessionId, teamId: target.teamId, taskId: input.taskId, artifactId: input.artifactId,
      }, { name: document.name, content: document.content, encoding: document.encoding })
      json(res, 200, { ok: true, path: published.path, sha256: published.sha256 })
    } catch { fail(res, 409, 'DOCUMENT_SHARE_UNAVAILABLE') }
    return true
  }
  if (path === `${REVIEW_PREFIX}/api/events`) {
    if (method !== 'GET') { fail(res, 405, 'REVIEW_METHOD_NOT_ALLOWED'); return true }
    const rawAfter = url.searchParams.get('after') ?? '-1'
    const lastEventId = header(req, 'last-event-id')
    if (!/^(?:-1|0|[1-9][0-9]*)$/.test(rawAfter) || (lastEventId !== undefined && !/^(?:0|[1-9][0-9]*)$/.test(lastEventId))) {
      fail(res, 400, 'REVIEW_INVALID_INPUT'); return true
    }
    const after = Math.max(Number(rawAfter), lastEventId === undefined ? -1 : Number(lastEventId))
    if (!Number.isSafeInteger(after)) { fail(res, 400, 'REVIEW_INVALID_INPUT'); return true }
    const target = await targetFor(runtime, access.record)
    if (!target || target.captainSessionId !== access.record.captainSessionId) { fail(res, 404, 'REVIEW_TARGET_NOT_FOUND'); return true }
    if (!runtime.subscribeSession || !runtime.conversation) { fail(res, 503, 'REVIEW_EVENTS_UNAVAILABLE'); return true }
    res.writeHead(200, { ...SHARED_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no', connection: 'keep-alive' })
    await openReviewStream(res, {
      after, expiresAt: access.record.expiresAt, stateUpdates: runtime.subscribeState !== undefined,
      subscribe: listener => {
        const leaveSession = runtime.subscribeSession!(target.captainSessionId, listener)
        let leaveState: (() => void) | undefined
        try { leaveState = runtime.subscribeState?.(target, () => listener({ type: 'state' })) }
        catch { leaveSession(); throw Error('REVIEW_EVENTS_UNAVAILABLE') }
        return () => { leaveSession(); leaveState?.() }
      },
      read: (cursor, latest) => runtime.conversation!(target.captainSessionId, cursor, latest),
      authorized: async () => {
        const current = await verifyReviewAccess(runtime.stateRoots(), cookie(req, accessId))
        return current?.record.id === accessId
      },
    })
    return true
  }
  if (path === `${REVIEW_PREFIX}/api/state` && url.searchParams.get('view') === 'conversation') {
    if (method !== 'GET') { fail(res, 405, 'REVIEW_METHOD_NOT_ALLOWED'); return true }
    const rawAfter = url.searchParams.get('after') ?? '-1'
    const after = Number(rawAfter)
    if (!/^(?:-1|0|[1-9][0-9]*)$/.test(rawAfter) || !Number.isSafeInteger(after)) { fail(res, 400, 'REVIEW_INVALID_INPUT'); return true }
    const rawBefore = url.searchParams.get('before')
    const before = rawBefore === null ? Number.MAX_SAFE_INTEGER : Number(rawBefore)
    if (rawBefore !== null && (!/^(?:0|[1-9][0-9]*)$/.test(rawBefore) || !Number.isSafeInteger(before))) { fail(res, 400, 'REVIEW_INVALID_INPUT'); return true }
    const target = await targetFor(runtime, access.record)
    if (!target || target.captainSessionId !== access.record.captainSessionId) { fail(res, 404, 'REVIEW_TARGET_NOT_FOUND'); return true }
    if (!runtime.conversation) { fail(res, 503, 'REVIEW_CONVERSATION_UNAVAILABLE'); return true }
    try {
      const conversation = await runtime.conversation(target.captainSessionId, url.searchParams.get('latest') === '1' ? -1 : after, url.searchParams.get('latest') === '1', before)
      json(res, 200, { ok: true, conversation })
    } catch { fail(res, 503, 'REVIEW_CONVERSATION_UNAVAILABLE') }
    return true
  }
  if (path === `${REVIEW_PREFIX}/api/state`) {
    if (method !== 'GET') { fail(res, 405, 'REVIEW_METHOD_NOT_ALLOWED'); return true }
    const target = await targetFor(runtime, access.record)
    if (target === undefined) { fail(res, 404, 'REVIEW_TARGET_NOT_FOUND'); return true }
    try {
      if (url.searchParams.get('view') === 'context') {
        if (target.archived || target.teamId !== undefined || !access.record.planId || target.planId !== access.record.planId) { fail(res, 409, 'REVIEW_PLAN_LOCKED'); return true }
        const plan = await readStagedPlan(target.stateRoot, access.record.planId)
        if (!plan || plan.createdBy !== target.captainSessionId || plan.status !== 'staged') { fail(res, 409, 'REVIEW_PLAN_LOCKED'); return true }
        if (!runtime.contextSnapshot) { fail(res, 503, 'REVIEW_CONTEXT_UNAVAILABLE'); return true }
        const previous = plan.runtime.sharedTaskContext
        const latest = await runtime.contextSnapshot(target.captainSessionId, previous)
        json(res, 200, { ok: true, context: { planId: plan.planId, digest: plan.digest, revision: plan.revision,
          baselineSha256: previous?.sha256 ?? null, currentSha256: latest.sha256,
          changed: previous !== undefined && latest.sha256 !== previous.sha256,
          newMessages: previous === undefined ? [] : latest.messages.slice(previous.messages.length).map(({ id, seq, text }) => ({ id, seq, text })) } })
      } else if (url.searchParams.get('catalog') === 'models') {
        const wire = await runtime.read(target)
        if (target.archived || target.teamId !== undefined || wire.team || wire.plan?.status !== 'staged'
          || access.record.planId !== wire.plan.planId) { fail(res, 403, 'REVIEW_PLAN_LOCKED'); return true }
        const models = await runtime.modelCatalog?.(access.record.captainSessionId)
        if (models === undefined) { fail(res, 503, 'REVIEW_MODEL_CATALOG_UNAVAILABLE'); return true }
        json(res, 200, { ok: true, models: models.map(({ provider, model, name, reasoningEffort }) => ({ provider, model, name, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })) })
      } else if (url.searchParams.has('document')) {
        const task = url.searchParams.get('task'); const artifact = url.searchParams.get('document')
        if (!id(task) || !id(artifact)) { fail(res, 400, 'REVIEW_INVALID_INPUT'); return true }
        json(res, 200, { ok: true, document: await readReviewDocument(target, task, artifact) })
      } else {
        const wire = await runtime.read(target)
        const context = await readReviewContext(target).catch(() => undefined)
        const documents = await listReviewDocuments(target,context).catch(() => [])
        const presentation = context ? reviewPresentation(context,wire,documents) : undefined
        json(res, 200, { ok: true, expiresAt: access.record.expiresAt, captainSessionId: access.record.captainSessionId, ...wire, documents, presentation, canSendMessage: !target.archived && runtime.sendMessage !== undefined, canEditPlan: !target.archived && target.teamId === undefined && !wire.team && wire.plan?.status === 'staged' && access.record.planId === wire.plan.planId })
      }
    }
    catch { fail(res, 409, 'REVIEW_STATE_UNAVAILABLE') }
    return true
  }
  if (path === `${REVIEW_PREFIX}/api/logout`) {
    if (method !== 'POST' || !sameOrigin(req)) { fail(res, 403, 'REVIEW_CSRF_REJECTED'); return true }
    await revokeReviewAccess(access.stateRoot, access.record.id)
    json(res, 200, { ok: true }, { 'set-cookie': setCookie(req, accessId, '', 0) })
    return true
  }
  if (path !== `${REVIEW_PREFIX}/api/action`) { fail(res, 404, 'REVIEW_NOT_FOUND'); return true }
  if (method !== 'POST' || !sameOrigin(req)) { fail(res, 403, 'REVIEW_CSRF_REJECTED'); return true }
  const input = await body(req)
  const target = await targetFor(runtime, access.record)
  if (input === undefined || target === undefined) { fail(res, 400, 'REVIEW_INVALID_INPUT'); return true }
  if (input.action === 'message') {
    if (target.archived || target.captainSessionId !== access.record.captainSessionId) { fail(res, 403, 'REVIEW_MESSAGE_LOCKED'); return true }
    if (Object.keys(input).some(key => !['action', 'text', 'requestId'].includes(key))
      || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000
      || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(input.requestId)) { fail(res, 400, 'REVIEW_INVALID_INPUT'); return true }
    if (!runtime.sendMessage) { fail(res, 503, 'REVIEW_MESSAGE_UNAVAILABLE'); return true }
    try {
      const receipt = await runtime.sendMessage(target.captainSessionId, input.text.trim(), `review-${access.record.id}-${input.requestId}`)
      if (receipt.accepted !== true) throw Error('REVIEW_MESSAGE_UNAVAILABLE')
      json(res, 200, { ok: true, accepted: true, requestId: input.requestId })
    } catch { fail(res, 503, 'REVIEW_MESSAGE_UNAVAILABLE') }
    return true
  }
  let request: TeamRouteRequest
  if (input.action === 'sync-context' && id(access.record.planId) && target.planId === access.record.planId
    && Object.keys(input).every(key => ['action', 'expectedDigest', 'expectedRevision', 'expectedContextSha256'].includes(key))
    && typeof input.expectedDigest === 'string' && /^[a-f0-9]{64}$/u.test(input.expectedDigest)
    && Number.isSafeInteger(input.expectedRevision) && (input.expectedRevision as number) >= 0
    && typeof input.expectedContextSha256 === 'string' && /^[a-f0-9]{64}$/u.test(input.expectedContextSha256)) {
    const fresh = await runtime.read(target)
    if (target.archived || target.teamId !== undefined || fresh.team || fresh.plan?.status !== 'staged'
      || fresh.plan.planId !== access.record.planId) { fail(res, 409, 'REVIEW_PLAN_LOCKED'); return true }
    if (fresh.plan.digest !== input.expectedDigest || fresh.plan.revision !== input.expectedRevision) { fail(res, 409, 'REVIEW_PLAN_STALE'); return true }
    request = { action: 'edit', captainSessionId: access.record.captainSessionId, planId: access.record.planId,
      expectedDigest: input.expectedDigest, expectedRevision: input.expectedRevision as number,
      expectedContextSha256: input.expectedContextSha256, patch: {}, actor: 'scoped-review-token', reviewTokenId: access.record.id }
  } else if (input.action === 'edit' && id(access.record.planId) && target.planId === access.record.planId
    && typeof input.expectedDigest === 'string' && /^[a-f0-9]{64}$/u.test(input.expectedDigest)
    && Number.isSafeInteger(input.expectedRevision) && (input.expectedRevision as number) >= 0) {
    const patch = input.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0
      || Object.keys(patch).some(key => !['plan_models', 'research_selection', 'research_material_selection'].includes(key))) {
      fail(res, 400, 'REVIEW_INVALID_PATCH'); return true
    }
    const fresh = await runtime.read(target)
    if (target.archived || target.teamId !== undefined || fresh.team || fresh.plan?.status !== 'staged'
      || fresh.plan.planId !== access.record.planId) { fail(res, 409, 'REVIEW_PLAN_LOCKED'); return true }
    if (fresh.plan.digest !== input.expectedDigest || fresh.plan.revision !== input.expectedRevision) { fail(res, 409, 'REVIEW_PLAN_STALE'); return true }
    request = { action: 'edit', captainSessionId: access.record.captainSessionId, planId: access.record.planId,
      expectedDigest: input.expectedDigest, expectedRevision: input.expectedRevision as number, patch: patch as Record<string, unknown>, actor: 'scoped-review-token', reviewTokenId: access.record.id }
  } else if (input.action === 'approve' && id(access.record.planId) && target.planId === access.record.planId
    && typeof input.expectedDigest === 'string' && /^[a-f0-9]{64}$/u.test(input.expectedDigest)
    && Number.isSafeInteger(input.expectedRevision) && (input.expectedRevision as number) >= 0) {
    request = { action: 'approve', captainSessionId: access.record.captainSessionId, planId: access.record.planId, expectedDigest: input.expectedDigest, expectedRevision: input.expectedRevision as number, actor: 'scoped-review-token', reviewTokenId: access.record.id }
  } else if (input.action === 'choose' && target.teamId !== undefined && id(input.taskId)
    && ((typeof input.choice === 'string' && input.choice.length > 0 && input.choice.length <= 80 && input.choices === undefined)
      || (input.choice === undefined && Array.isArray(input.choices) && input.choices.length > 0 && input.choices.length <= 8
        && input.choices.every(choice => typeof choice === 'string' && choice.length > 0 && choice.length <= 200)))
    && typeof input.expectedSha256 === 'string' && /^[a-f0-9]{64}$/u.test(input.expectedSha256)) {
    request = { action: 'choose', captainSessionId: access.record.captainSessionId, teamId: target.teamId, taskId: input.taskId,
      ...(typeof input.choice === 'string' ? { choice: input.choice } : { choices: input.choices as string[] }),
      expectedSha256: input.expectedSha256, actor: 'scoped-review-token', reviewTokenId: access.record.id }
  } else if ((input.action === 'task-pause' || input.action === 'task-start') && !target.archived && target.teamId !== undefined
    && id(input.taskId) && typeof input.expectedAttemptId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/u.test(input.expectedAttemptId)
    && Object.keys(input).every(key => ['action', 'taskId', 'expectedAttemptId'].includes(key))) {
    request = { action: input.action, captainSessionId: access.record.captainSessionId, teamId: target.teamId,
      taskId: input.taskId, expectedAttemptId: input.expectedAttemptId, actor: 'scoped-review-token', reviewTokenId: access.record.id }
  } else if (input.action === 'task-recover' && !target.archived && target.teamId !== undefined
    && id(input.taskId) && typeof input.expectedAttemptId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/u.test(input.expectedAttemptId)
    && typeof input.expectedWaitReason === 'string' && input.expectedWaitReason.startsWith('RUNTIME_HOST_RESTART_UNCONFIRMED:')
    && input.expectedWaitReason.length <= 2000
    && Object.keys(input).every(key => ['action', 'taskId', 'expectedAttemptId', 'expectedWaitReason'].includes(key))) {
    request = { action: 'task-recover', captainSessionId: access.record.captainSessionId, teamId: target.teamId,
      taskId: input.taskId, expectedAttemptId: input.expectedAttemptId, expectedWaitReason: input.expectedWaitReason,
      actor: 'scoped-review-token', reviewTokenId: access.record.id }
  } else { fail(res, 400, 'REVIEW_ACTION_NOT_ALLOWED'); return true }
  try { json(res, 200, { ok: true, ...(await runtime.action(target, request)) }) }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : ''
    const stale = /stale|digest|revision|CAS|ALREADY_DECIDED|STALE_SOURCE/iu.test(message)
    const code = stale && /staged plan .* (?:digest|revision) is stale/u.test(message) ? 'REVIEW_PLAN_STALE'
      : /^(REVIEW_TASK_[A-Z_]+|REVIEW_SESSION_UNAVAILABLE|PLAN_MODEL_UNAVAILABLE|PLAN_CAPTAIN_MODEL_SWITCH_REQUIRED|PLAN_MODELS_INVALID|PLAN_OUTLINE_REQUIRED|PLAN_OUTLINE_INVALID|PLAN_OUTLINE_UNMAPPED_PRODUCER|PLAN_ARTIFACT_INPUTS_REQUIRED|PLAN_EXPERT_UNAVAILABLE|SHARED_TASK_CONTEXT_CHANGED|REVIEWED_REPORT_PLAN_REQUIRED|DEEP_RESEARCH_SELECTION_INVALID|PRESET_INPUT_FROZEN)/u.exec(message)?.[1]
    fail(res, stale || /^REVIEW_TASK_/u.test(message) || code === 'SHARED_TASK_CONTEXT_CHANGED' ? 409 : 400, code ?? 'REVIEW_ACTION_FAILED')
  }
  return true
}
