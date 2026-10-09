/** Cross-module operation-key ordering against real PostgreSQL lock queues.
 * Principals originate from the local OIDC issuer; no SQL/proxy authorization or
 * lock implementation is substituted. Only fixed signed release fixtures are seeded. */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createSubmissionService } from '../dist/submissions.js'
import { createDatabaseFixture } from './support/database-fixture.mjs'
import { createTestIssuer } from './support/identity-fixture.mjs'
import { setupCatalog, seedCatalogRelease } from './support/catalog-fixture.mjs'

let fixture, provider
before(async () => { fixture = await createDatabaseFixture('operation-locks'); provider = await createTestIssuer() })
after(async () => { await provider?.close(); await fixture?.close() })
const settled = promise => promise.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', code: error.code }))
async function setup(t) {
  const c = await setupCatalog(t, fixture, provider)
  const release = await seedCatalogRelease(c)
  return { ...c, release, submissions: createSubmissionService(c.database, c.identity, { allowedGitHosts: ['unreachable.invalid'] }) }
}
async function holdOperation(c, operationKey) {
  const client = await c.database.pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [`human:${c.owner.userId}`, operationKey])
    const { pid } = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]
    let released = false
    return { pid, async release() {
      if (released) return
      released = true
      try { await client.query('ROLLBACK') } finally { client.release() }
    } }
  } catch (error) {
    try { await client.query('ROLLBACK') } finally { client.release() }
    throw error
  }
}
async function waiting(database, blockerPid, count) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const rows = (await database.query(`SELECT pid FROM pg_stat_activity
      WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock' AND wait_event='advisory'`, [blockerPid])).rows
    if (rows.length >= count) return rows.map(row => row.pid)
    await delay(20)
  }
  assert.fail(`Expected ${count} real operation-lock waiter(s); no row-lock shortcut is acceptable`)
}
async function assertBusinessRowsUnlocked(c) {
  await c.database.transaction(async tx => {
    const submission = await tx.query('SELECT id FROM submissions WHERE id=$1 FOR UPDATE NOWAIT', [c.release.manifest.approvedSubmissionId])
    const release = await tx.query('SELECT id FROM releases WHERE id=$1 FOR UPDATE NOWAIT', [c.release.id])
    const distribution = await tx.query('SELECT release_id FROM release_distribution WHERE release_id=$1 FOR UPDATE NOWAIT', [c.release.id])
    assert.equal(submission.rowCount, 1); assert.equal(release.rowCount, 1); assert.equal(distribution.rowCount, 1)
  })
}

test('publication retry waits for its operation key without retaining submission or release row locks', { timeout: 60000 }, async t => {
  const c = await setup(t), operationKey = randomUUID(), gate = await holdOperation(c, operationKey)
  const result = settled(c.submissions.retryPublication(c.owner, c.release.manifest.approvedSubmissionId, 2, operationKey))
  let outcome
  try {
    await waiting(c.database, gate.pid, 1)
    // The old row-first implementation reports 55P03 here. This transaction is
    // independent of both the held advisory transaction and the pending retry.
    await assertBusinessRowsUnlocked(c)
  } finally { await gate.release(); outcome = await result }
  assert.deepEqual(outcome, { status: 'rejected', code: 'INVALID_TRANSITION' })
  const row = (await c.database.query('SELECT status,state_version FROM releases WHERE id=$1', [c.release.id])).rows[0]
  assert.deepEqual(row, { status: 'published', state_version: 2 })
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM request_idempotency WHERE principal_key=$1 AND operation_key=$2',
    [`human:${c.owner.userId}`, operationKey])).rows[0].n, 0)
})

test('same actor/key governance and publication retry serialize with one success and one identity conflict, not a deadlock', { timeout: 60000 }, async t => {
  const c = await setup(t), operationKey = randomUUID(), gate = await holdOperation(c, operationKey)
  const governance = settled(c.governance.yank(c.owner, c.release.id, { expectedVersion: 2, reason: 'Ordered cross-module operation' }, operationKey))
  let retry, outcomes
  try {
    // Queue governance first, then retry. PostgreSQL's real advisory wait queue
    // establishes the order without timing-dependent Promise race assertions.
    await waiting(c.database, gate.pid, 1)
    retry = settled(c.submissions.retryPublication(c.owner, c.release.manifest.approvedSubmissionId, 2, operationKey))
    await waiting(c.database, gate.pid, 2)
    await assertBusinessRowsUnlocked(c)
  } finally {
    await gate.release()
    outcomes = await Promise.all([governance, ...(retry ? [retry] : [])])
  }
  assert.equal(outcomes.length, 2)
  assert.equal(outcomes[0].status, 'fulfilled')
  assert.equal(outcomes[0].value.status, 'yanked')
  assert.deepEqual(outcomes[1], { status: 'rejected', code: 'IDEMPOTENCY_CONFLICT' })
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM request_idempotency WHERE principal_key=$1 AND operation_key=$2',
    [`human:${c.owner.userId}`, operationKey])).rows[0].n, 1)
  assert.equal((await c.database.query("SELECT count(*)::int AS n FROM audit_events WHERE action='release.yanked' AND object_id=$1", [c.release.id])).rows[0].n, 1)
  const row = (await c.database.query('SELECT signed_manifest,state_version FROM releases WHERE id=$1', [c.release.id])).rows[0]
  assert.equal(row.state_version, 3); assert.deepEqual(row.signed_manifest, c.release.signed)
})

test('waiting cross-module retries recheck live authorization before reading an existing idempotency result', { timeout: 60000 }, async t => {
  const c = await setup(t), operationKey = randomUUID()
  const input = { expectedVersion: 1, scope: { kind: 'authenticated' }, reason: 'Existing reviewed-scope request' }
  const original = await c.governance.requestDistribution(c.owner, c.release.id, input, operationKey)
  const gate = await holdOperation(c, operationKey)
  const governance = settled(c.governance.requestDistribution(c.owner, c.release.id, input, operationKey))
  let retry, outcomes
  try {
    await waiting(c.database, gate.pid, 1)
    retry = settled(c.submissions.retryPublication(c.owner, c.release.manifest.approvedSubmissionId, 2, operationKey))
    await waiting(c.database, gate.pid, 2)
    await assertBusinessRowsUnlocked(c)
    // Keep a valid invited session but revoke only the permission needed by the
    // governance operation (tenant admin). Neither queued request may use
    // authority captured before wait; retry authorization now follows the pack
    // ownership axis, which the demotion does not touch.
    await c.identity.setMembership(c.admin, { organizationId: 'demo', userId: c.owner.userId, roles: ['member'], status: 'active' })
  } finally {
    await gate.release()
    outcomes = await Promise.all([governance, ...(retry ? [retry] : [])])
  }
  // Governance rechecks live tenant-admin authority and denies the demoted
  // admin. Retry rechecks live pack ownership, then hits the same key already
  // used by a different operation: IDEMPOTENCY_CONFLICT, never cached authority.
  assert.deepEqual(outcomes, [{ status: 'rejected', code: 'FORBIDDEN' }, { status: 'rejected', code: 'IDEMPOTENCY_CONFLICT' }])
  const records = (await c.database.query('SELECT result FROM request_idempotency WHERE principal_key=$1 AND operation_key=$2',
    [`human:${c.owner.userId}`, operationKey])).rows
  assert.equal(records.length, 1); assert.deepEqual(records[0].result, original)
  assert.equal((await c.database.query('SELECT count(*)::int AS n FROM distribution_reviews WHERE release_id=$1', [c.release.id])).rows[0].n, 1)
})
