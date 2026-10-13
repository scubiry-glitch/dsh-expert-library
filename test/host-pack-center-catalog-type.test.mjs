/**
 * Domain-pack-only manage surface: the catalog query pins type=domain-pack,
 * installations and updates hide center packs the center does not vouch for as
 * domain packs ('unknown' hides too), and legacy local receipts stay visible.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { managerFixture } from './support/pack-center-manager-fixture.mjs'

const dashboard = { schemaVersion: 1, types: ['dashboard'], scenarios: ['zhijian-workbench'] }
const expert = { schemaVersion: 1, types: ['expert'], scenarios: ['zhijian-workbench'] }

async function waitFor(predicate, message = 'condition', milliseconds = 15_000) {
  const end = Date.now() + milliseconds
  while (Date.now() < end) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${message}`)
}
async function terminal(manager, id) {
  return waitFor(async () => { const job = await manager.operation(id); return ['succeeded', 'failed', 'interrupted'].includes(job.status) && job })
}
/** Cache a release into the local inventory without activating it. */
async function cache(f, releaseId, generation) {
  const value = f.releases.get(releaseId)
  const job = await f.current.enqueue({ operationKey: `cache-${releaseId}`, kind: 'install', expectedGeneration: generation,
    releaseId, connectionRevision: (await f.current.connection()).revision, target: f.target(value) })
  assert.equal((await terminal(f.current, job.operationId)).status, 'succeeded')
  return generation + 1
}
async function seedLegacy(f, packId) {
  const stateFile = join(f.root, 'inventory', 'state.json')
  const state = JSON.parse(await readFile(stateFile, 'utf8'))
  const releaseId = `legacy.${'a'.repeat(64)}`
  state.installed[releaseId] = {
    releaseId, packId, version: '0.9.0', artifactSha256: 'b'.repeat(64), contentTreeSha256: 'c'.repeat(64),
    packPath: join(f.root, 'inventory', 'legacy', packId), installedAt: '2026-01-01T00:00:00.000Z', source: 'legacy',
  }
  await writeFile(stateFile, JSON.stringify(state))
  return releaseId
}

test('catalog pins type=domain-pack and lists domain packs with their classification', async t => {
  const f = await managerFixture(t)
  await f.addRelease({ releaseId: 'release.dp.v1', version: '1.0.0', packId: 'pack.dp.one' })
  await f.addRelease({ releaseId: 'release.dash.v1', version: '1.0.0', packId: 'pack.dash', classification: dashboard })
  await f.addRelease({ releaseId: 'release.expert.v1', version: '1.0.0', packId: 'pack.expert', classification: expert })
  await f.bind()
  const queries = []
  f.wire.catalogHook = (reply, url) => { queries.push(url.searchParams.get('type')) }
  const catalog = await f.current.catalog()
  assert.deepEqual(queries, ['domain-pack'], 'every catalog query is type-scoped')
  assert.deepEqual(catalog.items.map(item => item.releaseId), ['release.dp.v1'])
  assert.deepEqual(catalog.items[0].classification, { schemaVersion: 1, types: ['domain-pack'], scenarios: ['deepseek-harness'] })
})

test('catalog pagination skips non-domain rows without losing domain pages', async t => {
  const f = await managerFixture(t)
  await f.addRelease({ releaseId: 'release.dp.v2', version: '2.0.0', packId: 'pack.dp.two' })
  await f.addRelease({ releaseId: 'release.dash.v2', version: '2.0.0', packId: 'pack.dash', classification: dashboard })
  await f.addRelease({ releaseId: 'release.dp.v1', version: '1.0.0', packId: 'pack.dp.one' })
  await f.bind()
  const page1 = await f.current.catalog({ limit: 1 })
  assert.deepEqual(page1.items.map(item => item.releaseId), ['release.dp.v2'])
  assert.equal(page1.nextCursor, 'release.dp.v2')
  const page2 = await f.current.catalog({ limit: 1, beforeId: page1.nextCursor })
  assert.deepEqual(page2.items.map(item => item.releaseId), ['release.dp.v1'])
  assert.equal(page2.nextCursor, null)
})

test('installations hide non-domain-pack and unvouchable center packs, legacy stays visible', async t => {
  const f = await managerFixture(t)
  await f.addRelease({ releaseId: 'release.dp.v1', version: '1.0.0', packId: 'pack.dp.one' })
  await f.addRelease({ releaseId: 'release.dash.v1', version: '1.0.0', packId: 'pack.dash', classification: dashboard })
  await f.addRelease({ releaseId: 'release.gone.v1', version: '1.0.0', packId: 'pack.gone' })
  await f.bind()
  let generation = await cache(f, 'release.dp.v1', 0)
  generation = await cache(f, 'release.dash.v1', generation)
  generation = await cache(f, 'release.gone.v1', generation)
  // The center stops vouching for pack.gone entirely: its classification is unknown.
  f.releases.delete('release.gone.v1')
  const legacyReleaseId = await seedLegacy(f, 'pack.legacy')
  const installations = await f.current.installations()
  assert.deepEqual(installations.items.map(item => item.releaseId).sort(), [legacyReleaseId, 'release.dp.v1'])
  const domain = installations.items.find(item => item.releaseId === 'release.dp.v1')
  assert.deepEqual(domain.classification, { schemaVersion: 1, types: ['domain-pack'], scenarios: ['deepseek-harness'] })
  const legacy = installations.items.find(item => item.source === 'legacy')
  assert.equal(legacy.classification, undefined, 'legacy receipts are not center apps and stay unclassified')
})

test('updates are only planned for domain packs', async t => {
  const f = await managerFixture(t)
  await f.addRelease({ releaseId: 'release.dp.v1', version: '1.0.0', packId: 'pack.dp' })
  await f.addRelease({ releaseId: 'release.dash.v1', version: '1.0.0', packId: 'pack.dash', classification: dashboard })
  await f.bind()
  let generation = await cache(f, 'release.dp.v1', 0)
  generation = await cache(f, 'release.dash.v1', generation)
  await f.addRelease({ releaseId: 'release.dp.v2', version: '1.0.1', packId: 'pack.dp' })
  await f.addRelease({ releaseId: 'release.dash.v2', version: '1.0.1', packId: 'pack.dash', classification: dashboard })
  const updates = await f.current.checkUpdates()
  assert.deepEqual(updates.items.map(item => item.packId), ['pack.dp'])
  assert.equal(updates.items[0].candidate.releaseId, 'release.dp.v2')
  assert.equal(updates.items[0].status, 'update_available')
})

test('client forwards the type filter and degrades malformed classification to undefined', async t => {
  const f = await managerFixture(t)
  await f.addRelease({ releaseId: 'release.good', version: '1.0.0' })
  await f.addRelease({ releaseId: 'release.badshape', version: '1.0.0', packId: 'pack.bad',
    classification: { schemaVersion: 1, types: ['NOPE'], scenarios: [] } })
  await f.bind()
  const client = f.client()
  const queries = []
  f.wire.catalogHook = (reply, url) => { queries.push(url.searchParams.get('type')) }
  const typed = await client.listReleases({ type: 'domain-pack' })
  assert.deepEqual(typed.items.map(item => item.releaseId), ['release.good'])
  const untyped = await client.listReleases()
  assert.deepEqual(untyped.items.find(item => item.releaseId === 'release.good').classification,
    { schemaVersion: 1, types: ['domain-pack'], scenarios: ['deepseek-harness'] })
  assert.equal(untyped.items.find(item => item.releaseId === 'release.badshape').classification, undefined)
  assert.deepEqual(queries, ['domain-pack', null])
  await assert.rejects(client.listReleases({ type: 'BAD TYPE' }), { code: 'CENTER_INVALID_INPUT' })
  await assert.rejects(client.listReleases({ type: '../etc' }), { code: 'CENTER_INVALID_INPUT' })
})
