/** Real plugin lifecycle/three-base runtime integration with signed local fixtures.
 * Remote publication/browser flow is covered separately; these are not two DSH instances. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packDirectory } from '../packages/pack-artifact/index.mjs'
import { canonicalBytes, sha256, signReleaseManifest } from '../packages/pack-contract/index.mjs'

const source = process.env.PACK_HOST_SOURCE === '1'
const { createPackCenterHost, resolvePackCenterDir } = await import(source ? '../src/host/pack-center-host.ts' : '../lib/host/pack-center-host.js')
const { createPackCenterConnectionStore } = await import(source ? '../src/host/pack-center-connection.ts' : '../lib/host/pack-center-connection.js')
const { createPackStore } = await import(source ? '../src/host/pack-store.ts' : '../lib/host/pack-store.js')
const { resolveManagedRuntimePack } = await import(source ? '../src/host/pack-runtime.ts' : '../lib/host/pack-runtime.js')
const { builtinLegacyPack } = await import(source ? '../src/v2/compat.ts' : '../lib/v2/compat.js')
const fixturePack = fileURLToPath(new URL('../examples/pack-center/demo-v1', import.meta.url))
const hasCode = expected => error => error?.code === expected
async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'pack-center-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const ctx = { logger: { warn() {} }, get(key) {
    if (['workspace', 'workspaceRegistry'].includes(key)) return { list: () => [{ path: workspace }] }
    if (key === 'sessions') return { list: () => [] }
  } }
  const config = { knowledgeDir: 'knowledge', packsDir: 'domain-packs', vendorPacksDir: '',
    packCenterDir: join(root, 'deployment'), packCenterOrigin: 'https://center.invalid' }
  return { root, workspace, ctx, config }
}
async function localRelease(f) {
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const connection = { origin: f.config.packCenterOrigin, centerId: 'host.center', organizationId: 'host.owner', deploymentId: 'host.deployment',
    credentialId: 'host.credential', credentialToken: null, credentialExpiresAt: '2030-01-01T00:00:00.000Z', boundAt: '2026-01-01T00:00:00.000Z',
    trustedSigningKeys: { 'host.key': publicKey } }
  await createPackCenterConnectionStore(join(f.config.packCenterDir, 'private')).write(connection, 0)
  const archiveFile = join(f.root, 'fixture.tar'), artifact = await packDirectory(fixturePack, archiveFile)
  const manifest = { schemaVersion: 1, protocolVersion: 1, normalizationVersion: 1, digestAlgorithmVersion: 1,
    signatureAlgorithm: 'Ed25519', archiveFormat: 'tar', centerId: connection.centerId, releaseId: 'host.release', packId: 'demo.review',
    ownerOrgId: connection.organizationId, version: '1.0.0', sourceCommit: 'a'.repeat(40), artifactSha256: artifact.artifactSha256,
    contentTreeSha256: artifact.contentTreeSha256, reportSha256: sha256(canonicalBytes({})), validatorVersion: '0.1.0', packSchemaVersion: 2,
    requiresPlugin: { minVersion: '0.1.0' }, dependencyLock: [], builtinDependencies: [], sizeBytes: artifact.sizeBytes, fileCount: artifact.fileCount,
    approvedSubmissionId: 'host.submission', signingKeyId: 'host.key' }
  const store = createPackStore(join(f.config.packCenterDir, 'inventory'), {
    centerId: connection.centerId, trustedKeys: connection.trustedSigningKeys, capabilities: { pluginVersion: '0.1.0' },
  })
  await store.initialize()
  await store.install({ operationKey: 'fixture-install', expectedGeneration: 0, envelope: signReleaseManifest(manifest, keys.privateKey), archiveFile })
  return { store, manifest }
}
async function finished(service, id) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const job = await service.operation(id)
    if (!['queued', 'running'].includes(job.status)) return job
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  assert.fail('Local operation did not finish before test deadline')
}

test('private storage defaults only under a known DSH_HOME and rejects broad/noncanonical paths', () => {
  assert.equal(resolvePackCenterDir('', ''), '')
  assert.equal(resolvePackCenterDir(undefined, '/tmp/fixture-dsh'), '/tmp/fixture-dsh/expert-library-pack-center')
  assert.equal(resolvePackCenterDir('/tmp/fixture-local', '/ignored'), '/tmp/fixture-local')
  for (const root of ['/', homedir(), './relative', '/tmp/../other', '/tmp/path/']) assert.throws(() => resolvePackCenterDir(root, ''), hasCode('CENTER_INVALID_STORAGE'))
})

test('configured but unbound read surfaces and runtime snapshot create no local inventory', async t => {
  const f = await scratch(t), host = createPackCenterHost(f.ctx, f.config, () => [f.workspace])
  t.after(() => host.service.close())
  const view = await host.service.connection()
  assert.equal(view.configuredOrigin, 'https://center.invalid')
  assert.equal(view.activationAvailable, true)
  assert.equal(view.connection, null)
  assert.deepEqual(await host.service.installations(), { generation: 0, mode: 'normal', items: [] })
  assert.deepEqual(await host.activeSnapshot(), { generation: 0, mode: 'normal', packs: [], suppressedLegacyPaths: [] })
  await assert.rejects(lstat(f.config.packCenterDir), { code: 'ENOENT' })
})

test('plugin preflight enables a signed offline cache and the actual runtime sees it; config switch requires restart', async t => {
  const f = await scratch(t), local = await localRelease(f)
  const host = createPackCenterHost(f.ctx, f.config, () => [f.workspace])
  t.after(() => host.service.close())
  const queued = await host.service.enqueue({ operationKey: 'enable-fixture', expectedGeneration: 1, kind: 'enable', releaseId: local.manifest.releaseId })
  const result = await finished(host.service, queued.operationId)
  assert.equal(result.status, 'succeeded', result.errorCode)
  assert.equal(result.result.generation, 2)
  const snapshot = await host.activeSnapshot()
  assert.equal(snapshot.packs[0].releaseId, local.manifest.releaseId)
  const merged = await resolveManagedRuntimePack(f.ctx, { ...f.config, getPackCenterSnapshot: () => host.activeSnapshot() }, builtinLegacyPack())
  assert.equal(merged.pack.experts.find(item => item.id === 'demo.review.expert').display.publicLabel, '样例 V1')
  const originalRoot = f.config.packCenterDir
  f.config.packCenterDir = join(f.root, 'different-deployment')
  f.config.packCenterOrigin = 'https://different.invalid'
  assert.equal((await host.service.connection()).errorCode, 'CENTER_RESTART_REQUIRED')
  assert.equal((await host.service.connection()).configuredOrigin, 'https://center.invalid')
  await assert.rejects(host.service.enqueue({ operationKey: 'blocked-change', expectedGeneration: 2, kind: 'disable', packId: 'demo.review' }), hasCode('CENTER_RESTART_REQUIRED'))
  await assert.rejects(host.service.catalog(), hasCode('CENTER_RESTART_REQUIRED'))
  await assert.rejects(host.service.bind({}), hasCode('CENTER_RESTART_REQUIRED'))
  await assert.rejects(host.service.retry(queued.operationId), hasCode('CENTER_RESTART_REQUIRED'))
  assert.equal((await host.service.operations())[0].status, 'succeeded')
  assert.deepEqual(await host.activeSnapshot(), snapshot)
  assert.equal((await host.service.installations()).generation, 2)
  await assert.rejects(lstat(f.config.packCenterDir), { code: 'ENOENT' })
  assert.equal((await local.store.readState()).state.active['demo.review'], local.manifest.releaseId)
  assert.ok(originalRoot !== f.config.packCenterDir)
})

test('actual workspace conflict rejects activation without losing the verified cached release', async t => {
  const f = await scratch(t), local = await localRelease(f)
  await cp(fixturePack, join(f.workspace, 'domain-packs', 'collision'), { recursive: true })
  const host = createPackCenterHost(f.ctx, f.config, () => [f.workspace])
  t.after(() => host.service.close())
  const queued = await host.service.enqueue({ operationKey: 'enable-conflict', expectedGeneration: 1, kind: 'enable', releaseId: local.manifest.releaseId })
  const job = await finished(host.service, queued.operationId)
  assert.equal(job.status, 'failed')
  assert.equal(job.errorCode, 'CENTER_PACK_ID_CONFLICT')
  const inventory = await host.service.installations()
  assert.equal(inventory.generation, 1)
  assert.equal(inventory.items[0].integrity, 'verified')
  assert.equal(inventory.items[0].active, false)
  assert.deepEqual((await host.activeSnapshot()).packs, [])
})

test('plugin source wiring retains the legacy cards and registers protected center routes before URL normalization', async () => {
  const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const client = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const centerCard = await readFile(new URL('../src/client/pack-center-card.tsx', import.meta.url), 'utf8')
  const validationCard = await readFile(new URL('../src/client/domain-packs-card.tsx', import.meta.url), 'utf8')
  assert.match(index, /runtimeConfig\.getPackCenterSnapshot = \(\) => packCenter\.activeSnapshot\(\)/)
  const manage = index.slice(index.indexOf("path: '/plugins/dsh-expert-library/manage'"))
  assert.ok(manage.indexOf('handlePackCenter(req, res)') < manage.indexOf("new URL(req.url"))
  assert.match(index, /getManageToken: \(\) => resolveManageToken\(runtimeConfig.manageToken\)/)
  for (const id of ['expert-library-packs', 'expert-library-center', 'expert-library-manage']) assert.ok(client.includes(`id: '${id}'`))
  assert.match(client, /id: 'expert-library-packs'[\s\S]*?label: '领域包校验'/)
  assert.match(client, /id: 'expert-library-center'[\s\S]*?label: '领域包'/)
  assert.match(client, /}, PackCenterCard\)/)
  assert.match(centerCard, /aria-label="领域包版本管理"/)
  assert.match(validationCard, />领域包校验<\/h2>/)
})
