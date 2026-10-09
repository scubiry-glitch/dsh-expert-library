import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashContentDirectory } from '../packages/pack-contract/index.mjs'

const sourceMode = process.env.PACK_LEGACY_SOURCE === '1'
const { prepareLegacySnapshot, verifyLegacyRecord, verifyLegacySuppression } = await import(sourceMode
  ? '../src/host/pack-legacy.ts' : '../lib/host/pack-legacy.js')
const { createPackCenterStateStore } = await import(sourceMode
  ? '../src/host/pack-center-state.ts' : '../lib/host/pack-center-state.js')
const fixture = fileURLToPath(new URL('../examples/pack-center/demo-v1', import.meta.url))
const code = expected => error => error?.code === expected

async function context(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'pack-legacy-test-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const storeRoot = join(temporary, 'store')
  const vendorPath = join(temporary, 'vendor', 'example')
  await cp(fixture, vendorPath, { recursive: true })
  await createPackCenterStateStore(storeRoot).initialize()
  return { temporary, storeRoot, vendorPath }
}
async function prepared(t) {
  const ctx = await context(t)
  return { ...ctx, result: await prepareLegacySnapshot(ctx.storeRoot, ctx.vendorPath) }
}

test('copies a real V2 tree durably; source and state remain byte-for-byte unchanged', async t => {
  const { storeRoot, vendorPath } = await context(t)
  await mkdir(join(vendorPath, 'generated'))
  await writeFile(join(vendorPath, 'generated', 'source-digest.txt'), 'preserve this generated content exactly\n')
  const initial = await hashContentDirectory(vendorPath)
  const stateBefore = await readFile(join(storeRoot, 'state.json'))
  const metadataBefore = await lstat(join(vendorPath, 'pack.json'))
  const result = await prepareLegacySnapshot(storeRoot, vendorPath)
  assert.equal(result.vendorPath, vendorPath)
  assert.equal(result.record.source, 'legacy')
  assert.equal(result.record.centerId, undefined)
  assert.equal(result.record.ownerOrgId, undefined)
  assert.equal(result.record.releaseId, `legacy.${initial.contentTreeSha256}`)
  assert.equal(result.record.packPath, join(storeRoot, 'legacy', initial.contentTreeSha256, 'content'))
  assert.equal(result.suppression.backupPath, result.record.packPath)
  assert.deepEqual(await hashContentDirectory(vendorPath), initial)
  assert.deepEqual(await hashContentDirectory(result.record.packPath), initial)
  assert.deepEqual(await readFile(join(storeRoot, 'state.json')), stateBefore)
  assert.equal((await lstat(join(vendorPath, 'pack.json'))).mtimeMs, metadataBefore.mtimeMs)
  const archive = await readFile(join(storeRoot, 'legacy', initial.contentTreeSha256, 'artifact.tar'))
  assert.equal(createHash('sha256').update(archive).digest('hex'), result.record.artifactSha256)
  assert.equal((await verifyLegacyRecord(storeRoot, result.record)).pack.id, 'demo.review')
  await verifyLegacySuppression(storeRoot, vendorPath, result.suppression, { requireSourceUnchanged: true })
  assert.deepEqual(await readdir(join(storeRoot, '.legacy-incoming')), [])
})

test('non-SemVer legacy versions are preserved verbatim rather than forged as center versions', async t => {
  const { storeRoot, vendorPath } = await context(t)
  const file = join(vendorPath, 'pack.json')
  const pack = JSON.parse(await readFile(file, 'utf8'))
  pack.pack.version = ' 秋季版 2026.09 '
  await writeFile(file, JSON.stringify(pack))
  const { record } = await prepareLegacySnapshot(storeRoot, vendorPath)
  assert.equal(record.version, ' 秋季版 2026.09 ')
  assert.equal((await verifyLegacyRecord(storeRoot, record)).pack.version, pack.pack.version)
})

test('two independent vendor paths with identical content reuse one backup and retain exact path identities', async t => {
  const { temporary, storeRoot, vendorPath } = await context(t)
  const other = join(temporary, 'vendor', 'second')
  await cp(vendorPath, other, { recursive: true })
  const [a, b] = await Promise.all([prepareLegacySnapshot(storeRoot, vendorPath), prepareLegacySnapshot(storeRoot, other)])
  assert.equal(a.record.releaseId, b.record.releaseId)
  assert.equal(a.record.packPath, b.record.packPath)
  assert.notEqual(a.vendorPath, b.vendorPath)
  assert.equal((await readdir(join(storeRoot, 'legacy'))).length, 1)
  await writeFile(join(vendorPath, 'README.md'), 'source A changed')
  await verifyLegacySuppression(storeRoot, vendorPath, a.suppression)
  await assert.rejects(verifyLegacySuppression(storeRoot, vendorPath, a.suppression, { requireSourceUnchanged: true }), code('LEGACY_SOURCE_CHANGED'))
  await verifyLegacySuppression(storeRoot, other, b.suppression, { requireSourceUnchanged: true })
})

test('source deletion after takeover does not invalidate the isolated backup; restoration fails', async t => {
  const { temporary, storeRoot, vendorPath, result } = await prepared(t)
  await rename(vendorPath, join(temporary, 'saved-original'))
  await verifyLegacySuppression(storeRoot, vendorPath, result.suppression)
  assert.equal((await verifyLegacyRecord(storeRoot, result.record)).pack.version, '1.0.0')
  await assert.rejects(verifyLegacySuppression(storeRoot, vendorPath, result.suppression, { requireSourceUnchanged: true }))
})

test('different versions of the same pack at two vendor paths keep independent content addresses', async t => {
  const { temporary, storeRoot, vendorPath } = await context(t)
  const other = join(temporary, 'vendor', 'second')
  await cp(fileURLToPath(new URL('../examples/pack-center/demo-v2', import.meta.url)), other, { recursive: true })
  const a = await prepareLegacySnapshot(storeRoot, vendorPath)
  const b = await prepareLegacySnapshot(storeRoot, other)
  assert.equal(a.record.packId, b.record.packId)
  assert.notEqual(a.record.releaseId, b.record.releaseId)
  assert.equal((await verifyLegacyRecord(storeRoot, a.record)).pack.version, '1.0.0')
  assert.equal((await verifyLegacyRecord(storeRoot, b.record)).pack.version, '1.1.0')
})

test('tree-identical sources with different empty directories reuse the existing archive receipt', async t => {
  const { temporary, storeRoot, vendorPath } = await context(t)
  const other = join(temporary, 'vendor', 'with-empty-directory')
  await cp(vendorPath, other, { recursive: true })
  await mkdir(join(other, 'empty'))
  const a = await prepareLegacySnapshot(storeRoot, vendorPath)
  const b = await prepareLegacySnapshot(storeRoot, other)
  assert.equal(a.record.releaseId, b.record.releaseId)
  assert.equal(a.record.artifactSha256, b.record.artifactSha256)
  await verifyLegacyRecord(storeRoot, b.record)
  await verifyLegacySuppression(storeRoot, other, b.suppression, { requireSourceUnchanged: true })
})

test('tampered backup content is rejected and never silently restored from the old source', async t => {
  const { storeRoot, vendorPath, result } = await prepared(t)
  await writeFile(join(result.record.packPath, 'README.md'), 'corrupt local backup')
  await assert.rejects(verifyLegacyRecord(storeRoot, result.record), code('LEGACY_CONTENT_MISMATCH'))
  await assert.rejects(prepareLegacySnapshot(storeRoot, vendorPath), code('LEGACY_CONTENT_MISMATCH'))
  assert.equal(await readFile(join(result.record.packPath, 'README.md'), 'utf8'), 'corrupt local backup')
  assert.deepEqual(await readdir(join(storeRoot, '.legacy-incoming')), [])
})

test('archive byte tampering is detected independently of unchanged extracted files', async t => {
  const { storeRoot, result } = await prepared(t)
  const archivePath = join(storeRoot, 'legacy', result.record.contentTreeSha256, 'artifact.tar')
  const bytes = await readFile(archivePath)
  bytes[1000] ^= 1
  await writeFile(archivePath, bytes)
  await assert.rejects(verifyLegacyRecord(storeRoot, result.record), code('LEGACY_ARCHIVE_MISMATCH'))
})

test('receipt edits, forged center provenance, and state identity edits are rejected', async t => {
  const { storeRoot, result } = await prepared(t)
  await assert.rejects(verifyLegacyRecord(storeRoot, { ...result.record, source: 'center' }), code('LEGACY_RECORD_INVALID'))
  await assert.rejects(verifyLegacyRecord(storeRoot, { ...result.record, centerId: 'forged.center' }), code('LEGACY_RECORD_INVALID'))
  await assert.rejects(verifyLegacyRecord(storeRoot, { ...result.record, packId: 'forged.pack' }), code('LEGACY_IDENTITY_MISMATCH'))
  await assert.rejects(verifyLegacyRecord(storeRoot, { ...result.record, version: 'forged' }), code('LEGACY_IDENTITY_MISMATCH'))
  await assert.rejects(verifyLegacyRecord(storeRoot, { ...result.record, artifactSha256: '0'.repeat(64) }), code('LEGACY_IDENTITY_MISMATCH'))
  const receipt = JSON.parse(await readFile(result.record.manifestPath, 'utf8'))
  receipt.packId = 'forged.pack'
  await writeFile(result.record.manifestPath, JSON.stringify(receipt))
  await assert.rejects(verifyLegacyRecord(storeRoot, result.record), code('LEGACY_IDENTITY_MISMATCH'))
})

test('rejects record and suppression path escape, source/root overlap, and nonnormalized paths', async t => {
  const { temporary, storeRoot, vendorPath, result } = await prepared(t)
  await assert.rejects(verifyLegacyRecord(storeRoot, { ...result.record, packPath: vendorPath }), code('LEGACY_PATH_UNSAFE'))
  await assert.rejects(verifyLegacyRecord(storeRoot, { ...result.record, manifestPath: join(temporary, 'receipt.json') }), code('LEGACY_PATH_UNSAFE'))
  await assert.rejects(verifyLegacySuppression(storeRoot, vendorPath, { ...result.suppression, backupPath: vendorPath }), code('LEGACY_SUPPRESSION_INVALID'))
  await assert.rejects(prepareLegacySnapshot(storeRoot, storeRoot), code('LEGACY_PATH_UNSAFE'))
  await assert.rejects(prepareLegacySnapshot(storeRoot, result.record.packPath), code('LEGACY_PATH_UNSAFE'))
  await assert.rejects(prepareLegacySnapshot(storeRoot, temporary), code('LEGACY_PATH_UNSAFE'))
  await assert.rejects(prepareLegacySnapshot(storeRoot, `${vendorPath}/../example`), code('LEGACY_PATH_UNSAFE'))
  await assert.rejects(prepareLegacySnapshot('relative-store', vendorPath), code('LEGACY_PATH_UNSAFE'))
})

test('source and backup symlinks/hardlinks are refused without deleting targets', async t => {
  const { temporary, storeRoot, vendorPath, result } = await prepared(t)
  const sourceAlias = join(temporary, 'vendor-alias')
  await symlink(vendorPath, sourceAlias)
  await assert.rejects(prepareLegacySnapshot(storeRoot, sourceAlias), code('LEGACY_PATH_UNSAFE'))
  const storeAlias = join(temporary, 'store-alias')
  await symlink(storeRoot, storeAlias)
  await assert.rejects(prepareLegacySnapshot(storeAlias, vendorPath), code('LEGACY_PATH_UNSAFE'))
  const saved = join(temporary, 'original-content')
  await rename(result.record.packPath, saved)
  await symlink(saved, result.record.packPath)
  await assert.rejects(verifyLegacyRecord(storeRoot, result.record), code('LEGACY_PATH_UNSAFE'))
  assert.ok((await lstat(join(saved, 'pack.json'))).isFile())
  await link(join(vendorPath, 'README.md'), join(vendorPath, 'hardlink.md'))
  await assert.rejects(prepareLegacySnapshot(storeRoot, vendorPath))
  assert.deepEqual(await readdir(join(storeRoot, '.legacy-incoming')), [])
})

test('invalid V2 sources and missing/corrupt state fail without source mutation or committed backups', async t => {
  const { storeRoot, vendorPath } = await context(t)
  await writeFile(join(vendorPath, 'pack.json'), '{invalid json')
  await assert.rejects(prepareLegacySnapshot(storeRoot, vendorPath), code('LEGACY_PACK_INVALID'))
  assert.equal(await readFile(join(vendorPath, 'pack.json'), 'utf8'), '{invalid json')
  assert.deepEqual(await readdir(join(storeRoot, 'legacy')), [])
  assert.deepEqual(await readdir(join(storeRoot, '.legacy-incoming')), [])
  await writeFile(join(storeRoot, 'state.json'), '{broken state')
  await assert.rejects(prepareLegacySnapshot(storeRoot, vendorPath))
  assert.equal(await readFile(join(storeRoot, 'state.json'), 'utf8'), '{broken state')
  await rename(join(storeRoot, 'state.json'), join(storeRoot, 'saved-state.json'))
  await assert.rejects(prepareLegacySnapshot(storeRoot, vendorPath))
  await assert.rejects(lstat(join(storeRoot, 'state.json')), error => error.code === 'ENOENT')
})

test('scripts remain passive bytes and retained content includes generated and nested resources', async t => {
  const { temporary, storeRoot, vendorPath } = await context(t)
  const marker = join(temporary, 'script-was-executed')
  await writeFile(join(vendorPath, 'install.sh'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  await mkdir(join(vendorPath, 'assets', 'nested'), { recursive: true })
  await writeFile(join(vendorPath, 'assets', 'nested', 'raw.bin'), Buffer.from([0, 255, 13, 10]))
  const { record } = await prepareLegacySnapshot(storeRoot, vendorPath)
  await assert.rejects(lstat(marker), error => error.code === 'ENOENT')
  assert.equal((await lstat(join(record.packPath, 'install.sh'))).mode & 0o111, 0)
  assert.deepEqual(await readFile(join(record.packPath, 'assets', 'nested', 'raw.bin')), Buffer.from([0, 255, 13, 10]))
})
