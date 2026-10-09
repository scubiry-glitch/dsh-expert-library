/** Focused adversarial HTTP fixtures, complementary to the real-center flow. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packDirectory } from '../packages/pack-artifact/index.mjs'
import { canonicalBytes, sha256, signReleaseManifest } from '../packages/pack-contract/index.mjs'

const { createPackCenterClient } = await import(process.env.PACK_CENTER_CLIENT_SOURCE === '1'
  ? '../src/host/pack-center-client.ts' : '../lib/host/pack-center-client.js')
const { signingKeyFingerprints } = await import(process.env.PACK_CENTER_CLIENT_SOURCE === '1'
  ? '../src/host/pack-center-connection.ts' : '../lib/host/pack-center-connection.js')
const isCode = code => error => error?.code === code
const pair = () => {
  const key = generateKeyPairSync('ed25519')
  return { ...key, pem: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
}
const barrier = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(t, changes = {}) {
  const root = await mkdtemp(join(tmpdir(), 'center-client-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const key = pair(), trustedSigningKeys = { 'test.key': key.pem }
  const report = { schemaVersion: 1, validatorVersion: '0.1.0', packSchemaVersion: 2, valid: true, diagnostics: [], entityCounts: {} }
  const artifact = await packDirectory(fileURLToPath(new URL('../examples/pack-center/demo-v1', import.meta.url)), join(root, 'fixture.tar'))
  const archive = await readFile(join(root, 'fixture.tar'))
  const manifest = {
    schemaVersion: 1, protocolVersion: 1, normalizationVersion: 1, digestAlgorithmVersion: 1,
    signatureAlgorithm: 'Ed25519', archiveFormat: 'tar', centerId: 'test.center', releaseId: 'release.v1',
    packId: 'demo.review', ownerOrgId: 'org.one', version: '1.0.0', sourceCommit: 'a'.repeat(40),
    artifactSha256: artifact.artifactSha256, contentTreeSha256: artifact.contentTreeSha256,
    reportSha256: sha256(canonicalBytes(report)), validatorVersion: '0.1.0', packSchemaVersion: 2,
    requiresPlugin: { minVersion: '0.1.0' }, dependencyLock: [], builtinDependencies: [],
    sizeBytes: artifact.sizeBytes, fileCount: artifact.fileCount, approvedSubmissionId: 'submission.v1', signingKeyId: 'test.key',
  }
  const wire = {
    envelope: signReleaseManifest(manifest, key.privateKey), advertised: { ...trustedSigningKeys },
    centerId: 'test.center', report, archive, exchangeCount: 0, paths: [],
    token: `dpc_token_${randomBytes(32).toString('base64url')}`,
    bindingCode: `dpc_bind_${randomBytes(32).toString('base64url')}`,
    grant: randomBytes(32).toString('base64url'),
    onExchange: undefined, onGrant: undefined, onArtifact: undefined, onCatalog: undefined, onDetail: undefined,
  }
  function json(res, value, status = 200) {
    const body = Buffer.from(JSON.stringify(value))
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
    res.end(body)
  }
  function view() {
    const m = wire.envelope.manifest
    return { releaseId: m.releaseId, packId: m.packId, ownerOrgId: m.ownerOrgId, version: m.version,
      manifest: m, name: 'Fixture', publishedAt: '2026-01-01T00:00:00.000Z',
      distribution: { kind: 'organization' }, downloadAvailability: { available: true } }
  }
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, 'http://fixture.invalid')
      wire.paths.push(url.pathname)
      assert.equal(req.headers.cookie, undefined)
      assert.equal(req.headers.origin, undefined)
      assert.equal(Object.keys(req.headers).some(key => key.startsWith('sec-fetch-')), false)
      for await (const _chunk of req) { /* Never retain or print request secrets. */ }
      if (url.pathname === '/api/v1/deployment-bindings/exchange') {
        assert.equal(req.headers.authorization, undefined)
        wire.exchangeCount++
        const reply = { centerId: wire.centerId, deployment: { id: 'deploy.one', organizationId: 'org.one', status: 'active' },
          credential: { id: `credential.${wire.exchangeCount}`, scopes: ['catalog:read', 'release:download'], expiresAt: new Date(Date.now() + 86400000).toISOString() },
          credentialToken: wire.token, trustInfo: { schemaVersion: 1, centerId: wire.centerId,
            signingKeys: Object.entries(wire.advertised).map(([keyId, publicKeyPem]) => ({ keyId, publicKeyPem,
              fingerprintSha256: signingKeyFingerprints({ [keyId]: publicKeyPem })[keyId] })) } }
        await wire.onExchange?.(reply)
        json(res, reply); return
      }
      assert.ok(req.headers.authorization === `Bearer ${wire.token}`, 'Host sends only its private machine credential')
      if (url.pathname.endsWith('/download-grants')) {
        const reply = { schemaVersion: 1, centerId: wire.centerId, releaseId: wire.envelope.manifest.releaseId,
          signedManifest: wire.envelope, grantToken: wire.grant, expiresAt: new Date(Date.now() + 60000).toISOString(),
          artifactPath: `/api/v1/releases/${wire.envelope.manifest.releaseId}/artifact` }
        await wire.onGrant?.(reply)
        json(res, reply); return
      }
      if (url.pathname.endsWith('/artifact')) {
        assert.ok(req.headers['x-pack-download-grant'] === wire.grant, 'Grant is a header, never a URL parameter')
        await wire.onArtifact?.()
        if (!res.destroyed) {
          res.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Length': wire.archive.length })
          res.end(wire.archive)
        }
        return
      }
      if (url.pathname === '/api/v1/releases') {
        const reply = { schemaVersion: 1, centerId: wire.centerId, items: [view()], nextCursor: null }
        await wire.onCatalog?.(reply)
        json(res, reply); return
      }
      const reply = { ...view(), signedManifest: wire.envelope, validationReport: wire.report,
        diff: null, diffAvailability: { available: true }, notes: '', license: 'MIT' }
      await wire.onDetail?.(reply)
      json(res, reply)
    })().catch(() => { json(res, { error: { code: 'FIXTURE_FAILURE' } }, 500) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let closed = false
  const stop = async () => {
    if (closed) return
    closed = true
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  t.after(stop)
  const options = { origin: `http://127.0.0.1:${server.address().port}`, connectionRoot: join(root, 'private'),
    inventoryRoot: join(root, 'inventory'), capabilities: { pluginVersion: '0.1.0' }, allowLoopbackHttp: true, ...changes }
  const client = createPackCenterClient(options)
  const bindInput = { bindingCode: wire.bindingCode, expectedRevision: 0, expectedCenterId: 'test.center', trustedSigningKeys }
  const bind = () => client.bind(bindInput)
  const installInput = { releaseId: 'release.v1', operationKey: 'cache', expectedGeneration: 0 }
  return { root, key, options, client, wire, manifest, bindInput, bind, installInput, stop }
}

test('host connection and catalog are metadata projections; inputs are captured before awaiting', async t => {
  const f = await fixture(t)
  const promise = f.client.bind(f.bindInput)
  f.bindInput.expectedCenterId = 'mutated.center'
  const connection = await promise
  assert.equal(connection.connection.centerId, 'test.center')
  assert.doesNotMatch(JSON.stringify(connection), /credentialToken|PUBLIC KEY|PRIVATE KEY/)
  assert.ok(!JSON.stringify(connection).includes(f.root))
  f.wire.onCatalog = reply => { reply.credentialToken = f.wire.token; reply.items[0].credentialToken = f.wire.token }
  const catalog = await f.client.listReleases()
  assert.equal(catalog.items[0].releaseId, 'release.v1')
  assert.ok(!JSON.stringify(catalog).includes(f.wire.token))
})

test('bad pin syntax, private key, revision and reserved identifiers fail before one-time exchange', async t => {
  const f = await fixture(t)
  await assert.rejects(f.client.bind({ ...f.bindInput, trustedSigningKeys: {} }))
  await assert.rejects(f.client.bind({ ...f.bindInput, trustedSigningKeys: { 'test.key': f.key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } }))
  await assert.rejects(f.client.bind({ ...f.bindInput, expectedRevision: 1 }), isCode('REVISION_CONFLICT'))
  await assert.rejects(f.client.bind({ ...f.bindInput, expectedCenterId: '__proto__' }))
  assert.equal(f.wire.exchangeCount, 0)
})

test('failed rebind leaves previous credential and pins byte-for-byte; no automatic exchange retry', async t => {
  const f = await fixture(t)
  await f.bind()
  const before = await readFile(join(f.options.connectionRoot, 'connection.json'))
  f.wire.onExchange = reply => { reply.trustInfo.signingKeys[0].fingerprintSha256 = '0'.repeat(64) }
  await assert.rejects(f.client.bind({ ...f.bindInput, expectedRevision: 1 }), error => {
    assert.equal(error.code, 'CENTER_BIND_UNCONFIRMED'); assert.equal(error.reason, 'CENTER_TRUST_MISMATCH')
    assert.ok(!JSON.stringify(error).includes(f.wire.token)); assert.ok(!error.message.includes(f.root))
    return true
  })
  assert.equal(f.wire.exchangeCount, 2)
  assert.ok(before.equals(await readFile(join(f.options.connectionRoot, 'connection.json'))))
  assert.equal((await f.client.listReleases()).items.length, 1)
})

test('key rotation retains historical offline pins and refuses reassignment before exchange', async t => {
  const f = await fixture(t)
  await f.bind()
  const next = pair()
  f.wire.advertised = { 'next.key': next.pem }
  const result = await f.client.bind({ ...f.bindInput, expectedRevision: 1, trustedSigningKeys: f.wire.advertised })
  assert.deepEqual(Object.keys(result.connection.signingKeyFingerprints).sort(), ['next.key', 'test.key'])
  await assert.rejects(f.client.bind({ ...f.bindInput, expectedRevision: 2, trustedSigningKeys: { 'test.key': next.pem } }), isCode('CENTER_KEY_REASSIGNMENT'))
  await assert.rejects(f.client.bind({ ...f.bindInput, expectedRevision: 2, expectedCenterId: 'other.center' }), isCode('CENTER_ID_LOCKED'))
  assert.equal(f.wire.exchangeCount, 2)
})

test('two simultaneous binds have one CAS winner; losing credential is explicitly unconfirmed', async t => {
  const f = await fixture(t), arrived = barrier(), release = barrier()
  f.wire.onExchange = async () => { if (f.wire.exchangeCount === 2) arrived.resolve(); await release.promise }
  const attempts = [f.client.bind(f.bindInput), f.client.bind(f.bindInput)]
  await arrived.promise; release.resolve()
  const results = await Promise.allSettled(attempts)
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected')
  assert.equal(rejected.reason.code, 'CENTER_BIND_UNCONFIRMED')
  assert.equal(rejected.reason.reason, 'REVISION_CONFLICT')
  assert.equal((await f.client.getConnection()).revision, 1)
})

test('new private binding cannot adopt an existing inventory or orphaned inventory', async t => {
  const f = await fixture(t)
  await mkdir(f.options.inventoryRoot, { mode: 0o700 })
  await writeFile(join(f.options.inventoryRoot, 'orphan'), 'pre-existing')
  await assert.rejects(f.bind(), isCode('CENTER_INVENTORY_NOT_EMPTY'))
  assert.equal(f.wire.exchangeCount, 0)
  assert.equal(await readFile(join(f.options.inventoryRoot, 'orphan'), 'utf8'), 'pre-existing')
})

test('storage layout binds one private connection directory to exactly one inventory', async t => {
  const f = await fixture(t)
  assert.throws(() => createPackCenterClient({ ...f.options, connectionRoot: join(f.root, 'other-private') }), isCode('CENTER_INVALID_STORAGE'))
  assert.throws(() => createPackCenterClient({ ...f.options, inventoryRoot: join(f.root, 'other-inventory') }), isCode('CENTER_INVALID_STORAGE'))
  assert.throws(() => createPackCenterClient({ ...f.options, connectionRoot: join(f.root, 'nested', 'private') }), isCode('CENTER_INVALID_STORAGE'))
  assert.equal(f.wire.paths.length, 0)
})

test('configured origin change never sends the old credential to the replacement origin', async t => {
  const a = await fixture(t), b = await fixture(t)
  await a.bind()
  const changed = createPackCenterClient({ ...a.options, origin: b.options.origin })
  await assert.rejects(changed.listReleases(), isCode('CENTER_ORIGIN_CHANGED'))
  assert.equal(b.wire.paths.length, 0)
  b.wire.advertised = a.bindInput.trustedSigningKeys
  const result = await changed.bind({ ...a.bindInput, expectedRevision: 1 })
  assert.equal(result.connection.origin, b.options.origin)
  assert.equal(b.wire.exchangeCount, 1)
  assert.equal((await changed.listReleases()).items.length, 1)
})

test('unsupported catalog metadata remains visible but cannot grant runnable inventory', async t => {
  const f = await fixture(t)
  await f.bind()
  f.wire.onCatalog = reply => { reply.items[0].manifest.protocolVersion = 99 }
  const catalog = await f.client.listReleases()
  assert.equal(catalog.items[0].compatibility.compatible, false)
  await assert.rejects(f.client.install(f.installInput))
  assert.equal(f.wire.paths.filter(path => path.endsWith('/artifact')).length, 0)
  assert.deepEqual((await f.client.localState()).state.installed, {})
})

for (const [name, mutate] of [
  ['unsigned manifest', reply => { reply.signedManifest.manifest.ownerOrgId = 'org.attacker' }],
  ['arbitrary artifact URL', reply => { reply.artifactPath = 'https://attacker.invalid/file' }],
  ['relative artifact redirect', reply => { reply.artifactPath = '/api/v1/releases/another/artifact' }],
  ['expired grant', reply => { reply.expiresAt = '2000-01-01T00:00:00.000Z' }],
]) {
  test(`${name} is refused before archive download and never changes local state`, async t => {
    const f = await fixture(t)
    await f.bind(); f.wire.onGrant = mutate
    await assert.rejects(f.client.install(f.installInput))
    assert.equal(f.wire.paths.filter(path => path.endsWith('/artifact')).length, 0)
    assert.equal((await f.client.localState()).state.generation, 0)
  })
}

test('oversized or incompatible signed artifact is refused before downloading bytes', async t => {
  const f = await fixture(t, { maxArchiveBytes: 1 })
  await f.bind()
  await assert.rejects(f.client.install(f.installInput), isCode('CENTER_ARTIFACT_TOO_LARGE'))
  const other = createPackCenterClient({ ...f.options, maxArchiveBytes: 64 * 1024 * 1024 })
  f.wire.envelope = signReleaseManifest({ ...f.manifest, requiresPlugin: { minVersion: '99.0.0' } }, f.key.privateKey)
  await assert.rejects(other.install(f.installInput), isCode('INCOMPATIBLE_RELEASE'))
  assert.equal(f.wire.paths.filter(path => path.endsWith('/artifact')).length, 0)
})

test('archive corruption cleans private staging and preserves previous active state', async t => {
  const f = await fixture(t, { validateActivation: () => {} })
  await f.bind(); await f.client.install(f.installInput)
  await f.client.enable({ releaseId: 'release.v1', operationKey: 'enable', expectedGeneration: 1 })
  const before = await readFile(join(f.options.inventoryRoot, 'state.json'))
  f.wire.envelope = signReleaseManifest({ ...f.manifest, releaseId: 'release.v2', version: '1.1.0' }, f.key.privateKey)
  f.wire.archive = Buffer.from(f.wire.archive); f.wire.archive[100] ^= 0x20
  await assert.rejects(f.client.install({ releaseId: 'release.v2', operationKey: 'bad-download', expectedGeneration: 2 }), isCode('CENTER_DOWNLOAD_INVALID'))
  assert.ok(before.equals(await readFile(join(f.options.inventoryRoot, 'state.json'))))
  assert.deepEqual((await readdir(f.options.connectionRoot)).filter(name => name.startsWith('.download-')), [])
  assert.equal((await f.client.activeSnapshot()).packs[0].releaseId, 'release.v1')
})

test('unbind during artifact transfer fences commit and preserves offline trust', async t => {
  const f = await fixture(t), arrived = barrier(), release = barrier()
  await f.bind()
  f.wire.onArtifact = async () => { arrived.resolve(); await release.promise }
  const attempt = f.client.install(f.installInput)
  await arrived.promise
  const unbound = await f.client.unbind({ expectedRevision: 1 })
  release.resolve()
  await assert.rejects(attempt, isCode('REVISION_CONFLICT'))
  assert.equal(unbound.connection.bound, false)
  assert.ok(unbound.connection.signingKeyFingerprints['test.key'])
  assert.equal((await f.client.localState()).state.generation, 0)
  assert.deepEqual((await readdir(f.options.connectionRoot)).filter(name => name.startsWith('.download-')), [])
})

test('cancellation before request and during transfer never commits an install', async t => {
  const f = await fixture(t), arrived = barrier(), release = barrier()
  await f.bind()
  const pre = new AbortController(); pre.abort('Never expose this secret reason')
  await assert.rejects(f.client.install({ ...f.installInput, signal: pre.signal }), isCode('CENTER_CANCELLED'))
  assert.equal(f.wire.paths.filter(path => path.endsWith('/download-grants')).length, 0)
  f.wire.onArtifact = async () => { arrived.resolve(); await release.promise }
  const active = new AbortController(), attempt = f.client.install({ ...f.installInput, signal: active.signal })
  await arrived.promise; active.abort(); release.resolve()
  await assert.rejects(attempt, isCode('CENTER_CANCELLED'))
  assert.equal((await f.client.localState()).state.generation, 0)
  assert.deepEqual((await readdir(f.options.connectionRoot)).filter(name => name.startsWith('.download-')), [])
})

test('stale generation, activation flags and traversal inputs fail before remote grant', async t => {
  const f = await fixture(t)
  await f.bind()
  await assert.rejects(f.client.install({ ...f.installInput, expectedGeneration: 1 }), isCode('GENERATION_CONFLICT'))
  await assert.rejects(f.client.install({ ...f.installInput, activate: true }), isCode('CENTER_INVALID_INPUT'))
  await assert.rejects(f.client.install({ ...f.installInput, releaseId: '../escape' }))
  await assert.rejects(f.client.listReleases({ beforeId: 'a?token=secret' }))
  assert.equal(f.wire.paths.filter(path => path.endsWith('/download-grants')).length, 0)
})

test('signed detail must match its approved report; unavailable diff is not invented as empty', async t => {
  const f = await fixture(t)
  await f.bind()
  f.wire.onDetail = reply => { reply.diffAvailability = { available: false, code: 'BASELINE_UNAVAILABLE' } }
  const detail = await f.client.getRelease('release.v1')
  assert.deepEqual(detail.diffAvailability, { available: false, code: 'BASELINE_UNAVAILABLE' })
  assert.equal(detail.diff, null)
  f.wire.onDetail = reply => { reply.validationReport = { ...reply.validationReport, entityCounts: { experts: 99 } } }
  await assert.rejects(f.client.getRelease('release.v1'), isCode('CENTER_REPORT_MISMATCH'))
})

test('committed cache-only operation replays offline after unbind without new grant or download', async t => {
  const f = await fixture(t)
  await f.bind()
  const first = await f.client.install(f.installInput)
  assert.equal(first.state.generation, 1); assert.deepEqual(first.state.active, {})
  await f.client.unbind({ expectedRevision: 1 }); await f.stop()
  const restarted = createPackCenterClient(f.options)
  const replay = await restarted.install(f.installInput)
  assert.equal(replay.replayed, true); assert.equal(replay.state.generation, 1)
  assert.deepEqual(replay.operation, first.operation)
  await assert.rejects(restarted.install({ ...f.installInput, expectedGeneration: 1 }), isCode('IDEMPOTENCY_CONFLICT'))
  await assert.rejects(restarted.install({ ...f.installInput, releaseId: 'release.other' }), isCode('IDEMPOTENCY_CONFLICT'))
  const cached = await restarted.install({ ...f.installInput, operationKey: 'new-install', expectedGeneration: 1 })
  assert.equal(cached.state.generation, 2); assert.deepEqual(cached.state.active, {})
  assert.equal(f.wire.paths.filter(path => path.endsWith('/artifact')).length, 1)
})

test('install receipt is distinct from enable/other operations, even for the same release', async t => {
  const f = await fixture(t, { validateActivation: () => {} })
  await f.bind(); await f.client.install(f.installInput)
  await f.client.enable({ releaseId: 'release.v1', operationKey: 'enable', expectedGeneration: 1 })
  await assert.rejects(f.client.install({ releaseId: 'release.v1', operationKey: 'enable', expectedGeneration: 1 }), isCode('IDEMPOTENCY_CONFLICT'))
  assert.equal(f.wire.paths.filter(path => path.endsWith('/artifact')).length, 1)
})

const releaseTarget = manifest => ({ manifestSha256: sha256(canonicalBytes(manifest)),
  artifactSha256: manifest.artifactSha256, contentTreeSha256: manifest.contentTreeSha256 })

test('pure local install receipt query has no remote or initialization side effects when no receipt exists', async t => {
  const f = await fixture(t)
  const input = { ...f.installInput, target: releaseTarget(f.manifest), connectionRevision: 0 }
  assert.equal(await f.client.replayInstall(input), undefined)
  assert.equal(f.wire.paths.length, 0)
  await assert.rejects(readdir(f.options.inventoryRoot), error => error.code === 'ENOENT')
  await f.bind()
  assert.equal(await f.client.replayInstall({ ...input, connectionRevision: 1 }), undefined)
  await assert.rejects(readdir(f.options.inventoryRoot), error => error.code === 'ENOENT')
  assert.equal(f.wire.paths.length, 1)
})

test('committed receipt replay rejects changes to every pinned target digest before returning prior success', async t => {
  const f = await fixture(t)
  await f.bind()
  const input = { ...f.installInput, target: releaseTarget(f.manifest), connectionRevision: 1 }
  const first = await f.client.install(input)
  const stateBefore = await readFile(join(f.options.inventoryRoot, 'state.json'))
  const requests = f.wire.paths.length
  for (const field of ['manifestSha256', 'artifactSha256', 'contentTreeSha256']) {
    const changed = { ...input, target: { ...input.target, [field]: '0'.repeat(64) } }
    await assert.rejects(f.client.replayInstall(changed), isCode('CENTER_TARGET_CHANGED'))
    await assert.rejects(f.client.install(changed), isCode('CENTER_TARGET_CHANGED'))
  }
  const mutable = structuredClone(input), replay = f.client.replayInstall(mutable)
  mutable.target.artifactSha256 = '0'.repeat(64)
  assert.deepEqual((await replay).operation, first.operation)
  await assert.rejects(f.client.replayInstall(input, true), isCode('IDEMPOTENCY_CONFLICT'))
  await assert.rejects(f.client.replayInstall({ ...input, target: { ...input.target, extra: true } }), isCode('CENTER_INVALID_INPUT'))
  for (const target of [null, false, 0, []]) await assert.rejects(f.client.replayInstall({ ...input, target }))
  assert.equal(f.wire.paths.length, requests)
  assert.ok(stateBefore.equals(await readFile(join(f.options.inventoryRoot, 'state.json'))))
})

test('target-pinned historical receipt remains queryable after uninstall and unbind without reinstating inventory', async t => {
  const f = await fixture(t)
  await f.bind()
  const input = { ...f.installInput, target: releaseTarget(f.manifest), connectionRevision: 1 }
  const original = await f.client.install(input)
  await f.client.uninstall({ releaseId: 'release.v1', expectedGeneration: 1, operationKey: 'remove' })
  await f.client.unbind({ expectedRevision: 1 }); await f.stop()
  const stateBefore = await readFile(join(f.options.inventoryRoot, 'state.json')), requests = f.wire.paths.length
  const restarted = createPackCenterClient(f.options)
  for (const response of [await restarted.replayInstall(input), await restarted.install(input)]) {
    assert.equal(response.replayed, true)
    assert.deepEqual(response.operation, original.operation)
    assert.equal(response.state.generation, 2)
    assert.deepEqual(response.state.installed, {})
    assert.deepEqual(response.state.active, {})
  }
  assert.equal(await restarted.replayInstall({ ...input, operationKey: 'never-committed' }), undefined)
  assert.equal(f.wire.paths.length, requests)
  assert.ok(stateBefore.equals(await readFile(join(f.options.inventoryRoot, 'state.json'))))
})

test('update-and-enable partial receipt preserves the old active map and replays only the same kind and target', async t => {
  const f = await fixture(t, { validateActivation: () => { throw Object.assign(new Error('preflight refused'), { code: 'ENTITY_CONFLICT' }) } })
  await f.bind()
  const input = { ...f.installInput, target: releaseTarget(f.manifest), connectionRevision: 1 }
  const partial = await f.client.updateEnable(input)
  assert.equal(partial.operation.result.status, 'installed_not_enabled')
  assert.equal(partial.operation.result.activated, false)
  assert.deepEqual(partial.state.active, {})
  assert.ok(partial.state.installed['release.v1'])
  await f.client.unbind({ expectedRevision: 1 }); await f.stop()
  assert.deepEqual((await f.client.replayInstall(input, true)).operation, partial.operation)
  assert.deepEqual((await f.client.updateEnable(input)).operation, partial.operation)
  await assert.rejects(f.client.replayInstall(input), isCode('IDEMPOTENCY_CONFLICT'))
  await assert.rejects(f.client.replayInstall({ ...input, target: { ...input.target, contentTreeSha256: '0'.repeat(64) } }, true), isCode('CENTER_TARGET_CHANGED'))
  assert.equal(f.wire.paths.filter(path => path.endsWith('/artifact')).length, 1)
})

test('retained receipt metadata is reverified and rejects symlinks, hardlinks, FIFOs, oversize and substituted signed manifests', async t => {
  for (const corruption of ['symlink', 'hardlink', 'fifo', 'oversize', 'substituted']) {
    await t.test(corruption, async t => {
      const f = await fixture(t)
      await f.bind()
      const input = { ...f.installInput, target: releaseTarget(f.manifest), connectionRevision: 1 }
      const installed = await f.client.install(input), metadata = installed.state.installed['release.v1'].manifestPath
      await f.client.uninstall({ releaseId: 'release.v1', expectedGeneration: 1, operationKey: 'remove' })
      await f.client.unbind({ expectedRevision: 1 }); await f.stop()
      const stateBefore = await readFile(join(f.options.inventoryRoot, 'state.json'))
      if (corruption === 'substituted') {
        await writeFile(metadata, JSON.stringify(signReleaseManifest({ ...f.manifest, artifactSha256: '0'.repeat(64) }, f.key.privateKey)))
      } else {
        const saved = `${metadata}.saved`
        await rename(metadata, saved)
        if (corruption === 'symlink') await symlink(saved, metadata)
        else if (corruption === 'hardlink') await link(saved, metadata)
        else if (corruption === 'fifo') execFileSync('mkfifo', [metadata])
        else await writeFile(metadata, ' '.repeat(1024 * 1024 + 1))
      }
      await assert.rejects(f.client.replayInstall(input), isCode(corruption === 'substituted' ? 'IMMUTABLE_RELEASE_CONFLICT' : 'INVENTORY_UNSAFE'))
      assert.ok(stateBefore.equals(await readFile(join(f.options.inventoryRoot, 'state.json'))))
      assert.equal(f.wire.paths.filter(path => path.endsWith('/artifact')).length, 1)
    })
  }
})

test('local errors redact credential text and filesystem paths', async t => {
  const f = await fixture(t)
  await f.bind()
  await writeFile(join(f.options.connectionRoot, 'connection.json'), `{ broken ${f.wire.token}`)
  await assert.rejects(f.client.getConnection(), error => {
    assert.equal(error.code, 'CONNECTION_CORRUPT')
    assert.ok(!JSON.stringify(error).includes(f.wire.token))
    assert.ok(!String(error).includes(f.root))
    return true
  })
})
