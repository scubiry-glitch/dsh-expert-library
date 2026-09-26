/**
 * Durable staged-plan storage and lifecycle rules.
 *
 * This module deliberately has no Harness or spawn dependency. Preview and
 * stage can therefore be tested without creating a team; applying a plan is
 * owned by the tool layer after an explicit approval CAS.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findTeamByPlanId, replaceFileAtomicOrDirect, withTeamLock } from './state.ts'
import { canonicalDigest } from './v2/digest.ts'
import type { ExecutionPlan } from './v2/compiler.ts'
import type {
  StagedPlan,
  StagedPlanEdit,
  StagedPlanRuntime,
  StagedPlanStatus,
} from './types.ts'

export const STAGED_PLAN_DIR = 'plans'
export const STAGED_PLAN_SCHEMA_VERSION = 1 as const
const SAFE_PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const STAGED_PLAN_TRANSITIONS: Readonly<Record<StagedPlanStatus, readonly StagedPlanStatus[]>> = {
  staged: ['approved', 'discarded', 'expired'],
  approved: ['running', 'discarded', 'failed'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
  discarded: [],
  expired: [],
}

export function stagedPlanTransitionError(current: StagedPlanStatus, next: StagedPlanStatus): string | undefined {
  if (current === next) return undefined
  if (!STAGED_PLAN_TRANSITIONS[current].includes(next)) {
    return `staged plan cannot move from "${current}" to "${next}"`
  }
  return undefined
}

export function stagedPlanPath(stateRoot: string, planId: string): string {
  if (!SAFE_PLAN_ID.test(planId)) throw new Error(`invalid staged plan id "${planId}"`)
  return join(stateRoot, STAGED_PLAN_DIR, `${planId}.json`)
}

export function stagedPlanLockKey(stateRoot: string, planId: string): string {
  return `staged-plan:${stateRoot}:${planId}`
}

const STAGED_LOCK_RETRY_MS = 25
const STAGED_LOCK_STALE_MS = 120_000

async function acquireStagedPlanFileLock(stateRoot: string, planId: string): Promise<() => Promise<void>> {
  const plansDir = join(stateRoot, STAGED_PLAN_DIR)
  await mkdir(plansDir, { recursive: true })
  const lockPath = join(plansDir, `${planId}.lock`)
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), 'utf8')
      await handle.close()
      return async () => { await rm(lockPath, { force: true }) }
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST')) throw error
      try {
        const age = Date.now() - (await stat(lockPath)).mtimeMs
        if (age > STAGED_LOCK_STALE_MS) {
          await rm(lockPath, { force: true })
          continue
        }
      } catch {
        // The owner may have released the lock between stat and cleanup.
      }
      await new Promise(resolve => setTimeout(resolve, STAGED_LOCK_RETRY_MS))
    }
  }
}

export async function withStagedPlanLock<T>(stateRoot: string, planId: string, fn: () => Promise<T>): Promise<T> {
  if (!SAFE_PLAN_ID.test(planId)) throw new Error(`invalid staged plan id "${planId}"`)
  return withTeamLock(stagedPlanLockKey(stateRoot, planId), async () => {
    const release = await acquireStagedPlanFileLock(stateRoot, planId)
    try {
      return await fn()
    } finally {
      await release()
    }
  })
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const content = JSON.stringify(value, null, 2)
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
  try {
    await replaceFileAtomicOrDirect(temporary, file, content, {
      rename: async (from, to) => {
        const { rename } = await import('node:fs/promises')
        await rename(from, to)
      },
      writeFile: (target, payload) => writeFile(target, payload, 'utf8'),
      remove: (path) => rm(path, { force: true }),
    })
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStatus(value: unknown): value is StagedPlanStatus {
  return typeof value === 'string' && value in STAGED_PLAN_TRANSITIONS
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string')
}

function isRequest(value: unknown): value is Record<string, string | undefined> {
  return isRecord(value) && Object.values(value).every(item => item === undefined || typeof item === 'string')
}

function isRuntime(value: unknown): value is StagedPlanRuntime {
  if (!isRecord(value) || typeof value['teamName'] !== 'string' || typeof value['description'] !== 'string') return false
  if (value['interpolations'] !== undefined && !isStringRecord(value['interpolations'])) return false
  if (value['taskSuffixes'] !== undefined && !isStringRecord(value['taskSuffixes'])) return false
  if (value['memberOrder'] !== undefined
    && (!Array.isArray(value['memberOrder']) || !value['memberOrder'].every(item => typeof item === 'string'))) return false
  return true
}

/**
 * Digest the complete staged input, rather than only the compiler artifact.
 *
 * `ExecutionPlan.digest` intentionally covers only compiler inputs. Runtime
 * values such as a concrete goal, team name, interpolation, or task suffix
 * are supplied by the apply bridge, so they must participate in the approval
 * CAS digest as well. Canonical serialization makes key insertion order
 * irrelevant and avoids treating omitted optional values differently from
 * their JSON representation.
 */
export function stagedPlanDigest(
  planDigest: string,
  request: Readonly<Record<string, string | undefined>>,
  runtime: StagedPlanRuntime,
): string {
  return canonicalDigest({
    schemaVersion: STAGED_PLAN_SCHEMA_VERSION,
    compilerDigest: planDigest,
    request,
    runtime,
  })
}

function normalizeRuntime(runtime: StagedPlanRuntime): StagedPlanRuntime {
  return {
    teamName: runtime.teamName,
    description: runtime.description,
    ...(runtime.interpolations === undefined ? {} : { interpolations: { ...runtime.interpolations } }),
    ...(runtime.memberOrder === undefined ? {} : { memberOrder: [...runtime.memberOrder] }),
    ...(runtime.taskSuffixes === undefined ? {} : { taskSuffixes: { ...runtime.taskSuffixes } }),
  }
}

function isEditLog(value: unknown, revision: number, digest: string): value is readonly StagedPlanEdit[] {
  if (!Array.isArray(value) || value.length !== revision) return false
  let previousDigest: string | undefined
  for (let index = 0; index < value.length; index += 1) {
    const edit = value[index]
    if (!isRecord(edit)
      || edit['revision'] !== index + 1
      || typeof edit['at'] !== 'number'
      || !Number.isFinite(edit['at'])
      || typeof edit['by'] !== 'string'
      || edit['by'].trim() === ''
      || typeof edit['parentDigest'] !== 'string'
      || edit['parentDigest'].trim() === ''
      || typeof edit['digest'] !== 'string'
      || edit['digest'].trim() === ''
      || !Array.isArray(edit['fields'])
      || !edit['fields'].every(field => typeof field === 'string' && field.trim() !== '')) return false
    if (previousDigest !== undefined && edit['parentDigest'] !== previousDigest) return false
    previousDigest = edit['digest']
  }
  return previousDigest === undefined ? revision === 0 : previousDigest === digest
}

/** Tolerant structural validation for staged records at the JSON boundary. */
export function isStagedPlan(value: unknown): value is StagedPlan {
  if (!isRecord(value)) return false
  const plan = value['plan']
  const request = value['request']
  const runtime = value['runtime']
  return value['schemaVersion'] === STAGED_PLAN_SCHEMA_VERSION
    && typeof value['planId'] === 'string'
    && value['planId'].trim() !== ''
    && typeof value['digest'] === 'string'
    && value['digest'].trim() !== ''
    && Number.isSafeInteger(value['revision'])
    && (value['revision'] as number) >= 0
    && isStatus(value['status'])
    && typeof value['createdAt'] === 'number'
    && Number.isFinite(value['createdAt'])
    && typeof value['updatedAt'] === 'number'
    && Number.isFinite(value['updatedAt'])
    && typeof value['expiresAt'] === 'number'
    && Number.isFinite(value['expiresAt'])
    && typeof value['createdBy'] === 'string'
    && SAFE_PLAN_ID.test(value['planId'] as string)
    && value['createdBy'].trim() !== ''
    && isRequest(request)
    && isRuntime(runtime)
    && isRecord(plan)
    && plan['planId'] === value['planId']
    && typeof plan['digest'] === 'string'
    && plan['digest'].trim() !== ''
    && value['digest'] === stagedPlanDigest(plan['digest'], request, runtime)
    && isEditLog(value['editLog'], value['revision'] as number, value['digest'] as string)
}

export async function writeStagedPlan(stateRoot: string, plan: StagedPlan): Promise<void> {
  if (!isStagedPlan(plan)) throw new Error('invalid staged plan')
  await mkdir(join(stateRoot, STAGED_PLAN_DIR), { recursive: true })
  await writeJsonAtomic(stagedPlanPath(stateRoot, plan.planId), plan)
}

export async function readStagedPlan(stateRoot: string, planId: string): Promise<StagedPlan | undefined> {
  try {
    const raw = await readFile(stagedPlanPath(stateRoot, planId), 'utf8')
    let value: unknown
    try {
      value = JSON.parse(raw.replace(/^\uFEFF/u, ''))
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`invalid staged plan "${planId}": ${detail}`, { cause: error })
    }
    if (!isStagedPlan(value)) throw new Error(`invalid staged plan "${planId}"`)
    return value
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function listStagedPlanIds(stateRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(stateRoot, STAGED_PLAN_DIR), { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name.slice(0, -'.json'.length))
      .sort()
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Reconcile durable staged records after a host restart.
 *
 * The caller supplies a workspace state root, so this scan is side-effect free
 * outside the plans directory. `running` plans are completed when their
 * materialized team's planRef is present; otherwise they become an explicit
 * failed record instead of being silently retried. Expired drafts are marked
 * expired while approved drafts remain approval-ready for a later resume.
 */
export async function recoverStagedPlans(stateRoot: string, now = Date.now()): Promise<StagedPlan[]> {
  const recovered: StagedPlan[] = []
  for (const planId of await listStagedPlanIds(stateRoot)) {
    await withStagedPlanLock(stateRoot, planId, async () => {
      const current = await readStagedPlan(stateRoot, planId)
      if (current === undefined) return
      let next = current
      if (current.status === 'staged' && current.expiresAt <= now) {
        next = transitionStagedPlan(current, 'expired', { now })
      } else if (current.status === 'running') {
        const team = await findTeamByPlanId(stateRoot, planId)
        next = team === undefined
          ? transitionStagedPlan(current, 'failed', { now, failureReason: 'recovery found no durable team for running plan' })
          : transitionStagedPlan(current, 'completed', { now, appliedTeamId: team.id })
      }
      if (next !== current) await writeStagedPlan(stateRoot, next)
      recovered.push(next)
    })
  }
  return recovered
}

export function createStagedPlan(input: {
  planId?: string
  plan: ExecutionPlan
  request: Readonly<Record<string, string | undefined>>
  runtime: StagedPlanRuntime
  createdBy: string
  sessionId?: string
  expiresAt: number
  now?: number
}): StagedPlan {
  const now = input.now ?? Date.now()
  // The staged id is the recovery/approval identity. Keep the same id inside
  // the compiled plan so apply writes a TeamState.planRef that can be found
  // after a crash between materialization and finalizing the staged record.
  const planId = input.planId ?? `plan-${randomUUID()}`
  const plan = input.plan.planId === planId ? input.plan : { ...input.plan, planId }
  return {
    schemaVersion: STAGED_PLAN_SCHEMA_VERSION,
    planId,
    digest: stagedPlanDigest(plan.digest, input.request, input.runtime),
    revision: 0,
    status: 'staged',
    createdAt: now,
    updatedAt: now,
    expiresAt: input.expiresAt,
    createdBy: input.createdBy,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    request: { ...input.request },
    runtime: normalizeRuntime(input.runtime),
    plan,
    editLog: [],
  }
}

export function expireStagedPlan(plan: StagedPlan, now = Date.now()): StagedPlan {
  if (plan.status !== 'staged' || plan.expiresAt > now) return plan
  return transitionStagedPlan(plan, 'expired', { now })
}

export function transitionStagedPlan(
  plan: StagedPlan,
  next: StagedPlanStatus,
  opts: {
    now?: number
    actor?: string
    appliedTeamId?: string
    failureReason?: string
  } = {},
): StagedPlan {
  const error = stagedPlanTransitionError(plan.status, next)
  if (error !== undefined) throw new Error(error)
  const now = opts.now ?? Date.now()
  return {
    ...plan,
    status: next,
    updatedAt: now,
    ...(next === 'approved' ? { approvedAt: now, approvedBy: opts.actor ?? plan.createdBy } : {}),
    ...(opts.appliedTeamId === undefined ? {} : { appliedTeamId: opts.appliedTeamId }),
    ...(opts.failureReason === undefined ? {} : { failureReason: opts.failureReason }),
  }
}

export function editStagedPlan(
  plan: StagedPlan,
  input: {
    plan: ExecutionPlan
    request: Readonly<Record<string, string | undefined>>
    runtime: StagedPlanRuntime
    fields: readonly string[]
    actor: string
    now?: number
  },
): StagedPlan {
  if (plan.status !== 'staged') throw new Error(`only staged plans can be edited; current status is "${plan.status}"`)
  const now = input.now ?? Date.now()
  const stagedDigest = stagedPlanDigest(input.plan.digest, input.request, input.runtime)
  const edit: StagedPlanEdit = {
    revision: plan.revision + 1,
    at: now,
    by: input.actor,
    parentDigest: plan.digest,
    digest: stagedDigest,
    fields: [...input.fields],
  }
  // A recompiled draft gets a new deterministic compiler id. The durable
  // staged record keeps its own id across edits so optimistic CAS and crash
  // recovery continue to address the same plan.
  const stagedPlan = input.plan.planId === plan.planId ? input.plan : { ...input.plan, planId: plan.planId }
  return {
    ...plan,
    digest: stagedDigest,
    revision: edit.revision,
    updatedAt: now,
    request: { ...input.request },
    runtime: normalizeRuntime(input.runtime),
    plan: stagedPlan,
    editLog: [...plan.editLog, edit],
  }
}
