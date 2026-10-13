import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {checkEvidenceMerge,checkEvidenceReceipts} from '../lib/deep-research-gates.js'
import {qualityPublicationFixture} from './support/quality-publication-fixture.mjs'
import {createQualityRun} from '../lib/quality-run.js'
const sha=x=>createHash('sha256').update(x).digest('hex')
const input=[{task:'research_main',content:'main'},{task:'research_counter',content:'counter'}]
const data=()=>({inputs:input.map(x=>({task:x.task,sha256:sha(x.content)})),sources:[{id:'S1',title:'Synthetic fixture',url:'https://example.org',accessedAt:'2026-10-07'}],externalIncrements:Array.from({length:10},(_,i)=>({id:`E${i}`,sourceId:'S1',claim:`fixture ${i}`,novelty:`fixture increment ${i}`})),status:'CONDITIONAL'})
const md=d=>'```json evidence-merge\n'+JSON.stringify(d)+'\n```'
test('one preflight reports input set AND all invalid source locators',()=>{const d=data();d.inputs.push({task:'outline_final',sha256:sha('outline')});d.sources[0].url='file:///private';assert.throws(()=>checkEvidenceMerge(md(d),input),e=>/exactly.*research_main/.test(e.message)&&/S1.*provider_receipt/.test(e.message))})
test('receipt verifies raw response and invocation bytes, rejects drift and escape',async t=>{
 const root=await mkdtemp(join(tmpdir(),'receipt-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const raw='{"fixture":true}',call=JSON.stringify({cmd:'fixture-provider query',exitCode:0,attemptedAt:'2026-10-07T00:00:00Z',stdoutBytes:Buffer.byteLength(raw)})
 await writeFile(join(root,'raw.json'),raw);await writeFile(join(root,'call.json'),call)
 const d=data();d.sources[0]={...d.sources[0],url:undefined,kind:'provider_receipt',provider:'fixture-provider',receipt:{path:'raw.json',sha256:sha(raw),callPath:'call.json',callSha256:sha(call)}}
 checkEvidenceMerge(md(d),input);await checkEvidenceReceipts(md(d),root)
 await writeFile(join(root,'raw.json'),'changed');await assert.rejects(checkEvidenceReceipts(md(d),root),/SHA256 mismatch/)
 d.sources[0].receipt.path='../outside';await assert.rejects(checkEvidenceReceipts(md(d),root),/team-relative/)
 await symlink('/etc/hosts',join(root,'escape'));d.sources[0].receipt.path='escape';await assert.rejects(checkEvidenceReceipts(md(d),root),/escapes team/)
})
async function compact(t){const f=await qualityPublicationFixture(t);const team=await f.read();team.planRef={scenarioId:'98wiki-deep-research',templateVersion:'4.0.0',templateId:'profile:98wiki-deep-research'};team.tasks[0].planTask={logicalId:'research_main'};team.members[1].capabilityScope={expertId:'bk-001',role:'reviewer'};await f.write(team);await f.publish('synthetic fixture');await f.call('update_task',{task_id:'t1',attempt_id:'publication-attempt-1',submission_id:'s1',status:'in_progress',execution_state:'awaiting_review',output:'Synthetic submission',publications:[{name:'report.txt',source_path:'artifacts/report.txt'}]},'worker');return f}
test('external wait records reason without review verdict or budget charge, even at threshold',async t=>{
 const f=await compact(t), team=await f.read();team.qualityRuns.t1.contract.maxRepairRounds=0;team.qualityRun=team.qualityRuns.t1;await f.write(team)
 const args={task_id:'t1',event_id:'external-1',verdict:'needs_revision',repair_action:'wait_external',acceptance_results:[{id:'present',passed:false}],findings:[{id:'f1',code:'HOST_UNAVAILABLE',severity:'hard',message:'Host transport down; resume when restored',taskId:'t1',attempt:1}]}
 await f.call('quality_review',args,'reviewer');const after=await f.read();assert.equal(after.qualityRuns.t1.status,'pending');assert.equal(after.qualityRuns.t1.reviewRounds,0);assert.equal(after.qualityRuns.t1.repairRounds,0);assert.equal(after.tasks[0].executionState,'blocked_external');assert.equal(after.tasks[0].technicalReviewWaits.length,1)
 await f.call('quality_review',args,'reviewer');assert.equal((await f.read()).tasks[0].technicalReviewWaits.length,1)
})
test('authorized continuation preserves exhausted run, next attempt requires independent review; replay and stale checks',async t=>{
 const f=await compact(t);let team=await f.read();team.qualityRuns.t1.contract.maxRepairRounds=0;team.qualityRun=team.qualityRuns.t1;await f.write(team)
 await f.call('quality_review',{task_id:'t1',event_id:'negative',verdict:'needs_revision',acceptance_results:[{id:'present',passed:false}],findings:[{id:'f1',code:'CONTENT',severity:'hard',message:'Needs correction',taskId:'t1',attempt:1}]},'reviewer')
 await f.call('quality_closeout',{task_id:'t1',event_id:'closeout',reason:'Await user disposition'},'captain');team=await f.read();const old=structuredClone(team.qualityRuns.t1),pubs=team.tasks[0].publishedArtifacts
 const args={task_id:'t1',expected_run_id:old.runId,event_id:'continue-1',reason:'Fix verified technical declaration',user_decision:'User explicitly requests fix and continue',additional_repair_rounds:0}
 await assert.rejects(f.call('quality_continue',args,'worker'),/captain|not leading/i)
 await assert.rejects(f.call('quality_continue',{...args,expected_run_id:'stale'},'captain'),/NOT_EXHAUSTED/)
 await f.call('quality_continue',args,'captain');let after=await f.read();assert.deepEqual(after.qualityRunHistory.t1[0],old);assert.equal(after.qualityRuns.t1.attempt,2);assert.equal(after.qualityRuns.t1.status,'pending');assert.deepEqual(after.tasks[0].publishedArtifacts,pubs);assert.equal(after.tasks[0].qualityContinuations[0].previousCloseout.eventId,'closeout');assert.equal(after.tasks[0].researchRelease,undefined)
 await f.call('quality_continue',args,'captain');assert.equal((await f.read()).tasks[0].qualityContinuations.length,1)
 await assert.rejects(f.call('quality_continue',{...args,additional_repair_rounds:2},'captain'),/CONFLICT/)
})
test('repair threshold configurable above two with finite bounds',()=>{const c={id:'x',taskId:'t1',attempt:1,assignee:'w',kind:'implementation',objective:'x',inScope:['x'],acceptance:[{id:'x',statement:'x'}],verify:['true'],deliverables:['x'],changedPaths:['x'],maxRepairRounds:4};assert.equal(createQualityRun(c,'r').contract.maxRepairRounds,4);assert.throws(()=>createQualityRun({...c,maxRepairRounds:Infinity},'r'))})
