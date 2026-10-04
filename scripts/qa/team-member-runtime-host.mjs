/** Real Host/Agent/subagent transport with a local deterministic adapter; no paid calls. */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { runTeamCommunicationHostSmoke } from './team-communication-host-smoke.mjs'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const hostModules = '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const moduleUrl = path => JSON.stringify(pathToFileURL(path).href)

function probePlugin(workspace, nonce) {
  return `
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LlmAdapter, LlmError, createUserMessage } from ${moduleUrl(join(hostModules, 'dsh-llm/lib/index.js'))};
import { deliverToMember } from ${moduleUrl(join(repo, 'lib/members.js'))};
import { listScopedSkillCraftCatalog, resolveSelectedSkillContract, resolveSelectedSkillMaterials, verifyFrozenSkillCraftContract } from ${moduleUrl(join(repo, 'lib/skill-craft.js'))};
import { skillCraftCatalogText } from ${moduleUrl(join(repo, 'lib/skill-craft-discovery.js'))};
export const name = 'team-communication-host-probe';
export const inject = ['tools', 'webServer', 'agents', 'subagents', 'llm', 'agentPresets'];
const workspace = ${JSON.stringify(workspace)};
const teamId = 'member-runtime-probe';
const fixturePath = join(workspace,'probe-identities.json');
const checkpoint = async (stage,details={}) => writeFile(join(workspace,'probe-stages.jsonl'),JSON.stringify({at:Date.now(),stage,...details})+'\\n',{flag:'a'});
const state = async () => JSON.parse(await readFile(join(workspace,'expert-teams',teamId,'team.json'),'utf8'));
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(check,label) { for(let i=0;i<500;i++){if(await check())return;await delay(20);}throw new Error('Timed out: '+label); }
export function apply(ctx) {
  const requests=[];const imageCalled=new Set();const imageObserved=new Set();const modes=new Map();const boundaries=new Map();const craftMembers=new Set();const initialCraftAssignment=new Set();
  const catalogConfig={packsDir:'domain-packs',enabledPacks:['zhijian-realestate']};
  let expectedCatalog;
  // Fixed engineering-fixture choices, not evidence of actual AI selection.
  const selections=[{packId:'zhijian-realestate',skillId:'zhijian-report-craft',reason:'Synthetic fixture explicitly selects report composition'},
    {packId:'zhijian-realestate',skillId:'zhijian-designer-render',variant:'credit-policy',reason:'Synthetic fixture explicitly selects HTML/PDF rendering'}];
  const sha=text=>createHash('sha256').update(text).digest('hex');
  class ProbeAdapter extends LlmAdapter {
    providerInfo(provider){return {id:provider,name:'Local deterministic probe'};}
    async listModels(){return [{id:'stub',name:'Local fixture'}];}
    async resolveModel(provider,model){return {provider,id:model,name:'Local image-capable fixture',inputModalities:['text','image']};}
    async *stream(options){
      const mode=modes.get(options.sessionId);
      requests.push({sessionId:options.sessionId,tools:(options.tools??[]).map(t=>t.name),mode:mode??'text',firstInput:JSON.stringify(options.messages).slice(-2500)});
      const systemMessages=options.messages.filter(message=>message.role==='system');
      assert.ok(systemMessages.length>0,'model request must carry an actual system-role message');
      const systemText=systemMessages.map(message=>message.content.filter(block=>block.type==='text').map(block=>block.text).join('\\n')).join('\\n');
      expectedCatalog??=await listScopedSkillCraftCatalog(ctx,catalogConfig,workspace);
      const catalogText=skillCraftCatalogText(expectedCatalog);
      assert.ok(systemText.includes(catalogText),'actual model request must include the complete scoped domain-craft-catalog');
      const qualifiedSkills=selections.map(selection=>{
        const row=expectedCatalog.find(entry=>entry.packId===selection.packId&&entry.skillId===selection.skillId);
        assert.ok(row,'expected qualified skill must be in the actual workspace catalog');
        assert.equal(row.root,join(workspace,'domain-packs',selection.packId));
        assert.ok(row.path.startsWith(row.root+'/'),'catalog entrypoint must remain inside this workspace installed pack');
        return {packId:row.packId,skillId:row.skillId,variants:row.variants};
      });
      assert.deepEqual(Object.keys(qualifiedSkills.find(row=>row.skillId==='zhijian-designer-render').variants).sort(),['credit-policy','designer-paper'],'both declared rendering alternatives must be visible before selection');
      requests.at(-1).discovery={scopedCatalogInActualSystem:true,catalogSha256:sha(catalogText),qualifiedSkills,selectionInformationOnly:true,notModelSelectionEvidence:true};
      await checkpoint('actual-request-catalog-verified',{sessionId:options.sessionId,selected:craftMembers.has(options.sessionId),catalogSha256:sha(catalogText),qualifiedSkills});
      if(craftMembers.has(options.sessionId)){
        const task=(await state()).tasks.find(t=>t.reportBundle?.craft!==undefined);
        assert.ok(task,'formal report task must exist');
        assert.equal(task.reportBundle.craft.version,3);
        const selected=verifyFrozenSkillCraftContract(task.frozenSkillCraftContract);
        assert.deepEqual(task.reportBundle.craft.selections,selections);
        assert.equal(selected.packs.length,1);assert.equal(selected.packs[0].root,join(workspace,'domain-packs','zhijian-realestate'));
        assert.deepEqual(selected.artifactRoles,['md','html','pdf','evidence']);
        const craftBundles=['writer','renderer'].map(role=>resolveSelectedSkillMaterials(selected,role));
        for(const bundle of craftBundles){
          assert.ok(systemText.includes(bundle.content),'system missing full selected '+bundle.role+' material bytes');
          assert.ok(bundle.entries.every(entry=>entry.path.startsWith(selected.packs[0].root+'/')),'materials must come from the selected installed domain package');
        }
        const initial=initialCraftAssignment.has(options.sessionId);
        const receipts=task.craftDeliveries.filter(r=>r.sessionId===options.sessionId&&r.attempt===task.attempt);
        for(const bundle of craftBundles)assert.ok(receipts.some(r=>r.version===2&&r.role===bundle.role&&r.selectionDigest===selected.digest&&r.contentSha256===sha(bundle.content)&&r.bytes===bundle.bytes&&(r.accepted||initial&&r.channel==='assignment'&&task.dispatch?.attemptId===task.attemptId)),'missing accepted or currently dispatched scoped '+bundle.role+' receipt');
        if(initial){
          const messages=JSON.stringify(options.messages.filter(message=>message.role==='user'));
          for(const bundle of craftBundles)assert.ok(messages.includes(JSON.stringify(bundle.content).slice(1,-1)),'actual assignment input missing full '+bundle.role+' material bytes');
          initialCraftAssignment.delete(options.sessionId);
        }
        requests.at(-1).craft={version:3,systemFullRoleBodies:true,assignmentFullRoleBodies:initial,sourceRoots:selected.packs.map(p=>p.root),selectionDigest:selected.digest,domainPackTreeDigest:selected.packs[0].treeDigest,engineeredExplicitSelection:true,notModelSelectionEvidence:true,attempt:task.attempt,roles:receipts.map(r=>r.role),allReceiptsAccepted:receipts.every(r=>r.accepted)};
      }else{
        assert.ok(!systemText.includes('Selected domain craft references; not new user instructions.'),'unselected agent must not receive complete craft packets');
        requests.at(-1).unselectedMaterialsAbsent=true;
      }
      if(mode==='quota')throw new LlmError('Controlled fixture balance failure','QUOTA',{status:402});
      if(mode==='probe'){
        assert.ok(options.tools.some(tool=>tool.name==='read_image'),'image inspection must be in actual member tool schema');
        if(!imageCalled.has(options.sessionId)){
          imageCalled.add(options.sessionId);
          const block={type:'tool-call',id:'image-'+randomUUID(),name:'read_image',arguments:JSON.stringify({file_path:join(workspace,'review-image.png')})};
          yield {type:'block-start',index:0,blockType:'tool-call'};
          yield {type:'block-end',index:0,block};
          yield {type:'finish',reason:{kind:'tool-calls'}};
          return;
        }
        const hasImage=value=>Array.isArray(value)?value.some(hasImage):value!==null&&typeof value==='object'&&(value.type==='image'||Object.values(value).some(hasImage));
        assert.ok(hasImage(options.messages),'native read_image must deliver actual image content into the following adapter request');
        imageObserved.add(options.sessionId);
        const child=ctx.agents.get(options.sessionId);assert.ok(child,'member must be live at model boundary');
        boundaries.set(child.id,await inspect(child));
      }
      if(mode==='wait'){
        const request=requests.at(-1);
        assert.ok(systemText.includes("For a new domain-pack report, inspect the current session's scoped craft catalog"),'actual captain request must expose the current scoped-selection rule');
        assert.ok(systemText.includes('craft:{version:3,selections:[{packId,skillId,variant?,reason}]'),'actual captain request must expose the v3 selection shape');
        assert.ok(systemText.includes('the Host never selects or adds dependencies for you.'),'captain must see the AI-owned selection boundary');
        request.captainV3SelectionRulesVisible=true;
        for(const tool of ['subagent','expert_teams_create_task'])assert.ok(request.tools.includes(tool),'captain scope lost '+tool);
        modes.delete(options.sessionId);
        const block={type:'tool-call',id:'wait-'+randomUUID(),name:'expert_teams_wait',arguments:JSON.stringify({reason:'Await explicitly blocked member; no implementation can proceed'})};
        yield {type:'block-start',index:0,blockType:'tool-call'};
        yield {type:'block-end',index:0,block};
        yield {type:'finish',reason:{kind:'tool-calls'}};
      }else{
        yield {type:'block-start',index:0,blockType:'text'};
        yield {type:'text-delta',index:0,text:'Controlled local response.'};
        yield {type:'block-end',index:0,block:{type:'text',text:'Controlled local response.'}};
        yield {type:'finish',reason:{kind:'stop'}};
      }
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['round2-probe'],new ProbeAdapter()));
  const captainHandle=async(id,resume=false)=>ctx.agents[resume?'resume':'create']({
    [resume?'resumeSessionId':'sessionId']:id,
    agentOptions:{provider:'round2-probe',model:'stub'},
    ...(resume?{}:{meta:{cwd:workspace,agentPreset:'standard'}}),
    setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'standard');},
  });
  const approveAsUser=async(captain,staged,request)=>{
    const response=await fetch('http://'+request.headers.host+'/plugins/dsh-expert-library/teams',{
      method:'POST',headers:{'content-type':'application/json',cookie:request.headers.cookie??''},
      body:JSON.stringify({action:'approve',captainSessionId:captain.id,planId:staged.planId,expectedDigest:staged.digest,expectedRevision:staged.revision})});
    const payload=await response.json();assert.equal(response.status,200,'authenticated plan approval failed: '+JSON.stringify(payload));
    assert.equal(payload.plan.approval.source,'authenticated-host-user');return payload.plan;
  };
  const call=async(agent,name,args)=>{
    const tool=ctx.tools.get('expert_teams_'+name,agent);assert.ok(tool,'missing '+name);
    return tool.execute(args,{agent,signal:new AbortController().signal});
  };
  const wake=async(captain,id)=>{
    const before=requests.filter(r=>r.sessionId===id).length;
    assert.equal(await deliverToMember(ctx,captain,id,'Run the local fixture response.',new AbortController().signal),true);
    await until(()=>requests.filter(r=>r.sessionId===id).length>before,'member request');
    const child=ctx.agents.get(id);if(child)await child.whenIdle();
  };
  const inspect=async child=>{
    const request=requests.filter(r=>r.sessionId===child.id).at(-1);assert.ok(request);
    for(const tool of ['bash','read','read_image','write','expert_teams_quality_review','expert_teams_wait'])assert.ok(request.tools.includes(tool),'model request missing '+tool);
    for(const tool of ['subagent','expert_teams_add_member','expert_teams_create_task'])assert.ok(!request.tools.includes(tool),'model request leaked '+tool);
    const events=()=>child.session.snapshotEvents?.()??child.session.events;
    const prior=events().filter(e=>e.type==='subagent/catalog').length;
    const forced=await ctx.tools.execute({callId:'forced-'+randomUUID(),name:'subagent',arguments:{description:'Forbidden nested probe',prompt:'Do nothing'},agent:child,signal:new AbortController().signal});
    assert.equal(forced.isError,true,'nested delegation must fail before spawn');
    assert.match(JSON.stringify(forced),/delegation|capability|scope|UNKNOWN_TOOL/i);
    assert.equal(events().filter(e=>e.type==='subagent/catalog').length,prior);
    return {requestTools:request.tools,nativeImageInFollowingRequest:imageObserved.has(child.id),forcedNestedRejected:true,noNewChildCatalog:true};
  };
  const waitCaptain=async captain=>{
    await checkpoint('waitCaptain-before-idle',{status:captain.status});
    await captain.whenIdle();await checkpoint('waitCaptain-before-status');
    await call(captain,'status',{});await checkpoint('waitCaptain-after-status',{status:captain.status});
    await captain.whenIdle();
    modes.set(captain.id,'wait');
    captain.followup(createUserMessage({content:[{type:'text',text:'Use the waiting tool now.'}],source:{kind:'plugin',plugin:'team-communication-host-probe'}}));
    await until(async()=>Boolean((await state()).runtimeWaits?.[captain.id]),'durable captain wait');
    await captain.whenIdle();
    const log=captain.session.snapshotEvents?.()??captain.session.events;
    assert.ok(log.some(e=>e.type==='tool/call'&&JSON.stringify(e).includes('expert_teams_wait')),'wait must execute in a real model/tool turn');
    assert.equal(captain.status,'idle');
  };
  const server=ctx.get('webServer')??ctx.get('httpServer');
  ctx.effect(()=>server.register({kind:'exact',path:'/plugins/team-communication-host-smoke',handler:async(req,res)=>{
    if(req.headers['x-smoke-nonce']!==${JSON.stringify(nonce)}){res.writeHead(403);res.end();return;}
    try{
      const action=new URL(req.url,'http://localhost').searchParams.get('action');let result;
      if(action==='schema'){
        assert.ok(ctx.tools.get('expert_teams_wait'));assert.ok(ctx.tools.get('expert_teams_resume_member'));
        result={actualAgentProbe:true,waitTool:true,resumeMember:true};
      }else if(action==='prepare'&&req.method==='POST'){
        await checkpoint('prepare-start');
        await writeFile(join(workspace,'review-image.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP40KDwH4QZYAwAXJQKPRTh2pAAAAAASUVORK5CYII=','base64'));
        const handle=await captainHandle('probe-captain-'+randomUUID());const captain=handle.agent;
        await checkpoint('prepare-captain-created');
        const profile={schemaVersion:1,id:'member-craft-probe',version:'1',description:'Isolated member runtime and complete craft material validation',protocol:['Only local deterministic fixture calls'],
          members:['worker','blocked-worker'].map(name=>({id:name,name,role:'local fixture',route:{provider:'round2-probe',model:'stub'},maxDepth:0})),taskPlanning:'captain',review:{required:true,maxRepairRounds:2}};
        const staged=await call(captain,'plan_stage',{profile,team_name:teamId,goal:profile.description,tasks:[{id:'gate',subject:'Captain fixture gate',owner:'captain',dependsOn:[],acceptance:['Synthetic gate; no business deliverable']}]});
        await checkpoint('prepare-plan-staged');
        const waiting=await call(captain,'plan_approve',{plan_id:staged.planId,expected_digest:staged.digest,expected_revision:staged.revision});assert.equal(waiting.waitingFor,'user-confirmation');
        const approved=await approveAsUser(captain,staged,req);assert.equal(approved.status,'completed');
        await checkpoint('prepare-plan-approved');
        const members=(await state()).members;
        const healthy={member_id:members.find(m=>m.name==='worker').id};
        const failing={member_id:members.find(m=>m.name==='blocked-worker').id};
        for(const id of [healthy.member_id,failing.member_id]){const child=ctx.agents.get(id);if(child)await child.whenIdle();}
        await delay(100);
        await captain.whenIdle();
        for(const id of [captain.id,healthy.member_id,failing.member_id]){
          const session=ctx.agents.get(id)?.session;
          if(session){
            const events=session.snapshotEvents?.()??session.events;
            assert.ok(!events.some(e=>e.type==='turn/end'&&e.data?.reason?.kind==='error'),'bootstrap failed instead of silently settling: '+id);
          }
        }
        const bootState=await state();
        assert.ok(!bootState.captainRuntimeBlock&&!bootState.members.some(m=>m.runtimeBlock),'bootstrap must not create runtime blocks');
        assert.equal(requests.length,0,'idle bootstrap must not request member or captain model: '+JSON.stringify(requests));
        await checkpoint('prepare-bootstrap-verified',{modelRequests:requests.length});
        const gate=bootState.tasks.find(task=>task.assignee==='captain');
        await call(captain,'claim_task',{task_id:gate.id,assignee:'captain'});
        await call(captain,'update_task',{task_id:gate.id,execution_state:'blocked_external',wait_reason:'Synthetic fixture gate is intentionally held until local validation ends'});
        await checkpoint('prepare-gate-blocked');
        modes.set(healthy.member_id,'probe');await wake(captain,healthy.member_id);
        assert.ok(requests.some(r=>r.sessionId===healthy.member_id&&r.unselectedMaterialsAbsent),'actual unselected member request must omit craft packets');
        await checkpoint('prepare-unselected-request-verified');
        const catalog=await listScopedSkillCraftCatalog(ctx,catalogConfig,workspace);
        await checkpoint('prepare-catalog-loaded');
        for(const selection of selections)assert.ok(catalog.some(entry=>entry.packId===selection.packId&&entry.skillId===selection.skillId),'explicit selection must be in the scoped catalog');
        const expectedSelection=await resolveSelectedSkillContract(ctx,catalogConfig,workspace,selections);
        await checkpoint('prepare-selection-resolved',{selectionDigest:expectedSelection.digest});
        modes.set(healthy.member_id,'probe');craftMembers.add(healthy.member_id);initialCraftAssignment.add(healthy.member_id);
        boundaries.delete(healthy.member_id);
        await call(captain,'create_task',{subject:'Synthetic selected domain craft delivery',assignee:'worker',report_bundle:{md:'report.md',html:'report.html',pdf:'report.pdf',craft:{version:3,selections,evidence:'craft-evidence.json'}}});
        await checkpoint('prepare-selected-task-created');
        await until(()=>boundaries.has(healthy.member_id),'actual assignment request with full craft system bodies');
        assert.equal((await state()).tasks.find(t=>t.reportBundle?.craft!==undefined).frozenSkillCraftContract.digest,expectedSelection.digest);
        const assigned=ctx.agents.get(healthy.member_id);if(assigned)await assigned.whenIdle();
        await until(async()=>{
          const task=(await state()).tasks.find(t=>t.reportBundle?.craft!==undefined);
          return ['writer','renderer'].every(role=>task?.craftDeliveries.some(r=>r.sessionId===healthy.member_id&&r.attempt===task.attempt&&r.role===role&&r.accepted));
        },'accepted material receipts after actual delivery');
        await checkpoint('prepare-selected-materials-accepted');
        await wake(captain,healthy.member_id);const boundary=boundaries.get(healthy.member_id);assert.ok(boundary);
        await checkpoint('prepare-selected-continuation-verified');
        modes.set(failing.member_id,'quota');await wake(captain,failing.member_id);
        await until(async()=>(await state()).members.find(m=>m.id===failing.member_id)?.runtimeBlock?.code==='QUOTA','durable QUOTA block');
        await checkpoint('prepare-quota-block-verified');
        await call(captain,'create_task',{subject:'Wait for external fixture recovery',assignee:'blocked-worker'});
        await waitCaptain(captain);
        await checkpoint('prepare-complete');
        const fixture={captainId:captain.id,healthyId:healthy.member_id,failingId:failing.member_id};await writeFile(fixturePath,JSON.stringify(fixture));
        assert.ok(requests.some(r=>r.sessionId===captain.id&&r.captainV3SelectionRulesVisible),'captain v3 selection rules must reach an actual request');
        result={silentBootstrap:true,boundary,quotaPersisted:true,realWaitTurnEnded:true,fixture,requests:requests.length,craftMaterialRequests:requests.filter(r=>r.craft).map(r=>({sessionId:r.sessionId,...r.craft})),discoveryRequests:requests.map(r=>({sessionId:r.sessionId,...r.discovery,unselectedMaterialsAbsent:r.unselectedMaterialsAbsent===true,captainV3SelectionRulesVisible:r.captainV3SelectionRulesVisible===true})),fullCraftAssignment:true,unselectedMaterialRequestVerified:true,craftVersion:3,selectionProvenance:'engineering fixture; not actual model selection evidence'};
      }else if(action==='finish'&&req.method==='POST'){
        const finishStartedAt=Date.now();
        await checkpoint('finish-start');
        const fixture=JSON.parse(await readFile(fixturePath,'utf8'));const before=await state();
        assert.ok(before.runtimeWaits?.[fixture.captainId],'wait must survive Host restart');
        assert.equal(before.members.find(m=>m.id===fixture.failingId).runtimeBlock.code,'QUOTA');
        const handle=await captainHandle(fixture.captainId,true);const captain=handle.agent;await checkpoint('finish-captain-resumed');
        modes.set(fixture.healthyId,'probe');craftMembers.add(fixture.healthyId);await wake(captain,fixture.healthyId);const boundary=boundaries.get(fixture.healthyId);assert.ok(boundary);
        await checkpoint('finish-healthy-woke');
        const enqueueStartedAt=Date.now();
        await call(captain,'send_message',{to:'blocked-worker',content:'Ordinary message must remain queued behind QUOTA',idempotency_key:'quota-no-wake'});
        const blockedMessageEnqueueMs=Date.now()-enqueueStartedAt;
        await checkpoint('finish-blocked-message-queued');
        await delay(150);
        assert.equal(requests.filter(r=>r.sessionId===fixture.failingId).length,0,'runtime block must suppress model requests after restart');
        await waitCaptain(captain);
        await checkpoint('finish-captain-waited');
        assert.ok(requests.some(r=>r.sessionId===captain.id&&r.captainV3SelectionRulesVisible),'cold captain request must retain v3 selection rules');
        result={coldContinuation:true,boundary,quotaBlockSurvived:true,blockedMailboxProducedZeroModelRequests:true,realWaitTurnEnded:true,requests:requests.length,blockedMessageEnqueueMs,finishDurationMs:Date.now()-finishStartedAt,craftMaterialRequests:requests.filter(r=>r.craft).map(r=>({sessionId:r.sessionId,...r.craft})),discoveryRequests:requests.map(r=>({sessionId:r.sessionId,...r.discovery,unselectedMaterialsAbsent:r.unselectedMaterialsAbsent===true,captainV3SelectionRulesVisible:r.captainV3SelectionRulesVisible===true})),craftVersion:3};
      }else{res.writeHead(400);res.end();return;}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
    }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error?.stack??error)}));}
  }}));
}
`
}

runTeamCommunicationHostSmoke({
  probePlugin, kind: 'team-member-real-host-runtime', preserveFailure: true,
  afterInitialStop: async ({workspace,stoppedPid}) => {
    let gone=false;
    try { process.kill(stoppedPid,0); } catch(error) { if(error.code==='ESRCH')gone=true;else throw error; }
    if(!gone)throw new Error('The fixture owner must have actually exited before creating its orphan lock');
    const path=join(workspace,'expert-teams','.locks','member-runtime-probe.lock');
    await mkdir(join(path,'..'),{recursive:true});
    const injectedAt=Date.now();
    await writeFile(path,String(stoppedPid)+'\n'+String(injectedAt)+'\n');
    return {kind:'fresh-orphan-team-lock',ownerPid:stoppedPid,ownerVerifiedGone:true,injectedAt};
  },
  limitations: [
    'Uses actual composed Host Agents, continuable-subagent transport, model tool schemas and the tool execution pipeline.',
    'The adapter is deterministic and local. It validates runtime behavior without paid provider calls or business research.',
    'Real-model end-to-end report delivery remains a separate required production rerun.',
  ],
}).then(result => process.stdout.write(JSON.stringify(result, null, 2)+'\n')).catch(error => {
  process.stderr.write(String(error?.message??error)+'\n');process.exitCode=1;
})
