import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { qualityPublicationFixture } from './support/quality-publication-fixture.mjs'
import { compactResearchProfile, validateCompactResearchPlan } from '../lib/compact-research-plan.js'
import { parseProfile, profileToExecutionPlan } from '../lib/profiles.js'
import { validateDeepResearchPlan } from '../lib/deep-research-plan.js'
import { prepareDependencyInputs } from '../lib/dependency-inputs.js'
import { assertResearchRelease } from '../lib/research-release.js'
import { readMailbox } from '../lib/state.js'

const legacyPath = '/root/.openclaw/workspace/98wiki/projects/供平过租见底路径/深度研究团队DAG-v3.json'
async function fixture(t) {
  const f = await qualityPublicationFixture(t)
  let team = await f.read()
  team.planRef = { planId:'test-plan',digest:'0'.repeat(64),templateId:'profile:98wiki-deep-research',templateVersion:'4.0.0',scenarioId:'98wiki-deep-research' }
  team.members[1].capabilityScope = { expertId:'bk-001', role:'reviewer' }
  team.tasks[0].planTask = { logicalId:'research_main' }
  await f.write(team)
  await f.publish('Synthetic protocol fixture; no real research data.')
  const submit = { task_id:'t1',attempt_id:'publication-attempt-1',submission_id:'submit-1',status:'in_progress',execution_state:'awaiting_review',output:'Ready for independent review',publications:[{name:'report.txt',source_path:'artifacts/report.txt'}] }
  return {...f,submit}
}

test('v4 is additive: preserves original graph, compiles five producers and two user gates',async()=>{
  const source=JSON.parse(await readFile(legacyPath,'utf8')).profile
  const before=JSON.stringify(source)
  const compact=compactResearchProfile(parseProfile(source))
  assert.equal(JSON.stringify(source),before)
  validateDeepResearchPlan(source)
  validateDeepResearchPlan(compact)
  const parsed=parseProfile(compact)
  const plan=profileToExecutionPlan(parsed,{goal:'Isolated contract validation'})
  assert.equal(plan.template.version,'4.0.0')
  assert.equal(plan.tasks.length,7)
  assert.equal(plan.tasks.filter(t=>t.humanChoice).length,2)
  assert.equal(plan.tasks.filter(t=>!t.humanChoice).length,5)
  assert(!plan.tasks.some(t=>['content_review','evidence_merge','finalqa'].includes(t.id)))
  for(const id of ['writer','renderer']) {
    const invalid=structuredClone(compact)
    invalid.tasks.find(t=>t.id===id).produces=[]
    assert.throws(()=>validateCompactResearchPlan(invalid),/missing publication/)
  }
})

test('submission validates all files before committing, exact retry does not republish, conflict fails',async t=>{
  const f=await fixture(t)
  const before=await f.read()
  await assert.rejects(f.call('update_task',{...f.submit,publications:[{name:'report.txt',source_path:'artifacts/absent.txt'}]},'worker'),/ENOENT/)
  assert.deepEqual(await f.read(),before)
  await f.call('update_task',f.submit,'worker')
  const submitted=await f.read()
  assert.equal(submitted.tasks[0].executionState,'awaiting_review')
  assert(submitted.tasks[0].submissionReceipt)
  const pubCount=submitted.tasks[0].publishedArtifacts.length
  await f.call('update_task',f.submit,'worker')
  assert.equal((await f.read()).tasks[0].publishedArtifacts.length,pubCount)
  await assert.rejects(f.call('update_task',{...f.submit,output:'Changed'},'worker'),/IDEMPOTENCY_CONFLICT/)
  await assert.rejects(f.call('update_task',{task_id:'t1',attempt_id:f.submit.attempt_id,output:'Changed'},'worker'),/SUBMISSION_FROZEN/)
  const inbox=await readMailbox(f.stateRoot,'publication-admission','reviewer')
  assert.equal(inbox.filter(m=>m.idempotencyKey?.startsWith('compact-review:')).length,1)
})

test('real registered review atomically integrates, releases and completes; response-loss retry is safe',async t=>{
  const f=await fixture(t)
  await f.call('update_task',f.submit,'worker')
  const result=await f.review('review-1')
  assert.equal(result.status,'integrated')
  assert.equal(result.task_status,'completed')
  const team=await f.read(),task=team.tasks[0]
  const release=assertResearchRelease(team,task)
  assert.equal(release.reviewEventId,'review-1')
  assert.equal(release.integrationEventId,'host-integrate:review-1')
  assert.equal(task.finalizedAttemptId,f.submit.attempt_id)
  assert.equal(team.qualityRuns.t1.events.filter(e=>['review','integration'].includes(e.type)).length,2)
  await f.review('review-1')
  await f.call('update_task',f.submit,'worker')
  assert.deepEqual((await f.read()).tasks[0].researchRelease,release)
})

test('negative review preserves an explicit repair state without releasing downstream',async t=>{
  const f=await fixture(t)
  await f.call('update_task',f.submit,'worker')
  const result=await f.call('quality_review',{task_id:'t1',event_id:'negative-1',verdict:'needs_revision',acceptance_results:[{id:'present',passed:false}],findings:[{id:'f1',code:'CONTENT',severity:'hard',message:'Missing real evidence',taskId:'t1',attempt:1}]},'reviewer')
  assert.equal(result.status,'blocked')
  let team=await f.read()
  assert.equal(team.tasks[0].executionState,'awaiting_review')
  assert.equal(team.tasks[0].researchRelease,undefined)
  const consumer={id:'t2',status:'pending',dependencies:['t1'],planTask:{logicalId:'writer'}}
  await assert.rejects(prepareDependencyInputs(f.stateRoot,team,consumer,1),/RESEARCH_RELEASE_MISSING/)
  const repaired=await f.call('quality_repair',{task_id:'t1',event_id:'repair-1',actor:'captain'},'captain')
  assert.equal(repaired.attempt,2)
  team=await f.read()
  assert.equal(team.tasks.length,1)
  assert.equal(team.qualityRuns.t1.repairRounds,1)
})

test('downstream pins one approved bundle; tampered release is rejected',async t=>{
  const f=await fixture(t)
  await f.call('update_task',f.submit,'worker');await f.review('review-1')
  const team=await f.read()
  const consumer={id:'t2',status:'pending',dependencies:['t1'],planTask:{logicalId:'writer'},plannedArtifactInputs:[{fromTask:'research_main',artifact:'report.txt',purpose:'test',phase:'work'}]}
  const pins=await prepareDependencyInputs(f.stateRoot,team,consumer,1)
  assert.equal(pins.length,1)
  assert.equal(consumer.researchInputReleases.t1,team.tasks[0].researchRelease.digest)
  team.tasks[0].researchRelease.artifacts[0].sha256='f'.repeat(64)
  await assert.rejects(prepareDependencyInputs(f.stateRoot,team,consumer,1),/RESEARCH_RELEASE_CHANGED/)
})

test('independent reviewer cannot accept corrupted immutable bytes, no partial advancement',async t=>{
  const f=await fixture(t)
  await f.call('update_task',f.submit,'worker')
  const team=await f.read(),task=team.tasks[0],artifact=task.publishedArtifacts.at(-1)
  await writeFile(join(f.teamRoot,task.project.artifactsPath,artifact.relativePath),'Corrupt')
  await assert.rejects(f.review('review-corrupt'),/PUBLISHED|ARTIFACT|changed|HASH/i)
  const after=await f.read()
  assert.equal(after.qualityRuns.t1.status,'pending')
  assert.equal(after.tasks[0].status,'in_progress')
  assert.equal(after.tasks[0].researchRelease,undefined)
})

test('legacy teams retain separate review and captain integration',async t=>{
  const f=await qualityPublicationFixture(t)
  await f.publish('Legacy publication')
  const result=await f.review('legacy-review')
  assert.equal(result.status,'passed')
  assert.equal((await f.read()).tasks[0].status,'in_progress')
  assert.equal((await f.read()).tasks[0].researchRelease,undefined)
})

test('review plus repair is one idempotent transaction on the same task, with durable budget',async t=>{
  const f=await fixture(t)
  await f.call('update_task',f.submit,'worker')
  const args={task_id:'t1',event_id:'revision-1',verdict:'needs_revision',repair_action:'revise',acceptance_results:[{id:'present',passed:false}],findings:[{id:'f1',code:'CONTENT',severity:'hard',message:'Correct the missing definition in the report',taskId:'t1',attempt:1}]}
  const result=await f.call('quality_review',args,'reviewer')
  assert.equal(result.status,'repairing')
  let team=await f.read()
  assert.equal(team.tasks.length,1)
  assert.equal(team.qualityRuns.t1.attempt,2)
  assert.equal(team.qualityRuns.t1.repairRounds,1)
  assert.equal(team.tasks[0].researchRelease,undefined)
  const replay=await f.call('quality_review',args,'reviewer')
  assert.equal(replay.replayed,true)
  await assert.rejects(f.call('quality_review',{...args,repair_action:'wait_external'},'reviewer'),/IDEMPOTENCY_CONFLICT/)
  team=await f.read()
  assert.equal(team.qualityRuns.t1.repairRounds,1)
  const claim=await f.call('claim_task',{task_id:'t1'},'worker')
  await f.call('update_task',{task_id:'t1',attempt_id:claim.attempt_id,status:'in_progress'},'worker')
  await writeFile(join(f.teamRoot,team.tasks[0].project.path,'artifacts/report.txt'),'Corrected synthetic definition; no business data.')
  await f.call('update_task',{...f.submit,attempt_id:claim.attempt_id,submission_id:'submit-2'},'worker')
  const accepted=await f.review('review-2')
  assert.equal(accepted.status,'integrated')
  team=await f.read()
  assert.equal(team.tasks[0].researchRelease.attempt,2)
  assert.equal(team.tasks[0].researchRelease.taskId,'t1')
  assert.equal(team.qualityRuns.t1.evidenceHistory.length,2)
})

test('self-review and proxy review cannot exploit automatic advancement',async t=>{
  const f=await fixture(t)
  await f.call('update_task',f.submit,'worker')
  const args={task_id:'t1',event_id:'forged-pass',reviewer:'reviewer',verdict:'pass',acceptance_results:[{id:'present',passed:true}]}
  await assert.rejects(f.call('quality_review',args,'worker'),/IDENTITY|REVIEWER/)
  await assert.rejects(f.call('quality_review',args,'captain'),/IDENTITY|REVIEWER/)
  assert.equal((await f.read()).qualityRuns.t1.status,'pending')
})

test('concurrent exact reviews settle a single bundle and a single integration event',async t=>{
  const f=await fixture(t)
  await f.call('update_task',f.submit,'worker')
  const results=await Promise.allSettled([f.review('concurrent-review'),f.review('concurrent-review')])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,2, results.filter(r=>r.status==='rejected').map(r=>String(r.reason)).join('; '))
  const team=await f.read()
  assert.equal(team.qualityRuns.t1.events.filter(e=>e.type==='integration').length,1)
  assertResearchRelease(team,team.tasks[0])
})

test('the review page can download the immutable reviewed bundle under its team scope',async t=>{
  const { listReviewDocuments, readReviewDocument }=await import('../lib/host/review-documents.js')
  const f=await fixture(t)
  await f.call('update_task',f.submit,'worker');await f.review('download-review')
  const target={stateRoot:f.stateRoot,teamId:'publication-admission',captainSessionId:'captain-id'}
  const docs=await listReviewDocuments(target)
  assert(docs.some(d=>d.name==='reviewed-input-bundle.json'))
  const file=await readReviewDocument(target,'t1','reviewed-input-bundle')
  const bundle=JSON.parse(file.content)
  assert.equal(bundle.reviewEventId,'download-review')
  await assert.rejects(readReviewDocument({...target,captainSessionId:'other'},'t1','reviewed-input-bundle'),/DOCUMENT_UNAVAILABLE/)
})

test('committed submission reconstructs a missing review outbox on recovery',async t=>{
  const f=await fixture(t)
  await f.call('update_task',f.submit,'worker')
  await writeFile(join(f.teamRoot,'inbox/reviewer.jsonl'),'')
  // Simulate death after team commit but before review-message projection.
  // Status recovery reads only persisted team state; no original request is needed.
  await f.call('status',{},'captain')
  await f.call('status',{},'captain')
  const inbox=await readMailbox(f.stateRoot,'publication-admission','reviewer')
  assert.equal(inbox.filter(m=>m.idempotencyKey?.startsWith('compact-review:')).length,1)
  assert.equal((await f.read()).tasks[0].attempt,1)
})
