import { isCraftDeliveryReceipt, isCraftReviewPreparation } from './report-craft-delivery.ts'
/**
 * Team state persistence and pure team-logic rules.
 *
 * State lives on disk under `<workspace>/<stateDir>/<teamId>/`:
 * - `team.json` — the durable {@link TeamState} record
 * - `inbox/<agentKey>.jsonl` — one JSONL mailbox per agent (`captain` or a
 *   member name), mirroring the Claude Code Expert Teams mailbox layout
 *
 * All mutations run through an in-process per-team queue so read-modify-write
 * stays serial; `fs/promises` is used directly because the plugin owns this
 * bookkeeping (host-plane state, like session persistence) and the abstract
 * `fs` service offers no directory deletion.
 * @module dsh-expert-library/state
 */

import { createHash, randomUUID } from 'node:crypto'
import { isReportBundle, isReportCraftBinding, REPORT_BUNDLE_GUIDANCE } from './report-bundle.ts'
import { readFileSync } from 'node:fs'
import { link, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { restoreCapabilityScope, restoreCapabilityScopeWithReport } from './capability-scope.ts'
import { isQualityRun } from './quality-run.ts'
import type { TaskArtifact, TaskArtifactRef, TaskProject, TaskStatus, TeamMember, TeamMessage, TeamState, TeamTask } from './types.ts'
import { TERMINAL_TASK_STATUSES } from './types.ts'
import { isSharedTaskContext } from './shared-task-context.ts'
import { taskRepairFeedback } from './repair-feedback.ts'

/** Mailbox key of the captain. */
export const CAPTAIN_KEY = 'captain'
/** A crashed live-delivery attempt becomes retryable after this interval. */
export const MAILBOX_DELIVERY_LEASE_MS = 60_000
/** Durable deny-list for Expert Teams members that must never be resumed. */
const RETIRED_MEMBERS_FILE = 'retired-members.json'

/** In-process per-team mutation queues (promise chains). */
const locks = new Map<string, Promise<unknown>>()

/** Cross-process team lock settings. Unlike mailbox locks, timeout is fatal: a
 * team mutation must never continue with a stale read-modify-write snapshot. */
const TEAM_LOCK_TIMEOUT_MS = 120_000
const TEAM_LOCK_POLL_MS = 25
/** Only actual orphan recovery creates claims: at most eight per orphan identity. */
const TEAM_LOCK_RECOVERY_GENERATIONS = 8
const ownedRecoveryClaims = new Set<string>()

interface TeamFileLock {
  path: string
  content: string
  dev: number
  ino: number
}

async function readLockIdentity(path: string): Promise<TeamFileLock | undefined> {
  let handle
  try {
    handle = await open(path, 'r')
    const content = await handle.readFile('utf8')
    const held = await handle.stat()
    const current = await stat(path)
    if (held.dev !== current.dev || held.ino !== current.ino) return undefined
    return { path, content, dev: held.dev, ino: held.ino }
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function sameLock(a: TeamFileLock, b: TeamFileLock | undefined): boolean {
  return b !== undefined && a.dev === b.dev && a.ino === b.ino && a.content === b.content
}

/** Only ESRCH for an exact positive PID proves an owner dead. EPERM fails closed. */
function lockOwnerDead(lock: TeamFileLock): boolean {
  const first = lock.content.split('\n', 1)[0] ?? ''
  let owner: number
  if (/^[1-9]\d*$/.test(first)) owner = Number(first)
  else {
    // Older staged-plan locks used JSON. Keep their path and honor their
    // actual owner while migrating to the same bounded locking protocol.
    try {
      const legacy = JSON.parse(lock.content) as { pid?: unknown } | null
      if (legacy === null || typeof legacy !== 'object' || typeof legacy.pid !== 'number') return false
      owner = legacy.pid
    } catch { return false }
  }
  if (!Number.isSafeInteger(owner) || owner <= 0) return false
  try { process.kill(owner, 0); return false } catch (error: unknown) {
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/**
 * Elect one reaper for the exact orphan inode and contents. Publishing a fully
 * written claim through hard-link creation is atomic, so a competing reaper
 * never observes an empty claim-in-construction. Claims survive as small audit
 * records; normal acquisition creates none. If a reaper also crashes, the next
 * election includes its claim identity, up to eight generations per orphan.
 * A live/unknown reaper is never displaced. This serializes cooperating reapers
 * across processes; arbitrary external lock-file replacement is unsupported.
 */
async function electedOrphanReaper(orphan: TeamFileLock): Promise<boolean> {
  const directory = join(orphan.path, '..', '.recovery')
  await mkdir(directory, { recursive: true })
  let identity = JSON.stringify([orphan.dev, orphan.ino, orphan.content])
  for (let generation = 0; generation < TEAM_LOCK_RECOVERY_GENERATIONS; generation++) {
    const digest = createHash('sha256').update(identity).digest('hex')
    const claimPath = join(directory, `${digest}.claim`)
    if (ownedRecoveryClaims.has(claimPath)) return true
    const temporary = join(directory, `${process.pid}-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${process.pid}\n${Date.now()}\n${randomUUID()}\n`, { flag: 'wx' })
      try {
        await link(temporary, claimPath)
        ownedRecoveryClaims.add(claimPath)
        return true
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST')) throw error
      }
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    const previous = await readLockIdentity(claimPath)
    if (previous === undefined || !lockOwnerDead(previous)) return false
    identity += JSON.stringify([previous.dev, previous.ino, previous.content])
  }
  throw new Error('TEAM_LOCK_RECOVERY_EXHAUSTED: eight orphan-reaper generations require operator inspection')
}

async function releaseOwnedTeamFileLock(lock: TeamFileLock): Promise<void> {
  if (sameLock(lock, await readLockIdentity(lock.path))) await removeLockFile(lock.path)
}

async function removeLockFile(path: string): Promise<void> {
  try { await unlink(path) } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error
  }
}

function teamLockPath(key: string): string | undefined {
  if (key.startsWith('staged-plan:')) {
    const value = key.slice('staged-plan:'.length)
    const separator = value.lastIndexOf(':')
    if (separator <= 0) throw new Error('invalid staged-plan lock key')
    const planId = value.slice(separator + 1)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(planId)) throw new Error('invalid staged-plan lock id')
    return join(value.slice(0, separator), 'plans', `${planId}.lock`)
  }
  if (!key.startsWith('team:')) return undefined
  const value = key.slice('team:'.length)
  const separator = value.lastIndexOf(':')
  if (separator <= 0 || separator === value.length - 1) return undefined
  const stateRoot = value.slice(0, separator)
  const teamId = sanitizeKey(value.slice(separator + 1))
  // Keep locks outside the team directory: archive/remove may rename that
  // directory while the mutation lock is still held. A sibling lock remains
  // stable across the rename and prevents a concurrent recreate from racing
  // the archival operation.
  return join(stateRoot, '.locks', `${teamId}.lock`)
}

async function acquireTeamFileLock(key: string): Promise<TeamFileLock | undefined> {
  const lockFile = teamLockPath(key)
  if (lockFile === undefined) return undefined
  await mkdir(join(lockFile, '..'), { recursive: true })
  const deadline = Date.now() + TEAM_LOCK_TIMEOUT_MS
  while (true) {
    if (Date.now() >= deadline) throw new Error(`TEAM_LOCK_TIMEOUT: timed out waiting for ${key}`)
    try {
      const handle = await open(lockFile, 'wx')
      try {
        const content = `${process.pid}\n${Date.now()}\n${randomUUID()}\n`
        await handle.writeFile(content, 'utf8')
        const identity = await handle.stat()
        return { path: lockFile, content, dev: identity.dev, ino: identity.ino }
      } finally {
        await handle.close().catch(() => undefined)
      }
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST')) throw error
      try {
        const orphan = await readLockIdentity(lockFile)
        if (orphan === undefined) continue
        if (lockOwnerDead(orphan) && await electedOrphanReaper(orphan)) {
          // Only the elected reaper removes this exact orphan. Re-read both
          // inode and nonce/content before removal to reject a replacement.
          if (sameLock(orphan, await readLockIdentity(lockFile)) && lockOwnerDead(orphan)) {
            await removeLockFile(lockFile)
          }
          continue
        }
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      await sleep(TEAM_LOCK_POLL_MS)
    }
  }
}

/**
 * Serialize mutations of one team across the process and DSH workers. Team
 * keys additionally acquire a durable sibling lock file; non-team scopes
 * retain the in-process queue used by retired-member and staged-plan helpers.
 * @param key - the team id (or any mutation scope).
 * @param fn - the mutation to run exclusively.
 * @returns the mutation's result.
 */
export async function withTeamLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.then(() => gate)
  locks.set(key, tail)
  await previous
  let durable: TeamFileLock | undefined
  try {
    durable = await acquireTeamFileLock(key)
    return await fn()
  } finally {
    try {
      if (durable !== undefined) await releaseOwnedTeamFileLock(durable)
    } finally {
      release()
      if (locks.get(key) === tail) locks.delete(key)
    }
  }
}

/** Longest key emitted before truncating and appending a digest. */
const MAX_KEY_LENGTH = 48

/** Short stable digest, used to keep otherwise-colliding keys distinct. */
function keyDigest(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 8)
}

/**
 * Fold a free-form name into a safe path/key segment.
 *
 * Unicode letters and digits survive, so CJK/Cyrillic/Greek names stay
 * distinct and readable; everything else — spaces, punctuation, path
 * separators, control characters — folds to `-`. An ASCII-only whitelist
 * mapped *every* non-Latin name onto one shared fallback, which silently
 * merged their mailboxes and rejected the second such member as a duplicate.
 *
 * A name with no letters or digits at all (pure emoji or punctuation) cannot
 * yield a readable key, so it gets a digest rather than a shared constant.
 * Over-long names are truncated with a digest appended, so names sharing a
 * long prefix stay distinct and the result stays within filesystem limits
 * (CJK costs 3 bytes per character in UTF-8).
 *
 * @param name - any user-supplied name.
 * @returns a non-empty key safe as a single path segment.
 */
export function sanitizeKey(name: string): string {
  const cleaned = name.normalize('NFC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  if (cleaned === '') return `k-${keyDigest(name)}`
  const points = [...cleaned]
  if (points.length > MAX_KEY_LENGTH) {
    return `${points.slice(0, MAX_KEY_LENGTH).join('')}-${keyDigest(name)}`
  }
  return cleaned
}

/**
 * Whether `dependencies` are all satisfied (every named task exists and
 * completed) for the given task list.
 * @param tasks - the team's tasks.
 * @param dependencies - task ids the candidate depends on.
 * @returns the ids that are still unsatisfied, empty when claimable.
 */
export function unsatisfiedDependencies(tasks: TeamTask[], dependencies: string[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  return dependencies.filter((id) => byId.get(id)?.status !== 'completed')
}

/**
 * The allowed task status transitions, keyed by current status.
 * Terminal statuses have no outgoing transitions.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['claimed', 'cancelled'],
  claimed: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

/**
 * Validate one task status transition.
 * @param current - the task's current status.
 * @param next - the requested status.
 * @returns the transition error, or undefined when allowed.
 */
export function transitionError(current: TaskStatus, next: TaskStatus): string | undefined {
  if (current === next) return undefined
  if (!TASK_TRANSITIONS[current].includes(next)) {
    return `task status cannot move from "${current}" to "${next}"`
  }
  return undefined
}

/** Guard all explicit task mutations as well as scheduler dispatch. */
export function assertTeamRunnable(team: TeamState): void {
  if (team.halted === true) {
    throw new Error(`TEAM_HALTED: team "${team.name}" is halted${team.haltReason === undefined ? '' : ` (${team.haltReason})`}; resume explicitly before mutating tasks`)
  }
}

/** Activate the task's current generation for one owner and return its capability id. */
export function activateTaskAttempt(task: TeamTask, assignee: string): string {
  const attemptId = randomUUID()
  task.status = 'claimed'
  task.assignee = assignee
  task.attemptId = attemptId
  task.finalizedAttemptId = undefined
  task.handoffId = undefined
  task.reassigning = false
  task.output = undefined
  task.executionState = 'active'
  task.runtimeBlock = undefined
  task.waitReason = undefined
  task.dispatch = undefined
  task.updatedAt = Date.now()
  return attemptId
}

/** Start a fresh task generation for one owner. */
export function beginTaskAttempt(task: TeamTask, assignee: string): string {
  task.attempt = (task.attempt ?? 0) + 1
  return activateTaskAttempt(task, assignee)
}

/**
 * Clear the live capability once a task becomes terminal (completed/failed/
 * cancelled). The attempt COUNTER is kept for audit and retry-budget
 * accounting, but a lingering `attemptId` on a terminal record would make
 * stale-claim checks and audit views mistake dead work for a live claim —
 * exactly the residue observed on the 圆桌 team (attempts 5738/5688/5442
 * with attemptId still set). Reassignment of failed/cancelled work opens a
 * fresh generation anyway, so nothing is lost.
 */
export function finalizeTerminalTask(task: TeamTask): void {
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    // Keep the just-retired capability as a bounded provenance token. A worker
    // can have emitted a completion message before this commit; clearing the
    // only token made that legitimate message indistinguishable from a forged
    // message and caused it to be discarded as `missing_attempt`.
    task.finalizedAttemptId = task.attemptId
    task.attemptId = undefined
    task.reassigning = false
    task.executionState = undefined
    task.runtimeBlock = undefined
    task.waitReason = undefined
    task.dispatch = undefined
    task.updatedAt = Date.now()
  }
}

/**
 * Revoke the current worker immediately. Clearing its capability makes old
 * updates stale; a separate handoff generation serializes async quiescence.
 */
export function invalidateTaskAttempt(
  task: TeamTask,
  nextAssignee?: string,
  reassigning = false,
): void {
  task.attemptId = undefined
  task.finalizedAttemptId = undefined
  task.handoffId = randomUUID()
  task.status = 'pending'
  task.assignee = nextAssignee
  task.reassigning = reassigning
  task.output = undefined
  task.executionState = undefined
  task.runtimeBlock = undefined
  task.waitReason = undefined
  task.dispatch = undefined
  task.updatedAt = Date.now()
}

/**
 * Create the team directory structure and the initial team record.
 * @param stateRoot - resolved absolute state root directory.
 * @param state - the initial team record.
 */
/** Create the isolated project for one task. */
export async function createTaskProject(
  stateRoot: string,
  teamId: string,
  task: Pick<TeamTask, 'id' | 'subject' | 'description' | 'dependencies' | 'createdAt' | 'inputArtifacts'>,
): Promise<TaskProject> {
  const relative = join('expert-tasks', sanitizeKey(task.id))
  const dir = join(stateRoot, teamId, relative)
  const project: TaskProject = { path: relative, inputPath: join(relative, 'input', 'task.json'), outputPath: join(relative, 'output', 'result.json'), artifactsPath: join(relative, 'artifacts'), version: 1 }
  await mkdir(join(dir, 'input'), { recursive: true })
  await mkdir(join(dir, 'output'), { recursive: true })
  await mkdir(join(dir, 'artifacts'), { recursive: true })
  await atomicWriteText(join(dir, 'project.json'), JSON.stringify({ ...project, taskId: task.id, status: 'pending', updatedAt: Date.now() }, null, 2))
  await atomicWriteText(join(stateRoot, teamId, project.inputPath), JSON.stringify({ taskId: task.id, subject: task.subject, description: task.description, dependencies: task.dependencies, inputArtifacts: task.inputArtifacts, createdAt: task.createdAt }, null, 2))
  return project
}

/** Refresh the durable handoff before any first, repair or recovered dispatch.
 * The project is addressed from its real workspace, not an assumed child cwd. */
export function taskInputWarnings(task: TeamTask): string[] {
  return [
    ...(task.inputArtifactBinding?.reviewDisabled === true && task.dependencies.length > 0
      ? [`Quality review is explicitly disabled by the team policy. Dependencies ${task.dependencies.join(', ')} were not automatically pinned as reviewed versions. This workflow has no reviewed-version guarantee; explicitly declared input_artifacts still require dependency, publication and hash validation.`] : []),
    ...(task.inputArtifactBinding?.legacyUnpinnedSources ?? []).map(id =>
      `Legacy manually reviewed dependency ${id} has no immutable publication pin. Its recorded review evidence is retained under the existing workflow; current working files are not guaranteed to be that reviewed version. Do not claim a version-fixed handoff; use a new task with published, pinned inputs when that guarantee is required.`),
  ]
}

export async function syncTaskProjectInput(stateRoot: string, team: TeamState, task: TeamTask): Promise<void> {
  if (task.project === undefined) return
  const root = resolve(stateRoot, team.id)
  const run = team.qualityRuns?.[task.id] ?? (team.qualityRun?.contract.taskId === task.id ? team.qualityRun : undefined)
  await atomicWriteText(join(root, task.project.inputPath), JSON.stringify({
    taskId: task.id, subject: task.subject, description: task.description,
    dependencies: task.dependencies, inputArtifacts: task.inputArtifacts, createdAt: task.createdAt,
    inputArtifactBinding: task.inputArtifactBinding, inputArtifactManifest: task.inputArtifactManifest,
    inputArtifactWarnings: taskInputWarnings(task),
    attempt: task.attempt, attemptId: task.attemptId,
    project: { path: resolve(root, task.project.path), inputPath: resolve(root, task.project.inputPath),
      outputPath: resolve(root, task.project.outputPath), artifactsPath: resolve(root, task.project.artifactsPath) },
    sharedTaskContext: team.sharedTaskContext,
    taskProtocol: team.taskProtocol,
    acceptance: run?.contract.acceptance,
    repairFeedback: taskRepairFeedback(team, task),
    craftDeliveries: task.craftDeliveries,
    reportBundle: task.reportBundle, revisesTaskId: task.revisesTaskId,
    frozenSkillCraftContract: task.frozenSkillCraftContract,
    artifactChecks: run?.contract.artifactChecks,
    ...(task.reportBundle === undefined ? {} : { reportCheckGuidance: REPORT_BUNDLE_GUIDANCE, requiredPublications: run?.contract.deliverables.filter(id => id.startsWith('published:')) }),
  }, null, 2))
}

/** Publish an artifact into the task Project and update its manifest. */
export async function publishTaskArtifact(
  stateRoot: string,
  team: TeamState,
  task: TeamTask,
  input: { name: string; content: string | Uint8Array; mediaType?: string; description?: string },
): Promise<TaskArtifact> {
  if (task.project === undefined) throw new Error('task has no Project; legacy tasks cannot publish artifacts')
  const safeName = input.name.trim().replace(/[^a-zA-Z0-9._-]/g, '-')
  if (safeName === '' || safeName === '.' || safeName === '..' || safeName.includes('..')) throw new Error('invalid artifact name')
  const cleanPath = (path: string): boolean => !isAbsolute(path) && !/^[A-Za-z]:/.test(path)
    && !path.includes('\0') && path.replaceAll('\\', '/').split('/').every(part => part !== '' && part !== '.' && part !== '..')
  if (!cleanPath(team.id) || team.id.includes('/') || team.id.includes('\\')
    || !cleanPath(task.project.path) || !cleanPath(task.project.artifactsPath)) throw new Error('unsafe artifact project path')
  const root = await realpath(resolve(stateRoot))
  const project = await realpath(join(root, team.id, task.project.path))
  const dir = await realpath(join(root, team.id, task.project.artifactsPath))
  const rootRelative = relative(root, project)
  const projectRelative = relative(project, dir)
  if (rootRelative === '..' || rootRelative.startsWith(`..${sep}`) || isAbsolute(rootRelative)
    || projectRelative === '' || projectRelative === '..' || projectRelative.startsWith(`..${sep}`) || isAbsolute(projectRelative)) throw new Error('artifact project symlink escapes its allowed directory')
  const bytes = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : Buffer.from(input.content)
  const id = randomUUID()
  const versionDir = `attempt-${task.attempt ?? 0}-${id}`
  const artifact: TaskArtifact = { id, reviewId: `published:${safeName}`, taskId: task.id, attempt: task.attempt ?? 0, relativePath: `${versionDir}/${safeName}`, ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }), ...(input.description === undefined ? {} : { description: input.description }), sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength, createdAt: Date.now() }
  // New publication identities always own new paths. A failed team commit may
  // leave an unreferenced version, but cannot overwrite an already pinned one.
  await mkdir(join(dir, versionDir))
  await writeFile(join(dir, artifact.relativePath), bytes, { flag: 'wx' })
  await atomicWriteText(join(dir, 'manifest.json'), JSON.stringify([...(task.publishedArtifacts ?? []), artifact], null, 2))
  return artifact
}

/** Validate an artifact reference against dependency and publication allowlists. */
export function resolveAllowedArtifact(team: TeamState, task: TeamTask, ref: TaskArtifactRef): { source: TeamTask; artifact: TaskArtifact } {
  if (!(task.dependencies ?? []).includes(ref.sourceTaskId)) throw new Error(`artifact source task "${ref.sourceTaskId}" is not a dependency of "${task.id}"`)
  if (!(task.inputArtifacts ?? []).some(candidate => candidate.artifactId === ref.artifactId && candidate.sourceTaskId === ref.sourceTaskId)) throw new Error(`artifact "${ref.artifactId}" was not explicitly allowlisted for task "${task.id}"`)
  const source = team.tasks.find(candidate => candidate.id === ref.sourceTaskId)
  if (source === undefined || source.status !== 'completed') throw new Error(`source task "${ref.sourceTaskId}" is not completed`)
  const matches = source.publishedArtifacts?.filter(candidate => candidate.id === ref.artifactId) ?? []
  const artifact = matches[0]
  if (artifact === undefined) throw new Error(`artifact "${ref.artifactId}" is not published by source task "${ref.sourceTaskId}"`)
  if (matches.length !== 1 || artifact.taskId !== source.id) throw new Error(`artifact "${ref.artifactId}" has an ambiguous publication identity`)
  const path = artifact.relativePath.replaceAll('\\', '/')
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes('\0')
    || path.split('/').some(part => part === '' || part === '.' || part === '..')
    || (artifact.reviewId !== undefined && !/^published:[a-zA-Z0-9._-]+$/.test(artifact.reviewId))
    || !/^[a-f0-9]{64}$/i.test(artifact.sha256)
    || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) throw new Error(`artifact "${ref.artifactId}" has an invalid manifest`)
  return { source, artifact }
}


/** Read an allowlisted artifact and verify its manifest hash. */
export async function readAllowedTaskArtifact(stateRoot: string, team: TeamState, task: TeamTask, ref: TaskArtifactRef): Promise<{ artifact: TaskArtifact; content: string; encoding?: 'base64' }> {
  const resolved = resolveAllowedArtifact(team, task, ref)
  if (resolved.source.project === undefined) throw new Error('source task has no Project')
  const cleanPath = (path: string): boolean => !isAbsolute(path) && !/^[A-Za-z]:/.test(path)
    && !path.includes('\0') && path.replaceAll('\\', '/').split('/').every(part => part !== '' && part !== '.' && part !== '..')
  if (!cleanPath(team.id) || team.id.includes('/') || team.id.includes('\\')
    || !cleanPath(resolved.source.project.path) || !cleanPath(resolved.source.project.artifactsPath)) throw new Error('unsafe artifact project path')
  const root = await realpath(resolve(stateRoot))
  const project = await realpath(join(root, team.id, resolved.source.project.path))
  const dir = await realpath(join(root, team.id, resolved.source.project.artifactsPath))
  const path = await realpath(join(dir, resolved.artifact.relativePath.replaceAll('\\', '/')))
  for (const [base, candidate] of [[root, project], [project, dir], [dir, path]] as const) {
    const rel = relative(base, candidate)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('artifact path or symlink escapes its allowed directory')
  }
  if (task.inputArtifactManifest !== undefined) {
    const fixed = task.inputArtifactManifest.filter(item => item.sourceTaskId === ref.sourceTaskId && item.artifactId === ref.artifactId)
    const entry = fixed[0]
    if (fixed.length !== 1 || entry === undefined || entry.attempt !== resolved.artifact.attempt
      || entry.sha256 !== resolved.artifact.sha256 || entry.reviewArtifactId !== resolved.artifact.reviewId || entry.versionPath !== path) {
      throw new Error(`INPUT_VERSION_CHANGED: artifact ${ref.artifactId} differs from the consumer's fixed publication manifest`)
    }
  }
  if (!(await stat(path)).isFile()) throw new Error('artifact is not a regular file')
  const bytes = await readFile(path)
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (hash !== resolved.artifact.sha256 || bytes.byteLength !== resolved.artifact.sizeBytes) throw new Error(`artifact ${resolved.artifact.id} hash mismatch`)
  const content = bytes.toString('utf8')
  return Buffer.from(content, 'utf8').equals(bytes)
    ? { artifact: resolved.artifact, content }
    : { artifact: resolved.artifact, content: bytes.toString('base64'), encoding: 'base64' }
}
/** Update the isolated project output and status without replacing team state. */
export async function writeTaskProjectOutput(
  stateRoot: string,
  teamId: string,
  task: TeamTask,
): Promise<void> {
  if (task.project === undefined) return
  const teamDir = join(stateRoot, teamId)
  // The quality fields are ALWAYS written (qualityScore: null, repairCount: 0
  // when the task/team has no quality policy): forced recovery — the record
  // must carry the fields even when the member's output never mentions them.
  await atomicWriteText(join(teamDir, task.project.outputPath), JSON.stringify({
    taskId: task.id,
    status: task.status,
    attempt: task.attempt ?? 0,
    output: task.output,
    executionState: task.executionState,
    waitReason: task.waitReason,
    qualityScore: task.qualityScore ?? null,
    repairCount: task.repairCount ?? 0,
    updatedAt: task.updatedAt,
  }, null, 2))
  await atomicWriteText(join(teamDir, task.project.path, 'project.json'), JSON.stringify({ ...task.project, taskId: task.id, status: task.status, updatedAt: task.updatedAt }, null, 2))
}

/** Injectable write operations of {@link commitTaskUpdate}; defaults write real files. */
export interface TaskCommitPrimitives {
  /** Writes one task's project output files (default: {@link writeTaskProjectOutput}). */
  readonly writeProject?: (task: TeamTask) => Promise<void>
  /** Persists the team record (default: {@link writeTeam}). */
  readonly writeTeamRecord?: () => Promise<void>
}

/**
 * In-process compensating transaction for one task mutation: write the task's
 * project output first, then commit the team record. When the team write
 * fails, the project files are restored from the pre-update snapshot so the
 * durable record never claims an output the project does not hold; a failure
 * while restoring surfaces as an {@link AggregateError} alongside the
 * original error.
 *
 * This is a best-effort in-process compensation, not a crash-safe protocol:
 * a process death between the project write and the team write can leave a
 * written-but-uncommitted project output (harmless in practice — the team
 * record stays authoritative until it is successfully written). Closing that
 * window requires a write-ahead journal of task commits, planned for a later
 * phase; do not widen this helper beyond compensation.
 */
export async function commitTaskUpdate(
  stateRoot: string,
  team: TeamState,
  task: TeamTask,
  snapshot: TeamTask,
  primitives: TaskCommitPrimitives = {},
): Promise<void> {
  const writeProject = primitives.writeProject ?? ((current: TeamTask) => writeTaskProjectOutput(stateRoot, team.id, current))
  const writeTeamRecord = primitives.writeTeamRecord ?? (() => writeTeam(stateRoot, team))
  await writeProject(task)
  try {
    await writeTeamRecord()
  } catch (error: unknown) {
    try {
      await writeProject(snapshot)
    } catch (restoreError: unknown) {
      throw new AggregateError(
        [error, restoreError],
        `task ${task.id} commit failed and the project rollback failed too; the team record was not committed`,
      )
    }
    throw error
  }
}

export async function createTeamDir(stateRoot: string, state: TeamState): Promise<void> {
  const dir = join(stateRoot, state.id)
  await mkdir(join(dir, 'inbox'), { recursive: true })
  await atomicWriteText(join(dir, 'team.json'), JSON.stringify(state, null, 2))
}

/** Normalize legacy/partial A5 scopes at every read boundary. Validation must
 * not merely inspect a partial object and then hand that same object to the
 * provider gate: missing allowlists would otherwise become undefined and
 * either throw or bypass the intended deny-all defaults. */
function normalizeMemberScopes(state: TeamState): void {
  for (const member of state.members) {
    if (member.capabilityScope === undefined) continue
    const restored = restoreCapabilityScopeWithReport(member.capabilityScope, {
      expertId: member.name,
      role: member.role ?? 'member',
    })
    member.capabilityScope = restored.scope
  }
}

/**
 * Read one team record; `undefined` when absent.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team's sanitized id.
 */
export async function readTeam(stateRoot: string, teamId: string): Promise<TeamState | undefined> {
  try {
    const raw = await readFile(join(stateRoot, teamId, 'team.json'), 'utf8')
    const value: unknown = JSON.parse(stripLeadingBom(raw))
    if (!isTeamState(value, teamId)) {
      throw new Error(`invalid Expert Teams state in team "${teamId}"`)
    }
    normalizeMemberScopes(value)
    return value
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/**
 * Synchronously read one team record while a continuable child is being
 * composed. Harness requires child setup contributions to be synchronous;
 * this narrow boundary lets a cold-resumed member restore its durable model
 * selection before its first request can be published.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team's sanitized id.
 * @returns the team record, or `undefined` when absent.
 */
export function readTeamSync(stateRoot: string, teamId: string): TeamState | undefined {
  try {
    const raw = readFileSync(join(stateRoot, teamId, 'team.json'), 'utf8')
    const value: unknown = JSON.parse(stripLeadingBom(raw))
    if (!isTeamState(value, teamId)) {
      throw new Error(`invalid Expert Teams state in team "${teamId}"`)
    }
    normalizeMemberScopes(value)
    return value
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/**
 * Persist one team record (inside the caller's lock).
 * @param stateRoot - resolved absolute state root directory.
 * @param state - the record to persist.
 */
export async function writeTeam(stateRoot: string, state: TeamState): Promise<void> {
  await atomicWriteText(join(stateRoot, state.id, 'team.json'), JSON.stringify(state, null, 2))
}

/** Explicitly pause a team. This is durable and cannot be cleared by a
 * scheduler kick or ordinary task creation. */
export async function haltTeam(stateRoot: string, teamId: string, reason: string): Promise<TeamState> {
  return withTeamLock(`team:${stateRoot}:${teamId}`, async () => {
    const team = await readTeam(stateRoot, teamId)
    if (team === undefined) throw new Error(`team "${teamId}" was not found`)
    const trimmed = reason.trim()
    if (trimmed === '') throw new Error('halt reason must not be empty')
    team.halted = true
    team.haltReason = trimmed
    team.haltedAt = Date.now()
    await writeTeam(stateRoot, team)
    return team
  })
}

/** Explicitly resume a halted team. A reason is required for auditability. */
export async function resumeTeam(stateRoot: string, teamId: string, reason: string): Promise<TeamState> {
  return withTeamLock(`team:${stateRoot}:${teamId}`, async () => {
    const team = await readTeam(stateRoot, teamId)
    if (team === undefined) throw new Error(`team "${teamId}" was not found`)
    const trimmed = reason.trim()
    if (trimmed === '') throw new Error('resume reason must not be empty')
    team.halted = false
    team.resumedAt = Date.now()
    team.resumeReason = trimmed
    await writeTeam(stateRoot, team)
    return team
  })
}

/** Explicitly release one failed member route. Caller owns the team lock/write. */
export function resumeRuntimeMember(team: TeamState, sessionId: string, reason: string, expectedBlockId?: string): boolean {
  if (reason.trim() === '') throw new Error('runtime resume reason must not be empty')
  if (team.captainSessionId === sessionId) {
    const block = team.captainRuntimeBlock
    if (expectedBlockId !== undefined && block?.id !== expectedBlockId) throw new Error(`RUNTIME_BLOCK_STALE: no state changed. Current captain runtime_block.id=${JSON.stringify(block?.id ?? null)}. Copy the entire opaque ID, including every prefix; resume only after the cause has changed.`)
    if (block === undefined) return false
    team.captainRuntimeResolvedThroughTurn = Math.max(team.captainRuntimeResolvedThroughTurn ?? -1, block.turn)
    team.captainRuntimeBlock = undefined
    if (team.runtimeWaits !== undefined) delete team.runtimeWaits[sessionId]
    return true
  }
  const member = team.members.find(item => item.id === sessionId && item.status !== 'removed')
  if (member === undefined) throw new Error(`runtime member session ${sessionId} was not found`)
  if (expectedBlockId !== undefined && member.runtimeBlock?.id !== expectedBlockId) throw new Error(`RUNTIME_BLOCK_STALE: no state changed. Current member runtime_block.id=${JSON.stringify(member.runtimeBlock?.id ?? null)}. Copy the entire opaque ID, including every prefix; resume only after the cause has changed.`)
  const block = member.runtimeBlock
  if (block === undefined) return false
  member.runtimeResolvedThroughTurn = Math.max(member.runtimeResolvedThroughTurn ?? -1, block.turn)
  member.runtimeBlock = undefined
  member.activation = undefined
  member.runtimeResumedAt = Date.now()
  member.runtimeResumeReason = reason.trim()
  if (team.runtimeWaits !== undefined) delete team.runtimeWaits[sessionId]
  for (const task of team.tasks) {
    if (task.runtimeBlock?.id !== block.id || task.runtimeBlock.sessionId !== sessionId
      || task.runtimeBlock.attemptId !== task.attemptId || task.assignee !== member.name) continue
    task.runtimeBlock = undefined
    if (task.executionState === 'blocked_external' && task.waitReason?.startsWith('RUNTIME_')) {
      task.executionState = 'active'
      task.waitReason = undefined
      task.dispatch = undefined
    }
    task.updatedAt = Date.now()
  }
  return true
}

/**
 * Hot-path cache for the retired-member deny-list: the delivery guard reads it
 * on every queued prompt, so an unthrottled retry loop turns into an fs storm.
 * Short TTL; invalidated on write (recordRetiredMemberIds).
 */
const retiredIdsCache = new Map<string, { at: number; ids: Set<string> }>()
const RETIRED_IDS_CACHE_TTL_MS = 30_000

/** Read the durable set of member session ids retired by remove/delete. */
export async function readRetiredMemberIds(stateRoot: string): Promise<Set<string>> {
  const cached = retiredIdsCache.get(stateRoot)
  if (cached && Date.now() - cached.at < RETIRED_IDS_CACHE_TTL_MS) {
    return cached.ids
  }
  let ids: Set<string>
  try {
    const parsed: unknown = JSON.parse(stripLeadingBom(
      await readFile(join(stateRoot, RETIRED_MEMBERS_FILE), 'utf8'),
    ))
    if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string' || value === '')) {
      throw new Error('invalid Expert Teams retired member index')
    }
    ids = new Set(parsed)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      ids = new Set()
    } else {
      throw error
    }
  }
  retiredIdsCache.set(stateRoot, { at: Date.now(), ids })
  return ids
}

/** Atomically add session ids to the durable retired-member deny-list. */
export async function recordRetiredMemberIds(stateRoot: string, memberIds: readonly string[]): Promise<void> {
  const additions = memberIds.filter(id => id !== '')
  if (additions.length === 0) return
  await withTeamLock(`retired-members:${stateRoot}`, async () => {
    const retired = await readRetiredMemberIds(stateRoot)
    for (const id of additions) retired.add(id)
    await mkdir(stateRoot, { recursive: true })
    await atomicWriteText(
      join(stateRoot, RETIRED_MEMBERS_FILE),
      `${JSON.stringify([...retired].sort(), null, 2)}\n`,
    )
    retiredIdsCache.delete(stateRoot)
  })
}

/**
 * Find the team owned by one captain session (at most one per captain).
 * @param stateRoot - resolved absolute state root directory.
 * @param captainSessionId - the owning session id.
 * @returns the team record, or undefined when the captain leads no team.
 */
export async function findTeamByCaptain(
  stateRoot: string,
  captainSessionId: string,
): Promise<TeamState | undefined> {
  let entries
  try {
    entries = await readdir(stateRoot, { withFileTypes: true })
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
  let found: TeamState | undefined
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const team = await readTeam(stateRoot, entry.name)
    if (team?.captainSessionId === captainSessionId) {
      if (found !== undefined && found.id !== team.id) {
        throw new Error(`captain session leads multiple active teams ("${found.id}", "${team.id}"); archive one before continuing`)
      }
      found = team
    }
  }
  return found
}

/**
 * Find the team in which one session is an active participant.
 * Captains match `captainSessionId`; members match their durable child session
 * id. Removed members no longer have access to team-scoped tools.
 * @param stateRoot - resolved absolute state root directory.
 * @param agentSessionId - calling captain/member session id.
 * @returns the team record, or undefined when the caller belongs to no team.
 */
export async function findTeamByParticipant(
  stateRoot: string,
  agentSessionId: string,
): Promise<TeamState | undefined> {
  let entries
  try {
    entries = await readdir(stateRoot, { withFileTypes: true })
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
  let found: TeamState | undefined
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const team = await readTeam(stateRoot, entry.name)
    const participates = team?.captainSessionId === agentSessionId
      || team?.members.some((member) => member.id === agentSessionId && member.status !== 'removed') === true
    if (participates && team !== undefined) {
      if (found !== undefined && found.id !== team.id) {
        throw new Error(`agent session belongs to multiple active teams ("${found.id}", "${team.id}"); the target team is ambiguous`)
      }
      found = team
    }
  }
  return found
}

/** Find a durable team materialized from one staged plan during restart recovery. */
export async function findTeamByPlanId(
  stateRoot: string,
  planId: string,
): Promise<TeamState | undefined> {
  let entries
  try {
    entries = await readdir(stateRoot, { withFileTypes: true })
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'archive' || entry.name === 'plans') continue
    const team = await readTeam(stateRoot, entry.name)
    if (team?.planRef?.planId === planId) return team
  }
  return undefined
}

/** Build a fresh message record. */
export interface MessageProvenance {
  sourceTaskId?: string
  sourceAttemptId?: string
  sourceTaskStatus?: TeamTask['status']
  sequence?: number
  idempotencyKey?: string
}

/** Build a fresh message record. Provenance is additive for legacy callers. */
export function createMessage(
  from: string,
  to: string,
  content: string,
  provenance?: MessageProvenance,
): TeamMessage {
  return {
    id: randomUUID(),
    from,
    to,
    content,
    ts: Date.now(),
    ...(provenance?.sourceTaskId === undefined ? {} : { sourceTaskId: provenance.sourceTaskId }),
    ...(provenance?.sourceAttemptId === undefined ? {} : { sourceAttemptId: provenance.sourceAttemptId }),
    ...(provenance?.sourceTaskStatus === undefined ? {} : { sourceTaskStatus: provenance.sourceTaskStatus }),
    ...(provenance?.sequence === undefined ? {} : { sequence: provenance.sequence }),
    ...(provenance?.idempotencyKey === undefined ? {} : { idempotencyKey: provenance.idempotencyKey }),
  }
}

/** Result of checking a message against the currently active task generation. */
export type MessageAdmission =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: string }

/**
 * Check whether a message may be delivered to a live recipient. Messages
 * without provenance are legacy records and remain admissible. A sourced
 * message is tied to the task's current attempt; after retry/reassignment the
 * old attempt is rejected before it can wake a member or alter state. A
 * terminal task admits only the exact generation token retired at finalization
 * so a completion report already in flight is not mistaken for stale mail.
 */
export function admitTeamMessage(team: TeamState, message: TeamMessage): MessageAdmission {
  if (message.sourceTaskId === undefined) return { accepted: true }
  const task = team.tasks.find(candidate => candidate.id === message.sourceTaskId)
  if (task === undefined) return { accepted: false, reason: 'source_task_missing' }
  // A terminal task has no live capability, but a message emitted by its
  // final generation may still be waiting in the mailbox. Admit only the
  // exact capability retired at finalization; missing or older ids remain
  // rejected. The status recorded at emission may legitimately be the
  // pre-finalization status, so do not apply the live-status comparison here.
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    if (message.sourceAttemptId === undefined) return { accepted: false, reason: 'missing_attempt' }
    if (task.finalizedAttemptId === undefined || message.sourceAttemptId !== task.finalizedAttemptId) {
      return { accepted: false, reason: 'stale_attempt' }
    }
    return { accepted: true }
  }
  // Legacy sourced messages may omit the generation token. Preserve their
  // historical admission while rejecting any explicit stale token.
  if (message.sourceAttemptId !== undefined && task.attemptId !== message.sourceAttemptId) {
    return { accepted: false, reason: 'stale_attempt' }
  }
  if (message.sourceTaskStatus !== undefined && message.sourceTaskStatus !== task.status) {
    return { accepted: false, reason: 'stale_task_status' }
  }
  return { accepted: true }
}

/**
 * Append one message to an agent's mailbox (JSONL).
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @param agentKey - `captain` or a member name.
 * @param message - the message to append.
 */
/** A mailbox lock older than this is considered crashed and gets taken over. */
const MAILBOX_LOCK_STALE_MS = 30_000
/** Total time a mailbox mutation waits for the cross-process lock. */
const MAILBOX_LOCK_TIMEOUT_MS = 10_000
/** Backoff step while waiting for a held mailbox lock. */
const MAILBOX_LOCK_POLL_MS = 25

/**
 * Cross-process mutual exclusion for one mailbox file.
 *
 * The in-process `withTeamLock` queues cannot see another DSH process (or a
 * second worker) mutating the same JSONL, and both the append and the
 * claim/release/acknowledge mutations are read-modify-write — an interleave
 * silently loses whichever write lands first. This lock serializes the
 * file's readers-writers across processes with an O_EXCL lock file:
 *
 * - acquisition is `open(lock, 'wx')`, atomic on POSIX and Windows;
 * - a lock whose file is older than {@link MAILBOX_LOCK_STALE_MS} belonged to
 *   a crashed holder and is taken over (stale locks never wedge the mailbox);
 * - after {@link MAILBOX_LOCK_TIMEOUT_MS} the mutation fails closed. Continuing
 *   unlocked would permit concurrent read-modify-write calls to lose mail.
 */
async function withMailboxFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lockFile = `${file}.lock`
  const deadline = Date.now() + MAILBOX_LOCK_TIMEOUT_MS
  let locked = false
  while (!locked) {
    try {
      const handle = await open(lockFile, 'wx')
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`, 'utf8')
      await handle.close()
      locked = true
      break
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST')) {
        throw error
      }
      // Held by someone. Take over a stale (crashed-holder) lock, else wait.
      try {
        const stats = await stat(lockFile)
        if (Date.now() - stats.mtimeMs > MAILBOX_LOCK_STALE_MS) {
          await unlink(lockFile).catch(() => undefined)
          await sleep(MAILBOX_LOCK_POLL_MS)
          continue
        }
      } catch {
        // Lock vanished between open and stat — retry acquisition.
      }
      if (Date.now() >= deadline) break
      await sleep(MAILBOX_LOCK_POLL_MS)
    }
  }
  if (!locked) {
    throw new Error(`MAILBOX_LOCK_TIMEOUT: timed out waiting for ${file}`)
  }
  try {
    return await fn()
  } finally {
    await unlink(lockFile).catch(() => undefined)
  }
}

export async function appendMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  message: TeamMessage,
): Promise<TeamMessage> {
  const file = join(stateRoot, teamId, 'inbox', `${sanitizeKey(agentKey)}.jsonl`)
  await mkdir(join(stateRoot, teamId, 'inbox'), { recursive: true })
  return withMailboxFileLock(file, async () => {
    let existing = ''
    try {
      existing = await readFile(file, 'utf8')
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
        throw error
      }
    }
    const existingMessages: TeamMessage[] = []
    for (const rawLine of existing.split('\n')) {
      if (rawLine.trim() === '') continue
      try {
        const value: unknown = JSON.parse(stripLeadingBom(rawLine))
        if (isTeamMessage(value)) existingMessages.push(value)
      } catch {
        // Preserve malformed lines in the file; they remain visible to the
        // diagnostic reader but must not block a valid append.
      }
    }
    const duplicate = existingMessages.find(candidate => candidate.id === message.id
      || (message.idempotencyKey !== undefined
        && candidate.from === message.from
        && candidate.idempotencyKey === message.idempotencyKey))
    if (duplicate !== undefined) {
      if (duplicate.from !== message.from || duplicate.to !== message.to || duplicate.content !== message.content
        || duplicate.sourceTaskId !== message.sourceTaskId || duplicate.sourceAttemptId !== message.sourceAttemptId) {
        throw new Error(`MAILBOX_IDEMPOTENCY_CONFLICT: duplicate message key ${message.idempotencyKey ?? message.id}`)
      }
      return duplicate
    }
    const nextSequence = existingMessages
      .filter(candidate => candidate.from === message.from)
      .reduce((max, candidate) => Math.max(max, candidate.sequence ?? 0), 0) + 1
    if (message.sequence !== undefined && message.sequence !== nextSequence) {
      throw new Error(`MESSAGE_SEQUENCE_CONFLICT: expected ${nextSequence} for ${message.from}, got ${message.sequence}`)
    }
    const sequence = message.sequence ?? nextSequence
    const persisted: TeamMessage = { ...message, sequence }
    const separator = existing !== '' && !existing.endsWith('\n') ? '\n' : ''
    await atomicWriteText(file, `${existing}${separator}${JSON.stringify(persisted)}\n`)
    return persisted
  })
}

/**
 * Read one agent's whole mailbox, oldest first.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @param agentKey - `captain` or a member name.
 * @param onMalformedLine - optional diagnostic hook; malformed records are
 * skipped so one manually damaged line cannot make the whole team unreadable.
 * @returns the messages, empty when the mailbox does not exist yet.
 */
export async function readMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  onMalformedLine?: (lineNumber: number, error: unknown) => void,
): Promise<TeamMessage[]> {
  const file = join(stateRoot, teamId, 'inbox', `${sanitizeKey(agentKey)}.jsonl`)
  try {
    const raw = await readFile(file, 'utf8')
    const messages: TeamMessage[] = []
    for (const [index, rawLine] of raw.split('\n').entries()) {
      const line = stripLeadingBom(rawLine)
      if (line.trim() === '') continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        onMalformedLine?.(index + 1, new Error('invalid JSON'))
        continue
      }
      if (!isTeamMessage(value)) {
        onMalformedLine?.(index + 1, new Error('invalid message shape'))
        continue
      }
      messages.push(value)
    }
    return messages
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

/** Read only messages that have not been acknowledged by their recipient. */
export async function readUnreadMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  onMalformedLine?: (lineNumber: number, error: unknown) => void,
): Promise<TeamMessage[]> {
  const now = Date.now()
  return (await readMailbox(stateRoot, teamId, agentKey, onMalformedLine))
    .filter(message => message.readAt === undefined && message.discardedAt === undefined
      && (message.deliveryClaimedAt === undefined
        || now - message.deliveryClaimedAt >= MAILBOX_DELIVERY_LEASE_MS))
}

async function mutateMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
  mutate: (message: TeamMessage) => TeamMessage | Promise<TeamMessage>,
): Promise<void> {
  if (messageIds.length === 0) return
  const file = join(stateRoot, teamId, 'inbox', `${sanitizeKey(agentKey)}.jsonl`)
  await withMailboxFileLock(file, async () => {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const selected = new Set(messageIds)
    const lines: string[] = []
    for (const rawLine of raw.split('\n')) {
      const line = stripLeadingBom(rawLine)
      if (line.trim() === '') { lines.push(rawLine); continue }
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        lines.push(rawLine)
        continue
      }
      if (!isTeamMessage(value) || !selected.has(value.id)) { lines.push(rawLine); continue }
      lines.push(JSON.stringify(await mutate(value)))
    }
    await atomicWriteText(file, lines.join('\n'))
  })
}

/** Lease selected fallback messages to one delivery path. */
export async function claimMailboxDelivery(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
): Promise<string[]> {
  const now = Date.now()
  const claimed = new Set<string>()
  await mutateMailbox(stateRoot, teamId, agentKey, messageIds, message => ({
    ...message,
    ...(message.readAt !== undefined || message.discardedAt !== undefined
      ? {}
      : message.deliveryClaimedAt !== undefined && now - message.deliveryClaimedAt < MAILBOX_DELIVERY_LEASE_MS
        ? {}
        : (claimed.add(message.id), { deliveryClaimedAt: now })),
  }))
  return [...claimed]
}

/** Release a failed delivery lease so the scheduler can retry it later. */
export async function releaseMailboxDelivery(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, messageIds, (message) => {
    const { deliveryClaimedAt: _claimed, ...released } = message
    return released
  })
}

/**
 * Mark selected durable mailbox records delivered/read while preserving
 * malformed lines for diagnostics. Callers serialize this with the team lock.
 */
export async function acknowledgeMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
): Promise<void> {
  const now = Date.now()
  await mutateMailbox(stateRoot, teamId, agentKey, messageIds, async (message) => {
    // Revalidate provenance at the consumption boundary. A message can be
    // admitted and leased, then reassign can commit before the live prompt is
    // consumed; acknowledging it blindly would mark stale work delivered.
    if (message.sourceTaskId !== undefined) {
      const team = await readTeam(stateRoot, teamId)
      const admission = team === undefined
        ? { accepted: false as const, reason: 'team_missing' }
        : admitTeamMessage(team, message)
      if (!admission.accepted) {
        return {
          ...message,
          discardedAt: message.discardedAt ?? now,
          discardReason: message.discardReason ?? admission.reason,
          deliveredAt: message.deliveredAt ?? now,
          readAt: message.readAt ?? now,
          consumedAt: now,
        }
      }
    }
    const { deliveryClaimedAt: _claimed, ...rest } = message
    return {
      ...rest,
      deliveredAt: message.deliveredAt ?? now,
      readAt: message.readAt ?? now,
      consumedAt: now,
    }
  })
}

/** Mark stale or duplicate messages consumed without presenting them again. */
export async function discardMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
  reason: string,
): Promise<void> {
  const now = Date.now()
  await mutateMailbox(stateRoot, teamId, agentKey, messageIds, (message) => ({
    ...message,
    discardedAt: message.discardedAt ?? now,
    discardReason: message.discardReason ?? reason,
    readAt: message.readAt ?? now,
    deliveredAt: message.deliveredAt ?? now,
  }))
}

/** Remove the optional UTF-8 BOM some editors prepend to JSON text. */
function stripLeadingBom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value
}

/** Rename attempts before falling back to a direct overwrite. */
const ATOMIC_RENAME_RETRIES = 3
/** Pause between rename attempts, giving a briefly-locking owner time to finish. */
const ATOMIC_RENAME_RETRY_DELAY_MS = 50
/**
 * Rename error codes worth retrying before the direct-write fallback. On
 * Windows, replacing an existing file whose target is momentarily held open
 * without FILE_SHARE_DELETE surfaces as EPERM (or EACCES/EBUSY variants);
 * EEXIST/ENOTEMPTY cover other "target busy" edge shapes.
 */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY'])

function isRetryableRenameError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && RETRYABLE_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Filesystem primitives used by {@link replaceFileAtomicOrDirect}; injectable for tests. */
export interface AtomicReplacePrimitives {
  rename: (from: string, to: string) => Promise<void>
  writeFile: (file: string, content: string) => Promise<void>
  remove: (file: string) => Promise<void>
}

/** Tuning knobs for {@link replaceFileAtomicOrDirect} (defaults match production). */
export interface AtomicReplaceOptions {
  /** Rename attempts before the direct-write fallback (default 3). */
  retries?: number
  /** Delay between rename attempts in ms (default 50). */
  retryDelayMs?: number
}

/**
 * Replace `file` with `content`, preferring an atomic same-directory rename of
 * an already-written temp file.
 *
 * On Windows, `rename(tmp, file)` over an existing target throws EPERM while
 * any other process keeps the target open without FILE_SHARE_DELETE (editors,
 * indexers, antivirus scans, preview panes). By that point the payload has
 * already been fully written to the temp file, so a direct overwrite of the
 * target is a content-equivalent degraded path: retry the rename a few times
 * (transient locks clear quickly), then write the target in place. Every path
 * removes the temp file; when both the atomic rename and the direct write
 * fail, the combined error surfaces as an {@link AggregateError}.
 *
 * @returns nothing once the file has been replaced by one of the two paths.
 */
export async function replaceFileAtomicOrDirect(
  temporary: string,
  file: string,
  content: string,
  primitives: AtomicReplacePrimitives,
  options: AtomicReplaceOptions = {},
): Promise<void> {
  const retries = options.retries ?? ATOMIC_RENAME_RETRIES
  const retryDelayMs = options.retryDelayMs ?? ATOMIC_RENAME_RETRY_DELAY_MS
  for (let attempt = 0; ; attempt += 1) {
    try {
      await primitives.rename(temporary, file)
      return
    } catch (error: unknown) {
      if (isRetryableRenameError(error) && attempt < retries) {
        await sleep(retryDelayMs)
        continue
      }
      let fallbackError: unknown
      try {
        await primitives.writeFile(file, content)
      } catch (writeError: unknown) {
        fallbackError = writeError
      }
      await primitives.remove(temporary).catch(() => undefined)
      if (fallbackError !== undefined) {
        throw new AggregateError(
          [error, fallbackError],
          `failed to replace "${file}" atomically (${String(error)}) or by direct write (${String(fallbackError)})`,
        )
      }
      return
    }
  }
}

/**
 * Atomically replace one UTF-8 state file from a same-directory temp file,
 * degrading to a direct overwrite when the atomic rename cannot proceed
 * (see {@link replaceFileAtomicOrDirect} for the Windows EPERM rationale).
 */
async function atomicWriteText(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  await replaceFileAtomicOrDirect(temporary, file, content, {
    rename: (from, to) => rename(from, to),
    writeFile: (target, payload) => writeFile(target, payload, 'utf8'),
    remove: (path) => rm(path, { force: true }),
  })
}

/** Whether a parsed JSON value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is an optional string. */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

/** Whether a value is a finite timestamp/counter number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Validate one member record at the durable JSON boundary. */
function isRuntimeBlock(value: unknown): boolean {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['sessionId'] === 'string'
    && Number.isSafeInteger(value['turn']) && (value['turn'] as number) >= 0
    && typeof value['code'] === 'string' && typeof value['message'] === 'string' && isFiniteNumber(value['at'])
    && (value['status'] === undefined || Number.isSafeInteger(value['status'])) && isOptionalString(value['attemptId'])
}
function isRuntimeAttempts(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => isRecord(item)
    && typeof item['taskId'] === 'string' && typeof item['attemptId'] === 'string')
}
function isTeamMember(value: unknown): value is TeamMember {
  if (!isRecord(value)) return false
  const fallbackRoutesValid = value['fallbackRoutes'] === undefined || (
    Array.isArray(value['fallbackRoutes'])
    && value['fallbackRoutes'].every(route => isRecord(route)
      && typeof route['provider'] === 'string' && route['provider'].trim() !== ''
      && typeof route['model'] === 'string' && route['model'].trim() !== ''
      && isOptionalString(route['reasoningEffort']))
  )
  const scopeValid = value['capabilityScope'] === undefined || (() => {
    try {
      // Older team records have no scope. When a partial A5 snapshot is
      // encountered, restore it with the member identity and fail closed.
      restoreCapabilityScope(value['capabilityScope'], {
        expertId: typeof value['name'] === 'string' ? value['name'] : undefined,
        role: typeof value['role'] === 'string' ? value['role'] : 'member',
      })
      return true
    } catch {
      return false
    }
  })()
  return scopeValid
    && fallbackRoutesValid
    && typeof value['id'] === 'string'
    && typeof value['name'] === 'string'
    && value['name'].trim() !== ''
    && isOptionalString(value['role'])
    && isOptionalString(value['provider'])
    && isOptionalString(value['model'])
    && isOptionalString(value['reasoningEffort'])
    && isFiniteNumber(value['joinedAt'])
    && (value['runtimeBlock'] === undefined || isRuntimeBlock(value['runtimeBlock']))
    && (value['runtimeTurn'] === undefined || (isRecord(value['runtimeTurn'])
      && Number.isSafeInteger(value['runtimeTurn']['turn']) && isRuntimeAttempts(value['runtimeTurn']['taskAttempts'])))
    && (value['activation'] === undefined || (isRecord(value['activation'])
      && typeof value['activation']['id'] === 'string' && value['activation']['sessionId'] === value['id']
      && isFiniteNumber(value['activation']['reservedAt']) && isRuntimeAttempts(value['activation']['taskAttempts'])
      && (value['activation']['acceptedAt'] === undefined || isFiniteNumber(value['activation']['acceptedAt']))
      && (value['activation']['turn'] === undefined || Number.isSafeInteger(value['activation']['turn']))))
    && (value['status'] === 'idle' || value['status'] === 'working' || value['status'] === 'removed')
}

/** Validate one task record at the durable JSON boundary. */
function isTeamTask(value: unknown): value is TeamTask {
  if (!isRecord(value)) return false
  return typeof value['id'] === 'string'
    && typeof value['subject'] === 'string'
    && isOptionalString(value['description'])
    && (value['status'] === 'pending'
      || value['status'] === 'claimed'
      || value['status'] === 'in_progress'
      || value['status'] === 'completed'
      || value['status'] === 'failed'
      || value['status'] === 'cancelled')
    && isOptionalString(value['assignee'])
    && (value['reportBundle'] === undefined || isReportBundle(value['reportBundle']))
    && isReportCraftBinding(value['reportBundle'] as TeamTask['reportBundle'], value['frozenSkillCraftContract'])
    && (value['craftDeliveries'] === undefined || Array.isArray(value['craftDeliveries']) && value['craftDeliveries'].every(isCraftDeliveryReceipt))
    && (value['craftReviewPreparations'] === undefined || Array.isArray(value['craftReviewPreparations']) && value['craftReviewPreparations'].every(isCraftReviewPreparation))
    && isOptionalString(value['revisesTaskId'])
    && Array.isArray(value['dependencies'])
    && value['dependencies'].every((dependency) => typeof dependency === 'string')
    && isOptionalString(value['output'])
    && (value['inputArtifactBinding'] === undefined || (isRecord(value['inputArtifactBinding'])
      && value['inputArtifactBinding']['mode'] === 'dependency-default'
      && Number.isSafeInteger(value['inputArtifactBinding']['consumerAttempt']) && (value['inputArtifactBinding']['consumerAttempt'] as number) >= 1
      && Array.isArray(value['inputArtifacts'])
      && (value['inputArtifactBinding']['reviewDisabled'] === undefined || value['inputArtifactBinding']['reviewDisabled'] === true)
      && (value['inputArtifactBinding']['legacyUnpinnedSources'] === undefined || (Array.isArray(value['inputArtifactBinding']['legacyUnpinnedSources'])
        && value['inputArtifactBinding']['legacyUnpinnedSources'].every(id => typeof id === 'string')))))
    && (value['inputArtifactManifest'] === undefined || (Array.isArray(value['inputArtifactManifest'])
      && value['inputArtifactManifest'].every(item => isRecord(item) && typeof item['sourceTaskId'] === 'string'
        && typeof item['artifactId'] === 'string' && isOptionalString(item['reviewArtifactId'])
        && Number.isSafeInteger(item['attempt']) && (item['attempt'] as number) >= 0
        && typeof item['sha256'] === 'string' && /^[a-f0-9]{64}$/i.test(item['sha256'])
        && typeof item['versionPath'] === 'string' && isAbsolute(item['versionPath']))))
    && (value['executionState'] === undefined || ['active', 'awaiting_review', 'blocked_external', 'interrupted'].includes(value['executionState'] as string))
    && isOptionalString(value['waitReason'])
    && (value['runtimeBlock'] === undefined || isRuntimeBlock(value['runtimeBlock']))
    && (value['dispatch'] === undefined || (isRecord(value['dispatch'])
      && typeof value['dispatch']['attemptId'] === 'string'
      && typeof value['dispatch']['id'] === 'string'
      && isFiniteNumber(value['dispatch']['dispatchedAt'])
      && (value['dispatch']['acceptedAt'] === undefined || isFiniteNumber(value['dispatch']['acceptedAt']))
      && (value['dispatch']['nextRetryAt'] === undefined || isFiniteNumber(value['dispatch']['nextRetryAt']))
      && (value['dispatch']['failureCount'] === undefined || (Number.isSafeInteger(value['dispatch']['failureCount']) && (value['dispatch']['failureCount'] as number) >= 0))))
    && (value['attempt'] === undefined
      || (Number.isSafeInteger(value['attempt']) && (value['attempt'] as number) >= 0))
    && isOptionalString(value['attemptId'])
    && isOptionalString(value['finalizedAttemptId'])
    && isOptionalString(value['handoffId'])
    && (value['reassigning'] === undefined || typeof value['reassigning'] === 'boolean')
    && isFiniteNumber(value['createdAt'])
    && isFiniteNumber(value['updatedAt'])
}

/** Validate the full team record before it can participate in authorization. */
function isTeamState(value: unknown, expectedId: string): value is TeamState {
  if (!isRecord(value)) return false
  const validShape = value['id'] === expectedId
    && typeof value['name'] === 'string'
    && value['name'].trim() !== ''
    && isOptionalString(value['description'])
    && (value['sharedTaskContext'] === undefined || (isSharedTaskContext(value['sharedTaskContext'])
      && value['sharedTaskContext'].captainSessionId === value['captainSessionId']))
    && (value['taskProtocol'] === undefined || (Array.isArray(value['taskProtocol']) && value['taskProtocol'].every(item => typeof item === 'string')))
    && typeof value['captainSessionId'] === 'string'
    && value['captainSessionId'] !== ''
    && isOptionalString(value['scenarioId'])
    && isFiniteNumber(value['createdAt'])
    && Array.isArray(value['members'])
    && value['members'].every(isTeamMember)
    && Array.isArray(value['tasks'])
    && value['tasks'].every(isTeamTask)
    && Number.isSafeInteger(value['taskSeq'])
    && (value['taskSeq'] as number) >= 0
    && (value['halted'] === undefined || typeof value['halted'] === 'boolean')
    && (value['maxActiveMembers'] === undefined || (Number.isSafeInteger(value['maxActiveMembers']) && (value['maxActiveMembers'] as number) >= 1))
    && (value['captainRuntimeBlock'] === undefined || isRuntimeBlock(value['captainRuntimeBlock']))
    && (value['runtimeWaits'] === undefined || (isRecord(value['runtimeWaits']) && Object.values(value['runtimeWaits']).every(wait =>
      isRecord(wait) && typeof wait['reason'] === 'string' && isFiniteNumber(wait['since'])
      && Array.isArray(wait['taskIds']) && wait['taskIds'].every(id => typeof id === 'string'))))
    && (value['goalWaits'] === undefined || (isRecord(value['goalWaits']) && Object.values(value['goalWaits']).every(wait =>
      isRecord(wait) && typeof wait['goalId'] === 'string' && wait['goalId'] !== ''
      && Number.isSafeInteger(wait['pausedRevision']) && (wait['pausedRevision'] as number) >= 1
      && isFiniteNumber(wait['createdAt']))))
    && isOptionalString(value['haltReason'])
    && (value['haltedAt'] === undefined || isFiniteNumber(value['haltedAt']))
    && (value['resumedAt'] === undefined || isFiniteNumber(value['resumedAt']))
    && isOptionalString(value['resumeReason'])
    && (value['qualityRun'] === undefined || isQualityRun(value['qualityRun']))
    && (value['qualityRuns'] === undefined || (
      isRecord(value['qualityRuns']) && Object.values(value['qualityRuns']).every(isQualityRun)
    ))
    && (value['qualityRunHistory'] === undefined || (
      isRecord(value['qualityRunHistory']) && Object.values(value['qualityRunHistory']).every(history => Array.isArray(history) && history.every(isQualityRun))
    ))
    && (value['structuredQualityPolicy'] === undefined || (
      isRecord(value['structuredQualityPolicy'])
      && typeof value['structuredQualityPolicy']['required'] === 'boolean'
      && Number.isSafeInteger(value['structuredQualityPolicy']['maxRepairRounds'])
      && (value['structuredQualityPolicy']['maxRepairRounds'] as number) >= 0
      && (value['structuredQualityPolicy']['maxRepairRounds'] as number) <= 2
    ))
  if (!validShape) return false

  const members = value['members'] as TeamMember[]
  const tasks = value['tasks'] as TeamTask[]
  const memberIds = new Set<string>()
  const memberKeys = new Set<string>()
  for (const member of members) {
    const key = sanitizeKey(member.name)
    if (member.id === '' || key === CAPTAIN_KEY || memberIds.has(member.id) || memberKeys.has(key)) return false
    memberIds.add(member.id)
    memberKeys.add(key)
  }
  const taskIds = new Set<string>()
  for (const task of tasks) {
    if (task.id === '' || taskIds.has(task.id)) return false
    taskIds.add(task.id)
  }
  // Referential integrity: a durable record with dangling task dependencies,
  // a dependency cycle (which would block the scheduler forever), or a task
  // assigned to a member that does not exist must not participate in
  // authorization — fail the shape check so readTeam surfaces it loudly.
  const memberNames = new Set(members.map(member => member.name))
  const taskById = new Map(tasks.map(task => [task.id, task]))
  for (const task of tasks) {
    // `captain` (CAPTAIN_KEY) is a legal assignee: expert_teams_reassign_task
    // uses assignee="captain" for captain takeover, and beginTaskAttempt then
    // stamps CAPTAIN_KEY — it is never a member name, so exempt it here or a
    // takeover would corrupt the whole team record's validity.
    if (task.assignee !== undefined && task.assignee !== CAPTAIN_KEY && !memberNames.has(task.assignee)) return false
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency)) return false
    }
  }
  // Cycle detection (iterative DFS over the dependency edges).
  const visiting = new Set<string>()
  const done = new Set<string>()
  for (const root of taskIds) {
    if (done.has(root)) continue
    const stack: { id: string; expanded: boolean }[] = [{ id: root, expanded: false }]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (frame === undefined) continue
      if (!frame.expanded) {
        if (done.has(frame.id)) { stack.pop(); continue }
        if (visiting.has(frame.id)) return false
        visiting.add(frame.id)
        for (const dependency of taskById.get(frame.id)?.dependencies ?? []) {
          if (taskIds.has(dependency)) stack.push({ id: dependency, expanded: false })
        }
        frame.expanded = true
        continue
      }
      visiting.delete(frame.id)
      done.add(frame.id)
      stack.pop()
    }
  }
  return true
}

/** Validate a mailbox record so later rendering cannot crash on `{}`/`null`. */
function isTeamMessage(value: unknown): value is TeamMessage {
  if (!isRecord(value)) return false
  return typeof value['id'] === 'string'
    && typeof value['from'] === 'string'
    && typeof value['to'] === 'string'
    && typeof value['content'] === 'string'
    && isFiniteNumber(value['ts'])
    && (value['sourceTaskId'] === undefined || typeof value['sourceTaskId'] === 'string')
    && (value['sourceAttemptId'] === undefined || typeof value['sourceAttemptId'] === 'string')
    && (value['sourceTaskStatus'] === undefined || (typeof value['sourceTaskStatus'] === 'string' && (TERMINAL_TASK_STATUSES.includes(value['sourceTaskStatus'] as TaskStatus) || ['pending', 'claimed', 'in_progress'].includes(value['sourceTaskStatus'] as string))))
    && (value['sequence'] === undefined || (Number.isSafeInteger(value['sequence']) && (value['sequence'] as number) >= 1))
    && (value['idempotencyKey'] === undefined || typeof value['idempotencyKey'] === 'string')
    && (value['deliveryClaimedAt'] === undefined || isFiniteNumber(value['deliveryClaimedAt']))
    && (value['deliveredAt'] === undefined || isFiniteNumber(value['deliveredAt']))
    && (value['readAt'] === undefined || isFiniteNumber(value['readAt']))
    && (value['consumedAt'] === undefined || isFiniteNumber(value['consumedAt']))
    && (value['discardedAt'] === undefined || isFiniteNumber(value['discardedAt']))
    && (value['discardReason'] === undefined || typeof value['discardReason'] === 'string')
}

/**
 * Remove a team's whole directory (members should be interrupted first).
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 */
export async function removeTeamDir(stateRoot: string, teamId: string): Promise<void> {
  await rm(join(stateRoot, teamId), { recursive: true, force: true })
}

/**
 * `rename` with the same transient retry policy as the state-file atomic
 * write, for paths (like archiving a whole team directory) where there is no
 * content-equivalent direct-write degradation on Windows. A short-lived
 * delete-sharing lock on any file below the renamed path is retried a few
 * times before the error propagates.
 * @param from - source path.
 * @param to - destination path.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error: unknown) {
      if (isRetryableRenameError(error) && attempt < ATOMIC_RENAME_RETRIES) {
        await sleep(ATOMIC_RENAME_RETRY_DELAY_MS)
        continue
      }
      throw error
    }
  }
}

/**
 * Archive a team instead of deleting it: the whole directory (team.json with
 * tasks and dependency graph, plus the mailboxes) moves under
 * `<stateRoot>/archive/<teamId>/` so later sessions can review how tasks were
 * planned and rebuild dependency relationships. The archive directory has no
 * team.json of its own, so the live activity scan skips it naturally.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 */
export async function archiveTeamDir(stateRoot: string, teamId: string): Promise<void> {
  const archiveRoot = join(stateRoot, 'archive')
  await mkdir(archiveRoot, { recursive: true })
  const source = join(stateRoot, teamId)
  const target = join(archiveRoot, teamId)
  const previous = join(archiveRoot, `.${teamId}.previous-${randomUUID()}`)
  let displaced = false
  try {
    // The same Windows EPERM-on-rename applies at the directory boundary: a
    // delete-sharing violation on any file below `target` blocks the move, so
    // retry the transient-lock case before giving up.
    await renameWithRetry(target, previous)
    displaced = true
  } catch (error: unknown) {
    // Only ENOENT means there was nothing to displace; any other failure
    // (including a persistent EPERM lock) surfaces to the caller.
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw error
    }
  }

  try {
    await renameWithRetry(source, target)
  } catch (error: unknown) {
    if (displaced) {
      try {
        await renameWithRetry(previous, target)
      } catch (restoreError: unknown) {
        throw new AggregateError(
          [error, restoreError],
          `failed to archive team "${teamId}" and restore its previous archive`,
        )
      }
    }
    throw error
  }

  // The new generation is authoritative. A failed cleanup only leaves a
  // hidden recovery directory, which archive discovery deliberately ignores.
  if (displaced) await rm(previous, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Read one archived team (already moved under `archive/`), or undefined when
 * it was never archived.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 */
export async function readArchivedTeam(stateRoot: string, teamId: string): Promise<TeamState | undefined> {
  return readTeam(join(stateRoot, 'archive'), teamId)
}

/**
 * List every archived team id under the state root.
 * @param stateRoot - resolved absolute state root directory.
 * @returns the archived team ids, empty when the archive does not exist.
 */
export async function listArchivedTeamIds(stateRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(stateRoot, 'archive'), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

// ── activity snapshot (server-side, like the Claude Code desktop watcher) ──

/** Visual task state for the activity panel. */
export type VisualTaskState = 'blocked' | 'open' | 'running' | 'completed'

/**
 * The visual state of one task: `running` while in_progress, `completed`
 * when done, `blocked` while any dependency is unfinished, else `open`.
 */
export function taskVisualState(
  status: string,
  dependencies: readonly string[],
  tasks: readonly TeamTask[],
): VisualTaskState {
  if (status === 'completed') return 'completed'
  if (status === 'in_progress') return 'running'
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const openDependency = dependencies.some((dependencyId) => {
    const dependency = byId.get(dependencyId)
    return dependency !== undefined && dependency.status !== 'completed'
  })
  return openDependency ? 'blocked' : 'open'
}

/**
 * Longest dependency path depth per task id (each depth = one lane column).
 */
export function taskDepthsById(tasks: readonly TeamTask[]): Map<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const depths = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (taskId: string): number => {
    const cached = depths.get(taskId)
    if (cached !== undefined) return cached
    if (visiting.has(taskId)) return 0
    const task = byId.get(taskId)
    if (task === undefined) return 0
    visiting.add(taskId)
    const dependencies = task.dependencies
      .filter((dependencyId) => byId.has(dependencyId))
      .sort()
    const depth = dependencies.length === 0
      ? 0
      : 1 + Math.max(...dependencies.map(depthOf))
    visiting.delete(taskId)
    depths.set(taskId, depth)
    return depth
  }
  for (const task of tasks) depthOf(task.id)
  return depths
}
