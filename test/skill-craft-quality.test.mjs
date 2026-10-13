/** Pure contract/receipt tests. Synthetic receipts do not claim a real checker run. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
const source=process.env.DSH_SKILL_CRAFT_SOURCE==='1'
const q=await import(source?'../src/quality-run.ts':'../lib/quality-run.js')
const runtime=await import(source?'../src/quality-runtime.ts':'../lib/quality-runtime.js')
const {canonicalDigest}=await import(source?'../src/v2/digest.ts':'../lib/v2/digest.js')
const {isFrozenSkillCraftContract}=await import(source?'../src/skill-craft.ts':'../lib/skill-craft.js')
const sha=x=>createHash('sha256').update(x).digest('hex')
export function syntheticSelection(){
 const body={version:1,artifactRoles:['md','html','pdf','evidence'],selections:[{packId:'qa-craft',skillId:'writer',reason:'Explicit test choice',skillVersion:'1.0.0',skillDigest:'a'.repeat(64),declarationPath:'skills/writer/craft.json',declarationDigest:'b'.repeat(64)}],packs:[{packId:'qa-craft',version:'1.0.0',root:'/tmp/qa-uninstalled-craft-package',treeDigest:'c'.repeat(64)}],materials:[{packId:'qa-craft',skillId:'writer',id:'instructions',path:'skills/writer/SKILL.md',sha256:'d'.repeat(64),bytes:20,roles:['writer','reviewer']}],checks:[{packId:'qa-craft',id:'qa-structure',entrypoint:'skills/writer/check.mjs',sha256:'e'.repeat(64),version:'3.7.0',resultIds:['qa-part-a','qa-part-b']}],reviewAreas:[{id:'domain-evidence',description:'Domain-specific factual limitations'},{id:'domain-reasoning',description:'Domain-specific reasoning'}]}
 return {...body,digest:canonicalDigest(body)}
}
function setup(browser=false){
 const selection=syntheticSelection();if(browser){selection.checks[0].resultIds[1]='report-craft-browser';const{digest,...body}=selection;selection.digest=canonicalDigest(body)}assert.equal(isFrozenSkillCraftContract(selection),true)
 const spec={id:'selected-skill-craft-v1',md:'published:r.md',html:'published:r.html',pdf:'published:r.pdf',craftEvidence:'published:e.json',selection}
 const ids=[spec.md,spec.html,spec.pdf,spec.craftEvidence]
 const contract=q.createQualityContract({id:'qa-v3',taskId:'t1',attempt:1,assignee:'writer',kind:'implementation',objective:'Synthetic v3 contract integrity',inScope:['artifacts/**'],acceptance:[{id:'present',statement:'Artifacts verified'}],verify:['true'],deliverables:ids,changedPaths:['artifacts/**'],artifactChecks:[spec]})
 const artifacts=ids.map((id,i)=>{const content='Distinct located evidence '+i+' supports a bounded independent review.';return{id,taskId:'t1',attempt:1,path:'artifacts/'+i,content,sha256:sha(content)}})
 const evidence={taskId:'t1',attempt:1,artifacts,acceptanceResults:[{id:'present',passed:true,detail:'Synthetic contract test, not a real report approval.'}],commandsRun:[{command:'true',exitCode:0,passed:true}],changedPaths:artifacts.map(a=>a.path),artifactCheckReceipts:[{version:3,checkId:spec.id,selectionDigest:selection.digest,checkers:selection.checks.map(({packId,id,version,sha256,resultIds})=>({packId,id,version,sha256,resultIds:[...resultIds]})),contractDigest:q.qualityContractDigest(contract),taskId:'t1',attempt:1,artifacts:artifacts.map(({id,sha256})=>({id,sha256})),results:selection.checks.flatMap(c=>c.resultIds.map(id=>({id,status:'passed',detail:'Synthetic admitted observation'})))}],independentReview:{materialReceiptId:'qa-prepared',reviewerSessionId:'reviewer',areas:selection.reviewAreas.map(({id})=>({id,status:'passed',coverage:'Located domain-specific observation',evidence:[{artifactId:spec.md,quote:artifacts[0].content,reason:'Exact quotation locates the observation; it is not automatic semantic proof.'}]}))}}
 return{contract,evidence,selection,spec}
}
function review(contract,evidence){return q.reviewQualityRun(q.createQualityRun(contract),{eventId:'review',reviewer:'reviewer',verdict:'pass',evidence}).run}
const errorCode=code=>error=>error.code===code

test('selected skill declares two custom independent areas, without global material/style requirements',()=>{
 const{contract,evidence}=setup();assert.equal(contract.artifactChecks[0].materialDigest,undefined)
 const reviewed=review(contract,evidence),done=q.integrateQualityRun(reviewed,{eventId:'integrate',actor:'captain'}).run
 assert.equal(done.status,'integrated');runtime.assertDurableQualityRun(done)
})
test('v3 cold history and exact replay do not require the installed package still exists',()=>{
 const{contract,evidence}=setup(),reviewed=review(contract,evidence),done=q.integrateQualityRun(reviewed,{eventId:'integrate',actor:'captain'}).run
 const cold=JSON.parse(JSON.stringify(done));runtime.assertDurableQualityRun(cold)
 assert.equal(q.reviewQualityRun(cold,{eventId:'review',reviewer:'reviewer',verdict:'pass',evidence}).applied,false)
 assert.equal(q.integrateQualityRun(cold,{eventId:'integrate',actor:'captain'}).applied,false)
})
test('contract and saved receipt deeply copy selected checker identity arrays',()=>{
 const{contract,evidence,selection}=setup();selection.checks[0].resultIds.push('caller-added');assert.deepEqual(contract.artifactChecks[0].selection.checks[0].resultIds,['qa-part-a','qa-part-b'])
 const reviewed=review(contract,evidence);evidence.artifactCheckReceipts[0].checkers[0].resultIds.push('caller-mutated')
 assert.deepEqual(reviewed.latestEvidence.artifactCheckReceipts[0].checkers[0].resultIds,['qa-part-a','qa-part-b'])
})
for(const [name,mutate] of [
 ['missing result',r=>r.results.pop()],['extra result',r=>r.results.push({id:'invented',status:'passed',detail:'Fake'})],['duplicate result',r=>r.results[1]={...r.results[0]}],['unknown status',r=>r.results[0].status='success'],['missing checker',r=>r.checkers=[]],['self-selected result subset',r=>{r.checkers[0].resultIds.pop();r.results.pop()}],
])test('v3 rejects '+name,()=>{const{contract,evidence}=setup();mutate(evidence.artifactCheckReceipts[0]);assert.throws(()=>q.validateArtifactCheckReceipts(contract,evidence,1))})
for(const [name,mutate] of [
 ['selection digest',r=>r.selectionDigest='0'.repeat(64)],['checker version',r=>r.checkers[0].version='new'],['checker bytes',r=>r.checkers[0].sha256='0'.repeat(64)],['fourth artifact hash',r=>r.artifacts[3].sha256='0'.repeat(64)],['task attempt',r=>r.attempt=2],
])test('v3 receipt binds '+name,()=>{const{contract,evidence}=setup();mutate(evidence.artifactCheckReceipts[0]);assert.throws(()=>q.validateArtifactCheckReceipts(contract,evidence,1),errorCode('artifact_check_binding_mismatch'))})
test('v3 does not accept fixed legacy four-area review instead of selected areas',()=>{const{contract,evidence}=setup();evidence.independentReview.areas=q.INDEPENDENT_REVIEW_AREA_IDS.map(id=>({...evidence.independentReview.areas[0],id}));assert.throws(()=>review(contract,evidence),errorCode('independent_review_invalid'))})
test('v3 rejects a missing declared independent review area',()=>{const{contract,evidence}=setup();evidence.independentReview.areas.pop();assert.throws(()=>review(contract,evidence),errorCode('independent_review_invalid'))})
test('v3 located review rejects non-report quotes',()=>{const{contract,evidence}=setup();evidence.independentReview.areas[0].evidence[0].quote='Not in any artifact';assert.throws(()=>review(contract,evidence),errorCode('independent_review_quote_missing'))})
test('v3 failed independent domain area cannot authorize pass',()=>{const{contract,evidence}=setup();evidence.independentReview.areas[0].status='failed';assert.throws(()=>review(contract,evidence),errorCode('independent_review_failed'))})
test('v3 truthful negative machine/evidence results persist blocked without relaxing pass',()=>{
 const{contract,evidence}=setup();evidence.artifactCheckReceipts[0].results[0].status='failed';evidence.acceptanceResults[0].passed=false;evidence.commandsRun[0]={command:'true',exitCode:1,passed:false};evidence.independentReview.areas[0].status='failed'
 const blocked=q.reviewQualityRun(q.createQualityRun(contract),{eventId:'negative',reviewer:'reviewer',verdict:'needs_revision',evidence,findings:[{id:'f',code:'negative',severity:'hard',message:'Actual negative evidence must persist',taskId:'t1',attempt:1}]}).run
 assert.equal(blocked.status,'blocked');runtime.assertDurableQualityRun(blocked);assert.throws(()=>q.integrateQualityRun(blocked,{eventId:'integrate',actor:'captain'}))
})
test('contract rejects a caller-edited selection without recomputed digest',()=>{const{contract}=setup();contract.artifactChecks[0].selection.reviewAreas[0].description='tampered';assert.throws(()=>q.createQualityContract(contract),errorCode('invalid_contract'))})

test('typed quality contract cannot admit content-only selected skills as a four-format report',()=>{
 const{contract}=setup(),selection=contract.artifactChecks[0].selection
 selection.artifactRoles=['md','evidence'];const{digest,...body}=selection;selection.digest=canonicalDigest(body)
 assert.equal(isFrozenSkillCraftContract(selection),true)
 assert.throws(()=>q.createQualityContract(contract),errorCode('invalid_contract'))
})

function transportBlocked(){
 const{contract,evidence}=setup(),negative=structuredClone(evidence)
 for(const receipt of negative.artifactCheckReceipts)for(const r of receipt.results)Object.assign(r,{status:'failed',detail:'V2 input invalid: artifact bytes/hash mismatch'})
 const run=q.reviewQualityRun(q.createQualityRun(contract),{eventId:'bad-transport-review',reviewer:'reviewer',verdict:'needs_revision',evidence:negative,
 findings:[{id:'transport',code:'HOST_ARTIFACT_CHECK_INPUT_MISMATCH_BLOCKS_PASS',severity:'hard',message:'Synthetic transport failure; artifact bytes unchanged',taskId:'t1',attempt:1}]}).run
 return{run,evidence,args:{eventId:'recheck-1',actor:'captain',reason:'UTF-8 transport repaired',reviewEventId:'bad-transport-review',evidence}}
}
function browserBlocked(){
 const{contract,evidence}=setup(true),negative=structuredClone(evidence)
 Object.assign(negative.artifactCheckReceipts[0].results[1],{status:'unverified',detail:'Browser inspection unavailable: controlled browser executable unavailable'})
 negative.acceptanceResults[0].passed=false
 const run=q.reviewQualityRun(q.createQualityRun(contract),{eventId:'browser-host-review',reviewer:'reviewer',verdict:'needs_revision',evidence:negative,
 findings:[{id:'browser-host',code:'craft-browser-check-blocked-by-host-cache-permission',severity:'hard',message:'Host browser cache was inaccessible',taskId:'t1',attempt:1}]}).run
 const refreshed=structuredClone(evidence);refreshed.acceptanceResults[0].passed=false
 return{run,args:{eventId:'browser-host-recheck',actor:'captain',reason:'Host browser and isolated cache verified',reviewEventId:'browser-host-review',evidence:refreshed}}
}
test('Host browser-cache recovery reopens unchanged work for independent review without consuming repair budget',()=>{
 const{run,args}=browserBlocked(),before=structuredClone(run)
 const next=q.recheckHostQualityRun(run,args).run
 assert.deepEqual(run,before);assert.equal(next.status,'reviewing');assert.equal(next.repairRounds,run.repairRounds)
 assert.equal(next.latestEvidence.artifactCheckReceipts[0].results[1].status,'unverified')
 assert.equal(next.hostRechecks[0].evidence.artifactCheckReceipts[0].results[1].status,'passed')
 assert.equal(next.hostRechecks[0].evidence.acceptanceResults[0].passed,false)
 runtime.assertDurableQualityRun(next)
 const defect=browserBlocked();defect.run.findings[0].code='actual-visual-defect'
 assert.throws(()=>q.recheckHostQualityRun(defect.run,defect.args),/substantive|unrelated/)
})
test('Host recheck preserves failed reviewer acceptance for a fresh independent decision',()=>{
 const f=transportBlocked()
 f.run.latestEvidence.acceptanceResults[0].passed=false
 f.run.evidenceHistory[0].acceptanceResults[0].passed=false
 f.args.evidence.acceptanceResults[0].passed=false
 const next=q.recheckHostQualityRun(f.run,f.args).run
 runtime.assertDurableQualityRun(next)
 assert.equal(next.latestEvidence.acceptanceResults[0].passed,false)
 assert.equal(next.hostRechecks[0].evidence.acceptanceResults[0].passed,false)
 assert.equal(next.status,'reviewing')
})
test('Host recheck retains failed evidence and budget, and only opens independent review on identical bytes',()=>{
 const{run,args,evidence}=transportBlocked(),before=structuredClone(run)
 const next=q.recheckHostQualityRun(run,args).run
 assert.deepEqual(run,before);assert.equal(next.status,'reviewing');assert.equal(next.attempt,run.attempt)
 assert.equal(next.repairRounds,0);assert.equal(next.contract.maxRepairRounds,run.contract.maxRepairRounds)
 assert.deepEqual(next.findings,run.findings);assert.deepEqual(next.evidenceHistory,run.evidenceHistory)
 assert.deepEqual(next.latestEvidence,run.latestEvidence);assert.equal(next.hostRechecks.length,1)
 runtime.assertDurableQualityRun(JSON.parse(JSON.stringify(next)))
 assert.throws(()=>q.integrateQualityRun(next,{eventId:'premature',actor:'captain'}),/passed/)
 const passed=q.reviewQualityRun(next,{eventId:'actual-independent-new-review',reviewer:'reviewer',verdict:'pass',evidence}).run
 assert.equal(q.integrateQualityRun(passed,{eventId:'real-integration',actor:'captain'}).run.status,'integrated')
 assert.equal(q.recheckHostQualityRun(passed,args).applied,false)
 assert.throws(()=>q.recheckHostQualityRun(next,{...args,reason:'conflict'}),/conflict/)
})
for(const[label,mutate]of[
 ['changed bytes',f=>{f.args.evidence.artifacts[0].sha256='0'.repeat(64)}],
 ['changed review identity',f=>{f.args.reviewEventId='older-review'}],
 ['non-captain',f=>{f.args.actor='reviewer'}],
 ['substantive finding',f=>{f.run.findings[0].code='REAL_REPORT_DEFECT'}],
 ['other machine failure',f=>{f.run.latestEvidence.artifactCheckReceipts[0].results[0].detail='Actual clipped text'}],
 ['still failing',f=>{f.args.evidence.artifactCheckReceipts[0].results[0].status='failed'}],
 ['changed reviewer judgement',f=>{f.args.evidence.independentReview.areas[0].coverage='different'}],
])test('Host recheck rejects '+label+' without state changes',()=>{
 const f=transportBlocked();mutate(f);const before=structuredClone(f.run)
 assert.throws(()=>q.recheckHostQualityRun(f.run,f.args));assert.deepEqual(f.run,before)
})
