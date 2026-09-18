/**
 * 专家库手动管理设置页（`settings.section` entry `expert-library-manage`）：
 * 把「增加专家 / 增加领域包 / 变更专家 skill / 变更领域包包含的专家」等高频
 * 操作固定成可手动配置的表单，避免每次靠 agent 执行的随机性。
 *
 * 写目标（host `src/host/manage.ts`）：
 * - 专家/场景 → `<workspace>/<knowledgeDir>/{experts,scenarios}/<id>.json`
 *   （V1 用户自定义覆盖层，惰性生效、零漂移——领域包本体是构建产物绝不直写）；
 * - 技能 → `<knowledgeDir>/skills/<id>/`（zip 上传，安全 id + zip-slip 防护）；
 * - 领域包重建 → host 白名单脚本 `build-packs.mjs <id>`（仅允许列表内 pack id）。
 *
 * 取数（只读）：
 * - `GET /plugins/dsh-expert-library/manage/experts|scenarios|knowledge-roots`
 * - `GET /plugins/dsh-expert-library/skills`（已装技能清单，id/name/path）
 * - `GET /plugins/dsh-expert-library/packs`（领域包清单）
 *
 * Wire types 本地镜像（client bundle 不得 import host 模块）。Fetch 约定同
 * FilesView/domain-packs-card：`cache: 'no-store'`、形状守卫、保留末次快照。
 * @module dsh-expert-library/client/manage-card
 */

import { useEffect, useRef, useState } from 'react'
import css from './settings-card.module.css'

/** 写目标知识根（镜像 host ManageKnowledgeRoots）。 */
interface KnowledgeRootsWire {
  readonly ok: boolean
  readonly workspace?: string
  readonly knowledgeDir?: string
  readonly expertsDir?: string
  readonly scenariosDir?: string
  readonly skillsDir?: string
}

/**
 * 一个已入库的外部来源包（GET /manage/packs/registry）。
 * `state` 由 host 重算树摘要得出：clean = 与入库时一致，modified = 本地被改过。
 */
interface VendoredPackWire {
  readonly id: string
  readonly locator: string
  readonly revision: string
  readonly trust: string
  readonly state: string
  readonly rollbackAvailable: boolean
}

/** 一个已存在的自定义专家（GET /manage/experts）。 */
interface ManagedExpertWire {
  readonly id: string
  readonly name?: string
  readonly role?: string
  readonly invalid?: boolean
}

/** 一个已存在的自定义场景（GET /manage/scenarios）。 */
interface ManagedScenarioWire {
  readonly id: string
  readonly name?: string
  readonly tasks?: number
  readonly invalid?: boolean
}

/** 已装技能（GET /skills）。 */
interface InstalledSkillWire {
  readonly id: string
  readonly name?: string
  readonly path?: string
  readonly sizeBytes?: number
  readonly hasReferences?: boolean
}

/** 领域包摘要（GET /packs）。 */
interface PackSummaryWire {
  readonly id: string
  readonly version?: string
  readonly name?: string
  readonly layer?: string
  readonly counts?: Record<string, number>
}

/** 管理操作响应（host 统一信封）。 */
interface ManageResponse {
  readonly ok: boolean
  readonly error?: string
  readonly id?: string
  readonly name?: string
  readonly files?: number
  readonly stdout?: string
  readonly stderr?: string
}

export interface ManageCardProps {
  /** 关闭设置面板（shell 持有开合状态）。 */
  close: () => void
}

const MANAGE_BASE = '/plugins/dsh-expert-library/manage'
const SKILLS_URL = '/plugins/dsh-expert-library/skills'
const PACKS_URL = '/plugins/dsh-expert-library/packs'

/**
 * 与 host `src/host/auth.ts` 的 `MANAGE_TOKEN_HEADER` 对齐。客户端不 import
 * host 代码（那会把 node:crypto 拖进浏览器包），wire 常量按本仓惯例在两侧
 * 各自声明。
 */
const MANAGE_TOKEN_HEADER = 'x-expert-library-manage-token'

/** 授权令牌的本地存储键。 */
const TOKEN_STORAGE_KEY = 'dsh-expert-library.manageToken'

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

/** 设置令牌并持久化；空串表示仅本机可用。 */
function setManageToken(value: string): void {
  manageToken = value.trim()
  try {
    if (manageToken === '') window.localStorage.removeItem(TOKEN_STORAGE_KEY)
    else window.localStorage.setItem(TOKEN_STORAGE_KEY, manageToken)
  } catch {
    // 同上：存不下就只在本会话内有效，不阻断使用。
  }
}

/** 合并授权头；未设令牌时返回 undefined，让 fetch 用默认值。 */
function manageHeaders(extra?: Record<string, string>): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...extra }
  if (manageToken !== '') headers[MANAGE_TOKEN_HEADER] = manageToken
  return Object.keys(headers).length === 0 ? undefined : headers
}

/** host 拒绝时的提示：区分「没带令牌」与「令牌不对」。 */
function describeAuthFailure(status: number, error: string | undefined): string {
  if (status !== 403) return error ?? `HTTP ${status}`
  return manageToken === ''
    ? '本机地址之外的访问需要授权令牌：请在下方填入 host 的 manageToken 后重试。'
    : '授权令牌无效或已变更：请核对后重填。'
}

/** 包重建白名单（与 host PACK_BUILD_ALLOWLIST 对齐；不齐时 host 会拒绝）。 */
const REBUILD_ALLOWLIST = ['zhijian-realestate', 'bank-finance', 'beike', 'pipeline-domains', 'pipeline-general', 'builtin-library']

/** 表单草稿：专家 / 场景共用（专家忽略 tasks/deliverable 之外的场景字段）。 */
interface EditorDraft {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly background: string
  readonly principles: string
  readonly deliverables: string
  readonly suitedFor: string
  readonly tasks: string
  readonly description: string
}

const EMPTY_DRAFT: EditorDraft = {
  id: '', name: '', role: '', background: '', principles: '', deliverables: '', suitedFor: '', tasks: '', description: '',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 数组→换行文本；换行文本→数组（过滤空行）。 */
function lines(value: readonly string[] | undefined): string {
  return (value ?? []).join('\n')
}
function splitLines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/** 把草稿组装成专家 JSON（与 host parseExpert 的字段对齐）。 */
function buildExpertJson(draft: EditorDraft): unknown {
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    role: draft.role.trim(),
    background: draft.background.trim(),
    principles: splitLines(draft.principles),
    deliverables: splitLines(draft.deliverables),
    ...(splitLines(draft.suitedFor).length > 0 ? { suitedFor: splitLines(draft.suitedFor) } : {}),
  }
}

/** 把草稿组装成场景 JSON（tasks 用「标题 | 描述」行解析，dependsOn 留空）。 */
function buildScenarioJson(draft: EditorDraft): unknown {
  const tasks = splitLines(draft.tasks).map((line) => {
    const [subject, ...rest] = line.split('|')
    const description = rest.join('|').trim()
    return {
      subject: (subject ?? '').trim(),
      ...(description !== '' ? { description } : {}),
    }
  })
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    description: draft.description.trim(),
    experts: splitLines(draft.suitedFor),
    tasks,
    deliverable: draft.deliverables.trim(),
  }
}

/** 通用 JSON 请求。 */
async function jsonFetch(path: string, method: string, body?: unknown): Promise<ManageResponse> {
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
async function listFetch<T>(path: string, key: string): Promise<T[]> {
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

/** 主管理面板。 */
export function ManageCard(_props: ManageCardProps) {
  const fileRef = useRef<HTMLInputElement>(null)

  // ── 数据快照 ──────────────────────────────────────────────────────────────
  const [roots, setRoots] = useState<KnowledgeRootsWire | null>(null)
  const [experts, setExperts] = useState<readonly ManagedExpertWire[]>([])
  const [scenarios, setScenarios] = useState<readonly ManagedScenarioWire[]>([])
  const [skills, setSkills] = useState<readonly InstalledSkillWire[]>([])
  const [packs, setPacks] = useState<readonly PackSummaryWire[]>([])
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [tokenDraft, setTokenDraft] = useState(manageToken)
  const [sources, setSources] = useState<readonly VendoredPackWire[]>([])
  const [locator, setLocator] = useState('')
  const [sourceRef, setSourceRef] = useState('')

  // ── 编辑器状态 ────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'expert' | 'scenario'>('expert')
  const [draft, setDraft] = useState<EditorDraft>(EMPTY_DRAFT)
  const [editingId, setEditingId] = useState<string>('')

  const refresh = async (): Promise<void> => {
    const [rootsValue, expertsValue, scenariosValue, skillsValue, packsValue] = await Promise.all([
      listFetch<KnowledgeRootsWire>(`${MANAGE_BASE}/knowledge-roots`, 'ok').then((list) => {
        // knowledge-roots 返回的是对象本身（非数组）；listFetch 用 key='ok' 拿数组，
        // 这里退回直接 fetch。
        return null
      }),
      listFetch<ManagedExpertWire>(`${MANAGE_BASE}/experts`, 'experts'),
      listFetch<ManagedScenarioWire>(`${MANAGE_BASE}/scenarios`, 'scenarios'),
      listFetch<InstalledSkillWire>(SKILLS_URL, 'skills'),
      listFetch<PackSummaryWire>(PACKS_URL, 'packs'),
    ])
    void rootsValue
    try {
      const res = await fetch(`${MANAGE_BASE}/knowledge-roots`, { cache: 'no-store' as RequestCache, headers: manageHeaders() })
      if (res.ok) {
        const value: unknown = await res.json()
        if (isRecord(value)) setRoots(value as unknown as KnowledgeRootsWire)
      }
    } catch {
      setRoots(null)
    }
    setExperts(expertsValue)
    setScenarios(scenariosValue)
    setSkills(skillsValue)
    setPacks(packsValue)
  }

  /** 已入库的外部来源包。授权失败时静默留空——授权区自己会说明原因。 */
  const refreshSources = async (): Promise<void> => {
    const value = await listFetch<VendoredPackWire>(`${MANAGE_BASE}/packs/registry`, 'packs')
    setSources(value)
  }

  useEffect(() => {
    void refresh()
    void refreshSources()
  }, [])

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

  const setField = (key: keyof EditorDraft, value: string): void => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const startNew = (nextMode: 'expert' | 'scenario'): void => {
    setMode(nextMode)
    setEditingId('')
    setDraft(EMPTY_DRAFT)
    setMessage('')
    setError('')
  }

  const editExpert = (expert: ManagedExpertWire): void => {
    setMode('expert')
    setEditingId(expert.id)
    setDraft({
      id: expert.id,
      name: expert.name ?? '',
      role: expert.role ?? '',
      background: '',
      principles: '',
      deliverables: '',
      suitedFor: '',
      tasks: '',
      description: '',
    })
    setMessage('')
    setError('')
    // 编辑已有专家：提示完整字段以手工维护（列表只带 id/name/role）。
    setMessage(`编辑 ${expert.id}：请填写完整字段后保存（persona 全文不会从列表回填）。`)
  }

  const save = async (): Promise<void> => {
    if (draft.id.trim() === '') {
      setError('id 不能为空')
      return
    }
    setBusy('save')
    setError('')
    const body = mode === 'expert' ? buildExpertJson(draft) : buildScenarioJson(draft)
    const result = await jsonFetch(`${MANAGE_BASE}/${mode}s`, 'PUT', body)
    setBusy('')
    if (result.ok) {
      setMessage(`${mode === 'expert' ? '专家' : '场景'}「${result.id}」已保存（写入 ${mode === 'expert' ? 'experts' : 'scenarios'} 覆盖层，惰性生效）。`)
      void refresh()
    } else {
      setError(result.error ?? '保存失败')
    }
  }

  const remove = async (kind: 'expert' | 'scenario', id: string): Promise<void> => {
    setBusy(`del-${id}`)
    setError('')
    const result = await jsonFetch(`${MANAGE_BASE}/${kind}s?id=${encodeURIComponent(id)}`, 'DELETE')
    setBusy('')
    if (result.ok) {
      setMessage(`已删除 ${kind}「${id}」。`)
      void refresh()
    } else {
      setError(result.error ?? '删除失败')
    }
  }

  const installSkill = async (): Promise<void> => {
    const input = fileRef.current
    const file = input?.files?.[0]
    if (file === undefined) {
      setError('请先选择技能 zip 文件')
      return
    }
    // 技能 id：zip 内顶层目录名（如 tencent-pptx-skill/SKILL.md → tencent-pptx-skill）
    const topName = file.name.replace(/\.zip$/i, '').replace(/-skill$/i, '')
    const id = window.prompt('技能 id（安装目录名，≤64 字符，字母/数字/._-）：', topName)
    if (id === null || id.trim() === '') return
    setBusy('skill')
    setError('')
    try {
      const form = new FormData()
      form.append('id', id.trim())
      form.append('zip', file)
      const res = await fetch(`${MANAGE_BASE}/skills`, {
        method: 'POST',
        cache: 'no-store' as RequestCache,
        // 不设 content-type：multipart 的 boundary 由浏览器补。
        headers: manageHeaders(),
        body: form,
      })
      const value: unknown = await res.json()
      const result = isRecord(value)
        ? (value as unknown as ManageResponse)
        : { ok: false, error: describeAuthFailure(res.status, undefined) }
      setBusy('')
      if (result.ok) {
        setMessage(`技能「${result.id}」已安装（${result.files ?? 0} 个文件 → ${roots?.skillsDir ?? 'knowledge/skills/'}），惰性生效。`)
        if (input !== null) input.value = ''
        void refresh()
      } else {
        setError(result.error ?? '安装失败')
      }
    } catch (cause) {
      setBusy('')
      setError(`安装失败：${String(cause)}`)
    }
  }

  const rebuild = async (packId: string): Promise<void> => {
    setBusy(`rebuild-${packId}`)
    setError('')
    const result = await jsonFetch(`${MANAGE_BASE}/packs/rebuild`, 'POST', { id: packId })
    setBusy('')
    if (result.ok) {
      const tail = (result.stdout ?? '').split('\n').filter((line) => line.trim() !== '').slice(-4).join('\n')
      setMessage(`领域包「${packId}」重建完成：\n${tail}`)
      void refresh()
    } else {
      setError(result.error ?? `重建失败：${(result.stderr ?? '').slice(-300)}`)
    }
  }

  const packCount = (pack: PackSummaryWire, key: string): number => pack.counts?.[key] ?? 0

  return (
    <section className={css.card}>
      <header className={css.head}>
        <h2 className={css.title}>专家库管理</h2>
        <span className={css.subtitle}>手动配置高频操作：增加/编辑/删除自定义专家与场景、安装技能、重建领域包——避免每次靠 agent 执行的随机性。写目标：{roots?.workspace ?? '工作区'}/{roots?.knowledgeDir ?? 'knowledge'}/。</span>
      </header>

      <div className={css.body}>
        {(message !== '' || error !== '') && (
          <p className={error !== '' ? css.statusError : css.probeResult} role="status">
            {error !== '' ? error : message}
            {error !== '' && <button className={css.button} type="button" onClick={() => setError('')}>关闭</button>}
          </p>
        )}

        {/* ── 授权（非本机访问） ──────────────────────────────────────────── */}
        <h3 className={css.sectionTitle}>授权（非本机访问）</h3>
        <p className={css.sectionHint}>
          以本机地址（127.0.0.1 / localhost）打开本页无需令牌。经公网域名打开时，host 会拒绝
          未持令牌的 <code>/manage/*</code> 请求，下面的令牌即用于放行。令牌取自 host 配置项
          <code>manageToken</code> 或环境变量 <code>DSH_EXPERT_LIBRARY_MANAGE_TOKEN</code>；
          仅保存在本浏览器 localStorage，随请求头送出，不写入 URL。
        </p>
        <div className={css.fields}>
          <label className={css.field}>
            <span className={css.fieldLabel}>授权令牌</span>
            <input
              className={css.input}
              type="password"
              value={tokenDraft}
              autoComplete="off"
              placeholder={manageToken === '' ? '未设置——仅本机可用' : '已设置（清空并保存可移除）'}
              onChange={(event) => setTokenDraft(event.target.value)}
            />
          </label>
          <button
            className={css.button}
            type="button"
            onClick={() => {
              setManageToken(tokenDraft)
              setTokenDraft(manageToken)
              setError('')
              setMessage(manageToken === '' ? '已清除令牌：/manage/* 现在仅本机可用。' : '令牌已保存到本浏览器，正在重试请求…')
              void refresh()
            }}
          >
            保存令牌
          </button>
        </div>

        {/* ── 专家 / 场景管理 ─────────────────────────────────────────────── */}
        <h3 className={css.sectionTitle}>专家与场景（工作区覆盖层）</h3>
        <p className={css.sectionHint}>写入 <code>{roots?.expertsDir ?? '…/knowledge/experts/'}</code> 与 <code>{roots?.scenariosDir ?? '…/knowledge/scenarios/'}</code>，惰性生效、零漂移（领域包本体由构建器生成，不在此直改）。</p>
        <div className={css.packToolbar}>
          <button className={css.button} type="button" disabled={busy !== ''} onClick={() => startNew('expert')}>＋ 新建专家</button>
          <button className={css.button} type="button" disabled={busy !== ''} onClick={() => startNew('scenario')}>＋ 新建场景</button>
          <button className={css.button} type="button" disabled={busy !== ''} onClick={() => void refresh()}>刷新</button>
        </div>

        <div className={css.packToolbar}>
          <button className={`${css.button} ${mode === 'expert' ? css.buttonPrimary : ''}`} type="button" onClick={() => setMode('expert')}>编辑专家（{experts.length}）</button>
          <button className={`${css.button} ${mode === 'scenario' ? css.buttonPrimary : ''}`} type="button" onClick={() => setMode('scenario')}>编辑场景（{scenarios.length}）</button>
        </div>

        {mode === 'expert' && experts.length > 0 && (
          <table className={css.packTable}>
            <thead>
              <tr><th>id</th><th>名称</th><th>角色</th><th>操作</th></tr>
            </thead>
            <tbody>
              {experts.map((expert) => (
                <tr key={expert.id}>
                  <td><code className={css.packId}>{expert.id}</code>{expert.invalid === true && <span className={css.statusLabel}>（无效 JSON）</span>}</td>
                  <td>{expert.name ?? '—'}</td>
                  <td>{expert.role ?? '—'}</td>
                  <td>
                    <button className={css.button} type="button" disabled={busy !== ''} onClick={() => editExpert(expert)}>编辑</button>{' '}
                    <button className={css.button} type="button" disabled={busy !== ''} onClick={() => void remove('expert', expert.id)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {mode === 'expert' && experts.length === 0 && <p className={css.packsNote}>暂无自定义专家（内置/领域包专家不在此列）。</p>}

        {mode === 'scenario' && scenarios.length > 0 && (
          <table className={css.packTable}>
            <thead>
              <tr><th>id</th><th>名称</th><th>任务数</th><th>操作</th></tr>
            </thead>
            <tbody>
              {scenarios.map((scenario) => (
                <tr key={scenario.id}>
                  <td><code className={css.packId}>{scenario.id}</code>{scenario.invalid === true && <span className={css.statusLabel}>（无效 JSON）</span>}</td>
                  <td>{scenario.name ?? '—'}</td>
                  <td>{scenario.tasks ?? '—'}</td>
                  <td>
                    <button className={css.button} type="button" disabled={busy !== ''} onClick={() => { setMode('scenario'); setEditingId(scenario.id); setDraft({ id: scenario.id, name: scenario.name ?? '', role: '', background: '', principles: '', deliverables: '', suitedFor: '', tasks: '', description: '' }); setMessage(`编辑 ${scenario.id}：请填写完整字段后保存。`); setError('') }}>编辑</button>{' '}
                    <button className={css.button} type="button" disabled={busy !== ''} onClick={() => void remove('scenario', scenario.id)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {mode === 'scenario' && scenarios.length === 0 && <p className={css.packsNote}>暂无自定义场景（内置/领域包场景不在此列）。</p>}

        {/* 编辑器 */}
        <div className={css.fields}>
          <div className={css.packToolbar}>
            <strong className={css.packName}>{editingId !== '' ? `编辑：${editingId}` : `新建${mode === 'expert' ? '专家' : '场景'}`}</strong>
          </div>
          <label className={css.field}><span className={css.fieldLabel}>id（唯一，≤64 字符）</span><input className={css.input} value={draft.id} onChange={(event) => setField('id', event.target.value)} /></label>
          <label className={css.field}><span className={css.fieldLabel}>名称</span><input className={css.input} value={draft.name} onChange={(event) => setField('name', event.target.value)} /></label>
          {mode === 'expert' && (
            <>
              <label className={css.field}><span className={css.fieldLabel}>角色（role）</span><input className={css.input} value={draft.role} onChange={(event) => setField('role', event.target.value)} /></label>
              <label className={css.field}><span className={css.fieldLabel}>背景（background，persona 注入）</span><textarea className={css.input} rows={4} value={draft.background} onChange={(event) => setField('background', event.target.value)} /></label>
              <label className={css.field}><span className={css.fieldLabel}>工作原则（principles，每行一条；绑定技能时在此写入技能引用规则）</span><textarea className={css.input} rows={5} value={draft.principles} onChange={(event) => setField('principles', event.target.value)} /></label>
              <label className={css.field}><span className={css.fieldLabel}>交付物（deliverables，每行一条）</span><textarea className={css.input} rows={3} value={draft.deliverables} onChange={(event) => setField('deliverables', event.target.value)} /></label>
              <label className={css.field}><span className={css.fieldLabel}>适合场景（suitedFor，每行一个场景 id）</span><textarea className={css.input} rows={2} value={draft.suitedFor} onChange={(event) => setField('suitedFor', event.target.value)} /></label>
            </>
          )}
          {mode === 'scenario' && (
            <>
              <label className={css.field}><span className={css.fieldLabel}>描述（description）</span><textarea className={css.input} rows={3} value={draft.description} onChange={(event) => setField('description', event.target.value)} /></label>
              <label className={css.field}><span className={css.fieldLabel}>专家（experts，每行一个专家 id）</span><textarea className={css.input} rows={2} value={draft.suitedFor} onChange={(event) => setField('suitedFor', event.target.value)} /></label>
              <label className={css.field}><span className={css.fieldLabel}>任务（tasks，每行「标题 | 描述」，按行顺序成链）</span><textarea className={css.input} rows={5} value={draft.tasks} onChange={(event) => setField('tasks', event.target.value)} /></label>
              <label className={css.field}><span className={css.fieldLabel}>交付物（deliverable）</span><input className={css.input} value={draft.deliverables} onChange={(event) => setField('deliverables', event.target.value)} /></label>
            </>
          )}
          <div className={css.packToolbar}>
            <button className={css.buttonPrimary} type="button" disabled={busy !== ''} onClick={() => void save()}>{busy === 'save' ? '保存中…' : '保存'}</button>
            <button className={css.button} type="button" onClick={() => { setDraft(EMPTY_DRAFT); setEditingId(''); setMessage(''); setError('') }}>清空</button>
          </div>
        </div>

        {/* ── 技能安装 ─────────────────────────────────────────────────────── */}
        <h3 className={css.sectionTitle}>技能安装</h3>
        <p className={css.sectionHint}>上传技能 zip（内含 <code>SKILL.md</code>，可带 references/）→ 解压到 <code>{roots?.skillsDir ?? '…/knowledge/skills/<id>/'}</code>，惰性生效。技能引用规则：权威路径以 <code>GET /plugins/dsh-expert-library/skills</code> 为准，勿用相对路径猜测。</p>
        <div className={css.packToolbar}>
          <input ref={fileRef} className={css.input} type="file" accept=".zip" />
          <button className={css.buttonPrimary} type="button" disabled={busy !== ''} onClick={() => void installSkill()}>{busy === 'skill' ? '安装中…' : '安装技能'}</button>
        </div>
        {skills.length > 0 && (
          <table className={css.packTable}>
            <thead>
              <tr><th>id</th><th>名称</th><th>大小</th><th>references</th><th>路径</th></tr>
            </thead>
            <tbody>
              {skills.map((skill) => (
                <tr key={skill.id}>
                  <td><code className={css.packId}>{skill.id}</code></td>
                  <td>{skill.name ?? '—'}</td>
                  <td>{skill.sizeBytes !== undefined ? `${(skill.sizeBytes / 1024).toFixed(1)} KB` : '—'}</td>
                  <td>{skill.hasReferences === true ? '✓' : '—'}</td>
                  <td><code className={css.packId}>{skill.path ?? '—'}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* ── 领域包重建 ───────────────────────────────────────────────────── */}
        <h3 className={css.sectionTitle}>领域包重建</h3>
        <p className={css.sectionHint}>领域包是构建产物（<code>domain-packs/</code>），由 <code>build-packs.mjs</code> 确定性生成并带 <code>--check</code> 漂移校验。改源（raw-profile / 专家总表 / 场景定义）后在此一键重建；重建后请再跑「重新校验」确认零漂移。</p>
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
      </div>
    </section>
  )
}
