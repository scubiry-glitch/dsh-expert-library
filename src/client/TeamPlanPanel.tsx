import { PlanReviewEditor, reviewDraft, type PlanReviewDraft } from './PlanReviewEditor.tsx'
import { ResearchDagGraph } from './ResearchDagGraph.tsx'
import { reviewPublicUrl } from '../review-link.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityTeam } from './ActivityPanel.tsx'
import { fetchTeamModelCatalog, planMemberPreview, planRequest, planTaskPreview, type TeamModelOption, type TeamPlanMember, type TeamPlanWire, type TeamWire, type TeamWireMutation, type TeamWireMutationResponse, type TeamWireQualityRun } from './team-api.ts'
import css from './ActivityPanel.module.css'

export interface TeamPlanPanelProps {
  readonly captainSessionId?: string
  readonly team?: ActivityTeam
  readonly wire?: TeamWire
  readonly plan?: TeamPlanWire | null
  readonly archived?: boolean
  readonly stale?: boolean
  readonly loading?: boolean
  readonly error?: string
  readonly canMutate?: boolean
  readonly onOpenReview?: () => void
  readonly onCopyReview?: () => void
  readonly onMutate: (request: Omit<TeamWireMutation, 'captainSessionId' | 'teamId'>) => Promise<TeamWireMutationResponse | void>
}

function text(value: string | undefined): string { return value ?? '' }
function researchSelection(plan: TeamPlanWire | null | undefined): { subDagId: string; expertIds: string[] } | undefined {
  const selected = plan?.preview.expertSelection?.selectedIds
  const graph = plan?.preview.subDags?.find(item => item.selected)
  return selected === undefined || graph === undefined ? undefined : { subDagId: graph.id, expertIds: [...selected] }
}
function materialSelection(plan: TeamPlanWire | null | undefined): Record<string, 'core' | 'strategy'> {
  return Object.fromEntries((plan?.preview.tasks ?? []).filter(task => task.materialRecipe !== undefined)
    .map(task => [task.id, task.materialRecipe!.selected]))
}
function terminal(status: string): boolean { return status === 'completed' || status === 'failed' || status === 'cancelled' }
function planStatusLabel(status: string): string {
  if (/pending|review|stage/iu.test(status)) return '等待用户确认'
  if (status === 'completed') return '计划已应用'
  if (status === 'running') return '正在组建团队'
  if (status === 'expired') return '已过期'
  if (/approved|approve/iu.test(status)) return '已批准'
  if (/appl/iu.test(status)) return '已应用'
  if (/discard|cancel/iu.test(status)) return '已放弃'
  if (/fail|error/iu.test(status)) return '失败'
  return status
}

function routeSourceLabel(source?: string): string {
  const labels: Record<string, string> = { 'profile-member': '成员指定', 'profile-default': '计划默认', 'expert-override': '专家模型设置', 'expert-preset': '专家预设', 'plugin-default': '插件默认', captain: '队长模型', 'plan-edit': '本计划指定' }
  return source === undefined ? '历史计划未记录来源' : labels[source] ?? source
}

function runTone(run: TeamWireQualityRun): string {
  const verdict = (run.lastVerdict ?? run.status).toLowerCase()
  if (verdict.includes('fail') || verdict.includes('reject') || verdict.includes('block')) return 'failed'
  if (verdict.includes('pass') || verdict.includes('integrat') || verdict.includes('complete')) return 'completed'
  return 'running'
}

/** Plan/control surface deliberately lives inside the existing activity panel.
 * It is a review gate: edits and approval are always sent with the exact
 * digest/revision observed in this render; no optimistic approval is shown. */
export function TeamPlanPanel({ captainSessionId, team, wire, plan, archived = false, stale = false, loading = false, error, canMutate = true, onOpenReview, onCopyReview, onMutate }: TeamPlanPanelProps) {
  const [open, setOpen] = useState(plan?.status === 'staged')
  const [review, setReview] = useState<PlanReviewDraft>(() => reviewDraft(plan))
  const [selection, setSelection] = useState(() => researchSelection(plan))
  const [materials, setMaterials] = useState(() => materialSelection(plan))
  const savedSelectionRef = useRef(JSON.stringify(researchSelection(plan)))
  const savedMaterialsRef = useRef(JSON.stringify(materialSelection(plan)))
  const savedReviewRef = useRef(JSON.stringify(reviewDraft(plan)))
  const [goal, setGoal] = useState('')
  const [teamName, setTeamName] = useState('')
  const [data, setData] = useState('')
  const [city, setCity] = useState('')
  const [period, setPeriod] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | undefined>()
  const [modelCatalog, setModelCatalog] = useState<readonly TeamModelOption[]>()
  const [catalogError, setCatalogError] = useState<string>()
  const [blockedAfterError, setBlockedAfterError] = useState(false)
  const [observedPlan, setObservedPlan] = useState<TeamPlanWire | null | undefined>(plan)
  const savedPatchRef = useRef<string>('')
  const incomingRequest = planRequest(plan)
  const readyChoices = wire?.tasks.filter(task => task.status === 'pending' && task.humanChoice?.sha256 !== undefined) ?? []
  const reviewLink = (gate: 'plan' | 'outline' | 'body', taskId?: string): string | undefined => reviewPublicUrl(
    typeof window === 'undefined' ? undefined : window.location.origin,
    { captainSessionId: captainSessionId ?? team?.captainSessionId ?? '', planId: plan?.planId, teamId: team?.teamId, gate, taskId },
  )

  useEffect(() => { if (readyChoices.length > 0) setOpen(true) }, [readyChoices.length])

  useEffect(() => {
    if (captainSessionId === undefined || plan?.planId === undefined || plan.status !== 'staged' || !canMutate) return
    const controller = new AbortController()
    setModelCatalog(undefined)
    setCatalogError(undefined)
    fetchTeamModelCatalog(captainSessionId, plan.planId, controller.signal)
      .then(setModelCatalog)
      .catch(cause => { if (!controller.signal.aborted) setCatalogError(cause instanceof Error ? cause.message : '目录读取失败') })
    return () => controller.abort()
  }, [captainSessionId, plan?.planId, plan?.status, canMutate])

  useEffect(() => {
    setObservedPlan(plan)
    setReview(reviewDraft(plan))
    setSelection(researchSelection(plan))
    setMaterials(materialSelection(plan))
    savedSelectionRef.current = JSON.stringify(researchSelection(plan))
    savedMaterialsRef.current = JSON.stringify(materialSelection(plan))
    savedReviewRef.current = JSON.stringify(reviewDraft(plan))
    if (plan?.status === 'staged') setOpen(true)
    setGoal(text(incomingRequest.goal) || text(plan?.runtime?.description))
    setTeamName(text(incomingRequest.team_name) || text(plan?.runtime?.teamName))
    setData(text(incomingRequest.data))
    setCity(text(incomingRequest.city))
    setPeriod(text(incomingRequest.period))
    savedPatchRef.current = JSON.stringify({
      team_name: text(incomingRequest.team_name) || text(plan?.runtime?.teamName),
      goal: text(incomingRequest.goal) || text(plan?.runtime?.description),
      data: text(incomingRequest.data),
      city: text(incomingRequest.city),
      period: text(incomingRequest.period),
    })
    setLocalError(undefined)
    setBlockedAfterError(false)
  }, [plan?.planId, plan?.revision, plan?.digest, plan?.runtime?.teamName, plan?.runtime?.description, incomingRequest.goal, incomingRequest.team_name, incomingRequest.data, incomingRequest.city, incomingRequest.period])

  const activePlan = observedPlan === undefined ? plan : observedPlan
  const planIdentity = activePlan === null || activePlan === undefined ? undefined : { planId: activePlan.planId, expectedDigest: activePlan.digest, expectedRevision: activePlan.revision }
  const terminalPlan = activePlan !== null && activePlan !== undefined && ['completed', 'failed', 'discarded', 'expired'].includes(activePlan.status)
  const editablePlan = activePlan?.status === 'staged'
  const presetInputsFrozen = activePlan?.request.compiled_source !== undefined
  const approvablePlan = activePlan?.status === 'staged'
  const discardablePlan = activePlan?.status === 'staged' || activePlan?.status === 'approved'
  const canWrite = canMutate && !archived && !stale && !blockedAfterError && !loading && (wire !== undefined || !terminalPlan) && (wire !== undefined || activePlan !== undefined && activePlan !== null)
  const patch = useMemo(() => ({
    team_name: teamName,
    goal,
    data,
    city,
    period,
  }), [teamName, goal, data, city, period])
  const reviewDirty = JSON.stringify(review) !== savedReviewRef.current
  const selectionDirty = JSON.stringify(selection) !== savedSelectionRef.current
  const materialDirty = JSON.stringify(materials) !== savedMaterialsRef.current
  const reviewPatch: Record<string, unknown> = {}
  const savedReview = JSON.parse(savedReviewRef.current) as PlanReviewDraft
  if (JSON.stringify(review.report_outline) !== JSON.stringify(savedReview.report_outline)) reviewPatch.report_outline = review.report_outline
  const changedModels = Object.fromEntries(Object.entries(review.plan_models).filter(([id, route]) => JSON.stringify(route) !== JSON.stringify(savedReview.plan_models[id])))
  if (Object.keys(changedModels).length) reviewPatch.plan_models = { ...review.plan_models }
  const currentPatchKey = JSON.stringify(patch)
  const dirty = editablePlan && activePlan !== undefined && activePlan !== null && (currentPatchKey !== savedPatchRef.current || reviewDirty || selectionDirty || materialDirty)
  const run = async (request: Omit<TeamWireMutation, 'captainSessionId' | 'teamId'>): Promise<TeamWireMutationResponse | void> => {
    if (!canWrite) return undefined
    setBusy(true)
    setLocalError(undefined)
    try {
      const result = await onMutate(request)
      if (result?.plan !== undefined && result.plan !== null) setObservedPlan(result.plan)
      setBlockedAfterError(false)
      return result
    } catch (caught) { setLocalError(caught instanceof Error ? caught.message : '操作失败'); setBlockedAfterError(true); return undefined } finally { setBusy(false) }
  }
  const edit = async (): Promise<TeamWireMutationResponse | void> => {
    if (planIdentity === undefined) return
    // A graph change rewrites member ids and task edges on the Host. Re-read
    // its new preview before editing model routes or approving the plan.
    const result = await run({ action: 'edit', ...planIdentity, patch: selectionDirty && selection !== undefined
      ? { research_selection: selection }
      : materialDirty ? { research_material_selection: Object.entries(materials).map(([taskId, recipeId]) => ({ taskId, recipeId })) }
      : { ...(presetInputsFrozen ? {} : patch), ...reviewPatch } })
    if (result?.plan !== undefined && result.plan !== null) {
      if (!selectionDirty && !materialDirty) savedPatchRef.current = currentPatchKey
      const normalized = reviewDraft(result.plan)
      savedReviewRef.current = JSON.stringify(normalized)
      setReview(normalized)
      setSelection(researchSelection(result.plan))
      savedSelectionRef.current = JSON.stringify(researchSelection(result.plan))
      setMaterials(materialSelection(result.plan))
      savedMaterialsRef.current = JSON.stringify(materialSelection(result.plan))
    }
    return result
  }
  const recommend = async (): Promise<void> => {
    if (planIdentity === undefined || dirty || !editablePlan || presetInputsFrozen) {
      setLocalError('请先保存当前修改，再让大模型重新推荐。')
      return
    }
    const result = await run({ action: 'recommend', ...planIdentity })
    if (result?.plan === undefined || result.plan === null) return
    const next = result.plan
    const normalized = reviewDraft(next)
    setReview(normalized)
    savedReviewRef.current = JSON.stringify(normalized)
    setSelection(researchSelection(next))
    savedSelectionRef.current = JSON.stringify(researchSelection(next))
    setMaterials(materialSelection(next))
    savedMaterialsRef.current = JSON.stringify(materialSelection(next))
    savedPatchRef.current = currentPatchKey
  }
  const approve = async (): Promise<void> => {
    if (planIdentity === undefined || stale || !approvablePlan) return
    // A dirty editor must be committed first. Approving with the old
    // digest/revision would either reject by CAS or approve an older goal.
    if (dirty) {
      const saved = await edit()
      if (saved?.plan === undefined || saved.plan === null) return
      if (selectionDirty || materialDirty) return
      await run({ action: 'approve', planId: saved.plan.planId, expectedDigest: saved.plan.digest, expectedRevision: saved.plan.revision })
      return
    }
    await run({ action: 'approve', ...planIdentity })
  }
  const discard = async (): Promise<void> => {
    if (planIdentity === undefined || !discardablePlan) return
    await run({ action: 'discard', ...planIdentity })
  }
  const halt = async (): Promise<void> => { await run({ action: 'halt', reason: reason.trim() || '队长暂停团队' }) }
  const resume = async (): Promise<void> => { await run({ action: 'resume', reason: reason.trim() || '队长恢复团队' }) }
  const archive = async (): Promise<void> => { await run({ action: 'archive', reason: reason.trim() || '队长归档团队' }) }
  const choose = async (taskId: string, choice: string, expectedSha256: string): Promise<void> => {
    await run({ action: 'choose', taskId, choice, expectedSha256 })
  }
  const hasPlan = activePlan !== undefined && activePlan !== null
  const stagedTasks = planTaskPreview(activePlan)
  const stagedMembers = planMemberPreview(activePlan)
  const taskRows = wire?.tasks ?? team?.tasks ?? []
  const taskCount = taskRows.length
  const finished = taskRows.filter((task) => terminal(task.status)).length
  const qualityRuns = wire?.qualityRuns ?? []
  return (
    <section className={css.teamControls} data-team-controls data-team-id={team?.teamId ?? plan?.planId}>
      <div className={css.controlsHead}>
        <button type="button" className={css.controlsToggle} onClick={() => { setOpen((value) => !value) }} aria-expanded={open} data-team-controls-toggle>
          <span>{hasPlan ? '研究计划与执行' : '团队控制'}</span>
        <span className={css.controlsMeta}>{loading ? '同步中…' : stale ? '快照已过期' : terminalPlan ? planStatusLabel(activePlan?.status ?? '') : wire?.halted ? '已暂停' : archived ? '已归档' : `${finished}/${taskCount} 终态`}</span>
        </button>
        {onOpenReview !== undefined && <button type="button" className={css.reviewWindowButton} onClick={onOpenReview} title="用临时令牌在独立页面审阅" data-open-review>独立页</button>}
        {onCopyReview !== undefined && <button type="button" className={css.reviewWindowButton} onClick={onCopyReview} title="复制 24 小时内有效、最多可在 10 个浏览器中兑换的分享链接" data-copy-review>复制访问链接</button>}
        {wire?.halted && <span className={css.controlState} data-state="blocked">暂停</span>}
        {archived && <span className={css.controlState} data-state="archived">归档</span>}
      </div>
      {activePlan?.status === 'staged' && onOpenReview !== undefined && (
        <div className={css.planReviewEntry} data-plan-review-entry>
          <div><strong>研究计划待你确认</strong><p>在独立页面选择研究路线、专家和模型，编辑后确认启动。</p></div>
          <button type="button" className={css.reviewWindowButton} onClick={onOpenReview} data-open-plan-review>打开独立页编辑并确认 ↗</button>
        </div>
      )}
      {open && (
        <div className={css.controlsBody} data-team-controls-body>
          {error !== undefined && <div className={css.controlError} data-state="error" role="alert">{error}</div>}
          {localError !== undefined && <div className={css.controlError} data-state="error" role="alert">{localError}</div>}
          {(stale || blockedAfterError) && <div className={css.controlNotice} data-state="stale">数据已更新，请刷新后再批准或修改。</div>}
          {readyChoices.map(task => <section key={task.id} className={css.planEditor} data-human-choice={task.id}>
            <header className={css.planHeader}><span className={css.planTitle}>{task.subject} · 等待你选择</span></header>
            {reviewLink('outline', task.id) && <p className={css.reviewLink}><a href={reviewLink('outline', task.id)} target="_blank" rel="noopener noreferrer">在独立页面打开并确认 ↗</a><small>{reviewLink('outline', task.id)}</small></p>}
            <p>待确认全文来自已完成并通过评审的任务 {task.humanChoice!.sourceTaskId}，版本 SHA256：<code style={{ overflowWrap: 'anywhere' }}>{task.humanChoice!.sha256}</code></p>
            <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 480, overflow: 'auto' }}>{task.humanChoice!.content}</pre>
            <div className={css.planActions}>{task.humanChoice!.options.map(option => <button key={option} type="button" data-human-choice-option={option} onClick={() => { void choose(task.id, option, task.humanChoice!.sha256!) }} disabled={!canWrite || busy || stale}>{option}</button>)}</div>
          </section>)}
          {wire?.tasks.filter(task => task.status === 'pending' && task.humanChoice !== undefined && task.humanChoice.sha256 === undefined).map(task => <div key={task.id} className={css.controlNotice} data-human-choice-wait={task.id}>用户确认门等待上游全文通过评审：{task.humanChoice!.blockedReason ?? '等待上游任务'}</div>)}
          {wire?.tasks.filter(task => task.humanChoice?.receipt !== undefined).map(task => <div key={task.id} className={css.controlNotice} data-human-choice-receipt={task.id}>已选择 {task.humanChoice!.receipt!.choice} · 候选稿 SHA256 {task.humanChoice!.receipt!.sourceSha256}</div>)}
          {hasPlan && (
            <section className={css.planEditor} data-plan-editor data-plan-status={activePlan?.status} data-dirty={dirty}>
              <header className={css.planHeader}>
                <span className={css.planTitle}>{terminalPlan ? '执行计划' : '待审计划'}</span>
                <span className={css.planIdentity} title={activePlan?.digest}>r{activePlan?.revision} · {planStatusLabel(activePlan?.status ?? '')}</span>
              </header>
              <p className={css.controlNotice}>当前计划 SHA256：<code style={{ overflowWrap: 'anywhere' }}>{activePlan?.digest}</code></p>
              {onOpenReview !== undefined ? <p className={css.reviewLink}><button type="button" className={css.reviewWindowButton} onClick={onOpenReview}>在独立页面编辑并确认计划 ↗</button></p> : reviewLink('plan') && <p className={css.reviewLink}><a href={reviewLink('plan')} target="_blank" rel="noopener noreferrer">在独立页面审阅计划 ↗</a></p>}
              <div className={css.planFields}>
                <label>团队名称<input data-plan-field="team_name" value={teamName} onChange={(event) => { setTeamName(event.target.value) }} maxLength={120} disabled={!canWrite || !editablePlan || presetInputsFrozen || busy} /></label>
                <label>目标<textarea data-plan-field="goal" value={goal} onChange={(event) => { setGoal(event.target.value) }} maxLength={4000} disabled={!canWrite || !editablePlan || presetInputsFrozen || busy} rows={3} /></label>
                <div className={css.planFieldGrid}>
                  <label>数据范围<input data-plan-field="data" value={data} onChange={(event) => { setData(event.target.value) }} maxLength={500} disabled={!canWrite || !editablePlan || presetInputsFrozen || busy} /></label>
                  <label>城市<input data-plan-field="city" value={city} onChange={(event) => { setCity(event.target.value) }} maxLength={120} disabled={!canWrite || !editablePlan || presetInputsFrozen || busy} /></label>
                  <label>期间<input data-plan-field="period" value={period} onChange={(event) => { setPeriod(event.target.value) }} maxLength={120} disabled={!canWrite || !editablePlan || presetInputsFrozen || busy} /></label>
                </div>
              </div>
              {activePlan != null && <PlanReviewEditor plan={activePlan} value={review} onChange={setReview} disabled={!canWrite || !editablePlan || busy || selectionDirty || dirty} modelCatalog={modelCatalog} catalogError={catalogError} onRecommend={() => { void recommend() }} />}
              {selection !== undefined && activePlan?.preview.expertSelection !== undefined && activePlan.preview.subDags !== undefined && <section className={css.planTaskPreview} data-plan-subdag-selector>
                <header className={css.subsectionHeader}>选择子 DAG 与并行专家</header>
                <label>配置方式
                  <select value="manual" data-plan-recommend-select disabled={!canWrite || !editablePlan || presetInputsFrozen || busy || dirty} onChange={event => { if (event.target.value === 'ai') void recommend() }}>
                    <option value="manual">手动选择子图、专家、Skill 和模型</option>
                    <option value="ai">由大模型重新推荐整套配置</option>
                  </select>
                </label>
                <label>子 DAG
                  <select value={selection.subDagId} disabled={!canWrite || !editablePlan || presetInputsFrozen || busy || reviewDirty} onChange={event => {
                    if (event.target.value === '__ai__') { void recommend(); return }
                    const graph = activePlan.preview.subDags!.find(item => item.id === event.target.value)
                    if (graph === undefined) return
                    const candidates = activePlan.preview.expertSelection!.candidates.map(item => item.id)
                    const ids = [...selection.expertIds, ...candidates.filter(id => !selection.expertIds.includes(id))].slice(0, graph.expertCount)
                    setSelection({ subDagId: graph.id, expertIds: ids })
                  }}>
                    <option value="__ai__">由大模型推荐子 DAG 和专家</option>
                    {activePlan.preview.subDags.map(item => <option key={item.id} value={item.id} disabled={item.expertCount > activePlan.preview.expertSelection!.candidates.length}>{item.id}@{item.version} · {item.expertCount} 位并行专家</option>)}
                  </select>
                </label>
                <div className={css.planFieldGrid}>{selection.expertIds.map((id, index) => <label key={index}>第 {index + 1} 位专家
                  <select value={id} disabled={!canWrite || !editablePlan || presetInputsFrozen || busy || reviewDirty} onChange={event => {
                    if (event.target.value === '__ai__') { void recommend(); return }
                    const next = [...selection.expertIds]; next[index] = event.target.value
                    if (new Set(next).size === next.length) setSelection({ ...selection, expertIds: next })
                  }}>
                    <option value="__ai__">由大模型推荐整套专家</option>
                    {activePlan.preview.expertSelection!.candidates.map(candidate => <option key={candidate.id} value={candidate.id} disabled={selection.expertIds.some((other, slot) => slot !== index && other === candidate.id)}>{candidate.id} · {candidate.name} · {candidate.field}</option>)}
                  </select>
                </label>)}</div>
                <p className={css.controlNotice}>选择后先保存并查看 Host 重编译的依赖、材料和模型，再确认执行。当前提案由规划模型给出；保留当前选择即采用该推荐。</p>
                {selectionDirty && <button type="button" data-plan-action="save-subdag" disabled={!canWrite || busy} onClick={() => { void edit() }}>保存子 DAG 与专家</button>}
              </section>}
              {activePlan?.preview.expertSelection !== undefined && <section className={css.planTaskPreview} data-plan-expert-selection>
                <header className={css.subsectionHeader}>选专家与分析框架 <span>{activePlan.preview.expertSelection.candidates.filter(candidate => candidate.selected).length} 位已选</span></header>
                <p>{activePlan.preview.expertSelection.topic} · 路由 {activePlan.preview.expertSelection.routeFramework} · {activePlan.preview.expertSelection.question}</p>
                <ul className={css.taskReviewList}>{activePlan.preview.expertSelection.candidates.map(candidate => <li key={candidate.id} className={css.taskReviewRow}>
                  <strong>{candidate.selected ? '已选' : '候选'} · {candidate.id} · {candidate.name}</strong>
                  <span>{candidate.field} · {candidate.stance} · 推荐岗位：{candidate.recommendedRole}</span>
                  <span>入选理由：{candidate.reason}</span>
                </li>)}</ul>
                {activePlan.preview.analysisFramework !== undefined && <div className={css.acceptanceList} data-plan-analysis-framework>
                  <strong>{activePlan.preview.analysisFramework.id} · {activePlan.preview.analysisFramework.question}</strong>
                  <span>分析轴：{activePlan.preview.analysisFramework.axes.join('、')}</span>
                  <span>假设：{activePlan.preview.analysisFramework.hypotheses.join('、')}</span>
                  <span>证伪条件：{activePlan.preview.analysisFramework.falsifiers.join('、')}</span>
                </div>}
              </section>}
              {activePlan?.preview.recommendation !== undefined && <section className={css.planTaskPreview} data-plan-recommendation>
                <header className={css.subsectionHeader}>本轮模型推荐回执</header>
                <p>{activePlan.preview.recommendation.reason}</p>
                <p className={css.controlNotice}>推荐模型：{activePlan.preview.recommendation.model}；预计需启动 {activePlan.preview.recommendation.estimatedTaskStarts} 个执行任务，每任务至多 {activePlan.preview.recommendation.maxRepairRoundsPerTask} 轮修复。费用目录未接入，确认前请以当前模型费用为准。</p>
              </section>}
              {stagedTasks.length > 0 && (
                <section className={css.planTaskPreview} data-plan-task-review>
                  <header className={css.subsectionHeader}>计划 DAG 与验收 <span>{stagedTasks.length}</span></header>
                  {activePlan !== undefined && activePlan !== null && <ResearchDagGraph plan={activePlan} />}
                  <ul className={css.taskReviewList}>
                    {stagedTasks.map((task, index) => (
                      <li key={task.id ?? `${task.subject ?? 'task'}:${index}`} className={css.taskReviewRow}>
                        <span className={css.taskReviewTop}><code>{task.id ?? `T${index + 1}`}</code><span>{task.subject ?? '未命名任务'}</span></span>
                        <span className={css.taskReviewMeta}>{task.assignee ?? '待认领'} · {(task.dependencies ?? []).length === 0 ? '无前置' : `前置 ${(task.dependencies ?? []).join('、')}`}</span>
                        {(task.produces ?? []).length > 0 && <span className={css.taskReviewMeta}>需交付：{task.produces!.join('、')}</span>}
                        {task.humanChoice !== undefined && <span className={css.taskReviewMeta} data-plan-human-choice>用户选择门：{task.humanChoice.options.join(' / ')} · 候选稿 {task.humanChoice.sourceTaskId}/{task.humanChoice.artifact}</span>}
                        {task.artifactInputs !== undefined && <span className={css.acceptanceList} data-plan-artifact-inputs>{task.artifactInputs.length === 0 ? '可独立开展，无上游产物输入' : task.artifactInputs.map((input, i) => <span key={`${input.fromTask}/${input.artifact}/${i}`}>{input.phase === 'acceptance' ? '验收需用' : '执行需用'}：{input.fromTask} / {input.artifact} · {input.purpose}</span>)}</span>}
                        {(task.acceptance ?? []).length > 0 && <span className={css.acceptanceList}>{(task.acceptance ?? []).map((check) => <span key={check.id}>{check.statement}</span>)}</span>}
                        {task.reportCraft !== undefined && <span className={css.acceptanceList} data-plan-craft-review>
                          <span>交付格式：{task.reportCraft.artifactRoles.join('、')}</span>
                          {task.reportCraft.selections.map((skill) => <span key={`${skill.packId}/${skill.skillId}`}>工艺：{skill.packId} / {skill.skillId}{skill.variant === undefined ? '' : `（${skill.variant}）`} · {skill.reason}</span>)}
                          {task.reportCraft.reviewAreas.map((area) => <span key={area.id}>独立审核：{area.description}</span>)}
                        </span>}
                        <aside className={css.taskReviewBindings} data-plan-task-materials>
                          <strong>专家 / 固定材料</strong>
                          <span>专家：{task.sourceExpertIds?.join('、') ?? task.assignee ?? '待认领'}</span>
                          {task.taskMaterials !== undefined ? <>
                            {task.taskMaterials.skills.map(skill => <span key={`${skill.packId}/${skill.skillId}`} title={skill.sha256}>Skill：{skill.packId}/{skill.skillId}{skill.packVersion === undefined ? '' : `@${skill.packVersion}`} · {skill.sha256.slice(0, 12)}</span>)}
                            <span title={task.taskMaterials.prompt.sha256}>Prompt：{task.taskMaterials.prompt.templateId} · {task.taskMaterials.prompt.sha256.slice(0, 12)}</span>
                            <span title={task.taskMaterials.digest}>冻结 digest：{task.taskMaterials.digest.slice(0, 12)}</span>
                            {task.materialRecipe !== undefined && <label>本节点 Skill 组合
                              <select value={materials[task.id!] ?? task.materialRecipe.selected} disabled={!canWrite || !editablePlan || busy || selectionDirty || reviewDirty} onChange={event => {
                                if (event.target.value === '__ai__') { void recommend(); return }
                                setMaterials({ ...materials, [task.id!]: event.target.value as 'core' | 'strategy' })
                              }}>
                                <option value="__ai__">由大模型推荐整套 Skill</option>
                                {task.materialRecipe.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
                              </select>
                            </label>}
                          </> : task.reportCraft !== undefined ? task.reportCraft.selections.map(skill => <span key={`${skill.packId}/${skill.skillId}`}>Skill：{skill.packId}/{skill.skillId}</span>)
                            : <span>{task.humanChoice === undefined ? '后续阶段绑定' : 'Host 用户选择门'}</span>}
                          {(() => { const member = activePlan?.preview.members.find(item => task.id !== undefined && activePlan.preview.tasks.find(row => row.id === task.id)?.expertIds.includes(item.slotId)); const route = member?.route ?? activePlan?.preview.captainModel; return route === undefined ? null : <span>模型：{route.provider}/{route.model} · {route.reasoningEffort ?? 'default'} · {routeSourceLabel(member?.routeSource)}</span> })()}
                        </aside>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <div className={css.planActions}>
                {materialDirty && <button type="button" data-plan-action="save-materials" onClick={() => { void edit() }} disabled={!canWrite || !editablePlan || busy || selectionDirty}>保存节点 Skill 组合</button>}
                <button type="button" data-plan-action="edit" onClick={() => { void edit() }} disabled={!canWrite || !editablePlan || busy || !hasPlan}>保存计划</button>
                <button type="button" data-plan-action="approve" className={css.primaryAction} onClick={() => { void approve() }} disabled={!canWrite || !approvablePlan || busy || !hasPlan || stale}>确认并开始执行</button>
                <button type="button" data-plan-action="discard" className={css.dangerAction} onClick={() => { void discard() }} disabled={!canWrite || !discardablePlan || busy || !hasPlan}>放弃</button>
              </div>
              {dirty && <div className={css.controlNotice} data-state="dirty">表单有未保存修改；批准时会先保存当前版本。</div>}
              <div className={css.planFacts} data-plan-facts>
                <span>digest <code>{activePlan?.digest.slice(0, 12)}</code></span>
                {activePlan?.expiresAt !== undefined && <span>截止 {new Date(activePlan.expiresAt).toLocaleString()}</span>}
                {activePlan?.approval !== undefined && <span>批准方式：{activePlan.approval.source === 'authenticated-host-user' ? '用户确认' : activePlan.approval.source === 'scoped-review-token' ? '独立页令牌确认' : activePlan.approval.source === 'delegated-host-authorization' ? '用户授权自动执行' : '历史批准记录（未记录用户来源）'}</span>}
                {activePlan?.failureReason !== undefined && <span data-state="error">{activePlan.failureReason}</span>}
              </div>
            </section>
          )}
          {stagedMembers.length > 0 && (
            <section className={css.rosterSection} data-plan-roster-review>
              <header className={css.subsectionHeader}>计划成员与路由 <span>{stagedMembers.length}</span></header>
              <ul className={css.rosterList}>
                {stagedMembers.map((member: TeamPlanMember, index) => <li key={member.id ?? member.name ?? `member:${index}`} className={css.rosterRow}>
                  <span className={css.rosterName}>{member.name ?? '未命名成员'}<small>{member.role ?? '计划成员'}</small></span>
                  <span className={css.rosterRoute}>{member.provider ?? '默认'}{member.model === undefined ? '' : ` · ${member.model}`}<small>{routeSourceLabel(member.routeSource)}{member.routeFallbackIndex === undefined ? '' : ` · 备用路由 ${member.routeFallbackIndex + 1}`}</small></span>
                </li>)}
              </ul>
            </section>
          )}
          {wire !== undefined && (
            <>
              <section className={css.rosterSection} data-roster-review>
                <header className={css.subsectionHeader}>成员与路由 <span>{wire.members.length}</span></header>
                <ul className={css.rosterList}>
                  {wire.members.length === 0 && <li className={css.emptyControl}>暂无成员</li>}
                  {wire.members.map((member) => (
                    <li key={member.id} className={css.rosterRow} title={member.attemptId ?? ''}>
                      <span className={css.rosterName}>{member.name}<small>{member.role}</small></span>
                      <span className={css.rosterRoute}>{member.provider ?? '默认'}{member.model === undefined ? '' : ` · ${member.model}`}</span>
                      <span className={css.rosterStatus} data-state={member.status}>{member.status ?? 'unknown'}</span>
                    </li>
                  ))}
                </ul>
              </section>
              <section className={css.taskReview} data-task-review>
                <header className={css.subsectionHeader}>DAG 与验收 <span>{wire.tasks.length}</span></header>
                <ul className={css.taskReviewList}>
                  {wire.tasks.map((task) => (
                    <li key={task.id} className={css.taskReviewRow}>
                      <span className={css.taskReviewTop}><code>{task.id}</code><span>{task.subject}</span><b data-state={task.status}>{task.status}</b></span>
                      <span className={css.taskReviewMeta}>{task.assignee ?? '待认领'} · {task.dependencies.length === 0 ? '无前置' : `前置 ${task.dependencies.join('、')}`}{task.attemptId === undefined && task.attempt === undefined ? '' : ` · attempt ${task.attemptId ?? task.attempt}`}</span>
                      {task.acceptance !== undefined && task.acceptance.length > 0 && <span className={css.acceptanceList} data-acceptance-list>{task.acceptance.map((check) => <span key={check.id} data-passed={check.passed === true}>{check.passed === true ? '✓' : '○'} {check.statement}</span>)}</span>}
                    </li>
                  ))}
                </ul>
              </section>
              <section className={css.qualitySection} data-quality-runs>
                <header className={css.subsectionHeader}>质量审核 <span>{qualityRuns.length}</span></header>
                {qualityRuns.length === 0 ? <span className={css.emptyControl}>暂无结构化审核记录</span> : <ul className={css.qualityList}>{qualityRuns.map((quality) => <li key={quality.runId} className={css.qualityRow} data-state={runTone(quality)}><span><code>{quality.runId}</code> · {quality.taskId}</span><span>{quality.lastVerdict ?? quality.status} · 评审 {quality.reviewRounds} / 修复 {quality.repairRounds}</span><span className={css.qualityEvidence}>证据 {quality.evidence.artifactCount} 件 · 验收 {quality.evidence.acceptanceCount} · 命令 {quality.evidence.commandCount} · 路径 {quality.evidence.changedPaths.length}{quality.findings.length > 0 ? ` · 问题 ${quality.findings.length}` : ''}</span>{quality.findings.slice(0, 2).map((finding) => <span key={finding.id} className={css.qualityFinding} title={finding.message}>发现：{finding.message}</span>)}</li>)}</ul>}
              </section>
              <section className={css.pauseSection} data-team-lifecycle>
                <label>操作原因<input data-team-reason value={reason} onChange={(event) => { setReason(event.target.value) }} placeholder="可选，写入审计记录" maxLength={500} disabled={busy || !canWrite} /></label>
                <div className={css.lifecycleActions}>
                  {wire.halted ? <button type="button" data-team-action="resume" onClick={() => { void resume() }} disabled={!canWrite || busy}>恢复团队</button> : <button type="button" data-team-action="halt" onClick={() => { void halt() }} disabled={!canWrite || busy}>暂停团队</button>}
                  {!archived && <button type="button" data-team-action="archive" className={css.dangerAction} onClick={() => { void archive() }} disabled={!canWrite || busy}>归档团队</button>}
                </div>
              </section>
            </>
          )}
          {!canMutate && <div className={css.controlNotice} data-state="forbidden">当前会话没有写权限，只能查看。</div>}
        </div>
      )}
    </section>
  )
}
