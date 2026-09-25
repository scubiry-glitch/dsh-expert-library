/** Same-origin management client. Secrets are held in closures, never storage or URLs. */
import type {
  CenterBindInput, CenterCatalogView, CenterConnectionView, CenterInstallationsView,
  CenterOperationInput, CenterOperationView, CenterReleaseDetail, CenterUpdatesView,
} from '../pack-center-wire.ts'

export const PACK_CENTER_MANAGE_URL = '/plugins/dsh-expert-library/manage/center'
export class CenterUiError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CenterUiError' }
}
type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown): value is string => typeof value === 'string'
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const boolean = (value: unknown): value is boolean => typeof value === 'boolean'
const nullableString = (value: unknown) => value === null || string(value)
const strings = (value: unknown) => Array.isArray(value) && value.every(string)
const fields = (value: RecordValue, names: string[]) => names.every(name => string(value[name]))
const optionalFields = (value: RecordValue, names: string[]) => names.every(name => value[name] === undefined || string(value[name]))
const array = (value: unknown, valid: (item: unknown) => boolean) => Array.isArray(value) && value.every(valid)
const digest = (value: unknown) => string(value) && /^[a-f0-9]{64}$/.test(value)
const safeCode = (value: unknown): string => string(value) && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'REQUEST_FAILED'
export const centerUiErrorCode = (error: unknown): string => error instanceof CenterUiError ? safeCode(error.code) : 'REQUEST_FAILED'
/** Display-only eligibility; the host repeats the authoritative SemVer/identity checks. */
export function isOlderCenterVersion(candidate: string, current: string): boolean {
  const parse = (value: string) => {
    const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value)
    return parts?.[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0')) ? null : parts
  }
  const a = parse(candidate), b = parse(current)
  if (!a || !b) return false
  for (let index = 1; index <= 3; index++) {
    const left = BigInt(a[index]!), right = BigInt(b[index]!)
    if (left !== right) return left < right
  }
  if (a[4] === undefined || b[4] === undefined) return a[4] !== undefined && b[4] === undefined
  const left = a[4].split('.'), right = b[4].split('.')
  if ([...left, ...right].some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return false
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index], y = right[index]
    if (x === undefined || y === undefined) return x === undefined && y !== undefined
    if (x === y) continue
    const numericX = /^\d+$/.test(x), numericY = /^\d+$/.test(y)
    if (numericX && numericY) return BigInt(x) < BigInt(y)
    if (numericX !== numericY) return numericX
    return x < y
  }
  return false
}
const summary = (value: unknown): boolean => record(value)
  && fields(value, ['releaseId', 'packId', 'version', 'ownerOrgId', 'name', 'publishedAt'])
  && ['manifestSha256', 'artifactSha256', 'contentTreeSha256'].every(key => digest(value[key]))
  && record(value.compatibility) && boolean(value.compatibility.compatible) && strings(value.compatibility.reasons)
  && record(value.downloadAvailability) && boolean(value.downloadAvailability.available) && optionalFields(value.downloadAvailability, ['code'])
  && array(value.dependencies, item => record(item) && fields(item, ['packId', 'releaseId', 'version']))
const installed = (value: unknown): boolean => record(value)
  && fields(value, ['releaseId', 'packId', 'version', 'installedAt', 'artifactSha256', 'contentTreeSha256'])
  && optionalFields(value, ['centerId', 'ownerOrgId', 'previousReleaseId', 'errorCode', 'manifestSha256'])
  && ['center', 'legacy'].includes(String(value.source)) && boolean(value.active)
  && ['verified', 'unavailable'].includes(String(value.integrity))
const snapshot = (value: RecordValue): boolean => nullableString(value.checkedAt) && boolean(value.hasSnapshot) && boolean(value.stale) && optionalFields(value, ['errorCode'])
const operation = (value: unknown): boolean => record(value)
  && fields(value, ['operationId', 'phase', 'createdAt', 'updatedAt'])
  && optionalFields(value, ['errorCode'])
  && ['queued', 'running', 'succeeded', 'failed', 'interrupted'].includes(String(value.status))
  && record(value.request) && string(value.request.operationKey) && integer(value.request.expectedGeneration)
  && optionalFields(value.request, ['releaseId', 'packId'])
  && ['install', 'update_enable', 'enable', 'disable', 'rollback', 'uninstall'].includes(String(value.request.kind))
  && (value.result === undefined || (record(value.result) && integer(value.result.generation)
    && optionalFields(value.result, ['releaseId', 'packId', 'errorCode'])
    && ['succeeded', 'installed_not_enabled'].includes(String(value.result.outcome))))
const connection = (value: unknown): boolean => record(value) && boolean(value.configured)
  && optionalFields(value, ['errorCode'])
  && nullableString(value.configuredOrigin) && boolean(value.activationAvailable) && integer(value.revision)
  && (value.connection === null || (record(value.connection)
    && fields(value.connection, ['origin', 'centerId', 'organizationId', 'deploymentId', 'credentialId', 'credentialExpiresAt', 'boundAt'])
    && boolean(value.connection.bound) && record(value.connection.signingKeyFingerprints)
    && Object.values(value.connection.signingKeyFingerprints).every(string)))
const catalog = (value: unknown): boolean => record(value) && snapshot(value)
  && nullableString(value.nextCursor) && array(value.items, summary)
const installations = (value: unknown): boolean => record(value) && integer(value.generation)
  && optionalFields(value, ['warningCode'])
  && ['normal', 'recovered-read-only'].includes(String(value.mode)) && array(value.items, installed)
const updates = (value: unknown): boolean => record(value) && snapshot(value) && integer(value.generation)
  && array(value.items, item => record(item) && string(item.packId) && installed(item.current)
    && (item.latestVisible === null || summary(item.latestVisible)) && (item.candidate === null || summary(item.candidate))
    && boolean(item.candidateCached) && ['update_available', 'blocked', 'no_stable_release', 'up_to_date'].includes(String(item.status))
    && array(item.blockedReasons, reason => record(reason) && string(reason.releaseId) && strings(reason.reasons)))
const detail = (value: unknown): boolean => summary(value) && record(value)
  && fields(value, ['sourceCommit', 'notes', 'license']) && record(value.validation) && boolean(value.validation.valid)
  && array(value.validation.diagnostics, item => record(item) && fields(item, ['severity', 'code', 'message']))
  && record(value.diff) && boolean(value.diff.available) && string(value.diff.text) && optionalFields(value.diff, ['code'])

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new CenterUiError('INVALID_RESPONSE')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new CenterUiError('RESPONSE_TOO_LARGE') }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
    catch { throw new CenterUiError('INVALID_RESPONSE') }
  } finally { reader.releaseLock() }
}

export function createPackCenterApi(manageToken = '', fetcher: typeof fetch = fetch) {
  let closed = false
  const pending = new Set<AbortController>()
  async function request<T>(path: string, valid: (value: unknown) => boolean, body?: unknown): Promise<T> {
    if (closed) throw new CenterUiError('REQUEST_ABORTED')
    const controller = new AbortController()
    pending.add(controller)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 45_000)
    try {
      const response = await fetcher(`${PACK_CENTER_MANAGE_URL}${path}`, {
        method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', mode: 'same-origin',
        redirect: 'error', referrerPolicy: 'same-origin', signal: controller.signal,
        headers: {
          accept: 'application/json', 'x-pack-center-ui': '1',
          ...(manageToken ? { 'x-expert-library-manage-token': manageToken } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const envelope = await boundedJson(response)
      if (controller.signal.aborted || closed) throw new CenterUiError('REQUEST_ABORTED')
      if (!record(envelope)) throw new CenterUiError('INVALID_RESPONSE')
      if (!response.ok || envelope.ok !== true) {
        throw new CenterUiError(record(envelope.error) ? safeCode(envelope.error.code) : 'REQUEST_FAILED')
      }
      if (!valid(envelope.data)) throw new CenterUiError('INVALID_RESPONSE')
      return envelope.data as T
    } catch (error) {
      if (timedOut) throw new CenterUiError('REQUEST_TIMEOUT')
      if (controller.signal.aborted || closed) throw new CenterUiError('REQUEST_ABORTED')
      if (error instanceof CenterUiError) throw error
      throw new CenterUiError('REQUEST_FAILED')
    } finally { clearTimeout(timer); pending.delete(controller) }
  }
  return {
    close() { closed = true; for (const controller of pending) controller.abort(); pending.clear() },
    connection: () => request<CenterConnectionView>('/connection', connection),
    bind: (input: CenterBindInput) => request<CenterConnectionView>('/bind', connection, input),
    unbind: (expectedRevision: number) => request<CenterConnectionView>('/unbind', connection, { expectedRevision }),
    catalog(input: { packId?: string; limit?: number; beforeId?: string } = {}) {
      const query = new URLSearchParams()
      if (input.packId) query.set('packId', input.packId)
      if (input.limit !== undefined) query.set('limit', String(input.limit))
      if (input.beforeId) query.set('beforeId', input.beforeId)
      return request<CenterCatalogView>(`/catalog${query.size ? `?${query}` : ''}`, catalog)
    },
    release: (id: string) => request<CenterReleaseDetail>(`/releases/${encodeURIComponent(id)}`, detail),
    installations: () => request<CenterInstallationsView>('/installations', installations),
    updates: () => request<CenterUpdatesView>('/updates', updates),
    checkUpdates: () => request<CenterUpdatesView>('/check-updates', updates, {}),
    enqueue: (input: CenterOperationInput) => request<CenterOperationView>('/operations', operation, input),
    operations: () => request<CenterOperationView[]>('/operations', value => array(value, operation)),
    operation: (id: string) => request<CenterOperationView>(`/operations/${encodeURIComponent(id)}`, operation),
    retry: (id: string) => request<CenterOperationView>(`/operations/${encodeURIComponent(id)}/retry`, operation, {}),
  }
}
export type PackCenterApi = ReturnType<typeof createPackCenterApi>
