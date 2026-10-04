import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { qualityPublicationFixture } from './support/quality-publication-fixture.mjs'
import { createTaskProject, publishTaskArtifact, writeTaskProjectOutput } from '../lib/state.js'
import { prepareDependencyInputs } from '../lib/dependency-inputs.js'
import { createQualityRun, reviewQualityRun, integrateQualityRun } from '../lib/quality-run.js'

const repairArgs = { task_id: 't1', event_id: 'repair-original', actor: 'captain' }
async function rejectCurrent(f, eventId = 'review-original') {
  const run = (await f.read()).qualityRuns.t1
  return f.call('quality_review', { task_id: 't1', event_id: eventId, reviewer: 'reviewer', verdict: 'needs_revision',
    acceptance_results: [{ id: 'present', passed: false }], findings: [{ id: `${eventId}-finding`, code: 'CORRECT', severity: 'hard',
      message: 'The fixture output requires correction', taskId: 't1', attempt: run.attempt }] }, 'reviewer')
}
async function fullSlots(t) {
  const f = await qualityPublicationFixture(t)
  const team = await f.read()
  for (const name of ['busy-one', 'busy-two']) team.members.push({ id: `${name}-id`, name, status: 'working', joinedAt: 1,
    activation: { id: `${name}-reservation`, sessionId: `${name}-id`, reservedAt: Date.now(), acceptedAt: Date.now(), taskAttempts: [] } })
  await f.write(team)
  await rejectCurrent(f)
  const accepted = await f.call('quality_repair', repairArgs, 'captain')
  const saved = await f.read()
  assert.equal(saved.tasks[0].status, 'pending')
  assert.equal(saved.tasks[0].attempt, 1)
  assert.equal(saved.tasks[0].attemptId, undefined)
  assert.equal(saved.qualityRuns.t1.attempt, 2)
  assert.equal(saved.qualityRuns.t1.repairRounds, 1)
  return { ...f, accepted }
}
async function pinBlocked(t) {
  const f = await qualityPublicationFixture(t)
  const team = await f.read(), task = team.tasks[0]
  const source = { id: 't0', subject: 'Reviewed upstream source', status: 'completed', assignee: 'captain', attempt: 1,
    dependencies: [], createdAt: 1, updatedAt: 1 }
  source.project = await createTaskProject(f.stateRoot, team.id, source)
  const content = 'immutable source fixture'
  const artifact = await publishTaskArtifact(f.stateRoot, team, source, { name: 'source.txt', content })
  source.publishedArtifacts = [artifact]
  const path = `${team.id}/${source.project.artifactsPath}/${artifact.relativePath}`
  const run = createQualityRun({ id: 'source-contract', taskId: source.id, attempt: 1, assignee: 'captain', kind: 'implementation',
    objective: source.subject, inScope: [`${team.id}/**`], acceptance: [{ id: 'source', statement: 'Source checked' }],
    verify: ['true'], deliverables: [artifact.reviewId], changedPaths: [`${team.id}/**`] })
  team.qualityRuns.t0 = integrateQualityRun(reviewQualityRun(run, { eventId: 'source-review', reviewer: 'reviewer', verdict: 'pass',
    evidence: { taskId: source.id, attempt: 1, artifacts: [{ id: artifact.reviewId, taskId: source.id, attempt: 1, path, sha256: artifact.sha256, content }],
      acceptanceResults: [{ id: 'source', passed: true }], commandsRun: [{ command: 'true', exitCode: 0, passed: true }], changedPaths: [path] } }).run,
  { eventId: 'source-integrate', actor: 'captain' }).run
  team.tasks.push(source); team.taskSeq = 2
  task.dependencies = ['t0']; task.status = 'pending'
  await prepareDependencyInputs(f.stateRoot, team, task, 1)
  task.status = 'in_progress'
  await f.write(team)
  await rejectCurrent(f)
  const versionPath = join(f.stateRoot, path)
  await writeFile(versionPath, 'corrupt bytes')
  const accepted = await f.call('quality_repair', repairArgs, 'captain')
  const saved = await f.read()
  assert.equal(saved.tasks[0].status, 'pending')
  assert.equal(saved.tasks[0].attempt, 1)
  assert.equal(saved.tasks[0].executionState, 'blocked_external')
  assert.match(saved.tasks[0].waitReason, /INPUT_ARTIFACT_BLOCKED/)
  assert.equal(saved.tasks[0].inputArtifactBinding.consumerAttempt, 2)
  return { ...f, accepted, versionPath, content }
}

test('exact applied repair replays while all slots are full without writes, resets or extra budget', async t => {
  const f = await fullSlots(t), before = await f.read()
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await f.call('quality_repair', repairArgs, 'captain'), f.accepted)
    assert.deepEqual(await f.read(), before)
  }
  // Freeing capacity without a scheduler event makes a kick observable. Exact
  // replay must not turn into a second dispatch of the original receipt.
  for (const member of before.members) if (member.name.startsWith('busy-')) delete member.activation
  await f.write(before)
  assert.deepEqual(await f.call('quality_repair', repairArgs, 'captain'), f.accepted)
  assert.deepEqual(await f.read(), before)
  await f.call('status', {}, 'captain')
  assert.equal((await f.read()).tasks[0].attempt, 2, 'an actual scheduler kick, unlike a replay, admits the ready generation')
})

test('exact repair replay preserves a corrupt-pin blocker and frozen manifest even after bytes are restored', async t => {
  const f = await pinBlocked(t), before = await f.read()
  assert.deepEqual(await f.call('quality_repair', repairArgs, 'captain'), f.accepted)
  assert.deepEqual(await f.read(), before)
  await writeFile(f.versionPath, f.content)
  assert.deepEqual(await f.call('quality_repair', repairArgs, 'captain'), f.accepted)
  assert.deepEqual(await f.read(), before, 'retrying a receipt cannot implicitly resume the blocked task')
  assert.equal(await readFile(f.versionPath, 'utf8'), f.content)
  await f.call('resume_task', { task_id: 't1', reason: 'Restored the exact immutable publication bytes' }, 'captain')
  const resumed = await f.read()
  assert.equal(resumed.tasks[0].attempt, 2)
  assert.deepEqual(resumed.tasks[0].inputArtifactManifest, before.tasks[0].inputArtifactManifest)
})

for (const conflict of ['actor', 'stored-actor', 'type', 'fingerprint', 'new-event']) test(`pre-claim repair replay does not authorize ${conflict} conflicts`, async t => {
  const f = await fullSlots(t)
  let args = { ...repairArgs }
  if (conflict === 'actor') args.actor = 'another-actor'
  if (conflict === 'type') args.event_id = 'review-original'
  if (conflict === 'new-event') args.event_id = 'new-repair'
  if (conflict === 'stored-actor') {
    const team = await f.read()
    team.qualityRuns.t1.events.find(event => event.id === repairArgs.event_id).actor = 'different-stored-actor'
    team.qualityRun = team.qualityRuns.t1
    await f.write(team)
  }
  if (conflict === 'fingerprint') {
    const team = await f.read()
    team.qualityRuns.t1.events.find(event => event.id === repairArgs.event_id).fingerprint = '0'.repeat(64)
    team.qualityRun = team.qualityRuns.t1
    await f.write(team)
  }
  const before = await f.read()
  await assert.rejects(f.call('quality_repair', args, 'captain'), error =>
    error.code === 'idempotency_conflict' || /QUALITY_ATTEMPT_MISMATCH/.test(error.message))
  assert.deepEqual(await f.read(), before)
})

for (const ownership of ['different-owner', 'reassigning']) test(`exact receipt cannot authorize a ${ownership} task`, async t => {
  const f = await fullSlots(t), team = await f.read()
  if (ownership === 'different-owner') team.tasks[0].assignee = 'reviewer'
  else team.tasks[0].reassigning = true
  await f.write(team)
  await assert.rejects(f.call('quality_repair', repairArgs, 'captain'), /QUALITY_ATTEMPT_MISMATCH/)
  assert.deepEqual(await f.read(), team)
})

test('an archived repair receipt cannot be charged as a new repair in its replacement run', async t => {
  const f = await fullSlots(t)
  const claimed = await f.call('claim_task', { task_id: 't1' }, 'worker')
  await f.call('update_task', { task_id: 't1', attempt_id: claimed.attempt_id, status: 'in_progress', output: 'Corrected fixture', execution_state: 'awaiting_review' }, 'worker')
  const replacement = await f.call('quality_reopen', { task_id: 't1', event_id: 'withdraw-unreviewed', reason: 'Finish the local fixture before review' }, 'captain')
  assert.notEqual(replacement.runId, f.accepted.runId)
  await rejectCurrent(f, 'replacement-review')
  const before = await f.read()
  assert.equal(before.qualityRuns.t1.status, 'blocked')
  assert.equal(before.qualityRuns.t1.repairRounds, 0)
  assert.ok(before.qualityRunHistory.t1.some(run => run.events.some(event => event.id === repairArgs.event_id)))
  await assert.rejects(f.call('quality_repair', repairArgs, 'captain'), /STALE_QUALITY_EVENT|earlier quality run/i)
  assert.deepEqual(await f.read(), before)
  const next = await f.call('quality_repair', { ...repairArgs, event_id: 'replacement-new-repair' }, 'captain')
  assert.equal(next.attempt, 3)
  assert.equal(next.repair_rounds, 1)
})


test('an archived event on a different task does not make repair IDs team-global', async t => {
  const f = await qualityPublicationFixture(t), team = await f.read()
  const other = { ...team.tasks[0], id: 't2', assignee: 'captain', attemptId: 'other-attempt-1' }
  other.project = await createTaskProject(f.stateRoot, team.id, other)
  team.tasks.push(other); team.taskSeq = 2
  const scope = `${team.id}/${other.project.path}`
  team.qualityRuns.t2 = createQualityRun({ ...team.qualityRuns.t1.contract, id: 'other-contract', taskId: 't2', assignee: 'captain',
    inScope: [`${scope}/**`], changedPaths: [`${scope}/output/**`] }, 'other-run')
  await writeTaskProjectOutput(f.stateRoot, team.id, other)
  await f.write(team)
  await f.call('quality_review', { task_id: 't2', event_id: 'other-review', reviewer: 'reviewer', verdict: 'needs_revision',
    acceptance_results: [{ id: 'present', passed: false }], findings: [{ id: 'other-find', code: 'CORRECT', severity: 'hard',
      message: 'Correct other fixture', taskId: 't2', attempt: 1 }] }, 'reviewer')
  await f.call('quality_repair', { ...repairArgs, task_id: 't2' }, 'captain')
  await f.call('claim_task', { task_id: 't2' }, 'captain')
  await f.call('update_task', { task_id: 't2', status: 'in_progress', output: 'Other correction', execution_state: 'awaiting_review' }, 'captain')
  await f.call('quality_reopen', { task_id: 't2', event_id: 'other-withdraw', reason: 'Finish other fixture submission' }, 'captain')
  const afterOther = await f.read()
  assert.ok(afterOther.qualityRunHistory.t2.some(run => run.events.some(event => event.id === repairArgs.event_id)))
  await rejectCurrent(f)
  const accepted = await f.call('quality_repair', repairArgs, 'captain')
  assert.equal(accepted.attempt, 2)
  assert.equal(accepted.repair_rounds, 1)
  const after = await f.read()
  assert.deepEqual(after.qualityRuns.t2, afterOther.qualityRuns.t2)
  assert.deepEqual(after.qualityRunHistory.t2, afterOther.qualityRunHistory.t2)
})
