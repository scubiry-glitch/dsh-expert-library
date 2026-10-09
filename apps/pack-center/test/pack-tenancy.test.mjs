/** Tenancy split acceptance: pack management follows pack_ownerships (creation
 * axis) while tenant visibility follows pack_visibilities (distribution axis).
 * A tenant admin without pack ownership can no longer edit packs, a cross-tenant
 * maintainer can, and a tenant visibility grant ("all"/"list") widens exactly
 * what its deployments may list and download. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
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
import { createDatabaseFixture } from './support/database-fixture.mjs'
import { createTestIssuer } from './support/identity-fixture.mjs'
import { gitFixture } from './support/git-fixture.mjs'

test('pack ownership and tenant visibility are independent axes', async t => {
  const fixture = await createDatabaseFixture('pack-tenancy')
  t.after(() => fixture.close())
  const database = await fixture.database(t)
  const provider = await createTestIssuer(); t.after(() => provider.close())
  const git = await gitFixture(t)
  const publicOrigin = 'http://127.0.0.1:39998'
  const identity = createIdentityService({ database, oidc: { ...provider.config, redirectUri: `${publicOrigin}/api/auth/callback` }, loginEncryptionKey: randomBytes(32) })
  await identity.bootstrapAdmin({ issuer: provider.issuer, subject: 'admin', displayName: 'Admin' })
  const submissions = createSubmissionService(database, identity, { allowedGitHosts: ['git.fixture.invalid'] })
  const store = await createLocalArtifactStore(join(git.root, 'tenancy-store'))
  const keys = generateKeyPairSync('ed25519')
  const deployments = createDeploymentService({ database, identity, centerId: 'tenancy-center' })
  const catalog = createCatalogService({ database, identity, deployments, store, centerId: 'tenancy-center', trustedSigningKeys: { 'tenancy-key': keys.publicKey } })
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
        if (value && value.csrfToken) csrf = value.csrfToken
        return value
      },
      async login(subject, invitationToken) {
        const start = await this.request('/api/auth/login', 'POST', invitationToken ? { invitationToken } : {})
        const callback = new URL(await provider.authorize(start.authorizationUrl, { subject }))
        return this.request(callback.pathname + callback.search)
      },
    }
  }
  const admin = browser(), owner = browser(), tenantAdmin = browser(), collaborator = browser(), reviewer = browser()
  await admin.login('admin')
  for (const organization of ['demo', 'other']) await admin.request('/api/organizations', 'POST', { id: organization, slug: organization, name: organization }, 201)
  async function invite(client, subject, organization, roles) {
    const invitation = await admin.request(`/api/organizations/${organization}/invitations`, 'POST', { roles }, 201)
    const principal = await client.login(subject, invitation.invitationToken)
    await admin.request(`/api/users/${principal.principal.userId}/developer`, 'POST', { developer: true })
    return principal
  }
  const ownerLogin = await invite(owner, 'owner', 'demo', ['member'])
  await invite(tenantAdmin, 'tenant-admin', 'demo', ['admin'])
  const collaboratorLogin = await invite(collaborator, 'collaborator', 'other', ['member'])
  const reviewerLogin = await invite(reviewer, 'reviewer-tenancy', 'other', ['reviewer'])
  await admin.request('/api/organizations/demo/review-scopes', 'POST', { reviewerId: reviewerLogin.principal.userId, granted: true })
  async function bind(organizationId) {
    const point = await admin.request('/api/v1/deployments', 'POST', { organizationId, name: `${organizationId} point` }, 201)
    const code = await admin.request(`/api/v1/deployments/${point.id}/binding-codes`, 'POST', {}, 201)
    return host('/api/v1/deployment-bindings/exchange', { body: { bindingCode: code.bindingCode } })
  }
  const pointDemo = await bind('demo'), pointOther = await bind('other')

  async function publishPack(packId, developerClient) {
    // Align the fixture repo identity with this submission's packId/version.
    const manifestPath = join(git.work, 'pack.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.pack.id = packId; manifest.pack.version = '1.0.0'
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    await git.git('add', '.'); await git.git('commit', '--quiet', '--allow-empty', '-m', `identity ${packId}`)
    await git.push()
    const draft = await developerClient.request('/api/submissions', 'POST', {
      organizationId: 'demo', packId, name: `Tenancy sample ${packId}`, version: '1.0.0',
      source: { url: git.input.url, ref: 'main' }, notes: 'Immutable sample', license: 'MIT', distribution: { kind: 'organization' },
    }, 201)
    await developerClient.request(`/api/submissions/${draft.id}/validate`, 'POST', { expectedVersion: draft.stateVersion }, 202)
    const validator = createValidationWorker({ database, store, fetchSnapshot: createGitSnapshotFetcher(git.infrastructure),
      allowedGitHosts: ['git.fixture.invalid'], scratchRoot: git.outputParent, validatorVersion: '0.1.0', workerId: `validator-${packId}` })
    const outcome = await validator.runOnce()
    if (outcome.status !== 'validated') {
      const attempts = (await database.query('SELECT error_code,error_message FROM validation_attempts WHERE submission_id=$1 ORDER BY attempt DESC LIMIT 1', [draft.id])).rows[0]
      const snap = (await database.query('SELECT report FROM submission_snapshots WHERE submission_id=$1 ORDER BY id DESC LIMIT 1', [draft.id])).rows[0]
      t.diagnostic(JSON.stringify({ outcome, attempts, report: snap ? JSON.stringify(snap.report).slice(0, 800) : null }))
    }
    assert.equal(outcome.status, 'validated')
    const beforeSubmit = await developerClient.request(`/api/submissions/${draft.id}`)
    const pending = await developerClient.request(`/api/submissions/${draft.id}/submit`, 'POST', { expectedVersion: beforeSubmit.submission.stateVersion })
    const full = await developerClient.request(`/api/submissions/${draft.id}`)
    assert.equal(pending.status, 'pending_review')
    const approval = await reviewer.request(`/api/submissions/${draft.id}/review`, 'POST', {
      expectedVersion: pending.stateVersion, contentTreeSha256: full.snapshot.contentTreeSha256, decision: 'approved', comment: 'ok',
    })
    assert.equal(approval.submission.status, 'approved')
    const publisher = createPublisher({ database, store, centerId: 'tenancy-center', signingKeyId: 'tenancy-key', signingPrivateKey: keys.privateKey, workerId: `publisher-${packId}`, scratchRoot: git.root })
    const published = await publisher.runOnce()
    assert.equal(published.status, 'published', JSON.stringify(published))
    return { draft, releaseId: approval.releaseId }
  }

  // Creation axis: tenant admin without pack ownership cannot WRITE the pack,
  // but full review authority makes the submission readable for review.
  const alpha = await publishPack('demo.alpha', owner)
  assert.equal((await tenantAdmin.request(`/api/submissions/${alpha.draft.id}`)).submission.packId, 'demo.alpha')
  const owners = await owner.request('/api/packs/demo.alpha/owners')
  assert.equal(owners.items.length, 1)
  assert.equal(owners.items[0].role, 'owner')

  // Only a pack owner may grant collaborators; the tenant admin may not.
  assert.equal((await tenantAdmin.request('/api/packs/demo.alpha/owners', 'POST', { userId: collaboratorLogin.principal.userId, role: 'maintainer' }, 403)).error.code, 'FORBIDDEN')
  await owner.request('/api/packs/demo.alpha/owners', 'POST', { userId: collaboratorLogin.principal.userId, role: 'maintainer' }, 201)
  assert.equal((await owner.request('/api/packs/demo.alpha/owners')).items.length, 2)

  // Cross-tenant maintainer revises the pack without any demo membership.
  assert.equal(collaboratorLogin.principal.memberships.some(member => member.organizationId === 'demo'), false)
  await collaborator.request('/api/submissions', 'POST', {
    organizationId: 'demo', packId: 'demo.alpha', name: 'Tenancy sample demo.alpha', version: '1.1.0',
    source: { url: git.input.url, ref: 'main' }, notes: 'Maintainer revision', license: 'MIT', distribution: { kind: 'organization' },
    previousSubmissionId: alpha.draft.id,
  }, 201)
  // A member of demo without pack ownership still cannot revise it.
  await tenantAdmin.request('/api/submissions', 'POST', {
    organizationId: 'demo', packId: 'demo.alpha', name: 'Tenancy sample demo.alpha', version: '1.2.0',
    source: { url: git.input.url, ref: 'main' }, distribution: { kind: 'organization' }, previousSubmissionId: alpha.draft.id,
  }, 403)
  // The last active owner cannot be removed.
  assert.equal((await owner.request(`/api/packs/demo.alpha/owners/${ownerLogin.principal.userId}`, 'DELETE', {}, 409)).error.code, 'LAST_OWNER_DENIED')

  // Distribution axis: without a grant the other tenant sees nothing.
  assert.deepEqual((await host('/api/v1/releases', { token: pointOther.credentialToken })).items, [])
  await host(`/api/v1/releases/${alpha.releaseId}`, { token: pointOther.credentialToken, expected: 404 })

  // An "all" grant makes every published pack visible to the tenant.
  await admin.request('/api/pack-visibility', 'POST', { organizationId: 'other', scope: 'all' }, 201)
  const granted = await host('/api/v1/releases', { token: pointOther.credentialToken })
  assert.equal(granted.items.length, 1)
  assert.equal(granted.items[0].releaseId, alpha.releaseId)
  assert.equal((await host(`/api/v1/releases/${alpha.releaseId}`, { token: pointOther.credentialToken })).releaseId, alpha.releaseId)
  assert.equal((await admin.request('/api/organizations/other/pack-visibility')).scope, 'all')
  // Tenant members can read their own grant; a demo developer may not.
  assert.equal((await collaborator.request('/api/organizations/other/pack-visibility')).scope, 'all')
  await collaborator.request('/api/organizations/demo/pack-visibility', 'GET', undefined, 403)

  // A second pack plus a "list" grant narrows visibility to the listed subset.
  const beta = await publishPack('demo.beta', owner)
  await admin.request('/api/pack-visibility', 'POST', { organizationId: 'other', scope: 'list', packIds: ['demo.alpha'] }, 201)
  const narrowed = await host('/api/v1/releases', { token: pointOther.credentialToken })
  assert.deepEqual(narrowed.items.map(item => item.releaseId), [alpha.releaseId])
  await host(`/api/v1/releases/${beta.releaseId}`, { token: pointOther.credentialToken, expected: 404 })
  // Disabling the grant closes everything again.
  await admin.request('/api/organizations/other/pack-visibility/disable', 'POST', {}, 200)
  assert.deepEqual((await host('/api/v1/releases', { token: pointOther.credentialToken })).items, [])
  const afterDisable = await admin.request('/api/organizations/other/pack-visibility')
  assert.equal(afterDisable, null)
  // The demo tenant keeps seeing its own organization-scoped releases throughout.
  assert.equal((await host('/api/v1/releases', { token: pointDemo.credentialToken })).items.length, 2)
  t.diagnostic(JSON.stringify({ creationAxis: 'pack_ownerships', distributionAxis: 'pack_visibilities', packs: ['demo.alpha', 'demo.beta'] }))
})
