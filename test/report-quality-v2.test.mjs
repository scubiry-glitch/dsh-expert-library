import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REPORT_CRAFT_RESULT_IDS, REPORT_CRAFT_V2_RESULT_IDS, INDEPENDENT_REVIEW_AREA_IDS,
  createQualityContract, createQualityRun, qualityContractDigest, reviewQualityRun,
  integrateQualityRun, requestQualityRepair, forkQualityRun, amendQualityRun,
  validateTaskEvidenceIntegrity, isQualityRun,
} from '../lib/quality-run.js'
import { collectTaskEvidence, reviewEvidenceForReplay, writeQualityRunAtomic, readQualityRunJSON } from '../lib/quality-runtime.js'
import { REPORT_CRAFT_V2_CHECKER_VERSION } from '../lib/report-craft-checker-v2.js'
import { REPORT_CRAFT_PACK_ID, REPORT_CRAFT_MATERIAL_DIGEST } from '../lib/report-craft-materials.js'

const clone = value => structuredClone(value)
const sha = value => createHash('sha256').update(value).digest('hex')
const spec = { id: 'zhijian-report-craft-core-v2', md: 'published:report.md', html: 'published:report.html',
  pdf: 'published:report.pdf', craftEvidence: 'published:craft-evidence.json',
  materialPackId: REPORT_CRAFT_PACK_ID, materialDigest: REPORT_CRAFT_MATERIAL_DIGEST, style: 'credit-policy' }
const roles = check => check.id.endsWith('v2') ? [check.md, check.html, check.pdf, check.craftEvidence] : [check.md, check.html, check.pdf]
function independent(quote, status = 'passed') {
  return { materialReceiptId: 'host-preparation-fixture', reviewerSessionId: 'reviewer-session-fixture',
    areas: INDEPENDENT_REVIEW_AREA_IDS.map(id => ({ id, status, coverage: `Reviewed the fixture ${id} area against its current fixed inputs.`,
      evidence: [{ artifactId: spec.md, quote, reason: `This located passage identifies the report section examined for ${id}.` }] })) }
}
function contract(check = spec) {
  return createQualityContract({ id: 'report-v2-contract', taskId: 't1', attempt: 1, assignee: 'writer', kind: 'implementation',
    objective: 'A report bound to the selected material package and four actual artifacts', inScope: ['artifacts/**'],
    acceptance: [{ id: 'complete', statement: 'The selected report requirements are met' }], verify: ['true'],
    deliverables: ['task-output', ...roles(check)], changedPaths: ['artifacts/**'], artifactChecks: [check], maxRepairRounds: 2 })
}
// Synthetic receipts test the pure state boundary only. The collector cases
// below read real files and cannot be supplied these receipt objects.
function evidence(c = contract(), attempt = 1, status = 'passed') {
  const artifacts = c.deliverables.map((id, i) => {
    const content = `fixture ${id} attempt ${attempt}`
    return { id, taskId: c.taskId, attempt, path: `artifacts/${i}`, content, sha256: sha(content) }
  })
  return { taskId: c.taskId, attempt, artifacts, acceptanceResults: [{ id: 'complete', passed: true,
    detail: 'Fixture independent review explicitly references the frozen report versions.' }],
    commandsRun: [{ command: 'true', exitCode: 0, passed: true }], changedPaths: artifacts.map(a => a.path),
    ...(c.artifactChecks.some(check => check.id.endsWith('v2')) ? { independentReview: independent(artifacts.find(a => a.id === spec.md).content) } : {}),
    artifactCheckReceipts: c.artifactChecks.map(check => ({
      ...(check.id.endsWith('v2') ? { version: 2, checkerVersion: REPORT_CRAFT_V2_CHECKER_VERSION, materialDigest: check.materialDigest } : { version: 1 }),
      checkId: check.id, contractDigest: qualityContractDigest(c), taskId: c.taskId, attempt,
      artifacts: roles(check).map(id => ({ id, sha256: artifacts.find(a => a.id === id).sha256 })),
      results: (check.id.endsWith('v2') ? REPORT_CRAFT_V2_RESULT_IDS : REPORT_CRAFT_RESULT_IDS).map(id => ({ id, status, detail: `Observed ${id}` })),
    })) }
}
function review(run, e, verdict = 'pass', eventId = `review-${run.attempt}`) {
  return reviewQualityRun(run, { eventId, reviewer: 'reviewer', verdict, evidence: e,
    findings: verdict === 'pass' ? [] : [{ id: `finding-${run.attempt}`, code: 'report-v2', severity: 'hard',
      message: 'A required report check remains unresolved', taskId: run.contract.taskId, attempt: run.attempt }] })
}

for (const [name, patch] of [
  ['unknown check', { id: 'zhijian-report-craft-core-v3' }],
  ['missing ledger role', { craftEvidence: undefined }],
  ['empty ledger role', { craftEvidence: '' }],
  ['duplicate ledger role', { craftEvidence: spec.md }],
  ['unknown material pack', { materialPackId: 'producer-trusted' }],
  ['missing material digest', { materialDigest: undefined }],
  ['malformed material digest', { materialDigest: 'looks-good' }],
  ['unsupported style', { style: 'guess' }],
  ['extra skip option', { skipBrowser: true }],
]) test(`v2 contract rejects ${name}`, () => {
  assert.throws(() => contract({ ...spec, ...patch }), error => error.code === 'invalid_contract')
})

test('v2 ledger must be an explicit deliverable and bindings participate in the frozen digest', () => {
  const c = contract()
  assert.throws(() => createQualityContract({ ...c, deliverables: c.deliverables.filter(id => id !== spec.craftEvidence) }), /artifactChecks/)
  for (const check of [{ ...spec, materialDigest: 'a'.repeat(64) }, { ...spec, style: 'designer-paper' }, { ...spec, craftEvidence: 'published:new-ledger.json' }]) {
    assert.notEqual(qualityContractDigest(c), qualityContractDigest(contract(check)))
    assert.throws(() => validateTaskEvidenceIntegrity(contract(check), evidence(c)), error => error.code === 'artifact_missing' || error.code.startsWith('artifact_check_'))
  }
})

const mutations = {
  'missing receipt': e => { delete e.artifactCheckReceipts },
  'old receipt version': e => { e.artifactCheckReceipts[0].version = 1 },
  'unknown checker version': e => { e.artifactCheckReceipts[0].checkerVersion = 'future-checker' },
  'missing checker version': e => { delete e.artifactCheckReceipts[0].checkerVersion },
  'changed material digest': e => { e.artifactCheckReceipts[0].materialDigest = '0'.repeat(64) },
  'wrong contract digest': e => { e.artifactCheckReceipts[0].contractDigest = '0'.repeat(64) },
  'wrong task': e => { e.artifactCheckReceipts[0].taskId = 'other' },
  'future attempt': e => { e.artifactCheckReceipts[0].attempt = 2 },
  'missing fourth artifact': e => { e.artifactCheckReceipts[0].artifacts.pop() },
  'wrong ledger SHA': e => { e.artifactCheckReceipts[0].artifacts[3].sha256 = 'f'.repeat(64) },
  'wrong artifact order': e => { e.artifactCheckReceipts[0].artifacts.reverse() },
  'missing browser result': e => { e.artifactCheckReceipts[0].results.pop() },
  'duplicate required result': e => { e.artifactCheckReceipts[0].results[6] = e.artifactCheckReceipts[0].results[0] },
  'invented result id': e => { e.artifactCheckReceipts[0].results[6].id = 'all-good' },
  'unrecognized status': e => { e.artifactCheckReceipts[0].results[6].status = 'skip' },
  'override extra property': e => { e.artifactCheckReceipts[0].acceptedByModel = true },
  'new ledger bytes with old receipt': e => {
    const a = e.artifacts.find(a => a.id === spec.craftEvidence); a.content = 'replaced ledger'; a.sha256 = sha(a.content)
  },
}
for (const [name, mutate] of Object.entries(mutations)) test(`v2 review and cold restoration reject ${name}`, () => {
  const c = contract(), valid = evidence(c), saved = review(createQualityRun(c), valid).run
  const bad = clone(valid); mutate(bad)
  assert.throws(() => validateTaskEvidenceIntegrity(c, bad), error => error.code.startsWith('artifact_check_'))
  const cold = clone(saved); cold.latestEvidence = clone(bad); cold.evidenceHistory[0] = clone(bad)
  assert.equal(isQualityRun(cold), false)
})

for (const status of ['failed', 'unverified']) test(`v2 ${status} persists for revision but cannot authorize pass or integrate`, () => {
  const c = contract(), e = evidence(c)
  e.artifactCheckReceipts[0].results.at(-1).status = status
  const run = createQualityRun(c)
  assert.throws(() => review(run, e), error => error.code === 'artifact_check_failed')
  const negative = review(run, e, 'needs_revision').run
  assert.equal(negative.status, 'blocked'); assert.equal(negative.repairRounds, 0)
  assert.equal(isQualityRun(clone(negative)), true)
  assert.throws(() => integrateQualityRun({ ...negative, status: 'passed' }, { eventId: 'integrate', actor: 'captain' }), error => error.code === 'artifact_check_failed')
})

test('v2 repair preserves reference identity, requires new-attempt receipts, and keeps bounded negative history', () => {
  const c = contract(), first = review(createQualityRun(c), evidence(c, 1, 'failed'), 'needs_revision').run
  const repair = requestQualityRepair(first, { eventId: 'repair-1', actor: 'captain' }).run
  assert.deepEqual(repair.contract.artifactChecks, c.artifactChecks)
  assert.equal(repair.attempt, 2); assert.equal(repair.repairRounds, 1)
  assert.throws(() => review(repair, first.latestEvidence), error => error.code === 'stale_attempt')
  const passed = review(repair, evidence(c, 2)).run
  const integrated = integrateQualityRun(passed, { eventId: 'integrate', actor: 'captain' }).run
  assert.equal(integrated.status, 'integrated'); assert.equal(isQualityRun(clone(integrated)), true)
  assert.equal(integrated.evidenceHistory[0].artifactCheckReceipts[0].results[0].status, 'failed')
})

test('v2 frozen checks cannot be dropped and revision requires the new full contract receipt', () => {
  const c = contract(), saved = review(createQualityRun(c), evidence(c)).run
  assert.throws(() => amendQualityRun(saved, { eventId: 'drop', actor: 'captain', reason: 'skip checks', contract: { ...c, artifactChecks: [] } }), error => error.code === 'contract_frozen')
  const fork = forkQualityRun(saved, { eventId: 'fork', actor: 'captain', reason: 'new report attempt', assignee: 'writer', attempt: 2 }).run
  assert.deepEqual(fork.contract.artifactChecks, c.artifactChecks)
  const stale = evidence(fork.contract, 2); stale.artifactCheckReceipts[0].contractDigest = qualityContractDigest(c)
  assert.throws(() => review(fork, stale), error => error.code === 'artifact_check_binding_mismatch')
})

test('v1 remains three checks without v2 fields and ordinary tasks retain their existing contract', () => {
  const v1 = { id: 'zhijian-report-craft-core-v1', md: spec.md, html: spec.html, pdf: spec.pdf }
  const c = contract(v1), saved = review(createQualityRun(c), evidence(c)).run
  assert.equal(isQualityRun(clone(saved)), true)
  assert.equal(saved.latestEvidence.artifactCheckReceipts[0].version, 1)
  assert.equal(saved.latestEvidence.artifactCheckReceipts[0].results.length, 3)
  const ordinary = createQualityContract({ ...c, artifactChecks: undefined }), e = evidence(c)
  delete e.artifactCheckReceipts
  assert.equal(review(createQualityRun(ordinary), e).run.status, 'passed')
})

async function diskFixture(t, c = contract()) {
  const root = await mkdtemp(join(tmpdir(), 'report-quality-v2-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'artifacts'))
  const contents = new Map([[spec.md, '# Incomplete report\n'], [spec.html, '<!doctype html><html><body>Incomplete</body></html>'],
    [spec.pdf, Buffer.from('%PDF-1.7\ninvalid fixture PDF\n')], [spec.craftEvidence, '{}']])
  const artifacts = []
  for (const [i, id] of c.deliverables.entries()) {
    const path = `artifacts/${i}`; await writeFile(join(root, path), contents.get(id) ?? 'submitted report')
    artifacts.push({ id, path })
  }
  return { root, input: { workspaceRoot: root, contract: c, artifacts, acceptanceResults: [{ id: 'complete', passed: true,
    detail: 'Independent review of fixture artifacts; the Host checks decide required failures.' }],
    independentReview: independent('Incomplete report'),
    artifactCheckOptions: { browserExecutablePath: '/nonexistent/trusted-test-browser' } } }
}

test('v2 collector binds actual bytes; negative receipt replays without reading replaced files or rerunning checks', async t => {
  const { root, input } = await diskFixture(t), e = await collectTaskEvidence(input)
  const receipt = e.artifactCheckReceipts[0]
  assert.equal(receipt.version, 2); assert.equal(receipt.checkerVersion, REPORT_CRAFT_V2_CHECKER_VERSION)
  assert.equal(receipt.materialDigest, REPORT_CRAFT_MATERIAL_DIGEST)
  assert.deepEqual(receipt.artifacts, roles(spec).map(id => ({ id, sha256: e.artifacts.find(a => a.id === id).sha256 })))
  assert.deepEqual(receipt.results.map(result => result.id), [...REPORT_CRAFT_V2_RESULT_IDS])
  assert.ok(receipt.results.some(result => result.status !== 'passed'))
  const saved = review(createQualityRun(input.contract), e, 'needs_revision').run
  await writeQualityRunAtomic(join(root, 'quality.json'), saved)
  const cold = await readQualityRunJSON(join(root, 'quality.json'))
  await rm(join(root, 'artifacts'), { recursive: true })
  const replay = reviewEvidenceForReplay(cold, 'review-1', input)
  assert.deepEqual(replay, e)
  assert.equal(review(cold, replay, 'needs_revision').applied, false)
  assert.throws(() => reviewEvidenceForReplay(cold, 'review-1', { ...input, artifacts: input.artifacts.slice(1) }), error => error.code === 'idempotency_conflict')
  assert.throws(() => reviewEvidenceForReplay(cold, 'review-1', { ...input, independentReview: { ...input.independentReview, materialReceiptId: 'different-preparation' } }), error => error.code === 'idempotency_conflict')
})

test('v2 frozen untrusted material digest becomes seven unverified results, never producer-certified pass', async t => {
  const c = contract({ ...spec, materialDigest: '0'.repeat(64) }), { input } = await diskFixture(t, c)
  const e = await collectTaskEvidence(input)
  assert.ok(e.artifactCheckReceipts[0].results.every(result => result.status === 'unverified' && result.detail.includes('material integrity')))
  assert.throws(() => review(createQualityRun(c), e), error => error.code === 'artifact_check_failed')
  assert.equal(isQualityRun(clone(review(createQualityRun(c), e, 'needs_revision').run)), true)
})

test('v2 prepare-only collection needs no independent review, but cannot become a review or a cold reviewed run', async t => {
  const { input } = await diskFixture(t)
  delete input.independentReview
  const e = await collectTaskEvidence(input)
  assert.equal(e.independentReview, undefined)
  assert.doesNotThrow(() => validateTaskEvidenceIntegrity(input.contract, e))
  assert.throws(() => review(createQualityRun(input.contract), e, 'needs_revision'), error => error.code === 'independent_review_missing')
  const c = contract(), saved = review(createQualityRun(c), evidence(c)).run
  const cold = clone(saved); delete cold.latestEvidence.independentReview; delete cold.evidenceHistory[0].independentReview
  assert.equal(isQualityRun(cold), false)
})

for (const [name, mutate] of Object.entries({
  'missing area': review => review.areas.pop(),
  'duplicate area': review => { review.areas[1] = review.areas[0] },
  'invented area': review => { review.areas[0].id = 'all-good' },
  'empty coverage': review => { review.areas[0].coverage = ' ' },
  'missing located evidence': review => { review.areas[0].evidence = [] },
  'unknown artifact': review => { review.areas[0].evidence[0].artifactId = 'different-report' },
  'HTML source substituted for Markdown': review => { review.areas[0].evidence[0].artifactId = spec.html },
  'nonexistent quote': review => { review.areas[0].evidence[0].quote = 'this content was never in the report' },
  'empty explanation': review => { review.areas[0].evidence[0].reason = '' },
  'invented acceptance status': review => { review.areas[0].status = 'not_applicable' },
  'missing session': review => { delete review.reviewerSessionId },
  'empty Host preparation': review => { review.materialReceiptId = '' },
  'excessive quote': review => { review.areas[0].evidence[0].quote = 'x'.repeat(2001) },
  'unexpected self-certification': review => { review.verified = true },
})) test(`v2 independent review rejects ${name} during review and cold read`, () => {
  const c = contract(), e = evidence(c), saved = review(createQualityRun(c), e).run
  mutate(e.independentReview)
  assert.throws(() => review(createQualityRun(c), e), error => error.code.startsWith('independent_review_'))
  const cold = clone(saved); cold.latestEvidence = clone(e); cold.evidenceHistory[0] = clone(e)
  assert.equal(isQualityRun(cold), false)
})

for (const status of ['failed', 'unverified']) test(`v2 ${status} substantive observation cannot be covered by seven passing machine checks`, () => {
  const c = contract(), e = evidence(c)
  e.independentReview.areas[2].status = status
  assert.throws(() => review(createQualityRun(c), e), error => error.code === 'independent_review_failed')
  const negative = review(createQualityRun(c), e, 'needs_revision').run
  assert.equal(isQualityRun(clone(negative)), true)
  assert.throws(() => integrateQualityRun({ ...negative, status: 'passed' }, { eventId: 'integrate', actor: 'captain' }), error => error.code === 'independent_review_failed')
})

test('v2 quote anchors do not accept hidden HTML, comments, fenced or indented code as report prose', () => {
  for (const content of ['# Report\n<!-- hidden claim -->', '# Report\n<div hidden>hidden claim</div>', '# Report\n```json\nhidden claim\n```\n', '# Report\n    hidden claim\n']) {
    const c = contract(), e = evidence(c), a = e.artifacts.find(a => a.id === spec.md)
    a.content = content; a.sha256 = sha(content)
    e.artifactCheckReceipts[0].artifacts[0].sha256 = a.sha256
    e.independentReview = independent('hidden claim')
    assert.throws(() => review(createQualityRun(c), e), error => error.code === 'independent_review_quote_missing')
  }
})

test('v2 acceptance booleans require a bounded explanation without inventing a minimum proof length', () => {
  const c = contract(), e = evidence(c)
  delete e.acceptanceResults[0].detail
  assert.throws(() => validateTaskEvidenceIntegrity(c, e), error => error.code === 'acceptance_invalid')
  e.acceptanceResults[0].detail = 'Checked.'
  assert.doesNotThrow(() => validateTaskEvidenceIntegrity(c, e))
})
