import test from 'node:test'
import assert from 'node:assert/strict'
import {writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {qualityPublicationFixture} from './support/quality-publication-fixture.mjs'
import {createTaskCore} from '../lib/team-core.js'
import {prepareResearchSubmission} from '../lib/research-submission.js'

async function fixture(t) {
  const f=await qualityPublicationFixture(t),team=await f.read()
  team.planRef={planId:'fixture',templateId:'profile:98wiki-deep-research',templateVersion:'4.0.0',scenarioId:'98wiki-deep-research'}
  team.structuredQualityPolicy={required:true,maxRepairRounds:2}
  team.members[1].capabilityScope={expertId:'bk-001',role:'reviewer'}
  await f.write(team)
  await writeFile(join(f.teamRoot,'expert-tasks/t1/report.md'),'Synthetic rewritten report; no production data.')
  const submit={task_id:'t1',attempt_id:'publication-attempt-1',submission_id:'dynamic-first',status:'in_progress',execution_state:'awaiting_review',output:'Rewritten result ready for independent review',publications:[{name:'report.md',source_path:'report.md'}]}
  return {...f,submit}
}
test('undeclared dynamic follow-up registers first files atomically, reviews and integrates, retry is idempotent',async t=>{
  const f=await fixture(t),before=await f.read()
  await assert.rejects(f.call('update_task',{...f.submit,publications:[{name:'report.md',source_path:'missing.md'}]},'worker'),/ENOENT/)
  assert.deepEqual(await f.read(),before)
  await f.call('update_task',f.submit,'worker')
  let team=await f.read()
  assert.deepEqual(team.tasks[0].declaredPublications,['report.md'])
  assert.deepEqual(team.qualityRuns.t1.contract.deliverables,['task-output','published:report.md'])
  assert.equal(team.qualityRuns.t1.repairRounds,0)
  assert.equal(team.qualityRuns.t1.amendments.length,1)
  await f.call('update_task',f.submit,'worker')
  assert.deepEqual(await f.read(),team)
  const result=await f.review('independent-first')
  assert.equal(result.status,'integrated')
  assert.equal((await f.read()).tasks[0].researchRelease.artifacts.length,1)
})
test('approved seed task cannot silently invent its missing declaration',async t=>{
  const f=await fixture(t),team=await f.read();team.tasks[0].planTask={logicalId:'research_main'};await f.write(team)
  await assert.rejects(f.call('update_task',f.submit,'worker'),/SUBMISSION_FILES_INCOMPLETE.*expected.*received/)
  assert.deepEqual(await f.read(),team)
})
test('existing declaration still rejects omissions and extras and preserves durable state',async t=>{
  const f=await fixture(t);await f.publish('Declared report')
  const before=await f.read()
  await assert.rejects(f.call('update_task',f.submit,'worker'),/missing.*report.txt.*unexpected.*report.md/)
  assert.deepEqual(await f.read(),before)
})
test('invalid names, duplicates, traversal and empty submission do not register files or spend budget',async t=>{
  const f=await fixture(t),before=await f.read()
  for(const publications of [[],[{name:'../escape',source_path:'report.md'}],[...f.submit.publications,...f.submit.publications],[{name:'report.md',source_path:'../report.md'}]]) {
    await assert.rejects(f.call('update_task',{...f.submit,publications},'worker'),/PUBLICATIONS_INVALID|SUBMISSION_FILES_INCOMPLETE|SUBMISSION_PATH_INVALID/)
    assert.deepEqual(await f.read(),before)
  }
})
test('reviewed or repairing undeclared contract cannot auto-register',async t=>{
  const f=await fixture(t),team=await f.read();team.qualityRuns.t1.status='repairing';team.qualityRuns.t1.repairRounds=1;team.qualityRuns.t1.reviewRounds=1;team.qualityRun=team.qualityRuns.t1
  const before=structuredClone(team)
  await assert.rejects(prepareResearchSubmission(f.stateRoot,team,team.tasks[0],f.submit.publications),/SUBMISSION_FILES_INCOMPLETE/)
  assert.deepEqual(team,before)
})
test('captain task creation declares publications in contract and member task input',async t=>{
  const f=await fixture(t)
  assert.ok(f.registered.get('expert_teams_create_task').parameters.properties.produces)
  const captain={id:'captain-id',session:{header:{cwd:f.workspace},append(){}}}
  const ctx={agents:{get(){return captain}},logger:{debug(){},info(){},warn(){}}}
  const config={stateDir:'.expert-teams',memberProvider:'spawn',maxMembers:8,knowledgeDir:'knowledge',packsDir:'domain-packs'}
  const result=await createTaskCore(ctx,config,captain,{subject:'Follow-up rewrite',produces:['report.md','ledger.json']},new AbortController().signal)
  const team=await f.read(),task=team.tasks.find(t=>t.id===result.task_id)
  assert.deepEqual(team.qualityRuns[task.id].contract.deliverables,['task-output','published:ledger.json','published:report.md'])
  const input=JSON.parse(await readFile(join(f.teamRoot,task.project.inputPath),'utf8'))
  assert.deepEqual(input.requiredPublications,['published:ledger.json','published:report.md'])
  const before=await f.read()
  await assert.rejects(createTaskCore(ctx,config,captain,{subject:'Invalid',produces:['../bad']},new AbortController().signal),/PUBLICATIONS_INVALID/)
  assert.deepEqual(await f.read(),before)
})
