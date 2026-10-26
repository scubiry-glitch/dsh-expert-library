import { prepareResearchSubmission, submissionFingerprint } from './research-submission.ts'
import { viewpointResearchProfile } from './viewpoint-research-plan.ts'
import { compactResearchProfile } from './compact-research-plan.ts'
import { isResearchV5, isV5WorkingTask, workingRelease, isCompactResearch, reviewedRelease, compactReviewer } from './research-release.ts'
import { reviseTaskInputs } from './input-revision.ts'
import { presetReportArtifactFlow } from './plan-artifact-flow.ts'
import { checkDeepResearchPass, checkDeepResearchReviewer, checkCompactReviewAudit, inspectPdfPages } from './deep-research-gates.ts'
import { currentTaskAction } from './task-actions.ts'
import { occupiesMemberExecutionSlot } from './task-occupancy.ts'
import { recordPlanExecutionBoundary } from './plan-execution-boundary.ts'
import { requireReportOutline, requireStagedReportOutline, executionPlanDigest } from './plan-review.ts'
import { applyPlanReview, validateCaptainPlanModel, freezePlanModelRoutes, validateFrozenPlanModelRoutes } from './plan-models.ts'
import { checkTaskReassignment, taskInputDigest, taskScopeDigest } from './task-reassignment.ts'
import { delegatedPlanApproval, requireAuthorizedReportPlan } from './plan-authorization.ts'
import { inheritRetiredPlanGoalWait, persistPlanUserWait, resumePlanUserWait } from './goal-wait.ts'
import { prepareCraftDelivery, saveCraftDelivery, requireCraftProducerDelivery, bindCraftReviewPreparation, requireCraftReviewPreparation } from './report-craft-delivery.ts'
import { renderTaskRepairFeedback } from './repair-feedback.ts'
import { isReportBundle, reportArtifactCheck, requireNewReportCraftSelection, requireCurrentSkillCraftSelection } from './report-bundle.ts'
import { listScopedSkillCraftCatalog, resolveSelectedSkillContract } from './skill-craft.ts'
import { DOMAIN_MATERIAL_PACK, requireCurrentTaskMaterialSelection, resolveTaskMaterialContract, prepareTaskMaterialDelivery, saveTaskMaterialDelivery, requireTaskMaterialDelivery } from './task-material-binding.ts'
import { canonicalDigest } from './v2/digest.ts'
import { issueReviewShareLink } from './host/review-share-link.ts'
import { recordCustomerUsage } from './host/customer-usage.ts'
/**
 * The `expert_teams_*` model-facing tools.
 *
 * The captain (the agent that created the team) orchestrates: members are
 * continuable subagents it spawns and wakes. Members share the same tools and
 * drive their own task state, mirroring the Claude Code Expert Teams flow:
 * create team → add members → create tasks with dependencies → claim/assign →
 * work → report → status → delete.
 * @module dsh-expert-library/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readFile, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { appendTeamEvent, captainSessionOf } from './events.ts'
import { prepareDependencyInputs } from './dependency-inputs.ts'
import {
  acknowledgeMailbox,
  admitTeamMessage,
  appendMailbox,
  archiveTeamDir,
  beginTaskAttempt,
  CAPTAIN_KEY,
  commitTaskUpdate,
  createMessage,
  createTaskProject,
  createTeamDir,
  finalizeTerminalTask,
  findTeamByCaptain,
  findTeamByParticipant,
  findTeamByPlanId,
  haltTeam,
  assertTeamRunnable,
  invalidateTaskAttempt,
  readUnreadMailbox,
  readMailbox,
  recordRetiredMemberIds,
  releaseMailboxDelivery,
  discardMailbox,
  publishTaskArtifact,
  readAllowedTaskArtifact,
  readTeam,
  resumeTeam,
  resumeRuntimeMember,
  sanitizeKey,
  transitionError,
  unsatisfiedDependencies,
  withTeamLock,
  writeTeam,
  syncTaskProjectInput,
  taskInputWarnings,
} from './state.ts'
import {
  expertMemberPersona,
  installRetiredMemberGuard,
  installMemberSelectionRuntime,
  interruptMember,
  memberActivity,
  memberRouteRequest,
  resolveMemberLlmSelection,
  spawnMember,
  type MemberRuntimeConfig,
  type MemberSelectionRuntime,
} from './members.ts'
import {
  TERMINAL_TASK_STATUSES,
  type StagedPlan,
  type StagedPlanRuntime,
  type TeamMember,
  type TeamState,
  type TeamTask,
  type TaskArtifact,
} from './types.ts'
import {
  archiveStagedPlan,
  createStagedPlan,
  editStagedPlan,
  expireStagedPlan,
  failedPlanRecoveryMessage,
  readStagedPlan,
  stagedPlanDigest,
  transitionStagedPlan,
  withStagedPlanLock,
  writeStagedPlan,
} from './staged-plan.ts'
import { installTeamScheduler, type TeamScheduler } from './scheduler.ts'
import { parseProfile, profileToExecutionPlan, type ExpertTeamProfile } from './profiles.ts'
import { PROFILE_SCHEMA, PROFILE_TASKS_SCHEMA, REPORT_BUNDLE_SCHEMA } from './profile-schema.ts'
import { grantCapabilityTask, revokeCapabilityTask } from './capability-scope.ts'
import { collectTaskEvidence, assertDurableQualityRun, reviewEvidenceForReplay } from './quality-runtime.ts'
import { recheckHostQualityRun } from './quality-run.ts'
import { createQualityRun, amendQualityRun, forkQualityRun, integrateQualityRun, requestQualityRepair, reviewQualityRun, validateAcceptanceResults, validateArtifactCheckFreshness, validateReviewRequest, QualityRunError, FINDING_SEVERITIES, REVIEW_VERDICTS, INDEPENDENT_REVIEW_AREA_IDS, type Finding, type QualityRun, type ReviewVerdict } from './quality-run.ts'
import { assertReviewedArtifactsCurrent } from './quality-artifacts.ts'
import { resolveLibrary } from './expert-library/registry.ts'
import { requirePlanExpertAvailability } from './active-experts.ts'
import { validateDeepResearchPlan } from './deep-research-plan.ts'
import { selectDeepResearchSubDag, parseDeepResearchSelection, selectDeepResearchMaterials } from './deep-research-selection.ts'
import type { Expert, ExpertModelRoute } from './expert-library/types.ts'
import { knowledgeGuide } from './knowledge.ts'
import { resolveSkill, skillDescriptionBlock } from './skills.ts'
import { zhijianExpertPersona } from './zhijian/persona.ts'
import { isZhijianExpertId, zhijianMetaById } from './zhijian/registry.ts'
import { scenarioById } from './zhijian/routing.ts'
import { normalizeToolMode, toolExecutionOf, type ToolExecutionConfig, type ToolExecutionMode } from './settings.ts'
import { applyExecutionPlan, compileErrorOf, expandExecutionPlan, type ApplyPlanOptions } from './apply.ts'
import { captureSharedTaskContext } from './shared-task-context.ts'
import { evaluateTaskCompletionGates, subjectWithQualityMark, taskGateBlockedError } from './task-gates.ts'
import { compileV1ScenarioExecutionPlan, builtinLegacyPack } from './v2/compat.ts'
import { compileExecutionPlan, type ExecutionPlan } from './v2/compiler.ts'
import { buildZhijianDomainPack } from './v2/zhijian-pack.ts'
import { resolveManagedRuntimePack } from './host/pack-runtime.ts'
import { inspectExpertTeamsState } from './doctor.ts'
import {
  addMemberCore,
  createTaskCore,
  createDeepResearchVisualRevisionCore,
  createTeamCore,
  requireCaptainTeam,
  requireFreshCaptainTeam,
  requireFreshTeam,
  requireMember,
  requireTask,
  rollbackTeamAssembly,
  stateRootOf,
  teamLockKey,
  waitForMemberIdle,
  workspaceOf,
  type ExpertToolsCore,
  type ToolsConfig,
} from './team-core.ts'
export {
  addMemberCore,
  createTaskCore,
  createTeamCore,
  rollbackTeamAssembly,
  type ExpertToolsCore,
  type ToolsConfig,
} from './team-core.ts'

/** The caller agent, or a loud failure for non-agent callers. */
function requireCaptain(exec: ToolRunContext): Agent {
  if (!exec.agent) {
    throw new Error('agent_teams tools require a calling agent (exec.agent was undefined)')
  }
  return exec.agent
}

/** Replace scenario task placeholders without exposing credentials or mutable state. */
function interpolateScenarioTemplate(template: string, values: Record<string, string | undefined>): string {
  return template.replace(/\{(goal|team_name|scenario|data|city|period)\}/g, (_match, key: string) => values[key] ?? '')
}

/**
 * The tool registry validates and snapshots canonical results as JSON. The
 * planner/state types intentionally use readonly arrays and optional fields,
 * so project them through JSON at this adapter boundary instead of weakening
 * the durable domain types or relying on a mutable cast.
 */
function asToolJsonObject(value: unknown): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>
}

function toolJsonField(value: JsonValue, key: string): JsonValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)[key]
    : undefined
}

/** Counts shown to the model must describe the materialized roster/DAG, not
 * only the digest that hides an accidental empty graph. */
function planSizeSummary(value: JsonValue): string {
  const plan = toolJsonField(value, 'plan')
  const roster = plan === undefined ? toolJsonField(value, 'members') : toolJsonField(plan, 'roster')
  const tasks = plan === undefined ? toolJsonField(value, 'tasks') : toolJsonField(plan, 'tasks')
  const memberCount = Array.isArray(roster)
    ? plan === undefined ? roster.length : new Set(roster.map(member => toolJsonField(member, 'expertId'))).size
    : 0
  const taskCount = Array.isArray(tasks)
    ? plan === undefined ? tasks.length : tasks.reduce<number>((sum, task) => {
      const experts = toolJsonField(task, 'expertIds')
      return sum + (Array.isArray(experts) && experts.length > 0 ? experts.length : 1)
    }, 0)
    : 0
  const graph = Array.isArray(tasks) ? tasks.map(task => {
    const id = toolJsonField(task, plan === undefined ? 'task_id' : 'id')
    const deps = toolJsonField(task, plan === undefined ? 'depends_on' : 'dependsOn')
    return { id, deps: Array.isArray(deps) ? deps : [] }
  }) : []
  const edgeCount = graph.reduce((sum, task) => sum + task.deps.length, 0)
  const graphLabel = plan === undefined ? 'Dependency' : 'Logical dependency'
  const graphRows = graph.slice(0, 12).map(task => `${task.id} ← ${task.deps.join(', ') || '(none)'}`).join('; ')
  const reportTasks = Array.isArray(tasks) ? tasks.filter(task => toolJsonField(task, 'reportBundle') !== undefined).map(task => {
    const bundle = toolJsonField(task, 'reportBundle')!
    const craft = toolJsonField(bundle, 'craft')
    const version = craft === undefined ? 1 : toolJsonField(craft, 'version')
    const selected = craft === undefined ? undefined : toolJsonField(craft, 'selections')
    const label = version === 3 ? `selected-skill-craft-v1 (${Array.isArray(selected) ? selected.map(item => `${toolJsonField(item, 'packId')}/${toolJsonField(item, 'skillId')}`).join(', ') : 'invalid selections'})` : `zhijian-report-craft-core-v${version}`
    return `${label} for ${toolJsonField(task, plan === undefined ? 'task_id' : 'id')}`
  }) : []
  return `Members: ${memberCount}; tasks: ${taskCount}; ${graphLabel.toLowerCase()} edges: ${edgeCount}.${taskCount === 0 ? ' No task DAG is staged.' : ` ${graphLabel} table: ${graphRows}${graph.length > 12 ? `; ${graph.length - 12} more tasks in the canonical plan` : ''}.`} Report artifact checks: ${reportTasks.length === 0 ? 'none; for a report workflow, explicitly select applicable domain-pack skills in reportBundle on its final MD/HTML/PDF producer before approval' : `${reportTasks.join('; ')} (registered check coverage only; independent substantive review still required)`}.`
}

function repairFeedbackResult(team: TeamState, task: TeamTask, stateRoot: string): { repair_feedback?: string } {
  const feedback = renderTaskRepairFeedback(team, task, stateRoot)
  return feedback === '' ? {} : { repair_feedback: feedback }
}

function independentReviewAreas(run: QualityRun): { id: string; description: string }[] {
  const selected = run.contract.artifactChecks?.find(check => check.id === 'selected-skill-craft-v1')
  if (selected?.id === 'selected-skill-craft-v1') return selected.selection.reviewAreas.map(area => ({ ...area }))
  return run.contract.artifactChecks?.some(check => check.id === 'zhijian-report-craft-core-v2')
    ? INDEPENDENT_REVIEW_AREA_IDS.map(id => ({ id, description: id })) : []
}

function qualityRunFor(team: TeamState, taskId?: string): QualityRun {
  const selected = taskId === undefined
    ? team.qualityRun
    : team.qualityRuns?.[taskId]
      ?? (team.qualityRun?.contract.taskId === taskId ? team.qualityRun : undefined)
  if (selected !== undefined) return selected
  const available = team.tasks.filter(task => team.qualityRuns?.[task.id] !== undefined || team.qualityRun?.contract.taskId === task.id)
    .map(task => `${task.id}${task.planTask === undefined ? '' : ` (plan: ${task.planTask.logicalId})`}`)
  throw new Error(`team "${team.name}" has no structured quality run${taskId === undefined ? '' : ` for task ${taskId}`}. Runtime task IDs with quality runs: ${available.join(', ') || '(none)'}. Use the runtime task_id; expert_teams_status shows the current review contract when work awaits review or repair.`)
}

function setQualityRun(team: TeamState, run: QualityRun): void {
  // Keep the compatibility alias stable for the root run. Per-task tools must
  // not retarget omitted task_id calls to whichever task was edited most recently.
  if (team.qualityRun === undefined || team.qualityRun.contract.taskId === run.contract.taskId) {
    team.qualityRun = run
  }
  if (team.qualityRuns !== undefined) team.qualityRuns = { ...team.qualityRuns, [run.contract.taskId]: run }
}

function replaceQualityRun(team: TeamState, previous: QualityRun, next: QualityRun): void {
  if (previous.runId !== next.runId) {
    const history = team.qualityRunHistory?.[previous.contract.taskId] ?? []
    team.qualityRunHistory = {
      ...team.qualityRunHistory,
      [previous.contract.taskId]: history.some(item => item.runId === previous.runId) ? history : [...history, previous],
    }
  }
  setQualityRun(team, next)
}

function taskOutputEvidencePath(team: TeamState, task: TeamTask): string | undefined {
  return task.project === undefined ? undefined : `${team.id}/${task.project.outputPath}`.replaceAll('\\', '/')
}

function hasReviewedDeliverable(team: TeamState, run: QualityRun): boolean {
  const outputPath = taskOutputEvidencePath(team, requireTask(team, run.contract.taskId))
  return run.latestEvidence?.artifacts.some(item => item.id !== 'task-output' || item.path !== outputPath) === true
}

async function requireReviewedArtifactsCurrent(stateRoot: string, team: TeamState, run: QualityRun): Promise<void> {
  const task = requireTask(team, run.contract.taskId)
  for (const artifact of currentPublishedDeliverables(task, run)) {
    const evidence = run.latestEvidence?.artifacts.find(item => item.id === artifact.reviewId)
    if (evidence === undefined || evidence.path !== publishedEvidencePath(team, task, artifact)
      || evidence.sha256 !== artifact.sha256 || evidence.attempt !== task.attempt) {
      throw new Error(`PUBLISHED_EVIDENCE_MISMATCH: ${artifact.reviewId} must bind the latest published version of attempt ${task.attempt}; retry review`)
    }
  }
  await assertReviewedArtifactsCurrent({ stateRoot, run, taskOutputPath: taskOutputEvidencePath(team, requireTask(team, run.contract.taskId)) })
  if (run.status === 'passed' || run.status === 'integrated') {
    const task = requireTask(team, run.contract.taskId)
    requireCraftProducerDelivery(team, task, run)
    const review = run.latestEvidence?.independentReview
    requireCraftReviewPreparation(task, run, review?.reviewerSessionId ?? '', review?.materialReceiptId, run.latestEvidence?.artifacts ?? [])
  }
}

function publishedEvidencePath(team: TeamState, task: TeamTask, artifact: TaskArtifact): string {
  if (task.project === undefined) throw new Error('Published artifact has no task project')
  return `${team.id}/${task.project.artifactsPath}/${artifact.relativePath}`.replaceAll('\\', '/')
}

/** Each logical deliverable must be republished in the current attempt. */
function currentPublishedDeliverables(task: TeamTask, run: QualityRun): TaskArtifact[] {
  const latest = new Map<string, TaskArtifact>()
  for (const artifact of task.publishedArtifacts ?? []) {
    if (artifact.reviewId !== undefined && artifact.attempt === task.attempt) latest.set(artifact.reviewId, artifact)
  }
  const missing = run.contract.deliverables.filter(id => id.startsWith('published:') && !latest.has(id))
  const uncovered = [...latest.keys()].filter(id => !run.contract.deliverables.includes(id))
  if (missing.length || uncovered.length) throw new Error(`${missing.length ? 'PUBLISHED_ARTIFACT_MISSING' : 'PUBLISHED_ARTIFACT_UNCOVERED'}: current attempt ${task.attempt}; missing=[${missing.join(', ')}]; uncovered=[${uncovered.join(', ')}]. Correct the complete list before submission; no review was advanced.`)
  return [...latest.values()]
}

/** Present dynamic review inputs only for work currently needing a decision.
 * These bindings are navigation, not evidence of file validity or acceptance.
 */
function reviewContractForStatus(team: TeamState, task: TeamTask, stateRoot?: string) {
  const run = team.qualityRuns?.[task.id] ?? (team.qualityRun?.contract.taskId === task.id ? team.qualityRun : undefined)
  if (run === undefined || run.status === 'integrated' || TERMINAL_TASK_STATUSES.includes(task.status)
    || !(task.executionState === 'awaiting_review' || ['blocked', 'repairing', 'passed', 'escalated'].includes(run.status))) return undefined
  const latest = new Map<string, TaskArtifact>()
  for (const artifact of task.publishedArtifacts ?? []) {
    if (artifact.reviewId !== undefined && artifact.attempt === run.attempt) latest.set(artifact.reviewId, artifact)
  }
  const publications = task.project === undefined ? [] : [...latest.values()].map(artifact => ({
    review_artifact_id: artifact.reviewId!, artifact_id: artifact.id, path: publishedEvidencePath(team, task, artifact),
    ...(stateRoot === undefined ? {} : { versionPath: resolve(stateRoot, publishedEvidencePath(team, task, artifact)) }),
    attempt: artifact.attempt, sha256: artifact.sha256,
  }))
  const missing = run.contract.deliverables.filter(id => id.startsWith('published:') && !latest.has(id))
  const outputPath = run.contract.deliverables.includes('task-output') ? taskOutputEvidencePath(team, task) : undefined
  const nextAction = run.status === 'passed'
    ? `${task.status === 'claimed' ? 'The current owner must first move this same attempt to in_progress. Then ' : ''}The captain can call expert_teams_quality_integrate(task_id="${task.id}", actor="captain", complete_task=true) with a new integration event_id.`
    : run.status === 'blocked'
      ? `Integration remains blocked. First classify the failed acceptance item. Only for a correctable artifact or execution defect should the captain call expert_teams_quality_repair(task_id="${task.id}", actor="captain") with a new repair event_id, then provide corrected evidence and independent review. Reopening, republishing or switching actors does not fix an unchanged external service failure. If the approved acceptance includes a user-authorized conditional branch, verify every obligation of that exact branch; never reinterpret a mandatory data requirement or mark a failed check true. Otherwise report the external blocker and the recovery condition; do not spend repair attempts without new evidence.`
      : run.status === 'escalated'
        ? `The content repair threshold is reached. Report the blocker and request an explicit user continuation decision; expert_teams_quality_continue preserves this task and history. If the user stops instead, the captain may call expert_teams_quality_closeout(task_id="${task.id}", event_id="<new-closeout-id>", reason="<disposition>") to preserve evidence and mark this attempt failed. Revised report source or craft contract requires a new confirmed staged plan.`
        : missing.length > 0 && (run.status === 'pending' || run.status === 'repairing')
          ? `Required current-attempt publications are missing: ${missing.join(', ')}. ${task.executionState === 'awaiting_review' ? `The captain must first call expert_teams_quality_reopen(task_id="${task.id}", event_id="<new-withdrawal-id>", reason="<missing-publication reason>") to withdraw this unreviewed submission without consuming another repair.` : run.status === 'repairing' ? 'The current owner must read the complete repair feedback, correct and verify the rejected work, then publish the corrected artifacts.' : 'The current owner must finish publishing first.'} Publish the original deliverable names for attempt ${run.attempt}, then submit awaiting_review; do not send an artificial failed review to unlock publication.`
        : `An independent reviewer must inspect the actual artifacts and call expert_teams_quality_review(task_id="${task.id}") with a new review event_id and one truthful passed boolean for every acceptance ID below. Include output-present if listed. The Host automatically binds task-output and current published versions; omit artifacts for these bindings and supply only other declared deliverables. Failed checks require needs_revision/reject and findings.`
  return {
    run_id: run.runId, status: run.status, task_id: task.id, attempt: run.attempt,
    acceptance: run.contract.acceptance.map(item => ({ id: item.id, statement: item.statement })),
    verify: [...run.contract.verify], deliverables: [...run.contract.deliverables],
    craft_preparation_required: task.reportBundle?.craft !== undefined,
    independent_review_areas: independentReviewAreas(run),
    craft_review_guidance: task.reportBundle?.craft === undefined ? null : 'Before reviewing, call expert_teams_quality_review(prepare_only:true,task_id,reviewer) to obtain full materials and checks; then submit material_receipt and every listed independent_review evidence area.',
    artifact_checks: (run.contract.artifactChecks ?? []).map(check => asToolJsonObject(check)),
    artifact_check_receipts: (run.latestEvidence?.artifactCheckReceipts ?? []).map(receipt => asToolJsonObject(receipt)),
    published_artifacts: publications, missing_publications: missing,
    task_output_binding: outputPath === undefined ? null : { id: 'task-output', path: outputPath, attempt: run.attempt },
    next_action: `${task.attempt !== run.attempt || task.assignee !== run.contract.assignee
      ? `Wait for ${run.contract.assignee} to enter quality attempt ${run.attempt}; prior task generations cannot be reviewed. ` : ''}${missing.length === 0 ? ''
      : `${run.status === 'repairing' ? 'After addressing the repair feedback, publish' : 'The current owner must publish'} these missing current-attempt deliverables${run.status === 'repairing' ? '' : ' first'}: ${missing.join(', ')}. `}${nextAction}`,
  }
}

function terminalTaskAdvice(task: TeamTask): string {
  const recovery = task.status === 'completed'
    ? task.reportBundle === undefined
      ? 'Completed work cannot be reopened/reassigned: ask the captain to create a follow-up producer/consumer task for content changes.'
      : `Completed work cannot be reopened/reassigned: ask the captain to create a follow-up task with revises_task_id="${task.id}" for content changes; this preserves reviewed input pins and report checks.`
    : 'Ask the captain to use the supported explicit reassign/retry flow for failed or cancelled work before changing its deliverable.'
  return `Task ${task.id} is ${task.status}; do not reclaim it, republish, or edit its finalized deliverable. ${recovery} For a delayed completion report only, keep task_id="${task.id}"${task.finalizedAttemptId === undefined ? '; no finalized attempt receipt exists' : ` and attempt_id="${task.finalizedAttemptId}" in expert_teams_send_message`}; do not remove task_id to bypass the generation check.`
}

/** Caller owns the team lock; manual claims share the scheduler input gate. */
async function prepareClaimInputs(stateRoot: string, team: TeamState, task: TeamTask): Promise<void> {
  try {
    await prepareDependencyInputs(stateRoot, team, task, (task.attempt ?? 0) + 1)
  } catch (error) {
    task.executionState = 'blocked_external'
    task.waitReason = `INPUT_ARTIFACT_BLOCKED: ${String(error)}`
    task.updatedAt = Date.now()
    await writeTeam(stateRoot, team)
    await syncTaskProjectInput(stateRoot, team, task)
    throw new Error(`${task.waitReason}. No new attempt was started. Restore the fixed input and ask the captain to resume_task; explicit input references cannot be edited in place, so changed references require a new consumer task.`)
  }
}

/** Reviewed evidence authorizes one task generation and one owner only. */
function requireCurrentQualityTask(team: TeamState, run: QualityRun): TeamTask {
  const task = requireTask(team, run.contract.taskId)
  if (task.reassigning === true || task.attempt !== run.attempt || task.assignee !== run.contract.assignee) {
    throw new Error(`QUALITY_ATTEMPT_MISMATCH: task ${task.id} no longer matches its reviewed attempt/owner; old quality evidence cannot authorize reassigned work`)
  }
  return task
}

/**
 * A review must authorize the task output that will actually be integrated and
 * completed.  The Host materializes the conventional `task-output` artifact
 * as JSON, so compare its reviewed `output` field with the current durable task
 * record.  Status/timestamp metadata may change during completion; the
 * deliverable text may not silently change after review.
 */
function requireReviewedTaskOutputCurrent(team: TeamState, run: QualityRun, candidateOutput?: string): TeamTask {
  const task = requireCurrentQualityTask(team, run)
  // With real reviewed deliverables, output is descriptive metadata. Legacy
  // summary-only contracts keep their original content binding.
  if (hasReviewedDeliverable(team, run)) return task
  const taskOutputPath = task.project === undefined ? undefined : `${team.id}/${task.project.outputPath}`.replaceAll('\\', '/')
  const artifact = run.latestEvidence?.artifacts.find((candidate) => (
    candidate.id === 'task-output'
      && taskOutputPath !== undefined
      && candidate.path === taskOutputPath
  ))
  if (artifact === undefined) return task
  let reviewedOutput: unknown
  try {
    const record = JSON.parse(artifact.content) as Record<string, unknown>
    reviewedOutput = record.output
  } catch {
    throw new Error(`QUALITY_OUTPUT_MISMATCH: reviewed task-output for ${task.id} is not a Host task output record`)
  }
  const outputToCheck = candidateOutput ?? task.output
  if (typeof reviewedOutput !== 'string' || outputToCheck !== reviewedOutput) {
    throw new Error(`QUALITY_OUTPUT_MISMATCH: task ${task.id} output changed after review; obtain a fresh review for the current deliverable`)
  }
  return task
}

/** Shared by member completion and captain acceptance; failure is never success. */
async function enforceCompletionGates(stateRoot: string, team: TeamState, task: TeamTask, output: string | undefined): Promise<void> {
  const gate = evaluateTaskCompletionGates(team, task, output)
  if (gate?.blocked !== undefined) {
    task.gateFailCount = gate.blocked.budgetUsed
    task.subject = subjectWithQualityMark(task.subject, gate.blocked.score, true)
    task.qualityScore = gate.blocked.score
    task.repairCount = gate.blocked.budgetUsed
    task.executionState = 'blocked_external'
    task.waitReason = `Completion blocked: ${gate.blocked.reason}`
    task.updatedAt = Date.now()
    await writeTeam(stateRoot, team)
    throw taskGateBlockedError(gate.blocked)
  }
  task.qualityScore = gate?.score ?? null
  task.repairCount = task.gateFailCount ?? 0
  if (gate !== undefined) task.subject = subjectWithQualityMark(task.subject, gate.score, false)
  task.gateWarnings = gate?.warnings.length ? gate.warnings : undefined
}

function requireReviewIdentity(team: TeamState, run: QualityRun, callerId: string, reviewer: string): string {
  if (isCompactResearch(team)) {
    const task = requireTask(team, run.contract.taskId)
    if (compactReviewer(team, task) !== reviewer) throw new Error('RESEARCH_REVIEWER_REQUIRED: only the designated independent reviewer may accept this task')
    if (task.status !== 'completed' && task.executionState !== 'awaiting_review') throw new Error('RESEARCH_SUBMISSION_REQUIRED')
  }
  assertTeamRunnable(team)
  const identity = participantIdentityOf(team, callerId)
  if (identity === undefined || identity.name !== reviewer) {
    throw new Error('QUALITY_REVIEWER_IDENTITY: reviewer must match the authenticated calling participant; proxy reviews are not allowed')
  }
  if (identity.kind === 'captain') throw new Error('QUALITY_REVIEWER_IDENTITY: the captain integrates results but cannot act as the independent reviewer')
  const task = requireCurrentQualityTask(team, run)
  if (identity.name === task.assignee) throw new Error('QUALITY_SELF_REVIEW: reviewer must differ from the task assignee')
  checkDeepResearchReviewer(team, task, callerId)
  return identity.name
}

/**
 * Resolve how one external tool id (e.g. `zyt`) should execute under the
 * current config: the settings/entry `toolExecution` policy, normalized to a
 * concrete mode (`api`/`cli`/`auto`). Unknown tool ids and unknown modes fall
 * back to `auto` (probe the API first, then the CLI).
 * @param config - the runtime tool config.
 * @param toolId - external tool id, e.g. `zyt`.
 * @returns the effective execution mode.
 */
export function toolExecutionModeOf(config: ToolsConfig, toolId: string): ToolExecutionMode {
  const policy = toolExecutionOf(config.toolExecution, toolId)
  return normalizeToolMode(policy?.mode)
}

/** Read the full execution policy for one external tool id, or undefined when unconfigured. */
export function toolPolicyOf(config: ToolsConfig, toolId: string): ToolExecutionConfig | undefined {
  return toolExecutionOf(config.toolExecution, toolId)
}

/** The team this captain or active member currently participates in. */
async function requireParticipantTeam(workspace: string, config: ToolsConfig, caller: Agent): Promise<TeamState> {
  const team = await findTeamByParticipant(stateRootOf(workspace, config), caller.id)
  if (team === undefined) {
    throw new Error('you do not lead or belong to any active team yet')
  }
  return team
}

type ParticipantIdentity =
  | { kind: 'captain'; name: typeof CAPTAIN_KEY }
  | { kind: 'member'; name: string }

/** Re-derive a caller's role from fresh state while holding the team lock. */
function participantIdentityOf(team: TeamState, agentId: string): ParticipantIdentity | undefined {
  if (team.captainSessionId === agentId) return { kind: 'captain', name: CAPTAIN_KEY }
  const member = team.members.find((candidate) => candidate.id === agentId && candidate.status !== 'removed')
  return member === undefined ? undefined : { kind: 'member', name: member.name }
}

/** Fresh state and caller identity rechecked inside the lock. */
async function requireFreshParticipant(
  stateRoot: string,
  teamId: string,
  callerId: string,
): Promise<{ team: TeamState; identity: ParticipantIdentity }> {
  const fresh = await requireFreshTeam(stateRoot, teamId)
  const identity = participantIdentityOf(fresh, callerId)
  if (identity === undefined) throw new Error(`you are no longer an active participant in team "${fresh.name}"`)
  return { team: fresh, identity }
}

function memberOpenTask(team: TeamState, memberName: string, exceptTaskId?: string): TeamTask | undefined {
  return team.tasks.find(task => task.id !== exceptTaskId
    && task.assignee === memberName
    && occupiesMemberExecutionSlot(task))
}

/**
 * Deliver a durable member report at the captain's nearest model boundary.
 *
 * `Agent.steer()` targets the next step while the captain is running, wakes a
 * new turn when it is idle, and lets the Agent runtime reclassify an aborted
 * activity to `next-turn`. This prevents reports from waiting behind the
 * captain's entire orchestration turn.
 */
export function steerCaptainReport(captain: Pick<Agent, 'steer'>, from: string, content: string): boolean {
  try {
    captain.steer(createUserMessage({
      content: [{ type: 'text', text: `Expert Teams message from member ${from}:\n\n${content}` }],
      source: { kind: 'plugin', plugin: 'dsh-expert-library' },
    }))
    return true
  } catch {
    // The plugin mailbox was persisted before this best-effort live delivery.
    return false
  }
}

// ── Expert Library core operations ─────────────────────────────────────────
// The four transactional cores (createTeamCore / addMemberCore /
// createTaskCore / rollbackTeamAssembly) moved to `team-core.ts` so the V2
// apply bridge (`src/apply.ts`) can reuse them without an import cycle.
// `scenarioApplyCore` below compiles the V1 scenario through
// `compileV1ScenarioExecutionPlan` and applies the compiled plan.

/** Core of `expert_teams_scenario_apply`: assemble a team from a scenario.
 *
 * Thin adapter over the V2 compiler bridge: the V1 scenario is projected and
 * compiled by `compileV1ScenarioExecutionPlan` into an immutable ExecutionPlan
 * (roster + task DAG isomorphic to the V1 `t1..tn` convention), then applied
 * through `applyExecutionPlan`, which runs the same transactional
 * create/add/task/kick sequence as the previous imperative assembler and rolls
 * the team back (members retired + interrupted, state archived) on any
 * failure, so a half-built team can never wedge the captain's one-team slot.
 */
export async function scenarioApplyCore(
  ctx: Context,
  config: ToolsConfig,
  captain: Agent,
  args: { scenario: string; team_name?: string; goal?: string; data?: string; city?: string; period?: string; report_bundle?: unknown },
  signal: AbortSignal,
  core: ExpertToolsCore,
): Promise<{
  scenario_id: string
  team_id?: string
  status?: string
  plan_id?: string
  digest?: string
  revision?: number
  review_url?: string
  team_name: string
  members: { expert_id: string; member_name: string; model: string }[]
  tasks: { task_id: string; subject: string; assignee?: string }[]
  deliverable: string
}> {
  const staged = await scenarioStageCore(ctx, config, captain, args)
  const approved = await scenarioApproveCore(ctx, config, captain, staged.planId, signal, core, staged.digest, staged.revision)
  if (approved.appliedTeamId === undefined) return { scenario_id: args.scenario, team_name: approved.runtime.teamName, status: 'waiting_user', plan_id: approved.planId, digest: approved.digest, revision: approved.revision, review_url: await issueReviewShareLink(stateRootOf(workspaceOf(captain), config), config.reviewPublicOrigin, { captainSessionId: captain.id, planId: approved.planId, gate: 'plan' }), members: [], tasks: [], deliverable: 'Research plan saved. Waiting for user confirmation in the plan panel; end this turn without retrying approve.' }
  const team = await readTeam(stateRootOf(workspaceOf(captain), config), approved.appliedTeamId)
  if (team === undefined) throw new Error('applied team not found')
  return {
    scenario_id: args.scenario, team_id: team.id, team_name: team.name,
    members: team.members.map(member => ({ expert_id: member.capabilityScope?.expertId ?? member.name, member_name: member.name, model: `${member.provider}/${member.model}` })),
    tasks: team.tasks.map(task => ({ task_id: task.id, subject: task.subject, ...(task.assignee === undefined ? {} : { assignee: task.assignee }) })),
    deliverable: staged.plan.deliverables.map(item => item.id).join(', '),
  }
}

interface ScenarioPlanArgs {
  research_flow?: string
  report_outline?: unknown
  plan_models?: unknown
  report_bundle?: unknown
  scenario?: string
  /** Explicit parameters for a managed DomainPack V2 TeamTemplate. */
  scenario_params?: Record<string, unknown>
  /** A validated profile definition supplied explicitly at the plan boundary. */
  profile?: unknown
  /** Captain-mode task DAG generated during the staged planning step. */
  tasks?: unknown
  team_name?: string
  goal?: string
  data?: string
  city?: string
  period?: string
}

/** Canonical mutable JSON object used by the model-facing plan tools. */
function jsonObject(value: unknown): Record<string, JsonValue> {
  // Execution plans and staged plans are intentionally deeply readonly. The
  // tool boundary, however, requires mutable JsonValue arrays/objects. A
  // detached JSON round-trip both removes readonly containers and enforces the
  // same lossless shape that the tools registry persists.
  const snapshot = JSON.parse(JSON.stringify(value)) as unknown
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('plan tool output must be a JSON object')
  }
  return snapshot as Record<string, JsonValue>
}

interface ScenarioPreviewToolValue {
  scenario_id: string
  team_name: string
  plan_id: string
  digest: string
  compiler_digest: string
  members: string[]
  tasks: {
    task_id: string
    logical_id: string
    subject: string
    depends_on: string[]
    assignee_expert?: string
  }[]
}

interface ScenarioPlanDraft {
  readonly scenarioId: string
  readonly deliverable: string
  readonly plan: ExecutionPlan
  readonly options: ApplyPlanOptions
  readonly request: Readonly<Record<string, string | undefined>>
}

function runtimeFromApplyOptions(options: ApplyPlanOptions, plan: ExecutionPlan): StagedPlanRuntime {
  return {
    executionDigest: executionPlanDigest(plan),
    teamName: options.teamName,
    description: options.description,
    ...(options.interpolations === undefined ? {} : { interpolations: { ...options.interpolations } }),
    ...(options.memberOrder === undefined ? {} : { memberOrder: [...options.memberOrder] }),
    ...(options.taskSuffixes === undefined ? {} : { taskSuffixes: { ...options.taskSuffixes } }),
    ...(options.sharedTaskContext === undefined ? {} : { sharedTaskContext: structuredClone(options.sharedTaskContext) }),
    ...(options.expertDisplay === undefined ? {} : { expertDisplay: Object.fromEntries(options.expertDisplay) }),
  }
}

function applyOptionsFromRuntime(runtime: StagedPlanRuntime): ApplyPlanOptions {
  return {
    teamName: runtime.teamName,
    description: runtime.description,
    ...(runtime.interpolations === undefined ? {} : { interpolations: { ...runtime.interpolations } }),
    ...(runtime.memberOrder === undefined ? {} : { memberOrder: [...runtime.memberOrder] }),
    ...(runtime.taskSuffixes === undefined ? {} : { taskSuffixes: { ...runtime.taskSuffixes } }),
    ...(runtime.sharedTaskContext === undefined ? {} : { sharedTaskContext: structuredClone(runtime.sharedTaskContext) }),
    ...(runtime.expertDisplay === undefined ? {} : { expertDisplay: new Map(Object.entries(runtime.expertDisplay)) }),
  }
}

/** Review fields share the same compiler and approval digest on every entry. */
async function compileScenarioDraft(ctx: Context, config: ToolsConfig, captain: Agent, args: ScenarioPlanArgs): Promise<ScenarioPlanDraft> {
  const draft = await compileBaseScenarioDraft(ctx, config, captain, args)
  return { ...draft, plan: await applyPlanReview(ctx, captain, draft.plan, args.report_outline, args.plan_models),
    request: { ...draft.request,
      ...(args.report_outline === undefined ? {} : { report_outline: JSON.stringify(args.report_outline) }),
      ...(args.plan_models === undefined ? {} : { plan_models: JSON.stringify(args.plan_models) }),
    } }
}

/** Compile a scenario for preview/stage without creating a team or a member. */
async function compileBaseScenarioDraft(
  ctx: Context,
  config: ToolsConfig,
  captain: Agent,
  args: ScenarioPlanArgs,
): Promise<ScenarioPlanDraft> {
  if (args.profile !== undefined) return compileProfileDraft(ctx, config, captain, args)
  if (args.scenario === undefined || args.scenario.trim() === '') throw new Error('scenario or profile is required')
  const workspace = workspaceOf(captain)
  const library = await resolveLibrary(ctx, workspace, config.knowledgeDir)
  const scenarioId = args.scenario.trim()
  const scenario = library.scenarios.get(scenarioId)
  if (scenario === undefined) {
    const pack = (await resolveManagedRuntimePack(ctx, config, buildZhijianDomainPack())).pack
    const managed = pack.scenarios.find(item => item.id === scenarioId)
    if (managed === undefined) throw new Error(`unknown scenario "${scenarioId}" — available: ${[...library.scenarios.keys(), ...pack.scenarios.map(item => item.id)].join(', ')}`)
    if (args.scenario_params === undefined) throw new Error(`SCENARIO_PARAMS_REQUIRED: "${scenarioId}" requires explicit TeamTemplate parameters`)
    const compiled = compileExecutionPlan({
      pack,
      templateId: managed.teamTemplate,
      scenarioId,
      params: args.scenario_params,
    })
    if (!compiled.ok) throw compileErrorOf(compiled)
    const bundle = args.report_bundle
    if (bundle !== undefined && (!isReportBundle(bundle) || bundle.craft?.version !== 3)) {
      throw new Error('DOMAIN_SCENARIO_REPORT_BUNDLE_INVALID: select enabled domain-pack skills with craft.version=3')
    }
    const finalProducers = [...new Set(compiled.plan.deliverables.flatMap(item => item.fromTasks))]
    if (bundle !== undefined && finalProducers.length !== 1) throw new Error('DOMAIN_SCENARIO_FINAL_PRODUCER_AMBIGUOUS')
    const plan = bundle === undefined ? compiled.plan : presetReportArtifactFlow({
      ...compiled.plan,
      tasks: compiled.plan.tasks.map(task => task.id === finalProducers[0] ? { ...task, reportBundle: structuredClone(bundle) } : task),
    })
    const teamName = args.team_name?.trim() || managed.id
    const selectedPlan = await freezePlanModelRoutes(ctx, config, captain, await freezePlanCraftSelections(ctx, config, captain, plan))
    return {
      scenarioId,
      deliverable: selectedPlan.deliverables.map(item => item.id).join(', '),
      plan: selectedPlan,
      options: { teamName, description: args.goal?.trim() || `${scenarioId}: ${JSON.stringify(args.scenario_params)}` },
      request: {
        compiled_source: `domain-pack.${scenarioId}`,
        scenario: scenarioId,
        scenario_params: JSON.stringify(args.scenario_params),
        ...(bundle === undefined ? {} : { report_bundle: JSON.stringify(bundle) }),
        ...(args.team_name === undefined ? {} : { team_name: args.team_name }),
        ...(args.goal === undefined ? {} : { goal: args.goal }),
      },
    }
  }
  if (scenario.reportTaskIndex !== undefined) {
    if (!Number.isSafeInteger(scenario.reportTaskIndex) || scenario.reportTaskIndex < 0 || scenario.reportTaskIndex >= scenario.tasks.length) throw new Error('SCENARIO_REPORT_TASK_INVALID')
    if (!isReportBundle(args.report_bundle) || args.report_bundle.craft?.version !== 3) throw new Error('SCENARIO_REPORT_BUNDLE_REQUIRED: this preset declares a final report producer. Supply report_bundle with MD/HTML/PDF/evidence and explicit enabled domain-pack skill selections using craft.version=3; the Host will not choose skills.')
  } else if (args.report_bundle !== undefined) throw new Error('SCENARIO_REPORT_TASK_UNDECLARED: this preset has no declared report producer; use an explicit profile task with reportBundle.')
  const expertIds: string[] = []
  for (const id of [...scenario.experts, ...scenario.tasks.map(task => task.expert).filter((id): id is string => id !== undefined)]) {
    if (library.experts.get(id) === undefined) throw new Error(`scenario "${scenario.id}" references unknown expert "${id}"`)
    if (!expertIds.includes(id)) expertIds.push(id)
  }
  const teamName = args.team_name?.trim() || scenario.name
  const templateValues = {
    goal: args.goal?.trim() || scenario.description,
    team_name: teamName,
    scenario: scenario.id,
    data: args.data,
    city: args.city,
    period: args.period,
  }
  let skillBlock = ''
  if (scenario.skill !== undefined) {
    const resolved = await resolveSkill(ctx, workspace, config.knowledgeDir, scenario.skill.id, scenario.skill.name)
    skillBlock = `\n\n${skillDescriptionBlock(resolved, scenario.skill.purpose)}`
  }
  const runtimePack = (await resolveManagedRuntimePack(ctx, config, builtinLegacyPack())).pack
  const compiled = compileV1ScenarioExecutionPlan([...library.experts.values()], scenario, runtimePack)
  if (!compiled.ok) throw compileErrorOf(compiled)
  const reportBundle = isReportBundle(args.report_bundle) ? args.report_bundle : undefined
  const selectedPlan = await freezePlanCraftSelections(ctx, config, captain, reportBundle === undefined ? compiled.plan : presetReportArtifactFlow({
    ...compiled.plan, tasks: compiled.plan.tasks.map((task, index) => index === scenario.reportTaskIndex ? { ...task, reportBundle: structuredClone(reportBundle) } : task),
  }))
  const taskSuffixes: Record<string, string> = {}
  if (scenario.skill !== undefined) {
    const skillTaskIndex = scenario.skill.appliesToTaskIndex ?? (scenario.tasks.length - 1)
    const block = skillBlock.trim()
    if (block !== '') {
      const template = scenario.tasks[skillTaskIndex]
      taskSuffixes[`t${skillTaskIndex + 1}`] = template?.description === undefined ? block : `\n\n${block}`
    }
  }
  const options: ApplyPlanOptions = {
    teamName,
    description: `${interpolateScenarioTemplate(templateValues.goal, templateValues)}${skillBlock}`,
    interpolations: {
      goal: templateValues.goal,
      team_name: teamName,
      scenario: scenario.id,
      data: templateValues.data ?? '',
      city: templateValues.city ?? '',
      period: templateValues.period ?? '',
    },
    memberOrder: expertIds,
    taskSuffixes,
  }
  return {
    scenarioId: scenario.id,
    deliverable: scenario.deliverable,
    plan: await freezePlanModelRoutes(ctx, config, captain, selectedPlan),
    options,
    request: {
      scenario: scenario.id,
      ...(reportBundle === undefined ? {} : { report_bundle: JSON.stringify(reportBundle) }),
      ...(args.team_name === undefined ? {} : { team_name: args.team_name }),
      ...(args.goal === undefined ? {} : { goal: args.goal }),
      ...(args.data === undefined ? {} : { data: args.data }),
      ...(args.city === undefined ? {} : { city: args.city }),
      ...(args.period === undefined ? {} : { period: args.period }),
    },
  }
}

/** Bind explicit report craft and task instructions at the common plan boundary. */
async function freezePlanCraftSelections(ctx: Context, config: ToolsConfig, captain: Agent, input: ExecutionPlan): Promise<ExecutionPlan> {
  let plan = input
  for (const task of plan.tasks) requireNewReportCraftSelection(task.reportBundle)
  if (plan.tasks.some(task => task.reportBundle?.craft?.version === 3 || task.skillBindings !== undefined)) {
    const scopedSkills = plan.tasks.some(task => task.skillBindings?.some(skill => skill.packId === DOMAIN_MATERIAL_PACK))
      ? (await listScopedSkillCraftCatalog(ctx, config, workspaceOf(captain)))
        .filter(row => row.packId === DOMAIN_MATERIAL_PACK)
        .map(row => ({ packId: DOMAIN_MATERIAL_PACK as typeof DOMAIN_MATERIAL_PACK, skillId: row.skillId, root: row.root, packVersion: row.packVersion })) : []
    const tasks = []
    for (const task of plan.tasks) {
      const selection = task.reportBundle?.craft?.version === 3
        ? await resolveSelectedSkillContract(ctx, config, workspaceOf(captain), task.reportBundle.craft.selections) : undefined
      const taskMaterials = task.skillBindings === undefined ? undefined : resolveTaskMaterialContract(task.skillBindings, task.promptBinding!, scopedSkills)
      if (task.reportBundle !== undefined) reportArtifactCheck(task.reportBundle, selection)
      tasks.push({ ...task,
        ...(selection === undefined ? {} : { frozenSkillCraftContract: selection }),
        ...(taskMaterials === undefined ? {} : { frozenTaskMaterialContract: taskMaterials }),
      })
    }
    const digest = canonicalDigest({ compilerDigest: plan.digest, tasks })
    plan = { ...plan, tasks, digest, planId: `ep-${digest.slice(0, 16)}` }
  }
  return plan
}

/** Compile an explicit profile without selecting one from free-form goal text. */
async function compileProfileDraft(ctx: Context, config: ToolsConfig, captain: Agent, args: ScenarioPlanArgs): Promise<ScenarioPlanDraft> {
  if (args.report_bundle !== undefined) throw new Error('PROFILE_REPORT_BUNDLE_LOCATION: attach reportBundle to the explicit final producer task.')
  // An explicit empty captain graph clears a draft. Keep it distinct from
  // omission during edit, which preserves the previously staged graph.
  const emptyCaptainGraph = Array.isArray(args.tasks) && args.tasks.length === 0
    && typeof args.profile === 'object' && args.profile !== null && !Array.isArray(args.profile)
    && (args.profile as Record<string, unknown>).taskPlanning === 'captain'
  const profileInput = args.tasks === undefined || emptyCaptainGraph
    ? args.profile
    : {
      ...(typeof args.profile === 'object' && args.profile !== null ? args.profile as Record<string, unknown> : {}),
      // A captain profile freezes its roster first; this explicit staged DAG
      // is the captain's generated task graph and is validated by the same
      // seed-profile dependency/owner checks before approval.
      taskPlanning: 'seed',
      tasks: args.tasks,
    }
  const parsedProfile = parseProfile(args.research_flow === 'viewpoint-v5' && typeof profileInput === 'object' && profileInput !== null ? {...profileInput,version:'5.0.0'} : profileInput)
  const profile: ExpertTeamProfile = args.research_flow === 'viewpoint-v5' ? viewpointResearchProfile(parsedProfile) : args.research_flow === 'compact-v4' ? compactResearchProfile(parsedProfile) : parsedProfile
  validateDeepResearchPlan(profile)
  if (profile.id === '98wiki-deep-research' && /^2\./u.test(profile.version)) {
    const library = await resolveLibrary(ctx, workspaceOf(captain), config.knowledgeDir)
    for (const member of profile.members) {
      if (member.expert !== undefined && !library.experts.has(member.expert))
        throw new Error(`DEEP_RESEARCH_EXPERT_UNAVAILABLE: ${member.expert}`)
    }
  }
  const teamName = args.team_name?.trim() || profile.id
  const goal = args.goal?.trim() || profile.description
  let plan = profileToExecutionPlan(profile, { goal, team_name: teamName })
  plan = await freezePlanCraftSelections(ctx, config, captain, plan)
  return {
    scenarioId: profile.id,
    deliverable: `${profile.id} profile plan`,
    plan: await freezePlanModelRoutes(ctx, config, captain, plan),
    options: { teamName, description: goal, memberOrder: profile.members.map(member => member.id) },
    request: {
      profile: JSON.stringify(profile),
      ...(args.tasks === undefined || ['compact-v4','viewpoint-v5'].includes(args.research_flow ?? '') ? {} : { tasks: JSON.stringify(args.tasks) }),
      ...(args.team_name === undefined ? {} : { team_name: args.team_name }),
      ...(args.goal === undefined ? {} : { goal: args.goal }),
    },
  }
}

export async function scenarioPreviewCore(ctx: Context, config: ToolsConfig, captain: Agent, args: ScenarioPlanArgs) {
  const draft = await compileScenarioDraft(ctx, config, captain, args)
  requireStagedReportOutline(draft.plan)
  draft.options.sharedTaskContext = captureSharedTaskContext(captain)
  const expanded = expandExecutionPlan(draft.plan, draft.options)
  const runtime = runtimeFromApplyOptions(draft.options, draft.plan)
  return {
    scenario_id: draft.scenarioId,
    team_name: draft.options.teamName,
    plan_id: `plan-${canonicalDigest({ captainSessionId: captain.id, digest: stagedPlanDigest(draft.plan.digest, draft.request, runtime) }).slice(0, 32)}`,
    // Preview exposes the same approval digest that stage persists. The
    // compiler digest remains available for diagnostics, while request and
    // runtime interpolation changes are included in the CAS digest.
    digest: stagedPlanDigest(draft.plan.digest, draft.request, runtime),
    compiler_digest: draft.plan.digest,
    report_outline: draft.plan.reportOutline,
    captain_model: draft.plan.captainModel,
    members: expanded.members.map(member => member.expertId),
    member_routes: draft.plan.roster.map(member => ({ expert_id: member.expertId, route: member.modelPolicy, source: member.modelRouteSource, fallback_index: member.modelRouteFallbackIndex })),
    tasks: expanded.tasks.map(task => ({
      task_id: task.id,
      logical_id: task.logicalId,
      subject: task.subject,
      depends_on: task.dependsOn,
      ...(draft.plan.tasks.find(logical => logical.id === task.logicalId)?.reportBundle === undefined ? {} : { reportBundle: draft.plan.tasks.find(logical => logical.id === task.logicalId)!.reportBundle }),
      ...(task.assignee === undefined ? {} : { assignee: task.assignee }),
      ...(task.assigneeExpertId === undefined ? {} : { assignee_expert: task.assigneeExpertId }),
    })),
  }
}

export async function scenarioStageCore(ctx: Context, config: ToolsConfig, captain: Agent, args: ScenarioPlanArgs): Promise<StagedPlan> {
  const draft = await compileScenarioDraft(ctx, config, captain, args)
  return stageCompiledPlanCore(ctx, config, captain, draft.plan, draft.options, draft.request, true)
}

/** Shared boundary for profile, legacy scenario and domain preset plans. */
export async function stageCompiledPlanCore(ctx: Context, config: ToolsConfig, captain: Agent,
  plan: ExecutionPlan, options: ApplyPlanOptions, request: Readonly<Record<string, string | undefined>>, alreadyFrozen = false,
): Promise<StagedPlan> {
  const frozen = alreadyFrozen ? plan : await freezePlanModelRoutes(ctx, config, captain, await freezePlanCraftSelections(ctx, config, captain, plan))
  const draft = { plan: alreadyFrozen ? frozen : await applyPlanReview(ctx, captain, frozen, request.report_outline === undefined ? undefined : JSON.parse(request.report_outline), request.plan_models === undefined ? undefined : JSON.parse(request.plan_models)), options, request }
  requireStagedReportOutline(draft.plan)
  draft.options.sharedTaskContext = captureSharedTaskContext(captain)
  expandExecutionPlan(draft.plan, draft.options)
  await requirePlanExpertAvailability(ctx, config, workspaceOf(captain), draft.plan)
  const stateRoot = stateRootOf(workspaceOf(captain), config)
  const existing = await findTeamByParticipant(stateRoot, captain.id)
  if (existing !== undefined) throw new Error(`you already belong to team "${existing.name}" — finish it before staging another plan`)
  let staged = createStagedPlan({
    planId: `plan-${canonicalDigest({ captainSessionId: captain.id, digest: stagedPlanDigest(draft.plan.digest, draft.request, runtimeFromApplyOptions(draft.options, draft.plan)) }).slice(0, 32)}`,
    plan: draft.plan,
    request: draft.request,
    runtime: runtimeFromApplyOptions(draft.options, draft.plan),
    createdBy: captain.id,
    sessionId: captain.session.id,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  })
  staged = await inheritRetiredPlanGoalWait(ctx, captain, stateRoot, staged)
  await recordPlanExecutionBoundary(stateRoot, staged)
  return withStagedPlanLock(stateRoot, staged.planId, async () => {
    const previous = await readStagedPlan(stateRoot, staged.planId)
    if (previous !== undefined) {
      if (previous.createdBy === captain.id && previous.status === 'staged' && previous.digest === staged.digest) {
        if (await delegatedPlanApproval(stateRoot, previous) === undefined) return persistPlanUserWait(ctx, captain, stateRoot, previous)
        if (previous.waitingFor === undefined) return previous
        const { waitingFor: _waitingFor, ...authorized } = previous
        await writeStagedPlan(stateRoot, authorized)
        return authorized
      }
      if (previous.createdBy === captain.id && previous.status === 'failed') throw new Error(failedPlanRecoveryMessage(previous))
      throw new Error(`staged plan "${staged.planId}" already exists with status ${previous.status}; use plan_edit or plan_discard with its current digest/revision; staging cannot overwrite its history`)
    }
    await writeStagedPlan(stateRoot, staged)
    return await delegatedPlanApproval(stateRoot, staged) === undefined ? persistPlanUserWait(ctx, captain, stateRoot, staged) : staged
  })
}

export async function scenarioEditCore(
  ctx: Context,
  config: ToolsConfig,
  captain: Agent,
  planId: string,
  patch: Partial<Pick<ScenarioPlanArgs, 'team_name' | 'goal' | 'data' | 'city' | 'period' | 'profile' | 'tasks' | 'report_bundle' | 'report_outline' | 'plan_models'>> & { research_selection?: unknown; research_material_selection?: unknown },
  expectedDigest?: string,
  expectedRevision?: number,
  recommendationReceipt?: { readonly reason: string; readonly model: string; readonly modelCallTokens?: { readonly input: number; readonly output: number } },
  expectedContextSha256?: string,
): Promise<StagedPlan> {
  const stateRoot = stateRootOf(workspaceOf(captain), config)
  return withStagedPlanLock(stateRoot, planId, async () => {
    const current = await readStagedPlan(stateRoot, planId)
    if (current === undefined) throw new Error(`staged plan "${planId}" was not found`)
    if (current.createdBy !== captain.id) throw new Error(`staged plan "${planId}" belongs to another captain`)
    if (expectedDigest !== undefined && expectedDigest !== current.digest) throw new Error(`staged plan "${planId}" digest is stale`)
    if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new Error(`staged plan "${planId}" revision is stale`)
    if (current.status === 'failed') throw new Error(failedPlanRecoveryMessage(current))
    const live = expireStagedPlan(current)
    if (live.status !== current.status) {
      await writeStagedPlan(stateRoot, live)
      throw new Error(`staged plan "${planId}" has expired`)
    }
    if (expectedContextSha256 !== undefined && Object.keys(patch).length === 0) {
      if (current.runtime.sharedTaskContext === undefined) throw new Error('SHARED_TASK_CONTEXT_INVALID: the original plan has no frozen user input')
      const sharedTaskContext = captureSharedTaskContext(captain, current.runtime.sharedTaskContext)
      if (sharedTaskContext.sha256 !== expectedContextSha256) throw new Error('SHARED_TASK_CONTEXT_CHANGED: direct-user input changed during review; inspect the latest context before retrying')
      const updated = editStagedPlan(current, { plan: current.plan, request: current.request,
        runtime: { ...current.runtime, sharedTaskContext }, fields: ['sharedTaskContext'], actor: captain.id })
      if (updated === current) return current
      await recordPlanExecutionBoundary(stateRoot, updated)
      await writeStagedPlan(stateRoot, updated)
      return updated
    }
    if (current.request.compiled_source !== undefined) {
      if (Object.keys(patch).some(k => !['report_outline', 'plan_models'].includes(k))) throw new Error('PRESET_INPUT_FROZEN: edit outline/models here; restage to change preset inputs')
      const revised = await applyPlanReview(ctx, captain, current.plan, patch.report_outline, patch.plan_models)
      requireStagedReportOutline(revised)
      const sharedTaskContext = captureSharedTaskContext(captain, current.runtime.sharedTaskContext)
      if (expectedContextSha256 !== undefined && sharedTaskContext.sha256 !== expectedContextSha256) throw new Error('SHARED_TASK_CONTEXT_CHANGED: direct-user input changed during review; inspect the latest context before retrying')
      const request = { ...current.request,
        ...(patch.report_outline === undefined ? {} : { report_outline: JSON.stringify(patch.report_outline) }),
        ...(patch.plan_models === undefined ? {} : { plan_models: JSON.stringify(patch.plan_models) }) }
      const updated = editStagedPlan(current, { plan: revised, request,
        runtime: { ...current.runtime, executionDigest: executionPlanDigest(revised), sharedTaskContext },
        fields: [...Object.keys(patch), ...(sharedTaskContext.sha256 === current.runtime.sharedTaskContext?.sha256 ? [] : ['sharedTaskContext'])], actor: captain.id })
      if (updated === current) return current
      await recordPlanExecutionBoundary(stateRoot, updated)
      await writeStagedPlan(stateRoot, updated)
      return updated
    }
    if ((patch.research_selection !== undefined || patch.research_material_selection !== undefined)
      && (patch.profile !== undefined || patch.tasks !== undefined))
      throw new Error('DEEP_RESEARCH_SELECTION_INVALID: selection cannot be mixed with profile or task replacement')
    const request: ScenarioPlanArgs = { ...current.request, ...patch }
    for (const key of ['report_outline', 'plan_models'] as const) {
      if (patch[key] === undefined && current.request[key] !== undefined) request[key] = JSON.parse(current.request[key]) as unknown
    }
    if (patch.plan_models !== undefined && current.request.plan_models !== undefined && typeof patch.plan_models === 'object' && patch.plan_models !== null && !Array.isArray(patch.plan_models)) {
      // A changed fan-out has a changed roster. Old research model keys may no
      // longer exist, so the combined recommendation supplies the complete map.
      request.plan_models = patch.research_selection === undefined
        ? { ...JSON.parse(current.request.plan_models), ...patch.plan_models }
        : patch.plan_models
    }
    if (patch.report_bundle === undefined && current.request.report_bundle !== undefined) {
      try { request.report_bundle = JSON.parse(current.request.report_bundle) as unknown } catch { throw new Error('staged scenario report_bundle is invalid') }
    }
    let previousProfile: Record<string, unknown> | undefined
    if (current.request.profile !== undefined) {
      try {
        const parsed: unknown = JSON.parse(current.request.profile)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('expected profile object')
        previousProfile = parsed as Record<string, unknown>
      } catch {
        throw new Error(`staged plan "${planId}" has an invalid profile definition`)
      }
      if (patch.profile === undefined) request.profile = previousProfile
    }
    if (patch.research_selection !== undefined) {
      if (previousProfile === undefined) throw new Error('DEEP_RESEARCH_SELECTION_INVALID: a staged research profile is required')
      request.profile = selectDeepResearchSubDag(parseProfile(previousProfile), parseDeepResearchSelection(patch.research_selection))
      delete request.tasks
      if (patch.plan_models === undefined) delete request.plan_models
    }
    if (patch.research_material_selection !== undefined) {
      const materialProfile = patch.research_selection === undefined ? previousProfile : request.profile
      if (materialProfile === undefined) throw new Error('DEEP_RESEARCH_SELECTION_INVALID: a staged research profile is required')
      request.profile = selectDeepResearchMaterials(parseProfile(materialProfile), patch.research_material_selection)
      delete request.tasks
    }
    if (request.profile !== undefined) {
      delete request.scenario
      if (patch.tasks === undefined) {
        const replacement = typeof patch.profile === 'object' && patch.profile !== null && !Array.isArray(patch.profile)
          ? patch.profile as Record<string, unknown> : undefined
        const keepGeneratedGraph = patch.profile === undefined
          || (previousProfile !== undefined && replacement !== undefined
            && replacement.taskPlanning === previousProfile.taskPlanning && replacement.tasks === undefined)
        if (keepGeneratedGraph && current.request.tasks !== undefined) {
          try {
            request.tasks = JSON.parse(current.request.tasks) as unknown
          } catch {
            throw new Error(`staged plan "${planId}" has an invalid captain task graph`)
          }
        } else {
          // A mode change or explicitly embedded seed DAG replaces the old
          // placement. It must not be overridden by an inherited top-level DAG.
          delete request.tasks
        }
      }
    }
    const draft = await compileScenarioDraft(ctx, config, captain, request)
    requireStagedReportOutline(draft.plan)
    draft.options.sharedTaskContext = captureSharedTaskContext(captain, current.runtime.sharedTaskContext)
    if (expectedContextSha256 !== undefined && draft.options.sharedTaskContext.sha256 !== expectedContextSha256) throw new Error('SHARED_TASK_CONTEXT_CHANGED: direct-user input changed during review; inspect the latest context before retrying')
    expandExecutionPlan(draft.plan, draft.options)
    const frozenRequest = recommendationReceipt === undefined ? draft.request : { ...draft.request,
      research_recommendation: JSON.stringify({ ...recommendationReceipt, source: 'host-model-recommendation',
        estimatedTaskStarts: draft.plan.tasks.filter(task => task.humanChoice === undefined).length,
        maxRepairRoundsPerTask: draft.plan.reviewPolicy?.maxRepairRounds ?? 2 }) }
    const updated = editStagedPlan(current, {
      plan: draft.plan,
      request: frozenRequest,
      runtime: runtimeFromApplyOptions(draft.options, draft.plan),
      fields: [...Object.keys(patch), ...(recommendationReceipt === undefined ? [] : ['research_recommendation']),
        ...(draft.options.sharedTaskContext.sha256 === current.runtime.sharedTaskContext?.sha256 ? [] : ['sharedTaskContext'])],
      actor: captain.id,
    })
    if (updated === current) return current
    await recordPlanExecutionBoundary(stateRoot, updated)
    await writeStagedPlan(stateRoot, updated)
    return updated
  })
}

const HOST_USER_APPROVAL = Symbol('authenticated-host-user-plan-approval')
const REVIEW_TOKEN_APPROVAL = Symbol('scoped-review-token-plan-approval')
export async function scenarioApproveCore(ctx: Context, config: ToolsConfig, captain: Agent, planId: string,
  signal: AbortSignal, core: ExpertToolsCore, expectedDigest?: string, expectedRevision?: number): Promise<StagedPlan> {
  return approvePlanCore(ctx, config, captain, planId, signal, core, expectedDigest, expectedRevision)
}
/** Called only after the management HTTP adapter has authenticated the user. */
export async function scenarioApproveFromHost(ctx: Context, config: ToolsConfig, captain: Agent, planId: string,
  signal: AbortSignal, core: ExpertToolsCore, expectedDigest?: string, expectedRevision?: number): Promise<StagedPlan> {
  return approvePlanCore(ctx, config, captain, planId, signal, core, expectedDigest, expectedRevision, HOST_USER_APPROVAL)
}
/** A scoped bearer was issued by a signed Host user and exchanged once. */
export async function scenarioApproveFromReviewToken(ctx: Context, config: ToolsConfig, captain: Agent, planId: string,
  signal: AbortSignal, core: ExpertToolsCore, expectedDigest: string, expectedRevision: number, reviewTokenId: string): Promise<StagedPlan> {
  if (!/^[a-f0-9]{24}$/u.test(reviewTokenId)) throw new Error('REVIEW_TOKEN_INVALID')
  return approvePlanCore(ctx, config, captain, planId, signal, core, expectedDigest, expectedRevision, REVIEW_TOKEN_APPROVAL, reviewTokenId)
}

const stagedApprovalInFlight = new Map<string, Promise<StagedPlan>>()

/**
 * Serialize approvals for one staged plan across concurrent tool calls in the
 * same process. A second caller must wait for the owner rather than treating
 * the owner's still-running apply as a crashed plan and marking it failed.
 * After a process restart this map is empty, so the durable running-state
 * reconciliation below still handles a genuinely interrupted apply.
 */
async function approvePlanCore(
  ctx: Context,
  config: ToolsConfig,
  captain: Agent,
  planId: string,
  signal: AbortSignal,
  core: ExpertToolsCore,
  expectedDigest?: string,
  expectedRevision?: number,
  authority?: typeof HOST_USER_APPROVAL | typeof REVIEW_TOKEN_APPROVAL,
  reviewTokenId?: string,
): Promise<StagedPlan> {
  if (expectedDigest === undefined || expectedDigest.trim() === '') {
    throw new Error(`staged plan "${planId}" approval requires expected_digest for CAS`)
  }
  if (expectedRevision === undefined || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error(`staged plan "${planId}" approval requires expected_revision for CAS`)
  }
  const stateRoot = stateRootOf(workspaceOf(captain), config)
  // Include caller identity and the caller's CAS token. A stale or foreign
  // approval must not piggyback on an in-flight owner's promise and bypass
  // the createdBy/expected_digest/expected_revision checks in the lock.
  const key = `${stateRoot}\u0000${planId}\u0000${captain.id}\u0000${expectedDigest}\u0000${expectedRevision}\u0000${authority === REVIEW_TOKEN_APPROVAL ? `token:${reviewTokenId}` : authority === HOST_USER_APPROVAL ? 'host-user' : 'delegated'}`
  const existing = stagedApprovalInFlight.get(key)
  if (existing !== undefined) {
    const result = await existing
    if (authority === undefined || result.status !== 'staged') return result
    // The model may have reached waiting_user just before the user's click.
    // Continue that authenticated click after its read-only wait completes.
    if (stagedApprovalInFlight.get(key) === existing) stagedApprovalInFlight.delete(key)
    return approvePlanCore(ctx, config, captain, planId, signal, core, expectedDigest, expectedRevision, authority, reviewTokenId)
  }
  const operation = scenarioApproveCoreOnce(ctx, config, captain, planId, signal, core, expectedDigest, expectedRevision, authority, reviewTokenId)
  stagedApprovalInFlight.set(key, operation)
  try {
    return await operation
  } finally {
    if (stagedApprovalInFlight.get(key) === operation) stagedApprovalInFlight.delete(key)
  }
}

async function scenarioApproveCoreOnce(
  ctx: Context,
  config: ToolsConfig,
  captain: Agent,
  planId: string,
  signal: AbortSignal,
  core: ExpertToolsCore,
  expectedDigest?: string,
  expectedRevision?: number,
  authority?: typeof HOST_USER_APPROVAL | typeof REVIEW_TOKEN_APPROVAL,
  reviewTokenId?: string,
): Promise<StagedPlan> {
  const stateRoot = stateRootOf(workspaceOf(captain), config)
  const reservation = await withStagedPlanLock(stateRoot, planId, async () => {
    const current = await readStagedPlan(stateRoot, planId)
    if (current === undefined) throw new Error(`staged plan "${planId}" was not found`)
    if (current.createdBy !== captain.id) throw new Error(`staged plan "${planId}" belongs to another captain`)
    if (expectedDigest !== undefined && expectedDigest !== current.digest) throw new Error(`staged plan "${planId}" digest is stale`)
    if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new Error(`staged plan "${planId}" revision is stale`)
    const live = expireStagedPlan(current)
    if (live.status === 'expired') {
      await writeStagedPlan(stateRoot, live)
      throw new Error(`staged plan "${planId}" has expired`)
    }
    if (live.status === 'completed') return { plan: live, owner: false }
    if (live.status === 'running') {
      // A process may have exited after apply created the durable team but
      // before the staged record was finalized. Reconcile that observable
      // team before deciding whether another apply is safe.
      const recovered = await findTeamByPlanId(stateRoot, planId)
      if (recovered !== undefined) {
        const completed = transitionStagedPlan(live, 'completed', { appliedTeamId: recovered.id })
        await writeStagedPlan(stateRoot, completed)
        return { plan: completed, owner: false, resumeTeamId: recovered.id }
      }
      const failed = transitionStagedPlan(live, 'failed', { failureReason: 'approval interrupted before a durable team was materialized' })
      await writeStagedPlan(stateRoot, failed)
      throw new Error(`staged plan "${planId}" was interrupted before apply completed`)
    }
    if (live.status === 'failed') throw new Error(failedPlanRecoveryMessage(live))
    if (live.status !== 'staged' && live.status !== 'approved') throw new Error(`staged plan "${planId}" is ${live.status}`)
    const currentContext = captureSharedTaskContext(captain, live.runtime.sharedTaskContext)
    if (live.runtime.sharedTaskContext !== undefined && currentContext.sha256 !== live.runtime.sharedTaskContext.sha256) {
      throw new Error(`SHARED_TASK_CONTEXT_CHANGED: new direct-user input must be included in plan "${planId}" before approval. next_action: call expert_teams_plan_edit with the current plan_id, expected_digest and expected_revision (an empty patch is sufficient), review the refreshed user context, then approve its returned digest/revision. No team or member was created.`)
    }
    // Old drafts may predate current stage validation. Reject pure expansion
    // errors while still editable, before writing approved/running receipts.
    for (const task of live.plan.tasks) {
      requireNewReportCraftSelection(task.reportBundle)
      await requireCurrentSkillCraftSelection(ctx, config, workspaceOf(captain), task.reportBundle, task.frozenSkillCraftContract)
      requireCurrentTaskMaterialSelection(task.skillBindings, task.promptBinding, task.frozenTaskMaterialContract)
    }
    await requireAuthorizedReportPlan(stateRoot, captain.id, captureSharedTaskContext(captain), live.plan)
    expandExecutionPlan(live.plan, applyOptionsFromRuntime(live.runtime))
    await requirePlanExpertAvailability(ctx, config, workspaceOf(captain), live.plan)
    // An incomplete draft must remain editable while awaiting a user. Only an
    // actual approval attempt requires the final outline and execution route.
    if (live.status === 'staged' && authority === undefined && await delegatedPlanApproval(stateRoot, live) === undefined) {
      return { plan: await persistPlanUserWait(ctx, captain, stateRoot, live), owner: false }
    }
    requireReportOutline(live.plan)
    await validateCaptainPlanModel(ctx, captain, live.plan, signal)
    await validateFrozenPlanModelRoutes(ctx, captain, live.plan, signal)
    if (live.runtime.sharedTaskContext !== undefined && captureSharedTaskContext(captain, live.runtime.sharedTaskContext).sha256 !== live.runtime.sharedTaskContext.sha256) {
      throw new Error(`SHARED_TASK_CONTEXT_CHANGED: direct-user input arrived while validating plan "${planId}". Edit the current staged plan before approval; no authorization was consumed and no team was created.`)
    }
    const grant = live.status !== 'staged' || authority !== undefined ? undefined : await delegatedPlanApproval(stateRoot, live, true)
    if (live.status === 'staged' && authority === undefined && grant === undefined) {
      return { plan: await persistPlanUserWait(ctx, captain, stateRoot, live), owner: false }
    }
    const approved = live.status === 'staged' ? transitionStagedPlan(live, 'approved', {
      actor: authority === REVIEW_TOKEN_APPROVAL ? 'scoped-review-token' : 'authenticated-host-user',
      approvalSource: authority === REVIEW_TOKEN_APPROVAL ? 'scoped-review-token' : authority === HOST_USER_APPROVAL ? 'authenticated-host-user' : 'delegated-host-authorization',
      ...(reviewTokenId !== undefined ? { authorizationRequestId: `review-token-${reviewTokenId}` } : grant === undefined ? {} : { authorizationRequestId: grant.requestId }),
      ...(live.runtime.sharedTaskContext === undefined ? {} : { contextSha256: live.runtime.sharedTaskContext.sha256 }),
    }) : live
    // Persist the approval receipt before entering the potentially long
    // materialization phase. A host crash between these writes leaves a
    // durable, auditable `approved` plan that can be resumed deliberately.
    if (live.status === 'staged') await writeStagedPlan(stateRoot, approved)
    const running = transitionStagedPlan(approved, 'running', { actor: captain.id })
    await writeStagedPlan(stateRoot, running)
    return { plan: running, owner: true }
  })
  if (!reservation.owner) {
    if (reservation.plan.status === 'completed') await resumePlanUserWait(ctx, captain, reservation.plan, stateRoot)
    // If the previous process died after persisting planRef but before the
    // scheduler kick, recovery completed the plan record but the team still
    // needs one explicit wake-up. Normal completed replays have no
    // resumeTeamId and remain idempotent no-ops.
    if ('resumeTeamId' in reservation && reservation.resumeTeamId !== undefined) {
      await core.scheduler.kickTeam(workspaceOf(captain), reservation.resumeTeamId, captain)
    }
    return reservation.plan
  }
  const reserved = reservation.plan
  try {
    const applied = await applyExecutionPlan(ctx, config, captain, reserved.plan, {
      ...applyOptionsFromRuntime(reserved.runtime),
      structuredQuality: reserved.plan.reviewPolicy?.required !== false,
    }, signal, core)
    return withStagedPlanLock(stateRoot, planId, async () => {
      const current = await readStagedPlan(stateRoot, planId)
      if (current === undefined) throw new Error(`staged plan "${planId}" disappeared during apply`)
      const updated = transitionStagedPlan(current, 'completed', {
        appliedTeamId: applied.team_id,
      })
      await writeStagedPlan(stateRoot, updated)
      await resumePlanUserWait(ctx, captain, updated, stateRoot)
      await archiveStagedPlan(stateRoot, updated).catch((error: unknown) => {
        ctx.logger.warn(`expert-teams: staged plan archive failed for ${planId}: ${String(error)}`)
      })
      return updated
    })
  } catch (error: unknown) {
    await withStagedPlanLock(stateRoot, planId, async () => {
      const current = await readStagedPlan(stateRoot, planId)
      if (current?.status === 'running') {
        await writeStagedPlan(stateRoot, transitionStagedPlan(current, 'failed', { failureReason: error instanceof Error ? error.message : String(error) }))
      }
    })
    throw error
  }
}

export async function scenarioDiscardCore(config: ToolsConfig, captain: Agent, planId: string, expectedDigest?: string, expectedRevision?: number): Promise<StagedPlan> {
  const stateRoot = stateRootOf(workspaceOf(captain), config)
  return withStagedPlanLock(stateRoot, planId, async () => {
    const current = await readStagedPlan(stateRoot, planId)
    if (current === undefined) throw new Error(`staged plan "${planId}" was not found`)
    if (current.createdBy !== captain.id) throw new Error(`staged plan "${planId}" belongs to another captain`)
    if (expectedDigest !== undefined && current.digest !== expectedDigest) throw new Error(`staged plan "${planId}" digest is stale`)
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error(`staged plan "${planId}" revision is stale`)
    const discarded = transitionStagedPlan(current, 'discarded', { actor: captain.id })
    await writeStagedPlan(stateRoot, discarded)
    return discarded
  })
}

/**
 * Register every `expert_teams_*` tool into the shared tools registry.
 * @param ctx - the plugin context (injects `tools`).
 * @param config - resolved tool config.
 * @returns the core dependencies for downstream tool families (Zhijian).
 */
export function registerExpertTeamsTools(ctx: Context, config: ToolsConfig): ExpertToolsCore {
  ctx.logger.info('expert-teams: compact-v4 transactions enabled; original DAG versions preserved')
  installRetiredMemberGuard(ctx, config.stateDir)
  const memberSelections = installMemberSelectionRuntime(ctx, config.stateDir)
  const scheduler = installTeamScheduler(ctx, { stateDir: config.stateDir,
    get maxActiveMembers() { return config.maxActiveMembers },
    get v5ResearchMaxActiveMembers() { return config.v5ResearchMaxActiveMembers },
  })

  ctx.tools.register(defineTool({
    name: 'expert_teams_create',
    description: 'Create a new Expert Teams team: you (the calling agent) become the captain. A captain leads one team at a time; create tasks and members afterwards with expert_teams_add_member and expert_teams_create_task.',
    parameters: {
      name: { type: 'string', required: true, description: 'Name for the new team (used as its stable id).' },
      description: { type: 'string', description: 'Team purpose / the goal the team will work on.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
          team_name: { type: 'string', required: true },
          state_dir: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Team "${value.team_name}" created (id ${value.team_id}) under ${value.state_dir}. You are the captain.`,
      }],
    },
    async execute(args, exec) {
      return createTeamCore(ctx, config, requireCaptain(exec), {
        name: args.name,
        ...args.description !== undefined ? { description: args.description } : {},
      }, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_plan_preview',
    description: 'Compile an Expert Library scenario into a reviewable plan without writing team state, creating members, creating tasks, or waking agents. For a report with a known outline, generate every chapter in report_outline in this call; a task description alone does not create the outline.',
    parameters: {
      scenario: { type: 'string', description: 'Legacy or active DomainPack scenario id. Omit when supplying an explicit profile object.' },
      scenario_params: { type: 'object', additionalProperties: true, description: 'For active DomainPack scenarios, explicit TeamTemplate parameters. Rent pricing requires property (known facts and unknowns) and asOfDate (YYYY-MM-DD).' },
      profile: PROFILE_SCHEMA,
      research_flow: { type: 'string', enum: ['viewpoint-v5', 'compact-v4', 'original'], description: 'For NEW research select viewpoint-v5: all selected experts contribute, choose viewpoints then evolve the outline; internal materials auto-advance, manuscript and delivery have independent review. compact-v4 retains the seven-task workflow. Original profiles and applied teams remain unchanged.' },
      tasks: PROFILE_TASKS_SCHEMA,
      report_bundle: REPORT_BUNDLE_SCHEMA,
      report_outline: { type: 'object', additionalProperties: true, description: 'Required for report-producing plans at preview: generate all promised chapters now as {chapters:[{id,title,questions:[string],evidence:[string],taskIds:[logicalTaskId]}],attachments:[string]}. Only a reviewed outline.md gate or V5 viewpoint-first flow may defer it.' },
      plan_models: { type: 'object', additionalProperties: true, description: 'Per-plan model choices keyed by roster expert id or captain: {provider,model,reasoningEffort}. No global changes or fallback. A changed captain route requires native session switching before approval.' },
      team_name: { type: 'string', description: 'Optional team name.' },
      goal: { type: 'string', description: 'Concrete goal.' },
      data: { type: 'string', description: 'Optional context data.' },
      city: { type: 'string', description: 'Optional city.' },
      period: { type: 'string', description: 'Optional period.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: `Plan preview ${toolJsonField(value, 'plan_id') ?? 'unknown'} (${toolJsonField(value, 'digest') ?? 'unknown'}) for ${toolJsonField(value, 'team_name') ?? 'unknown'}. ${planSizeSummary(value)} This preview did not save a staged record. Next: call expert_teams_plan_stage with the complete profile and tasks (or scenario). Use the returned staged plan id, digest and revision for edit or approve.`,
      }],
    },
    async execute(args, exec) {
      return asToolJsonObject(await scenarioPreviewCore(ctx, config, requireCaptain(exec), args))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_plan_stage',
    description: 'Persist a compiled scenario as a staged plan. Report plans must include the complete structured report_outline in this call; missing chapters are rejected before a user-facing draft is saved. Staging does not create members, tasks, or live wakeups. Before freezing acceptance, preserve the original user requirements, including any explicitly authorized conditional-analysis branch for unavailable external sources. Require source-error evidence, limitations and bounded conclusions for such a branch; do not invent fallback permission or weaken a mandatory source requirement.',
    parameters: {
      scenario: { type: 'string', description: 'Legacy or active DomainPack scenario id. Omit when supplying an explicit profile object.' },
      scenario_params: { type: 'object', additionalProperties: true, description: 'For active DomainPack scenarios, explicit TeamTemplate parameters. Rent pricing requires property (known facts and unknowns) and asOfDate (YYYY-MM-DD).' },
      profile: PROFILE_SCHEMA,
      research_flow: { type: 'string', enum: ['viewpoint-v5', 'compact-v4', 'original'], description: 'For NEW research select viewpoint-v5: all selected experts contribute, choose viewpoints then evolve the outline; internal materials auto-advance, manuscript and delivery have independent review. compact-v4 retains the seven-task workflow. Original profiles and applied teams remain unchanged.' },
      tasks: PROFILE_TASKS_SCHEMA,
      report_bundle: REPORT_BUNDLE_SCHEMA,
      report_outline: { type: 'object', additionalProperties: true, description: 'Required for report-producing plans at staging: generate all promised chapters now as {chapters:[{id,title,questions:[string],evidence:[string],taskIds:[logicalTaskId]}],attachments:[string]}. Only a reviewed outline.md gate or V5 viewpoint-first flow may defer it.' },
      plan_models: { type: 'object', additionalProperties: true, description: 'Per-plan model choices keyed by roster expert id or captain: {provider,model,reasoningEffort}. No global changes or fallback. A changed captain route requires native session switching before approval.' },
      team_name: { type: 'string', description: 'Optional team name.' },
      goal: { type: 'string', description: 'Concrete goal.' },
      data: { type: 'string', description: 'Optional context data.' },
      city: { type: 'string', description: 'Optional city.' },
      period: { type: 'string', description: 'Optional period.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: `Staged plan ${toolJsonField(value, 'planId') ?? 'unknown'} (${toolJsonField(value, 'digest') ?? 'unknown'}), revision ${toolJsonField(value, 'revision') ?? 'unknown'}, status ${toolJsonField(value, 'status') ?? 'staged'}. ${planSizeSummary(value)} ${toolJsonField(value, 'waitingFor') === 'user-confirmation' ? `Waiting for the user to confirm in the research plan panel.${toolJsonField(value, 'review_url') ? ` Independent page: ${toolJsonField(value, 'review_url')}.` : ''} End this turn; do not retry approve.` : 'A matching Host delegation is present; review this exact revision before calling approve.'}`,
      }],
    },
    async execute(args, exec) {
      const staged = await scenarioStageCore(ctx, config, requireCaptain(exec), args)
      if (staged.waitingFor === 'user-confirmation') exec.concludeTurn?.()
      const output = asToolJsonObject(staged)
      if (staged.waitingFor === 'user-confirmation') {
        const url = await issueReviewShareLink(stateRootOf(workspaceOf(requireCaptain(exec)), config), config.reviewPublicOrigin, { captainSessionId: requireCaptain(exec).id, planId: staged.planId, gate: 'plan' })
        if (url !== undefined) output.review_url = url
      }
      return output
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_plan_edit',
    description: 'Edit the same staged scenario or profile plan with optimistic digest/revision checks. Replacing a profile in the same taskPlanning mode preserves its generated tasks when tasks is omitted; explicit tasks replaces that graph, and tasks: [] clears a captain draft. A taskPlanning mode change uses the new profile/task placement.',
    parameters: {
      plan_id: { type: 'string', required: true, description: 'Staged plan id.' },
      expected_digest: { type: 'string', required: true, description: 'Digest currently shown to the user; approval is compare-and-swap.' },
      expected_revision: { type: 'number', required: true, description: 'Revision currently shown to the user; approval is compare-and-swap.' },
      team_name: { type: 'string', description: 'New team name.' },
      goal: { type: 'string', description: 'New goal.' },
      data: { type: 'string', description: 'New context data.' },
      city: { type: 'string', description: 'New city.' },
      period: { type: 'string', description: 'New period.' },
      profile: PROFILE_SCHEMA,
      research_flow: { type: 'string', enum: ['viewpoint-v5', 'compact-v4', 'original'], description: 'For NEW research select viewpoint-v5: all selected experts contribute, choose viewpoints then evolve the outline; internal materials auto-advance, manuscript and delivery have independent review. compact-v4 retains the seven-task workflow. Original profiles and applied teams remain unchanged.' },
      tasks: PROFILE_TASKS_SCHEMA,
      report_bundle: REPORT_BUNDLE_SCHEMA,
      report_outline: { type: 'object', additionalProperties: true, description: 'Structured report: {chapters:[{id,title,questions:[string],evidence:[string],taskIds:[logicalTaskId]}],attachments:[string]}. Ordered chapters are reviewed before report execution.' },
      plan_models: { type: 'object', additionalProperties: true, description: 'Per-plan model choices keyed by roster expert id or captain: {provider,model,reasoningEffort}. No global changes or fallback. A changed captain route requires native session switching before approval.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: `Plan ${toolJsonField(value, 'planId') ?? 'unknown'} edited to revision ${toolJsonField(value, 'revision') ?? 'unknown'} (${toolJsonField(value, 'digest') ?? 'unknown'}). ${planSizeSummary(value)}`,
      }],
    },
    async execute(args, exec) {
      const patch: Partial<ScenarioPlanArgs> = {}
      if (args.team_name !== undefined) patch.team_name = args.team_name
      if (args.goal !== undefined) patch.goal = args.goal
      if (args.data !== undefined) patch.data = args.data
      if (args.city !== undefined) patch.city = args.city
      if (args.period !== undefined) patch.period = args.period
      if (args.profile !== undefined) patch.profile = args.profile
      if (args.tasks !== undefined) patch.tasks = args.tasks
      if (args.report_bundle !== undefined) patch.report_bundle = args.report_bundle
      if (args.report_outline !== undefined) patch.report_outline = args.report_outline
      if (args.plan_models !== undefined) patch.plan_models = args.plan_models
      return asToolJsonObject(await scenarioEditCore(ctx, config, requireCaptain(exec), args.plan_id, patch, args.expected_digest, args.expected_revision))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_plan_approve',
    description: 'Apply one staged plan only with an existing authenticated Host user authorization. Without it, the plan stays waiting_user and this turn ends. User approval happens in the research plan panel; never retry or bypass this gate.',
    parameters: {
      plan_id: { type: 'string', required: true, description: 'Staged plan id.' },
      expected_digest: { type: 'string', description: 'Digest currently shown to the user.' },
      expected_revision: { type: 'number', description: 'Revision currently shown to the user.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const appliedTeamId = toolJsonField(value, 'appliedTeamId')
        const taskIds = toolJsonField(value, 'runtime_task_ids')
        const mapping = Array.isArray(taskIds)
          ? taskIds.map(item => `${toolJsonField(item, 'logical_id')} -> ${toolJsonField(item, 'task_id')}`).join('; ')
          : undefined
        const taskHint = appliedTeamId === undefined ? '' : mapping === undefined
          ? ' Read expert_teams_status for the current runtime task IDs before calling task, quality or wait tools.'
          : mapping === '' ? ' This team has no mapped plan tasks.'
            : ` Runtime task IDs (plan logical ID -> task_id): ${mapping}. Use the runtime task_id in task, quality and wait tools.`
        return [{
          type: 'text',
          text: `Plan ${toolJsonField(value, 'planId') ?? 'unknown'} ${appliedTeamId === undefined ? `is ${toolJsonField(value, 'status') ?? 'unknown'}` : `is approved and applied as team ${appliedTeamId}; task execution and independent review are still separate requirements`}. ${planSizeSummary(value)}${taskHint}${appliedTeamId === undefined ? `${toolJsonField(value, 'review_url') ? ` Independent page: ${toolJsonField(value, 'review_url')}.` : ''}` : ' Read expert_teams_status, claim a ready captain-owned task and mark it in_progress with the returned attempt_id before doing its business work. Publish and review each dependency before starting downstream report production; coordinate assigned members instead of silently doing their tasks.'}`,
        }]
      },
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const approved = await scenarioApproveCore(ctx, config, captain, args.plan_id, exec.signal, { memberSelections, scheduler }, args.expected_digest, args.expected_revision)
      if (approved.waitingFor === 'user-confirmation') exec.concludeTurn?.()
      const output = asToolJsonObject(approved)
      if (approved.waitingFor === 'user-confirmation') {
        const url = await issueReviewShareLink(stateRootOf(workspaceOf(captain), config), config.reviewPublicOrigin, { captainSessionId: captain.id, planId: approved.planId, gate: 'plan' })
        if (url !== undefined) output.review_url = url
      }
      if (approved.appliedTeamId !== undefined) {
        // Use the materialized planTask provenance, including fan-out. Do not
        // infer runtime IDs from ordering or change a completed apply receipt
        // into an error merely because this optional presentation read fails.
        try {
          const team = await readTeam(stateRootOf(workspaceOf(captain), config), approved.appliedTeamId)
          if (team?.captainSessionId === captain.id && team.planRef?.planId === approved.planId) {
            output.runtime_task_ids = team.tasks.filter(task => task.planTask !== undefined)
              .map(task => ({ logical_id: task.planTask!.logicalId, task_id: task.id }))
          }
        } catch (error: unknown) {
          ctx.logger.warn(`expert-teams: approved task ID presentation unavailable for ${approved.planId}: ${String(error)}`)
        }
      }
      return output
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_plan_discard',
    description: 'Discard a staged plan without creating a team. The plan record remains auditable.',
    parameters: { plan_id: { type: 'string', required: true, description: 'Staged plan id.' } },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: `Plan ${toolJsonField(value, 'planId') ?? 'unknown'} discarded.` }],
    },
    async execute(args, exec) {
      return asToolJsonObject(await scenarioDiscardCore(config, requireCaptain(exec), args.plan_id))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_scenario_apply',
    description: 'Save the preset DAG as a reviewable research plan with frozen models. Without an authenticated Host authorization, wait for the user to confirm in the plan panel and end this turn. Report presets require an explicit v3 report_bundle selecting enabled domain-pack skills. An existing exact-input Host grant permits execution; a model cannot approve itself.',
    parameters: {
      scenario: { type: 'string', required: true, description: 'Scenario id to apply (e.g. code-review, market-research, product-design, fullstack-build, security-audit, documentation).' },
      report_bundle: REPORT_BUNDLE_SCHEMA,
      team_name: { type: 'string', description: 'Team name; defaults to the scenario name.' },
      goal: { type: 'string', description: 'Team goal/description; defaults to the scenario description. Use this to pass the concrete target (e.g. the commit range to review).' },
      data: { type: 'string', description: 'Optional data/material context available to task placeholders.' },
      city: { type: 'string', description: 'Optional city or region for task placeholders.' },
      period: { type: 'string', description: 'Optional period for task placeholders.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scenario_id: { type: 'string', required: true },
          team_id: { type: 'string' },
          status: { type: 'string' }, plan_id: { type: 'string' }, digest: { type: 'string' }, revision: { type: 'number' }, review_url: { type: 'string' },
          team_name: { type: 'string', required: true },
          members: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                expert_id: { type: 'string', required: true },
                member_name: { type: 'string', required: true },
                model: { type: 'string', required: true },
              },
            },
            required: true,
          },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                task_id: { type: 'string', required: true },
                subject: { type: 'string', required: true },
                assignee: { type: 'string' },
              },
            },
            required: true,
          },
          deliverable: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        if (value.status === 'waiting_user') return [{ type: 'text', text: `Research plan ${value.plan_id} is waiting for user confirmation. ${value.review_url ? `Independent page: ${value.review_url}. ` : 'Open the research plan panel. '}No team or members were created; end this turn without repeating approve.` }]
        const lines = [
          `Scenario "${value.scenario_id}" applied → team "${value.team_name}" (${value.team_id}).`,
          `Members (${value.members.length}): ${value.members.map(member => `${member.member_name} [${member.expert_id}] @ ${member.model}`).join(', ')}`,
          `Tasks (${value.tasks.length}): ${value.tasks.map(task => `${task.task_id}${task.assignee ? ` (${task.assignee})` : ''} ${task.subject}`).join('; ')}`,
          `Deliverable: ${value.deliverable}`,
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const created = await scenarioApplyCore(ctx, config, captain, {
        scenario: args.scenario,
        ...args.report_bundle === undefined ? {} : { report_bundle: args.report_bundle },
        ...args.team_name !== undefined ? { team_name: args.team_name } : {},
        ...args.goal !== undefined ? { goal: args.goal } : {},
        ...args.data !== undefined ? { data: args.data } : {},
        ...args.city !== undefined ? { city: args.city } : {},
        ...args.period !== undefined ? { period: args.period } : {},
      }, exec.signal, { memberSelections, scheduler })
      // `applyExecutionPlan` already kicked the team once after the full DAG
      // was seeded (inside its transactional try block).
      if (created.status === 'waiting_user') exec.concludeTurn?.()
      return created
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_add_member',
    description: 'Add a durable continuable member. By default it snapshots the captain\'s current LLM route and effort. Supply provider/model only for an explicitly requested role-specific route; a changed provider or model automatically uses the target model\'s default effort. Set reasoning_effort only to request one of the target model\'s supported ids explicitly (or "default" to force its default). When `expert` is set, the member is spawned from the Expert Library: it receives the expert\'s persona, its preset AI model route (provider/model/reasoning effort), and the knowledge pack guide for that role; `name`/`role`/`provider`/`model` then default to the expert profile. The member waits for messages, works on assigned tasks, and can message the team.',
    parameters: {
      name: { type: 'string', description: 'Unique member name inside the team (defaults to the expert\'s name when `expert` is set).' },
      role: { type: 'string', description: 'Role of the member (e.g. researcher, engineer, reviewer); defaults to the expert\'s role.' },
      expert: { type: 'string', description: 'Expert Library profile id to spawn this member from (e.g. security-reviewer); presets persona, model route, and knowledge guide.' },
      provider: { type: 'string', description: 'Optional LLM provider route. Use only when the user explicitly requests a different provider; requires model.' },
      model: { type: 'string', description: 'Optional model override. Omit for the captain\'s current model (or the expert/configured memberModel default).' },
      reasoning_effort: { type: 'string', description: 'Optional reasoning effort override: one of the target model\'s supported effort ids, or "default" to force its default. When omitted, the captain\'s effort is inherited only for the same provider/model; a changed route uses the target default.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          member_name: { type: 'string', required: true },
          member_id: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          reasoning_effort: { type: 'string' },
          status: { type: 'string', required: true },
          expert_id: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Member "${value.member_name}" added (subagent id ${value.member_id}, ${value.provider}/${value.model}${value.reasoning_effort === undefined ? '' : `, reasoning ${value.reasoning_effort}`}, status ${value.status}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const team = await requireCaptainTeam(workspace, config, captain)
      const created = await addMemberCore(ctx, config, captain, {
        ...args.name !== undefined ? { name: args.name } : {},
        ...args.role !== undefined ? { role: args.role } : {},
        ...args.expert !== undefined ? { expert: args.expert } : {},
        ...args.provider !== undefined ? { provider: args.provider } : {},
        ...args.model !== undefined ? { model: args.model } : {},
        ...args.reasoning_effort !== undefined ? { reasoning_effort: args.reasoning_effort } : {},
      }, exec.signal, memberSelections)
      await scheduler.kickMember(workspace, team.id, created.member_name, captain)
      return created
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_remove_member',
    description: 'Remove a member safely: revoke its current attempts, return all unfinished owned tasks to the shared pending pool, interrupt its live turn, and mark it removed.',
    parameters: {
      name: { type: 'string', required: true, description: 'Name of the member to remove.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          member_name: { type: 'string', required: true },
          status: { type: 'string', required: true },
          requeued_tasks: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Member "${value.member_name}" removed (status ${value.status}); requeued tasks: ${value.requeued_tasks.join(', ') || 'none'}.`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      const revoked = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        assertTeamRunnable(fresh)
        const member = requireMember(fresh, args.name)
        const requeued: string[] = []
        for (const task of fresh.tasks) {
          if (task.assignee !== member.name || TERMINAL_TASK_STATUSES.includes(task.status)) continue
          const run = fresh.qualityRuns?.[task.id]
            ?? (fresh.qualityRun?.contract.taskId === task.id ? fresh.qualityRun : undefined)
          if (run?.status === 'escalated' && task.status !== 'failed' && task.status !== 'cancelled') {
            throw new Error(`QUALITY_ESCALATED_CLOSEOUT_REQUIRED: close out ${task.id} before removing ${member.name}; the review evidence must remain attached to its attempt`)
          }
          invalidateTaskAttempt(task)
          task.reassigning = false
          requeued.push(task.id)
        }
        member.status = 'removed'
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'expert-teams/member-removed', {
          teamId: fresh.id,
          memberId: member.id,
        })
        return { member: { ...member }, requeued }
      })
      if (revoked.member.id !== '') {
        await recordRetiredMemberIds(stateRoot, [revoked.member.id])
        interruptMember(ctx, captain, revoked.member.id)
        await waitForMemberIdle(ctx, revoked.member, exec.signal)
      }
      await scheduler.kickTeam(workspace, team.id, captain)
      return {
        member_name: revoked.member.name,
        status: revoked.member.status,
        requeued_tasks: revoked.requeued,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_create_task',
    description: 'Create a task in your team\'s task list. Tasks can depend on other tasks (dependencies): a task is only claimable once every dependency is completed. Optionally assign it to a member, who still claims it before working.',
    parameters: {
      subject: { type: 'string', required: true, description: 'Brief title for the task.' },
      description: { type: 'string', description: 'What needs to be done, in detail.' },
      dependencies: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task ids this task depends on (must be completed before this task can be claimed).',
      },
      assignee: { type: 'string', description: 'Optional active member name, or "captain" for the authenticated captain. The owner must claim the task before working.' },
      produces: { type: 'array', items: { type: 'string' }, description: 'File publications expected from this task, e.g. ["report.md", "report-source-ledger.json", "research-evidence.md"]. Plain file names only. Compact dynamic tasks without a declaration register files atomically at their first submission before any review; subsequent attempts preserve that declaration.' },
      report_bundle: REPORT_BUNDLE_SCHEMA,
      revises_task_id: { type: 'string', description: 'For changes to a completed report with report_bundle, identify its integrated source task. Host adds its dependency, pins reviewed publications, and inherits report checks and acceptance. Ordinary task follow-ups use dependencies/input_artifacts instead. Omit input_artifacts; publish a new version in this new task. The old reviewed task remains immutable.' },
      input_artifacts: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        source_task_id: { type: 'string', required: true }, artifact_id: { type: 'string', required: true }, purpose: { type: 'string' },
      } }, description: 'Pin published artifact UUIDs from dependencies. Omit to freeze their current reviewed publications at first dispatch; explicit [] means no artifact inputs. Explicit pins remain fixed through repair; changing explicit selection requires a new consumer task. Automatic defaults refresh only in a new repair/reassignment attempt. The Host checks bytes before dispatch.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          status: { type: 'string', required: true },
          assignee: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Task "${value.subject}" created as ${value.task_id} (status ${value.status}${value.assignee ? `, assigned to ${value.assignee}` : ''}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const team = await requireCaptainTeam(workspace, config, captain)
      assertTeamRunnable(team)
      const created = await createTaskCore(ctx, config, captain, {
        subject: args.subject,
        ...args.description !== undefined ? { description: args.description } : {},
        ...args.dependencies !== undefined ? { dependencies: args.dependencies } : {},
        ...args.assignee !== undefined ? { assignee: args.assignee } : {},
        ...args.produces !== undefined ? { produces: args.produces } : {},
        ...args.report_bundle === undefined ? {} : { reportBundle: args.report_bundle },
        ...args.revises_task_id === undefined ? {} : { revisesTaskId: args.revises_task_id },
        ...args.input_artifacts === undefined ? {} : { inputArtifacts: args.input_artifacts.map(ref => ({ sourceTaskId: ref.source_task_id, artifactId: ref.artifact_id, ...ref.purpose === undefined ? {} : { purpose: ref.purpose } })) },
      }, exec.signal)
      await scheduler.kickTeam(workspace, team.id, captain)
      return created
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_open_visual_revision',
    description: 'Captain-only bounded v3 research recovery after an independently rejected hard visual review of an integrated renderer. Atomically creates render_revision_1 and visual_review_1, closes the old rejected review, and rewires unclaimed finalqa to the new reviewed version. This operation can run only once per team.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      render_task_id: { type: 'string', required: true },
      visual_review_task_id: { type: 'string', required: true },
      finalqa_task_id: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: `Visual revision opened: ${value.render_task_id} → ${value.visual_review_task_id}; final QA ${value.finalqa_task_id} now depends on the new review.` }] },
    async execute(_args, exec) {
      const captain = requireCaptain(exec)
      const result = await createDeepResearchVisualRevisionCore(ctx, config, captain)
      const team = await requireCaptainTeam(workspaceOf(captain), config, captain)
      await scheduler.kickTeam(workspaceOf(captain), team.id, captain)
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_publish_artifact',
    description: 'Snapshot an existing file from your current task project into an immutable published version. Returns the artifact id, SHA256 and version path; downstream tasks can pin this id without copying file contents into messages.',
    parameters: {
      task_id: { type: 'string', required: true }, attempt_id: { type: 'string', required: true },
      source_path: { type: 'string', description: 'Clean path relative to the exact project.path in input/task.json, e.g. artifacts/report.md. Do not supply workspace-relative or absolute paths, ./ or ../. First copy a shared deliverable into your own task project, then publish that local file before awaiting_review.' },
      reuse_artifact_id: { type: 'string', description: 'After a valid reassignment, explicitly adopt one previous-attempt artifact id instead of copying its file. Mutually exclusive with source_path. Host verifies SHA, unchanged input manifest and task scope; a fresh independent review is still required.' },
      expected_sha256: { type: 'string', description: 'Required exact SHA256 for reuse_artifact_id.' },
      reuse_reason: { type: 'string', description: 'Required explanation of why this previous artifact remains applicable.' },
      name: { type: 'string', required: true }, media_type: { type: 'string' }, description: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: `Published ${value.artifact_id} (${value.sha256}) at ${value.path}` }] },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const located = await requireParticipantTeam(workspace, config, caller)
      return withTeamLock(teamLockKey(stateRoot, located.id), async () => {
        const { team, identity } = await requireFreshParticipant(stateRoot, located.id, caller.id)
        assertTeamRunnable(team)
        const task = requireTask(team, args.task_id)
        if (task.assignee !== identity.name) throw new Error('ARTIFACT_STALE_OWNER: only the current task owner/attempt can publish')
        if (TERMINAL_TASK_STATUSES.includes(task.status)) throw new Error(`ARTIFACT_STALE_OWNER: ${terminalTaskAdvice(task)}`)
        if (task.attemptId !== args.attempt_id || task.reassigning === true) throw new Error('ARTIFACT_STALE_OWNER: only the current task owner/attempt can publish')
        if (task.waitReason?.startsWith('USER_PAUSED:')) throw new Error('TASK_PAUSED_BY_USER: wait for an explicit restart before publishing')
        if (task.status !== 'claimed' && task.status !== 'in_progress') throw new Error('Only unfinished tasks can publish a new version')
        if (task.project === undefined) throw new Error('Task has no isolated project')
        const run = team.qualityRuns?.[task.id] ?? (team.qualityRun?.contract.taskId === task.id ? team.qualityRun : undefined)
        if (run !== undefined) requireCraftProducerDelivery(team, task, run)
        requireTaskMaterialDelivery(task, caller.id, task.attempt ?? 1, 'producer')
        if (run?.status === 'passed' || run?.status === 'integrated') throw new Error('Reopen quality review before publishing a revised deliverable')
        if (task.executionState === 'awaiting_review') throw new Error('Task is waiting for review; open repair/revision before writing new artifacts')
        const safeName = args.name.trim().replace(/[^a-zA-Z0-9._-]/g, '-')
        const reviewId = `published:${safeName}`
        const artifactScope = `${team.id}/${task.project.artifactsPath}/**`.replaceAll('\\', '/')
        let amendedRun = run
        if (run !== undefined && (!run.contract.deliverables.includes(reviewId) || !run.contract.changedPaths.includes(artifactScope))) {
          if (run.status !== 'pending' || run.reviewRounds !== 0) throw new Error('QUALITY_CONTRACT_FROZEN: repair must republish the original deliverable name; add new deliverables in a follow-up task or reopen a settled review')
          amendedRun = amendQualityRun(run, {
            eventId: `publish-contract:${reviewId}`, actor: identity.name,
            reason: 'Bind the published deliverable to independent quality review.',
            contract: { ...run.contract, deliverables: [...new Set([...run.contract.deliverables, reviewId])], changedPaths: [...new Set([...run.contract.changedPaths, artifactScope])] },
          }).run
        }
        let content: Buffer
        let reusedFrom: TaskArtifact['reusedFrom']
        if (args.reuse_artifact_id !== undefined) {
          if (args.source_path !== undefined || !args.reuse_reason?.trim() || args.reuse_reason.length > 2000 || !/^[a-f0-9]{64}$/u.test(args.expected_sha256 ?? '')) throw new Error('ARTIFACT_REUSE_INPUT: provide artifact id, exact SHA and applicability reason; omit source_path')
          const previous = task.publishedArtifacts?.find(a => a.id === args.reuse_artifact_id)
          const handoff = task.reassignmentHistory?.at(-1)
          if (previous === undefined || handoff === undefined || !handoff.publicationIds.includes(previous.id)
            || task.attempt !== handoff.previousAttempt + 1 || previous.attempt !== handoff.previousAttempt
            || previous.reviewId !== reviewId || previous.sha256 !== args.expected_sha256
            || handoff.inputDigest !== taskInputDigest(task) || handoff.scopeDigest !== taskScopeDigest(task)) throw new Error('ARTIFACT_REUSE_SCOPE_CHANGED: no matching verified handoff for these bytes, inputs and task scope')
          const artifactRoot = await realpath(join(stateRoot, team.id, task.project.artifactsPath))
          const source = await realpath(join(artifactRoot, previous.relativePath))
          const rel = relative(artifactRoot, source)
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('ARTIFACT_REUSE_PATH_INVALID')
          content = await readFile(source)
          if (createHash('sha256').update(content).digest('hex') !== previous.sha256) throw new Error('ARTIFACT_REUSE_BYTES_CHANGED: old publication no longer matches its SHA')
          reusedFrom = { artifactId: previous.id, attempt: previous.attempt, inputDigest: handoff.inputDigest, scopeDigest: handoff.scopeDigest, reason: args.reuse_reason.trim() }
        } else {
          if (args.source_path === undefined || args.expected_sha256 !== undefined || args.reuse_reason !== undefined) throw new Error('ARTIFACT_SOURCE_REQUIRED: provide source_path and name, or explicit reuse_artifact_id with SHA and reason')
          const parts = args.source_path.replaceAll('\\', '/').split('/')
          if (isAbsolute(args.source_path) || parts.some(part => part === '..' || part === '.' || part === '')) throw new Error(`Artifact source must be a clean relative project path. projectRoot=${resolve(stateRoot, team.id, task.project.path)}; source_path="artifacts/report.md" is relative to this own project. Absolute paths, ./ and ../ remain forbidden.`)
          const project = await realpath(join(stateRoot, team.id, task.project.path))
          const source = await realpath(join(project, ...parts))
          const rel = relative(project, source)
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Artifact source escapes the task project')
          content = await readFile(source)
        }
        const artifact = await publishTaskArtifact(stateRoot, team, task, { name: args.name, content, mediaType: args.media_type, description: args.description, ...(reusedFrom === undefined ? {} : { reusedFrom }) })
        if (!task.publishedArtifacts?.some(a => a.id === artifact.id)) task.publishedArtifacts = [...(task.publishedArtifacts ?? []), artifact]
        if (amendedRun !== undefined) setQualityRun(team, amendedRun)
        task.updatedAt = Date.now()
        await writeTeam(stateRoot, team)
        return { task_id: task.id, artifact_id: artifact.id, review_artifact_id: artifact.reviewId!, attempt: artifact.attempt, sha256: artifact.sha256, size_bytes: artifact.sizeBytes, path: publishedEvidencePath(team, task, artifact) }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_read_artifact',
    description: 'Read a pinned dependency artifact after checking its published hash. Text is paginated to avoid loading whole files into the conversation.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Consumer task whose input manifest pins this upstream artifact; not the source task.' }, source_task_id: { type: 'string', required: true, description: 'Completed dependency named in the consumer input manifest.' }, artifact_id: { type: 'string', required: true, description: 'Immutable artifact UUID from that manifest, never a published:* review_artifact_id.' },
      offset: { type: 'number', description: 'Text character offset, default 0.' }, limit: { type: 'number', description: 'Maximum characters, default 4000, maximum 16000.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const located = await requireParticipantTeam(workspace, config, caller)
      return withTeamLock(teamLockKey(stateRoot, located.id), async () => {
        const { team, identity } = await requireFreshParticipant(stateRoot, located.id, caller.id)
        const task = requireTask(team, args.task_id)
        if (identity.kind !== 'captain' && task.assignee !== identity.name) throw new Error('Cannot read another task project')
        if (task.id === args.source_task_id || args.artifact_id.startsWith('published:')) throw new Error(`PINNED_INPUT_REQUIRED: task_id is the downstream consumer, source_task_id is its completed dependency, artifact_id is the immutable UUID from inputArtifactManifest; review_artifact_id (published:*) is only a quality binding name. This API does not read a task's own output. For captain review, read the exact absolute versionPath shown by expert_teams_status. Dependency and pin checks are unchanged.`)
        const { artifact, content, encoding } = await readAllowedTaskArtifact(stateRoot, team, task, { sourceTaskId: args.source_task_id, artifactId: args.artifact_id })
        if (encoding === 'base64') {
          const source = requireTask(team, args.source_task_id)
          return asToolJsonObject({ artifact_id: artifact.id, sha256: artifact.sha256, size_bytes: artifact.sizeBytes, binary: true, path: `${team.id}/${source.project!.artifactsPath}/${artifact.relativePath}`.replaceAll('\\', '/'), content: 'Binary artifact verified; read the file at the returned path with the appropriate viewer.', next_offset: null })
        }
        const offset = args.offset ?? 0
        const limit = args.limit ?? 4000
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000) throw new Error('Invalid artifact pagination')
        const page = content.slice(offset, offset + limit)
        const nextOffset = offset + limit < content.length ? offset + limit : null
        return asToolJsonObject({ artifact_id: artifact.id, sha256: artifact.sha256, size_bytes: artifact.sizeBytes,
          offset, total_characters: content.length, returned_characters: page.length,
          content: page, next_offset: nextOffset, eof: nextOffset === null,
          notice: nextOffset === null
            ? 'End of artifact. Do not increase offset. Use the content already read; start at offset 0 only if earlier pages are missing.'
            : `Continue at next_offset=${nextOffset}. Offsets and lengths count JavaScript UTF-16 code units, not bytes.` })
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_reassign_task',
    description: 'Guarded retry or reassignment using current expected_attempt and expected_attempt_id. Running owners, recent publications, pending review and external blockers cannot be bypassed by takeover. Use the existing submission/review flow for finished work; assignee="captain" requests captain takeover only after admission.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task to retry/reassign.' },
      expected_attempt: { type: 'number', required: true, description: 'Current attempt from task status; stale observations cannot revoke new work.' },
      expected_attempt_id: { type: 'string', description: 'Current attempt_id, required whenever the task has one.' },
      assignee: { type: 'string', required: true, description: 'Active member name, or "captain" for captain takeover.' },
      reason: { type: 'string', description: 'Why the task is being retried or reassigned.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          previous_assignee: { type: 'string', required: true },
          assignee: { type: 'string', required: true },
          status: { type: 'string', required: true },
          attempt: { type: 'number', required: true },
          attempt_id: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} reassigned ${value.previous_assignee || 'unassigned'} → ${value.assignee} (attempt ${value.attempt}, status ${value.status}${value.attempt_id ? `, attempt_id ${value.attempt_id}` : ''}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      const target = args.assignee.trim()
      if (target === '') throw new Error('reassignment assignee must not be empty')
      const reassignmentReason = args.reason?.trim()

      const revoked = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        assertTeamRunnable(fresh)
        const task = requireTask(fresh, args.task_id)
        if (task.humanChoice !== undefined) throw new Error('HUMAN_CHOICE_HOST_ONLY: selection nodes cannot be reassigned')
        if (task.status === 'completed') throw new Error(`completed task ${task.id} is immutable and cannot be reassigned`)
        if (task.reassigning === true) throw new Error(`task ${task.id} is already being reassigned`)
        if (!reassignmentReason) throw new Error('REASSIGNMENT_REASON_REQUIRED: state the observed handoff reason')
        const targetMember = target === CAPTAIN_KEY ? undefined : requireMember(fresh, target)
        if (targetMember !== undefined) {
          const busy = memberOpenTask(fresh, targetMember.name, task.id)
          if (busy !== undefined) {
            throw new Error(`member "${targetMember.name}" is busy with ${busy.id}; finish or reassign it first`)
          }
        }
        const previousAssignee = task.assignee ?? ''
        const previousMember = (task.status !== 'claimed' && task.status !== 'in_progress')
          || task.assignee === undefined || task.assignee === CAPTAIN_KEY
          ? undefined
          : fresh.members.find(member => member.name === task.assignee && member.status !== 'removed')
        const previousRun = fresh.qualityRuns?.[task.id]
          ?? (fresh.qualityRun?.contract.taskId === task.id ? fresh.qualityRun : undefined)
        const owner = fresh.members.find(member => member.name === task.assignee && member.status !== 'removed')
        const activity = owner === undefined ? 'idle' : ctx.agents.get(owner.id as SessionId)?.status
          ?? (await memberActivity(ctx, fresh.captainSessionId)).get(owner.id) ?? 'unknown'
        const observation = checkTaskReassignment(task, { expectedAttempt: args.expected_attempt,
          expectedAttemptId: args.expected_attempt_id, member: owner, activity, quality: previousRun,
          now: Date.now(), graceMs: config.reassignmentGraceMs })
        if ((task.reassignmentHistory?.length ?? 0) >= 64) throw new Error('REASSIGNMENT_HISTORY_LIMIT: create a separately reviewed follow-up task')
        task.reassignmentHistory = [...(task.reassignmentHistory ?? []), { ...observation, reason: reassignmentReason, target }]
        if (previousRun !== undefined) {
          const nextAttempt = (task.attempt ?? 0) + 1
          if (previousRun.attempt !== nextAttempt || previousRun.contract.assignee !== target || previousRun.status !== 'pending') {
            const revised = forkQualityRun(previousRun, {
              eventId: `reassign-${randomUUID()}`, actor: CAPTAIN_KEY,
              reason: args.reason?.trim() || `Reassign task to ${target}`,
              assignee: target, attempt: nextAttempt,
            })
            assertDurableQualityRun(revised.run)
            replaceQualityRun(fresh, previousRun, revised.run)
          }
        }
        invalidateTaskAttempt(task, target, true)
        if (previousMember?.capabilityScope !== undefined) {
          previousMember.capabilityScope = revokeCapabilityTask(previousMember.capabilityScope, task.id)
        }
        if (targetMember?.capabilityScope !== undefined) {
          targetMember.capabilityScope = grantCapabilityTask(targetMember.capabilityScope, task.id)
        }
        await writeTeam(stateRoot, fresh)
        return {
          previousAssignee,
          previousMember: previousMember === undefined ? undefined : { ...previousMember },
          handoffId: task.handoffId,
        }
      })

      let quiescenceError: unknown
      if (revoked.previousMember !== undefined) {
        interruptMember(ctx, captain, revoked.previousMember.id)
        try {
          await waitForMemberIdle(ctx, revoked.previousMember, exec.signal)
        } catch (error: unknown) {
          quiescenceError = error
        }
      }

      await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const task = requireTask(fresh, args.task_id)
        if (task.handoffId !== revoked.handoffId || task.assignee !== target || task.reassigning !== true) {
          throw new Error(`task ${task.id} changed during reassignment; refusing to overwrite the newer state`)
        }
        task.reassigning = false
        if (quiescenceError === undefined && target === CAPTAIN_KEY) {
          await prepareClaimInputs(stateRoot, fresh, task)
          beginTaskAttempt(task, CAPTAIN_KEY)
          await syncTaskProjectInput(stateRoot, fresh, task)
        }
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captain.session, 'expert-teams/task-updated', {
          teamId: fresh.id,
          taskId: task.id,
          status: task.status,
          assignee: task.assignee,
          ...args.reason === undefined ? {} : { output: `Reassigned: ${args.reason}` },
        })
      })
      if (quiescenceError !== undefined) throw quiescenceError
      if (target !== CAPTAIN_KEY) await scheduler.kickMember(workspace, team.id, target, captain)
      const current = await readTeam(stateRoot, team.id)
      const task = current === undefined ? undefined : requireTask(current, args.task_id)
      if (task === undefined) throw new Error(`team "${team.name}" ended during reassignment`)
      return {
        task_id: task.id,
        previous_assignee: revoked.previousAssignee,
        assignee: task.assignee ?? '',
        status: task.status,
        attempt: task.attempt ?? 0,
        ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_claim_task',
    description: 'Claim one ready task for a member (or yourself). A member cannot own a second unfinished task. The returned attempt_id is required for that member\'s updates and becomes stale after retry/reassignment.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The task id to claim.' },
      assignee: { type: 'string', description: 'Active member name or "captain" (captain only; defaults to the task\'s assignee).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          assignee: { type: 'string', required: true },
          attempt: { type: 'number', required: true },
          attempt_id: { type: 'string' },
          craft_materials: { type: 'string' },
          task_materials: { type: 'string' },
          task_material_digest: { type: 'string' },
          repair_feedback: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} claimed by ${value.assignee} (attempt ${value.attempt}${value.attempt_id ? `, attempt_id ${value.attempt_id}` : ''}, status ${value.status}).${value.repair_feedback ? '\n\n' + value.repair_feedback : ''}${value.craft_materials ? '\n\n' + value.craft_materials : ''}${value.task_materials ? '\n\n' + value.task_materials : ''}`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireParticipantTeam(workspace, config, caller)
      return withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, caller.id)
        assertTeamRunnable(fresh)
        const task = requireTask(fresh, args.task_id)
        if (task.humanChoice !== undefined) throw new Error('HUMAN_CHOICE_HOST_ONLY: this task requires an authenticated user selection in the Host panel')
        if (task.waitReason?.startsWith('USER_PAUSED:')) throw new Error('TASK_PAUSED_BY_USER: wait for an explicit restart before updating')
        const quality = fresh.qualityRuns?.[task.id]
          ?? (fresh.qualityRun?.contract.taskId === task.id ? fresh.qualityRun : undefined)
        if (quality?.status === 'escalated') throw new Error('QUALITY_ESCALATED_CLOSEOUT_REQUIRED: close out the exhausted review before claiming this task')
        if (task.reassigning === true) {
          throw new Error(`task ${task.id} is being reassigned; wait for the handoff to finish`)
        }
        let assignee = task.assignee
        if (identity.kind === 'captain') {
          if (args.assignee !== undefined) {
            if (args.assignee !== CAPTAIN_KEY) requireMember(fresh, args.assignee)
            assignee = args.assignee
          }
        } else {
          if (args.assignee !== undefined) {
            throw new Error('members cannot set assignee when claiming a task')
          }
          if (assignee !== undefined && assignee !== identity.name) {
            throw new Error(`task ${task.id} is assigned to "${assignee}", not you`)
          }
          assignee = identity.name
        }
        if (TERMINAL_TASK_STATUSES.includes(task.status)) throw new Error(terminalTaskAdvice(task))
        // Authorization must happen before the idempotent return: another
        // member must not receive a false success for somebody else's task.
        if (task.status === 'claimed' || task.status === 'in_progress') {
          if (assignee === undefined || task.assignee !== assignee) {
            throw new Error(`task ${task.id} is already claimed by "${task.assignee ?? 'nobody'}"`)
          }
          const craft = prepareCraftDelivery(task, caller.id, task.attempt ?? 1, ['writer', 'renderer'], 'claim')
          const taskMaterials = prepareTaskMaterialDelivery(task, caller.id, task.attempt ?? 1, 'producer', true)
          if (assignee === identity.name) { saveCraftDelivery(task, craft.receipts); saveTaskMaterialDelivery(task, taskMaterials.receipt); await writeTeam(stateRoot, fresh) }
          await syncTaskProjectInput(stateRoot, fresh, task)
          return {
            ...(craft.content === '' || assignee !== identity.name ? {} : { craft_materials: craft.content }),
            ...(taskMaterials.content === '' || assignee !== identity.name ? {} : { task_materials: taskMaterials.content, task_material_digest: taskMaterials.receipt?.digest }),
            ...repairFeedbackResult(fresh, task, stateRoot),
            task_id: task.id,
            status: task.status,
            assignee,
            attempt: task.attempt ?? 0,
            ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
          }
        }
        const pending = unsatisfiedDependencies(fresh.tasks, task.dependencies)
        if (pending.length > 0) {
          const reviewable = pending.filter(id => fresh.tasks.find(source => source.id === id)?.executionState === 'awaiting_review')
          throw new Error(`task ${task.id} is blocked by unfinished dependencies: ${pending.join(', ')} — complete them first.${reviewable.length === 0 ? '' : ` An authorized independent reviewer can inspect and call expert_teams_quality_review on already-submitted dependency ${reviewable.join(', ')} without claiming this downstream task; inspect its status review_contract first. A passed review still needs captain quality_integrate before this downstream task becomes ready.`}`)
        }
        if (task.executionState === 'blocked_external') throw new Error(`task ${task.id} is externally blocked; only captain resume_task may release its durable blocker`)
        const transition = transitionError(task.status, 'claimed')
        if (transition !== undefined) throw new Error(transition)
        if (assignee === undefined) {
          throw new Error('claiming an unassigned task needs assignee="captain" for your own work, or an active member name')
        }
        const busy = memberOpenTask(fresh, assignee, task.id)
        if (busy !== undefined) {
          throw new Error(`member "${assignee}" is busy with ${busy.id}; finish or reassign it first`)
        }
        await prepareClaimInputs(stateRoot, fresh, task)
        const craft = prepareCraftDelivery(task, caller.id, (task.attempt ?? 0) + 1, ['writer', 'renderer'], 'claim')
        const taskMaterials = prepareTaskMaterialDelivery(task, caller.id, (task.attempt ?? 0) + 1, 'producer', true)
        const attemptId = beginTaskAttempt(task, assignee)
        if (assignee === identity.name) saveCraftDelivery(task, craft.receipts)
        if (assignee === identity.name) saveTaskMaterialDelivery(task, taskMaterials.receipt)
        await syncTaskProjectInput(stateRoot, fresh, task)
        const owner = assignee === CAPTAIN_KEY ? undefined : fresh.members.find(member => member.name === assignee)
        if (owner?.capabilityScope !== undefined) owner.capabilityScope = grantCapabilityTask(owner.capabilityScope, task.id)
        await writeTeam(stateRoot, fresh)
        const customerEvents = []
        const occurrence = createHash('sha256').update(`${fresh.id}:${task.id}:${task.attempt ?? 1}`).digest('hex')
        if (owner?.capabilityScope?.expertId) customerEvents.push(recordCustomerUsage({ kind: 'expert',
          id: owner.capabilityScope.expertId, sessionId: fresh.captainSessionId, workspace, occurrence }))
        if (assignee === identity.name && taskMaterials.receipt) {
          for (const skill of task.frozenTaskMaterialContract?.skills ?? []) {
            customerEvents.push(recordCustomerUsage({ kind: 'skill', id: skill.skillId,
              version: skill.packVersion, sessionId: fresh.captainSessionId, workspace,
              occurrence: createHash('sha256').update(`${occurrence}:${skill.packId}:${skill.skillId}`).digest('hex') }))
            if (skill.packId !== 'dsh-expert-library') customerEvents.push(recordCustomerUsage({ kind: 'pack',
              id: skill.packId, version: skill.packVersion, sessionId: fresh.captainSessionId, workspace,
              occurrence: createHash('sha256').update(`${occurrence}:${skill.packId}`).digest('hex') }))
          }
        }
        await Promise.allSettled(customerEvents)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'expert-teams/task-updated', {
          teamId: fresh.id,
          taskId: task.id,
          status: task.status,
          assignee: task.assignee,
        })
        return {
          ...(craft.content === '' || assignee !== identity.name ? {} : { craft_materials: craft.content }),
          ...(taskMaterials.content === '' || assignee !== identity.name ? {} : { task_materials: taskMaterials.content, task_material_digest: taskMaterials.receipt?.digest }),
          ...repairFeedbackResult(fresh, task, stateRoot),
          task_id: task.id,
          status: task.status,
          assignee: task.assignee ?? '',
          attempt: task.attempt ?? 0,
          attempt_id: attemptId,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_update_task',
    description: 'Update a task status/output. Members must supply the current attempt_id returned by claim_task; stale attempts are rejected after takeover/reassignment. Terminal results are immutable. A captain must use reassign_task(assignee="captain") before updating member-owned work. Completing a task runs the team plan\'s quality gates: a failing hard gate blocks the completion with gate id, reason and correction guidance (fix the output and retry); soft-gate warnings are returned as gate_warnings; the derived 0-100 quality score is stamped into the task title as 「质 NN」(「质 NN·硬门未过」 when a hard gate blocks).',
    parameters: {
      submission_id: { type: 'string', description: 'Compact v4 atomic submission id. Use with publications, nonempty output, status=in_progress and execution_state=awaiting_review. Exact retries return the original receipt.' },
      publications: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, source_path: { type: 'string', required: true } } }, description: 'Every declared file, relative to this task project; Host publishes and submits all files in one transaction.' },
      task_id: { type: 'string', required: true, description: 'The task id to update.' },
      status: {
        type: 'string',
        enum: ['in_progress', 'completed', 'failed', 'cancelled'],
        description: 'New status. Advance claimed work to in_progress before completion. For reviewed work, the captain should use quality_integrate(complete_task=true). Do not combine a terminal status with execution_state.',
      },
      output: { type: 'string', description: 'Nonempty result summary/results required before awaiting_review; also set when completing or failing. This tool writes managed output/result.json; editing that file directly does not submit task.output.' },
      attempt_id: { type: 'string', description: 'Current execution capability returned by claim_task (required for members when present on the task).' },
      execution_state: { type: 'string', enum: ['active', 'awaiting_review', 'blocked_external', 'interrupted'], description: 'Only for claimed/in_progress unfinished work; omit with completed/failed/cancelled. Persist awaiting_review after submitting evidence, or blocked_external with wait_reason. Waiting tasks are not automatically redispatched.' },
      wait_reason: { type: 'string', description: 'Concrete condition that must change before work resumes; required for blocked_external.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          output: { type: 'string' },
          attempt: { type: 'number', required: true },
          attempt_id: { type: 'string' },
          execution_state: { type: 'string' },
          wait_reason: { type: 'string' },
          gate_warnings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Non-blocking quality warnings attached at completion. Hard failures require resolution or escalation.',
          },
          quality_score: {
            oneOf: [{ type: 'number' }, { type: 'null' }],
            required: true,
            description: 'Forced-recovery field: derived 0-100 quality score of the last gated run (null when the team has no resolvable quality policy — the key is always present).',
          },
          repair_count: {
            type: 'number',
            required: true,
            description: 'Forced-recovery field: repair rounds used (hard-gate blocks) at the last completion attempt (0 when none).',
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} attempt ${value.attempt} → ${value.status}${value.output !== undefined ? `\nOutput: ${value.output}` : ''}\n质量分 ${value.quality_score ?? '—'} ｜ 修复 ${value.repair_count} 轮${value.gate_warnings !== undefined ? `\nQuality warnings:\n- ${value.gate_warnings.join('\n- ')}` : ''}`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireParticipantTeam(workspace, config, caller)
      const updated = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, caller.id)
        assertTeamRunnable(fresh)
        const task = requireTask(fresh, args.task_id)
        if (task.humanChoice !== undefined) throw new Error('HUMAN_CHOICE_HOST_ONLY: this task requires an authenticated user selection in the Host panel')
        if (identity.kind === 'captain'
          && task.assignee !== undefined
          && task.assignee !== CAPTAIN_KEY) {
          throw new Error(`task ${task.id} is owned by member "${task.assignee}"; call expert_teams_reassign_task with assignee="captain" before takeover`)
        }
        if (identity.kind === 'member') {
          if (task.assignee !== identity.name) {
            throw new Error(`task ${task.id} is assigned to "${task.assignee ?? 'nobody'}", not you`)
          }
          if (task.attemptId !== undefined && args.attempt_id !== task.attemptId) {
            throw new Error(`stale attempt for task ${task.id}: expected the current attempt_id; stop work and request fresh assignment`)
          }
        }
        const submitFingerprint = submissionFingerprint({ submission_id: args.submission_id, publications: args.publications, output: args.output, attempt_id: args.attempt_id, status: args.status, execution_state: args.execution_state, wait_reason: args.wait_reason })
        if (args.submission_id !== undefined || args.publications !== undefined) {
          if (!isCompactResearch(fresh) || !args.submission_id?.trim() || args.submission_id.length > 180 || !args.publications || args.status !== 'in_progress' || args.execution_state !== 'awaiting_review' || !args.output?.trim()) throw new Error('SUBMISSION_INPUT_INVALID: V4/V5 require submission_id, all publications, output, in_progress and awaiting_review')
          if (task.submissionReceipt?.id === args.submission_id) {
            if (task.submissionReceipt.fingerprint !== submitFingerprint || task.submissionReceipt.attempt !== task.attempt || args.attempt_id !== (task.attemptId ?? task.finalizedAttemptId)) throw new Error('SUBMISSION_IDEMPOTENCY_CONFLICT')
            return { task_id: task.id, status: task.status, attempt: task.attempt ?? 0, output: task.output, execution_state: task.executionState, quality_score: task.qualityScore ?? null, repair_count: task.repairCount ?? 0 }
          }
        }
        if (TERMINAL_TASK_STATUSES.includes(task.status)) {
          const sameStatus = args.status === undefined || args.status === task.status
          const sameOutput = args.output === undefined || args.output === task.output
          if (!sameStatus || !sameOutput || args.execution_state !== undefined || args.wait_reason !== undefined) {
            throw new Error(`terminal task ${task.id} is immutable; use expert_teams_reassign_task to retry failed/cancelled work`)
          }
          return {
            task_id: task.id,
            status: task.status,
            attempt: task.attempt ?? 0,
            ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
            ...task.output !== undefined ? { output: task.output } : {},
            ...task.gateWarnings !== undefined && task.gateWarnings.length > 0 ? { gate_warnings: [...task.gateWarnings] } : {},
            quality_score: task.qualityScore ?? null,
            repair_count: task.repairCount ?? 0,
          }
        }
        if (isCompactResearch(fresh) && task.executionState === 'awaiting_review') throw new Error('RESEARCH_SUBMISSION_FROZEN: use an exact submission retry or an authorized quality repair')
        const escalatedRun = fresh.qualityRuns?.[task.id]
          ?? (fresh.qualityRun?.contract.taskId === task.id ? fresh.qualityRun : undefined)
        if (escalatedRun?.status === 'escalated') throw new Error('QUALITY_ESCALATED_CLOSEOUT_REQUIRED: only the captain may close out this exhausted review')
        const craftRun = fresh.qualityRuns?.[task.id] ?? (fresh.qualityRun?.contract.taskId === task.id ? fresh.qualityRun : undefined)
        if (craftRun !== undefined && args.status !== 'failed' && args.status !== 'cancelled' && args.execution_state !== 'blocked_external') requireCraftProducerDelivery(fresh, task, craftRun)
        if (args.status !== 'failed' && args.status !== 'cancelled' && args.execution_state !== 'blocked_external') requireTaskMaterialDelivery(task, caller.id, task.attempt ?? 1, 'producer')
        // Pre-update snapshot for the compensating commit below (project
        // files are restored from it when the team write fails).
        const snapshot: TeamTask = {
          ...task,
          ...task.project === undefined ? {} : { project: { ...task.project } },
        }
        if (args.publications !== undefined) await prepareResearchSubmission(stateRoot, fresh, task, args.publications)
        if (args.execution_state !== undefined) {
          if (args.status !== undefined && args.status !== 'in_progress') throw new Error(`execution_state is only valid for unfinished work; task ${task.id} is ${task.status}/${task.executionState ?? 'active'}. Omit execution_state and wait_reason with terminal status=${args.status}; reviewed work must use captain quality_integrate(complete_task=true) after the owner advances the same attempt to in_progress`)
          if (args.execution_state === 'active' && task.executionState !== undefined && task.executionState !== 'active') throw new Error('Use captain resume_task or quality repair/reopen/acceptance to release waiting work')
          if (task.executionState === 'awaiting_review' && args.execution_state !== 'awaiting_review') throw new Error('Use quality repair/reopen/acceptance to resolve review waiting')
          if (task.executionState === 'blocked_external' && args.execution_state !== 'blocked_external') throw new Error('Use captain resume_task to release externally blocked work')
          if (task.status !== 'claimed' && task.status !== 'in_progress') throw new Error('claim the task before setting execution_state')
          if (args.execution_state === 'blocked_external' && !args.wait_reason?.trim()) throw new Error('blocked_external requires a concrete wait_reason')
          if (args.execution_state === 'awaiting_review' && !(args.output ?? task.output)?.trim()) throw new Error(`awaiting_review requires a submitted result. Call expert_teams_update_task(task_id=${JSON.stringify(task.id)}${task.attemptId === undefined ? '' : `, attempt_id=${JSON.stringify(task.attemptId)}`}, execution_state="awaiting_review", output="<complete reviewable content>"). Quality structure gates inspect the task output field, not separately published files. This tool writes managed output/result.json; editing that file directly does not set task.output.`)
          if (args.execution_state === 'awaiting_review') {
            const run = fresh.qualityRuns?.[task.id] ?? (fresh.qualityRun?.contract.taskId === task.id ? fresh.qualityRun : undefined)
            if (run !== undefined) {
              // Refuse an incomplete submission before changing the task or
              // durable result. Prior-attempt files do not satisfy this gate.
              const present = new Set((task.publishedArtifacts ?? []).filter(artifact => artifact.attempt === task.attempt).map(artifact => artifact.reviewId))
              const missing = run.contract.deliverables.filter(id => id.startsWith('published:') && !present.has(id))
              if (missing.length > 0) throw new Error(`REVIEW_SUBMISSION_INCOMPLETE: publish all required deliverables for current attempt ${task.attempt} before awaiting_review: ${missing.join(', ')}. Task and output were not changed; publish the same deliverable names first, then resubmit.`)
              currentPublishedDeliverables(task, run)
            }
          }
        } else if (args.wait_reason !== undefined) {
          throw new Error('wait_reason requires execution_state')
        }
        // Quality gates on completion. The gate chain is evaluated BEFORE any
        // status/output mutation, so a block persists ONLY the repair-budget
        // counter, the quality-score subject marker and the forced
        // qualityScore/repairCount fields, and leaves the task
        // claimed/in_progress (status, output and attemptId untouched) — the
        // member fixes the output and retries with the same attempt. Soft-gate
        // warnings are
        // attached to the task result; the derived score is stamped into the
        // task title as 「质 NN」(idempotent — repeated evaluations replace the
        // old marker). No resolvable policy ⇒ undefined ⇒ exactly today's
        // behavior (no marker), except the task still records
        // qualityScore: null / repairCount: 0 — the fields are ALWAYS present
        // (forced recovery, never left to the member's output).
        let gateWarnings: readonly string[] | undefined
        if (args.status === 'completed' && isV5WorkingTask(fresh,task)) throw new Error('V5_ATOMIC_SUBMISSION_REQUIRED: submit declared publications with submission_id, in_progress and awaiting_review; Host validates and completes internal work atomically')
        if (args.status === 'completed') {
          const structuredRun = fresh.qualityRuns?.[task.id]
            ?? (fresh.qualityRun?.contract.taskId === task.id ? fresh.qualityRun : undefined)
          if (structuredRun !== undefined && structuredRun.status !== 'integrated') {
            throw new Error(`QUALITY_REVIEW_REQUIRED: task ${task.id} is ${task.status}, quality=${structuredRun.status}; ${structuredRun.status === 'passed' ? 'the captain must call quality_integrate with a new integration event_id and complete_task=true after the owner advances this same attempt to in_progress' : 'complete independent review and captain integration before completion; use quality_repair for a blocked review'}`)
          }
          if (structuredRun !== undefined) {
            requireReviewedTaskOutputCurrent(fresh, structuredRun, args.output ?? task.output)
            await requireReviewedArtifactsCurrent(stateRoot, fresh, structuredRun)
            if (structuredRun.latestEvidence !== undefined) validateArtifactCheckFreshness(structuredRun.latestEvidence)
          }
          const transition = transitionError(task.status, 'completed')
          if (transition !== undefined) throw new Error(`${transition}; current task=${task.id}, attempt=${task.attempt ?? 0}. ${task.status === 'claimed' ? 'The current owner must first update this same attempt to in_progress, then request completion' : 'Inspect the current task state and use the supported claim/repair flow'}`)
          await enforceCompletionGates(stateRoot, fresh, task, args.output ?? task.output)
          gateWarnings = task.gateWarnings
        }
        if (args.status !== undefined) {
          const transition = transitionError(task.status, args.status)
          if (transition !== undefined) throw new Error(transition)
          task.status = args.status
        }
        if (args.output !== undefined) task.output = args.output
        if (args.execution_state !== undefined) {
          task.executionState = args.execution_state
          task.waitReason = args.execution_state === 'awaiting_review'
            ? args.wait_reason?.trim() || 'Submitted; waiting for independent quality review.'
            : args.execution_state === 'blocked_external' ? args.wait_reason!.trim() : undefined
        }
        if (args.submission_id && isV5WorkingTask(fresh,task)) { task.researchRelease=workingRelease(task); task.status='completed'; task.executionState=undefined; task.waitReason=undefined }
        if (gateWarnings !== undefined) task.gateWarnings = gateWarnings
        // Terminal work drops its live capability: stale-claim checks and
        // audit views must never see a lingering attemptId on dead work.
        finalizeTerminalTask(task)
        task.updatedAt = Date.now()
        if (args.submission_id !== undefined) task.submissionReceipt = { id: args.submission_id, fingerprint: submitFingerprint, attempt: task.attempt!, artifactDigest: canonicalDigest((task.publishedArtifacts ?? []).filter(a => a.attempt === task.attempt)) }
        // Compensating commit: project output first, team record second, with
        // a snapshot rollback when the team write fails (see commitTaskUpdate).
        await commitTaskUpdate(stateRoot, fresh, task, snapshot)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'expert-teams/task-updated', {
          teamId: fresh.id,
          taskId: task.id,
          status: task.status,
          ...task.assignee !== undefined ? { assignee: task.assignee } : {},
          ...task.output !== undefined ? { output: task.output } : {},
          ...task.gateWarnings !== undefined ? { gateWarnings: [...task.gateWarnings] } : {},
        })
        return {
          task_id: task.id,
          status: task.status,
          attempt: task.attempt ?? 0,
          ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
          ...task.output !== undefined ? { output: task.output } : {},
          ...task.executionState === undefined ? {} : { execution_state: task.executionState },
          ...task.waitReason === undefined ? {} : { wait_reason: task.waitReason },
          ...task.gateWarnings !== undefined && task.gateWarnings.length > 0 ? { gate_warnings: [...task.gateWarnings] } : {},
          quality_score: task.qualityScore ?? null,
          repair_count: task.repairCount ?? 0,
        }
      })
      await scheduler.kickTeam(workspace, team.id, team.captainSessionId === caller.id ? caller : undefined)
      return updated
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_send_message',
    description: 'Send a message to the captain or to a teammate. Messages go straight into the recipient\'s mailbox; when the captain agent is online the plugin also schedules live delivery (member recipients get the message as their next turn; a running captain sees it at the nearest model step). No relay is involved: teammates talk to each other directly, exactly like the Claude Code Expert Teams mailbox model.',
    parameters: {
      to: { type: 'string', required: true, description: 'Recipient: "captain" or a member name.' },
      content: { type: 'string', required: true, description: 'The message text.' },
      from: { type: 'string', description: 'Sender (defaults to the caller: the captain, or the calling member).' },
      task_id: { type: 'string', description: 'Optional source task. Members may only send for their currently assigned task.' },
      attempt_id: { type: 'string', description: 'Optional source attempt id; stale attempts are rejected before delivery.' },
      idempotency_key: { type: 'string', description: 'Optional stable key. Repeated sends with the same key are delivered once.' },
      sequence: { type: 'number', description: 'Optional sender sequence. Omit to allocate the next mailbox sequence.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message_id: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          delivered: { type: 'string', required: true, description: 'live (accepted by the live captain), wake (member recipient woken), or mailbox (durable inbox only).' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Message ${value.message_id} ${value.from} → ${value.to} delivered via ${value.delivered}.`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireParticipantTeam(workspace, config, caller)
      const to = args.to.trim()
      const prepared = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, caller.id)
        const from = identity.name
        // `from` may only be the caller's own identity: impersonating another
        // member (or the captain) would poison the mailbox and event records.
        if (args.from !== undefined && args.from !== from) {
          throw new Error(`expert_teams_send_message: "from" must be your own identity ("${from}"), not "${args.from}"`)
        }
        const requestedTaskId = args.task_id?.trim() || undefined
        const sourceTask = requestedTaskId === undefined
          ? identity.kind === 'member'
            ? fresh.tasks.find(task => task.assignee === identity.name
              && (task.status === 'claimed' || task.status === 'in_progress')
              && task.attemptId !== undefined)
            : undefined
          : requireTask(fresh, requestedTaskId)
        if (sourceTask !== undefined && identity.kind === 'member' && sourceTask.assignee !== identity.name) {
          throw new Error(`message source task ${sourceTask.id} is assigned to "${sourceTask.assignee ?? 'nobody'}", not you`)
        }
        if (args.attempt_id !== undefined) {
          if (sourceTask === undefined) throw new Error('message attempt_id requires task_id or an active member task')
          const expectedAttemptId = sourceTask.attemptId ?? sourceTask.finalizedAttemptId
          if (expectedAttemptId !== args.attempt_id) {
            throw new Error(`stale attempt for message task ${sourceTask.id}: expected the current attempt_id`)
          }
        }
        if (sourceTask !== undefined && TERMINAL_TASK_STATUSES.includes(sourceTask.status)) {
          // Terminal work may only emit a message when the caller explicitly
          // presents the exact generation retired at finalization. This keeps
          // the compatibility path for delayed completion mail while blocking
          // unbound post-terminal/proxy messages.
          if (args.attempt_id === undefined || sourceTask.finalizedAttemptId === undefined || args.attempt_id !== sourceTask.finalizedAttemptId) {
            throw new Error(`terminal task ${sourceTask.id} requires its finalized attempt_id to send a message. ${terminalTaskAdvice(sourceTask)}`)
          }
        }
        const provenance = sourceTask === undefined
          ? {
            ...(args.sequence === undefined ? {} : { sequence: args.sequence }),
            ...(args.idempotency_key === undefined ? {} : { idempotencyKey: args.idempotency_key }),
          }
          : {
            sourceTaskId: sourceTask.id,
            ...sourceTask.attemptId === undefined && sourceTask.finalizedAttemptId === undefined
              ? {}
              : { sourceAttemptId: sourceTask.attemptId ?? sourceTask.finalizedAttemptId },
            sourceTaskStatus: sourceTask.status,
            ...(args.sequence === undefined ? {} : { sequence: args.sequence }),
            ...(args.idempotency_key === undefined ? {} : { idempotencyKey: args.idempotency_key }),
          }
        if (to === CAPTAIN_KEY) {
          const message = { ...createMessage(from, CAPTAIN_KEY, args.content, provenance), deliveryClaimedAt: Date.now() }
          const persisted = await appendMailbox(stateRoot, fresh.id, CAPTAIN_KEY, message)
          if (persisted.id !== message.id) return { kind: 'duplicate' as const, fresh, identity, message: persisted, from }
          appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'expert-teams/message-sent', {
            teamId: fresh.id,
            messageId: message.id,
            from,
            to: CAPTAIN_KEY,
            content: args.content,
            ts: message.ts,
          })
          return { kind: 'captain' as const, fresh, identity, message: persisted, from }
        }
        const recipient = requireMember(fresh, to)
        const message = { ...createMessage(from, recipient.name, args.content, provenance), deliveryClaimedAt: Date.now() }
        const persisted = await appendMailbox(stateRoot, fresh.id, recipient.name, message)
        if (persisted.id !== message.id) return { kind: 'duplicate' as const, fresh, identity, message: persisted, from, recipient }
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'expert-teams/message-sent', {
          teamId: fresh.id,
          messageId: message.id,
          from,
          to: recipient.name,
          content: args.content,
          ts: message.ts,
        })
        return { kind: 'member' as const, fresh, identity, message: persisted, from, recipient }
      })

      if (prepared.kind === 'duplicate') {
        return { message_id: prepared.message.id, from: prepared.message.from, to: prepared.message.to, delivered: 'mailbox' as const }
      }

      // The task may have been reassigned while the durable append lock was
      // released for live delivery. Re-check the generation before waking a
      // recipient; stale messages remain auditable but cannot revive old work.
      const currentTeam = await readTeam(stateRoot, prepared.fresh.id)
      if (currentTeam === undefined || currentTeam.halted === true
        || (prepared.kind === 'member' && !currentTeam.members.some(member => member.name === prepared.recipient.name && member.id === prepared.recipient.id && member.status !== 'removed'))) {
        if (currentTeam !== undefined) await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
          releaseMailboxDelivery(stateRoot, prepared.fresh.id, prepared.message.to, [prepared.message.id])
        ))
        return { message_id: prepared.message.id, from: prepared.message.from, to: prepared.message.to, delivered: 'mailbox' as const }
      }
      if (currentTeam !== undefined) {
        const admission = admitTeamMessage(currentTeam, prepared.message)
        if (!admission.accepted) {
          await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
            discardMailbox(stateRoot, prepared.fresh.id, prepared.message.to, [prepared.message.id], admission.reason)
          ))
          return { message_id: prepared.message.id, from: prepared.message.from, to: prepared.message.to, delivered: 'mailbox' as const }
        }
      }

      // Resolve the exact live captain only after releasing the state lock.
      // The plugin mailbox is already durable if live delivery cannot proceed.
      const captain = ctx.agents.get(prepared.fresh.captainSessionId as SessionId)
      if (prepared.kind === 'captain') {
        await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
          releaseMailboxDelivery(stateRoot, prepared.fresh.id, CAPTAIN_KEY, [prepared.message.id])
        ))
        await scheduler.kickTeam(workspace, prepared.fresh.id, captain)
        const receipt = (await readMailbox(stateRoot, prepared.fresh.id, CAPTAIN_KEY)).find(message => message.id === prepared.message.id)
        const delivered = receipt?.deliveredAt !== undefined && receipt.discardedAt === undefined ? 'live' : 'mailbox'
        return { message_id: prepared.message.id, from: prepared.from, to: CAPTAIN_KEY, delivered }
      }
      // The scheduler owns dispatch admission, including mailbox-only turns,
      // runtime blockers and the team's shared concurrency slots.
      await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
        releaseMailboxDelivery(stateRoot, prepared.fresh.id, prepared.recipient.name, [prepared.message.id])
      ))
      await scheduler.kickMember(workspace, prepared.fresh.id, prepared.recipient.name, captain)
      const receipt = (await readMailbox(stateRoot, prepared.fresh.id, prepared.recipient.name)).find(message => message.id === prepared.message.id)
      const delivered = receipt?.deliveredAt !== undefined && receipt.discardedAt === undefined ? 'wake' : 'mailbox'
      return {
        message_id: prepared.message.id,
        from: prepared.from,
        to: prepared.recipient.name,
        delivered,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_chat',
    description: '向团队内某位成员发起一轮追问（连续对话通道，P2.1）：不重建团队、不新建任务——消息进入成员 mailbox 并唤醒其新回合，回合计数累计在成员记录上（可追溯）。仅队长可用；用于对已完成/进行中的输出做澄清、口径修正或延伸追问。',
    parameters: {
      member: { type: 'string', required: true, description: '目标成员名（团队内 active 成员）。' },
      idempotency_key: { type: 'string', description: 'Stable retry key; retrying the same question will not wake the member again.' },
      content: { type: 'string', required: true, description: '追问内容（澄清问题/口径修正/延伸要求）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          member: { type: 'string', required: true },
          round: { type: 'number', required: true, description: '该成员的累计追问回合数。' },
          message_id: { type: 'string', required: true },
          delivered: { type: 'string', required: true, description: 'wake（成员被唤醒）或 mailbox（仅入箱）。' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `追问已发出：${value.member} 第 ${value.round} 轮（message ${value.message_id}，${value.delivered === 'wake' ? '成员已唤醒' : '已入 mailbox'}）。`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireParticipantTeam(workspace, config, captain)
      const memberName = args.member.trim()
      const prepared = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, captain.id)
        if (identity.kind !== 'captain') {
          throw new Error('expert_teams_chat 仅队长可用；成员间的追问请用 expert_teams_send_message')
        }
        assertTeamRunnable(fresh)
        const recipient = requireMember(fresh, memberName)
        const message = { ...createMessage(CAPTAIN_KEY, recipient.name, args.content, args.idempotency_key === undefined ? {} : { idempotencyKey: args.idempotency_key }), deliveryClaimedAt: Date.now() }
        const persisted = await appendMailbox(stateRoot, fresh.id, recipient.name, message)
        if (persisted.id !== message.id) return { fresh, recipient: { ...recipient }, message: persisted, round: recipient.chatRounds ?? 0, duplicate: true }
        recipient.chatRounds = (recipient.chatRounds ?? 0) + 1
        const round = recipient.chatRounds
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'expert-teams/chat-round', {
          teamId: fresh.id,
          messageId: message.id,
          member: recipient.name,
          round,
          content: args.content,
          ts: message.ts,
        })
        await writeTeam(stateRoot, fresh)
        return { fresh, recipient: { ...recipient }, message, round, duplicate: false }
      })
      if (prepared.duplicate) return { member: prepared.recipient.name, round: prepared.round, message_id: prepared.message.id, delivered: 'mailbox' }
      const currentTeam = await readTeam(stateRoot, prepared.fresh.id)
      if (currentTeam === undefined || currentTeam.halted === true
        || !currentTeam.members.some(member => member.name === prepared.recipient.name && member.id === prepared.recipient.id && member.status !== 'removed')) {
        if (currentTeam !== undefined) await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
          releaseMailboxDelivery(stateRoot, prepared.fresh.id, prepared.recipient.name, [prepared.message.id])
        ))
        return { member: prepared.recipient.name, round: prepared.round, message_id: prepared.message.id, delivered: 'mailbox' }
      }
      // Use the same scheduler admission for ordinary questions and reviews.
      const liveCaptain = ctx.agents.get(prepared.fresh.captainSessionId as SessionId)
      await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
        releaseMailboxDelivery(stateRoot, prepared.fresh.id, prepared.recipient.name, [prepared.message.id])
      ))
      await scheduler.kickMember(workspace, prepared.fresh.id, prepared.recipient.name, liveCaptain)
      const receipt = (await readMailbox(stateRoot, prepared.fresh.id, prepared.recipient.name)).find(message => message.id === prepared.message.id)
      const delivered = receipt?.deliveredAt !== undefined && receipt.discardedAt === undefined ? 'wake' : 'mailbox'
      return {
        member: prepared.recipient.name,
        round: prepared.round,
        message_id: prepared.message.id,
        delivered,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_quality_review',
    description: 'Review the structured quality run for a staged/profile team. Evidence is read from the task project and verification commands are executed from the durable contract; callers cannot self-certify hashes or exit codes.',
    parameters: {
      repair_action: { type: 'string', enum: ['revise', 'wait_external'], description: 'Compact v4 needs_revision only: revise authorizes Host to atomically open the bounded same-task repair for a concrete correctable defect; wait_external preserves the failure until its external recovery condition changes. Never use revise for unchanged remote source failures.' },
      review_audit: { type: 'string', description: 'Compact v4 writer PASS requires substantive per-chapter notes with 报告SHA256, 来源台账SHA256 and 结论: PASS. Renderer PASS requires json visual-audit with actual HTML/PDF hashes, checkedAt, method, blockers:0, dom/wide/narrow/interactions/accessibility and exact rendered first/middle/last PDF page hashes.' },
      event_id: { type: 'string', description: 'Operation-specific idempotency ID, e.g. review-t1-1-unique. Reuse only for an exact retry of this review and payload; repair and integration need different IDs.' },
      task_id: { type: 'string', description: 'Task whose quality run is being reviewed. Defaults to the root run.' },
      reviewer: { type: 'string', description: 'Optional compatibility field; if supplied it must match the caller. Host derives reviewer identity from the authenticated session.' },
      verdict: { type: 'string', enum: [...REVIEW_VERDICTS], description: 'pass requires all acceptance/verification checks to pass and no hard finding. needs_revision/reject preserve truthful failing checks and require findings.' },
      artifacts: { type: 'array', description: 'Additional contract artifacts only. Omit task-output and published versions: Host binds them automatically. If supplied, use the exact review_artifact_id and Host-bound path shown in expert_teams_status; artifact_id is a different immutable version identifier.', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, path: { type: 'string', required: true } } } },
      acceptance_results: { type: 'array', description: 'Exactly one truthful boolean result for EVERY ID in the task review_contract.acceptance from expert_teams_status, including output-present when listed. Copy exact IDs, not statement text or invented acceptance-N aliases. Keep failed checks false when requesting revision or rejecting.', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, passed: { type: 'boolean', required: true }, detail: { type: 'string' } } } },
      prepare_only: { type: 'boolean', description: 'For selected report craft or fixed task Skill/Prompt, first set true with task_id and reviewer only. Host returns complete frozen reviewer materials, artifact hashes and machine checks; this does not approve the task.' },
      material_receipt: { type: 'string', description: 'Host receipt from prepare_only for this reviewer session, current attempt and exact artifact bytes.' },
      task_material_receipt: { type: 'string', description: 'When task Skill/Prompt and report craft are both selected, submit the separate fixed task-material receipt returned by prepare_only.' },
      independent_review: { type: 'array', description: 'Supply every exact area ID returned by prepare_only (v3: selected domain contract; legacy v2: four fixed areas), each with scope, truthful status and located quotes/reasons from the exact declared Markdown artifact ID returned by preparation. All areas, including visual-and-format, require an MD anchor; HTML/PDF/ledger summaries belong in coverage/reason and cannot replace it. Quote visible prose or its exact Markdown source; preserve identifier punctuation and inline-code literals. These observations do not automatically prove semantic correctness.', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, status: { type: 'string', required: true, enum: ['passed','failed','unverified'] }, coverage: { type: 'string', required: true }, evidence: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { artifactId: { type: 'string', required: true }, quote: { type: 'string', required: true }, reason: { type: 'string', required: true } } } } } } },
      changed_paths: { type: 'array', items: { type: 'string' } },
      findings: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, code: { type: 'string', required: true }, severity: { type: 'string', required: true, enum: [...FINDING_SEVERITIES], description: 'info: observation; soft: nonblocking issue; hard: blocks pass/integration. Only info, soft, hard are accepted.' }, message: { type: 'string', required: true }, taskId: { type: 'string', required: true }, attempt: { type: 'number', required: true }, path: { type: 'string' } } } },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.craft_materials || value.task_materials ? JSON.stringify(value) : `Quality run ${value.runId ?? 'unknown'} is ${value.status ?? 'unknown'}. ${value.next_action ?? ''}` }] },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireParticipantTeam(workspace, config, caller)
      const run = qualityRunFor(team, args.task_id)
      const reviewer = args.reviewer ?? participantIdentityOf(team, caller.id)?.name ?? ''
      const reviewFingerprint = canonicalDigest(args)
      const priorWait = requireTask(team,run.contract.taskId).technicalReviewWaits?.find(w=>w.eventId===args.event_id)
      if (priorWait) {
        if(priorWait.fingerprint!==reviewFingerprint||priorWait.reviewerSessionId!==caller.id) throw new Error('RESEARCH_EXTERNAL_WAIT_CONFLICT')
        return {runId:run.runId,status:run.status,task_id:run.contract.taskId,replayed:true,next_action:'Technical wait already recorded; no content verdict or budget charge.'}
      }
      const priorReview = requireTask(team, run.contract.taskId).researchReviewTransactions?.[args.event_id ?? '']
      if (isCompactResearch(team) && args.prepare_only !== true && priorReview !== undefined) {
        if (priorReview.fingerprint !== reviewFingerprint || priorReview.reviewerSessionId !== caller.id || participantIdentityOf(team,caller.id)?.name !== reviewer) throw new Error('RESEARCH_REVIEW_IDEMPOTENCY_CONFLICT')
        await scheduler.kickTeam(workspace,team.id)
        return { runId: priorReview.runId, status: priorReview.status, task_id: run.contract.taskId, attempt: priorReview.attempt, replayed: true, next_action: 'This review transaction is already committed; inspect current status before further action.' }
      }
      if (args.repair_action !== undefined && (!isCompactResearch(team) || args.verdict !== 'needs_revision' || args.prepare_only === true)) throw new Error('RESEARCH_REPAIR_ACTION_INVALID')
      requireReviewIdentity(team, run, caller.id, reviewer)
      if (args.prepare_only !== true) {
        if (args.event_id === undefined || args.verdict === undefined || args.acceptance_results === undefined) throw new Error('QUALITY_REVIEW_INPUT: event_id, verdict and acceptance_results are required for a normal review')
        validateReviewRequest(run, { eventId: args.event_id, reviewer, verdict: args.verdict as ReviewVerdict, findings: (args.findings ?? []) as Finding[] })
      } else if (args.verdict !== undefined || args.acceptance_results !== undefined || args.independent_review !== undefined) throw new Error('QUALITY_PREPARE_ONLY: preparation cannot carry review decisions')
      const task = requireTask(team, run.contract.taskId)
      if (task.reportBundle?.craft === undefined && task.frozenTaskMaterialContract === undefined && (args.prepare_only === true || args.material_receipt !== undefined || args.task_material_receipt !== undefined || args.independent_review !== undefined)) {
        throw new Error('CRAFT_REVIEW_NOT_APPLICABLE: this task has no selected craft contract. Omit prepare_only, material_receipt and independent_review; submit the task review_contract acceptance_results with truthful verdict/findings. No evidence or review state was changed.')
      }
      if (args.prepare_only !== true && (args.independent_review !== undefined || task.frozenTaskMaterialContract !== undefined) && !args.material_receipt?.trim()) {
        throw new Error('CRAFT_REVIEW_RECEIPT_REQUIRED: prepare this craft review with prepare_only:true, inspect the returned exact artifacts/materials, then submit its material_receipt and all required independent_review areas.')
      }
      if (args.prepare_only !== true && task.reportBundle?.craft !== undefined && task.frozenTaskMaterialContract !== undefined && !args.task_material_receipt?.trim()) {
        throw new Error('TASK_BINDING_REVIEW_RECEIPT_REQUIRED: this task has both report craft and fixed Skill/Prompt; submit both receipts from prepare_only')
      }
      if (task.project === undefined) throw new Error(`quality task "${run.contract.taskId}" has no durable project`)
      requireCurrentQualityTask(team, run)
      requireCraftProducerDelivery(team, task, run)
      const producerSessionId = task.assignee === 'captain'
        ? team.captainSessionId : team.members.find(member => member.name === task.assignee)?.id ?? ''
      requireTaskMaterialDelivery(task, producerSessionId, run.attempt, 'producer')
      const acceptanceResults = args.prepare_only === true ? run.contract.acceptance.map(c => ({ id: c.id, passed: false, detail: 'Not yet independently reviewed; machine preflight only.' })) : args.acceptance_results!
      try {
        validateAcceptanceResults(run.contract, acceptanceResults)
      } catch (error: unknown) {
        if (!(error instanceof QualityRunError)) throw error
        throw new QualityRunError(error.code, `${error.message}. Required acceptance_results IDs and statements: ${JSON.stringify(run.contract.acceptance)}. Provide every exact ID once with a truthful passed boolean; keep failed checks false and use needs_revision/reject with findings.`, error.details)
      }
      const artifactSpecs = [...(args.artifacts ?? [])]
      const automatic = currentPublishedDeliverables(task, run).map(artifact => ({ id: artifact.reviewId!, path: publishedEvidencePath(team, task, artifact) }))
      if (run.contract.deliverables.includes('task-output')) automatic.push({ id: 'task-output', path: taskOutputEvidencePath(team, task)! })
      for (const spec of automatic) {
        const supplied = artifactSpecs.find(item => item.id === spec.id)
        if (supplied !== undefined && supplied.path !== spec.path) throw new Error(`PUBLISHED_EVIDENCE_MISMATCH: review artifact ${JSON.stringify(spec.id)} must use its Host-bound path ${JSON.stringify(spec.path)} for attempt ${run.attempt}. Omit this artifact entry to let the Host bind the current version automatically; retain any other manually required deliverables.`)
        if (supplied === undefined) artifactSpecs.push(spec)
      }
      const evidenceInput = {
        workspaceRoot: stateRoot,
        contract: run.contract,
        attempt: run.attempt,
        artifacts: artifactSpecs,
        acceptanceResults,
        ...(args.independent_review === undefined ? {} : { independentReview: { materialReceiptId: args.material_receipt ?? '', reviewerSessionId: caller.id, areas: args.independent_review } }),
        artifactCheckOptions: {
          signal: exec.signal,
          // Set by the trusted service environment. Customer DSH instances
          // cannot traverse /root when ProtectHome is enabled.
          ...(process.env.DSH_REPORT_BROWSER_EXECUTABLE
            ? { browserExecutablePath: process.env.DSH_REPORT_BROWSER_EXECUTABLE }
            : {}),
          ...(process.env.DSH_REPORT_CRAFT_SCREENSHOT_ROOT
            ? { screenshotRoot: process.env.DSH_REPORT_CRAFT_SCREENSHOT_ROOT }
            : {}),
        },
        changedPaths: [...new Set([...(args.changed_paths ?? artifactSpecs.map(item => item.path)), ...automatic.map(item => item.path)])],
      }
      const evidence = (args.prepare_only === true ? undefined : reviewEvidenceForReplay(run, args.event_id!, evidenceInput)) ?? await collectTaskEvidence(evidenceInput)
      const reviewedArtifactDigest = canonicalDigest(evidence.artifacts.map(({ id, path, sha256 }) => ({ id, path, sha256 })))
      if (args.prepare_only === true) {
        let visualAuditTemplate: Record<string, unknown> | undefined
        if (isResearchV5(team) && task.planTask?.logicalId === 'renderer') {
          const html = evidence.artifacts.find(artifact => artifact.id === 'published:report.html')
          const pdf = evidence.artifacts.find(artifact => artifact.id === 'published:report.pdf')
          if (!html || !pdf) throw new Error('V5_VISUAL_AUDIT_TEMPLATE: published HTML and PDF required')
          const pageReceipt = await inspectPdfPages(await readFile(resolve(stateRoot, pdf.path)), 1)
          visualAuditTemplate = {
            verdict: '', checkedAt: '', method: '', blockers: null,
            htmlSha256: html.sha256, pdfSha256: pdf.sha256,
            pageCount: pageReceipt.pageCount,
            pages: Object.fromEntries(Object.entries(pageReceipt.pages).map(([name, page]) => [name, { ...page, finding: '' }])),
            dom: '', wide: '', narrow: '', accessibility: '', references: '', figures: '',
          }
        }
        const craft = task.reportBundle?.craft === undefined ? undefined : prepareCraftDelivery(task, caller.id, run.attempt, ['reviewer'], 'review-preparation')
        const taskMaterials = prepareTaskMaterialDelivery(task, caller.id, run.attempt, 'reviewer', true, reviewedArtifactDigest)
        await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
          const { team: fresh } = await requireFreshParticipant(stateRoot, team.id, caller.id)
          const current = qualityRunFor(fresh, args.task_id)
          if (current.runId !== run.runId || current.attempt !== run.attempt || JSON.stringify(current.contract) !== JSON.stringify(run.contract)) throw new Error('CRAFT_PREPARATION_STALE: task changed during preparation')
          requireReviewIdentity(fresh, current, caller.id, reviewer)
          const liveTask = requireCurrentQualityTask(fresh, current)
          requireCraftProducerDelivery(fresh, liveTask, current)
          await requireReviewedArtifactsCurrent(stateRoot, fresh, { ...current, latestEvidence: evidence })
          if (craft !== undefined) { saveCraftDelivery(liveTask, craft.receipts); bindCraftReviewPreparation(liveTask, current, craft.receipts[0]!, evidence.artifacts) }
          saveTaskMaterialDelivery(liveTask, taskMaterials.receipt)
          await writeTeam(stateRoot, fresh)
        })
        return asToolJsonObject({ runId: run.runId, status: 'prepared_for_independent_review', task_id: task.id, attempt: run.attempt,
          material_receipt: craft?.receipts[0]?.id ?? taskMaterials.receipt?.id, task_material_receipt: taskMaterials.receipt?.id, craft_materials: craft?.content, task_materials: taskMaterials.content,
          artifacts: evidence.artifacts.map(({ id, path, sha256 }) => ({ id, path, sha256 })), machine_checks: evidence.artifactCheckReceipts,
          ...(visualAuditTemplate === undefined ? {} : { visual_audit_template: visualAuditTemplate }),
          acceptance: run.contract.acceptance,
          ...(craft === undefined ? {} : { independent_review_areas: independentReviewAreas(run) }),
          next_action: craft === undefined
            ? 'Inspect the exact files, hashes and machine checks. Submit a normal review with this material_receipt and all truthful acceptance_results; changed artifact bytes require a new preparation. Preparation is not acceptance.'
            : 'Inspect these exact files and check results. Submit a normal review with material_receipt, all acceptance_results and all selected independent_review areas listed here with real MD quotes/reasons. Every area (including visual/format) must use the frozen md artifact ID and actual prose; preserve underscores and inline code. Record HTML/PDF/ledger observations in coverage/reason, not as substitute quote artifacts. Failed/unverified required items prohibit pass; report needs_revision/reject and findings. Preparation is not acceptance.' })
      }
      requireCraftReviewPreparation(task, run, caller.id, args.material_receipt, evidence.artifacts)
      requireTaskMaterialDelivery(task, caller.id, run.attempt, 'reviewer', args.task_material_receipt ?? args.material_receipt, reviewedArtifactDigest)
      const saved = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const { team: fresh } = await requireFreshParticipant(stateRoot, team.id, caller.id)
        const freshRun = qualityRunFor(fresh, args.task_id)
        const committed = requireTask(fresh, freshRun.contract.taskId).researchReviewTransactions?.[args.event_id!]
        if (isCompactResearch(fresh) && committed !== undefined) {
          if (committed.fingerprint !== reviewFingerprint || committed.reviewerSessionId !== caller.id) throw new Error('RESEARCH_REVIEW_IDEMPOTENCY_CONFLICT')
          return { run: freshRun, task: requireTask(fresh, freshRun.contract.taskId) }
        }

        if (freshRun.runId !== run.runId || JSON.stringify(freshRun.contract) !== JSON.stringify(run.contract)) throw new Error('quality run changed while evidence was being collected; retry with a new event id')
        requireReviewIdentity(fresh, freshRun, caller.id, reviewer)
        const freshTask = requireTask(fresh, freshRun.contract.taskId)
        requireCraftProducerDelivery(fresh, freshTask, freshRun)
        requireCraftReviewPreparation(freshTask, freshRun, caller.id, args.material_receipt, evidence.artifacts)
        requireTaskMaterialDelivery(freshTask, caller.id, freshRun.attempt, 'reviewer', args.task_material_receipt ?? args.material_receipt, reviewedArtifactDigest)
        const freshTaskOutputPath = freshTask.project === undefined ? undefined : `${fresh.id}/${freshTask.project.outputPath}`.replaceAll('\\', '/')
        const reviewedOutput = evidence.artifacts.find((candidate) => (
          candidate.id === 'task-output'
            && freshTaskOutputPath !== undefined
            && candidate.path === freshTaskOutputPath
        ))
        const hasDeliverable = evidence.artifacts.some(item => item.id !== 'task-output' || item.path !== freshTaskOutputPath)
        if (reviewedOutput !== undefined && !hasDeliverable) {
          let record: Record<string, unknown>
          try {
            record = JSON.parse(reviewedOutput.content) as Record<string, unknown>
          } catch {
            throw new Error(`QUALITY_OUTPUT_MISMATCH: task-output evidence for ${freshTask.id} is not a Host task output record`)
          }
          if (record.output !== freshTask.output) {
            throw new Error(`QUALITY_OUTPUT_MISMATCH: task ${freshTask.id} changed while evidence was being collected; retry review`)
          }
        }
        // Commands may have mutated a file after evidence collection; refuse
        // to freeze a snapshot that already differs from the current bytes.
        await requireReviewedArtifactsCurrent(stateRoot, fresh, { ...freshRun, latestEvidence: evidence })
        if (args.verdict === 'pass') {
          await checkDeepResearchPass(stateRoot, fresh, freshTask, evidence)
          await checkCompactReviewAudit(stateRoot, fresh, freshTask, evidence, args.review_audit)
        }
        if (isCompactResearch(fresh) && freshTask.researchReviewAudits?.[args.event_id!] !== undefined && freshTask.researchReviewAudits[args.event_id!] !== (args.review_audit ?? '')) throw new Error('RESEARCH_REVIEW_AUDIT_CONFLICT')
        const infrastructureWait = isResearchV5(fresh) && evidence.artifactCheckReceipts?.some(r=>r.results.some(c=>c.status==='unverified'))
        if (isCompactResearch(fresh) && (args.repair_action === 'wait_external' || infrastructureWait)) {
          const reason = infrastructureWait ? 'Host verification incomplete: '+evidence.artifactCheckReceipts!.flatMap(r=>r.results.filter(c=>c.status==='unverified').map(c=>c.id+': '+c.detail)).join('; ') : (args.findings ?? []).map(f => f.message).join('; ')
          if (!reason.trim()) throw new Error('RESEARCH_EXTERNAL_WAIT_REASON_REQUIRED')
          const prior = freshTask.technicalReviewWaits?.find(w => w.eventId === args.event_id)
          if (prior && prior.fingerprint !== reviewFingerprint) throw new Error('RESEARCH_EXTERNAL_WAIT_CONFLICT')
          if (!prior) freshTask.technicalReviewWaits = [...(freshTask.technicalReviewWaits ?? []), {eventId:args.event_id!,reviewerSessionId:caller.id,fingerprint:reviewFingerprint,reason,at:Date.now(),attempt:freshRun.attempt}]
          freshTask.executionState = 'blocked_external'
          freshTask.waitReason = reason
          await writeTeam(stateRoot,fresh)
          return {run:freshRun,task:freshTask}
        }
        const mutation = reviewQualityRun(freshRun, {
          eventId: args.event_id!,
          reviewer,
          verdict: args.verdict as ReviewVerdict,
          findings: (args.findings ?? []) as Finding[],
          evidence,
        })
        assertDurableQualityRun(mutation.run)
        if (!mutation.applied) return { run: freshRun, task: freshTask }
        if (isCompactResearch(fresh)) freshTask.researchReviewTransactions = { ...freshTask.researchReviewTransactions, [args.event_id!]: { fingerprint: reviewFingerprint, reviewerSessionId: caller.id, runId: mutation.run.runId, status: mutation.run.status, attempt: mutation.run.attempt } }
        if (isCompactResearch(fresh) && mutation.run.status === 'blocked' && args.repair_action === 'revise') {
          const snapshot = structuredClone(freshTask)
          const repair = requestQualityRepair(mutation.run, { eventId: `host-repair:${args.event_id!}`, actor: CAPTAIN_KEY }).run
          setQualityRun(fresh,repair)
          invalidateTaskAttempt(freshTask,freshTask.assignee!)
          freshTask.attempt = repair.attempt - 1
          freshTask.researchReviewTransactions![args.event_id!]!.status = repair.status
          freshTask.researchReviewTransactions![args.event_id!]!.attempt = repair.attempt
          await syncTaskProjectInput(stateRoot,fresh,freshTask)
          await commitTaskUpdate(stateRoot,fresh,freshTask,snapshot)
          return { run: repair, task: freshTask }
        }

        if (isCompactResearch(fresh) && mutation.run.status === 'passed') {
          if (freshTask.status !== 'in_progress' || freshTask.executionState !== 'awaiting_review') throw new Error('RESEARCH_SUBMISSION_REQUIRED: submit this attempt before independent acceptance')
          const snapshot = structuredClone(freshTask)
          const integrated = integrateQualityRun(mutation.run, { eventId: `host-integrate:${args.event_id!}`, actor: CAPTAIN_KEY }).run
          // Completion gates must not commit counters before the acceptance transaction.
          const gate = evaluateTaskCompletionGates(fresh, freshTask, freshTask.output)
          if (gate?.blocked !== undefined) throw new Error(`RESEARCH_COMPLETION_BLOCKED: ${JSON.stringify(gate.blocked)}`)
          freshTask.researchReviewAudits = { ...freshTask.researchReviewAudits, [args.event_id!]: args.review_audit ?? '' }
          freshTask.researchRelease = reviewedRelease(freshTask, integrated)
          setQualityRun(fresh, integrated)
          freshTask.researchReviewTransactions![args.event_id!]!.status = 'integrated'
          freshTask.status = 'completed'
          finalizeTerminalTask(freshTask)
          freshTask.updatedAt = Date.now()
          await commitTaskUpdate(stateRoot, fresh, freshTask, snapshot)
          return { run: integrated, task: freshTask }
        }
        setQualityRun(fresh, mutation.run)
        freshTask.executionState = 'awaiting_review'
        freshTask.waitReason = mutation.run.status === 'passed'
          ? 'Review passed; waiting for captain acceptance.'
          : 'Review requires a quality repair decision.'
        await writeTeam(stateRoot, fresh)
        return { run: qualityRunFor(fresh, args.task_id), task: freshTask }
      })
      if (isCompactResearch(team)) await scheduler.kickTeam(workspace, team.id)
      const nextAction = saved.task.executionState === 'blocked_external'
        ? 'External/technical blocker recorded without a content verdict or repair budget charge. Captain resumes only after the recorded cause changes; independent acceptance remains required.'
        : saved.run.status === 'integrated' && isCompactResearch(team)
        ? 'Host committed the independent review, immutable reviewed input bundle and task completion together. Downstream work is scheduled automatically; authenticated user gates still require user choice.'
        : saved.run.status === 'repairing' && isCompactResearch(team)
          ? 'Host recorded the failed independent review and opened a bounded repair on the same task. The owner receives the findings and next attempt; downstream remains blocked.'
        : saved.run.status === 'passed'
        ? `${saved.task.status === 'claimed' ? `The current owner ${saved.task.assignee} must update this same attempt to in_progress; then the captain must` : 'The captain must'} call expert_teams_quality_integrate(task_id="${saved.task.id}", actor="captain", complete_task=true) with a new integration event_id, different from this review ID.`
        : saved.run.status === 'blocked'
          ? `Negative checks remain recorded; integration is blocked. First classify the failure. For a correctable artifact or execution defect, call expert_teams_quality_repair(task_id="${saved.task.id}", actor="captain") with a new repair event_id, correct and verify the work, publish evidence and request independent review. An unchanged external source failure is not repaired by more error notes, republication, takeover or another review. Check the approved acceptance for an explicitly user-authorized conditional branch; every obligation of that branch still needs evidence. Do not change the meaning of mandatory acceptance or make a failed check true. If no authorized branch can be satisfied, report the blocker and recovery condition instead of consuming repair attempts.`
          : saved.run.status === 'escalated'
            ? `The content repair threshold is reached. Report the blocker and request an explicit user continuation decision; expert_teams_quality_continue preserves this task and history. If the user stops instead, the captain may call expert_teams_quality_closeout(task_id="${saved.task.id}", event_id="<new-closeout-id>", reason="<disposition>"). This preserves rejected evidence and marks the task failed; scope or craft changes still require the approved plan revision flow.`
            : `Quality status is ${saved.run.status}; no further review mutation was applied.`
      return { runId: saved.run.runId, status: saved.run.status, task_id: saved.task.id, task_status: saved.task.status, review_rounds: saved.run.reviewRounds, repair_rounds: saved.run.repairRounds, next_action: nextAction }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_quality_repair',
    description: 'Open the next structured quality repair attempt after a blocked review only when there is a concrete correctable defect or new recovery evidence. The repair budget is durable and capped by the contract. Repeated remote failure without changed conditions, changing actors, or republishing the same evidence is not a repair and cannot make integration legal. Preserve failed checks; do not call this tool merely to allow another identical review.',
    parameters: { task_id: { type: 'string' }, event_id: { type: 'string', required: true, description: 'New repair-specific ID, e.g. repair-t1-1-unique. Reuse only for an exact retry; never reuse a review/integration ID.' }, actor: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: `Quality run ${value.runId ?? 'unknown'} is ${value.status ?? 'unknown'} (attempt ${value.attempt ?? 'unknown'}).` }] },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      const run = qualityRunFor(team, args.task_id)
      const saved = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const freshRun = qualityRunFor(fresh, args.task_id)
        if (freshRun.runId !== run.runId) throw new Error('quality run changed; retry the repair request')
        const existing = freshRun.events.find(event => event.id === args.event_id)
        if (existing?.type === 'repair') {
          // Verify the stored operation/actor/payload fingerprint before any
          // generation exception. An accepted repair reserves quality N+1
          // while a full slot or bad input can still leave task N pending.
          if (existing.actor !== args.actor) throw new QualityRunError('idempotency_conflict', `event ${args.event_id} was accepted for a different actor`)
          const replay = requestQualityRepair(freshRun, { eventId: args.event_id, actor: args.actor })
          const task = requireTask(fresh, freshRun.contract.taskId)
          const awaitingClaim = freshRun.status === 'repairing' && task.status === 'pending'
            && task.attemptId === undefined && (task.attempt ?? 0) + 1 === freshRun.attempt
          if (task.reassigning === true || task.assignee !== freshRun.contract.assignee
            || (!awaitingClaim && task.attempt !== freshRun.attempt)) requireCurrentQualityTask(fresh, freshRun)
          return { run: replay.run, applied: false }
        }
        requireCurrentQualityTask(fresh, freshRun)
        if (existing !== undefined) throw new QualityRunError('idempotency_conflict', `event ${args.event_id} belongs to ${existing.type}, not a repair event`)
        // Event IDs are run-scoped, but a delayed receipt from an ancestor of
        // THIS task must not become a new budget-consuming repair after fork.
        const history = fresh.qualityRunHistory?.[freshRun.contract.taskId] ?? []
        const visited = new Set<string>()
        let parentId = freshRun.revision?.parentRunId
        while (parentId !== undefined && !visited.has(parentId)) {
          visited.add(parentId)
          const parent = history.find(previous => previous.runId === parentId && previous.contract.taskId === freshRun.contract.taskId)
          if (parent === undefined) break
          if (parent.events.some(event => event.id === args.event_id)) throw new Error(`STALE_QUALITY_EVENT: event ${args.event_id} belongs to an earlier quality run for task ${freshRun.contract.taskId}; inspect the current run and use a new repair event_id only for a new repair decision`)
          parentId = parent.revision?.parentRunId
        }
        const mutation = requestQualityRepair(freshRun, { eventId: args.event_id, actor: args.actor })
        assertDurableQualityRun(mutation.run)
        setQualityRun(fresh, mutation.run)
        const qualityTask = fresh.tasks.find(candidate => candidate.id === mutation.run.contract.taskId)
        if (qualityTask !== undefined && mutation.run.attempt > (qualityTask.attempt ?? 0)) {
          invalidateTaskAttempt(qualityTask, qualityTask.assignee ?? CAPTAIN_KEY)
          // beginTaskAttempt increments the durable task counter when the
          // scheduler/captain claims the repaired generation. Leave it one
          // below the quality generation so both counters meet at claim time.
          qualityTask.attempt = mutation.run.attempt - 1
        }
        // Persist complete feedback before the new generation can be dispatched
        // or manually claimed. Captain follow-up mail may arrive much later.
        if (qualityTask !== undefined) await syncTaskProjectInput(stateRoot, fresh, qualityTask)
        await writeTeam(stateRoot, fresh)
        return { run: qualityRunFor(fresh, args.task_id), applied: mutation.applied }
      })
      if (saved.applied) await scheduler.kickTeam(workspace, team.id, captain)
      return { runId: saved.run.runId, status: saved.run.status, attempt: saved.run.attempt, repair_rounds: saved.run.repairRounds }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_quality_closeout',
    description: 'Captain-only audited closeout for an escalated quality run. Mark the task failed, preserve the rejected evidence and original output, release its execution slot, and keep dependent tasks blocked. A scope or craft changes still require the approved plan revision flow.',
    parameters: {
      task_id: { type: 'string', required: true },
      event_id: { type: 'string', required: true, description: 'Unique closeout decision ID; reuse only for an exact retry.' },
      reason: { type: 'string', required: true, description: 'Concrete disposition of the exhausted findings and next required source or contract correction.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        task_id: { type: 'string', required: true },
        task_status: { type: 'string', required: true },
        quality_status: { type: 'string', required: true },
        event_id: { type: 'string', required: true },
        reason: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: `Task ${value.task_id} closed as ${value.task_status}; quality remains ${value.quality_status}. Decision ${value.event_id}: ${value.reason}` }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      const eventId = args.event_id.trim()
      const reason = args.reason.trim()
      if (!eventId || !reason) throw new Error('QUALITY_CLOSEOUT_REASON_REQUIRED: event_id and reason must be nonempty')
      const closed = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const task = requireTask(fresh, args.task_id)
        const run = qualityRunFor(fresh, task.id)
        const receipt = task.qualityCloseout
        if (receipt !== undefined) {
          if (receipt.eventId !== eventId || receipt.reason !== reason || receipt.runId !== run.runId || task.status !== 'failed') {
            throw new Error('QUALITY_CLOSEOUT_CONFLICT: this task already has a different closeout decision')
          }
          return { task_id: task.id, task_status: task.status, quality_status: run.status, event_id: eventId, reason, applied: false }
        }
        if (run.status !== 'escalated') throw new Error(`QUALITY_CLOSEOUT_NOT_ESCALATED: quality=${run.status}; use the normal review and repair flow`)
        if (TERMINAL_TASK_STATUSES.includes(task.status)) throw new Error(`QUALITY_CLOSEOUT_TERMINAL: task ${task.id} is already ${task.status}`)
        if (task.reassigning === true) throw new Error('QUALITY_CLOSEOUT_HANDOFF: finish the ownership handoff before closeout')
        if (run.events.some(event => event.id === eventId)) throw new Error('QUALITY_CLOSEOUT_EVENT_CONFLICT: event_id is already used by this quality run')
        const snapshot: TeamTask = { ...task, ...task.project === undefined ? {} : { project: { ...task.project } } }
        task.qualityCloseout = { eventId, runId: run.runId, reason, closedAt: Date.now() }
        task.status = 'failed'
        finalizeTerminalTask(task)
        await commitTaskUpdate(stateRoot, fresh, task, snapshot)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'expert-teams/task-updated', {
          teamId: fresh.id, taskId: task.id, status: task.status, assignee: task.assignee,
        })
        return { task_id: task.id, task_status: task.status, quality_status: run.status, event_id: eventId, reason, applied: true }
      })
      if (closed.applied) await scheduler.kickTeam(workspace, team.id, captain)
      return { task_id: closed.task_id, task_status: closed.task_status, quality_status: closed.quality_status, event_id: closed.event_id, reason: closed.reason }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_quality_continue',
    description: 'Captain-only explicit USER policy decision after an exhausted review. Preserve all prior runs, findings, publications and closeout; open the next attempt of the same task. Does not pass any review or human gate. Supply the user decision verbatim; never self-authorize more rounds. Exact retries are idempotent.',
    parameters: {
      task_id: {type:'string',required:true}, expected_run_id:{type:'string',required:true},
      event_id:{type:'string',required:true}, reason:{type:'string',required:true}, user_decision:{type:'string',required:true},
      additional_repair_rounds:{type:'number',required:true,description:'Explicitly authorized content repair rounds after the new submission, 0–20. Use 0 for one technical correction and re-review.'},
    },
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    async execute(args,exec) {
      const captain=requireCaptain(exec), workspace=workspaceOf(captain), stateRoot=stateRootOf(workspace,config)
      const team=await requireCaptainTeam(workspace,config,captain)
      const result=await withTeamLock(teamLockKey(stateRoot,team.id),async()=>{
        const fresh=await requireFreshCaptainTeam(stateRoot,team.id,captain.id)
        assertTeamRunnable(fresh)
        const task=requireTask(fresh,args.task_id), run=qualityRunFor(fresh,args.task_id)
        const fingerprint=canonicalDigest(args)
        const prior=task.qualityContinuations?.find(r=>r.eventId===args.event_id)
        if(prior) {if(prior.fingerprint!==fingerprint) throw new Error('QUALITY_CONTINUATION_CONFLICT'); return prior}
        if(!isCompactResearch(fresh)||task.humanChoice||task.reassigning||!task.assignee||run.status!=='escalated'||run.runId!==args.expected_run_id
          || !['failed','in_progress'].includes(task.status)) throw new Error('QUALITY_CONTINUATION_NOT_EXHAUSTED')
        if(!args.event_id.trim()||!args.reason.trim()||!args.user_decision.trim()||!Number.isSafeInteger(args.additional_repair_rounds)
          ||args.additional_repair_rounds<0||args.additional_repair_rounds>20) throw new Error('QUALITY_CONTINUATION_DECISION_REQUIRED')
        const owner=fresh.members.find(m=>m.name===task.assignee)
        const live=ctx.agents.get((owner?.id??fresh.captainSessionId) as SessionId)
        if(live && (live.status!=='idle'||live.inbox?.hasPending)) throw new Error('QUALITY_CONTINUATION_OWNER_BUSY')
        if(memberOpenTask(fresh,task.assignee,task.id)) throw new Error('QUALITY_CONTINUATION_OWNER_OCCUPIED')
        const next=createQualityRun({...run.contract,id:`continued-contract-${fingerprint}`,attempt:run.attempt+1,maxRepairRounds:args.additional_repair_rounds},`continued-${fingerprint}`)
        const receipt={eventId:args.event_id,fingerprint,parentRunId:run.runId,runId:next.runId,reason:args.reason,userDecision:args.user_decision,
          at:Date.now(),previousOutput:task.output,previousCloseout:task.qualityCloseout}
        const snapshot=structuredClone(task)
        replaceQualityRun(fresh,run,next)
        task.qualityContinuations=[...(task.qualityContinuations??[]),receipt]
        task.qualityCloseout=undefined
        invalidateTaskAttempt(task,task.assignee)
        task.attempt=next.attempt-1
        task.submissionReceipt=undefined
        // Keep the concrete recovery instruction with the dispatched task.
        task.description+=`\nAudited continuation: ${args.reason}. User decision: ${args.user_decision}. Preserve prior publications; obtain a fresh independent review.`
        await syncTaskProjectInput(stateRoot,fresh,task)
        await commitTaskUpdate(stateRoot,fresh,task,snapshot)
        return receipt
      })
      await scheduler.kickTeam(workspace,team.id,captain)
      return JSON.parse(JSON.stringify(result)) as Record<string, JsonValue>
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_revise_inputs',
    description: 'Captain-only audited replacement of one unfinished task dependency with its independently reviewed, integrated follow-up. Requires an idle owner and unreviewed pending quality run. For externally blocked input revisions, provide the exact expected_wait_reason to resolve the wait and replace inputs atomically; do not resume_task first, which dispatches old inputs. Validates frozen craft and publications before committing. Revokes an active attempt, preserves old manifests and review budget. Does not pass quality or human gates. Invoke separately for every affected unfinished consumer.',
    parameters: {
      task_id: { type: 'string', required: true },
      source_task_id: { type: 'string', required: true },
      replacement_task_id: { type: 'string', required: true },
      expected_attempt: { type: 'number', required: true },
      expected_attempt_id: { type: 'string' },
      expected_wait_reason: { type: 'string', description: 'Exact current waitReason when the captain explicitly resolves an external wait as part of this input revision. A changed blocker, runtime block, busy owner or invalid input rejects the entire operation.' },
      event_id: { type: 'string', required: true },
      reason: { type: 'string', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      const result = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        assertTeamRunnable(fresh)
        const task = requireTask(fresh, args.task_id)
        const owner = fresh.members.find(member => member.name === task.assignee && member.status !== 'removed')
        if (task.assignee === CAPTAIN_KEY && task.attemptId) throw new Error('INPUT_REVISION_REJECTED: active captain-owned work requires a separate follow-up')
        const liveOwner = owner === undefined ? undefined : ctx.agents.get(owner.id as SessionId)
        const activity = liveOwner?.inbox?.hasPending === true ? 'running' : owner === undefined ? 'idle' : liveOwner?.status
          ?? (await memberActivity(ctx, fresh.captainSessionId)).get(owner.id) ?? 'unknown'
        const updated = await reviseTaskInputs(stateRoot, fresh, {
          taskId: args.task_id, sourceTaskId: args.source_task_id, replacementTaskId: args.replacement_task_id,
          expectedAttempt: args.expected_attempt, ...(args.expected_attempt_id === undefined ? {} : { expectedAttemptId: args.expected_attempt_id }),
          ...(args.expected_wait_reason === undefined ? {} : { expectedWaitReason: args.expected_wait_reason }),
          eventId: args.event_id, reason: args.reason,
        }, activity)
        if (updated.applied) {
          await writeTeam(stateRoot, updated.team)
        }
        // Reconcile the projection on exact retries too, including a crash
        // after the authoritative team commit but before task input sync.
        await syncTaskProjectInput(stateRoot, updated.team, requireTask(updated.team, args.task_id))
        return { applied: updated.applied, receipt: JSON.parse(JSON.stringify(updated.receipt)) as JsonValue }
      })
      // A retry also kicks scheduling after a crash between persistence and dispatch.
      await scheduler.kickTeam(workspace, team.id, captain)
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_quality_reopen',
    description: 'Open a new review version for unfinished work. The captain can also withdraw a pending/repairing awaiting_review submission that has no review for its current attempt, so the owner can finish publishing before resubmission. This keeps the same task attempt and consumed repair budget. Reviewed revisions follow the normal budget; completed work requires a follow-up task.',
    parameters: {
      task_id: { type: 'string' },
      event_id: { type: 'string', required: true, description: 'New reopen-specific ID. Reuse only for an exact retry of the same operation and payload.' },
      reason: { type: 'string', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: `Quality revision ${value.runId} is ${value.status}.` }] },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      const saved = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        assertTeamRunnable(fresh)
        const run = qualityRunFor(fresh, args.task_id)
        const task = requireTask(fresh, run.contract.taskId)
        if (TERMINAL_TASK_STATUSES.includes(task.status) || task.reassigning === true) throw new Error('Only unfinished, settled tasks can reopen quality review; create a follow-up task for completed work')
        if (task.assignee === undefined || !task.attempt) throw new Error('Claim the task before reopening review')
        const withdrawUnreviewed = run.revision?.eventId === args.event_id
          ? run.revision.withdrawUnreviewed === true
          : task.executionState === 'awaiting_review'
            && (run.status === 'pending' || run.status === 'repairing')
            && !run.evidenceHistory.some(evidence => evidence.attempt === run.attempt)
            && run.latestEvidence?.attempt !== run.attempt
        if (run.revision?.eventId !== args.event_id && task.assignee !== CAPTAIN_KEY) {
          const busy = memberOpenTask(fresh, task.assignee, task.id)
          if (busy !== undefined) throw new Error(`member "${task.assignee}" is busy with ${busy.id}; finish it before reopening ${task.id}`)
        }
        const mutation = forkQualityRun(run, { eventId: args.event_id, actor: CAPTAIN_KEY, reason: args.reason, assignee: task.assignee, attempt: task.attempt, ...(withdrawUnreviewed ? { withdrawUnreviewed: true } : {}) })
        assertDurableQualityRun(mutation.run)
        replaceQualityRun(fresh, run, mutation.run)
        if (mutation.applied) {
          task.executionState = 'active'
          task.waitReason = undefined
          task.dispatch = undefined
          task.updatedAt = Date.now()
          const ownerId = task.assignee === CAPTAIN_KEY ? fresh.captainSessionId
            : fresh.members.find(member => member.name === task.assignee && member.status !== 'removed')?.id
          if (ownerId !== undefined && fresh.runtimeWaits !== undefined) delete fresh.runtimeWaits[ownerId]
        }
        await writeTeam(stateRoot, fresh)
        return mutation.run
      })
      await scheduler.kickTeam(workspace, team.id, captain)
      return { runId: saved.runId, status: saved.status, attempt: saved.attempt }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_resume_member',
    description: 'Explicitly resolve one durable provider/runtime blocker after its cause changed. Only the captain may resume a named member or "captain". This preserves task attempts and review waiting and does not change routes or release other members.',
    parameters: {
      member: { type: 'string', required: true, description: 'Active member name, or "captain" for the captain session.' },
      reason: { type: 'string', required: true, description: 'Concrete verified change, such as restored quota/capacity or an explicitly selected usable route.' },
      expected_block_id: { type: 'string', description: 'Copy the ENTIRE current runtime_block.id from status, including the runtime: prefix and any recovery suffix. This is an opaque ID, not a session ID or session:turn pair. A stale or shortened ID is rejected without changing state.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: `Runtime blocker for ${value.member}: ${value.resumed ? 'resolved' : 'no blocker'}. Other members remain unchanged.` }] },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      const saved = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        assertTeamRunnable(fresh)
        const memberName = args.member.trim()
        const member = memberName === CAPTAIN_KEY ? undefined : requireMember(fresh, memberName)
        const sessionId = member?.id ?? fresh.captainSessionId
        const oldBlock = member?.runtimeBlock ?? (memberName === CAPTAIN_KEY ? fresh.captainRuntimeBlock : undefined)
        const oldActivationId = member?.activation?.id
        const resumed = resumeRuntimeMember(fresh, sessionId, args.reason, args.expected_block_id,
          { cold: ctx.agents.get(sessionId as SessionId) === undefined })
        if (resumed && (oldBlock !== undefined || oldActivationId !== undefined)) {
          const tasks = fresh.tasks.filter(task => task.assignee === memberName && !TERMINAL_TASK_STATUSES.includes(task.status))
            .map(task => `${task.id} attempt=${task.attempt ?? 0} attempt_id=${task.attemptId ?? 'none'} state=${task.executionState ?? 'active'}`).join('; ')
          await appendMailbox(stateRoot, fresh.id, memberName, createMessage(CAPTAIN_KEY, memberName,
            `Explicit runtime recovery for session ${sessionId}: ${args.reason}. Continue the interrupted work or independent review. Preserve the current task attempt and awaiting_review state; inspect durable task/quality state before acting. ${tasks || 'No owned task; resume the interrupted mailbox/review request.'}`,
            { idempotencyKey: `runtime-resume:${oldBlock?.id ?? oldActivationId}` }))
        }
        await writeTeam(stateRoot, fresh)
        return { member: memberName, session_id: sessionId, resumed, reason: args.reason }
      })
      if (saved.resumed) {
        if (saved.member === CAPTAIN_KEY) await scheduler.kickTeam(workspace, team.id, captain)
        else await scheduler.kickMember(workspace, team.id, saved.member, captain)
      }
      return saved
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_quality_host_recheck',
    description: 'Captain-only recovery for a diagnosed Host-only checker failure (legacy UTF-8 transport or controlled-browser cache permission). Re-runs Host checks on the unchanged reviewed bytes and opens independent re-review only if every check passes. Preserves failure evidence, attempt, publications and repair budget; never passes or integrates a review. Content findings require normal repair.',
    parameters: {
      task_id: { type: 'string', required: true }, expected_run_id: { type: 'string', required: true },
      expected_review_event_id: { type: 'string', required: true }, event_id: { type: 'string', required: true },
      reason: { type: 'string', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain), stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      return withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        assertTeamRunnable(fresh)
        const run = qualityRunFor(fresh, args.task_id), task = requireTask(fresh, args.task_id)
        if (run.runId !== args.expected_run_id) throw new Error('HOST_RECHECK_STALE_RUN')
        const replay = run.hostRechecks?.find(r => r.eventId === args.event_id)
        if (!replay && (task.executionState !== 'awaiting_review' || task.status !== 'in_progress'
          || task.runtimeBlock || task.reassigning || task.humanChoice || run.status !== 'blocked')) throw new Error('HOST_RECHECK_NOT_A_BLOCKED_SUBMISSION')
        const old = replay?.evidence ?? run.latestEvidence
        if (!old) throw new Error('HOST_RECHECK_MISSING_EVIDENCE')
        let evidence = old
        if (!replay) {
          await requireReviewedArtifactsCurrent(stateRoot, fresh, run)
          evidence = await collectTaskEvidence({ workspaceRoot: stateRoot, contract: run.contract, attempt: run.attempt,
            artifacts: old.artifacts.map(({id,path}) => ({id,path})), acceptanceResults: old.acceptanceResults,
            independentReview: old.independentReview, changedPaths: old.changedPaths,
            artifactCheckOptions: {
              ...(process.env.DSH_REPORT_BROWSER_EXECUTABLE
                ? { browserExecutablePath: process.env.DSH_REPORT_BROWSER_EXECUTABLE }
                : {}),
              ...(process.env.DSH_REPORT_CRAFT_SCREENSHOT_ROOT
                ? { screenshotRoot: process.env.DSH_REPORT_CRAFT_SCREENSHOT_ROOT }
                : {}),
            },
          })
        }
        const mutation = recheckHostQualityRun(run, {eventId:args.event_id,actor:CAPTAIN_KEY,reason:args.reason,
          reviewEventId:args.expected_review_event_id,evidence})
        assertDurableQualityRun(mutation.run)
        if (mutation.applied) {
          replaceQualityRun(fresh, run, mutation.run)
          task.waitReason = 'Host checks recovered on unchanged publications. Await the bound independent reviewer; no author resubmission or budget charge.'
          task.updatedAt = Date.now()
          await writeTeam(stateRoot, fresh)
        }
        return {task_id:task.id,applied:mutation.applied,quality_status:mutation.run.status,attempt:mutation.run.attempt,
          repair_rounds:mutation.run.repairRounds,checks:(evidence.artifactCheckReceipts??[]).flatMap(r=>r.results).map(r=>({id:r.id,status:r.status})),
          next_action:'Ask the bound independent reviewer to prepare and submit a new truthful review event for these unchanged publications; integrate only after that review passes.'}
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_resume_task',
    description: 'Resume explicitly blocked/interrupted work without changing its owner or attempt. Waiting-for-review work resumes through quality repair/reopen/acceptance instead.',
    parameters: { task_id: { type: 'string', required: true }, reason: { type: 'string', required: true }, expected_block_id: { type: 'string', description: 'Current owner runtime block ID when explicitly resolving a provider failure; stale IDs are rejected.' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: `Task ${value.task_id} resumed (attempt ${value.attempt}).` }] },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      if (!args.reason.trim()) throw new Error('A concrete resume reason is required')
      const task = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        assertTeamRunnable(fresh)
        const task = requireTask(fresh, args.task_id)
        if (task.status !== 'claimed' && task.status !== 'in_progress' && !(task.status === 'pending' && task.executionState === 'blocked_external')) throw new Error('Only claimed/in-progress tasks or pending input-blocked tasks can resume')
        if (task.executionState === 'awaiting_review') throw new Error('Use quality_repair, quality_reopen or quality_integrate to resolve review waiting')
        if (task.assignee !== undefined && task.assignee !== CAPTAIN_KEY) {
          const busy = memberOpenTask(fresh, task.assignee, task.id)
          if (busy !== undefined) throw new Error(`member "${task.assignee}" is busy with ${busy.id}; finish it before resuming ${task.id}`)
        }
        const ownerSessionId = task.assignee === CAPTAIN_KEY ? fresh.captainSessionId : fresh.members.find(member => member.name === task.assignee && member.status !== 'removed')?.id
        if (ownerSessionId !== undefined) {
          resumeRuntimeMember(fresh, ownerSessionId, args.reason, args.expected_block_id,
            { cold: ctx.agents.get(ownerSessionId as SessionId) === undefined })
          if (fresh.runtimeWaits !== undefined) delete fresh.runtimeWaits[ownerSessionId]
        }
        task.executionState = 'active'
        task.waitReason = undefined
        task.dispatch = undefined
        task.updatedAt = Date.now()
        await writeTeam(stateRoot, fresh)
        return task
      })
      await scheduler.kickTeam(workspace, team.id, captain)
      return { task_id: task.id, attempt: task.attempt ?? 0, status: task.status, reason: args.reason }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_quality_integrate',
    description: 'Accept a passing review after checking the current artifact bytes. Set complete_task=true to atomically integrate and finish member work without reassigning or waking the member for bookkeeping.',
    parameters: {
      task_id: { type: 'string' }, event_id: { type: 'string', required: true, description: 'New integration-specific ID, e.g. integrate-t1-1-unique; never reuse the review ID. Reuse only for an exact integration retry.' }, actor: { type: 'string', required: true },
      complete_task: { type: 'boolean', description: 'Atomically complete/unlock dependents (recommended). Requires task status=in_progress, a passed current-attempt review and unchanged artifact bytes. If claimed, the current owner must first update the same attempt to in_progress.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: `Quality run ${value.runId ?? 'unknown'} is ${value.status ?? 'unknown'}; task ${value.task_status}.` }] },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      if (args.actor !== CAPTAIN_KEY) throw new Error('Quality integration actor must match the authenticated captain')
      const saved = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        assertTeamRunnable(fresh)
        const run = qualityRunFor(fresh, args.task_id)
        const task = requireReviewedTaskOutputCurrent(fresh, run)
        const mutation = integrateQualityRun(run, { eventId: args.event_id, actor: CAPTAIN_KEY })
        if (args.complete_task === true && task.status !== 'completed') {
          const transition = transitionError(task.status, 'completed')
          if (transition !== undefined) throw new Error(`QUALITY_COMPLETION_PRECONDITION: ${transition}; task=${task.id}, quality=${run.status}, attempt=${task.attempt ?? 0}. ${task.status === 'claimed' ? `The authorized current owner ${task.assignee} must call expert_teams_update_task(status="in_progress") using this same attempt_id; then retry quality_integrate with its integration-specific event_id` : 'Only in_progress work can complete; inspect task state and use the supported claim/repair flow'}. No task or quality state was changed`)
        }
        await requireReviewedArtifactsCurrent(stateRoot, fresh, run)
        assertDurableQualityRun(mutation.run)
        const snapshot: TeamTask = { ...task, ...task.project === undefined ? {} : { project: { ...task.project } } }
        if (args.complete_task === true && task.status !== 'completed') {
          const transition = transitionError(task.status, 'completed')
          if (transition !== undefined) throw new Error(transition)
          // An exact old integration receipt does not authorize a new task
          // completion under an outdated checker. Completed historical tasks
          // still retain their side-effect-free replay path.
          if (run.latestEvidence !== undefined) validateArtifactCheckFreshness(run.latestEvidence)
          await enforceCompletionGates(stateRoot, fresh, task, task.output)
          task.status = 'completed'
          finalizeTerminalTask(task)
        } else if (task.status !== 'completed') {
          task.executionState = 'active'
          task.waitReason = undefined
          task.dispatch = undefined
        }
        task.updatedAt = Date.now()
        setQualityRun(fresh, mutation.run)
        await commitTaskUpdate(stateRoot, fresh, task, snapshot)
        return { run: mutation.run, task }
      })
      await scheduler.kickTeam(workspace, team.id, captain)
      return { runId: saved.run.runId, status: saved.run.status, task_status: saved.task.status, task_id: saved.task.id }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_halt',
    description: 'Durably halt this team. Ordinary task creation, scheduler kicks and restart recovery cannot resume it silently; a non-empty reason is recorded.',
    parameters: { reason: { type: 'string', required: true, description: 'Why work is being paused.' } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { team_id: { type: 'string', required: true }, halted: { type: 'boolean', required: true }, reason: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Team ${value.team_id} halted: ${value.reason}` }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const team = await requireCaptainTeam(workspaceOf(captain), config, captain)
      const halted = await haltTeam(stateRootOf(workspaceOf(captain), config), team.id, args.reason)
      return { team_id: halted.id, halted: halted.halted === true, reason: halted.haltReason ?? args.reason }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_resume',
    description: 'Explicitly resume a halted team. A non-empty reason is recorded and the scheduler is kicked once.',
    parameters: { reason: { type: 'string', required: true, description: 'Why work may resume.' } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { team_id: { type: 'string', required: true }, halted: { type: 'boolean', required: true }, reason: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Team ${value.team_id} resumed: ${value.reason}` }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const team = await requireCaptainTeam(workspace, config, captain)
      const resumed = await resumeTeam(stateRootOf(workspace, config), team.id, args.reason)
      await scheduler.kickTeam(workspace, resumed.id, captain)
      return { team_id: resumed.id, halted: resumed.halted === true, reason: resumed.resumeReason ?? args.reason }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_status',
    description: 'Team snapshot: members with live activity/runtime blockers and tasks with status/assignee/dependencies/output. Captains also see every team mailbox; members see only their own inbox. After inspection, use expert_teams_wait to end an idle waiting turn instead of polling.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    async execute(_args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const located = await requireParticipantTeam(workspace, config, caller)
      if (located.captainSessionId === caller.id) {
        await scheduler.kickTeam(workspace, located.id, caller)
      }
      const { team, identity } = await withTeamLock(
        teamLockKey(stateRoot, located.id),
        () => requireFreshParticipant(stateRoot, located.id, caller.id),
      )
      const activity = await memberActivity(ctx, team.captainSessionId)
      const members = team.members
        .filter((member) => member.status !== 'removed')
        .map((member) => ({
          name: member.name,
          role: member.role ?? '',
          provider: member.provider ?? '',
          model: member.model ?? '',
          reasoning_effort: member.reasoningEffort ?? '',
          status: member.status,
          runtime_block: member.runtimeBlock === undefined ? null : { ...member.runtimeBlock },
          activity: member.id !== '' ? (activity.get(member.id) ?? 'unknown') : 'unspawned',
        }))
      const tasks = team.tasks.map((task) => ({
        id: task.id,
        plan_logical_id: task.planTask?.logicalId ?? '',
        subject: task.subject,
        status: task.status,
        assignee: task.assignee ?? '',
        dependencies: task.dependencies,
        attempt: task.attempt ?? 0,
        attempt_id: task.attemptId ?? '',
        finalized_attempt_id: task.finalizedAttemptId ?? '',
        reassigning: task.reassigning === true,
        execution_state: task.executionState ?? 'active',
        wait_reason: task.waitReason ?? '',
        runtime_block: task.runtimeBlock === undefined ? null : { ...task.runtimeBlock },
        ...task.output !== undefined ? { output: task.output } : {},
        quality_closeout: task.qualityCloseout ?? null,
        // Forced-recovery fields: always present in the report (null/0 when no
        // quality policy applies or the task was never gated).
        quality_score: task.qualityScore ?? null,
        repair_count: task.repairCount ?? 0,
        quality_status: team.qualityRuns?.[task.id]?.status ?? (team.qualityRun?.contract.taskId === task.id ? team.qualityRun.status : ''),
        review_contract: reviewContractForStatus(team, task, stateRoot) ?? null,
        ...(task.researchRelease ? { reviewed_input_bundle: asToolJsonObject(task.researchRelease) } : {}),
        ...(task.researchInputReleases ? { input_release_digests: { ...task.researchInputReleases } } : {}),
        current_action: asToolJsonObject(currentTaskAction(team, task, identity.name)),
        ...repairFeedbackResult(team, task, stateRoot),
        input_artifact_manifest: (task.inputArtifactManifest ?? []).map(item => ({ ...item })),
        input_source_overrides: task.inputSourceOverrides ?? {}, input_revisions: JSON.parse(JSON.stringify(task.inputRevisions ?? [])) as JsonValue,
        input_artifact_warnings: taskInputWarnings(task),
      }))
      const mailboxWarnings: string[] = []
      let mailboxWarningCount = 0
      const reportMalformed = (agentKey: string) => (lineNumber: number): void => {
        mailboxWarningCount += 1
        if (mailboxWarnings.length < 10) {
          mailboxWarnings.push(`${agentKey} mailbox line ${lineNumber}`)
        }
      }
      const captainInbox = identity.kind === 'captain'
        ? await readUnreadMailbox(stateRoot, team.id, CAPTAIN_KEY, reportMalformed(CAPTAIN_KEY))
        : []
      const ownInbox = identity.kind === 'captain' ? captainInbox : await readUnreadMailbox(stateRoot, team.id, identity.name, reportMalformed(identity.name))
      const visibleInbox = ownInbox.slice(0, 10)
      const memberInboxes: Record<string, { count: number; latest: string }> = {}
      const visibleMembers = identity.kind === 'captain'
        ? members
        : members.filter((member) => member.name === identity.name)
      for (const member of visibleMembers) {
        const messages = await readUnreadMailbox(
          stateRoot,
          team.id,
          member.name,
          reportMalformed(member.name),
        )
        if (messages.length > 0) {
          memberInboxes[member.name] = {
            count: messages.length,
            latest: messages[messages.length - 1]?.content.slice(0, 200) ?? '',
          }
        }
      }
      const result = {
        team_id: team.id,
        team_name: team.name,
        confirmation_links: identity.kind === 'captain' ? (await Promise.all(team.tasks.map(async task => {
          if (task.status !== 'pending' || task.humanChoice === undefined) return []
          const source = team.tasks.find(item => item.id === task.humanChoice?.sourceTaskId)
          if (source?.status !== 'completed') return []
          const gate = /outline|大纲/iu.test(`${task.planTask?.logicalId ?? ''} ${task.subject}`) ? 'outline' : 'body'
          const url = await issueReviewShareLink(stateRoot, config.reviewPublicOrigin, { captainSessionId: team.captainSessionId, teamId: team.id, planId: team.planRef?.planId, gate, taskId: task.id })
          return url === undefined ? [] : [{ gate, task_id: task.id, url }]
        }))).flat() : [],
        description: team.description ?? '',
        halted: team.halted === true,
        halt_reason: team.haltReason ?? '',
        quality_status: team.qualityRun?.status ?? '',
        captain_runtime_block: team.captainRuntimeBlock === undefined ? null : { ...team.captainRuntimeBlock },
        viewer: identity.name,
        members,
        tasks,
        captain_inbox: (identity.kind === 'captain' ? visibleInbox : []).map((message) => ({
          from: message.from,
          content: message.content,
          ts: message.ts,
        })),
        inbox: visibleInbox.map(message => ({ id: message.id, from: message.from, content: message.content, ts: message.ts })),
        inbox_pending_count: ownInbox.length,
        member_inboxes: memberInboxes,
        mailbox_warnings: mailboxWarnings,
        mailbox_warning_count: mailboxWarningCount,
      }
      const acknowledged = visibleInbox.map(message => message.id)
      if (acknowledged.length > 0) {
        await withTeamLock(teamLockKey(stateRoot, team.id), () => (
          acknowledgeMailbox(stateRoot, team.id, identity.kind === 'captain' ? CAPTAIN_KEY : identity.name, acknowledged)
        ))
      }
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_library_doctor',
    description: 'Read-only diagnostics for the current Expert Teams state root. It reports schema, plan, lock, mailbox, attempt, route, capability and quality findings without writing state or waking agents.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      const captain = requireCaptain(exec)
      return asToolJsonObject(await inspectExpertTeamsState(stateRootOf(workspaceOf(captain), config)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_delete',
    description: 'End your team: interrupts all members (best effort) and deletes the team\'s state directory (team file, tasks, mailboxes). Use when the team\'s work is done or abandoned.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'boolean', required: true },
          team_name: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Team "${value.team_name}" deleted.`,
      }],
    },
    async execute(_args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      const members = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        // Include previously removed members so deleting a pre-fix team also
        // retires durable catalog entries left behind by remove_member.
        const roster = fresh.members.map(member => ({ ...member }))
        for (const member of fresh.members) {
          if (member.status === 'removed') continue
          member.status = 'removed'
          for (const task of fresh.tasks) {
            if (task.assignee === member.name && !TERMINAL_TASK_STATUSES.includes(task.status)) invalidateTaskAttempt(task)
          }
        }
        await writeTeam(stateRoot, fresh)
        return roster
      })
      await recordRetiredMemberIds(stateRoot, members.map(member => member.id))
      for (const member of members) {
        if (member.id === '') continue
        interruptMember(ctx, captain, member.id)
      }
      const quiescence = await Promise.allSettled(members.map(member => waitForMemberIdle(ctx, member, exec.signal)))
      for (const result of quiescence) {
        if (result.status === 'rejected') {
          ctx.logger.warn(`expert-teams: member did not quiesce cleanly before team archive: ${String(result.reason)}`)
        }
      }
      await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'expert-teams/team-deleted', {
          teamId: fresh.id,
        })
        // Archive, not delete: tasks (with their dependency graph) and the
        // mailboxes stay on disk for later review and dependency rebuilds.
        await archiveTeamDir(stateRoot, fresh.id)
      })
      return { deleted: true, team_name: team.name }
    },
  }))

  return { memberSelections, scheduler }
}

/** Render the status snapshot as compact text for the model. */
function renderStatus(value: JsonValue): string {
  const team = value as {
    team_name: string
    description?: string
    halted?: boolean
    halt_reason?: string
    quality_status?: string
    captain_runtime_block?: { id: string; code: string; message: string } | null
    viewer: string
    confirmation_links?: { gate: string; task_id: string; url: string }[]
    members: {
      name: string
      role: string
      provider: string
      model: string
      reasoning_effort: string
      status: string
      activity: string
      runtime_block?: { id: string; code: string; message: string } | null
    }[]
    tasks: { id: string; plan_logical_id?: string; subject: string; status: string; assignee: string; dependencies: string[]; attempt: number; attempt_id: string; finalized_attempt_id?: string; input_artifact_manifest?: unknown[]; input_artifact_warnings?: string[]; reassigning: boolean; execution_state?: string; wait_reason?: string; output?: string; quality_score: number | null; repair_count: number; quality_status?: string; repair_feedback?: string; review_contract?: ReturnType<typeof reviewContractForStatus> | null; current_action?: ReturnType<typeof currentTaskAction> }[]
    inbox?: { id: string; from: string; content: string }[]
    inbox_pending_count?: number
    captain_inbox: { from: string; content: string }[]
    member_inboxes: Record<string, { count: number; latest: string }>
    mailbox_warnings: string[]
    mailbox_warning_count: number
  }
  const lines: string[] = [
    `Team "${team.team_name}"${team.description ? ` — ${team.description}` : ''}`,
    `Viewing as: ${team.viewer}`,
    ...(team.confirmation_links ?? []).map(link => `${link.gate === 'outline' ? 'Outline' : 'Body'} confirmation for ${link.task_id}: ${link.url}`),
    ...(team.halted ? [`HALTED: ${team.halt_reason || 'operator requested pause'}`] : []),
    ...(team.quality_status ? [`Quality run: ${team.quality_status}`] : []),
    ...(team.captain_runtime_block ? [`Captain BLOCKED: ${team.captain_runtime_block.code} — ${team.captain_runtime_block.message} (block ${team.captain_runtime_block.id}; explicit resume_member(member="captain") required)`] : []),
    `Members (${team.members.length}):`,
    ...team.members.map((member) => {
      const route = member.provider && member.model ? ` · ${member.provider}/${member.model}` : ''
      const effort = member.reasoning_effort ? ` · reasoning ${member.reasoning_effort}` : ''
      const blocked = member.runtime_block ? ` BLOCKED ${member.runtime_block.code}: ${member.runtime_block.message} (block ${member.runtime_block.id}; explicit resume_member required)` : ''
      return `  - ${member.name} [${member.role}] ${member.status}/${member.activity}${route}${effort}${blocked}`
    }),
    `Tasks (${team.tasks.length}):`,
    ...team.tasks.map((task) => {
      const deps = task.dependencies.length > 0 ? ` (deps: ${task.dependencies.join(',')})` : ''
      const output = task.output !== undefined ? `\n      output: ${task.output.slice(0, 300)}` : ''
      const handoff = task.reassigning ? ' (reassigning)' : ''
      const waiting = task.execution_state && task.execution_state !== 'active' ? ` [${task.execution_state}: ${task.wait_reason || 'awaiting next event'}]` : ''
      const quality = task.status === 'completed'
        ? `\n      质量分 ${task.quality_score ?? '—'} ｜ 修复 ${task.repair_count} 轮`
        : ''
      const finalized = task.finalized_attempt_id ? `\n      Finalized report receipt: task_id="${task.id}", attempt_id="${task.finalized_attempt_id}"; content changes need a new follow-up task.` : ''
      const inputs = (task.input_artifact_manifest?.length ? `\n      Fixed dependency inputs: ${JSON.stringify(task.input_artifact_manifest)}` : '')
        + (task.input_artifact_warnings ?? []).map(warning => `\n      Input warning: ${warning}`).join('')
      const planId = task.plan_logical_id ? ` (plan: ${task.plan_logical_id})` : ''
      const qualityStatus = task.quality_status ? ` quality=${task.quality_status}` : ''
      const action = task.current_action ? `\n      Your current action: ${JSON.stringify(task.current_action)}` : ''
      const contract = task.review_contract
      const repair = task.repair_feedback ? `\n      ${task.repair_feedback}` : ''
      const review = contract == null ? '' : [
        `review_contract ${contract.run_id}: task_id=${contract.task_id}, attempt=${contract.attempt}, status=${contract.status}`,
        `acceptance (every exact ID required): ${JSON.stringify(contract.acceptance)}`,
        ...(contract.independent_review_areas.length === 0 ? [] : [`independent_review areas (every exact ID required): ${JSON.stringify(contract.independent_review_areas)}`]),
        ...(contract.published_artifacts.length === 0 ? [] : [`Current published bindings: ${JSON.stringify(contract.published_artifacts)}`]),
        ...(contract.task_output_binding === null ? [] : [`Automatic task-output binding: ${JSON.stringify(contract.task_output_binding)}`]),
        ...(contract.missing_publications.length === 0 ? [] : [`Missing current-attempt publications: ${contract.missing_publications.join(', ')}`]),
        `Declared deliverables: ${JSON.stringify(contract.deliverables)}; Host verification commands: ${JSON.stringify(contract.verify)}`,
        `next_action: ${contract.next_action}`,
      ].map(line => `\n      ${line}`).join('')
      return `  - ${task.id}${planId} [${task.status}] attempt ${task.attempt}${handoff}${waiting}${qualityStatus} ${task.subject} → ${task.assignee || 'unassigned'}${deps}${quality}${finalized}${inputs}${output}${repair}${review}${action}`
    }),
    `Your inbox (${(team.inbox ?? team.captain_inbox).length} shown / ${team.inbox_pending_count ?? team.captain_inbox.length} pending):`,
    ...(team.inbox ?? team.captain_inbox).map((message) => `  - [${message.from}] ${message.content}`),
  ]
  for (const [name, inbox] of Object.entries(team.member_inboxes)) {
    lines.push(`Member inbox ${name} (${inbox.count}): latest — ${inbox.latest.slice(0, 120)}`)
  }
  if (team.mailbox_warning_count > 0) {
    lines.push(
      `Mailbox warnings (${team.mailbox_warning_count}; malformed lines were skipped; showing up to 10):`,
      ...team.mailbox_warnings.map((warning) => `  - ${warning}`),
    )
  }
  return lines.join('\n')
}
