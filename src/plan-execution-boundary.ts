import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { StagedPlan } from './types.ts'
import { withTeamLock } from './state.ts'
/** Native tool boundary for sessions explicitly admitted to a planned workflow. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ToolsConfig } from './team-core.ts'
import { stateRootOf, workspaceOf } from './team-core.ts'
import { captureSharedTaskContext } from './shared-task-context.ts'
import { planInputSha256, readPlanExecutionAuthorization } from './plan-authorization.ts'
import { readStagedPlan } from './staged-plan.ts'
import { findTeamByParticipant } from './state.ts'

// No shell, generic code transport, data provider, web fetch, member spawn or
// write operation is a planning primitive. Skill/material reads use native reads.
const PLANNING_TOOLS = new Set([
  'read', 'read_file', 'read_files', 'ls', 'glob', 'grep', 'rg', 'list_directory',
  'tool_search', 'search_tools', 'list_tools', 'list_subagent_models',
  'expert_library_doctor', 'expert_teams_plan_preview', 'expert_teams_plan_stage',
  'expert_teams_plan_edit', 'expert_teams_plan_approve', 'expert_teams_plan_discard',
  'expert_teams_scenario_apply', 'expert_review_route', 'expert_review_clarify',
  'expert_teams_report', 'expert_teams_ppt', 'expert_teams_debate', 'expert_teams_roundtable',
  'expert_review_apply', 'expert_teams_status', 'expert_teams_wait',
  'get_goal', 'update_goal', 'request_user_input', 'todo_write',
])
const BLOCKED = 'PLAN_EXECUTION_APPROVAL_REQUIRED: this session is in planning. Review and confirm its current outline, models, craft and task plan before business data retrieval, calculation, report production or member startup. Planning may use todo_write, discover tools and read supplied local materials. For expert selection use expert_review_route, which returns a shortlist; then call expert_teams_plan_stage with the outline, model routes, crafts and tasks. Do not scan all expert personas or checker source merely to choose a team. Shell and generic code execution remain unavailable until approval.'

const policyFile = (root: string, captain: string) => join(root, 'plans', 'execution-boundaries', createHash('sha256').update(captain).digest('hex') + '.json')
interface BoundaryRecord { captain: string; contextSha256: string; plans: string[] }
async function readBoundary(root: string, captain: string): Promise<BoundaryRecord | undefined> {
  try {
    const row = JSON.parse(await readFile(policyFile(root, captain), 'utf8')) as BoundaryRecord
    if (row.captain !== captain || !/^[a-f0-9]{64}$/u.test(row.contextSha256) || !Array.isArray(row.plans) || row.plans.length > 100 || row.plans.some(id => typeof id !== 'string' || !/^plan-[a-f0-9]+$/u.test(id))) throw new Error('PLAN_BOUNDARY_INVALID')
    return row
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
/** Persist before the staged record, so a crash never opens an execution gap. */
export async function recordPlanExecutionBoundary(root: string, plan: StagedPlan): Promise<void> {
  if (plan.runtime.sharedTaskContext === undefined) throw new Error('PLAN_BOUNDARY_CONTEXT_REQUIRED')
  const file = policyFile(root, plan.createdBy)
  await withTeamLock(`plan-boundary:${file}`, async () => {
    const old = await readBoundary(root, plan.createdBy)
    const contextSha256 = plan.runtime.sharedTaskContext!.sha256
    const plans = [...new Set([...(old?.contextSha256 === contextSha256 ? old.plans : []), plan.planId])]
    if (plans.length > 100) throw new Error('PLAN_BOUNDARY_PLAN_LIMIT')
    await mkdir(join(root, 'plans', 'execution-boundaries'), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ captain: plan.createdBy, contextSha256, plans }), { flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
  })
}

export async function planExecutionDenial(exec: Pick<ToolExecution, 'agent' | 'name'>, config: ToolsConfig): Promise<string | undefined> {
  const captain = exec.agent
  if (captain === undefined || PLANNING_TOOLS.has(exec.name)) return undefined
  const root = stateRootOf(workspaceOf(captain), config)
  const team = await findTeamByParticipant(root, captain.id)
  // Existing members continue under their own frozen capability and attempt
  // boundaries. A captain needs the durable approved plan for its own tools.
  if (team !== undefined && team.captainSessionId !== captain.id) return undefined
  const context = captureSharedTaskContext(captain)
  const grant = await readPlanExecutionAuthorization(root, captain.id)
  const explicitlyRequired = grant?.requireReviewedReport === true && planInputSha256(context) === grant.expectedInputSha256
  const boundary = await readBoundary(root, captain.id)
  const ids = boundary?.contextSha256 === context.sha256 ? boundary.plans : []
  const plans = (await Promise.all(ids.map(id => readStagedPlan(root, id))))
    .filter(p => p !== undefined && p.createdBy === captain.id && p.runtime.sharedTaskContext?.sha256 === context.sha256)
  if (!explicitlyRequired && !ids.length) return undefined
  const approved = plans.find(p => p!.status === 'completed' && p!.appliedTeamId === team?.id
    && p!.approval?.digest === p!.digest && p!.approval?.revision === p!.revision && p!.approval?.contextSha256 === context.sha256)
  if (approved === undefined || team?.halted === true) return BLOCKED
  const route = approved.plan.captainModel
  if (route !== undefined) {
    const actual = captain.session.requestHeader()?.config
    if ((actual?.provider ?? captain.options.provider) !== route.provider || (actual?.model ?? captain.options.model) !== route.model
      || (actual?.reasoningEffort ?? 'default') !== (route.reasoningEffort ?? 'default')) return 'PLAN_EXECUTION_MODEL_MISMATCH: captain route differs from the approved plan; restore the approved session model before execution.'
  }
  // Applying a plan does not start its captain-owned tasks. Keep coordination
  // available while requiring the same explicit work/review lifecycle used by
  // members. A submitted member output may be inspected by the captain; the
  // quality tools still authenticate the reviewer and frozen artifact version.
  if (team !== undefined && team.tasks.length > 0 && !exec.name.startsWith('expert_teams_')
    && !team.tasks.every(task => task.status === 'completed')) {
    const working = team.tasks.some(task => task.assignee === 'captain' && task.status === 'in_progress'
      && task.attemptId !== undefined && (task.executionState === undefined || task.executionState === 'active'))
    const reviewing = team.tasks.some(task => task.assignee !== undefined && task.assignee !== 'captain'
      && task.status === 'in_progress' && task.executionState === 'awaiting_review')
    if (!working && !reviewing) {
      const ready = team.tasks.filter(task => task.assignee === 'captain'
        && (task.status === 'pending' || task.status === 'claimed')
        && task.dependencies.every(id => team.tasks.some(parent => parent.id === id && parent.status === 'completed')))
      return 'PLAN_TASK_EXECUTION_REQUIRED: the plan is approved, but captain business execution has no active task or submitted member work to review. '
        + (ready.length ? `Ready captain task_ids: ${ready.map(task => task.id).join(', ')}. Claim one with expert_teams_claim_task, then call expert_teams_update_task(status=in_progress, attempt_id=<returned attempt>) before business tools. ` : '')
        + 'Inspect expert_teams_status. Publish the assigned evidence, obtain independent quality review and integrate it before downstream work. Coordinate member work or use expert_teams_wait for a real pending event; approval alone does not complete the report.'
    }
  }
  return undefined
}

export function installPlanExecutionBoundary(ctx: Context, config: ToolsConfig): void {
  const denied = new Map<ToolExecution['token'], string>()
  ctx.effect(() => ctx.tools.guard(exec => denied.get(exec.token)))
  const nativePlanning = new Map<Agent, () => void>()
  ctx.effect(() => () => { for (const dispose of nativePlanning.values()) dispose(); nativePlanning.clear() })
  ctx.on('agent/pre-step', async (step, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const reason = await planExecutionDenial({ agent: step.agent, name: 'run_code' }, config)
    if (reason !== undefined && !nativePlanning.has(step.agent)) {
      nativePlanning.set(step.agent, step.agent.ctx.tools.presentAs('native'))
    } else if (reason === undefined) {
      nativePlanning.get(step.agent)?.()
      nativePlanning.delete(step.agent)
    }
    return decision
  })
  ctx.on('agent/disposed', ({ agent }) => { nativePlanning.get(agent)?.(); nativePlanning.delete(agent) })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    let reason: string | undefined
    try { reason = await planExecutionDenial(exec, config) }
    catch { reason = 'PLAN_EXECUTION_STATE_UNAVAILABLE: approval state could not be verified; no business tool was dispatched.' }
    if (reason === undefined) return decision
    denied.set(exec.token, reason)
    return { kind: 'deny', reason }
  })
  ctx.on('tools/result', exec => { denied.delete(exec.token) })
}
