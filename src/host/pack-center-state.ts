/**
 * Durable, deployment-local pack state. This module never downloads or loads packs.
 * An installer must verify immutable inventory before committing its references.
 *
 * Linux `flock` is a required host dependency. A short-lived child acquires a lock
 * on the parent's inherited open-file description. The parent keeps that fd open
 * until commit, so child exit cannot lose the lock and parent crashes release it.
 * Only the state.json rename commits a transaction; unreferenced inventory is safe.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, mkdir, readdir, readFile, rename, unlink, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { types } from 'node:util'

export type StateJson = null | boolean | number | string | StateJson[] | { [key: string]: StateJson }

export interface InstalledPackRecord {
  releaseId: string
  packId: string
  version: string
  artifactSha256: string
  contentTreeSha256: string
  packPath: string
  manifestPath?: string
  installedAt: string
  source: 'center' | 'legacy'
  centerId?: string
  ownerOrgId?: string
  previousReleaseId?: string
}

/** Records an explicitly taken-over path, not a pack-ID-wide exclusion. */
export interface LegacySuppression {
  packId: string
  releaseId: string
  backupPath: string
  contentTreeSha256: string
  suppressedAt: string
}

export interface CommittedOperation {
  operationKey: string
  requestFingerprint: string
  expectedGeneration: number
  committedGeneration: number
  committedAt: string
  result: StateJson
}

/** Permanent trust receipt; uninstall must not forget an accepted immutable release. */
export interface AcceptedRelease {
  releaseId: string
  packId: string
  version: string
  centerId: string
  ownerOrgId: string
  manifestSha256: string
}

export interface PackCenterState {
  schemaVersion: 1
  generation: number
  installed: Record<string, InstalledPackRecord>
  active: Record<string, string>
  operations: Record<string, CommittedOperation>
  legacySuppressions: Record<string, LegacySuppression>
  acceptedReleases: Record<string, AcceptedRelease>
}

export type PackCenterStateErrorCode =
  | 'STATE_CORRUPT' | 'STATE_MISSING' | 'STATE_UNSUPPORTED_VERSION'
  | 'STATE_READ_FAILED' | 'STATE_READ_ONLY' | 'STATE_RECOVERY_INVALID'
  | 'STATE_WRITE_FAILED' | 'STATE_COMMIT_UNCERTAIN' | 'STATE_INVALID'
  | 'GENERATION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'INVALID_REQUEST'
  | 'LOCK_UNAVAILABLE' | 'LOCK_TIMEOUT' | 'LOCK_LOST'

export class PackCenterStateError extends Error {
  readonly code: PackCenterStateErrorCode
  readonly details: Record<string, StateJson>
  constructor(code: PackCenterStateErrorCode, message: string, details: Record<string, StateJson> = {}) {
    super(message)
    this.name = 'PackCenterStateError'
    this.code = code
    this.details = details
  }
}

/**
 * before/after-prev-write: before/after durable replacement of the previous state.
 * before-state-rename: the new unique temporary is fsynced, but is not committed.
 * after-state-rename: the atomic commit happened; parent directory is not yet synced.
 * after-state-sync: the commit and its directory entry are durably synced.
 * The last two failures are uncertain to the caller and resolved by identical retry.
 */
export type StateFaultPoint = 'before-prev-write' | 'after-prev-write' | 'before-state-rename' | 'after-state-rename' | 'after-state-sync'

export interface PackCenterStateOptions {
  /** Reverify referenced signatures, inventory, and legacy backups before recovery. */
  validateSnapshot?: (state: Readonly<PackCenterState>) => Promise<void> | void
  lockTimeoutMs?: number
  /** Failure injection only; hosts normally leave this unset. */
  fault?: (point: StateFaultPoint) => Promise<void> | void
}

export interface StateReadResult {
  state: PackCenterState
  mode: 'normal' | 'recovered-read-only'
  warning?: { code: 'STATE_CORRUPT' | 'STATE_MISSING'; message: string }
}

export interface StateTransactionRequest {
  operationKey: string
  request: StateJson
  expectedGeneration: number
}

export interface StateTransactionResult {
  state: PackCenterState
  operation: CommittedOperation
  replayed: boolean
}

const sha256Pattern = /^[a-f0-9]{64}$/
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)

function dictionary(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

/** Canonical request hashing rejects values JSON would silently discard/coerce. */
export function canonicalStateJson(value: unknown): string {
  const ancestors = new Set<object>()
  function encode(item: unknown): string {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return JSON.stringify(item)
    if (typeof item !== 'object' || item === null || types.isProxy(item) || ancestors.has(item)) {
      throw new PackCenterStateError('INVALID_REQUEST', 'Only finite, acyclic JSON values are accepted')
    }
    ancestors.add(item)
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype) throw new PackCenterStateError('INVALID_REQUEST', 'Only plain JSON arrays are accepted')
        const descriptors = Object.getOwnPropertyDescriptors(item)
        if (Reflect.ownKeys(descriptors).length !== item.length + 1) {
          throw new PackCenterStateError('INVALID_REQUEST', 'Sparse or decorated arrays are not accepted')
        }
        const values: string[] = []
        for (let index = 0; index < item.length; index++) {
          const descriptor = descriptors[String(index)]
          if (!descriptor || !own(descriptor, 'value') || !descriptor.enumerable) throw new PackCenterStateError('INVALID_REQUEST', 'Array entries must be enumerable JSON data')
          values.push(encode(descriptor.value))
        }
        return `[${values.join(',')}]`
      }
      if (!dictionary(item) || Object.getOwnPropertySymbols(item).length) {
        throw new PackCenterStateError('INVALID_REQUEST', 'Only plain JSON objects are accepted')
      }
      const descriptors = Object.getOwnPropertyDescriptors(item)
      return `{${Object.keys(descriptors).sort().map(key => {
        const descriptor = descriptors[key]!
        if (!own(descriptor, 'value') || !descriptor.enumerable) throw new PackCenterStateError('INVALID_REQUEST', 'Object properties must be enumerable JSON data')
        return `${JSON.stringify(key)}:${encode(descriptor.value)}`
      }).join(',')}}`
    } finally {
      ancestors.delete(item)
    }
  }
  return encode(value)
}

export function fingerprintStateRequest(request: StateJson, expectedGeneration: number): string {
  return createHash('sha256').update(canonicalStateJson({ expectedGeneration, request })).digest('hex')
}

export function emptyPackCenterState(): PackCenterState {
  return { schemaVersion: 1, generation: 0, installed: {}, active: {}, operations: {}, legacySuppressions: {}, acceptedReleases: {} }
}

function validKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !forbiddenKeys.has(value) && !/[\x00-\x1f\x7f]/.test(value)
}

function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && isAbsolute(value) && resolve(value) === value
}

function timestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/** Structural validation does not stand in for signature/inventory verification. */
export function validatePackCenterState(value: unknown): asserts value is PackCenterState {
  function require(check: unknown, reason: string): asserts check {
    if (!check) throw new PackCenterStateError('STATE_INVALID', reason)
  }
  // Reject accessors before structural reads; validation must never execute them.
  try { canonicalStateJson(value) } catch { throw new PackCenterStateError('STATE_INVALID', 'State contains values outside JSON') }
  require(dictionary(value), 'State must be an object')
  require(value.schemaVersion === 1, 'Unsupported state schema')
  require(Number.isSafeInteger(value.generation) && (value.generation as number) >= 0, 'Invalid generation')
  for (const key of ['installed', 'active', 'operations', 'legacySuppressions', 'acceptedReleases']) require(dictionary(value[key]), `Invalid ${key} map`)
  const state = value as unknown as PackCenterState
  const acceptedVersions = new Set<string>()
  for (const [releaseId, accepted] of Object.entries(state.acceptedReleases)) {
    require(validKey(releaseId) && dictionary(accepted) && accepted.releaseId === releaseId, 'Invalid accepted release identity')
    require(validKey(accepted.packId) && validKey(accepted.version) && validKey(accepted.centerId) && validKey(accepted.ownerOrgId), 'Invalid accepted release metadata')
    require(typeof accepted.manifestSha256 === 'string' && sha256Pattern.test(accepted.manifestSha256), 'Invalid accepted manifest digest')
    const identity = canonicalStateJson([accepted.packId, accepted.version])
    require(!acceptedVersions.has(identity), 'A pack version cannot have two accepted release identities')
    acceptedVersions.add(identity)
  }
  for (const [releaseId, record] of Object.entries(state.installed)) {
    require(validKey(releaseId) && dictionary(record), 'Invalid installed record')
    require(record.releaseId === releaseId && validKey(record.packId) && validKey(record.version), 'Invalid installed identity')
    require(sha256Pattern.test(record.artifactSha256) && sha256Pattern.test(record.contentTreeSha256), 'Invalid installed digests')
    require(absolutePath(record.packPath) && timestamp(record.installedAt), 'Invalid installed path or time')
    require(record.source === 'center' || record.source === 'legacy', 'Invalid installed source')
    if (record.manifestPath !== undefined) require(absolutePath(record.manifestPath), 'Invalid manifest path')
    if (record.source === 'center') {
      require(validKey(record.centerId) && validKey(record.ownerOrgId) && absolutePath(record.manifestPath), 'Center records require center, owner, and signed manifest')
    }
    if (record.previousReleaseId !== undefined) {
      require(validKey(record.previousReleaseId) && record.previousReleaseId !== releaseId, 'Invalid previous release')
      const previous = state.installed[record.previousReleaseId]
      require(own(state.installed, record.previousReleaseId) && previous?.packId === record.packId, 'Previous release must exist for the same pack')
    }
  }
  for (const [packId, releaseId] of Object.entries(state.active)) {
    require(validKey(packId) && validKey(releaseId), 'Invalid active mapping')
    require(own(state.installed, releaseId) && state.installed[releaseId]?.packId === packId, 'Active release must be installed for this pack')
  }
  const committedGenerations = new Set<number>()
  for (const [key, operation] of Object.entries(state.operations)) {
    require(validKey(key) && dictionary(operation) && operation.operationKey === key, 'Invalid operation identity')
    require(sha256Pattern.test(operation.requestFingerprint) && timestamp(operation.committedAt), 'Invalid operation fingerprint or time')
    require(Number.isSafeInteger(operation.expectedGeneration) && operation.expectedGeneration >= 0, 'Invalid operation expected generation')
    require(operation.committedGeneration === operation.expectedGeneration + 1 && operation.committedGeneration <= state.generation, 'Invalid committed generation')
    require(!committedGenerations.has(operation.committedGeneration), 'Duplicate committed generation')
    committedGenerations.add(operation.committedGeneration)
    require(own(operation, 'result'), 'Operation result missing')
  }
  for (const [vendorPath, suppression] of Object.entries(state.legacySuppressions)) {
    require(absolutePath(vendorPath) && dictionary(suppression), 'Invalid legacy suppression path')
    require(validKey(suppression.packId) && validKey(suppression.releaseId), 'Invalid legacy suppression identity')
    require(own(state.installed, suppression.releaseId) && state.installed[suppression.releaseId]?.packId === suppression.packId, 'Legacy suppression must reference installed pack')
    require(absolutePath(suppression.backupPath) && sha256Pattern.test(suppression.contentTreeSha256) && timestamp(suppression.suppressedAt), 'Invalid legacy backup')
  }
}

function clone<T>(value: T): T { return JSON.parse(canonicalStateJson(value)) as T }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
function errno(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code }

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

async function readDocument(path: string): Promise<PackCenterState | undefined> {
  let raw: string
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PackCenterStateError('STATE_CORRUPT', 'State must be a regular file')
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined
    if (error instanceof PackCenterStateError) throw error
    throw new PackCenterStateError('STATE_READ_FAILED', 'Cannot read pack state')
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (dictionary(parsed) && own(parsed, 'schemaVersion') && parsed.schemaVersion !== 1) {
      throw new PackCenterStateError('STATE_UNSUPPORTED_VERSION', 'State schema is not supported; upgrade the plugin before writing')
    }
    validatePackCenterState(parsed)
    return parsed
  } catch (error) {
    if (error instanceof PackCenterStateError && error.code === 'STATE_UNSUPPORTED_VERSION') throw error
    throw new PackCenterStateError('STATE_CORRUPT', 'Pack state is malformed or inconsistent; the original file is preserved')
  }
}

async function hasInventory(root: string): Promise<boolean> {
  // Empty directories and abandoned staging downloads are not installed inventory.
  for (const name of ['releases', 'legacy', 'store', 'manifests', 'operations']) {
    try { if ((await readdir(join(root, name))).length) return true } catch (error) {
      if (errno(error) !== 'ENOENT') throw new PackCenterStateError('STATE_READ_FAILED', 'Cannot inspect pack inventory')
    }
  }
  try { await lstat(join(root, 'state.prev.json')); return true } catch (error) {
    if (errno(error) !== 'ENOENT') throw new PackCenterStateError('STATE_READ_FAILED', 'Cannot inspect previous state')
  }
  return false
}

async function acquireLock(root: string, timeoutMs: number): Promise<{ release(): Promise<void>; assertHeld(): void }> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  // A lock file is persistent, never unlinked/replaced. Refuse aliased roots/files
  // so independently opened transactions cannot silently lock different inodes.
  if (await realpath(root) !== root) throw new PackCenterStateError('LOCK_UNAVAILABLE', 'Pack state root must not contain symbolic links')
  const file = await open(join(root, '.state.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600).catch(() => {
    throw new PackCenterStateError('LOCK_UNAVAILABLE', 'Cannot open pack state lock safely')
  })
  let held = false
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1) throw new PackCenterStateError('LOCK_UNAVAILABLE', 'Pack state lock must be an unaliased regular file')
    // fd 3 is a dup of this parent's fd, NOT a fresh open of the path. Linux
    // flock locks the shared open-file description, which survives child exit.
    const child = spawn('flock', ['--exclusive', '--timeout', String(timeoutMs / 1000), '--conflict-exit-code', '73', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', file.fd],
    })
    await new Promise<void>((resolveReady, rejectReady) => {
      child.once('error', () => rejectReady(new PackCenterStateError('LOCK_UNAVAILABLE', 'The host requires util-linux flock for pack state transactions')))
      child.once('close', code => {
        if (code === 0) resolveReady()
        else rejectReady(new PackCenterStateError(code === 73 ? 'LOCK_TIMEOUT' : 'LOCK_UNAVAILABLE', code === 73 ? 'Another process is writing pack state' : 'Pack state lock acquisition process failed'))
      })
    })
    held = true
    return {
      assertHeld() { if (!held || file.fd < 0) throw new PackCenterStateError('LOCK_LOST', 'Pack state lock was lost before commit') },
      async release() { if (held) { held = false; await file.close() } },
    }
  } catch (error) {
    await file.close()
    throw error
  }
}

export function createPackCenterStateStore(rootInput: string, options: PackCenterStateOptions = {}) {
  const root = resolve(rootInput)
  const statePath = join(root, 'state.json')
  const previousPath = join(root, 'state.prev.json')
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000
  if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0) throw new PackCenterStateError('INVALID_REQUEST', 'Invalid lock timeout')

  async function readState(): Promise<StateReadResult> {
    let problem: PackCenterStateError
    try {
      const state = await readDocument(statePath)
      if (state) return { state, mode: 'normal' }
      if (!await hasInventory(root)) return { state: emptyPackCenterState(), mode: 'normal' }
      problem = new PackCenterStateError('STATE_MISSING', 'State is missing while previous state or inventory exists; refusing empty initialization')
    } catch (error) {
      if (!(error instanceof PackCenterStateError) || error.code !== 'STATE_CORRUPT') throw error
      problem = error
    }
    if (!options.validateSnapshot) throw problem
    let previous: PackCenterState | undefined
    try { previous = await readDocument(previousPath) } catch {
      throw new PackCenterStateError('STATE_RECOVERY_INVALID', 'Previous state is unavailable or invalid; original files are preserved')
    }
    if (!previous) throw problem
    try { await options.validateSnapshot(freeze(clone(previous))) } catch {
      throw new PackCenterStateError('STATE_RECOVERY_INVALID', 'Previous state references failed integrity validation; original files are preserved')
    }
    return { state: previous, mode: 'recovered-read-only', warning: { code: problem.code as 'STATE_CORRUPT' | 'STATE_MISSING', message: problem.message } }
  }

  async function writeDocument(path: string, state: PackCenterState, beforeRename?: () => Promise<void>, afterRename?: () => Promise<void>) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(`${canonicalStateJson(state)}\n`, 'utf8')
        await file.sync()
      } finally { await file.close() }
      await beforeRename?.()
      await rename(temporary, path)
      await afterRename?.()
      await syncDirectory(root)
    } finally {
      // Remove only our uniquely named unfinished write, never inventory or state.
      await unlink(temporary).catch(error => { if (errno(error) !== 'ENOENT') throw error })
    }
  }

  async function initialize(): Promise<PackCenterState> {
    const lock = await acquireLock(root, lockTimeoutMs)
    try {
      const current = await readState()
      if (current.mode !== 'normal') throw new PackCenterStateError('STATE_READ_ONLY', 'Recovered state is read-only until explicit administrative recovery')
      if (!await readDocument(statePath)) {
        lock.assertHeld()
        try { await writeDocument(statePath, current.state) } catch { throw new PackCenterStateError('STATE_WRITE_FAILED', 'Could not initialize pack state') }
      }
      return current.state
    } finally { await lock.release() }
  }

  async function transact(
    input: StateTransactionRequest,
    mutate: (draft: PackCenterState, current: Readonly<PackCenterState>) => StateJson | void | Promise<StateJson | void>,
  ): Promise<StateTransactionResult> {
    // Freeze the caller's request by value before the first await. A mutable
    // request object must not alter its generation/key after fingerprinting.
    input = clone(input)
    if (!dictionary(input) || Object.keys(input).sort().join(',') !== 'expectedGeneration,operationKey,request') {
      throw new PackCenterStateError('INVALID_REQUEST', 'Only operationKey, expectedGeneration, and request are accepted')
    }
    if (!validKey(input.operationKey) || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
      throw new PackCenterStateError('INVALID_REQUEST', 'A valid operation key and nonnegative expected generation are required')
    }
    const fingerprint = fingerprintStateRequest(input.request, input.expectedGeneration)
    const lock = await acquireLock(root, lockTimeoutMs)
    try {
      const read = await readState()
      if (read.mode !== 'normal') throw new PackCenterStateError('STATE_READ_ONLY', 'Recovered state is read-only until explicit administrative recovery')
      const current = read.state
      // Make the initially empty state durable too. A first-operation crash after
      // writing prev must still leave a readable current state, not a false loss.
      if (!await readDocument(statePath)) {
        lock.assertHeld()
        try { await writeDocument(statePath, current) } catch { throw new PackCenterStateError('STATE_WRITE_FAILED', 'Could not initialize pack state') }
      }
      if (own(current.operations, input.operationKey)) {
        const operation = current.operations[input.operationKey]!
        if (operation.requestFingerprint !== fingerprint) throw new PackCenterStateError('IDEMPOTENCY_CONFLICT', 'Operation key has already been used for a different request')
        return { state: current, operation, replayed: true }
      }
      if (current.generation !== input.expectedGeneration) {
        throw new PackCenterStateError('GENERATION_CONFLICT', 'Pack state changed; refresh before trying a new operation', { expectedGeneration: input.expectedGeneration, actualGeneration: current.generation })
      }
      if (current.generation === Number.MAX_SAFE_INTEGER) throw new PackCenterStateError('STATE_INVALID', 'State generation is exhausted')
      let draft = clone(current)
      const result = await mutate(draft, freeze(clone(current)))
      // Detach the committed snapshot from any reference retained by mutate.
      // Validate descriptors before reading metadata, so accessors never run.
      try { draft = clone(draft) } catch { throw new PackCenterStateError('STATE_INVALID', 'Mutation produced values outside JSON') }
      // Operation history, schema, and generation are controlled only by this store.
      if (canonicalStateJson(draft.operations) !== canonicalStateJson(current.operations) || draft.generation !== current.generation || draft.schemaVersion !== 1) {
        throw new PackCenterStateError('STATE_INVALID', 'Mutation cannot rewrite transaction metadata')
      }
      for (const [releaseId, accepted] of Object.entries(current.acceptedReleases)) {
        if (!draft.acceptedReleases || !own(draft.acceptedReleases, releaseId) || canonicalStateJson(draft.acceptedReleases[releaseId]) !== canonicalStateJson(accepted)) {
          throw new PackCenterStateError('STATE_INVALID', 'Mutation cannot remove or rewrite a previously accepted release')
        }
      }
      const operation: CommittedOperation = {
        operationKey: input.operationKey, requestFingerprint: fingerprint,
        expectedGeneration: current.generation, committedGeneration: current.generation + 1,
        committedAt: new Date().toISOString(), result: result === undefined ? null : clone(result),
      }
      draft.generation = operation.committedGeneration
      draft.operations[input.operationKey] = operation
      validatePackCenterState(draft)
      let committed = false
      try {
        lock.assertHeld()
        await options.fault?.('before-prev-write')
        await writeDocument(previousPath, current)
        await options.fault?.('after-prev-write')
        await writeDocument(statePath, draft, async () => {
          await options.fault?.('before-state-rename')
          lock.assertHeld()
        }, async () => {
          committed = true
          await options.fault?.('after-state-rename')
        })
        await options.fault?.('after-state-sync')
      } catch (error) {
        if (error instanceof PackCenterStateError && error.code === 'LOCK_LOST') throw error
        throw new PackCenterStateError(committed ? 'STATE_COMMIT_UNCERTAIN' : 'STATE_WRITE_FAILED', committed ? 'State may be committed; retry the identical operation key and request to resolve its result' : 'State was not committed; the previous active versions are preserved', { operationKey: input.operationKey })
      }
      return { state: draft, operation, replayed: false }
    } finally { await lock.release() }
  }

  return { root, readState, initialize, transact }
}

export type PackCenterStateStore = ReturnType<typeof createPackCenterStateStore>
