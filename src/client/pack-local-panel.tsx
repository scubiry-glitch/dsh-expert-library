/**
 * 「领域包 · 本地来源」panel: local pack-source management moved out of the
 * former 专家库管理 card so that all pack concerns live on the 领域包 page.
 * Blocks:
 * 1. 领域包列表 + 重建 — GET /packs table; rebuild via the host allowlisted
 *    `build-packs.mjs <id>` (POST /manage/packs/rebuild).
 * 2. 外部来源包（vendored）— onboard (pull → validate → vendor), rollback,
 *    uninstall (GET/POST/DELETE /manage/packs/*).
 * 3. 包目录 — `packsDir` runtime setting through the shared expert-library
 *    scope (editing only when the scope is injected and writable).
 * Non-loopback access needs the manage token (权限 input here); secrets never
 * render. Wire types mirrored via manage-client.ts.
 * @module dsh-expert-library/client/pack-local-panel
 */

import { useEffect, useState } from 'react'
import css from './settings-card.module.css'
import {
  MANAGE_BASE,
  REBUILD_ALLOWLIST,
  describeAuthFailure,
  getManageToken,
  isRecord,
  jsonFetch,
  listFetch,
  manageHeaders,
  setManageToken,
  type ManageResponse,
  type VendoredPackWire,
} from './manage-client.ts'
import {
  PACKS_URL,
  text,
  type ExpertLibrarySettingsScope,
} from './settings-shared.ts'

/** 领域包摘要（GET /packs）。 */
interface PanelPackWire {
  readonly id: string
  readonly version?: string
  readonly name?: string
  readonly counts?: Record<string, number>
}

/** 领域包本地来源与重建面板。 */
export function PackLocalPanel({ scope }: { scope?: ExpertLibrarySettingsScope }) {
  const [packs, setPacks] = useState<readonly PanelPackWire[]>([])
  const [sources, setSources] = useState<readonly VendoredPackWire[]>([])
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [locator, setLocator] = useState('')
  const [sourceRef, setSourceRef] = useState('')
  const [tokenDraft, setTokenDraft] = useState(getManageToken())
  const [tokenSavedAt, setTokenSavedAt] = useState(0)

  const writable = scope?.getSnapshot().writable === true
  const [packsDir, setPacksDir] = useState(text(scope?.getSnapshot().value?.packsDir))

  const refreshPacks = async (): Promise<void> => {
    setPacks(await listFetch<PanelPackWire>(PACKS_URL, 'packs'))
  }

  const refreshSources = async (): Promise<void> => {
    setSources(await listFetch<VendoredPackWire>(`${MANAGE_BASE}/packs/registry`, 'packs'))
  }

  useEffect(() => {
    void refreshPacks()
    void refreshSources()
  }, [tokenSavedAt])

  useEffect(() => {
    const value = scope?.getSnapshot().value
    if (value !== undefined) setPacksDir(text(value.packsDir))
  }, [scope, scope?.getSnapshot().value])

  /** 领域包重建（host 白名单脚本 build-packs.mjs）。 */
  const rebuild = async (packId: string): Promise<void> => {
    setBusy(`rebuild-${packId}`)
    setError('')
    const result = await jsonFetch(`${MANAGE_BASE}/packs/rebuild`, 'POST', { id: packId })
    setBusy('')
    if (result.ok) {
      const tail = (result.stdout ?? '').split('\n').filter((line) => line.trim() !== '').slice(-4).join('\n')
      setMessage(`领域包「${packId}」重建完成：\n${tail}`)
      await Promise.all([refreshPacks(), refreshSources()])
    } else {
      setError(result.error ?? `重建失败：${(result.stderr ?? '').slice(-300)}`)
    }
  }

  /** 外部来源：拉取 → 校验 → 入库。未列入白名单的 host 会先回报告等确认。 */
  const onboard = async (approve: boolean): Promise<void> => {
    const target = locator.trim()
    if (target === '') return
    setBusy('onboard')
    setError('')
    setMessage('')
    const payload: Record<string, unknown> = { locator: target, approve }
    if (sourceRef.trim() !== '') payload.ref = sourceRef.trim()
    try {
      const res = await fetch(`${MANAGE_BASE}/packs/onboard`, {
        method: 'POST',
        cache: 'no-store' as RequestCache,
        headers: manageHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(payload),
      })
      const value: unknown = await res.json()
      const body = isRecord(value) ? value : {}
      if (body['ok'] === true) {
        setMessage(`已入库 ${String(body['packId'])} @ ${String(body['revision']).slice(0, 12)}（${String(body['trust'])}，drift=${String(body['drift'])}）。`)
        await refreshSources()
      } else if (body['needsReview'] === true) {
        const invalid = body['valid'] === false
        setError(
          `该 host 不在白名单，未入库。已拉到 ${String(body['revision']).slice(0, 12)}，`
          + `包 id ${String(body['packId'] ?? '（未解析）')}，校验${invalid ? '未通过' : '通过'}。`
          + `${invalid ? '先修掉诊断再提交。' : '确认无误后点「确认入库」。'}`,
        )
      } else {
        setError(describeAuthFailure(res.status, typeof body['error'] === 'string' ? body['error'] : undefined))
      }
    } catch (cause) {
      setError(`入库失败：${String(cause)}`)
    } finally {
      setBusy('')
    }
  }

  /** 回退到入库时记录的上一版。 */
  const rollbackSource = async (id: string): Promise<void> => {
    setBusy(`rollback-${id}`)
    setError('')
    const result = await jsonFetch(`${MANAGE_BASE}/packs/rollback`, 'POST', { id })
    setBusy('')
    if (result.ok) {
      setMessage(`已回退 ${id}。`)
      await refreshSources()
    } else {
      setError(result.error ?? '回退失败')
    }
  }

  /** 卸载一个外部来源包（仅从 vendor 目录移除，不影响平台自带包）。 */
  const removeSource = async (id: string): Promise<void> => {
    setBusy(`remove-${id}`)
    setError('')
    try {
      const res = await fetch(`${MANAGE_BASE}/packs/vendored?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        cache: 'no-store' as RequestCache,
        headers: manageHeaders(),
      })
      const value: unknown = await res.json()
      const body = isRecord(value) ? (value as unknown as ManageResponse) : { ok: false, error: `HTTP ${res.status}` }
      if (body.ok) {
        setMessage(`已卸载 ${id}。`)
        await refreshSources()
      } else {
        setError(body.error ?? '卸载失败')
      }
    } catch (cause) {
      setError(`卸载失败：${String(cause)}`)
    } finally {
      setBusy('')
    }
  }

  const savePacksDir = async (): Promise<void> => {
    if (scope === undefined || !writable) return
    setBusy('packsDir')
    setError('')
    try {
      if (packsDir.trim() === '') await scope.unset('packsDir')
      else await scope.set('packsDir', packsDir.trim())
      setMessage('已保存')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setBusy('')
    }
  }

  const packCount = (pack: PanelPackWire, key: string): number => pack.counts?.[key] ?? 0

  return (
    <div>
      {(message !== '' || error !== '') && (
        <p className={error !== '' ? css.statusError : css.probeResult} role="status">
          {error !== '' ? error : message}
          {error !== '' && <button className={css.button} type="button" onClick={() => setError('')}>关闭</button>}
        </p>
      )}

      {/* ── 授权（非本机访问） ──────────────────────────────────────────── */}
      <h3 className={css.sectionTitle}>授权（非本机访问）</h3>
      <p className={css.sectionHint}>
        以本机地址打开无需令牌；经公网域名访问时 <code>/manage/*</code> 需要令牌放行
        （取自 host 配置 <code>manageToken</code> 或 <code>DSH_EXPERT_LIBRARY_MANAGE_TOKEN</code>）。
        与「专家库 · 权限」共用同一令牌，仅保存在本浏览器。
      </p>
      <div className={css.fields}>
        <label className={css.field}>
          <span className={css.fieldLabel}>授权令牌</span>
          <input
            className={css.input}
            type="password"
            value={tokenDraft}
            autoComplete="off"
            placeholder={getManageToken() === '' ? '未设置——仅本机可用' : '已设置（清空并保存可移除）'}
            onChange={(event) => setTokenDraft(event.target.value)}
          />
        </label>
        <button
          className={css.button}
          type="button"
          onClick={() => {
            setManageToken(tokenDraft)
            setTokenDraft(getManageToken())
            setError('')
            setMessage(getManageToken() === '' ? '已清除令牌：/manage/* 现在仅本机可用。' : '令牌已保存到本浏览器。')
            setTokenSavedAt((value) => value + 1)
          }}
        >
          保存令牌
        </button>
      </div>

      {/* ── 领域包列表 + 重建 ──────────────────────────────────────────── */}
      <h3 className={css.sectionTitle}>领域包重建</h3>
      <p className={css.sectionHint}>领域包是构建产物（<code>domain-packs/</code>），由 <code>build-packs.mjs</code> 确定性生成并带 <code>--check</code> 漂移校验。改源后在此一键重建；重建后请到「本地校验」Tab 跑「重新校验漂移」确认零漂移。</p>
      {packs.length > 0 && (
        <table className={css.packTable}>
          <thead>
            <tr><th>包</th><th>版本</th><th>专家</th><th>场景</th><th>操作</th></tr>
          </thead>
          <tbody>
            {packs.map((pack) => (
              <tr key={pack.id}>
                <td><span className={css.packName}>{pack.name ?? pack.id}</span><code className={css.packId}>{pack.id}</code></td>
                <td>{pack.version ?? '—'}</td>
                <td>{packCount(pack, 'experts')}</td>
                <td>{packCount(pack, 'scenarios')}</td>
                <td>
                  {REBUILD_ALLOWLIST.includes(pack.id) ? (
                    <button className={css.button} type="button" disabled={busy !== ''} onClick={() => void rebuild(pack.id)}>{busy === `rebuild-${pack.id}` ? '重建中…' : '重建'}</button>
                  ) : (
                    <span className={css.statusLabel}>只读</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {packs.length === 0 && <p className={css.packsNote}>暂无领域包。</p>}

      {/* ── 外部来源包（vendored） ──────────────────────────────────────── */}
      <h3 className={css.sectionTitle}>外部来源包（vendored）</h3>
      <p className={css.sectionHint}>
        从外部地址引入领域包：平台拉取 → 用与构建同一套校验器校验 → 冻结成本地包入库。
        <strong>运行时不联网</strong>——地址只是一次性的引进通道，拉下来的内容永远是本地包。
        白名单外的 host 会先返回校验报告，确认后再入库。未配置 <code>vendorPacksDir</code> 时此区不可用。
      </p>
      <div className={css.fields}>
        <label className={css.field}>
          <span className={css.fieldLabel}>来源地址</span>
          <input
            className={css.input}
            value={locator}
            autoComplete="off"
            placeholder="如 https://git.example.com/acme/domain-pack.git"
            onChange={(event) => setLocator(event.target.value)}
          />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>版本（tag / 分支 / commit，留空取默认分支）</span>
          <input
            className={css.input}
            value={sourceRef}
            autoComplete="off"
            placeholder="如 v1.0.0"
            onChange={(event) => setSourceRef(event.target.value)}
          />
        </label>
        <button className={css.button} type="button" disabled={busy !== '' || locator.trim() === ''} onClick={() => void onboard(false)}>
          {busy === 'onboard' ? '处理中…' : '拉取并校验'}
        </button>
        <button className={css.button} type="button" disabled={busy !== '' || locator.trim() === ''} onClick={() => void onboard(true)}>
          确认入库
        </button>
      </div>

      {sources.length > 0 && (
        <table className={css.packTable}>
          <thead>
            <tr>
              <th>包 id</th><th>来源</th><th>版本</th><th>信任级</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.id}>
                <td>{source.id}</td>
                <td>{source.locator}</td>
                <td>{source.revision.slice(0, 12)}</td>
                <td>{source.trust}</td>
                <td>
                  <span className={css.statusLabel}>
                    {source.state === 'clean' ? '一致' : source.state === 'modified' ? '本地已改' : '缺失'}
                  </span>
                </td>
                <td>
                  <button className={css.button} type="button" disabled={busy !== '' || !source.rollbackAvailable} onClick={() => void rollbackSource(source.id)}>
                    {busy === `rollback-${source.id}` ? '回退中…' : '回退'}
                  </button>{' '}
                  <button className={css.button} type="button" disabled={busy !== ''} onClick={() => void removeSource(source.id)}>
                    {busy === `remove-${source.id}` ? '卸载中…' : '卸载'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sources.length === 0 && <p className={css.packsNote}>暂无外部来源包。</p>}

      {/* ── 包目录 ─────────────────────────────────────────────────────── */}
      <h3 className={css.sectionTitle}>包目录</h3>
      <p className={css.sectionHint}>工作区领域包的扫描目录。</p>
      <label className={css.field}><span className={css.fieldLabel}>包目录</span><input className={css.input} placeholder="domain-packs" value={packsDir} onChange={event => setPacksDir(event.target.value)} /></label>
      {scope !== undefined && writable && (
        <div className={css.packToolbar}>
          <button className={`${css.button} ${css.buttonPrimary}`} type="button" disabled={busy !== ''} onClick={() => void savePacksDir()}>{busy === 'packsDir' ? '保存中…' : '保存包目录'}</button>
        </div>
      )}
    </div>
  )
}
