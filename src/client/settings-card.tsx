/**
 * Settings page for the Expert Library namespace, restructured into three
 * blocks:
 *
 * 1. 数据源 — per-provider (wind/zyt/beike) status dots, editable
 *    path/endpoint fields wired to the `providers` settings object (saved
 *    through the same scope.set/unset flow as the runtime form), and a
 *    per-provider 检测 button hitting the host health route. Secrets are
 *    never rendered — the wire carries only keyPresent booleans.
 * 2. Domain Pack — read-only table merging `GET /packs` (validation health,
 *    counts) with `GET /health?probe=packs` (tree sha256 drift); 重新校验
 *    re-calls both. Pack add/remove/change stays with the generator CLI.
 * 3. 运行配置 — the original runtime/model/prompt form, unchanged.
 *
 * Wire types are mirrored locally (the client bundle must not import host
 * modules). Fetch conventions follow domain-packs-card: `cache: 'no-store'`,
 * shape guards before committing state, last snapshot kept across errors.
 */

import { useEffect, useState, type ReactNode } from 'react'
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

/* ------------------------------------------------------------------ *
 *  Helpers.
 * ------------------------------------------------------------------ */

const HEALTH_URL = '/plugins/dsh-expert-library/health'
const PACKS_URL = '/plugins/dsh-expert-library/packs'

type ProviderId = 'wind' | 'zyt' | 'beike'

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

/* ------------------------------------------------------------------ *
 *  Component.
 * ------------------------------------------------------------------ */

/** Settings page for the Expert Library namespace. Secrets are intentionally absent. */
export function ExpertLibrarySettingsCard({ close, scope }: ExpertLibrarySettingsCardProps) {
  const snapshot = scope.getSnapshot()
  const value = snapshot.value
  const [draft, setDraft] = useState({
    stateDir: text(value?.stateDir),
    knowledgeDir: text(value?.knowledgeDir),
    memberProvider: text(value?.memberProvider),
    maxMembers: number(value?.maxMembers),
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
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  // 数据源 / Domain Pack health state (read-only host probes).
  const [health, setHealth] = useState<HealthWire | null>(null)
  const [healthError, setHealthError] = useState('')
  const [checking, setChecking] = useState<ProviderId | 'packs' | null>(null)
  const [packs, setPacks] = useState<readonly PackSummaryWire[] | null>(null)
  const [packsError, setPacksError] = useState('')

  useEffect(() => {
    if (snapshot.status !== 'ready' || value === undefined) return
    setDraft({
      stateDir: text(value.stateDir),
      knowledgeDir: text(value.knowledgeDir),
      memberProvider: text(value.memberProvider),
      maxMembers: number(value.maxMembers),
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

  /** 重新校验: reload the pack table plus the drift probe. */
  const recheckPacks = async (): Promise<void> => {
    setChecking('packs')
    await Promise.all([fetchPacks(), fetchHealth('packs')])
    setChecking(null)
  }

  useEffect(() => {
    void fetchHealth('all')
    void fetchPacks()
  }, [])

  const set = (field: keyof typeof draft, next: string | boolean) => {
    setDraft(current => ({ ...current, [field]: next }))
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

      const writes: Array<[string, unknown]> = [
        ['stateDir', draft.stateDir],
        ['knowledgeDir', draft.knowledgeDir],
        ['memberProvider', draft.memberProvider],
        ['maxMembers', Number(draft.maxMembers)],
        ['promptSectionOrder', Number(draft.promptSectionOrder)],
        ['defaultModel', { provider: draft.modelProvider, model: draft.modelName, reasoningEffort: draft.reasoningEffort }],
        ['announceToAgent', draft.announceToAgent],
        ['packsDir', draft.packsDir],
      ]
      for (const [field, next] of writes) {
        if (typeof next === 'string' && next.trim() === '') await scope.unset(field)
        else await scope.set(field, next)
      }
      if (Object.keys(providers).length > 0) await scope.set('providers', providers)
      else await scope.unset('providers')
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

  return <section className={css.card}>
    <header className={css.head}>
      <h2 className={css.title}>专家库</h2>
      <span className={css.subtitle}>三个外部数据源（Wind / 政研通 / 贝壳）的注册与连通状态、领域包校验，以及运行时 / 模型 / 提示词配置。</span>
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

      <h3 className={css.sectionTitle}>Domain Pack</h3>
      <p className={css.sectionHint}>领域包校验与内容漂移状态（只读；包的增删改请使用生成器 CLI）。</p>
      <label className={css.field}><span className={css.fieldLabel}>包目录</span><input className={css.input} placeholder="domain-packs" value={draft.packsDir} onChange={event => set('packsDir', event.target.value)} /></label>
      <div className={css.packToolbar}>
        <button className={css.button} type="button" disabled={checking !== null} onClick={() => void recheckPacks()}>{checking === 'packs' ? '校验中…' : '重新校验'}</button>
      </div>
      {packsError !== '' && <p className={css.statusError} role="status">{packsError}</p>}
      {packs !== null && packs.length === 0 && <p className={css.packsNote}>暂无领域包</p>}
      {packs !== null && packs.length > 0 && (
        <table className={css.packTable}>
          <thead>
            <tr><th>包</th><th>层级</th><th>校验</th><th>专家/场景</th><th>漂移</th><th>sha256</th></tr>
          </thead>
          <tbody>
            {packs.map((pack) => {
              const drift = health?.packs.find((candidate) => candidate.id === pack.id)
              return (
                <tr key={`${pack.layer}:${pack.id}`}>
                  <td><span className={css.packName}>{pack.name}</span><code className={css.packId}>{pack.id}@{pack.version}</code></td>
                  <td>{LAYER_LABEL[pack.layer] ?? pack.layer}</td>
                  <td data-severity={pack.ok ? 'pass' : 'fail'}>{pack.ok ? '通过' : `${pack.errorCount} 错误`}</td>
                  <td>{pack.counts['experts'] ?? 0} / {pack.counts['scenarios'] ?? 0}</td>
                  <td data-drift={drift?.drift ?? 'unknown'}>{drift === undefined ? '—' : DRIFT_LABEL[drift.drift]}</td>
                  <td>{drift === undefined ? '—' : <code className={css.mono}>{drift.sha256.slice(0, 12)}</code>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <h3 className={css.sectionTitle}>运行配置</h3>
      <p className={css.sectionHint}>配置成员运行时、默认模型和提示词策略。</p>
      <label className={css.field}><span className={css.fieldLabel}>状态目录</span><input className={css.input} value={draft.stateDir} onChange={event => set('stateDir', event.target.value)} /></label>
      <label className={css.field}><span className={css.fieldLabel}>知识目录</span><input className={css.input} value={draft.knowledgeDir} onChange={event => set('knowledgeDir', event.target.value)} /></label>
      <label className={css.field}><span className={css.fieldLabel}>成员 Provider</span><input className={css.input} value={draft.memberProvider} onChange={event => set('memberProvider', event.target.value)} /></label>
      <label className={css.field}><span className={css.fieldLabel}>最大成员数</span><input className={css.input} type="number" min="1" value={draft.maxMembers} onChange={event => set('maxMembers', event.target.value)} /></label>
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
