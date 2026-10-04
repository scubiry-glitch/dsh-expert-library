import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createQualityRun } from '../lib/quality-run.js'
import { reportArtifactCheck, reportCheckDeliverables } from '../lib/report-bundle.js'
import { craftSessionContext } from '../lib/report-craft-delivery.js'
import { qualityPublicationFixture } from './support/quality-publication-fixture.mjs'
import { createCraftV2Fixture } from './support/report-craft-v2-fixture.mjs'

const bundle = { md:'report.md',html:'report.html',pdf:'report.pdf',craft:{version:2,style:'credit-policy',evidence:'craft-evidence.json'} }
const sample = createCraftV2Fixture()
async function setup(t) {
  const f = await qualityPublicationFixture(t,{verify:['true']})
  const team=await f.read(),old=team.qualityRuns.t1,check=reportArtifactCheck(bundle)
  const run=createQualityRun({...old.contract,deliverables:['task-output',...reportCheckDeliverables(check)],
    changedPaths:[...old.contract.changedPaths,`${team.id}/${team.tasks[0].project.artifactsPath}/**`],artifactChecks:[check]},old.runId)
  team.planRef={planId:'craft-plan-v2',digest:'craft-digest',templateId:'profile:craft',templateVersion:'2'}
  team.structuredQualityPolicy={required:true,maxRepairRounds:2};team.tasks[0].reportBundle=structuredClone(bundle)
  team.qualityRun=run;team.qualityRuns.t1=run;await f.write(team);return f
}
async function publish(f) {
  const task=(await f.read()).tasks[0]
  for(const [name,content] of [['report.md',sample.md],['report.html',sample.html],['report.pdf',sample.pdf],['craft-evidence.json',sample.craftEvidence]]) {
    await writeFile(join(f.teamRoot,task.project.artifactsPath,name),content)
    await f.call('publish_artifact',{task_id:task.id,attempt_id:task.attemptId,source_path:`artifacts/${name}`,name},'worker')
  }
}
const reviewArgs=(receipt,event='review-v2')=>({task_id:'t1',event_id:event,reviewer:'reviewer',verdict:'pass',material_receipt:receipt,
  acceptance_results:[{id:'present',passed:true,detail:'Synthetic current report and scoped checks were inspected for this fixture.'}],
  independent_review:['chapter-substance','facts-and-uncertainty','calculations-and-coverage','visual-and-format'].map(id=>({id,status:'passed',coverage:'The synthetic report current body and the declared check scope.',
    evidence:[{artifactId:'published:report.md',quote:'此例为合成测试，不是用户事实。',reason:`Synthetic fixture review locating ${id}; this is a protocol test, not a substantive business judgment.`}]}))})

test('v2 producer receives complete role bodies before publication and survives cold prompt assembly',async t=>{
  const f=await setup(t),task=(await f.read()).tasks[0]
  await writeFile(join(f.teamRoot,task.project.artifactsPath,'report.md'),sample.md)
  await assert.rejects(f.call('publish_artifact',{task_id:'t1',attempt_id:task.attemptId,source_path:'artifacts/report.md',name:'report.md'},'worker'),/CRAFT_MATERIALS_NOT_DELIVERED/)
  const claimed=await f.call('claim_task',{task_id:'t1'},'worker')
  assert.ok(claimed.craft_materials.includes('Host report craft materials'))
  const current=await f.read();assert.deepEqual(current.tasks[0].craftDeliveries.map(r=>r.role),['writer','renderer'])
  assert.ok(current.tasks[0].craftDeliveries.every(r=>r.accepted&&r.sessionId==='worker-id'))
  const cold=craftSessionContext(f.stateRoot,'worker-id')
  assert.equal(cold,claimed.craft_materials)
  assert.equal(craftSessionContext(f.stateRoot,'unrelated-session'),'')
  await publish(f)
  current.tasks[0].craftDeliveries[0].contentSha256='0'.repeat(64);await f.write(current)
  await assert.rejects(f.call('update_task',{task_id:'t1',attempt_id:task.attemptId,status:'in_progress'},'worker'),/CRAFT_DELIVERY_STALE/)
})

test('real tools require reviewer preparation and bounded cited review, then integrate exact bytes',async t=>{
  const f=await setup(t);await f.call('claim_task',{task_id:'t1'},'worker');await publish(f)
  await assert.rejects(f.call('quality_review',reviewArgs('invented'),'reviewer'),/CRAFT_REVIEW_PREPARATION_REQUIRED/)
  const prep=await f.call('quality_review',{task_id:'t1',reviewer:'reviewer',prepare_only:true},'reviewer')
  assert.equal(prep.status,'prepared_for_independent_review');assert.ok(prep.craft_materials)
  assert.equal(prep.machine_checks[0].results.length,7)
  assert.ok(prep.machine_checks[0].results.every(r=>r.status==='passed'),JSON.stringify(prep.machine_checks))
  assert.ok(craftSessionContext(f.stateRoot,'reviewer-id').includes('roles reviewer'))
  await assert.rejects(f.call('quality_review',{...reviewArgs(prep.material_receipt),independent_review:[]},'reviewer'),/independent|review/i)
  await f.call('quality_review',reviewArgs(prep.material_receipt),'reviewer')
  const passed=await f.read();assert.equal(passed.qualityRuns.t1.status,'passed')
  const replay=await f.call('quality_review',reviewArgs(prep.material_receipt),'reviewer');assert.equal(replay.review_rounds,1)
  await f.call('quality_integrate',{task_id:'t1',event_id:'integrate-v2',actor:'captain',complete_task:true},'captain')
  const done=await f.read();assert.equal(done.tasks[0].status,'completed');assert.equal(done.qualityRuns.t1.status,'integrated')
  const pub=done.tasks[0].publishedArtifacts.find(a=>a.reviewId==='published:report.md')
  const path=join(f.teamRoot,done.tasks[0].project.artifactsPath,pub.relativePath)
  await writeFile(path,(await readFile(path,'utf8'))+'\nUnreviewed change')
  await assert.rejects(f.call('quality_integrate',{task_id:'t1',event_id:'integrate-v2',actor:'captain',complete_task:true},'captain'),/hash|changed|mismatch|current/i)
})

test('review preparation cannot authorize a changed contract in the same attempt',async t=>{
  const f=await setup(t);await f.call('claim_task',{task_id:'t1'},'worker');await publish(f)
  const prep=await f.call('quality_review',{task_id:'t1',reviewer:'reviewer',prepare_only:true},'reviewer')
  const team=await f.read(),old=team.qualityRuns.t1
  const next=createQualityRun({...old.contract,objective:old.contract.objective+' revised acceptance context'},'new-run-same-attempt')
  team.qualityRuns.t1=next;team.qualityRun=next;await f.write(team)
  await assert.rejects(f.call('quality_review',reviewArgs(prep.material_receipt),'reviewer'),/CRAFT_REVIEW_PREPARATION_REQUIRED/)
})
