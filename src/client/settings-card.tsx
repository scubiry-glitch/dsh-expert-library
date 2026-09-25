/**
 * 智见数据 settings page (`settings.section` entry `expert-library`,
 * formerly labelled 专家库). Purely data-source management:
 *
 * 1. 数据源 — per-provider (wind/zyt/beike) status dots, editable
 *    path/endpoint fields wired to the `providers` settings object (saved
 *    through the same scope.set/unset flow as before), a per-provider
 *    检测 button hitting the host health route. Secrets are never
 *    rendered — the wire carries only keyPresent booleans.
 * 2. 工具执行模式 — per-tool execution-mode editor (`toolExecution`:
 *    api/cli/auto + readOnly).
 *
 * Everything else that used to live here moved to its own settings section:
 * Domain Pack validation + runtime participation → 「领域包校验」
 * (domain-packs-card.tsx); expert model-route overrides → 「专家库管理」
 * (manage-card.tsx); runtime/model/prompt form → 「专家库运行」
 * (runtime-config-card.tsx). Shared wire types and helpers live in
 * settings-shared.ts.
 */

import { useEffect, useState, type ReactNode } from 'react'
import css from './settings-card.module.css'
import {
  HEALTH_URL,
  TOOL_IDS,
  TOOL_LABEL,
  MODE_LABEL,
  isHealthWire,
  probeResultLine,
  providerStatus,
  text,
  type HealthWire,
  type ProviderId,
  type ToolExecutionDraft,
  type ExpertLibrarySettingsScope,
} from './settings-shared.ts'

export interface ExpertLibrarySettingsCardProps {
  close: () => void
  scope: ExpertLibrarySettingsScope
}

/* ------------------------------------------------------------------ *
 *  Component.
 * ------------------------------------------------------------------ */

/** 智见数据设置页：外部数据源的注册/连通/执行模式。秘密不在此显示或写入。 */
export function ExpertLibrarySettingsCard({ close, scope }: ExpertLibrarySettingsCardProps) {
  const snapshot = scope.getSnapshot()
  const value = snapshot.value

  // Draft of every editable settings field (strings/booleans, flattened from
  // nested objects the way the host save reassembles them).
  const [draft, setDraft] = useState({
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

  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  // 数据源 health state (read-only host probes).
  const [health, setHealth] = useState<HealthWire | null>(null)
  const [healthError, setHealthError] = useState('')
  const [checking, setChecking] = useState<ProviderId | null>(null)

  useEffect(() => {
    if (snapshot.status !== 'ready' || value === undefined) return
    setDraft({
      windCliPath: text(value.providers?.wind?.cliPath),
      zytBaseUrl: text(value.providers?.zyt?.baseUrl),
      zytPreferCli: value.providers?.zyt?.preferCli ?? false,
      beikeBaseUrl: text(value.providers?.beike?.baseUrl),
      beikePreferCli: value.providers?.beike?.preferCli ?? false,
    })
    setToolExecution(() => {
      const out: Record<string, ToolExecutionDraft> = {}
      for (const toolId of TOOL_IDS) {
        const policy = value.toolExecution?.[toolId]
        out[toolId] = {
          mode: policy?.mode === 'api' || policy?.mode === 'cli' || policy?.mode === 'auto' ? policy.mode : 'auto',
          readOnly: policy?.readOnly ?? false,
        }
      }
      return out
    })
  }, [snapshot.status, value])

  const fetchHealth = async (probe: ProviderId | 'all'): Promise<void> => {
    setChecking(probe === 'all' ? null : probe)
    setHealthError('')
    try {
      const response = await fetch(`${HEALTH_URL}?probe=${probe}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('non-ok response')
      const body: unknown = await response.json()
      if (!isHealthWire(body)) throw new Error('malformed body')
      // Merge: a single-provider probe only refreshes that provider's row
      // (the rest of its payload is shallow).
      setHealth((current) => {
        if (probe === 'all' || current === null) return body
        return {
          ...body,
          providers: { ...current.providers, [probe]: body.providers[probe] },
          packs: current.packs,
        }
      })
    } catch {
      setHealthError('健康探测请求失败')
    } finally {
      setChecking(null)
    }
  }

  useEffect(() => {
    void fetchHealth('all')
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

      // Tool execution: only tools with a non-default setting are written
      // (auto mode, readOnly false = inherit the composition layer).
      const toolExecutionOut: Record<string, unknown> = {}
      for (const [toolId, entry] of Object.entries(toolExecution)) {
        const normalized: Record<string, unknown> = {}
        if (entry.mode !== 'auto') normalized['mode'] = entry.mode
        if (entry.readOnly) normalized['readOnly'] = true
        if (Object.keys(normalized).length > 0) toolExecutionOut[toolId] = normalized
      }

      if (Object.keys(providers).length > 0) await scope.set('providers', providers)
      else await scope.unset('providers')
      if (Object.keys(toolExecutionOut).length > 0) await scope.set('toolExecution', toolExecutionOut)
      else await scope.unset('toolExecution')
      setMessage('已保存')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (snapshot.status === 'loading') {
    return <section className={css.card}><p className={css.hint}>正在读取智见数据设置…</p></section>
  }
  if (snapshot.status === 'unavailable') {
    return <section className={css.card}><h2 className={css.title}>智见数据</h2><p className={css.hint}>当前 DSH 配置未开放 Expert Library 设置。</p></section>
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
      <h2 className={css.title}>智见数据</h2>
      <span className={css.subtitle}>外部数据源（Wind / 政研通 / 贝壳）的注册与连通状态，以及工具执行模式。留空表示继承默认配置；API Key 等秘密不会显示或写入此处。</span>
    </header>

    <div className={css.body}>
      <h3 className={css.sectionTitle}>数据源</h3>
      <p className={css.sectionHint}>三个外部数据源（Wind / 政研通 / 贝壳）的注册与连通状态。留空表示继承默认配置。</p>
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

      <h3 className={css.sectionTitle}>工具执行模式</h3>
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

      <div className={css.footer}>
        {message !== '' && <span className={css.message} role="status">{message}</span>}
        <button className={`${css.button} ${css.buttonPrimary}`} type="button" disabled={!snapshot.writable || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
        <button className={css.button} type="button" onClick={close}>关闭</button>
      </div>
    </div>
  </section>
}
