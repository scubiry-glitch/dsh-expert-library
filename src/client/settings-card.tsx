/**
 * Settings page for the Expert Library namespace, restructured into four
 * blocks:
 *
 * 1. 数据源 — per-provider (wind/zyt/beike) status dots, editable
 *    path/endpoint fields wired to the `providers` settings object (saved
 *    through the same scope.set/unset flow as the runtime form), a
 *    per-provider 检测 button hitting the host health route, and a per-tool
 *    execution-mode editor (`toolExecution`: api/cli/auto + readOnly).
 *    Secrets are never rendered — the wire carries only keyPresent booleans.
 * 2. Domain Pack — read-only table merging `GET /packs` (validation health,
 *    counts) with `GET /health?probe=packs` (tree sha256 drift), plus the
 *    runtime pack selection: which workspace packs participate in team
 *    compile (`enabledPacks`) and in what precedence order
 *    (`packPriority`). 重新校验 re-calls both. Pack add/remove/change stays
 *    with the generator CLI.
 * 3. 专家路由 — `GET /experts` listing every expert with its preset route,
 *    the settings override (if any) and the effective route + inheritance
 *    source; per-expert override inputs are wired to `expertModelOverrides`.
 * 4. 运行配置 — the original runtime/model/prompt form, now including
 *    memberMaxDepth (delegation depth cap).
 *
 * Wire types are mirrored locally (the client bundle must not import host
 * modules). Fetch conventions follow domain-packs-card: `cache: 'no-store'`,
 * shape guards before committing state, last snapshot kept across errors.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { ExpertLibrarySettings } from '../settings.ts'
import css from './settings-card.module.css'

export interface ExpertLibrarySettingsCardProps {
  close: () => void
  scope: SettingsScope<ExpertLibrarySettings>
}

/* ------------------------------------------------------------------ *
 *  Mirrored host wire types (src/host/health.ts, src/v2/preview.ts).
 * ------------------------------------------------------------------ */

interface WindHealthWire {
  readonly registered: boolean
  readonly cliPath?: string
  readonly cliExists: boolean
  readonly keyPresent: boolean
  readonly detail?: string
}

interface ZytHealthWire {
  readonly registered: boolean
  readonly baseUrl: string
  readonly keyPresent: boolean
  readonly reachable?: boolean
  readonly latencyMs?: number
  readonly identity?: { readonly tenantName?: string; readonly dataView?: string }
  readonly detail?: string
}

interface BeikeHealthWire {
  readonly registered: boolean
  readonly baseUrl: string
  readonly keyPresent: boolean
  readonly reachable?: boolean
  readonly latencyMs?: number
  readonly serverInfo?: string
  readonly detail?: string
}

interface PackHealthWire {
  readonly id: string
  readonly version: string
  readonly experts: number
  readonly scenarios: number
  readonly sha256: string
  readonly drift: 'clean' | 'dirty' | 'unknown'
}

interface HealthWire {
  readonly checkedAt: string
  readonly providers: {
    readonly wind: WindHealthWire
    readonly zyt: ZytHealthWire
    readonly beike: BeikeHealthWire
  }
  readonly packs: readonly PackHealthWire[]
}

interface PackSummaryWire {
  readonly id: string
  readonly version: string
  readonly name: string
  readonly layer: string
  readonly ok: boolean
  readonly errorCount: number
  readonly counts: Record<string, number>
}

/** One expert row of `GET /experts`. */
interface ExpertRouteWire {
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

/** One tool-execution draft row (mirrors ToolExecutionConfig). */
interface ToolExecutionDraft {
  readonly mode: 'api' | 'cli' | 'auto'
  readonly readOnly: boolean
}

/* ------------------------------------------------------------------ *
 *  Helpers.
 * ------------------------------------------------------------------ */

const HEALTH_URL = '/plugins/dsh-expert-library/health'
const PACKS_URL = '/plugins/dsh-expert-library/packs'
const EXPERTS_URL = '/plugins/dsh-expert-library/experts'

type ProviderId = 'wind' | 'zyt' | 'beike'

/** Tool ids whose execution mode is user-configurable (provider id = tool id). */
const TOOL_IDS: readonly ProviderId[] = ['wind', 'zyt', 'beike']

const TOOL_LABEL: Record<ProviderId, string> = {
  wind: 'Wind',
  zyt: '政研通 zyt',
  beike: '贝壳 beike',
}

const MODE_LABEL: Record<string, string> = {
  api: 'API',
  cli: 'CLI',
  auto: '自动',
}

const SOURCE_LABEL: Record<string, string> = {
  override: '设置覆盖',
  expert: '专家预设',
  default: '全局默认',
  none: '未配置',
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): string {
  return typeof value === 'number' ? String(value) : ''
}

function isHealthWire(body: unknown): body is HealthWire {
  if (typeof body !== 'object' || body === null) return false
  const record = body as Record<string, unknown>
  return typeof record['checkedAt'] === 'string'
    && typeof record['providers'] === 'object' && record['providers'] !== null
    && Array.isArray(record['packs'])
}

function isExpertRouteWire(body: unknown): body is { experts?: unknown } {
  return typeof body === 'object' && body !== null && Array.isArray((body as Record<string, unknown>)['experts'])
}

/** Status dot + label + color key for one provider's health row. */
function providerStatus(provider: ProviderId, health: HealthWire | null): {
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
function probeResultLine(provider: ProviderId, health: HealthWire | null): string {
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

const DRIFT_LABEL: Record<PackHealthWire['drift'], string> = {
  clean: '一致',
  dirty: '有漂移',
  unknown: '无基准',
}

const LAYER_LABEL: Record<string, string> = {
  builtin: '内置',
  workspace: '工作区',
}

/** Compact route text: provider/model (effort). */
function routeText(route: { provider?: string; model?: string; reasoningEffort?: string } | undefined): string {
  if (route === undefined) return '—'
  const base = [route.provider, route.model].filter((part) => part !== undefined && part !== '').join('/')
  return route.reasoningEffort === undefined || route.reasoningEffort === ''
    ? (base === '' ? '—' : base)
    : `${base}（${route.reasoningEffort}）`
}

/* ------------------------------------------------------------------ *
 *  Component.
 * ------------------------------------------------------------------ */

/** Settings page for the Expert Library namespace. Secrets are intentionally absent. */
export function ExpertLibrarySettingsCard({ close, scope }: ExpertLibrarySettingsCardProps) {
  const snapshot = scope.getSnapshot()
  const value = snapshot.value

  // Draft of every editable settings field (strings/booleans, flattened from
  // nested objects the way the host save reassembles them).
  const [draft, setDraft] = useState({
    stateDir: text(value?.stateDir),
    knowledgeDir: text(value?.knowledgeDir),
    memberProvider: text(value?.memberProvider),
    maxMembers: number(value?.maxMembers),
    memberMaxDepth: number(value?.memberMaxDepth),
    promptSectionOrder: number(value?.promptSectionOrder),
    modelProvider: text(value?.defaultModel?.provider),
    modelName: text(value?.defaultModel?.model),
    reasoningEffort: text(value?.defaultModel?.reasoningEffort),
    announceToAgent: value?.announceToAgent ?? true,
    packsDir: text(value?.packsDir),
    windCliPath: text(value?.providers?.wind?.cliPath),
    zytBaseUrl: text(value?.providers?.zyt?.baseUrl),
    zytPreferCli: value?.providers?.zyt?.preferCli ?? false,
    beikeBaseUrl: text(value?.providers?.beike?.baseUrl),
    beikePreferCli: value?.providers?.beike?.preferCli ?? false,
  })
  // Per-tool execution drafts (toolExecution), keyed by provider/tool id.
  const [toolExecution, setToolExecution] = useState<Record<string, ToolExecutionDraft>>(() => {
    const out: Record<string, ToolExecutionDraft> = {}
    for (const toolId of TOOL_IDS) {
      const policy = value?.toolExecution?.[toolId]
      out[toolId] = {
        mode: policy?.mode === 'api' || policy?.mode === 'cli' || policy?.mode === 'auto' ? policy.mode : 'auto',
        readOnly: policy?.readOnly ?? false,
      }
    }
    return out
  })
  // Runtime pack selection: enabled workspace pack ids + priority order.
  const [enabledPacks, setEnabledPacks] = useState<readonly string[]>(value?.enabledPacks ?? [])
  const [packPriority, setPackPriority] = useState<readonly string[]>(value?.packPriority ?? [])
  // Expert model overrides (expert id → route), edited in the 专家路由 block.
  const [expertOverrides, setExpertOverrides] = useState<Record<string, { provider?: string; model?: string; reasoningEffort?: string }>>(() => {
    const out: Record<string, { provider?: string; model?: string; reasoningEffort?: string }> = {}
    for (const [id, route] of Object.entries(value?.expertModelOverrides ?? {})) {
      out[id] = { ...route }
    }
    return out
  })

  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  // 数据源 / Domain Pack health state (read-only host probes).
  const [health, setHealth] = useState<HealthWire | null>(null)
  const [healthError, setHealthError] = useState('')
  const [checking, setChecking] = useState<ProviderId | 'packs' | null>(null)
  const [packs, setPacks] = useState<readonly PackSummaryWire[] | null>(null)
  const [packsError, setPacksError] = useState('')

  // 专家路由 listing + filter.
  const [experts, setExperts] = useState<readonly ExpertRouteWire[] | null>(null)
  const [expertsError, setExpertsError] = useState('')
  const [expertFilter, setExpertFilter] = useState('')

  useEffect(() => {
    if (snapshot.status !== 'ready' || value === undefined) return
    setDraft({
      stateDir: text(value.stateDir),
      knowledgeDir: text(value.knowledgeDir),
      memberProvider: text(value.memberProvider),
      maxMembers: number(value.maxMembers),
      memberMaxDepth: number(value.memberMaxDepth),
      promptSectionOrder: number(value.promptSectionOrder),
      modelProvider: text(value.defaultModel?.provider),
      modelName: text(value.defaultModel?.model),
      reasoningEffort: text(value.defaultModel?.reasoningEffort),
      announceToAgent: value.announceToAgent ?? true,
      packsDir: text(value.packsDir),
      windCliPath: text(value.providers?.wind?.cliPath),
      zytBaseUrl: text(value.providers?.zyt?.baseUrl),
      zytPreferCli: value.providers?.zyt?.preferCli ?? false,
      beikeBaseUrl: text(value.providers?.beike?.baseUrl),
      beikePreferCli: value.providers?.beike?.preferCli ?? false,
    })
    setEnabledPacks(value.enabledPacks ?? [])
    setPackPriority(value.packPriority ?? [])
    setExpertOverrides((current) => {
      const merged: Record<string, { provider?: string; model?: string; reasoningEffort?: string }> = { ...current }
      for (const [id, route] of Object.entries(value.expertModelOverrides ?? {})) {
        merged[id] = { ...route }
      }
      return merged
    })
  }, [snapshot.status, value])

  const fetchHealth = async (probe: ProviderId | 'packs' | 'all'): Promise<void> => {
    setChecking(probe === 'all' ? null : probe)
    setHealthError('')
    try {
      const response = await fetch(`${HEALTH_URL}?probe=${probe}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('non-ok response')
      const body: unknown = await response.json()
      if (!isHealthWire(body)) throw new Error('malformed body')
      // Merge: a single-provider probe only refreshes that provider's row
      // (the rest of its payload is shallow); a packs probe refreshes drift.
      setHealth((current) => {
        if (probe === 'all' || current === null) return body
        return {
          ...body,
          providers: probe === 'packs' ? current.providers : { ...current.providers, [probe]: body.providers[probe] },
          packs: probe === 'packs' ? body.packs : current.packs,
        }
      })
    } catch {
      setHealthError('健康探测请求失败')
    } finally {
      setChecking(null)
    }
  }

  const fetchPacks = async (): Promise<void> => {
    setPacksError('')
    try {
      const response = await fetch(PACKS_URL, { cache: 'no-store' })
      if (!response.ok) throw new Error('non-ok response')
      const body = (await response.json()) as { packs?: unknown }
      if (!Array.isArray(body.packs)) throw new Error('malformed body')
      setPacks(body.packs as readonly PackSummaryWire[])
    } catch {
      setPacksError('领域包列表请求失败')
    }
  }

  const fetchExperts = async (): Promise<void> => {
    setExpertsError('')
    try {
      const response = await fetch(EXPERTS_URL, { cache: 'no-store' })
      if (!response.ok) throw new Error('non-ok response')
      const body: unknown = await response.json()
      if (!isExpertRouteWire(body) || !Array.isArray(body.experts)) throw new Error('malformed body')
      setExperts(body.experts as readonly ExpertRouteWire[])
    } catch {
      setExpertsError('专家路由列表请求失败')
    }
  }

  /** 重新校验: reload the pack table plus the drift probe. */
  const recheckPacks = async (): Promise<void> => {
    setChecking('packs')
    await Promise.all([fetchPacks(), fetchHealth('packs')])
    setChecking(null)
  }

  useEffect(() => {
    void fetchHealth('all')
    void fetchPacks()
    void fetchExperts()
  }, [])

  const set = (field: keyof typeof draft, next: string | boolean) => {
    setDraft(current => ({ ...current, [field]: next }))
    setMessage('')
  }

  /** Toggle one workspace pack's runtime participation. Enabling also gives it
   * an explicit priority slot (appended), so the ↑/↓ controls are usable.
   * Empty `enabledPacks` means "all valid packs enabled" (the default), so
   * the first uncheck materializes every workspace pack id into the list
   * first — otherwise unchecking the first pack from the default state would
   * be a no-op. */
  const togglePack = (id: string, next: boolean): void => {
    const workspaceIds = (packs ?? [])
      .filter(pack => pack.layer !== 'builtin')
      .map(pack => pack.id)
    setEnabledPacks(current => {
      if (next) return [...current, id]
      if (current.length > 0) return current.filter(candidate => candidate !== id)
      // Default state (empty = all): materialize all workspace packs minus
      // the one being disabled.
      return workspaceIds.filter(candidate => candidate !== id)
    })
    setPackPriority(current => next
      ? (current.includes(id) ? current : [...current, id])
      : current.filter(candidate => candidate !== id))
    setMessage('')
  }

  /** Move one pack one step up/down in the priority order (first = highest).
   * A pack not yet in the list (default discovery order) is materialized: ↑
   * puts it at the front, ↓ appends it after the listed packs. */
  const movePack = (id: string, delta: -1 | 1): void => {
    setPackPriority(current => {
      const index = current.indexOf(id)
      if (index === -1) {
        // Not yet listed: ↑ = highest precedence, ↓ = lowest among listed.
        return delta === -1 ? [id, ...current] : [...current, id]
      }
      const target = index + delta
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      next.splice(index, 1)
      next.splice(target, 0, id)
      return next
    })
    setMessage('')
  }

  /** Set one expert's route override (empty strings unset that field). */
  const setExpertOverride = (
    id: string,
    field: 'provider' | 'model' | 'reasoningEffort',
    next: string,
  ): void => {
    setExpertOverrides(current => {
      const existing = current[id] ?? {}
      const updated = { ...existing, [field]: next }
      // Drop the entry when every field is empty (no override).
      if (updated.provider?.trim() === '' && updated.model?.trim() === '' && (updated.reasoningEffort?.trim() ?? '') === '') {
        const { [id]: _removed, ...rest } = current
        return rest
      }
      return { ...current, [id]: updated }
    })
    setMessage('')
  }

  const save = async () => {
    if (!snapshot.writable || saving) return
    setSaving(true)
    setMessage('')
    try {
      // Provider endpoints: empty strings are omitted; preferCli is written
      // only when checked (unchecked = inherit the composition layer). When
      // nothing remains the whole `providers` field re-inherits via unset.
      const wind: Record<string, unknown> = {}
      if (draft.windCliPath.trim() !== '') wind['cliPath'] = draft.windCliPath.trim()
      const zyt: Record<string, unknown> = {}
      if (draft.zytBaseUrl.trim() !== '') zyt['baseUrl'] = draft.zytBaseUrl.trim()
      if (draft.zytPreferCli) zyt['preferCli'] = true
      const beike: Record<string, unknown> = {}
      if (draft.beikeBaseUrl.trim() !== '') beike['baseUrl'] = draft.beikeBaseUrl.trim()
      if (draft.beikePreferCli) beike['preferCli'] = true
      const providers: Record<string, unknown> = {}
      if (Object.keys(wind).length > 0) providers['wind'] = wind
      if (Object.keys(zyt).length > 0) providers['zyt'] = zyt
      if (Object.keys(beike).length > 0) providers['beike'] = beike

      // Tool execution: only tools with a non-default setting are written
      // (auto mode, readOnly false = inherit the composition layer).
      const toolExecutionOut: Record<string, unknown> = {}
      for (const [toolId, entry] of Object.entries(toolExecution)) {
        const normalized: Record<string, unknown> = {}
        if (entry.mode !== 'auto') normalized['mode'] = entry.mode
        if (entry.readOnly) normalized['readOnly'] = true
        if (Object.keys(normalized).length > 0) toolExecutionOut[toolId] = normalized
      }

      // Expert overrides: only entries with at least one non-empty field.
      const overridesOut: Record<string, unknown> = {}
      for (const [id, route] of Object.entries(expertOverrides)) {
        const normalized: Record<string, unknown> = {}
        if ((route.provider ?? '').trim() !== '') normalized['provider'] = route.provider!.trim()
        if ((route.model ?? '').trim() !== '') normalized['model'] = route.model!.trim()
        if ((route.reasoningEffort ?? '').trim() !== '') normalized['reasoningEffort'] = route.reasoningEffort!.trim()
        if (Object.keys(normalized).length > 0) overridesOut[id] = normalized
      }

      const writes: Array<[string, unknown]> = [
        ['stateDir', draft.stateDir],
        ['knowledgeDir', draft.knowledgeDir],
        ['memberProvider', draft.memberProvider],
        ['maxMembers', Number(draft.maxMembers)],
        // memberMaxDepth 0 is meaningful ("forbid delegation"), so only unset
        // when the field is truly empty.
        ['memberMaxDepth', draft.memberMaxDepth.trim() === '' ? '' : Number(draft.memberMaxDepth)],
        ['promptSectionOrder', Number(draft.promptSectionOrder)],
        ['defaultModel', { provider: draft.modelProvider, model: draft.modelName, reasoningEffort: draft.reasoningEffort }],
        ['announceToAgent', draft.announceToAgent],
        ['packsDir', draft.packsDir],
        ['enabledPacks', enabledPacks],
        ['packPriority', packPriority],
      ]
      for (const [field, next] of writes) {
        if (typeof next === 'string' && next.trim() === '') await scope.unset(field)
        else if (Array.isArray(next) && next.length === 0 && (field === 'enabledPacks' || field === 'packPriority')) await scope.unset(field)
        else await scope.set(field, next)
      }
      if (Object.keys(providers).length > 0) await scope.set('providers', providers)
      else await scope.unset('providers')
      if (Object.keys(toolExecutionOut).length > 0) await scope.set('toolExecution', toolExecutionOut)
      else await scope.unset('toolExecution')
      if (Object.keys(overridesOut).length > 0) await scope.set('expertModelOverrides', overridesOut)
      else await scope.unset('expertModelOverrides')
      setMessage('已保存')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (snapshot.status === 'loading') {
    return <section className={css.card}><p className={css.hint}>正在读取专家库设置…</p></section>
  }
  if (snapshot.status === 'unavailable') {
    return <section className={css.card}><h2 className={css.title}>专家库</h2><p className={css.hint}>当前 DSH 配置未开放 Expert Library 设置。</p></section>
  }

  const renderProviderRow = (
    provider: ProviderId,
    name: string,
    fields: ReactNode,
  ) => {
    const status = providerStatus(provider, health)
    const result = probeResultLine(provider, health)
    return (
      <div className={css.provider}>
        <div className={css.providerHead}>
          <span className={css.statusDot} data-status={status.key} role="img" aria-label={status.label}>{status.dot}</span>
          <strong className={css.providerName}>{name}</strong>
          <span className={css.statusLabel} data-status={status.key}>{status.label}</span>
          <button
            className={css.button}
            type="button"
            disabled={checking !== null}
            onClick={() => void fetchHealth(provider)}
          >
            {checking === provider ? '检测中…' : '检测'}
          </button>
        </div>
        <div className={css.fields}>{fields}</div>
        {result !== '' && <p className={css.probeResult} role="status">{result}</p>}
      </div>
    )
  }

  const filteredExperts = useMemo(() => {
    if (experts === null) return null
    const query = expertFilter.trim().toLowerCase()
    if (query === '') return experts
    return experts.filter(expert =>
      expert.id.toLowerCase().includes(query)
      || expert.name.toLowerCase().includes(query)
      || (expert.field ?? '').toLowerCase().includes(query)
      || (expert.stance ?? '').toLowerCase().includes(query))
  }, [experts, expertFilter])

  return <section className={css.card}>
    <header className={css.head}>
      <h2 className={css.title}>专家库</h2>
      <span className={css.subtitle}>三个外部数据源（Wind / 政研通 / 贝壳）的注册与连通状态、领域包校验与运行参与、专家模型路由覆盖，以及运行时 / 模型 / 提示词配置。</span>
    </header>

    <div className={css.body}>
      <h3 className={css.sectionTitle}>数据源</h3>
      <p className={css.sectionHint}>三个外部数据源（Wind / 政研通 / 贝壳）的注册与连通状态。留空表示继承默认配置；API Key 等秘密不会显示或写入此处。</p>
      {healthError !== '' && <p className={css.statusError} role="status">{healthError} <button className={css.button} type="button" onClick={() => void fetchHealth('all')}>重试</button></p>}
      {renderProviderRow('wind', 'Wind（行情 CLI）', (
        <label className={css.field}><span className={css.fieldLabel}>CLI 路径</span><input className={css.input} placeholder="~/.agents/skills/wind-mcp-skill/scripts/cli.mjs" value={draft.windCliPath} onChange={event => set('windCliPath', event.target.value)} /></label>
      ))}
      {renderProviderRow('zyt', '政研通 zyt', (
        <>
          <label className={css.field}><span className={css.fieldLabel}>API Base URL</span><input className={css.input} placeholder="https://dss.ke.com" value={draft.zytBaseUrl} onChange={event => set('zytBaseUrl', event.target.value)} /></label>
          <label className={css.checkRow}><input className={css.checkbox} type="checkbox" checked={draft.zytPreferCli} onChange={event => set('zytPreferCli', event.target.checked)} /> 优先使用 CLI</label>
        </>
      ))}
      {renderProviderRow('beike', '贝壳 beike', (
        <>
          <label className={css.field}><span className={css.fieldLabel}>MCP Endpoint</span><input className={css.input} placeholder="https://building.ke.com/mcp" value={draft.beikeBaseUrl} onChange={event => set('beikeBaseUrl', event.target.value)} /></label>
          <label className={css.checkRow}><input className={css.checkbox} type="checkbox" checked={draft.beikePreferCli} onChange={event => set('beikePreferCli', event.target.checked)} /> 优先使用 CLI</label>
        </>
      ))}

      <h4 className={css.sectionTitle}>工具执行模式</h4>
      <p className={css.sectionHint}>外部工具的执行方式：API（结构化 HTTP）、CLI（受控本地命令）或自动（先探测 API 再回退 CLI）。「自动」+ 非只读 = 继承默认策略。</p>
      {TOOL_IDS.map(toolId => (
        <div className={css.provider} key={toolId}>
          <div className={css.providerHead}>
            <strong className={css.providerName}>{TOOL_LABEL[toolId]}</strong>
            <label className={`${css.checkRow} ${css.statusLabel}`}>
              <input className={css.checkbox} type="checkbox" checked={toolExecution[toolId]?.readOnly ?? false} onChange={event => {
                const current = toolExecution[toolId] ?? { mode: 'auto' as const, readOnly: false }
                setToolExecution(prev => ({ ...prev, [toolId]: { ...current, readOnly: event.target.checked } }))
                setMessage('')
              }} /> 只读
            </label>
          </div>
          <div className={css.fields}>
            <label className={css.field}>
              <span className={css.fieldLabel}>执行模式</span>
              <select
                className={css.input}
                value={toolExecution[toolId]?.mode ?? 'auto'}
                onChange={event => {
                  const mode = event.target.value
                  if (mode === 'api' || mode === 'cli' || mode === 'auto') {
                    const current = toolExecution[toolId] ?? { mode: 'auto' as const, readOnly: false }
                    setToolExecution(prev => ({ ...prev, [toolId]: { ...current, mode } }))
                    setMessage('')
                  }
                }}
              >
                {(Object.keys(MODE_LABEL) as Array<'api' | 'cli' | 'auto'>).map(mode => (
                  <option key={mode} value={mode}>{MODE_LABEL[mode]}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      ))}

      <h3 className={css.sectionTitle}>Domain Pack</h3>
      <p className={css.sectionHint}>领域包校验与内容漂移状态，以及哪些工作区包参与团队编译（运行时叠加；包的增删改请使用生成器 CLI）。</p>
      <label className={css.field}><span className={css.fieldLabel}>包目录</span><input className={css.input} placeholder="domain-packs" value={draft.packsDir} onChange={event => set('packsDir', event.target.value)} /></label>
      <div className={css.packToolbar}>
        <button className={css.button} type="button" disabled={checking !== null} onClick={() => void recheckPacks()}>{checking === 'packs' ? '校验中…' : '重新校验'}</button>
      </div>
      {packsError !== '' && <p className={css.statusError} role="status">{packsError}</p>}
      {packs !== null && packs.length === 0 && <p className={css.packsNote}>暂无领域包</p>}
      {packs !== null && packs.length > 0 && (
        <table className={css.packTable}>
          <thead>
            <tr><th>包</th><th>层级</th><th>校验</th><th>专家/场景</th><th>漂移</th><th>运行</th><th>优先级</th></tr>
          </thead>
          <tbody>
            {packs.map((pack) => {
              const drift = health?.packs.find((candidate) => candidate.id === pack.id)
              const enabled = pack.layer === 'builtin' ? true : enabledPacks.length === 0 || enabledPacks.includes(pack.id)
              const rank = packPriority.indexOf(pack.id)
              return (
                <tr key={`${pack.layer}:${pack.id}`}>
                  <td><span className={css.packName}>{pack.name}</span><code className={css.packId}>{pack.id}@{pack.version}</code></td>
                  <td>{LAYER_LABEL[pack.layer] ?? pack.layer}</td>
                  <td data-severity={pack.ok ? 'pass' : 'fail'}>{pack.ok ? '通过' : `${pack.errorCount} 错误`}</td>
                  <td>{pack.counts['experts'] ?? 0} / {pack.counts['scenarios'] ?? 0}</td>
                  <td data-drift={drift?.drift ?? 'unknown'}>{drift === undefined ? '—' : DRIFT_LABEL[drift.drift]}</td>
                  <td>
                    {pack.layer === 'builtin'
                      ? <span className={css.packId}>始终</span>
                      : (
                        <label className={css.checkRow}>
                          <input className={css.checkbox} type="checkbox" checked={enabled} onChange={event => togglePack(pack.id, event.target.checked)} />
                          {enabled ? '参与' : '停用'}
                        </label>
                      )}
                  </td>
                  <td>
                    {pack.layer === 'builtin' || !enabled
                      ? <span className={css.packId}>—</span>
                      : (
                        <span className={css.priorityControl}>
                          <button className={css.button} type="button" disabled={rank === 0} onClick={() => movePack(pack.id, -1)}>↑</button>
                          <span className={css.packId}>{rank === -1 ? '默认' : rank + 1}</span>
                          <button className={css.button} type="button" disabled={rank !== -1 && rank >= packPriority.length - 1} onClick={() => movePack(pack.id, 1)}>↓</button>
                        </span>
                      )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {packs !== null && packs.length > 0 && (
        <p className={css.sectionHint}>「运行」勾选 = 该工作区包参与团队编译（可覆盖内置专家/场景/模板）；优先级决定多个包并存时的覆盖顺序（↑ 越靠前优先级越高）。未勾选任何包 = 全部有效包参与（默认）。</p>
      )}

      <h3 className={css.sectionTitle}>专家路由</h3>
      <p className={css.sectionHint}>每位专家的生效模型路由与继承来源：设置覆盖 &gt; 专家预设 &gt; 全局默认。在此输入 provider/model（可带推理强度）即可为该专家覆盖路由，保存后立即生效。</p>
      <div className={css.packToolbar}>
        <input
          className={css.input}
          placeholder="按 id / 姓名 / 领域 / 立场过滤…"
          value={expertFilter}
          onChange={event => setExpertFilter(event.target.value)}
        />
        <button className={css.button} type="button" onClick={() => void fetchExperts()}>刷新</button>
      </div>
      {expertsError !== '' && <p className={css.statusError} role="status">{expertsError} <button className={css.button} type="button" onClick={() => void fetchExperts()}>重试</button></p>}
      {filteredExperts === null && <p className={css.packsNote}>正在读取专家列表…</p>}
      {filteredExperts !== null && filteredExperts.length === 0 && <p className={css.packsNote}>无匹配专家</p>}
      {filteredExperts !== null && filteredExperts.length > 0 && (
        <div className={css.expertTableWrap}>
          <table className={css.packTable}>
            <thead>
              <tr><th>专家</th><th>领域/立场</th><th>预设路由</th><th>当前生效</th><th>来源</th><th>覆盖路由（provider / model / effort）</th></tr>
            </thead>
            <tbody>
              {filteredExperts.map(expert => {
                const override = expertOverrides[expert.id]
                return (
                  <tr key={expert.id}>
                    <td><span className={css.packName}>{expert.name}</span><code className={css.packId}>{expert.id}{expert.deceased === true ? '（已故）' : ''}</code></td>
                    <td>{[expert.field, expert.stance].filter(part => part !== undefined && part !== '').join(' · ') || (expert.role ?? '—')}</td>
                    <td className={css.mono}>{routeText(expert.preset)}</td>
                    <td className={css.mono} data-severity={expert.source === 'override' ? 'pass' : 'idle'}>{routeText(expert.effective)}</td>
                    <td>{SOURCE_LABEL[expert.source] ?? expert.source}</td>
                    <td>
                      <span className={css.routeEditor}>
                        <input className={css.miniInput} placeholder="provider" value={override?.provider ?? ''} onChange={event => setExpertOverride(expert.id, 'provider', event.target.value)} />
                        <input className={css.miniInput} placeholder="model" value={override?.model ?? ''} onChange={event => setExpertOverride(expert.id, 'model', event.target.value)} />
                        <input className={css.miniInput} placeholder="effort" value={override?.reasoningEffort ?? ''} onChange={event => setExpertOverride(expert.id, 'reasoningEffort', event.target.value)} />
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3 className={css.sectionTitle}>运行配置</h3>
      <p className={css.sectionHint}>配置成员运行时、默认模型和提示词策略。</p>
      <label className={css.field}><span className={css.fieldLabel}>状态目录</span><input className={css.input} value={draft.stateDir} onChange={event => set('stateDir', event.target.value)} /></label>
      <label className={css.field}><span className={css.fieldLabel}>知识目录</span><input className={css.input} value={draft.knowledgeDir} onChange={event => set('knowledgeDir', event.target.value)} /></label>
      <label className={css.field}><span className={css.fieldLabel}>成员 Provider</span><input className={css.input} value={draft.memberProvider} onChange={event => set('memberProvider', event.target.value)} /></label>
      <label className={css.field}><span className={css.fieldLabel}>最大成员数</span><input className={css.input} type="number" min="1" value={draft.maxMembers} onChange={event => set('maxMembers', event.target.value)} /></label>
      <label className={css.field}><span className={css.fieldLabel}>成员委托深度</span><input className={css.input} type="number" min="0" value={draft.memberMaxDepth} onChange={event => set('memberMaxDepth', event.target.value)} /></label>
      <label className={css.field}><span className={css.fieldLabel}>提示词顺序</span><input className={css.input} type="number" min="0" value={draft.promptSectionOrder} onChange={event => set('promptSectionOrder', event.target.value)} /></label>
      <label className={css.field}><span className={css.fieldLabel}>默认模型 Provider</span><input className={css.input} value={draft.modelProvider} onChange={event => set('modelProvider', event.target.value)} /></label>
      <label className={css.field}><span className={css.fieldLabel}>默认模型</span><input className={css.input} value={draft.modelName} onChange={event => set('modelName', event.target.value)} /></label>
      <label className={css.field}><span className={css.fieldLabel}>默认推理强度</span><input className={css.input} value={draft.reasoningEffort} onChange={event => set('reasoningEffort', event.target.value)} /></label>
      <label className={css.checkRow}><input className={css.checkbox} type="checkbox" checked={draft.announceToAgent} onChange={event => set('announceToAgent', event.target.checked)} /> 向 Agent 注入专家库使用协议</label>
      <div className={css.footer}>
        {message !== '' && <span className={css.message} role="status">{message}</span>}
        <button className={`${css.button} ${css.buttonPrimary}`} type="button" disabled={!snapshot.writable || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
        <button className={css.button} type="button" onClick={close}>关闭</button>
      </div>
    </div>
  </section>
}
