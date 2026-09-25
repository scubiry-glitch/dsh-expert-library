/**
 * 专家库设置页（`settings.section` entry `expert-library-manage`），四个 Tab：
 * - 内容管理：自定义专家/场景覆盖层编辑器、技能 zip 安装；
 * - 模型设置：默认模型 + 专家模型路由覆盖（expertModelOverrides）；
 * - 运行设置：状态/知识目录、成员数量/委托深度、提示词顺序；
 * - 权限：/manage/* 授权令牌（本浏览器 localStorage）。
 *
 * 领域包相关（列表/重建/外部来源/包目录）统一由「领域包」设置页负责
 * （本地校验 Tab + 本地来源 Tab），此处不再重复入口。
 *
 * 写目标（host `src/host/manage.ts`）：
 * - 专家/场景 → `<workspace>/<knowledgeDir>/{experts,scenarios}/<id>.json`
 *   （V1 用户自定义覆盖层，惰性生效、零漂移）；
 * - 技能 → `<knowledgeDir>/skills/<id>/`（zip 上传，安全 id + zip-slip 防护）。
 *
 * 专家模型路由覆盖（从原 专家库 设置卡迁入）：`GET /experts` 列出每位专家的
 * 生效路由与继承来源，覆盖写入 `expertModelOverrides` 设置。
 *
 * 取数（只读）：
 * - `GET /plugins/dsh-expert-library/manage/experts|scenarios|knowledge-roots`
 * - `GET /plugins/dsh-expert-library/experts`（专家路由清单）
 * - `GET /plugins/dsh-expert-library/skills`（已装技能清单，id/name/path）
 * - `GET /plugins/dsh-expert-library/packs`（领域包清单）
 *
 * Wire types 本地镜像（client bundle 不得 import host 模块）。Fetch 约定同
 * FilesView/domain-packs-card：`cache: 'no-store'`、形状守卫、保留末次快照。
 * @module dsh-expert-library/client/manage-card
 */

import type { KeyboardEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import css from './settings-card.module.css'
import {
  MANAGE_BASE,
  describeAuthFailure,
  getManageToken,
  jsonFetch,
  listFetch,
  manageHeaders,
  setManageToken,
  type ManageResponse,
} from './manage-client.ts'
import {
  EXPERTS_URL,
  number,
  text,
  SOURCE_LABEL,
  isExpertRouteWire,
  normalizeOverride,
  routeText,
  type ExpertRouteWire,
  type ExpertLibrarySettingsScope,
  type RouteOverrideDraft,
} from './settings-shared.ts'

/** 写目标知识根（镜像 host ManageKnowledgeRoots）。 */
interface KnowledgeRootsWire {
  readonly ok: boolean
  readonly workspace?: string
  readonly knowledgeDir?: string
  readonly expertsDir?: string
  readonly scenariosDir?: string
  readonly skillsDir?: string
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

export interface ManageCardProps {
  /** 关闭设置面板（shell 持有开合状态）。 */
  close: () => void
  /** 共享 expert-library 设置 scope；注入后开放专家路由覆盖编辑。 */
  scope?: ExpertLibrarySettingsScope
}

const SKILLS_URL = '/plugins/dsh-expert-library/skills'

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

/** Tab 定义：内容管理 / 模型设置 / 运行设置 / 权限。 */
const TAB_ITEMS = [
  { id: 'content', label: '内容管理' },
  { id: 'model', label: '模型设置' },
  { id: 'runtime', label: '运行设置' },
  { id: 'auth', label: '权限' },
] as const

/** 主管理面板。 */
export function ManageCard({ scope }: ManageCardProps) {
  const fileRef = useRef<HTMLInputElement>(null)

  // ── 数据快照 ──────────────────────────────────────────────────────────────
  const [roots, setRoots] = useState<KnowledgeRootsWire | null>(null)
  const [experts, setExperts] = useState<readonly ManagedExpertWire[]>([])
  const [scenarios, setScenarios] = useState<readonly ManagedScenarioWire[]>([])
  const [skills, setSkills] = useState<readonly InstalledSkillWire[]>([])
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [tokenDraft, setTokenDraft] = useState(getManageToken())

  // ── 专家路由覆盖（自原 专家库 设置卡迁入）────────────────────────────────
  const [routeExperts, setRouteExperts] = useState<readonly ExpertRouteWire[] | null>(null)
  const [routeError, setRouteError] = useState('')
  const [routeFilter, setRouteFilter] = useState('')
  const [routeOverrides, setRouteOverrides] = useState<Record<string, RouteOverrideDraft>>(() => {
    const out: Record<string, RouteOverrideDraft> = {}
    const value = scope?.getSnapshot().value
    for (const [id, route] of Object.entries(value?.expertModelOverrides ?? {})) {
      out[id] = { ...route }
    }
    return out
  })
  const [routeMessage, setRouteMessage] = useState('')
  const [routeSaving, setRouteSaving] = useState(false)

  // ── 运行配置（自「专家库运行」分区迁入）──────────────────────────────────
  const [runtimeDraft, setRuntimeDraft] = useState(() => ({
    stateDir: text(scope?.getSnapshot().value?.stateDir),
    knowledgeDir: text(scope?.getSnapshot().value?.knowledgeDir),
    memberProvider: text(scope?.getSnapshot().value?.memberProvider),
    maxMembers: number(scope?.getSnapshot().value?.maxMembers),
    memberMaxDepth: number(scope?.getSnapshot().value?.memberMaxDepth),
    promptSectionOrder: number(scope?.getSnapshot().value?.promptSectionOrder),
    modelProvider: text(scope?.getSnapshot().value?.defaultModel?.provider),
    modelName: text(scope?.getSnapshot().value?.defaultModel?.model),
    reasoningEffort: text(scope?.getSnapshot().value?.defaultModel?.reasoningEffort),
    announceToAgent: scope?.getSnapshot().value?.announceToAgent ?? true,
  }))
  const [runtimeMessage, setRuntimeMessage] = useState('')
  const [runtimeSaving, setRuntimeSaving] = useState(false)

  // ── 编辑器状态 ────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'expert' | 'scenario'>('expert')
  const [draft, setDraft] = useState<EditorDraft>(EMPTY_DRAFT)
  const [editingId, setEditingId] = useState<string>('')
  const [tab, setTab] = useState<'content' | 'model' | 'runtime' | 'auth'>('content')

  function tabKeys(event: KeyboardEvent<HTMLButtonElement>): void {
    const index = TAB_ITEMS.findIndex((item) => item.id === tab)
    const next = event.key === 'ArrowRight' ? (index + 1) % TAB_ITEMS.length : event.key === 'ArrowLeft' ? (index + TAB_ITEMS.length - 1) % TAB_ITEMS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? TAB_ITEMS.length - 1 : null
    if (next === null) return
    event.preventDefault(); setTab(TAB_ITEMS[next]!.id)
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons?.[next]?.focus()
  }

  const refresh = async (): Promise<void> => {
    const [expertsValue, scenariosValue, skillsValue] = await Promise.all([
      listFetch<ManagedExpertWire>(`${MANAGE_BASE}/experts`, 'experts'),
      listFetch<ManagedScenarioWire>(`${MANAGE_BASE}/scenarios`, 'scenarios'),
      listFetch<InstalledSkillWire>(SKILLS_URL, 'skills'),
    ])
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
  }

  /** 已入库的外部来源包。授权失败时静默留空——授权区自己会说明原因。 */
  useEffect(() => {
    void refresh()
  }, [])

  /** 专家路由清单：GET /experts（含预设/覆盖/生效路由）。 */
  const fetchRouteExperts = async (): Promise<void> => {
    setRouteError('')
    try {
      const response = await fetch(EXPERTS_URL, { cache: 'no-store' as RequestCache })
      if (!response.ok) throw new Error('non-ok response')
      const body: unknown = await response.json()
      if (!isExpertRouteWire(body) || !Array.isArray(body.experts)) throw new Error('malformed body')
      setRouteExperts(body.experts as readonly ExpertRouteWire[])
    } catch {
      setRouteError('专家路由列表请求失败')
    }
  }

  useEffect(() => { void fetchRouteExperts() }, [])

  // 设置 scope 值就绪后同步覆盖草稿（首次快照可能晚于挂载）。
  useEffect(() => {
    if (scope === undefined) return
    if (scope.getSnapshot().status !== 'ready') return
    const value = scope.getSnapshot().value
    if (value === undefined) return
    setRouteOverrides((current) => {
      const merged: Record<string, RouteOverrideDraft> = { ...current }
      for (const [id, route] of Object.entries(value.expertModelOverrides ?? {})) {
        merged[id] = { ...route }
      }
      return merged
    })
    setRuntimeDraft({
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
    })
  }, [scope, scope?.getSnapshot().status, scope?.getSnapshot().value])

  const filteredRouteExperts = useMemo(() => {
    if (routeExperts === null) return null
    const query = routeFilter.trim().toLowerCase()
    if (query === '') return routeExperts
    return routeExperts.filter(expert =>
      expert.id.toLowerCase().includes(query)
      || expert.name.toLowerCase().includes(query)
      || (expert.field ?? '').toLowerCase().includes(query)
      || (expert.stance ?? '').toLowerCase().includes(query))
  }, [routeExperts, routeFilter])

  /** 设置一位专家的路由覆盖（空串 = 清除该字段；全空 = 移除覆盖）。 */
  const setRouteOverride = (
    id: string,
    field: keyof RouteOverrideDraft,
    next: string,
  ): void => {
    setRouteOverrides(current => {
      const updated = { ...(current[id] ?? {}), [field]: next }
      if (normalizeOverride(updated) === undefined) {
        const { [id]: _removed, ...rest } = current
        return rest
      }
      return { ...current, [id]: updated }
    })
    setRouteMessage('')
  }

  const setRuntime = (field: keyof typeof runtimeDraft, next: string | boolean): void => {
    setRuntimeDraft(current => ({ ...current, [field]: next }))
    setRuntimeMessage('')
  }

  const saveRuntime = async (): Promise<void> => {
    if (scope === undefined || runtimeSaving) return
    setRuntimeSaving(true)
    setRuntimeMessage('')
    try {
      const writes: Array<[string, unknown]> = [
        ['stateDir', runtimeDraft.stateDir],
        ['knowledgeDir', runtimeDraft.knowledgeDir],
        ['memberProvider', runtimeDraft.memberProvider],
        ['maxMembers', Number(runtimeDraft.maxMembers)],
        ['memberMaxDepth', runtimeDraft.memberMaxDepth.trim() === '' ? '' : Number(runtimeDraft.memberMaxDepth)],
        ['promptSectionOrder', Number(runtimeDraft.promptSectionOrder)],
        ['announceToAgent', runtimeDraft.announceToAgent],
      ]
      for (const [field, next] of writes) {
        if (typeof next === 'string' && next.trim() === '') await scope.unset(field)
        else await scope.set(field, next)
      }
      setRuntimeMessage('已保存')
    } catch (error) {
      setRuntimeMessage(error instanceof Error ? error.message : '保存失败')
    } finally {
      setRuntimeSaving(false)
    }
  }

  /** 默认模型（模型设置 Tab）。 */
  const saveModel = async (): Promise<void> => {
    if (scope === undefined || runtimeSaving) return
    setRuntimeSaving(true)
    setRuntimeMessage('')
    try {
      await scope.set('defaultModel', { provider: runtimeDraft.modelProvider, model: runtimeDraft.modelName, reasoningEffort: runtimeDraft.reasoningEffort })
      setRuntimeMessage('已保存')
    } catch (error) {
      setRuntimeMessage(error instanceof Error ? error.message : '保存失败')
    } finally {
      setRuntimeSaving(false)
    }
  }

  const saveRoutes = async (): Promise<void> => {
    if (scope === undefined || routeSaving) return
    setRouteSaving(true)
    setRouteMessage('')
    try {
      const out: Record<string, unknown> = {}
      for (const [id, route] of Object.entries(routeOverrides)) {
        const normalized = normalizeOverride(route)
        if (normalized !== undefined) out[id] = normalized
      }
      if (Object.keys(out).length > 0) await scope.set('expertModelOverrides', out)
      else await scope.unset('expertModelOverrides')
      setRouteMessage('已保存')
    } catch (error) {
      setRouteMessage(error instanceof Error ? error.message : '保存失败')
    } finally {
      setRouteSaving(false)
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

  return (
    <section className={css.card}>
      <header className={css.head}>
        <h2 className={css.title}>专家库管理</h2>
        <span className={css.subtitle}>自定义专家与场景、技能、模型路由与运行参数；领域包及其来源请到「领域包」设置页。写目标：{roots?.workspace ?? '工作区'}/{roots?.knowledgeDir ?? 'knowledge'}/。</span>
      </header>

      <div className={css.body}>
        {(message !== '' || error !== '') && (
          <p className={error !== '' ? css.statusError : css.probeResult} role="status">
            {error !== '' ? error : message}
            {error !== '' && <button className={css.button} type="button" onClick={() => setError('')}>关闭</button>}
          </p>
        )}

        <nav className={css.tabs} role="tablist" aria-label="专家库管理">
          {TAB_ITEMS.map((item, index) => (
            <button
              className={css.tab}
              key={item.id}
              id={`elc-manage-tab-${index}`}
              role="tab"
              type="button"
              aria-selected={tab === item.id}
              aria-controls={`elc-manage-panel-${index}`}
              tabIndex={tab === item.id ? 0 : -1}
              onKeyDown={tabKeys}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {tab === 'auth' && (
        <>
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
              setMessage(getManageToken() === '' ? '已清除令牌：/manage/* 现在仅本机可用。' : '令牌已保存到本浏览器，正在重试请求…')
              void refresh()
            }}
          >
            保存令牌
          </button>
        </div>
        </>
        )}

        {tab === 'content' && (
        <>

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

        </>
        )}

        {tab === 'model' && (
        <>
        <h3 className={css.sectionTitle}>默认模型</h3>
        <p className={css.sectionHint}>未单独覆盖路由的成员/专家使用的全局默认模型。</p>
        <label className={css.field}><span className={css.fieldLabel}>默认模型 Provider</span><input className={css.input} value={runtimeDraft.modelProvider} onChange={event => setRuntime('modelProvider', event.target.value)} /></label>
        <label className={css.field}><span className={css.fieldLabel}>默认模型</span><input className={css.input} value={runtimeDraft.modelName} onChange={event => setRuntime('modelName', event.target.value)} /></label>
        <label className={css.field}><span className={css.fieldLabel}>默认推理强度</span><input className={css.input} value={runtimeDraft.reasoningEffort} onChange={event => setRuntime('reasoningEffort', event.target.value)} /></label>
        {scope !== undefined && (
          <div className={css.packToolbar}>
            {runtimeMessage !== '' && <span className={css.message} role="status">{runtimeMessage}</span>}
            <button className={`${css.button} ${css.buttonPrimary}`} type="button" disabled={runtimeSaving} onClick={() => void saveModel()}>{runtimeSaving ? '保存中…' : '保存默认模型'}</button>
          </div>
        )}

        <h3 className={css.sectionTitle}>专家模型路由</h3>
        <p className={css.sectionHint}>每位专家的生效模型路由与继承来源：设置覆盖 &gt; 专家预设 &gt; 全局默认。输入 provider/model（可带推理强度）即可为该专家覆盖路由，保存后立即生效。</p>
        {scope === undefined && <p className={css.hint}>当前环境未开放设置写入，以下为只读展示。</p>}
        <div className={css.packToolbar}>
          <input
            className={css.input}
            placeholder="按 id / 姓名 / 领域 / 立场过滤…"
            value={routeFilter}
            onChange={event => setRouteFilter(event.target.value)}
          />
          <button className={css.button} type="button" onClick={() => void fetchRouteExperts()}>刷新</button>
          {scope !== undefined && (
            <button className={`${css.button} ${css.buttonPrimary}`} type="button" disabled={routeSaving} onClick={() => void saveRoutes()}>{routeSaving ? '保存中…' : '保存路由覆盖'}</button>
          )}
          {routeMessage !== '' && <span className={css.message} role="status">{routeMessage}</span>}
        </div>
        {routeError !== '' && <p className={css.statusError} role="status">{routeError} <button className={css.button} type="button" onClick={() => void fetchRouteExperts()}>重试</button></p>}
        {filteredRouteExperts === null && <p className={css.packsNote}>正在读取专家列表…</p>}
        {filteredRouteExperts !== null && filteredRouteExperts.length === 0 && <p className={css.packsNote}>无匹配专家</p>}
        {filteredRouteExperts !== null && filteredRouteExperts.length > 0 && (
          <div className={css.expertTableWrap}>
            <table className={css.packTable}>
              <thead>
                <tr><th>专家</th><th>领域/立场</th><th>预设路由</th><th>当前生效</th><th>来源</th><th>覆盖路由（provider / model / effort）</th></tr>
              </thead>
              <tbody>
                {filteredRouteExperts.map(expert => {
                  const override = routeOverrides[expert.id]
                  return (
                    <tr key={expert.id}>
                      <td><span className={css.packName}>{expert.name}</span><code className={css.packId}>{expert.id}{expert.deceased === true ? '（已故）' : ''}</code></td>
                      <td>{[expert.field, expert.stance].filter(part => part !== undefined && part !== '').join(' · ') || (expert.role ?? '—')}</td>
                      <td className={css.mono}>{routeText(expert.preset)}</td>
                      <td className={css.mono} data-severity={expert.source === 'override' ? 'pass' : 'idle'}>{routeText(expert.effective)}</td>
                      <td>{SOURCE_LABEL[expert.source] ?? expert.source}</td>
                      <td>
                        {scope === undefined
                          ? <span className={css.packId}>—</span>
                          : (
                            <span className={css.routeEditor}>
                              <input className={css.miniInput} placeholder="provider" value={override?.provider ?? ''} onChange={event => setRouteOverride(expert.id, 'provider', event.target.value)} />
                              <input className={css.miniInput} placeholder="model" value={override?.model ?? ''} onChange={event => setRouteOverride(expert.id, 'model', event.target.value)} />
                              <input className={css.miniInput} placeholder="effort" value={override?.reasoningEffort ?? ''} onChange={event => setRouteOverride(expert.id, 'reasoningEffort', event.target.value)} />
                            </span>
                          )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        </>
        )}

        {tab === 'runtime' && (
        <>
        <h3 className={css.sectionTitle}>运行配置</h3>
        <p className={css.sectionHint}>成员运行时、默认模型、提示词策略与领域包目录。留空表示继承默认配置。</p>
        {scope === undefined && <p className={css.hint}>当前环境未开放设置写入，运行配置不可编辑。</p>}
        <label className={css.field}><span className={css.fieldLabel}>状态目录</span><input className={css.input} value={runtimeDraft.stateDir} onChange={event => setRuntime('stateDir', event.target.value)} /></label>
        <label className={css.field}><span className={css.fieldLabel}>知识目录</span><input className={css.input} value={runtimeDraft.knowledgeDir} onChange={event => setRuntime('knowledgeDir', event.target.value)} /></label>
        <label className={css.field}><span className={css.fieldLabel}>成员 Provider</span><input className={css.input} value={runtimeDraft.memberProvider} onChange={event => setRuntime('memberProvider', event.target.value)} /></label>
        <label className={css.field}><span className={css.fieldLabel}>最大成员数</span><input className={css.input} type="number" min="1" value={runtimeDraft.maxMembers} onChange={event => setRuntime('maxMembers', event.target.value)} /></label>
        <label className={css.field}><span className={css.fieldLabel}>成员委托深度</span><input className={css.input} type="number" min="0" value={runtimeDraft.memberMaxDepth} onChange={event => setRuntime('memberMaxDepth', event.target.value)} /></label>
        <label className={css.field}><span className={css.fieldLabel}>提示词顺序</span><input className={css.input} type="number" min="0" value={runtimeDraft.promptSectionOrder} onChange={event => setRuntime('promptSectionOrder', event.target.value)} /></label>
        <label className={css.checkRow}><input className={css.checkbox} type="checkbox" checked={runtimeDraft.announceToAgent} onChange={event => setRuntime('announceToAgent', event.target.checked)} /> 向 Agent 注入专家库使用协议</label>
        {scope !== undefined && (
          <div className={css.packToolbar}>
            {runtimeMessage !== '' && <span className={css.message} role="status">{runtimeMessage}</span>}
            <button className={`${css.button} ${css.buttonPrimary}`} type="button" disabled={runtimeSaving} onClick={() => void saveRuntime()}>{runtimeSaving ? '保存中…' : '保存运行配置'}</button>
          </div>
        )}
        </>
        )}
      </div>
    </section>
  )
}
