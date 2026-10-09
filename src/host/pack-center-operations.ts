/**
 * Durable host-only operation queue. The journal contains public, immutable
 * identifiers/digests only: never credentials, URLs, paths, or request headers.
 *
 * Linux util-linux flock is required. A persistent transaction lock protects
 * journal replacements; a separate inherited-FD runner lock permits only one
 * executor across all web processes. A crashed runner is reconciled locally,
 * never automatically reissued. Explicit retry retains the exact request.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { canonicalStateJson } from './pack-center-state.ts'

export type PackOperationKind = 'install' | 'update_enable' | 'enable' | 'disable' | 'rollback' | 'uninstall'
export interface PackOperationRequest {
  operationKey: string
  kind: PackOperationKind
  expectedGeneration: number
  releaseId?: string
  packId?: string
  connectionRevision?: number
  target?: { manifestSha256: string; artifactSha256: string; contentTreeSha256: string }
}
export interface PackOperationResult {
  generation: number
  outcome: 'succeeded' | 'installed_not_enabled'
  releaseId?: string
  packId?: string
  activated?: boolean
  errorCode?: string
}
export const OPERATION_PHASES = ['queued', 'preparing', 'authorizing', 'downloading', 'verifying', 'installing',
  'activating', 'committing', 'recovering', 'completed', 'failed', 'interrupted'] as const
export type PackOperationPhase = typeof OPERATION_PHASES[number]
export type PackOperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
export interface PackOperationJob {
  operationId: string
  request: PackOperationRequest
  status: PackOperationStatus
  phase: PackOperationPhase
  createdAt: string
  updatedAt: string
  result?: PackOperationResult
  errorCode?: string
}
export interface PackOperationQueueOptions {
  root: string
  execute: (request: PackOperationRequest, reportProgress: (phase: PackOperationPhase) => Promise<void>) => Promise<PackOperationResult>
  /** Read local receipts only. Must not initiate a new remote request or mutation. */
  recover: (request: PackOperationRequest) => Promise<PackOperationResult | null>
  lockTimeoutMs?: number
}

export const MAX_PACK_OPERATIONS = 256
const maximumBytes = 2 * 1024 * 1024
const requestMaximumBytes = 2048
const errorCodes = new Set([
  'OPERATION_INVALID', 'OPERATION_INVALID_RESULT', 'OPERATION_FAILED', 'OPERATION_INTERRUPTED', 'OPERATION_NOT_FOUND',
  'OPERATION_LIMIT', 'OPERATION_CLOSED', 'OPERATION_STORAGE_UNSAFE', 'OPERATION_STORAGE_CORRUPT',
  'OPERATION_READ_FAILED', 'OPERATION_WRITE_FAILED', 'OPERATION_COMMIT_UNCERTAIN',
  'IDEMPOTENCY_CONFLICT', 'GENERATION_CONFLICT', 'REVISION_CONFLICT', 'LOCK_UNAVAILABLE', 'LOCK_TIMEOUT', 'LOCK_LOST',
  'CENTER_DISABLED', 'CENTER_NOT_CONFIGURED', 'CENTER_BIND_UNCONFIRMED', 'CENTER_RESTART_REQUIRED',
  'CENTER_NOT_BOUND', 'CENTER_ORIGIN_CHANGED', 'CENTER_CREDENTIAL_EXPIRED', 'CENTER_REQUEST_FAILED',
  'CENTER_RESPONSE_INVALID', 'CENTER_CANCELLED', 'CENTER_GRANT_EXPIRED', 'CENTER_ARTIFACT_TOO_LARGE',
  'CENTER_ACTIVATION_UNAVAILABLE', 'CENTER_INVALID_INPUT', 'CENTER_INVALID_STORAGE', 'CENTER_MISMATCH',
  'CENTER_INVENTORY_NOT_EMPTY', 'CENTER_TRUST_MISMATCH', 'CENTER_KEY_REASSIGNMENT', 'CENTER_ID_LOCKED',
  'CENTER_PACK_ID_CONFLICT', 'CENTER_ENTITY_CONFLICT', 'CENTER_MERGE_INVALID', 'CENTER_BASES_REQUIRED', 'ACTIVATION_PREFLIGHT_FAILED',
  'CENTER_TARGET_CHANGED', 'CENTER_CONNECTION_CHANGED', 'CENTER_BINDING_CHANGED', 'TARGET_CHANGED',
  'CENTER_NETWORK_ERROR', 'CENTER_TIMEOUT', 'CENTER_REDIRECT_DENIED', 'CENTER_HTTP_ERROR',
  'CENTER_RESPONSE_TOO_LARGE', 'CENTER_INVALID_REQUEST', 'CENTER_INVALID_ORIGIN', 'CENTER_DOWNLOAD_INVALID',
  'CENTER_DOWNLOAD_IO', 'CENTER_DOWNLOAD_TARGET_EXISTS', 'CENTER_PAGE_LIMIT', 'CENTER_RELEASE_MISMATCH', 'CENTER_REPORT_MISMATCH',
  'CONNECTION_INVALID', 'CONNECTION_UNSAFE_PATH', 'CONNECTION_CORRUPT', 'CONNECTION_READ_FAILED',
  'CONNECTION_WRITE_FAILED', 'CONNECTION_COMMIT_UNCERTAIN',
  'STATE_CORRUPT', 'STATE_MISSING', 'STATE_UNSUPPORTED_VERSION', 'STATE_READ_FAILED', 'STATE_READ_ONLY',
  'STATE_RECOVERY_INVALID', 'STATE_WRITE_FAILED', 'STATE_COMMIT_UNCERTAIN', 'STATE_INVALID',
  'INCOMPATIBLE_RELEASE', 'CONTENT_DIGEST_MISMATCH', 'PACK_INVALID', 'PACK_IDENTITY_MISMATCH',
  'DEPENDENCY_MANIFEST_MISMATCH', 'INVENTORY_UNSAFE', 'INVENTORY_IDENTITY_MISMATCH', 'INVENTORY_PATH_MISMATCH',
  'INVENTORY_MISSING', 'IMMUTABLE_RELEASE_CONFLICT', 'IMMUTABLE_VERSION_CONFLICT', 'PACK_OWNER_CONFLICT',
  'ENTITY_CONFLICT', 'DEPENDENCY_BLOCKED', 'BUILTIN_DEPENDENCY_BLOCKED', 'DEPENDENCY_CYCLE',
  'RELEASE_NOT_INSTALLED', 'PACK_NOT_ACTIVE', 'INVALID_ROLLBACK_TARGET', 'RELEASE_ACTIVE',
  'LEGACY_VERIFIER_REQUIRED', 'LEGACY_RESTORE_REQUIRED', 'OPERATION_DISAPPEARED', 'INVALID_REQUEST',
  'INVALID_CONTRACT', 'INVALID_PATH', 'INVALID_TRANSITION', 'INVALID_VERSION',
  'SIGNATURE_INVALID', 'UNKNOWN_SIGNING_KEY', 'UNSUPPORTED_ALGORITHM', 'UNSUPPORTED_FILE',
  'TRANSPORT_INVALID', 'TRANSPORT_UNSAFE_ORIGIN', 'TRANSPORT_UNSAFE_PATH', 'TRANSPORT_REQUEST_FAILED',
  'TRANSPORT_TIMEOUT', 'TRANSPORT_CANCELLED', 'TRANSPORT_RESPONSE_TOO_LARGE', 'TRANSPORT_RESPONSE_INVALID',
  'TRANSPORT_REDIRECT_REFUSED', 'TRANSPORT_HTTP_ERROR', 'TRANSPORT_ARTIFACT_TOO_LARGE',
  'TRANSPORT_DIGEST_MISMATCH', 'TRANSPORT_SIZE_MISMATCH', 'TRANSPORT_DESTINATION_EXISTS',
  'UNAUTHORIZED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'RELEASE_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE',
  'BINDING_CODE_INVALID', 'DEPLOYMENT_DISABLED', 'DOWNLOAD_GRANT_INVALID', 'DOWNLOAD_GRANT_REQUIRED',
  'RELEASE_YANKED', 'RELEASE_INTEGRITY', 'RATE_LIMITED',
])

export class PackOperationError extends Error {
  readonly code: string
  constructor(code: string) {
    const safeCode = errorCodes.has(code) ? code : 'OPERATION_FAILED'
    super(safeCode)
    this.name = 'PackOperationError'
    this.code = safeCode
  }
}
/** Do not copy an exception's message, details, cause, URL, or arbitrary code. */
export function sanitizePackOperationError(error: unknown): string {
  try {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return 'OPERATION_FAILED'
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string' && errorCodes.has(descriptor.value)
      ? descriptor.value : 'OPERATION_FAILED'
  } catch { return 'OPERATION_FAILED' }
}
function fail(code: string): never { throw new PackOperationError(code) }
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value))
const validId = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) && !value.includes('..')
  && !['__proto__', 'prototype', 'constructor'].includes(value) && !/^dpc_(?:token|bind)_/.test(value)
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
const validDate = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => own(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}
function copy<T>(value: T, maximum = maximumBytes, code = 'OPERATION_INVALID'): T {
  try {
    const json = canonicalStateJson(value)
    if (Buffer.byteLength(json) > maximum) fail(code)
    return JSON.parse(json) as T
  } catch { return fail(code) }
}
export function validatePackOperationRequest(input: unknown): PackOperationRequest {
  const value = copy(input, requestMaximumBytes)
  if (!plain(value) || !keys(value, ['operationKey', 'kind', 'expectedGeneration'],
    ['releaseId', 'packId', 'connectionRevision', 'target']) || !integer(value.expectedGeneration)
    || typeof value.operationKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.operationKey)
    || ['__proto__', 'prototype', 'constructor'].includes(value.operationKey) || /^dpc_(?:token|bind)_/.test(value.operationKey)
    || !['install', 'update_enable', 'enable', 'disable', 'rollback', 'uninstall'].includes(value.kind as string)) fail('OPERATION_INVALID')
  for (const key of ['releaseId', 'packId']) if (own(value, key) && !validId(value[key])) fail('OPERATION_INVALID')
  const remote = value.kind === 'install' || value.kind === 'update_enable'
  if (remote) {
    if (!validId(value.releaseId) || own(value, 'packId') || !integer(value.connectionRevision) || !plain(value.target)
      || !keys(value.target, ['manifestSha256', 'artifactSha256', 'contentTreeSha256'])
      || Object.values(value.target).some(item => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item))) fail('OPERATION_INVALID')
  } else {
    if (own(value, 'target') || own(value, 'connectionRevision')) fail('OPERATION_INVALID')
    if (value.kind !== 'disable' && !validId(value.releaseId)) fail('OPERATION_INVALID')
    if ((value.kind === 'disable' || value.kind === 'rollback') && !validId(value.packId)) fail('OPERATION_INVALID')
    if (value.kind === 'disable' && own(value, 'releaseId')) fail('OPERATION_INVALID')
    if (['enable', 'uninstall'].includes(value.kind as string) && own(value, 'packId')) fail('OPERATION_INVALID')
  }
  return value as unknown as PackOperationRequest
}
function result(input: unknown): PackOperationResult {
  const value = copy(input, requestMaximumBytes, 'OPERATION_INVALID_RESULT')
  if (!plain(value) || !keys(value, ['generation', 'outcome'], ['releaseId', 'packId', 'activated', 'errorCode'])
    || !integer(value.generation) || !['succeeded', 'installed_not_enabled'].includes(value.outcome as string)) fail('OPERATION_INVALID_RESULT')
  for (const key of ['releaseId', 'packId']) if (own(value, key) && !validId(value[key])) fail('OPERATION_INVALID_RESULT')
  if (own(value, 'activated') && typeof value.activated !== 'boolean'
    || own(value, 'errorCode') && (typeof value.errorCode !== 'string' || !errorCodes.has(value.errorCode))
    || value.outcome === 'installed_not_enabled' && value.activated === true) fail('OPERATION_INVALID_RESULT')
  return value as unknown as PackOperationResult
}
function operationId(request: PackOperationRequest): string {
  return `op_${createHash('sha256').update(request.operationKey).digest('hex')}`
}
function validateId(value: string): void { if (typeof value !== 'string' || !/^op_[a-f0-9]{64}$/.test(value)) fail('OPERATION_INVALID') }

interface Journal { schemaVersion: 1; revision: number; jobs: PackOperationJob[] }
function validateJournal(input: unknown): Journal {
  const value = copy(input, maximumBytes, 'OPERATION_STORAGE_CORRUPT')
  try {
    if (!plain(value) || !keys(value, ['schemaVersion', 'revision', 'jobs']) || value.schemaVersion !== 1
      || !integer(value.revision) || !Array.isArray(value.jobs) || value.jobs.length > MAX_PACK_OPERATIONS) fail('OPERATION_STORAGE_CORRUPT')
    const seen = new Set<string>()
    for (const item of value.jobs) {
      if (!plain(item) || !keys(item, ['operationId', 'request', 'status', 'phase', 'createdAt', 'updatedAt'], ['result', 'errorCode'])) fail('OPERATION_STORAGE_CORRUPT')
      const request = validatePackOperationRequest(item.request)
      if (item.operationId !== operationId(request) || seen.has(item.operationId as string)
        || !validDate(item.createdAt) || !validDate(item.updatedAt) || item.updatedAt < item.createdAt
        || !['queued', 'running', 'succeeded', 'failed', 'interrupted'].includes(item.status as string)
        || !OPERATION_PHASES.includes(item.phase as PackOperationPhase)) fail('OPERATION_STORAGE_CORRUPT')
      seen.add(item.operationId as string)
      if (item.status === 'succeeded') {
        if (item.phase !== 'completed' || !own(item, 'result') || own(item, 'errorCode')) fail('OPERATION_STORAGE_CORRUPT')
        if (result(item.result).outcome !== 'succeeded') fail('OPERATION_STORAGE_CORRUPT')
      } else if (item.status === 'failed' || item.status === 'interrupted') {
        if (item.phase !== item.status || typeof item.errorCode !== 'string' || !errorCodes.has(item.errorCode)) fail('OPERATION_STORAGE_CORRUPT')
        if (own(item, 'result') && (item.status !== 'failed' || result(item.result).outcome !== 'installed_not_enabled')) fail('OPERATION_STORAGE_CORRUPT')
      } else {
        if (own(item, 'result') || own(item, 'errorCode')
          || item.status === 'queued' && item.phase !== 'queued'
          || item.status === 'running' && ['queued', 'completed', 'failed', 'interrupted'].includes(item.phase as string)) fail('OPERATION_STORAGE_CORRUPT')
      }
    }
    return value as unknown as Journal
  } catch { return fail('OPERATION_STORAGE_CORRUPT') }
}
function checkStat(stat: Stats, directory: boolean): void {
  const uid = process.getuid?.()
  if (uid === undefined || stat.uid !== uid || (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600)
    || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('OPERATION_STORAGE_UNSAFE')
}
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino

export function createPackOperationQueue(options: PackOperationQueueOptions) {
  const { root, execute, recover } = options
  const broad = new Set(['/', '/root', '/home', '/tmp', '/var', '/var/tmp', '/var/lib', '/usr', '/usr/lib', '/etc', '/run',
    homedir(), process.cwd(), dirname(process.cwd())])
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || root.includes('\0')
    || root.split('/').filter(Boolean).length < 2 || broad.has(root)) fail('OPERATION_STORAGE_UNSAFE')
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 120_000
    || typeof execute !== 'function' || typeof recover !== 'function') fail('OPERATION_INVALID')
  let started = false, closed = false
  let startPromise: Promise<void> | undefined, tickPromise: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let runner: { directory: FileHandle; lock: FileHandle } | undefined
  let fatal: PackOperationError | undefined

  async function directory(create: boolean): Promise<FileHandle | undefined> {
    let opened: FileHandle | undefined
    try {
      let path = parse(root).root
      for (const part of root.slice(path.length).split('/')) {
        path = join(path, part)
        let info: Stats
        try { info = await lstat(path) } catch (error) {
          if (errno(error) !== 'ENOENT') throw error
          if (!create) return undefined
          await mkdir(path, { mode: 0o700 }).catch(error => { if (errno(error) !== 'EEXIST') throw error })
          const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          try { await parent.sync() } finally { await parent.close() }
          info = await lstat(path)
        }
        if (!info.isDirectory() || info.isSymbolicLink()) fail('OPERATION_STORAGE_UNSAFE')
      }
      if (await realpath(root) !== root) fail('OPERATION_STORAGE_UNSAFE')
      opened = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      checkStat(await opened.stat(), true)
      if (!sameFile(await opened.stat(), await lstat(root))) fail('OPERATION_STORAGE_UNSAFE')
      return opened
    } catch (error) {
      await opened?.close().catch(() => {})
      if (error instanceof PackOperationError) throw error
      return fail(create ? 'OPERATION_WRITE_FAILED' : 'OPERATION_READ_FAILED')
    }
  }
  const anchor = (opened: FileHandle) => `/proc/self/fd/${opened.fd}`
  async function assertDirectory(opened: FileHandle): Promise<void> {
    try {
      checkStat(await opened.stat(), true)
      if (await realpath(root) !== root || !sameFile(await opened.stat(), await lstat(root))) fail('LOCK_LOST')
    } catch (error) { if (error instanceof PackOperationError) throw error; fail('LOCK_LOST') }
  }
  async function assertLock(opened: FileHandle, lock: FileHandle, name: string): Promise<void> {
    await assertDirectory(opened)
    try {
      checkStat(await lock.stat(), false)
      const info = await lstat(join(anchor(opened), name))
      checkStat(info, false)
      if (!sameFile(await lock.stat(), info)) fail('LOCK_LOST')
    } catch (error) { if (error instanceof PackOperationError) throw error; fail('LOCK_LOST') }
  }
  async function acquire(opened: FileHandle, name: string, timeout: number): Promise<FileHandle | undefined> {
    let file: FileHandle | undefined
    try {
      const path = join(anchor(opened), name)
      try { checkStat(await lstat(path), false) } catch (error) { if (errno(error) !== 'ENOENT') throw error }
      file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
      checkStat(await file.stat(), false)
      if ((await file.stat()).size !== 0) fail('OPERATION_STORAGE_UNSAFE')
      await file.sync(); await opened.sync()
      const child = spawn('flock', ['--exclusive', '--timeout', String(timeout / 1000), '--conflict-exit-code', '73', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', file.fd],
      })
      const acquired = await new Promise<boolean>((resolveReady, rejectReady) => {
        child.once('error', () => rejectReady(new PackOperationError('LOCK_UNAVAILABLE')))
        child.once('close', code => code === 0 ? resolveReady(true) : code === 73 ? resolveReady(false) : rejectReady(new PackOperationError('LOCK_UNAVAILABLE')))
      })
      if (!acquired) { await file.close(); return undefined }
      await assertLock(opened, file, name)
      return file
    } catch (error) {
      await file?.close().catch(() => {})
      if (error instanceof PackOperationError) throw error
      return fail('LOCK_UNAVAILABLE')
    }
  }
  async function marker(opened: FileHandle): Promise<boolean> {
    try {
      const info = await lstat(join(anchor(opened), '.operations.initialized'))
      checkStat(info, false)
      if (info.size !== 0) fail('OPERATION_STORAGE_CORRUPT')
      return true
    } catch (error) { if (errno(error) === 'ENOENT') return false; throw error }
  }
  async function readDocument(opened: FileHandle): Promise<{ document: Journal; exists: boolean }> {
    let file: FileHandle | undefined
    try {
      await assertDirectory(opened)
      const initialized = await marker(opened)
      const path = join(anchor(opened), 'operations.json')
      let before: Stats
      try { before = await lstat(path) } catch (error) {
        if (errno(error) !== 'ENOENT') throw error
        if (initialized) fail('OPERATION_STORAGE_CORRUPT')
        return { document: { schemaVersion: 1, revision: 0, jobs: [] }, exists: false }
      }
      checkStat(before, false)
      if (before.size > maximumBytes) fail('OPERATION_STORAGE_CORRUPT')
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const openedStat = await file.stat()
      checkStat(openedStat, false)
      if (!sameFile(before, openedStat) || openedStat.size > maximumBytes) fail('OPERATION_STORAGE_UNSAFE')
      const bytes = Buffer.alloc(maximumBytes + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      const after = await file.stat()
      checkStat(after, false)
      if (length > maximumBytes || length !== openedStat.size || after.size !== openedStat.size
        || after.mtimeMs !== openedStat.mtimeMs || after.ctimeMs !== openedStat.ctimeMs) fail('OPERATION_STORAGE_CORRUPT')
      const raw = bytes.subarray(0, length).toString('utf8')
      let document: Journal
      try { document = validateJournal(JSON.parse(raw)) } catch { return fail('OPERATION_STORAGE_CORRUPT') }
      if (raw !== `${canonicalStateJson(document)}\n`) fail('OPERATION_STORAGE_CORRUPT')
      return { document, exists: true }
    } catch (error) {
      if (error instanceof PackOperationError) throw error
      return fail('OPERATION_READ_FAILED')
    } finally { await file?.close().catch(() => {}) }
  }
  async function writeDocument(opened: FileHandle, held: FileHandle, current: Journal, next: Journal): Promise<void> {
    let temporary: string | undefined
    let committed = false
    try {
      validateJournal(next)
      if (next.revision !== current.revision + 1) fail('OPERATION_STORAGE_CORRUPT')
      temporary = join(anchor(opened), `.operations.${process.pid}.${randomUUID()}.tmp`)
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        checkStat(await file.stat(), false)
        await file.writeFile(`${canonicalStateJson(next)}\n`, 'utf8'); await file.sync()
      } finally { await file.close() }
      await assertLock(opened, held, '.operations.lock')
      if (runner) await assertLock(runner.directory, runner.lock, '.operations.runner.lock')
      if (canonicalStateJson((await readDocument(opened)).document) !== canonicalStateJson(current)) fail('REVISION_CONFLICT')
      await rename(temporary, join(anchor(opened), 'operations.json'))
      committed = true
      await opened.sync()
      if (!await marker(opened)) {
        const mark = await open(join(anchor(opened), '.operations.initialized'),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { checkStat(await mark.stat(), false); await mark.sync() } finally { await mark.close() }
        await opened.sync()
      }
    } catch (error) {
      if (committed) return fail('OPERATION_COMMIT_UNCERTAIN')
      if (error instanceof PackOperationError) throw error
      return fail('OPERATION_WRITE_FAILED')
    } finally {
      // Delete only this transaction's unique temporary, never journal/locks/jobs.
      if (temporary) await unlink(temporary).catch(() => {})
    }
  }
  async function transaction<T>(create: boolean, action: (document: Journal) => { value: T; changed?: boolean }): Promise<T> {
    const opened = await directory(create)
    if (!opened) return action({ schemaVersion: 1, revision: 0, jobs: [] }).value
    let held: FileHandle | undefined
    try {
      held = await acquire(opened, '.operations.lock', lockTimeoutMs)
      if (!held) fail('LOCK_TIMEOUT')
      const current = await readDocument(opened)
      const next = copy(current.document)
      const { value, changed } = action(next)
      if (changed || create && !current.exists) {
        if (next.revision >= Number.MAX_SAFE_INTEGER) fail('OPERATION_LIMIT')
        next.revision++
        await writeDocument(opened, held, current.document, next)
      }
      return copy(value)
    } finally {
      await held?.close().catch(() => {})
      await opened.close().catch(() => {})
    }
  }
  function available(): void { if (closed) fail('OPERATION_CLOSED'); if (fatal) throw fatal }
  const updated = (job: PackOperationJob) => new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString()
  async function alter(id: string, action: (job: PackOperationJob) => void): Promise<void> {
    await transaction(true, journal => {
      const job = journal.jobs.find(item => item.operationId === id)
      if (!job) fail('OPERATION_NOT_FOUND')
      action(job); job.updatedAt = updated(job)
      return { value: null, changed: true }
    })
  }
  async function completed(id: string, value: PackOperationResult): Promise<void> {
    await alter(id, job => {
      job.result = value
      if (value.outcome === 'installed_not_enabled') {
        job.status = 'failed'; job.phase = 'failed'; job.errorCode = value.errorCode ?? 'OPERATION_FAILED'
      } else { job.status = 'succeeded'; job.phase = 'completed'; delete job.errorCode }
    })
  }
  async function interrupted(id: string, code = 'OPERATION_INTERRUPTED'): Promise<void> {
    await alter(id, job => { job.status = 'interrupted'; job.phase = 'interrupted'; job.errorCode = code; delete job.result })
  }
  async function recoverRunning(): Promise<void> {
    const running = await transaction(false, document => ({ value: document.jobs.filter(job => job.status === 'running') }))
    for (const job of running) {
      await alter(job.operationId, item => { item.phase = 'recovering' })
      let recovered: PackOperationResult | null
      try { const value = await recover(copy(job.request)); recovered = value === null ? null : result(value) }
      catch (error) { await interrupted(job.operationId, sanitizePackOperationError(error)); continue }
      if (recovered) await completed(job.operationId, recovered)
      else await interrupted(job.operationId)
    }
  }
  async function executeJob(job: PackOperationJob): Promise<void> {
    let recovered: PackOperationResult | null
    try { const value = await recover(copy(job.request)); recovered = value === null ? null : result(value) }
    catch (error) { await interrupted(job.operationId, sanitizePackOperationError(error)); return }
    if (recovered) { await completed(job.operationId, recovered); return }
    let progress = Promise.resolve(), acceptsProgress = true
    const reportProgress = (phase: PackOperationPhase): Promise<void> => {
      if (!OPERATION_PHASES.includes(phase) || ['queued', 'completed', 'failed', 'interrupted'].includes(phase)) {
        const rejected = Promise.reject<void>(new PackOperationError('OPERATION_INVALID'))
        rejected.catch(() => {})
        return rejected
      }
      if (!acceptsProgress) return Promise.resolve()
      progress = progress.then(() => alter(job.operationId, current => {
        if (current.status !== 'running') fail('OPERATION_STORAGE_CORRUPT')
        current.phase = phase
      }))
      progress.catch(() => {})
      return progress
    }
    let value: PackOperationResult | undefined, failure: unknown
    try { value = result(await execute(copy(job.request), reportProgress)) } catch (error) { failure = error }
    acceptsProgress = false
    // Even a fire-and-forget progress callback must be durable before completion.
    await progress
    if (value) { await completed(job.operationId, value); return }
    // A thrown exception may follow a successful local commit. Ask the local
    // receipt reader, not the remote center, before declaring failure.
    try {
      const recoveredResult = await recover(copy(job.request))
      if (recoveredResult !== null) { await completed(job.operationId, result(recoveredResult)); return }
    } catch (error) { await interrupted(job.operationId, sanitizePackOperationError(error)); return }
    const code = sanitizePackOperationError(failure)
    if (code.endsWith('_COMMIT_UNCERTAIN') || code === 'OPERATION_INVALID_RESULT') {
      await interrupted(job.operationId, code); return
    }
    await alter(job.operationId, current => {
      current.status = 'failed'; current.phase = 'failed'; current.errorCode = code; delete current.result
    })
  }
  async function releaseRunner(): Promise<void> {
    const held = runner; runner = undefined
    await held?.lock.close().catch(() => {})
    await held?.directory.close().catch(() => {})
  }
  async function takeRunner(): Promise<void> {
    if (runner) return
    const opened = await directory(true)
    if (!opened) fail('OPERATION_WRITE_FAILED')
    let held: FileHandle | undefined
    try {
      held = await acquire(opened, '.operations.runner.lock', 0)
      if (!held) return
      runner = { directory: opened, lock: held }
    } finally { if (!held) await opened.close().catch(() => {}) }
    try { await recoverRunning() } catch (error) { await releaseRunner(); throw error }
  }
  function schedule(): void {
    if (!started || closed || fatal || timer) return
    timer = setTimeout(() => { timer = undefined; wake() }, 500)
    timer.unref()
  }
  function wake(): void {
    if (!started || closed || fatal || tickPromise) return
    if (timer) { clearTimeout(timer); timer = undefined }
    tickPromise = (async () => {
      await takeRunner()
      if (!runner) return
      while (!closed) {
        await assertLock(runner.directory, runner.lock, '.operations.runner.lock')
        const next = await transaction(true, journal => {
          const job = journal.jobs.find(item => item.status === 'queued')
          if (!job) return { value: null }
          job.status = 'running'; job.phase = 'preparing'; job.updatedAt = updated(job)
          return { value: job, changed: true }
        })
        if (!next) break
        await executeJob(next)
      }
    })().catch(async error => {
      fatal = new PackOperationError(sanitizePackOperationError(error))
      await releaseRunner()
    }).finally(() => { tickPromise = undefined; schedule() })
  }
  async function start(): Promise<void> {
    available()
    if (startPromise) return startPromise
    startPromise = (async () => {
      await transaction(true, () => ({ value: null }))
      // Only local reconciliation may delay startup; no executor/network work.
      await takeRunner()
      if (closed) return
      started = true; wake()
    })()
    try { await startPromise } catch (error) {
      startPromise = undefined
      fatal = new PackOperationError(sanitizePackOperationError(error))
      throw fatal
    }
  }
  async function enqueue(input: PackOperationRequest): Promise<PackOperationJob> {
    available()
    const request = validatePackOperationRequest(input)
    const id = operationId(request)
    const job = await transaction(true, journal => {
      const existing = journal.jobs.find(item => item.operationId === id)
      if (existing) {
        if (canonicalStateJson(existing.request) !== canonicalStateJson(request)) fail('IDEMPOTENCY_CONFLICT')
        return { value: existing }
      }
      if (journal.jobs.length >= MAX_PACK_OPERATIONS) fail('OPERATION_LIMIT')
      const now = new Date().toISOString()
      const value: PackOperationJob = { operationId: id, request, status: 'queued', phase: 'queued', createdAt: now, updatedAt: now }
      journal.jobs.push(value)
      return { value, changed: true }
    })
    wake()
    return job
  }
  async function get(id: string): Promise<PackOperationJob | null> {
    validateId(id)
    if (fatal) throw fatal
    return transaction(false, journal => ({ value: journal.jobs.find(job => job.operationId === id) ?? null }))
  }
  async function list(): Promise<PackOperationJob[]> {
    if (fatal) throw fatal
    return transaction(false, journal => ({ value: journal.jobs }))
  }
  async function retry(id: string): Promise<PackOperationJob> {
    available(); validateId(id)
    const job = await transaction(true, journal => {
      const value = journal.jobs.find(item => item.operationId === id)
      if (!value) fail('OPERATION_NOT_FOUND')
      if (!['failed', 'interrupted'].includes(value.status)) return { value }
      value.status = 'queued'; value.phase = 'queued'; value.updatedAt = updated(value)
      delete value.result; delete value.errorCode
      return { value, changed: true }
    })
    wake()
    return job
  }
  /** Stops new scheduling; waits for the current executor/progress/commit to
   * finish, then releases its flock. It does not abort an in-flight commit. */
  async function close(): Promise<void> {
    closed = true
    if (timer) { clearTimeout(timer); timer = undefined }
    await startPromise?.catch(() => {})
    await tickPromise?.catch(() => {})
    await releaseRunner()
  }
  return { enqueue, get, list, retry, start, close }
}
export type PackOperationQueue = ReturnType<typeof createPackOperationQueue>
