import { readTeam, resumeRuntimeMember, withTeamLock, writeTeam } from '../state.ts'
import { teamLockKey } from '../team-core.ts'
import type { TeamRouteTarget } from './team-routes.ts'

export const REVIEW_USER_PAUSED = 'USER_PAUSED: 已从专家协作室暂停，等待手动启动。'

/** Apply one scoped task control against fresh durable state. No new attempt is opened. */
export async function changeReviewTaskExecution(target: TeamRouteTarget, action: 'task-pause' | 'task-start' | 'task-recover',
  taskId: string, expectedAttemptId: string, expectedWaitReason?: string): Promise<{ memberSessionId?: string; teamId: string }> {
  if (!target.teamId || target.archived) throw new Error('REVIEW_TASK_NOT_AVAILABLE')
  return withTeamLock(teamLockKey(target.stateRoot, target.teamId), async () => {
    const team = await readTeam(target.stateRoot, target.teamId!)
    if (!team || team.captainSessionId !== target.captainSessionId || team.halted) throw new Error('REVIEW_TASK_NOT_AVAILABLE')
    const task = team.tasks.find(item => item.id === taskId)
    if (!task || !task.assignee || !task.attemptId || task.attemptId !== expectedAttemptId
      || task.humanChoice || task.reassigning) throw new Error('REVIEW_TASK_STALE')
    const member = team.members.find(item => item.name === task.assignee && item.status !== 'removed')
    if (task.assignee !== 'captain' && !member) throw new Error('REVIEW_TASK_NOT_AVAILABLE')
    if (action === 'task-pause') {
      if (task.status !== 'in_progress' || task.runtimeBlock
        || (task.executionState !== undefined && task.executionState !== 'active')) throw new Error('REVIEW_TASK_NOT_RUNNING')
      task.executionState = 'blocked_external'
      task.waitReason = REVIEW_USER_PAUSED
      if (member) member.runtimeResolvedThroughTurn = Math.max(member.runtimeResolvedThroughTurn ?? -1,
        member.runtimeTurn?.turn ?? -1, member.activation?.turn ?? -1)
    } else if (action === 'task-recover') {
      if (task.status !== 'in_progress' || task.executionState !== 'blocked_external'
        || task.waitReason !== expectedWaitReason || !task.waitReason?.startsWith('RUNTIME_HOST_RESTART_UNCONFIRMED:')
        || task.runtimeBlock?.code !== 'HOST_RESTART_UNCONFIRMED' || !member?.runtimeBlock
        || member.runtimeBlock.id !== task.runtimeBlock.id || task.runtimeBlock.attemptId !== task.attemptId) {
        throw new Error('REVIEW_TASK_RECOVERY_STALE')
      }
      resumeRuntimeMember(team, member.id, '用户在专家协作室继续重启后未确认的原任务尝试', member.runtimeBlock.id)
      task.executionState = 'active'
      task.waitReason = undefined
    } else {
      const paused = task.executionState === 'blocked_external' && task.waitReason === REVIEW_USER_PAUSED
      if (!paused && (task.status !== 'claimed' || (task.executionState !== undefined && task.executionState !== 'active' && task.executionState !== 'interrupted'))) {
        throw new Error('REVIEW_TASK_NOT_STARTABLE')
      }
      if (!['claimed', 'in_progress'].includes(task.status)) throw new Error('REVIEW_TASK_NOT_STARTABLE')
      if (task.runtimeBlock && !paused) throw new Error('REVIEW_TASK_OWNER_BLOCKED')
      if (member?.runtimeBlock) {
        if (!paused) throw new Error('REVIEW_TASK_OWNER_BLOCKED')
        resumeRuntimeMember(team, member.id, '用户在专家协作室重新启动已暂停任务', member.runtimeBlock.id)
      }
      task.executionState = 'active'
      task.waitReason = undefined
    }
    task.dispatch = undefined
    task.updatedAt = Date.now()
    await writeTeam(target.stateRoot, team)
    return { teamId: team.id, ...(member?.id ? { memberSessionId: member.id } : {}) }
  })
}
