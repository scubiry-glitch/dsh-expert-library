import { canonicalDigest } from './v2/digest.ts'
import type { TeamMember, TeamTask } from './types.ts'
import type { QualityRun } from './quality-run.ts'

export const taskInputDigest = (task: TeamTask) => canonicalDigest(task.inputArtifactManifest ?? [])
export const taskScopeDigest = (task: TeamTask) => canonicalDigest({ subject: task.subject, description: task.description, dependencies: task.dependencies, plannedArtifactInputs: task.plannedArtifactInputs, reportBundle: task.reportBundle, frozenSkillCraftContract: task.frozenSkillCraftContract, skillBindings: task.skillBindings, promptBinding: task.promptBinding, frozenTaskMaterialContract: task.frozenTaskMaterialContract })

export const DEFAULT_REASSIGNMENT_GRACE_MS = 120_000

export interface ReassignmentObservation {
  expectedAttempt: number
  expectedAttemptId?: string
  activity: 'running' | 'idle' | 'ready' | 'unknown'
  member?: TeamMember
  quality?: QualityRun
  now: number
  graceMs?: number
}

/** Called under the team lock, before revoking an attempt or interrupting anyone. */
export function checkTaskReassignment(task: TeamTask, observation: ReassignmentObservation) {
  const { expectedAttempt, expectedAttemptId, activity, member, quality, now } = observation
  if (!Number.isSafeInteger(expectedAttempt) || expectedAttempt !== (task.attempt ?? 0)
    || task.attemptId !== undefined && task.attemptId !== expectedAttemptId) {
    throw new Error(`REASSIGNMENT_STALE: task=${task.id}; current attempt=${task.attempt ?? 0}, attempt_id=${task.attemptId ?? 'none'}. Read current state; no ownership changed.`)
  }
  if (task.status === 'completed' || task.reassigning === true) throw new Error('REASSIGNMENT_IMMUTABLE: completed or already reassigning')
  if (quality?.status === 'escalated') throw new Error('QUALITY_ESCALATED_CLOSEOUT_REQUIRED: the captain must close out this exhausted run before assigning follow-up work')
  if (task.runtimeBlock !== undefined || member?.runtimeBlock !== undefined || task.executionState === 'blocked_external') {
    throw new Error('REASSIGNMENT_EXTERNAL_BLOCK: resolve the recorded external condition through its supported flow; changing ownership cannot bypass it.')
  }
  if (task.executionState === 'awaiting_review' || quality?.status === 'reviewing' || quality?.status === 'passed') {
    throw new Error('REASSIGNMENT_AWAITING_REVIEW: preserve this attempt; the independent reviewer or captain integration must advance its existing evidence.')
  }
  const graceMs = observation.graceMs ?? DEFAULT_REASSIGNMENT_GRACE_MS
  if (!Number.isFinite(graceMs) || graceMs < 1_000 || graceMs > 3_600_000) throw new Error('REASSIGNMENT_POLICY_INVALID: grace must be 1000..3600000 ms')
  const publications = (task.publishedArtifacts ?? []).filter(a => a.attempt === task.attempt)
  const lastProgressAt = Math.max(task.attemptStartedAt ?? task.createdAt,
    task.dispatch?.attemptId === task.attemptId ? task.dispatch?.acceptedAt ?? task.dispatch?.dispatchedAt ?? 0 : 0,
    ...publications.map(a => a.createdAt))
  const active = task.status === 'claimed' || task.status === 'in_progress'
  // Only a confirmed stopped member may lose active work. A live model turn
  // includes provider queue/tool time and is not evidence that work is stuck.
  if (member !== undefined && (activity === 'running' || activity === 'unknown')) {
    throw new Error(`REASSIGNMENT_OWNER_ACTIVE: task=${task.id}; activity=${activity}. Observe progress or use an explicit user-controlled stop; no attempt revoked.`)
  }
  if (active && now - lastProgressAt < graceMs) {
    throw new Error(`REASSIGNMENT_RECENT_PROGRESS: task=${task.id}; lastProgressAt=${lastProgressAt}; retryAfter=${lastProgressAt + graceMs}. Preserve current publications; do not reassign for bookkeeping.`)
  }
  return { observedAt: now, previousAttempt: task.attempt ?? 0, previousAttemptId: task.attemptId,
    previousAssignee: task.assignee, activity, lastProgressAt, graceMs,
    inputDigest: taskInputDigest(task), scopeDigest: taskScopeDigest(task),
    publicationIds: publications.map(a => a.id) }
}
