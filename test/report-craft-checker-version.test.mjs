import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
const source=process.env.DSH_CRAFT_V2_SOURCE==='1'
const q=await import(source?'../src/quality-run.ts':'../lib/quality-run.js')
const runtime=await import(source?'../src/quality-runtime.ts':'../lib/quality-runtime.js')
const sha=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex')
const clone=structuredClone
function setup(version='report-craft-v2.1',verdict='pass',budget=2){
 const spec={id:'zhijian-report-craft-core-v2',md:'published:report.md',html:'published:report.html',pdf:'published:report.pdf',craftEvidence:'published:craft-evidence.json',materialPackId:'zhijian-report-craft-v2',materialDigest:'a'.repeat(64),style:'credit-policy'}
 const roles=[spec.md,spec.html,spec.pdf,spec.craftEvidence]
 const contract=q.createQualityContract({id:'checker-history',taskId:'t1',attempt:1,assignee:'writer',kind:'implementation',objective:'Versioned synthetic receipt integrity only',inScope:['artifacts/**'],acceptance:[{id:'present',statement:'The synthetic artifacts are accounted for'}],verify:['true'],deliverables:roles,changedPaths:['artifacts/**'],maxRepairRounds:budget,artifactChecks:[spec]})
 const artifacts=roles.map((id,i)=>{const content='A bounded synthetic passage for '+id;return{id,taskId:'t1',attempt:1,path:'artifacts/'+i,content,sha256:sha(content)}})
 const evidence={taskId:'t1',attempt:1,artifacts,acceptanceResults:[{id:'present',passed:verdict==='pass',detail:'Synthetic historical record; no actual business approval.'}],commandsRun:[{command:'true',exitCode:0,passed:true}],changedPaths:artifacts.map(a=>a.path),artifactCheckReceipts:[{version:2,checkId:spec.id,checkerVersion:version,materialDigest:spec.materialDigest,contractDigest:q.qualityContractDigest(contract),taskId:'t1',attempt:1,artifacts:artifacts.map(({id,sha256})=>({id,sha256})),results:q.REPORT_CRAFT_V2_RESULT_IDS.map(id=>({id,status:verdict==='pass'?'passed':'failed',detail:'Synthetic saved observation'}))}],independentReview:{materialReceiptId:'saved-preparation',reviewerSessionId:'reviewer-session',areas:q.INDEPENDENT_REVIEW_AREA_IDS.map(id=>({id,status:verdict==='pass'?'passed':'failed',coverage:'Synthetic history compatibility check',evidence:[{artifactId:spec.md,quote:artifacts[0].content,reason:'Exact historical passage location, not proof of business reasoning.'}]}))}}
 const findings=verdict==='pass'?[]:[{id:'f1',code:'craft',severity:'hard',message:'Saved non-pass result',taskId:'t1',attempt:1}]
 const input={eventId:'old-review',reviewer:'reviewer',verdict,evidence,findings,at:1}
 // Reconstruct a genuine old-version event fingerprint; do not ask the new
 // transition to authorize old evidence just to manufacture a history fixture.
 const initial=q.createQualityRun(contract),event={id:input.eventId,type:'review',actor:input.reviewer,at:1,fingerprint:sha({type:'review',actor:input.reviewer,payload:{verdict,findings,evidence}})}
 const saved={...initial,status:verdict==='pass'?'passed':budget===0?'escalated':'blocked',reviewRounds:1,findings,evidenceHistory:[clone(evidence)],latestEvidence:clone(evidence),lastVerdict:verdict,contractFrozenAt:1,events:[event]}
 return{initial,saved,input,evidence}
}
function integrated(saved){return{...clone(saved),status:'integrated',events:[...saved.events,{id:'old-integrate',type:'integration',actor:'captain',at:2,fingerprint:sha({type:'integration',actor:'captain',payload:{}})}]}}
for(const [name,verdict,budget] of [['passed','pass',2],['blocked','needs_revision',2],['escalated','needs_revision',0]])test('historical v2.1 '+name+' receipt remains readable after checker upgrade',()=>{
 const{saved}=setup('report-craft-v2.1',verdict,budget);assert.equal(q.isQualityRun(clone(saved)),true);assert.doesNotThrow(()=>runtime.assertDurableQualityRun(clone(saved)))
})
test('historical integrated v2.1 loads without mutating the old receipt',()=>{
 const{saved}=setup(),old=integrated(saved),original=JSON.stringify(old);assert.equal(q.isQualityRun(old),true);runtime.assertDurableQualityRun(old);assert.equal(JSON.stringify(old),original)
})
test('exact historical review and integration event replays have no new approval side effect',()=>{
 const{saved,input,evidence}=setup(),done=integrated(saved)
 assert.equal(q.reviewQualityRun(done,input).applied,false)
 assert.equal(q.integrateQualityRun(done,{eventId:'old-integrate',actor:'captain'}).applied,false)
 const recovered=runtime.reviewEvidenceForReplay(done,input.eventId,{artifacts:evidence.artifacts.map(({id,path})=>({id,path})),acceptanceResults:evidence.acceptanceResults,changedPaths:evidence.changedPaths,independentReview:evidence.independentReview});assert.deepEqual(recovered,evidence)
})
test('historical event ID with changed payload still rejects despite version compatibility',()=>{
 const{saved,input}=setup();assert.throws(()=>q.reviewQualityRun(saved,{...input,findings:[{id:'new',code:'info',severity:'info',message:'Changed payload',taskId:'t1',attempt:1}]}),e=>e.code==='idempotency_conflict')
})
test('old v2.1 receipt cannot authorize a fresh pass review',()=>{
 const{initial,input}=setup();assert.throws(()=>q.reviewQualityRun(initial,{...input,eventId:'new-review'}),e=>e.code==='artifact_check_stale')
})
test('old v2.1 passing review cannot authorize a new integration',()=>{
 const{saved}=setup();assert.throws(()=>q.integrateQualityRun(saved,{eventId:'new-integrate',actor:'captain'}),e=>e.code==='artifact_check_stale')
})
test('old v2.1 negative receipt cannot be misrepresented as a fresh checker run',()=>{
 const{initial,input}=setup('report-craft-v2.1','needs_revision');assert.throws(()=>q.reviewQualityRun(initial,{...input,eventId:'new-negative'}),e=>e.code==='artifact_check_stale')
})
test('current v2.2 receipt can authorize new review and integration',()=>{
 assert.equal(q.REPORT_CRAFT_V2_CHECKER_VERSION,'report-craft-v2.2');const{initial,input}=setup(q.REPORT_CRAFT_V2_CHECKER_VERSION)
 const reviewed=q.reviewQualityRun(initial,{...input,eventId:'current-review'}).run,done=q.integrateQualityRun(reviewed,{eventId:'current-integrate',actor:'captain'}).run
 assert.equal(done.status,'integrated');runtime.assertDurableQualityRun(done)
})
test('unknown historical checker versions remain invalid',()=>{
 const{saved}=setup('report-craft-v2.0');assert.equal(q.isQualityRun(saved),false);assert.throws(()=>runtime.assertDurableQualityRun(saved))
})
test('history compatibility does not excuse receipt/artifact/contract identity corruption',()=>{
 for(const mutate of [e=>e.artifactCheckReceipts[0].contractDigest='0'.repeat(64),e=>e.artifactCheckReceipts[0].artifacts[0].sha256='0'.repeat(64),e=>e.artifacts[0].content+='tamper']){
  const{saved}=setup();mutate(saved.latestEvidence);saved.evidenceHistory[0]=clone(saved.latestEvidence);assert.equal(q.isQualityRun(saved),false)
 }
})
