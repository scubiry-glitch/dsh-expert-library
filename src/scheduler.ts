import { prepareCraftDelivery, saveCraftDelivery, type CraftDeliveryReceipt } from './report-craft-delivery.ts'
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
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { deliverCaptainMailbox, deliverToMember } from './members.ts'
import { deliverMemberMailbox } from './mailbox-delivery.ts'
import { forkQualityRun, QualityRunError } from './quality-run.ts'
import { captureRuntimeTurn, recordRuntimeFailure } from './runtime-failure.ts'
import { sessionOwnEvents } from './harness-compat.ts'
import { renderSharedTaskContext } from './shared-task-context.ts'
import { renderTaskRepairFeedback } from './repair-feedback.ts'
import { prepareDependencyInputs } from './dependency-inputs.ts'
import {
  acknowledgeMailbox,
  admitTeamMessage,
  appendMailbox,
  beginTaskAttempt,
  createMessage,
  discardMailbox,
  claimMailboxDelivery,
  findTeamByParticipant,
  findTeamByCaptain,
  readTeam,
  readUnreadMailbox,
  releaseMailboxDelivery,
  readMailbox,
  MAILBOX_DELIVERY_LEASE_MS,
  unsatisfiedDependencies,
  withTeamLock,
  writeTeam,
  syncTaskProjectInput,
  taskInputWarnings,
} from './state.ts'
import { TERMINAL_TASK_STATUSES, type TeamMember, type TeamTask, type TeamState, type SharedTaskContext } from './types.ts'

export interface SchedulerConfig {
  readonly stateDir: string
  /** Hard cap over live/pending member turns, including independent review. */
  readonly maxActiveMembers?: number
  /** Injectable clock for deterministic transport recovery tests. */
  readonly clock?: {
    now(): number
    setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>
    clearTimeout(timer: ReturnType<typeof setTimeout>): void
  }
}

export interface TeamScheduler {
  /** Try to give every genuinely idle/ready member one unit of ready work. */
  kickTeam(workspace: string, teamId: string, captain?: Agent): Promise<void>
  /** Try to flush fallback mail or give one member one ready task. */
  kickMember(workspace: string, teamId: string, memberName: string, captain?: Agent): Promise<void>
  /** Reconcile durable teams after a process restart and resume safe dispatches. */
  recoverWorkspace(workspace: string): Promise<{ recovered: string[]; halted: string[] }>
  /** Schedule bounded recovery after a durable mailbox could not be delivered. */
  scheduleRecovery(workspace: string, teamId: string, delayMs?: number): void
}

interface DispatchTicket {
  readonly taskId: string
  readonly memberName: string
  readonly memberId: string
  readonly attempt: number
  readonly attemptId: string
  readonly dispatchId?: string
  readonly activationId?: string
  readonly subject: string
  readonly description?: string
  readonly sharedTaskContext?: SharedTaskContext
  readonly taskProtocol?: readonly string[]
  readonly repairFeedback?: string
  readonly craftContent?: string
  readonly craftReceipts?: readonly CraftDeliveryReceipt[]
  readonly projectPath?: string
  readonly inputPath?: string
  readonly outputPath?: string
  readonly inputArtifactWarnings?: readonly string[]
  readonly inputArtifacts?: readonly { sourceTaskId: string; artifactId: string; reviewArtifactId?: string; attempt: number; sha256: string; versionPath: string }[]
}

/**
 * Minimum interval between two dispatches of the same live task attempt.
 * Without it, the "lost turn recovery" path re-dispatches a member's claimed
 * task on every kick the moment the live agent still reports idle (the window
 * between delivery acceptance and the member's turn starting), stacking
 * duplicate prompts and inflating `attempt` thousands of times.
 */
export const DISPATCH_COOLDOWN_MS = 30_000
export const MAX_DISPATCH_FAILURES = 3
export const MAX_MAILBOX_RECOVERY_ROUNDS = 3

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
  if (task.runtimeBlock !== undefined || task.executionState === 'awaiting_review' || task.executionState === 'blocked_external') {
    return { blocked: true }
  }
  const reuse = (task.status === 'claimed' || task.status === 'in_progress')
    && task.assignee === memberName
    && task.attemptId !== undefined
  // Pending work opens a new generation. Neither an old capability nor its
  // receipt may delay an explicit repair/reassignment into that generation.
  if (!reuse) return { blocked: false, reuse: false }
  // The durable timestamp survives scheduler/process replacement. Ignore a
  // receipt from a retired attempt: it must not delay newly admitted work.
  const persistedAt = task.dispatch?.attemptId === task.attemptId ? task.dispatch?.dispatchedAt : undefined
  if (task.dispatch !== undefined && task.dispatch.attemptId === task.attemptId && (task.dispatch.nextRetryAt ?? -Infinity) > now) return { blocked: true }
  const dispatchedAt = Math.max(lastDispatchAt ?? -Infinity, persistedAt ?? -Infinity)
  if (now - dispatchedAt < DISPATCH_COOLDOWN_MS) {
    return { blocked: true }
  }
  // Reuse only a LIVE claim (claimed/in_progress owned by this member with a
  // capability). Terminal statuses must never be re-delivered even if a stale
  // attemptId lingers on the record (defense in depth behind the selection
  // filters, which already exclude terminal tasks).
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
  if (member.runtimeBlock !== undefined) return false
  const live = ctx.agents.get(member.id as SessionId)
  // The public status can still be idle between FIFO acceptance and turn
  // start. Pending input already owns the next turn, including after restart.
  return live === undefined || (live.status === 'idle' && live.inbox?.hasPending !== true)
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
  if (task.status !== 'failed' || task.runtimeBlock !== undefined) return false
  const attempt = task.attempt ?? 0
  return attempt >= 1 && attempt < 3
}

/** Return retryable terminal work to the pending pool before the next scheduling pass. */
async function requeueRetryableTasks(stateRoot: string, teamId: string): Promise<void> {
  await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
    const fresh = await readTeam(stateRoot, teamId)
    if (fresh === undefined || fresh.halted === true) return
    let changed = false
    for (const task of fresh.tasks) {
      if (!shouldAutoRetryTask(task)) continue
      const previousRun = fresh.qualityRuns?.[task.id]
        ?? (fresh.qualityRun?.contract.taskId === task.id ? fresh.qualityRun : undefined)
      if (previousRun !== undefined) {
        const nextAttempt = (task.attempt ?? 0) + 1
        try {
          const next = forkQualityRun(previousRun, {
            eventId: `auto-retry-${task.id}-${nextAttempt}-${previousRun.runId}`,
            actor: 'scheduler', reason: `Retry failed execution at attempt ${nextAttempt}`,
            assignee: task.assignee ?? previousRun.contract.assignee, attempt: nextAttempt,
          }).run
          const history = fresh.qualityRunHistory?.[task.id] ?? []
          fresh.qualityRunHistory = { ...fresh.qualityRunHistory,
            [task.id]: history.some(run => run.runId === previousRun.runId) ? history : [...history, previousRun] }
          if (fresh.qualityRun === undefined || fresh.qualityRun.contract.taskId === task.id) fresh.qualityRun = next
          if (fresh.qualityRuns !== undefined) fresh.qualityRuns = { ...fresh.qualityRuns, [task.id]: next }
          task.assignee ??= next.contract.assignee
        } catch (error) {
          if (!(error instanceof QualityRunError) || error.code !== 'repair_budget_exhausted') throw error
          await appendMailbox(stateRoot, teamId, 'captain', createMessage('scheduler', 'captain',
            `Task ${task.id} remains failed: automatic retry cannot reopen quality review (${error.message}). An explicit policy decision is required.`,
            { idempotencyKey: `auto-retry-blocked:${task.id}:${previousRun.runId}:${task.attempt}` }))
          continue
        }
      }
      task.status = 'pending'
      task.output = undefined
      task.attemptId = undefined
      task.executionState = undefined
      task.waitReason = undefined
      task.dispatch = undefined
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
    if (fresh === undefined || fresh.halted === true || fresh.tasks.length === 0 || fresh.completionNotifiedAt !== undefined) return
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
      'Team "' + fresh.name + '" has reached a terminal state for every task. Summary: ' + JSON.stringify(counts) + '. This is a progress signal, not proof that the goal is complete: inspect every required acceptance check, failed/cancelled task, artifact and structured quality run; only deliver after all required work is completed and integrated, otherwise record the next action or blocker.',
    ))
  })
}

/** Build the durable assignment message; exported for prompt contract tests. */
export function assignmentPrompt(ticket: DispatchTicket, stateDir: string, teamId: string): string {
  const description = ticket.description === undefined ? '' : `\n\n${ticket.description}`
  return `Expert Teams automatic task assignment from the shared task list.

Task: ${ticket.taskId} — ${ticket.subject}${description}\n\n${renderSharedTaskContext(ticket.sharedTaskContext, ticket.taskProtocol)}\n\nProject isolation: work only inside the current task project${ticket.projectPath === undefined ? '' : ` at ${ticket.projectPath}`}. Read ${ticket.inputPath ?? 'the task project input/task.json'} and write the result through expert_teams_update_task${ticket.outputPath === undefined ? '' : ` (durable result: ${ticket.outputPath})`}; do not inspect other expert-task project directories. These are exact task paths; do not guess them from the inherited workspace cwd. Follow the original user constraints for any expressly requested shared deliverable paths.
Attempt: ${ticket.attempt}
Attempt id: ${ticket.attemptId}
${ticket.dispatchId === undefined ? '' : `Dispatch id: ${ticket.dispatchId}\n`}
${ticket.repairFeedback ?? ''}
${ticket.craftContent ?? ''}
${(ticket.inputArtifactWarnings ?? []).join('\n')}
${ticket.inputArtifacts === undefined || ticket.inputArtifacts.length === 0 ? '' : `Verified upstream artifact manifest: ${JSON.stringify(ticket.inputArtifacts)}\nThese pinned immutable versions are the authoritative dependency inputs. Read each via expert_teams_read_artifact(task_id="${ticket.taskId}", source_task_id=<sourceTaskId>, artifact_id=<artifactId UUID>); reviewArtifactId is not an artifact UUID. Do not substitute mutable shared working copies or edit upstream files. An unavailable fixed version blocks work; do not fall back to another version.\n`}

Call expert_teams_claim_task for ${ticket.taskId}; it will return this same attempt_id. Include attempt_id=${ticket.attemptId} in every expert_teams_update_task call. Inspect the live task before acting: a delayed or repeated assignment does not clear awaiting_review or blocked_external. In either waiting state, preserve the submitted output and end the turn unless a review/repair/integration event or an explicit unblocking update has made the task runnable. Mark the task in_progress before doing substantive work. Continue action → verification → correction until the task meets its acceptance checks or you have a concrete external blocker; a single reply, elapsed time or budget exhaustion is not completion. If it is rejected as stale, stop work because the task was reassigned. If this task has a structured QualityRun that is not integrated, save the result as in_progress with execution_state=awaiting_review and a wait_reason, report evidence/findings to the captain once and wait for independent review/repair/integration; do not submit completed or self-approve. For a concrete external blocker, save progress with execution_state=blocked_external and wait_reason naming the missing input, responsible party and unblocking condition. Recoverable execution interruptions use execution_state=interrupted; they are resumable under this same attempt_id. Only submit completed after the live attempt's checks and required quality integration pass. Work only this task in this turn, report the result and next dependency to the captain, persist any waiting state before yielding, then become idle.

State policy: ${stateDir}/${teamId}/ is read-only diagnostics; mutate team state only through expert_teams_* tools.`
}

/** Install one scheduler and its member activity observer. */
export function installTeamScheduler(ctx: Context, config: SchedulerConfig): TeamScheduler {
  const memberQueues = new Map<string, Promise<unknown>>()
  /** Cache only the current dispatch receipt; clearing it explicitly permits immediate resume. */
  const lastDispatchAt = new Map<string, { attemptId: string; dispatchId: string; dispatchedAt: number }>()
  const clock = config.clock ?? { now: () => Date.now(), setTimeout, clearTimeout }
  const recoveryTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; dueAt: number }>()
  const mailboxRecovery = new Map<string, { rounds: number; dueAt?: number; notified?: boolean }>()
  const deliveryController = new AbortController()
  const eventQueues = new Map<string, Promise<void>>()
  let disposed = false
  const configuredCap = (): number => {
    const value = config.maxActiveMembers ?? 2
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('maxActiveMembers must be a positive integer')
    return value
  }
  configuredCap()
  const hasSlot = (member: TeamMember): boolean => {
    const agent = ctx.agents.get(member.id as SessionId)
    return member.activation !== undefined || agent?.status === 'running' || agent?.inbox?.hasPending === true
  }
  const canReserve = (team: TeamState, member: TeamMember): boolean => {
    // Explicit task resume/reassignment retires the old delivery reservation.
    if (member.activation !== undefined && isMemberAvailable(ctx, member)
      && member.activation.taskAttempts.length > 0 && member.activation.taskAttempts.every(owned => {
        const task = team.tasks.find(item => item.id === owned.taskId)
        return task?.attemptId !== owned.attemptId || task.dispatch === undefined || task.executionState === 'interrupted'
      })) member.activation = undefined
    return !hasSlot(member)
      && team.members.filter(item => item.status !== 'removed' && hasSlot(item)).length < (team.maxActiveMembers ?? configuredCap())
  }
  const reserve = (team: TeamState, member: TeamMember): string => {
    const id = randomUUID()
    member.activation = { id, sessionId: member.id, reservedAt: clock.now(),
      taskAttempts: team.tasks.filter(task => task.assignee === member.name && task.attemptId !== undefined
        && (task.status === 'claimed' || task.status === 'in_progress'))
        .map(task => ({ taskId: task.id, attemptId: task.attemptId! })) }
    return id
  }
  const settleReservation = async (stateRoot: string, teamId: string, memberId: string, id: string, accepted: boolean): Promise<void> => {
    await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
      const fresh = await readTeam(stateRoot, teamId)
      const member = fresh?.members.find(item => item.id === memberId && item.status !== 'removed')
      if (fresh === undefined || member?.activation?.id !== id) return
      if (accepted) member.activation.acceptedAt = clock.now()
      else member.activation = undefined
      await writeTeam(stateRoot, fresh)
    })
  }
  const recoveryKey = (workspace: string, teamId: string): string => `${stateRootOf(workspace, config)}\u0000${teamId}`
  const armRecovery = (workspace: string, teamId: string, dueAt: number): void => {
    if (disposed) return
    const key = recoveryKey(workspace, teamId)
    const previous = recoveryTimers.get(key)
    if (previous !== undefined && previous.dueAt <= dueAt) return
    if (previous !== undefined) clock.clearTimeout(previous.timer)
    const timer = clock.setTimeout(() => {
      recoveryTimers.delete(key)
      if (disposed) return
      const mailbox = mailboxRecovery.get(key)
      if (mailbox?.dueAt !== undefined && mailbox.dueAt <= clock.now()) {
        mailbox.rounds++
        mailbox.dueAt = undefined
      }
      void runtime.kickTeam(workspace, teamId).catch((error: unknown) => {
        ctx.logger.warn(`expert-teams: scheduled recovery failed for ${teamId}: ${String(error)}`)
      }).finally(() => {
        const pending = mailboxRecovery.get(key)?.dueAt
        if (pending !== undefined) armRecovery(workspace, teamId, pending)
      })
    }, Math.max(1, dueAt - clock.now()))
    timer.unref?.()
    recoveryTimers.set(key, { timer, dueAt })
  }
  const restoreMailboxRecovery = async (workspace: string, teamId: string): Promise<void> => {
    const stateRoot = stateRootOf(workspace, config)
    const team = await readTeam(stateRoot, teamId)
    if (team === undefined || team.halted === true) return
    let nextAt = Infinity
    const capacityAvailable = team.members.filter(member => member.status !== 'removed' && hasSlot(member)).length < (team.maxActiveMembers ?? configuredCap())
    // Healthy work occupying a slot is not a failed delivery. Idle events
    // admit its queued successors without spending the transport retry budget.
    for (const key of [...(team.captainRuntimeBlock === undefined ? ['captain'] : []), ...team.members.filter(member => member.status !== 'removed'
      && member.runtimeBlock === undefined && capacityAvailable && isMemberAvailable(ctx, member) && !hasSlot(member)).map(member => member.name)]) {
      for (const message of await readMailbox(stateRoot, teamId, key)) {
        if (message.readAt !== undefined || message.discardedAt !== undefined) continue
        nextAt = Math.min(nextAt, message.deliveryClaimedAt === undefined
          ? clock.now() + DISPATCH_COOLDOWN_MS : message.deliveryClaimedAt + MAILBOX_DELIVERY_LEASE_MS)
      }
    }
    if (Number.isFinite(nextAt)) runtime.scheduleRecovery(workspace, teamId, Math.max(1, nextAt - clock.now()))
    else mailboxRecovery.delete(recoveryKey(workspace, teamId))
  }

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

  const flushCaptainMailbox = async (stateRoot: string, teamId: string, captain: Agent): Promise<void> => {
    await serializeMember(`${stateRoot}\u0000${teamId}\u0000captain`, async () => {
      if (disposed) return
      const messages = await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
        const fresh = await readTeam(stateRoot, teamId)
        if (disposed || fresh === undefined || fresh.halted === true || fresh.captainRuntimeBlock !== undefined) return []
        const admitted = []
        for (const message of await readUnreadMailbox(stateRoot, teamId, 'captain')) {
          const admission = admitTeamMessage(fresh, message)
          if (admission.accepted) admitted.push(message)
          else await discardMailbox(stateRoot, teamId, 'captain', [message.id], admission.reason)
        }
        const claimed = new Set(await claimMailboxDelivery(stateRoot, teamId, 'captain', admitted.map(message => message.id)))
        if (claimed.size > 0 && fresh.runtimeWaits?.[fresh.captainSessionId] !== undefined) {
          delete fresh.runtimeWaits[fresh.captainSessionId]
          await writeTeam(stateRoot, fresh)
        }
        return admitted.filter(message => claimed.has(message.id))
      })
      for (const message of messages) {
        if (disposed) return
        const accepted = deliverCaptainMailbox(captain, message)
        await withTeamLock(teamLockKey(stateRoot, teamId), () => accepted
          ? acknowledgeMailbox(stateRoot, teamId, 'captain', [message.id])
          : releaseMailboxDelivery(stateRoot, teamId, 'captain', [message.id]))
        if (!accepted) runtime.scheduleRecovery(captain.session.header.cwd ?? process.cwd(), teamId)
      }
    })
  }

  const runtime: TeamScheduler = {
    scheduleRecovery(workspace, teamId, delayMs = DISPATCH_COOLDOWN_MS) {
      if (disposed) return
      const key = recoveryKey(workspace, teamId)
      const recovery = mailboxRecovery.get(key) ?? { rounds: 0 }
      mailboxRecovery.set(key, recovery)
      if (recovery.rounds >= MAX_MAILBOX_RECOVERY_ROUNDS) {
        if (recovery.notified) return
        recovery.notified = true
        const stateRoot = stateRootOf(workspace, config)
        void withTeamLock(teamLockKey(stateRoot, teamId), async () => {
          const team = await readTeam(stateRoot, teamId)
          if (team === undefined || team.halted === true) return
          await appendMailbox(stateRoot, teamId, 'captain', createMessage('scheduler', 'captain',
            'Mailbox delivery remains unacknowledged after bounded automatic recovery. Pending messages are preserved; restore the recipient connection or explicitly retry delivery.',
            { idempotencyKey: `mailbox-recovery-exhausted:${teamId}` }))
          return team.captainSessionId
        }).then(async captainId => {
          if (disposed || captainId === undefined) return
          const captain = ctx.agents.get(captainId as SessionId)
          if (captain !== undefined) await flushCaptainMailbox(stateRoot, teamId, captain)
        }).catch((error: unknown) => ctx.logger.warn(`expert-teams: mailbox recovery notice failed: ${String(error)}`))
        return
      }
      const dueAt = clock.now() + Math.max(1, delayMs)
      recovery.dueAt = Math.min(recovery.dueAt ?? Infinity, dueAt)
      armRecovery(workspace, teamId, recovery.dueAt)
    },
    async recoverWorkspace(workspace) {
      if (disposed) return { recovered: [], halted: [] }
      const stateRoot = stateRootOf(workspace, config)
      let entries
      try {
        entries = await readdir(stateRoot, { withFileTypes: true })
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { recovered: [], halted: [] }
        }
        throw error
      }
      const recovered: string[] = []
      const halted: string[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'archive' || entry.name === 'plans') continue
        const team = await readTeam(stateRoot, entry.name)
        if (team === undefined) continue
        if (team.halted === true) { halted.push(team.id); continue }
        // Reconcile terminal records already present in live Host sessions
        // before any dispatch. Persisted runtimeBlock also survives a cold Host.
        for (const member of team.members) {
          const live = ctx.agents.get(member.id as SessionId)
          if (live !== undefined) await reconcileLatestTurn(live)
          else if (member.activation !== undefined && member.runtimeBlock === undefined) {
            // Never guess that an accepted cold turn was merely lost. Its
            // terminal log may contain a quota failure; explicit recovery is
            // safer than feeding an unbounded restart/request/error cycle.
            await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
              const fresh = await readTeam(stateRoot, team.id)
              const current = fresh?.members.find(item => item.id === member.id)
              if (fresh === undefined || current === undefined || current.activation === undefined || current.activation.id !== member.activation?.id) return
              const recoveryTurn = current.activation.turn ?? current.runtimeTurn?.turn ?? 0
              const block = recordRuntimeFailure(fresh, member.id, recoveryTurn,
                { code: 'HOST_RESTART_UNCONFIRMED', message: 'A reserved member delivery has no live Host after restart and its outcome is unconfirmed. Inspect its saved session and explicitly resume this member.' }, clock.now(), current.activation.id)
              if (block === undefined) return
              await writeTeam(stateRoot, fresh)
              await appendMailbox(stateRoot, team.id, 'captain', createMessage('scheduler', 'captain', block.message,
                { idempotencyKey: block.id }))
            })
          }
        }
        await restoreMailboxRecovery(workspace, team.id)
        const captain = ctx.agents.get(team.captainSessionId as SessionId)
        if (captain === undefined) continue
        // Open claims retain their attemptId. kickTeam's planDispatch path
        // reuses that capability, so restart recovery cannot silently create a
        // fresh generation or duplicate the member's queued work.
        await runtime.kickTeam(workspace, team.id, captain)
        recovered.push(team.id)
      }
      return { recovered, halted }
    },

    async kickTeam(workspace, teamId, suppliedCaptain) {
      if (disposed) return
      const stateRoot = stateRootOf(workspace, config)
      let team = await readTeam(stateRoot, teamId)
      if (team === undefined) return
      // A halted team is an explicit operator decision. Do not requeue failed
      // tasks, spawn members, or otherwise clear the halt as a side effect of
      // an idle/status event; only resumeTeam may reopen scheduling.
      if (team.halted === true) return
      await requeueRetryableTasks(stateRoot, teamId)
      team = await readTeam(stateRoot, teamId)
      if (disposed || team === undefined || team.halted === true) return
      const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain)
      if (captain === undefined) { await restoreMailboxRecovery(workspace, teamId); return }
      // All-terminal short circuit: settle member statuses ONCE and stop
      // waking anyone. Without this, every kick during a finished team still
      // runs the member loop, and the first member whose record says
      // "working" triggers a residual write long after completion.
      if (team.tasks.every(task => TERMINAL_TASK_STATUSES.includes(task.status))) {
        const stillTerminal = await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
          const fresh = await readTeam(stateRoot, teamId)
          if (disposed || fresh === undefined || fresh.halted === true
            || !fresh.tasks.every(task => TERMINAL_TASK_STATUSES.includes(task.status))) return false
          let changed = false
          for (const member of fresh.members) {
            if (member.status === 'removed') continue
            if (member.status !== 'idle') {
              member.status = 'idle'
              changed = true
            }
          }
          if (changed) await writeTeam(stateRoot, fresh)
          return true
        })
        if (!stillTerminal) return
        await notifyTeamCompletion(stateRoot, teamId)
        await flushCaptainMailbox(stateRoot, teamId, captain)
        await restoreMailboxRecovery(workspace, teamId)
        return
      }
      for (const member of team.members) {
        if (member.status === 'removed') continue
        await runtime.kickMember(workspace, teamId, member.name, captain)
      }
      await notifyTeamCompletion(stateRoot, teamId)
      await flushCaptainMailbox(stateRoot, teamId, captain)
      await restoreMailboxRecovery(workspace, teamId)
    },

    async kickMember(workspace, teamId, memberName, suppliedCaptain) {
      if (disposed) return
      const stateRoot = stateRootOf(workspace, config)
      const queueKey = `${stateRoot}\u0000${teamId}\u0000${memberName}`
      await serializeMember(queueKey, async () => {
        if (disposed) return
        let team = await readTeam(stateRoot, teamId)
        if (team === undefined) return
        if (team.halted === true) return
        const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain)
        if (captain === undefined) return
        let member = team.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
        if (member === undefined || member.id === '' || !isMemberAvailable(ctx, member)) return

        // A mailbox-only fallback is real pending work. Read the team and
        // mailbox under the same team lock so admission never evaluates an
        // outdated task attempt while a concurrent reassign is committing.
        const mailboxBatch = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
          const fresh = await readTeam(stateRoot, team!.id)
          const currentMember = fresh?.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
          if (disposed || fresh === undefined || fresh.halted === true || currentMember === undefined || currentMember.id === '' || !isMemberAvailable(ctx, currentMember)) {
            return undefined
          }
          const unread = await readUnreadMailbox(stateRoot, fresh.id, currentMember.name)
          const decisions = unread.map(message => ({ message, admission: admitTeamMessage(fresh, message) }))
          const admitted = decisions.filter(item => item.admission.accepted).map(item => item.message)
          const discarded = decisions.filter(item => !item.admission.accepted)
          for (const group of new Set(discarded.map(item => item.admission.accepted ? '' : item.admission.reason))) {
            const ids = discarded.filter(item => !item.admission.accepted && item.admission.reason === group).map(item => item.message.id)
            await discardMailbox(stateRoot, fresh.id, currentMember.name, ids, group)
          }
          if (admitted.length > 0) {
            if (!canReserve(fresh, currentMember)) return undefined
            const claimedIds = await claimMailboxDelivery(stateRoot, fresh.id, currentMember.name, admitted.map(message => message.id))
            const claimed = new Set(claimedIds)
            const activationId = claimed.size === 0 ? undefined : reserve(fresh, currentMember)
            if (activationId !== undefined) {
              if (fresh.runtimeWaits !== undefined) delete fresh.runtimeWaits[currentMember.id]
              await writeTeam(stateRoot, fresh)
            }
            return { team: fresh, member: currentMember, activationId, messages: admitted.filter(message => claimed.has(message.id)), leaseBusy: claimed.size === 0 }
          }
          return { team: fresh, member: currentMember, messages: admitted, leaseBusy: false }
        })
        if (mailboxBatch?.leaseBusy === true) { runtime.scheduleRecovery(workspace, teamId, MAILBOX_DELIVERY_LEASE_MS); return }
        if (mailboxBatch !== undefined && mailboxBatch.messages.length > 0) {
          const accepted = await deliverMemberMailbox(
            ctx,
            captain,
            mailboxBatch.member.id,
            mailboxBatch.messages,
            deliveryController.signal,
          )
          await settleReservation(stateRoot, team.id, mailboxBatch.member.id, mailboxBatch.activationId!, accepted)
          if (accepted) {
            await withTeamLock(teamLockKey(stateRoot, team.id), () => (
              acknowledgeMailbox(stateRoot, team!.id, mailboxBatch.member.name, mailboxBatch.messages.map(message => message.id))
            ))
          } else {
            await withTeamLock(teamLockKey(stateRoot, team.id), () => (
              releaseMailboxDelivery(stateRoot, team!.id, mailboxBatch.member.name, mailboxBatch.messages.map(message => message.id))
            ))
            runtime.scheduleRecovery(workspace, teamId)
          }
          return
        }

        const ticket = await withTeamLock(teamLockKey(stateRoot, team.id), async (): Promise<DispatchTicket | undefined> => {
          const fresh = await readTeam(stateRoot, team!.id)
          if (disposed || fresh === undefined || fresh.halted === true) return undefined
          const currentMember = fresh.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
          if (currentMember === undefined || currentMember.id === '' || !isMemberAvailable(ctx, currentMember)
            || !canReserve(fresh, currentMember)) return undefined
          // An open task owns this member even while waiting. planDispatch
          // separates deliberate waiting from runnable/interrupted recovery;
          // do not assign a second task just because the owner became idle.
          const task = ownedOpenTask(fresh.tasks, currentMember.name)
            ?? nextReadyTask(fresh.tasks, currentMember.name)
          if (fresh.runtimeWaits?.[currentMember.id] !== undefined) {
            // A dependency completion or quality repair can make a pending
            // assignment ready without a separate mailbox. That is a real
            // work event; an unchanged accepted open attempt is not.
            if (task?.status !== 'pending') return undefined
            delete fresh.runtimeWaits[currentMember.id]
          }
          if (task === undefined) {
            if (currentMember.status !== 'idle') {
              currentMember.status = 'idle'
              await writeTeam(stateRoot, fresh)
            }
            return undefined
          }
          // Only the same live receipt owns the cooldown. Repair retires the
          // capability; explicit resume clears the receipt even when keeping
          // the capability. Both must take effect immediately.
          const cooldownKey = `${stateRoot}\u0000${team!.id}\u0000${currentMember.name}\u0000${task.id}`
          const cached = lastDispatchAt.get(cooldownKey)
          const cachedAt = cached?.attemptId === task.attemptId && cached?.dispatchId === task.dispatch?.id
            ? cached?.dispatchedAt : undefined
          const decision = planDispatch(task, currentMember.name, cachedAt, clock.now())
          if (decision.blocked) {
            if (task.executionState !== 'awaiting_review' && task.executionState !== 'blocked_external'
              && task.dispatch !== undefined && task.dispatch.attemptId === task.attemptId) {
              armRecovery(workspace, teamId, Math.max(task.dispatch.nextRetryAt ?? 0, task.dispatch.dispatchedAt + DISPATCH_COOLDOWN_MS))
            }
            return undefined
          }

          const inputArtifacts: NonNullable<DispatchTicket['inputArtifacts']>[number][] = []
          let craftPacket: ReturnType<typeof prepareCraftDelivery> | undefined
          try {
            craftPacket = prepareCraftDelivery(task, currentMember.id, decision.reuse ? task.attempt ?? 1 : (task.attempt ?? 0) + 1, ['writer', 'renderer'], 'assignment')
            inputArtifacts.push(...await prepareDependencyInputs(stateRoot, fresh, task,
              decision.reuse ? task.attempt ?? 1 : (task.attempt ?? 0) + 1))
          } catch (error) {
            task.executionState = 'blocked_external'
            task.waitReason = `INPUT_ARTIFACT_BLOCKED: ${String(error)}`
            task.updatedAt = Date.now()
            await writeTeam(stateRoot, fresh)
            await syncTaskProjectInput(stateRoot, fresh, task)
            await appendMailbox(stateRoot, fresh.id, 'captain', createMessage('scheduler', 'captain',
              `Task ${task.id} was not dispatched: ${task.waitReason}. Restore the declared fixed version, then explicitly resume it. Input references cannot be edited in place; changed explicit inputs require a new consumer task. Automatic inputs may be selected again only in a supported new repair/reassignment attempt.`,
              { idempotencyKey: `input-artifact-blocked:${task.id}:${task.attempt ?? 0}:${task.waitReason}` }))
            return undefined
          }

          // Lost-turn recovery for a task the member already owns with a live
          // capability re-delivers the SAME attempt_id (idempotent: claim is a
          // no-op for the owner, update_task keeps working). NEVER open a new
          // generation here — a fresh attempt_id invalidates every prompt
          // already queued for the member and cascades into stale claims.
          const attemptId = decision.reuse
            ? task.attemptId!
            : beginTaskAttempt(task, currentMember.name)
          saveCraftDelivery(task, craftPacket?.receipts ?? [])
          await syncTaskProjectInput(stateRoot, fresh, task)
          const dispatchId = randomUUID()
          const dispatchedAt = clock.now()
          const failureCount = task.dispatch?.attemptId === attemptId ? task.dispatch.failureCount : undefined
          task.dispatch = { attemptId, id: dispatchId, dispatchedAt, ...(failureCount === undefined ? {} : { failureCount }) }
          const activationId = reserve(fresh, currentMember)
          currentMember.status = 'working'
          await writeTeam(stateRoot, fresh)
          lastDispatchAt.set(cooldownKey, { attemptId, dispatchId, dispatchedAt })
          return {
            taskId: task.id,
            memberName: currentMember.name,
            memberId: currentMember.id,
            attempt: task.attempt ?? 1,
            attemptId,
            dispatchId,
            activationId,
            subject: task.subject,
            description: task.description,
            sharedTaskContext: fresh.sharedTaskContext,
            taskProtocol: fresh.taskProtocol,
            repairFeedback: renderTaskRepairFeedback(fresh, task, stateRoot),
            craftContent: craftPacket?.content,
            craftReceipts: craftPacket?.receipts,
            ...(task.project === undefined ? {} : {
              projectPath: resolve(stateRoot, fresh.id, task.project.path),
              inputPath: resolve(stateRoot, fresh.id, task.project.inputPath),
              outputPath: resolve(stateRoot, fresh.id, task.project.outputPath),
            }),
            ...(inputArtifacts.length === 0 ? {} : { inputArtifacts }),
            inputArtifactWarnings: taskInputWarnings(task),
          }
        })
        if (ticket === undefined) return

        const accepted = await deliverToMember(
          ctx,
          captain,
          ticket.memberId,
          assignmentPrompt(ticket, config.stateDir, team.id),
          deliveryController.signal,
        )
        await settleReservation(stateRoot, team.id, ticket.memberId, ticket.activationId!, accepted)
        if (accepted) {
          await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
            const fresh = await readTeam(stateRoot, team!.id)
            const task = fresh?.tasks.find(candidate => candidate.id === ticket.taskId)
            if (fresh === undefined || task?.attemptId !== ticket.attemptId || task.dispatch === undefined || task.dispatch.id !== ticket.dispatchId) return
            for (const receipt of task.craftDeliveries ?? []) {
              if (ticket.craftReceipts?.some(r => r.id === receipt.id)) receipt.accepted = true
            }
            task.dispatch.acceptedAt = clock.now()
            task.dispatch.failureCount = undefined
            task.dispatch.nextRetryAt = undefined
            if (task.executionState === 'interrupted' && task.waitReason?.startsWith('DISPATCH_DELIVERY_FAILED:')) {
              task.executionState = 'active'
              task.waitReason = undefined
            }
            await writeTeam(stateRoot, fresh)
          })
          return
        }

        // A transport failure does not retire a persisted capability, even on
        // its first dispatch. Keep the same receipt for cooldown/recovery:
        // re-opening pending here would inflate attempts on every failed kick
        // and could invalidate a prompt accepted before the transport threw.
        if (disposed) return
        await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
          const fresh = await readTeam(stateRoot, team!.id)
          if (disposed || fresh === undefined || fresh.halted === true) return
          const task = fresh.tasks.find(candidate => candidate.id === ticket.taskId)
          if (task === undefined || task.dispatch === undefined || task.attemptId !== ticket.attemptId || task.dispatch.id !== ticket.dispatchId) return
          task.dispatch.failureCount = (task.dispatch.failureCount ?? 0) + 1
          if (task.executionState !== 'awaiting_review' && task.executionState !== 'blocked_external') {
            if (task.dispatch.failureCount >= MAX_DISPATCH_FAILURES) {
              task.executionState = 'blocked_external'
              task.waitReason = 'DISPATCH_DELIVERY_EXHAUSTED: Restore member transport and explicitly resume this task; its attempt is preserved.'
              task.dispatch.nextRetryAt = undefined
              await appendMailbox(stateRoot, team!.id, 'captain', createMessage('scheduler', 'captain',
                `Task ${task.id} paused after ${MAX_DISPATCH_FAILURES} failed deliveries. ${task.waitReason}`,
                { idempotencyKey: `dispatch-delivery-exhausted:${task.id}:${ticket.attemptId}` }))
            } else {
              task.executionState = 'interrupted'
              task.waitReason = 'DISPATCH_DELIVERY_FAILED: Delivery was not accepted; retry this same attempt after the dispatch cooldown.'
              task.dispatch.nextRetryAt = clock.now() + DISPATCH_COOLDOWN_MS
              armRecovery(workspace, teamId, task.dispatch.nextRetryAt)
            }
          }
          task.updatedAt = Date.now()
          const currentMember = fresh.members.find(candidate => candidate.name === ticket.memberName)
          if (currentMember !== undefined && currentMember.status !== 'removed') currentMember.status = 'idle'
          await writeTeam(stateRoot, fresh)
        })
      })
    },
  }

  const observeTurn = async (sessionId: string, workspace: string, event: SessionEvent): Promise<void> => {
    if (disposed || (event.type !== 'turn/start' && event.type !== 'turn/end')) return
    const stateRoot = stateRootOf(workspace, config)
    const located = await findTeamByParticipant(stateRoot, sessionId)
    if (located === undefined) return
    let changed = false
    await withTeamLock(teamLockKey(stateRoot, located.id), async () => {
      const team = await readTeam(stateRoot, located.id)
      if (team === undefined) return
      if (event.type === 'turn/start') {
        changed = captureRuntimeTurn(team, sessionId, event.data.turn, event.time)
      } else {
        const member = team.members.find(item => item.id === sessionId && item.status !== 'removed')
        if (event.data.reason.kind === 'error') {
          const block = recordRuntimeFailure(team, sessionId, event.data.turn, event.data.reason.error, event.time)
          if (block !== undefined) {
            changed = true
            await appendMailbox(stateRoot, team.id, 'captain', createMessage('scheduler', 'captain',
              `Member runtime stopped: session ${sessionId}, turn ${block.turn}, code ${block.code}${block.status === undefined ? '' : ` (HTTP ${block.status})`}. ${block.message}. Automatic wake/retry is paused for this session; submitted artifacts and quality state are preserved. Restore its provider/connection and explicitly resume this member session. A captain model change does not resume member routes.`,
              { idempotencyKey: block.id }))
          }
        }
        if (event.data.reason.kind === 'completed' && member?.runtimeTurn?.turn === event.data.turn
          && team.runtimeWaits?.[sessionId] === undefined) {
          const unfinished = member.runtimeTurn.taskAttempts.filter(owned => team.tasks.some(task => task.id === owned.taskId
            && task.attemptId === owned.attemptId && task.assignee === member.name
            && (task.status === 'claimed' || task.status === 'in_progress')
            && (task.executionState === undefined || task.executionState === 'active')))
          if (unfinished.length > 0) {
            team.runtimeWaits ??= {}
            team.runtimeWaits[sessionId] = { reason: 'Turn ended with unfinished work; inspect the result and explicitly resume the same attempt or submit it for review.',
              taskIds: unfinished.map(task => task.taskId), since: event.time }
            changed = true
            await appendMailbox(stateRoot, team.id, 'captain', createMessage('scheduler', 'captain',
              `Member ${member.name} ended turn ${event.data.turn} while ${unfinished.map(task => task.taskId).join(', ')} remains unfinished. Automatic redispatch is paused. Inspect its persisted result; use resume_task to continue the same attempt, or arrange the required independent review. Do not poll or create a replacement attempt merely because the member is idle.`,
              { idempotencyKey: `unfinished-turn:${sessionId}:${event.data.turn}` }))
          }
        }
        if (member?.activation !== undefined && member.activation.turn === event.data.turn
          && (member.runtimeTurn?.turn ?? -1) <= event.data.turn) {
          member.activation = undefined
          changed = true
        }
      }
      if (changed) await writeTeam(stateRoot, team)
    })
  }
  const reconcileLatestTurn = async (agent: Agent): Promise<void> => {
    await eventQueues.get(agent.id)
    const events = sessionOwnEvents(agent.session) as readonly SessionEvent[]
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!
      if (event.type === 'turn/start') return
      if (event.type === 'turn/end') {
        await observeTurn(agent.id, agent.session.header.cwd ?? process.cwd(), event)
        return
      }
    }
  }
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/start' && event.type !== 'turn/end') return
    const previous = eventQueues.get(session.id) ?? Promise.resolve()
    const next = previous.then(() => observeTurn(session.id, session.header.cwd ?? process.cwd(), event))
      .catch((error: unknown) => ctx.logger.warn(`expert-teams: runtime observation failed for ${session.id}: ${String(error)}`))
    eventQueues.set(session.id, next)
    void next.finally(() => { if (eventQueues.get(session.id) === next) eventQueues.delete(session.id) })
  })

  const syncMemberStatus = async (agent: Agent, status: AgentStatus): Promise<void> => {
    if (status === 'idle') await reconcileLatestTurn(agent)
    const workspace = agent.session.header.cwd ?? process.cwd()
    const stateRoot = stateRootOf(workspace, config)
    // A captain status edge is also the restart/reconnect signal for its
    // durable team. Reconcile open member claims before normal member status
    // handling; planDispatch reuses live attempt ids, so this is idempotent.
    const captainTeam = await findTeamByCaptain(stateRoot, agent.id)
    if (captainTeam !== undefined) {
      if (status === 'idle') await runtime.kickTeam(workspace, captainTeam.id, agent)
      else if (status === 'running') await flushCaptainMailbox(stateRoot, captainTeam.id, agent)
      return
    }
    const located = await findTeamByParticipant(stateRoot, agent.id)
    if (located === undefined || located.captainSessionId === agent.id) return
    const member = located.members.find(candidate => candidate.id === agent.id && candidate.status !== 'removed')
    if (member === undefined) return
    await withTeamLock(teamLockKey(stateRoot, located.id), async () => {
      const fresh = await readTeam(stateRoot, located.id)
      const current = fresh?.members.find(candidate => candidate.id === agent.id && candidate.status !== 'removed')
      if (fresh === undefined || current === undefined) return
      // A late idle callback may race with a newly accepted activation. The
      // old turn's end handler only clears its own turn; don't release a new
      // reservation once fresh input already owns the next turn.
      if (status === 'idle' && (agent.status !== 'idle' || agent.inbox?.hasPending === true)) return
      const next = status === 'running' ? 'working' : 'idle'
      // Real sessions release the exact reservation at their turn/end. The
      // event-less compatibility cohort only has the status edge available.
      if (status === 'idle' && sessionOwnEvents(agent.session).length === 0) current.activation = undefined
      if (current.status === next && status !== 'idle') return
      current.status = next
      await writeTeam(stateRoot, fresh)
    })
    if (status === 'idle') await runtime.kickTeam(workspace, located.id)
  }

  ctx.on('agent/status', ({ agent, status }) => {
    void syncMemberStatus(agent, status).catch((error: unknown) => {
      ctx.logger.warn(`expert-teams: member status scheduling failed for ${agent.id}: ${String(error)}`)
    })
  })
  const dispose = (): void => {
    disposed = true
    deliveryController.abort(new Error('team scheduler disposed'))
    for (const pending of recoveryTimers.values()) clock.clearTimeout(pending.timer)
    recoveryTimers.clear()
    mailboxRecovery.clear()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'expert-teams: scheduler recovery timers')

  return runtime
}
