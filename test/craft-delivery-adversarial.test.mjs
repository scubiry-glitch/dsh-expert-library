import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createQualityRun } from '../lib/quality-run.js'
import { reportArtifactCheck, reportCheckDeliverables } from '../lib/report-bundle.js'
import { qualityPublicationFixture } from './support/quality-publication-fixture.mjs'
import { createCraftV2Fixture } from './support/report-craft-v2-fixture.mjs'

const bundle = { md: 'report.md', html: 'report.html', pdf: 'report.pdf',
  craft: { version: 2, style: 'credit-policy', evidence: 'craft-evidence.json' } }
const areas = ['chapter-substance', 'facts-and-uncertainty', 'calculations-and-coverage', 'visual-and-format']

async function setup(t, maxRepairRounds = 2, verify = ['true']) {
  const f = await qualityPublicationFixture(t, { verify })
  const team = await f.read(), old = team.qualityRuns.t1, check = reportArtifactCheck(bundle)
  const run = createQualityRun({ ...old.contract, maxRepairRounds,
    deliverables: ['task-output', ...reportCheckDeliverables(check)],
    changedPaths: [...old.contract.changedPaths, `${team.id}/${team.tasks[0].project.artifactsPath}/**`],
    artifactChecks: [check] }, old.runId)
  team.planRef = { planId: 'adversarial-craft', digest: 'adversarial-digest', templateId: 'profile:craft', templateVersion: '2' }
  team.structuredQualityPolicy = { required: true, maxRepairRounds: 2 }
  team.tasks[0].reportBundle = structuredClone(bundle)
  team.qualityRun = run; team.qualityRuns.t1 = run
  await f.write(team)
  return f
}

async function publishCurrent(f) {
  const sample = createCraftV2Fixture()
  const claim = await f.call('claim_task', { task_id: 't1' }, 'worker')
  assert.ok(claim.craft_materials, 'real claiming tool must return the complete producer bodies')
  const task = (await f.read()).tasks[0]
  for (const [name, bytes] of [['report.md', sample.md], ['report.html', sample.html], ['report.pdf', sample.pdf], ['craft-evidence.json', sample.craftEvidence]]) {
    await writeFile(join(f.teamRoot, task.project.artifactsPath, name), bytes)
    await f.call('publish_artifact', { task_id: 't1', attempt_id: task.attemptId, source_path: `artifacts/${name}`, name }, 'worker')
  }
  await f.call('update_task', { task_id: 't1', attempt_id: task.attemptId, status: 'in_progress',
    execution_state: 'awaiting_review', output: 'Synthetic current report, with all four fixed publications ready for independent review.' }, 'worker')
}

async function prepare(f) {
  const result = await f.call('quality_review', { task_id: 't1', reviewer: 'reviewer', prepare_only: true }, 'reviewer')
  assert.equal(result.machine_checks[0].results.length, 7)
  assert.ok(result.machine_checks[0].results.every(check => check.status === 'passed'), JSON.stringify(result.machine_checks))
  return result.material_receipt
}

function reviewArgs(receipt, eventId, attempt = 1, verdict = 'pass') {
  return { task_id: 't1', event_id: eventId, reviewer: 'reviewer', verdict, material_receipt: receipt,
    acceptance_results: [{ id: 'present', passed: verdict === 'pass', detail: 'The synthetic current report was inspected; a negative fixture records an independent requested clarification.' }],
    independent_review: areas.map(id => ({ id, status: verdict === 'pass' ? 'passed' : 'unverified',
      coverage: 'Synthetic material, report version and declared scope inspected for this protocol test.',
      evidence: [{ artifactId: 'published:report.md', quote: '此例为合成测试，不是用户事实。',
        reason: 'The quoted synthetic report statement locates the material reviewed; this fixture does not assert a real business conclusion.' }] })),
    ...(verdict === 'pass' ? {} : { findings: [{ id: `clarify-${attempt}`, code: 'clarification', severity: 'hard',
      message: 'An independent clarification must be addressed before this fixture is accepted.', taskId: 't1', attempt }] }) }
}

test('explicit v2 report revisions preserve the remaining lineage budget without mutating their source', async t => {
  for (const scenario of [{ maximum: 0, consumed: 0, remaining: 0 }, { maximum: 2, consumed: 1, remaining: 1 }]) {
    await t.test(`source maximum ${scenario.maximum}, consumed ${scenario.consumed}`, async t => {
      const f = await setup(t, scenario.maximum)
      await publishCurrent(f)
      if (scenario.consumed) {
        const receipt = await prepare(f)
        await f.call('quality_review', reviewArgs(receipt, 'independent-clarification', 1, 'needs_revision'), 'reviewer')
        const repaired = await f.call('quality_repair', { task_id: 't1', event_id: 'repair-clarification', actor: 'captain' }, 'captain')
        assert.equal(repaired.repair_rounds, 1)
        await publishCurrent(f)
      }
      const receipt = await prepare(f)
      const attempt = (await f.read()).qualityRuns.t1.attempt
      await f.call('quality_review', reviewArgs(receipt, 'accept-current', attempt), 'reviewer')
      await f.call('quality_integrate', { task_id: 't1', event_id: 'integrate-current', actor: 'captain', complete_task: true }, 'captain')
      const source = await f.read()
      assert.equal(source.qualityRuns.t1.repairRounds, scenario.consumed)
      const revision = await f.call('create_task', { subject: 'Explicit corrected report', assignee: 'captain', revises_task_id: 't1' }, 'captain')
      const next = await f.read()
      assert.equal(next.qualityRuns[revision.task_id].contract.maxRepairRounds, scenario.remaining,
        'an explicit revision must not restore the team default over its source remaining budget')
      assert.deepEqual(next.qualityRuns[revision.task_id].contract.artifactChecks, source.qualityRuns.t1.contract.artifactChecks)
      assert.deepEqual(next.qualityRuns.t1, source.qualityRuns.t1)
      assert.deepEqual(next.tasks[0], source.tasks[0])
      const beforeNew = await f.read()
      await assert.rejects(f.call('create_task', { subject: 'Separate independent report', assignee: 'captain', report_bundle: bundle }, 'captain'), /REPORT_SKILL_SELECTION_REQUIRED|report_bundle\.craft/)
      assert.deepEqual(await f.read(), beforeNew, 'legacy task inheritance does not authorize a fresh legacy report')
    })
  }
})

test('a second preparation preserves the first exact review receipt across cold reads without executing verification again', async t => {
  const f = await setup(t, 2, ['node -e "require(\'fs\').appendFileSync(\'verification-count\',\'x\')"'])
  await publishCurrent(f)
  const first = await prepare(f), second = await prepare(f)
  assert.notEqual(first, second)
  let team = await f.read()
  assert.deepEqual(team.tasks[0].craftReviewPreparations.map(p => p.receiptId), [first, second])
  const args = reviewArgs(first, 'review-first-preparation')
  await f.call('quality_review', args, 'reviewer')
  const accepted = await f.read()
  const verifyCount = await readFile(join(f.stateRoot, 'verification-count'), 'utf8')
  // Each registered tool cold-reads the real durable team JSON. A replay with
  // the same immutable evidence must not execute the command/checker again.
  await f.call('quality_review', args, 'reviewer')
  assert.equal(await readFile(join(f.stateRoot, 'verification-count'), 'utf8'), verifyCount)
  team = await f.read()
  assert.deepEqual(team.qualityRuns.t1, accepted.qualityRuns.t1)
  assert.equal(team.qualityRuns.t1.reviewRounds, 1)
  assert.equal(team.qualityRuns.t1.repairRounds, 0)
  await assert.rejects(f.call('quality_review', { ...args, material_receipt: second }, 'reviewer'), /replay|different|conflict|match/i)
  assert.deepEqual((await f.read()).qualityRuns.t1, accepted.qualityRuns.t1)
})
