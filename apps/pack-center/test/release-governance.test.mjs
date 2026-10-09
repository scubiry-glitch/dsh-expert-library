import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { createIdentityService } from '../dist/auth.js'
import { createReleaseGovernance } from '../dist/release-governance.js'
import { canonicalJson, sha256, signReleaseManifest, verifyReleaseManifest } from '../../../packages/pack-contract/index.mjs'
import { createDatabaseFixture } from './support/database-fixture.mjs'
import { createTestIssuer } from './support/identity-fixture.mjs'

let fixture, provider
before(async () => { fixture = await createDatabaseFixture('governance'); provider = await createTestIssuer() })
after(async () => { await provider?.close(); await fixture?.close() })
const code = expected => error => { assert.equal(error.code, expected); return true }

async function setup(t) {
  const database = await fixture.database(t)
  const identity = createIdentityService({ database, oidc: provider.config, loginEncryptionKey: randomBytes(32) })
  await identity.bootstrapAdmin({ issuer: provider.issuer, subject: 'admin', displayName: 'Admin' })
  const admin = (await provider.login(identity)).principal
  for (const name of ['demo', 'elsewhere']) await identity.createOrganization(admin, { id: name, slug: name, name })
  async function invite(subject, organizationId, roles) {
    const token = await identity.createInvitation(admin, { organizationId, roles })
    return (await provider.login(identity, subject, { invitationToken: token.invitationToken })).principal
  }
  const owner = await invite('owner', 'demo', ['admin', 'reviewer'])
  const developer = await invite('developer', 'demo', ['member'])
  const outsider = await invite('outsider', 'elsewhere', ['admin'])
  const reviewer = await invite('reviewer', 'elsewhere', ['reviewer'])
  const reviewer2 = await invite('reviewer2', 'elsewhere', ['reviewer'])
  for (const actor of [owner, reviewer, reviewer2]) await identity.setReviewScope(admin, { organizationId: 'demo', reviewerId: actor.userId, granted: true })
  await database.query(`INSERT INTO deployments(id,organization_id,name,created_by) VALUES
    ('demo-deployment','demo','Demo deployment',$1),('elsewhere-deployment','elsewhere','Elsewhere deployment',$2)`, [owner.userId, outsider.userId])
  const keys = generateKeyPairSync('ed25519')
  const c = { database, identity, admin, owner, developer, outsider, reviewer, reviewer2, keys,
    service: createReleaseGovernance({ database, identity }) }
  const release = await seedRelease(c)
  return { ...c, release }
}

// Signed fixed-content fixture only: Git/archive/publisher tests independently
// prove the production path. All service authorization uses real OIDC sessions.
async function seedRelease(c, options = {}) {
  const id = options.id ?? 'release-one', packId = options.packId ?? 'demo.review'
  const scope = options.scope ?? { kind: 'organization' }, dependencyLock = options.dependencies ?? []
  const submissionId = `s-${id}`, snapshotId = `ss-${id}`, reviewId = `rv-${id}`
  const report = { schemaVersion: 1, validatorVersion: '0.1.0', packSchemaVersion: 2, valid: true, diagnostics: [], entityCounts: {} }
  const artifact = sha256(`${id}:artifact`), tree = sha256(`${id}:tree`), reportHash = sha256(canonicalJson(report))
  const delivery = { requiresPlugin: { minVersion: '0.1.0' }, dependencyLock, builtinDependencies: [] }
  await c.database.query("INSERT INTO packages(pack_id,owner_org_id,created_by,name) VALUES ($1,'demo',$2,'Fixture')", [packId, c.developer.userId])
  await c.database.query(`INSERT INTO submissions(id,owner_org_id,pack_id,author_id,version,source_url,source_ref,distribution,dependency_release_ids)
    VALUES ($1,'demo',$2,$3,'1.0.0','https://unreachable.invalid/fixture.git','main',$4::jsonb,$5)`,
  [submissionId, packId, c.developer.userId, canonicalJson(scope), dependencyLock.map(row => row.releaseId)])
  await c.database.query("UPDATE submissions SET status='validating',state_version=2 WHERE id=$1", [submissionId])
  await c.database.query(`INSERT INTO submission_snapshots(id,submission_id,source_commit,artifact_sha256,content_tree_sha256,report_sha256,
    artifact_key,report_key,validator_version,normalization_version,pack_schema_version,size_bytes,file_count,report,preview)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'0.1.0',1,2,2048,1,$9::jsonb,$10::jsonb)`,
  [snapshotId, submissionId, 'a'.repeat(40), artifact, tree, reportHash, `sha256/${artifact}`, `sha256/${reportHash}`, canonicalJson(report), canonicalJson({ delivery })])
  await c.database.query("UPDATE submissions SET status='validated',snapshot_id=$2,state_version=3 WHERE id=$1", [submissionId, snapshotId])
  await c.database.query("UPDATE submissions SET status='pending_review',state_version=4 WHERE id=$1", [submissionId])
  await c.database.query(`INSERT INTO reviews(id,submission_id,snapshot_id,reviewer_id,decision,expected_state_version,content_tree_sha256,comment)
    VALUES ($1,$2,$3,$4,'approved',4,$5,'Fixture approved fixed content')`, [reviewId, submissionId, snapshotId, c.reviewer.userId, tree])
  await c.database.query("UPDATE submissions SET status='approved',state_version=5 WHERE id=$1", [submissionId])
  await c.database.query(`INSERT INTO releases(id,pack_id,owner_org_id,version,approved_submission_id,snapshot_id)
    VALUES ($1,$2,'demo','1.0.0',$3,$4)`, [id, packId, submissionId, snapshotId])
  if (['publishing', 'publish_failed'].includes(options.status)) {
    if (options.status === 'publish_failed') await c.database.query("UPDATE releases SET status='publish_failed',state_version=2 WHERE id=$1", [id])
    await c.database.query('INSERT INTO release_distribution(release_id,scope) VALUES ($1,$2::jsonb)', [id, canonicalJson(scope)])
    return { id }
  }
  const manifest = { schemaVersion: 1, protocolVersion: 1, normalizationVersion: 1, digestAlgorithmVersion: 1,
    signatureAlgorithm: 'Ed25519', archiveFormat: 'tar', centerId: 'center-test', releaseId: id, packId, ownerOrgId: 'demo',
    version: '1.0.0', sourceCommit: 'a'.repeat(40), artifactSha256: artifact, contentTreeSha256: tree, reportSha256: reportHash,
    validatorVersion: '0.1.0', packSchemaVersion: 2, ...delivery, sizeBytes: 2048, fileCount: 1,
    approvedSubmissionId: submissionId, signingKeyId: 'test-key' }
  const signed = signReleaseManifest(manifest, c.keys.privateKey)
  await c.database.query(`UPDATE releases SET signed_manifest=$2::jsonb,status='published',published_at=clock_timestamp(),state_version=2 WHERE id=$1`, [id, canonicalJson(signed)])
  await c.database.query('INSERT INTO release_distribution(release_id,scope) VALUES ($1,$2::jsonb)', [id, canonicalJson(scope)])
  return { id, manifest, signed, lock: { packId, ownerOrgId: 'demo', releaseId: id, version: '1.0.0', artifactSha256: artifact, contentTreeSha256: tree } }
}
const proposal = (scope = { kind: 'authenticated' }, expectedVersion = 1) => ({ expectedVersion, scope, reason: 'Distribution recipients reviewed separately' })
const decision = (decision = 'approved') => ({ expectedVersion: 1, decision, comment: 'Reviewed current fixed dependency graph and recipients' })
async function current(c, releaseId = 'release-one') { return c.service.get(c.owner, releaseId) }
async function propose(c, releaseId = 'release-one', scope = { kind: 'authenticated' }, expectedVersion = 1) {
  return c.service.requestDistribution(c.owner, releaseId, proposal(scope, expectedVersion), randomUUID())
}

test('organization management lists every release state with stable pagination, independently of download scope', async t => {
  const c = await setup(t)
  await seedRelease(c, { id: 'release-two', packId: 'demo.selected', scope: { kind: 'selected', organizationIds: ['elsewhere'], deploymentIds: [] } })
  await seedRelease(c, { id: 'release-three', packId: 'demo.publishing', status: 'publishing' })
  await seedRelease(c, { id: 'release-four', packId: 'demo.failed', status: 'publish_failed' })
  await c.service.yank(c.owner, c.release.id, { expectedVersion: 2, reason: 'Keep the management record after withdrawal' }, 'yank-list')
  for (const actor of [c.owner, c.admin, c.reviewer]) {
    const all = await c.service.listOrganization(actor, 'demo')
    assert.deepEqual(all.items.map(item => item.id), ['release-two', 'release-three', 'release-one', 'release-four'])
    assert.deepEqual(new Set(all.items.map(item => item.status)), new Set(['published', 'publishing', 'yanked', 'publish_failed']))
    assert.equal(all.nextCursor, null)
    assert.deepEqual(all.items[0].distribution.scope, { kind: 'selected', organizationIds: ['elsewhere'], deploymentIds: [] })
    assert.ok(all.items.every(item => item.ownerOrgId === 'demo' && !('signedManifest' in item) && !('artifactKey' in item)))
    const first = await c.service.listOrganization(actor, 'demo', { limit: 2 })
    const second = await c.service.listOrganization(actor, 'demo', { limit: 2, beforeId: first.nextCursor })
    assert.deepEqual([...first.items, ...second.items], all.items)
    assert.deepEqual((await c.service.listOrganization(actor, 'demo', { beforeId: second.nextCursor })).items, [])
  }
  assert.deepEqual((await c.service.listOrganization(c.outsider, 'elsewhere')).items, [])
})

test('organization release management checks live human privileges even for empty pages and rejects unsafe pagination', async t => {
  const c = await setup(t)
  for (const actor of [c.developer, c.outsider]) {
    await assert.rejects(c.service.listOrganization(actor, 'demo'), code('FORBIDDEN'))
    await assert.rejects(c.service.listOrganization(actor, 'demo', { beforeId: 'a' }), code('FORBIDDEN'))
  }
  await assert.rejects(c.service.listOrganization({ kind: 'deployment' }, 'demo'), code('HUMAN_REQUIRED'))
  await assert.rejects(c.service.listOrganization({ ...c.owner }, 'demo'), code('UNAUTHENTICATED'))
  for (const input of [{ limit: 0 }, { limit: 101 }, { beforeId: '../secret' }, { status: 'published' }]) {
    await assert.rejects(c.service.listOrganization(c.owner, 'demo', input), code('INVALID_INPUT'))
  }
  await assert.rejects(c.service.listOrganization(c.owner, 'demo', { limit: 1.5 }), code('INVALID_CONTRACT'))
  await c.identity.setReviewScope(c.admin, { organizationId: 'demo', reviewerId: c.reviewer.userId, granted: false })
  await assert.rejects(c.service.listOrganization(c.reviewer, 'demo'), code('FORBIDDEN'))
  await c.identity.setMembership(c.admin, { organizationId: 'demo', userId: c.owner.userId, roles: ['member'], status: 'active' })
  await assert.rejects(c.service.listOrganization(c.owner, 'demo'), code('FORBIDDEN'))
})

test('distribution requests do not publish scopes; independent approval changes only scope metadata', async t => {
  const c = await setup(t), before = await current(c), initial = canonicalJson(c.release.signed)
  const request = await propose(c)
  assert.equal(request.status, 'pending_review'); assert.equal(request.stateVersion, 1); assert.equal(request.expectedDistributionVersion, 1)
  assert.deepEqual((await current(c)).distribution, { scope: { kind: 'organization' }, stateVersion: 1 })
  const approved = await c.service.reviewDistribution(c.reviewer, request.id, decision(), 'approve')
  assert.equal(approved.request.status, 'approved'); assert.equal(approved.request.stateVersion, 2)
  assert.deepEqual(approved.distribution, { scope: { kind: 'authenticated' }, stateVersion: 2 })
  const row = (await c.database.query('SELECT * FROM releases WHERE id=$1', [c.release.id])).rows[0]
  assert.equal(row.state_version, before.stateVersion); assert.equal(canonicalJson(row.signed_manifest), initial)
  assert.deepEqual(verifyReleaseManifest(row.signed_manifest, { 'test-key': c.keys.publicKey }), c.release.manifest)
  assert.equal((await c.database.query("SELECT count(*)::int AS n FROM audit_events WHERE action IN ('distribution.requested','distribution.approved')")).rows[0].n, 2)
  const narrowing = await propose(c, c.release.id, { kind: 'organization' }, 2)
  assert.equal((await current(c)).distribution.scope.kind, 'authenticated')
  await c.service.reviewDistribution(c.reviewer2, narrowing.id, decision(), 'approve-narrowing')
  assert.deepEqual((await current(c)).distribution, { scope: { kind: 'organization' }, stateVersion: 3 })
})

test('org-admin request, assigned independent reviewer, live authorization and human-only enforcement', async t => {
  const c = await setup(t)
  for (const actor of [c.developer, c.outsider, c.reviewer]) await assert.rejects(c.service.requestDistribution(actor, c.release.id, proposal(), randomUUID()), code('FORBIDDEN'))
  for (const actor of [{ kind: 'deployment' }, { ...c.owner }]) await assert.rejects(c.service.requestDistribution(actor, c.release.id, proposal(), randomUUID()), code(actor.kind === 'deployment' ? 'HUMAN_REQUIRED' : 'UNAUTHENTICATED'))
  const request = await propose(c)
  // Tenant-admin requesters may self-approve (policy parity with submission
  // self-review); the decision is immutable and fully audited.
  const selfApproval = await c.service.reviewDistribution(c.owner, request.id, decision(), 'self-admin')
  assert.equal(selfApproval.request.status, 'approved')
  assert.equal(selfApproval.distribution.scope.kind, 'authenticated')
  // A fresh request is required after a decision. Only the owner/admin can
  // request (line above proves reviewers cannot), so reviewer approval is
  // always independent. Requests must pin the advanced distribution version.
  const distributionVersion = (await current(c)).distribution.stateVersion
  const second = await propose(c, 'release-one', { kind: 'organization' }, distributionVersion)
  const approved = await c.service.reviewDistribution(c.reviewer, second.id, decision(), 'independent')
  assert.equal(approved.request.status, 'approved')
  const nextVersion = (await current(c)).distribution.stateVersion
  const third = await propose(c, 'release-one', { kind: 'authenticated' }, nextVersion)
  await assert.rejects(c.service.reviewDistribution(c.outsider, third.id, decision(), 'wrong-scope'), code('FORBIDDEN'))
  await c.identity.setReviewScope(c.admin, { organizationId: 'demo', reviewerId: c.reviewer.userId, granted: false })
  const fourth = await propose(c, 'release-one', { kind: 'authenticated' }, (await current(c)).distribution.stateVersion)
  await assert.rejects(c.service.reviewDistribution(c.reviewer, fourth.id, decision(), 'revoked-scope'), code('FORBIDDEN'))
  assert.equal((await current(c)).distribution.stateVersion > 1, true)
})

test('idempotent retries return committed results only after current authorization; conflicting payload fails', async t => {
  const c = await setup(t), input = proposal()
  const request = await c.service.requestDistribution(c.owner, c.release.id, input, 'request-key')
  assert.deepEqual(await c.service.requestDistribution(c.owner, c.release.id, input, 'request-key'), request)
  await assert.rejects(c.service.requestDistribution({ ...c.owner }, c.release.id, input, 'request-key'), code('UNAUTHENTICATED'))
  await assert.rejects(c.service.requestDistribution(c.owner, c.release.id, { ...input, reason: 'Other reason' }, 'request-key'), code('IDEMPOTENCY_CONFLICT'))
  const result = await c.service.reviewDistribution(c.reviewer, request.id, decision(), 'review-key')
  assert.deepEqual(await c.service.reviewDistribution(c.reviewer, request.id, decision(), 'review-key'), result)
  await c.identity.setReviewScope(c.admin, { organizationId: 'demo', reviewerId: c.reviewer.userId, granted: false })
  await assert.rejects(c.service.reviewDistribution(c.reviewer, request.id, decision(), 'review-key'), code('FORBIDDEN'))
  await c.identity.setMembership(c.admin, { organizationId: 'demo', userId: c.owner.userId, roles: ['member'], status: 'active' })
  await assert.rejects(c.service.requestDistribution(c.owner, c.release.id, input, 'request-key'), code('FORBIDDEN'))
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM distribution_reviews')).rows[0].n, 1)
})

test('concurrent duplicate requests and decisions commit once; stale competing approvals do not broaden scope', async t => {
  const c = await setup(t)
  const requests = await Promise.all(Array.from({ length: 5 }, () => c.service.requestDistribution(c.owner, c.release.id, proposal(), 'same-request')))
  for (const row of requests) assert.deepEqual(row, requests[0])
  const second = await propose(c, c.release.id, { kind: 'selected', organizationIds: ['demo', 'elsewhere'], deploymentIds: [] })
  const results = await Promise.allSettled([
    c.service.reviewDistribution(c.reviewer, requests[0].id, decision(), 'first-review'),
    c.service.reviewDistribution(c.reviewer2, second.id, decision(), 'second-review'),
  ])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'VERSION_CONFLICT')
  assert.equal((await current(c)).distribution.stateVersion, 2)
  const pending = (await c.service.listReviewQueue(c.reviewer, 'demo')).items[0]
  const rejected = await c.service.reviewDistribution(c.reviewer, pending.id, decision('rejected'), 'reject-stale')
  assert.equal(rejected.request.status, 'rejected'); assert.equal(rejected.distribution.stateVersion, 2)
})

test('concurrent same-request decisions produce one immutable terminal review', async t => {
  const c = await setup(t), request = await propose(c)
  const results = await Promise.allSettled([
    c.service.reviewDistribution(c.reviewer, request.id, decision(), 'approve'),
    c.service.reviewDistribution(c.reviewer2, request.id, decision('rejected'), 'reject'),
  ])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'VERSION_CONFLICT')
  const row = await c.service.getRequest(c.owner, request.id)
  await assert.rejects(c.database.query("UPDATE distribution_reviews SET status='pending_review',state_version=state_version+1 WHERE id=$1", [row.id]), code('23514'))
  await assert.rejects(c.database.query('DELETE FROM distribution_reviews WHERE id=$1', [row.id]), code('23514'))
  assert.equal((await c.database.query("SELECT count(*)::int AS n FROM audit_events WHERE action IN ('distribution.approved','distribution.rejected')")).rows[0].n, 1)
})

test('operation-key lock precedes release rows, so reused keys cannot deadlock fixed dependency traversal', async t => {
  const c = await setup(t)
  const dependency = await seedRelease(c, { id: 'lock-dependency', packId: 'demo.lock-dependency', scope: { kind: 'authenticated' } })
  const dependent = await seedRelease(c, { id: 'lock-dependent', packId: 'demo.lock-dependent', dependencies: [dependency.lock] })
  const firstLocked = Promise.withResolvers(), secondAttempted = Promise.withResolvers(), continueFirst = Promise.withResolvers()
  let attempts = 0
  // Only schedule real PostgreSQL calls; neither locks nor authorization are
  // mocked. Pause the first transaction while it holds the advisory operation
  // lock, and inspect the actual dependency row while its competitor waits.
  const database = { ...c.database, transaction(fn) {
    return c.database.transaction(tx => fn(new Proxy(tx, { get(target, property) {
      if (property !== 'query') return Reflect.get(target, property)
      return async (sql, values) => {
        const operationLock = typeof sql === 'string' && sql.includes('pg_advisory_xact_lock') && values?.[1] === 'shared-lock-key'
        const attempt = operationLock ? ++attempts : 0
        if (attempt === 2) secondAttempted.resolve()
        const result = await target.query(sql, values)
        if (attempt === 1) { firstLocked.resolve(); await continueFirst.promise }
        return result
      }
    } })))
  } }
  const service = createReleaseGovernance({ database, identity: c.identity })
  const first = service.requestDistribution(c.owner, dependent.id, proposal(), 'shared-lock-key')
  const firstResult = first.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))
  await firstLocked.promise
  const second = service.requestDistribution(c.owner, dependency.id, proposal({ kind: 'organization' }), 'shared-lock-key')
  const secondResult = second.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))
  await secondAttempted.promise
  let probeError
  try {
    // Under the old release->operation ordering, the second request holds this
    // row and NOWAIT reports 55P03. It then deadlocks against the first request's
    // dependency traversal when that transaction resumes.
    await c.database.transaction(tx => tx.query('SELECT id FROM releases WHERE id=$1 FOR UPDATE NOWAIT', [dependency.id]))
  } catch (error) { probeError = error }
  finally { continueFirst.resolve() }
  const results = await Promise.all([firstResult, secondResult])
  assert.equal(probeError, undefined, 'waiting for an operation key must not retain any release row lock')
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected'); assert.equal(results[1].reason.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM distribution_reviews')).rows[0].n, 1)
})

test('rejected requests preserve scope and cannot be edited or subsequently approved', async t => {
  const c = await setup(t), request = await propose(c)
  const result = await c.service.reviewDistribution(c.reviewer, request.id, decision('rejected'), 'reject')
  assert.equal(result.request.status, 'rejected'); assert.equal(result.request.stateVersion, 2)
  assert.deepEqual(result.distribution, { scope: { kind: 'organization' }, stateVersion: 1 })
  await assert.rejects(c.service.reviewDistribution(c.reviewer2, request.id, { ...decision(), expectedVersion: 2 }, 'late-approve'), code('INVALID_TRANSITION'))
  for (const query of ["UPDATE distribution_reviews SET requested_scope='{\"kind\":\"organization\"}',state_version=state_version+1 WHERE id=$1",
    "UPDATE distribution_reviews SET reason='rewritten',state_version=state_version+1 WHERE id=$1"]) await assert.rejects(c.database.query(query, [request.id]), code('23514'))
})

test('selected recipient existence and active status checked both on request and approval', async t => {
  const c = await setup(t)
  for (const scope of [{ kind: 'selected', organizationIds: ['missing'], deploymentIds: [] }, { kind: 'selected', organizationIds: [], deploymentIds: ['missing'] }]) {
    await assert.rejects(propose(c, c.release.id, scope), code('DISTRIBUTION_TARGET_INVALID'))
  }
  const org = await propose(c, c.release.id, { kind: 'selected', organizationIds: ['elsewhere'], deploymentIds: [] })
  const deployment = await propose(c, c.release.id, { kind: 'selected', organizationIds: [], deploymentIds: ['demo-deployment'] })
  await c.database.query("UPDATE deployments SET status='disabled',state_version=state_version+1 WHERE id='demo-deployment'")
  await assert.rejects(c.service.reviewDistribution(c.reviewer, deployment.id, decision(), 'disabled-deployment'), code('DISTRIBUTION_TARGET_INVALID'))
  // Keep reviewer membership active in demo while the selected target is disabled.
  const invitation = await c.identity.createInvitation(c.admin, { organizationId: 'demo', roles: ['reviewer'] })
  await provider.login(c.identity, 'reviewer', { invitationToken: invitation.invitationToken })
  await c.identity.setOrganizationStatus(c.admin, { organizationId: 'elsewhere', status: 'disabled' })
  await assert.rejects(c.service.reviewDistribution(c.reviewer, org.id, decision(), 'disabled-org'), code('DISTRIBUTION_TARGET_INVALID'))
  assert.equal((await current(c)).distribution.stateVersion, 1)
})

test('fixed direct and transitive dependency scopes prevent broadening beyond authorized recipients', async t => {
  const c = await setup(t)
  const leaf = await seedRelease(c, { id: 'leaf', packId: 'demo.leaf' })
  const middle = await seedRelease(c, { id: 'middle', packId: 'demo.middle', dependencies: [leaf.lock] })
  const top = await seedRelease(c, { id: 'top', packId: 'demo.top', dependencies: [middle.lock] })
  for (const release of [middle, top]) await assert.rejects(propose(c, release.id), code('DEPENDENCY_FORBIDDEN'))
  await assert.rejects(propose(c, top.id, { kind: 'selected', organizationIds: [], deploymentIds: ['elsewhere-deployment'] }), code('DEPENDENCY_FORBIDDEN'))
  const selected = await propose(c, top.id, { kind: 'selected', organizationIds: [], deploymentIds: ['demo-deployment'] })
  const result = await c.service.reviewDistribution(c.reviewer, selected.id, decision(), 'approve-selected')
  assert.deepEqual(result.distribution.scope, { kind: 'selected', organizationIds: [], deploymentIds: ['demo-deployment'] })
})

test('approval rechecks the current locked dependency graph, not request-time scopes or floating versions', async t => {
  const c = await setup(t)
  const leaf = await seedRelease(c, { id: 'leaf', packId: 'demo.leaf', scope: { kind: 'authenticated' } })
  const middle = await seedRelease(c, { id: 'middle', packId: 'demo.middle', dependencies: [leaf.lock], scope: { kind: 'authenticated' } })
  const top = await seedRelease(c, { id: 'top', packId: 'demo.top', dependencies: [middle.lock] })
  const pending = await propose(c, top.id)
  const narrow = await propose(c, leaf.id, { kind: 'organization' })
  await c.service.reviewDistribution(c.reviewer, narrow.id, decision(), 'narrow-leaf')
  await assert.rejects(c.service.reviewDistribution(c.reviewer2, pending.id, decision(), 'no-longer-available'), code('DEPENDENCY_FORBIDDEN'))
  assert.equal((await c.service.getRequest(c.owner, pending.id)).status, 'pending_review')
  assert.equal((await current(c, top.id)).distribution.stateVersion, 1)
  assert.deepEqual((await c.database.query('SELECT signed_manifest FROM releases WHERE id=$1', [top.id])).rows[0].signed_manifest, top.signed)
})

test('yanked fixed dependency prevents a previously valid scope approval', async t => {
  const c = await setup(t)
  const dependency = await seedRelease(c, { id: 'dependency', packId: 'demo.dependency', scope: { kind: 'authenticated' } })
  const dependent = await seedRelease(c, { id: 'dependent', packId: 'demo.dependent', dependencies: [dependency.lock] })
  const request = await propose(c, dependent.id)
  await c.service.yank(c.owner, dependency.id, { expectedVersion: 2, reason: 'Dependency withdrawn' }, 'yank-dependency')
  await assert.rejects(c.service.reviewDistribution(c.reviewer, request.id, decision(), 'approve-dependency-yanked'), code('DEPENDENCY_UNAVAILABLE'))
})

test('yank is owner-admin/platform-admin only, versioned, irreversible and retains fixed signed content', async t => {
  const c = await setup(t)
  const input = { expectedVersion: 2, reason: 'Release no longer supported' }
  for (const actor of [c.developer, c.outsider, c.reviewer]) await assert.rejects(c.service.yank(actor, c.release.id, input, randomUUID()), code('FORBIDDEN'))
  await assert.rejects(c.service.yank(c.owner, c.release.id, { ...input, expectedVersion: 1 }, 'stale'), code('VERSION_CONFLICT'))
  const results = await Promise.all(Array.from({ length: 5 }, () => c.service.yank(c.owner, c.release.id, input, 'yank')))
  for (const result of results) assert.deepEqual(result, results[0])
  assert.equal(results[0].status, 'yanked'); assert.equal(results[0].stateVersion, 3); assert.ok(results[0].yankedAt)
  await assert.rejects(c.service.yank(c.admin, c.release.id, { ...input, expectedVersion: 3 }, 'again'), code('INVALID_TRANSITION'))
  await assert.rejects(c.database.query("UPDATE releases SET status='published',state_version=state_version+1 WHERE id=$1", [c.release.id]), code('23514'))
  await assert.rejects(c.database.query('DELETE FROM releases WHERE id=$1', [c.release.id]), code('23514'))
  const row = (await c.database.query('SELECT signed_manifest,snapshot_id FROM releases WHERE id=$1', [c.release.id])).rows[0]
  assert.deepEqual(row.signed_manifest, c.release.signed); assert.equal(row.snapshot_id, 'ss-release-one')
  assert.equal((await c.database.query("SELECT count(*)::int AS n FROM audit_events WHERE action='release.yanked'")).rows[0].n, 1)
  const other = await seedRelease(c, { id: 'other', packId: 'demo.other' })
  assert.equal((await c.service.yank(c.admin, other.id, input, 'platform-yank')).status, 'yanked')
})

test('yank blocks new scope changes/approvals but permits explicit rejection of an obsolete request', async t => {
  const c = await setup(t), request = await propose(c)
  await c.service.yank(c.owner, c.release.id, { expectedVersion: 2, reason: 'Withdrawn' }, 'yank')
  await assert.rejects(propose(c), code('INVALID_TRANSITION'))
  await assert.rejects(c.service.reviewDistribution(c.reviewer, request.id, decision(), 'approve-yanked'), code('INVALID_TRANSITION'))
  assert.equal((await c.service.reviewDistribution(c.reviewer, request.id, decision('rejected'), 'reject-yanked')).request.status, 'rejected')
})

test('management reads and review queue expose no credentials and enforce current org/scope isolation', async t => {
  const c = await setup(t), request = await propose(c)
  assert.equal((await current(c)).id, c.release.id)
  assert.equal((await c.service.get(c.reviewer, c.release.id)).id, c.release.id)
  assert.equal((await c.service.getRequest(c.owner, request.id)).id, request.id)
  for (const actor of [c.outsider, c.developer]) {
    await assert.rejects(c.service.get(actor, c.release.id), code('NOT_FOUND'))
    await assert.rejects(c.service.getRequest(actor, request.id), code('NOT_FOUND'))
    await assert.rejects(c.service.listReleaseRequests(actor, c.release.id), code('NOT_FOUND'))
    await assert.rejects(c.service.listReviewQueue(actor, 'demo'), code('FORBIDDEN'))
  }
  const page = await c.service.listReleaseRequests(c.owner, c.release.id, { limit: 1 })
  assert.equal(page.items[0].id, request.id); assert.equal(page.nextCursor, request.id)
  assert.deepEqual(await c.service.listReleaseRequests(c.owner, c.release.id, { beforeId: page.nextCursor }), { items: [], nextCursor: null })
  assert.equal((await c.service.listReviewQueue(c.reviewer, 'demo')).items[0].id, request.id)
  const visible = canonicalJson([await current(c), page])
  for (const name of ['sessionToken', 'csrfToken', 'invitationToken', 'signed_manifest', 'signingPrivateKey', 'artifact_key']) assert.equal(visible.includes(name), false)
  await c.identity.setReviewScope(c.admin, { organizationId: 'demo', reviewerId: c.reviewer.userId, granted: false })
  await assert.rejects(c.service.get(c.reviewer, c.release.id), code('NOT_FOUND'))
  await assert.rejects(c.service.listReviewQueue(c.reviewer, 'demo'), code('FORBIDDEN'))
})

test('inputs are strict and detached before awaits; invalid proposals leave no state', async t => {
  const c = await setup(t)
  const input = proposal({ kind: 'selected', organizationIds: ['demo'], deploymentIds: [] })
  const pending = c.service.requestDistribution(c.owner, c.release.id, input, 'capture')
  input.scope.organizationIds.push('elsewhere'); input.reason = 'changed after invocation'; input.expectedVersion = 100
  const request = await pending
  assert.deepEqual(request.requestedScope, { kind: 'selected', organizationIds: ['demo'], deploymentIds: [] })
  assert.equal(request.reason, 'Distribution recipients reviewed separately')
  for (const invalid of [{ ...proposal(), extra: true }, { ...proposal(), reason: '  ' }, { ...proposal(), expectedVersion: 0 }]) {
    await assert.rejects(c.service.requestDistribution(c.owner, c.release.id, invalid, randomUUID()), code('INVALID_INPUT'))
  }
  await assert.rejects(c.service.requestDistribution(c.owner, c.release.id, proposal({ kind: 'organization' }), 'unchanged'), code('DISTRIBUTION_UNCHANGED'))
  await assert.rejects(c.service.reviewDistribution(c.reviewer, request.id, { ...decision(), comment: '' }, 'empty-comment'), code('INVALID_INPUT'))
  await assert.rejects(c.service.yank(c.owner, c.release.id, { expectedVersion: 2, reason: 'x', unexpected: true }, 'unexpected'), code('INVALID_INPUT'))
  await assert.rejects(c.service.listReviewQueue(c.reviewer, 'demo', { status: 'other' }), code('INVALID_INPUT'))
  await assert.rejects(c.service.listReleaseRequests(c.owner, c.release.id, { limit: 101 }), code('INVALID_INPUT'))
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM distribution_reviews')).rows[0].n, 1)
})
