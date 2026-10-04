import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityTeam } from './ActivityPanel.tsx'
import { planMemberPreview, planRequest, planTaskPreview, type TeamPlanMember, type TeamPlanWire, type TeamWire, type TeamWireMutation, type TeamWireMutationResponse, type TeamWireQualityRun } from './team-api.ts'
import css from './ActivityPanel.module.css'

export interface TeamPlanPanelProps {
  readonly team?: ActivityTeam
  readonly wire?: TeamWire
  readonly plan?: TeamPlanWire | null
  readonly archived?: boolean
  readonly stale?: boolean
  readonly loading?: boolean
  readonly error?: string
  readonly canMutate?: boolean
  readonly onMutate: (request: Omit<TeamWireMutation, 'captainSessionId' | 'teamId'>) => Promise<TeamWireMutationResponse | void>
}

function text(value: string | undefined): string { return value ?? '' }
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
  const labels: Record<string, string> = { 'profile-member': '成员指定', 'profile-default': '计划默认', 'expert-override': '专家模型设置', 'expert-preset': '专家预设', 'plugin-default': '插件默认', captain: '队长模型' }
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
export function TeamPlanPanel({ team, wire, plan, archived = false, stale = false, loading = false, error, canMutate = true, onMutate }: TeamPlanPanelProps) {
  const [open, setOpen] = useState(plan?.status === 'staged')
  const [goal, setGoal] = useState('')
  const [teamName, setTeamName] = useState('')
  const [data, setData] = useState('')
  const [city, setCity] = useState('')
  const [period, setPeriod] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | undefined>()
  const [blockedAfterError, setBlockedAfterError] = useState(false)
  const [observedPlan, setObservedPlan] = useState<TeamPlanWire | null | undefined>(plan)
  const savedPatchRef = useRef<string>('')
  const incomingRequest = planRequest(plan)

  useEffect(() => {
    setObservedPlan(plan)
    if (plan?.status === 'staged') setOpen(true)
    setGoal(text(incomingRequest.goal))
    setTeamName(text(incomingRequest.team_name) || text(plan?.runtime?.teamName))
    setData(text(incomingRequest.data))
    setCity(text(incomingRequest.city))
    setPeriod(text(incomingRequest.period))
    savedPatchRef.current = JSON.stringify({
      team_name: text(incomingRequest.team_name) || text(plan?.runtime?.teamName),
      goal: text(incomingRequest.goal),
      data: text(incomingRequest.data),
      city: text(incomingRequest.city),
      period: text(incomingRequest.period),
    })
    setLocalError(undefined)
    setBlockedAfterError(false)
  }, [plan?.planId, plan?.revision, plan?.digest, plan?.runtime?.teamName, incomingRequest.goal, incomingRequest.team_name, incomingRequest.data, incomingRequest.city, incomingRequest.period])

  const activePlan = observedPlan === undefined ? plan : observedPlan
  const planIdentity = activePlan === null || activePlan === undefined ? undefined : { planId: activePlan.planId, expectedDigest: activePlan.digest, expectedRevision: activePlan.revision }
  const terminalPlan = activePlan !== null && activePlan !== undefined && ['completed', 'failed', 'discarded', 'expired'].includes(activePlan.status)
  const editablePlan = activePlan?.status === 'staged' && activePlan.request.compiled_source === undefined
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
  const currentPatchKey = JSON.stringify(patch)
  const dirty = editablePlan && activePlan !== undefined && activePlan !== null && currentPatchKey !== savedPatchRef.current
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
    const result = await run({ action: 'edit', ...planIdentity, patch })
    if (result?.plan !== undefined && result.plan !== null) savedPatchRef.current = currentPatchKey
    return result
  }
  const approve = async (): Promise<void> => {
    if (planIdentity === undefined || stale || !approvablePlan) return
    // A dirty editor must be committed first. Approving with the old
    // digest/revision would either reject by CAS or approve an older goal.
    if (dirty) {
      const saved = await edit()
      if (saved?.plan === undefined || saved.plan === null) return
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
        {wire?.halted && <span className={css.controlState} data-state="blocked">暂停</span>}
        {archived && <span className={css.controlState} data-state="archived">归档</span>}
      </div>
      {open && (
        <div className={css.controlsBody} data-team-controls-body>
          {error !== undefined && <div className={css.controlError} data-state="error" role="alert">{error}</div>}
          {localError !== undefined && <div className={css.controlError} data-state="error" role="alert">{localError}</div>}
          {(stale || blockedAfterError) && <div className={css.controlNotice} data-state="stale">数据已更新，请刷新后再批准或修改。</div>}
          {hasPlan && (
            <section className={css.planEditor} data-plan-editor data-plan-status={activePlan?.status} data-dirty={dirty}>
              <header className={css.planHeader}>
                <span className={css.planTitle}>待审计划</span>
                <span className={css.planIdentity} title={activePlan?.digest}>r{activePlan?.revision} · {planStatusLabel(activePlan?.status ?? '')}</span>
              </header>
              <div className={css.planFields}>
                <label>团队名称<input data-plan-field="team_name" value={teamName} onChange={(event) => { setTeamName(event.target.value) }} maxLength={120} disabled={!canWrite || !editablePlan || busy} /></label>
                <label>目标<textarea data-plan-field="goal" value={goal} onChange={(event) => { setGoal(event.target.value) }} maxLength={4000} disabled={!canWrite || !editablePlan || busy} rows={3} /></label>
                <div className={css.planFieldGrid}>
                  <label>数据范围<input data-plan-field="data" value={data} onChange={(event) => { setData(event.target.value) }} maxLength={500} disabled={!canWrite || !editablePlan || busy} /></label>
                  <label>城市<input data-plan-field="city" value={city} onChange={(event) => { setCity(event.target.value) }} maxLength={120} disabled={!canWrite || !editablePlan || busy} /></label>
                  <label>期间<input data-plan-field="period" value={period} onChange={(event) => { setPeriod(event.target.value) }} maxLength={120} disabled={!canWrite || !editablePlan || busy} /></label>
                </div>
              </div>
              {stagedTasks.length > 0 && (
                <section className={css.planTaskPreview} data-plan-task-review>
                  <header className={css.subsectionHeader}>计划 DAG 与验收 <span>{stagedTasks.length}</span></header>
                  <ul className={css.taskReviewList}>
                    {stagedTasks.map((task, index) => (
                      <li key={task.id ?? `${task.subject ?? 'task'}:${index}`} className={css.taskReviewRow}>
                        <span className={css.taskReviewTop}><code>{task.id ?? `T${index + 1}`}</code><span>{task.subject ?? '未命名任务'}</span></span>
                        <span className={css.taskReviewMeta}>{task.assignee ?? '待认领'} · {(task.dependencies ?? []).length === 0 ? '无前置' : `前置 ${(task.dependencies ?? []).join('、')}`}</span>
                        {(task.acceptance ?? []).length > 0 && <span className={css.acceptanceList}>{(task.acceptance ?? []).map((check) => <span key={check.id}>{check.statement}</span>)}</span>}
                        {task.reportCraft !== undefined && <span className={css.acceptanceList} data-plan-craft-review>
                          <span>交付格式：{task.reportCraft.artifactRoles.join('、')}</span>
                          {task.reportCraft.selections.map((skill) => <span key={`${skill.packId}/${skill.skillId}`}>工艺：{skill.packId} / {skill.skillId}{skill.variant === undefined ? '' : `（${skill.variant}）`} · {skill.reason}</span>)}
                          {task.reportCraft.reviewAreas.map((area) => <span key={area.id}>独立审核：{area.description}</span>)}
                        </span>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <div className={css.planActions}>
                <button type="button" data-plan-action="edit" onClick={() => { void edit() }} disabled={!canWrite || !editablePlan || busy || !hasPlan}>保存计划</button>
                <button type="button" data-plan-action="approve" className={css.primaryAction} onClick={() => { void approve() }} disabled={!canWrite || !approvablePlan || busy || !hasPlan || stale}>确认并开始执行</button>
                <button type="button" data-plan-action="discard" className={css.dangerAction} onClick={() => { void discard() }} disabled={!canWrite || !discardablePlan || busy || !hasPlan}>放弃</button>
              </div>
              {dirty && <div className={css.controlNotice} data-state="dirty">表单有未保存修改；批准时会先保存当前版本。</div>}
              <div className={css.planFacts} data-plan-facts>
                <span>digest <code>{activePlan?.digest.slice(0, 12)}</code></span>
                {activePlan?.expiresAt !== undefined && <span>截止 {new Date(activePlan.expiresAt).toLocaleString()}</span>}
                {activePlan?.approval !== undefined && <span>批准方式：{activePlan.approval.source === 'authenticated-host-user' ? '用户确认' : activePlan.approval.source === 'delegated-host-authorization' ? '用户授权自动执行' : '历史批准记录（未记录用户来源）'}</span>}
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
