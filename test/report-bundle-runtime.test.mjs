import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createQualityRun } from '../lib/quality-run.js'
import { reportArtifactCheck } from '../lib/report-bundle.js'
import { prepareDependencyInputs } from '../lib/dependency-inputs.js'
import { qualityPublicationFixture } from './support/quality-publication-fixture.mjs'
import { createCraftFixture } from './support/report-craft-fixture.mjs'

const bundle = { md: 'report.md', html: 'report.html', pdf: 'report.pdf' }
async function setup(t) {
  const f = await qualityPublicationFixture(t, { verify: ['true'] })
  const team = await f.read(), old = team.qualityRuns.t1
  const check = reportArtifactCheck(bundle)
  const run = createQualityRun({ ...old.contract, deliverables: ['task-output', check.md, check.html, check.pdf],
    changedPaths: [...old.contract.changedPaths, `${team.id}/${team.tasks[0].project.artifactsPath}/**`], artifactChecks: [check] }, old.runId)
  team.planRef = { planId: 'craft-plan', digest: 'craft-digest', templateId: 'profile:craft', templateVersion: '1' }
  team.structuredQualityPolicy = { required: true, maxRepairRounds: 2 }
  team.tasks[0].reportBundle = { ...bundle }
  team.qualityRun = run; team.qualityRuns.t1 = run
  await f.write(team)
  return f
}
async function publish(f, content = createCraftFixture()) {
  const task = (await f.read()).tasks[0]
  for (const ext of ['md','html','pdf']) {
    await writeFile(join(f.teamRoot, task.project.path, 'artifacts', bundle[ext]), content[ext])
    await f.call('publish_artifact', { task_id: task.id, attempt_id: task.attemptId, source_path: `artifacts/${bundle[ext]}`, name: bundle[ext] }, 'worker')
  }
}
async function integrate(f) {
  await f.review('review-craft')
  await f.call('quality_integrate', { task_id:'t1', event_id:'integrate-craft', actor:'captain', complete_task:true }, 'captain')
}

test('registered review checks actual bad PDF despite all acceptance flags true and persists negative evidence', async t => {
  const f = await setup(t)
  await publish(f, createCraftFixture({ pdfOptions: { missingFooter: true } }))
  const before = await f.read()
  await assert.rejects(f.review('false-pass'), /artifact.*check|report-craft-pdf|footer/i)
  assert.deepEqual(await f.read(), before, 'failed pass does not consume review/repair budget')
  await f.call('quality_review', { task_id:'t1', event_id:'truthful-negative', reviewer:'reviewer', verdict:'needs_revision',
    acceptance_results:[{id:'present',passed:false}], findings:[{id:'footer',code:'missing-footer',severity:'hard',message:'Required PDF footer is absent',taskId:'t1',attempt:1}] }, 'reviewer')
  const blocked = await f.read()
  assert.equal(blocked.qualityRuns.t1.status, 'blocked')
  assert.equal(blocked.qualityRuns.t1.latestEvidence.artifactCheckReceipts[0].results.find(x => x.id==='report-craft-pdf-structure').status,'failed')
  await assert.rejects(f.call('quality_integrate',{ task_id:'t1',event_id:'bad-integrate',actor:'captain',complete_task:false },'captain'), /requires a passed review/)
})

test('report follow-up inherits frozen checks and exact reviewed dependency pins; explicit opt-out is rejected atomically', async t => {
  const f = await setup(t)
  await publish(f); await integrate(f)
  const source = await f.read(), before = structuredClone(source)
  await assert.rejects(f.call('create_task', { subject:'Bad opt-out', assignee:'captain', revises_task_id:'t1', input_artifacts:[] },'captain'), /REPORT_REVISION_INPUTS_FIXED/)
  await assert.rejects(f.call('create_task', { subject:'Rename to evade', assignee:'captain', revises_task_id:'t1', report_bundle:{...bundle,pdf:'other.pdf'} },'captain'), /REPORT_REVISION_CONTRACT_MISMATCH|report_bundle\.craft/)
  assert.deepEqual(await f.read(),before)
  const result = await f.call('create_task', { subject:'Repair report figures', assignee:'captain', revises_task_id:'t1' },'captain')
  const team = await f.read(), task = team.tasks.find(task => task.id===result.task_id)
  assert.deepEqual(task.dependencies,['t1']); assert.equal(task.revisesTaskId,'t1')
  assert.deepEqual(team.qualityRuns[task.id].contract.artifactChecks,source.qualityRuns.t1.contract.artifactChecks)
  assert.deepEqual(task.reportBundle,bundle)
  assert.deepEqual(team.qualityRuns[task.id].contract.acceptance,source.qualityRuns.t1.contract.acceptance)
  await prepareDependencyInputs(f.stateRoot,team,task,1)
  assert.equal(task.inputArtifactManifest.length,3)
  assert.deepEqual(task.inputArtifactManifest.map(x=>x.sha256).sort(),source.tasks[0].publishedArtifacts.map(x=>x.sha256).sort())
  const manifest = JSON.parse(await readFile(join(f.teamRoot, task.project.inputPath),'utf8'))
  assert.deepEqual(manifest.artifactChecks,team.qualityRuns[task.id].contract.artifactChecks)
  assert.deepEqual((await f.read()).tasks[0],source.tasks[0],'new revision does not mutate finalized source')
})

test('same-named ordinary draft after a completed report is not silently classified as its revision', async t => {
  const f = await setup(t)
  await publish(f); await integrate(f)
  const result = await f.call('create_task',{subject:'Unbound follow-up',assignee:'captain'},'captain')
  const claim = await f.call('claim_task',{task_id:result.task_id},'captain')
  const team = await f.read(), task=team.tasks.find(task=>task.id===result.task_id)
  await writeFile(join(f.teamRoot,task.project.path,'artifacts/report.md'),'unchecked replacement')
  const published = await f.call('publish_artifact',{task_id:task.id,attempt_id:claim.attempt_id,source_path:'artifacts/report.md',name:'report.md'},'captain')
  assert.ok(published.artifact_id)
  assert.equal((await f.read()).qualityRuns[task.id].contract.artifactChecks,undefined)
  assert.deepEqual((await f.read()).tasks[0],team.tasks[0])
})

test('a fresh legacy report cannot bypass explicit selected-skill admission', async t => {
  const f = await setup(t), before=await f.read()
  await assert.rejects(f.call('create_task',{subject:'Separate report',assignee:'captain',report_bundle:bundle},'captain'),/REPORT_SKILL_SELECTION_REQUIRED|report_bundle\.craft/)
  assert.deepEqual(await f.read(),before)
})

test('an ordinary upstream draft can publish report.md while the separately checked final producer is still pending', async t => {
  const f = await setup(t)
  const result=await f.call('create_task',{subject:'Compose draft for the final producer',assignee:'captain'},'captain')
  const claim=await f.call('claim_task',{task_id:result.task_id},'captain')
  const task=(await f.read()).tasks.find(task=>task.id===result.task_id)
  await writeFile(join(f.teamRoot,task.project.path,'artifacts/report.md'),'Preliminary content for the separate final producer')
  const published=await f.call('publish_artifact',{task_id:task.id,attempt_id:claim.attempt_id,source_path:'artifacts/report.md',name:'report.md'},'captain')
  assert.ok(published.artifact_id)
  assert.equal((await f.read()).qualityRuns.t1.status,'pending')
})


test('explicit report revision refuses an ordinary integrated source rather than dropping its original contract', async t => {
  const f=await qualityPublicationFixture(t,{verify:['true']})
  const team=await f.read()
  team.planRef={planId:'ordinary-plan',digest:'ordinary-digest',templateId:'profile:ordinary',templateVersion:'1'}
  team.structuredQualityPolicy={required:true,maxRepairRounds:2}
  await f.write(team)
  await f.publish('Ordinary reviewed output'); await integrate(f)
  const before=await f.read()
  await assert.rejects(f.call('create_task',{subject:'Improper report revision',assignee:'captain',revises_task_id:'t1'},'captain'),/REPORT_REVISION_SOURCE_NOT_REPORT/)
  assert.deepEqual(await f.read(),before)
})
