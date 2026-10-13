import type { ReportOutline, PlanModelRoute } from '../plan-review.ts'
import type { TeamModelOption, TeamPlanWire } from './team-api.ts'
import css from './ActivityPanel.module.css'

export type PlanReviewDraft = { report_outline?: ReportOutline; plan_models: Record<string, PlanModelRoute> }
export function reviewDraft(plan: TeamPlanWire | null | undefined): PlanReviewDraft {
  return {
    ...(plan?.preview.reportOutline === undefined ? {} : { report_outline: structuredClone(plan.preview.reportOutline) }),
    plan_models: Object.fromEntries([
      ...(plan?.preview.captainModel === undefined ? [] : [['captain', { ...plan.preview.captainModel }]]),
      ...(plan?.preview.members ?? []).filter(m => m.route !== undefined).map(m => [m.expertId, { ...m.route! }]),
    ]),
  }
}
const lines = (text: string): string[] => text.split('\n')
export function PlanReviewEditor({ plan, value, onChange, disabled, modelCatalog, catalogError, onRecommend }: {
  plan: TeamPlanWire; value: PlanReviewDraft; onChange: (value: PlanReviewDraft) => void; disabled: boolean
  modelCatalog?: readonly TeamModelOption[]; catalogError?: string; onRecommend?: () => void
}) {
  const outline = value.report_outline
  const chapters = outline?.chapters ?? []
  const report = outline !== undefined || plan.preview.tasks.some(t => t.reportCraft !== undefined)
  const setChapters = (rows: ReportOutline['chapters']) => onChange({ ...value, report_outline: { chapters: rows, attachments: outline?.attachments ?? [] } })
  const update = (index: number, patch: Partial<ReportOutline['chapters'][number]>) => setChapters(chapters.map((c, i) => i === index ? { ...c, ...patch } : c))
  const move = (index: number, offset: number) => { const copy = [...chapters]; [copy[index], copy[index + offset]] = [copy[index + offset]!, copy[index]!]; setChapters(copy) }
  const roles = [{ id: 'captain', name: '队长（正式执行）', source: '当前会话' }, ...plan.preview.members.map(m => ({ id: m.expertId, name: m.role ?? m.expertId, source: m.routeSource === 'plan-edit' ? '本计划指定' : '继承已解析的模型设置' }))]
  const available = [...new Map([
    ...(plan.preview.captainModel === undefined ? [] : [plan.preview.captainModel]),
    ...plan.preview.members.flatMap(member => member.route === undefined ? [] : [member.route]),
    ...(modelCatalog ?? []).map(item => ({ provider: item.provider, model: item.model, reasoningEffort: item.reasoningEffort ?? 'default' })),
  ].map(route => [JSON.stringify(route), route])).values()]
  return <div className={css.planFields} data-plan-review-editor>
    {report && <section className={css.planTaskPreview} data-plan-outline>
      <h3 className={css.subsectionHeader}>报告章节大纲</h3>
      {!chapters.length && <p className={css.controlNotice}>添加章节、核心问题和所需证据后，才能确认执行。</p>}
      <ol className={css.outlineList}>
        {chapters.map((chapter, index) => <li key={chapter.id} className={css.outlineChapter}>
          <label>第 {index + 1} 章标题<input value={chapter.title} maxLength={200} disabled={disabled} onChange={e => update(index, { title: e.target.value })} /></label>
          <label>核心问题（每行一项）<textarea rows={2} value={chapter.questions.join('\n')} disabled={disabled} onChange={e => update(index, { questions: lines(e.target.value) })} /></label>
          <label>所需证据（每行一项）<textarea rows={2} value={chapter.evidence.join('\n')} disabled={disabled} onChange={e => update(index, { evidence: lines(e.target.value) })} /></label>
          <fieldset className={css.outlineTasks}><legend>负责本章的任务</legend>{plan.preview.tasks.map(task => <label key={task.id}><input type="checkbox" checked={chapter.taskIds.includes(task.id)} disabled={disabled} onChange={e => update(index, { taskIds: e.target.checked ? [...chapter.taskIds, task.id] : chapter.taskIds.filter(id => id !== task.id) })} />{task.subject ?? task.id}</label>)}</fieldset>
          <div className={css.planActions}>
            <button type="button" aria-label={`上移第 ${index + 1} 章`} disabled={disabled || index === 0} onClick={() => move(index, -1)}>上移</button>
            <button type="button" aria-label={`下移第 ${index + 1} 章`} disabled={disabled || index === chapters.length - 1} onClick={() => move(index, 1)}>下移</button>
            <button type="button" aria-label={`删除第 ${index + 1} 章`} disabled={disabled} onClick={() => setChapters(chapters.filter((_, i) => i !== index))}>删除章节</button>
          </div>
        </li>)}
      </ol>
      <div className={css.planActions}><button type="button" data-outline-add disabled={disabled || chapters.length >= 40} onClick={() => setChapters([...chapters, { id: `chapter-${crypto.randomUUID()}`, title: '', questions: [''], evidence: [''], taskIds: [] }])}>添加章节</button></div>
      <label>必要附件（每行一项）<textarea rows={2} value={outline?.attachments.join('\n') ?? ''} disabled={disabled} onChange={e => onChange({ ...value, report_outline: { chapters, attachments: e.target.value === '' ? [] : lines(e.target.value) } })} /></label>
    </section>}
    <section className={css.planTaskPreview} data-plan-model-editor>
      <h3 className={css.subsectionHeader}>本次执行模型</h3>
      <p className={css.controlNotice}>下拉列出 Host 当前可用的模型目录及本计划已冻结的路由。选择“采用规划提案”会恢复当前提案；保存时再次验证可用性。队长切换模型还需同步使用会话模型选择器。费用目录尚未接入，不展示无法核实的金额。</p>
      {catalogError && <p className={css.controlNotice}>模型目录暂不可用：{catalogError}。仍可使用本计划已冻结的模型。</p>}
      {roles.map(role => { const route = value.plan_models[role.id]; if (!route) return null
        const set = (next: PlanModelRoute) => onChange({ ...value, plan_models: { ...value.plan_models, [role.id]: { ...next } } })
        const proposed = role.id === 'captain' ? plan.preview.captainModel : plan.preview.members.find(member => member.expertId === role.id)?.route
        return <fieldset key={role.id} className={css.modelRoute} data-model-role={role.id}>
          <legend>{role.name}</legend><span className={css.controlNotice}>{role.source} · 保存后由服务端验证可用性</span>
          <label>执行模型
            <select value={JSON.stringify(route)} disabled={disabled} onChange={event => {
              if (event.target.value === '__ai__') { onRecommend?.(); return }
              const next = event.target.value === '__recommend__' ? proposed : available.find(item => JSON.stringify(item) === event.target.value)
              if (next !== undefined) set(next)
            }}>
              <option value="__recommend__">采用规划提案（当前冻结结果）</option>
              {onRecommend !== undefined && <option value="__ai__">由大模型重新推荐整套配置</option>}
              {available.map(item => <option key={JSON.stringify(item)} value={JSON.stringify(item)}>{item.provider}/{item.model} · {item.reasoningEffort ?? 'default'}{modelCatalog?.find(candidate => candidate.provider === item.provider && candidate.model === item.model)?.name ? ` · ${modelCatalog.find(candidate => candidate.provider === item.provider && candidate.model === item.model)!.name}` : ''}</option>)}
            </select>
          </label>
        </fieldset>
      })}
    </section>
  </div>
}
