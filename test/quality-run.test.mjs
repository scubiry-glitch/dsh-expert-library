/** Structured A4 quality-run state-machine tests. Runs against built lib/. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  createQualityContract,
  createQualityRun,
  hasQualityEvent,
  integrateQualityRun,
  QualityRunError,
  requestQualityRepair,
  reviewQualityRun,
  validateTaskEvidence,
} from '../lib/quality-run.js'

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function contract(overrides = {}) {
  return createQualityContract({
    id: 'contract-report',
    taskId: 'task-report',
    attempt: 1,
    assignee: 'worker',
    kind: 'implementation',
    objective: 'produce the report artifact',
    inScope: ['src/**'],
    outOfScope: ['secrets/**'],
    acceptance: [{ id: 'a1', statement: 'report has a conclusion' }],
    verify: ['node verify-report.mjs'],
    deliverables: ['report'],
    changedPaths: ['src/report.md'],
    maxRepairRounds: 2,
    ...overrides,
  })
}

function evidence(attempt, overrides = {}) {
  const content = overrides.content ?? 'Conclusion: stable'
  return {
    taskId: 'task-report',
    attempt,
    artifacts: [{
      id: 'report',
      taskId: 'task-report',
      attempt,
      path: 'src/report.md',
      content,
      sha256: overrides.sha256 ?? sha256(content),
    }],
    acceptanceResults: [{ id: 'a1', passed: true }],
    commandsRun: [{ command: 'node verify-report.mjs', exitCode: 0, passed: true }],
    changedPaths: ['src/report.md'],
    ...overrides,
  }
}

function finding(run, severity = 'hard', id = `finding-${run.reviewRounds + 1}`) {
  return {
    id,
    code: 'missing-section',
    severity,
    message: 'the report is missing a required section',
    taskId: run.contract.taskId,
    attempt: run.attempt,
  }
}

function review(run, eventId, verdict = 'pass', findings = []) {
  return reviewQualityRun(run, {
    eventId,
    reviewer: 'reviewer',
    verdict,
    findings,
    evidence: evidence(run.attempt),
    at: 1000 + run.reviewRounds,
  })
}

test('contract and evidence are structured before a review can pass', () => {
  const run = createQualityRun(contract(), 'run-1')
  assert.equal(run.status, 'pending')
  assert.equal(run.attempt, 1)
  assert.deepEqual(run.contract.deliverables, ['report'])
  assert.doesNotThrow(() => validateTaskEvidence(run.contract, evidence(1), 1))
  assert.throws(
    () => validateTaskEvidence(run.contract, evidence(1, { sha256: '0'.repeat(64) }), 1),
    (error) => error instanceof QualityRunError && error.code === 'artifact_hash_mismatch',
  )
})

test('reviewer cannot be the assignee and a failed review keeps integration locked', () => {
  const run = createQualityRun(contract(), 'run-reviewer')
  assert.throws(
    () => reviewQualityRun(run, {
      eventId: 'review-self', reviewer: 'worker', verdict: 'reject', findings: [finding(run)], evidence: evidence(1),
    }),
    (error) => error instanceof QualityRunError && error.code === 'reviewer_is_assignee',
  )
  const rejected = review(run, 'review-1', 'needs_revision', [finding(run)])
  assert.equal(rejected.run.status, 'blocked')
  assert.throws(
    () => integrateQualityRun(rejected.run, { eventId: 'integrate-too-early', actor: 'captain' }),
    (error) => error instanceof QualityRunError && error.code === 'integration_blocked',
  )
})

test('soft findings may pass, and integration is idempotent across replay', () => {
  const run = createQualityRun(contract(), 'run-soft')
  const passed = review(run, 'review-soft', 'pass', [finding(run, 'soft', 'style-warning')])
  assert.equal(passed.run.status, 'passed')
  assert.equal(passed.run.findings[0].severity, 'soft')
  const integrated = integrateQualityRun(passed.run, { eventId: 'integrate-1', actor: 'captain', at: 2000 })
  assert.equal(integrated.run.status, 'integrated')
  const replay = integrateQualityRun(integrated.run, { eventId: 'integrate-1', actor: 'captain', at: 2000 })
  assert.equal(replay.applied, false)
  assert.deepEqual(replay.run, integrated.run)
})

test('hard review failure creates bounded repair generations and then passes', () => {
  let run = createQualityRun(contract(), 'run-repair')
  run = review(run, 'review-1', 'needs_revision', [finding(run)]).run
  assert.equal(run.status, 'blocked')
  run = requestQualityRepair(run, { eventId: 'repair-1', actor: 'captain', at: 1100 }).run
  assert.equal(run.status, 'repairing')
  assert.equal(run.repairRounds, 1)
  assert.equal(run.attempt, 2)
  // A stale artifact from attempt 1 cannot be reviewed for attempt 2.
  assert.throws(
    () => reviewQualityRun(run, {
      eventId: 'review-stale', reviewer: 'reviewer', verdict: 'pass', evidence: evidence(1),
    }),
    (error) => error instanceof QualityRunError && error.code === 'stale_attempt',
  )
  run = review(run, 'review-2', 'needs_revision', [finding(run, 'hard', 'finding-2')]).run
  run = requestQualityRepair(run, { eventId: 'repair-2', actor: 'captain', at: 1200 }).run
  assert.equal(run.repairRounds, 2)
  assert.equal(run.attempt, 3)
  run = review(run, 'review-3', 'pass').run
  assert.equal(run.status, 'passed')
  assert.equal(run.reviewRounds, 3)
  assert.equal(integrateQualityRun(run, { eventId: 'integrate-repair', actor: 'captain' }).run.status, 'integrated')
})

test('third failed review escalates instead of silently exceeding two repair rounds', () => {
  let run = createQualityRun(contract(), 'run-escalate')
  run = review(run, 'review-1', 'reject', [finding(run)]).run
  run = requestQualityRepair(run, { eventId: 'repair-1', actor: 'captain' }).run
  run = review(run, 'review-2', 'reject', [finding(run, 'hard', 'finding-2')]).run
  run = requestQualityRepair(run, { eventId: 'repair-2', actor: 'captain' }).run
  run = review(run, 'review-3', 'reject', [finding(run, 'hard', 'finding-3')]).run
  assert.equal(run.status, 'escalated')
  assert.equal(run.repairRounds, 2)
  assert.throws(
    () => requestQualityRepair(run, { eventId: 'repair-3', actor: 'captain' }),
    (error) => error instanceof QualityRunError && error.code === 'invalid_transition',
  )
  assert.throws(
    () => integrateQualityRun(run, { eventId: 'integrate-escalated', actor: 'captain' }),
    (error) => error instanceof QualityRunError && error.code === 'integration_blocked',
  )
})

test('quality policy cannot raise the repair budget above the design cap', () => {
  assert.throws(
    () => createQualityContract(contract({ maxRepairRounds: 3 })),
    (error) => error instanceof QualityRunError && error.code === 'invalid_contract',
  )
  let run = createQualityRun(contract({ maxRepairRounds: 0 }), 'run-no-repair')
  run = review(run, 'review-no-repair', 'reject', [finding(run)]).run
  assert.equal(run.status, 'escalated')
})

test('missing artifacts, hash mismatch and changed paths are hard evidence failures', () => {
  const run = createQualityRun(contract(), 'run-evidence')
  // Make the actual failure modes explicit rather than relying on reviewer prose.
  assert.throws(
    () => reviewQualityRun(run, {
      eventId: 'review-missing-artifact', reviewer: 'reviewer', verdict: 'pass', evidence: evidence(1, { artifacts: [] }),
    }),
    (error) => error instanceof QualityRunError && error.code === 'artifact_missing',
  )
  assert.throws(
    () => reviewQualityRun(run, {
      eventId: 'review-bad-hash', reviewer: 'reviewer', verdict: 'pass', evidence: evidence(1, { sha256: 'f'.repeat(64) }),
    }),
    (error) => error instanceof QualityRunError && error.code === 'artifact_hash_mismatch',
  )
  assert.throws(
    () => reviewQualityRun(run, {
      eventId: 'review-outside', reviewer: 'reviewer', verdict: 'pass', evidence: {
        ...evidence(1), changedPaths: ['secrets/key'], artifacts: [{ ...evidence(1).artifacts[0], path: 'secrets/key' }],
      },
    }),
    (error) => error instanceof QualityRunError && error.code === 'path_out_of_scope',
  )
})

test('event ids make duplicate reviews safe after a JSON restart', () => {
  const first = review(createQualityRun(contract(), 'run-restart'), 'review-1', 'pass')
  const restored = JSON.parse(JSON.stringify(first.run))
  assert.equal(hasQualityEvent(restored, 'review-1'), true)
  const replay = reviewQualityRun(restored, {
    eventId: 'review-1', reviewer: 'reviewer', verdict: 'pass', evidence: evidence(1), at: 1000,
  })
  assert.equal(replay.applied, false)
  assert.deepEqual(replay.run, restored)
})
