import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, readdir, open, mkdir, mkdtemp, link, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { assertSafePath, canonicalBytes, sha256, ContractError } from '../pack-contract/index.mjs'

const BLOCK = 512
const CHUNK = 64 * 1024
const ZERO = Buffer.alloc(BLOCK)
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
export const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 160 * 1024 * 1024, maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024, maxFiles: 10000, maxEntries: 20000, maxPathDepth: 64,
})

const fail = (code, message) => { throw new ContractError(code, message) }
const order = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const padding = size => (BLOCK - size % BLOCK) % BLOCK
const isZero = bytes => bytes.every(byte => byte === 0)
function limitsFor(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_CONTRACT', 'Expected artifact limits')
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key) || !Number.isSafeInteger(value) || value < 0) fail('INVALID_CONTRACT', `Invalid artifact limit: ${key}`)
  }
  return { ...DEFAULT_LIMITS, ...input }
}
function checkLimit(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value > maximum) fail('LIMIT_EXCEEDED', `${label} exceeds configured limit`)
}
function safePath(value, limits) {
  assertSafePath(value)
  checkLimit(value.split('/').length, limits.maxPathDepth, 'Path depth')
  return value
}
function utf8(bytes) {
  try { return decoder.decode(bytes) } catch { fail('INVALID_PATH', 'Invalid UTF-8 in artifact path or header') }
}
async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
async function newOutput(path) {
  if (typeof path !== 'string' || !path || path.includes('\0')) fail('INVALID_PATH', 'Expected an output path')
  const target = resolve(path)
  if (await exists(target)) fail('STATE_CONFLICT', 'Artifact output already exists')
  if (!(await lstat(dirname(target))).isDirectory()) fail('INVALID_PATH', 'Output parent must be a real directory')
  return target
}
function regular(info, label) {
  if (!info.isFile() || (info.nlink !== 1 && info.nlink !== 1n)) fail('UNSUPPORTED_FILE', `Expected an independent regular file: ${label}`)
}
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink
}
function noFollowFlags(flags) { return flags | constants.O_NOFOLLOW }
function rethrow(error) {
  if (error instanceof ContractError) throw error
  const code = error.code === 'EEXIST' ? 'STATE_CONFLICT' : ['ELOOP', 'EISDIR', 'ENOTDIR'].includes(error.code) ? 'UNSUPPORTED_FILE' : 'SOURCE_FAILED'
  throw new ContractError(code, `Artifact filesystem operation failed (${error.code ?? 'unknown'})`)
}
function treeSummary(files) {
  files.sort((a, b) => order(a.path, b.path))
  return {
    contentTreeSha256: sha256(Buffer.concat([Buffer.from('dsh-pack-tree-v1\0'), canonicalBytes({ schemaVersion: 1, files })])),
    fileCount: files.length, contentSizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
  }
}
async function readExactly(handle, count, position) {
  const buffer = Buffer.alloc(count)
  let done = 0
  while (done < count) {
    const { bytesRead } = await handle.read(buffer, done, count - done, position + done)
    if (!bytesRead) fail('INTEGRITY_MISMATCH', 'Truncated artifact or source file')
    done += bytesRead
  }
  return buffer
}
async function writeAll(handle, bytes) {
  let done = 0
  while (done < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, done, bytes.length - done)
    if (!bytesWritten) fail('SOURCE_FAILED', 'Artifact write did not make progress')
    done += bytesWritten
  }
}
function tarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  const parts = path.split('/')
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('/')
    const name = parts.slice(i).join('/')
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  fail('INVALID_PATH', 'Path exceeds POSIX ustar name/prefix capacity')
}
function putNumber(header, offset, width, value) {
  const octal = value.toString(8)
  if (octal.length > width - 1) fail('LIMIT_EXCEEDED', 'Number exceeds POSIX ustar capacity')
  header.write(octal.padStart(width - 1, '0'), offset, width - 1, 'ascii')
}
function headerFor(entry) {
  const header = Buffer.alloc(BLOCK)
  const path = tarPath(entry.path)
  header.write(path.name, 0, 100, 'utf8')
  header.write(path.prefix, 345, 155, 'utf8')
  putNumber(header, 100, 8, entry.directory ? 0o755 : 0o644)
  putNumber(header, 108, 8, 0); putNumber(header, 116, 8, 0)
  putNumber(header, 124, 12, entry.size); putNumber(header, 136, 12, 0)
  header.fill(32, 148, 156)
  header[156] = entry.directory ? 53 : 48
  header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii')
  putNumber(header, 329, 8, 0); putNumber(header, 337, 8, 0)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  header[154] = 0; header[155] = 32
  return header
}

/** Input must already be normalized and frozen by the caller, without Git metadata. */
export async function packDirectory(root, outputFile, limitInput) {
  const limits = limitsFor(limitInput)
  let temporary
  try {
    const source = resolve(root)
    const target = await newOutput(outputFile)
    if (target === source || target.startsWith(`${source}${sep}`)) fail('INVALID_PATH', 'Artifact output must be outside the input tree')
    const rootInfo = await lstat(source, { bigint: true })
    if (!rootInfo.isDirectory()) fail('UNSUPPORTED_FILE', 'Input root must be a real directory')
    const entries = []
    const directories = [{ absolute: source, info: rootInfo }]
    let total = 0; let fileCount = 0; let archiveSize = 2 * BLOCK
    checkLimit(archiveSize, limits.maxArchiveBytes, 'Artifact bytes')
    async function walk(relative) {
      const names = await readdir(join(source, relative), { encoding: 'buffer' })
      checkLimit(entries.length + names.length, limits.maxEntries, 'Archive entries')
      for (const rawName of names) {
        const name = utf8(rawName)
        const path = safePath(relative ? `${relative}/${name}` : name, limits)
        tarPath(path)
        const absolute = join(source, path)
        const info = await lstat(absolute, { bigint: true })
        if (!info.isDirectory()) regular(info, path)
        const directory = info.isDirectory()
        const size = directory ? 0 : Number(info.size)
        if (!directory) {
          checkLimit(size, limits.maxFileBytes, 'File bytes')
          total += size; fileCount++
          checkLimit(total, limits.maxTotalBytes, 'Total content bytes')
          checkLimit(fileCount, limits.maxFiles, 'File count')
        }
        archiveSize += BLOCK + size + padding(size)
        checkLimit(archiveSize, limits.maxArchiveBytes, 'Artifact bytes')
        entries.push({ path, absolute, info, directory, size })
        checkLimit(entries.length, limits.maxEntries, 'Archive entries')
        if (directory) { directories.push({ absolute, info }); await walk(path) }
      }
    }
    await walk('')
    entries.sort((a, b) => order(a.path, b.path))
    temporary = await mkdtemp(join(dirname(target), `.${basename(target)}.packing-`))
    const pending = join(temporary, 'artifact.tar')
    const out = await open(pending, 'wx', 0o600)
    const archiveHash = createHash('sha256')
    const files = []
    const append = async bytes => { await writeAll(out, bytes); archiveHash.update(bytes) }
    try {
      for (const entry of entries) {
        await append(headerFor(entry))
        if (entry.directory) continue
        const input = await open(entry.absolute, noFollowFlags(constants.O_RDONLY))
        try {
          const before = await input.stat({ bigint: true })
          regular(before, entry.path)
          if (!sameFile(entry.info, before)) fail('STATE_CONFLICT', 'Input tree changed while creating artifact')
          const digest = createHash('sha256')
          for (let position = 0; position < entry.size; position += CHUNK) {
            const bytes = await readExactly(input, Math.min(CHUNK, entry.size - position), position)
            digest.update(bytes); await append(bytes)
          }
          if (!sameFile(before, await input.stat({ bigint: true }))) fail('STATE_CONFLICT', 'Source file changed while creating artifact')
          files.push({ path: entry.path, sizeBytes: entry.size, sha256: digest.digest('hex') })
        } finally { await input.close() }
        if (padding(entry.size)) await append(ZERO.subarray(0, padding(entry.size)))
      }
      await append(ZERO); await append(ZERO)
      for (const dir of directories) {
        if (!sameFile(dir.info, await lstat(dir.absolute, { bigint: true }))) fail('STATE_CONFLICT', 'Input directory changed while creating artifact')
      }
      await out.sync()
    } finally { await out.close() }
    const summary = { artifactSha256: archiveHash.digest('hex'), sizeBytes: archiveSize, ...treeSummary(files) }
    // Hard-link publication is atomic and fails if the target appeared concurrently.
    await link(pending, target)
    return summary
  } catch (error) { rethrow(error) } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true })
  }
}

function fieldText(header, offset, width) {
  const bytes = header.subarray(offset, offset + width)
  const nul = bytes.indexOf(0)
  if (nul !== -1 && !isZero(bytes.subarray(nul))) fail('INTEGRITY_MISMATCH', 'Nonzero bytes after tar text terminator')
  return utf8(nul === -1 ? bytes : bytes.subarray(0, nul))
}
function fieldNumber(header, offset, width) {
  const bytes = header.subarray(offset, offset + width)
  if (bytes.some(byte => byte !== 0 && byte !== 32 && (byte < 48 || byte > 55))) fail('INTEGRITY_MISMATCH', 'Invalid tar octal number')
  const text = bytes.toString('ascii')
  if (!/^ *[0-7]+(?:\0[\0 ]*| *)$/.test(text)) fail('INTEGRITY_MISMATCH', 'Malformed tar numeric field')
  const value = Number.parseInt(text.trim(), 8)
  if (!Number.isSafeInteger(value) || value < 0) fail('LIMIT_EXCEEDED', 'Tar number exceeds integer bounds')
  return value
}
function parseHeader(header, limits) {
  const checksum = fieldNumber(header, 148, 8)
  const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
  if (actual !== checksum) fail('INTEGRITY_MISMATCH', 'Tar header checksum mismatch')
  if (!header.subarray(257, 263).equals(Buffer.from('ustar\0')) || !header.subarray(263, 265).equals(Buffer.from('00'))) fail('UNSUPPORTED_FILE', 'Only POSIX ustar archives are supported')
  if (![0, 48, 53].includes(header[156])) fail('UNSUPPORTED_FILE', 'Tar links, special files, and extension headers are forbidden')
  if (fieldText(header, 157, 100)) fail('UNSUPPORTED_FILE', 'Link target is forbidden')
  fieldText(header, 265, 32); fieldText(header, 297, 32)
  for (const [offset, width] of [[100, 8], [108, 8], [116, 8], [136, 12], [329, 8], [337, 8]]) fieldNumber(header, offset, width)
  if (!isZero(header.subarray(500))) fail('INTEGRITY_MISMATCH', 'Nonzero reserved tar header bytes')
  const name = fieldText(header, 0, 100)
  const prefix = fieldText(header, 345, 155)
  if (!name) fail('INVALID_PATH', 'Empty tar entry name')
  const directory = header[156] === 53
  let path = prefix ? `${prefix}/${name}` : name
  if (directory && path.endsWith('/')) path = path.slice(0, -1)
  safePath(path, limits)
  const size = fieldNumber(header, 124, 12)
  if (directory && size !== 0) fail('INTEGRITY_MISMATCH', 'Directory entry contains data')
  checkLimit(size, limits.maxFileBytes, 'File bytes')
  return { path, directory, size }
}
function expectedArtifact(expected, limits) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) fail('INVALID_CONTRACT', 'Expected an authenticated artifact description')
  for (const key of ['artifactSha256', 'contentTreeSha256']) if (typeof expected[key] !== 'string' || !/^[0-9a-f]{64}$/.test(expected[key])) fail('INVALID_CONTRACT', `Invalid ${key}`)
  for (const key of ['sizeBytes', 'fileCount']) if (!Number.isSafeInteger(expected[key]) || expected[key] < 0) fail('INVALID_CONTRACT', `Invalid ${key}`)
  checkLimit(expected.sizeBytes, limits.maxArchiveBytes, 'Artifact bytes')
  checkLimit(expected.fileCount, limits.maxFiles, 'File count')
  if (expected.sizeBytes < 2 * BLOCK || expected.sizeBytes % BLOCK !== 0) fail('INTEGRITY_MISMATCH', 'Tar length must contain complete blocks and end markers')
}

/** Writes only into private staging; makes destination visible after every verification passes. */
export async function extractArtifact(archiveFile, destination, expected, limitInput) {
  const limits = limitsFor(limitInput)
  expectedArtifact(expected, limits)
  let lease; let input
  try {
    const target = await newOutput(destination)
    input = await open(archiveFile, noFollowFlags(constants.O_RDONLY))
    const before = await input.stat({ bigint: true })
    regular(before, 'archive')
    if (before.size !== BigInt(expected.sizeBytes)) fail('INTEGRITY_MISMATCH', 'Archive byte length differs from manifest')
    const firstHash = createHash('sha256')
    for (let position = 0; position < expected.sizeBytes; position += CHUNK) firstHash.update(await readExactly(input, Math.min(CHUNK, expected.sizeBytes - position), position))
    if (firstHash.digest('hex') !== expected.artifactSha256) fail('INTEGRITY_MISMATCH', 'Archive SHA-256 differs from manifest')
    const lock = join(dirname(target), `.${basename(target)}.pack-artifact-lock`)
    // Cooperating installers cannot race publication to the same private staging destination.
    await mkdir(lock, { mode: 0o700 }); lease = lock
    const staging = join(lock, 'tree')
    await mkdir(staging, { mode: 0o700 })
    let offset = 0; let entries = 0; let total = 0; let ended = false
    const archiveHash = createHash('sha256')
    const explicit = new Set(); const kinds = new Map(); const files = []
    const read = async count => {
      if (offset + count > expected.sizeBytes) fail('INTEGRITY_MISMATCH', 'Truncated tar entry')
      const bytes = await readExactly(input, count, offset)
      offset += count; archiveHash.update(bytes); return bytes
    }
    while (offset < expected.sizeBytes) {
      const header = await read(BLOCK)
      if (isZero(header)) {
        if (!isZero(await read(BLOCK))) fail('INTEGRITY_MISMATCH', 'Tar requires two zero end blocks')
        while (offset < expected.sizeBytes) if (!isZero(await read(Math.min(CHUNK, expected.sizeBytes - offset)))) fail('INTEGRITY_MISMATCH', 'Nonzero data after tar end marker')
        ended = true; break
      }
      const entry = parseHeader(header, limits)
      entries++; checkLimit(entries, limits.maxEntries, 'Archive entries')
      if (explicit.has(entry.path)) fail('INVALID_PATH', 'Duplicate tar entry')
      const kind = entry.directory ? 'directory' : 'file'
      if (kinds.has(entry.path) && (kinds.get(entry.path) !== kind || kind === 'file')) fail('INVALID_PATH', 'Tar file/directory conflict')
      const parts = entry.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/')
        if (kinds.get(parent) === 'file') fail('INVALID_PATH', 'Tar file is an ancestor of another entry')
        kinds.set(parent, 'directory')
      }
      explicit.add(entry.path); kinds.set(entry.path, kind)
      const absolute = join(staging, entry.path)
      if (entry.directory) { await mkdir(absolute, { recursive: true, mode: 0o755 }); continue }
      checkLimit(files.length + 1, limits.maxFiles, 'File count')
      total += entry.size; checkLimit(total, limits.maxTotalBytes, 'Total content bytes')
      if (files.length + 1 > expected.fileCount) fail('INTEGRITY_MISMATCH', 'File count differs from manifest')
      if (offset + entry.size + padding(entry.size) + 2 * BLOCK > expected.sizeBytes) fail('INTEGRITY_MISMATCH', 'Tar file size exceeds remaining archive')
      await mkdir(dirname(absolute), { recursive: true, mode: 0o755 })
      const out = await open(absolute, 'wx', 0o644)
      const digest = createHash('sha256')
      try {
        for (let position = 0; position < entry.size; position += CHUNK) {
          const bytes = await read(Math.min(CHUNK, entry.size - position))
          digest.update(bytes); await writeAll(out, bytes)
        }
        await out.sync()
      } finally { await out.close() }
      if (padding(entry.size) && !isZero(await read(padding(entry.size)))) fail('INTEGRITY_MISMATCH', 'Nonzero tar file padding')
      files.push({ path: entry.path, sizeBytes: entry.size, sha256: digest.digest('hex') })
    }
    if (!ended) fail('INTEGRITY_MISMATCH', 'Missing tar end markers')
    const summary = { artifactSha256: archiveHash.digest('hex'), sizeBytes: offset, ...treeSummary(files) }
    for (const key of ['artifactSha256', 'sizeBytes', 'contentTreeSha256', 'fileCount']) if (summary[key] !== expected[key]) fail('INTEGRITY_MISMATCH', `${key} differs from manifest`)
    if (!sameFile(before, await input.stat({ bigint: true }))) fail('STATE_CONFLICT', 'Archive changed during verification')
    if (await exists(target)) fail('STATE_CONFLICT', 'Artifact destination appeared during extraction')
    // Parent is caller-owned isolated staging, never a shared or attacker-writable directory.
    await rename(staging, target)
    return summary
  } catch (error) { rethrow(error) } finally {
    if (input) await input.close()
    if (lease) await rm(lease, { recursive: true, force: true })
  }
}
