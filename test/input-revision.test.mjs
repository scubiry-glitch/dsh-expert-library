import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { reviseTaskInputs } from '../lib/input-revision.js'
import { createQualityRun, reviewQualityRun, integrateQualityRun } from '../lib/quality-run.js'
import { createTeamDir, createTaskProject, publishTaskArtifact, beginTaskAttempt } from '../lib/state.js'
import { reviewedRelease, pinResearchReleases } from '../lib/research-release.js'
import { prepareDependencyInputs } from '../lib/dependency-inputs.js'
import { qualityPublicationFixture } from './support/quality-publication-fixture.mjs'
const sha = s => createHash('sha256').update(s).digest('hex')
const request = { taskId: 't13', sourceTaskId: 't12', replacementTaskId: 't19', expectedAttempt: 1,
  expectedAttemptId: 'old-attempt', eventId: 'revise-source-1', reason: 'Reviewed correction supersedes the source' }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'source-revision-'))
  t.after(() => rm(root, {recursive:true, force:true}))
  const team = {id:'team',name:'team',captainSessionId:'captain',createdAt:1,taskSeq:19,
    members:[{id:'worker',name:'worker',joinedAt:1,status:'idle'}], tasks:[],qualityRuns:{}}
  const task = (id, status, deps, logical) => ({id, subject:id,status,dependencies:deps,assignee:'worker',attempt:1,createdAt:1,updatedAt:1,
    ...(logical ? {planTask:{logicalId:logical}} : {})})
  const old = task('t12','completed',[],'writer'), next = task('t19','completed',['t12'])
  const consumer = {...task('t13','pending',['t12'],'content_review'),attempt:0,
    plannedArtifactInputs:[{fromTask:'writer',artifact:'report.md',purpose:'review',phase:'work'}]}
  team.tasks=[old,next,consumer]
  await createTeamDir(root,team)
  for(const candidate of team.tasks) candidate.project=await createTaskProject(root,team.id,candidate)
  for(const source of [old,next]) {
    const content=`${source.id} approved report`
    const artifact=await publishTaskArtifact(root,team,source,{name:'report.md',content})
    source.publishedArtifacts=[artifact]
    const path=`team/${source.project.artifactsPath}/${artifact.relativePath}`
    const run=createQualityRun({id:`contract-${source.id}`,taskId:source.id,attempt:1,assignee:'worker',kind:'implementation',objective:source.id,
      inScope:['team/**'],acceptance:[{id:'ok',statement:'reviewed'}],verify:['node --version'],deliverables:['published:report.md'],changedPaths:['team/**'],maxRepairRounds:2})
    team.qualityRuns[source.id]=integrateQualityRun(reviewQualityRun(run,{eventId:'review',reviewer:'independent',verdict:'pass',evidence:{taskId:source.id,attempt:1,
      artifacts:[{id:'published:report.md',path,taskId:source.id,attempt:1,content,sha256:sha(content)}],acceptanceResults:[{id:'ok',passed:true}],
      commandsRun:[{command:'node --version',passed:true,exitCode:0}],changedPaths:[path]}}).run,{eventId:'integrate',actor:'captain'}).run
  }
  team.qualityRuns.t13=createQualityRun({id:'review-contract',taskId:'t13',attempt:1,assignee:'worker',kind:'implementation',objective:'review',
    inScope:['team/**'],acceptance:[{id:'ok',statement:'reviewed'}],verify:['node --version'],deliverables:['task-output'],changedPaths:['team/**'],maxRepairRounds:2})
  await prepareDependencyInputs(root,team,consumer,1)
  Object.assign(consumer,{status:'in_progress',attempt:1,attemptId:'old-attempt',executionState:'awaiting_review'})
  return {root,team,old,next,consumer}
}

test('source revision freezes reviewed replacement, retires old capability and preserves history and budget', async t=>{
  const f=await fixture(t), original=structuredClone(f.team)
  const {team,receipt}=await reviseTaskInputs(f.root,f.team,request,'idle')
  const task=team.tasks.find(t=>t.id==='t13')
  assert.deepEqual(f.team,original,'pure admission must not partly mutate original')
  assert.equal(task.status,'pending');assert.equal(task.attemptId,undefined)
  assert.equal(task.attempt,1);assert.deepEqual(task.dependencies,['t19'])
  assert.equal(task.inputSourceOverrides.writer,'t19')
  assert.equal(task.inputArtifactManifest[0].sha256,f.next.publishedArtifacts[0].sha256)
  assert.equal(receipt.previousManifest[0].sha256,f.old.publishedArtifacts[0].sha256)
  assert.equal(team.qualityRuns.t13.attempt,2);assert.equal(team.qualityRuns.t13.status,'pending')
  assert.equal(team.qualityRuns.t13.contract.maxRepairRounds,2)
  assert.equal(team.qualityRunHistory.t13[0].runId,f.team.qualityRuns.t13.runId)
  beginTaskAttempt(task,'worker')
  await prepareDependencyInputs(f.root,team,task,2)
  assert.equal(task.attempt,2);assert.notEqual(task.attemptId,'old-attempt')
  assert.equal((await reviseTaskInputs(f.root,team,request,'running')).applied,false,'exact retry does not revoke a new attempt')
  await assert.rejects(reviseTaskInputs(f.root,team,{...request,reason:'different'},'idle'),/idempotency conflict/)
})

test('future consumer pins replacement before unrelated human gate is decided',async t=>{
  const f=await fixture(t)
  Object.assign(f.consumer,{status:'pending',attempt:0,attemptId:undefined,executionState:undefined,inputArtifacts:undefined,inputArtifactBinding:undefined,inputArtifactManifest:undefined})
  f.team.tasks.push({id:'gate',subject:'user approval',status:'pending',dependencies:[],createdAt:1,updatedAt:1,humanChoice:{sourceTaskId:'t13',artifact:'report.md',options:['yes','no']}})
  f.consumer.dependencies.push('gate')
  const {team,receipt}=await reviseTaskInputs(f.root,f.team,{...request,expectedAttempt:0,expectedAttemptId:undefined},'idle')
  const task=team.tasks.find(t=>t.id==='t13')
  assert.equal(task.inputArtifactManifest,undefined)
  assert.equal(receipt.nextManifest[0].sourceTaskId,'t19')
  assert.equal(team.tasks.find(t=>t.id==='gate').status,'pending')
  await assert.rejects(prepareDependencyInputs(f.root,team,task,1),/INPUT_DEPENDENCY_NOT_READY/)
})

for(const [label,mutate,activity,pattern] of [
  ['stale capability',f=>{f.consumer.attemptId='new'},'idle',/stale/],
  ['running owner',()=>{},'running',/idle/],
  ['pending activation',f=>{f.team.members[0].activation={id:'busy'}},'idle',/idle/],
  ['unintegrated replacement',f=>{f.team.qualityRuns.t19.status='passed'},'idle',/integrated/],
  ['missing lineage',f=>{f.next.dependencies=[]},'idle',/lineage/],
  ['terminal consumer',f=>{f.consumer.status='completed'},'idle',/terminal/],
  ['passed consumer',f=>{f.team.qualityRuns.t13.status='passed'},'idle',/unreviewed/],
  ['explicit pins',f=>{f.consumer.inputArtifactBinding=undefined},'idle',/explicit/],
  ['cycle',f=>{f.next.dependencies.push('t13')},'idle',/cycle/],
]) test(`rejects ${label} without altering state`,async t=>{
  const f=await fixture(t);mutate(f);const before=structuredClone(f.team)
  await assert.rejects(reviseTaskInputs(f.root,f.team,request,activity),pattern)
  assert.deepEqual(f.team,before)
})

test('tampered reviewed bytes fail before any revised state commits',async t=>{
  const f=await fixture(t), before=structuredClone(f.team)
  await writeFile(join(f.root,'team',f.next.project.artifactsPath,f.next.publishedArtifacts[0].relativePath),'tampered')
  await assert.rejects(reviseTaskInputs(f.root,f.team,request,'idle'),/changed|mismatch/i)
  assert.deepEqual(f.team,before)
})

test('registered revision tool refuses member caller',async t=>{
  const f=await qualityPublicationFixture(t)
  await assert.rejects(f.call('revise_inputs',{task_id:'t1',source_task_id:'t12',replacement_task_id:'t19',expected_attempt:1,event_id:'r1',reason:'revision'},'worker'),/captain|team/i)
})

test('captain can atomically resolve the exact external wait and pin reviewed inputs',async t=>{
  const f=await fixture(t)
  Object.assign(f.consumer,{executionState:'blocked_external',waitReason:'Waiting for corrected figures',dispatch:{id:'old-dispatch'}})
  const before=structuredClone(f.team)
  const req={...request,expectedWaitReason:f.consumer.waitReason}
  const {team,receipt}=await reviseTaskInputs(f.root,f.team,req,'idle')
  const task=team.tasks.find(t=>t.id==='t13')
  assert.deepEqual(f.team,before)
  assert.equal(task.status,'pending')
  assert.equal(task.executionState,undefined)
  assert.equal(task.waitReason,undefined)
  assert.equal(task.dispatch,undefined)
  assert.equal(task.attemptId,undefined)
  assert.deepEqual(task.dependencies,['t19'])
  assert.equal(task.inputArtifactManifest[0].sha256,f.next.publishedArtifacts[0].sha256)
  assert.equal(receipt.expectedWaitReason,'Waiting for corrected figures')
  assert.equal(team.qualityRuns.t13.status,'pending','input recovery never passes review')
  assert.equal((await reviseTaskInputs(f.root,team,req,'running')).applied,false,'exact retry remains safe after dispatch')
})

for (const [label,mutate,expected,activity,pattern] of [
  ['implicit resolution',()=>{},undefined,'idle',/blocked/],
  ['stale wait',()=>{},'Old reason','idle',/wait changed/],
  ['busy owner',()=>{},'Waiting for corrected figures','running',/idle/],
  ['runtime failure',f=>{f.consumer.runtimeBlock={id:'provider-failure'}},'Waiting for corrected figures','idle',/blocked/],
  ['member runtime failure',f=>{f.team.members[0].runtimeBlock={id:'provider-failure'}},'Waiting for corrected figures','idle',/runtime blocker/],
  ['craft drift',f=>{f.consumer.frozenSkillCraftContract={digest:'invalid'}},'Waiting for corrected figures','idle',/SKILL_CRAFT/],
  ['human gate',f=>{f.consumer.humanChoice={sourceTaskId:'t12'}},'Waiting for corrected figures','idle',/human-only/],
]) test(`atomic wait resolution rejects ${label} without changing old state`,async t=>{
  const f=await fixture(t)
  Object.assign(f.consumer,{executionState:'blocked_external',waitReason:'Waiting for corrected figures'})
  mutate(f)
  const before=structuredClone(f.team)
  await assert.rejects(reviseTaskInputs(f.root,f.team,{...request,...(expected===undefined?{}:{expectedWaitReason:expected})},activity),pattern)
  assert.deepEqual(f.team,before)
})

test('failed replacement verification retains external blocker and all original pins',async t=>{
  const f=await fixture(t)
  Object.assign(f.consumer,{executionState:'blocked_external',waitReason:'Waiting for corrected figures'})
  const before=structuredClone(f.team)
  await writeFile(join(f.root,'team',f.next.project.artifactsPath,f.next.publishedArtifacts[0].relativePath),'tampered')
  await assert.rejects(reviseTaskInputs(f.root,f.team,{...request,expectedWaitReason:f.consumer.waitReason},'idle'),/changed|mismatch/i)
  assert.deepEqual(f.team,before)
})

for(const version of ['4.0.0','5.0.0']) test(`${version} authorized revision replaces release pins atomically and keeps ordinary drift checks`,async t=>{
  const f=await fixture(t)
  f.team.planRef={scenarioId:'98wiki-deep-research',templateVersion:version,templateId:'profile:98wiki-deep-research',planId:'test',digest:'0'.repeat(64)}
  for(const source of [f.old,f.next]) source.researchRelease=reviewedRelease(source,f.team.qualityRuns[source.id])
  pinResearchReleases(f.team,f.consumer)
  const original=structuredClone(f.team),oldPins=structuredClone(f.consumer.researchInputReleases)
  const revised=await reviseTaskInputs(f.root,f.team,request,'idle'),task=revised.team.tasks.find(t=>t.id==='t13')
  assert.deepEqual(f.team,original)
  assert.deepEqual(oldPins,{t12:f.old.researchRelease.digest})
  assert.deepEqual(task.researchInputReleases,{t19:f.next.researchRelease.digest})
  beginTaskAttempt(task,'worker');await prepareDependencyInputs(f.root,revised.team,task,2)
  assert.equal((await reviseTaskInputs(f.root,revised.team,request,'running')).applied,false)
  task.researchInputReleases.t19='0'.repeat(64)
  await assert.rejects(prepareDependencyInputs(f.root,revised.team,task,2),/RESEARCH_INPUT_RELEASE_CHANGED/)
})

test('V4 failed replacement byte verification retains the old release pins and wait atomically',async t=>{
  const f=await fixture(t)
  f.team.planRef={scenarioId:'98wiki-deep-research',templateVersion:'4.0.0',templateId:'profile:98wiki-deep-research',planId:'test',digest:'0'.repeat(64)}
  for(const source of [f.old,f.next]) source.researchRelease=reviewedRelease(source,f.team.qualityRuns[source.id])
  pinResearchReleases(f.team,f.consumer)
  Object.assign(f.consumer,{executionState:'blocked_external',waitReason:'Waiting for reviewed replacement'})
  const before=structuredClone(f.team)
  await writeFile(join(f.root,'team',f.next.project.artifactsPath,f.next.publishedArtifacts[0].relativePath),'tampered')
  await assert.rejects(reviseTaskInputs(f.root,f.team,{...request,expectedWaitReason:f.consumer.waitReason},'idle'),/changed|mismatch/i)
  assert.deepEqual(f.team,before)
})
