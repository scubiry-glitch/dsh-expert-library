/** Actual native artifact output, EOF loop stop, and cold recovery; no paid model. */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { runTeamCommunicationHostSmoke } from './team-communication-host-smoke.mjs'
const repo = fileURLToPath(new URL('../..', import.meta.url))
const url = p => JSON.stringify(pathToFileURL(p).href)
function probePlugin(workspace, nonce) { return `
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {LlmAdapter,createUserMessage} from ${url('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js')};
import {defineTool} from ${url(join(repo,'node_modules/@deepseek-ai/dsh-tools/lib/index.js'))};
import {createTeamDir,readTeam,writeTeam,publishTaskArtifact} from ${url(join(repo,'lib/state.js'))};
import {sessionOwnEvents} from ${url(join(repo,'lib/harness-compat.js'))};
import * as preset from ${url(join(repo,'lib/preset.js'))};
export const name='team-communication-host-probe';
export const inject=['tools','webServer','agents','subagents','llm','agentPresets','commands'];
const workspace=${JSON.stringify(workspace)},root=join(workspace,'expert-teams'),teamId='artifact-pages-fixture',file=join(workspace,'pages-state.json');
const content='x'.repeat(2400)+'中文🙂结束';
export function apply(ctx){
 let mode='cycle',requests=0,artifactId,binaryId;
 class Adapter extends LlmAdapter{
  providerInfo(id){return {id,name:'Local artifact pagination fixture'}}
  async listModels(){return [{id:'stub',name:'Deterministic local model'}]}
  async *stream(options){
   if(!options.tools?.some(t=>t.name==='qa_artifact_page_marker')||(mode==='pages'&&requests>=25)){
    const text='Synthetic fixture finished';yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};return;
   }
   if(requests>=45)throw new Error('EOF guard did not stop changing offsets');
   const i=requests++,args={task_id:'t2',source_task_id:'t1',artifact_id:mode==='cycle'&&i===2?binaryId:artifactId,
    offset:mode==='pages'?i*100:i===0||i===2?0:i===1?1000:10000+(i-3)*1000,limit:mode==='pages'?100:i===1?16000:1000};
   const block={type:'tool-call',id:'pages-'+randomUUID(),name:'expert_teams_read_artifact',arguments:JSON.stringify(args)};
   yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'tool-calls'}};
  }
 }
 ctx.effect(()=>ctx.llm.registerAdapter(['artifact-pages-fixture'],new Adapter()));
 ctx.tools.register(defineTool({name:'qa_artifact_page_marker',description:'Identifies synthetic fixture requests',parameters:{},output:{schema:{type:'object',additionalProperties:true},render:(_args,v)=>[{type:'text',text:JSON.stringify(v)}]},async execute(){return {fixture:true}}}));
 const open=async(id,resume=false)=>{const {agent}=await ctx.agents[resume?'resume':'create']({[resume?'resumeSessionId':'sessionId']:id,agentOptions:{provider:'artifact-pages-fixture',model:'stub'},...(resume?{}:{meta:{cwd:workspace,agentPreset:'standard'}}),setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'standard');agentCtx.plugin(preset,{stateDir:'expert-teams',memberProvider:'spawn'})}});agent.ctx.tools.presentAs('native');const permission=await ctx.commands.execute(agent,'/permission danger-full-access',[],new AbortController().signal);assert.equal(permission?.result.kind,'success');return agent};
 const until=async(fn)=>{for(let i=0;i<1200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50))}throw new Error('Fixture condition timed out')};
 const observedPages=agent=>sessionOwnEvents(agent.session).filter(e=>e.type==='tool/result').flatMap(e=>(e.data.message?.content??[]).flatMap(b=>(b.content??[]).flatMap(c=>{try{const v=JSON.parse(c.text);return v.artifact_id?[v]:[]}catch{return []}})));
 ctx.effect(()=>ctx.get('webServer').register({kind:'exact',path:'/plugins/team-communication-host-smoke',handler:async(req,res)=>{
  if(req.headers['x-smoke-nonce']!==${JSON.stringify(nonce)}){res.writeHead(403);res.end();return}
  try{const action=new URL(req.url,'http://localhost').searchParams.get('action');let result;
   if(action==='schema')result={nativePinnedArtifactPagination:true};
   else if(action==='prepare'){
    const captain=await open('pages-captain-'+randomUUID());
    const project={path:'expert-tasks/t1',inputPath:'expert-tasks/t1/input/task.json',outputPath:'expert-tasks/t1/output/result.json',artifactsPath:'expert-tasks/t1/artifacts',version:1};
    const source={id:'t1',subject:'Synthetic already completed source',status:'completed',assignee:'captain',dependencies:[],attempt:1,createdAt:1,updatedAt:1,project};
    const consumer={id:'t2',subject:'Read pinned synthetic pages',status:'in_progress',assignee:'captain',dependencies:['t1'],attempt:1,attemptId:'pages-attempt',executionState:'active',createdAt:1,updatedAt:1};
    const team={id:teamId,name:teamId,captainSessionId:captain.id,createdAt:Date.now(),members:[],tasks:[source,consumer],taskSeq:2};
    await createTeamDir(root,team);await mkdir(join(root,teamId,project.artifactsPath),{recursive:true});
    const text=await publishTaskArtifact(root,team,source,{name:'source.txt',content,mediaType:'text/plain'});source.publishedArtifacts=[text];
    const binary=await publishTaskArtifact(root,team,source,{name:'source.bin',content:new Uint8Array([255,0,254,1]),mediaType:'application/octet-stream'});source.publishedArtifacts.push(binary);
    consumer.inputArtifacts=[text,binary].map(a=>({sourceTaskId:'t1',artifactId:a.id}));
    consumer.inputArtifactManifest=[text,binary].map(a=>({sourceTaskId:'t1',artifactId:a.id,reviewArtifactId:a.reviewId,attempt:1,sha256:a.sha256,versionPath:join(root,teamId,project.artifactsPath,a.relativePath)}));
    await writeTeam(root,team);artifactId=text.id;binaryId=binary.id;
    captain.followup(createUserMessage({content:[{type:'text',text:'Read the synthetic pinned artifacts and exercise EOF.'}],source:{kind:'user'}}));
    await until(async()=>(await readTeam(root,teamId))?.captainRuntimeBlock?.code==='TOOL_LOOP_DETECTED');await captain.whenIdle();
    const current=await readTeam(root,teamId),events=sessionOwnEvents(captain.session),pages=observedPages(captain);
    assert.equal(pages[0].next_offset,1000);assert.equal(pages[0].total_characters,content.length);assert.equal(pages[0].eof,false);
    assert.equal(pages[0].content+pages[1].content,content);assert.equal(pages[1].eof,true);assert.equal(pages[1].next_offset,null);
    assert.equal(pages[2].binary,true);assert.equal(pages[2].path,teamId+'/'+project.artifactsPath+'/'+binary.relativePath);
    const empty=pages.filter(p=>p.eof&&p.content==='');assert.ok(empty.length>=8);assert.ok(empty.every(p=>p.next_offset===null&&p.returned_characters===0&&/Do not increase offset/.test(p.notice)));
    const rejected=events.filter(e=>e.type==='tool/result'&&JSON.stringify(e.data).includes('TOOL_LOOP_REPETITION')).length;assert.equal(rejected,3);assert.ok(requests<22);
    assert.equal(events.findLast(e=>e.type==='turn/end').data.reason.kind,'error');
    await writeFile(file,JSON.stringify({captainId:captain.id,artifactId,binaryId,blockId:current.captainRuntimeBlock.id}));
    result={modelFacingCursor:true,modelFacingEnd:true,unicodeTailPreserved:true,binaryPathVisible:true,correctiveRejections:rejected,requests,durableRuntimeBlock:true,realLlmCalls:0,businessApiCalls:0};
   }else if(action==='finish'){
    const f=JSON.parse(await readFile(file,'utf8'));assert.equal((await readTeam(root,teamId)).captainRuntimeBlock.id,f.blockId);
    artifactId=f.artifactId;binaryId=f.binaryId;mode='pages';requests=0;
    const captain=await open(f.captainId,true);
    const resumed=await captain.ctx.tools.get('expert_teams_resume_member',captain).execute({member:'captain',reason:'Synthetic recovery uses distinct real pages.',expected_block_id:f.blockId},{agent:captain,signal:new AbortController().signal});assert.equal(resumed.resumed,true);
    await until(()=>requests>=25);await captain.whenIdle();
    const pages=observedPages(captain).filter(p=>p.artifact_id===artifactId&&p.offset<2500).slice(-25);
    assert.equal(pages.length,25);assert.equal(pages.map(p=>p.content).join(''),content);
    assert.equal((await readTeam(root,teamId)).captainRuntimeBlock,undefined);
    assert.equal(sessionOwnEvents(captain.session).findLast(e=>e.type==='turn/end').data.reason.kind,'completed');
    result={coldBlockRetained:true,explicitRecovery:true,distinctPages:25,sameTextDifferentOffsetsAllowed:true,completed:true,realLlmCalls:0,businessApiCalls:0};
   }else{res.writeHead(400);res.end();return}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error.stack??error)}))}
 }}));
}
` }
runTeamCommunicationHostSmoke({probePlugin,kind:'artifact-pagination-native-host',preserveFailure:true,probeTimeoutMs:180000,
  limitations:['Actual native tool output and cold recovery with a deterministic local model; no production, paid model or business API.',
    'Seeds a synthetic completed dependency and immutable publications to isolate pagination. Does not claim report content or upstream review acceptance.']})
  .then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n')).catch(error=>{process.stderr.write(String(error.message??error)+'\n');process.exitCode=1})
