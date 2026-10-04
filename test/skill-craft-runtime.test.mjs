/** Real local child processes against disposable installed synthetic packages. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,access,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {createInstalledSkillCraftPack} from './support/skill-craft-fixture.mjs'
const source=process.env.DSH_SKILL_CRAFT_SOURCE==='1'
const {resolveSelectedSkillContract}=await import(source?'../src/skill-craft.ts':'../lib/skill-craft.js')
const {evaluateSkillCraft}=await import(source?'../src/skill-craft-runtime.ts':'../lib/skill-craft-runtime.js')
const q=await import(source?'../src/quality-run.ts':'../lib/quality-run.js')
const {collectTaskEvidence}=await import(source?'../src/quality-runtime.ts':'../lib/quality-runtime.js')
const sha=b=>createHash('sha256').update(b).digest('hex')
const readInput="let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw);"
const success=readInput+"console.log(JSON.stringify(input.resultIds.map(id=>({id,status:'passed',detail:'Synthetic real child inspected fixed artifact bytes'}))));"
async function fixture(t,code=success,extraSkills=[]){
 const workspace=await mkdtemp(join(tmpdir(),'selected-skill-runner-'));t.after(()=>rm(workspace,{recursive:true,force:true}))
 const installed=await createInstalledSkillCraftPack(join(workspace,'domain-packs','synthetic-craft'),{skills:[{id:'compose',runnerCode:typeof code==='function'?code(workspace):code,resultIds:['qa-first','qa-second']},...extraSkills]})
 const selection=await resolveSelectedSkillContract({}, {packsDir:'domain-packs',enabledPacks:[installed.packId]},workspace,installed.selections)
 const spec={id:'selected-skill-craft-v1',md:'published:r.md',html:'published:r.html',pdf:'published:r.pdf',craftEvidence:'published:e.json',selection}
 const ids=[spec.md,spec.html,spec.pdf,spec.craftEvidence],data=['Actual synthetic report prose.','<main>Actual synthetic report prose.</main>',Buffer.from([0,255,128,37,80,68,70]),'{"synthetic":true}']
 const artifacts=ids.map((id,i)=>{const b=Buffer.from(data[i]);return{id,taskId:'t1',attempt:1,path:'artifacts/'+i,sha256:sha(b),content:b.toString('base64'),encoding:'base64'}})
 return{workspace,installed,selection,spec,artifacts,entry:join(installed.root,'skills/compose/scripts/check.mjs')}
}
const all=(results,status)=>assert.ok(results.length>0&&results.every(r=>r.status===status),JSON.stringify(results))
const exists=path=>access(path).then(()=>true,()=>false)

test('real child receives four hash-bound bytes, fixed protocol and no producer filesystem paths',async t=>{
 const f=await fixture(t,readInput+`import {createHash} from 'node:crypto';
 if(input.protocolVersion!==1||Object.keys(input.artifacts).sort().join(',')!=='evidence,html,md,pdf')throw Error('shape');
 for(const a of Object.values(input.artifacts)){if(Object.keys(a).sort().join(',')!=='content,encoding,id,sha256')throw Error('path leaked');if(createHash('sha256').update(Buffer.from(a.content,a.encoding)).digest('hex')!==a.sha256)throw Error('hash')}
 console.log(JSON.stringify(input.resultIds.toReversed().map(id=>({id,status:'passed',detail:'bytes verified'}))));`)
 const results=await evaluateSkillCraft(f.artifacts,f.spec);all(results,'passed');assert.deepEqual(results.map(r=>r.id),['qa-first','qa-second'])
})
test('two explicitly selected skills execute declared checks with disjoint exact result sets',async t=>{
 const f=await fixture(t,success,[{id:'render',runnerCode:success,resultIds:['qa-render']}]);const results=await evaluateSkillCraft(f.artifacts,f.spec);all(results,'passed');assert.deepEqual(results.map(r=>r.id),['qa-first','qa-second','qa-render'])
})
test('collector creates v3 receipt from actual processes and filesystem bytes without global material identity',async t=>{
 const f=await fixture(t);await mkdir(join(f.workspace,'artifacts'));for(const a of f.artifacts)await writeFile(join(f.workspace,a.path),Buffer.from(a.content,a.encoding))
 const contract=q.createQualityContract({id:'runtime',taskId:'t1',attempt:1,assignee:'writer',kind:'implementation',objective:'Real synthetic checker collection',inScope:['artifacts/**'],acceptance:[{id:'present',statement:'Artifacts exist'}],verify:['true'],deliverables:f.artifacts.map(a=>a.id),changedPaths:['artifacts/**'],artifactChecks:[f.spec]})
 const evidence=await collectTaskEvidence({workspaceRoot:f.workspace,contract,artifacts:f.artifacts.map(({id,path})=>({id,path})),acceptanceResults:[{id:'present',passed:true,detail:'Actual local synthetic process, not a business report.'}]})
 const receipt=evidence.artifactCheckReceipts[0];assert.equal(receipt.version,3);assert.equal(receipt.selectionDigest,f.selection.digest);assert.equal(receipt.materialDigest,undefined);assert.deepEqual(receipt.artifacts,f.artifacts.map(({id,sha256})=>({id,sha256})));all(receipt.results,'passed');q.validateArtifactCheckReceipts(contract,evidence,1)
})
for(const [name,body] of [
 ['unknown ID',"[{id:'invented',status:'passed',detail:'fake'}]"],
 ['missing result',"[{id:input.resultIds[0],status:'passed',detail:'partial'}]"],
 ['duplicate result',"input.resultIds.map(()=>({id:input.resultIds[0],status:'passed',detail:'duplicate'}))"],
 ['unknown status',"input.resultIds.map(id=>({id,status:'success',detail:'wrong'}))"],
 ['extra receipt fields',"input.resultIds.map(id=>({id,status:'passed',detail:'fake',receipt:'self-signed'}))"],
 ['envelope instead of result array',"{protocolVersion:1,results:input.resultIds.map(id=>({id,status:'passed',detail:'wrapped'}))}"],
])test('runner fails closed for '+name,async t=>{const f=await fixture(t,readInput+`console.log(JSON.stringify(${body}));`);all(await evaluateSkillCraft(f.artifacts,f.spec),'unverified')})
test('runner fails closed for malformed JSON',async t=>{const f=await fixture(t,readInput+"console.log('not-json');");all(await evaluateSkillCraft(f.artifacts,f.spec),'unverified')})
test('valid failed/unverified observations survive without being reclassified as process success',async t=>{const f=await fixture(t,readInput+"console.log(JSON.stringify(input.resultIds.map((id,i)=>({id,status:i?'unverified':'failed',detail:'Actual declared non-pass'}))));");assert.deepEqual((await evaluateSkillCraft(f.artifacts,f.spec)).map(r=>r.status),['failed','unverified'])})
test('nonzero exit cannot return passing results or expose stderr',async t=>{const f=await fixture(t,success+"console.error('PRIVATE_SENTINEL_not_a_real_secret');process.exitCode=7;");const results=await evaluateSkillCraft(f.artifacts,f.spec);all(results,'unverified');assert.ok(!JSON.stringify(results).includes('PRIVATE_SENTINEL'))})
test('time limit kills a live checker and returns no passing partial results',async t=>{const f=await fixture(t,readInput+"setInterval(()=>{},1000);");const at=Date.now();const result=await evaluateSkillCraft(f.artifacts,f.spec,{timeoutMs:150});all(result,'unverified');assert.match(result[0].detail,/time limit/);assert.ok(Date.now()-at<3000)})
test('pre-cancel does not execute the installed entrypoint',async t=>{const f=await fixture(t,w=>`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(w,'executed'))},'bad');`+success);const ctl=new AbortController();ctl.abort();all(await evaluateSkillCraft(f.artifacts,f.spec,{signal:ctl.signal}),'unverified');assert.equal(await exists(join(f.workspace,'executed')),false)})
test('active cancellation kills the checker after it has begun execution',async t=>{
 const f=await fixture(t,w=>`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(w,'started'))},'yes');`+readInput+"setInterval(()=>{},1000);")
 const ctl=new AbortController(),pending=evaluateSkillCraft(f.artifacts,f.spec,{signal:ctl.signal,timeoutMs:3000});let started=false
 for(let i=0;i<100;i++){if(await exists(join(f.workspace,'started'))){started=true;break}await new Promise(r=>setTimeout(r,10))}
 assert.equal(started,true);ctl.abort();const results=await pending;all(results,'unverified');assert.match(results[0].detail,/cancelled/)
})
test('oversized stdout is unverified rather than silently truncated into a pass',async t=>{const f=await fixture(t,readInput+"console.log('x'.repeat(10000));");const results=await evaluateSkillCraft(f.artifacts,f.spec,{maxOutputBytes:128});all(results,'unverified');assert.match(results[0].detail,/output limit/)})
test('oversized stderr is bounded and never disclosed',async t=>{const f=await fixture(t,readInput+"console.error('PRIVATE_SENTINEL'.repeat(1000));setTimeout(()=>{},1000);");const results=await evaluateSkillCraft(f.artifacts,f.spec,{maxOutputBytes:128});all(results,'unverified');assert.ok(!JSON.stringify(results).includes('PRIVATE_SENTINEL'))})
test('invalid artifact bytes fail before checker execution',async t=>{const f=await fixture(t,w=>`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(w,'executed'))},'bad');`+success);f.artifacts[0].content+='AAAA';all(await evaluateSkillCraft(f.artifacts,f.spec),'failed');assert.equal(await exists(join(f.workspace,'executed')),false)})
test('installed entry byte drift before execution cannot reuse frozen selection',async t=>{const f=await fixture(t);await writeFile(f.entry,success+'\n// changed');all(await evaluateSkillCraft(f.artifacts,f.spec),'unverified')})
test('a checker modifying its installed pack cannot receive an admitted success',async t=>{const f=await fixture(t,readInput+"import {appendFileSync} from 'node:fs';appendFileSync(new URL(import.meta.url),'\\n// drift');console.log(JSON.stringify(input.resultIds.map(id=>({id,status:'passed',detail:'before drift admission'}))));");all(await evaluateSkillCraft(f.artifacts,f.spec),'unverified')})
test('missing installed checker is explicitly unverified',async t=>{const f=await fixture(t);await rm(f.entry);all(await evaluateSkillCraft(f.artifacts,f.spec),'unverified')})
test('symlink replacement cannot escape the frozen pack identity',async t=>{const f=await fixture(t),outside=join(f.workspace,'outside.mjs');await writeFile(outside,success);await rm(f.entry);await symlink(outside,f.entry);all(await evaluateSkillCraft(f.artifacts,f.spec),'unverified')})
test('checker process does not inherit Host credential-like environment or NODE_OPTIONS',async t=>{
 const f=await fixture(t,readInput+"if(process.env.QA_CRAFT_PRIVATE_ENV||process.env.NODE_OPTIONS)throw Error('inherited');console.log(JSON.stringify(input.resultIds.map(id=>({id,status:'passed',detail:'minimal environment'}))));")
 const old=process.env.QA_CRAFT_PRIVATE_ENV,oldNode=process.env.NODE_OPTIONS;process.env.QA_CRAFT_PRIVATE_ENV='synthetic_private';process.env.NODE_OPTIONS='--trace-warnings'
 try{all(await evaluateSkillCraft(f.artifacts,f.spec),'passed')}finally{if(old===undefined)delete process.env.QA_CRAFT_PRIVATE_ENV;else process.env.QA_CRAFT_PRIVATE_ENV=old;if(oldNode===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=oldNode}
})

test('direct report runner refuses an explicitly selected content-only skill without auto-selecting a renderer',async t=>{
 const workspace=await mkdtemp(join(tmpdir(),'selected-skill-partial-'));t.after(()=>rm(workspace,{recursive:true,force:true}))
 const installed=await createInstalledSkillCraftPack(join(workspace,'domain-packs','synthetic-craft'),{skills:[{id:'compose',runnerCode:success,artifactRoles:['md','evidence']}]})
 const selection=await resolveSelectedSkillContract({}, {packsDir:'domain-packs'},workspace,installed.selections)
 assert.deepEqual(selection.artifactRoles,['md','evidence']);assert.equal(selection.selections.length,1)
 const spec={id:'selected-skill-craft-v1',md:'a',html:'b',pdf:'c',craftEvidence:'d',selection}
 const results=await evaluateSkillCraft([],spec);all(results,'failed');assert.match(results[0].detail,/complete declared/);assert.equal(selection.selections.length,1)
})
