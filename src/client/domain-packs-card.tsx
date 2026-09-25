/**
 * Read-only Domain Pack preview settings page (`settings.section` entry
 * `expert-library-packs`): lists the builtin + workspace domain packs served
 * by the plugin's `GET /plugins/dsh-expert-library/packs` route and shows one
 * pack's validation detail on selection.
 *
 * The pack list / validation detail stays read-only. The runtime
 * participation block below (enabledPacks / packPriority + content drift via
 * `/health?probe=packs`) moved here from the former 专家库 settings card and
 * is editable through the shared `expert-library` settings scope when one is
 * injected. The wire types are mirrored locally
 * (like ActivityPanel mirrors host snapshots) because the client bundle must
 * not import the host `src/v2` modules.
 *
 * Fetch conventions follow FilesView/ActivityPanel: `cache: 'no-store'`,
 * guard `!response.ok` and array shapes before committing state, and keep the
 * last snapshot across transient host restarts.
 *
 * Styled with `domain-packs-card.module.css`, the DSW-token sibling of the
 * 专家库 settings card.
 * @module dsh-expert-library/client/domain-packs-card
 */

import { useEffect, useState } from 'react'
import css from './domain-packs-card.module.css'
import tableCss from './settings-card.module.css'
import {
  DRIFT_LABEL,
  HEALTH_URL,
  LAYER_LABEL,
  isHealthWire,
  type HealthWire,
  type ExpertLibrarySettingsScope,
} from './settings-shared.ts'

/** One pack row of the host list response (mirrors host PackSummary). */
interface ClientPackSummary {
  readonly id: string
  readonly version: string
  readonly schemaVersion: number
  readonly name: string
  readonly description?: string
  readonly layer: string
  readonly label: string
  readonly root?: string
  readonly snapshot?: string
  readonly ok: boolean
  readonly errorCount: number
  readonly warningCount: number
  readonly counts: Record<string, number>
}

/** One validation finding (mirrors host PackDiagnostic). */
interface ClientPackDiagnostic {
  readonly code: string
  readonly path: string
  readonly message: string
  readonly severity: 'error' | 'warning' | 'info'
}

/** Per-pack preview payload (mirrors host DomainPackPreviewResponse). */
interface ClientDomainPackPreview {
  readonly ok: boolean
  readonly pack?: ClientPackSummary
  readonly diagnostics: readonly ClientPackDiagnostic[]
  readonly evaluatedAt: string
}

export interface DomainPacksCardProps {
  /** Close the settings panel (the shell owns the open state). */
  close: () => void
  /** Shared expert-library settings scope; editing is only offered when
   * injected (absent scope = read-only preview). */
  scope?: ExpertLibrarySettingsScope
}

/** Host route serving pack summaries and per-pack previews. */
const PACKS_URL = '/plugins/dsh-expert-library/packs'

/** Layer badge labels (superset of the shared table labels). */
const LOCAL_LAYER_LABEL: Record<string, string> = {
  'domain-pack': '领域包',
  request: '请求',
  ...LAYER_LABEL,
}

/** Counts grid order: collection key → 中文 label. */
const COUNTS: ReadonlyArray<readonly [string, string]> = [
  ['experts', '专家'],
  ['scenarios', '场景'],
  ['teamTemplates', '团队模板'],
  ['outputTemplates', '输出模板'],
  ['qualityPolicies', '质量策略'],
  ['toolProviders', '工具 Provider'],
  ['knowledgeProviders', '知识 Provider'],
  ['domainKnowledge', '领域知识'],
  ['methodPacks', '方法包'],
  ['skillPackages', '技能包'],
]

function layerLabel(layer: string): string {
  return LOCAL_LAYER_LABEL[layer] ?? layer
}

/** One severity group of diagnostics. */
function DiagnosticGroup({ title, diagnostics }: {
  readonly title: string
  readonly diagnostics: readonly ClientPackDiagnostic[]
}) {
  if (diagnostics.length === 0) return null
  return (
    <div className={css.diagGroup}>
      <h4>{title}（{diagnostics.length}）</h4>
      <ul>
        {diagnostics.map((diagnostic, index) => (
          <li key={`${diagnostic.code}:${diagnostic.path}:${index}`}>
            <code>{diagnostic.code}</code> <code>{diagnostic.path}</code> {diagnostic.message}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Validation result panel of the selected pack. */
function PreviewResult({ preview }: { readonly preview: ClientDomainPackPreview }) {
  const errors = preview.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
  const warnings = preview.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning')
  const infos = preview.diagnostics.filter((diagnostic) => diagnostic.severity === 'info')
  const pack = preview.pack
  return (
    <>
      <p
        role="status"
        data-preview-ok={preview.ok}
        className={preview.ok ? css.statusOk : css.statusFail}
      >
        {preview.ok ? '✓ 校验通过' : `✗ 校验失败（${errors.length} 项错误）`}
      </p>
      {preview.ok && pack !== undefined && (
        <>
          <dl className={css.facts}>
            <dt>版本</dt><dd>{pack.version}</dd>
            <dt>层级</dt><dd>{layerLabel(pack.layer)}</dd>
            <dt>来源</dt><dd>{pack.label}</dd>
            {pack.snapshot !== undefined && <><dt>快照</dt><dd>{pack.snapshot}</dd></>}
            {pack.root !== undefined && <><dt>根目录</dt><dd className={css.mono}>{pack.root}</dd></>}
          </dl>
          <ul className={css.counts}>
            {COUNTS.map(([key, label]) => (
              <li key={key}>{label} {pack.counts[key] ?? 0}</li>
            ))}
          </ul>
        </>
      )}
      <DiagnosticGroup title="错误" diagnostics={errors} />
      <DiagnosticGroup title="警告" diagnostics={warnings} />
      <DiagnosticGroup title="提示" diagnostics={infos} />
    </>
  )
}

/** Read-only Domain Pack preview and validation page. Tenant version management
 * is exposed by the separate settings section labelled 「领域包」. */
/** Slot wrapper: full-page card with header + close. */
export function DomainPacksCard({ close, scope }: DomainPacksCardProps) {
  return <PackValidationPanel scope={scope} onClose={close} />
}

/** Embeddable validation + runtime-participation panel (no outer card shell).
 * Used standalone in the 「领域包校验」 slot and as the 「本地校验」 tab of the
 * 领域包 version-management card. */
export function PackValidationPanel({ scope, onClose }: {
  scope?: ExpertLibrarySettingsScope
  onClose?: () => void
}) {
  const [packs, setPacks] = useState<readonly ClientPackSummary[] | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<ClientDomainPackPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  // Content-drift probe (mirrors host /health?probe=packs payload).
  const [drift, setDrift] = useState<HealthWire | null>(null)
  const [driftError, setDriftError] = useState('')
  const writable = scope?.getSnapshot().writable === true
  const settingsValue = scope?.getSnapshot().value
  // Runtime participation drafts (moved from the former 专家库 card).
  const [enabledPacks, setEnabledPacks] = useState<readonly string[]>(settingsValue?.enabledPacks ?? [])
  const [packPriority, setPackPriority] = useState<readonly string[]>(settingsValue?.packPriority ?? [])
  const [packsMessage, setPacksMessage] = useState('')
  const [packsSaving, setPacksSaving] = useState(false)

  const loadList = async (): Promise<void> => {
    setListLoading(true)
    setListError('')
    try {
      const response = await fetch(PACKS_URL, { cache: 'no-store' })
      if (!response.ok) throw new Error('non-ok response')
      const body = (await response.json()) as { packs?: unknown }
      if (!Array.isArray(body.packs)) throw new Error('malformed body')
      setPacks(body.packs as readonly ClientPackSummary[])
      // Drop a selection whose pack disappeared (deleted/moved on disk).
      if (selectedId !== null && !(body.packs as readonly ClientPackSummary[]).some((pack) => pack.id === selectedId)) {
        setSelectedId(null)
        setPreview(null)
      }
    } catch {
      // Host restarting or webless profile; keep the last list.
      setListError('领域包列表请求失败')
    } finally {
      setListLoading(false)
    }
  }

  const loadPreview = async (id: string): Promise<void> => {
    setPreview(null)
    setPreviewError('')
    setPreviewLoading(true)
    try {
      const response = await fetch(`${PACKS_URL}?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('non-ok response')
      const body = (await response.json()) as ClientDomainPackPreview
      if (typeof body.ok !== 'boolean' || !Array.isArray(body.diagnostics)) throw new Error('malformed body')
      setPreview(body)
    } catch {
      setPreviewError('校验请求失败')
    } finally {
      setPreviewLoading(false)
    }
  }

  useEffect(() => { void loadList() }, [])

  const loadDrift = async (): Promise<void> => {
    setDriftError('')
    try {
      const response = await fetch(`${HEALTH_URL}?probe=packs`, { cache: 'no-store' })
      if (!response.ok) throw new Error('non-ok response')
      const body: unknown = await response.json()
      if (!isHealthWire(body)) throw new Error('malformed body')
      setDrift(body)
    } catch {
      setDriftError('漂移探测请求失败')
    }
  }

  useEffect(() => {
    if (scope === undefined) return
    if (scope.getSnapshot().status !== 'ready') return
    const value = scope.getSnapshot().value
    if (value === undefined) return
    setEnabledPacks(value.enabledPacks ?? [])
    setPackPriority(value.packPriority ?? [])
  }, [scope, scope?.getSnapshot().status, scope?.getSnapshot().value])

  useEffect(() => {
    void loadDrift()
  }, [])

  /** See the former 专家库 card: empty enabledPacks = all valid packs. */
  const togglePack = (id: string, next: boolean): void => {
    const workspaceIds = (packs ?? [])
      .filter(pack => pack.layer !== 'builtin')
      .map(pack => pack.id)
    setEnabledPacks(current => {
      if (next) return [...current, id]
      if (current.length > 0) return current.filter(candidate => candidate !== id)
      return workspaceIds.filter(candidate => candidate !== id)
    })
    setPackPriority(current => next
      ? (current.includes(id) ? current : [...current, id])
      : current.filter(candidate => candidate !== id))
    setPacksMessage('')
  }

  const movePack = (id: string, delta: -1 | 1): void => {
    setPackPriority(current => {
      const index = current.indexOf(id)
      if (index === -1) {
        return delta === -1 ? [id, ...current] : [...current, id]
      }
      const target = index + delta
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      next.splice(index, 1)
      next.splice(target, 0, id)
      return next
    })
    setPacksMessage('')
  }

  const savePacks = async (): Promise<void> => {
    if (scope === undefined || !writable || packsSaving) return
    setPacksSaving(true)
    setPacksMessage('')
    try {
      if (enabledPacks.length > 0) await scope.set('enabledPacks', enabledPacks)
      else await scope.unset('enabledPacks')
      if (packPriority.length > 0) await scope.set('packPriority', packPriority)
      else await scope.unset('packPriority')
      setPacksMessage('已保存')
    } catch (error) {
      setPacksMessage(error instanceof Error ? error.message : '保存失败')
    } finally {
      setPacksSaving(false)
    }
  }

  return (
    <section className={css.card}>
      {onClose !== undefined && (
        <header className={css.head}>
          <h2 className={css.title}>领域包校验</h2>
          <p className={css.subtitle}>Domain Pack 只读预览与校验结果：内置 zhijian-realestate 包与各工作区 <code className={css.mono}>domain-packs/</code> 目录下的包；此处仅读取并重新校验，不修改任何文件。</p>
        </header>
      )}
      <div className={css.body}>
        <div className={css.toolbar}>
          <button className={css.button} type="button" disabled={listLoading} onClick={() => void loadList()}>{listLoading ? '刷新中…' : '刷新'}</button>
          {onClose !== undefined && <button className={css.button} type="button" onClick={onClose}>关闭</button>}
        </div>
        {listLoading && packs === null && <p className={css.hint}>正在读取领域包…</p>}
        {listError !== '' && packs === null && (
          <p className={css.statusError} role="status">{listError} <button className={css.button} type="button" onClick={() => void loadList()}>重试</button></p>
        )}
        {packs !== null && packs.length === 0 && <p className={css.hint}>暂无领域包</p>}
        {packs !== null && packs.length > 0 && (
          <ul className={css.packList}>
            {packs.map((pack) => (
              <li key={pack.id}>
                <button
                  className={css.packRow}
                  type="button"
                  data-active={selectedId === pack.id}
                  onClick={() => {
                    setSelectedId(pack.id)
                    void loadPreview(pack.id)
                  }}
                >
                  <span className={css.packMain}>
                    <span className={css.packName}>{pack.name}</span>
                    <span className={css.packMeta}>{pack.id}@{pack.version}</span>
                    <span className={css.packSummary}>专家 {pack.counts.experts ?? 0} · 场景 {pack.counts.scenarios ?? 0} · 模板 {pack.counts.teamTemplates ?? 0}</span>
                  </span>
                  <span className={css.layer}>{layerLabel(pack.layer)}</span>
                  <span className={css.pill} data-severity={pack.ok ? 'pass' : 'fail'}>
                    {pack.ok ? '通过' : `${pack.errorCount} 错误`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {selectedId !== null && (
          <section className={css.preview} aria-label={`${selectedId} 校验详情`}>
            <h3 className={css.previewTitle}>{selectedId}</h3>
            {previewLoading && <p className={css.hint}>正在校验 {selectedId}…</p>}
            {!previewLoading && previewError !== '' && (
              <p className={css.statusError} role="status">{previewError} <button className={css.button} type="button" onClick={() => void loadPreview(selectedId)}>重试</button></p>
            )}
            {!previewLoading && preview !== null && <PreviewResult preview={preview} />}
          </section>
        )}

        <h3 className={tableCss.sectionTitle}>运行参与与内容漂移</h3>
        <p className={tableCss.sectionHint}>「运行」勾选 = 该工作区包参与团队编译（可覆盖内置专家/场景/模板）；优先级决定多个包并存时的覆盖顺序（↑ 越靠前优先级越高）。未勾选任何包 = 全部有效包参与（默认）。漂移列来自 <code>GET /health?probe=packs</code> 树摘要比对。包的增删改请使用生成器 CLI。</p>
        {scope === undefined && <p className={css.hint}>当前环境未开放设置写入，以下为只读展示。</p>}
        {driftError !== '' && <p className={css.statusError} role="status">{driftError}</p>}
        <div className={tableCss.packToolbar}>
          <button className={tableCss.button} type="button" onClick={() => void loadDrift()}>重新校验漂移</button>
          {writable && (
            <button className={`${tableCss.button} ${tableCss.buttonPrimary}`} type="button" disabled={packsSaving} onClick={() => void savePacks()}>{packsSaving ? '保存中…' : '保存运行配置'}</button>
          )}
          {packsMessage !== '' && <span className={tableCss.message} role="status">{packsMessage}</span>}
        </div>
        {packs !== null && packs.length > 0 && (
          <table className={tableCss.packTable}>
            <thead>
              <tr><th>包</th><th>层级</th><th>漂移</th><th>运行</th><th>优先级</th></tr>
            </thead>
            <tbody>
              {packs.map((pack) => {
                const driftEntry = drift?.packs.find((candidate) => candidate.id === pack.id)
                const enabled = pack.layer === 'builtin' ? true : enabledPacks.length === 0 || enabledPacks.includes(pack.id)
                const rank = packPriority.indexOf(pack.id)
                return (
                  <tr key={`${pack.layer}:${pack.id}`}>
                    <td><span className={tableCss.packName}>{pack.name}</span><code className={tableCss.packId}>{pack.id}@{pack.version}</code></td>
                    <td>{LAYER_LABEL[pack.layer] ?? pack.layer}</td>
                    <td data-drift={driftEntry?.drift ?? 'unknown'}>{driftEntry === undefined ? '—' : DRIFT_LABEL[driftEntry.drift]}</td>
                    <td>
                      {pack.layer === 'builtin' || !writable
                        ? <span className={tableCss.packId}>{pack.layer === 'builtin' ? '始终' : '—'}</span>
                        : (
                          <label className={tableCss.checkRow}>
                            <input className={tableCss.checkbox} type="checkbox" checked={enabled} onChange={event => togglePack(pack.id, event.target.checked)} />
                            {enabled ? '参与' : '停用'}
                          </label>
                        )}
                    </td>
                    <td>
                      {pack.layer === 'builtin' || !enabled || !writable
                        ? <span className={tableCss.packId}>—</span>
                        : (
                          <span className={tableCss.priorityControl}>
                            <button className={tableCss.button} type="button" disabled={rank === 0} onClick={() => movePack(pack.id, -1)}>↑</button>
                            <span className={tableCss.packId}>{rank === -1 ? '默认' : rank + 1}</span>
                            <button className={tableCss.button} type="button" disabled={rank !== -1 && rank >= packPriority.length - 1} onClick={() => movePack(pack.id, 1)}>↓</button>
                          </span>
                        )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}
