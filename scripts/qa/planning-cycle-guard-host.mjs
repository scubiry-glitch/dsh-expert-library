/** Diagnose the actual model-visible pre-team surface with a deterministic adapter. */
import {fileURLToPath,pathToFileURL} from 'node:url'
import {join,resolve} from 'node:path'
import {runTeamCommunicationHostSmoke} from './team-communication-host-smoke.mjs'
const repo=fileURLToPath(new URL('../..',import.meta.url)),url=p=>JSON.stringify(pathToFileURL(p).href)
export function probePlugin(workspace,nonce){return String.raw`
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {LlmAdapter,createUserMessage} from ${url('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js')};
import {authorizePlanExecution,PLAN_AUTHORIZATION_SCOPE} from ${url(join(repo,'lib/plan-authorization.js'))};
import {captureSharedTaskContext} from ${url(join(repo,'lib/shared-task-context.js'))};
import {canonicalDigest} from ${url(join(repo,'lib/v2/digest.js'))};
import {readPlanningLoopStop} from ${url(join(repo,'lib/planning-loop-stop.js'))};
import {sessionOwnEvents} from ${url(join(repo,'lib/harness-compat.js'))};
import * as preset from ${url(join(repo,'lib/preset.js'))};
export const name='team-communication-host-probe';
export const inject=['tools','webServer','agents','subagents','llm','agentPresets','goals'];
const workspace=${JSON.stringify(workspace)},root=join(workspace,'expert-teams'),file=join(workspace,'planning-surface.json');
export function apply(ctx){
 let sid,workRequests=0,visibleTools=[],mode='loop',goalCreated=false;
 const until=async(fn)=>{for(let i=0;i<800;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25))}throw new Error('native planning fixture condition timed out')};
 const open=async(id,resume=false)=>(await ctx.agents[resume?'resume':'create']({[resume?'resumeSessionId':'sessionId']:id,agentOptions:{provider:'planning-surface',model:'stub'},...(resume?{}:{meta:{cwd:workspace,agentPreset:'standard'}}),setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'standard');agentCtx.plugin(preset,{stateDir:'expert-teams',memberProvider:'spawn'})}})).agent;
 class Adapter extends LlmAdapter{
  providerInfo(id){return {id,name:'Isolated planning surface'}}
  async listModels(){return [{id:'stub',name:'Synthetic planner'}]}
  async *stream(options){
   if(options.sessionId===sid&&options.tools?.some(t=>t.name==='read')){
    visibleTools=options.tools.map(t=>t.name);workRequests++;
    if(mode==='loop'&&!goalCreated){goalCreated=true;const a=ctx.agents.get(sid);ctx.agents.withInitiator(a,()=>ctx.goals.create(a,{objective:'Finish the synthetic plan, never spin on repeated reads',maxGoalRounds:3}));}
    if(mode==='progress'&&workRequests<=10)await writeFile(join(workspace,'synthetic-'+((workRequests-1)%3)+'.txt'),'New observation '+workRequests+'\nChanged contents.\n');
    if((mode==='loop'&&workRequests<=24)||(mode==='progress'&&workRequests<=10)){const block={type:'tool-call',id:'read-'+randomUUID(),name:'read',arguments:JSON.stringify({file_path:join(workspace,'synthetic-'+((workRequests-1)%3)+'.txt'),offset:mode==='loop'&&workRequests>3?2:1,limit:mode==='loop'&&workRequests>3?1:2})};yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'tool-calls'}};return}
   }
   const text='Synthetic diagnostic finished.';yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};
  }
 }
 ctx.effect(()=>ctx.llm.registerAdapter(['planning-surface'],new Adapter()));
 ctx.effect(()=>ctx.get('webServer').register({kind:'exact',path:'/plugins/team-communication-host-smoke',handler:async(req,res)=>{
  if(req.headers['x-smoke-nonce']!==${JSON.stringify(nonce)}){res.writeHead(403);res.end();return}
  try{const action=new URL(req.url,'http://localhost').searchParams.get('action');let result;
   if(action==='schema')result={syntheticPreTeamPlanning:true};
   else if(action==='prepare'){
    for(let i=0;i<3;i++)await writeFile(join(workspace,'synthetic-'+i+'.txt'),'Synthetic local material '+i+'\nUnchanged observation.\n');
    sid='planning-cycle-'+randomUUID();const captain=await open(sid);
    const text='Prepare a reviewed synthetic report plan using local supplied fixture materials.';
    await authorizePlanExecution(root,sid,captureSharedTaskContext(captain),{requestId:'fixture-'+randomUUID(),expectedInputSha256:canonicalDigest([text]),reason:'Isolated authenticated fixture authorization',scope:PLAN_AUTHORIZATION_SCOPE,requireReviewedReport:true});
    captain.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));
    await until(async()=>Boolean(await readPlanningLoopStop(root,sid,captureSharedTaskContext(captain).sha256)));await captain.whenIdle();
    for(const name of ['expert_teams_plan_stage','expert_teams_plan_preview','expert_review_route','todo_write','read'])assert.ok(visibleTools.includes(name),'not model-visible: '+name);
    const events=sessionOwnEvents(captain.session),results=events.filter(e=>e.type==='tool/result');
    assert.equal(workRequests,15);assert.equal(results.length,15);assert.equal(results.filter(e=>JSON.stringify(e.data).includes('TOOL_LOOP_REPETITION')).length,3);assert.equal(ctx.goals.get(captain).phase,'paused');assert.equal(ctx.goals.get(captain).activation,'disarmed');const before=workRequests;await new Promise(r=>setTimeout(r,350));assert.equal(workRequests,before,'paused Goal generated more model work');
    const todo=await captain.ctx.tools.execute({callId:'todo-'+randomUUID(),name:'todo_write',arguments:{todos:[{content:'Prepare the synthetic plan',status:'in_progress'}]},agent:captain,signal:new AbortController().signal});
    assert.equal(todo.isError,false);const context=captureSharedTaskContext(captain),block=await readPlanningLoopStop(root,sid,context.sha256);assert.equal(block.goalWait.pausedRevision,ctx.goals.get(captain).revision);
    const end=events.findLast(e=>e.type==='turn/end');assert.equal(end.data.reason.kind,'error');assert.match(end.data.reason.error.message,/TOOL_LOOP_DETECTED/);
    result={modelVisiblePlanningTools:['expert_teams_plan_stage','expert_teams_plan_preview','expert_review_route'],visibleToolCount:visibleTools.length,modelRequests:workRequests,actualReadDispatches:12,correctiveRejections:3,readReslicingDetected:true,todoAllowed:true,goalPaused:true,nativeTurnError:end.data.reason.error.code,durablePreTeamBlock:true};
    await writeFile(file,JSON.stringify({captainId:sid,contextSha256:context.sha256,block,prepared:result}));
   }else if(action==='finish'){
    const f=JSON.parse(await readFile(file,'utf8'));sid=f.captainId;goalCreated=true;const captain=await open(sid,true);
    assert.deepEqual(await readPlanningLoopStop(root,sid,f.contextSha256),f.block);assert.equal(ctx.goals.get(captain).phase,'paused');
    const ended=()=>sessionOwnEvents(captain.session).filter(e=>e.type==='turn/end').length;
    let before=ended();captain.followup(createUserMessage({content:[{type:'text',text:'Synthetic same-input continuation notice.'}],source:{kind:'plugin',plugin:'planning-loop-probe',form:'notice',summary:'Cold loop check'}}));await until(()=>ended()>before);await captain.whenIdle();assert.equal(workRequests,0,'cold same-input continuation made a model request');
    const goal=ctx.goals.get(captain);before=ended();ctx.goals.resume(captain,{id:goal.id,revision:goal.revision});await until(()=>ended()>before&&ctx.goals.get(captain).phase==='paused');await captain.whenIdle();assert.equal(workRequests,0,'Goal resume bypassed the durable planning block');
    const pausedRevision=ctx.goals.get(captain).revision;mode='idle';before=ended();captain.followup(createUserMessage({content:[{type:'text',text:'New direct instruction: inspect changed synthetic local material only; do not perform business execution.'}],source:{kind:'user'}}));await until(()=>workRequests===1);await captain.whenIdle();
    assert.equal(sessionOwnEvents(captain.session).findLast(e=>e.type==='turn/end').data.reason.kind,'completed');assert.equal(ctx.goals.get(captain).phase,'paused');assert.equal(ctx.goals.get(captain).revision,pausedRevision,'new input silently resumed the Goal');
    mode='progress';workRequests=0;sid='planning-progress-'+randomUUID();const fresh=await open(sid);const freshText='Inspect changing synthetic supplied material for a new reviewed plan.';
    await authorizePlanExecution(root,sid,captureSharedTaskContext(fresh),{requestId:'fresh-'+randomUUID(),expectedInputSha256:canonicalDigest([freshText]),reason:'Fresh isolated planning fixture',scope:PLAN_AUTHORIZATION_SCOPE,requireReviewedReport:true});
    fresh.followup(createUserMessage({content:[{type:'text',text:freshText}],source:{kind:'user'}}));await until(()=>workRequests===11);await fresh.whenIdle();assert.equal(sessionOwnEvents(fresh.session).findLast(e=>e.type==='turn/end').data.reason.kind,'completed');assert.equal(await readPlanningLoopStop(root,sid,captureSharedTaskContext(fresh).sha256),undefined);
    result={coldBlockRetained:true,sameInputModelRequests:0,manualGoalResumeRepaused:true,newDirectInputAdmitted:true,authorizedChangingReads:10,newInputDidNotResumeGoal:true,completed:true};
   }
   else{res.writeHead(400);res.end();return}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error.stack??error)}))}
 }}));
}
`}
if(process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])) runTeamCommunicationHostSmoke({probePlugin,kind:'planning-cycle-guard-native-host',preserveFailure:true,probeTimeoutMs:60000,limitations:['Actual native read tools, re-sliced unchanged lines, pre-team admission, native Goal pause and cold recovery are exercised with local synthetic files.','Deterministic local model adapter; no paid model, business provider or production state touched.']}).then(r=>process.stdout.write(JSON.stringify(r,null,2)+'\n')).catch(e=>{process.stderr.write(String(e.message??e)+'\n');process.exitCode=1})
