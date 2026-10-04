import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createQualityRun, reviewQualityRun, integrateQualityRun, qualityContractDigest,
  REPORT_CRAFT_V2_RESULT_IDS, REPORT_CRAFT_V2_CHECKER_VERSION, INDEPENDENT_REVIEW_AREA_IDS } from '../lib/quality-run.js'
import { reportArtifactCheck, reportCheckDeliverables } from '../lib/report-bundle.js'
import { prepareCraftDelivery, saveCraftDelivery, bindCraftReviewPreparation } from '../lib/report-craft-delivery.js'
import { qualityPublicationFixture } from './support/quality-publication-fixture.mjs'

const bundle = { md: 'report.md', html: 'report.html', pdf: 'report.pdf', craft: { version: 2, style: 'credit-policy', evidence: 'craft-evidence.json' } }
const sha = value => createHash('sha256').update(value).digest('hex')

// Synthetic admitted history tests the version-migration boundary only; this
// fixture does not claim to run browser/PDF checks. Real tools publish/read the
// bytes and validate material-delivery receipts before the completion call.
async function integratedHistory(t, { completed = false, historical = true } = {}) {
  const f = await qualityPublicationFixture(t, { verify: ['true'] })
  let team = await f.read(), task = team.tasks[0]
  const check = reportArtifactCheck(bundle)
  task.reportBundle = structuredClone(bundle)
  const run = createQualityRun({ ...team.qualityRun.contract, artifactChecks: [check],
    deliverables: ['task-output', ...reportCheckDeliverables(check)],
    changedPaths: [`${team.id}/${task.project.path}/**`] }, 'checker-migration-run')
  team.qualityRun = run; team.qualityRuns.t1 = run
  await f.write(team)
  await f.call('claim_task', { task_id: 't1' }, 'worker')
  for (const name of ['report.md', 'report.html', 'report.pdf', 'craft-evidence.json']) {
    await writeFile(join(f.teamRoot, task.project.artifactsPath, name), `Synthetic historical ${name}`)
    await f.call('publish_artifact', { task_id: 't1', attempt_id: task.attemptId, source_path: `artifacts/${name}`, name }, 'worker')
  }
  team = await f.read(); task = team.tasks[0]
  const artifacts = [{ id: 'task-output', path: `${team.id}/${task.project.outputPath}` },
    ...task.publishedArtifacts.map(a => ({ id: a.reviewId, path: `${team.id}/${task.project.artifactsPath}/${a.relativePath}` }))]
  for (const artifact of artifacts) {
    artifact.content = await readFile(join(f.stateRoot, artifact.path), 'utf8')
    artifact.sha256 = sha(artifact.content); artifact.taskId = task.id; artifact.attempt = task.attempt
  }
  const packet = prepareCraftDelivery(task, 'reviewer-id', 1, ['reviewer'], 'review-preparation')
  saveCraftDelivery(task, packet.receipts)
  const prep = bindCraftReviewPreparation(task, run, packet.receipts[0], artifacts)
  const evidence = { taskId: 't1', attempt: 1, artifacts,
    acceptanceResults: [{ id: 'present', passed: true, detail: 'Synthetic admitted historical report' }],
    commandsRun: [{ command: 'true', exitCode: 0, passed: true }], changedPaths: artifacts.map(a => a.path),
    independentReview: { materialReceiptId: prep.receiptId, reviewerSessionId: 'reviewer-id', areas: INDEPENDENT_REVIEW_AREA_IDS.map(id => ({
      id, status: 'passed', coverage: 'Synthetic historical review area', evidence: [{ artifactId: check.md, quote: 'Synthetic historical report.md', reason: 'Located fixture quote' }],
    })) },
    artifactCheckReceipts: [{ version: 2, checkId: check.id, checkerVersion: REPORT_CRAFT_V2_CHECKER_VERSION,
      materialDigest: check.materialDigest, contractDigest: qualityContractDigest(run.contract), taskId: 't1', attempt: 1,
      artifacts: reportCheckDeliverables(check).map(id => ({ id, sha256: artifacts.find(a => a.id === id).sha256 })),
      results: REPORT_CRAFT_V2_RESULT_IDS.map(id => ({ id, status: 'passed', detail: 'Synthetic historical receipt' })),
    }],
  }
  const passed = reviewQualityRun(run, { eventId: 'historical-review', reviewer: 'reviewer', verdict: 'pass', evidence }).run
  const integrated = structuredClone(integrateQualityRun(passed, { eventId: 'historical-integration', actor: 'captain' }).run)
  if (historical) {
    integrated.latestEvidence.artifactCheckReceipts[0].checkerVersion = 'report-craft-v2.1'
    integrated.evidenceHistory[0].artifactCheckReceipts[0].checkerVersion = 'report-craft-v2.1'
  }
  team.qualityRun = integrated; team.qualityRuns.t1 = integrated
  if (completed) {
    task.status = 'completed'; task.finalizedAttemptId = task.attemptId; delete task.attemptId
  }
  await f.write(team)
  return f
}

for (const route of ['quality_integrate', 'update_task']) test(`old integrated receipt cannot newly complete a task via ${route}`, async t => {
  const f = await integratedHistory(t)
  const before = await f.read()
  const args = route === 'quality_integrate'
    ? { task_id: 't1', event_id: 'historical-integration', actor: 'captain', complete_task: true }
    : { task_id: 't1', attempt_id: before.tasks[0].attemptId, status: 'completed' }
  await assert.rejects(f.call(route, args, route === 'quality_integrate' ? 'captain' : 'worker'), error => error.code === 'artifact_check_stale')
  assert.deepEqual(await f.read(), before, 'refusal has no task, budget, review, or dispatch side effect')
})

test('an already completed historical task retains exact integration replay after checker migration', async t => {
  const f = await integratedHistory(t, { completed: true })
  const before = await f.read()
  const result = await f.call('quality_integrate', { task_id: 't1', event_id: 'historical-integration', actor: 'captain', complete_task: true }, 'captain')
  assert.equal(result.task_status, 'completed')
  const after = await f.read()
  assert.deepEqual(after.qualityRuns.t1, before.qualityRuns.t1)
  assert.equal(after.tasks[0].finalizedAttemptId, before.tasks[0].finalizedAttemptId)
})

test('current checker receipt can complete an already integrated in-progress task', async t => {
  const f = await integratedHistory(t, { historical: false })
  const result = await f.call('quality_integrate', { task_id: 't1', event_id: 'historical-integration', actor: 'captain', complete_task: true }, 'captain')
  assert.equal(result.task_status, 'completed')
})
