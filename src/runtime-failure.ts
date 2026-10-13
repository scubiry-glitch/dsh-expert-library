/** Pure Host-turn failure bookkeeping; no provider retries or model calls. */
import type { RuntimeBlock, TeamState } from './types.ts'

export function runtimeRecoveryGuidance(code: string): string {
  return code === 'TOOL_LOOP_DETECTED'
    ? 'Inspect the existing results and choose a different operation before explicitly resuming this member session; preserve its task attempt and review state'
    : 'Restore this member provider/connection and explicitly resume this member session'
}

export function captureRuntimeTurn(team: TeamState, sessionId: string, turn: number, startedAt = Infinity): boolean {
  const member = team.members.find(item => item.id === sessionId && item.status !== 'removed')
  if (member === undefined || (member.runtimeTurn?.turn ?? -1) >= turn) return false
  member.runtimeTurn = {
    turn,
    taskAttempts: team.tasks.filter(task => task.assignee === member.name && task.attemptId !== undefined
      && (task.status === 'claimed' || task.status === 'in_progress') && (task.dispatch?.dispatchedAt ?? -Infinity) <= startedAt)
      .map(task => ({ taskId: task.id, attemptId: task.attemptId! })),
  }
  if (member.activation !== undefined && member.activation.reservedAt <= startedAt) member.activation.turn = turn
  return true
}

/** Called for a terminal turn/end error or a plugin-owned terminal stop
 * decision, never a transient request-error. This writes plugin state only. */
export function recordRuntimeFailure(
  team: TeamState, sessionId: string, turn: number,
  failure: { code: string; message: string; status?: number }, at: number, recoveryActivationId?: string,
): RuntimeBlock | undefined {
  const member = team.members.find(item => item.id === sessionId && item.status !== 'removed')
  const captain = team.captainSessionId === sessionId
  if (captain ? (team.captainRuntimeResolvedThroughTurn ?? -1) >= turn
    : member === undefined || (recoveryActivationId === undefined && (member.runtimeResolvedThroughTurn ?? -1) >= turn)
      || (member.runtimeTurn?.turn ?? -1) > turn) return undefined
  const id = `runtime:${sessionId}:${turn}${recoveryActivationId === undefined ? '' : `:recovery:${recoveryActivationId}`}`
  if ((captain ? team.captainRuntimeBlock : member?.runtimeBlock)?.id === id) return undefined
  const block: RuntimeBlock = {
    id, sessionId, turn, code: failure.code, at,
    ...(failure.status === undefined ? {} : { status: failure.status }),
    message: failure.message.replace(/(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
      .replace(/((?:api[_-]?key|token|password|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]').slice(0, 1000),
  }
  if (captain) {
    team.captainRuntimeBlock = block
    return block
  }
  if (member === undefined) return undefined
  const attempts = recoveryActivationId !== undefined ? member.activation?.taskAttempts ?? []
    : member.runtimeTurn?.turn === turn ? member.runtimeTurn.taskAttempts : member.activation?.taskAttempts ?? []
  member.runtimeBlock = block
  member.activation = undefined
  member.status = 'idle'
  for (const owned of attempts) {
    const task = team.tasks.find(item => item.id === owned.taskId && item.assignee === member.name
      && item.attemptId === owned.attemptId && (item.status === 'claimed' || item.status === 'in_progress'))
    if (task === undefined) continue
    if (task.waitReason?.startsWith('USER_PAUSED:')) continue
    task.runtimeBlock = { ...block, attemptId: owned.attemptId }
    // A failed review worker must not erase a submitted result or review state.
    if (task.executionState !== 'awaiting_review') {
      task.executionState = 'blocked_external'
      task.waitReason = `RUNTIME_${block.code}: ${block.message}. ${runtimeRecoveryGuidance(block.code)} (${sessionId}).`
    }
    task.updatedAt = at
  }
  return block
}
