/** Real native read/write/bash cycle, versioned identical evidence, cold recovery. */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { runTeamCommunicationHostSmoke } from './team-communication-host-smoke.mjs'
const repo = fileURLToPath(new URL('../..', import.meta.url))
const url = p => JSON.stringify(pathToFileURL(p).href)
const fixtureScript = `import hashlib,json,pathlib,sys
p=pathlib.Path(__file__).resolve().parent
mode,kind,revision=sys.argv[1:]
assert mode in ('repeat','progress') and kind in ('assembly','preflight') and revision.isdigit()
if mode=='progress' and kind=='assembly':
 (p/'report.md').write_text('Changed synthetic report '+revision)
hashes={r:hashlib.sha256((p/('report.'+r)).read_bytes()).hexdigest() for r in ('md','html','pdf')}
ledger=p/(mode+'-ledger'+revision+'.json')
if kind=='assembly':
 with ledger.open('xb') as f:f.write(b'fixed synthetic evidence')
 value={'status':'BOUND_DRAFT','qualityApproved':False,'hostReceipt':False,'reportSha256':hashes,'evidenceSha256':hashlib.sha256(ledger.read_bytes()).hexdigest(),'output':str(ledger),'notice':'Synthetic assembly; no quality approval.'}
else:
 value={'status':'failed','qualityApproved':False,'hostReceipt':False,'inputFilesUnchanged':True,'packId':'synthetic-fixture','packVersion':'1','selections':[],'artifacts':[{'role':r,'sha256':h,'path':str(p/('report.'+r))} for r,h in hashes.items()]+[{'role':'evidence','sha256':hashlib.sha256(ledger.read_bytes()).hexdigest(),'path':str(ledger)}],'results':[{'id':'report-craft-calculations','status':'failed','detail':'Synthetic unchanged quantity mismatch.'}]}
print(json.dumps(value))
sys.exit(0 if kind=='assembly' else 1)
`
function probePlugin(workspace, nonce) { return `
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {LlmAdapter,createUserMessage} from ${url('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js')};
import {defineTool} from ${url(join(repo,'node_modules/@deepseek-ai/dsh-tools/lib/index.js'))};
import {createTeamDir,readTeam} from ${url(join(repo,'lib/state.js'))};
import {sessionOwnEvents} from ${url(join(repo,'lib/harness-compat.js'))};
import * as preset from ${url(join(repo,'lib/preset.js'))};
export const name='team-communication-host-probe';
export const inject=['tools','webServer','agents','subagents','llm','agentPresets','commands'];
const workspace=${JSON.stringify(workspace)},root=join(workspace,'expert-teams'),teamId='report-cycle-fixture',file=join(workspace,'cycle-state.json'),script=join(workspace,'report-fixture.py');
export function apply(ctx){
 let mode='repeat',requests=0;
 class Adapter extends LlmAdapter{
  providerInfo(id){return {id,name:'Local report cycle fixture'}}
  async listModels(){return [{id:'stub',name:'Deterministic local model'}]}
  async *stream(options){
   if(!options.tools?.some(t=>t.name==='qa_report_cycle_marker')||(mode==='progress'&&requests>=20)){
    const text='Synthetic fixture finished';yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};return;
   }
   if(requests>=60)throw new Error('Fixture guard did not terminate the repeated cycle');
   const index=requests++,part=index%4,revision=Math.floor(index/4)+1;
   let name,args;
   if(part===0){name='read';args={file_path:join(workspace,'anchors.txt'),limit:20}}
   else if(part===1){name='write';args={file_path:join(workspace,'bindings.json'),content:'fixed synthetic bindings'}}
   else{assert.match(script,/^[a-zA-Z0-9_./-]+$/);name='bash';args={command:'python3 '+script+' '+mode+' '+(part===2?'assembly':'preflight')+' '+revision,description:'Synthetic local report tool'}}
   const block={type:'tool-call',id:'cycle-'+randomUUID(),name,arguments:JSON.stringify(args)};
   yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'tool-calls'}};
  }
 }
 ctx.effect(()=>ctx.llm.registerAdapter(['report-cycle-fixture'],new Adapter()));
 ctx.tools.register(defineTool({name:'qa_report_cycle_marker',description:'Identifies synthetic fixture requests',parameters:{},output:{schema:{type:'object',additionalProperties:true},render:(_args,v)=>[{type:'text',text:JSON.stringify(v)}]},async execute(){return {fixture:true}}}));
 const open=async(id,resume=false)=>{const {agent}=await ctx.agents[resume?'resume':'create']({[resume?'resumeSessionId':'sessionId']:id,agentOptions:{provider:'report-cycle-fixture',model:'stub'},...(resume?{}:{meta:{cwd:workspace,agentPreset:'standard'}}),setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'standard');agentCtx.plugin(preset,{stateDir:'expert-teams',memberProvider:'spawn'})}});agent.ctx.tools.presentAs('native');const permission=await ctx.commands.execute(agent,'/permission danger-full-access',[],new AbortController().signal);assert.equal(permission?.result.kind,'success');return agent};
 const until=async(fn)=>{for(let i=0;i<1200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50))}throw new Error('Fixture condition timed out')};
 ctx.effect(()=>ctx.get('webServer').register({kind:'exact',path:'/plugins/team-communication-host-smoke',handler:async(req,res)=>{
  if(req.headers['x-smoke-nonce']!==${JSON.stringify(nonce)}){res.writeHead(403);res.end();return}
  try{const action=new URL(req.url,'http://localhost').searchParams.get('action');let result;
   if(action==='schema')result={nativeReadWriteBash:true};
   else if(action==='prepare'){
    await writeFile(script,${JSON.stringify(fixtureScript)});await writeFile(join(workspace,'anchors.txt'),'unchanged synthetic anchors');
    for(const role of ['md','html','pdf'])await writeFile(join(workspace,'report.'+role),'synthetic '+role);
    const captain=await open('cycle-captain-'+randomUUID());
    await createTeamDir(root,{id:teamId,name:teamId,captainSessionId:captain.id,createdAt:Date.now(),members:[],tasks:[],taskSeq:0});
    captain.followup(createUserMessage({content:[{type:'text',text:'Execute the local report repair cycle fixture.'}],source:{kind:'user'}}));
    await until(async()=>(await readTeam(root,teamId))?.captainRuntimeBlock?.code==='TOOL_LOOP_DETECTED');await captain.whenIdle();
    const team=await readTeam(root,teamId),events=sessionOwnEvents(captain.session),end=events.findLast(e=>e.type==='turn/end');
    assert.equal(end.data.reason.kind,'error');assert.match(end.data.reason.error.message,/TOOL_LOOP_DETECTED/);
    const rejected=events.filter(e=>e.type==='tool/result'&&JSON.stringify(e.data).includes('TOOL_LOOP_REPETITION')).length;
    assert.equal(rejected,3);assert.ok(requests<30,'cosmetic versions must not keep the turn alive');
    const versions=(await readdir(workspace)).filter(p=>/^repeat-ledger[0-9]+[.]json$/.test(p));assert.ok(versions.length>=2&&versions.length<=6);
    await writeFile(file,JSON.stringify({captainId:captain.id,blockId:team.captainRuntimeBlock.id}));
    result={requests,correctiveRejections:rejected,identicalLedgerVersions:versions.length,nativeReadWriteBash:true,durableRuntimeBlock:true,realLlmCalls:0,businessApiCalls:0};
   }else if(action==='finish'){
    const f=JSON.parse(await readFile(file,'utf8'));assert.equal((await readTeam(root,teamId)).captainRuntimeBlock.id,f.blockId);
    const captain=await open(f.captainId,true);mode='progress';requests=0;
    const resumed=await captain.ctx.tools.get('expert_teams_resume_member',captain).execute({member:'captain',reason:'Synthetic report bytes now change between revisions.',expected_block_id:f.blockId},{agent:captain,signal:new AbortController().signal});assert.equal(resumed.resumed,true);
    await until(()=>requests>=20);await captain.whenIdle();
    assert.equal((await readTeam(root,teamId)).captainRuntimeBlock,undefined);
    assert.equal(sessionOwnEvents(captain.session).findLast(e=>e.type==='turn/end').data.reason.kind,'completed');
    assert.equal((await readdir(workspace)).filter(p=>/^progress-ledger[0-9]+[.]json$/.test(p)).length,5);
    result={coldBlockRetained:true,explicitRecovery:true,changedReportRevisions:5,completed:true,realLlmCalls:0,businessApiCalls:0};
   }else{res.writeHead(400);res.end();return}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error.stack??error)}))}
 }}));
}
` }
runTeamCommunicationHostSmoke({probePlugin,kind:'report-repair-cycle-native-host',preserveFailure:true,probeTimeoutMs:180000,
  limitations:['Actual native read/write/bash and durable cold recovery with a deterministic local model.',
    'Synthetic report-tool envelopes exercise repetition accounting only; they do not validate report semantics or confer quality approval. No production, paid model or business API calls.']})
  .then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n')).catch(error=>{process.stderr.write(String(error.message??error)+'\n');process.exitCode=1})
