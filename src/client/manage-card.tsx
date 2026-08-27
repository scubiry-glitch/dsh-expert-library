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
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let value: unknown = null
  try {
    value = await res.json()
  } catch {
    value = null
  }
  if (isRecord(value) && typeof value['ok'] === 'boolean') {
    return value as unknown as ManageResponse
  }
  return { ok: false, error: `HTTP ${res.status}` }
}

/** 列表请求守卫。 */
async function listFetch<T>(path: string, key: string): Promise<T[]> {
  try {
    const res = await fetch(path, { cache: 'no-store' as RequestCache })
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
      const res = await fetch(`${MANAGE_BASE}/knowledge-roots`, { cache: 'no-store' as RequestCache })
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

  useEffect(() => {
    void refresh()
  }, [])

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
        body: form,
      })
      const value: unknown = await res.json()
      const result = isRecord(value) ? (value as unknown as ManageResponse) : { ok: false, error: `HTTP ${res.status}` }
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
      </div>
    </section>
  )
}
