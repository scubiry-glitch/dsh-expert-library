import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout } from 'node:timers/promises'
import { createDatabaseFixture } from './support/database-fixture.mjs'
import { createLocalArtifactStore } from '../dist/storage.js'
import { createPublisher } from '../dist/publisher.js'
import { packDirectory } from '../../../packages/pack-artifact/index.mjs'
import { canonicalBytes, canonicalJson, sha256, signReleaseManifest, verifyReleaseManifest } from '../../../packages/pack-contract/index.mjs'

const exec = promisify(execFile)
const packPath = new URL('../../../examples/pack-center/demo-v1/', import.meta.url).pathname
let fixture
before(async () => { fixture = await createDatabaseFixture('publisher') })
after(async () => { await fixture?.close() })
const hasCode = expected => error => { assert.equal(error.code, expected); return true }

async function setup(t, changes = {}) {
  const database = await fixture.database(t)
  const scratch = await mkdtemp(join(tmpdir(), 'pack-center-publisher-test-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const store = await createLocalArtifactStore(join(scratch, 'store'))
  const keys = generateKeyPairSync('ed25519')
  const archive = join(scratch, 'archive.tar')
  let source = packPath
  if (changes.packDependsOn) {
    source = join(scratch, 'custom-pack'); await mkdir(source)
    const pack = JSON.parse(await readFile(join(packPath, 'pack.json'), 'utf8'))
    pack.pack.dependsOn = changes.packDependsOn
    await writeFile(join(source, 'pack.json'), canonicalBytes(pack))
  }
  const artifact = await packDirectory(source, archive)
  const stored = await store.putFile(archive, artifact.artifactSha256)
  const report = { schemaVersion: 1, validatorVersion: '0.1.0', packSchemaVersion: 2, valid: true, diagnostics: [], entityCounts: {}, ...changes.report }
  const storedReport = await store.putJson(report)
  const version = changes.version ?? '1.0.0', packId = changes.packId ?? 'demo.review'
  const delivery = { requiresPlugin: { minVersion: '0.1.0', maxVersionExclusive: '2.0.0' }, dependencyLock: [], builtinDependencies: [], ...changes.delivery }
  const tree = changes.tree ?? artifact.contentTreeSha256
  await database.query("INSERT INTO organizations(id,slug,name) VALUES ('org-demo','demo','Demo')")
  await database.query(`INSERT INTO users(id,oidc_issuer,oidc_subject,display_name) VALUES
    ('author','https://issuer.invalid','author','Author'),('reviewer','https://issuer.invalid','reviewer','Reviewer')`)
  await database.query("INSERT INTO packages(pack_id,owner_org_id,created_by,name) VALUES ($1,'org-demo','author','Demo')", [packId])
  const authorDelivery = { ...delivery, ...changes.authorDelivery }
  await database.query(`INSERT INTO submissions(id,owner_org_id,pack_id,author_id,version,source_url,source_ref,distribution,requires_plugin,builtin_dependencies,dependency_release_ids)
    VALUES ('submission-one','org-demo',$1,'author',$2,'https://unreachable.invalid/repo.git','main','{"kind":"organization"}',$3::jsonb,$4::jsonb,$5)`,
  [packId, version, canonicalJson(authorDelivery.requiresPlugin), canonicalJson(authorDelivery.builtinDependencies), authorDelivery.dependencyLock.map(row => row.releaseId)])
  await database.query("UPDATE submissions SET status='validating',state_version=2 WHERE id='submission-one'")
  await database.query(`INSERT INTO submission_snapshots(id,submission_id,source_commit,artifact_sha256,content_tree_sha256,report_sha256,
    artifact_key,report_key,validator_version,normalization_version,pack_schema_version,size_bytes,file_count,report,preview)
    VALUES ('snapshot-one','submission-one',$1,$2,$3,$4,$5,$6,'0.1.0',1,2,$7,$8,$9::jsonb,$10::jsonb)`,
  ['a'.repeat(40), artifact.artifactSha256, tree, storedReport.sha256, stored.key, storedReport.key,
    artifact.sizeBytes, artifact.fileCount, canonicalJson(report), canonicalJson(changes.missingDelivery ? {} : { delivery })])
  await database.query("UPDATE submissions SET status='validated',snapshot_id='snapshot-one',state_version=3 WHERE id='submission-one'")
  await database.query("UPDATE submissions SET status='pending_review',state_version=4 WHERE id='submission-one'")
  await database.query(`INSERT INTO reviews(id,submission_id,snapshot_id,reviewer_id,decision,expected_state_version,content_tree_sha256,comment)
    VALUES ('review-one','submission-one','snapshot-one','reviewer','approved',4,$1,'Reviewed frozen bytes')`, [tree])
  await database.query("UPDATE submissions SET status='approved',state_version=5 WHERE id='submission-one'")
  await database.query(`INSERT INTO releases(id,pack_id,owner_org_id,version,approved_submission_id,snapshot_id)
    VALUES ('release-one',$1,'org-demo',$2,'submission-one','snapshot-one')`, [packId, version])
  await database.query("INSERT INTO release_distribution(release_id,scope) VALUES ('release-one','{\"kind\":\"organization\"}')")
  const job = await database.enqueueJob({ kind: 'publish_release', idempotencyKey: 'publish:release-one', payload: { releaseId: 'release-one', snapshotId: 'snapshot-one' }, maxAttempts: changes.maxAttempts ?? 3 })
  const options = { database, store, centerId: 'center-test', signingKeyId: 'test-key', signingPrivateKey: keys.privateKey, workerId: 'publisher-one', scratchRoot: scratch }
  return { database, store, keys, scratch, artifact, report, delivery, options, job: job.job, publisher: createPublisher(options) }
}
async function release(database) { return (await database.query("SELECT * FROM releases WHERE id='release-one'")).rows[0] }
async function retry(database, key = 'retry-one') {
  return database.enqueueJob({ kind: 'publish_release', idempotencyKey: key, payload: { releaseId: 'release-one', snapshotId: 'snapshot-one' }, maxAttempts: 3 })
}
async function dependencyFixture(t, { id = 'dependency-one', packId = 'demo.dependency', dependencyLock = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pack-center-dependency-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const content = join(root, 'content'); await mkdir(content)
  const pack = JSON.parse(await readFile(join(packPath, 'pack.json'), 'utf8'))
  pack.pack.id = packId; pack.pack.dependsOn = dependencyLock.map(row => row.packId)
  await writeFile(join(content, 'pack.json'), canonicalBytes(pack))
  const archive = join(root, 'artifact.tar'), artifact = await packDirectory(content, archive)
  const lock = { packId, ownerOrgId: 'org-demo', releaseId: id, version: '1.0.0', artifactSha256: artifact.artifactSha256, contentTreeSha256: artifact.contentTreeSha256 }
  return { lock, async seed({ database, store, keys }, scope = { kind: 'organization' }) {
    const report = { schemaVersion: 1, validatorVersion: '0.1.0', packSchemaVersion: 2, valid: true, diagnostics: [], entityCounts: {} }
    const stored = await store.putFile(archive, artifact.artifactSha256), storedReport = await store.putJson(report)
    const submissionId = `s-${id}`, snapshotId = `ss-${id}`, reviewId = `rv-${id}`
    const delivery = { requiresPlugin: { minVersion: '0.1.0' }, dependencyLock, builtinDependencies: [] }
    await database.query("INSERT INTO packages(pack_id,owner_org_id,created_by,name) VALUES ($1,'org-demo','author','Dependency')", [packId])
    await database.query(`INSERT INTO submissions(id,owner_org_id,pack_id,author_id,version,source_url,source_ref,distribution,dependency_release_ids)
      VALUES ($1,'org-demo',$2,'author','1.0.0','https://unreachable.invalid/dep.git','main',$3::jsonb,$4)`, [submissionId, packId, canonicalJson(scope), dependencyLock.map(row => row.releaseId)])
    await database.query("UPDATE submissions SET status='validating',state_version=2 WHERE id=$1", [submissionId])
    await database.query(`INSERT INTO submission_snapshots(id,submission_id,source_commit,artifact_sha256,content_tree_sha256,report_sha256,
      artifact_key,report_key,validator_version,normalization_version,pack_schema_version,size_bytes,file_count,report,preview)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'0.1.0',1,2,$9,$10,$11::jsonb,$12::jsonb)`,
    [snapshotId, submissionId, 'b'.repeat(40), artifact.artifactSha256, artifact.contentTreeSha256, storedReport.sha256,
      stored.key, storedReport.key, artifact.sizeBytes, artifact.fileCount, canonicalJson(report), canonicalJson({ delivery })])
    await database.query("UPDATE submissions SET status='validated',snapshot_id=$2,state_version=3 WHERE id=$1", [submissionId, snapshotId])
    await database.query("UPDATE submissions SET status='pending_review',state_version=4 WHERE id=$1", [submissionId])
    await database.query(`INSERT INTO reviews(id,submission_id,snapshot_id,reviewer_id,decision,expected_state_version,content_tree_sha256,comment)
      VALUES ($1,$2,$3,'reviewer','approved',4,$4,'Fixture approved frozen dependency')`, [reviewId, submissionId, snapshotId, artifact.contentTreeSha256])
    await database.query("UPDATE submissions SET status='approved',state_version=5 WHERE id=$1", [submissionId])
    await database.query(`INSERT INTO releases(id,pack_id,owner_org_id,version,approved_submission_id,snapshot_id)
      VALUES ($1,$2,'org-demo','1.0.0',$3,$4)`, [id, packId, submissionId, snapshotId])
    const manifest = { schemaVersion: 1, protocolVersion: 1, normalizationVersion: 1, digestAlgorithmVersion: 1,
      signatureAlgorithm: 'Ed25519', archiveFormat: 'tar', centerId: 'center-test', releaseId: id, packId, ownerOrgId: 'org-demo',
      version: '1.0.0', sourceCommit: 'b'.repeat(40), artifactSha256: artifact.artifactSha256, contentTreeSha256: artifact.contentTreeSha256,
      reportSha256: storedReport.sha256, validatorVersion: '0.1.0', packSchemaVersion: 2, ...delivery,
      sizeBytes: artifact.sizeBytes, fileCount: artifact.fileCount, approvedSubmissionId: submissionId, signingKeyId: 'test-key' }
    const signed = signReleaseManifest(manifest, keys.privateKey)
    await store.putJson(signed)
    await database.query("UPDATE releases SET signed_manifest=$2::jsonb,status='published',published_at=clock_timestamp(),state_version=2 WHERE id=$1", [id, canonicalJson(signed)])
    await database.query('INSERT INTO release_distribution(release_id,scope) VALUES ($1,$2::jsonb)', [id, canonicalJson(scope)])
  } }
}

test('publisher signs approved fixed archive/report without fetching its unreachable Git source', async t => {
  const { database, publisher, keys, store, artifact, delivery, report } = await setup(t)
  const result = await publisher.runOnce()
  assert.equal(result.status, 'published')
  const published = await release(database)
  assert.equal(published.status, 'published')
  const manifest = verifyReleaseManifest(published.signed_manifest, { 'test-key': keys.publicKey })
  assert.equal(manifest.sourceCommit, 'a'.repeat(40))
  assert.equal(manifest.artifactSha256, artifact.artifactSha256)
  assert.equal(manifest.contentTreeSha256, artifact.contentTreeSha256)
  assert.equal(manifest.reportSha256, sha256(canonicalBytes(report)))
  assert.equal(manifest.packId, 'demo.review')
  assert.equal(manifest.approvedSubmissionId, 'submission-one')
  assert.deepEqual(manifest.requiresPlugin, delivery.requiresPlugin)
  assert.deepEqual(manifest.dependencyLock, [])
  assert.deepEqual(manifest.builtinDependencies, [])
  assert.deepEqual(await store.getBytes(result.manifestKey), canonicalBytes(published.signed_manifest))
  assert.equal((await database.query('SELECT status FROM jobs')).rows[0].status, 'succeeded')
  assert.equal((await database.query("SELECT count(*)::int AS n FROM audit_events WHERE action='release.published'")).rows[0].n, 1)
  assert.deepEqual(await publisher.runOnce(), { status: 'idle' })
})

test('concurrent publishers lease one job and duplicate authorized jobs preserve exact signature and one audit', async t => {
  const { database, options, store } = await setup(t)
  const results = await Promise.all([createPublisher(options).runOnce(), createPublisher({ ...options, workerId: 'publisher-two' }).runOnce()])
  assert.equal(results.filter(item => item.status === 'published').length, 1)
  assert.equal(results.filter(item => item.status === 'idle').length, 1)
  const first = await release(database)
  await retry(database, 'duplicate-job')
  const repeated = await createPublisher(options).runOnce()
  assert.equal(repeated.status, 'published')
  const last = await release(database)
  assert.deepEqual(last.signed_manifest, first.signed_manifest)
  assert.equal(last.state_version, first.state_version)
  assert.equal((await database.query("SELECT count(*)::int AS n FROM audit_events WHERE action='release.published'")).rows[0].n, 1)
  assert.deepEqual(await store.getBytes(repeated.manifestKey), canonicalBytes(first.signed_manifest))
  await assert.rejects(database.query("UPDATE releases SET signed_manifest='{}',state_version=state_version+1 WHERE id='release-one'"), hasCode('23514'))
  await assert.rejects(database.query("UPDATE releases SET version='1.0.1',state_version=state_version+1 WHERE id='release-one'"), hasCode('23514'))
})

test('publisher rejects missing delivery, invalid reports, wrong pack identity/version and inconsistent tree', async t => {
  for (const changes of [
    { missingDelivery: true, expected: 'PUBLISH_DELIVERY_MISSING' },
    { authorDelivery: { requiresPlugin: { minVersion: '0.2.0' } }, expected: 'PUBLISH_DELIVERY_CONFLICT' },
    { report: { valid: false }, expected: 'PUBLISH_REPORT_INVALID' },
    { packId: 'demo.other', expected: 'PUBLISH_PACK_INVALID' },
    { version: '2.0.0', expected: 'PUBLISH_PACK_INVALID' },
    { tree: '0'.repeat(64), expected: 'INTEGRITY_MISMATCH' },
    { delivery: { builtinDependencies: [{ packId: 'builtin.fake', minVersion: '1.0.0' }] }, expected: 'PUBLISH_DEPENDENCY_MISMATCH' },
  ]) {
    const { database, publisher } = await setup(t, changes)
    const result = await publisher.runOnce()
    assert.equal(result.status, 'failed')
    assert.equal(result.errorCode, changes.expected)
    const row = await release(database)
    assert.equal(row.status, 'publish_failed')
    assert.equal(row.signed_manifest, null)
    assert.equal((await database.query('SELECT status FROM jobs')).rows[0].status, 'failed')
    assert.equal((await database.query("SELECT count(*)::int AS n FROM audit_events WHERE action='release.published'")).rows[0].n, 0)
  }
})

test('CAS archive/report tampering fails closed before a signature is frozen', async t => {
  for (const target of ['artifact', 'report']) {
    const { database, publisher, store } = await setup(t)
    const snapshot = (await database.query('SELECT * FROM submission_snapshots')).rows[0]
    const path = join(store.root, 'sha256', snapshot[`${target}_sha256`], 'data')
    const bytes = await readFile(path)
    bytes[0] ^= 1
    await chmod(path, 0o600); await writeFile(path, bytes); await chmod(path, 0o400)
    const result = await publisher.runOnce()
    assert.equal(result.status, 'failed')
    assert.equal(result.errorCode, 'STORAGE_HASH_MISMATCH')
    assert.equal((await release(database)).signed_manifest, null)
  }
})

test('direct dependency must still be published and available to every approved recipient', async t => {
  for (const mode of ['allowed', 'yanked', 'narrowed', 'wrong-lock']) {
    const dependency = await dependencyFixture(t)
    const lock = mode === 'wrong-lock' ? { ...dependency.lock, artifactSha256: '0'.repeat(64) } : dependency.lock
    const context = await setup(t, { packDependsOn: [lock.packId], delivery: { dependencyLock: [lock] } })
    await dependency.seed(context)
    if (mode === 'yanked') await context.database.query("UPDATE releases SET status='yanked',yanked_at=clock_timestamp(),yank_reason='Withdrawn',state_version=state_version+1 WHERE id=$1", [lock.releaseId])
    if (mode === 'narrowed') {
      await context.database.query("INSERT INTO organizations(id,slug,name) VALUES ('org-other','other','Other')")
      await context.database.query("UPDATE release_distribution SET scope='{\"kind\":\"selected\",\"organizationIds\":[\"org-other\"],\"deploymentIds\":[]}',state_version=state_version+1 WHERE release_id=$1", [lock.releaseId])
    }
    const result = await context.publisher.runOnce()
    assert.equal(result.status, mode === 'allowed' ? 'published' : 'failed')
    if (mode !== 'allowed') assert.equal(result.errorCode, { yanked: 'DEPENDENCY_UNAVAILABLE', narrowed: 'DEPENDENCY_FORBIDDEN', 'wrong-lock': 'DEPENDENCY_INTEGRITY' }[mode])
  }
})

test('a dependency yanked after signature freeze blocks final publication without changing the frozen envelope', async t => {
  const dependency = await dependencyFixture(t)
  const context = await setup(t, { packDependsOn: [dependency.lock.packId], delivery: { dependencyLock: [dependency.lock] } })
  await dependency.seed(context)
  const result = await createPublisher({ ...context.options, async fault(point) {
    if (point === 'after-manifest-store') await context.database.query("UPDATE releases SET status='yanked',yanked_at=clock_timestamp(),yank_reason='Withdrawn',state_version=state_version+1 WHERE id=$1", [dependency.lock.releaseId])
  } }).runOnce()
  assert.equal(result.errorCode, 'DEPENDENCY_UNAVAILABLE')
  const row = await release(context.database)
  assert.equal(row.status, 'publish_failed')
  assert.ok(row.signed_manifest)
  assert.equal((await context.database.query("SELECT count(*)::int AS n FROM audit_events WHERE action='release.published'")).rows[0].n, 0)
})

test('transitive dependency narrowing blocks its parent release and builtins require the trusted inventory', async t => {
  const nested = await dependencyFixture(t, { id: 'nested-one', packId: 'demo.nested' })
  const direct = await dependencyFixture(t, { dependencyLock: [nested.lock] })
  const context = await setup(t, { packDependsOn: [direct.lock.packId], delivery: { dependencyLock: [direct.lock] } })
  await nested.seed(context); await direct.seed(context)
  await context.database.query("INSERT INTO organizations(id,slug,name) VALUES ('org-other','other','Other')")
  await context.database.query("UPDATE release_distribution SET scope='{\"kind\":\"selected\",\"organizationIds\":[\"org-other\"],\"deploymentIds\":[]}',state_version=state_version+1 WHERE release_id=$1", [nested.lock.releaseId])
  assert.equal((await context.publisher.runOnce()).errorCode, 'DEPENDENCY_FORBIDDEN')
  for (const compatible of [true, false]) {
    const builtin = await setup(t, { packDependsOn: ['builtin.base'], delivery: { builtinDependencies: [{ packId: 'builtin.base', minVersion: '1.0.0', maxVersionExclusive: '2.0.0' }] } })
    const result = await createPublisher({ ...builtin.options, builtinPackVersions: { 'builtin.base': compatible ? '1.2.0' : '2.0.0' } }).runOnce()
    assert.equal(result.status, compatible ? 'published' : 'failed')
    if (!compatible) assert.equal(result.errorCode, 'BUILTIN_DEPENDENCY_UNAVAILABLE')
  }
})

test('frozen envelope survives manifest-store failure and retry cannot rotate key or signature', async t => {
  const { database, options, store, keys } = await setup(t, { maxAttempts: 1 })
  const failed = createPublisher({ ...options, store: { ...store,
    getBytes: store.getBytes.bind(store), openStream: store.openStream.bind(store), verify: store.verify.bind(store),
    async putJson() { const error = new Error('Do not leak secret filesystem details'); error.code = 'ENOSPC'; throw error },
  } })
  assert.equal((await failed.runOnce()).status, 'failed')
  const frozen = (await release(database)).signed_manifest
  assert.ok(frozen)
  verifyReleaseManifest(frozen, { 'test-key': keys.publicKey })
  await retry(database, 'wrong-key')
  const otherKey = generateKeyPairSync('ed25519')
  const wrong = await createPublisher({ ...options, signingKeyId: 'rotated-key', signingPrivateKey: otherKey.privateKey }).runOnce()
  assert.equal(wrong.errorCode, 'PUBLISH_KEY_MISMATCH')
  assert.deepEqual((await release(database)).signed_manifest, frozen)
  await retry(database, 'right-key')
  assert.equal((await createPublisher(options).runOnce()).status, 'published')
  assert.deepEqual((await release(database)).signed_manifest, frozen)
  const jobs = await database.query('SELECT error_message FROM jobs WHERE error_message IS NOT NULL')
  assert.ok(!JSON.stringify(jobs.rows).includes('secret filesystem'))
})

test('actual process exits after freeze and CAS write resume the identical signature after lease expiry', async t => {
  for (const point of ['after-freeze', 'after-manifest-store']) {
    const { database, options, store, keys } = await setup(t)
    const publisherUrl = new URL('../dist/publisher.js', import.meta.url).href
    const databaseUrl = new URL('../dist/database.js', import.meta.url).href
    const storageUrl = new URL('../dist/storage.js', import.meta.url).href
    const script = `import {createPublisher} from ${JSON.stringify(publisherUrl)};
      import {createDatabase} from ${JSON.stringify(databaseUrl)}; import {createLocalArtifactStore} from ${JSON.stringify(storageUrl)};
      const database=createDatabase({connectionString:process.env.PUBLISH_TEST_DB,schema:process.env.PUBLISH_TEST_SCHEMA});
      const store=await createLocalArtifactStore(process.env.PUBLISH_TEST_STORE);
      const publisher=createPublisher({database,store,centerId:'center-test',signingKeyId:'test-key',signingPrivateKey:process.env.PUBLISH_TEST_KEY,
        workerId:'crash-worker',scratchRoot:process.env.PUBLISH_TEST_SCRATCH,leaseMs:1000,fault(point){if(point===process.env.PUBLISH_TEST_POINT)process.exit(42)}});
      await publisher.runOnce(); await database.close();`
    await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env,
      PUBLISH_TEST_DB: database.pool.options.connectionString, PUBLISH_TEST_SCHEMA: database.schema,
      PUBLISH_TEST_STORE: store.root, PUBLISH_TEST_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), PUBLISH_TEST_POINT: point,
      PUBLISH_TEST_SCRATCH: options.scratchRoot,
    } }), error => error.code === 42)
    const frozen = (await release(database)).signed_manifest
    assert.ok(frozen)
    await setTimeout(1100)
    assert.equal((await createPublisher(options).runOnce()).status, 'published')
    assert.deepEqual((await release(database)).signed_manifest, frozen)
    const attempts = await database.query('SELECT attempt,outcome FROM job_attempts ORDER BY attempt')
    assert.deepEqual(attempts.rows.map(row => row.outcome), ['lease_expired', 'succeeded'])
  }
})

test('publisher uses its explicit private scratch root and refuses an unsafe parent instead of system tmp fallback', async t => {
  const context = await setup(t)
  const dedicated = join(context.scratch, 'quota-volume')
  await mkdir(dedicated, { mode: 0o700 })
  let inspected = false
  const store = {
    getBytes: context.store.getBytes.bind(context.store), verify: context.store.verify.bind(context.store), putJson: context.store.putJson.bind(context.store),
    async openStream(...args) {
      const names = await readdir(dedicated)
      assert.equal(names.length, 1); assert.match(names[0], /^pack-center-publish-/)
      inspected = true
      return context.store.openStream(...args)
    },
  }
  assert.equal((await createPublisher({ ...context.options, store, scratchRoot: dedicated }).runOnce()).status, 'published')
  assert.equal(inspected, true); assert.deepEqual(await readdir(dedicated), [])
  const unsafe = await setup(t)
  await chmod(unsafe.scratch, 0o755)
  const result = await unsafe.publisher.runOnce()
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'PUBLISH_SCRATCH_UNSAFE')
  assert.throws(() => createPublisher({ ...unsafe.options, scratchRoot: undefined }), hasCode('PUBLISH_CONFIG'))
})

test('a deterministic final-transaction lease fence rolls back publication and its success audit', async t => {
  const { database, options } = await setup(t)
  let injectedLease, reachedCommit = false
  const wrapped = { ...database, async withJobTransaction(lease, fn) {
    return database.withJobTransaction(lease, async tx => {
      const value = await fn(tx)
      assert.equal(reachedCommit, true, 'Must reach the actual final publication transaction')
      // Only schedule a real PostgreSQL failure at the final fence. An unconditional
      // failed heartbeat could abort earlier while its DB lease was still valid.
      const expired = await tx.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1 AND lease_token=$2 AND status='running'", [lease.id, lease.leaseToken])
      assert.equal(expired.rowCount, 1)
      injectedLease = lease
      return value
    })
  } }
  const result = await createPublisher({ ...options, database: wrapped, leaseMs: 60000,
    async fault(point) { if (point === 'before-commit') reachedCommit = true },
  }).runOnce()
  assert.equal(result.status, 'lease_lost')
  assert.ok(injectedLease, 'The real SQL fence, not an earlier failure, must cause lease loss')
  const row = await release(database)
  assert.equal(row.status, 'publishing')
  assert.ok(row.signed_manifest, 'Frozen immutable envelope survives, but publication rolls back')
  assert.equal((await database.query("SELECT count(*)::int AS n FROM audit_events WHERE action='release.published'")).rows[0].n, 0)
  // The failed transaction also rolls back the injected expiry. Explicitly
  // expire that same test lease before testing real worker recovery; no timers.
  const expired = await database.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1 AND lease_token=$2 AND status='running'", [injectedLease.id, injectedLease.leaseToken])
  assert.equal(expired.rowCount, 1)
  assert.equal((await createPublisher(options).runOnce()).status, 'published')
})

test('exhausted crashed last attempt reconciles to publish_failed and an authorized new job can recover', async t => {
  const { database, options } = await setup(t, { maxAttempts: 1 })
  const lease = await database.claimJob('dead-worker', { kinds: ['publish_release'], leaseMs: 50 })
  assert.ok(lease)
  await setTimeout(70)
  assert.deepEqual(await createPublisher(options).runOnce(), { status: 'idle' })
  assert.equal((await release(database)).status, 'publish_failed')
  await retry(database)
  assert.equal((await createPublisher(options).runOnce()).status, 'published')
})

test('replayed jobs never undo a yanked release or enlarge its distribution', async t => {
  const { database, publisher } = await setup(t)
  await publisher.runOnce()
  const before = await release(database)
  await database.query("UPDATE releases SET status='yanked',yanked_at=clock_timestamp(),yank_reason='Safety withdrawal',state_version=state_version+1 WHERE id='release-one'")
  await retry(database)
  assert.equal((await publisher.runOnce()).status, 'yanked')
  const after = await release(database)
  assert.equal(after.status, 'yanked')
  assert.deepEqual(after.signed_manifest, before.signed_manifest)
  assert.deepEqual((await database.query('SELECT scope FROM release_distribution')).rows[0].scope, { kind: 'organization' })
})

test('signing configuration rejects RSA and invalid identifiers without claiming work', async t => {
  const { database, options } = await setup(t)
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  assert.throws(() => createPublisher({ ...options, signingPrivateKey: rsa.privateKey }), hasCode('PUBLISH_KEY_ALGORITHM'))
  assert.throws(() => createPublisher({ ...options, workerId: '../unsafe' }), hasCode('PUBLISH_CONFIG'))
  assert.throws(() => createPublisher({ ...options, signingKeyId: 'k'.repeat(65) }), hasCode('PUBLISH_CONFIG'))
  assert.equal((await database.query('SELECT status FROM jobs')).rows[0].status, 'queued')
})
