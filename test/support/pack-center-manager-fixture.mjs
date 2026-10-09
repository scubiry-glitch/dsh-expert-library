/** Real signed HTTP/tar fixture. No test registration and no mocked host manager. */
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packDirectory } from '../../packages/pack-artifact/index.mjs'
import { canonicalBytes, sha256, signReleaseManifest } from '../../packages/pack-contract/index.mjs'

const source = process.env.PACK_MANAGER_SOURCE === '1'
const { createPackCenterManager } = await import(source ? '../../src/host/pack-center-manager.ts' : '../../lib/host/pack-center-manager.js')
const { createPackCenterClient } = await import(source ? '../../src/host/pack-center-client.ts' : '../../lib/host/pack-center-client.js')
const { signingKeyFingerprints } = await import(source ? '../../src/host/pack-center-connection.ts' : '../../lib/host/pack-center-connection.js')

export function barrier() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
export async function managerFixture(t, changes = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'center-manager-test-')), root = join(directory, 'deployment')
  const key = generateKeyPairSync('ed25519'), pem = key.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const trustedSigningKeys = { 'test.key': pem }
  const report = { schemaVersion: 1, validatorVersion: '0.1.0', packSchemaVersion: 2, valid: true, diagnostics: [], entityCounts: {} }
  const template = await readFile(new URL('../../examples/pack-center/demo-v1/pack.json', import.meta.url), 'utf8')
  const releases = new Map(), managers = [], gates = []
  const wire = {
    paths: [], methods: [], headersSafe: true, catalogError: null, artifactError: null, grantError: null,
    catalogHook: undefined, grantHook: undefined, artifactHook: undefined,
    token: `dpc_token_${randomBytes(32).toString('base64url')}`, bindingCode: `dpc_bind_${randomBytes(32).toString('base64url')}`,
    grant: randomBytes(32).toString('base64url'), exchanges: 0,
  }
  async function addRelease({ releaseId, version, packId = 'demo.review', availability = { available: true }, ...extra }) {
    const content = join(directory, 'payloads', releaseId), tar = join(directory, `${releaseId}.tar`)
    await mkdir(content, { recursive: true, mode: 0o700 })
    await writeFile(join(content, 'pack.json'), template.replaceAll('demo.review', packId).replaceAll('1.0.0', version), { mode: 0o600 })
    const artifact = await packDirectory(content, tar)
    const manifest = {
      schemaVersion: 1, protocolVersion: 1, normalizationVersion: 1, digestAlgorithmVersion: 1,
      signatureAlgorithm: 'Ed25519', archiveFormat: 'tar', centerId: 'test.center', releaseId,
      packId, ownerOrgId: 'org.one', version, sourceCommit: 'a'.repeat(40), artifactSha256: artifact.artifactSha256,
      contentTreeSha256: artifact.contentTreeSha256, reportSha256: sha256(canonicalBytes(report)), validatorVersion: '0.1.0',
      packSchemaVersion: 2, requiresPlugin: { minVersion: '0.1.0' }, dependencyLock: [], builtinDependencies: [],
      sizeBytes: artifact.sizeBytes, fileCount: artifact.fileCount, approvedSubmissionId: `submission.${releaseId}`, signingKeyId: 'test.key', ...extra,
    }
    const value = { manifest, envelope: signReleaseManifest(manifest, key.privateKey), archive: await readFile(tar), availability }
    releases.set(releaseId, value)
    return value
  }
  function view(value) {
    const m = value.manifest
    return { releaseId: m.releaseId, packId: m.packId, ownerOrgId: m.ownerOrgId, version: m.version, manifest: m,
      name: 'Manager fixture', publishedAt: '2026-01-01T00:00:00.000Z', distribution: { kind: 'organization' },
      downloadAvailability: value.availability }
  }
  function json(res, value, status = 200) {
    const bytes = Buffer.from(JSON.stringify(value))
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' }); res.end(bytes)
  }
  const server = createServer((req, res) => { void (async () => {
    const url = new URL(req.url, 'http://fixture.invalid')
    wire.paths.push(url.pathname); wire.methods.push(req.method)
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.origin, undefined)
    assert.equal(Object.keys(req.headers).some(name => name.startsWith('sec-fetch-')), false)
    for await (const _chunk of req) { /* Never retain credential/code request bodies. */ }
    if (url.pathname === '/api/v1/deployment-bindings/exchange') {
      assert.equal(req.headers.authorization, undefined); wire.exchanges++
      json(res, { centerId: 'test.center', deployment: { id: 'deploy.one', organizationId: 'org.one', status: 'active' },
        credential: { id: `credential.${wire.exchanges}`, scopes: ['catalog:read', 'release:download'], expiresAt: new Date(Date.now() + 86400000).toISOString() },
        credentialToken: wire.token, trustInfo: { schemaVersion: 1, centerId: 'test.center', signingKeys: [
          { keyId: 'test.key', publicKeyPem: pem, fingerprintSha256: signingKeyFingerprints(trustedSigningKeys)['test.key'] },
        ] } }); return
    }
    assert.ok(req.headers.authorization === `Bearer ${wire.token}`, 'Private machine authorization is correct')
    if (url.pathname === '/api/v1/releases') {
      if (wire.catalogError) { json(res, { error: { code: wire.catalogError } }, wire.catalogError === 'UNAUTHENTICATED' ? 401 : 503); return }
      let rows = [...releases.values()].filter(value => !url.searchParams.has('packId') || value.manifest.packId === url.searchParams.get('packId'))
      const before = url.searchParams.get('beforeId')
      if (before) rows = rows.slice(rows.findIndex(value => value.manifest.releaseId === before) + 1)
      const limit = Number(url.searchParams.get('limit') ?? 50), selected = rows.slice(0, limit)
      const reply = { schemaVersion: 1, centerId: 'test.center', items: selected.map(view), nextCursor: rows.length > limit ? selected.at(-1).manifest.releaseId : null }
      await wire.catalogHook?.(reply, url); json(res, reply); return
    }
    const match = /^\/api\/v1\/releases\/([A-Za-z0-9._-]+)(?:\/(download-grants|artifact))?$/.exec(url.pathname)
    const value = match && releases.get(match[1])
    if (!value) { json(res, { error: { code: 'NOT_FOUND' } }, 404); return }
    if (match[2] === 'download-grants') {
      if (wire.grantError) { json(res, { error: { code: wire.grantError } }, 403); return }
      const reply = { schemaVersion: 1, centerId: 'test.center', releaseId: value.manifest.releaseId, signedManifest: value.envelope,
        grantToken: wire.grant, expiresAt: new Date(Date.now() + 60000).toISOString(), artifactPath: `/api/v1/releases/${value.manifest.releaseId}/artifact` }
      await wire.grantHook?.(reply); json(res, reply); return
    }
    if (match[2] === 'artifact') {
      assert.ok(req.headers['x-pack-download-grant'] === wire.grant, 'Download grant is a private header')
      if (wire.artifactError) { json(res, { error: { code: wire.artifactError } }, 403); return }
      await wire.artifactHook?.(value)
      res.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Length': value.archive.length }); res.end(value.archive); return
    }
    json(res, { ...view(value), signedManifest: value.envelope, validationReport: report,
      diff: null, diffAvailability: { available: true }, notes: 'Fixture notes', license: 'MIT' })
  })().catch(() => { if (!res.headersSent) json(res, { error: { code: 'FIXTURE_FAILURE' } }, 500); else res.destroy() }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let stopped = false
  async function stop() {
    if (stopped) return
    stopped = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
  const options = { root, origin: `http://127.0.0.1:${server.address().port}`, capabilities: { pluginVersion: '0.1.0' },
    allowLoopbackHttp: true, timeoutMs: 3000, validateActivation: () => {}, ...changes }
  function manager(overrides = {}) { const value = createPackCenterManager({ ...options, ...overrides }); managers.push(value); return value }
  function client(overrides = {}) {
    const { root: ignored, ...base } = options
    return createPackCenterClient({ ...base, connectionRoot: join(root, 'private'), inventoryRoot: join(root, 'inventory'), ...overrides })
  }
  const current = manager()
  const bindInput = { bindingCode: wire.bindingCode, expectedRevision: 0, expectedCenterId: 'test.center', trustedSigningKeys }
  t.after(async () => { gates.forEach(gate => gate.resolve()); for (const value of managers) await value.close(); await stop(); await rm(directory, { recursive: true, force: true }) })
  return { directory, root, key, wire, releases, options, manager, client, current, bindInput, addRelease, stop,
    async bind() { return current.bind(bindInput) },
    gate() { const value = barrier(); gates.push(value); return value },
    target(value) { return { manifestSha256: sha256(canonicalBytes(value.manifest)), artifactSha256: value.manifest.artifactSha256, contentTreeSha256: value.manifest.contentTreeSha256 } },
  }
}
