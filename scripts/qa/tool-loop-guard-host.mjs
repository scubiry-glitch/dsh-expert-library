/** Native tool repetition, turn failure and cold explicit recovery; synthetic only. */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { runTeamCommunicationHostSmoke } from './team-communication-host-smoke.mjs'
const repo = fileURLToPath(new URL('../..', import.meta.url))
const url = p => JSON.stringify(pathToFileURL(p).href)
function probePlugin(workspace, nonce) { return `
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {LlmAdapter,createUserMessage} from ${url('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js')};
import {defineTool} from ${url(join(repo, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js'))};
import {createTeamDir,readTeam} from ${url(join(repo, 'lib/state.js'))};
import {sessionOwnEvents} from ${url(join(repo, 'lib/harness-compat.js'))};
import * as preset from ${url(join(repo, 'lib/preset.js'))};
export const name='team-communication-host-probe';
export const inject=['tools','webServer','agents','subagents','llm','agentPresets'];
const workspace=${JSON.stringify(workspace)},file=join(workspace,'tool-loop-fixture.json'),root=join(workspace,'expert-teams'),teamId='tool-loop-fixture';
export function apply(ctx){
 let mode='repeat',requests=0,metadataRequests=0,dispatches=0;
 class Adapter extends LlmAdapter{
  providerInfo(id){return {id,name:'Isolated loop fixture'}}
  async listModels(){return [{id:'stub',name:'Deterministic loop fixture'}]}
  async *stream(options){
   if(!options.tools?.some(t=>t.name==='qa_loop_observation')){metadataRequests++;const text='Synthetic loop fixture';yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};return}
   requests++;
   if(mode==='progress'&&requests>10){const text='Synthetic changing-observation run finished.';yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};return}
   const block={type:'tool-call',id:'loop-'+randomUUID(),name:'qa_loop_observation',arguments:'{}'};
   yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'tool-calls'}};
  }
 }
 ctx.effect(()=>ctx.llm.registerAdapter(['loop-fixture'],new Adapter()));
 ctx.tools.register(defineTool({name:'qa_loop_observation',description:'Bounded synthetic tool observation',parameters:{},output:{schema:{type:'object',additionalProperties:true},render:(_args,v)=>[{type:'text',text:JSON.stringify(v)}]},async execute(){dispatches++;return {observation:mode==='repeat'?'unchanged':dispatches}}}));
 const open=async(id,resume=false)=>(await ctx.agents[resume?'resume':'create']({[resume?'resumeSessionId':'sessionId']:id,agentOptions:{provider:'loop-fixture',model:'stub'},...(resume?{}:{meta:{cwd:workspace,agentPreset:'standard'}}),setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'standard');agentCtx.plugin(preset,{stateDir:'expert-teams',memberProvider:'spawn'})}})).agent;
 const until=async(fn)=>{for(let i=0;i<400;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25))}throw new Error('fixture condition timed out')};
 ctx.effect(()=>ctx.get('webServer').register({kind:'exact',path:'/plugins/team-communication-host-smoke',handler:async(req,res)=>{
  if(req.headers['x-smoke-nonce']!==${JSON.stringify(nonce)}){res.writeHead(403);res.end();return}
  try{const action=new URL(req.url,'http://localhost').searchParams.get('action');let result;
   if(action==='schema')result={nativeToolLoopGuard:true};
   else if(action==='prepare'){
    const captain=await open('loop-captain-'+randomUUID());
    await createTeamDir(root,{id:teamId,name:teamId,captainSessionId:captain.id,createdAt:Date.now(),members:[],tasks:[],taskSeq:0});
    captain.followup(createUserMessage({content:[{type:'text',text:'Run the synthetic repeated observation fixture.'}],source:{kind:'user'}}));
    await until(async()=>(await readTeam(root,teamId))?.captainRuntimeBlock?.code==='TOOL_LOOP_DETECTED');await captain.whenIdle();
    assert.equal(requests,11);assert.equal(dispatches,8);
    const team=await readTeam(root,teamId),events=sessionOwnEvents(captain.session);
    const end=events.findLast(e=>e.type==='turn/end');assert.equal(end.data.reason.kind,'error');assert.match(end.data.reason.error.message,/TOOL_LOOP_DETECTED/);assert.equal(team.captainRuntimeBlock.code,'TOOL_LOOP_DETECTED');
    assert.equal(events.filter(e=>e.type==='tool/result'&&JSON.stringify(e.data).includes('TOOL_LOOP_REPETITION')).length,3);
    await writeFile(file,JSON.stringify({captainId:captain.id,blockId:team.captainRuntimeBlock.id}));
    result={requests,metadataRequests,dispatches,correctiveRejections:3,nativeTurnError:end.data.reason.error.code,durableRuntimeBlock:true,noBusinessCalls:true};
   }else if(action==='finish'){
    const f=JSON.parse(await readFile(file,'utf8'));assert.equal((await readTeam(root,teamId)).captainRuntimeBlock.id,f.blockId);
    const captain=await open(f.captainId,true);mode='progress';
    const tool=captain.ctx.tools.get('expert_teams_resume_member',captain);
    const resumed=await tool.execute({member:'captain',reason:'Synthetic fixture now returns changing observations instead of an unchanged result.',expected_block_id:f.blockId},{agent:captain,signal:new AbortController().signal});assert.equal(resumed.resumed,true);
    await until(()=>requests>=11);await captain.whenIdle();
    assert.equal(dispatches,10);assert.equal((await readTeam(root,teamId)).captainRuntimeBlock,undefined);
    const end=sessionOwnEvents(captain.session).findLast(e=>e.type==='turn/end');assert.equal(end.data.reason.kind,'completed');
    result={coldBlockRetained:true,explicitRecovery:true,changingObservations:dispatches,completed:true,realLLMCalls:0,businessCalls:0};
   }else{res.writeHead(400);res.end();return}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error.stack??error)}))}
 }}));
}
` }
runTeamCommunicationHostSmoke({ probePlugin, kind: 'tool-loop-guard-native-host', preserveFailure: true, probeTimeoutMs: 60000,
  limitations: ['Deterministic local adapter on actual isolated Host; no paid model, tenant or business API calls.', 'Repetition is a heuristic; changing tool observations must remain executable.'] })
  .then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => { process.stderr.write(String(error.message ?? error) + '\n'); process.exitCode = 1 })
