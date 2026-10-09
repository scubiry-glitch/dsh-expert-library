/** Real signed center HTTP fixtures; connection changes happen through an independent SDK instance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer, request } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { managerFixture } from './support/pack-center-manager-fixture.mjs'

const { createPackCenterRouteHandler } = await import(process.env.PACK_MANAGER_SOURCE === '1'
  ? '../src/host/pack-center-routes.ts' : '../lib/host/pack-center-routes.js')
const newCode = () => `dpc_bind_${randomBytes(32).toString('base64url')}`
const remoteListCount = f => f.wire.paths.filter(path => path === '/api/v1/releases').length
function emptySnapshot(value, code) {
  assert.deepEqual(value.items, [])
  assert.equal(value.hasSnapshot, false)
  assert.equal(value.checkedAt, null)
  assert.equal(value.stale, true)
  if (code) assert.equal(value.errorCode, code)
}
async function prepareUpdateSnapshot(f) {
  const v1 = await f.addRelease({ releaseId: 'release.v1', version: '1.0.0' })
  const v2 = await f.addRelease({ releaseId: 'release.old-visible', version: '1.1.0' })
  await f.bind()
  await f.client().install({ releaseId: v1.manifest.releaseId, operationKey: 'initial-cache', expectedGeneration: 0,
    target: f.target(v1), connectionRevision: 1 })
  const checked = await f.current.checkUpdates()
  assert.equal(checked.stale, false)
  assert.equal(checked.hasSnapshot, true)
  assert.equal(checked.items[0].candidate.releaseId, v2.manifest.releaseId)
  assert.ok(checked.checkedAt)
  return { v1, v2, checked }
}

for (const mutation of ['unbind', 'rebind']) {
  for (const response of ['success', 'failure']) {
    test(`update snapshot crossing external ${mutation} discards old metadata after a ${response} response`, async t => {
      const f = await managerFixture(t, { timeoutMs: 15_000 })
      const { v2, checked } = await prepareUpdateSnapshot(f)
      const entered = f.gate(), release = f.gate()
      f.wire.catalogHook = async (_reply, url) => {
        assert.equal(url.searchParams.get('packId'), 'demo.review')
        entered.resolve()
        await release.promise
        if (response === 'failure') throw new Error('controlled fixture failure')
      }
      const pending = f.current.checkUpdates()
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Update check did not reach the catalog barrier') })])
      // Bypass current.bind/unbind deliberately: another host process does not
      // call this instance's clearCache(), so revision fencing must do the work.
      const external = f.client()
      const changed = mutation === 'unbind'
        ? await external.unbind({ expectedRevision: 1 })
        : await external.bind({ ...f.bindInput, expectedRevision: 1, bindingCode: newCode() })
      assert.equal(changed.revision, 2)
      release.resolve()
      const fenced = await pending
      emptySnapshot(fenced, 'REVISION_CONFLICT')
      assert.equal(JSON.stringify(fenced).includes(v2.manifest.releaseId), false)
      assert.notEqual(fenced.checkedAt, checked.checkedAt)
      emptySnapshot(await f.current.updates())

      f.wire.catalogHook = undefined
      if (mutation === 'unbind') await external.bind({ ...f.bindInput, expectedRevision: 2, bindingCode: newCode() })
      f.releases.delete(v2.manifest.releaseId)
      const next = await f.addRelease({ releaseId: 'release.new-visible', version: '1.2.0' })
      f.wire.catalogError = 'UNAUTHENTICATED'
      const revoked = await f.current.checkUpdates()
      emptySnapshot(revoked, 'UNAUTHENTICATED')
      assert.equal(JSON.stringify(revoked).includes(v2.manifest.releaseId), false)
      f.wire.catalogError = null
      const before = remoteListCount(f), refreshed = await f.current.checkUpdates()
      assert.equal(remoteListCount(f), before + 1)
      assert.equal(refreshed.hasSnapshot, true)
      assert.equal(refreshed.stale, false)
      assert.equal(refreshed.items[0].candidate.releaseId, next.manifest.releaseId)
      assert.equal(JSON.stringify(refreshed).includes(v2.manifest.releaseId), false)
      assert.equal((await f.current.installations()).generation, 1)
      assert.equal(f.wire.paths.filter(path => path.endsWith('/artifact')).length, 1)
    })
  }
}

test('catalog errors preserve only same-revision snapshots and external rebind cannot reuse old private catalog', async t => {
  const f = await managerFixture(t, { timeoutMs: 15_000 })
  const old = await f.addRelease({ releaseId: 'release.old-visible', version: '1.0.0' })
  await f.bind()
  const cached = await f.current.catalog({ packId: 'demo.review', limit: 10 })
  assert.equal(cached.stale, false); assert.equal(cached.hasSnapshot, true)
  f.wire.catalogError = 'UNAUTHENTICATED'
  const sameRevision = await f.current.catalog({ packId: 'demo.review', limit: 10 })
  assert.equal(sameRevision.stale, true); assert.equal(sameRevision.hasSnapshot, true)
  assert.equal(sameRevision.errorCode, 'UNAUTHENTICATED')
  assert.equal(sameRevision.checkedAt, cached.checkedAt)
  assert.deepEqual(sameRevision.items, cached.items)
  // Cache keys also include the query; a failed distinct query has no history.
  emptySnapshot(await f.current.catalog({ packId: 'demo.review', limit: 11 }), 'UNAUTHENTICATED')

  const external = f.client()
  await external.unbind({ expectedRevision: 1 })
  emptySnapshot(await f.current.catalog({ packId: 'demo.review', limit: 10 }), 'CENTER_NOT_BOUND')
  await external.bind({ ...f.bindInput, expectedRevision: 2, bindingCode: newCode() })
  emptySnapshot(await f.current.catalog({ packId: 'demo.review', limit: 10 }), 'UNAUTHENTICATED')
  f.releases.delete(old.manifest.releaseId)
  const fresh = await f.addRelease({ releaseId: 'release.new-visible', version: '1.1.0' })
  f.wire.catalogError = null
  const count = remoteListCount(f), next = await f.current.catalog({ packId: 'demo.review', limit: 10 })
  assert.equal(remoteListCount(f), count + 1)
  assert.equal(next.stale, false)
  assert.deepEqual(next.items.map(item => item.releaseId), [fresh.manifest.releaseId])
  assert.equal(f.wire.paths.some(path => path.endsWith('/artifact')), false)
})

test('same-revision failed update check retains its last successful snapshot with explicit stale state', async t => {
  const f = await managerFixture(t, { timeoutMs: 15_000 })
  const { checked } = await prepareUpdateSnapshot(f)
  f.wire.catalogError = 'UNAUTHENTICATED'
  const stale = await f.current.checkUpdates()
  assert.equal(stale.stale, true)
  assert.equal(stale.hasSnapshot, true)
  assert.equal(stale.errorCode, 'UNAUTHENTICATED')
  assert.equal(stale.checkedAt, checked.checkedAt)
  assert.deepEqual(stale.items, checked.items)
  assert.deepEqual(await f.current.updates(), stale)
})

async function localRoutes(t, service) {
  const handler = createPackCenterRouteHandler({ service, getManageToken: () => undefined })
  const server = createServer((req, res) => { void handler(req, res).then(handled => {
    if (!handled) { res.writeHead(404); res.end() }
  }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const port = server.address().port
  return (path, input) => new Promise((resolve, reject) => {
    const bytes = input === undefined ? undefined : Buffer.from(JSON.stringify(input))
    const req = request({ hostname: '127.0.0.1', port, path: `/plugins/dsh-expert-library/manage/center${path}`,
      method: bytes ? 'POST' : 'GET', headers: { 'x-pack-center-ui': '1',
        ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.once('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), body: JSON.parse(Buffer.concat(chunks).toString()) }))
    })
    req.once('error', reject)
    req.end(bytes)
  })
}

test('successful binding remains HTTP 200 with committed revision when operation journal startup is corrupt', async t => {
  const f = await managerFixture(t, { timeoutMs: 15_000 })
  const operationsRoot = join(f.root, 'operations'), journal = join(operationsRoot, 'operations.json')
  await mkdir(operationsRoot, { recursive: true, mode: 0o700 })
  const damaged = '{"jobs":invalid-json}'
  await writeFile(journal, damaged, { mode: 0o600 })
  const send = await localRoutes(t, f.current)
  const bound = await send('/bind', f.bindInput)
  assert.equal(bound.status, 200)
  assert.equal(bound.body.ok, true)
  assert.equal(bound.body.data.revision, 1)
  assert.equal(bound.body.data.connection.bound, true)
  assert.equal(bound.body.data.errorCode, 'OPERATION_STORAGE_CORRUPT')
  const connection = await send('/connection')
  assert.equal(connection.status, 200)
  assert.equal(connection.body.data.revision, 1)
  assert.equal(connection.body.data.connection.bound, true)
  assert.equal(connection.body.data.errorCode, 'OPERATION_STORAGE_CORRUPT')
  const operations = await send('/operations')
  assert.equal(operations.status, 502)
  assert.deepEqual(operations.body, { ok: false, error: { code: 'OPERATION_STORAGE_CORRUPT' } })
  for (const value of [bound.text, connection.text, operations.text]) {
    for (const forbidden of [f.wire.token, f.bindInput.bindingCode, f.root, 'credentialToken', 'trustedSigningKeys', 'BEGIN PUBLIC KEY']) {
      assert.equal(value.includes(forbidden), false)
    }
  }
  assert.equal(f.wire.exchanges, 1)
  assert.equal(await readFile(journal, 'utf8'), damaged)
})
