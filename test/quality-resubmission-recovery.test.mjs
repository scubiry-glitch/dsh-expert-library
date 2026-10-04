import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { qualityPublicationFixture } from './support/quality-publication-fixture.mjs'
import { createQualityRun, forkQualityRun, isQualityRun, reviewQualityRun, amendQualityRun } from '../lib/quality-run.js'
import { assertDurableQualityRun } from '../lib/quality-runtime.js'

async function repairedFixture(t) {
  const f = await qualityPublicationFixture(t)
  await f.publish('Rejected first report')
  await f.call('quality_review', {
    task_id: 't1', event_id: 'review-negative', reviewer: 'reviewer', verdict: 'needs_revision',
    acceptance_results: [{ id: 'present', passed: false }],
    findings: [{ id: 'f1', code: 'missing-conclusion', severity: 'hard', message: 'Add conclusion', taskId: 't1', attempt: 1 }],
  }, 'reviewer')
  await f.call('quality_repair', { task_id: 't1', event_id: 'repair-first', actor: 'captain' }, 'captain')
  const claim = await f.call('claim_task', { task_id: 't1' }, 'worker')
  await f.call('update_task', { task_id: 't1', attempt_id: claim.attempt_id, status: 'in_progress' }, 'worker')
  return f
}

async function publishCurrent(f, content) {
  const task = (await f.read()).tasks[0]
  await writeFile(join(f.teamRoot, task.project.path, 'artifacts/report.txt'), content)
  return f.call('publish_artifact', { task_id: 't1', attempt_id: task.attemptId,
    source_path: 'artifacts/report.txt', name: 'report.txt' }, 'worker')
}

test('a repaired task cannot submit awaiting_review using only prior-attempt publications', async t => {
  const f = await repairedFixture(t)
  const before = await f.read()
  const outputPath = join(f.teamRoot, before.tasks[0].project.outputPath)
  const outputBefore = await readFile(outputPath)
  await assert.rejects(f.call('update_task', {
    task_id: 't1', attempt_id: before.tasks[0].attemptId, status: 'in_progress',
    execution_state: 'awaiting_review', output: 'Premature replacement', wait_reason: 'review',
  }, 'worker'), /REVIEW_SUBMISSION_INCOMPLETE.*published:report.txt/)
  assert.deepEqual(await f.read(), before, 'failed preflight must not mutate task, review budget, or published references')
  assert.deepEqual(await readFile(outputPath), outputBefore, 'rejected submission must not overwrite the durable result')
  await publishCurrent(f, 'Corrected report with conclusion')
  const task = (await f.read()).tasks[0]
  await f.call('update_task', { task_id: 't1', attempt_id: task.attemptId, status: 'in_progress',
    execution_state: 'awaiting_review', output: 'Ready after publishing', wait_reason: 'review' }, 'worker')
  assert.equal((await f.read()).tasks[0].executionState, 'awaiting_review')
})

test('captain withdraws a legacy premature repair submission without extra budget, lost evidence, or stale wait', async t => {
  const f = await repairedFixture(t)
  const legacy = await f.read()
  const old = structuredClone(legacy.qualityRuns.t1)
  const attemptId = legacy.tasks[0].attemptId
  legacy.tasks[0].executionState = 'awaiting_review'
  legacy.runtimeWaits = { 'worker-id': { taskIds: ['t1'], since: Date.now(), reason: 'review' } }
  await f.write(legacy)
  const args = { task_id: 't1', event_id: 'withdraw-missing-publication', reason: 'Finish the required current-attempt publication' }
  await assert.rejects(f.call('quality_reopen', args, 'worker'), /not leading any team/)
  assert.deepEqual(await f.read(), legacy, 'unauthorized member cannot withdraw another review')
  await f.call('quality_reopen', args, 'captain')
  const reopened = await f.read()
  const run = reopened.qualityRuns.t1
  assert.notEqual(run.runId, old.runId, 'fresh review identity invalidates in-flight old review collection')
  assert.equal(run.attempt, 2)
  assert.equal(reopened.tasks[0].attemptId, attemptId)
  assert.equal(reopened.tasks[0].executionState, 'active')
  assert.equal(reopened.runtimeWaits?.['worker-id'], undefined)
  assert.equal(run.contract.maxRepairRounds, old.contract.maxRepairRounds - old.repairRounds)
  assert.equal(run.revision.budgetCharged, old.repairRounds)
  assert.equal(run.revision.withdrawUnreviewed, true)
  assert.equal(run.contractFrozenAt, old.contractFrozenAt)
  assert.ok(JSON.stringify(reopened.qualityRunHistory).includes('missing-conclusion'), 'negative evidence remains archived')
  assert.ok(isQualityRun(JSON.parse(JSON.stringify(run))))
  await f.call('quality_reopen', args, 'captain')
  assert.deepEqual((await f.read()).qualityRuns.t1, run, 'cold-compatible exact replay consumes no additional budget')
  await assert.rejects(f.call('quality_reopen', { ...args, reason: 'different operation' }, 'captain'), /different content/)
  await assert.rejects(f.call('quality_integrate', { task_id: 't1', event_id: 'integrate-before-review', actor: 'captain', complete_task: true }, 'captain'), /requires a passed review/)
  await publishCurrent(f, 'Corrected report after submission withdrawal')
  const task = (await f.read()).tasks[0]
  await f.call('update_task', { task_id: 't1', attempt_id: task.attemptId, status: 'in_progress',
    execution_state: 'awaiting_review', output: 'Corrected report', wait_reason: 'independent review' }, 'worker')
  await f.review('review-after-withdrawal')
  await f.call('quality_integrate', { task_id: 't1', event_id: 'integrate-after-withdrawal', actor: 'captain', complete_task: true }, 'captain')
  assert.equal((await f.read()).tasks[0].status, 'completed')
  await assert.rejects(f.call('quality_reopen', { ...args, event_id: 'reopen-completed' }, 'captain'), /follow-up task/)
})

test('withdrawal cannot alter a reviewed generation, consume a fresh repair, or unfreeze failed criteria', async t => {
  const f = await repairedFixture(t)
  const run = (await f.read()).qualityRuns.t1
  const args = { eventId: 'withdraw-pure', actor: 'captain', reason: 'Complete publication', assignee: 'worker', attempt: run.attempt, withdrawUnreviewed: true }
  const next = forkQualityRun(run, args).run
  assert.doesNotThrow(() => assertDurableQualityRun(JSON.parse(JSON.stringify(next))))
  assert.throws(() => assertDurableQualityRun({ ...next, revision: undefined }), /already contract frozen/)
  assert.equal(next.revision.budgetCharged, run.repairRounds)
  assert.throws(() => amendQualityRun(next, { eventId: 'remove-failed-check', actor: 'captain', reason: 'skip criterion',
    contract: { ...next.contract, verify: ['true'] } }), error => error.code === 'contract_frozen')
  assert.throws(() => forkQualityRun(run, { ...args, actor: 'worker' }), error => error.code === 'invalid_withdrawal')
  assert.throws(() => forkQualityRun(run, { ...args, attempt: run.attempt + 1 }), error => error.code === 'invalid_withdrawal')
  // Use the actual rejected evidence from the previous task generation.
  const evidence = run.latestEvidence
  const pending = createQualityRun({ ...run.contract, attempt: evidence.attempt }, 'pure-reviewed-parent')
  const blocked = reviewQualityRun(pending, { eventId: 'review-blocked', reviewer: 'reviewer', verdict: 'needs_revision',
    evidence, findings: run.findings }).run
  assert.throws(() => forkQualityRun(blocked, { ...args, attempt: blocked.attempt }), error => error.code === 'invalid_withdrawal')
  const escalated = { ...blocked, status: 'escalated' }
  assert.throws(() => forkQualityRun(escalated, { ...args, attempt: escalated.attempt }), error => error.code === 'repair_budget_exhausted')
  const fresh = createQualityRun({ ...run.contract, attempt: 1, maxRepairRounds: 0 }, 'never-reviewed')
  const withdrawn = forkQualityRun(fresh, { ...args, attempt: 1 }).run
  assert.equal(withdrawn.contract.maxRepairRounds, 0)
  assert.equal(withdrawn.revision.budgetCharged, 0)
  assert.ok(isQualityRun(withdrawn))
})

test('a captain withdrawal invalidates an already collecting review instead of accepting stale evidence', async t => {
  const verify = `node -e "const f=require('fs');f.writeFileSync('verify-started','1');const t=setInterval(()=>{if(f.existsSync('release-review'))clearInterval(t)},10)"`
  const f = await qualityPublicationFixture(t, { verify: [verify] })
  await f.publish('Submission before a necessary correction')
  const before = await f.read()
  await f.call('update_task', { task_id: 't1', attempt_id: before.tasks[0].attemptId, status: 'in_progress',
    execution_state: 'awaiting_review', wait_reason: 'independent review' }, 'worker')
  const oldReview = f.review('review-concurrent-with-withdrawal')
  oldReview.catch(() => undefined)
  try {
    let started = false
    for (let i = 0; i < 150; i++) {
      try { await readFile(join(f.stateRoot, 'verify-started')); started = true; break } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(started, true, 'review must actually be collecting evidence before the withdrawal')
    await f.call('quality_reopen', { task_id: 't1', event_id: 'withdraw-during-verification', reason: 'Correct the submission before review is committed' }, 'captain')
  } finally {
    await writeFile(join(f.stateRoot, 'release-review'), '1')
  }
  await assert.rejects(oldReview, /quality run changed while evidence was being collected/)
  const after = await f.read()
  assert.notEqual(after.qualityRuns.t1.runId, before.qualityRuns.t1.runId)
  assert.equal(after.qualityRuns.t1.status, 'pending')
  assert.equal(after.qualityRuns.t1.latestEvidence, undefined)
  assert.equal(after.tasks[0].executionState, 'active')
  assert.equal(after.qualityRuns.t1.contract.maxRepairRounds, before.qualityRuns.t1.contract.maxRepairRounds)
})
