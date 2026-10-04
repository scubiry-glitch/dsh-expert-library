/** Registered task/plan APIs; synthetic domain package and Host transport only. No model or business calls. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateArgs } from '@deepseek-ai/dsh-tools'
import { createInstalledSkillCraftPack } from './support/skill-craft-fixture.mjs'
const source = process.env.SKILL_CRAFT_TEST_SOURCE === '1'
const load = file => import(source ? `../src/${file}.ts` : `../lib/${file}.js`)
const tools = await load('tools'), state = await load('state'), plans = await load('staged-plan')
const report = await load('report-bundle'), delivery = await load('report-craft-delivery')
const { expandExecutionPlan } = await load('apply')
const { resolveSelectedSkillContract } = await load('skill-craft')
const { canonicalDigest } = await load('v2/digest')
const { PROFILE_SCHEMA, PROFILE_TASKS_SCHEMA } = await load('profile-schema')

async function fixture(t, specs = [{ id: 'compose', artifactRoles: ['md','evidence'], body: 'COMPLETE_WRITER_BODY with exact current requirements.' },
  { id: 'layout', artifactRoles: ['html','pdf'], requires: ['compose'], body: 'COMPLETE_RENDERER_BODY with exact current requirements.' }]) {
  const workspace = await mkdtemp(join(tmpdir(), 'v3-task-integration-'))
  t.after(() => rm(workspace, { recursive:true, force:true }))
  const pack = await createInstalledSkillCraftPack(join(workspace,'domain-packs','local-policy'), { packId:'local-policy', skills:specs })
  const agents = new Map(), registered = new Map(), starts = [], dispatches = []
  const makeAgent = id => { const a={ id, status:'idle', whenIdle:async()=>{}, options:{provider:'test',model:'m'}, session:{id,header:{cwd:workspace},requestHeader:()=>({config:{provider:'test',model:'m'}}),events:[],append(){},steer(){}} }; agents.set(id,a); return a }
  const captain = makeAgent('captain')
  const ctx = { tools:{register(t){registered.set(t.name,t)}}, agents:{get:id=>agents.get(id)}, llm:{resolveCallConfig:async c=>c},
    logger:{debug(){},info(){},warn(){}}, effect(){},on(){},
    subagents:{registerContinuableSetup(){return ()=>undefined},list:()=>['spawn'],listChildren:async()=>[],listDescendants:async()=>[],
      getProvider:()=>({prepareContinuable(){},capabilities:{persona:true,toolFilter:true}}),
      async startContinuable(input){ starts.push(input);makeAgent(input.childId);return {childId:input.childId} },
      async followup(...args){dispatches.push(args)},interrupt(){} } }
  const config={stateDir:'.expert-teams',memberProvider:'spawn',maxMembers:8,knowledgeDir:'knowledge',packsDir:'domain-packs',enabledPacks:['local-policy']}
  const core=tools.registerExpertTeamsTools(ctx,config), stateRoot=join(workspace,config.stateDir)
  const bundle={md:'report.md',html:'report.html',pdf:'report.pdf',craft:{version:3,selections:pack.selections,evidence:'proof.json'}}
  const profile={schemaVersion:1,id:'v3-generic',version:'1',description:'Selected local policy report',protocol:['Use selected materials'],
    members:[{id:'author',name:'author',role:'Writer'},{id:'reviewer',name:'reviewer',role:'Independent reviewer'}],
    taskPlanning:'captain',review:{required:true,maxRepairRounds:2}}
  const args={profile,tasks:[{id:'report',subject:'Synthetic report',owner:'captain',dependsOn:[],acceptance:['Synthetic files reviewed'],reportBundle:bundle}],team_name:'v3-team'}
  const call=(name,args,agent=captain)=>registered.get('expert_teams_'+name).execute(args,{agent,session:agent.session,signal:new AbortController().signal})
  const stage=()=>tools.scenarioStageCore(ctx,config,captain,args)
  const approve=staged=>tools.scenarioApproveFromHost(ctx,config,captain,staged.planId,new AbortController().signal,core,staged.digest,staged.revision)
  const read=()=>state.readTeam(stateRoot,'v3-team')
  return {workspace,stateRoot,...pack,agents,registered,starts,dispatches,ctx,config,core,captain,bundle,profile,args,call,stage,approve,read}
}

async function approved(t, specs) { const f=await fixture(t,specs); const staged=await f.stage(); await f.approve(staged); return {...f,staged} }
const taskOf = team => team.tasks.find(task=>task.planTask?.logicalId==='report')
async function publishAndSubmit(f) {
  let team=await f.read(),task=taskOf(team)
  const claimed=await f.call('claim_task',{task_id:task.id})
  assert.match(claimed.craft_materials,/COMPLETE_WRITER_BODY/)
  assert.match(claimed.craft_materials,/COMPLETE_RENDERER_BODY/)
  team=await f.read();task=taskOf(team)
  for(const [name,body] of [['report.md','Located synthetic evidence is explicitly not a business fact.'],['report.html','<main>Located synthetic evidence</main>'],['report.pdf','Synthetic binary fixture; checker only tests selected protocol.'],['proof.json','{}']]) {
    await writeFile(join(f.stateRoot,team.id,task.project.artifactsPath,name),body)
    await f.call('publish_artifact',{task_id:task.id,attempt_id:task.attemptId,source_path:'artifacts/'+name,name})
  }
  await f.call('update_task',{task_id:task.id,attempt_id:task.attemptId,status:'in_progress',execution_state:'awaiting_review',output:'Synthetic report ready for the independent selected policy review.'})
  return task
}
async function review(f, verdict='pass', event='review-current') {
  const team=await f.read(),task=taskOf(team),run=team.qualityRuns[task.id]
  const reviewer=f.agents.get(team.members.find(m=>m.name==='reviewer').id)
  const prepared=await f.call('quality_review',{task_id:task.id,reviewer:'reviewer',prepare_only:true},reviewer)
  assert.deepEqual(prepared.independent_review_areas,run.contract.artifactChecks[0].selection.reviewAreas)
  assert.equal(prepared.machine_checks[0].version,3)
  const args={task_id:task.id,event_id:event,reviewer:'reviewer',verdict,material_receipt:prepared.material_receipt,
    acceptance_results:run.contract.acceptance.map(a=>({id:a.id,passed:verdict==='pass',detail:'Synthetic files were inspected against their selected policy.'})),
    independent_review:prepared.independent_review_areas.map(a=>({id:a.id,status:verdict==='pass'?'passed':'unverified',coverage:'Synthetic protocol fixture scope',evidence:[{artifactId:'published:report.md',quote:'Located synthetic evidence is explicitly not a business fact.',reason:'This is a located test quotation, not automatic proof of any business claim.'}]})),
    ...(verdict==='pass'?{}:{findings:[{id:'clarify',code:'clarify',severity:'hard',message:'Synthetic clarification required',taskId:task.id,attempt:run.attempt}]})}
  const result=await f.call('quality_review',args,reviewer)
  return {args,result,reviewer,prepared}
}

test('v3 schema allows explicit generic selections but cannot accept Host roots or frozen contracts',async t=>{
  const f=await fixture(t),schema={profile:PROFILE_SCHEMA,tasks:PROFILE_TASKS_SCHEMA,team_name:{type:'string'}}
  const published=f.registered.get('expert_teams_plan_stage').parameters.properties.tasks.items.properties.reportBundle.properties.craft
  assert.equal(published.properties.version.const,3)
  assert.deepEqual(validateArgs(schema,f.args),[])
  for(const edit of [b=>b.craft.selections[0].root='/tmp/forged',b=>b.craft.selections[0].digest='a'.repeat(64),b=>b.craft.frozenSkillCraftContract={}]) {
    const args=structuredClone(f.args);edit(args.tasks[0].reportBundle)
    assert.ok(validateArgs(schema,args).length>0)
    await assert.rejects(tools.scenarioStageCore(f.ctx,f.config,f.captain,args),/reportBundle|unknown|invalid/i)
  }
  const args=structuredClone(f.args);args.tasks[0].frozenSkillCraftContract={}
  await assert.rejects(tools.scenarioStageCore(f.ctx,f.config,f.captain,args),/unknown profile field/)
  assert.equal(f.starts.length,0)
})

test('stage rejects output-role undercoverage without auto-selecting a renderer or writing a draft',async t=>{
  const f=await fixture(t);f.args.tasks[0].reportBundle.craft.selections=[f.selections[0]]
  const frozen=await resolveSelectedSkillContract(f.ctx,f.config,f.workspace,[f.selections[0]])
  assert.deepEqual(frozen.artifactRoles,['md','evidence'])
  assert.equal(report.isReportCraftBinding(f.bundle,frozen),false)
  await assert.rejects(f.stage(),/OUTPUT_COVERAGE.*html, pdf/)
  const plan={tasks:[{reportBundle:f.bundle,frozenSkillCraftContract:frozen}]}
  assert.throws(()=>expandExecutionPlan(plan,{}),/SKILL_CRAFT_CONTRACT_MISMATCH/)
  assert.equal(f.starts.length,0)
})

test('stage/edit preserve DAG plus exact selected contract, and reason changes are digest-visible',async t=>{
  const f=await fixture(t);f.args.tasks.unshift({id:'gate',subject:'Gate',owner:'captain',dependsOn:[]});f.args.tasks[1].dependsOn=['gate']
  const first=await f.stage(),cold=await plans.readStagedPlan(f.stateRoot,first.planId)
  assert.deepEqual(cold,first)
  const check=report.reportArtifactCheck(first.plan.tasks[1].reportBundle,first.plan.tasks[1].frozenSkillCraftContract)
  assert.equal(check.id,'selected-skill-craft-v1');assert.equal(check.selection.packs[0].packId,'local-policy')
  const edited=await tools.scenarioEditCore(f.ctx,f.config,f.captain,first.planId,{profile:{...f.profile,description:'Refined task'}},first.digest,first.revision)
  assert.deepEqual(edited.plan.tasks,first.plan.tasks)
  const tasks=structuredClone(f.args.tasks);tasks[1].reportBundle.craft.selections[0].reason+=' Explicitly refined.'
  const next=await tools.scenarioEditCore(f.ctx,f.config,f.captain,first.planId,{tasks},edited.digest,edited.revision)
  assert.notEqual(next.digest,edited.digest)
  assert.notEqual(next.plan.tasks[1].frozenSkillCraftContract.digest,check.selection.digest)
  assert.equal(f.starts.length,0)
})

test('approve rejects pack-byte drift and disabled selection before any team/session side effects',async t=>{
  const f=await fixture(t),staged=await f.stage(),path=join(f.root,'references/compose.md'),original=await readFile(path)
  await writeFile(path,'Changed selected material after staging')
  await assert.rejects(f.approve(staged),/CONTRACT_CHANGED|DRIFT/)
  assert.equal((await plans.readStagedPlan(f.stateRoot,staged.planId)).status,'staged')
  assert.equal(await f.read(),undefined);assert.equal(f.starts.length,0)
  await writeFile(path,original);f.config.enabledPacks=['disabled']
  await assert.rejects(f.approve(staged),/UNAVAILABLE/)
  assert.equal(f.starts.length,0);f.config.enabledPacks=['local-policy']
  await f.approve(staged);assert.equal(f.starts.length,2)
})

test('manual claim and cold session materials retain the staged generic selection and exact full bodies',async t=>{
  const f=await approved(t),team=await f.read(),task=taskOf(team),frozen=task.frozenSkillCraftContract
  assert.deepEqual(frozen,f.staged.plan.tasks[0].frozenSkillCraftContract)
  assert.deepEqual(team.qualityRuns[task.id].contract.artifactChecks[0].selection,frozen)
  const claim=await f.call('claim_task',{task_id:task.id})
  assert.match(claim.craft_materials,/COMPLETE_WRITER_BODY/);assert.match(claim.craft_materials,/COMPLETE_RENDERER_BODY/)
  const cold=await f.read(),current=taskOf(cold),input=JSON.parse(await readFile(join(f.stateRoot,team.id,current.project.inputPath),'utf8'))
  assert.deepEqual(input.frozenSkillCraftContract,frozen)
  assert.deepEqual(input.artifactChecks[0].selection,frozen)
  assert.ok(current.craftDeliveries.every(r=>r.version===2&&r.selectionDigest===frozen.digest&&r.sessionId===f.captain.id))
  delivery.requireCraftProducerDelivery(cold,current,cold.qualityRuns[task.id])
  const context=delivery.craftSessionContext(f.stateRoot,f.captain.id)
  assert.match(context,/COMPLETE_WRITER_BODY/);assert.match(context,/COMPLETE_RENDERER_BODY/)
  const copied=structuredClone(cold);copied.tasks[0].craftDeliveries[0].attempt++
  assert.throws(()=>delivery.requireCraftProducerDelivery(copied,copied.tasks[0],copied.qualityRuns[task.id]),/NOT_DELIVERED/)
})

test('selected producer assignment carries complete materials in the same accepted dispatch',async t=>{
  const f=await fixture(t);f.args.tasks[0].owner='author'
  const staged=await f.stage();await f.approve(staged)
  const text=JSON.stringify(f.dispatches)
  assert.match(text,/COMPLETE_WRITER_BODY/);assert.match(text,/COMPLETE_RENDERER_BODY/)
  const team=await f.read(),task=taskOf(team)
  assert.equal(task.attempt,1);assert.equal(task.craftDeliveries.length,2)
  assert.ok(task.craftDeliveries.every(r=>r.accepted&&r.channel==='assignment'))
  delivery.requireCraftProducerDelivery(team,task,team.qualityRuns[task.id])
})

test('review preparation and exact replay use selected custom areas and retained current material receipts',async t=>{
  const f=await approved(t);await publishAndSubmit(f)
  const first=await review(f),before=await f.read()
  assert.deepEqual(first.prepared.independent_review_areas.map(a=>a.id),['compose-review','layout-review'])
  await f.call('quality_review',first.args,first.reviewer)
  assert.deepEqual((await f.read()).qualityRuns,before.qualityRuns)
  const changed=structuredClone(first.args);changed.independent_review[0].id='chapter-substance'
  await assert.rejects(f.call('quality_review',changed,first.reviewer),/conflict|area|replay|different evidence/i)
  const task=taskOf(before),prep=task.craftReviewPreparations[0]
  const wrong=structuredClone(task);wrong.craftReviewPreparations[0].runId='replacement'
  assert.throws(()=>delivery.requireCraftReviewPreparation(wrong,before.qualityRuns[task.id],first.reviewer.id,prep.receiptId,before.qualityRuns[task.id].latestEvidence.artifacts),/PREPARATION_REQUIRED/)
})

test('explicit revisions inherit selected contract and remaining repair budget without changing the source',async t=>{
  const f=await approved(t);await publishAndSubmit(f);await review(f,'needs_revision','negative-first')
  let team=await f.read(),task=taskOf(team)
  await f.call('quality_repair',{task_id:task.id,event_id:'repair-first',actor:'captain'})
  await publishAndSubmit(f);await review(f,'pass','review-second')
  await f.call('quality_integrate',{task_id:task.id,event_id:'integrate-second',actor:'captain',complete_task:true})
  const original=await f.read(),sourceTask=taskOf(original),sourceRun=original.qualityRuns[sourceTask.id]
  const revision=await f.call('create_task',{subject:'Explicit follow-up revision',assignee:'captain',revises_task_id:sourceTask.id})
  team=await f.read();task=team.tasks.find(t=>t.id===revision.task_id)
  assert.deepEqual(task.frozenSkillCraftContract,sourceTask.frozenSkillCraftContract)
  assert.deepEqual(task.reportBundle,sourceTask.reportBundle)
  assert.deepEqual(team.qualityRuns[task.id].contract.artifactChecks,sourceRun.contract.artifactChecks)
  assert.equal(team.qualityRuns[task.id].contract.maxRepairRounds,1)
  assert.deepEqual(team.qualityRuns[sourceTask.id],sourceRun)
  const different=structuredClone(f.bundle);different.craft.selections[0].reason='Different selected rationale'
  await assert.rejects(f.call('create_task',{subject:'Cannot change revision selection',assignee:'captain',revises_task_id:sourceTask.id,report_bundle:different}),/CONTRACT_REQUIRED|MISMATCH/)
  const ordinary=await f.call('create_task',{subject:'Independent new report',assignee:'captain',report_bundle:f.bundle})
  assert.equal((await f.read()).qualityRuns[ordinary.task_id].contract.maxRepairRounds,2)
})

test('omitted craft does not select skills, while v1 and v2 keep their original check interpretation',async t=>{
  const f=await fixture(t);delete f.args.tasks[0].reportBundle
  const staged=await f.stage();assert.equal(staged.plan.tasks[0].frozenSkillCraftContract,undefined)
  assert.equal(report.reportArtifactCheck({md:'r.md',html:'r.html',pdf:'r.pdf'}).id,'zhijian-report-craft-core-v1')
  assert.equal(report.reportArtifactCheck({md:'r.md',html:'r.html',pdf:'r.pdf',craft:{version:2,style:'credit-policy',evidence:'e.json'}}).id,'zhijian-report-craft-core-v2')
  const contract=await resolveSelectedSkillContract(f.ctx,f.config,f.workspace,f.selections),forged=structuredClone(contract)
  forged.artifactRoles=['md','evidence'];delete forged.digest;forged.digest=canonicalDigest(forged)
  assert.equal(report.isReportCraftBinding(f.bundle,forged),false)
  assert.throws(()=>report.reportArtifactCheck(f.bundle,forged),/OUTPUT_COVERAGE/)
})


test('four-file report with no renderer material refuses stage and dynamic creation before state mutation',async t=>{
  const f=await fixture(t,[{id:'all-outputs',artifactRoles:['md','html','pdf','evidence'],materials:[{id:'instructions',path:'references/all-outputs.md',roles:['writer','reviewer']}]}])
  await assert.rejects(f.stage(),/MATERIAL_COVERAGE.*renderer/)
  assert.equal(f.starts.length,0);assert.equal(await f.read(),undefined)
  await assert.rejects(readFile(join(f.stateRoot,'plans')),/ENOENT/)
  const selected=f.bundle;delete f.args.tasks[0].reportBundle
  const staged=await f.stage();await f.approve(staged)
  const before=await f.read()
  await assert.rejects(f.call('create_task',{subject:'Missing rendering instructions',assignee:'captain',report_bundle:selected}),/MATERIAL_COVERAGE.*renderer/)
  assert.deepEqual(await f.read(),before)
})


test('new legacy v1/v2 report opt-ins refuse stage and create without downgrading historical parsing',async t=>{
  const f=await fixture(t),base={md:'report.md',html:'report.html',pdf:'report.pdf'}
  const legacy=[base,{...base,craft:{version:2,style:'credit-policy',evidence:'proof.json'}}]
  for(const bundle of legacy){
    assert.equal(report.isReportBundle(bundle),true)
    f.args.tasks[0].reportBundle=bundle
    await assert.rejects(f.stage(),/REPORT_SKILL_SELECTION_REQUIRED/)
  }
  assert.equal(f.starts.length,0);assert.equal(await f.read(),undefined)
  delete f.args.tasks[0].reportBundle;await f.approve(await f.stage())
  const before=await f.read()
  for(const bundle of legacy){
    await assert.rejects(f.call('create_task',{subject:'New report cannot choose legacy checks',assignee:'captain',report_bundle:bundle}),/REPORT_SKILL_SELECTION_REQUIRED|report_bundle\.craft/)
    await assert.rejects(tools.createTaskCore(f.ctx,f.config,f.captain,{subject:'Core cannot bypass selected skill admission',assignee:'captain',reportBundle:bundle}),/REPORT_SKILL_SELECTION_REQUIRED/)
  }
  assert.deepEqual(await f.read(),before)
})
