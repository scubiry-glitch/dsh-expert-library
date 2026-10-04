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
function setup(){
 const selection=syntheticSelection();assert.equal(isFrozenSkillCraftContract(selection),true)
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
