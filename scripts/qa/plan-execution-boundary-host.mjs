/** Actual native ToolRuntime guard and cold plan binding; no business/model service. */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { runTeamCommunicationHostSmoke } from './team-communication-host-smoke.mjs'
const repo=fileURLToPath(new URL('../..',import.meta.url))
const url=p=>JSON.stringify(pathToFileURL(p).href)
function probePlugin(workspace,nonce){return `
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {LlmAdapter,createUserMessage} from ${url('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js')};
import {defineTool} from ${url(join(repo,'node_modules/@deepseek-ai/dsh-tools/lib/index.js'))};
import * as preset from ${url(join(repo,'lib/preset.js'))};
export const name='team-communication-host-probe';
export const inject=['tools','webServer','agents','subagents','llm','agentPresets'];
const workspace=${JSON.stringify(workspace)},file=join(workspace,'execution-boundary-fixture.json');
export function apply(ctx){
 let businessCalls=0;const requests=[];
 class Adapter extends LlmAdapter{
  providerInfo(id){return {id,name:'Isolated boundary model'}}
  async listModels(){return [{id:'stub',name:'Fixture planning model'},{id:'stub-next',name:'Fixture execution model'}]}
  async *stream(options){requests.push({sessionId:options.sessionId,model:options.model,tools:options.tools.map(t=>t.name)});yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'Fixture planning response'};yield {type:'block-end',index:0,block:{type:'text',text:'Fixture planning response'}};yield {type:'finish',reason:{kind:'stop'}};}
 }
 ctx.effect(()=>ctx.llm.registerAdapter(['boundary-fixture'],new Adapter()));
 ctx.tools.register(defineTool({name:'r12_business_probe',description:'Isolated execution counter',parameters:{},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(){businessCalls++;return {calls:businessCalls}}}));
 const open=async(id,resume=false)=> (await ctx.agents[resume?'resume':'create']({[resume?'resumeSessionId':'sessionId']:id,agentOptions:{provider:'boundary-fixture',model:'stub'},...(resume?{}:{meta:{cwd:workspace,agentPreset:'standard'}}),setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'standard');agentCtx.plugin(preset,{stateDir:'expert-teams',memberProvider:'spawn'})}})).agent;
 const call=(agent,name,args)=>agent.ctx.tools.get('expert_teams_'+name,agent).execute(args,{agent,signal:new AbortController().signal});
 const execute=(agent,name,args={})=>agent.ctx.tools.execute({callId:'boundary-'+randomUUID(),name,arguments:args,agent,signal:new AbortController().signal});
 const denied=async(agent,name,args={})=>{const result=await execute(agent,name,args);assert.equal(result.isError,true,name+' was not rejected');assert.match(JSON.stringify(result),/PLAN_EXECUTION_APPROVAL_REQUIRED/,name+' did not reach the plan guard');return {tool:name,denied:true}};
 const server=ctx.get('webServer');
 ctx.effect(()=>server.register({kind:'exact',path:'/plugins/team-communication-host-smoke',handler:async(req,res)=>{
  if(req.headers['x-smoke-nonce']!==${JSON.stringify(nonce)}){res.writeHead(403);res.end();return}
  try{const action=new URL(req.url,'http://localhost').searchParams.get('action');let result;
   if(action==='schema'){result={nativeGuard:true,syntheticBusinessTool:true}}
   else if(action==='prepare'){
    const captain=await open('boundary-captain-'+randomUUID());
    captain.followup(createUserMessage({content:[{type:'text',text:'Review a synthetic evidence plan before execution.'}],source:{kind:'user'}}));for(let i=0;i<300&&!requests.some(r=>r.sessionId===captain.id);i++)await new Promise(r=>setTimeout(r,20));assert.ok(requests.some(r=>r.sessionId===captain.id));await captain.whenIdle();
    const args={profile:{schemaVersion:1,id:'boundary-workflow',version:'1',description:'Synthetic bounded plan',protocol:[],members:[{id:'observer',name:'Observer',route:{provider:'boundary-fixture',model:'stub'}}],taskPlanning:'seed',tasks:[{id:'planning-gate',subject:'Captain must inspect fixture state',owner:'captain',artifactInputs:[],produces:[]}]},report_outline:{chapters:[{id:'evidence',title:'Synthetic evidence',questions:['What is known?'],evidence:['Fixture observation'],taskIds:['planning-gate']}],attachments:[]}};
    const plan=await call(captain,'plan_stage',args);
    assert.equal(plan.waitingFor,'user-confirmation');assert.equal(plan.plan.captainModel.model,'stub');
    const rejected=[];
    for(const name of ['r12_business_probe','bash','expert_provider_call','subagent']) rejected.push(await denied(captain,name));
    const unpresent=captain.ctx.tools.presentAs('both');
    try{rejected.push(await denied(captain,'run_code',{code:'return 42',description:'Synthetic forbidden calculation'}))}finally{unpresent()}
    assert.equal(businessCalls,0);
    const snapshot=await execute(captain,'expert_teams_plan_preview',args);assert.notEqual(snapshot.isError,true,'planning must remain available');
    await writeFile(file,JSON.stringify({captainId:captain.id,planId:plan.planId,digest:plan.digest,revision:plan.revision}));
    result={rejected,planningAvailable:true,businessCalls,unapprovedPlanRetained:true};
   }else if(action==='finish'){
    const f=JSON.parse(await readFile(file,'utf8')),captain=await open(f.captainId,true);
    await denied(captain,'r12_business_probe');assert.equal(businessCalls,0);
    const edited=await call(captain,'plan_edit',{plan_id:f.planId,expected_digest:f.digest,expected_revision:f.revision,plan_models:{captain:{provider:'boundary-fixture',model:'stub-next'}}});
    const approve=()=>fetch('http://'+req.headers.host+'/plugins/dsh-expert-library/teams',{method:'POST',headers:{'content-type':'application/json',cookie:req.headers.cookie??''},body:JSON.stringify({action:'approve',captainSessionId:captain.id,planId:f.planId,expectedDigest:edited.digest,expectedRevision:edited.revision})});
    const refused=await approve();assert.equal(refused.status,400);assert.match(JSON.stringify(await refused.json()),/PLAN_CAPTAIN_MODEL_SWITCH_REQUIRED/);
    const defaults=ctx.get('agentDefaultModel'),beforeDefault=defaults.currentSelection();
    try{
     await ctx.get('sessionController').selectModel({sessionId:captain.id,provider:'boundary-fixture',model:'stub-next'});
     const response=await approve(),payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));assert.equal(payload.plan.approval.source,'authenticated-host-user');
     const oldRequest=await execute(captain,'r12_business_probe');assert.equal(oldRequest.isError,true);assert.match(JSON.stringify(oldRequest),/PLAN_EXECUTION_MODEL_MISMATCH/);
     captain.followup(createUserMessage({content:[{type:'text',text:'Continue the approved synthetic execution.'}],source:{kind:'plugin',plugin:'boundary-probe',form:'notice',summary:'Fixture continuation'}}));
     for(let i=0;i<300&&!requests.some(r=>r.sessionId===captain.id&&r.model==='stub-next');i++)await new Promise(r=>setTimeout(r,20));
     await captain.whenIdle();assert.ok(requests.some(r=>r.sessionId===captain.id&&r.model==='stub-next'),'actual request must use the selected execution model');
     const unclaimed=await execute(captain,'r12_business_probe');assert.equal(unclaimed.isError,true);assert.match(JSON.stringify(unclaimed),/PLAN_TASK_EXECUTION_REQUIRED/);assert.equal(businessCalls,0);
     const team=JSON.parse(await readFile(join(workspace,'expert-teams',payload.team.id,'team.json'),'utf8')),taskId=team.tasks[0].id;
     const claimed=await execute(captain,'expert_teams_claim_task',{task_id:taskId,assignee:'captain'});assert.notEqual(claimed.isError,true,JSON.stringify(claimed));
     const live=JSON.parse(await readFile(join(workspace,'expert-teams',payload.team.id,'team.json'),'utf8')).tasks[0];
     const stillUnstarted=await execute(captain,'r12_business_probe');assert.equal(stillUnstarted.isError,true);assert.match(JSON.stringify(stillUnstarted),/PLAN_TASK_EXECUTION_REQUIRED/);
     const started=await execute(captain,'expert_teams_update_task',{task_id:taskId,attempt_id:live.attemptId,status:'in_progress'});assert.notEqual(started.isError,true,JSON.stringify(started));
     const allowed=await execute(captain,'r12_business_probe');assert.notEqual(allowed.isError,true,JSON.stringify(allowed));assert.equal(businessCalls,1);
    }finally{await defaults.saveSelection(beforeDefault)}
    result={coldApprovalGate:true,authenticatedFixtureApproval:true,nativeCaptainSelection:true,oldPlanningRequestBlocked:true,taskClaimAndStartRequired:true,actualExecutionModel:'stub-next',isolatedDefaultRestored:true,approvedToolExecutedOnce:true,businessCalls};
   }else{res.writeHead(400);res.end();return}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error.stack??error)}))}
 }}));
}
`}
runTeamCommunicationHostSmoke({probePlugin,kind:'plan-execution-boundary-native-host',preserveFailure:true,probeTimeoutMs:60000,
 limitations:['Actual isolated Host and native ToolRuntime pipeline, with deterministic local model and business counter.','No real tenant, business API or paid LLM requests; authenticated clicks are fixture acceptance operations.']})
 .then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n')).catch(error=>{process.stderr.write(String(error.message??error)+'\n');process.exitCode=1})
