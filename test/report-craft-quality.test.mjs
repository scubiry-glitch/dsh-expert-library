import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REPORT_CRAFT_RESULT_IDS, createQualityContract, createQualityRun, qualityContractDigest,
  reviewQualityRun, integrateQualityRun, requestQualityRepair, forkQualityRun, amendQualityRun,
  validateTaskEvidence, validateTaskEvidenceIntegrity, isQualityRun,
} from '../lib/quality-run.js'
import {
  collectTaskEvidence, reviewEvidenceForReplay, assertDurableQualityRun,
  writeQualityRunAtomic, readQualityRunJSON,
} from '../lib/quality-runtime.js'

const binding = { id: 'zhijian-report-craft-core-v1', md: 'published:report.md', html: 'published:report.html', pdf: 'published:report.pdf' }
const sha = value => createHash('sha256').update(value).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
function contract(patch = {}) {
  return createQualityContract({ id: 'craft-contract', taskId: 't1', attempt: 1, assignee: 'writer', kind: 'implementation',
    objective: 'Validate the selected report bundle', inScope: ['artifacts/**'], outOfScope: [],
    acceptance: [{ id: 'present', statement: 'Report is complete' }], verify: ['true'],
    deliverables: ['task-output', binding.md, binding.html, binding.pdf], changedPaths: ['artifacts/**'],
    artifactChecks: [binding], maxRepairRounds: 2, ...patch })
}
// Synthetic Host receipts exercise the pure state boundary. Real collector
// receipt construction is tested separately below, with actual files/checker.
function evidence(c = contract(), attempt = 1, status = 'passed') {
  const artifacts = c.deliverables.map((id, index) => {
    const content = `fixture ${id} generation ${attempt}`
    return { id, taskId: c.taskId, attempt, path: `artifacts/${index}`, content, sha256: sha(content) }
  })
  return { taskId: c.taskId, attempt, artifacts, acceptanceResults: [{ id: 'present', passed: true }],
    commandsRun: [{ command: 'true', exitCode: 0, passed: true }], changedPaths: artifacts.map(a => a.path),
    ...(c.artifactChecks === undefined ? {} : { artifactCheckReceipts: c.artifactChecks.map(check => ({
      version: 1, checkId: check.id, contractDigest: qualityContractDigest(c), taskId: c.taskId, attempt,
      artifacts: [check.md, check.html, check.pdf].map(id => ({ id, sha256: artifacts.find(a => a.id === id).sha256 })),
      results: REPORT_CRAFT_RESULT_IDS.map(id => ({ id, status, detail: `${id}: fixture observation` })),
    })) }) }
}
function review(run, e, verdict = 'pass', eventId = `review-${run.attempt}`) {
  return reviewQualityRun(run, { eventId, reviewer: 'reviewer', verdict, evidence: e,
    findings: verdict === 'pass' ? [] : [{ id: `finding-${run.attempt}`, code: 'craft', severity: 'hard',
      message: 'Report craft check is unresolved', taskId: run.contract.taskId, attempt: run.attempt }] })
}

for (const [name, checks] of [
  ['unknown registered version', [{ ...binding, id: 'zhijian-report-craft-core-v2' }]],
  ['empty role', [{ ...binding, md: '' }]],
  ['duplicate roles', [{ ...binding, pdf: binding.md }]],
  ['undeclared role', [{ ...binding, html: 'other' }]],
  ['unexpected option', [{ ...binding, skipPdf: true }]],
  ['duplicate check', [binding, binding]],
  ['non-array checks', {}],
]) test(`report contract rejects ${name}`, () => {
  assert.throws(() => contract({ artifactChecks: checks }), error => error.code === 'invalid_contract')
})

test('contract digest is canonical and includes the full frozen contract', () => {
  const c = contract(), reordered = Object.fromEntries(Object.entries(c).reverse())
  assert.equal(qualityContractDigest(c), qualityContractDigest(reordered))
  for (const change of [{ objective: 'changed' }, { maxRepairRounds: 1 }, { acceptance: [{ id: 'present', statement: 'new promise' }] }]) {
    assert.notEqual(qualityContractDigest(c), qualityContractDigest(contract(change)))
    assert.throws(() => validateTaskEvidenceIntegrity(contract(change), evidence(c), 1), /different contract/)
  }
})

const mutations = {
  'missing receipt': e => { delete e.artifactCheckReceipts },
  'wrong artifact SHA': e => { e.artifactCheckReceipts[0].artifacts[0].sha256 = '0'.repeat(64) },
  'old attempt': e => { e.artifactCheckReceipts[0].attempt = 2 },
  'other task': e => { e.artifactCheckReceipts[0].taskId = 't2' },
  'old contract': e => { e.artifactCheckReceipts[0].contractDigest = '0'.repeat(64) },
  'unknown checker version': e => { e.artifactCheckReceipts[0].checkId = 'zhijian-report-craft-core-v0' },
  'unknown receipt version': e => { e.artifactCheckReceipts[0].version = 2 },
  'missing required result': e => { e.artifactCheckReceipts[0].results.pop() },
  'duplicate result': e => { e.artifactCheckReceipts[0].results[1] = e.artifactCheckReceipts[0].results[0] },
  'unknown result ID': e => { e.artifactCheckReceipts[0].results[0].id = 'model-says-good' },
  'invalid result status': e => { e.artifactCheckReceipts[0].results[0].status = 'skip' },
  'role order mismatch': e => { e.artifactCheckReceipts[0].artifacts.reverse() },
  'unexpected receipt override': e => { e.artifactCheckReceipts[0].allowFailure = true },
  'replaced bytes with old receipt': e => { e.artifacts[1].content = 'replacement'; e.artifacts[1].sha256 = sha('replacement') },
}
for (const [name, mutate] of Object.entries(mutations)) test(`report evidence rejects ${name} in review and cold persisted state`, () => {
  const c = contract(), e = evidence(c), passed = review(createQualityRun(c), e).run
  const invalid = clone(e); mutate(invalid)
  assert.throws(() => validateTaskEvidenceIntegrity(c, invalid, 1), error => error.code.startsWith('artifact_check_'))
  const cold = clone(passed); cold.latestEvidence = clone(invalid); cold.evidenceHistory[0] = clone(invalid)
  assert.equal(isQualityRun(cold), false)
  assert.throws(() => assertDurableQualityRun(cold), error => error.code === 'quality_state_invalid')
})

for (const status of ['failed', 'unverified']) test(`${status} Host checks survive needs_revision but cannot authorize pass or integration`, () => {
  const c = contract(), e = evidence(c, 1, status), run = createQualityRun(c)
  assert.doesNotThrow(() => validateTaskEvidenceIntegrity(c, e, 1))
  assert.throws(() => review(run, e), error => error.code === 'artifact_check_failed')
  const blocked = review(run, e, 'needs_revision').run
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.repairRounds, 0)
  assert.doesNotThrow(() => assertDurableQualityRun(clone(blocked)))
  assert.throws(() => integrateQualityRun(blocked, { eventId: 'integrate', actor: 'captain' }), /passed review/)
  assert.throws(() => integrateQualityRun({ ...blocked, status: 'passed' }, { eventId: 'integrate', actor: 'captain' }), error => error.code === 'artifact_check_failed')
  e.artifactCheckReceipts[0].results[0].detail = 'caller modified its object later'
  assert.notEqual(blocked.latestEvidence.artifactCheckReceipts[0].results[0].detail, e.artifactCheckReceipts[0].results[0].detail)
})

test('repair retains checks and requires a fresh receipt for the new attempt before integration', () => {
  const c = contract(), negative = evidence(c, 1, 'failed')
  const blocked = review(createQualityRun(c), negative, 'needs_revision').run
  const repaired = requestQualityRepair(blocked, { eventId: 'repair', actor: 'captain' }).run
  assert.equal(repaired.attempt, 2); assert.equal(repaired.repairRounds, 1)
  assert.deepEqual(repaired.contract.artifactChecks, c.artifactChecks)
  assert.throws(() => review(repaired, negative), error => error.code === 'stale_attempt')
  const fresh = evidence(c, 2)
  const passed = review(repaired, fresh).run
  const integrated = integrateQualityRun(passed, { eventId: 'integrate', actor: 'captain' }).run
  assert.equal(integrated.status, 'integrated'); assert.equal(integrated.repairRounds, 1)
  assert.doesNotThrow(() => assertDurableQualityRun(clone(integrated)))
})

test('cold negative history cannot bind a receipt from a never-opened future generation', () => {
  const c = contract(), blocked = review(createQualityRun(c), evidence(c, 1, 'failed'), 'needs_revision').run
  const future = evidence(c, 2, 'failed')
  const invalid = { ...blocked, latestEvidence: future, evidenceHistory: [future] }
  assert.equal(isQualityRun(invalid), false)
  assert.throws(() => assertDurableQualityRun(invalid), error => error.code === 'quality_state_invalid')
})

test('review freezes checks; a fork preserves binding but invalidates receipts from its parent contract', () => {
  const c = contract(), e = evidence(c), passed = review(createQualityRun(c), e).run
  assert.throws(() => amendQualityRun(passed, { eventId: 'drop', actor: 'captain', reason: 'drop checker',
    contract: { ...c, artifactChecks: [] } }), error => error.code === 'contract_frozen')
  const child = forkQualityRun(passed, { eventId: 'fork', actor: 'captain', reason: 'revise', assignee: 'writer', attempt: 2 }).run
  assert.deepEqual(child.contract.artifactChecks, c.artifactChecks)
  assert.notEqual(qualityContractDigest(child.contract), qualityContractDigest(c))
  const copied = evidence(child.contract, 2)
  copied.artifactCheckReceipts[0].contractDigest = qualityContractDigest(c)
  assert.throws(() => review(child, copied), error => error.code === 'artifact_check_binding_mismatch')
})

test('ordinary quality tasks preserve compatibility and reject extra report receipts', () => {
  const c = contract({ artifactChecks: undefined }), e = evidence(c)
  assert.equal(e.artifactCheckReceipts, undefined)
  assert.equal(review(createQualityRun(c), e).run.status, 'passed')
  assert.doesNotThrow(() => validateTaskEvidence(c, { ...e, artifactCheckReceipts: [] }))
  assert.throws(() => validateTaskEvidence(c, { ...e, artifactCheckReceipts: evidence().artifactCheckReceipts }), /exactly cover/)
})

test('real collector binds four actual files and negative receipts survive exact replay and atomic cold read', async t => {
  const root = await mkdtemp(join(tmpdir(), 'report-craft-quality-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'artifacts'))
  const files = [ ['task-output', 'output.json', '{"output":"submitted report"}'],
    [binding.md, 'report.md', '# Incomplete report\nNo disclosure or closing section.'],
    [binding.html, 'report.html', '<html><body>Incomplete report</body></html>'],
    [binding.pdf, 'report.pdf', Buffer.from('%PDF-1.7\ninvalid fixture PDF\n')] ]
  for (const [, name, bytes] of files) await writeFile(join(root, 'artifacts', name), bytes)
  const c = contract(), specs = files.map(([id, name]) => ({ id, path: `artifacts/${name}` }))
  const input = { workspaceRoot: root, contract: c, artifacts: specs, acceptanceResults: [{ id: 'present', passed: true }] }
  const e = await collectTaskEvidence(input)
  assert.equal(e.artifacts.length, 4)
  assert.equal(e.artifactCheckReceipts.length, 1)
  const receipt = e.artifactCheckReceipts[0]
  assert.deepEqual(receipt.artifacts, [binding.md, binding.html, binding.pdf].map(id => ({ id, sha256: e.artifacts.find(a => a.id === id).sha256 })))
  assert.deepEqual(receipt.results.map(r => r.id), [...REPORT_CRAFT_RESULT_IDS])
  assert.ok(receipt.results.some(r => r.status !== 'passed'))
  assert.throws(() => review(createQualityRun(c), e), error => error.code === 'artifact_check_failed')
  const blocked = review(createQualityRun(c), e, 'needs_revision').run
  const file = join(root, 'quality.json')
  await writeQualityRunAtomic(file, blocked)
  const cold = await readQualityRunJSON(file)
  assert.deepEqual(cold.latestEvidence.artifactCheckReceipts, e.artifactCheckReceipts)
  // Removing files makes a rerun fail. A genuine exact retry reuses the
  // persisted Host observation; it cannot secretly invoke the checker again.
  await rm(join(root, 'artifacts'), { recursive: true })
  const replayEvidence = reviewEvidenceForReplay(cold, 'review-1', input)
  assert.deepEqual(replayEvidence, e)
  const replay = review(cold, replayEvidence, 'needs_revision')
  assert.equal(replay.applied, false); assert.deepEqual(replay.run, cold)
  const corrupt = JSON.parse(await readFile(file, 'utf8'))
  corrupt.latestEvidence.artifactCheckReceipts[0].contractDigest = '0'.repeat(64)
  await writeFile(file, JSON.stringify(corrupt))
  await assert.rejects(readQualityRunJSON(file), error => error.code === 'quality_state_invalid')
})
