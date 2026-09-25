/** Four-tab, local management surface. Machine credentials never enter this bundle. */
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type {
  CenterBindInput, CenterCatalogView, CenterConnectionView, CenterInstalledRelease, CenterInstallationsView,
  CenterOperationInput, CenterOperationView, CenterReleaseDetail, CenterReleaseSummary, CenterUpdatesView,
} from '../pack-center-wire.ts'
import { centerUiErrorCode, createPackCenterApi, isOlderCenterVersion, type PackCenterApi } from './pack-center-api.ts'
import css from './pack-center-card.module.css'
import { PackValidationPanel } from './domain-packs-card.tsx'
import { PackLocalPanel } from './pack-local-panel.tsx'
import type { ExpertLibrarySettingsScope } from './settings-shared.ts'

const TABS = ['领域包目录', '本地校验', '本地来源', '已安装', '更新', '来源设置'] as const
type Tab = typeof TABS[number]
type ReadKey = 'connection' | 'catalog' | 'installed' | 'updates' | 'operations' | 'detail'
type PendingAction = { input: CenterOperationInput; title: string; description: string; uncertain?: boolean }
const PHASES: Record<string, string> = {
  queued: '排队等待', preparing: '准备目标', authorizing: '申请下载授权', downloading: '下载归档', verifying: '校验签名与内容',
  installing: '写入本地缓存', activating: '启用前校验', committing: '提交本地状态', recovering: '恢复检查',
  completed: '已完成', failed: '失败', interrupted: '已中断',
}
const KINDS: Record<CenterOperationInput['kind'], string> = {
  install: '安装到缓存', update_enable: '更新并启用', enable: '启用', disable: '停用', rollback: '回滚', uninstall: '卸载',
}
const STATUS: Record<CenterOperationView['status'], string> = {
  queued: '排队中', running: '执行中', succeeded: '成功', failed: '失败', interrupted: '已中断',
}
const ERROR_HELP: Record<string, string> = {
  MANAGE_UNAUTHORIZED: '需要本地管理权限。请在上方填写管理员提供的管理令牌。',
  UNAUTHORIZED: '管理权限无效，请重新确认本地管理令牌。',
  FORBIDDEN: '管理权限不足，或请求来源未通过保护检查。',
  NOT_BOUND: '尚未绑定中心；已有本地包不受影响。',
  CENTER_NOT_BOUND: '尚未绑定中心；已有本地包不受影响。',
  CENTER_NOT_CONFIGURED: '请由管理员在插件配置中设置中心地址和本地私密目录。',
  CENTER_RESTART_REQUIRED: '中心配置已变化，需要重启插件后才能写入。现有本地状态仍可只读查看。',
  CONNECTION_REVISION_CONFLICT: '绑定已经变化，请刷新并重新核对目标。',
  GENERATION_CONFLICT: '本地包状态已变化。请刷新已安装列表后重新选择操作。',
  REQUEST_TIMEOUT: '请求超时，结果尚未确认。写操作不会自动重试。',
  REQUEST_FAILED: '请求未完成；请检查本地服务与管理权限。',
  INVALID_RESPONSE: '本地服务返回了无法识别的响应；未采用该响应。',
}
const date = (value: string | null | undefined): string => {
  if (!value) return '尚未检查'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '时间不可用' : parsed.toLocaleString()
}
const digest = (release: CenterReleaseSummary) => ({
  manifestSha256: release.manifestSha256, artifactSha256: release.artifactSha256, contentTreeSha256: release.contentTreeSha256,
})
const busyOperation = (operation: CenterOperationView) => operation.status === 'queued' || operation.status === 'running'

function ErrorNotice({ code, label }: { code?: string; label?: string }) {
  if (!code) return null
  return <p className={css.error} role="alert">{label ? `${label}：` : ''}{ERROR_HELP[code] ?? '操作未完成，请根据错误码核查后手动重试。'} <code>{code}</code></p>
}
function SnapshotNotice({ snapshot, label }: { snapshot: { checkedAt: string | null; hasSnapshot: boolean; stale: boolean; errorCode?: string } | null; label: string }) {
  if (!snapshot) return <p className={css.hint}>{label}尚无可用快照。</p>
  return <div className={css.snapshot} role="status" data-stale={snapshot.stale}>
    <span>{snapshot.stale ? snapshot.hasSnapshot ? '检查未成功，显示过期快照' : '检查未成功，尚无可用快照' : snapshot.hasSnapshot ? '检查成功' : '尚无成功检查快照'} · {date(snapshot.checkedAt)}</span>
    {!snapshot.hasSnapshot && <span>尚不能判断目录是否为空或是否已是最新版本。</span>}
    <ErrorNotice code={snapshot.errorCode} />
  </div>
}

function ReleaseDetail({ value, close }: { value: CenterReleaseDetail; close: () => void }) {
  return <section className={css.detail} aria-label="发布详情">
    <div className={css.row}><h3>{value.name} · {value.version}</h3><button className={css.button} type="button" onClick={close}>收起详情</button></div>
    <dl className={css.facts}>
      <dt>领域包</dt><dd>{value.packId}</dd><dt>发布 ID</dt><dd><code>{value.releaseId}</code></dd>
      <dt>发布组织</dt><dd>{value.ownerOrgId}</dd><dt>源提交</dt><dd><code>{value.sourceCommit}</code></dd>
      <dt>许可</dt><dd>{value.license || '未提供'}</dd><dt>清单摘要</dt><dd><code>{value.manifestSha256}</code></dd>
      <dt>归档摘要</dt><dd><code>{value.artifactSha256}</code></dd><dt>内容摘要</dt><dd><code>{value.contentTreeSha256}</code></dd>
    </dl>
    <h4>发布说明</h4><pre className={css.plainText}>{value.notes || '未提供发布说明。'}</pre>
    <h4>校验报告</h4><p>{value.validation.valid ? '中心校验通过' : '中心校验未通过'}</p>
    <ul className={css.diagnostics}>{value.validation.diagnostics.map((item, index) => <li key={index}><code>{item.severity} · {item.code}</code> {item.message}</li>)}</ul>
    <h4>差异</h4>{value.diff.available ? <pre className={css.plainText}>{value.diff.text || '已提供差异，内容为空。'}</pre> : <p className={css.hint}>差异不可用；不能据此判断没有变化。{value.diff.code && <code> {value.diff.code}</code>}</p>}
    {value.dependencies.length > 0 && <><h4>锁定依赖</h4><ul>{value.dependencies.map(item => <li key={item.packId}>{item.packId}@{item.version} · <code>{item.releaseId}</code></li>)}</ul></>}
  </section>
}

function SourceSettings({ view, busy, onBind, onUnbind, onTest }: {
  view: CenterConnectionView | null; busy: boolean
  onBind: (input: CenterBindInput) => Promise<void>; onUnbind: () => void; onTest: () => void
}) {
  const [centerId, setCenterId] = useState('')
  const [bindingCode, setBindingCode] = useState('')
  const [keys, setKeys] = useState([{ id: '', pem: '' }])
  const [confirmed, setConfirmed] = useState(false)
  const [formError, setFormError] = useState('')
  const prefix = useId()
  const locked = busy || view?.errorCode === 'CENTER_RESTART_REQUIRED'
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const code = bindingCode.trim()
    setBindingCode('')
    setFormError('')
    if (!view || !view.configured || locked || !confirmed || !centerId.trim() || !code) {
      setFormError('请填写中心 ID、一次性绑定码，并完成独立公钥核对。绑定码已清空。'); return
    }
    const entries = keys.map(key => [key.id.trim(), key.pem.trim()] as const)
    if (entries.some(([id, pem]) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
      || !pem.startsWith('-----BEGIN PUBLIC KEY-----') || !pem.endsWith('-----END PUBLIC KEY-----') || pem.includes('PRIVATE KEY'))
      || new Set(entries.map(([id]) => id)).size !== entries.length) {
      setFormError('请填写互不重复的公钥 ID 和 PUBLIC KEY PEM；不接受私钥。绑定码已清空。'); return
    }
    setConfirmed(false)
    void onBind({ bindingCode: code, expectedRevision: view.revision, expectedCenterId: centerId.trim(), trustedSigningKeys: Object.fromEntries(entries) })
  }
  return <div className={css.stack}>
    <section className={css.box}>
      <h3>此部署的中心来源</h3>
      <dl className={css.facts}>
        <dt>配置地址</dt><dd>{view?.configuredOrigin ?? '尚未配置'}</dd>
        <dt>绑定状态</dt><dd>{view?.connection?.bound ? '已绑定' : view?.connection ? '已解绑；保留本地可信公钥和包' : '尚未绑定'}</dd>
        {view?.connection && <><dt>中心 ID</dt><dd>{view.connection.centerId}</dd><dt>组织</dt><dd>{view.connection.organizationId}</dd>
          <dt>部署 ID</dt><dd>{view.connection.deploymentId}</dd><dt>凭据到期</dt><dd>{date(view.connection.credentialExpiresAt)}</dd>
          <dt>绑定时间</dt><dd>{date(view.connection.boundAt)}</dd></>}
      </dl>
      <p className={css.hint}>中心地址由管理员通过插件配置 <code>packCenterOrigin</code> 设置，私密目录由 <code>packCenterDir</code> 设置。此页不能改成任意远程地址。</p>
      <div className={css.actions}>
        <button className={css.button} type="button" disabled={busy || !view?.connection?.bound} onClick={onTest}>测试连接</button>
        <button className={css.dangerButton} type="button" disabled={locked || !view?.connection?.bound} onClick={onUnbind}>解绑此部署</button>
      </div>
      <p className={css.hint}>解绑只移除本地机器凭据，不删除已安装包与可信公钥；如需撤销中心凭据，请在中心管理台另行撤销。中心故障不会主动停用本地已启用包。</p>
      {view?.connection && <><h4>已固定的签名公钥指纹</h4><ul className={css.fingerprintList}>{Object.entries(view.connection.signingKeyFingerprints).map(([id, fingerprint]) => <li key={id}><span>{id}</span><code>{fingerprint}</code></li>)}</ul></>}
    </section>
    <form className={css.box} onSubmit={submit} autoComplete="off">
      <h3>{view?.connection?.bound ? '重新绑定 / 轮换机器凭据' : '绑定中心'}</h3>
      <p className={css.hint}>先向中心管理员索取一次性绑定码，并通过独立渠道核对中心 ID 与 Ed25519 公钥。不会自动信任中心返回的未知公钥。重新绑定成功后，请管理员撤销不再使用的旧凭据。</p>
      <label className={css.field} htmlFor={`${prefix}-center`}>独立核对的中心 ID<input id={`${prefix}-center`} className={css.input} value={centerId} maxLength={128} onChange={event => setCenterId(event.target.value)} required disabled={locked} /></label>
      <label className={css.field} htmlFor={`${prefix}-code`}>一次性绑定码<input id={`${prefix}-code`} className={css.input} type="password" value={bindingCode} onChange={event => setBindingCode(event.target.value)} maxLength={2048} autoComplete="new-password" spellCheck={false} required disabled={locked} /></label>
      {keys.map((key, index) => <fieldset key={index} className={css.keyFields} disabled={locked}>
        <legend>独立可信公钥 {index + 1}</legend>
        <label className={css.field} htmlFor={`${prefix}-key-${index}`}>公钥 ID<input id={`${prefix}-key-${index}`} className={css.input} value={key.id} maxLength={128} required onChange={event => setKeys(previous => previous.map((item, position) => position === index ? { ...item, id: event.target.value } : item))} /></label>
        <label className={css.field} htmlFor={`${prefix}-pem-${index}`}>公钥 PEM（仅 PUBLIC KEY）<textarea id={`${prefix}-pem-${index}`} className={css.textarea} value={key.pem} rows={4} maxLength={8192} required autoComplete="off" spellCheck={false} onChange={event => setKeys(previous => previous.map((item, position) => position === index ? { ...item, pem: event.target.value } : item))} /></label>
        {keys.length > 1 && <button className={css.button} type="button" onClick={() => setKeys(previous => previous.filter((_, position) => position !== index))}>移除此公钥</button>}
      </fieldset>)}
      <button className={css.button} type="button" disabled={locked || keys.length >= 8} onClick={() => setKeys(previous => [...previous, { id: '', pem: '' }])}>添加公钥</button>
      <label className={css.check}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={locked} />已通过独立渠道核对中心和公钥</label>
      {formError && <p className={css.error} role="alert">{formError}</p>}
      <button className={css.primaryButton} type="submit" disabled={locked || !view?.configured || !confirmed}>{busy ? '绑定处理中…' : view?.connection?.bound ? '确认重新绑定' : '确认绑定'}</button>
      <p className={css.hint}>绑定码提交即清空；提交结果不明时不会自动重试，请到中心核实并按需重新签发。</p>
    </form>
  </div>
}

function CenterSession({ token, scope }: { token: string; scope?: ExpertLibrarySettingsScope }) {
  const [tab, setTab] = useState<Tab>('领域包目录')
  const [connection, setConnection] = useState<CenterConnectionView | null>(null)
  const [catalog, setCatalog] = useState<CenterCatalogView | null>(null)
  const [installed, setInstalled] = useState<CenterInstallationsView | null>(null)
  const [updates, setUpdates] = useState<CenterUpdatesView | null>(null)
  const [operations, setOperations] = useState<CenterOperationView[]>([])
  const [detail, setDetail] = useState<CenterReleaseDetail | null>(null)
  const [search, setSearch] = useState('')
  const [loadedSearch, setLoadedSearch] = useState('')
  const [rollbackTargets, setRollbackTargets] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Partial<Record<ReadKey | 'write', string>>>({})
  const [loading, setLoading] = useState<Partial<Record<ReadKey, boolean>>>({})
  const [writing, setWriting] = useState(false)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [unbindRevision, setUnbindRevision] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const apiRef = useRef<PackCenterApi | null>(null)
  const connectionRevisionRef = useRef<number | null>(null)
  const requestedInstalledGeneration = useRef(0)
  const sequences = useRef<Partial<Record<ReadKey, number>>>({})
  const writingRef = useRef(false)
  const prefix = useId()
  const isCurrent = (client: PackCenterApi): boolean => apiRef.current === client
  function clearUnauthorized(client: PackCenterApi, errorCode: string): void {
    if (!isCurrent(client)) return
    client.close(); apiRef.current = createPackCenterApi(token)
    sequences.current = {}; connectionRevisionRef.current = null
    writingRef.current = false; setWriting(false); setLoading({})
    setConnection(null); setCatalog(null); setInstalled(null); setUpdates(null); setOperations([]); setDetail(null)
    setPendingAction(null); setUnbindRevision(null); setErrors({ connection: errorCode })
    setNotice('本地管理权限未通过。旧权限下的内容已清空，请重新应用有效令牌。')
  }

  async function read<T>(key: ReadKey, client: PackCenterApi, request: () => Promise<T>, commit: (value: T) => void): Promise<void> {
    const sequence = (sequences.current[key] ?? 0) + 1
    sequences.current[key] = sequence
    setLoading(previous => ({ ...previous, [key]: true }))
    setErrors(previous => ({ ...previous, [key]: undefined }))
    const current = () => isCurrent(client) && sequences.current[key] === sequence
    try { const value = await request(); if (current()) commit(value) }
    catch (error) {
      if (current()) {
        const code = centerUiErrorCode(error)
        if (code === 'MANAGE_UNAUTHORIZED') clearUnauthorized(client, code)
        else setErrors(previous => ({ ...previous, [key]: code }))
      }
    }
    finally { if (current()) setLoading(previous => ({ ...previous, [key]: false })) }
  }
  function loadInstalled(client = apiRef.current): void {
    if (client) void read('installed', client, client.installations, setInstalled)
  }
  function loadOperations(client = apiRef.current): void {
    if (client) void read('operations', client, client.operations, setOperations)
  }
  function loadCatalog(packId = search.trim(), beforeId?: string): void {
    const client = apiRef.current
    if (!client) return
    void read('catalog', client, () => client.catalog({ ...(packId ? { packId } : {}), limit: 20, ...(beforeId ? { beforeId } : {}) }), value => {
      setLoadedSearch(packId)
      setCatalog(previous => beforeId && previous ? {
        ...value, items: [...new Map([...previous.items, ...value.items].map(item => [item.releaseId, item])).values()],
      } : value)
    })
  }
  function loadDetail(id: string): void {
    const client = apiRef.current
    if (!client) return
    setDetail(null)
    void read('detail', client, () => client.release(id), setDetail)
  }
  function bootstrap(client: PackCenterApi, knownConnection?: CenterConnectionView): void {
    if (knownConnection) { connectionRevisionRef.current = knownConnection.revision; setConnection(knownConnection) }
    else void read('connection', client, client.connection, value => {
      if (connectionRevisionRef.current !== null && connectionRevisionRef.current !== value.revision) resetAfterBinding(value)
      else { connectionRevisionRef.current = value.revision; setConnection(value) }
    })
    loadInstalled(client)
    loadOperations(client)
    void read('updates', client, client.updates, setUpdates)
    void read('catalog', client, () => client.catalog({ limit: 20 }), setCatalog)
  }
  function resetAfterBinding(value: CenterConnectionView): void {
    apiRef.current?.close()
    const client = createPackCenterApi(token)
    apiRef.current = client
    sequences.current = {}
    requestedInstalledGeneration.current = 0
    setCatalog(null); setInstalled(null); setUpdates(null); setOperations([]); setDetail(null)
    setPendingAction(null); setUnbindRevision(null); setErrors({}); setLoading({}); setRollbackTargets({})
    setSearch(''); setLoadedSearch('')
    bootstrap(client, value)
  }
  useEffect(() => {
    const client = createPackCenterApi(token)
    apiRef.current = client
    bootstrap(client)
    return () => { if (apiRef.current === client) apiRef.current = null; client.close(); apiRef.current?.close(); apiRef.current = null }
  }, [token])

  // Polling is read-only. Failed polling stops until the user explicitly refreshes.
  const hasPendingOperations = operations.some(busyOperation)
  useEffect(() => {
    if (!hasPendingOperations || errors.operations || loading.operations) return
    const timer = setTimeout(() => {
      const client = apiRef.current
      if (!client) return
      const previouslyPending = new Set(operations.filter(busyOperation).map(item => item.operationId))
      void read('operations', client, client.operations, value => {
        setOperations(value)
        if (value.some(item => previouslyPending.has(item.operationId) && !busyOperation(item))) {
          loadInstalled(client)
          void read('updates', client, client.updates, setUpdates)
        }
      })
    }, 1500)
    return () => clearTimeout(timer)
  }, [operations, hasPendingOperations, errors.operations, loading.operations])
  useEffect(() => {
    const latest = Math.max(0, ...operations.map(item => item.result?.generation ?? 0))
    if (installed && !loading.installed && !errors.installed && latest > installed.generation && latest > requestedInstalledGeneration.current) {
      requestedInstalledGeneration.current = latest
      loadInstalled()
    }
  }, [operations, installed, loading.installed, errors.installed])

  const restartRequired = connection?.errorCode === 'CENTER_RESTART_REQUIRED'
  const cannotMutate = writing || restartRequired || !!errors.connection || !!errors.installed || !installed || installed.mode !== 'normal'
  const canActivate = connection?.activationAvailable === true
  const catalogStale = !!catalog?.stale || !!errors.catalog
  const updatesStale = !!updates?.stale || !!errors.updates
  function chooseRemote(release: CenterReleaseSummary, kind: 'install' | 'update_enable'): void {
    if (!installed || !connection || cannotMutate) return
    setErrors(previous => ({ ...previous, write: undefined })); setNotice('')
    setPendingAction({
      input: { kind, operationKey: crypto.randomUUID(), expectedGeneration: installed.generation, releaseId: release.releaseId, connectionRevision: connection.revision, target: digest(release) },
      title: `${KINDS[kind]}：${release.packId}@${release.version}`,
      description: kind === 'install' ? '只下载、校验并缓存这个固定发布；不会自动启用或改变当前运行版本。'
        : '固定版本通过下载 / 本地缓存校验与启用预检后才切换。若启用失败，保留原运行版本，并明确显示“已安装但未启用”。',
    })
  }
  function chooseLocal(kind: 'enable' | 'disable' | 'rollback' | 'uninstall', item: CenterInstalledRelease, target?: CenterInstalledRelease): void {
    if (!installed || cannotMutate) return
    const fields = kind === 'disable' ? { packId: item.packId } : kind === 'rollback' ? { packId: item.packId, releaseId: target?.releaseId } : { releaseId: item.releaseId }
    setErrors(previous => ({ ...previous, write: undefined })); setNotice('')
    setPendingAction({ input: { kind, operationKey: crypto.randomUUID(), expectedGeneration: installed.generation, ...fields },
      title: `${KINDS[kind]}：${item.packId}@${target?.version ?? item.version}`,
      description: kind === 'uninstall' ? '移除此版本的安装记录，不会清空其他包。当前已启用版本必须先停用。'
        : kind === 'disable' ? '后续新任务将不再使用此包；已运行任务持有的快照不在此操作中替换。'
          : '仅使用本地已安装的固定版本；通过完整性与依赖预检后提交。失败时保留当前有效配置。',
    })
  }
  async function performAction(): Promise<void> {
    const action = pendingAction, client = apiRef.current
    if (!action || !client || writingRef.current || restartRequired) return
    writingRef.current = true; setWriting(true); setErrors(previous => ({ ...previous, write: undefined }))
    try {
      const value = await client.enqueue(action.input)
      if (!isCurrent(client)) return
      setOperations(previous => [value, ...previous.filter(item => item.operationId !== value.operationId)])
      setPendingAction(null); setNotice('操作已进入持久化队列；关闭页面不会重复提交。')
      if (!busyOperation(value)) loadInstalled(client)
    } catch (error) {
      if (isCurrent(client)) {
        setErrors(previous => ({ ...previous, write: centerUiErrorCode(error) }))
        setPendingAction(previous => previous && previous.input.operationKey === action.input.operationKey ? { ...previous, uncertain: true } : previous)
        loadOperations(client)
      }
    } finally { if (isCurrent(client)) { writingRef.current = false; setWriting(false) } }
  }
  async function retryOperation(id: string): Promise<void> {
    const client = apiRef.current
    if (!client || writingRef.current || restartRequired) return
    writingRef.current = true; setWriting(true); setErrors(previous => ({ ...previous, write: undefined }))
    try {
      const value = await client.retry(id)
      if (isCurrent(client)) setOperations(previous => [value, ...previous.filter(item => item.operationId !== value.operationId)])
    } catch (error) { if (isCurrent(client)) setErrors(previous => ({ ...previous, write: centerUiErrorCode(error) })) }
    finally { if (isCurrent(client)) { writingRef.current = false; setWriting(false) } }
  }
  async function bind(input: CenterBindInput): Promise<void> {
    const client = apiRef.current
    if (!client || writingRef.current) return
    writingRef.current = true; setWriting(true); setErrors(previous => ({ ...previous, write: undefined })); setNotice('')
    try {
      const value = await client.bind(input)
      if (!isCurrent(client)) return
      resetAfterBinding(value)
      setNotice('绑定成功。机器凭据只存放在宿主私密目录，不返回浏览器。')
    } catch (error) {
      if (isCurrent(client)) {
        setErrors(previous => ({ ...previous, write: centerUiErrorCode(error) }))
        setNotice('绑定未得到成功确认，不会自动重试。请在中心核实凭据状态，必要时撤销并签发新绑定码；既有本地包不变。')
      }
    } finally { if (apiRef.current) { writingRef.current = false; setWriting(false) } }
  }
  async function unbind(): Promise<void> {
    const client = apiRef.current, revision = unbindRevision
    if (!client || revision === null || writingRef.current) return
    writingRef.current = true; setWriting(true); setErrors(previous => ({ ...previous, write: undefined }))
    try {
      const value = await client.unbind(revision)
      if (isCurrent(client)) { resetAfterBinding(value); setNotice('已解绑本机凭据；保留已安装包与固定公钥。中心端撤销需另行处理。') }
    } catch (error) { if (isCurrent(client)) setErrors(previous => ({ ...previous, write: centerUiErrorCode(error) })) }
    finally { if (apiRef.current) { writingRef.current = false; setWriting(false) } }
  }
  function checkUpdates(): void {
    const client = apiRef.current
    if (!client || writingRef.current || loading.updates || restartRequired) return
    void read('updates', client, client.checkUpdates, setUpdates)
  }
  function tabKeys(event: KeyboardEvent<HTMLButtonElement>): void {
    const index = TABS.indexOf(tab)
    const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : null
    if (next === null) return
    event.preventDefault(); setTab(TABS[next]!)
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons?.[next]?.focus()
  }

  return <div className={css.body}>
    <div className={css.row}><span className={css.pill} data-good={connection?.connection?.bound === true}>{connection?.connection?.bound ? '中心已绑定' : connection ? '中心未绑定' : '正在读取连接状态'}</span>
      {installed && <span className={css.hint}>本地状态代次 {installed.generation}{installed.mode === 'recovered-read-only' ? ' · 恢复只读模式' : ''}</span>}
      <button className={css.button} type="button" disabled={writing || loading.connection} onClick={() => { const client = apiRef.current; if (client) bootstrap(client) }}>刷新状态</button></div>
    <ErrorNotice code={errors.connection || connection?.errorCode} label="连接状态" />
    {installed?.mode === 'recovered-read-only' && <p className={css.warning} role="status">本地状态已从备份恢复为只读，暂停所有写操作，请管理员检查。<code> {installed.warningCode}</code></p>}
    {connection && !connection.activationAvailable && <p className={css.warning}>宿主启用预检尚不可用；当前只能缓存，启用、回滚和更新启用已禁用。</p>}
    <nav className={css.tabs} role="tablist" aria-label="领域包版本管理">
      {TABS.map((item, index) => <button className={css.tab} key={item} id={`${prefix}-tab-${index}`} role="tab" type="button" aria-selected={tab === item} aria-controls={`${prefix}-panel-${index}`} tabIndex={tab === item ? 0 : -1} onKeyDown={tabKeys} onClick={() => setTab(item)}>{item}</button>)}
    </nav>
    {notice && <p className={css.notice} role="status">{notice}</p>}
    <ErrorNotice code={errors.write} />
    {pendingAction && <section className={css.confirm} aria-label="操作确认" aria-busy={writing}>
      <h3>{pendingAction.title}</h3><p>{pendingAction.description}</p>
      <p className={css.hint}>固定本地代次 {pendingAction.input.expectedGeneration}{pendingAction.input.connectionRevision !== undefined ? ` · 绑定修订 ${pendingAction.input.connectionRevision}` : ''} · 操作键 <code>{pendingAction.input.operationKey}</code></p>
      {pendingAction.input.target && <p className={css.hint}>目标清单 <code>{pendingAction.input.target.manifestSha256}</code></p>}
      {pendingAction.uncertain && <p className={css.warning}>提交未确认。先检查下方队列；若仍需重试，将使用相同操作键和固定目标，不另建任务。若状态冲突，请取消并刷新后重新选择。</p>}
      <div className={css.actions}><button className={css.primaryButton} type="button" disabled={writing || restartRequired} onClick={() => void performAction()}>{writing ? '正在提交…' : pendingAction.uncertain ? '用相同操作键重试' : '确认执行'}</button><button className={css.button} type="button" disabled={writing} onClick={() => setPendingAction(null)}>取消</button></div>
    </section>}
    {unbindRevision !== null && <section className={css.confirm} aria-label="解绑确认"><h3>确认解绑此部署？</h3><p>删除本机凭据，但保留本地包、公钥和历史。不会自动撤销中心端凭据。</p><div className={css.actions}><button className={css.dangerButton} type="button" disabled={writing} onClick={() => void unbind()}>确认解绑</button><button className={css.button} type="button" disabled={writing} onClick={() => setUnbindRevision(null)}>取消</button></div></section>}

    <section className={css.panel} id={`${prefix}-panel-${TABS.indexOf(tab)}`} role="tabpanel" aria-labelledby={`${prefix}-tab-${TABS.indexOf(tab)}`}>
      {tab === '领域包目录' && <div className={css.stack}>
        <form className={css.search} onSubmit={event => { event.preventDefault(); setDetail(null); loadCatalog() }}>
          <label className={css.field} htmlFor={`${prefix}-search`}>按领域包 ID 筛选<input id={`${prefix}-search`} className={css.input} value={search} onChange={event => setSearch(event.target.value)} maxLength={160} placeholder="留空查看可见发布" /></label>
          <button className={css.button} type="submit" disabled={loading.catalog || writing}>{loading.catalog ? '读取中…' : '查询目录'}</button>
        </form>
        <SnapshotNotice snapshot={catalog && (errors.catalog ? { ...catalog, stale: true } : catalog)} label="目录" /><ErrorNotice code={errors.catalog} label="目录读取" />
        {!errors.catalog && catalog?.hasSnapshot && !catalog.stale && catalog.items.length === 0 && <p className={css.hint}>当前凭据与筛选范围内没有可见发布。</p>}
        <ul className={css.cards}>{catalog?.items.map(item => <li key={item.releaseId} className={css.box}>
          <div className={css.row}><h3>{item.name || item.packId}</h3><span className={css.pill}>{item.version}</span></div>
          <p className={css.meta}>{item.packId} · {item.ownerOrgId} · {date(item.publishedAt)}</p>
          {!item.compatibility.compatible && <p className={css.warning}>不兼容：{item.compatibility.reasons.join('；')}</p>}
          {!item.downloadAvailability.available && <p className={css.warning}>暂不可下载 <code>{item.downloadAvailability.code}</code></p>}
          <div className={css.actions}><button className={css.button} type="button" disabled={loading.detail} onClick={() => loadDetail(item.releaseId)}>查看详情</button>
            <button className={css.primaryButton} type="button" disabled={cannotMutate || !connection?.connection?.bound || catalogStale || !item.compatibility.compatible || !item.downloadAvailability.available} onClick={() => chooseRemote(item, 'install')}>安装到缓存</button></div>
        </li>)}</ul>
        {catalog?.nextCursor && <button className={css.button} type="button" disabled={loading.catalog || catalogStale} onClick={() => loadCatalog(loadedSearch, catalog.nextCursor!)}>加载更多发布</button>}
        <ErrorNotice code={errors.detail} label="发布详情" />{loading.detail && <p role="status">正在读取发布详情…</p>}
        {detail && <ReleaseDetail value={detail} close={() => setDetail(null)} />}
      </div>}
      {tab === '本地校验' && <PackValidationPanel scope={scope} />}
      {tab === '本地来源' && <div className={css.stack}><PackLocalPanel scope={scope} /></div>}
      {tab === '已安装' && <div className={css.stack}>
        <div className={css.row}><h3>本地安装与启用</h3><button className={css.button} type="button" disabled={loading.installed} onClick={() => loadInstalled()}>{loading.installed ? '读取中…' : '刷新已安装'}</button></div>
        <p className={css.hint}>安装只缓存；启用、停用、回滚均需单独确认。中心离线时仍可管理已验证的本地版本。</p>
        <ErrorNotice code={errors.installed} label="本地状态" />
        {!errors.installed && installed?.items.length === 0 && <p className={css.hint}>尚无中心管理的本地安装版本。原有领域包预览入口保持不变。</p>}
        <ul className={css.cards}>{installed?.items.map(item => {
          const previous = installed.items.filter(candidate => candidate.releaseId !== item.releaseId && candidate.packId === item.packId && candidate.source === item.source
            && candidate.centerId === item.centerId && candidate.ownerOrgId === item.ownerOrgId && candidate.integrity === 'verified'
            && (isOlderCenterVersion(candidate.version, item.version) || candidate.releaseId === item.previousReleaseId))
          const target = previous.find(candidate => candidate.releaseId === rollbackTargets[item.releaseId]) ?? previous.find(candidate => candidate.releaseId === item.previousReleaseId) ?? previous[0]
          return <li className={css.box} key={item.releaseId}>
            <div className={css.row}><h3>{item.packId}@{item.version}</h3><span className={css.pill} data-good={item.active}>{item.active ? '已启用' : '已缓存 / 未启用'}</span><span className={css.pill}>{item.source === 'legacy' ? '接管的旧来源' : '中心包'}</span></div>
            <p className={css.meta}>发布 ID <code>{item.releaseId}</code> · 安装于 {date(item.installedAt)}</p>
            {item.source === 'legacy' && <p className={css.hint}>此处只读展示旧来源。接管、恢复和卸载请继续使用原有管理流程。</p>}
            {item.integrity !== 'verified' && <p className={css.warning}>本地完整性不可用，不能启用或回滚至此版本。<code> {item.errorCode}</code></p>}
            <div className={css.actions}>
              {item.active ? <button className={css.button} type="button" disabled={cannotMutate || !canActivate || item.source === 'legacy'} onClick={() => chooseLocal('disable', item)}>停用</button>
                : <button className={css.primaryButton} type="button" disabled={cannotMutate || !canActivate || item.integrity !== 'verified' || item.source === 'legacy'} onClick={() => chooseLocal('enable', item)}>启用此版本</button>}
              <button className={css.dangerButton} type="button" disabled={cannotMutate || item.active || item.source === 'legacy'} onClick={() => chooseLocal('uninstall', item)}>卸载此版本</button>
            </div>
            {item.source !== 'legacy' && item.active && previous.length > 0 && <div className={css.rollback}>
              <label className={css.field} htmlFor={`${prefix}-rollback-${item.releaseId}`}>选择本地回滚版本<select className={css.input} id={`${prefix}-rollback-${item.releaseId}`} value={target?.releaseId ?? ''} onChange={event => setRollbackTargets(value => ({ ...value, [item.releaseId]: event.target.value }))}>{previous.map(candidate => <option key={candidate.releaseId} value={candidate.releaseId}>{candidate.version} · {candidate.releaseId}</option>)}</select></label>
              <button className={css.button} type="button" disabled={cannotMutate || !canActivate || !target} onClick={() => chooseLocal('rollback', item, target)}>回滚至所选版本</button>
            </div>}
          </li>
        })}</ul>
      </div>}
      {tab === '更新' && <div className={css.stack}>
        <div className={css.row}><h3>已安装包更新</h3><button className={css.button} type="button" disabled={loading.updates || writing || restartRequired || !connection?.connection?.bound} onClick={checkUpdates}>{loading.updates ? '检查中…' : '检查更新'}</button></div>
        <p className={css.hint}>检查不会自动安装。仅显示当前凭据可见的稳定发布；权限、兼容性与依赖阻断会单独列出。</p>
        <SnapshotNotice snapshot={updates && (errors.updates ? { ...updates, stale: true } : updates)} label="更新检查" /><ErrorNotice code={errors.updates} label="更新检查" />
        {!errors.updates && updates?.hasSnapshot && !updates.stale && updates.items.length === 0 && <p className={css.hint}>没有需要检查的中心安装包。</p>}
        <ul className={css.cards}>{updates?.items.map(item => <li className={css.box} key={item.packId}>
          <h3>{item.packId}</h3><p>当前 {item.current.version} · {item.current.active ? '已启用' : '未启用'}{item.latestVisible ? ` · 最新可见 ${item.latestVisible.version}` : ''}</p>
          {item.status === 'up_to_date' && <p className={updatesStale ? css.warning : css.hint}>{updatesStale ? '上次检查无可用更新；当前尚未确认。' : '当前可见范围内无可用更新。'}</p>}
          {item.status === 'no_stable_release' && <p className={css.warning}>当前可见范围没有可用稳定发布，不能断言已是最新。</p>}
          {item.status === 'blocked' && <p className={css.warning}>较新发布存在阻断，尚不能更新。</p>}
          {item.blockedReasons.length > 0 && <ul className={css.diagnostics}>{item.blockedReasons.map(reason => <li key={reason.releaseId}><code>{reason.releaseId}</code>：{reason.reasons.join('；')}</li>)}</ul>}
          {item.candidate && <><p>可选目标 {item.candidate.version}{item.candidateCached ? ' · 已在本地缓存' : ''}</p><div className={css.actions}>
            <button className={css.button} type="button" disabled={cannotMutate || updatesStale || !connection?.connection?.bound || item.candidateCached} onClick={() => chooseRemote(item.candidate!, 'install')}>{item.candidateCached ? '目标已缓存' : '仅下载到缓存'}</button>
            <button className={css.primaryButton} type="button" disabled={cannotMutate || !canActivate || updatesStale || !connection?.connection?.bound} onClick={() => chooseRemote(item.candidate!, 'update_enable')}>更新并启用所选版本</button>
          </div></>}
        </li>)}</ul>
      </div>}
      {tab === '来源设置' && <SourceSettings key={`${connection?.revision ?? 'unavailable'}:${connection?.errorCode ?? ''}`} view={connection} busy={writing} onBind={bind} onUnbind={() => { if (connection) setUnbindRevision(connection.revision) }} onTest={() => { setTab('领域包目录'); setSearch(''); loadCatalog('') }} />}
    </section>
    {TABS.filter(item => item !== tab).map(item => <section key={item} hidden id={`${prefix}-panel-${TABS.indexOf(item)}`} role="tabpanel" aria-labelledby={`${prefix}-tab-${TABS.indexOf(item)}`} />)}

    <section className={css.operationSection} aria-label="异步操作进度">
      <div className={css.row}><h3>操作进度</h3><button className={css.button} type="button" disabled={loading.operations} onClick={() => loadOperations()}>{loading.operations ? '刷新中…' : '刷新操作记录'}</button></div>
      <ErrorNotice code={errors.operations} label="操作队列" />
      {errors.operations && hasPendingOperations && <p className={css.warning}>进度查询已暂停，不能据此认定任务失败。请手动刷新；不会重新提交安装。</p>}
      {!errors.operations && operations.length === 0 && <p className={css.hint}>暂无持久化操作记录。</p>}
      <ol className={css.cards}>{operations.map(item => <li className={css.operation} key={item.operationId} aria-busy={busyOperation(item)}>
        <div className={css.row}><strong>{KINDS[item.request.kind]} · {item.request.packId ?? item.request.releaseId}</strong><span className={css.pill} data-good={item.status === 'succeeded' && item.result?.outcome !== 'installed_not_enabled'}>{item.result?.outcome === 'installed_not_enabled' ? '已安装但未启用' : STATUS[item.status]}</span></div>
        <p role="status">阶段：{PHASES[item.phase] ?? '等待明确阶段'} · 更新于 {date(item.updatedAt)}</p>
        {item.result?.outcome === 'installed_not_enabled' && <p className={css.warning}>目标已缓存，但启用未成功；原启用版本保持不变。请检查错误后重新选择本地启用操作。</p>}
        <p className={css.meta}>操作 ID <code>{item.operationId}</code> · 固定操作键 <code>{item.request.operationKey}</code></p>
        <ErrorNotice code={item.errorCode ?? item.result?.errorCode} />
        {(item.status === 'failed' || item.status === 'interrupted') && <button className={css.button} type="button" disabled={writing || restartRequired} onClick={() => void retryOperation(item.operationId)}>手动重试同一操作</button>}
      </li>)}</ol>
    </section>
  </div>
}

/** Changing the active token remounts all privileged state and aborts the previous session. */
/** PackCenterCard props: `scope` enables the 本地校验 tab's runtime editing. */
export function PackCenterCard({ close, scope }: { close: () => void; scope?: ExpertLibrarySettingsScope }) {
  const [tokenDraft, setTokenDraft] = useState('')
  const [session, setSession] = useState({ token: '', revision: 0 })
  const prefix = useId()
  return <section className={css.card}>
    <header className={css.head}><div className={css.row}><h2>领域包版本管理</h2><button className={css.button} type="button" onClick={close}>关闭</button></div>
      <p className={css.hint}>独立中心负责发布与审核；本机负责可信下载、缓存、启用和回滚。不会自动升级正在运行的领域包。</p>
      <details className={css.auth}><summary>本地管理权限{session.token ? ' · 已设置页面内令牌' : ''}</summary>
        <form className={css.stack} autoComplete="off" onSubmit={event => { event.preventDefault(); const token = tokenDraft.trim(); setTokenDraft(''); setSession(previous => ({ token, revision: previous.revision + 1 })) }}>
          <label className={css.field} htmlFor={`${prefix}-token`}>本地管理令牌（可选）<input id={`${prefix}-token`} className={css.input} type="password" value={tokenDraft} maxLength={4096} autoComplete="new-password" spellCheck={false} onChange={event => setTokenDraft(event.target.value)} /></label>
          <p className={css.hint}>仅在此页面内存中使用，不写入浏览器存储。留空应用可清除当前令牌。切换令牌会清空旧权限下的目录、绑定信息与进度，并中止未完成的页面请求。</p>
          <button className={css.button} type="submit">应用管理令牌</button>
        </form>
      </details>
    </header>
    <CenterSession key={session.revision} token={session.token} scope={scope} />
  </section>
}
