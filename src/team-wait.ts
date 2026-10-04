/** Event-driven waiting: persist the participant's wait and end this turn. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { findTeamByParticipant, readTeam, readUnreadMailbox, unsatisfiedDependencies, withTeamLock, writeTeam } from './state.ts'
import { workspaceOf, type ToolsConfig, type ExpertToolsCore } from './team-core.ts'
import { TERMINAL_TASK_STATUSES } from './types.ts'
import { installGoalWaitResumption, persistGoalAwareWait } from './goal-wait.ts'

export function registerTeamWaitTool(ctx: Context, config: ToolsConfig, core: ExpertToolsCore): void {
  installGoalWaitResumption(ctx, config.stateDir)
  ctx.tools.register(defineTool({
    name: 'expert_teams_wait',
    description: 'Persist an event-driven wait and END the current turn without completing any task or goal. Use after saving progress when only other members, independent review or external input can advance the work. An active goal is formally paused; accepted team messages resume only that exact plugin-owned pause. New human input takes control and leaves goal resumption to the user through the Host goal controls. Do not use bash sleep, repeated status calls or inbox-file polling to wait.',
    parameters: {
      reason: { type: 'string', required: true, description: 'Concrete pending event, responsible member/input and resume condition; this is not a completion claim.' },
      task_ids: { type: 'array', items: { type: 'string' }, description: 'Runtime task IDs from plan approval or expert_teams_status, not logical IDs from the plan. Include unfinished tasks only; omit this field to capture all unfinished team tasks.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          waiting: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
          task_ids: { type: 'array', items: { type: 'string' }, required: true },
          next_action: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.waiting
        ? `已保存等待状态：${value.reason}。本回合结束，任务仍未完成；收到新消息后继续。`
        : value.next_action }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('expert_teams_wait requires a calling participant')
      if (typeof exec.concludeTurn !== 'function') throw new Error('This Host cannot conclude a waiting turn; upgrade the Host before using expert_teams_wait')
      const reason = args.reason.trim()
      if (reason === '') throw new Error('reason must identify the event or input being awaited')
      const workspace = workspaceOf(agent)
      const stateRoot = join(workspace, config.stateDir)
      const found = await findTeamByParticipant(stateRoot, agent.id)
      if (found === undefined) throw new Error('No team found for this participant')
      // Give ready work one normal scheduling pass before parking. No timer or
      // model request is created by waiting itself.
      await core.scheduler.kickTeam(workspace, found.id)
      const result = await withTeamLock(`team:${stateRoot}:${found.id}`, async () => {
        const team = await readTeam(stateRoot, found.id)
        if (team === undefined) throw new Error('Team no longer exists')
        const isCaptain = team.captainSessionId === agent.id
        const member = team.members.find(item => item.id === agent.id && item.status !== 'removed')
        if (!isCaptain && member === undefined) throw new Error('Participant no longer belongs to this team')
        const key = isCaptain ? 'captain' : member!.name
        const taskIds = args.task_ids === undefined
          ? team.tasks.filter(task => !TERMINAL_TASK_STATUSES.includes(task.status)).map(task => task.id)
          : [...new Set(args.task_ids)]
        for (const id of taskIds) {
          const task = team.tasks.find(item => item.id === id)
          if (task === undefined) {
            const validIds = team.tasks.filter(item => !TERMINAL_TASK_STATUSES.includes(item.status)).map(item => item.id)
            throw new Error(`Unknown runtime task ${id}. Valid unfinished runtime task IDs: ${validIds.join(', ') || '(none)'}. Use these IDs, not plan logical IDs. Omit task_ids to capture all unfinished team tasks; if none remain, report their actual acceptance outcome instead of waiting.`)
          }
          if (TERMINAL_TASK_STATUSES.includes(task.status)) throw new Error(`Task ${id} is terminal; await an unfinished task or report the actual outcome`)
        }
        if (taskIds.length === 0) return { waiting: false, reason, task_ids: taskIds, next_action: 'No unfinished task remains. Check final artifacts and report their actual acceptance outcome; waiting does not establish success.' }
        const ownedReady = team.tasks.find(task => task.assignee === key && task.status === 'pending'
          && unsatisfiedDependencies(team.tasks, task.dependencies).length === 0)
        if (ownedReady !== undefined) throw new Error(`Task ${ownedReady.id} is ready and assigned to you. Claim and perform it before waiting.`)
        const ownedActive = team.tasks.find(task => task.assignee === key
          && (task.status === 'claimed' || task.status === 'in_progress')
          && task.executionState !== 'awaiting_review' && task.executionState !== 'blocked_external')
        if (ownedActive !== undefined) throw new Error(`Task ${ownedActive.id} is still active under your ownership. Save output and its actual awaiting_review or blocked_external state before waiting.`)
        const unread = await readUnreadMailbox(stateRoot, team.id, key)
        if (unread.length > 0 || agent.inbox?.hasPending === true) {
          return { waiting: false, reason, task_ids: taskIds, next_action: 'New input is already pending. Process the inbox/status messages before waiting; no wait was persisted.' }
        }
        team.runtimeWaits = { ...team.runtimeWaits, [agent.id]: { reason, taskIds, since: Date.now() } }
        await persistGoalAwareWait(ctx, agent, team, () => writeTeam(stateRoot, team))
        return { waiting: true, reason, task_ids: taskIds, next_action: 'Turn ends now. A matching team task/review message resumes work and its exact plugin-paused goal. New human input is processed normally and takes control of goal resumption through the Host goal controls. No polling is needed.' }
      })
      if (result.waiting) exec.concludeTurn()
      return result
    },
  }))
}
