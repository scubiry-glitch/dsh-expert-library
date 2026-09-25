/**
 * Shared client infrastructure for the Expert Library `/manage/*` routes:
 * authorization token storage/headers, guarded fetch helpers, and the wire
 * types used by both 「专家库」 (manage-card.tsx) and 「领域包 · 本地来源」
 * (pack-local-panel.tsx). Wire constants are declared on both sides of the
 * wire (the client bundle must not import host modules).
 * @module dsh-expert-library/client/manage-client
 */

export const MANAGE_BASE = '/plugins/dsh-expert-library/manage'

/**
 * 与 host `src/host/auth.ts` 的 `MANAGE_TOKEN_HEADER` 对齐。
 */
const MANAGE_TOKEN_HEADER = 'x-expert-library-manage-token'

/** 授权令牌的本地存储键。 */
const TOKEN_STORAGE_KEY = 'dsh-expert-library.manageToken'

/** 管理操作响应（host 统一信封）。 */
export interface ManageResponse {
  readonly ok: boolean
  readonly error?: string
  readonly id?: string
  readonly name?: string
  readonly files?: number
  readonly stdout?: string
  readonly stderr?: string
}

/**
 * host 侧对整个 `/manage/*` 按「回环或持令牌」放行：从本机地址打开设置页
 * 无需令牌，经公网域名打开则需要。令牌随请求头送，不存在于 URL 里。
 */
let manageToken = readStoredToken()

function readStoredToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ?? ''
  } catch {
    // 隐私模式下 localStorage 不可用；未持令牌即只能回环访问。
    return ''
  }
}

/** 当前令牌（页面初始化输入框用）。 */
export function getManageToken(): string {
  return manageToken
}

/** 设置令牌并持久化；空串表示仅本机可用。 */
export function setManageToken(value: string): void {
  manageToken = value.trim()
  try {
    if (manageToken === '') window.localStorage.removeItem(TOKEN_STORAGE_KEY)
    else window.localStorage.setItem(TOKEN_STORAGE_KEY, manageToken)
  } catch {
    // 同上：存不下就只在本会话内有效，不阻断使用。
  }
}

/** 合并授权头；未设令牌时返回 undefined，让 fetch 用默认值。 */
export function manageHeaders(extra?: Record<string, string>): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...extra }
  if (manageToken !== '') headers[MANAGE_TOKEN_HEADER] = manageToken
  return Object.keys(headers).length === 0 ? undefined : headers
}

/** host 拒绝时的提示：区分「没带令牌」与「令牌不对」。 */
export function describeAuthFailure(status: number, error: string | undefined): string {
  if (status !== 403) return error ?? `HTTP ${status}`
  return manageToken === ''
    ? '本机地址之外的访问需要授权令牌：请在「权限」页填入 host 的 manageToken 后重试。'
    : '授权令牌无效或已变更：请核对后重填。'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 通用 JSON 请求。 */
export async function jsonFetch(path: string, method: string, body?: unknown): Promise<ManageResponse> {
  const res = await fetch(path, {
    method,
    cache: 'no-store' as RequestCache,
    headers: manageHeaders(body === undefined ? undefined : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let value: unknown = null
  try {
    value = await res.json()
  } catch {
    value = null
  }
  if (isRecord(value) && typeof value['ok'] === 'boolean') {
    if (value['ok'] === false && !res.ok) {
      return { ok: false, error: describeAuthFailure(res.status, typeof value['error'] === 'string' ? value['error'] : undefined) } as unknown as ManageResponse
    }
    return value as unknown as ManageResponse
  }
  return { ok: false, error: describeAuthFailure(res.status, undefined) }
}

/** 列表请求守卫。 */
export async function listFetch<T>(path: string, key: string): Promise<T[]> {
  try {
    const res = await fetch(path, { cache: 'no-store' as RequestCache, headers: manageHeaders() })
    if (!res.ok) return []
    const value: unknown = await res.json()
    if (isRecord(value) && Array.isArray(value[key])) return value[key] as T[]
  } catch {
    return []
  }
  return []
}

/** 包重建白名单（与 host PACK_BUILD_ALLOWLIST 对齐；不齐时 host 会拒绝）。 */
export const REBUILD_ALLOWLIST = ['zhijian-realestate', 'bank-finance', 'beike', 'pipeline-domains', 'pipeline-general', 'builtin-library']

/** 一个已入库的外部来源包（GET /manage/packs/registry）。
 * `state` 由 host 重算树摘要得出：clean = 与入库时一致，modified = 本地被改过。 */
export interface VendoredPackWire {
  readonly id: string
  readonly locator: string
  readonly revision: string
  readonly trust: string
  readonly state: string
  readonly rollbackAvailable: boolean
}
