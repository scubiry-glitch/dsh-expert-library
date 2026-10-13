import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { qualityPublicationFixture } from './support/quality-publication-fixture.mjs'
import { shouldAutoRetryTask } from '../lib/scheduler.js'

const rejection = {
  task_id: 't1', event_id: 'review-t1-exhausted', reviewer: 'reviewer', verdict: 'reject',
  acceptance_results: [{ id: 'present', passed: false, detail: 'Source structure is incomplete' }],
  findings: [{ id: 'source-structure', code: 'missing-source-section', severity: 'hard',
    message: 'Repair the source contract before rendering', taskId: 't1', attempt: 1 }],
}

test('captain closes an exhausted review without losing evidence or unlocking downstream work', async t => {
  const f = await qualityPublicationFixture(t)
  const initial = await f.read()
  initial.qualityRuns.t1.contract.maxRepairRounds = 0
  initial.qualityRun.contract.maxRepairRounds = 0
  initial.tasks.push({ id: 't2', subject: 'Render follow-up', status: 'pending', assignee: 'reviewer',
    dependencies: ['t1'], createdAt: 1, updatedAt: 1 })
  await f.write(initial)
  const reviewed = await f.call('quality_review', rejection, 'reviewer')
  assert.equal(reviewed.status, 'escalated')
  const before = await f.read()
  assert.equal(before.tasks[0].executionState, 'awaiting_review')
  assert.equal((await f.call('status', {}, 'captain')).tasks[0].current_action.kind, 'closeout')
  await assert.rejects(f.call('quality_closeout', { task_id: 't1', event_id: 'close-1', reason: 'Repair source' }, 'worker'), /not leading any team/)
  await assert.rejects(f.call('remove_member', { name: 'worker' }, 'captain'), /QUALITY_ESCALATED_CLOSEOUT_REQUIRED/)
  await assert.rejects(f.call('update_task', { task_id: 't1', status: 'failed', attempt_id: 'publication-attempt-1' }, 'worker'), /QUALITY_ESCALATED_CLOSEOUT_REQUIRED/)
  assert.deepEqual(await f.read(), before)

  const request = { task_id: 't1', event_id: 'close-1', reason: 'Correct the source structure in a reviewed follow-up task' }
  const closed = await f.call('quality_closeout', request, 'captain')
  assert.equal(closed.task_status, 'failed')
  const after = await f.read()
  assert.equal(after.tasks[0].status, 'failed')
  assert.equal(after.tasks[0].output, before.tasks[0].output)
  assert.equal(after.tasks[0].attemptId, undefined)
  assert.equal(after.tasks[0].qualityCloseout.runId, before.qualityRuns.t1.runId)
  assert.equal(shouldAutoRetryTask(after.tasks[0]), false)
  assert.deepEqual(after.qualityRuns.t1, before.qualityRuns.t1)
  assert.equal((await f.call('status', {}, 'captain')).tasks[0].quality_closeout.eventId, 'close-1')
  assert.equal(after.tasks[1].status, 'pending')
  await assert.rejects(f.call('claim_task', { task_id: 't2' }, 'reviewer'), /blocked by unfinished dependencies/)
  assert.deepEqual(await f.call('quality_closeout', request, 'captain'), closed)
  assert.deepEqual(await f.read(), after)
  await assert.rejects(f.call('quality_closeout', { ...request, event_id: 'close-2' }, 'captain'), /QUALITY_CLOSEOUT_CONFLICT/)
  const removed = await f.call('remove_member', { name: 'worker' }, 'captain')
  assert.deepEqual(removed.requeued_tasks, [])
  assert.equal((await f.read()).tasks[0].status, 'failed')
})

test('archiving a team preserves failed closeout status and evidence', async t => {
  const f = await qualityPublicationFixture(t)
  const initial = await f.read()
  initial.qualityRuns.t1.contract.maxRepairRounds = 0
  initial.qualityRun.contract.maxRepairRounds = 0
  await f.write(initial)
  await f.call('quality_review', rejection, 'reviewer')
  await f.call('quality_closeout', { task_id: 't1', event_id: 'close-before-archive', reason: 'Repair in a new approved plan' }, 'captain')
  await f.call('delete', {}, 'captain')
  const archived = JSON.parse(await readFile(join(f.stateRoot, 'archive', 'publication-admission', 'team.json'), 'utf8'))
  assert.equal(archived.tasks[0].status, 'failed')
  assert.equal(archived.tasks[0].qualityCloseout.eventId, 'close-before-archive')
  assert.equal(archived.qualityRuns.t1.status, 'escalated')
})

test('orphaned pending escalation cannot be claimed and remains closeable by captain', async t => {
  const f = await qualityPublicationFixture(t)
  const initial = await f.read()
  initial.qualityRuns.t1.contract.maxRepairRounds = 0
  initial.qualityRun.contract.maxRepairRounds = 0
  await f.write(initial)
  await f.call('quality_review', rejection, 'reviewer')
  const stale = await f.read()
  stale.tasks[0].status = 'pending'
  stale.tasks[0].executionState = undefined
  stale.tasks[0].attemptId = undefined
  await f.write(stale)
  await assert.rejects(f.call('claim_task', { task_id: 't1' }, 'worker'), /QUALITY_ESCALATED_CLOSEOUT_REQUIRED/)
  const closed = await f.call('quality_closeout', { task_id: 't1', event_id: 'close-orphan', reason: 'Preserve rejected attempt' }, 'captain')
  assert.equal(closed.task_status, 'failed')
})
