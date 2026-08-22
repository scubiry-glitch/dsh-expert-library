/**
 * Conversation 文件 tab: one `conversation.view` entry (beside 对话/轨迹) that
 * lists the documents this conversation consumed and produced.
 *
 * - 输入: files the user uploaded into the conversation (dsh-files stores them
 *   under `<workspace>/.dsh-filess/<sessionId>/`; served by the plugin's
 *   `session-files` route).
 * - 产出: files written by the conversation's tools — read from the live
 *   conversation snapshot's tool-result render intents (diff/edit cards carry
 *   `locations`; univer tool calls carry a `file` argument) — the same
 *   derivation the chat view's deliverables turn-tail uses.
 *
 * Previews: office documents (.univer/.xlsx/.docx/.pptx/.csv/…) embed the
 * dsh-univer-office viewer via `/univer-api/state`; everything else embeds the
 * plugin's raw `workspace-file` route (text/markdown/images/PDF render in the
 * browser, other types offer download).
 * @module dsh-expert-library/client/files
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Module-loading import: the SlotMap augmentation below declares the
// 'conversation.view' contract this component is registered against.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './FilesView.module.css'

/** Poll cadence for the host input-files route. */
const INPUT_POLL_MS = 4000

/** One document row (either direction of the conversation). */
interface FileRow {
  readonly group: 'input' | 'produced'
  readonly name: string
  /** Model/workspace-facing path (relative to the session cwd). */
  readonly path: string
  readonly sizeBytes?: number
  readonly updatedAt?: number
}

/** Structural slice of one conversation chat node (duck-typed on purpose). */
interface NodeSlice {
  readonly kind: string
  readonly seq?: number
  readonly isError?: boolean
  readonly callView?: unknown
  readonly call?: { readonly name: string; readonly argsRaw: string } | null
  readonly subCalls?: readonly unknown[]
}

/** Extract a string field from raw JSON tool arguments. */
function jsonField(raw: string, field: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && field in parsed) {
      const value = (parsed as Record<string, unknown>)[field]
      if (typeof value === 'string' && value !== '') return value
    }
  } catch {
    // non-JSON arguments; nothing to read
  }
  return undefined
}

/** Paths one settled call produced, by render intent (mirrors deliverables). */
function producedPathsOfCall(candidate: NodeSlice): string[] {
  if (candidate.isError === true) return []
  const paths: string[] = []
  const view = candidate.callView as
    | { card?: string; kind?: string; locations?: readonly { path: string }[] }
    | null
    | undefined
  if (view !== null && view !== undefined) {
    if (view.card === 'diff' || (view.card === 'generic' && view.kind === 'edit')) {
      for (const location of view.locations ?? []) paths.push(location.path)
    }
  }
  const call = candidate.call
  if (call !== null && call !== undefined && call.name.startsWith('univer')) {
    const file = jsonField(call.argsRaw, 'file')
    if (file !== undefined) paths.push(file)
  }
  return paths
}

/** Walk one tool-result node and its nested sub-calls for produced paths. */
function producedPathsOfNode(node: NodeSlice): string[] {
  const paths: string[] = []
  const visit = (candidate: NodeSlice): void => {
    paths.push(...producedPathsOfCall(candidate))
    for (const child of candidate.subCalls ?? []) visit(child as NodeSlice)
  }
  visit(node)
  return paths
}

/** View kind for the preview pane. */
function previewKindOf(path: string): 'office' | 'image' | 'pdf' | 'text' | 'other' {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (['univer', 'xlsx', 'xls', 'csv', 'tsv', 'docx', 'doc', 'pptx'].includes(extension)) return 'office'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(extension)) return 'image'
  if (extension === 'pdf') return 'pdf'
  if (['md', 'markdown', 'txt', 'text', 'json', 'yaml', 'yml', 'log', 'js', 'ts', 'py', 'html', 'htm', 'css', 'xml', 'csv', 'tsv'].includes(extension)) return 'text'
  return 'other'
}

/** Short human byte size. */
function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Univer viewer state for one office file (duck-typed). */
interface UniverState {
  readonly viewerUrl?: string
  readonly gatewayRunning?: boolean
}

/** Complete props of the 文件 conversation view entry. */
export type FilesViewProps = PropsRuntime<'conversation.view'>

/**
 * The 文件 view: left column lists 输入/产出 documents of the conversation,
 * right pane previews the selection (univer office viewer or raw embed).
 */
export function FilesView({ useSession, sessionId }: FilesViewProps) {
  const nodes = useSession((snapshot) => snapshot.chat.legacy.nodes)

  // Produced documents: fold tool-result nodes in seq order, first-seen wins.
  const produced = useMemo<readonly FileRow[]>(() => {
    const rows: FileRow[] = []
    const seen = new Set<string>()
    for (const node of nodes) {
      const candidate = node as NodeSlice
      if (candidate.kind !== 'tool-result') continue
      for (const path of producedPathsOfNode(candidate)) {
        if (seen.has(path)) continue
        seen.add(path)
        rows.push({ group: 'produced', name: path.split('/').pop() ?? path, path })
      }
    }
    return rows
  }, [nodes])

  // Input documents: poll the host route for this session's uploads.
  const [inputs, setInputs] = useState<readonly FileRow[]>([])
  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(
          `/plugins/dsh-expert-library/session-files?sessionId=${encodeURIComponent(sessionId)}`,
          { cache: 'no-store' },
        )
        if (!response.ok) return
        const body = (await response.json()) as {
          files?: readonly { name: string; relPath: string; sizeBytes: number; updatedAt: number }[]
        }
        if (!cancelled && Array.isArray(body.files)) {
          setInputs(body.files.map((file) => ({
            group: 'input' as const,
            name: file.name,
            path: file.relPath,
            sizeBytes: file.sizeBytes,
            updatedAt: file.updatedAt,
          })))
        }
      } catch {
        // host restarting; retry on the next poll
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, INPUT_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId])

  const [selected, setSelected] = useState<string | null>(null)
  const rows = useMemo<readonly FileRow[]>(
    () => [...inputs, ...produced],
    [inputs, produced],
  )
  const active = useMemo<FileRow | undefined>(
    () => rows.find((row) => row.path === selected),
    [rows, selected],
  )
  // Drop a selection whose file disappeared (renamed/deleted).
  const lastActive = useRef<FileRow | undefined>(undefined)
  useEffect(() => {
    lastActive.current = active
    if (selected !== null && active === undefined) setSelected(null)
  }, [selected, active])

  const inputCount = inputs.length
  const producedCount = produced.length

  return (
    <div className={css.root} data-expert-files-view>
      <aside className={css.list}>
        <div className={css.groupHead}>
          <span className={css.groupTitle}>输入文档</span>
          <span className={css.groupCount}>{inputCount}</span>
        </div>
        {inputCount === 0 && <div className={css.groupEmpty}>尚无上传文件（经输入框附件上传的文件会列在这里）</div>}
        {inputs.map((row) => (
          <button
            type="button"
            key={`input:${row.path}`}
            className={css.row}
            data-active={selected === row.path}
            onClick={() => { setSelected(row.path) }}
            title={row.path}
          >
            <span className={css.rowName}>{row.name}</span>
            <span className={css.rowMeta}>{formatSize(row.sizeBytes)}</span>
          </button>
        ))}
        <div className={css.groupHead}>
          <span className={css.groupTitle}>产出文档</span>
          <span className={css.groupCount}>{producedCount}</span>
        </div>
        {producedCount === 0 && <div className={css.groupEmpty}>本会话尚未产出文件（工具写入或创建的文件会列在这里）</div>}
        {produced.map((row) => (
          <button
            type="button"
            key={`produced:${row.path}`}
            className={css.row}
            data-active={selected === row.path}
            onClick={() => { setSelected(row.path) }}
            title={row.path}
          >
            <span className={css.rowName}>{row.name}</span>
            <span className={css.rowPath}>{row.path}</span>
          </button>
        ))}
      </aside>
      <section className={css.preview}>
        {active === undefined ? (
          <div className={css.previewEmpty}>选择左侧文件以预览</div>
        ) : (
          <PreviewPane sessionId={sessionId} row={active} />
        )}
      </section>
    </div>
  )
}

/** Right pane: renders the selected document. */
function PreviewPane({ sessionId, row }: {
  readonly sessionId: string
  readonly row: FileRow
}) {
  const kind = previewKindOf(row.path)
  const rawUrl = `/plugins/dsh-expert-library/workspace-file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(row.path)}`
  const [univer, setUniver] = useState<UniverState | undefined>()
  const [univerError, setUniverError] = useState('')

  useEffect(() => {
    if (kind !== 'office') return
    let cancelled = false
    setUniver(undefined)
    setUniverError('')
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(
          `/univer-api/state?file=${encodeURIComponent(row.path)}&sessionId=${encodeURIComponent(sessionId)}`,
          { cache: 'no-store' },
        )
        if (!response.ok) {
          if (!cancelled) setUniverError('无法打开该文档的 Office 预览（插件未安装或格式不支持）')
          return
        }
        const body = (await response.json()) as UniverState
        if (!cancelled) {
          if (body.viewerUrl === undefined) setUniverError('Office 预览暂不可用（Univer Gateway 未运行）')
          else setUniver(body)
        }
      } catch {
        if (!cancelled) setUniverError('Office 预览请求失败')
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [kind, row.path, sessionId])

  return (
    <div className={css.paneBody}>
      <header className={css.paneHead}>
        <span className={css.paneName} title={row.path}>{row.name}</span>
        <span className={css.panePath}>{row.path}</span>
        <a className={css.paneOpen} href={rawUrl} target="_blank" rel="noreferrer">新标签打开</a>
      </header>
      <div className={css.paneContent}>
        {kind === 'office' && (
          univer !== undefined && univer.viewerUrl !== undefined
            ? <iframe className={css.frame} src={univer.viewerUrl} title={row.name} />
            : <div className={css.paneHint}>{univerError === '' ? '正在加载 Office 预览…' : univerError}</div>
        )}
        {kind === 'image' && <img className={css.image} src={rawUrl} alt={row.name} />}
        {(kind === 'pdf' || kind === 'text') && <iframe className={css.frame} src={rawUrl} title={row.name} />}
        {kind === 'other' && (
          <div className={css.paneHint}>
            该文件类型不支持内联预览。
            <a className={css.paneOpen} href={rawUrl} target="_blank" rel="noreferrer">下载 / 打开</a>
          </div>
        )}
      </div>
    </div>
  )
}
