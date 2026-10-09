/** Real OIDC + PostgreSQL + content-addressed artifacts + HTTP distribution.
 * The immutable validation snapshot is seeded from the checked-in sample; the
 * submission, review and Ed25519 publisher are real. Git fetching is covered by
 * center-flow.test.mjs, and this suite is not browser UI or two-DSH acceptance. */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { createCenterServer } from '../dist/server.js'
import { createIdentityService } from '../dist/auth.js'
import { createSubmissionService } from '../dist/submissions.js'
import { createDeploymentService } from '../dist/deployments.js'
import { createCatalogService } from '../dist/catalog.js'
import { createReleaseGovernance } from '../dist/release-governance.js'
import { createLocalArtifactStore } from '../dist/storage.js'
import { createPublisher } from '../dist/publisher.js'
import { packDirectory } from '../../../packages/pack-artifact/index.mjs'
import { canonicalJson, sha256, verifyReleaseManifest } from '../../../packages/pack-contract/index.mjs'
import { createDatabaseFixture } from './support/database-fixture.mjs'
import { createTestIssuer } from './support/identity-fixture.mjs'

let fixture, provider
before(async () => { fixture = await createDatabaseFixture('distribution-http'); provider = await createTestIssuer() })
after(async () => { await provider?.close(); await fixture?.close() })

function failure(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body))
  if (code) assert.equal(result.body.error.code, code)
}
function success(result, status = 200) {
  assert.equal(result.status, status, JSON.stringify(result.body)); return result.body
}
async function setup(t, options = {}) {
  const database = await fixture.database(t)
  const root = await mkdtemp(join(tmpdir(), 'pack-center-distribution-http-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const keys = generateKeyPairSync('ed25519')
  const store = await createLocalArtifactStore(join(root, 'store'))
  const publicOrigin = 'http://127.0.0.1:39999'
  const identity = createIdentityService({ database, oidc: { ...provider.config, redirectUri: `${publicOrigin}/api/auth/callback` }, loginEncryptionKey: randomBytes(32) })
  await identity.bootstrapAdmin({ issuer: provider.issuer, subject: 'admin', displayName: 'Administrator' })
  const submissions = createSubmissionService(database, identity, { allowedGitHosts: ['github.com'] })
  const deployments = createDeploymentService({ database, identity, centerId: 'center-test' })
  const governance = createReleaseGovernance({ database, identity })
  const catalogStore = options.decorateStream ? {
    verify: store.verify.bind(store),
    async openStream(...args) { const opened = await store.openStream(...args); return { ...opened, stream: options.decorateStream(opened.stream) } },
  } : store
  const catalog = createCatalogService({ database, identity, deployments, store: catalogStore, centerId: 'center-test',
    trustedSigningKeys: { 'test-key': keys.publicKey }, ...(options.downloadGrantTtlMs ? { downloadGrantTtlMs: options.downloadGrantTtlMs } : {}) })
  const server = createCenterServer({ database, identity, submissions, distribution: { deployments, catalog, governance }, publicOrigin, allowLoopbackHttp: true })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const address = `http://127.0.0.1:${server.address().port}`
  function browser() {
    const cookies = new Map()
    return {
      cookies,
      async call(path, { method = 'GET', body, headers = {}, key = randomUUID() } = {}) {
        const csrf = [...cookies].find(([name]) => name.endsWith('-csrf'))?.[1]
        const response = await fetch(address + path, { method, redirect: 'manual', headers: {
          cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '), origin: publicOrigin,
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': key }),
          ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers,
        }, body: body === undefined ? undefined : JSON.stringify(body) })
        for (const line of response.headers.getSetCookie()) {
          const pair = line.split(';')[0], separator = pair.indexOf('=')
          cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
        }
        const bytes = Buffer.from(await response.arrayBuffer())
        return { status: response.status, headers: Object.fromEntries(response.headers), bytes,
          body: response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(bytes) : undefined }
      },
      async login(subject, invitationToken) {
        const start = success(await this.call('/api/auth/login', { method: 'POST', body: invitationToken ? { invitationToken } : {} }))
        const callback = new URL(await provider.authorize(start.authorizationUrl, { subject }))
        return success(await this.call(callback.pathname + callback.search))
      },
    }
  }
  // Deliberately use the Node HTTP transport. Browser-like Sec-Fetch headers
  // (including those automatically added by fetch) are refused by host routes.
  async function host(path, { token, method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      const request = httpRequest(address + path, { method, headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}), ...headers,
      } }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () => {
          const bytes = Buffer.concat(chunks)
          resolve({ status: response.statusCode, headers: response.headers, bytes,
            body: response.headers['content-type']?.startsWith('application/json') ? JSON.parse(bytes) : undefined })
        })
      })
      request.on('error', reject); request.end(bytes)
    })
  }
  const admin = browser(); await admin.login('admin')
  for (const id of ['demo', 'other', 'reviewers']) success(await admin.call('/api/organizations', { method: 'POST', body: { id, slug: id, name: id } }), 201)
  async function invite(subject, organizationId, roles) {
    const invitation = success(await admin.call(`/api/organizations/${organizationId}/invitations`, { method: 'POST', body: { roles } }), 201)
    const client = browser(); const login = await client.login(subject, invitation.invitationToken)
    await admin.call(`/api/users/${login.principal.userId}/developer`, { method: 'POST', body: { developer: true } })
    return { ...client, login }
  }
  const developer = await invite('developer', 'demo', ['member'])
  const reviewer = await invite('reviewer', 'reviewers', ['reviewer'])
  const outsider = await invite('outsider', 'other', ['admin'])
  success(await admin.call('/api/organizations/demo/review-scopes', { method: 'POST', body: { reviewerId: reviewer.login.principal.userId, granted: true } }))
  async function point(name, organizationId = 'demo') {
    const deployment = success(await admin.call('/api/v1/deployments', { method: 'POST', body: { organizationId, name } }), 201)
    const binding = success(await admin.call(`/api/v1/deployments/${deployment.id}/binding-codes`, { method: 'POST', body: {} }), 201)
    const exchanged = success(await host('/api/v1/deployment-bindings/exchange', { method: 'POST', body: { bindingCode: binding.bindingCode } }))
    return { deployment, binding, exchanged, token: exchanged.credentialToken,
      call: (path, options = {}) => host(path, { ...options, token: exchanged.credentialToken }) }
  }
  const env = { database, identity, submissions, deployments, governance, catalog, store, keys, root, admin, developer, reviewer, outsider, browser, host, point }
  return env
}

async function published(env, scope = { kind: 'organization' }) {
  const { database, developer, reviewer, root, store, keys } = env
  const draft = success(await developer.call('/api/submissions', { method: 'POST', body: {
    organizationId: 'demo', packId: 'demo.review', name: 'Distribution sample', version: '1.0.0',
    source: { url: 'https://github.com/example/sample.git', ref: 'main' }, distribution: scope, notes: 'Reviewed original sample', license: 'MIT',
  } }), 201)
  success(await developer.call(`/api/submissions/${draft.id}/validate`, { method: 'POST', body: { expectedVersion: draft.stateVersion } }), 202)
  const archive = join(root, 'sample.tar'), snapshotId = randomUUID()
  const artifact = await packDirectory(new URL('../../../examples/pack-center/demo-v1/', import.meta.url).pathname, archive)
  const stored = await store.putFile(archive, artifact.artifactSha256)
  const report = { schemaVersion: 1, validatorVersion: '0.1.0', packSchemaVersion: 2, valid: true, diagnostics: [], entityCounts: {} }
  const storedReport = await store.putJson(report)
  const preview = { delivery: { requiresPlugin: { minVersion: '0.1.0' }, dependencyLock: [], builtinDependencies: [] } }
  await database.query(`INSERT INTO submission_snapshots(id,submission_id,source_commit,artifact_sha256,content_tree_sha256,report_sha256,
    artifact_key,report_key,validator_version,normalization_version,pack_schema_version,size_bytes,file_count,report,preview)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'0.1.0',1,2,$9,$10,$11::jsonb,$12::jsonb)`,
  [snapshotId, draft.id, 'a'.repeat(40), artifact.artifactSha256, artifact.contentTreeSha256, storedReport.sha256,
    stored.key, storedReport.key, artifact.sizeBytes, artifact.fileCount, canonicalJson(report), canonicalJson(preview)])
  await database.query("UPDATE submissions SET status='validated',snapshot_id=$2,state_version=state_version+1 WHERE id=$1", [draft.id, snapshotId])
  const validated = success(await developer.call(`/api/submissions/${draft.id}`))
  const pending = success(await developer.call(`/api/submissions/${draft.id}/submit`, { method: 'POST', body: { expectedVersion: validated.submission.stateVersion } }))
  const approved = success(await reviewer.call(`/api/submissions/${draft.id}/review`, { method: 'POST', body: {
    expectedVersion: pending.stateVersion, contentTreeSha256: artifact.contentTreeSha256, decision: 'approved', comment: 'Checked fixed sample',
  } }))
  const publisher = createPublisher({ database, store, centerId: 'center-test', signingKeyId: 'test-key', signingPrivateKey: keys.privateKey,
    scratchRoot: root, workerId: 'http-test-publisher' })
  const result = await publisher.runOnce()
  assert.equal(result.status, 'published', JSON.stringify(result))
  return { id: approved.releaseId, artifact, report, draft, archive }
}

test('HTTP admin binds two real host identities, returns credentials only to hosts and refuses browser exchange', async t => {
  const env = await setup(t), { admin, developer, outsider, host, database } = env
  const point = success(await admin.call('/api/v1/deployments', { method: 'POST', body: { organizationId: 'demo', name: 'Point A' } }), 201)
  failure(await developer.call('/api/v1/deployments', { method: 'POST', body: { organizationId: 'demo', name: 'No permission' } }), 403)
  failure(await outsider.call(`/api/v1/deployments/${point.id}`), 404, 'NOT_FOUND')
  failure(await outsider.call('/api/v1/deployments/not-a-real-deployment'), 404, 'NOT_FOUND')
  const binding = success(await admin.call(`/api/v1/deployments/${point.id}/binding-codes`, { method: 'POST', body: {} }), 201)
  failure(await admin.call('/api/v1/deployment-bindings/exchange', { method: 'POST', body: { bindingCode: binding.bindingCode } }), 403)
  for (const headers of [{ origin: 'http://127.0.0.1:39999' }, { cookie: '' }, { 'sec-fetch-mode': 'cors' }]) {
    failure(await host('/api/v1/deployment-bindings/exchange', { method: 'POST', body: { bindingCode: binding.bindingCode }, headers }), 403)
  }
  const exchanged = success(await host('/api/v1/deployment-bindings/exchange', { method: 'POST', body: { bindingCode: binding.bindingCode } }))
  assert.match(exchanged.credentialToken, /^dpc_token_/)
  assert.equal(exchanged.deployment.id, point.id)
  assert.equal(exchanged.trustInfo.centerId, 'center-test'); assert.equal(exchanged.trustInfo.signingKeys.length, 1)
  assert.match(exchanged.trustInfo.signingKeys[0].fingerprintSha256, /^[0-9a-f]{64}$/)
  failure(await host('/api/v1/deployment-bindings/exchange', { method: 'POST', body: { bindingCode: binding.bindingCode } }), 401)
  const second = await env.point('Point B')
  assert.notEqual(second.token, exchanged.credentialToken)
  const metadata = success(await admin.call(`/api/v1/deployments/${point.id}`))
  assert.equal(metadata.credentials.length, 1)
  assert.ok(!JSON.stringify(metadata).includes(exchanged.credentialToken))
  assert.ok(!JSON.stringify(metadata).includes(binding.bindingCode))
  const listing = success(await admin.call('/api/v1/deployments?organizationId=demo'))
  assert.equal(listing.deployments.length, 2)
  const spare = success(await admin.call(`/api/v1/deployments/${second.deployment.id}/binding-codes`, { method: 'POST', body: {} }), 201)
  success(await admin.call(`/api/v1/deployments/${second.deployment.id}/binding-codes/revoke`, { method: 'POST', body: { bindingCodeId: spare.bindingCodeId } }))
  failure(await host('/api/v1/deployment-bindings/exchange', { method: 'POST', body: { bindingCode: spare.bindingCode } }), 401)
  const disabled = success(await admin.call(`/api/v1/deployments/${second.deployment.id}/status`, { method: 'POST', body: { status: 'disabled', expectedVersion: second.deployment.stateVersion } }))
  assert.equal(disabled.status, 'disabled')
  failure(await second.call('/api/v1/releases'), 401)
  failure(await admin.call(`/api/v1/deployments/${second.deployment.id}/binding-codes`, { method: 'POST', body: {} }), 409, 'DEPLOYMENT_DISABLED')
  failure(await admin.call(`/api/v1/deployments/${second.deployment.id}/status`, { method: 'POST', body: { status: 'active', expectedVersion: second.deployment.stateVersion } }), 409, 'STATE_CONFLICT')
  const stored = JSON.stringify((await database.query('SELECT * FROM audit_events')).rows)
    + JSON.stringify((await database.query('SELECT * FROM request_idempotency')).rows)
  for (const secret of [binding.bindingCode, exchanged.credentialToken, second.token, spare.bindingCode]) assert.ok(!stored.includes(secret))
})

test('HTTP authorized catalogue and fixed download bytes isolate deployments and reject machine human-mutations', async t => {
  const env = await setup(t), first = await env.point('A'), second = await env.point('B'), other = await env.point('Other', 'other')
  const release = await published(env), path = `/api/v1/releases/${release.id}`
  for (const point of [first, second]) {
    const list = success(await point.call('/api/v1/releases'))
    assert.equal(list.items.length, 1); assert.equal(list.items[0].releaseId, release.id)
  }
  assert.deepEqual(success(await other.call('/api/v1/releases')).items, [])
  failure(await other.call(path), 404)
  const details = success(await first.call(path))
  assert.equal(details.signedManifest.manifest.artifactSha256, release.artifact.artifactSha256)
  const grant = success(await first.call(`${path}/download-grants`, { method: 'POST', body: {} }), 201)
  const manifest = verifyReleaseManifest(grant.signedManifest, { 'test-key': env.keys.publicKey })
  const downloaded = await first.call(grant.artifactPath, { headers: { 'x-pack-download-grant': grant.grantToken } })
  success(downloaded); assert.equal(sha256(downloaded.bytes), manifest.artifactSha256)
  assert.equal(downloaded.bytes.length, manifest.sizeBytes)
  assert.equal(downloaded.headers['content-type'], 'application/x-tar')
  assert.equal(downloaded.headers['content-disposition'], 'attachment; filename="domain-pack.tar"')
  assert.equal(downloaded.headers['cache-control'], 'no-store'); assert.equal(downloaded.headers['accept-ranges'], 'none')
  assert.equal(downloaded.headers['access-control-allow-origin'], undefined)
  failure(await second.call(grant.artifactPath, { headers: { 'x-pack-download-grant': grant.grantToken } }), 403, 'DOWNLOAD_GRANT_INVALID')
  for (const target of ['/api/submissions', `${path}/yank`, `/api/v1/deployments/${first.deployment.id}/status`]) {
    const denied = await first.call(target, { method: 'POST', body: { expectedVersion: 2, reason: 'Not a human', status: 'disabled' } })
    assert.ok([401, 403].includes(denied.status), JSON.stringify(denied.body))
  }
  const revokeKey = randomUUID(), revokePath = `/api/v1/deployments/${first.deployment.id}/credentials/revoke`
  const revokeOptions = { method: 'POST', body: { credentialId: first.exchanged.credential.id }, key: revokeKey }
  const revoked = await env.admin.call(revokePath, revokeOptions)
  success(revoked)
  assert.deepEqual(success(await env.admin.call(revokePath, revokeOptions)), revoked.body)
  failure(await first.call('/api/v1/releases'), 401)
  failure(await first.call(grant.artifactPath, { headers: { 'x-pack-download-grant': grant.grantToken } }), 401)
  assert.equal(success(await second.call('/api/v1/releases')).items.length, 1)
})

test('HTTP selected deployment scope hides a release from a same-organization second host', async t => {
  const env = await setup(t), first = await env.point('A'), second = await env.point('B')
  const release = await published(env, { kind: 'selected', organizationIds: [], deploymentIds: [first.deployment.id] })
  assert.equal(success(await first.call('/api/v1/releases')).items.length, 1)
  assert.deepEqual(success(await second.call('/api/v1/releases')).items, [])
  failure(await second.call(`/api/v1/releases/${release.id}`), 404)
  failure(await second.call(`/api/v1/releases/${release.id}/download-grants`, { method: 'POST', body: {} }), 404)
})

test('HTTP organization release management is human-only, separately authorized and retains yanked records', async t => {
  const env = await setup(t), point = await env.point('Only recipient')
  const release = await published(env, { kind: 'selected', organizationIds: [], deploymentIds: [point.deployment.id] })
  const path = '/api/v1/organizations/demo/releases'
  assert.deepEqual(success(await env.admin.call('/api/v1/releases')).items, [], 'Platform administration does not grant private downloads')
  for (const client of [env.admin, env.reviewer]) {
    const result = success(await client.call(`${path}?limit=1`))
    assert.equal(result.items[0].id, release.id); assert.equal(result.nextCursor, release.id)
    assert.deepEqual(success(await client.call(`${path}?beforeId=${release.id}`)).items, [])
  }
  for (const client of [env.developer, env.outsider]) failure(await client.call(path), 403, 'FORBIDDEN')
  failure(await point.call(path), 403, 'HUMAN_AUTHENTICATION_REQUIRED')
  failure(await env.admin.call(`${path}?unexpected=1`), 400)
  failure(await env.admin.call(`${path}?limit=0`), 400)
  const current = success(await env.admin.call(`/api/v1/releases/${release.id}/manage`))
  success(await env.admin.call(`/api/v1/releases/${release.id}/yank`, { method: 'POST', body: { expectedVersion: current.stateVersion, reason: 'Retain management history' } }))
  assert.equal(success(await env.admin.call(path)).items[0].status, 'yanked')
  assert.deepEqual(success(await point.call('/api/v1/releases')).items, [])
})

test('HTTP scope review and yank invalidate old download grants without changing the signed bytes', async t => {
  const env = await setup(t), first = await env.point('A'), second = await env.point('B')
  const release = await published(env), path = `/api/v1/releases/${release.id}`
  const before = success(await first.call(path)).signedManifest
  const grantA = success(await first.call(`${path}/download-grants`, { method: 'POST', body: {} }), 201)
  const grantB = success(await second.call(`${path}/download-grants`, { method: 'POST', body: {} }), 201)
  const managed = success(await env.admin.call(`${path}/manage`))
  const requested = success(await env.admin.call(`${path}/distribution-requests`, { method: 'POST', body: {
    expectedVersion: managed.distribution.stateVersion, scope: { kind: 'selected', organizationIds: [], deploymentIds: [first.deployment.id] }, reason: 'Limit to the selected host',
  } }), 201)
  assert.equal(success(await env.reviewer.call('/api/v1/organizations/demo/distribution-review-queue')).items.length, 1)
  // Policy parity with submission self-review: the tenant admin requester may
  // self-approve; the decision stays immutable and audited.
  const selfDecision = success(await env.admin.call(`/api/v1/distribution-requests/${requested.id}/review`, { method: 'POST', body: { expectedVersion: requested.stateVersion, decision: 'approved', comment: 'Self-approved by tenant admin' } }))
  assert.equal(selfDecision.request.status, 'approved')
  failure(await env.reviewer.call(`/api/v1/distribution-requests/${requested.id}/review`, { method: 'POST', body: { expectedVersion: requested.stateVersion, decision: 'approved', comment: 'Already decided' } }), 409)
  assert.deepEqual(success(await first.call(path)).signedManifest, before)
  failure(await second.call(grantB.artifactPath, { headers: { 'x-pack-download-grant': grantB.grantToken } }), 404)
  success(await first.call(grantA.artifactPath, { headers: { 'x-pack-download-grant': grantA.grantToken } }))
  const current = success(await env.admin.call(`${path}/manage`))
  success(await env.admin.call(`${path}/yank`, { method: 'POST', body: { expectedVersion: current.stateVersion, reason: 'Withdraw from new distribution' } }))
  failure(await first.call(grantA.artifactPath, { headers: { 'x-pack-download-grant': grantA.grantToken } }), 410, 'RELEASE_YANKED')
  assert.deepEqual(success(await first.call('/api/v1/releases')).items, [])
  const row = (await env.database.query('SELECT signed_manifest,status FROM releases WHERE id=$1', [release.id])).rows[0]
  assert.deepEqual(row.signed_manifest, before); assert.equal(row.status, 'yanked')
})

test('HTTP transport rejects ambiguous auth, browser Bearer, URL grants, range and conditional requests', async t => {
  const env = await setup(t), point = await env.point('A'), release = await published(env)
  const path = `/api/v1/releases/${release.id}`
  failure(await env.admin.call('/api/me', { headers: { authorization: `Bearer ${point.token}` } }), 400, 'AMBIGUOUS_AUTHENTICATION')
  failure(await env.admin.call(path, { headers: { authorization: `Bearer ${point.token}` } }), 400, 'AMBIGUOUS_AUTHENTICATION')
  for (const headers of [{ origin: 'http://127.0.0.1:39999' }, { 'sec-fetch-mode': 'cors' }, { 'sec-fetch-site': 'same-origin' }]) {
    failure(await point.call(path, { headers }), 403)
  }
  const grant = success(await point.call(`${path}/download-grants`, { method: 'POST', body: {} }), 201)
  failure(await point.call(`${grant.artifactPath}?grant=${grant.grantToken}`), 400, 'INVALID_INPUT')
  failure(await point.call(grant.artifactPath), 401, 'DOWNLOAD_GRANT_REQUIRED')
  for (const headers of [{ range: 'bytes=0-15' }, { 'if-none-match': '*' }, { 'if-modified-since': new Date().toUTCString() }]) {
    failure(await point.call(grant.artifactPath, { headers: { ...headers, 'x-pack-download-grant': grant.grantToken } }), 400, 'DOWNLOAD_CONDITION_UNSUPPORTED')
  }
  failure(await point.call('/api/v1/releases?limit=0'), 400)
  failure(await point.call('/api/v1/releases?limit=1&limit=2'), 400)
  failure(await point.call(`${path}/download-grants`, { method: 'POST', body: { credentialToken: point.token } }), 400)
  const audit = JSON.stringify((await env.database.query('SELECT * FROM audit_events')).rows)
  for (const secret of [point.token, point.binding.bindingCode, grant.grantToken]) assert.ok(!audit.includes(secret))
})

test('HTTP short-lived grants require their original current identity and expiry is enforced', async t => {
  const env = await setup(t, { downloadGrantTtlMs: 1000 }), point = await env.point('A'), release = await published(env)
  const path = `/api/v1/releases/${release.id}`
  failure(await env.developer.call(`${path}/download-grants`, { method: 'POST', body: {}, headers: { 'x-csrf-token': '' } }), 403, 'CSRF_INVALID')
  const humanGrant = success(await env.developer.call(`${path}/download-grants`, { method: 'POST', body: {} }), 201)
  failure(await point.call(humanGrant.artifactPath, { headers: { 'x-pack-download-grant': humanGrant.grantToken } }), 403, 'DOWNLOAD_GRANT_INVALID')
  success(await env.developer.call(humanGrant.artifactPath, { headers: { 'x-pack-download-grant': humanGrant.grantToken } }))
  const oldCookie = [...env.developer.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  success(await env.developer.call('/api/auth/logout', { method: 'POST', body: {} }))
  failure(await env.host(humanGrant.artifactPath, { headers: { cookie: oldCookie, 'x-pack-download-grant': humanGrant.grantToken } }), 401)
  const machineGrant = success(await point.call(`${path}/download-grants`, { method: 'POST', body: {} }), 201)
  await delay(1100)
  failure(await point.call(machineGrant.artifactPath, { headers: { 'x-pack-download-grant': machineGrant.grantToken } }), 403, 'DOWNLOAD_GRANT_INVALID')
  const refreshed = success(await point.call(`${path}/download-grants`, { method: 'POST', body: {} }), 201)
  success(await point.call(refreshed.artifactPath, { headers: { 'x-pack-download-grant': refreshed.grantToken } }))
})

test('HTTP fails closed on damaged artifact bytes without leaking private storage paths or grant material', async t => {
  const env = await setup(t), point = await env.point('A'), release = await published(env)
  const grant = success(await point.call(`/api/v1/releases/${release.id}/download-grants`, { method: 'POST', body: {} }), 201)
  const path = join(env.store.root, 'sha256', release.artifact.artifactSha256, 'data')
  const bytes = await readFile(path); bytes[0] ^= 1
  await chmod(path, 0o600); await writeFile(path, bytes); await chmod(path, 0o400)
  const refused = await point.call(grant.artifactPath, { headers: { 'x-pack-download-grant': grant.grantToken } })
  failure(refused, 500, 'STORAGE_HASH_MISMATCH')
  assert.equal(refused.headers['content-type'], 'application/json; charset=utf-8')
  const report = JSON.stringify(refused.body) + JSON.stringify((await env.database.query('SELECT * FROM audit_events')).rows)
  for (const secret of [path, grant.grantToken, point.token]) assert.ok(!report.includes(secret))
})

test('HTTP stream read failure destroys transport and source without recording raw exception secrets', async t => {
  let closed = false, sensitiveMessage = 'test-only stream failure'
  const env = await setup(t, { decorateStream(source) {
    const failure = new Transform({ transform(chunk, encoding, callback) { callback(new Error(sensitiveMessage)) } })
    source.once('close', () => { closed = true })
    failure.once('close', () => source.destroy())
    source.on('error', error => failure.destroy(error))
    // Match the storage contract's lazy readable: do not start disk reads until
    // the HTTP pipeline has installed its error listeners and requests bytes.
    failure.once('resume', () => source.pipe(failure))
    return failure
  } })
  const point = await env.point('A'), release = await published(env)
  const grant = success(await point.call(`/api/v1/releases/${release.id}/download-grants`, { method: 'POST', body: {} }), 201)
  sensitiveMessage = 'test-only stream failure /private/storage/path secret-marker-not-a-real-credential'
  await assert.rejects(point.call(grant.artifactPath, { headers: { 'x-pack-download-grant': grant.grantToken } }), error => {
    assert.ok(['ECONNRESET', 'EPIPE', 'ABORT_ERR'].includes(error.code)); return true
  })
  for (let attempt = 0; !closed && attempt < 20; attempt += 1) await delay(10)
  assert.equal(closed, true)
  const audit = JSON.stringify((await env.database.query('SELECT * FROM audit_events')).rows)
  for (const secret of [sensitiveMessage, point.token, grant.grantToken]) assert.ok(!audit.includes(secret))
})
