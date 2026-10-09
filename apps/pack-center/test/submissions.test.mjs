import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createIdentityService } from '../dist/auth.js'
import { createSubmissionService } from '../dist/submissions.js'
import { canonicalJson, sha256 } from '../../../packages/pack-contract/index.mjs'
import { createDatabaseFixture } from './support/database-fixture.mjs'
import { createTestIssuer } from './support/identity-fixture.mjs'

let fixture, provider
before(async () => { fixture = await createDatabaseFixture('submissions'); provider = await createTestIssuer() })
after(async () => { await provider?.close(); await fixture?.close() })
const code = expected => error => { assert.equal(error.code, expected); return true }
const report = { schemaVersion: 1, validatorVersion: '0.1.0', packSchemaVersion: 2, valid: true, diagnostics: [], entityCounts: {}, permissions: { execScripts: [], internalOnly: false } }
const digest = sha256('business-transaction-snapshot')

async function setup(t) {
  const database = await fixture.database(t)
  const identity = createIdentityService({ database, oidc: provider.config, loginEncryptionKey: randomBytes(32) })
  await identity.bootstrapAdmin({ issuer: provider.issuer, subject: 'admin', displayName: 'Admin' })
  const admin = (await provider.login(identity)).principal
  for (const name of ['demo', 'elsewhere']) await identity.createOrganization(admin, { id: name, slug: name, name })
  async function invite(subject, organizationId, roles) {
    const token = await identity.createInvitation(admin, { organizationId, roles })
    const principal = (await provider.login(identity, subject, { invitationToken: token.invitationToken })).principal
    await identity.setDeveloper(admin, { userId: principal.userId, developer: true })
    return principal
  }
  const author = await invite('developer', 'demo', ['member'])
  const colleague = await invite('colleague', 'demo', ['member'])
  const outsider = await invite('outsider', 'elsewhere', ['member'])
  const reviewer = await invite('reviewer', 'elsewhere', ['reviewer'])
  const reviewer2 = await invite('reviewer2', 'elsewhere', ['reviewer'])
  for (const actor of [reviewer, reviewer2]) await identity.setReviewScope(admin, { organizationId: 'demo', reviewerId: actor.userId, granted: true })
  return { database, identity, service: createSubmissionService(database, identity, { allowedGitHosts: ['github.com'] }), admin, author, colleague, outsider, reviewer, reviewer2, invite }
}
function input(overrides = {}) {
  return { organizationId: 'demo', packId: 'demo.review', name: 'Sample', version: '1.0.0', source: { url: 'https://github.com/example/sample.git', ref: 'main' }, distribution: { kind: 'organization' }, ...overrides }
}

// These service tests deliberately seed a fixed validation result to isolate
// transaction/authorization rules. Actual Git/CAS validation has its own suite.
async function validated(context, overrides = {}, options = {}) {
  const draft = await context.service.create(context.author, input(overrides), randomUUID())
  const validation = await context.service.startValidation(context.author, draft.id, draft.stateVersion, randomUUID())
  const snapshotId = randomUUID()
  const value = options.report ?? report
  await context.database.transaction(async tx => {
    await tx.query(`INSERT INTO submission_snapshots(id,submission_id,source_commit,artifact_sha256,content_tree_sha256,report_sha256,artifact_key,report_key,
      validator_version,normalization_version,pack_schema_version,size_bytes,file_count,report,preview)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'0.1.0',1,2,2048,1,$9::jsonb,$10::jsonb)`,
    [snapshotId, draft.id, 'a'.repeat(40), sha256('artifact'), digest, options.reportHash ?? sha256(canonicalJson(value)), `sha256/${sha256('artifact')}`,
      `sha256/${sha256(canonicalJson(value))}`, canonicalJson(value), canonicalJson({ delivery: { requiresPlugin: { minVersion: '0.1.0' }, dependencyLock: [], builtinDependencies: [] } })])
    await tx.query("UPDATE submissions SET status='validated',snapshot_id=$2,state_version=state_version+1 WHERE id=$1", [draft.id, snapshotId])
  })
  return { ...(await context.service.get(context.author, draft.id)).submission, jobId: validation.jobId }
}
async function pending(context, overrides = {}) {
  const value = await validated(context, overrides)
  return context.service.submit(context.author, value.id, value.stateVersion, randomUUID())
}
function decision(submission, overrides = {}) {
  return { expectedVersion: submission.stateVersion, contentTreeSha256: digest, decision: 'approved', comment: 'Reviewed fixed snapshot', ...overrides }
}

test('create detaches input, enforces ownership, validates source and deduplicates retries', async t => {
  const c = await setup(t)
  const value = input()
  const promise = c.service.create(c.author, value, 'same-create')
  value.version = '9.0.0'; value.source.ref = 'changed-after-call'
  const created = await promise
  assert.equal(created.version, '1.0.0'); assert.equal(created.source.ref, 'main')
  assert.deepEqual(await c.service.create(c.author, input(), 'same-create'), created)
  await assert.rejects(c.service.create(c.author, input({ version: '1.0.1' }), 'same-create'), code('IDEMPOTENCY_CONFLICT'))
  await assert.rejects(c.service.create(c.colleague, input(), 'other-author'), code('FORBIDDEN'))
  await assert.rejects(c.service.create(c.outsider, input(), 'wrong-org'), code('FORBIDDEN'))
  await assert.rejects(c.service.create(c.author, input({ packId: 'elsewhere.review' }), 'namespace'), code('PACK_NAMESPACE'))
  const legacy = await c.service.create(c.author, input({ packId: 'macro-capital-analyst', version: '1.0.0' }), 'legacy-id')
  assert.equal(legacy.packId, 'macro-capital-analyst')
  for (const url of ['http://github.com/a/b', 'https://user:secret@github.com/a/b', 'https://github.com/a/b?q=x', 'https://127.0.0.1/a/b', 'https://github.com:444/a/b']) {
    await assert.rejects(c.service.create(c.author, input({ source: { url, ref: 'main' } }), randomUUID()), code('SOURCE_NOT_ALLOWED'))
  }
  await assert.rejects(c.service.create(c.author, input({ extra: true }), 'unknown-field'), code('INVALID_INPUT'))
  await assert.rejects(c.service.create(c.author, input({ distribution: { kind: 'selected', organizationIds: ['missing'], deploymentIds: [] } }), 'missing-target'), code('DISTRIBUTION_TARGET_INVALID'))
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM submissions')).rows[0].n, 2)
})

test('draft editing is versioned; validation atomically enqueues once and freezes reviewed fields', async t => {
  const c = await setup(t)
  const draft = await c.service.create(c.author, input(), 'create')
  const edit = { version: '1.1.0', source: { url: 'https://github.com/example/sample.git', ref: 'v1.1' }, distribution: { kind: 'organization' }, notes: 'Updated' }
  const updated = await c.service.updateDraft(c.author, draft.id, 1, edit, 'edit')
  assert.equal(updated.stateVersion, 2); assert.equal(updated.version, '1.1.0')
  assert.deepEqual(await c.service.updateDraft(c.author, draft.id, 1, edit, 'edit'), updated)
  await assert.rejects(c.service.updateDraft(c.author, draft.id, 1, edit, 'stale-edit'), code('VERSION_CONFLICT'))
  const results = await Promise.all(Array.from({ length: 8 }, () => c.service.startValidation(c.author, draft.id, 2, 'validate')))
  for (const item of results) assert.deepEqual(item, results[0])
  assert.equal(results[0].submission.status, 'validating')
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n, 1)
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM releases')).rows[0].n, 0)
  await assert.rejects(c.service.updateDraft(c.author, draft.id, 3, edit, 'late-edit'), code('INVALID_TRANSITION'))
  await assert.rejects(c.database.query("UPDATE submissions SET source_ref='mutable',state_version=state_version+1 WHERE id=$1", [draft.id]), code('23514'))
  await assert.rejects(c.database.query("UPDATE submissions SET requires_plugin='{\"minVersion\":\"9.0.0\"}',state_version=state_version+1 WHERE id=$1", [draft.id]), code('23514'))
})

test('private read/list isolation, cross-org scoped review queue and live revocation', async t => {
  const c = await setup(t)
  const submission = await pending(c)
  assert.equal((await c.service.get(c.author, submission.id)).submission.id, submission.id)
  assert.equal((await c.service.get(c.reviewer, submission.id)).snapshot.contentTreeSha256, digest)
  await assert.rejects(c.service.get(c.outsider, submission.id), code('NOT_FOUND'))
  await assert.rejects(c.service.get(c.colleague, submission.id), code('NOT_FOUND'))
  assert.equal((await c.service.list(c.colleague, 'demo')).items.length, 0)
  // Reviewers hold a demo review scope: they list pending items even without
  // any pack ownership or demo membership.
  assert.equal((await c.service.list(c.reviewer, 'demo')).items.length, 1)
  assert.equal((await c.service.listReviewQueue(c.reviewer, 'demo')).items[0].id, submission.id)
  await assert.rejects(c.service.listReviewQueue(c.outsider, 'demo'), code('FORBIDDEN'))
  await c.identity.setReviewScope(c.admin, { organizationId: 'demo', reviewerId: c.reviewer.userId, granted: false })
  await assert.rejects(c.service.get(c.reviewer, submission.id), code('NOT_FOUND'))
  await assert.rejects(c.service.review(c.reviewer, submission.id, decision(submission), 'review'), code('FORBIDDEN'))
  await c.identity.setMembership(c.admin, { organizationId: 'demo', userId: c.author.userId, roles: ['member'], status: 'disabled' })
  await assert.rejects(c.service.get(c.author, submission.id), code('INVITATION_REQUIRED'))
})

test('administrators may self-review their own submissions; ordinary reviewers still cannot', async t => {
  const c = await setup(t)
  const tenantAdmin = await c.invite("tenant-admin", "demo", ["admin"])
  // Tenant admin authors and self-reviews: allowed, and the queue shows it.
  const own = await pending({ ...c, author: tenantAdmin }, { packId: 'demo.self-admin' })
  const approval = await c.service.review(tenantAdmin, own.id, decision(own), 'self-admin')
  assert.equal(approval.submission.status, 'approved'); assert.ok(approval.releaseId)
  const second = await pending({ ...c, author: tenantAdmin }, { packId: 'demo.self-admin-2' })
  const queue = await c.service.listReviewQueue(tenantAdmin, 'demo')
  assert.equal(queue.items.some(item => item.id === second.id), true)
  // Platform administrator self-review path.
  const platformOwn = await pending({ ...c, author: c.admin }, { packId: 'demo.self-platform' })
  const platformApproval = await c.service.review(c.admin, platformOwn.id, decision(platformOwn), 'self-platform')
  assert.equal(platformApproval.submission.status, 'approved')
  // Ordinary developer authorship stays self-review-denied (covered in the
  // dedicated self-review test below via c.author + reviewer scope).
})

test('invalid or digest-mismatched reports cannot be submitted, even if database status says validated', async t => {
  const c = await setup(t)
  for (const [index, options] of [{ report: { ...report, valid: false, diagnostics: [{ severity: 'error', code: 'INVALID', message: 'invalid' }] } }, { reportHash: sha256('tampered') }].entries()) {
    const value = await validated(c, { version: `1.0.${index}` }, options)
    await assert.rejects(c.service.submit(c.author, value.id, value.stateVersion, `submit-${index}`), code('REPORT_INVALID'))
    assert.equal((await c.service.get(c.author, value.id)).submission.status, 'validated')
  }
})

test('self-review and machine/forged principals are rejected; stale version/digest never reserve releases', async t => {
  const c = await setup(t)
  const submission = await pending(c)
  await assert.rejects(c.service.review(c.author, submission.id, decision(submission), 'self'), code('SELF_REVIEW_DENIED'))
  await assert.rejects(c.service.review({ kind: 'deployment', deploymentId: 'machine' }, submission.id, decision(submission), 'machine'), code('HUMAN_REQUIRED'))
  await assert.rejects(c.service.review({ ...c.reviewer }, submission.id, decision(submission), 'fake'), code('UNAUTHENTICATED'))
  await assert.rejects(c.service.review(c.reviewer, submission.id, decision(submission, { expectedVersion: 1 }), 'stale'), code('VERSION_CONFLICT'))
  await assert.rejects(c.service.review(c.reviewer, submission.id, decision(submission, { contentTreeSha256: sha256('other') }), 'digest'), code('SNAPSHOT_CONFLICT'))
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM reviews')).rows[0].n, 0)
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM releases')).rows[0].n, 0)
})

test('concurrent reviewers produce exactly one decision/release/outbox; retry returns the same immutable target', async t => {
  const c = await setup(t)
  const submission = await pending(c)
  const results = await Promise.allSettled([c.service.review(c.reviewer, submission.id, decision(submission), 'review-one'), c.service.review(c.reviewer2, submission.id, decision(submission), 'review-two')])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'VERSION_CONFLICT')
  const winner = results[0].status === 'fulfilled' ? [c.reviewer, 'review-one', results[0].value] : [c.reviewer2, 'review-two', results[1].value]
  assert.deepEqual(await c.service.review(winner[0], submission.id, decision(submission), winner[1]), winner[2])
  assert.equal(winner[2].submission.status, 'approved')
  const release = (await c.database.query('SELECT * FROM releases')).rows[0]
  assert.equal(release.status, 'publishing'); assert.equal(release.signed_manifest, null); assert.equal(release.snapshot_id, submission.snapshotId)
  const jobs = (await c.database.query("SELECT * FROM jobs WHERE kind='publish_release'")).rows
  assert.equal(jobs.length, 1); assert.deepEqual(jobs[0].payload, { releaseId: release.id, snapshotId: submission.snapshotId })
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM reviews')).rows[0].n, 1)
})

test('two approved candidates for one version roll the losing review back; later version creates a fresh immutable revision', async t => {
  const c = await setup(t)
  const first = await pending(c)
  const second = await pending(c)
  const published = await c.service.review(c.reviewer, first.id, decision(first), 'approve-first')
  await assert.rejects(c.service.review(c.reviewer, second.id, decision(second), 'approve-second'), code('VERSION_EXISTS'))
  assert.equal((await c.service.get(c.author, second.id)).submission.status, 'pending_review')
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM reviews WHERE submission_id=$1', [second.id])).rows[0].n, 0)
  await assert.rejects(c.service.create(c.author, input(), 'reuse-version'), code('VERSION_EXISTS'))
  const next = await c.service.create(c.author, input({ version: '1.1.0', previousSubmissionId: first.id }), 'new-version')
  assert.equal(next.previousSubmissionId, first.id); assert.equal(next.snapshotId, null)
  assert.equal((await c.service.get(c.author, first.id)).submission.snapshotId, published.submission.snapshotId)
})

test('changes requested and withdrawal retain fixed snapshots and comments; rework is a separate submission', async t => {
  const c = await setup(t)
  const first = await pending(c)
  await c.service.review(c.reviewer, first.id, decision(first, { decision: 'changes_requested', comment: 'Add examples' }), 'changes')
  const history = await c.service.get(c.author, first.id)
  assert.equal(history.reviews[0].comment, 'Add examples'); assert.equal(history.submission.status, 'changes_requested')
  const second = await pending(c, { previousSubmissionId: first.id })
  const withdrawn = await c.service.withdraw(c.author, second.id, second.stateVersion, 'withdraw')
  assert.equal(withdrawn.status, 'withdrawn'); assert.notEqual(withdrawn.snapshotId, first.snapshotId)
  assert.equal((await c.service.listReviewQueue(c.reviewer, 'demo')).items.length, 0)
  await assert.rejects(c.service.review(c.reviewer, second.id, decision(withdrawn), 'late'), code('INVALID_TRANSITION'))
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM releases')).rows[0].n, 0)
})

test('publication failures are visible and only authorized reviewers/admins can retry the exact approved snapshot once', async t => {
  const c = await setup(t)
  const submission = await pending(c)
  const approval = await c.service.review(c.reviewer, submission.id, decision(submission), 'approve')
  await c.database.query("UPDATE releases SET status='publish_failed',state_version=state_version+1,error_code='STORAGE_FAILURE' WHERE id=$1", [approval.releaseId])
  const result = await c.service.get(c.author, submission.id)
  assert.equal(result.release.status, 'publish_failed'); assert.equal(result.release.errorCode, 'STORAGE_FAILURE')
  const version = result.release.stateVersion
  // The author is the pack owner: authorized to retry, still version-checked.
  await assert.rejects(c.service.retryPublication(c.author, submission.id, version - 1, 'author-stale-retry'), code('VERSION_CONFLICT'))
  await assert.rejects(c.service.retryPublication(c.outsider, submission.id, version, 'outsider-retry'), code('FORBIDDEN'))
  await assert.rejects(c.service.retryPublication(c.reviewer, submission.id, version - 1, 'stale-retry'), code('VERSION_CONFLICT'))
  const retries = await Promise.all(Array.from({ length: 4 }, () => c.service.retryPublication(c.reviewer, submission.id, version, 'retry')))
  for (const item of retries) assert.deepEqual(item, retries[0])
  assert.equal(retries[0].releaseId, approval.releaseId)
  const job = (await c.database.query('SELECT * FROM jobs WHERE id=$1', [retries[0].jobId])).rows[0]
  assert.deepEqual(job.payload, { releaseId: approval.releaseId, snapshotId: submission.snapshotId })
  const current = await c.service.get(c.author, submission.id)
  assert.equal(current.release.status, 'publishing'); assert.equal(current.submission.snapshotId, submission.snapshotId)
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM reviews')).rows[0].n, 1)
})
