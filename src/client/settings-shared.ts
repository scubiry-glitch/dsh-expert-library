/**
 * Shared wire types + helpers for the Expert Library settings-family cards
 * (智见数据 / 领域包校验 / 专家库管理 / 专家库运行). Wire types are mirrored
 * from the host (`src/host/health.ts`, `src/v2/preview.ts`) — the client
 * bundle must not import host modules.
 * @module dsh-expert-library/client/settings-shared
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { ExpertLibrarySettings } from '../settings.ts'

export type ExpertLibrarySettingsScope = SettingsScope<ExpertLibrarySettings>

export const HEALTH_URL = '/plugins/dsh-expert-library/health'
export const PACKS_URL = '/plugins/dsh-expert-library/packs'
export const EXPERTS_URL = '/plugins/dsh-expert-library/experts'

export type ProviderId = 'wind' | 'zyt' | 'beike'

/** Tool ids whose execution mode is user-configurable (provider id = tool id). */
export const TOOL_IDS: readonly ProviderId[] = ['wind', 'zyt', 'beike']

export const TOOL_LABEL: Record<ProviderId, string> = {
  wind: 'Wind',
  zyt: '政研通 zyt',
  beike: '贝壳 beike',
}

export const MODE_LABEL: Record<string, string> = {
  api: 'API',
  cli: 'CLI',
  auto: '自动',
}

export const SOURCE_LABEL: Record<string, string> = {
  override: '设置覆盖',
  expert: '专家预设',
  default: '全局默认',
  none: '未配置',
}

export const DRIFT_LABEL: Record<PackHealthWire['drift'], string> = {
  clean: '一致',
  dirty: '有漂移',
  unknown: '无基准',
}

export const LAYER_LABEL: Record<string, string> = {
  builtin: '内置',
  workspace: '工作区',
}

export interface WindHealthWire {
  readonly registered: boolean
  readonly cliPath?: string
  readonly cliExists: boolean
  readonly keyPresent: boolean
  readonly detail?: string
}

export interface ZytHealthWire {
  readonly registered: boolean
  readonly baseUrl: string
  readonly keyPresent: boolean
  readonly reachable?: boolean
  readonly latencyMs?: number
  readonly identity?: { readonly tenantName?: string; readonly dataView?: string }
  readonly detail?: string
}

export interface BeikeHealthWire {
  readonly registered: boolean
  readonly baseUrl: string
  readonly keyPresent: boolean
  readonly reachable?: boolean
  readonly latencyMs?: number
  readonly serverInfo?: string
  readonly detail?: string
}

export interface PackHealthWire {
  readonly id: string
  readonly version: string
  readonly experts: number
  readonly scenarios: number
  readonly sha256: string
  readonly drift: 'clean' | 'dirty' | 'unknown'
}

export interface HealthWire {
  readonly checkedAt: string
  readonly providers: {
    readonly wind: WindHealthWire
    readonly zyt: ZytHealthWire
    readonly beike: BeikeHealthWire
  }
  readonly packs: readonly PackHealthWire[]
}

/** One expert row of `GET /experts`. */
export interface ExpertRouteWire {
  readonly id: string
  readonly name: string
  readonly field?: string
  readonly stance?: string
  readonly initials?: string
  readonly role?: string
  readonly deceased?: boolean
  readonly namespace?: string
  readonly version?: string
  readonly preset?: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
  readonly override?: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
  readonly effective?: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
  readonly source: 'override' | 'expert' | 'default' | 'none'
}

/** One pack row of `GET /packs`. */
export interface PackSummaryWire {
  readonly id: string
  readonly version: string
  readonly name: string
  readonly layer: string
  readonly ok: boolean
  readonly errorCount: number
  readonly counts: Record<string, number>
}

/** One tool-execution draft row (mirrors ToolExecutionConfig). */
export interface ToolExecutionDraft {
  readonly mode: 'api' | 'cli' | 'auto'
  readonly readOnly: boolean
}

/** Route override draft for one expert. */
export interface RouteOverrideDraft {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function number(value: unknown): string {
  return typeof value === 'number' ? String(value) : ''
}

export function isHealthWire(body: unknown): body is HealthWire {
  if (typeof body !== 'object' || body === null) return false
  const record = body as Record<string, unknown>
  return typeof record['checkedAt'] === 'string'
    && typeof record['providers'] === 'object' && record['providers'] !== null
    && Array.isArray(record['packs'])
}

export function isExpertRouteWire(body: unknown): body is { experts?: unknown } {
  return typeof body === 'object' && body !== null && Array.isArray((body as Record<string, unknown>)['experts'])
}

/** Status dot + label + color key for one provider's health row. */
export function providerStatus(provider: ProviderId, health: HealthWire | null): {
  readonly dot: string
  readonly label: string
  readonly key: 'ok' | 'warn' | 'error' | 'idle'
} {
  if (health === null) return { dot: '⚪', label: '未探测', key: 'idle' }
  const entry = health.providers[provider]
  if (!entry.registered) return { dot: '⚪', label: '未注册', key: 'idle' }
  if (!entry.keyPresent) return { dot: '🟠', label: '未配置凭据', key: 'warn' }
  if (provider === 'wind') {
    const wind = health.providers.wind
    if (!wind.cliExists) return { dot: '🔴', label: 'CLI 缺失', key: 'error' }
    return { dot: '🟢', label: '就绪', key: 'ok' }
  }
  const probed = entry as ZytHealthWire | BeikeHealthWire
  if (probed.reachable === true) return { dot: '🟢', label: '可通', key: 'ok' }
  if (probed.reachable === false) return { dot: '🔴', label: '探测失败', key: 'error' }
  return { dot: '⚪', label: '未探测', key: 'idle' }
}

/** Inline result line of the latest 检测 for one provider. */
export function probeResultLine(provider: ProviderId, health: HealthWire | null): string {
  if (health === null) return ''
  const entry = health.providers[provider]
  const parts: string[] = []
  const probed = entry as ZytHealthWire | BeikeHealthWire
  if (typeof probed.latencyMs === 'number') parts.push(`${probed.latencyMs}ms`)
  const identity = (probed as ZytHealthWire).identity
  if (identity !== undefined) {
    parts.push([identity.tenantName, identity.dataView].filter((part) => part !== undefined).join(' · '))
  }
  const serverInfo = (probed as BeikeHealthWire).serverInfo
  if (serverInfo !== undefined) parts.push(serverInfo)
  if (entry.detail !== undefined) parts.push(entry.detail)
  return parts.filter((part) => part !== '').join('；')
}

/** Compact route text: provider/model (effort). */
export function routeText(route: RouteOverrideDraft | undefined): string {
  if (route === undefined) return '—'
  const base = [route.provider, route.model].filter((part) => part !== undefined && part !== '').join('/')
  return route.reasoningEffort === undefined || route.reasoningEffort === ''
    ? (base === '' ? '—' : base)
    : `${base}（${route.reasoningEffort}）`
}

/** Normalize an override draft for writing: drop empty fields; drop the
 * whole entry when nothing remains. Returns undefined for "no override". */
export function normalizeOverride(route: RouteOverrideDraft): Record<string, string> | undefined {
  const normalized: Record<string, string> = {}
  if ((route.provider ?? '').trim() !== '') normalized['provider'] = route.provider!.trim()
  if ((route.model ?? '').trim() !== '') normalized['model'] = route.model!.trim()
  if ((route.reasoningEffort ?? '').trim() !== '') normalized['reasoningEffort'] = route.reasoningEffort!.trim()
  return Object.keys(normalized).length > 0 ? normalized : undefined
}
