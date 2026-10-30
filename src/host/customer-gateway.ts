import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { verifyCustomerMentionSelections, type CustomerMention, type CustomerMentionSelection } from './customer-mentions.ts'
import type { CustomerQuestionAnswer, CustomerQuestionCard } from './customer-questions.ts'
import type { WebSearchPolicy } from './customer-web-search.ts'
import { CUSTOMER_UPLOAD_MAX_BYTES, validCustomerUpload } from './customer-uploads.ts'

export const CUSTOMER_GATEWAY_PREFIX = '/plugins/dsh-expert-library/customer-gateway'
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/
const SNAPSHOT_ID = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface CustomerGatewayRuntime {
  token(): Promise<string>
  presets?(): Promise<{ presets: { id: string; name?: string; description?: string; isDefault?: boolean }[]; defaultId: string }>
  createSpace?(path: string): Promise<{ path: string }>
  createSession(sessionId: string, spacePath?: string | null, presetId?: string | null): Promise<{ sessionId: string; presetId?: string }>
  sessionPreset?(sessionId: string): Promise<{ presetId: string; canSwitch: boolean }>
  selectSessionPreset?(sessionId: string, presetId: string): Promise<{ presetId: string; canSwitch: boolean }>
  ownsSession(sessionId: string): Promise<boolean>
  sendMessage(sessionId: string, text: string, requestId: string, mentions?: CustomerMentionSelection[]): Promise<{ accepted: true }>
  uploadAttachment?(sessionId: string, name: string, data: string): Promise<{ name: string; path: string; sizeBytes: number }>
  removeAttachment?(sessionId: string, path: string): Promise<void>
  conversation(sessionId: string, after: number, latest?: boolean, before?: number): Promise<unknown>
  listDatasets?(sessionId: string, before?: string): Promise<unknown>
  readDataset?(sessionId: string, datasetId: string, offset: number): Promise<unknown>
  activity?(sessionId: string): Promise<{ running: boolean }>
  activityBatch?(sessionIds: string[]): Promise<{ items: { sessionId: string; running: boolean }[] }>
  workspace?(sessionId: string): Promise<unknown>
  workspaceAction?(sessionId: string, action: CustomerWorkspaceAction): Promise<unknown>
  models?(sessionId: string): Promise<unknown>
  conversationModel?(sessionId: string): Promise<unknown>
  selectConversationModel?(sessionId: string, provider: string, model: string): Promise<unknown>
  document?(sessionId: string, taskId: string, artifactId: string): Promise<unknown>
  mentions?(): Promise<CustomerMention[]>
  pendingQuestion?(sessionId: string): CustomerQuestionCard | null
  answerQuestion?(sessionId: string, requestId: string, answers: CustomerQuestionAnswer[]): boolean
  webSearchPolicy?(sessionId: string): WebSearchPolicy
  setWebSearchPolicy?(sessionId: string, policy: WebSearchPolicy): void
  pendingApproval?(sessionId: string): { id: string; toolName: string; reason: string } | null
  answerApproval?(sessionId: string, id: string, decision: 'allowed-once' | 'rejected'): boolean
  adminSettings?(): Promise<unknown>
  adminModels?(): Promise<unknown>
  adminUsage?(days: 7 | 30): Promise<unknown>
  updateAdminSettings?(section: string, value: unknown, revision: number): Promise<unknown>
}

export type CustomerWorkspaceAction =
  | { action: 'edit' | 'approve'; expectedDigest: string; expectedRevision: number; patch?: Record<string, unknown> }
  | { action: 'sync-context'; expectedDigest: string; expectedRevision: number; expectedContextSha256: string }
  | { action: 'choose'; taskId: string; expectedSha256: string; choices: string[] }
  | { action: 'halt' | 'resume'; reason?: string }

const scopedId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 256 && value !== '.' && value !== '..' && /^[\p{L}\p{N}._:-]+$/u.test(value)
const planPatch = new Set(['team_name', 'goal', 'data', 'city', 'period', 'report_outline', 'plan_models'])
function workspaceAction(body: Record<string, unknown> | undefined): CustomerWorkspaceAction | undefined {
  if (!body || typeof body.action !== 'string') return undefined
  if (body.action === 'sync-context') {
    if (!Object.keys(body).every(key => ['action', 'expectedDigest', 'expectedRevision', 'expectedContextSha256'].includes(key))
      || typeof body.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/iu.test(body.expectedDigest)
      || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0
      || typeof body.expectedContextSha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(body.expectedContextSha256)) return undefined
    return { action: 'sync-context', expectedDigest: body.expectedDigest, expectedRevision: body.expectedRevision as number,
      expectedContextSha256: body.expectedContextSha256 }
  }
  if (body.action === 'edit' || body.action === 'approve') {
    if (typeof body.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/iu.test(body.expectedDigest)
      || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) return undefined
    if (body.action === 'approve') return Object.keys(body).every(key => ['action', 'expectedDigest', 'expectedRevision'].includes(key))
      ? { action: 'approve', expectedDigest: body.expectedDigest, expectedRevision: body.expectedRevision as number } : undefined
    if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)
      || !Object.keys(body.patch).length || Object.keys(body.patch).some(key => !planPatch.has(key))) return undefined
    return { action: 'edit', expectedDigest: body.expectedDigest, expectedRevision: body.expectedRevision as number,
      patch: body.patch as Record<string, unknown> }
  }
  if (body.action === 'choose') {
    if (!scopedId(body.taskId) || typeof body.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(body.expectedSha256)
      || !Array.isArray(body.choices) || body.choices.length < 1 || body.choices.length > 8
      || !body.choices.every(choice => typeof choice === 'string' && choice.length > 0 && choice.length <= 200)) return undefined
    return { action: 'choose', taskId: body.taskId, expectedSha256: body.expectedSha256, choices: body.choices }
  }
  if (body.action === 'halt' || body.action === 'resume') {
    if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 1000)) return undefined
    return { action: body.action, ...(typeof body.reason === 'string' ? { reason: body.reason } : {}) }
  }
  return undefined
}

const send = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(data))
}
const safeToken = (left: string, right: string): boolean => {
  const presented = Buffer.from(left), expected = Buffer.from(right)
  if (expected.length < 32 || presented.length !== expected.length) return false
  return timingSafeEqual(presented, expected)
}
const loopback = (address?: string) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
const PRESET_ID = /^[a-z][a-z0-9-]{0,63}$/u
const spacePath = (value: unknown): value is string => typeof value === 'string' && value.length <= 512
  && /^spaces(?:\/[\p{L}\p{N}_ -]{1,40}){1,5}$/u.test(value)

async function jsonBody(req: IncomingMessage, limit = 24_000): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return undefined
    chunks.push(chunk)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
}

/** Small service-to-service surface, mounted only in a one-account DSH instance. */
export async function handleCustomerGateway(req: IncomingMessage, res: ServerResponse, runtime: CustomerGatewayRuntime): Promise<void> {
  if (!loopback(req.socket.remoteAddress)) return send(res, 403, { error: 'FORBIDDEN' })
  const authorization = req.headers.authorization
  const configuredToken = await runtime.token().catch(() => '')
  if (!safeToken(typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '', configuredToken)) {
    return send(res, 401, { error: 'UNAUTHENTICATED' })
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const suffix = url.pathname.slice(CUSTOMER_GATEWAY_PREFIX.length)
  if (!url.pathname.startsWith(CUSTOMER_GATEWAY_PREFIX) || (suffix && !suffix.startsWith('/'))) return send(res, 404, { error: 'NOT_FOUND' })
  if (suffix === '/health' && req.method === 'GET') return send(res, 200, { ok: true })
  if (suffix === '/presets' && req.method === 'GET') {
    try { return send(res, 200, await runtime.presets?.() ?? { presets: [], defaultId: '' }) }
    catch { return send(res, 503, { error: 'PRESETS_UNAVAILABLE' }) }
  }
  if (suffix === '/spaces' && req.method === 'POST') {
    if (!runtime.createSpace) return send(res, 503, { error: 'SPACE_UNAVAILABLE' })
    const body = await jsonBody(req, 2_000)
    if (!body || Object.keys(body).some(key => key !== 'path') || !spacePath(body.path))
      return send(res, 400, { error: 'INVALID_SPACE' })
    try { return send(res, 201, await runtime.createSpace(body.path)) }
    catch (error) { return send(res, error instanceof Error && error.message === 'SPACE_EXISTS' ? 409 : 400,
      { error: error instanceof Error && error.message === 'SPACE_EXISTS' ? 'SPACE_EXISTS' : 'INVALID_SPACE' }) }
  }
  if (suffix === '/admin/settings') {
    if (req.method === 'GET') {
      try { return send(res, 200, await runtime.adminSettings?.() ?? { writable: false }) }
      catch { return send(res, 503, { error: 'SETTINGS_UNAVAILABLE' }) }
    }
    if (req.method !== 'PUT') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' })
    const body = await jsonBody(req, 32_000)
    if (!body || Object.keys(body).some(key => !['section', 'value', 'revision'].includes(key))
      || !['providers', 'toolExecution', 'packCenterUpdatePolicy', 'defaultModel', 'expertModelOverrides', 'runtime'].includes(String(body.section))
      || !Number.isSafeInteger(body.revision) || (body.revision as number) < 0
      || !body.value || typeof body.value !== 'object' || Array.isArray(body.value)
      || !runtime.updateAdminSettings) return send(res, 400, { error: 'INVALID_SETTINGS' })
    try { return send(res, 200, await runtime.updateAdminSettings(body.section as string, body.value, body.revision as number)) }
    catch (error) { return send(res, error instanceof Error && error.name === 'SettingsConflictError' ? 409 : 400,
      { error: error instanceof Error && error.name === 'SettingsConflictError' ? 'SETTINGS_CONFLICT' : 'INVALID_SETTINGS' }) }
  }
  if (suffix === '/admin/models' && req.method === 'GET') {
    try { return send(res, 200, { models: await runtime.adminModels?.() ?? [] }) }
    catch { return send(res, 503, { error: 'MODELS_UNAVAILABLE' }) }
  }
  if (suffix === '/admin/usage') {
    if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' })
    const days = url.searchParams.get('days') ?? '7'
    if (url.searchParams.size > 1 || (days !== '7' && days !== '30')) return send(res, 400, { error: 'INVALID_RANGE' })
    if (!runtime.adminUsage) return send(res, 503, { error: 'USAGE_UNAVAILABLE' })
    try { return send(res, 200, await runtime.adminUsage(Number(days) as 7 | 30)) }
    catch { return send(res, 503, { error: 'USAGE_UNAVAILABLE' }) }
  }
  if (suffix === '/mentions' && req.method === 'GET') {
    try { return send(res, 200, { items: await runtime.mentions?.() ?? [] }) }
    catch { return send(res, 503, { error: 'MENTIONS_UNAVAILABLE' }) }
  }
  if (suffix === '/sessions/activity-batch') {
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' })
    const body = await jsonBody(req)
    const ids = body?.sessionIds
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50
      || !ids.every(id => typeof id === 'string' && SESSION_ID.test(id))
      || new Set(ids).size !== ids.length) return send(res, 400, { error: 'INVALID_REQUEST' })
    if (!runtime.activityBatch) return send(res, 503, { error: 'ACTIVITY_UNAVAILABLE' })
    try {
      const started = Date.now()
      for (let offset = 0; offset < ids.length; offset += 6) {
        const owned = await Promise.all(ids.slice(offset, offset + 6).map(id => runtime.ownsSession(id).catch(() => false)))
        if (owned.some(value => !value)) return send(res, 404, { error: 'NOT_FOUND' })
      }
      const ownershipMs = Date.now() - started
      const result = await runtime.activityBatch(ids)
      if (Date.now() - started > 1_000) console.warn(`customer activity batch slow: count=${ids.length} ownershipMs=${ownershipMs} activityMs=${Date.now() - started - ownershipMs}`)
      return send(res, 200, result)
    } catch { return send(res, 503, { error: 'ACTIVITY_UNAVAILABLE' }) }
  }
  if (suffix === '/sessions' && req.method === 'POST') {
    const body = await jsonBody(req)
    if (!body || typeof body.sessionId !== 'string' || !SESSION_ID.test(body.sessionId)
      || (body.spacePath !== undefined && body.spacePath !== null && !spacePath(body.spacePath))
      || (body.presetId !== undefined && body.presetId !== null && (typeof body.presetId !== 'string' || !PRESET_ID.test(body.presetId)))
      || Object.keys(body).some(key => !['sessionId', 'spacePath', 'presetId'].includes(key))) return send(res, 400, { error: 'INVALID_REQUEST' })
    try {
      const created = await runtime.createSession(body.sessionId, body.spacePath as string | null | undefined, body.presetId as string | null | undefined)
      if (created.sessionId !== body.sessionId) throw new Error('session id mismatch')
      return send(res, 200, { sessionId: created.sessionId, presetId: created.presetId })
    } catch (error) { return send(res, error instanceof Error && error.message === 'INVALID_PRESET' ? 400 : 503,
      { error: error instanceof Error && error.message === 'INVALID_PRESET' ? 'INVALID_PRESET' : 'SESSION_UNAVAILABLE' }) }
  }
  const presetMatch = /^\/sessions\/(session-[0-9a-f-]+)\/preset$/iu.exec(suffix)
  if (presetMatch?.[1] && SESSION_ID.test(presetMatch[1])) {
    if (!await runtime.ownsSession(presetMatch[1]).catch(() => false)) return send(res, 404, { error: 'NOT_FOUND' })
    if (req.method === 'GET') {
      try { return send(res, 200, await runtime.sessionPreset?.(presetMatch[1]) ?? { presetId: '', canSwitch: false }) }
      catch { return send(res, 503, { error: 'PRESET_UNAVAILABLE' }) }
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' })
    if (!runtime.selectSessionPreset) return send(res, 503, { error: 'PRESET_UNAVAILABLE' })
    const body = await jsonBody(req, 1_000)
    if (!body || Object.keys(body).some(key => key !== 'presetId')
      || typeof body.presetId !== 'string' || !PRESET_ID.test(body.presetId)) return send(res, 400, { error: 'INVALID_PRESET' })
    try { return send(res, 200, await runtime.selectSessionPreset(presetMatch[1], body.presetId)) }
    catch (error) { return send(res, error instanceof Error && error.message === 'PRESET_LOCKED' ? 409 : 400,
      { error: error instanceof Error && error.message === 'PRESET_LOCKED' ? 'PRESET_LOCKED' : 'INVALID_PRESET' }) }
  }
  const attachmentMatch = /^\/sessions\/(session-[0-9a-f-]+)\/attachments$/i.exec(suffix)
  if (attachmentMatch?.[1] && SESSION_ID.test(attachmentMatch[1])) {
    if (req.method !== 'POST' && req.method !== 'DELETE') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' })
    if (!await runtime.ownsSession(attachmentMatch[1]).catch(() => false)) return send(res, 404, { error: 'NOT_FOUND' })
    if (req.method === 'DELETE') {
      if (!runtime.removeAttachment) return send(res, 503, { error: 'ATTACHMENT_UNAVAILABLE' })
      const body = await jsonBody(req, 1024)
      if (!body || Object.keys(body).some(key => key !== 'path') || typeof body.path !== 'string')
        return send(res, 400, { error: 'INVALID_ATTACHMENT' })
      try { await runtime.removeAttachment(attachmentMatch[1], body.path); return send(res, 200, { removed: true }) }
      catch (error) {
        const missing = error instanceof Error && (error.message.startsWith('INVALID_ATTACHMENT')
          || (error as NodeJS.ErrnoException).code === 'ENOENT')
        return send(res, missing ? 404 : 503, { error: missing ? 'ATTACHMENT_NOT_FOUND' : 'ATTACHMENT_UNAVAILABLE' })
      }
    }
    if (!runtime.uploadAttachment) return send(res, 503, { error: 'ATTACHMENT_UNAVAILABLE' })
    const body = await jsonBody(req, Math.ceil(CUSTOMER_UPLOAD_MAX_BYTES / 3) * 4 + 1024)
    if (!body || !validCustomerUpload(body.name, body.data) || Object.keys(body).some(key => !['name', 'data'].includes(key)))
      return send(res, 400, { error: 'INVALID_ATTACHMENT' })
    try { return send(res, 201, await runtime.uploadAttachment(attachmentMatch[1], body.name as string, body.data)) }
    catch (error) { return send(res, error instanceof Error && error.message === 'INVALID_ATTACHMENT' ? 400 : 503,
      { error: error instanceof Error && error.message === 'INVALID_ATTACHMENT' ? 'INVALID_ATTACHMENT' : 'ATTACHMENT_UNAVAILABLE' }) }
  }
  const approvalMatch = /^\/sessions\/(session-[0-9a-f-]+)\/approval$/i.exec(suffix)
  if (approvalMatch?.[1] && SESSION_ID.test(approvalMatch[1])) {
    const sessionId = approvalMatch[1]
    if (!await runtime.ownsSession(sessionId).catch(() => false)) return send(res, 404, { error: 'NOT_FOUND' })
    if (req.method === 'GET') return send(res, 200, { approval: runtime.pendingApproval?.(sessionId) ?? null })
    if (req.method === 'POST') {
      const body = await jsonBody(req)
      if (!body || Object.keys(body).some(key => !['id', 'decision'].includes(key))
        || typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.id)
        || (body.decision !== 'allowed-once' && body.decision !== 'rejected')) return send(res, 400, { error: 'INVALID_REQUEST' })
      return runtime.answerApproval?.(sessionId, body.id, body.decision)
        ? send(res, 200, { accepted: true }) : send(res, 409, { error: 'APPROVAL_NOT_PENDING' })
    }
    return send(res, 405, { error: 'METHOD_NOT_ALLOWED' })
  }
  const modelMatch = /^\/sessions\/(session-[0-9a-f-]+)\/model$/i.exec(suffix)
  if (modelMatch?.[1] && SESSION_ID.test(modelMatch[1])) {
    if (!await runtime.ownsSession(modelMatch[1]).catch(() => false)) return send(res, 404, { error: 'NOT_FOUND' })
    if (req.method === 'GET') {
      try { return send(res, 200, await runtime.conversationModel?.(modelMatch[1]) ?? { selected: null, models: [] }) }
      catch { return send(res, 503, { error: 'MODELS_UNAVAILABLE' }) }
    }
    if (req.method === 'POST') {
      const body = await jsonBody(req)
      if (!body || Object.keys(body).some(key => !['provider', 'model'].includes(key))
        || typeof body.provider !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(body.provider)
        || typeof body.model !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(body.model)) return send(res, 400, { error: 'INVALID_REQUEST' })
      try { return send(res, 200, await runtime.selectConversationModel?.(modelMatch[1], body.provider, body.model) ?? { error: 'MODELS_UNAVAILABLE' }) }
      catch { return send(res, 400, { error: 'MODEL_UNAVAILABLE' }) }
    }
    return send(res, 405, { error: 'METHOD_NOT_ALLOWED' })
  }
  const activityMatch = /^\/sessions\/(session-[0-9a-f-]+)\/activity$/i.exec(suffix)
  if (activityMatch?.[1] && SESSION_ID.test(activityMatch[1])) {
    if (!await runtime.ownsSession(activityMatch[1]).catch(() => false)) return send(res, 404, { error: 'NOT_FOUND' })
    if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' })
    if (!runtime.activity) return send(res, 503, { error: 'ACTIVITY_UNAVAILABLE' })
    try { return send(res, 200, await runtime.activity(activityMatch[1])) }
    catch { return send(res, 503, { error: 'ACTIVITY_UNAVAILABLE' }) }
  }
  const workspaceMatch = /^\/sessions\/(session-[0-9a-f-]+)\/workspace(?:\/(action|models|documents)(?:\/([^/]+)\/([^/]+))?)?$/i.exec(suffix)
  if (workspaceMatch?.[1] && SESSION_ID.test(workspaceMatch[1])) {
    if (!await runtime.ownsSession(workspaceMatch[1]).catch(() => false)) return send(res, 404, { error: 'NOT_FOUND' })
    if (!workspaceMatch[2] && req.method === 'GET') {
      try { return send(res, 200, await runtime.workspace?.(workspaceMatch[1]) ?? { plan: null, team: null, datasets: [] }) }
      catch { return send(res, 503, { error: 'WORKSPACE_UNAVAILABLE' }) }
    }
    if (workspaceMatch[2] === 'models' && req.method === 'GET') {
      try { return send(res, 200, { models: await runtime.models?.(workspaceMatch[1]) ?? [] }) }
      catch { return send(res, 503, { error: 'MODELS_UNAVAILABLE' }) }
    }
    if (workspaceMatch[2] === 'action' && req.method === 'POST' && runtime.workspaceAction) {
      const input = workspaceAction(await jsonBody(req, 128_000))
      if (!input) return send(res, 400, { error: 'INVALID_REQUEST' })
      try { return send(res, 200, await runtime.workspaceAction(workspaceMatch[1], input)) }
      catch (cause) {
        const code = cause instanceof Error ? cause.message : ''
        const known = /^(CUSTOMER_REPORT_DELIVERY_REQUIRED|PLAN_OUTLINE_REQUIRED|PLAN_OUTLINE_UNMAPPED_PRODUCER|PLAN_OUTLINE_INVALID|PLAN_MODELS_INVALID|PRESET_INPUT_FROZEN|REVIEW_SESSION_UNAVAILABLE|SHARED_TASK_CONTEXT_CHANGED|HUMAN_CHOICE_[A-Z_]+):?/u.exec(code)?.[1]
        return send(res, /stale|digest|revision|CAS|SHARED_TASK_CONTEXT_CHANGED/iu.test(code) ? 409 : 400,
          { error: known ?? 'WORKSPACE_ACTION_FAILED' })
      }
    }
    if (workspaceMatch[2] === 'documents' && req.method === 'GET' && runtime.document) {
      let taskId: string, artifactId: string
      try { taskId = decodeURIComponent(workspaceMatch[3] ?? ''); artifactId = decodeURIComponent(workspaceMatch[4] ?? '') }
      catch { return send(res, 404, { error: 'NOT_FOUND' }) }
      if (!scopedId(taskId) || !scopedId(artifactId)) return send(res, 404, { error: 'NOT_FOUND' })
      try { return send(res, 200, await runtime.document(workspaceMatch[1], taskId, artifactId)) }
      catch { return send(res, 404, { error: 'DOCUMENT_UNAVAILABLE' }) }
    }
    return send(res, 405, { error: 'METHOD_NOT_ALLOWED' })
  }
  const dataMatch = /^\/sessions\/(session-[0-9a-f-]+)\/datasets(?:\/([0-9a-f-]+))?$/i.exec(suffix)
  if (dataMatch?.[1] && SESSION_ID.test(dataMatch[1]) && req.method === 'GET') {
    const sessionId = dataMatch[1]
    if (!await runtime.ownsSession(sessionId).catch(() => false)) return send(res, 404, { error: 'NOT_FOUND' })
    try {
      if (dataMatch[2]) {
        if (!SNAPSHOT_ID.test(dataMatch[2])) return send(res, 404, { error: 'NOT_FOUND' })
        const offset = Number(url.searchParams.get('offset') ?? '0')
        if (!Number.isSafeInteger(offset) || offset < 0) return send(res, 400, { error: 'INVALID_CURSOR' })
        if (!runtime.readDataset) return send(res, 503, { error: 'DATA_UNAVAILABLE' })
        const row = await runtime.readDataset(sessionId, dataMatch[2], offset)
        return row ? send(res, 200, row) : send(res, 404, { error: 'NOT_FOUND' })
      }
      const before = url.searchParams.get('before') ?? undefined
      if (before !== undefined && !SNAPSHOT_ID.test(before)) return send(res, 400, { error: 'INVALID_CURSOR' })
      if (!runtime.listDatasets) return send(res, 503, { error: 'DATA_UNAVAILABLE' })
      return send(res, 200, await runtime.listDatasets(sessionId, before))
    } catch { return send(res, 503, { error: 'DATA_UNAVAILABLE' }) }
  }
  const webSearchMatch = /^\/sessions\/(session-[0-9a-f-]+)\/web-search$/i.exec(suffix)
  if (webSearchMatch?.[1] && SESSION_ID.test(webSearchMatch[1])) {
    const sessionId = webSearchMatch[1]
    if (!await runtime.ownsSession(sessionId).catch(() => false)) return send(res, 404, { error: 'NOT_FOUND' })
    if (!runtime.webSearchPolicy || !runtime.setWebSearchPolicy) return send(res, 503, { error: 'WEB_SEARCH_UNAVAILABLE' })
    if (req.method === 'GET') return send(res, 200, { policy: runtime.webSearchPolicy(sessionId) })
    if (req.method === 'PUT') {
      const body = await jsonBody(req, 200)
      if (!body || Object.keys(body).length !== 1 || !['ask', 'on', 'off'].includes(String(body.policy)))
        return send(res, 400, { error: 'INVALID_WEB_SEARCH_POLICY' })
      runtime.setWebSearchPolicy(sessionId, body.policy as WebSearchPolicy)
      return send(res, 200, { policy: runtime.webSearchPolicy(sessionId) })
    }
    return send(res, 405, { error: 'METHOD_NOT_ALLOWED' })
  }
  const questionMatch = /^\/sessions\/(session-[0-9a-f-]+)\/question$/i.exec(suffix)
  if (questionMatch?.[1] && SESSION_ID.test(questionMatch[1])) {
    const sessionId = questionMatch[1]
    if (!await runtime.ownsSession(sessionId).catch(() => false)) return send(res, 404, { error: 'NOT_FOUND' })
    if (req.method === 'GET') return send(res, 200, { question: runtime.pendingQuestion?.(sessionId) ?? null })
    if (req.method === 'POST') {
      const body = await jsonBody(req)
      if (!body || typeof body.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.requestId)
        || !Array.isArray(body.answers)) return send(res, 400, { error: 'INVALID_REQUEST' })
      return runtime.answerQuestion?.(sessionId, body.requestId, body.answers as CustomerQuestionAnswer[])
        ? send(res, 200, { accepted: true }) : send(res, 409, { error: 'QUESTION_NOT_PENDING' })
    }
    return send(res, 405, { error: 'METHOD_NOT_ALLOWED' })
  }
  const match = /^\/sessions\/(session-[0-9a-f-]+)\/messages$/i.exec(suffix)
  if (!match?.[1] || !SESSION_ID.test(match[1])) return send(res, 404, { error: 'NOT_FOUND' })
  const sessionId = match[1]
  if (!await runtime.ownsSession(sessionId).catch(() => false)) return send(res, 404, { error: 'NOT_FOUND' })
  if (req.method === 'GET') {
    const rawAfter = url.searchParams.get('after') ?? '-1'
    const after = Number(rawAfter)
    const rawLatest = url.searchParams.get('latest')
    const latest = rawLatest === '1'
    const rawBefore = url.searchParams.get('before')
    const before = rawBefore === null ? Number.MAX_SAFE_INTEGER : Number(rawBefore)
    if (!Number.isSafeInteger(after) || after < -1 || (rawLatest !== null && !latest)
      || (latest && after !== -1) || (rawBefore !== null && (!latest || !Number.isSafeInteger(before) || before < 0)))
      return send(res, 400, { error: 'INVALID_CURSOR' })
    try { return send(res, 200, await runtime.conversation(sessionId, after, latest, before)) }
    catch { return send(res, 503, { error: 'CONVERSATION_UNAVAILABLE' }) }
  }
  if (req.method === 'POST') {
    const body = await jsonBody(req)
    if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20_000
      || typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId)) return send(res, 400, { error: 'INVALID_REQUEST' })
    let verified: CustomerMentionSelection[]
    try {
      if (body.mentions !== undefined && (!Array.isArray(body.mentions) || body.mentions.length > 4))
        return send(res, 400, { error: 'MENTION_UNAVAILABLE' })
      const selected = body.mentions ?? []
      const hasMention = /(?:^|[\s(（])@([^\s@，。！？、,!?;；:：)\]）]{1,64})/u.test(body.text)
      const available = hasMention || selected.length ? await runtime.mentions?.() ?? [] : []
      const found = verifyCustomerMentionSelections(body.text, available, selected as CustomerMentionSelection[])
      if (found === undefined) return send(res, 400, { error: 'MENTION_UNAVAILABLE' })
      verified = found.map(({ kind, id, version, name }) => ({ kind, id, version, name }))
    } catch { return send(res, 503, { error: 'MENTIONS_UNAVAILABLE' }) }
    try { return send(res, 202, await runtime.sendMessage(sessionId, body.text, body.requestId, verified)) }
    catch { return send(res, 503, { error: 'MESSAGE_UNAVAILABLE' }) }
  }
  return send(res, 405, { error: 'METHOD_NOT_ALLOWED' })
}
