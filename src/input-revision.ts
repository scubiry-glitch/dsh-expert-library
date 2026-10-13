import type { TeamState, TeamTask } from './types.ts'
import { canonicalDigest } from './v2/digest.ts'
import { prepareDependencyInputs } from './dependency-inputs.ts'
import { forkQualityRun } from './quality-run.ts'
import { invalidateTaskAttempt } from './state.ts'
import { verifyFrozenSkillCraftContract } from './skill-craft.ts'

export interface InputRevisionRequest {
  taskId: string
  sourceTaskId: string
  replacementTaskId: string
  expectedAttempt: number
  expectedAttemptId?: string
  eventId: string
  reason: string
  /** Explicit captain resolution of this exact external wait, committed only
   * together with verified replacement inputs. Runtime/human gates stay closed. */
  expectedWaitReason?: string
}

export interface InputRevisionReceipt extends InputRevisionRequest {
  fingerprint: string
  actor: 'captain'
  at: number
  logicalSource: string
  nextAttempt: number
  previousDependencies: string[]
  previousInputs: NonNullable<TeamTask['inputArtifacts']>
  previousManifest: NonNullable<TeamTask['inputArtifactManifest']>
  nextManifest: NonNullable<TeamTask['inputArtifactManifest']>
}

/** Caller authenticates the original captain and holds the team lock. All
 * validation runs on a clone; failure cannot partially rewrite durable pins.
 * A live owner must first finish its turn. This never accepts a review. */
export async function reviseTaskInputs(stateRoot: string, original: TeamState, request: InputRevisionRequest,
  ownerActivity: string | undefined): Promise<{ team: TeamState; receipt: InputRevisionReceipt; applied: boolean }> {
  const fail = (message: string): never => { throw new Error(`INPUT_REVISION_REJECTED: ${message}`) }
  if (!request.reason.trim() || !request.eventId.trim() || !Number.isSafeInteger(request.expectedAttempt)
    || request.expectedAttempt < 0) fail('reason, event ID and expected attempt are required')
  const fingerprint = canonicalDigest(request)
  const team = structuredClone(original)
  const task = team.tasks.find(t => t.id === request.taskId)
  if (!task) return fail('unknown consumer')
  const existing = task.inputRevisions?.find(r => r.eventId === request.eventId)
  if (existing) {
    if (existing.fingerprint !== fingerprint) return fail('idempotency conflict')
    return { team, receipt: existing, applied: false }
  }
  if ((task.inputRevisions?.length ?? 0) >= 32) fail('revision history limit reached')
  if (['completed', 'failed', 'cancelled'].includes(task.status) || task.humanChoice || task.humanChoiceReceipt
    || task.reassigning || task.runtimeBlock) fail('consumer is terminal, human-only or blocked')
  const resolveWait = request.expectedWaitReason !== undefined
  if (resolveWait) {
    if (!request.expectedWaitReason?.trim() || task.executionState !== 'blocked_external'
      || task.waitReason !== request.expectedWaitReason) fail('external wait changed; inspect the current blocker before resolving it')
  } else if (task.executionState === 'blocked_external') fail('consumer is blocked; provide its exact expectedWaitReason to resolve it atomically with input revision')
  if ((task.attempt ?? 0) !== request.expectedAttempt || task.attemptId !== request.expectedAttemptId) fail('stale consumer attempt')
  const owner = team.members.find(m => m.name === task.assignee && m.status !== 'removed')
  if (owner?.activation || owner?.runtimeBlock || (task.attemptId && ownerActivity !== 'idle' && ownerActivity !== 'ready')) fail('owner must be idle without an activation or runtime blocker')
  if (task.inputArtifacts !== undefined && task.inputArtifactBinding?.mode !== 'dependency-default') fail('explicit artifact selections require a separately planned follow-up')
  const source = team.tasks.find(t => t.id === request.sourceTaskId)
  const replacement = team.tasks.find(t => t.id === request.replacementTaskId)
  if (!source || !replacement || source.id === replacement.id || replacement.id === task.id
    || !task.dependencies.includes(source.id) || task.dependencies.includes(replacement.id)) return fail('invalid dependency replacement')
  if (!replacement.dependencies.includes(source.id) && replacement.revisesTaskId !== source.id) fail('replacement has no declared revision lineage to the source')
  for (const candidate of [source, replacement]) {
    const run = team.qualityRuns?.[candidate.id] ?? (team.qualityRun?.contract.taskId === candidate.id ? team.qualityRun : undefined)
    if (candidate.status !== 'completed' || candidate.humanChoice || !run || run.status !== 'integrated'
      || run.attempt !== candidate.attempt) fail('both source versions must have current integrated quality evidence')
  }
  const seen = new Set<string>()
  const reachesConsumer = (id: string): boolean => {
    if (id === task.id) return true
    if (seen.has(id)) return false
    seen.add(id)
    return team.tasks.find(t => t.id === id)?.dependencies.some(reachesConsumer) ?? false
  }
  if (reachesConsumer(replacement.id)) fail('dependency cycle')
  const logicalSource = Object.entries(task.inputSourceOverrides ?? {}).find(([, id]) => id === source.id)?.[0]
    ?? source.planTask?.logicalId ?? source.id
  if (task.plannedArtifactInputs !== undefined && !task.plannedArtifactInputs.some(i => i.fromTask === logicalSource)) fail('source has no approved input requirement')
  const run = team.qualityRuns?.[task.id] ?? (team.qualityRun?.contract.taskId === task.id ? team.qualityRun : undefined)
  if (!run || run.status !== 'pending' || run.latestEvidence || run.evidenceHistory.length !== 0) return fail('consumer must have an unreviewed pending quality run; resolve its prior review first')
  // Resuming separately can dispatch the old inputs before revision. Verify
  // the frozen craft here and commit the released wait only after every new
  // input has passed admission on this clone.
  if (task.frozenSkillCraftContract) verifyFrozenSkillCraftContract(task.frozenSkillCraftContract)
  const nextAttempt = (task.attempt ?? 0) + 1
  const receipt: InputRevisionReceipt = { ...request, fingerprint, actor: 'captain', at: Date.now(), logicalSource,
    nextAttempt, previousDependencies: [...task.dependencies], previousInputs: task.inputArtifacts ?? [],
    previousManifest: task.inputArtifactManifest ?? [], nextManifest: [] }
  if (task.attemptId !== undefined) {
    if (!task.assignee) return fail('active consumer has no owner')
    const revised = forkQualityRun(run, { eventId: request.eventId, actor: 'captain', reason: request.reason,
      assignee: task.assignee, attempt: nextAttempt }).run
    team.qualityRunHistory = { ...team.qualityRunHistory,
      [task.id]: [...(team.qualityRunHistory?.[task.id] ?? []), run] }
    team.qualityRuns = { ...team.qualityRuns, [task.id]: revised }
    if (team.qualityRun?.contract.taskId === task.id) team.qualityRun = revised
    invalidateTaskAttempt(task, task.assignee)
  } else if (task.status !== 'pending' || run.attempt !== nextAttempt) fail('consumer is not awaiting a fresh attempt')
  if (resolveWait) {
    task.executionState = undefined
    task.waitReason = undefined
    task.dispatch = undefined
  }
  task.dependencies = task.dependencies.map(id => id === source.id ? replacement.id : id)
  task.inputSourceOverrides = { ...task.inputSourceOverrides, [logicalSource]: replacement.id }
  task.inputArtifacts = undefined
  task.inputArtifactManifest = undefined
  task.inputArtifactBinding = undefined
  // This authorized revision starts a new consumer generation. Rebuild release
  // pins alongside file pins on this clone; ordinary dispatch still rejects drift.
  task.researchInputReleases = undefined
  // Validate and freeze the replacement even if a future consumer is waiting
  // on other dependencies (including a human decision).
  const probe = structuredClone(task)
  probe.dependencies = [replacement.id]
  probe.inputSourceOverrides = undefined
  probe.inputRevisions = undefined
  probe.plannedArtifactInputs = task.plannedArtifactInputs?.filter(i => i.fromTask === logicalSource)
    .map(i => ({ ...i, fromTask: replacement.planTask?.logicalId ?? replacement.id }))
  receipt.nextManifest = structuredClone(await prepareDependencyInputs(stateRoot, team, probe, nextAttempt))
  task.inputRevisions = [...(task.inputRevisions ?? []), receipt]
  if ((task.attempt ?? 0) !== 0) {
    // A restarted consumer freezes its full input set before dispatch.
    receipt.nextManifest = structuredClone(await prepareDependencyInputs(stateRoot, team, task, nextAttempt))
  }
  task.updatedAt = receipt.at
  if (owner && team.runtimeWaits) delete team.runtimeWaits[owner.id]
  return { team, receipt, applied: true }
}
