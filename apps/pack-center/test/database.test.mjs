import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout } from 'node:timers/promises'
import { createDatabase, enqueueJob } from '../dist/database.js'
import { loadConfig } from '../dist/config.js'

const exec = promisify(execFile)
const postgresImage = 'postgres@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995'
let connectionString = process.env.PACK_CENTER_TEST_DATABASE_URL
let ownedContainer
const marker = `pack-center-db-test-${randomUUID()}`
const expectedMigrations = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => /^[0-9]{3}_[a-z0-9_]+\.sql$/.test(name)).sort()

before(async () => {
  if (!connectionString) {
    const password = randomBytes(32).toString('hex')
    const started = await exec('docker', ['run', '--detach', '--name', marker, '--label', `dsh.pack-center.test=${marker}`,
      '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=pack_center_test', postgresImage],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, timeout: 60000 })
    ownedContainer = started.stdout.trim()
    assert.match(ownedContainer, /^[a-f0-9]{64}$/)
    const inspected = await exec('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', ownedContainer])
    const port = inspected.stdout.trim()
    assert.match(port, /^[0-9]+$/)
    connectionString = `postgresql://postgres:${password}@127.0.0.1:${port}/pack_center_test`
    process.stdout.write(`# Isolated PostgreSQL container: ${ownedContainer}; image: ${postgresImage}\n`)
  }
  const ready = createDatabase({ connectionString, schema: `pc_ready_${randomBytes(6).toString('hex')}` })
  try {
    let connected = false
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await ready.query('SELECT 1'); connected = true; break } catch { await setTimeout(250) }
    }
    assert.equal(connected, true, 'Dedicated test database must be reachable; no in-memory fallback')
    const version = await ready.query('SHOW server_version')
    process.stdout.write(`# PostgreSQL server_version: ${version.rows[0].server_version}\n`)
  } finally { await ready.close() }
})

after(async () => {
  if (!ownedContainer) return
  const inspected = await exec('docker', ['inspect', '--format', '{{ index .Config.Labels "dsh.pack-center.test" }}', ownedContainer])
  assert.equal(inspected.stdout.trim(), marker, 'Cleanup may touch only the exact container created by this test')
  await exec('docker', ['rm', '--force', '--volumes', ownedContainer])
  process.stdout.write(`# Removed owned test container and its anonymous database volume: ${ownedContainer}\n`)
})

async function database(t, options = {}) {
  const schema = `pc_test_${randomBytes(10).toString('hex')}`
  const db = createDatabase({ connectionString, schema, maxConnections: 10 })
  t.after(async () => {
    try { await db.query(`DROP SCHEMA "${schema}" CASCADE`) } finally { await db.close() }
  })
  if (options.migrate !== false) await db.migrate()
  return db
}
const sqlError = code => error => { assert.equal(error.code, code); return true }
const digest = character => character.repeat(64)

async function principals(db) {
  await db.query(`INSERT INTO organizations(id,slug,name) VALUES ('org-a','org-a','A'),('org-b','org-b','B')`)
  await db.query(`INSERT INTO users(id,oidc_issuer,oidc_subject,display_name) VALUES
    ('author','https://identity.example','author','Developer'),('reviewer','https://identity.example','reviewer','Reviewer'),
    ('reviewer-two','https://identity.example','reviewer-two','Other Reviewer')`)
  await db.query(`INSERT INTO memberships(organization_id,user_id,roles) VALUES ('org-a','author',ARRAY['member'])`)
  await db.query(`INSERT INTO packages(pack_id,owner_org_id,created_by,name) VALUES ('org-a.demo','org-a','author','Demo')`)
}
async function pendingSubmission(db, id = 'submission-one', version = '1.0.0') {
  await db.query(`INSERT INTO submissions(id,owner_org_id,pack_id,author_id,version,source_url,source_ref,distribution)
    VALUES ($1,'org-a','org-a.demo','author',$2,'https://git.example/demo.git','main','{"kind":"organization"}')`, [id, version])
  await db.query(`UPDATE submissions SET status='validating',state_version=2 WHERE id=$1`, [id])
  const snapshotId = `snapshot-${id}`
  await db.query(`INSERT INTO submission_snapshots(id,submission_id,source_commit,artifact_sha256,content_tree_sha256,report_sha256,
    artifact_key,report_key,validator_version,normalization_version,pack_schema_version,size_bytes,file_count,report)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'1.0.0',1,2,2048,2,'{"valid":true}')`,
  [snapshotId, id, 'a'.repeat(40), digest('b'), digest('c'), digest('d'), `artifacts/${id}.tar`, `reports/${id}.json`])
  await db.query(`UPDATE submissions SET status='validated',snapshot_id=$2,state_version=3 WHERE id=$1`, [id, snapshotId])
  await db.query(`UPDATE submissions SET status='pending_review',state_version=4 WHERE id=$1`, [id])
  return { id, snapshotId, version }
}
async function approve(db, submission, reviewerId = 'reviewer') {
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO reviews(id,submission_id,snapshot_id,reviewer_id,decision,expected_state_version,content_tree_sha256,comment)
      VALUES ($1,$2,$3,$4,'approved',4,$5,'Reviewed fixed snapshot')`,
    [randomUUID(), submission.id, submission.snapshotId, reviewerId, digest('c')])
    await tx.query(`UPDATE submissions SET status='approved',state_version=5 WHERE id=$1`, [submission.id])
  })
}
async function publishingRelease(db, submission, id = 'release-one') {
  await db.query(`INSERT INTO releases(id,pack_id,owner_org_id,version,approved_submission_id,snapshot_id)
    VALUES ($1,'org-a.demo','org-a',$2,$3,$4)`, [id, submission.version, submission.id, submission.snapshotId])
}

test('configuration requires an independent identity, dedicated DB schema and secure public origin', () => {
  const env = { PACK_CENTER_DATABASE_URL: 'postgresql://test:password@127.0.0.1/db', PACK_CENTER_ID: 'test-center', PACK_CENTER_PUBLIC_ORIGIN: 'https://packs.example' }
  assert.equal(loadConfig(env).database.schema, 'pack_center')
  assert.equal(loadConfig({ ...env, PACK_CENTER_PUBLIC_ORIGIN: 'http://127.0.0.1:4310' }).listenPort, 4310)
  for (const change of [
    { PACK_CENTER_DATABASE_SCHEMA: 'public' }, { PACK_CENTER_DATABASE_SCHEMA: 'x; DROP DATABASE db' },
    { PACK_CENTER_DATABASE_URL: 'https://database.example' }, { PACK_CENTER_PUBLIC_ORIGIN: 'http://packs.example' },
    { PACK_CENTER_PUBLIC_ORIGIN: 'https://secret@packs.example' }, { PACK_CENTER_LISTEN_PORT: '0' },
    { PACK_CENTER_ID: 'c'.repeat(65) },
  ]) assert.throws(() => loadConfig({ ...env, ...change }))
})

test('migrations apply transactionally, are concurrent-idempotent and detect changed history', async t => {
  const db = await database(t, { migrate: false })
  assert.deepEqual((await Promise.all([db.migrate(), db.migrate()])).flat(), expectedMigrations)
  assert.deepEqual(await Promise.all([db.migrate(), db.migrate()]), [[], []])
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM schema_migrations')).rows[0].count, expectedMigrations.length)
  assert.ok((await db.query(`SELECT count(*)::integer AS count FROM information_schema.tables WHERE table_schema=$1`, [db.schema])).rows[0].count >= 23)
  await db.query(`UPDATE schema_migrations SET sha256=$1`, [digest('f')])
  await assert.rejects(db.migrate(), sqlError('MIGRATION_MISMATCH'))
})

test('a failed migration leaves neither its partial table nor the newly-created schema', async t => {
  const schema = `pc_bad_${randomBytes(10).toString('hex')}`
  const db = createDatabase({ connectionString, schema })
  t.after(() => db.close())
  const directory = await mkdtemp(join(tmpdir(), 'pack-center-bad-migration-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, '001_invalid.sql'), 'CREATE TABLE partial_table(id text); SELECT absent_function_for_test();')
  await assert.rejects(db.migrate(directory), sqlError('42883'))
  assert.equal((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0)
})

test('service startup validates migration completeness and hashes without applying changes', async t => {
  const db = await database(t)
  await db.verifyMigrations()
  const count = (await db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n
  await db.query('DELETE FROM schema_migrations WHERE name=$1', [expectedMigrations.at(-1)])
  await assert.rejects(db.verifyMigrations(), { code: 'MIGRATIONS_PENDING' })
  assert.equal((await db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, count - 1)
  const other = await database(t)
  await other.query("UPDATE schema_migrations SET sha256=repeat('0',64) WHERE name=$1", [expectedMigrations[0]])
  await assert.rejects(other.verifyMigrations(), { code: 'MIGRATION_MISMATCH' })
})

test('connection URL startup options cannot redirect normal queries to a different schema', async t => {
  const original = await database(t)
  const url = new URL(connectionString)
  url.searchParams.set('options', '-c search_path=public')
  const db = createDatabase({ connectionString: url.href, schema: original.schema })
  t.after(() => db.close())
  assert.equal((await db.query('SELECT current_schema() AS schema')).rows[0].schema, original.schema)
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM schema_migrations')).rows[0].count, expectedMigrations.length)
})

test('business state and jobs roll back together, while identity and ownership remain database-enforced', async t => {
  const db = await database(t)
  await principals(db)
  await assert.rejects(db.transaction(async tx => {
    await tx.query(`UPDATE organizations SET name='Not committed' WHERE id='org-a'`)
    await enqueueJob(tx, { kind: 'validate_submission', idempotencyKey: 'rollback', payload: { submissionId: 'missing' } })
    throw new Error('deliberate rollback')
  }), /deliberate rollback/)
  assert.equal((await db.query(`SELECT name FROM organizations WHERE id='org-a'`)).rows[0].name, 'A')
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM jobs')).rows[0].count, 0)
  await assert.rejects(db.query(`INSERT INTO users(id,oidc_issuer,oidc_subject,display_name) VALUES ('duplicate','https://identity.example','author','Duplicate')`), sqlError('23505'))
  await db.query(`INSERT INTO users(id,oidc_issuer,oidc_subject,display_name) VALUES ('separate-issuer','https://other.example','author','Separate issuer')`)
  await assert.rejects(db.query(`UPDATE packages SET owner_org_id='org-b' WHERE pack_id='org-a.demo'`), sqlError('23514'))
  await assert.rejects(db.query(`INSERT INTO submissions(id,owner_org_id,pack_id,author_id,version,source_url,source_ref,distribution)
    VALUES ('foreign-owner','org-b','org-a.demo','author','1.0.0','https://git.example/repo.git','main','{"kind":"organization"}')`), sqlError('23503'))
})

test('snapshots/source are immutable, self-review is refused, and concurrent reviewers commit once', async t => {
  const db = await database(t); await principals(db)
  const submission = await pendingSubmission(db)
  await assert.rejects(db.query(`UPDATE submission_snapshots SET artifact_key='other' WHERE id=$1`, [submission.snapshotId]), sqlError('23514'))
  await assert.rejects(db.query(`DELETE FROM submission_snapshots WHERE id=$1`, [submission.snapshotId]), sqlError('23514'))
  await assert.rejects(db.query(`UPDATE submissions SET source_ref='moved',state_version=5 WHERE id=$1`, [submission.id]), sqlError('23514'))
  await assert.rejects(approve(db, submission, 'author'), sqlError('23514'))
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM reviews')).rows[0].count, 0)
  const reviewed = await Promise.allSettled([approve(db, submission), approve(db, submission, 'reviewer-two')])
  assert.equal(reviewed.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM reviews')).rows[0].count, 1)
  assert.equal((await db.query('SELECT status FROM submissions WHERE id=$1', [submission.id])).rows[0].status, 'approved')
})

test('releases require reviewed bytes, preserve full version uniqueness and immutable signed content after yank', async t => {
  const db = await database(t); await principals(db)
  const first = await pendingSubmission(db)
  await assert.rejects(publishingRelease(db, first), sqlError('23514'))
  await approve(db, first); await publishingRelease(db, first)
  await db.query(`UPDATE releases SET signed_manifest='{"manifest":{"version":"1.0.0"},"signature":"fixture"}',status='published',published_at=clock_timestamp(),state_version=2 WHERE id='release-one'`)
  await assert.rejects(db.query(`UPDATE releases SET signed_manifest='{}',state_version=3 WHERE id='release-one'`), sqlError('23514'))
  const duplicate = await pendingSubmission(db, 'submission-duplicate')
  await approve(db, duplicate)
  await assert.rejects(publishingRelease(db, duplicate, 'release-duplicate'), error => {
    assert.equal(error.code, '23505'); assert.equal(error.constraint, 'releases_pack_id_version_key'); return true
  })
  const metadataVersion = await pendingSubmission(db, 'submission-metadata', '1.0.0+build.1')
  await approve(db, metadataVersion); await publishingRelease(db, metadataVersion, 'release-metadata')
  await db.query(`UPDATE releases SET status='yanked',state_version=3,yank_reason='Test retirement',yanked_at=clock_timestamp() WHERE id='release-one'`)
  await assert.rejects(db.query(`UPDATE releases SET status='published',state_version=4 WHERE id='release-one'`), sqlError('23514'))
  await assert.rejects(db.query(`DELETE FROM releases WHERE id='release-one'`), sqlError('23514'))
})

test('deployment credentials cannot gain human roles and audit records cannot be overwritten', async t => {
  const db = await database(t); await principals(db)
  await db.query(`INSERT INTO deployments(id,organization_id,name,created_by) VALUES ('site-a','org-a','Site A','author')`)
  await assert.rejects(db.query(`INSERT INTO deployment_credentials(id,deployment_id,token_sha256,scopes) VALUES ('token-a','site-a',$1,ARRAY['review:write'])`, [digest('b')]), sqlError('23514'))
  await db.query(`INSERT INTO deployment_credentials(id,deployment_id,token_sha256) VALUES ('token-a','site-a',$1)`, [digest('b')])
  await db.query(`INSERT INTO audit_events(actor_kind,actor_id,action,object_kind,object_id,outcome) VALUES ('system','test-worker','validated','submission','one','succeeded')`)
  await assert.rejects(db.query(`UPDATE audit_events SET action='replaced'`), sqlError('23514'))
  await assert.rejects(db.query('DELETE FROM audit_events'), sqlError('23514'))
})

test('concurrent job enqueue is idempotent and claimers use one exclusive lease', async t => {
  const db = await database(t)
  const input = { kind: 'validate_submission', idempotencyKey: 'one-work-item', payload: { submissionId: 'submission-one' } }
  const enqueued = await Promise.all([db.enqueueJob(input), db.enqueueJob(input), db.enqueueJob(input)])
  assert.equal(new Set(enqueued.map(result => result.job.id)).size, 1)
  assert.equal(enqueued.filter(result => !result.replayed).length, 1)
  await assert.rejects(db.enqueueJob({ ...input, payload: { submissionId: 'different' } }), sqlError('IDEMPOTENCY_CONFLICT'))
  const claimed = await Promise.all(Array.from({ length: 8 }, (_, index) => db.claimJob(`worker-${index}`)))
  assert.equal(claimed.filter(Boolean).length, 1)
  const lease = claimed.find(Boolean)
  assert.equal(lease.attempt, 1)
  await db.completeJob(lease, { validated: true })
  await assert.rejects(db.completeJob(lease, { validated: true }), sqlError('LEASE_LOST'))
  assert.equal(await db.claimJob('another-worker'), undefined)
})

test('expired worker cannot renew/write back; reclaim gets a new fence and durable attempt history', async t => {
  const db = await database(t)
  await db.enqueueJob({ kind: 'publish_release', idempotencyKey: 'recover', payload: { releaseId: 'release-one' }, maxAttempts: 2 })
  const first = await db.claimJob('worker-first', { kinds: ['publish_release'] })
  await db.query(`UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [first.id])
  await assert.rejects(db.renewJob(first), sqlError('LEASE_LOST'))
  const second = await db.claimJob('worker-second', { kinds: ['publish_release'] })
  assert.equal(second.id, first.id); assert.equal(second.attempt, 2); assert.notEqual(second.leaseToken, first.leaseToken)
  await assert.rejects(db.completeJob(first), sqlError('LEASE_LOST'))
  await db.renewJob(second)
  await db.completeJob(second, { published: true })
  assert.deepEqual((await db.query('SELECT outcome FROM job_attempts ORDER BY attempt')).rows.map(row => row.outcome), ['lease_expired', 'succeeded'])
})

test('fenced completion rolls back business writes if the lease expires during the transaction', async t => {
  const db = await database(t); await principals(db)
  await db.enqueueJob({ kind: 'validate_submission', idempotencyKey: 'fenced', payload: { submissionId: 's' } })
  const lease = await db.claimJob('worker')
  await assert.rejects(db.withJobTransaction(lease, async tx => {
    await tx.query(`UPDATE organizations SET name='Uncommitted' WHERE id='org-a'`)
    await tx.query(`UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [lease.id])
    return { changed: true }
  }), sqlError('LEASE_LOST'))
  assert.equal((await db.query(`SELECT name FROM organizations WHERE id='org-a'`)).rows[0].name, 'A')
  const done = await db.withJobTransaction(lease, async tx => {
    await tx.query(`UPDATE organizations SET name='Committed' WHERE id='org-a'`)
    return { changed: true }
  })
  assert.deepEqual(done, { changed: true })
  assert.equal((await db.query(`SELECT name FROM organizations WHERE id='org-a'`)).rows[0].name, 'Committed')
})

test('retry exhaustion and a last-attempt crash become terminal instead of permanently running', async t => {
  const db = await database(t)
  await db.enqueueJob({ kind: 'validate_submission', idempotencyKey: 'retry', payload: {}, maxAttempts: 2 })
  const first = await db.claimJob('worker')
  assert.equal((await db.failJob(first, { code: 'TEST_FAILURE', message: 'Controlled test failure' }, { retry: true, delayMs: 0 })).status, 'queued')
  const second = await db.claimJob('worker')
  assert.equal((await db.failJob(second, { code: 'TEST_FAILURE', message: 'Controlled test failure' }, { retry: true, delayMs: 0 })).status, 'failed')
  await db.enqueueJob({ kind: 'publish_release', idempotencyKey: 'crash', payload: {}, maxAttempts: 1 })
  const crashed = await db.claimJob('crashed-worker')
  await db.query(`UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [crashed.id])
  assert.equal(await db.claimJob('replacement-worker'), undefined)
  const row = (await db.query('SELECT status,error_code FROM jobs WHERE id=$1', [crashed.id])).rows[0]
  assert.deepEqual(row, { status: 'failed', error_code: 'LEASE_EXPIRED' })
})

test('a job committed by an independent Node process is recovered by a new database client', async t => {
  const db = await database(t)
  const moduleUrl = new URL('../dist/database.js', import.meta.url).href
  await exec(process.execPath, ['--input-type=module', '-e', `
    const { createDatabase } = await import(${JSON.stringify(moduleUrl)});
    const db = createDatabase({ connectionString: process.env.PACK_CENTER_TEST_DATABASE_URL, schema: process.env.PACK_CENTER_TEST_SCHEMA });
    try { await db.enqueueJob({kind:'validate_submission',idempotencyKey:'child-process',payload:{submissionId:'from-child'}}); }
    finally { await db.close(); }
  `], { env: { ...process.env, PACK_CENTER_TEST_DATABASE_URL: connectionString, PACK_CENTER_TEST_SCHEMA: db.schema }, timeout: 20000 })
  const lease = await db.claimJob('parent-worker')
  assert.deepEqual(lease.payload, { submissionId: 'from-child' })
  await db.completeJob(lease)
})
