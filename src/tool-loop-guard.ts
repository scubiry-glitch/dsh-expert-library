/** Bounded protection for repeated observations, including multi-call read cycles.
 * This is a repetition heuristic, not proof that a tool had no side effects.
 * No arguments, outputs, business facts or credentials are persisted here.
 */
import { canonicalDigest } from './v2/digest.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { findTeamByParticipant, readTeam, withTeamLock, writeTeam, appendMailbox, createMessage } from './state.ts'
import { stateRootOf, workspaceOf, type ToolsConfig } from './team-core.ts'
import { shellOperationKey } from './structured-tool-failure.ts'
import { captureRuntimeTurn, recordRuntimeFailure } from './runtime-failure.ts'
import { planExecutionDenial } from './plan-execution-boundary.ts'
import { captureSharedTaskContext } from './shared-task-context.ts'
import { readPlanningLoopStop, persistPlanningLoopStop } from './planning-loop-stop.ts'

export const IDENTICAL_TOOL_LIMIT = 8
export const LOOP_CORRECTION_LIMIT = 3
const hash = canonicalDigest
interface Observation { call: string; output: string; count: number; name: string }
interface TurnBudget {
  turn: number; observation?: Observation; repeated: number; rejected: number
  observations: Set<string>; calls: Set<string>; readLines: Set<string>
}
export const LOOP_HISTORY_LIMIT = 256
export const LOOP_READ_LINE_LIMIT = 32768
function remember(set: Set<string>, key: string, limit: number): void {
  set.delete(key); set.add(key)
  if (set.size > limit) set.delete(set.values().next().value!)
}

export class ToolLoopBudget {
  private readonly rows = new WeakMap<object, TurnBudget>()
  enter(agent: object, turn: number): void {
    if (this.rows.get(agent)?.turn !== turn) this.rows.set(agent, {
      turn, repeated: 0, rejected: 0, observations: new Set(), calls: new Set(), readLines: new Set(),
    })
  }
  clear(agent: object): void { this.rows.delete(agent) }
  reason(agent: object, call: string): string | undefined {
    const row = this.rows.get(agent), o = row?.observation
    if (!row || !o || !((o.call === call && o.count >= IDENTICAL_TOOL_LIMIT)
      || (row.repeated >= IDENTICAL_TOOL_LIMIT && row.calls.has(call)))) return
    return `TOOL_LOOP_REPETITION: repeated calls are returning already observed results, including multi-call cycles. This repeat was not dispatched. Use existing evidence and change the operation or produce the assigned deliverable. Before a team exists, use expert_review_route for a focused expert shortlist, then expert_teams_plan_stage with the outline, models, craft and tasks; do not rescan every expert or checker source. Use the team wait tool only for a real external event. Three rejected repeats without a new observation stop this turn. Repetition does not prove that previous calls had no side effects.`
  }
  rejected(agent: object): void { const row = this.rows.get(agent); if (row) row.rejected++ }
  settled(agent: object, call: string, output: string, name: string, readLines?: readonly string[], observationKey?: string): void {
    const row = this.rows.get(agent)
    if (!row) return
    const key = observationKey ?? hash([call, output])
    const repeated = readLines?.length ? readLines.every(line => row.readLines.has(line)) : row.observations.has(key)
    row.repeated = repeated ? row.repeated + 1 : 0
    if (!repeated) row.rejected = 0
    remember(row.observations, key, LOOP_HISTORY_LIMIT); remember(row.calls, call, LOOP_HISTORY_LIMIT)
    for (const line of readLines ?? []) remember(row.readLines, line, LOOP_READ_LINE_LIMIT)
    const old = row.observation
    row.observation = { call, output, name,
      count: old?.call === call && old.output === output ? old.count + 1 : 1 }
  }
  exhausted(agent: object): boolean { return (this.rows.get(agent)?.rejected ?? 0) >= LOOP_CORRECTION_LIMIT }
}

/** Native read's public structured result, not its formatted footer. Hash each
 * actual returned line so re-slicing the same unchanged file is not progress.
 * Unknown/malformed result shapes conservatively retain exact-result matching.
 * Only bounded hashes are retained in memory; no file content is persisted.
 */
export function toolLoopReadKeys(exec: Pick<ToolExecution, 'name'>, result: Readonly<ToolExecutionResult>): string[] | undefined {
  if (exec.name !== 'read' || result.isError || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) return
  const value = result.value as Record<string, unknown>
  if (typeof value.path !== 'string' || !Number.isInteger(value.offset) || (value.offset as number) < 1
    || !Number.isInteger(value.totalLines) || (value.totalLines as number) < 0 || !Array.isArray(value.lines)
    || value.lines.length > LOOP_READ_LINE_LIMIT) return
  let last = (value.offset as number) - 1
  const keys: string[] = []
  for (const item of value.lines) {
    if (!item || typeof item !== 'object' || !Number.isInteger(item.number) || item.number <= last
      || item.number > (value.totalLines as number) || typeof item.text !== 'string') return
    keys.push(hash([value.path, value.totalLines, item.number, item.text])); last = item.number
  }
  return keys
}

function artifactReadArgs(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const args = value as Record<string, unknown>
  if (typeof args.task_id === 'string' && typeof args.source_task_id === 'string' && typeof args.artifact_id === 'string'
    && (args.offset === undefined || (Number.isSafeInteger(args.offset) && (args.offset as number) >= 0))
    && (args.limit === undefined || (Number.isSafeInteger(args.limit) && (args.limit as number) >= 1 && (args.limit as number) <= 16000))) return args
}
export function toolLoopCallKey(exec: Pick<ToolExecution, 'name' | 'arguments'>): string {
  const args = exec.name === 'expert_teams_read_artifact' ? artifactReadArgs(exec.arguments) : undefined
  if (args) {
    // The immutable pinned artifact is the operation. Pagination is progress
    // only when it returns a new observation, not merely a new cursor.
    return hash([exec.name, args.task_id, args.source_task_id, args.artifact_id])
  }
  return shellOperationKey(exec) ?? hash([exec.name, exec.arguments])
}
export function toolLoopResultKey(result: Readonly<ToolExecutionResult>): string {
  // Compare the actual model-facing observation, including success/error state.
  // Timing/usage metadata and call IDs must not manufacture apparent progress.
  return hash([result.isError, result.content])
}

/** Only a complete empty EOF result is cursor-independent. Nonempty pages keep
 * their range in the observation, so equal text at different offsets is valid.
 * This is repetition accounting, not artifact authorization or hash verification.
 */
function artifactEndObservationKey(exec: Pick<ToolExecution, 'name' | 'arguments'>, result: Readonly<ToolExecutionResult>): string | undefined {
  if (exec.name !== 'expert_teams_read_artifact' || result.isError || !result.value
    || typeof result.value !== 'object' || Array.isArray(result.value)) return
  const args = artifactReadArgs(exec.arguments)
  if (!args) return
  const value = result.value as Record<string, unknown>
  if (value.binary === true || value.eof !== true || value.next_offset !== null || value.content !== ''
    || value.returned_characters !== 0 || typeof value.artifact_id !== 'string'
    || value.artifact_id !== args.artifact_id
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || !Number.isSafeInteger(value.total_characters) || (value.total_characters as number) < 0
    || !Number.isSafeInteger(value.offset) || (value.offset as number) < (value.total_characters as number)) return
  return hash(['pinned-artifact-end', toolLoopCallKey(exec), value.sha256, value.total_characters])
}

/** Recognize complete report-tool observations by their content digests. A new
 * output filename is not new evidence. This is only repetition accounting:
 * these self-reported envelopes never establish provenance or quality approval.
 * Unknown, truncated, aborted and changed observations keep normal semantics.
 */
export function toolLoopReportObservationKey(exec: Pick<ToolExecution, 'name'>, result: Readonly<ToolExecutionResult>): string | undefined {
  const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v)
  if (exec.name !== 'bash' || result.isError || !record(result.value)
    || result.value.aborted === true || result.value.timedOut === true
    || ![0, 1, 2].includes(result.value.exitCode as number)) return
  const stdout = result.value.stdout
  if (!record(stdout) || stdout.truncated === true || typeof stdout.text !== 'string' || stdout.text.length > 256 * 1024) return
  let value: unknown
  try { value = JSON.parse(stdout.text) } catch { return }
  if (!record(value) || value.qualityApproved !== false || value.hostReceipt !== false) return
  if (value.status === 'BOUND_DRAFT') {
    const reports = value.reportSha256
    if (result.value.exitCode !== 0 || !record(reports) || Object.keys(reports).sort().join(',') !== 'html,md,pdf'
      || !Object.values(reports).every(digest) || !digest(value.evidenceSha256)
      || typeof value.output !== 'string' || !value.output.startsWith('/')) return
    return hash(['report-assembly-observation', reports, value.evidenceSha256])
  }
  if (value.status !== 'failed' || value.inputFilesUnchanged !== true
    || typeof value.packId !== 'string' || typeof value.packVersion !== 'string' || !Array.isArray(value.selections)
    || !Array.isArray(value.artifacts) || value.artifacts.length !== 4
    || !value.artifacts.every(a => record(a) && typeof a.role === 'string' && typeof a.path === 'string' && digest(a.sha256))
    || value.artifacts.map(a => a.role).sort().join(',') !== 'evidence,html,md,pdf'
    || !Array.isArray(value.results) || !value.results.length || value.results.length > 32
    || !value.results.every(r => record(r) && typeof r.id === 'string' && r.id.startsWith('report-craft-')
      && ['passed', 'failed', 'unverified'].includes(r.status as string) && typeof r.detail === 'string')
    || !value.results.some(r => r.status === 'failed')) return
  return hash(['report-preflight-observation', value.packId, value.packVersion, value.selections,
    value.artifacts.map(a => [a.role, a.sha256]).sort(), value.results])
}

export function installToolLoopGuard(ctx: Context, config: ToolsConfig): void {
  const budget = new ToolLoopBudget()
  const participants = new WeakSet<Agent>()
  const denied = new Map<ToolExecution['token'], string>()
  ctx.effect(() => ctx.tools.guard(exec => denied.get(exec.token)))
  ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || signal.aborted) return decision
    // The Host journals admitted messages after pre-step. A direct user input
    // must be allowed through that boundary before its new context can exist.
    const directUserAdmission = decision.messages.some(message => message.source.kind === 'user')
    if (directUserAdmission) budget.clear(agent)
    const root = stateRootOf(workspaceOf(agent), config)
    const team = await findTeamByParticipant(root, agent.id)
    const planning = !team && (await planExecutionDenial({ agent, name: 'run_code' }, config)) !== undefined
    if ((!team && !planning) || team?.halted) {
      participants.delete(agent); budget.clear(agent)
      return decision
    }
    const context = planning ? captureSharedTaskContext(agent) : undefined
    if (context !== undefined && !directUserAdmission && await readPlanningLoopStop(root, agent.id, context.sha256)) {
      await persistPlanningLoopStop(ctx, agent, root, context.sha256, turn)
      throw new Error('TOOL_LOOP_DETECTED: planning was stopped for repeated observations. A new direct user instruction is required to recover; the paused Goal is not automatically resumed.')
    }
    participants.add(agent)
    budget.enter(agent, turn)
    if (budget.exhausted(agent)) {
      if (context !== undefined) {
        await persistPlanningLoopStop(ctx, agent, root, context.sha256, turn)
        throw new Error('TOOL_LOOP_DETECTED: pre-team planning stopped after repeated observations and three corrective rejections. Use a new direct user instruction to recover; retain the existing evidence and stage a focused plan.')
      }
      if (!team) return decision
      const message = 'Repeated tool observations continued after three corrective rejections. Inspect the existing results and choose a different operation before explicitly resuming this member; retain its current task attempt and review state.'
      // Different Host installations may normalize foreign Error subclasses as
      // UNKNOWN. Persist this plugin-owned terminal decision independently;
      // the native driver remains the sole writer of its own turn/end event.
      await withTeamLock(`team:${root}:${team.id}`, async () => {
        const fresh = await readTeam(root, team.id)
        if (!fresh || fresh.halted) return
        captureRuntimeTurn(fresh, agent.id, turn)
        const block = recordRuntimeFailure(fresh, agent.id, turn, { code: 'TOOL_LOOP_DETECTED', message }, Date.now())
        if (!block) return
        await appendMailbox(root, fresh.id, 'captain', createMessage('scheduler', 'captain',
          `Member runtime stopped: session ${agent.id}, turn ${turn}, code ${block.code}. ${message} Automatic redispatch is paused.`,
          { idempotencyKey: block.id }))
        await writeTeam(root, fresh)
      })
      throw new Error('TOOL_LOOP_DETECTED: ' + message)
    }
    return decision
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow' || exec.parent !== undefined || !exec.agent || !participants.has(exec.agent)) return decision
    const reason = budget.reason(exec.agent, toolLoopCallKey(exec))
    if (!reason) return decision
    denied.set(exec.token, reason)
    return { kind: 'deny', reason }
  })
  ctx.on('tools/result', (exec, result) => {
    const ours = denied.delete(exec.token)
    if (!exec.agent || exec.parent !== undefined || !participants.has(exec.agent)) return
    if (ours) budget.rejected(exec.agent)
    else budget.settled(exec.agent, toolLoopCallKey(exec), toolLoopResultKey(result), exec.name,
      toolLoopReadKeys(exec, result), artifactEndObservationKey(exec, result) ?? toolLoopReportObservationKey(exec, result))
  })
  ctx.on('agent/disposed', ({ agent }) => { participants.delete(agent); budget.clear(agent) })
  ctx.effect(() => () => denied.clear())
}
