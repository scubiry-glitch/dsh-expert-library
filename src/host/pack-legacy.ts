/**
 * Local-only legacy takeover preparation. A backup is not a center approval.
 * This module never changes state.json or the vendor tree. The host atomically
 * commits the returned record and exact-path suppression in a later transaction.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { canonicalBytes, hashContentDirectory } from '#pack-contract'
import { DEFAULT_LIMITS, extractArtifact, packDirectory } from '#pack-artifact'
import { loadPackFromDir, type DomainPackV2 } from '../pack-validator.ts'
import { validatePackCenterState, type InstalledPackRecord, type LegacySuppression } from './pack-center-state.ts'

export class PackLegacyError extends Error {
  readonly code: string
  readonly details: Readonly<Record<string, unknown>>
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'PackLegacyError'
    this.code = code
    this.details = details
  }
}

interface LegacyReceipt {
  schemaVersion: 1
  source: 'legacy'
  releaseId: string
  packId: string
  version: string
  contentTreeSha256: string
  artifactSha256: string
  sizeBytes: number
  fileCount: number
  contentSizeBytes: number
}

export interface PreparedLegacySnapshot {
  record: InstalledPackRecord
  vendorPath: string
  suppression: LegacySuppression
}

const digestPattern = /^[a-f0-9]{64}$/
const receiptKeys = ['schemaVersion', 'source', 'releaseId', 'packId', 'version', 'contentTreeSha256', 'artifactSha256', 'sizeBytes', 'fileCount', 'contentSizeBytes']
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code
function fail(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new PackLegacyError(code, message, details)
}
function absolute(path: string): void {
  if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path) || resolve(path) !== path) {
    fail('LEGACY_PATH_UNSAFE', 'Legacy paths must be absolute and normalized')
  }
}
function separate(root: string, vendorPath: string): void {
  absolute(root); absolute(vendorPath)
  if (root === vendorPath || vendorPath.startsWith(root.endsWith(sep) ? root : `${root}${sep}`) || root.startsWith(vendorPath.endsWith(sep) ? vendorPath : `${vendorPath}${sep}`)) {
    fail('LEGACY_PATH_UNSAFE', 'The legacy source and local inventory must be disjoint trees')
  }
}
async function realDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    fail('LEGACY_PATH_UNSAFE', 'Legacy storage and sources must be real, non-symlink directories', { path })
  }
}
async function boundedJson(path: string, maximum = 1024 * 1024): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum) fail('LEGACY_RECEIPT_INVALID', 'Expected one bounded regular metadata file')
    return JSON.parse(await file.readFile('utf8')) as unknown
  } finally { await file.close() }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function syncTree(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const item = join(path, entry.name)
    if (entry.isDirectory()) await syncTree(item)
    else if (entry.isFile()) {
      const handle = await open(item, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await handle.sync() } finally { await handle.close() }
    } else fail('LEGACY_PATH_UNSAFE', 'Legacy snapshots contain only regular files and directories')
  }
  await syncDirectory(path)
}
async function mkdirReal(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }) } catch (error) { if (errno(error) !== 'EEXIST') throw error }
  await realDirectory(path)
}
function receiptOf(value: unknown): LegacyReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('LEGACY_RECEIPT_INVALID', 'Invalid local legacy receipt')
  const receipt = value as Record<string, unknown>
  if (Object.keys(receipt).length !== receiptKeys.length || receiptKeys.some(key => !Object.hasOwn(receipt, key))) {
    fail('LEGACY_RECEIPT_INVALID', 'Legacy receipt fields do not match schema v1')
  }
  if (receipt.schemaVersion !== 1 || receipt.source !== 'legacy' ||
    typeof receipt.contentTreeSha256 !== 'string' || !digestPattern.test(receipt.contentTreeSha256) ||
    typeof receipt.artifactSha256 !== 'string' || !digestPattern.test(receipt.artifactSha256) ||
    receipt.releaseId !== `legacy.${receipt.contentTreeSha256}` ||
    typeof receipt.packId !== 'string' || !receipt.packId || typeof receipt.version !== 'string' || !receipt.version) {
    fail('LEGACY_RECEIPT_INVALID', 'Legacy receipt identity is invalid')
  }
  for (const [key, maximum] of [['sizeBytes', DEFAULT_LIMITS.maxArchiveBytes], ['fileCount', DEFAULT_LIMITS.maxFiles], ['contentSizeBytes', DEFAULT_LIMITS.maxTotalBytes]] as const) {
    const number = receipt[key]
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0 || number > maximum) {
      fail('LEGACY_RECEIPT_INVALID', `Invalid receipt ${key}`)
    }
  }
  return receipt as unknown as LegacyReceipt
}
async function verifyArchive(path: string, receipt: LegacyReceipt): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(receipt.sizeBytes)) {
      fail('LEGACY_ARCHIVE_MISMATCH', 'Local legacy archive is missing, linked, or has changed size')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    for (let position = 0; position < receipt.sizeBytes;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, receipt.sizeBytes - position), position)
      if (!bytesRead) fail('LEGACY_ARCHIVE_MISMATCH', 'Legacy archive was truncated while being read')
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead
    }
    const after = await file.stat({ bigint: true })
    if (hash.digest('hex') !== receipt.artifactSha256 || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) {
      fail('LEGACY_ARCHIVE_MISMATCH', 'Local legacy archive no longer matches its receipt')
    }
  } finally { await file.close() }
}
async function verifySnapshot(root: string, digest: string): Promise<{ receipt: LegacyReceipt; pack: DomainPackV2 }> {
  absolute(root)
  if (!digestPattern.test(digest)) fail('LEGACY_RECORD_INVALID', 'Invalid legacy content digest')
  const directory = join(root, 'legacy', digest)
  for (const path of [root, join(root, 'legacy'), directory, join(directory, 'content')]) await realDirectory(path)
  const receipt = receiptOf(await boundedJson(join(directory, 'legacy.json')))
  if (receipt.contentTreeSha256 !== digest) fail('LEGACY_RECEIPT_INVALID', 'Legacy receipt is stored under the wrong content address')
  await verifyArchive(join(directory, 'artifact.tar'), receipt)
  const actual = await hashContentDirectory(join(directory, 'content'))
  if (actual.contentTreeSha256 !== digest || actual.fileCount !== receipt.fileCount || actual.sizeBytes !== receipt.contentSizeBytes) {
    fail('LEGACY_CONTENT_MISMATCH', 'Local legacy backup content has changed')
  }
  const loaded = await loadPackFromDir(join(directory, 'content'))
  if (!loaded.ok || !loaded.pack) fail('LEGACY_PACK_INVALID', 'Legacy backup failed V2 validation', { diagnostics: loaded.diagnostics })
  if (loaded.pack.pack.id !== receipt.packId || loaded.pack.pack.version !== receipt.version) {
    fail('LEGACY_IDENTITY_MISMATCH', 'Local receipt identity differs from its V2 content')
  }
  return { receipt, pack: loaded.pack }
}
function rethrow(error: unknown): never {
  if (error instanceof PackLegacyError) throw error
  const code = errno(error)
  throw new PackLegacyError('LEGACY_PREPARATION_FAILED', 'Legacy snapshot operation failed; source and state were not modified', { causeCode: typeof code === 'string' ? code : 'UNKNOWN' })
}

/** Creates a durable local backup, but does not activate or suppress any path. */
export async function prepareLegacySnapshot(storeRoot: string, vendorPath: string): Promise<PreparedLegacySnapshot> {
  let staging: string | undefined
  try {
    separate(storeRoot, vendorPath)
    await realDirectory(storeRoot); await realDirectory(vendorPath)
    // An interrupted backup must not create populated inventory for a nonexistent
    // deployment state. This check is read-only; callers initialize the store.
    const state = await boundedJson(join(storeRoot, 'state.json'), 64 * 1024 * 1024)
    validatePackCenterState(state)
    const legacyRoot = join(storeRoot, 'legacy')
    const incoming = join(storeRoot, '.legacy-incoming')
    await mkdirReal(legacyRoot); await mkdirReal(incoming)
    await syncDirectory(storeRoot)
    staging = await mkdtemp(join(incoming, 'snapshot-'))
    const artifact = await packDirectory(vendorPath, join(staging, 'artifact.tar'))
    await extractArtifact(join(staging, 'artifact.tar'), join(staging, 'content'), artifact)
    const loaded = await loadPackFromDir(join(staging, 'content'))
    if (!loaded.ok || !loaded.pack) fail('LEGACY_PACK_INVALID', 'Legacy source is not a valid V2 pack', { diagnostics: loaded.diagnostics })
    const after = await hashContentDirectory(vendorPath)
    if (after.contentTreeSha256 !== artifact.contentTreeSha256 || after.fileCount !== artifact.fileCount) {
      fail('LEGACY_SOURCE_CHANGED', 'Legacy source changed while preparing its immutable backup')
    }
    const receipt: LegacyReceipt = {
      schemaVersion: 1, source: 'legacy', releaseId: `legacy.${artifact.contentTreeSha256}`,
      packId: loaded.pack.pack.id, version: loaded.pack.pack.version,
      contentTreeSha256: artifact.contentTreeSha256, artifactSha256: artifact.artifactSha256,
      sizeBytes: artifact.sizeBytes, fileCount: artifact.fileCount, contentSizeBytes: artifact.contentSizeBytes,
    }
    const file = await open(join(staging, 'legacy.json'), 'wx', 0o600)
    try { await file.writeFile(canonicalBytes(receipt)); await file.sync() } finally { await file.close() }
    await syncTree(staging)
    const directory = join(legacyRoot, receipt.contentTreeSha256)
    try { await rename(staging, directory) } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(errno(error) ?? '')) throw error
    }
    await syncDirectory(legacyRoot); await syncDirectory(incoming)
    // Content addressing can reuse an earlier archive (empty directories are
    // excluded from the tree digest). Always return the existing receipt's bytes.
    const verified = await verifySnapshot(storeRoot, receipt.contentTreeSha256)
    const timestamp = new Date().toISOString()
    const record: InstalledPackRecord = {
      releaseId: verified.receipt.releaseId, packId: verified.receipt.packId, version: verified.receipt.version,
      contentTreeSha256: verified.receipt.contentTreeSha256, artifactSha256: verified.receipt.artifactSha256,
      packPath: join(directory, 'content'), manifestPath: join(directory, 'legacy.json'),
      installedAt: timestamp, source: 'legacy',
    }
    const existing = state.installed[record.releaseId]
    if (existing) await verifyLegacyRecord(storeRoot, existing)
    // Preserve the original version string, but refuse identities the durable
    // state schema cannot represent; never silently sanitize legacy metadata.
    validatePackCenterState({ ...state, installed: { ...state.installed, [record.releaseId]: record } })
    return {
      record, vendorPath,
      suppression: { packId: record.packId, releaseId: record.releaseId, backupPath: record.packPath, contentTreeSha256: record.contentTreeSha256, suppressedAt: timestamp },
    }
  } catch (error) { return rethrow(error) } finally {
    // staging is always a freshly-created child owned by this invocation.
    if (staging) await rm(staging, { recursive: true, force: true })
  }
}

/** Verify local provenance and exact immutable paths without inventing a signature. */
export async function verifyLegacyRecord(storeRoot: string, record: InstalledPackRecord): Promise<DomainPackV2> {
  try {
    absolute(storeRoot)
    if (!record || record.source !== 'legacy' || record.centerId !== undefined || record.ownerOrgId !== undefined ||
      typeof record.contentTreeSha256 !== 'string' || !digestPattern.test(record.contentTreeSha256) ||
      typeof record.artifactSha256 !== 'string' || !digestPattern.test(record.artifactSha256) ||
      record.releaseId !== `legacy.${record.contentTreeSha256}`) {
      fail('LEGACY_RECORD_INVALID', 'A legacy record must retain local-only provenance and its content-addressed identity')
    }
    const directory = join(storeRoot, 'legacy', record.contentTreeSha256)
    if (record.packPath !== join(directory, 'content') || record.manifestPath !== join(directory, 'legacy.json')) {
      fail('LEGACY_PATH_UNSAFE', 'Legacy state paths must reference the exact immutable local snapshot')
    }
    const verified = await verifySnapshot(storeRoot, record.contentTreeSha256)
    for (const key of ['releaseId', 'packId', 'version', 'contentTreeSha256', 'artifactSha256'] as const) {
      if (record[key] !== verified.receipt[key]) fail('LEGACY_IDENTITY_MISMATCH', `Legacy state and receipt disagree on ${key}`)
    }
    return verified.pack
  } catch (error) { rethrow(error) }
}

/** Backup use ignores later source changes; explicit restoration must verify them. */
export async function verifyLegacySuppression(
  storeRoot: string,
  vendorPath: string,
  suppression: LegacySuppression,
  options: { requireSourceUnchanged?: boolean } = {},
): Promise<void> {
  try {
    separate(storeRoot, vendorPath)
    if (!suppression || typeof suppression.contentTreeSha256 !== 'string' || !digestPattern.test(suppression.contentTreeSha256) ||
      suppression.releaseId !== `legacy.${suppression.contentTreeSha256}` ||
      suppression.backupPath !== join(storeRoot, 'legacy', suppression.contentTreeSha256, 'content') ||
      typeof suppression.suppressedAt !== 'string' || !Number.isFinite(Date.parse(suppression.suppressedAt))) {
      fail('LEGACY_SUPPRESSION_INVALID', 'Legacy suppression must reference an exact, content-addressed local backup')
    }
    const { receipt } = await verifySnapshot(storeRoot, suppression.contentTreeSha256)
    if (receipt.packId !== suppression.packId || receipt.releaseId !== suppression.releaseId) {
      fail('LEGACY_IDENTITY_MISMATCH', 'Legacy suppression identity differs from its backup')
    }
    if (options.requireSourceUnchanged) {
      await realDirectory(vendorPath)
      const source = await hashContentDirectory(vendorPath)
      if (source.contentTreeSha256 !== suppression.contentTreeSha256 || source.fileCount !== receipt.fileCount) {
        fail('LEGACY_SOURCE_CHANGED', 'Original vendor content changed after takeover; restoring legacy management requires an explicit conflict resolution')
      }
    }
  } catch (error) { rethrow(error) }
}
