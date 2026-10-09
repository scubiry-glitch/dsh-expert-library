/** Real center HTTP/OIDC + PostgreSQL + smart HTTPS Git -> host client ->
 * signed immutable local inventory. Two deployment-local client directories
 * are not two real DSH processes, and the sample preflight is not DSH acceptance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
import { verifyReleaseManifest } from '../../../packages/pack-contract/index.mjs'
import { createDatabaseFixture } from './support/database-fixture.mjs'
import { createTestIssuer } from './support/identity-fixture.mjs'
import { gitFixture } from './support/git-fixture.mjs'

const { createPackCenterClient } = await import(process.env.PACK_CENTER_CLIENT_SOURCE === '1'
  ? '../../../src/host/pack-center-client.ts' : '../../../lib/host/pack-center-client.js')

test('real center host client pins, persists, isolates deployments, installs without enabling and keeps verified offline content after revoke/unbind', async t => {
  const fixture = await createDatabaseFixture('host-client-flow')
  t.after(() => fixture.close())
  const database = await fixture.database(t)
  const provider = await createTestIssuer()
  t.after(() => provider.close())
  const git = await gitFixture(t)
  const publicOrigin = 'http://127.0.0.1:39999'
  const centerId = 'host-client-center', signingKeyId = 'host-client-key'
  const keys = generateKeyPairSync('ed25519')
  // These pins come from the fixture administrator, not from exchange/catalog.
  const trustedSigningKeys = { [signingKeyId]: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  const identity = createIdentityService({ database,
    oidc: { ...provider.config, redirectUri: `${publicOrigin}/api/auth/callback` }, loginEncryptionKey: randomBytes(32) })
  await identity.bootstrapAdmin({ issuer: provider.issuer, subject: 'admin', displayName: 'Host Client Test Administrator' })
  const submissions = createSubmissionService(database, identity, { allowedGitHosts: ['git.fixture.invalid'] })
  const store = await createLocalArtifactStore(join(git.root, 'host-client-center-store'))
  const deployments = createDeploymentService({ database, identity, centerId })
  const catalog = createCatalogService({ database, identity, deployments, store, centerId,
    trustedSigningKeys: { [signingKeyId]: keys.publicKey } })
  const governance = createReleaseGovernance({ database, identity })
  const server = createCenterServer({ database, identity, submissions,
    distribution: { deployments, catalog, governance }, publicOrigin, allowLoopbackHttp: true })
  // Count only non-secret route paths: never retain authorization/body headers.
  const hostRequests = new Map()
  server.on('request', request => {
    const path = new URL(request.url, publicOrigin).pathname
    if (path.startsWith('/api/v1/releases') || path === '/api/v1/deployment-bindings/exchange') {
      hostRequests.set(path, (hostRequests.get(path) ?? 0) + 1)
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let stopped = false
  async function stopCenter() {
    if (stopped) return
    stopped = true
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  t.after(stopCenter)
  const origin = `http://127.0.0.1:${server.address().port}`

  function browser() {
    const cookies = new Map()
    let csrf
    return {
      async request(path, method = 'GET', body, expected = 200) {
        const response = await fetch(`${origin}${path}`, { method, redirect: 'manual', headers: {
          Origin: publicOrigin, Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        }, body: body === undefined ? undefined : JSON.stringify(body) })
        for (const line of response.headers.getSetCookie()) {
          const pair = line.split(';')[0], index = pair.indexOf('=')
          cookies.set(pair.slice(0, index), pair.slice(index + 1))
        }
        const value = await response.json()
        // Deliberately do not print bodies: successful issuance includes secrets.
        assert.equal(response.status, expected, `${method} ${new URL(path, origin).pathname} returned unexpected status`)
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
  const admin = browser(), developer = browser(), reviewer = browser()
  await admin.login('admin')
  for (const id of ['host-owner', 'host-other', 'host-reviewers']) {
    await admin.request('/api/organizations', 'POST', { id, slug: id === 'host-owner' ? 'demo' : id, name: id }, 201)
  }
  async function invite(client, subject, organizationId, roles) {
    const invitation = await admin.request(`/api/organizations/${organizationId}/invitations`, 'POST', { roles }, 201)
    const principal = await client.login(subject, invitation.invitationToken)
    await admin.request(`/api/users/${principal.principal.userId}/developer`, 'POST', { developer: true })
    return principal
  }
  await invite(developer, 'developer', 'host-owner', ['member'])
  const reviewerLogin = await invite(reviewer, 'reviewer', 'host-reviewers', ['reviewer'])
  await admin.request('/api/organizations/host-owner/review-scopes', 'POST', { reviewerId: reviewerLogin.principal.userId, granted: true })

  const draft = await developer.request('/api/submissions', 'POST', {
    organizationId: 'host-owner', packId: 'demo.review', name: 'Host client signed sample', version: '1.0.0',
    source: { url: git.input.url, ref: 'main' }, notes: 'Private host client transport and inventory fixture',
    license: 'MIT', distribution: { kind: 'organization' },
  }, 201)
  await developer.request(`/api/submissions/${draft.id}/validate`, 'POST', { expectedVersion: draft.stateVersion }, 202)
  const validator = createValidationWorker({ database, store, fetchSnapshot: createGitSnapshotFetcher(git.infrastructure),
    allowedGitHosts: ['git.fixture.invalid'], scratchRoot: git.outputParent, validatorVersion: '0.1.0', workerId: 'host-client-validator' })
  assert.equal((await validator.runOnce()).status, 'validated')
  const validated = await developer.request(`/api/submissions/${draft.id}`)
  assert.equal(validated.snapshot.report.valid, true)
  assert.equal(validated.snapshot.preview.normalization.scriptsExecuted, false)
  const pending = await developer.request(`/api/submissions/${draft.id}/submit`, 'POST', { expectedVersion: validated.submission.stateVersion })
  const approved = await reviewer.request(`/api/submissions/${draft.id}/review`, 'POST', {
    expectedVersion: pending.stateVersion, contentTreeSha256: validated.snapshot.contentTreeSha256,
    decision: 'approved', comment: 'Approve the exact immutable host sample',
  })
  const publisher = createPublisher({ database, store, centerId, signingKeyId, signingPrivateKey: keys.privateKey,
    workerId: 'host-client-publisher', scratchRoot: git.root })
  assert.equal((await publisher.runOnce()).status, 'published')
  const releaseId = approved.releaseId
  assert.ok(releaseId)

  const pointA = await admin.request('/api/v1/deployments', 'POST', { organizationId: 'host-owner', name: 'Host A' }, 201)
  const pointB = await admin.request('/api/v1/deployments', 'POST', { organizationId: 'host-other', name: 'Host B' }, 201)
  let activationChecks = 0
  const roots = name => ({ connectionRoot: join(git.root, `host-${name}`, 'private'), inventoryRoot: join(git.root, `host-${name}`, 'inventory') })
  const optionsA = { origin, ...roots('a'), capabilities: { pluginVersion: '0.1.0' }, allowLoopbackHttp: true,
    async validateActivation(state) {
      activationChecks++
      // An explicit real-content sample preflight, not an empty callback or a
      // claim to have validated the DSH builtin/workspace runtime merge.
      for (const [packId, activeRelease] of Object.entries(state.active)) {
        assert.equal(packId, 'demo.review')
        const pack = JSON.parse(await readFile(join(state.installed[activeRelease].packPath, 'pack.json'), 'utf8'))
        assert.equal(pack.pack.id, packId)
        assert.equal(pack.pack.version, '1.0.0')
        assert.equal(pack.experts[0].display.publicLabel, '样例 V1')
        assert.equal(pack.teamTemplates[0].slots[0].capabilities[0], 'demo.review')
      }
    },
  }
  const optionsB = { origin, ...roots('b'), capabilities: { pluginVersion: '0.1.0' }, allowLoopbackHttp: true }
  let hostA = createPackCenterClient(optionsA)
  const hostB = createPackCenterClient(optionsB)
  const exchangePath = '/api/v1/deployment-bindings/exchange'
  async function issue(point) {
    return admin.request(`/api/v1/deployments/${point.id}/binding-codes`, 'POST', {}, 201)
  }
  async function failedInitialBinding(client, point, changes) {
    const code = await issue(point), before = hostRequests.get(exchangePath) ?? 0
    await assert.rejects(client.bind({ bindingCode: code.bindingCode, expectedRevision: 0, expectedCenterId: centerId,
      trustedSigningKeys, ...changes }), error => error.code === 'CENTER_BIND_UNCONFIRMED')
    assert.equal(hostRequests.get(exchangePath), before + 1, 'An unconfirmed one-time exchange must not be retried')
    assert.deepEqual(await client.getConnection(), { revision: 0, connection: null }, 'Untrusted identity must not become the active connection')
    const status = await admin.request(`/api/v1/deployments/${point.id}`)
    assert.equal(status.credentials.length, 1, 'Exchange can consume a code before the host detects a trust mismatch')
    await admin.request(`/api/v1/deployments/${point.id}/credentials/revoke`, 'POST', { credentialId: status.credentials[0].id })
  }
  const wrongKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  await failedInitialBinding(hostA, pointA, { trustedSigningKeys: { [signingKeyId]: wrongKey } })
  await failedInitialBinding(hostB, pointB, { expectedCenterId: 'not-the-configured-center' })
  async function bind(client, point) {
    const code = await issue(point)
    const view = await client.bind({ bindingCode: code.bindingCode, expectedRevision: 0, expectedCenterId: centerId, trustedSigningKeys })
    assert.equal(view.revision, 1)
    assert.equal(view.connection.bound, true)
    assert.equal(view.connection.centerId, centerId)
    assert.equal(view.connection.deploymentId, point.id)
    assert.ok(view.connection.credentialId)
    assert.doesNotMatch(JSON.stringify(view), /credentialToken|BEGIN PUBLIC KEY|BEGIN PRIVATE KEY|host-client-center-store/)
    assert.ok(!JSON.stringify(view).includes(git.root))
    return view
  }
  const connectionA = await bind(hostA, pointA), connectionB = await bind(hostB, pointB)
  assert.notEqual(connectionA.connection.credentialId, connectionB.connection.credentialId)
  hostA = createPackCenterClient(optionsA)
  assert.deepEqual(await hostA.getConnection(), connectionA, 'A restarted client reads its private persisted binding')
  const available = await hostA.listReleases({ packId: 'demo.review', limit: 1 })
  assert.equal(available.items.length, 1)
  assert.equal(available.items[0].releaseId, releaseId)
  assert.deepEqual((await hostB.listReleases()).items, [], 'Private catalog rows do not cross deployment organizations')
  await assert.rejects(hostB.getRelease(releaseId), error => error.status === 404)
  await assert.rejects(hostB.install({ releaseId, expectedGeneration: 0, operationKey: 'denied-private-install' }), error => error.status === 404)
  assert.deepEqual((await hostB.localState()).state.installed, {})

  const detail = await hostA.getRelease(releaseId)
  const manifest = verifyReleaseManifest(detail.signedManifest, { [signingKeyId]: keys.publicKey })
  assert.equal(manifest.contentTreeSha256, validated.snapshot.contentTreeSha256)
  assert.equal(manifest.artifactSha256, validated.snapshot.artifactSha256)
  const grantsBeforeInstall = hostRequests.get(`/api/v1/releases/${releaseId}/download-grants`) ?? 0
  const downloadsBeforeInstall = hostRequests.get(`/api/v1/releases/${releaseId}/artifact`) ?? 0
  const installed = await hostA.install({ releaseId, expectedGeneration: 0, operationKey: 'install-reviewed-v1' })
  assert.equal(installed.state.generation, 1)
  assert.deepEqual(installed.state.active, {}, 'A download must never imply enable')
  assert.equal(installed.operation.result.activated, false)
  assert.equal(activationChecks, 0, 'Caching is independent of activation preflight')
  assert.equal(installed.state.installed[releaseId].contentTreeSha256, manifest.contentTreeSha256)
  assert.equal(installed.state.installed[releaseId].artifactSha256, manifest.artifactSha256)
  assert.equal(hostRequests.get(`/api/v1/releases/${releaseId}/download-grants`), grantsBeforeInstall + 1)
  assert.equal(hostRequests.get(`/api/v1/releases/${releaseId}/artifact`), downloadsBeforeInstall + 1)
  assert.deepEqual((await hostA.activeSnapshot()).packs, [])
  const packPath = installed.state.installed[releaseId].packPath
  assert.ok(packPath.startsWith(`${optionsA.inventoryRoot}/`))
  assert.ok(!packPath.startsWith(`${optionsB.inventoryRoot}/`))
  const envelope = JSON.parse(await readFile(installed.state.installed[releaseId].manifestPath, 'utf8'))
  assert.deepEqual(verifyReleaseManifest(envelope, { [signingKeyId]: keys.publicKey }), manifest)
  const withoutHostPreflight = createPackCenterClient({ ...optionsA, validateActivation: undefined })
  await assert.rejects(withoutHostPreflight.enable({ releaseId, expectedGeneration: 1, operationKey: 'missing-host-preflight' }),
    error => error.code === 'CENTER_ACTIVATION_UNAVAILABLE', 'Host activation requires an explicit runtime preflight adapter')
  assert.equal((await hostA.localState()).state.generation, 1)
  assert.deepEqual((await hostA.activeSnapshot()).packs, [])
  const enabled = await hostA.enable({ releaseId, expectedGeneration: 1, operationKey: 'enable-reviewed-v1' })
  assert.equal(enabled.state.generation, 2)
  assert.equal(enabled.state.active['demo.review'], releaseId)
  assert.equal(activationChecks, 1)
  const captured = await hostA.activeSnapshot()
  assert.equal(captured.packs[0].releaseId, releaseId)
  assert.equal(captured.packs[0].root, packPath)

  await admin.request(`/api/v1/deployments/${pointA.id}/credentials/revoke`, 'POST', { credentialId: connectionA.connection.credentialId })
  const beforeRevokedPull = hostRequests.get('/api/v1/releases')
  await assert.rejects(hostA.listReleases(), error => error.status === 401)
  assert.equal(hostRequests.get('/api/v1/releases'), beforeRevokedPull + 1, 'Revocation must be checked by the real center')
  // P5 intentionally permits offline use of already verified installed bytes.
  // Probe a genuinely uncached target to prove new distribution still checks
  // the revoked machine credential before exposing even release existence.
  const uncachedReleaseId = randomUUID()
  const revokedGrantPath = `/api/v1/releases/${uncachedReleaseId}/download-grants`
  const beforeRevokedGrant = hostRequests.get(revokedGrantPath) ?? 0
  await assert.rejects(hostA.install({ releaseId: uncachedReleaseId, expectedGeneration: 2, operationKey: 'revoked-remote-pull' }), error => error.status === 401)
  assert.equal(hostRequests.get(revokedGrantPath), beforeRevokedGrant + 1)
  assert.equal(hostRequests.get(`/api/v1/releases/${releaseId}/artifact`), downloadsBeforeInstall + 1,
    'A revoked identity cannot start a second artifact transfer')
  assert.equal((await hostA.localState()).state.generation, 2)
  assert.deepEqual((await hostB.listReleases()).items, [], 'Revoking A must not revoke B')
  assert.deepEqual(await hostA.activeSnapshot(), captured, 'Revoked network permission does not erase verified local content')

  await stopCenter()
  hostA = createPackCenterClient(optionsA)
  await assert.rejects(hostA.listReleases(), 'A stopped center cannot serve a remote catalog')
  assert.deepEqual(await hostA.activeSnapshot(), captured, 'Cold client can verify its active inventory with the center offline')
  const unbound = await hostA.unbind({ expectedRevision: connectionA.revision })
  assert.equal(unbound.revision, 2)
  assert.equal(unbound.connection.bound, false)
  assert.equal(unbound.connection.centerId, centerId)
  hostA = createPackCenterClient(optionsA)
  assert.deepEqual(await hostA.getConnection(), unbound)
  assert.deepEqual(await hostA.activeSnapshot(), captured, 'Unbinding keeps independently pinned historical verification keys')
  assert.deepEqual((await hostB.getConnection()), connectionB, 'A local unbind cannot mutate another deployment directory')
  const requestsBeforeReplay = [...hostRequests]
  const offlineReceipt = await hostA.install({ releaseId, expectedGeneration: 0, operationKey: 'install-reviewed-v1' })
  assert.equal(offlineReceipt.replayed, true, 'A committed receipt remains resolvable after center stop and local unbind')
  assert.equal(offlineReceipt.state.generation, 2, 'An old receipt lookup must not revert later activation or advance state')
  assert.deepEqual(offlineReceipt.operation, installed.operation)
  assert.equal(offlineReceipt.state.active['demo.review'], releaseId)
  await assert.rejects(hostA.install({ releaseId: randomUUID(), expectedGeneration: 0, operationKey: 'install-reviewed-v1' }),
    error => error.code === 'IDEMPOTENCY_CONFLICT')
  await assert.rejects(hostA.install({ releaseId, expectedGeneration: 1, operationKey: 'install-reviewed-v1' }),
    error => error.code === 'IDEMPOTENCY_CONFLICT')
  assert.deepEqual([...hostRequests], requestsBeforeReplay)
  assert.equal((await hostA.localState()).state.generation, 2)
  const disabled = await hostA.disable({ packId: 'demo.review', expectedGeneration: 2, operationKey: 'offline-disable' })
  assert.equal(disabled.state.generation, 3)
  assert.deepEqual((await hostA.activeSnapshot()).packs, [])
  await hostA.enable({ releaseId, expectedGeneration: 3, operationKey: 'offline-enable' })
  assert.equal((await hostA.activeSnapshot()).packs[0].releaseId, releaseId)
  assert.ok(activationChecks >= 2)
  assert.equal(JSON.parse(await readFile(join(captured.packs[0].root, 'pack.json'), 'utf8')).experts[0].display.publicLabel, '样例 V1')
  await writeFile(join(packPath, 'README.md'), 'Deliberately corrupted isolated fixture content')
  await assert.rejects(hostA.activeSnapshot(), error => error.code === 'CONTENT_DIGEST_MISMATCH',
    'Offline runtime selection must not trust modified local content')
  t.diagnostic(JSON.stringify({ releaseId, artifactSha256: manifest.artifactSha256, contentTreeSha256: manifest.contentTreeSha256,
    independentlyPinned: true, realCenterGrantAndStream: true, defaultInstallInactive: true,
    twoClientDirectoryIsolation: true, credentialRevocationEnforced: true, offlineAfterRestartAndUnbind: true,
    offlineCommittedReceiptReplay: true, changedReceiptRequestRejected: true,
    sampleContentPreflightOnly: true, realDshAcceptance: false }))
})
