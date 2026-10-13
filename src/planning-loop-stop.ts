/** Durable loop stop for an explicitly admitted workflow before a team exists. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamState } from './types.ts'
import { withTeamLock } from './state.ts'
import { persistGoalAwareWait } from './goal-wait.ts'

interface PlanningLoopStop {
  schemaVersion: 1
  captainSessionId: string
  contextSha256: string
  code: 'TOOL_LOOP_DETECTED'
  turn: number
  stoppedAt: number
  goalWait?: { goalId: string; pausedRevision: number; createdAt: number }
}
function location(root: string, captain: string, context: string): string {
  if (!/^[a-f0-9]{64}$/u.test(context)) throw new Error('PLANNING_LOOP_CONTEXT_INVALID')
  return join(root, 'plans', 'runtime-blocks', createHash('sha256').update(captain + '\0' + context).digest('hex') + '.json')
}
export async function readPlanningLoopStop(root: string, captain: string, context: string): Promise<PlanningLoopStop | undefined> {
  try {
    const value = JSON.parse(await readFile(location(root, captain, context), 'utf8')) as PlanningLoopStop
    if (value.schemaVersion !== 1 || value.captainSessionId !== captain || value.contextSha256 !== context
      || value.code !== 'TOOL_LOOP_DETECTED' || !Number.isInteger(value.turn) || value.turn < 1
      || !Number.isFinite(value.stoppedAt) || (value.goalWait !== undefined
        && (typeof value.goalWait.goalId !== 'string' || !Number.isInteger(value.goalWait.pausedRevision)
          || !Number.isFinite(value.goalWait.createdAt)))) throw new Error('PLANNING_LOOP_STOP_INVALID')
    return value
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export async function persistPlanningLoopStop(ctx: Context, agent: Agent, root: string, context: string, turn: number): Promise<void> {
  const path = location(root, agent.id, context)
  await withTeamLock('planning-loop:' + path, async () => {
    const old = await readPlanningLoopStop(root, agent.id, context)
    const record: PlanningLoopStop = old ?? {
      schemaVersion: 1, captainSessionId: agent.id, contextSha256: context,
      code: 'TOOL_LOOP_DETECTED', turn, stoppedAt: Date.now(),
    }
    // Reuse the public Goal CAS/durability bridge without inventing a team.
    // A manual Goal resume with unchanged input cannot restart a model loop;
    // a fresh user input has another context and requires its own admission.
    const holder: Pick<TeamState, 'goalWaits'> = {
      goalWaits: record.goalWait === undefined ? {} : { [agent.id]: record.goalWait },
    }
    await persistGoalAwareWait(ctx, agent, holder, async () => {
      const { goalWait: _previous, ...base } = record
      const ticket = holder.goalWaits?.[agent.id]
      const value = { ...base, ...(ticket === undefined ? {} : { goalWait: ticket }) }
      await mkdir(join(root, 'plans', 'runtime-blocks'), { recursive: true })
      const temporary = path + '.' + randomUUID() + '.tmp'
      await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
      await rename(temporary, path)
    })
  })
}
