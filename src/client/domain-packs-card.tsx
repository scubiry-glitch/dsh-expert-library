/**
 * Read-only Domain Pack preview settings page (`settings.section` entry
 * `expert-library-packs`): lists the builtin + workspace domain packs served
 * by the plugin's `GET /plugins/dsh-expert-library/packs` route and shows one
 * pack's validation detail on selection.
 *
 * Read-only by design (Phase 1 「设置页只读预览校验」): no settings scope, no
 * `scope.set`/`unset`, no write controls. The wire types are mirrored locally
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
}

/** Host route serving pack summaries and per-pack previews. */
const PACKS_URL = '/plugins/dsh-expert-library/packs'

/** Layer badge labels. */
const LAYER_LABEL: Record<string, string> = {
  builtin: '内置',
  'domain-pack': '领域包',
  workspace: '工作区',
  request: '请求',
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
  return LAYER_LABEL[layer] ?? layer
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

/** Read-only Domain Pack preview and validation page. */
export function DomainPacksCard({ close }: DomainPacksCardProps) {
  const [packs, setPacks] = useState<readonly ClientPackSummary[] | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<ClientDomainPackPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')

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

  return (
    <section className={css.card}>
      <header className={css.head}>
        <h2 className={css.title}>领域包</h2>
        <p className={css.subtitle}>Domain Pack 只读预览与校验结果：内置 zhijian-realestate 包与各工作区 <code className={css.mono}>domain-packs/</code> 目录下的包；此处仅读取并重新校验，不修改任何文件。</p>
      </header>
      <div className={css.body}>
        <div className={css.toolbar}>
          <button className={css.button} type="button" disabled={listLoading} onClick={() => void loadList()}>{listLoading ? '刷新中…' : '刷新'}</button>
          <button className={css.button} type="button" onClick={close}>关闭</button>
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
      </div>
    </section>
  )
}
