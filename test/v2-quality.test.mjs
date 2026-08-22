/**
 * Phase 4 `quality-runtime` regression tests: deterministic gate ordering,
 * hard-fail delivery prevention, targeted repair capped at 2 rounds, and
 * location/evidence/artifact-hash reporting.
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { runQualityChain, orderGates, MAX_REPAIR_ROUNDS, hashArtifact } from '../lib/v2/index.js'

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const FIXED_NOW = '2026-08-01T00:00:00.000Z'
const now = () => () => FIXED_NOW

/** Compiled gate chain from an ExecutionPlan (structure → data → semantic). */
function compiledGates() {
  return [
    { id: 'quality-1/schema', kind: 'deterministic', phase: 'structure', chainOrder: 0, policyId: 'quality-1', policyVersion: '1.0.0', gateId: 'schema', severity: 'hard', appliesTo: ['t3'] },
    { id: 'quality-1/data', kind: 'deterministic', phase: 'data', chainOrder: 1, policyId: 'quality-1', policyVersion: '1.0.0', gateId: 'data', severity: 'hard', appliesTo: ['t3'] },
    { id: 'quality-1/semantic', kind: 'semantic', phase: 'semantic', chainOrder: 2, policyId: 'quality-1', policyVersion: '1.0.0', gateId: 'semantic', severity: 'soft', appliesTo: ['t3'] },
  ]
}

const pass = (gateId) => (input, ctx) => ({ gateId, status: 'pass', issues: [], evaluatedAt: ctx.now() })

const fail = (gateId, code = 'hard-fail', location = 't3', evidence = 'bad number', correction = 'repair t3') =>
  (input, ctx) => ({
    gateId,
    status: 'fail',
    issues: [{ code, severity: 'error', location, evidence, correction }],
    evaluatedAt: ctx.now(),
  })

const warn = (gateId) => (input, ctx) => ({
  gateId,
  status: 'warn',
  issues: [{ code: 'soft-issue', severity: 'warning', location: 't3', evidence: 'warn me' }],
  evaluatedAt: ctx.now(),
})

const allPass = () => ({
  schema: pass('schema'),
  data: pass('data'),
  semantic: pass('semantic'),
})

const artifacts = (overrides = {}) => ({ t3: { content: '## 结论\n上海市场回暖。' }, ...overrides })

test('MAX_REPAIR_ROUNDS design cap is 2', () => {
  assert.equal(MAX_REPAIR_ROUNDS, 2)
})

test('all-pass chain delivers with outcome pass', () => {
  const result = runQualityChain({
    gates: compiledGates(),
    evaluators: allPass(),
    artifacts: artifacts(),
    now: now(),
    planId: 'ep-abc',
  })
  assert.equal(result.outcome, 'pass')
  assert.equal(result.deliverableAllowed, true)
  assert.equal(result.planId, 'ep-abc')
  assert.equal(result.rounds.length, 1)
  assert.equal(result.rounds[0].status, 'pass')
  assert.equal(result.repairRoundsUsed, 0)
  assert.equal(result.summary.totalGates, 3)
  assert.equal(result.summary.failed, 0)
  assert.equal(result.evaluatedAt, FIXED_NOW)
})

test('soft failure warns but still allows delivery', () => {
  const result = runQualityChain({
    gates: compiledGates(),
    evaluators: { schema: pass('schema'), data: pass('data'), semantic: warn('semantic') },
    artifacts: artifacts(),
    now: now(),
  })
  assert.equal(result.outcome, 'warn')
  assert.equal(result.deliverableAllowed, true)
  assert.equal(result.summary.warned, 1)
  assert.equal(result.rounds[0].failures.length, 0)
})

test('hard fail without a repair callback blocks delivery', () => {
  const result = runQualityChain({
    gates: compiledGates(),
    evaluators: { schema: pass('schema'), data: fail('data'), semantic: pass('semantic') },
    artifacts: artifacts(),
    now: now(),
  })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.deliverableAllowed, false)
  assert.equal(result.summary.failed, 1)
  const failure = result.rounds[0].failures[0]
  assert.equal(failure.gateId, 'data')
  assert.equal(failure.severity, 'hard')
  assert.deepEqual(failure.affectedArtifacts, ['t3'])
  // Location / evidence / correction are reported for targeted repair.
  assert.equal(failure.issues[0].location, 't3')
  assert.equal(failure.issues[0].evidence, 'bad number')
  assert.equal(failure.issues[0].correction, 'repair t3')
})

test('targeted repair fixes only the failing gate, then re-runs the chain', () => {
  let repairCalls = 0
  const repair = (request) => {
    repairCalls++
    assert.equal(request.round, 1)
    assert.equal(request.maxRounds, 2)
    // Targeted: only the hard-failing gate is handed over.
    assert.deepEqual(request.failures.map(f => f.gateId), ['data'])
    assert.deepEqual(request.failures[0].affectedArtifacts, ['t3'])
    assert.equal(request.artifacts.t3.content, artifacts().t3.content)
    return { repaired: true, replacements: { t3: request.artifacts.t3.content + '\n# fixed' } }
  }
  const result = runQualityChain({
    gates: compiledGates(),
    evaluators: {
      schema: pass('schema'),
      data: (input, ctx) => (input.artifact.includes('# fixed') ? pass('data')(input, ctx) : fail('data')(input, ctx)),
      semantic: pass('semantic'),
    },
    artifacts: artifacts(),
    repair,
    now: now(),
  })
  assert.equal(result.outcome, 'repaired-pass')
  assert.equal(result.deliverableAllowed, true)
  assert.equal(repairCalls, 1)
  assert.equal(result.repairRoundsUsed, 1)
  assert.equal(result.rounds.length, 2)
  assert.equal(result.rounds[1].status, 'pass')
})

test('repair loop is capped at 2 rounds, then blocked (no endless self-edit)', () => {
  const roundsSeen = []
  const repair = (request) => {
    roundsSeen.push(request.round)
    return { repaired: true, replacements: { t3: request.artifacts.t3.content + '\n# more' } }
  }
  const result = runQualityChain({
    gates: compiledGates(),
    evaluators: { schema: pass('schema'), data: fail('data'), semantic: pass('semantic') },
    artifacts: artifacts(),
    repair,
    now: now(),
  })
  assert.equal(result.outcome, 'blocked')
  assert.equal(result.deliverableAllowed, false)
  assert.deepEqual(roundsSeen, [1, 2])
  assert.equal(result.repairRoundsUsed, 2)
  assert.equal(result.rounds.length, 3) // initial + 2 repair rounds + final failing round
  assert.equal(result.summary.maxRepairRounds, 2)
})

test('caller maxRepairRounds is capped at the design cap of 2', () => {
  let calls = 0
  const result = runQualityChain({
    gates: compiledGates(),
    evaluators: { schema: pass('schema'), data: fail('data'), semantic: pass('semantic') },
    artifacts: artifacts(),
    repair: () => { calls++; return { repaired: true, replacements: { t3: 'x' } } },
    maxRepairRounds: 99,
    now: now(),
  })
  assert.equal(result.outcome, 'blocked')
  assert.equal(result.deliverableAllowed, false)
  assert.equal(calls, 2)
  assert.equal(result.maxRepairRounds, 2)
})

test('declining repair blocks delivery as failed', () => {
  const result = runQualityChain({
    gates: compiledGates(),
    evaluators: { schema: pass('schema'), data: fail('data'), semantic: pass('semantic') },
    artifacts: artifacts(),
    repair: () => ({ repaired: false, reason: 'cannot fix without data source' }),
    now: now(),
  })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.deliverableAllowed, false)
})

test('soft fails that persist after repair yield repaired-warn and still deliver', () => {
  const result = runQualityChain({
    gates: compiledGates(),
    evaluators: {
      schema: pass('schema'),
      data: (input, ctx) => (input.artifact.includes('# fixed') ? pass('data')(input, ctx) : fail('data')(input, ctx)),
      semantic: warn('semantic'),
    },
    artifacts: artifacts(),
    repair: (request) => ({ repaired: true, replacements: { t3: request.artifacts.t3.content + '\n# fixed' } }),
    now: now(),
  })
  assert.equal(result.outcome, 'repaired-warn')
  assert.equal(result.deliverableAllowed, true)
  assert.equal(result.repairRoundsUsed, 1)
})

test('gates execute in deterministic chain order', () => {
  const order = []
  const recording = (gateId) => (input, ctx) => {
    order.push(gateId)
    return pass(gateId)(input, ctx)
  }
  const result = runQualityChain({
    gates: compiledGates(),
    evaluators: { schema: recording('schema'), data: recording('data'), semantic: recording('semantic') },
    artifacts: artifacts(),
    now: now(),
  })
  assert.equal(result.outcome, 'pass')
  assert.deepEqual(order, ['schema', 'data', 'semantic'])
})

test('a missing evaluator for a hard gate fails it and blocks delivery', () => {
  const result = runQualityChain({
    gates: compiledGates(),
    evaluators: { schema: pass('schema'), semantic: pass('semantic') }, // data missing
    artifacts: artifacts(),
    now: now(),
  })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.deliverableAllowed, false)
  const dataResult = result.rounds[0].results[1]
  assert.equal(dataResult.gateId, 'data')
  assert.equal(dataResult.status, 'fail')
  assert.equal(dataResult.issues[0].code, 'gate-evaluator-missing')
})

test('report carries final artifact hashes and per-gate artifact hashes', () => {
  const result = runQualityChain({
    gates: compiledGates(),
    evaluators: allPass(),
    artifacts: artifacts(),
    now: now(),
  })
  const content = artifacts().t3.content
  assert.equal(result.artifactHashes.t3, sha256(content))
  assert.equal(result.artifactHashes.t3, hashArtifact(content))
  // The evaluator input receives the hash of the artifact it evaluates.
  assert.equal(result.rounds[0].results[0].artifactHashes.t3, sha256(content))
})

test('hashes are recomputed over the repaired artifact', () => {
  const result = runQualityChain({
    gates: compiledGates(),
    evaluators: {
      schema: pass('schema'),
      data: (input, ctx) => (input.artifact.includes('# fixed') ? pass('data')(input, ctx) : fail('data')(input, ctx)),
      semantic: pass('semantic'),
    },
    artifacts: artifacts(),
    repair: (request) => ({ repaired: true, replacements: { t3: request.artifacts.t3.content + '\n# fixed' } }),
    now: now(),
  })
  assert.equal(result.outcome, 'repaired-pass')
  assert.equal(result.artifactHashes.t3, sha256(artifacts().t3.content + '\n# fixed'))
})

test('deliverable targets compose task artifacts deterministically', () => {
  const gates = [{ id: 'quality-1/schema', kind: 'deterministic', phase: 'structure', chainOrder: 0, policyId: 'quality-1', policyVersion: '1.0.0', gateId: 'schema', severity: 'hard', appliesTo: ['deliverable'] }]
  let seen = null
  const result = runQualityChain({
    gates,
    evaluators: {
      schema: (input, ctx) => {
        seen = { deliverableId: input.deliverableId, artifact: input.artifact }
        return pass('schema')(input, ctx)
      },
    },
    artifacts: { t1: { content: 'A' }, t2: { content: 'B' } },
    deliverableSources: { d1: ['t1', 't2'] },
    now: now(),
  })
  assert.equal(result.outcome, 'pass')
  assert.equal(seen.deliverableId, 'd1')
  assert.equal(seen.artifact, 'A\n\nB')
  assert.equal(result.artifactHashes.t1, sha256('A'))
})

test('orderGates sorts raw specs by phase, then declaration, then id', () => {
  const ordered = orderGates([
    { id: 'semantic', kind: 'semantic', appliesTo: ['x'], severity: 'soft' },
    { id: 'schema', kind: 'deterministic', appliesTo: ['x'], severity: 'hard' },
    { id: 'data', kind: 'deterministic', appliesTo: ['x'], severity: 'hard', phase: 'data' },
  ])
  assert.deepEqual(ordered.map(g => g.id), ['schema', 'data', 'semantic'])
  // Gates without a phase default by kind: deterministic→structure, semantic→semantic.
  const byKind = orderGates([
    { id: 's1', kind: 'semantic', appliesTo: [], severity: 'soft' },
    { id: 'd1', kind: 'deterministic', appliesTo: [], severity: 'hard' },
  ])
  assert.deepEqual(byKind.map(g => g.id), ['d1', 's1'])
})

test('the whole chain result is deterministic for fixed inputs', () => {
  const run = () => runQualityChain({
    gates: compiledGates(),
    evaluators: allPass(),
    artifacts: artifacts(),
    now: now(),
  })
  assert.deepEqual(run(), run())
})

test('deliverable repair targets source task artifacts (never the bare deliverable id)', () => {
  const gates = [
    { id: 'quality-1/data', kind: 'deterministic', phase: 'data', chainOrder: 0, policyId: 'quality-1', policyVersion: '1.0.0', gateId: 'data', severity: 'hard', appliesTo: ['deliverable'] },
  ]
  let request = null
  const result = runQualityChain({
    gates,
    evaluators: {
      data: (input, ctx) => (input.artifact.includes('FIXED') ? pass('data')(input, ctx) : fail('data')(input, ctx)),
    },
    artifacts: { t1: { content: 'A' }, t2: { content: 'B' } },
    deliverableSources: { d1: ['t1', 't2'] },
    repair: (req) => {
      request = req
      return { repaired: true, replacements: { t2: req.artifacts.t2.content + '\nFIXED' } }
    },
    now: now(),
  })
  // The failure points at the *source tasks* of the composed deliverable…
  assert.equal(request.failures.length, 1)
  assert.deepEqual(request.failures[0].affectedArtifacts, ['t1', 't2'])
  assert.equal(request.failures[0].issues[0].code, 'hard-fail')
  assert.equal(request.artifacts.t1.content, 'A') // snapshot has the source tasks
  // …and the replacement applied to a source task changes the next round's
  // composed deliverable, so the repair actually takes effect.
  assert.equal(result.outcome, 'repaired-pass')
  assert.equal(result.deliverableAllowed, true)
  assert.equal(result.repairRoundsUsed, 1)
  assert.equal(result.rounds.length, 2)
  assert.equal(result.rounds[1].results[0].status, 'pass')
})

test('missing gate target fails with gate-artifact-missing (never concatenates artifacts)', () => {
  const gates = [
    { id: 'quality-1/data', kind: 'deterministic', phase: 'data', chainOrder: 0, policyId: 'quality-1', policyVersion: '1.0.0', gateId: 'data', severity: 'hard', appliesTo: ['ghost-task'] },
  ]
  const result = runQualityChain({
    gates,
    evaluators: allPass(),
    artifacts: { t1: { content: 'A' }, t2: { content: 'B' } },
    now: now(),
  })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.deliverableAllowed, false)
  const dataResult = result.rounds[0].results[0]
  assert.equal(dataResult.gateId, 'data')
  assert.equal(dataResult.status, 'fail')
  const issue = dataResult.issues[0]
  assert.equal(issue.code, 'gate-artifact-missing')
  // Report contract: location (joined appliesTo) + correction are present.
  assert.equal(issue.location, 'ghost-task')
  assert.ok(issue.correction.includes('bind'))

  // Multiple declared targets are joined in the location.
  const multi = runQualityChain({
    gates: [
      { id: 'quality-1/data', kind: 'deterministic', phase: 'data', chainOrder: 0, policyId: 'quality-1', policyVersion: '1.0.0', gateId: 'data', severity: 'hard', appliesTo: ['ghost-a', 'ghost-b'] },
    ],
    evaluators: allPass(),
    artifacts: { t1: { content: 'A' } },
    now: now(),
  })
  assert.equal(multi.rounds[0].results[0].issues[0].location, 'ghost-a, ghost-b')

  // Empty appliesTo falls back to the gate id as location.
  const empty = runQualityChain({
    gates: [
      { id: 'quality-1/data', kind: 'deterministic', phase: 'data', chainOrder: 0, policyId: 'quality-1', policyVersion: '1.0.0', gateId: 'data', severity: 'hard', appliesTo: [] },
    ],
    evaluators: allPass(),
    artifacts: { t1: { content: 'A' } },
    now: now(),
  })
  assert.equal(empty.rounds[0].results[0].issues[0].location, 'data')
})

test('deliverable gate without deliverableSources fails with gate-artifact-missing', () => {
  const gates = [
    { id: 'quality-1/schema', kind: 'deterministic', phase: 'structure', chainOrder: 0, policyId: 'quality-1', policyVersion: '1.0.0', gateId: 'schema', severity: 'hard', appliesTo: ['deliverable'] },
  ]
  const result = runQualityChain({
    gates,
    evaluators: allPass(),
    artifacts: { t1: { content: 'A' }, t2: { content: 'B' } },
    now: now(),
  })
  assert.equal(result.outcome, 'failed')
  const issue = result.rounds[0].results[0].issues[0]
  assert.equal(issue.code, 'gate-artifact-missing')
  assert.equal(issue.location, 'deliverable')
  assert.ok(issue.correction.includes('deliverableSources'))
})

test('deliverable gates evaluate every deliverable deterministically (not just the first)', () => {
  const gates = [
    { id: 'quality-1/schema', kind: 'deterministic', phase: 'structure', chainOrder: 0, policyId: 'quality-1', policyVersion: '1.0.0', gateId: 'schema', severity: 'hard', appliesTo: ['deliverable'] },
  ]
  const seen = []
  const result = runQualityChain({
    gates,
    evaluators: {
      schema: (input, ctx) => {
        seen.push({ id: input.deliverableId, artifact: input.artifact })
        return pass('schema')(input, ctx)
      },
    },
    artifacts: { t1: { content: 'A' }, t2: { content: 'B' } },
    deliverableSources: { d2: ['t2'], d1: ['t1'] }, // declared unsorted on purpose
    now: now(),
  })
  assert.equal(result.outcome, 'pass')
  // Both deliverables evaluated, ids sorted → d1 before d2.
  assert.deepEqual(seen.map(entry => entry.id), ['d1', 'd2'])
  assert.deepEqual(seen.map(entry => entry.artifact), ['A', 'B'])
  assert.equal(result.rounds[0].results.length, 2)
})

test('repair preserves caller artifact hashes while content sha256 is recomputed', () => {
  const gates = [
    { id: 'quality-1/data', kind: 'deterministic', phase: 'data', chainOrder: 0, policyId: 'quality-1', policyVersion: '1.0.0', gateId: 'data', severity: 'hard', appliesTo: ['t3'] },
  ]
  const observedHashes = []
  const result = runQualityChain({
    gates,
    evaluators: {
      data: (input, ctx) => {
        observedHashes.push({ ...input.artifactHashes })
        return input.artifact.includes('# fixed') ? pass('data')(input, ctx) : fail('data')(input, ctx)
      },
    },
    artifacts: { t3: { content: 'x', hashes: { pdf: 'pdf-1' } } },
    repair: (request) => ({ repaired: true, replacements: { t3: request.artifacts.t3.content + '\n# fixed' } }),
    now: now(),
  })
  assert.equal(result.outcome, 'repaired-pass')
  assert.equal(observedHashes.length, 2)
  // Round 0: sha256 of original content + caller hash preserved.
  assert.equal(observedHashes[0].t3, sha256('x'))
  assert.equal(observedHashes[0].pdf, 'pdf-1')
  // Round 1: sha256 recomputed over the repaired content, caller hash kept.
  assert.equal(observedHashes[1].t3, sha256('x\n# fixed'))
  assert.equal(observedHashes[1].pdf, 'pdf-1')
  assert.equal(result.artifactHashes.t3, sha256('x\n# fixed'))
})
