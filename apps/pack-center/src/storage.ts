import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { canonicalBytes } from '../../../packages/pack-contract/index.mjs'

export const DEFAULT_ARTIFACT_MAX_BYTES = 160 * 1024 * 1024
export const HARD_ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024
const KEY = /^sha256\/([0-9a-f]{64})$/
const DIGEST = /^[0-9a-f]{64}$/

export class ArtifactStorageError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.name = 'ArtifactStorageError'; this.code = code }
}
export interface ArtifactDescriptor { key: string; sha256: string; sizeBytes: number }
export interface StorageLimits { maxBytes?: number }
export type StorageFaultPoint = 'after-data-sync' | 'after-publish' | 'after-directory-sync'
export interface LocalArtifactStoreOptions extends StorageLimits {
  /** Test-only crash injection. Never provide from a remotely supplied request. */
  fault?: (point: StorageFaultPoint) => void | Promise<void>
}
export interface VerifiedArtifactStream extends ArtifactDescriptor { stream: Readable }

function fail(code: string, message: string): never { throw new ArtifactStorageError(code, message) }
function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code }
function limit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 0 || result > HARD_ARTIFACT_MAX_BYTES) {
    fail('STORAGE_LIMIT', 'Artifact byte limit is invalid')
  }
  return Math.min(result, fallback)
}
function parseKey(key: string): string {
  if (typeof key !== 'string' || key.length !== 71) fail('STORAGE_BAD_KEY', 'Artifact key must be a content-addressed key')
  const match = KEY.exec(key)
  if (!match) fail('STORAGE_BAD_KEY', 'Artifact key must be a content-addressed key')
  return match[1]!
}
function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
}
function regular(stat: BigIntStats, immutable = false): void {
  if (!stat.isFile() || stat.nlink !== 1n || (immutable && (stat.mode & 0o777n) !== 0o400n)) {
    fail('STORAGE_UNSAFE_PATH', 'Artifact must be an unlinked regular private file')
  }
}
async function privateDirectory(path: string, create = false): Promise<void> {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }) } catch (error) { if (errorCode(error) !== 'EEXIST') throw error }
  }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o7777) !== 0o700
    || (process.geteuid && info.uid !== process.geteuid()) || await realpath(path) !== path) {
    fail('STORAGE_UNSAFE_PATH', 'Artifact directories must be real, owned, private directories with mode 0700')
  }
}
async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await fd.sync() } finally { await fd.close() }
}
async function removeOwnStaging(path: string): Promise<void> {
  try { await unlink(join(path, 'data')) } catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
  try { await rmdir(path) } catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
}

/** Private local-volume adapter. Authorization and signing belong to the caller; this is not S3. */
export class LocalArtifactStore {
  readonly root: string
  readonly maxBytes: number
  private readonly incoming: string
  private readonly objects: string
  private readonly fault?: LocalArtifactStoreOptions['fault']

  private constructor(root: string, options: LocalArtifactStoreOptions) {
    this.root = root
    this.incoming = join(root, '.incoming')
    this.objects = join(root, 'sha256')
    this.maxBytes = limit(options.maxBytes, HARD_ARTIFACT_MAX_BYTES)
    if (options.maxBytes === undefined) this.maxBytes = DEFAULT_ARTIFACT_MAX_BYTES
    this.fault = options.fault
  }

  static async create(root: string, options: LocalArtifactStoreOptions = {}): Promise<LocalArtifactStore> {
    if (typeof root !== 'string' || !root || root.includes('\0')) fail('STORAGE_UNSAFE_PATH', 'Storage root is invalid')
    const absolute = resolve(root)
    // The parent must already exist. Never follow a symlink or recursively create an unrelated tree.
    if (await realpath(dirname(absolute)) !== dirname(absolute)) fail('STORAGE_UNSAFE_PATH', 'Storage parent must be a real directory')
    const store = new LocalArtifactStore(absolute, options)
    await privateDirectory(absolute, true)
    await privateDirectory(store.incoming, true)
    await privateDirectory(store.objects, true)
    await syncDirectory(absolute)
    await syncDirectory(dirname(absolute))
    return store
  }

  private async ready(): Promise<void> {
    await privateDirectory(this.root)
    await privateDirectory(this.incoming)
    await privateDirectory(this.objects)
  }

  private async openVerified(key: string, limits: StorageLimits = {}): Promise<{ descriptor: ArtifactDescriptor; fd: FileHandle; stat: BigIntStats }> {
    const sha256 = parseKey(key)
    const maxBytes = limit(limits.maxBytes, this.maxBytes)
    await this.ready()
    const object = join(this.objects, sha256)
    await privateDirectory(object)
    const fd = await open(join(object, 'data'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await fd.stat({ bigint: true })
      regular(stat, true)
      if (stat.size > BigInt(maxBytes)) fail('STORAGE_LIMIT', 'Artifact exceeds the allowed byte limit')
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(CHUNK_BYTES)
      let position = 0
      while (true) {
        const result = await fd.read(buffer, 0, Math.min(CHUNK_BYTES, maxBytes - position + 1), position)
        if (result.bytesRead === 0) break
        position += result.bytesRead
        if (position > maxBytes) fail('STORAGE_LIMIT', 'Artifact exceeds the allowed byte limit')
        hash.update(buffer.subarray(0, result.bytesRead))
      }
      const after = await fd.stat({ bigint: true })
      regular(after, true)
      if (!unchanged(stat, after) || position !== Number(stat.size) || hash.digest('hex') !== sha256) {
        fail('STORAGE_HASH_MISMATCH', 'Stored artifact does not match its content-addressed key')
      }
      return { descriptor: { key, sha256, sizeBytes: position }, fd, stat: after }
    } catch (error) { await fd.close(); throw error }
  }

  async verify(key: string, limits: StorageLimits = {}): Promise<ArtifactDescriptor> {
    const opened = await this.openVerified(key, limits)
    try { return opened.descriptor } finally { await opened.fd.close() }
  }

  async openStream(key: string, limits: StorageLimits = {}): Promise<VerifiedArtifactStream> {
    const { descriptor, fd, stat } = await this.openVerified(key, limits)
    // Keep the exact verified FD; reopening by path after validation creates a TOCTOU vulnerability.
    const read = async function* (): AsyncGenerator<Buffer> {
      try {
        if (!unchanged(stat, await fd.stat({ bigint: true }))) fail('STORAGE_HASH_MISMATCH', 'Artifact changed after verification')
        const hash = createHash('sha256')
        let position = 0
        while (position < descriptor.sizeBytes) {
          const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, descriptor.sizeBytes - position))
          const result = await fd.read(buffer, 0, buffer.byteLength, position)
          if (!result.bytesRead) fail('STORAGE_HASH_MISMATCH', 'Artifact was truncated during read')
          position += result.bytesRead
          const chunk = buffer.subarray(0, result.bytesRead)
          hash.update(chunk)
          yield chunk
        }
        const after = await fd.stat({ bigint: true })
        regular(after, true)
        if (!unchanged(stat, after) || hash.digest('hex') !== descriptor.sha256) {
          fail('STORAGE_HASH_MISMATCH', 'Artifact changed during read')
        }
      } finally { await fd.close() }
    }
    const stream = Readable.from(read(), { objectMode: false })
    // Also close when a caller abandons the stream before its first read.
    stream.once('close', () => { void fd.close().catch(() => {}) })
    return { ...descriptor, stream }
  }

  async getBytes(key: string, limits: StorageLimits = {}): Promise<Buffer> {
    const { stream } = await this.openStream(key, limits)
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  }

  private async publish(chunks: AsyncIterable<Uint8Array>, expectedSha256: string | undefined, limits: StorageLimits): Promise<ArtifactDescriptor> {
    if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || expectedSha256.length !== 64 || !DIGEST.test(expectedSha256))) fail('STORAGE_BAD_KEY', 'Expected SHA-256 must be lowercase hexadecimal')
    const maxBytes = limit(limits.maxBytes, this.maxBytes)
    await this.ready()
    const staging = join(this.incoming, randomUUID())
    await mkdir(staging, { mode: 0o700 })
    let published = false
    try {
      const data = await open(join(staging, 'data'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const hash = createHash('sha256')
      let sizeBytes = 0
      try {
        for await (const chunk of chunks) {
          sizeBytes += chunk.byteLength
          if (sizeBytes > maxBytes) fail('STORAGE_LIMIT', 'Artifact exceeds the allowed byte limit')
          hash.update(chunk)
          let written = 0
          while (written < chunk.byteLength) {
            const result = await data.write(chunk, written, chunk.byteLength - written)
            if (!result.bytesWritten) fail('STORAGE_IO', 'Artifact write made no progress')
            written += result.bytesWritten
          }
        }
        await data.chmod(0o400)
        await data.sync()
      } finally { await data.close() }
      const sha256 = hash.digest('hex')
      if (expectedSha256 !== undefined && expectedSha256 !== sha256) fail('STORAGE_HASH_MISMATCH', 'Source bytes do not match the expected SHA-256')
      await syncDirectory(staging)
      await this.fault?.('after-data-sync')
      const descriptor = { key: `sha256/${sha256}`, sha256, sizeBytes }
      const destination = join(this.objects, sha256)
      // A complete nonempty directory is the atomic CAS unit. POSIX rename cannot replace an
      // existing nonempty directory, unlike rename(file,file); concurrent writers never overwrite.
      let exists = false
      try { await lstat(destination); exists = true } catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
      if (exists) {
        const existing = await this.verify(descriptor.key, { maxBytes })
        if (existing.sizeBytes !== sizeBytes) fail('STORAGE_HASH_MISMATCH', 'Existing artifact does not match source bytes')
        await syncDirectory(this.objects)
        return existing
      }
      try { await rename(staging, destination); published = true } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(errorCode(error) ?? '')) throw error
        const existing = await this.verify(descriptor.key, { maxBytes })
        if (existing.sizeBytes !== sizeBytes) fail('STORAGE_HASH_MISMATCH', 'Existing artifact does not match source bytes')
        await syncDirectory(this.objects)
        return existing
      }
      await this.fault?.('after-publish')
      await syncDirectory(this.objects)
      await syncDirectory(this.incoming)
      await this.fault?.('after-directory-sync')
      return descriptor
    } finally {
      // Never remove an object from sha256/. A crash can leave private, non-distributed staging.
      if (!published) await removeOwnStaging(staging)
    }
  }

  async putFile(sourceFile: string, expectedSha256?: string, limits: StorageLimits = {}): Promise<ArtifactDescriptor> {
    const path = resolve(sourceFile)
    if (await realpath(path) !== path) fail('STORAGE_UNSAFE_PATH', 'Source file must not use symbolic links')
    const maxBytes = limit(limits.maxBytes, this.maxBytes)
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await fd.stat({ bigint: true })
      regular(before)
      if (before.size > BigInt(maxBytes)) fail('STORAGE_LIMIT', 'Artifact exceeds the allowed byte limit')
      async function* read(): AsyncGenerator<Buffer> {
        let position = 0
        while (true) {
          const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, maxBytes - position + 1))
          const result = await fd.read(buffer, 0, buffer.byteLength, position)
          if (!result.bytesRead) break
          position += result.bytesRead
          if (position > maxBytes) fail('STORAGE_LIMIT', 'Artifact exceeds the allowed byte limit')
          yield buffer.subarray(0, result.bytesRead)
        }
        const after = await fd.stat({ bigint: true })
        regular(after)
        if (!unchanged(before, after) || position !== Number(before.size)) fail('STORAGE_SOURCE_CHANGED', 'Source file changed during storage')
      }
      return await this.publish(read(), expectedSha256, { maxBytes })
    } finally { await fd.close() }
  }

  async putJson(value: unknown, limits: StorageLimits = {}): Promise<ArtifactDescriptor> {
    const bytes = canonicalBytes(value)
    async function* read(): AsyncGenerator<Buffer> { yield bytes }
    return this.publish(read(), undefined, limits)
  }
}

export function createLocalArtifactStore(root: string, options: LocalArtifactStoreOptions = {}): Promise<LocalArtifactStore> {
  return LocalArtifactStore.create(root, options)
}
