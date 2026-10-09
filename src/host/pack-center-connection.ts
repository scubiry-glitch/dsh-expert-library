/** Host-only credential persistence. Never serialize read() into a browser RPC. */
import { spawn } from 'node:child_process'
import { createHash, createPublicKey, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { canonicalStateJson } from './pack-center-state.ts'

export interface StoredPackCenterConnection {
  origin: string
  centerId: string
  organizationId: string
  deploymentId: string
  credentialId: string
  /** Null removes remote access while preserving identity and offline signature pins. */
  credentialToken: string | null
  credentialExpiresAt: string
  boundAt: string
  /** Independently confirmed Ed25519 SPKI public keys, never fetched trust-on-first-use. */
  trustedSigningKeys: Record<string, string>
}

export interface PackCenterConnectionSnapshot {
  revision: number
  connection: StoredPackCenterConnection | null
}

export type PackCenterConnectionErrorCode =
  | 'CONNECTION_INVALID' | 'CONNECTION_UNSAFE_PATH' | 'CONNECTION_CORRUPT'
  | 'CONNECTION_READ_FAILED' | 'CONNECTION_WRITE_FAILED' | 'CONNECTION_COMMIT_UNCERTAIN'
  | 'REVISION_CONFLICT' | 'LOCK_UNAVAILABLE' | 'LOCK_TIMEOUT' | 'LOCK_LOST'

export class PackCenterConnectionError extends Error {
  readonly code: PackCenterConnectionErrorCode
  constructor(code: PackCenterConnectionErrorCode) {
    const messages: Record<PackCenterConnectionErrorCode, string> = {
      CONNECTION_INVALID: 'Invalid private center connection data',
      CONNECTION_UNSAFE_PATH: 'Private center storage permissions or file identity are unsafe',
      CONNECTION_CORRUPT: 'Private center connection is invalid; original data is preserved',
      CONNECTION_READ_FAILED: 'Cannot read private center connection',
      CONNECTION_WRITE_FAILED: 'Private center connection was not replaced',
      CONNECTION_COMMIT_UNCERTAIN: 'Private connection may be committed; read its current revision before retrying',
      REVISION_CONFLICT: 'Center connection changed; refresh before retrying',
      LOCK_UNAVAILABLE: 'A safe private connection lock is unavailable; util-linux flock is required',
      LOCK_TIMEOUT: 'Another process is changing the center connection',
      LOCK_LOST: 'Private connection lock or directory identity changed before commit',
    }
    super(messages[code])
    this.name = 'PackCenterConnectionError'
    this.code = code
  }
}

const maximumBytes = 64 * 1024
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code
function fail(code: PackCenterConnectionErrorCode): never { throw new PackCenterConnectionError(code) }
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value))
const validId = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) && !value.includes('..')
  && !['__proto__', 'prototype', 'constructor'].includes(value)

function detached(value: unknown): unknown {
  try {
    const json = canonicalStateJson(value)
    if (Buffer.byteLength(json) > maximumBytes) fail('CONNECTION_INVALID')
    return JSON.parse(json)
  } catch { return fail('CONNECTION_INVALID') }
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function normalizeKeys(input: unknown): Record<string, string> {
  const value = detached(input)
  if (!plain(value) || Object.keys(value).length < 1 || Object.keys(value).length > 16) fail('CONNECTION_INVALID')
  const normalized: Record<string, string> = {}
  for (const keyId of Object.keys(value).sort()) {
    const pem = value[keyId]
    if (!validId(keyId) || typeof pem !== 'string' || pem.length > 2048
      || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\r?\n?$/.test(pem)) fail('CONNECTION_INVALID')
    try {
      const key = createPublicKey({ key: pem, type: 'spki', format: 'pem' })
      if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') fail('CONNECTION_INVALID')
      normalized[keyId] = key.export({ type: 'spki', format: 'pem' }).toString()
    } catch { fail('CONNECTION_INVALID') }
  }
  return normalized
}

/** SHA-256 over the canonical DER SubjectPublicKeyInfo, represented as lower-case hex. */
export function signingKeyFingerprints(keys: Record<string, string>): Record<string, string> {
  const normalized = normalizeKeys(keys)
  const result: Record<string, string> = {}
  for (const [keyId, pem] of Object.entries(normalized)) {
    const der = createPublicKey(pem).export({ type: 'spki', format: 'der' })
    result[keyId] = createHash('sha256').update(der).digest('hex')
  }
  return result
}

function normalizeConnection(input: unknown, allowLoopbackHttp: boolean): StoredPackCenterConnection | null {
  const value = detached(input)
  if (value === null) return null
  if (!plain(value) || !exactKeys(value, ['origin', 'centerId', 'organizationId', 'deploymentId', 'credentialId',
    'credentialToken', 'credentialExpiresAt', 'boundAt', 'trustedSigningKeys'])) fail('CONNECTION_INVALID')
  for (const key of ['centerId', 'organizationId', 'deploymentId', 'credentialId']) if (!validId(value[key])) fail('CONNECTION_INVALID')
  if (value.credentialToken !== null && (typeof value.credentialToken !== 'string'
    || !/^dpc_token_[A-Za-z0-9_-]{43}$/.test(value.credentialToken))) fail('CONNECTION_INVALID')
  if (typeof value.origin !== 'string' || value.origin.length > 2048 || /[\s\\]/.test(value.origin)) fail('CONNECTION_INVALID')
  let origin: string
  try {
    const url = new URL(value.origin)
    const localHttp = allowLoopbackHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || ![url.origin, `${url.origin}/`].includes(value.origin)) fail('CONNECTION_INVALID')
    origin = url.origin
  } catch { return fail('CONNECTION_INVALID') }
  for (const key of ['boundAt', 'credentialExpiresAt']) {
    if (typeof value[key] !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value[key] as string)) fail('CONNECTION_INVALID')
    const date = new Date(value[key] as string)
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value[key]) fail('CONNECTION_INVALID')
  }
  if (Date.parse(value.credentialExpiresAt as string) <= Date.parse(value.boundAt as string)) fail('CONNECTION_INVALID')
  return {
    origin, centerId: value.centerId as string, organizationId: value.organizationId as string,
    deploymentId: value.deploymentId as string, credentialId: value.credentialId as string,
    credentialToken: value.credentialToken, credentialExpiresAt: value.credentialExpiresAt as string,
    boundAt: value.boundAt as string, trustedSigningKeys: normalizeKeys(value.trustedSigningKeys),
  }
}

/** Explicit metadata projection. No token, public-key text, storage path, or spread of host data. */
export function publicView(input: PackCenterConnectionSnapshot) {
  const value = detached(input)
  if (!plain(value) || !exactKeys(value, ['revision', 'connection']) || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0) fail('CONNECTION_INVALID')
  // Projection can describe loopback fixtures; production persistence still refuses HTTP by default.
  const connection = normalizeConnection(value.connection, true)
  return {
    revision: value.revision as number,
    connection: connection === null ? null : {
      origin: connection.origin, centerId: connection.centerId, organizationId: connection.organizationId,
      deploymentId: connection.deploymentId, credentialId: connection.credentialId,
      credentialExpiresAt: connection.credentialExpiresAt, boundAt: connection.boundAt,
      bound: connection.credentialToken !== null,
      signingKeyFingerprints: signingKeyFingerprints(connection.trustedSigningKeys),
    },
  }
}

export type PublicPackCenterConnection = ReturnType<typeof publicView>

function checkStat(stat: Stats, directory: boolean): void {
  const uid = process.getuid?.()
  if (uid === undefined || stat.uid !== uid || (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600)
    || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('CONNECTION_UNSAFE_PATH')
}

function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino }

/** Linux-only, like pack-center-state. Persistent flock inode is never removed or replaced. */
export function createPackCenterConnectionStore(root: string, options: { lockTimeoutMs?: number; allowLoopbackHttp?: boolean } = {}) {
  const broad = new Set(['/', '/root', '/home', '/tmp', '/var', '/var/tmp', '/var/lib', '/usr', '/usr/lib', '/etc', '/run',
    homedir(), process.cwd(), dirname(process.cwd())])
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || root.includes('\0')
    || root.split('/').filter(Boolean).length < 2 || broad.has(root)) fail('CONNECTION_UNSAFE_PATH')
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 120_000
    || (options.allowLoopbackHttp !== undefined && typeof options.allowLoopbackHttp !== 'boolean')) fail('CONNECTION_INVALID')
  const allowLoopbackHttp = options.allowLoopbackHttp === true

  async function directory(create: boolean): Promise<FileHandle | undefined> {
    let opened: FileHandle | undefined
    try {
      // Reject symbolic links in every existing component, including an absent leaf's parents.
      const components = root.slice(parse(root).root.length).split('/')
      let path = parse(root).root
      for (let index = 0; index < components.length; index++) {
        path = join(path, components[index]!)
        let info: Stats
        try { info = await lstat(path) } catch (error) {
          if (errno(error) !== 'ENOENT') throw error
          if (!create) return undefined
          await mkdir(path, { mode: 0o700 }).catch(error => { if (errno(error) !== 'EEXIST') throw error })
          const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          try { await parent.sync() } finally { await parent.close() }
          info = await lstat(path)
        }
        if (!info.isDirectory() || info.isSymbolicLink()) fail('CONNECTION_UNSAFE_PATH')
      }
      if (await realpath(root) !== root) fail('CONNECTION_UNSAFE_PATH')
      opened = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      checkStat(await opened.stat(), true)
      if (!sameFile(await opened.stat(), await lstat(root))) fail('CONNECTION_UNSAFE_PATH')
      return opened
    } catch (error) {
      await opened?.close().catch(() => {})
      if (error instanceof PackCenterConnectionError) throw error
      return fail(create ? 'CONNECTION_WRITE_FAILED' : 'CONNECTION_READ_FAILED')
    }
  }

  const anchor = (directory: FileHandle) => `/proc/self/fd/${directory.fd}`
  async function assertDirectory(directory: FileHandle): Promise<void> {
    try {
      const info = await directory.stat()
      checkStat(info, true)
      if (await realpath(root) !== root || !sameFile(info, await lstat(root))) fail('LOCK_LOST')
    } catch (error) {
      if (error instanceof PackCenterConnectionError) throw error
      fail('LOCK_LOST')
    }
  }

  async function readDocument(directory: FileHandle): Promise<PackCenterConnectionSnapshot> {
    let file: FileHandle | undefined
    try {
      await assertDirectory(directory)
      const path = join(anchor(directory), 'connection.json')
      let info: Stats
      try { info = await lstat(path) } catch (error) {
        if (errno(error) === 'ENOENT') return { revision: 0, connection: null }
        throw error
      }
      checkStat(info, false)
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const opened = await file.stat()
      checkStat(opened, false)
      if (!sameFile(info, opened)) fail('CONNECTION_UNSAFE_PATH')
      if (opened.size > maximumBytes) fail('CONNECTION_CORRUPT')
      const bytes = Buffer.alloc(maximumBytes + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      const after = await file.stat()
      checkStat(after, false)
      if (length > maximumBytes || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) fail('CONNECTION_CORRUPT')
      const raw = bytes.subarray(0, length).toString('utf8')
      try {
        const parsed: unknown = JSON.parse(raw)
        if (!plain(parsed) || !exactKeys(parsed, ['schemaVersion', 'revision', 'connection']) || parsed.schemaVersion !== 1
          || !Number.isSafeInteger(parsed.revision) || (parsed.revision as number) < 1) fail('CONNECTION_CORRUPT')
        const connection = normalizeConnection(parsed.connection, allowLoopbackHttp)
        const document = { schemaVersion: 1, revision: parsed.revision as number, connection }
        // Our private format is canonical-only: this also rejects duplicate keys and lossy JSON coercions.
        if (raw !== `${canonicalStateJson(document)}\n`) fail('CONNECTION_CORRUPT')
        return { revision: document.revision, connection }
      } catch { return fail('CONNECTION_CORRUPT') }
    } catch (error) {
      if (error instanceof PackCenterConnectionError) throw error
      return fail('CONNECTION_READ_FAILED')
    } finally { await file?.close().catch(() => {}) }
  }

  async function read(): Promise<PackCenterConnectionSnapshot> {
    const opened = await directory(false)
    if (!opened) return { revision: 0, connection: null }
    try { return await readDocument(opened) } finally { await opened.close().catch(() => {}) }
  }

  async function lock(directory: FileHandle): Promise<FileHandle> {
    let file: FileHandle | undefined
    try {
      file = await open(join(anchor(directory), '.connection.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
      checkStat(await file.stat(), false)
      const child = spawn('flock', ['--exclusive', '--timeout', String(lockTimeoutMs / 1000), '--conflict-exit-code', '73', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', file.fd],
      })
      await new Promise<void>((resolveReady, rejectReady) => {
        child.once('error', () => rejectReady(new PackCenterConnectionError('LOCK_UNAVAILABLE')))
        child.once('close', code => code === 0 ? resolveReady() : rejectReady(new PackCenterConnectionError(code === 73 ? 'LOCK_TIMEOUT' : 'LOCK_UNAVAILABLE')))
      })
      await assertDirectory(directory)
      if (!sameFile(await file.stat(), await lstat(join(anchor(directory), '.connection.lock')))) fail('LOCK_LOST')
      return file
    } catch (error) {
      await file?.close().catch(() => {})
      if (error instanceof PackCenterConnectionError) throw error
      return fail('LOCK_UNAVAILABLE')
    }
  }

  /**
   * Linearize a host-only operation against bind/unbind without exposing secrets.
   * Lock ordering is always connection -> inventory. The callback must not call
   * write/withRevision on this connection, or acquire the same locks in reverse.
   * Callback failures propagate unchanged; its own transaction owns its outcome.
   */
  async function withRevision<T>(expectedRevision: number, action: () => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof action !== 'function') fail('CONNECTION_INVALID')
    const opened = await directory(true)
    if (!opened) return fail('CONNECTION_WRITE_FAILED')
    let held: FileHandle | undefined
    try {
      held = await lock(opened)
      const current = await readDocument(opened)
      if (current.revision !== expectedRevision) fail('REVISION_CONFLICT')
      return await action()
    } finally {
      await held?.close().catch(() => {})
      await opened.close().catch(() => {})
    }
  }

  async function write(input: StoredPackCenterConnection | null, expectedRevision: number): Promise<PackCenterConnectionSnapshot> {
    // Capture all caller data before awaiting; accessors/proxies must never be invoked.
    const connection = normalizeConnection(input, allowLoopbackHttp)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) fail('CONNECTION_INVALID')
    const opened = await directory(true)
    if (!opened) return fail('CONNECTION_WRITE_FAILED')
    let held: FileHandle | undefined
    let temporary: string | undefined
    let committed = false
    try {
      held = await lock(opened)
      const current = await readDocument(opened)
      if (current.revision !== expectedRevision) fail('REVISION_CONFLICT')
      if (current.connection !== null && connection === null) fail('CONNECTION_INVALID')
      const next = { revision: current.revision + 1, connection }
      const json = `${canonicalStateJson({ schemaVersion: 1, ...next })}\n`
      if (Buffer.byteLength(json) > maximumBytes) fail('CONNECTION_INVALID')
      temporary = join(anchor(opened), `.connection.${process.pid}.${randomUUID()}.tmp`)
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        checkStat(await file.stat(), false)
        await file.writeFile(json, 'utf8')
        await file.sync()
      } finally { await file.close() }
      await assertDirectory(opened)
      checkStat(await held.stat(), false)
      if (!sameFile(await held.stat(), await lstat(join(anchor(opened), '.connection.lock')))) fail('LOCK_LOST')
      // Refuse newly introduced corruption/aliases immediately before replacement.
      if (canonicalStateJson(await readDocument(opened)) !== canonicalStateJson(current)) fail('REVISION_CONFLICT')
      await rename(temporary, join(anchor(opened), 'connection.json'))
      committed = true
      await opened.sync()
      return next
    } catch (error) {
      if (committed) return fail('CONNECTION_COMMIT_UNCERTAIN')
      if (error instanceof PackCenterConnectionError) throw error
      return fail('CONNECTION_WRITE_FAILED')
    } finally {
      // Only this operation's unique staging file; never delete current/previous credentials or inventory.
      if (temporary) await unlink(temporary).catch(() => {})
      await held?.close().catch(() => {})
      await opened.close().catch(() => {})
    }
  }

  return { read, write, withRevision, publicView }
}

export type PackCenterConnectionStore = ReturnType<typeof createPackCenterConnectionStore>
