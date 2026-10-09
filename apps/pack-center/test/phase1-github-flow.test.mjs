/** HTTP/OIDC -> real smart HTTPS Git -> PostgreSQL/CAS -> approved Ed25519 release
 * -> authenticated host HTTP download with two isolated machine identities.
 * This is not browser or two actual DSH-process acceptance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request as httpRequest } from 'node:http'
import { createIdentityService } from '../dist/auth.js'
import { createSubmissionService } from '../dist/submissions.js'
import { createCenterServer } from '../dist/server.js'
import { createLocalArtifactStore } from '../dist/storage.js'
import { createGitSnapshotFetcher } from '../dist/git-snapshot.js'
import { createValidationWorker } from '../dist/validation-worker.js'
import { createPublisher } from '../dist/publisher.js'
import { createDeploymentService } from '../dist/deployments.js'
import { createCatalogService } from '../dist/catalog.js'
import { createReleaseGovernance } from '../dist/release-governance.js'
import { canonicalBytes, sha256, verifyReleaseManifest } from '../../../packages/pack-contract/index.mjs'
import { extractArtifact } from '../../../packages/pack-artifact/index.mjs'
import { createDatabaseFixture } from './support/database-fixture.mjs'
import { createTestIssuer } from './support/identity-fixture.mjs'

test('Phase 1 real GitHub submission, independent review, signed publication and authorized download', async t => {
  const fixture = await createDatabaseFixture('center-flow')
  t.after(() => fixture.close())
  const database = await fixture.database(t)
  const provider = await createTestIssuer(); t.after(() => provider.close())
  const root = await mkdtemp(join(tmpdir(), 'pack-center-phase1-github-'))
  const outputParent = join(root, 'output'); await mkdir(outputParent)
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceUrl = 'https://github.com/weixkcornell/macro-capital-analyst.git'
  const sourceCommit = 'f42bf4c8068294726ab7c780fe23ad121d72f34e'
  const git = { root, outputParent, infrastructure: {},
    input: { url: sourceUrl, ref: sourceCommit, outputParent, allowedHosts: ['github.com'], validatorVersion: '0.1.0' } }
  const publicOrigin = 'http://127.0.0.1:39999'
  const identity = createIdentityService({ database, oidc: { ...provider.config, redirectUri: `${publicOrigin}/api/auth/callback` }, loginEncryptionKey: randomBytes(32) })
  await identity.bootstrapAdmin({ issuer: provider.issuer, subject: 'admin', displayName: 'Admin' })
  const submissions = createSubmissionService(database, identity, { allowedGitHosts: ['github.com'] })
  const store = await createLocalArtifactStore(join(git.root, 'flow-store'))
  const keys = generateKeyPairSync('ed25519')
  const deployments = createDeploymentService({ database, identity, centerId: 'isolated-center' })
  const catalog = createCatalogService({ database, identity, deployments, store, centerId: 'isolated-center', trustedSigningKeys: { 'isolated-key': keys.publicKey } })
  const governance = createReleaseGovernance({ database, identity })
  const server = createCenterServer({ database, identity, submissions, distribution: { deployments, catalog, governance }, publicOrigin, allowLoopbackHttp: true })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const address = `http://127.0.0.1:${server.address().port}`
  async function host(path, { token, grant, body, expected = 200 } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(`${address}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(grant ? { 'X-Pack-Download-Grant': grant } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      } }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk)); res.on('error', reject)
        res.on('end', () => {
          try {
            const bytes = Buffer.concat(chunks)
            assert.equal(res.statusCode, expected, `Host ${path} returned ${res.statusCode}`)
            assert.equal(res.headers['cache-control'], 'no-store')
            resolve(res.headers['content-type']?.includes('application/json') ? JSON.parse(bytes) : bytes)
          } catch (error) { reject(error) }
        })
      })
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
  function browser() {
    const cookies = new Map()
    let csrf
    return {
      async request(path, method = 'GET', body, expected = 200, key = randomUUID()) {
        const response = await fetch(`${address}${path}`, { method, redirect: 'manual', headers: {
          Origin: publicOrigin, Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }), ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        }, body: body === undefined ? undefined : JSON.stringify(body) })
        for (const line of response.headers.getSetCookie()) {
          const pair = line.split(';')[0], index = pair.indexOf('=')
          cookies.set(pair.slice(0, index), pair.slice(index + 1))
        }
        const value = await response.json()
        assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`)
        if (value.csrfToken) csrf = value.csrfToken
        return value
      },
      async login(subject, invitationToken) {
        const start = await this.request('/api/auth/login', 'POST', invitationToken ? { invitationToken } : {})
        const callback = new URL(await provider.authorize(start.authorizationUrl, { subject }))
        return this.request(callback.pathname + callback.search)
      },
    }
  }
  const admin = browser(), developer = browser(), reviewer = browser(), outsider = browser()
  await admin.login('admin')
  for (const organization of ['demo', 'review-team', 'other']) await admin.request('/api/organizations', 'POST', { id: organization, slug: organization, name: organization }, 201)
  async function bind(organizationId) {
    const point = await admin.request('/api/v1/deployments', 'POST', { organizationId, name: `${organizationId} isolated point` }, 201)
    const code = await admin.request(`/api/v1/deployments/${point.id}/binding-codes`, 'POST', {}, 201)
    const result = await host('/api/v1/deployment-bindings/exchange', { body: { bindingCode: code.bindingCode } })
    assert.equal(result.centerId, 'isolated-center'); assert.equal(result.deployment.id, point.id)
    return result
  }
  const pointA = await bind('demo'), pointB = await bind('other')
  async function invite(client, subject, organization, roles) {
    const invitation = await admin.request(`/api/organizations/${organization}/invitations`, 'POST', { roles }, 201)
    const principal = await client.login(subject, invitation.invitationToken)
    await admin.request(`/api/users/${principal.principal.userId}/developer`, 'POST', { developer: true })
    return principal
  }
  await invite(developer, 'developer', 'demo', ['member'])
  const reviewerLogin = await invite(reviewer, 'reviewer', 'review-team', ['reviewer'])
  await invite(outsider, 'outsider', 'other', ['member'])
  await admin.request('/api/organizations/demo/review-scopes', 'POST', { reviewerId: reviewerLogin.principal.userId, granted: true })
  const draft = await developer.request('/api/submissions', 'POST', {
    organizationId: 'demo', packId: 'macro-capital-analyst', name: 'Macro Capital Analyst', version: '2.3.0',
    source: { url: sourceUrl, ref: sourceCommit }, notes: 'Phase 1 real public GitHub package', license: 'MIT', distribution: { kind: 'organization' },
  }, 201)
  const requested = await developer.request(`/api/submissions/${draft.id}/validate`, 'POST', { expectedVersion: draft.stateVersion }, 202)
  assert.equal(requested.submission.status, 'validating')
  const validator = createValidationWorker({ database, store, fetchSnapshot: createGitSnapshotFetcher(git.infrastructure),
    allowedGitHosts: ['github.com'], scratchRoot: git.outputParent, validatorVersion: '0.1.0', workerId: 'phase1-github-validator' })
  const commitBefore = sourceCommit
  assert.equal((await validator.runOnce()).status, 'validated')
  const validated = await developer.request(`/api/submissions/${draft.id}`)
  assert.equal(validated.snapshot.sourceCommit, commitBefore)
  assert.equal(validated.snapshot.report.valid, true)
  assert.equal(validated.snapshot.preview.normalization.scriptsExecuted, false)
  const pending = await developer.request(`/api/submissions/${draft.id}/submit`, 'POST', { expectedVersion: validated.submission.stateVersion })
  const reviewInput = { expectedVersion: pending.stateVersion, contentTreeSha256: validated.snapshot.contentTreeSha256, decision: 'approved', comment: 'Approved the exact original sample' }
  const machineReview = await host(`/api/submissions/${draft.id}/review`, { token: pointA.credentialToken, body: reviewInput, expected: 403 })
  assert.ok(['HUMAN_REQUIRED', 'HUMAN_AUTHENTICATION_REQUIRED'].includes(machineReview.error.code), machineReview.error.code)
  assert.equal((await developer.request(`/api/submissions/${draft.id}/review`, 'POST', reviewInput, 403)).error.code, 'SELF_REVIEW_DENIED')
  await outsider.request(`/api/submissions/${draft.id}`, 'GET', undefined, 404)
  const queue = await reviewer.request('/api/reviews?organizationId=demo')
  assert.equal(queue.items[0].id, draft.id)

  const approval = await reviewer.request(`/api/submissions/${draft.id}/review`, 'POST', reviewInput)
  assert.equal(approval.submission.status, 'approved')
  assert.ok(approval.releaseId)
  const publisher = createPublisher({ database, store, centerId: 'isolated-center', signingKeyId: 'isolated-key', signingPrivateKey: keys.privateKey, workerId: 'flow-publisher', scratchRoot: git.root })
  const published = await publisher.runOnce()
  assert.equal(published.status, 'published', JSON.stringify(published))
  const release = (await database.query('SELECT * FROM releases WHERE id=$1', [approval.releaseId])).rows[0]
  const envelope = release.signed_manifest
  const manifest = verifyReleaseManifest(envelope, { 'isolated-key': keys.publicKey })
  assert.equal(manifest.version, '2.3.0'); assert.equal(manifest.sourceCommit, commitBefore)
  assert.equal(manifest.contentTreeSha256, validated.snapshot.contentTreeSha256)
  assert.equal(manifest.reportSha256, validated.snapshot.reportSha256)
  assert.deepEqual(await store.getBytes(published.manifestKey), canonicalBytes(envelope))
  const available = await host('/api/v1/releases', { token: pointA.credentialToken })
  assert.equal(available.items.length, 1); assert.equal(available.items[0].releaseId, release.id)
  assert.deepEqual((await host('/api/v1/releases', { token: pointB.credentialToken })).items, [])
  await host(`/api/v1/releases/${release.id}`, { token: pointB.credentialToken, expected: 404 })
  const grant = await host(`/api/v1/releases/${release.id}/download-grants`, { token: pointA.credentialToken, body: {}, expected: 201 })
  assert.deepEqual(grant.signedManifest, envelope)
  await host(grant.artifactPath, { token: pointB.credentialToken, grant: grant.grantToken, expected: 404 })
  const archiveBytes = await host(grant.artifactPath, { token: pointA.credentialToken, grant: grant.grantToken })
  assert.deepEqual(archiveBytes, await store.getBytes(`sha256/${manifest.artifactSha256}`))
  assert.equal(sha256(archiveBytes), validated.snapshot.artifactSha256)
  const archive = join(git.root, 'approved.tar'), extracted = join(git.root, 'approved-content')
  await writeFile(archive, archiveBytes)
  await extractArtifact(archive, extracted, manifest)
  const pack = JSON.parse(await readFile(join(extracted, 'pack.json'), 'utf8'))
  assert.equal(pack.version, '2.3.0')

  // Simulate at-least-once queue delivery with a distinct outbox record. Neither
  // the envelope nor published_at changes, and no second publication audit fires.
  await database.enqueueJob({ kind: 'publish_release', idempotencyKey: `delivery-again:${release.id}`, payload: { releaseId: release.id, snapshotId: release.snapshot_id } })
  assert.equal((await publisher.runOnce()).status, 'published')
  const repeated = (await database.query('SELECT * FROM releases WHERE id=$1', [release.id])).rows[0]
  assert.deepEqual(repeated.signed_manifest, envelope); assert.deepEqual(repeated.published_at, release.published_at)
  assert.equal((await database.query("SELECT count(*)::int AS n FROM audit_events WHERE action='release.published' AND object_id=$1", [release.id])).rows[0].n, 1)
  const beforeYank = await host(`/api/v1/releases/${release.id}/download-grants`, { token: pointA.credentialToken, body: {}, expected: 201 })
  await admin.request(`/api/v1/releases/${release.id}/yank`, 'POST', { expectedVersion: repeated.state_version, reason: 'End-to-end withdrawal safety test' })
  assert.deepEqual((await host('/api/v1/releases', { token: pointA.credentialToken })).items, [])
  await host(beforeYank.artifactPath, { token: pointA.credentialToken, grant: beforeYank.grantToken, expected: 410 })
  assert.equal(sha256(archiveBytes), manifest.artifactSha256, 'Withdrawal cannot erase an already downloaded immutable artifact')
  assert.ok(provider.requests.token >= 4 && provider.requests.jwks >= 1)
  t.diagnostic(JSON.stringify({ sourceUrl, approvedCommit: commitBefore, fixedCommit: true, artifactSha256: manifest.artifactSha256,
    contentTreeSha256: manifest.contentTreeSha256, reportSha256: manifest.reportSha256, releaseId: release.id, duplicatePublicationUnchanged: true,
    authenticatedHttpDownload: true, twoMachineIdentityIsolation: true, oldGrantRejectedAfterYank: true }))
})
