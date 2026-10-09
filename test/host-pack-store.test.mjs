import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packDirectory } from '../packages/pack-artifact/index.mjs'
import { hashContentDirectory, signReleaseManifest } from '../packages/pack-contract/index.mjs'

const { createPackStore } = await import(process.env.PACK_STORE_SOURCE === '1'
  ? '../src/host/pack-store.ts' : '../lib/host/pack-store.js')
const fixture = name => fileURLToPath(new URL(`../examples/pack-center/${name}`, import.meta.url))
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const defaults = { centerId: 'test.center', trustedKeys: { 'test.key': publicKey }, capabilities: { pluginVersion: '0.1.0' } }
const errCode = code => error => error?.code === code

async function context(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pack-store-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'local')
  const store = createPackStore(stateRoot, { ...defaults, ...options })
  await store.initialize()
  return { root, stateRoot, store }
}

async function release(root, version = 'v1', changes = {}) {
  const source = version === 'v1' ? 'demo-v1' : 'demo-v2'
  const file = join(root, `archive-${version}-${Math.random().toString(16).slice(2)}.tar`)
  const artifact = await packDirectory(fixture(source), file)
  const manifest = {
    schemaVersion: 1, protocolVersion: 1, normalizationVersion: 1, digestAlgorithmVersion: 1,
    signatureAlgorithm: 'Ed25519', archiveFormat: 'tar', centerId: 'test.center',
    releaseId: `release.${version}`, packId: 'demo.review', ownerOrgId: 'org.one',
    version: version === 'v1' ? '1.0.0' : '1.1.0', sourceCommit: 'a'.repeat(40),
    artifactSha256: artifact.artifactSha256, contentTreeSha256: artifact.contentTreeSha256,
    reportSha256: 'b'.repeat(64), validatorVersion: '0.1.0', packSchemaVersion: 2,
    requiresPlugin: { minVersion: '0.1.0' }, dependencyLock: [], builtinDependencies: [],
    sizeBytes: artifact.sizeBytes, fileCount: artifact.fileCount,
    approvedSubmissionId: `submission.${version}`, signingKeyId: 'test.key', ...changes,
  }
  return { envelope: signReleaseManifest(manifest, privateKey), archiveFile: file }
}
const install = (store, input, generation, key, activate = false) => store.install({
  ...input, expectedGeneration: generation, operationKey: key, activate,
})
const enable = (store, releaseId, generation, key) => store.enable({ releaseId, expectedGeneration: generation, operationKey: key })
async function stateBytes(root) { return readFile(join(root, 'state.json'), 'utf8') }

test('verified download enters inventory without activation; explicit enable and all-disabled work', async t => {
  const { root, stateRoot, store } = await context(t)
  const v1 = await release(root)
  const installed = await install(store, v1, 0, 'download')
  assert.equal(installed.state.generation, 1)
  assert.deepEqual(installed.state.active, {})
  assert.equal(installed.operation.result.activated, false)
  assert.equal(Object.keys(installed.state.installed).length, 1)
  const active = await enable(store, 'release.v1', 1, 'enable')
  assert.deepEqual(active.state.active, { 'demo.review': 'release.v1' })
  const snapshot = await store.activeSnapshot()
  assert.equal(snapshot.packs[0].releaseId, 'release.v1')
  assert.ok(Object.isFrozen(snapshot.packs[0]))
  await store.disable({ packId: 'demo.review', expectedGeneration: 2, operationKey: 'disable' })
  assert.equal((await store.activeSnapshot()).packs.length, 0)
  assert.ok((await stateBytes(stateRoot)).includes('release.v1'))
})

test('cached release update/enable and offline rollback preserve captured old content paths', async t => {
  const { root, store } = await context(t)
  const v1 = await release(root)
  const v2 = await release(root, 'v2')
  await install(store, v1, 0, 'v1', true)
  const oldSnapshot = await store.activeSnapshot()
  await install(store, v2, 1, 'cache-v2')
  assert.equal((await store.activeSnapshot()).packs[0].releaseId, 'release.v1')
  await unlink(v2.archiveFile)
  const switched = await install(store, v2, 2, 'activate-v2', true)
  assert.equal(switched.operation.result.activated, true)
  assert.equal(switched.state.installed['release.v2'].previousReleaseId, 'release.v1')
  assert.equal((await store.activeSnapshot()).packs[0].releaseId, 'release.v2')
  await unlink(v1.archiveFile)
  const rolledBack = await store.rollback({ packId: 'demo.review', releaseId: 'release.v1', expectedGeneration: 3, operationKey: 'rollback' })
  assert.equal(rolledBack.state.active['demo.review'], 'release.v1')
  const oldContent = JSON.parse(await readFile(join(oldSnapshot.packs[0].root, 'pack.json'), 'utf8'))
  assert.equal(oldContent.experts[0].display.publicLabel, '样例 V1')
  assert.equal(oldSnapshot.generation, 1)
})

test('identical install retries need no original archive and do not increase generation', async t => {
  const { root, store } = await context(t)
  const v1 = await release(root)
  const first = await install(store, v1, 0, 'same')
  await unlink(v1.archiveFile)
  const retry = await install(store, v1, 0, 'same')
  assert.equal(retry.replayed, true)
  assert.equal(retry.state.generation, first.state.generation)
  await assert.rejects(install(store, v1, 0, 'same', true), errCode('IDEMPOTENCY_CONFLICT'))
})

test('archive tampering never changes existing activation and leaves no runnable staging tree', async t => {
  const { root, stateRoot, store } = await context(t)
  await install(store, await release(root), 0, 'old', true)
  const before = await stateBytes(stateRoot)
  const v2 = await release(root, 'v2')
  const bytes = await readFile(v2.archiveFile)
  bytes[1000] ^= 0x20
  await writeFile(v2.archiveFile, bytes)
  await assert.rejects(install(store, v2, 1, 'tampered', true))
  assert.equal(await stateBytes(stateRoot), before)
  assert.deepEqual(await readdir(join(stateRoot, '.incoming')), [])
  assert.equal((await store.activeSnapshot()).packs[0].releaseId, 'release.v1')
})

test('unsigned metadata edits, wrong center, incompatible plugin and identity mismatch are rejected', async t => {
  const { root, stateRoot, store } = await context(t)
  const v1 = await release(root)
  const before = await stateBytes(stateRoot)
  const changed = structuredClone(v1)
  changed.envelope.manifest.ownerOrgId = 'org.evil'
  await assert.rejects(install(store, changed, 0, 'unsigned'))
  const wrongCenter = await release(root, 'v1', { centerId: 'other.center' })
  await assert.rejects(install(store, wrongCenter, 0, 'wrong-center'), errCode('CENTER_MISMATCH'))
  const incompatible = await release(root, 'v1', { requiresPlugin: { minVersion: '99.0.0' } })
  await assert.rejects(install(store, incompatible, 0, 'incompatible'), errCode('INCOMPATIBLE_RELEASE'))
  const identity = await release(root, 'v1', { packId: 'wrong.identity' })
  await assert.rejects(install(store, identity, 0, 'identity'), errCode('PACK_IDENTITY_MISMATCH'))
  assert.equal(await stateBytes(stateRoot), before)
})

test('a release ID cannot be reused with a different signed compatibility requirement', async t => {
  const { root, stateRoot, store } = await context(t)
  const v1 = await release(root)
  await install(store, v1, 0, 'v1')
  const before = await stateBytes(stateRoot)
  const conflict = await release(root, 'v1', { requiresPlugin: { minVersion: '0.0.1' } })
  await assert.rejects(install(store, conflict, 1, 'conflict'), errCode('IMMUTABLE_RELEASE_CONFLICT'))
  assert.equal(await stateBytes(stateRoot), before)
})

test('owner namespace and pack-version identity collisions do not replace a valid installed release', async t => {
  const { root, stateRoot, store } = await context(t)
  await install(store, await release(root), 0, 'v1', true)
  const before = await stateBytes(stateRoot)
  const owner = await release(root, 'v2', { ownerOrgId: 'org.two' })
  await assert.rejects(install(store, owner, 1, 'owner'), errCode('PACK_OWNER_CONFLICT'))
  const version = await release(root, 'v1', { releaseId: 'release.other' })
  await assert.rejects(install(store, version, 1, 'version'), errCode('IMMUTABLE_VERSION_CONFLICT'))
  assert.equal(await stateBytes(stateRoot), before)
})

test('modified installed files cannot be enabled, used in a snapshot, or rolled back to', async t => {
  const { root, stateRoot, store } = await context(t)
  const first = await install(store, await release(root), 0, 'v1', true)
  await install(store, await release(root, 'v2'), 1, 'v2', true)
  const before = await stateBytes(stateRoot)
  const oldPath = first.state.installed['release.v1'].packPath
  await writeFile(join(oldPath, 'README.md'), 'tampered')
  await assert.rejects(enable(store, 'release.v1', 2, 'bad-enable'), errCode('CONTENT_DIGEST_MISMATCH'))
  await assert.rejects(store.rollback({ packId: 'demo.review', releaseId: 'release.v1', expectedGeneration: 2, operationKey: 'bad-rollback' }), errCode('CONTENT_DIGEST_MISMATCH'))
  assert.equal(await stateBytes(stateRoot), before)
  const current = await store.activeSnapshot()
  await writeFile(join(current.packs[0].root, 'README.md'), 'also tampered')
  await assert.rejects(store.activeSnapshot(), errCode('CONTENT_DIGEST_MISMATCH'))
})

test('generation CAS prevents concurrent active switches; replay of winner is stable', async t => {
  const { root, store } = await context(t)
  await install(store, await release(root), 0, 'v1')
  await install(store, await release(root, 'v2'), 1, 'v2')
  const results = await Promise.allSettled([
    enable(store, 'release.v1', 2, 'enable-v1'), enable(store, 'release.v2', 2, 'enable-v2'),
  ])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'GENERATION_CONFLICT')
  const won = results.find(item => item.status === 'fulfilled').value
  const retry = await enable(store, won.operation.result.releaseId, 2, won.operation.operationKey)
  assert.equal(retry.replayed, true)
  assert.equal(retry.state.generation, 3)
})

test('state commit failure keeps old release; uncertain committed reply resolves via identical retry', async t => {
  let inject
  const { root, stateRoot, store } = await context(t, { fault: point => { if (point === inject) throw new Error('simulated power loss') } })
  await install(store, await release(root), 0, 'v1', true)
  const before = await stateBytes(stateRoot)
  const v2 = await release(root, 'v2')
  inject = 'before-state-rename'
  await assert.rejects(install(store, v2, 1, 'v2', true), errCode('STATE_WRITE_FAILED'))
  assert.equal(await stateBytes(stateRoot), before)
  inject = 'after-state-rename'
  await assert.rejects(install(store, v2, 1, 'v2', true), errCode('STATE_COMMIT_UNCERTAIN'))
  inject = undefined
  const retry = await install(store, v2, 1, 'v2', true)
  assert.equal(retry.replayed, true)
  assert.equal(retry.state.active['demo.review'], 'release.v2')
})

test('corrupt state recovers a verified previous snapshot read-only and preserves corrupt bytes', async t => {
  const { root, stateRoot, store } = await context(t)
  await install(store, await release(root), 0, 'v1', true)
  await install(store, await release(root, 'v2'), 1, 'v2', true)
  await writeFile(join(stateRoot, 'state.json'), '{broken')
  const snapshot = await store.activeSnapshot()
  assert.equal(snapshot.mode, 'recovered-read-only')
  assert.equal(snapshot.packs[0].releaseId, 'release.v1')
  await assert.rejects(store.disable({ packId: 'demo.review', expectedGeneration: 1, operationKey: 'write-recovery' }), errCode('STATE_READ_ONLY'))
  assert.equal(await stateBytes(stateRoot), '{broken')
})

test('corrupt state with corrupted previous inventory refuses recovery', async t => {
  const { root, stateRoot, store } = await context(t)
  const first = await install(store, await release(root), 0, 'v1', true)
  await install(store, await release(root, 'v2'), 1, 'v2', true)
  await writeFile(join(stateRoot, 'state.json'), '{broken')
  await writeFile(join(first.state.installed['release.v1'].packPath, 'README.md'), 'broken')
  await assert.rejects(store.readState(), errCode('STATE_RECOVERY_INVALID'))
  assert.equal(await stateBytes(stateRoot), '{broken')
})

test('uninstall refuses active release and keeps inactive content for earlier task snapshots', async t => {
  const { root, store } = await context(t)
  await install(store, await release(root), 0, 'v1', true)
  const old = await store.activeSnapshot()
  await assert.rejects(store.uninstall({ releaseId: 'release.v1', expectedGeneration: 1, operationKey: 'active-uninstall' }), errCode('RELEASE_ACTIVE'))
  await install(store, await release(root, 'v2'), 1, 'v2', true)
  const result = await store.uninstall({ releaseId: 'release.v1', expectedGeneration: 2, operationKey: 'inactive-uninstall' })
  assert.equal(result.state.installed['release.v1'], undefined)
  assert.equal(result.state.installed['release.v2'].previousReleaseId, undefined)
  assert.equal(result.operation.result.retainedFiles, true)
  assert.ok((await stat(join(old.packs[0].root, 'pack.json'))).isFile())
})

test('exact forward and reverse dependencies block incompatible update and disable', async t => {
  const { root, store } = await context(t)
  const v1 = await release(root)
  const v2 = await release(root, 'v2')
  const dependency = v1.envelope.manifest
  const source = join(root, 'consumer')
  await mkdir(source)
  const json = JSON.parse(await readFile(join(fixture('demo-v1'), 'pack.json'), 'utf8'))
  const independent = JSON.parse(JSON.stringify(json).replaceAll('demo.review', 'dep.consumer'))
  await writeFile(join(source, 'pack.json'), JSON.stringify(independent))
  const archiveFile = join(root, 'consumer.tar')
  const artifact = await packDirectory(source, archiveFile)
  const envelope = signReleaseManifest({
    ...dependency, releaseId: 'consumer.v1', packId: 'dep.consumer', approvedSubmissionId: 'consumer.submission',
    artifactSha256: artifact.artifactSha256, contentTreeSha256: artifact.contentTreeSha256,
    fileCount: artifact.fileCount, sizeBytes: artifact.sizeBytes,
    dependencyLock: [{
      packId: dependency.packId, ownerOrgId: dependency.ownerOrgId, releaseId: dependency.releaseId,
      version: dependency.version, artifactSha256: dependency.artifactSha256, contentTreeSha256: dependency.contentTreeSha256,
    }],
  }, privateKey)
  await install(store, { envelope, archiveFile }, 0, 'consumer')
  await assert.rejects(enable(store, 'consumer.v1', 1, 'missing-dependency'), errCode('DEPENDENCY_BLOCKED'))
  await install(store, v1, 1, 'dependency', true)
  await enable(store, 'consumer.v1', 2, 'consumer-enable')
  await install(store, v2, 3, 'cache-v2')
  await assert.rejects(enable(store, 'release.v2', 4, 'blocked-update'), error => {
    assert.equal(error.code, 'DEPENDENCY_BLOCKED')
    assert.equal(error.details.affectedPackId, 'dep.consumer')
    return true
  })
  await assert.rejects(store.disable({ packId: 'demo.review', expectedGeneration: 4, operationKey: 'blocked-disable' }), errCode('DEPENDENCY_BLOCKED'))
  assert.equal((await store.readState()).state.active['demo.review'], 'release.v1')
})

test('built-in dependencies and changed local plugin capabilities are checked without downloads', async t => {
  const { root, stateRoot, store } = await context(t)
  const input = await release(root, 'v1', { builtinDependencies: [{ packId: 'builtin.core', minVersion: '2.0.0' }] })
  await install(store, input, 0, 'cache')
  await assert.rejects(enable(store, 'release.v1', 1, 'no-builtin'), errCode('BUILTIN_DEPENDENCY_BLOCKED'))
  const available = createPackStore(stateRoot, { ...defaults, builtinVersions: { 'builtin.core': '2.1.0' } })
  await enable(available, 'release.v1', 1, 'with-builtin')
  await unlink(input.archiveFile)
  const oldPlugin = createPackStore(stateRoot, { ...defaults, capabilities: { pluginVersion: '0.0.1' }, builtinVersions: { 'builtin.core': '2.1.0' } })
  await assert.rejects(oldPlugin.activeSnapshot(), errCode('INCOMPATIBLE_RELEASE'))
})

test('two independent local stores can keep different active versions', async t => {
  const a = await context(t)
  const b = await context(t)
  const v1 = await release(a.root)
  const v2 = await release(a.root, 'v2')
  await install(a.store, v1, 0, 'initial', true)
  await install(b.store, v1, 0, 'initial', true)
  await install(a.store, v2, 1, 'update', true)
  assert.equal((await a.store.activeSnapshot()).packs[0].releaseId, 'release.v2')
  assert.equal((await b.store.activeSnapshot()).packs[0].releaseId, 'release.v1')
  assert.equal((await b.store.readState()).state.generation, 1)
})

test('failed host activation keeps a verified download with an explicit unsuccessful outcome', async t => {
  let block = false
  const { root, store } = await context(t, { validateActivation: () => { if (block) throw new Error('workspace conflict') } })
  await install(store, await release(root), 0, 'v1', true)
  block = true
  const v2 = await release(root, 'v2')
  const result = await install(store, v2, 1, 'v2', true)
  assert.equal(result.operation.result.status, 'installed_not_enabled')
  assert.equal(result.operation.result.activated, false)
  assert.equal(result.operation.result.activationError.code, 'ACTIVATION_PREFLIGHT_FAILED')
  assert.equal(result.state.active['demo.review'], 'release.v1')
  assert.ok(result.state.installed['release.v2'])
  await unlink(v2.archiveFile)
  const retry = await install(store, v2, 1, 'v2', true)
  assert.equal(retry.replayed, true)
  assert.equal(retry.operation.result.status, 'installed_not_enabled')
  block = false
  await enable(store, 'release.v2', 2, 'try-enable-again')
  assert.equal((await store.activeSnapshot()).packs[0].releaseId, 'release.v2')
})

test('distinct SemVer build metadata is distinct immutable identity, not an automatic priority increase', async t => {
  const { root, store } = await context(t)
  const base = await release(root)
  for (const [index, build] of ['one', 'two'].entries()) {
    const source = join(root, `build-${build}`)
    await mkdir(source)
    const pack = JSON.parse(await readFile(join(fixture('demo-v1'), 'pack.json'), 'utf8'))
    pack.pack.version = `1.0.0+${build}`
    await writeFile(join(source, 'pack.json'), JSON.stringify(pack))
    const archiveFile = join(root, `build-${build}.tar`)
    const artifact = await packDirectory(source, archiveFile)
    const envelope = signReleaseManifest({
      ...base.envelope.manifest, version: pack.pack.version, releaseId: `build.${build}`,
      artifactSha256: artifact.artifactSha256, contentTreeSha256: artifact.contentTreeSha256,
      sizeBytes: artifact.sizeBytes, fileCount: artifact.fileCount,
    }, privateKey)
    await install(store, { envelope, archiveFile }, index, `build-${build}`)
  }
  assert.equal(Object.keys((await store.readState()).state.installed).length, 2)
})

test('different packs cannot silently replace an already-active entity', async t => {
  const { root, store } = await context(t)
  const base = await release(root)
  await install(store, base, 0, 'v1', true)
  const source = join(root, 'conflicting')
  await mkdir(source)
  const pack = JSON.parse(await readFile(join(fixture('demo-v1'), 'pack.json'), 'utf8'))
  pack.pack.id = 'different.pack'
  await writeFile(join(source, 'pack.json'), JSON.stringify(pack))
  const archiveFile = join(root, 'conflict.tar')
  const artifact = await packDirectory(source, archiveFile)
  const envelope = signReleaseManifest({
    ...base.envelope.manifest, packId: pack.pack.id, releaseId: 'different.release',
    artifactSha256: artifact.artifactSha256, contentTreeSha256: artifact.contentTreeSha256,
    sizeBytes: artifact.sizeBytes, fileCount: artifact.fileCount,
  }, privateKey)
  await install(store, { envelope, archiveFile }, 1, 'cache-conflict')
  await assert.rejects(enable(store, 'different.release', 2, 'conflict'), errCode('ENTITY_CONFLICT'))
  assert.deepEqual((await store.readState()).state.active, { 'demo.review': 'release.v1' })
})

test('uninstall does not erase the accepted immutable version or owner binding', async t => {
  const { root, store } = await context(t)
  const original = await release(root)
  await install(store, original, 0, 'first')
  await store.uninstall({ releaseId: 'release.v1', expectedGeneration: 1, operationKey: 'remove' })
  const conflict = await release(root, 'v1', { releaseId: 'replacement.release', requiresPlugin: { minVersion: '0.0.1' } })
  await assert.rejects(install(store, conflict, 2, 'replace-version'), errCode('IMMUTABLE_VERSION_CONFLICT'))
  const owner = await release(root, 'v2', { ownerOrgId: 'another.org' })
  await assert.rejects(install(store, owner, 2, 'replace-owner'), errCode('PACK_OWNER_CONFLICT'))
  const originalManifestChanged = await release(root, 'v1', { requiresPlugin: { minVersion: '0.0.1' } })
  await assert.rejects(install(store, originalManifestChanged, 2, 'replace-manifest'), errCode('IMMUTABLE_RELEASE_CONFLICT'))
  await unlink(original.archiveFile)
  const restored = await install(store, original, 2, 'reinstall-same')
  assert.equal(restored.state.installed['release.v1'].version, '1.0.0')
  assert.equal(Object.keys(restored.state.acceptedReleases).length, 1)
})

test('mutation of caller request during install cannot change signed bytes or activation choice', async t => {
  const { root, store } = await context(t)
  const request = { ...await release(root), operationKey: 'immutable-input', expectedGeneration: 0, activate: false }
  const pending = store.install(request)
  request.activate = true
  request.envelope.manifest.version = '9.9.9'
  request.envelope.signature = 'bad'
  const result = await pending
  assert.deepEqual(result.state.active, {})
  assert.equal(result.state.installed['release.v1'].version, '1.0.0')
})

test('legacy takeover switches exact paths atomically, supports offline history rollback and explicit restore', async t => {
  const { root, store } = await context(t)
  const oldPath = join(root, 'vendor', 'old')
  const newPath = join(root, 'vendor', 'new')
  await cp(fixture('demo-v1'), oldPath, { recursive: true })
  await cp(fixture('demo-v2'), newPath, { recursive: true })
  const oldDigest = (await hashContentDirectory(oldPath)).contentTreeSha256
  const newDigest = (await hashContentDirectory(newPath)).contentTreeSha256
  const first = await store.takeOverLegacy({ vendorPath: oldPath, expectedContentTreeSha256: oldDigest, expectedGeneration: 0, operationKey: 'take-old' })
  assert.equal(first.operation.result.source, 'legacy')
  assert.deepEqual(Object.keys(first.state.legacySuppressions), [oldPath])
  assert.equal(Object.keys(first.state.acceptedReleases).length, 0, 'Local backup must not become a center-approved receipt')
  assert.equal((await store.activeSnapshot()).packs[0].source, 'legacy')
  assert.equal((await hashContentDirectory(oldPath)).contentTreeSha256, oldDigest)
  await store.takeOverLegacy({ vendorPath: newPath, expectedContentTreeSha256: newDigest, expectedGeneration: 1, operationKey: 'take-new' })
  const oldReleaseId = `legacy.${oldDigest}`
  const rolledBack = await store.rollback({ packId: 'demo.review', releaseId: oldReleaseId, expectedGeneration: 2, operationKey: 'legacy-rollback' })
  assert.equal(rolledBack.state.active['demo.review'], oldReleaseId)
  await store.disable({ packId: 'demo.review', expectedGeneration: 3, operationKey: 'legacy-disable' })
  assert.equal((await store.activeSnapshot()).packs.length, 0)
  assert.equal((await store.activeSnapshot()).suppressedLegacyPaths.length, 2, 'Disable does not reactivate automatic vendor discovery')
  const restored = await store.restoreLegacyManagement({ vendorPath: oldPath, expectedGeneration: 4, operationKey: 'legacy-restore' })
  assert.deepEqual(Object.keys(restored.state.legacySuppressions), [newPath])
  assert.deepEqual(restored.state.active, {})
  assert.ok((await stat(restored.state.installed[oldReleaseId].packPath)).isDirectory())
})

test('legacy source changes after takeover do not change the backup; restore refuses changed source', async t => {
  const { root, stateRoot, store } = await context(t)
  const vendorPath = join(root, 'old')
  await cp(fixture('demo-v1'), vendorPath, { recursive: true })
  const expectedContentTreeSha256 = (await hashContentDirectory(vendorPath)).contentTreeSha256
  await store.takeOverLegacy({ vendorPath, expectedContentTreeSha256, expectedGeneration: 0, operationKey: 'takeover' })
  const before = await stateBytes(stateRoot)
  await writeFile(join(vendorPath, 'README.md'), 'Changed outside management')
  assert.equal((await store.activeSnapshot()).packs.length, 1)
  await assert.rejects(store.restoreLegacyManagement({ vendorPath, expectedGeneration: 1, operationKey: 'restore' }), errCode('LEGACY_SOURCE_CHANGED'))
  assert.equal(await stateBytes(stateRoot), before)
  const replayed = await store.takeOverLegacy({ vendorPath, expectedContentTreeSha256, expectedGeneration: 0, operationKey: 'takeover' })
  assert.equal(replayed.replayed, true)
})

test('legacy takeover failure before commit leaves automatic source untouched and unsuppressed', async t => {
  const { root, stateRoot, store } = await context(t, { fault: point => { if (point === 'before-state-rename') throw new Error('crash') } })
  const vendorPath = join(root, 'old')
  await cp(fixture('demo-v1'), vendorPath, { recursive: true })
  const expectedContentTreeSha256 = (await hashContentDirectory(vendorPath)).contentTreeSha256
  const before = await stateBytes(stateRoot)
  await assert.rejects(store.takeOverLegacy({ vendorPath, expectedContentTreeSha256, expectedGeneration: 0, operationKey: 'takeover' }), errCode('STATE_WRITE_FAILED'))
  assert.equal(await stateBytes(stateRoot), before)
  assert.deepEqual((await store.readState()).state.legacySuppressions, {})
  assert.equal((await hashContentDirectory(vendorPath)).contentTreeSha256, expectedContentTreeSha256)
})
