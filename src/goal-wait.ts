/** Bridge event waits to the Host's public, revision-checked goal lifecycle. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { join } from 'node:path'
import { findTeamByParticipant, readTeam, withTeamLock, writeTeam } from './state.ts'
import type { TeamState, StagedPlan } from './types.ts'
import { listStagedPlanIds, readStagedPlan, writeStagedPlan } from './staged-plan.ts'

interface GoalRef { id: string; revision: number }
interface GoalView extends GoalRef {
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  activation: 'armed' | 'disarmed'
}
interface Goals {
  get(agent: Agent): GoalView | undefined
  pause(agent: Agent, ref: GoalRef): GoalView
  resume(agent: Agent, ref: GoalRef): GoalView
}

// Goals are an optional Host service; older installations without goal mode
// retain ordinary event waiting. Never import a second copy of the service.
function goalsOf(ctx: Context): Goals | undefined {
  const goals = typeof ctx.get === 'function' ? ctx.get('goals') as Goals | undefined : undefined
  if (goals !== undefined && (typeof goals.get !== 'function' || typeof goals.pause !== 'function'
    || typeof goals.resume !== 'function')) throw new Error('Host goals service lacks the public get/pause/resume contract')
  return goals
}

function asInitiator<T>(ctx: Context, agent: Agent, action: () => T): T {
  const agents = ctx.agents as unknown as { withInitiator?: <R>(agent: Agent, action: () => R) => R }
  if (typeof agents?.withInitiator !== 'function') throw new Error('Host goals waiting requires agents.withInitiator')
  // External pause cancels a running turn. This is the caller parking its own
  // turn, so the driver must see that exact live caller as the initiator.
  return agents.withInitiator(agent, action)
}

function matches(goal: GoalView | undefined, ticket: NonNullable<TeamState['goalWaits']>[string]): boolean {
  return goal?.id === ticket.goalId && goal.revision === ticket.pausedRevision && goal.phase === 'paused'
}

function goalJournal(ctx: Context): { flush(session: Agent['session']): Promise<void> } {
  const sessions = ctx.get('sessions') as { flush?: (session: Agent['session']) => Promise<boolean> } | undefined
  if (typeof sessions?.flush !== 'function') throw new Error('Host goals waiting requires sessions.flush')
  return {
    async flush(session) {
      if (await sessions.flush!(session) !== true) throw new Error('Goal wait checkpoint requires a session durability listener')
    },
  }
}

/** Caller holds the team lock. Only a pause returned by the Host creates a
 * resumable ticket; a predicted next revision cannot prove pause ownership.
 * A failed write rolls back by exact CAS. A process kill between pause and
 * persistence safely leaves the goal paused for explicit operator resume.
 */
export async function persistGoalAwareWait(
  ctx: Context, agent: Agent, team: Pick<TeamState, 'goalWaits'>, persist: () => Promise<void>,
): Promise<void> {
  const goals = goalsOf(ctx)
  const goal = goals?.get(agent)
  const previous = team.goalWaits?.[agent.id]
  if (previous !== undefined && !matches(goal, previous)) delete team.goalWaits![agent.id]
  if (goals === undefined || goal?.phase !== 'active' || goal.activation !== 'armed') {
    await persist()
    return
  }
  const journal = goalJournal(ctx)
  const paused = asInitiator(ctx, agent, () => goals.pause(agent, { id: goal.id, revision: goal.revision }))
  const ticket = { goalId: paused.id, pausedRevision: paused.revision, createdAt: Date.now() }
  team.goalWaits = { ...team.goalWaits, [agent.id]: ticket }
  try {
    // The public goal mutation appends synchronously to memory. Flush its
    // journal before making the cross-journal ownership receipt durable.
    await journal.flush(agent.session)
    await persist()
  } catch (error) {
    // Never overwrite a manual edit, complete, clear or replacement goal.
    try {
      if (matches(goals.get(agent), ticket)) {
        asInitiator(ctx, agent, () => goals.resume(agent, { id: ticket.goalId, revision: ticket.pausedRevision }))
        await journal.flush(agent.session)
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Wait persistence and compensation failed; inspect the current goal before explicitly resuming it')
    }
    throw error
  }
}

/** Resume only after real input has passed all downstream admission hooks.
 * Doing this before the model request also prevents a fast second wait from
 * being undone by a late delivery acknowledgement from the first wake.
 */
export function installGoalWaitResumption(ctx: Context, stateDir: string): void {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || signal.aborted || !decision.messages.some(message =>
      message.source.kind === 'user'
      || (message.source.kind === 'plugin' && message.source.plugin === 'dsh-expert-library'))) return decision
    const stateRoot = join(agent.session.header.cwd ?? process.cwd(), stateDir)
    const located = await findTeamByParticipant(stateRoot, agent.id)
    if (located?.goalWaits?.[agent.id] === undefined) return decision
    await withTeamLock(`team:${stateRoot}:${located.id}`, async () => {
      const team = await readTeam(stateRoot, located.id)
      const ticket = team?.goalWaits?.[agent.id]
      if (team === undefined || ticket === undefined || signal.aborted) return
      const humanInput = decision.messages.some(message => message.source.kind === 'user')
      if (humanInput) {
        // Human takeover also revokes future automatic restoration while
        // this team is halted or its runtime is blocked.
        delete team.goalWaits![agent.id]
        if (team.runtimeWaits !== undefined) delete team.runtimeWaits[agent.id]
        await writeTeam(stateRoot, team)
        return
      }
      if (team.halted === true) return
      const isCaptain = team.captainSessionId === agent.id
      const member = team.members.find(item => item.id === agent.id && item.status !== 'removed')
      if ((!isCaptain && member === undefined) || (isCaptain ? team.captainRuntimeBlock : member?.runtimeBlock) !== undefined) return
      const goals = goalsOf(ctx)
      if (goals === undefined) return
      const current = goals.get(agent)
      if (matches(current, ticket)) {
        // Synchronous exact CAS: no await between reading and resuming.
        const journal = goalJournal(ctx)
        const resumed = asInitiator(ctx, agent, () => goals.resume(agent, { id: ticket.goalId, revision: ticket.pausedRevision }))
        try {
          await journal.flush(agent.session)
        } catch (error) {
          // A durability failure must not leave a process-local armed goal
          // spinning. Compensate only our unchanged resumed revision, then
          // persist the replacement paused receipt after its journal flush.
          const latest = goals.get(agent)
          if (latest?.id === resumed.id && latest.revision === resumed.revision && latest.phase === 'active') {
            const paused = asInitiator(ctx, agent, () => goals.pause(agent, { id: latest.id, revision: latest.revision }))
            await journal.flush(agent.session)
            team.goalWaits![agent.id] = { goalId: paused.id, pausedRevision: paused.revision, createdAt: Date.now() }
            await writeTeam(stateRoot, team)
          }
          throw error
        }
      }
      // A different ref belongs to another control operation. Retire only
      // our stale ticket; never resume that changed or manually paused goal.
      // Human input also takes control: process it normally, but do not infer
      // permission to arm a paused goal from arbitrary text (e.g. "stop").
      delete team.goalWaits![agent.id]
      if (team.runtimeWaits !== undefined) delete team.runtimeWaits[agent.id]
      await writeTeam(stateRoot, team)
    }).catch((error: unknown) => {
      // Input is still allowed to run, e.g. to raise an exhausted goal cap.
      // Failure here must neither drop the real message nor start polling.
      ctx.logger.warn(`expert-teams: goal wait resumption failed for ${agent.id}: ${String(error)}`)
    })
    return decision
  })
}

/** A replacement plan may retain a retired plan's pause only while the
 * native Goal still has that exact plugin-owned revision. Discard itself
 * never arms automatic rounds, and the old audit record stays unchanged. */
export async function inheritRetiredPlanGoalWait(ctx: Context, agent: Agent, root: string, plan: StagedPlan): Promise<StagedPlan> {
  const current = goalsOf(ctx)?.get(agent)
  if (plan.goalWait !== undefined || current?.phase !== 'paused') return plan
  const retired: StagedPlan[] = []
  for (const id of await listStagedPlanIds(root)) {
    if (id === plan.planId) continue
    const candidate = await readStagedPlan(root, id)
    if (candidate?.createdBy === agent.id && ['discarded', 'expired', 'failed'].includes(candidate.status)
      && candidate.goalWait !== undefined && matches(current, candidate.goalWait)) retired.push(candidate)
  }
  const source = retired.sort((a, b) => b.updatedAt - a.updatedAt)[0]
  return source?.goalWait === undefined ? plan : { ...plan, goalWait: { ...source.goalWait, sourcePlanId: source.planId } }
}

/** A staged plan exists before a team, so its user-confirmation wait owns its
 * own exact Host goal pause receipt. No polling or artificial team is needed. */
export async function persistPlanUserWait(ctx: Context, agent: Agent, root: string, plan: StagedPlan): Promise<StagedPlan> {
  const holder: Pick<TeamState, 'goalWaits'> = { goalWaits: plan.goalWait === undefined ? {} : { [agent.id]: plan.goalWait } }
  let result = plan
  await persistGoalAwareWait(ctx, agent, holder, async () => {
    result = { ...plan, waitingFor: 'user-confirmation', ...(holder.goalWaits?.[agent.id] === undefined ? {} : { goalWait: holder.goalWaits[agent.id] }) }
    await writeStagedPlan(root, result)
  })
  return result
}

export async function resumePlanUserWait(ctx: Context, agent: Agent, plan: StagedPlan, root: string): Promise<void> {
  const ticket = plan.goalWait
  if (ticket === undefined) return
  const goals = goalsOf(ctx)
  if (goals === undefined || !matches(goals.get(agent), ticket)) return
  const resumed = asInitiator(ctx, agent, () => goals.resume(agent, { id: ticket.goalId, revision: ticket.pausedRevision }))
  try {
    await goalJournal(ctx).flush(agent.session)
  } catch (error) {
    // A resume that cannot be made durable must not leave automatic rounds
    // armed. Park only our unchanged revision and retain its exact new ticket
    // so replay of the completed plan can recover safely.
    const latest = goals.get(agent)
    if (latest?.id === resumed.id && latest.revision === resumed.revision && latest.phase === 'active') {
      const paused = asInitiator(ctx, agent, () => goals.pause(agent, { id: latest.id, revision: latest.revision }))
      await goalJournal(ctx).flush(agent.session)
      await writeStagedPlan(root, { ...plan, goalWait: { goalId: paused.id, pausedRevision: paused.revision, createdAt: Date.now() } })
    }
    throw error
  }
}
