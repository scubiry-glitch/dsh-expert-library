import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { qualityPublicationFixture } from './support/quality-publication-fixture.mjs'
import { FINDING_SEVERITIES, REVIEW_VERDICTS, integrateQualityRun, reviewQualityRun, validateAcceptanceResults } from '../lib/quality-run.js'
import { assertDurableQualityRun } from '../lib/quality-runtime.js'

function reviewArgs(overrides = {}) {
  return {
    task_id: 't1', event_id: 'review-t1-negative', reviewer: 'reviewer', verdict: 'needs_revision',
    acceptance_results: [{ id: 'present', passed: false, detail: 'Required conclusion is absent' }],
    findings: [{ id: 'missing-conclusion', code: 'missing-section', severity: 'hard', message: 'Add the required conclusion', taskId: 't1', attempt: 1 }],
    ...overrides,
  }
}

test('status exposes the live review contract and current publication bindings without bypassing acceptance or stale-evidence gates', async t => {
  const f = await qualityPublicationFixture(t)
  const initial = await f.read()
  initial.tasks[0].planTask = { logicalId: 'logical-report', fanOutIndex: 0 }
  initial.qualityRuns.t1.contract.acceptance = [
    { id: 'output-present', statement: 'The actual output is reviewable' },
    { id: 'profile-acceptance-1', statement: 'The required conclusion is supported' },
    { id: 'profile-acceptance-2', statement: 'Every cited value has a source' },
  ]
  initial.qualityRun = structuredClone(initial.qualityRuns.t1)
  await f.write(initial)
  assert.equal((await f.call('status', {}, 'reviewer')).tasks[0].review_contract, null, 'active unfinished work stays concise')
  const first = await f.publish('First review version')
  const latest = await f.publish('Latest review version with references')
  const waiting = await f.read()
  waiting.tasks[0].executionState = 'awaiting_review'
  await f.write(waiting)
  const snapshot = await f.call('status', {}, 'reviewer')
  const contract = snapshot.tasks[0].review_contract
  const durable = (await f.read()).qualityRuns.t1
  assert.deepEqual(contract.acceptance, durable.contract.acceptance)
  assert.equal(contract.task_id, 't1')
  assert.equal(contract.attempt, durable.attempt)
  assert.equal(snapshot.tasks[0].plan_logical_id, 'logical-report')
  assert.equal(contract.published_artifacts.length, 1, 'only the current version is offered for this deliverable')
  assert.deepEqual(contract.published_artifacts[0], {
    review_artifact_id: latest.review_artifact_id, artifact_id: latest.artifact_id,
    path: latest.path, attempt: latest.attempt, sha256: latest.sha256,
    versionPath: join(f.stateRoot, latest.path),
  })
  assert.notEqual(latest.artifact_id, latest.review_artifact_id)
  assert.notEqual(first.path, latest.path)
  const falseResults = contract.acceptance.map(item => ({ id: item.id, passed: false }))
  assert.doesNotThrow(() => validateAcceptanceResults(durable.contract, falseResults), 'the discovered ID set satisfies the real complete-set validator')
  const args = { task_id: contract.task_id, event_id: 'review-discovered-inputs', reviewer: 'reviewer', verdict: 'pass', acceptance_results: falseResults }
  await assert.rejects(f.call('quality_review', args, 'reviewer'), error => error.code === 'acceptance_failed')
  assert.equal((await f.read()).qualityRuns.t1.status, 'pending', 'discoverable inputs never imply acceptance')
  const truth = contract.acceptance.map(item => ({ id: item.id, passed: true }))
  await assert.rejects(f.call('quality_review', { ...args, acceptance_results: truth, artifacts: [{ id: latest.review_artifact_id, path: first.path }] }, 'reviewer'), error => {
    assert.match(error.message, /PUBLISHED_EVIDENCE_MISMATCH/)
    assert.ok(error.message.includes(latest.path))
    assert.ok(error.message.includes(`attempt ${latest.attempt}`))
    return true
  })
  await assert.rejects(f.call('quality_review', { ...args, acceptance_results: [{ id: 'invented-id', passed: true }] }, 'reviewer'), error => {
    assert.equal(error.code, 'acceptance_unknown')
    assert.ok(contract.acceptance.every(item => error.message.includes(item.id) && error.message.includes(item.statement)))
    return true
  })
  const reviewed = await f.call('quality_review', { ...args, acceptance_results: truth }, 'reviewer')
  assert.equal(reviewed.status, 'passed', 'valid exact inputs still pass through real evidence collection')
  await f.call('quality_integrate', { task_id: 't1', event_id: 'integrate-discovered-inputs', actor: 'captain', complete_task: true }, 'captain')
  assert.equal((await f.call('status', {}, 'reviewer')).tasks[0].review_contract, null, 'integrated tasks no longer repeat the full contract')
})

test('repair status excludes prior-attempt publications and review still requires republishing', async t => {
  const f = await qualityPublicationFixture(t)
  const old = await f.publish('Rejected attempt-one evidence')
  await f.call('quality_review', reviewArgs(), 'reviewer')
  await f.call('quality_repair', { task_id: 't1', event_id: 'repair-discovered-contract', actor: 'captain' }, 'captain')
  const snapshot = await f.call('status', {}, 'reviewer')
  const contract = snapshot.tasks[0].review_contract
  assert.equal(contract.attempt, 2)
  assert.equal(contract.status, 'repairing')
  assert.deepEqual(contract.published_artifacts, [])
  assert.ok(contract.missing_publications.includes(old.review_artifact_id))
  await assert.rejects(f.call('quality_review', {
    task_id: 't1', event_id: 'review-stale-publication', reviewer: 'reviewer', verdict: 'pass',
    acceptance_results: contract.acceptance.map(item => ({ id: item.id, passed: true })),
  }, 'reviewer'), /PUBLISHED_ARTIFACT_MISSING|QUALITY_ATTEMPT_MISMATCH/)
  assert.equal((await f.read()).qualityRuns.t1.status, 'repairing')
})

test('registered review schema advertises real enums and rejects invalid metadata before verification', async t => {
  const f = await qualityPublicationFixture(t, { verify: ['node -e "require(\'fs\').appendFileSync(\'verification-count\', \'x\')"'] })
  const schema = f.registered.get('expert_teams_quality_review').parameters
  assert.deepEqual(schema.properties.verdict.enum, [...REVIEW_VERDICTS])
  assert.deepEqual(schema.properties.findings.items.properties.severity.enum, [...FINDING_SEVERITIES])
  const before = await f.read()
  for (const severity of ['major', 'blocker', 'error', 'high']) {
    const input = reviewArgs()
    input.findings[0].severity = severity
    await assert.rejects(f.call('quality_review', input, 'reviewer'), /findings.*severity.*(?:info|soft|hard)/)
  }
  await assert.rejects(f.call('quality_review', reviewArgs({ verdict: 'approved' }), 'reviewer'), /verdict/)
  const stale = reviewArgs(); stale.findings[0].attempt = 0
  await assert.rejects(f.call('quality_review', stale, 'reviewer'), /different task\/attempt/)
  await assert.rejects(f.call('quality_review', reviewArgs({ acceptance_results: [] }), 'reviewer'), /acceptance_results/)
  await assert.rejects(readFile(join(f.stateRoot, 'verification-count')), error => error.code === 'ENOENT')
  assert.deepEqual(await f.read(), before)
})

for (const verdict of ['needs_revision', 'reject']) {
  test(`${verdict} durably retains false acceptance and actual exit 7; exact tool retry does not execute verification again`, async t => {
    const f = await qualityPublicationFixture(t, { verify: ['node -e "require(\'fs\').appendFileSync(\'verification-count\', \'x\'); process.exit(7)"'] })
    const args = reviewArgs({ verdict })
    const result = await f.call('quality_review', args, 'reviewer')
    assert.equal(result.status, 'blocked')
    assert.match(result.next_action, /quality_repair/)
    const persisted = await f.read()
    const run = persisted.qualityRuns.t1
    assert.doesNotThrow(() => assertDurableQualityRun(run))
    assert.equal(run.latestEvidence.acceptanceResults[0].passed, false)
    assert.equal(run.latestEvidence.commandsRun[0].exitCode, 7)
    assert.equal(run.latestEvidence.commandsRun[0].passed, false)
    assert.equal(run.findings[0].severity, 'hard')
    assert.equal(persisted.tasks[0].executionState, 'awaiting_review')
    assert.equal(persisted.tasks[0].attemptId, 'publication-attempt-1')
    assert.equal(run.events.filter(event => event.type === 'review').length, 1)
    const replay = await f.call('quality_review', args, 'reviewer')
    assert.equal(replay.status, 'blocked')
    assert.deepEqual(await f.read(), persisted)
    assert.equal(await readFile(join(f.stateRoot, 'verification-count'), 'utf8'), 'x')
    await assert.rejects(f.call('quality_review', reviewArgs({ verdict, acceptance_results: [{ id: 'present', passed: true }] }), 'reviewer'), /idempotency|different evidence inputs/)
    await assert.rejects(f.call('quality_integrate', { task_id: 't1', event_id: 'integrate-negative', actor: 'captain', complete_task: true }, 'captain'), /requires a passed review/)
    assert.deepEqual(await f.read(), persisted)
  })
}

test('negative evidence remains subject to integrity, identity and pass/integration guards', async t => {
  const f = await qualityPublicationFixture(t)
  await f.call('quality_review', reviewArgs(), 'reviewer')
  const blocked = (await f.read()).qualityRuns.t1
  const pending = { ...blocked, status: 'pending', reviewRounds: 0, events: [], evidenceHistory: [], latestEvidence: undefined, lastVerdict: undefined, findings: [], contractFrozenAt: undefined }
  const evidence = blocked.latestEvidence
  const input = { eventId: 'review-t1-negative', reviewer: 'reviewer', verdict: 'reject', findings: blocked.findings, evidence }
  for (const [changed, code] of [
    [{ ...evidence, acceptanceResults: [] }, 'evidence_missing'],
    [{ ...evidence, artifacts: [{ ...evidence.artifacts[0], sha256: '0'.repeat(64) }] }, 'artifact_hash_mismatch'],
    [{ ...evidence, attempt: 0 }, 'stale_attempt'],
    [{ ...evidence, commandsRun: [{ command: 'true', exitCode: 7, passed: true }] }, 'verification_invalid'],
  ]) assert.throws(() => reviewQualityRun(pending, { ...input, evidence: changed }), error => error.code === code)
  assert.throws(() => reviewQualityRun(pending, { ...input, reviewer: 'worker' }), error => error.code === 'reviewer_is_assignee')
  assert.throws(() => reviewQualityRun(pending, { ...input, verdict: 'pass', findings: [] }), error => error.code === 'acceptance_failed')
  assert.throws(() => integrateQualityRun({ ...blocked, status: 'passed', lastVerdict: 'pass' }, { eventId: 'integrate-forged-pass', actor: 'captain' }), error => error.code === 'acceptance_failed')
  const failedCommand = { ...evidence, acceptanceResults: [{ id: 'present', passed: true }], commandsRun: [{ command: 'true', exitCode: 7, passed: false }] }
  assert.throws(() => reviewQualityRun(pending, { ...input, verdict: 'pass', findings: [], evidence: failedCommand }), error => error.code === 'verification_failed')
})

test('completion errors explain operation IDs and the same-attempt owner transition without changing state', async t => {
  const f = await qualityPublicationFixture(t)
  const initial = await f.read()
  initial.tasks[0].status = 'claimed'
  await f.write(initial)
  const passed = await f.review('review-t1-pass')
  assert.match(passed.next_action, /owner worker.*same attempt to in_progress/)
  const reviewed = await f.read()
  await assert.rejects(f.call('quality_integrate', { task_id: 't1', event_id: 'review-t1-pass', actor: 'captain', complete_task: true }, 'captain'), /new integration event_id/)
  await assert.rejects(f.call('quality_integrate', { task_id: 't1', event_id: 'integrate-t1-pass', actor: 'captain', complete_task: true }, 'captain'), /QUALITY_COMPLETION_PRECONDITION.*same attempt_id/)
  await assert.rejects(f.call('update_task', { task_id: 't1', status: 'completed', execution_state: 'awaiting_review', attempt_id: 'publication-attempt-1' }, 'worker'), /Omit execution_state/)
  await assert.rejects(f.call('update_task', { task_id: 't1', status: 'completed', attempt_id: 'publication-attempt-1' }, 'worker'), /QUALITY_REVIEW_REQUIRED.*new integration event_id/)
  assert.deepEqual(await f.read(), reviewed)
  await f.call('update_task', { task_id: 't1', status: 'in_progress', attempt_id: 'publication-attempt-1' }, 'worker')
  const integrated = await f.call('quality_integrate', { task_id: 't1', event_id: 'integrate-t1-pass', actor: 'captain', complete_task: true }, 'captain')
  assert.equal(integrated.status, 'integrated')
  assert.equal(integrated.task_status, 'completed')
  const replay = await f.call('quality_integrate', { task_id: 't1', event_id: 'integrate-t1-pass', actor: 'captain', complete_task: true }, 'captain')
  assert.equal(replay.status, 'integrated')
  const final = await f.read()
  assert.equal(final.tasks[0].attempt, 1)
  assert.equal(final.tasks[0].finalizedAttemptId, 'publication-attempt-1')
  assert.equal(final.qualityRuns.t1.events.filter(event => event.type === 'integration').length, 1)
})

test('only the authenticated captain may create and claim captain-owned follow-up work', async t => {
  const f = await qualityPublicationFixture(t)
  const task = await f.call('create_task', { subject: 'Captain follow-up', assignee: 'captain' }, 'captain')
  assert.equal(task.assignee, 'captain')
  await assert.rejects(f.call('claim_task', { task_id: task.task_id, assignee: 'captain' }, 'worker'), /members cannot set assignee/)
  const claimed = await f.call('claim_task', { task_id: task.task_id, assignee: 'captain' }, 'captain')
  assert.equal(claimed.assignee, 'captain')
  assert.equal(claimed.status, 'claimed')
  assert.ok(claimed.attempt_id)
  assert.equal((await f.read()).tasks.find(item => item.id === task.task_id).attempt, 1)
})

test('explicit runtime resume resolves only the selected session and preserves independent review waiting', async t => {
  const f = await qualityPublicationFixture(t)
  const team = await f.read()
  const block = (sessionId, id) => ({ id, sessionId, turn: 1, code: 'QUOTA', status: 402, message: 'quota exhausted', at: 1 })
  team.members[0].runtimeBlock = block('worker-id', 'runtime:worker-id:1')
  team.members[1].runtimeBlock = block('reviewer-id', 'reviewer-block')
  team.captainRuntimeBlock = block('captain-id', 'captain-block')
  team.tasks[0].executionState = 'awaiting_review'
  team.tasks[0].waitReason = 'Independent review required'
  await f.write(team)
  await assert.rejects(f.call('resume_member', { member: 'worker', reason: 'Quota restored', expected_block_id: 'worker-id:1' }, 'captain'), error => {
    assert.match(error.message, /RUNTIME_BLOCK_STALE/)
    assert.match(error.message, /runtime_block.id="runtime:worker-id:1"/)
    return true
  })
  assert.equal((await f.read()).members[0].runtimeBlock.id, 'runtime:worker-id:1')
  await assert.rejects(f.call('resume_member', { member: 'worker', reason: 'Quota restored' }, 'reviewer'), /captain|team/i)
  const resumed = await f.call('resume_member', { member: 'worker', reason: 'Quota restored', expected_block_id: 'runtime:worker-id:1' }, 'captain')
  assert.equal(resumed.resumed, true)
  const after = await f.read()
  assert.equal(after.members[0].runtimeBlock, undefined)
  assert.equal(after.members[1].runtimeBlock.id, 'reviewer-block')
  assert.equal(after.captainRuntimeBlock.id, 'captain-block')
  assert.equal(after.tasks[0].executionState, 'awaiting_review')
  assert.equal(after.tasks[0].attemptId, 'publication-attempt-1')
})


test('ordinary reviews reject craft-only fields before running verification and recover with ordinary arguments', async t => {
  const f = await qualityPublicationFixture(t, { verify: ['node -e "require(\'fs\').appendFileSync(\'verification-count\', \'x\')"'] })
  const before = await f.read()
  const normal = { task_id: 't1', event_id: 'ordinary-review', reviewer: 'reviewer', verdict: 'pass', acceptance_results: [{ id: 'present', passed: true }] }
  for (const fields of [{ independent_review: [] }, { material_receipt: 'invented' }, { prepare_only: true }]) {
    const args = fields.prepare_only ? { task_id: 't1', reviewer: 'reviewer', ...fields } : { ...normal, ...fields }
    await assert.rejects(f.call('quality_review', args, 'reviewer'), /CRAFT_REVIEW_NOT_APPLICABLE.*Omit/)
    assert.deepEqual(await f.read(), before)
  }
  await assert.rejects(readFile(join(f.stateRoot, 'verification-count')), error => error.code === 'ENOENT')
  await f.publish('Ordinary reviewed deliverable')
  assert.equal((await f.call('quality_review', normal, 'reviewer')).status, 'passed')
  assert.equal(await readFile(join(f.stateRoot, 'verification-count'), 'utf8'), 'x')
})
