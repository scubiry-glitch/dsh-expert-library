import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalBytes } from '../packages/pack-contract/index.mjs'
import { managerFixture } from './support/pack-center-manager-fixture.mjs'

const isCode = code => error => error?.code === code
async function waitFor(predicate, message = 'condition') {
  const end = Date.now() + 15_000
  while (Date.now() < end) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${message}`)
}
async function terminal(manager, id) {
  return waitFor(async () => { const job = await manager.operation(id); return ['succeeded', 'failed', 'interrupted'].includes(job.status) && job }, 'terminal operation')
}
async function install(f, release, operationKey, expectedGeneration, kind = 'install') {
  const job = await f.current.enqueue({ operationKey, kind, expectedGeneration, releaseId: release.manifest.releaseId,
    connectionRevision: (await f.current.connection()).revision, target: f.target(release) })
  return terminal(f.current, job.operationId)
}
async function activeBaseline(f) {
  const v1 = await f.addRelease({ releaseId: 'release.v1', version: '1.0.0' })
  await f.bind()
  assert.equal((await install(f, v1, 'cache-v1', 0)).status, 'succeeded')
  const enabled = await f.current.enqueue({ operationKey: 'enable-v1', kind: 'enable', expectedGeneration: 1, releaseId: 'release.v1' })
  assert.equal((await terminal(f.current, enabled.operationId)).status, 'succeeded')
  return v1
}

test('manager enqueues real signed install asynchronously, exposes phases, caches only, and returns no private data', async t => {
  const f = await managerFixture(t), v1 = await f.addRelease({ releaseId: 'release.v1', version: '1.0.0' })
  const entered = f.gate(), release = f.gate()
  f.wire.artifactHook = async () => { entered.resolve(); await release.promise }
  await f.bind()
  const input = { operationKey: 'cache-v1', kind: 'install', expectedGeneration: 0, releaseId: 'release.v1', connectionRevision: 1, target: f.target(v1) }
  const job = await f.current.enqueue(input)
  await entered.promise
  const running = await f.current.operation(job.operationId)
  assert.equal(running.status, 'running'); assert.equal(running.phase, 'downloading')
  assert.equal((await f.current.installations()).generation, 0)
  release.resolve()
  const done = await terminal(f.current, job.operationId)
  assert.equal(done.status, 'succeeded'); assert.equal(done.result.activated, false); assert.equal(done.result.generation, 1)
  const local = await f.current.installations()
  assert.equal(local.items.length, 1); assert.equal(local.items[0].active, false); assert.equal(local.items[0].integrity, 'verified')
  const publicData = JSON.stringify([await f.current.connection(), await f.current.catalog(), local, await f.current.operations()])
  for (const secret of [f.root, f.wire.token, 'credentialToken', 'trustedSigningKeys', 'BEGIN PUBLIC KEY', 'packPath', 'manifestPath']) assert.equal(publicData.includes(secret), false)
  const paths = [...f.wire.paths]
  await f.current.unbind({ expectedRevision: 1 }); await f.current.close()
  // Deterministic crash boundary: the inventory transaction committed, but the
  // journal's completion rename was lost. Reconcile from the real local receipt.
  const journalPath = join(f.root, 'operations', 'operations.json')
  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  journal.revision++
  journal.jobs[0].status = 'running'; journal.jobs[0].phase = 'installing'; delete journal.jobs[0].result
  await writeFile(journalPath, Buffer.concat([canonicalBytes(journal), Buffer.from('\n')]), { mode: 0o600 })
  await f.stop()
  const next = f.manager()
  await next.start()
  assert.equal((await next.enqueue(input)).status, 'succeeded')
  assert.deepEqual(f.wire.paths, paths)
  assert.equal((await next.installations()).items[0].integrity, 'verified')
})

test('manager rejects stale generation/revision before queueing and fixed target changes before artifact bytes', async t => {
  const f = await managerFixture(t), v1 = await f.addRelease({ releaseId: 'release.v1', version: '1.0.0' })
  await f.bind()
  const input = { operationKey: 'fixed', kind: 'install', expectedGeneration: 0, releaseId: 'release.v1', connectionRevision: 1, target: f.target(v1) }
  await assert.rejects(f.current.enqueue({ ...input, expectedGeneration: 1 }), isCode('GENERATION_CONFLICT'))
  await assert.rejects(f.current.enqueue({ ...input, connectionRevision: 0 }), isCode('REVISION_CONFLICT'))
  assert.deepEqual(await f.current.operations(), [])
  const job = await f.current.enqueue({ ...input, target: { ...input.target, manifestSha256: '0'.repeat(64) } })
  const done = await terminal(f.current, job.operationId)
  assert.equal(done.status, 'failed'); assert.equal(done.errorCode, 'CENTER_TARGET_CHANGED')
  assert.equal(f.wire.paths.filter(path => path.endsWith('/artifact')).length, 0)
  assert.equal((await f.current.installations()).generation, 0)
  await assert.rejects(f.current.enqueue(input), isCode('IDEMPOTENCY_CONFLICT'))
})

test('failed update-and-enable keeps previous active release, retains cache, and records failed partial receipt', async t => {
  let rejectV2 = true
  const f = await managerFixture(t, { validateActivation: state => {
    if (rejectV2 && state.active['demo.review'] === 'release.v2') throw Object.assign(new Error('private activation details'), { code: 'ENTITY_CONFLICT' })
  } })
  await activeBaseline(f)
  const v2 = await f.addRelease({ releaseId: 'release.v2', version: '1.1.0' })
  const update = await install(f, v2, 'update-v2', 2, 'update_enable')
  assert.equal(update.status, 'failed'); assert.equal(update.errorCode, 'ENTITY_CONFLICT')
  assert.equal(update.result.outcome, 'installed_not_enabled'); assert.equal(update.result.activated, false); assert.equal(update.result.generation, 3)
  const local = await f.current.installations()
  assert.equal(local.items.find(item => item.releaseId === 'release.v1').active, true)
  assert.equal(local.items.find(item => item.releaseId === 'release.v2').active, false)
  assert.ok(local.items.every(item => item.integrity === 'verified'))
  rejectV2 = false
  const before = [...f.wire.paths]
  await f.current.retry(update.operationId)
  assert.equal((await terminal(f.current, update.operationId)).status, 'failed')
  assert.equal((await f.current.installations()).generation, 3)
  const enabled = await f.current.enqueue({ operationKey: 'enable-v2-new-intent', kind: 'enable', expectedGeneration: 3, releaseId: 'release.v2' })
  assert.equal((await terminal(f.current, enabled.operationId)).status, 'succeeded')
  assert.deepEqual(f.wire.paths, before)
  assert.equal((await f.current.installations()).items.find(item => item.releaseId === 'release.v2').active, true)
  assert.doesNotMatch(JSON.stringify(await f.current.operations()), /private activation details|activationError|packPath/)
})

test('manual update check orders stable SemVer, excludes prereleases, blocks incompatible/dependency releases and downloads nothing', async t => {
  const f = await managerFixture(t)
  await activeBaseline(f)
  await f.addRelease({ releaseId: 'release.v19', version: '1.9.0' })
  await f.addRelease({ releaseId: 'release.v110', version: '1.10.0' })
  await f.addRelease({ releaseId: 'release.v3pre', version: '3.0.0-beta.1' })
  await f.addRelease({ releaseId: 'release.v2blocked', version: '2.0.0', requiresPlugin: { minVersion: '99.0.0' } })
  await f.addRelease({ releaseId: 'release.v120dep', version: '1.20.0', dependencyLock: [
    { packId: 'dependency.missing', releaseId: 'dependency.v1', version: '1.0.0', ownerOrgId: 'org.one', artifactSha256: 'a'.repeat(64), contentTreeSha256: 'b'.repeat(64) },
  ] })
  const beforePaths = [...f.wire.paths], beforeGeneration = (await f.current.installations()).generation
  assert.equal((await f.current.updates()).hasSnapshot, false)
  assert.deepEqual(f.wire.paths, beforePaths)
  const checked = await f.current.checkUpdates()
  assert.equal(checked.stale, false); assert.equal(checked.hasSnapshot, true); assert.equal(checked.generation, beforeGeneration)
  const item = checked.items[0]
  assert.equal(item.status, 'update_available'); assert.equal(item.candidate.releaseId, 'release.v110')
  assert.equal(item.latestVisible.releaseId, 'release.v2blocked'); assert.equal(item.candidateCached, false)
  assert.ok(item.blockedReasons.some(row => row.releaseId === 'release.v2blocked'))
  assert.ok(item.blockedReasons.find(row => row.releaseId === 'release.v120dep').reasons.some(reason => reason.startsWith('DEPENDENCY_REQUIRED:')))
  assert.equal(item.blockedReasons.some(row => row.releaseId === 'release.v3pre'), false)
  assert.ok(f.wire.paths.slice(beforePaths.length).every(path => path === '/api/v1/releases'))
  assert.equal((await f.current.installations()).generation, beforeGeneration)
  assert.deepEqual(await f.current.updates(), checked)
})

test('cached update candidate can be enabled offline without another download or generation mutation during checking', async t => {
  const f = await managerFixture(t)
  await activeBaseline(f)
  const v2 = await f.addRelease({ releaseId: 'release.v2', version: '1.1.0' })
  assert.equal((await install(f, v2, 'cache-v2', 2)).status, 'succeeded')
  const beforePaths = [...f.wire.paths]
  const checked = await f.current.checkUpdates()
  assert.equal(checked.items[0].candidateCached, true)
  assert.equal(checked.items[0].current.releaseId, 'release.v1')
  assert.equal(checked.items[0].candidate.releaseId, 'release.v2')
  assert.equal((await f.current.installations()).generation, 3)
  assert.ok(f.wire.paths.slice(beforePaths.length).every(path => path === '/api/v1/releases'))
  const afterCheck = [...f.wire.paths]
  await f.stop()
  const enabled = await f.current.enqueue({ operationKey: 'offline-enable', kind: 'enable', expectedGeneration: 3, releaseId: 'release.v2' })
  assert.equal((await terminal(f.current, enabled.operationId)).status, 'succeeded')
  assert.deepEqual(f.wire.paths, afterCheck)
  assert.equal((await f.current.updates()).stale, true)
  assert.equal((await f.current.updates()).errorCode, 'GENERATION_CONFLICT')
})

test('catalog and update failures distinguish stale previous snapshot from no successful history', async t => {
  const f = await managerFixture(t)
  await activeBaseline(f)
  await f.addRelease({ releaseId: 'release.v2', version: '1.1.0' })
  const catalog = await f.current.catalog(), updates = await f.current.checkUpdates()
  assert.equal(catalog.hasSnapshot, true); assert.equal(updates.hasSnapshot, true)
  f.wire.catalogError = 'UNAUTHENTICATED'
  const staleCatalog = await f.current.catalog(), staleUpdates = await f.current.checkUpdates()
  assert.equal(staleCatalog.stale, true); assert.equal(staleCatalog.hasSnapshot, true); assert.equal(staleCatalog.checkedAt, catalog.checkedAt)
  assert.deepEqual(staleCatalog.items, catalog.items); assert.equal(staleCatalog.errorCode, 'UNAUTHENTICATED')
  assert.equal(staleUpdates.stale, true); assert.equal(staleUpdates.hasSnapshot, true); assert.deepEqual(staleUpdates.items, updates.items)
  const fresh = f.manager()
  const noCatalog = await fresh.catalog(), noUpdates = await fresh.checkUpdates()
  assert.equal(noCatalog.hasSnapshot, false); assert.equal(noCatalog.checkedAt, null); assert.deepEqual(noCatalog.items, [])
  assert.equal(noUpdates.hasSnapshot, false); assert.equal(noUpdates.checkedAt, null); assert.deepEqual(noUpdates.items, [])
  assert.equal(noUpdates.errorCode, 'UNAUTHENTICATED')
  assert.equal((await f.current.installations()).generation, 2)
})

test('empty local update check still probes authorization and cannot misreport outage as up to date', async t => {
  const f = await managerFixture(t)
  await f.addRelease({ releaseId: 'release.v1', version: '1.0.0' }); await f.bind()
  f.wire.catalogError = 'UNAUTHENTICATED'
  const check = await f.current.checkUpdates()
  assert.equal(check.hasSnapshot, false); assert.equal(check.stale, true); assert.equal(check.errorCode, 'UNAUTHENTICATED')
  assert.ok(f.wire.paths.includes('/api/v1/releases'))
  assert.equal(f.wire.paths.some(path => path.endsWith('/download-grants') || path.endsWith('/artifact')), false)
  assert.equal((await f.current.installations()).generation, 0)
})

test('binding changes clear remote history and disabled remote configuration preserves offline installations', async t => {
  const f = await managerFixture(t)
  await activeBaseline(f)
  await f.current.catalog(); await f.current.checkUpdates()
  await f.current.unbind({ expectedRevision: 1 })
  assert.equal((await f.current.catalog()).hasSnapshot, false)
  assert.equal((await f.current.updates()).hasSnapshot, false)
  const disabled = f.manager({ origin: undefined })
  const connection = await disabled.connection()
  assert.equal(connection.configured, false); assert.equal(connection.connection.bound, false)
  const before = [...f.wire.paths]
  assert.equal((await disabled.catalog()).errorCode, 'CENTER_DISABLED')
  assert.equal((await disabled.installations()).items[0].integrity, 'verified')
  assert.equal((await disabled.activeSnapshot()).packs.length, 1)
  assert.deepEqual(f.wire.paths, before)
})

test('tampered installed content is unavailable, cannot activate, and prevents a successful update check', async t => {
  const f = await managerFixture(t), v1 = await f.addRelease({ releaseId: 'release.v1', version: '1.0.0' })
  await f.bind(); await install(f, v1, 'cache-v1', 0)
  const state = await f.client().localState(), record = state.state.installed['release.v1']
  const path = join(record.packPath, 'pack.json'), original = await readFile(path, 'utf8')
  await writeFile(path, `${original}\n`, { mode: 0o600 })
  const local = await f.current.installations()
  assert.equal(local.items[0].integrity, 'unavailable'); assert.equal(local.items[0].errorCode, 'CONTENT_DIGEST_MISMATCH')
  const beforePaths = [...f.wire.paths]
  const update = await f.current.checkUpdates()
  assert.equal(update.stale, true); assert.equal(update.hasSnapshot, false); assert.equal(update.errorCode, 'CONTENT_DIGEST_MISMATCH')
  const enabling = await f.current.enqueue({ operationKey: 'enable-corrupt', kind: 'enable', expectedGeneration: 1, releaseId: 'release.v1' })
  assert.notEqual((await terminal(f.current, enabling.operationId)).status, 'succeeded')
  assert.equal((await f.current.installations()).generation, 1)
  assert.equal((await f.current.installations()).items[0].active, false)
  assert.deepEqual(f.wire.paths, beforePaths)
})
