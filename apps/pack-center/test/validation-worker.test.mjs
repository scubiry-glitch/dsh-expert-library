import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, generateKeyPairSync } from 'node:crypto'
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createValidationWorker } from '../dist/validation-worker.js'
import { createLocalArtifactStore } from '../dist/storage.js'
import { createGitSnapshotFetcher } from '../dist/git-snapshot.js'
import { canonicalJson, sha256, signReleaseManifest } from '../../../packages/pack-contract/index.mjs'
import { manifest as fixtureManifest } from '../../../packages/pack-contract/test/fixtures.mjs'
import { createDatabaseFixture } from './support/database-fixture.mjs'
import { gitFixture } from './support/git-fixture.mjs'

let fixture
before(async () => { fixture = await createDatabaseFixture('validation-worker') })
after(async () => { await fixture?.close() })

async function context(t, overrides = {}) {
  const database = await fixture.database(t), git = await gitFixture(t)
  await database.query(`INSERT INTO organizations(id,slug,name) VALUES ('demo','demo','Demo'),('other','other','Other')`)
  await database.query(`INSERT INTO users(id,oidc_issuer,oidc_subject,display_name) VALUES
    ('author','https://identity.invalid','author','Author'),('reviewer','https://identity.invalid','reviewer','Reviewer')`)
  await database.query(`INSERT INTO packages(pack_id,owner_org_id,created_by,name) VALUES ('demo.review','demo','author','Demo')`)
  const store = await createLocalArtifactStore(join(git.root, 'store'))
  const options = { database, store, fetchSnapshot: createGitSnapshotFetcher(git.infrastructure), allowedGitHosts: ['git.fixture.invalid'],
    scratchRoot: git.outputParent, validatorVersion: '0.1.0', workerId: 'test-worker', ...overrides }
  return { database, git, store, options, worker: createValidationWorker(options) }
}
async function enqueue(c, changes = {}, maxAttempts = 3) {
  const id = randomUUID()
  await c.database.query(`INSERT INTO submissions(id,owner_org_id,pack_id,author_id,version,source_url,source_ref,distribution,requires_plugin,dependency_release_ids,builtin_dependencies)
    VALUES ($1,'demo','demo.review','author',$2,$3,'main',$4::jsonb,$5::jsonb,$6,$7::jsonb)`,
  [id, changes.version ?? '1.0.0', c.git.input.url, canonicalJson(changes.distribution ?? { kind: 'organization' }),
    canonicalJson(changes.requiresPlugin ?? { minVersion: '0.1.0' }), changes.dependencyReleaseIds ?? [], canonicalJson(changes.builtinDependencies ?? [])])
  await c.database.query(`UPDATE submissions SET status='validating',state_version=2 WHERE id=$1`, [id])
  const { job } = await c.database.enqueueJob({ kind: 'validate_submission', idempotencyKey: `validate:${id}`, payload: { submissionId: id }, maxAttempts })
  return { id, jobId: job.id }
}
async function snapshot(c, id) { return (await c.database.query('SELECT * FROM submission_snapshots WHERE submission_id=$1', [id])).rows[0] }
async function current(c, id) { return (await c.database.query('SELECT * FROM submissions WHERE id=$1', [id])).rows[0] }
async function editPack(c, mutate) {
  const pack = JSON.parse(await readFile(join(c.git.work, 'pack.json'), 'utf8'))
  mutate(pack)
  await writeFile(join(c.git.work, 'pack.json'), JSON.stringify(pack))
  await c.git.git('add', '.'); await c.git.git('commit', '--quiet', '-m', 'updated fixture'); return c.git.push()
}
async function published(c, options = {}) {
  const releaseId = options.releaseId ?? `release-${randomUUID()}`, packId = options.packId ?? `demo.dependency-${randomUUID()}`
  const owner = options.owner ?? 'demo', id = randomUUID(), snapshotId = randomUUID()
  const report = { schemaVersion: 1, validatorVersion: '0.1.0', packSchemaVersion: 2, valid: true, diagnostics: [], entityCounts: {} }
  const manifest = fixtureManifest({ releaseId, packId, ownerOrgId: owner, approvedSubmissionId: id, validatorVersion: '0.1.0',
    reportSha256: sha256(canonicalJson(report)), version: options.version ?? '1.0.0', dependencyLock: options.dependencyLock ?? [], builtinDependencies: options.builtinDependencies ?? [] })
  await c.database.query(`INSERT INTO packages(pack_id,owner_org_id,created_by,name) VALUES ($1,$2,'author','Dependency') ON CONFLICT DO NOTHING`, [packId, owner])
  await c.database.query(`INSERT INTO submissions(id,owner_org_id,pack_id,author_id,version,source_url,source_ref,distribution)
    VALUES ($1,$2,$3,'author',$4,'https://git.fixture.invalid/repo.git','main',$5::jsonb)`, [id, owner, packId, manifest.version, canonicalJson(options.scope ?? { kind: 'organization' })])
  await c.database.query(`UPDATE submissions SET status='validating',state_version=2 WHERE id=$1`, [id])
  await c.database.query(`INSERT INTO submission_snapshots(id,submission_id,source_commit,artifact_sha256,content_tree_sha256,report_sha256,artifact_key,report_key,
    validator_version,normalization_version,pack_schema_version,size_bytes,file_count,report,preview)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'0.1.0',1,2,2048,1,$9::jsonb,$10::jsonb)`,
  [snapshotId, id, manifest.sourceCommit, manifest.artifactSha256, manifest.contentTreeSha256, manifest.reportSha256,
    `sha256/${manifest.artifactSha256}`, `sha256/${manifest.reportSha256}`, canonicalJson(report), canonicalJson(options.preview ?? { files: [], entities: {} })])
  await c.database.query(`UPDATE submissions SET status='validated',snapshot_id=$2,state_version=3 WHERE id=$1`, [id, snapshotId])
  await c.database.query(`UPDATE submissions SET status='pending_review',state_version=4 WHERE id=$1`, [id])
  await c.database.query(`INSERT INTO reviews(id,submission_id,snapshot_id,reviewer_id,decision,expected_state_version,content_tree_sha256,comment)
    VALUES ($1,$2,$3,'reviewer','approved',4,$4,'Fixture reviewed')`, [randomUUID(), id, snapshotId, manifest.contentTreeSha256])
  await c.database.query(`UPDATE submissions SET status='approved',state_version=5 WHERE id=$1`, [id])
  await c.database.query(`INSERT INTO releases(id,pack_id,owner_org_id,version,approved_submission_id,snapshot_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [releaseId, packId, owner, manifest.version, id, snapshotId])
  const { privateKey } = generateKeyPairSync('ed25519')
  await c.database.query(`UPDATE releases SET status='published',state_version=2,signed_manifest=$2::jsonb,published_at=clock_timestamp() WHERE id=$1`, [releaseId, canonicalJson(signReleaseManifest(manifest, privateKey))])
  await c.database.query('INSERT INTO release_distribution(release_id,scope) VALUES ($1,$2::jsonb)', [releaseId, canonicalJson(options.scope ?? { kind: 'organization' })])
  return { packId, ownerOrgId: owner, releaseId, version: manifest.version, artifactSha256: manifest.artifactSha256, contentTreeSha256: manifest.contentTreeSha256 }
}

test('real Git -> verified CAS -> immutable PostgreSQL snapshot; no further fetch after completion', async t => {
  const c = await context(t), submission = await enqueue(c)
  const sourceCommit = await c.git.git('rev-parse', 'HEAD')
  const result = await c.worker.runOnce()
  assert.equal(result.status, 'validated', JSON.stringify(result))
  const saved = await snapshot(c, submission.id)
  assert.equal(saved.source_commit, sourceCommit)
  assert.equal((await current(c, submission.id)).status, 'validated')
  assert.equal((await c.store.verify(saved.artifact_key)).sha256, saved.artifact_sha256)
  assert.deepEqual(JSON.parse(await c.store.getBytes(saved.report_key)), saved.report)
  assert.equal(saved.report_sha256, sha256(canonicalJson(saved.report)))
  assert.deepEqual(saved.preview.delivery, { requiresPlugin: { minVersion: '0.1.0' }, dependencyLock: [], builtinDependencies: [] })
  assert.equal(saved.preview.packMeta.id, 'demo.review')
  assert.equal(saved.diff.baseline, null)
  assert.deepEqual(saved.diff.files.added.sort(), ['README.md', 'pack.json'])
  assert.equal((await c.database.query('SELECT status FROM jobs WHERE id=$1', [submission.jobId])).rows[0].status, 'succeeded')
  const requests = c.git.requests.length
  await editPack(c, pack => { pack.pack.version = '1.1.0' })
  assert.deepEqual(await c.worker.runOnce(), { worked: false, status: 'idle' })
  assert.equal(c.git.requests.length, requests)
  assert.equal((await snapshot(c, submission.id)).source_commit, sourceCommit)
  assert.deepEqual(await readdir(c.git.outputParent), [])
  await assert.rejects(c.database.query("UPDATE submission_snapshots SET preview='{}' WHERE id=$1", [saved.id]), { code: '23514' })
})

test('invalid content and mismatched version retain diagnostic archive but never become validated', async t => {
  for (const kind of ['invalid', 'identity']) await t.test(kind, async t => {
    const c = await context(t), submission = await enqueue(c, kind === 'identity' ? { version: '9.0.0' } : {})
    if (kind === 'invalid') await editPack(c, pack => { pack.pack.schemaVersion = 999 })
    assert.equal((await c.worker.runOnce()).status, 'validation_failed')
    const saved = await snapshot(c, submission.id)
    assert.equal(saved.report.valid, false)
    assert.equal((await current(c, submission.id)).status, 'validation_failed')
    assert.equal((await c.store.verify(saved.artifact_key)).sha256, saved.artifact_sha256)
    assert.equal((await c.database.query('SELECT status,snapshot_id FROM validation_attempts WHERE submission_id=$1', [submission.id])).rows[0].snapshot_id, saved.id)
    assert.equal((await c.database.query('SELECT count(*)::int AS n FROM releases')).rows[0].n, 0)
  })
})

test('fixed dependency graph and exact built-in inventory are recorded before review', async t => {
  const c = await context(t, { builtinPackVersions: { 'builtin.core': '1.2.0' } })
  const dependency = await published(c)
  await editPack(c, pack => { pack.pack.dependsOn = [dependency.packId, 'builtin.core'] })
  const requirements = [{ packId: 'builtin.core', minVersion: '1.0.0', maxVersionExclusive: '2.0.0' }]
  const submission = await enqueue(c, { dependencyReleaseIds: [dependency.releaseId], builtinDependencies: requirements })
  assert.equal((await c.worker.runOnce()).status, 'validated')
  const saved = await snapshot(c, submission.id)
  assert.deepEqual(saved.preview.delivery.dependencyLock, [dependency])
  assert.deepEqual(saved.preview.delivery.builtinDependencies, requirements)
  await assert.rejects(c.database.query(`UPDATE submissions SET dependency_release_ids=ARRAY[]::text[],state_version=state_version+1 WHERE id=$1`, [submission.id]), { code: '23514' })
})

test('dependency visibility, scope expansion, missing declarations and unconfigured built-ins fail validation', async t => {
  for (const kind of ['scope-expansion', 'private-dependency', 'missing-lock', 'builtin-unknown']) await t.test(kind, async t => {
    const c = await context(t)
    const dependency = kind === 'builtin-unknown' ? undefined : await published(c, { owner: kind === 'private-dependency' ? 'other' : 'demo' })
    await editPack(c, pack => { pack.pack.dependsOn = [dependency?.packId ?? 'builtin.unknown'] })
    const submission = await enqueue(c, { distribution: kind === 'scope-expansion' ? { kind: 'authenticated' } : { kind: 'organization' },
      dependencyReleaseIds: dependency && kind !== 'missing-lock' ? [dependency.releaseId] : [],
      builtinDependencies: kind === 'builtin-unknown' ? [{ packId: 'builtin.unknown', minVersion: '1.0.0' }] : [] })
    assert.equal((await c.worker.runOnce()).status, 'validation_failed')
    const saved = await snapshot(c, submission.id)
    assert.equal(saved.report.valid, false)
    assert.ok(saved.report.diagnostics.some(d => ['DEPENDENCY_FORBIDDEN', 'DEPENDENCY_DECLARATION_MISMATCH', 'BUILTIN_DEPENDENCY_UNAVAILABLE'].includes(d.code)), JSON.stringify(saved.report))
  })
})

test('transitive dependency cycles and conflicting versions cannot become a frozen lock', async t => {
  const c = await context(t)
  // A published dependency declaring this package creates a package-level cycle,
  // even if the referenced prior version exists and has valid approved identity.
  const prior = await published(c, { packId: 'demo.review', version: '0.9.0' })
  const dependency = await published(c, { dependencyLock: [prior] })
  await editPack(c, pack => { pack.pack.dependsOn = [dependency.packId] })
  const submission = await enqueue(c, { dependencyReleaseIds: [dependency.releaseId] })
  assert.equal((await c.worker.runOnce()).status, 'validation_failed')
  assert.ok((await snapshot(c, submission.id)).report.diagnostics.some(d => d.code === 'DEPENDENCY_CYCLE'))
  const first = await published(c, { packId: 'demo.shared', version: '1.0.0' })
  const second = await published(c, { packId: 'demo.shared', version: '2.0.0' })
  const branchA = await published(c, { dependencyLock: [first] }), branchB = await published(c, { dependencyLock: [second] })
  await editPack(c, pack => { pack.pack.dependsOn = [branchA.packId, branchB.packId] })
  const conflict = await enqueue(c, { dependencyReleaseIds: [branchA.releaseId, branchB.releaseId] })
  assert.equal((await c.worker.runOnce()).status, 'validation_failed')
  assert.ok((await snapshot(c, conflict.id)).report.diagnostics.some(d => d.code === 'DEPENDENCY_CONFLICT'))
})

test('selected recipients are checked as exact deployment/org sets, not inferred owner access', async t => {
  const c = await context(t)
  await c.database.query("INSERT INTO deployments(id,organization_id,name,created_by) VALUES ('site-demo','demo','Site Demo','author'),('site-other','other','Site Other','author')")
  const dependency = await published(c)
  await editPack(c, pack => { pack.pack.dependsOn = [dependency.packId] })
  const allowed = await enqueue(c, { dependencyReleaseIds: [dependency.releaseId], distribution: { kind: 'selected', organizationIds: [], deploymentIds: ['site-demo'] } })
  assert.equal((await c.worker.runOnce()).status, 'validated')
  assert.equal((await snapshot(c, allowed.id)).report.valid, true)
  const denied = await enqueue(c, { dependencyReleaseIds: [dependency.releaseId], distribution: { kind: 'selected', organizationIds: [], deploymentIds: ['site-other'] } })
  assert.equal((await c.worker.runOnce()).status, 'validation_failed')
  assert.ok((await snapshot(c, denied.id)).report.diagnostics.some(d => d.code === 'DEPENDENCY_FORBIDDEN'))
  const noImplicitOwner = await published(c, { scope: { kind: 'selected', organizationIds: ['other'], deploymentIds: [] } })
  await editPack(c, pack => { pack.pack.dependsOn = [noImplicitOwner.packId] })
  const hidden = await enqueue(c, { dependencyReleaseIds: [noImplicitOwner.releaseId], distribution: { kind: 'selected', organizationIds: ['other'], deploymentIds: [] } })
  assert.equal((await c.worker.runOnce()).status, 'validation_failed')
  assert.ok((await snapshot(c, hidden.id)).report.diagnostics.some(d => d.code === 'DEPENDENCY_FORBIDDEN'))
})

test('two workers claim once while heartbeat prevents a slow active fetch from being stolen', async t => {
  const c = await context(t), submission = await enqueue(c)
  let entered
  const enteredPromise = new Promise(resolve => { entered = resolve })
  const fetch = c.options.fetchSnapshot
  const first = createValidationWorker({ ...c.options, workerId: 'worker-a', leaseMs: 600,
    fetchSnapshot: async input => { entered(); await delay(900); return fetch(input) } })
  const second = createValidationWorker({ ...c.options, workerId: 'worker-b', leaseMs: 600 })
  const running = first.runOnce()
  await enteredPromise; await delay(700)
  assert.deepEqual(await second.runOnce(), { worked: false, status: 'idle' })
  assert.equal((await running).status, 'validated')
  assert.equal((await c.database.query('SELECT attempt FROM jobs WHERE id=$1', [submission.jobId])).rows[0].attempt, 1)
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM submission_snapshots')).rows[0].n, 1)
})

test('stale worker cannot commit after a newer claim has obtained the fence', async t => {
  const c = await context(t), submission = await enqueue(c)
  let entered, resume
  const enteredPromise = new Promise(resolve => { entered = resolve }), resumePromise = new Promise(resolve => { resume = resolve })
  const fetch = c.options.fetchSnapshot
  const first = createValidationWorker({ ...c.options, workerId: 'worker-old', leaseMs: 60000,
    fetchSnapshot: async input => { const value = await fetch(input); entered(); await resumePromise; return value } })
  const running = first.runOnce(); await enteredPromise
  await c.database.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [submission.jobId])
  const winner = await createValidationWorker({ ...c.options, workerId: 'worker-new' }).runOnce()
  assert.equal(winner.status, 'validated')
  resume(); assert.equal((await running).status, 'lease_lost')
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM submission_snapshots')).rows[0].n, 1)
  const attempts = (await c.database.query('SELECT attempt,status,error_code FROM validation_attempts ORDER BY attempt')).rows
  assert.deepEqual(attempts.map(a => a.status), ['failed', 'succeeded'])
  assert.equal(attempts[0].error_code, 'LEASE_EXPIRED')
})

test('CAS write failure cannot attach a missing snapshot; errors are sanitized and final crash is reconciled', async t => {
  const c = await context(t), submission = await enqueue(c, {}, 1)
  const broken = createValidationWorker({ ...c.options, store: { putFile: (...args) => c.store.putFile(...args), putJson: async () => { throw new Error('PRIVATE-TOKEN=DO-NOT-LOG') } } })
  assert.equal((await broken.runOnce()).status, 'validation_failed')
  assert.equal(await snapshot(c, submission.id), undefined)
  assert.equal((await current(c, submission.id)).status, 'validation_failed')
  const records = (await c.database.query('SELECT error_message FROM jobs UNION ALL SELECT error_message FROM validation_attempts')).rows
  assert.ok(records.every(row => !String(row.error_message).includes('PRIVATE-TOKEN')))
  const abandoned = await enqueue(c, {}, 1)
  const lease = await c.database.claimJob('crashed-worker', { kinds: ['validate_submission'], leaseMs: 100 })
  assert.equal(lease.id, abandoned.jobId)
  await c.database.query("INSERT INTO validation_attempts(id,submission_id,attempt,status) VALUES ($1,$2,1,'running')", [randomUUID(), abandoned.id])
  await delay(150)
  assert.deepEqual(await c.worker.runOnce(), { worked: false, status: 'idle' })
  assert.equal((await current(c, abandoned.id)).status, 'validation_failed')
  assert.equal((await c.database.query('SELECT status,error_code FROM jobs WHERE id=$1', [abandoned.jobId])).rows[0].error_code, 'LEASE_EXPIRED')
  assert.equal((await c.database.query('SELECT status FROM validation_attempts WHERE submission_id=$1', [abandoned.id])).rows[0].status, 'failed')
})

test('review diff uses last published snapshot for changed/removed files and entity removals', async t => {
  const c = await context(t)
  const prior = await published(c, { packId: 'demo.review', version: '0.9.0', preview: {
    files: [{ path: 'pack.json', sha256: sha256('old'), sizeBytes: 3 }, { path: 'old.md', sha256: sha256('removed'), sizeBytes: 7 }],
    entities: { experts: ['demo.old.expert'], scenarios: ['demo.review.scenario'] },
    entityDigests: { scenarios: { 'demo.review.scenario': sha256('old scenario') } },
  } })
  const submission = await enqueue(c)
  assert.equal((await c.worker.runOnce()).status, 'validated')
  const saved = await snapshot(c, submission.id)
  assert.equal(saved.diff.baseline.releaseId, prior.releaseId)
  assert.deepEqual(saved.diff.files.changed, ['pack.json'])
  assert.deepEqual(saved.diff.files.removed, ['old.md'])
  assert.deepEqual(saved.diff.entities.experts.removed, ['demo.old.expert'])
  assert.deepEqual(saved.diff.entities.experts.added, ['demo.review.expert'])
  assert.deepEqual(saved.diff.entities.scenarios.changed, ['demo.review.scenario'])
})

test('historical snapshots without an entity inventory are unverified, not empty or unchanged', async t => {
  for (const entities of [undefined, [], { experts: 'not-an-array' }]) await t.test(JSON.stringify(entities) ?? 'missing', async t => {
    const c = await context(t)
    await published(c, { packId: 'demo.review', version: '0.9.0', preview: { ...(entities === undefined ? {} : { entities }) } })
    const submission = await enqueue(c)
    assert.equal((await c.worker.runOnce()).status, 'validated')
    const saved = await snapshot(c, submission.id)
    assert.deepEqual(saved.diff.entities.experts, { added: [], removed: [], changed: [], unverifiedPrevious: ['demo.review.expert'] })
  })
})
