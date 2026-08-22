/**
 * Event-driven shared task scheduler.
 *
 * Claude Code teammates keep polling the shared task list after a turn. DSH
 * continuable agents instead expose explicit idle/running edges, so this
 * scheduler closes the same loop without keeping a polling turn alive: every
 * idle edge and every task-graph mutation attempts one atomic claim and wakes
 * the selected durable member.
 * @module dsh-expert-library/scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { deliverToMember } from './members.ts'
import {
  acknowledgeMailbox,
  appendMailbox,
  beginTaskAttempt,
  createMessage,
  claimMailboxDelivery,
  findTeamByParticipant,
  readTeam,
  readUnreadMailbox,
  releaseMailboxDelivery,
  unsatisfiedDependencies,
  withTeamLock,
  writeTeam,
} from './state.ts'
import { TERMINAL_TASK_STATUSES, type TeamMember, type TeamTask } from './types.ts'

export interface SchedulerConfig {
  readonly stateDir: string
}

export interface TeamScheduler {
  /** Try to give every genuinely idle/ready member one unit of ready work. */
  kickTeam(workspace: string, teamId: string, captain?: Agent): Promise<void>
  /** Try to flush fallback mail or give one member one ready task. */
  kickMember(workspace: string, teamId: string, memberName: string, captain?: Agent): Promise<void>
}

interface DispatchTicket {
  readonly taskId: string
  readonly memberName: string
  readonly memberId: string
  readonly attempt: number
  readonly attemptId: string
  readonly previousAssignee?: string
  readonly subject: string
  readonly description?: string
  /**
   * True when this ticket re-delivers an EXISTING live capability (the member
   * already owns the claimed/in-progress task and holds its attempt_id). A
   * failed re-delivery must NOT roll the task back to pending — the member may
   * still hold a queued prompt carrying that attempt_id, and invalidating it
   * would produce a stale-claim storm.
   */
  readonly reuse?: boolean
}

/**
 * Minimum interval between two dispatches of the same (member, task) pair.
 * Without it, the "lost turn recovery" path re-dispatches a member's claimed
 * task on every kick the moment the live agent still reports idle (the window
 * between delivery acceptance and the member's turn starting), stacking
 * duplicate prompts and inflating `attempt` thousands of times.
 */
export const DISPATCH_COOLDOWN_MS = 30_000

/**
 * Pure dispatch decision for one (member, task): whether the cooldown blocks
 * a re-dispatch, and whether the ticket re-delivers the member's EXISTING
 * capability (`reuse`) or opens a fresh attempt generation. Exported for unit
 * testing at the pure boundary.
 */
export function planDispatch(
  task: TeamTask,
  memberName: string,
  lastDispatchAt: number | undefined,
  now: number = Date.now(),
): { readonly blocked: true } | { readonly blocked: false; readonly reuse: boolean } {
  if (lastDispatchAt !== undefined && now - lastDispatchAt < DISPATCH_COOLDOWN_MS) {
    return { blocked: true }
  }
  // Reuse only a LIVE claim (claimed/in_progress owned by this member with a
  // capability). Terminal statuses must never be re-delivered even if a stale
  // attemptId lingers on the record (defense in depth behind the selection
  // filters, which already exclude terminal tasks).
  const reuse = (task.status === 'claimed' || task.status === 'in_progress')
    && task.assignee === memberName
    && task.attemptId !== undefined
  return { blocked: false, reuse }
}

function stateRootOf(workspace: string, config: SchedulerConfig): string {
  return join(workspace, config.stateDir)
}

function teamLockKey(stateRoot: string, teamId: string): string {
  return `team:${stateRoot}:${teamId}`
}

function liveCaptain(ctx: Context, captainSessionId: string, supplied?: Agent): Agent | undefined {
  if (supplied !== undefined && supplied.id === captainSessionId) return supplied
  return ctx.agents.get(captainSessionId as SessionId)
}

function isMemberAvailable(ctx: Context, member: TeamMember): boolean {
  const live = ctx.agents.get(member.id as SessionId)
  return live === undefined || live.status === 'idle'
}

function ownedOpenTask(tasks: readonly TeamTask[], memberName: string): TeamTask | undefined {
  return tasks.find(task => task.assignee === memberName
    && (task.status === 'claimed' || task.status === 'in_progress'))
}

function nextReadyTask(tasks: readonly TeamTask[], memberName: string): TeamTask | undefined {
  const ready = tasks.filter(task => task.status === 'pending'
    && task.reassigning !== true
    && unsatisfiedDependencies([...tasks], task.dependencies).length === 0)
  return ready.find(task => task.assignee === memberName)
    ?? ready.find(task => task.assignee === undefined)
}

/**
 * Whether one terminal task may be returned to the pending pool by the
 * automatic requeue pass.
 *
 * Explicit cancellation is always final — a user who cancelled work must
 * never see it resurrected by the scheduler. Legacy `attempt: 0` failed
 * records (created before attempts were tracked) stay terminal too, because
 * their failure budget cannot be judged. Only a genuinely retried failure
 * (attempt 1 or 2, so the next pass still fits the 3-attempt budget)
 * auto-requeues. Explicit user-driven retries go through
 * `expert_teams_reassign_task`, which is unaffected by this predicate.
 * Exported for unit testing at the pure boundary.
 */
export function shouldAutoRetryTask(task: TeamTask): boolean {
  if (task.status !== 'failed') return false
  const attempt = task.attempt ?? 0
  return attempt >= 1 && attempt < 3
}

/** Return retryable terminal work to the pending pool before the next scheduling pass. */
async function requeueRetryableTasks(stateRoot: string, teamId: string): Promise<void> {
  await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
    const fresh = await readTeam(stateRoot, teamId)
    if (fresh === undefined) return
    let changed = false
    for (const task of fresh.tasks) {
      if (!shouldAutoRetryTask(task)) continue
      task.status = 'pending'
      task.output = undefined
      task.attemptId = undefined
      task.handoffId = undefined
      task.reassigning = false
      task.updatedAt = Date.now()
      changed = true
    }
    if (changed) await writeTeam(stateRoot, fresh)
  })
}

/** Emit one durable captain notice when every task reaches a terminal state. */
async function notifyTeamCompletion(stateRoot: string, teamId: string): Promise<void> {
  await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
    const fresh = await readTeam(stateRoot, teamId)
    if (fresh === undefined || fresh.tasks.length === 0 || fresh.completionNotifiedAt !== undefined) return
    if (!fresh.tasks.every(task => TERMINAL_TASK_STATUSES.includes(task.status))) return
    fresh.completionNotifiedAt = Date.now()
    await writeTeam(stateRoot, fresh)
    const counts = fresh.tasks.reduce<Record<string, number>>((acc, task) => {
      acc[task.status] = (acc[task.status] ?? 0) + 1
      return acc
    }, {})
    await appendMailbox(stateRoot, fresh.id, 'captain', createMessage(
      'scheduler',
      'captain',
      'Team "' + fresh.name + '" has reached a terminal state for every task. Summary: ' + JSON.stringify(counts) + '. Review outputs and deliver the final artifact.',
    ))
  })
}

function assignmentPrompt(ticket: DispatchTicket, stateDir: string, teamId: string): string {
  const description = ticket.description === undefined ? '' : `\n\n${ticket.description}`
  return `Expert Teams automatic task assignment from the shared task list.

Task: ${ticket.taskId} — ${ticket.subject}${description}\n\nProject isolation: work only inside the current task project. Read input/task.json and write the result through expert_teams_update_task; do not inspect other expert-task project directories.
Attempt: ${ticket.attempt}
Attempt id: ${ticket.attemptId}

Call expert_teams_claim_task for ${ticket.taskId}; it will return this same attempt_id. Include attempt_id=${ticket.attemptId} in every expert_teams_update_task call. If it is rejected as stale, stop work because the task was reassigned. Work only this task in this turn, report the result to the captain, then become idle so the scheduler can select your next ready task.

State policy: ${stateDir}/${teamId}/ is read-only diagnostics; mutate team state only through expert_teams_* tools.`
}

function fallbackMailboxPrompt(messages: Awaited<ReturnType<typeof readUnreadMailbox>>): string {
  return [
    'Expert Teams delivered messages that were persisted while live delivery was unavailable:',
    ...messages.map(message => `\nFrom ${message.from}:\n${message.content}`),
    '\nHandle these messages in this turn. Task assignments still require expert_teams_claim_task and the current attempt_id.',
  ].join('\n')
}

/** Install one scheduler and its member activity observer. */
export function installTeamScheduler(ctx: Context, config: SchedulerConfig): TeamScheduler {
  const memberQueues = new Map<string, Promise<unknown>>()
  /** Last dispatch timestamp per `${stateRoot}\u0000${teamId} ${member} ${task}` (in-memory cooldown guard). */
  const lastDispatchAt = new Map<string, number>()

  const serializeMember = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = memberQueues.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => gate)
    memberQueues.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (memberQueues.get(key) === tail) memberQueues.delete(key)
    }
  }

  const runtime: TeamScheduler = {
    async kickTeam(workspace, teamId, suppliedCaptain) {
      const stateRoot = stateRootOf(workspace, config)
      let team = await readTeam(stateRoot, teamId)
      if (team === undefined) return
      await requeueRetryableTasks(stateRoot, teamId)
      team = await readTeam(stateRoot, teamId)
      if (team === undefined) return
      const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain)
      if (captain === undefined) return
      // All-terminal short circuit: settle member statuses ONCE and stop
      // waking anyone. Without this, every kick during a finished team still
      // runs the member loop, and the first member whose record says
      // "working" triggers a residual write long after completion.
      if (team.tasks.every(task => TERMINAL_TASK_STATUSES.includes(task.status))) {
        let changed = false
        for (const member of team.members) {
          if (member.status === 'removed') continue
          if (member.status !== 'idle') {
            member.status = 'idle'
            changed = true
          }
        }
        if (changed) await writeTeam(stateRoot, team)
        await notifyTeamCompletion(stateRoot, teamId)
        return
      }
      for (const member of team.members) {
        if (member.status === 'removed') continue
        await runtime.kickMember(workspace, teamId, member.name, captain)
      }
      await notifyTeamCompletion(stateRoot, teamId)
    },

    async kickMember(workspace, teamId, memberName, suppliedCaptain) {
      const stateRoot = stateRootOf(workspace, config)
      const queueKey = `${stateRoot}\u0000${teamId}\u0000${memberName}`
      await serializeMember(queueKey, async () => {
        let team = await readTeam(stateRoot, teamId)
        if (team === undefined) return
        const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain)
        if (captain === undefined) return
        let member = team.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
        if (member === undefined || member.id === '' || !isMemberAvailable(ctx, member)) return

        // A mailbox-only fallback is real pending work. Deliver it before a
        // fresh task and acknowledge only after Harness accepts the follow-up.
        const unread = await readUnreadMailbox(stateRoot, team.id, member.name)
        if (unread.length > 0) {
          await withTeamLock(teamLockKey(stateRoot, team.id), () => (
            claimMailboxDelivery(stateRoot, team!.id, member!.name, unread.map(message => message.id))
          ))
          const accepted = await deliverToMember(
            ctx,
            captain,
            member.id,
            fallbackMailboxPrompt(unread),
            new AbortController().signal,
          )
          if (accepted) {
            await withTeamLock(teamLockKey(stateRoot, team.id), () => (
              acknowledgeMailbox(stateRoot, team!.id, member!.name, unread.map(message => message.id))
            ))
          } else {
            await withTeamLock(teamLockKey(stateRoot, team.id), () => (
              releaseMailboxDelivery(stateRoot, team!.id, member!.name, unread.map(message => message.id))
            ))
          }
          return
        }

        const ticket = await withTeamLock(teamLockKey(stateRoot, team.id), async (): Promise<DispatchTicket | undefined> => {
          const fresh = await readTeam(stateRoot, team!.id)
          if (fresh === undefined) return undefined
          const currentMember = fresh.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
          if (currentMember === undefined || currentMember.id === '' || !isMemberAvailable(ctx, currentMember)) return undefined
          // An idle/ready member that still owns an open task lost the turn
          // that was executing it (model stopped early, interrupt settlement,
          // or process restart). Retry that task with a fresh capability
          // instead of permanently treating the durable claim as "busy".
          const task = ownedOpenTask(fresh.tasks, currentMember.name)
            ?? nextReadyTask(fresh.tasks, currentMember.name)
          if (task === undefined) {
            if (currentMember.status !== 'idle') {
              currentMember.status = 'idle'
              await writeTeam(stateRoot, fresh)
            }
            return undefined
          }
          // Cooldown: re-dispatching the same (member, task) pair within the
          // window is the dispatch-storm amplifier — every kick during the
          // delivery→turn-start gap (agent still reports idle) would stack
          // another prompt for the member.
          const cooldownKey = `${stateRoot}\u0000${team!.id}\u0000${currentMember.name}\u0000${task.id}`
          const decision = planDispatch(task, currentMember.name, lastDispatchAt.get(cooldownKey))
          if (decision.blocked) return undefined

          // Lost-turn recovery for a task the member already owns with a live
          // capability re-delivers the SAME attempt_id (idempotent: claim is a
          // no-op for the owner, update_task keeps working). NEVER open a new
          // generation here — a fresh attempt_id invalidates every prompt
          // already queued for the member and cascades into stale claims.
          const attemptId = decision.reuse
            ? task.attemptId!
            : beginTaskAttempt(task, currentMember.name)
          const previousAssignee = task.assignee
          currentMember.status = 'working'
          await writeTeam(stateRoot, fresh)
          lastDispatchAt.set(cooldownKey, Date.now())
          return {
            taskId: task.id,
            memberName: currentMember.name,
            memberId: currentMember.id,
            attempt: task.attempt ?? 1,
            attemptId,
            ...(decision.reuse ? { reuse: true } : { previousAssignee }),
            subject: task.subject,
            description: task.description,
          }
        })
        if (ticket === undefined) return

        const accepted = await deliverToMember(
          ctx,
          captain,
          ticket.memberId,
          assignmentPrompt(ticket, config.stateDir, team.id),
          new AbortController().signal,
        )
        if (accepted) return

        // Roll back only our exact failed dispatch. A concurrent captain
        // handoff has already changed the capability and wins. A REUSE ticket
        // re-delivered a live capability the member still owns: never roll the
        // task back to pending — the member may hold a queued prompt carrying
        // that same attempt_id; invalidating it re-arms the stale-claim storm.
        await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
          const fresh = await readTeam(stateRoot, team!.id)
          if (fresh === undefined) return
          const task = fresh.tasks.find(candidate => candidate.id === ticket.taskId)
          if (ticket.reuse === true) {
            // Keep the claim and its capability; the cooldown damps retries.
            const currentMember = fresh.members.find(candidate => candidate.name === ticket.memberName)
            if (currentMember !== undefined && currentMember.status !== 'removed') currentMember.status = 'idle'
            await writeTeam(stateRoot, fresh)
            return
          }
          if (task?.attemptId !== ticket.attemptId) return
          task.status = 'pending'
          task.assignee = ticket.previousAssignee
          task.attemptId = undefined
          task.handoffId = undefined
          task.reassigning = false
          task.updatedAt = Date.now()
          const currentMember = fresh.members.find(candidate => candidate.name === ticket.memberName)
          if (currentMember !== undefined && currentMember.status !== 'removed') currentMember.status = 'idle'
          await writeTeam(stateRoot, fresh)
        })
      })
    },
  }

  const syncMemberStatus = async (agent: Agent, status: AgentStatus): Promise<void> => {
    const workspace = agent.session.header.cwd ?? process.cwd()
    const stateRoot = stateRootOf(workspace, config)
    const located = await findTeamByParticipant(stateRoot, agent.id)
    if (located === undefined || located.captainSessionId === agent.id) return
    const member = located.members.find(candidate => candidate.id === agent.id && candidate.status !== 'removed')
    if (member === undefined) return
    await withTeamLock(teamLockKey(stateRoot, located.id), async () => {
      const fresh = await readTeam(stateRoot, located.id)
      const current = fresh?.members.find(candidate => candidate.id === agent.id && candidate.status !== 'removed')
      if (fresh === undefined || current === undefined) return
      const next = status === 'running' ? 'working' : 'idle'
      if (current.status === next) return
      current.status = next
      await writeTeam(stateRoot, fresh)
    })
    if (status === 'idle') await runtime.kickMember(workspace, located.id, member.name)
  }

  ctx.on('agent/status', ({ agent, status }) => {
    void syncMemberStatus(agent, status).catch((error: unknown) => {
      ctx.logger.warn(`expert-teams: member status scheduling failed for ${agent.id}: ${String(error)}`)
    })
  })

  return runtime
}
