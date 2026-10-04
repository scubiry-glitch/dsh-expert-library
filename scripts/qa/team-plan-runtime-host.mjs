/** Full staged-profile materialization through real Host Agents; local adapter only. */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { runTeamCommunicationHostSmoke } from './team-communication-host-smoke.mjs'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const url = path => JSON.stringify(pathToFileURL(path).href)
function probePlugin(workspace, nonce) {
  return `
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LlmAdapter, createUserMessage } from ${url('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js')};
import { deliverToMember } from ${url(join(repo, 'lib/members.js'))};
import * as expertToolsPreset from ${url(join(repo, 'lib/preset.js'))};
export const name='team-communication-host-probe';
export const inject=['tools','webServer','agents','subagents','llm','agentPresets','goals'];
const workspace=${JSON.stringify(workspace)},teamId='staged-profile-runtime-probe';
const originalConstraint='ORIGINAL_USER_CONSTRAINT_9f23: never reuse a prior run or relax acceptance checks.';
const additionalConstraint='ADDITIONAL_USER_CONSTRAINT_b813: retain the original request and verify every delivered format.';
const protocolRule='PROFILE_PROTOCOL_a278: report actual failed checks without changing their requirements.';
const reportSelections=[
  {packId:'zhijian-realestate',skillId:'zhijian-report-craft',reason:'This local fixture explicitly selects the installed domain writing policy.'},
  {packId:'zhijian-realestate',skillId:'zhijian-designer-render',variant:'credit-policy',reason:'This local fixture explicitly selects HTML/PDF rendering coverage.'},
];
const reportBundle={md:'report.md',html:'report.html',pdf:'report.pdf',craft:{version:3,selections:reportSelections,evidence:'craft-evidence.json'}};
const state=async()=>JSON.parse(await readFile(join(workspace,'expert-teams',teamId,'team.json'),'utf8'));
const fixturePath=join(workspace,'plan-fixture.json');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let i=0;i<500;i++){if(await check())return;await pause(20)}throw Error('Timed out: '+label)}
export function apply(ctx){
  const requests=[],events=[],expectedPins=new Map(),memberActions=new Map(),planGoalCases=new Map();
  ctx.on('session/event',(_session,event)=>events.push(event));
  class Adapter extends LlmAdapter{
    providerInfo(provider){return {id:provider,name:'Local plan fixture'}}
    async listModels(){return ['stub-a','stub-b'].map(id=>({id,name:id}))}
    async *stream(options){
      const stage=(options.tools??[]).find(t=>t.name==='expert_teams_plan_stage');
      if(stage){
        const properties=stage.parameters.properties;
        assert.ok(properties.profile.properties.members.items.properties.route.properties.model,'missing model-visible nested route schema');
        assert.ok(properties.tasks.items.properties.dependsOn,'missing model-visible task dependency schema');
        assert.ok(properties.tasks.items.properties.dependencies,'missing model-visible dependency alias schema');
        const craft=properties.tasks.items.properties.reportBundle.properties.craft;
        assert.equal(craft.properties.version.const,3,'missing model-visible selected-skill contract');
        assert.equal(properties.profile.additionalProperties,false);
      }
      const supplied=JSON.stringify({messages:options.messages,system:options.system});
      const pin=expectedPins.get(options.sessionId);
      requests.push({sessionId:options.sessionId,model:options.model,tools:(options.tools??[]).map(t=>t.name),captainSchemaChecked:Boolean(stage),
        originalUserConstraint:supplied.includes(originalConstraint),additionalUserConstraint:supplied.includes(additionalConstraint),profileProtocol:supplied.includes(protocolRule),
        pinnedInput:pin===undefined?null:{...pin,observedInRequest:[pin.artifactId,pin.sha256,pin.versionPath].every(value=>supplied.includes(value))}});
      const action=memberActions.get(options.sessionId);
      if(action){memberActions.delete(options.sessionId);const live=ctx.agents.get(options.sessionId);assert.ok(live,'accepted model request must have a live Agent');await action(live);}
      const goalCase=planGoalCases.get(options.sessionId);
      if(goalCase){
        const live=ctx.agents.get(options.sessionId),goal=ctx.goals.get(live);goalCase.requests.push({goal:{...goal}});
        if(!goalCase.staged){goalCase.staged=true;
          const block={type:'tool-call',id:'plan-'+randomUUID(),name:'expert_teams_plan_stage',arguments:JSON.stringify(goalCase.args)};
          yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'tool-calls'}};return;
        }
        // The resumed request is recorded before this bounded fixture parks its own Goal.
        if(goal?.phase==='active')ctx.agents.withInitiator(live,()=>ctx.goals.pause(live,{id:goal.id,revision:goal.revision}));
      }
      yield {type:'block-start',index:0,blockType:'text'};
      yield {type:'text-delta',index:0,text:'Local fixture response.'};
      yield {type:'block-end',index:0,block:{type:'text',text:'Local fixture response.'}};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['round3-plan'],new Adapter()));
  const captainHandle=(id,resume=false)=>ctx.agents[resume?'resume':'create']({
    [resume?'resumeSessionId':'sessionId']:id,agentOptions:{provider:'round3-plan',model:'stub-a'},
    ...(resume?{}:{meta:{cwd:workspace,agentPreset:'standard'}}),
    setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'standard');agentCtx.plugin(expertToolsPreset,{stateDir:'expert-teams',memberProvider:'spawn',memberModel:{provider:'round3-plan',model:'stub-a'},expertModelOverrides:{researcher:{provider:'round3-plan',model:'stub-a'}}})},
  });
  const approveAsUser=async(captain,staged,request)=>{
    const response=await fetch('http://'+request.headers.host+'/plugins/dsh-expert-library/teams',{
      method:'POST',headers:{'content-type':'application/json',cookie:request.headers.cookie??''},
      body:JSON.stringify({action:'approve',captainSessionId:captain.id,planId:staged.planId,expectedDigest:staged.digest,expectedRevision:staged.revision})});
    const payload=await response.json();assert.equal(response.status,200,'authenticated plan approval failed: '+JSON.stringify(payload));
    assert.equal(payload.plan.approval.source,'authenticated-host-user');return payload.plan;
  };
  const call=(agent,name,args)=>agent.ctx.tools.get('expert_teams_'+name,agent).execute(args,{agent,signal:new AbortController().signal});
  const authorityApi=async(req,captain,body,expectedStatus=200,authenticated=true)=>{
    const response=await fetch('http://'+req.headers.host+'/plugins/dsh-expert-library/teams'+(body===undefined?'?captainSessionId='+encodeURIComponent(captain.id)+'&authorization=1':''),{
      method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(authenticated?{cookie:req.headers.cookie??''}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const payload=await response.json();assert.equal(response.status,expectedStatus,JSON.stringify(payload));return payload;
  };
  const fixturePlan=(id)=>({profile:{schemaVersion:1,id,version:'1',description:'Isolated authorization fixture',protocol:[],
    members:[{id:'observer',name:'observer',role:'Fixture observer',route:{provider:'round3-plan',model:'stub-a'},maxDepth:0}],taskPlanning:'captain',review:{required:true,maxRepairRounds:2}},
    tasks:[{id:'gate',subject:'Captain fixture gate',owner:'captain',dependsOn:[],acceptance:['Do not start downstream work']}],team_name:id});
  const exerciseAuthorization=async(req)=>{
    const captain=(await captainHandle('grant-captain-'+randomUUID())).agent;
    const text='EXACT_DIRECT_USER_GRANT_FIXTURE: execute this single isolated plan.';
    captain.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));
    await until(()=>requests.some(r=>r.sessionId===captain.id),'grant direct-user request');await captain.whenIdle();
    const expectedInputSha256=createHash('sha256').update(JSON.stringify([text])).digest('hex');
    const grant={action:'authorize-plan-execution',captainSessionId:captain.id,expectedInputSha256,scope:'single-plan-for-direct-user-input',requireReviewedReport:true,reason:'Authenticated fixture user authorizes one exact-input reviewed report plan.',requestId:'host-fixture-'+randomUUID()};
    await authorityApi(req,captain,grant,401,false);
    await authorityApi(req,captain,{...grant,expectedInputSha256:'0'.repeat(64)},409);
    const accepted=await authorityApi(req,captain,grant);
    assert.equal(accepted.authorization.authorizedBy,'authenticated-host-user');assert.equal(accepted.authorization.expectedInputSha256,expectedInputSha256);
    assert.deepEqual((await authorityApi(req,captain,grant)).authorization,accepted.authorization,'same grant request must replay exactly');
    assert.equal(accepted.authorization.requireReviewedReport,true,'Host route must preserve the authenticated report requirement');
    await assert.rejects(()=>call(captain,'create',{name:'unaudited-bypass'}),/REVIEWED_REPORT_PLAN_REQUIRED/);
    assert.equal((await authorityApi(req,captain)).authorization.consumed,undefined,'ad-hoc refusal cannot consume approval');
    const planned=fixturePlan('authorized-fixture-team');
    planned.profile.review={}; // Existing effective default is required=true; mirrors the observed real caller.
    planned.tasks[0].reportBundle={md:'report.md',html:'report.html',pdf:'report.pdf',craft:{version:3,evidence:'craft-evidence.json',selections:[
      {packId:'zhijian-realestate',skillId:'zhijian-report-craft',reason:'Local fixture explicitly selects content craft'},
      {packId:'zhijian-realestate',skillId:'zhijian-designer-render',variant:'credit-policy',reason:'Local fixture explicitly selects rendering craft'}]}};
    const staged=await call(captain,'plan_stage',planned);
    assert.equal(staged.waitingFor,undefined,'authorized exact input should not wait for another user approval');
    const approved=await call(captain,'plan_approve',{plan_id:staged.planId,expected_digest:staged.digest,expected_revision:staged.revision});
    assert.equal(approved.status,'completed');assert.equal(approved.approval.source,'delegated-host-authorization');
    const reportTeam=JSON.parse(await readFile(join(workspace,'expert-teams',approved.appliedTeamId,'team.json'),'utf8'));
    assert.equal(reportTeam.structuredQualityPolicy.required,true);assert.ok(reportTeam.tasks.some(task=>task.reportBundle?.craft?.version===3&&reportTeam.qualityRuns?.[task.id]));
    const consumed=(await authorityApi(req,captain)).authorization;
    assert.deepEqual([consumed.consumed.planId,consumed.consumed.digest,consumed.consumed.revision],[staged.planId,staged.digest,staged.revision]);
    assert.equal(consumed.consumed.contextSha256,staged.runtime.sharedTaskContext.sha256);
    assert.equal((await call(captain,'plan_approve',{plan_id:staged.planId,expected_digest:staged.digest,expected_revision:staged.revision})).appliedTeamId,approved.appliedTeamId);
    assert.deepEqual((await authorityApi(req,captain)).authorization,consumed,'approval replay cannot consume another grant');
    await captain.whenIdle();
    return {reviewedReportRequirement:true,defaultEnabledReviewAccepted:true,adHocRefusedBeforeSideEffects:true,unauthenticatedGrantRejected:true,wrongInputDigestRejected:true,authenticatedGrantIdempotent:true,exactInputDelegatedApproval:true,consumptionBoundToExactPlan:true,approvalReplayIdempotent:true};
  };
  const exercisePlanGoalWait=async(req,manualEdit=false)=>{
    const captain=(await captainHandle('plan-goal-'+randomUUID())).agent;
    const label='goal-plan-'+(manualEdit?'manual':'owned'),record={args:fixturePlan(label),requests:[],staged:false};planGoalCases.set(captain.id,record);
    ctx.goals.create(captain,{objective:'Await user approval of this isolated research plan before execution.',maxGoalRounds:3});
    await until(()=>captain.status==='idle'&&ctx.goals.get(captain)?.phase==='paused','research plan pauses actual Goal and ends turn');
    const roots=await import('node:fs/promises'),plans=join(workspace,'expert-teams','plans');
    const rows=await Promise.all((await roots.readdir(plans)).filter(f=>f.endsWith('.json')).map(async f=>JSON.parse(await readFile(join(plans,f),'utf8'))));
    const staged=rows.find(p=>p.createdBy===captain.id);assert.ok(staged);assert.equal(staged.waitingFor,'user-confirmation');
    const paused=ctx.goals.get(captain);assert.equal(staged.goalWait.pausedRevision,paused.revision);assert.equal(record.requests.length,1);
    await pause(350);assert.equal(record.requests.length,1,'waiting research plan must not spin model requests');assert.equal(ctx.goals.get(captain).roundsStarted,1);
    const beforeResumes=events.filter(e=>e.type==='goal/change'&&e.data?.operation==='resume').length;
    let edited;
    if(manualEdit)edited=ctx.goals.edit(captain,{id:paused.id,revision:paused.revision},{objective:'User changed this Goal; retain the user-owned pause.'});
    const approved=await approveAsUser(captain,staged,req);assert.equal(approved.status,'completed');
    if(manualEdit){await captain.whenIdle();await pause(100);assert.equal(ctx.goals.get(captain).revision,edited.revision);assert.equal(ctx.goals.get(captain).phase,'paused');}
    else{await until(()=>record.requests.length>=2&&captain.status==='idle','approved research plan resumes real Goal once');assert.equal(record.requests[1].goal.phase,'active');}
    const resumes=events.filter(e=>e.type==='goal/change'&&e.data?.operation==='resume').length-beforeResumes;
    assert.equal(resumes,manualEdit?0:1);
    const response=await fetch('http://'+req.headers.host+'/plugins/dsh-expert-library/teams?captainSessionId='+captain.id+'&planId='+staged.planId,{headers:{cookie:req.headers.cookie??''}});
    const retained=await response.json();assert.equal(response.status,200);assert.equal(retained.plan.status,'completed');assert.equal(retained.plan.approval.source,'authenticated-host-user');
    planGoalCases.delete(captain.id);
    return {realGoalWaitPaused:true,oneModelRoundWhileWaiting:true,userApprovalExecutes:true,exactOwnedPauseResumed:!manualEdit,manualGoalChangePreserved:manualEdit,retainedCompletedPlan:true};
  };

  const memberAction=async(captain,id,prompt,action)=>{
    // Continuable bootstrap deliberately releases idle Agents. Invoke tools
    // while a real accepted plugin message has made the participant resident.
    const outcome=new Promise(resolve=>memberActions.set(id,async child=>{
      try{resolve({value:await action(child)})}catch(error){resolve({error})}
    }));
    assert.equal(await deliverToMember(ctx,captain,id,prompt,new AbortController().signal),true);
    const result=await outcome;const live=ctx.agents.get(id);if(live)await live.whenIdle();
    if(result.error)throw result.error;return result.value;
  };
  const inspectMember=async(captain,id,model)=>{
    const before=requests.filter(r=>r.sessionId===id).length;
    assert.equal(await deliverToMember(ctx,captain,id,'Exercise this persisted member route and tools.',new AbortController().signal),true);
    await until(()=>requests.filter(r=>r.sessionId===id).length>before,'member model request');
    const child=ctx.agents.get(id);if(child)await child.whenIdle();
    const request=requests.filter(r=>r.sessionId===id).at(-1);
    assert.equal(request.model,model);
    for(const tool of ['bash','read','write','expert_teams_wait','expert_teams_quality_review'])assert.ok(request.tools.includes(tool),'member lacks '+tool);
    assert.ok(!request.tools.includes('subagent'));
    assert.equal(request.originalUserConstraint,true,'member request lost the original direct-user constraint');
    assert.equal(request.additionalUserConstraint,true,'member request lost a post-stage direct-user constraint');
    assert.equal(request.profileProtocol,true,'member request lost the selected profile protocol');
    return request;
  };
  // A second isolated captain/team keeps the original gated roster untouched.
  // Every lifecycle mutation uses real registered tools; no synthetic review
  // state or model/user authority is injected into the team file.
  const pinTeamId='automatic-input-runtime-probe';
  const pinState=async()=>JSON.parse(await readFile(join(workspace,'expert-teams',pinTeamId,'team.json'),'utf8'));
  const prepareAutoPins=async(req)=>{
    const captain=(await captainHandle('pin-captain-'+randomUUID())).agent;
    const profile={schemaVersion:1,id:'auto-pin-profile',version:'1',description:'Verify default dependency publication pinning',
      protocol:['Use only this local fixture.'],members:[{id:'consumer',name:'consumer',role:'Independent fixture reviewer and downstream consumer',
        route:{provider:'round3-plan',model:'stub-a'},maxDepth:0}],taskPlanning:'captain',review:{required:true,maxRepairRounds:2}};
    const tasks=[{id:'source',subject:'Known fixture publication',owner:'captain',dependsOn:[],acceptance:['Known fixture bytes were checked']},
      {id:'consumer',subject:'Consume the reviewed immutable version',owner:'consumer',dependsOn:['source'],acceptance:['Read the fixed publication']}];
    const staged=await call(captain,'plan_stage',{profile,tasks,team_name:pinTeamId,goal:profile.description});
    await approveAsUser(captain,staged,req);
    let team=await pinState();const member=team.members[0],bootstrap=ctx.agents.get(member.id);if(bootstrap)await bootstrap.whenIdle();
    assert.equal(requests.filter(r=>r.sessionId===member.id).length,0,'auto-pin member bootstrap unexpectedly requested a model');
    const source=team.tasks.find(t=>t.planTask.logicalId==='source'),consumer=team.tasks.find(t=>t.planTask.logicalId==='consumer');
    assert.equal(consumer.inputArtifacts,undefined,'fixture must exercise omitted inputs');
    const claimed=await call(captain,'claim_task',{task_id:source.id});
    await call(captain,'update_task',{task_id:source.id,status:'in_progress',output:'Known source fixture is ready'});
    const workingPath=join(workspace,'expert-teams',pinTeamId,source.project.path,'artifacts/source.md');
    const content='REVIEWED_IMMUTABLE_FIXTURE_7bd1';await writeFile(workingPath,content);
    await call(captain,'publish_artifact',{task_id:source.id,attempt_id:claimed.attempt_id,source_path:'artifacts/source.md',name:'source.md'});
    await call(captain,'update_task',{task_id:source.id,execution_state:'awaiting_review'});
    team=await pinState();const run=team.qualityRuns[source.id];
    await memberAction(captain,member.id,'Inspect the submitted local source fixture for independent review.',child=>call(child,'quality_review',{task_id:source.id,event_id:'pin-review',reviewer:member.name,verdict:'pass',
      acceptance_results:run.contract.acceptance.map(item=>({id:item.id,passed:true}))}));
    team=await pinState();const artifact=team.tasks.find(t=>t.id===source.id).publishedArtifacts.at(-1);
    const expected={sourceTaskId:source.id,artifactId:artifact.id,reviewArtifactId:artifact.reviewId,attempt:artifact.attempt,sha256:artifact.sha256,
      versionPath:join(workspace,'expert-teams',pinTeamId,source.project.artifactsPath,artifact.relativePath)};
    expectedPins.set(member.id,expected);
    const beforeAssignment=requests.filter(r=>r.sessionId===member.id).length;
    await call(captain,'quality_integrate',{task_id:source.id,event_id:'pin-integrate',actor:'captain',complete_task:true});
    await until(()=>requests.filter(r=>r.sessionId===member.id).length>beforeAssignment,'automatic dependency consumer request');const assigned=ctx.agents.get(member.id);if(assigned)await assigned.whenIdle();await captain.whenIdle();
    team=await pinState();const dispatched=team.tasks.find(t=>t.id===consumer.id),first=requests.filter(r=>r.sessionId===member.id)[beforeAssignment];
    assert.equal(team.qualityRuns[source.id].status,'integrated');assert.equal(team.tasks.find(t=>t.id===source.id).status,'completed');
    assert.deepEqual(dispatched.inputArtifactManifest,[expected]);assert.deepEqual(dispatched.inputArtifactBinding,{mode:'dependency-default',consumerAttempt:dispatched.attempt});
    assert.equal(first.pinnedInput.observedInRequest,true,'first actual model request lacks absolute fixed publication manifest');
    const input=JSON.parse(await readFile(join(workspace,'expert-teams',pinTeamId,dispatched.project.inputPath),'utf8'));
    assert.deepEqual(input.inputArtifactManifest,[expected]);assert.deepEqual(input.inputArtifactBinding,dispatched.inputArtifactBinding);
    await writeFile(workingPath,'LATER_MUTABLE_WORKING_COPY_NOT_REVIEWED');
    const read=await memberAction(captain,member.id,'Read the fixed dependency version after the working copy changed.',child=>call(child,'read_artifact',{task_id:dispatched.id,source_task_id:source.id,artifact_id:artifact.id}));
    assert.equal(read.content,content);assert.equal(read.sha256,artifact.sha256);assert.equal(await readFile(expected.versionPath,'utf8'),content);
    return {captainId:captain.id,memberId:member.id,consumerTaskId:consumer.id,attemptId:dispatched.attemptId,manifest:[expected],content,
      firstRequestContainedFixedManifest:true,mutableSourceChangeDidNotAffectPinnedRead:true,taskInputContainsFixedManifest:true};
  };
  const finishAutoPins=async(f)=>{
    let team=await pinState();const before=team.tasks.find(t=>t.id===f.consumerTaskId);
    assert.deepEqual(before.inputArtifactManifest,f.manifest);assert.equal(before.attemptId,f.attemptId);
    const captain=(await captainHandle(f.captainId,true)).agent;expectedPins.set(f.memberId,f.manifest[0]);
    const read=await memberAction(captain,f.memberId,'Continue the existing task with its persisted fixed dependency input.',child=>call(child,'read_artifact',{task_id:f.consumerTaskId,source_task_id:f.manifest[0].sourceTaskId,artifact_id:f.manifest[0].artifactId}));
    await captain.whenIdle();assert.equal(requests.find(r=>r.sessionId===f.memberId).pinnedInput.observedInRequest,true);
    assert.equal(read.content,f.content);assert.equal(read.sha256,f.manifest[0].sha256);
    team=await pinState();assert.deepEqual(team.tasks.find(t=>t.id===f.consumerTaskId).inputArtifactManifest,f.manifest);
    return {coldFixedInputRead:true,coldRequestContainedFixedManifest:true,sameAttemptId:team.tasks.find(t=>t.id===f.consumerTaskId).attemptId===f.attemptId};
  };
  const verifyTeam=async()=>{
    const team=await state();assert.equal(team.members.length,5);
    assert.equal(team.sharedTaskContext.status,'captured');
    assert.ok(team.sharedTaskContext.messages.some(message=>message.text===originalConstraint));
    assert.ok(team.sharedTaskContext.messages.some(message=>message.text===additionalConstraint));
    assert.ok(team.taskProtocol.includes(protocolRule));
    assert.ok(!team.captainRuntimeBlock&&!team.members.some(m=>m.runtimeBlock),'batch initialization failed');
    assert.equal(new Set(team.members.map(m=>m.id)).size,5);
    const gate=team.tasks.find(t=>t.planTask?.logicalId==='gate');assert.equal(gate.assignee,'captain');
    assert.equal(gate.status,'pending');
    for(const task of team.tasks){
      assert.equal(task.status,'pending');
      assert.deepEqual(task.dependencies,task.id===gate.id?[]:[gate.id],'dependency alias lost its canonical edge during materialization or cold restore');
      const acceptance=team.qualityRuns[task.id].contract.acceptance;
      assert.ok(acceptance.some(item=>item.statement==='Fixture acceptance for '+task.planTask.logicalId),'profile acceptance was discarded');
      const inputPath=join(workspace,'expert-teams',teamId,task.project.inputPath);
      const input=JSON.parse(await readFile(inputPath,'utf8'));
      if(task.planTask.logicalId==='work-delta'){
        const check=team.qualityRuns[task.id].contract.artifactChecks[0];
        assert.equal(task.reportBundle.craft.version,3);assert.deepEqual(task.reportBundle.craft.selections,reportSelections);
        assert.equal(check.id,'selected-skill-craft-v1');assert.deepEqual(check.selection,task.frozenSkillCraftContract);
        assert.deepEqual(input.frozenSkillCraftContract,check.selection);assert.deepEqual(input.artifactChecks[0],check);
        assert.deepEqual(check.selection.artifactRoles,['md','html','pdf','evidence']);
        assert.deepEqual(check.selection.packs.map(p=>p.root),[join(workspace,'domain-packs','zhijian-realestate')]);
        assert.equal(check.selection.checks.flatMap(c=>c.resultIds).length,8);
      }
      assert.equal(input.sharedTaskContext.sha256,team.sharedTaskContext.sha256,'task input lost shared user context');
      assert.deepEqual(input.taskProtocol,team.taskProtocol);
      assert.deepEqual(input.acceptance,acceptance,'task input lost the current acceptance contract');
      assert.equal(input.project.inputPath,inputPath,'task input path is not absolute and exact');
      assert.equal(input.project.path,join(workspace,'expert-teams',teamId,task.project.path));
      assert.equal(input.project.outputPath,join(workspace,'expert-teams',teamId,task.project.outputPath));
      assert.equal(input.project.artifactsPath,join(workspace,'expert-teams',teamId,task.project.artifactsPath));
    }
    return team;
  };
  const server=ctx.get('webServer')??ctx.get('httpServer');
  ctx.effect(()=>server.register({kind:'exact',path:'/plugins/team-communication-host-smoke',handler:async(req,res)=>{
    if(req.headers['x-smoke-nonce']!==${JSON.stringify(nonce)}){res.writeHead(403);res.end();return}
    try{
      const action=new URL(req.url,'http://localhost').searchParams.get('action');let result;
      if(action==='schema')result={stagedProfileProbe:true};
      else if(action==='prepare'&&req.method==='POST'){
        const handle=await captainHandle('plan-captain-'+randomUUID()),captain=handle.agent;
        const human=async text=>{
          const before=requests.filter(request=>request.sessionId===captain.id).length;
          captain.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));
          await until(()=>requests.filter(request=>request.sessionId===captain.id).length>before,'admitted fixture user input');await captain.whenIdle();
        };
        await human(originalConstraint);
        const beforeStaging=requests.length;
        const specs=['alpha','beta','gamma','delta','reviewer'].map((id,index)=>({id,name:id,role:'Isolated fixture '+id,
          ...(index<2?{expert:'researcher'}:{}),route:{provider:'round3-plan',model:index===1?'stub-b':'stub-a'},maxDepth:0}));
        const profile={schemaVersion:1,id:'isolated-profile',version:'1',description:'Validate distinct profile identities and batch startup',protocol:['Use only the local fixture',protocolRule],members:specs,taskPlanning:'captain',review:{required:true,maxRepairRounds:2}};
        const tasks=[{id:'gate',subject:'Captain-controlled gate',owner:'captain',dependencies:[],acceptance:['Fixture acceptance for gate']},
          ...specs.map(s=>({id:'work-'+s.id,subject:'Work '+s.id,owner:s.id,dependencies:['gate'],acceptance:['Fixture acceptance for work-'+s.id],...(s.id==='delta'?{reportBundle}:{})}))];
        const initialProfile={...profile,members:specs.map(({route,...member})=>member)};
        const args={profile:initialProfile,tasks,team_name:teamId,goal:profile.description};
        const preview=await call(captain,'plan_preview',args);assert.equal(preview.members.length,5);assert.equal(new Set(preview.members).size,5);
        assert.deepEqual(preview.tasks.map(t=>t.depends_on),[[],...specs.map(()=>['t1'])]);
        let staged=await call(captain,'plan_stage',args);assert.equal(staged.status,'staged');assert.equal(requests.length,beforeStaging);
        assert.equal(staged.plan.tasks.length,6);
        assert.deepEqual(staged.plan.tasks.map(t=>t.dependsOn),[[],...specs.map(()=>['gate'])]);
        assert.ok(staged.plan.tasks.every(t=>!Object.hasOwn(t,'dependencies')),'staged plan must store canonical dependency fields');
        const originalTasks=structuredClone(staged.plan.tasks);
        const frozen=staged.plan.tasks.find(t=>t.id==='work-delta').frozenSkillCraftContract;
        assert.ok(frozen.digest);assert.deepEqual(frozen.selections.map(({packId,skillId,variant,reason})=>({packId,skillId,...(variant?{variant}:{}),reason})),reportSelections);
        assert.deepEqual(frozen.packs.map(p=>p.root),[join(workspace,'domain-packs','zhijian-realestate')]);
        await assert.rejects(call(captain,'plan_edit',{plan_id:staged.planId,expected_digest:staged.digest,expected_revision:staged.revision,
          tasks:tasks.map((task,index)=>index===1?{...task,dependsOn:[]}:task)}),/dependsOn and dependencies conflict/);
        await human(additionalConstraint);
        await assert.rejects(call(captain,'plan_approve',{plan_id:staged.planId,expected_digest:staged.digest,expected_revision:staged.revision}),/CONTEXT_CHANGED/);
        const beforeEditing=requests.length;
        staged=await call(captain,'plan_edit',{plan_id:staged.planId,expected_digest:staged.digest,expected_revision:staged.revision,profile});
        assert.equal(staged.revision,1);
        assert.deepEqual(staged.plan.tasks,originalTasks,'profile-only route edit changed the task graph');
        assert.equal(requests.length,beforeEditing,'staging/editing invoked a model');
        // Exact current workspace source is part of approval identity. Mutate
        // only this disposable installed fixture; restore exact bytes before
        // approving the same still-editable draft. No source pack is touched.
        const selectedMaterial=frozen.materials[0];
        const selectedRoot=frozen.packs.find(p=>p.packId===selectedMaterial.packId).root;
        const selectedPath=join(selectedRoot,selectedMaterial.path),selectedBytes=await readFile(selectedPath);
        try{
          await writeFile(selectedPath,Buffer.concat([selectedBytes,Buffer.from('\\nQA drift after stage\\n')]));
          await assert.rejects(call(captain,'plan_approve',{plan_id:staged.planId,expected_digest:staged.digest,expected_revision:staged.revision}),/SKILL_CRAFT_.*(?:DRIFT|CHANGED)/);
          await assert.rejects(readFile(join(workspace,'expert-teams',teamId,'team.json')),{code:'ENOENT'});
          assert.equal(requests.length,beforeEditing,'rejected drift spawned a model request');
        }finally{await writeFile(selectedPath,selectedBytes)}
        const waiting=await call(captain,'plan_approve',{plan_id:staged.planId,expected_digest:staged.digest,expected_revision:staged.revision});
        assert.equal(waiting.waitingFor,'user-confirmation');assert.equal(waiting.status,'staged');
        const approved=await approveAsUser(captain,staged,req);
        assert.equal(approved.status,'completed');
        let team=await state();
        for(const member of team.members){const child=ctx.agents.get(member.id);if(child)await child.whenIdle()}
        await captain.whenIdle();await pause(100);team=await verifyTeam();
        assert.equal(requests.length,beforeEditing,'batch bootstrap or dependency-gated member unexpectedly invoked a model');
        const bootstrapErrors=events.filter(e=>e.type==='turn/end'&&e.data?.reason?.kind==='error');assert.equal(bootstrapErrors.length,0);
        const replay=await call(captain,'plan_approve',{plan_id:staged.planId,expected_digest:staged.digest,expected_revision:staged.revision});
        assert.equal(replay.status,'completed');assert.equal((await state()).members.length,5);
        await assert.rejects(call(captain,'plan_stage',args),/already|completed|existing|receipt|overwrite|next_action/i);
        const beta=team.members.find(m=>m.name==='beta');const boundary=await inspectMember(captain,beta.id,'stub-b');
        await captain.whenIdle();
        if(!requests.some(r=>r.sessionId===captain.id)){
          captain.followup(createUserMessage({content:[{type:'text',text:'Inspect your available tool schemas.'}],source:{kind:'plugin',plugin:'team-communication-host-probe'}}));
          await until(()=>requests.some(r=>r.sessionId===captain.id),'captain schema request');await captain.whenIdle();
        }
        assert.ok(requests.some(r=>r.captainSchemaChecked));
        const autoPins=await prepareAutoPins(req);
        const authorization=await exerciseAuthorization(req),planGoalWait=await exercisePlanGoalWait(req),planGoalManualEdit=await exercisePlanGoalWait(req,true);
        await writeFile(fixturePath,JSON.stringify({captainId:captain.id,betaId:beta.id,planId:staged.planId,digest:staged.digest,revision:staged.revision,sharedContextSha256:team.sharedTaskContext.sha256,selectionDigest:frozen.digest,autoPins}));
        result={authorization,planGoalWait,planGoalManualEdit,selectedV3FrozenInStage:true,selectedPackDriftRejectedBeforeTeamCreation:true,sameDigestApprovedAfterExactSourceRestore:true,selectedContractAndInputPreserved:true,hostAndAgentPresetMounted:true,dependencyAliasCanonicalized:true,conflictingDependencyAliasRejected:true,profileOnlyRouteEditPreservedTasks:true,directUserContextPreserved:true,newUserContextRequiresPlanEdit:true,profileProtocolPreserved:true,sharedContextSha256:team.sharedTaskContext.sha256,distinctMembers:5,sharedExpertMembers:2,customMembersWithoutExpert:3,zeroBootstrapRequests:true,noBootstrapErrors:true,captainGatePreserved:true,acceptanceContractsPreserved:true,approvalReplayIdempotent:true,liveTeamRestageRejected:true,modelVisibleNestedSchema:true,boundary,autoPins};
      }else if(action==='finish'&&req.method==='POST'){
        const f=JSON.parse(await readFile(fixturePath,'utf8'));const coldTeam=await verifyTeam();assert.equal(coldTeam.sharedTaskContext.sha256,f.sharedContextSha256);
        assert.equal(coldTeam.tasks.find(t=>t.planTask?.logicalId==='work-delta').frozenSkillCraftContract.digest,f.selectionDigest);
        const handle=await captainHandle(f.captainId,true),captain=handle.agent;
        const boundary=await inspectMember(captain,f.betaId,'stub-b');await captain.whenIdle();
        const replay=await call(captain,'plan_approve',{plan_id:f.planId,expected_digest:f.digest,expected_revision:f.revision});
        assert.equal(replay.status,'completed');await verifyTeam();
        const autoPins=await finishAutoPins(f.autoPins);
        result={coldSelectedContractAndInputPreserved:true,autoPins,coldDependencyAliasEdgesPreserved:true,coldMemberRoutePreserved:true,coldApprovalReplayIdempotent:true,acceptanceContractsPreserved:true,coldUserContextPreserved:true,sharedContextSha256:f.sharedContextSha256,boundary};
      }else{res.writeHead(400);res.end();return}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
    }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error?.stack??error)}))}
  }}));
}
`
}

runTeamCommunicationHostSmoke({probePlugin,kind:'team-plan-real-host-runtime',preserveFailure:true,
  limitations:['Real Host profile preview/stage/approval, batch member startup, model schemas and cold continuation use a local deterministic adapter.','No paid model or business-data API calls; actual end-to-end report completion requires the independent real-tenant rerun.'],
}).then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n')).catch(error=>{process.stderr.write(String(error?.message??error)+'\n');process.exitCode=1})
