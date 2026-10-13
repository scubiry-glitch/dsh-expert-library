/** Real Host regression for queued next-turn input during an event wait. */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { runTeamCommunicationHostSmoke } from './team-communication-host-smoke.mjs'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const url = path => JSON.stringify(pathToFileURL(path).href)
const expectRegression = process.argv.includes('--expect-regression')
if (process.argv.slice(2).some(arg => arg !== '--expect-regression')) throw Error('Unsupported probe argument')

function probePlugin(workspace, nonce) {
  return `
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {LlmAdapter,createUserMessage} from ${url('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js')};
import * as preset from ${url(join(repo, 'lib/preset.js'))};
export const name='team-communication-host-probe';
export const inject=['tools','webServer','agents','subagents','llm','agentPresets'];
const workspace=${JSON.stringify(workspace)},expectRegression=${JSON.stringify(expectRegression)};
const teamId='next-turn-wait-probe',fixturePath=join(workspace,'next-turn-wait-fixture.json');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const events=a=>a.session.ownEvents?.()??a.session.snapshotEvents?.()??a.session.events;
const state=async()=>JSON.parse(await readFile(join(workspace,'expert-teams',teamId,'team.json'),'utf8'));
async function until(check,label){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await pause(20)}throw Error('Timed out: '+label)}
export function apply(ctx){
  const requests=[];let queuedId,initialRequests=0,metadataRequests=0;
  class Adapter extends LlmAdapter{
    providerInfo(id){return {id,name:'Local next-turn wait probe'}}
    async listModels(){return [{id:'stub',name:'Deterministic bounded next-turn waiter'}]}
    async *stream(options){
      if(!options.tools?.some(tool=>tool.name==='expert_teams_wait')){
        metadataRequests++;
        const block={type:'text',text:'Next-turn waiting fixture'};
        yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'stop'}};return;
      }
      const agent=ctx.agents.get(options.sessionId);assert.ok(agent);
      const input=events(agent).filter(e=>e.type==='user/message'&&e.data?.source?.kind==='user').at(-1);
      const queued=JSON.stringify(input?.data?.content).includes('fixture-next-turn-event');
      const step=events(agent).filter(e=>e.type==='step/start').at(-1);
      requests.push({sessionId:agent.id,turn:step?.data?.turn,queuedInput:queued,inputSeq:input?.seq,nextTurnBefore:agent.inbox.nextTurn.length});
      assert.ok(requests.length<=4,'probe must stay bounded');
      if(!queued){
        initialRequests++;
        if(initialRequests===1){
          const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'fixture-next-turn-event: inspect the pending external review and wait again.'}]});
          queuedId=message.id;agent.followup(message);
          assert.equal(agent.inbox.nextTurn.length,1);assert.equal(agent.inbox.nextStep.length,0);
        }
        // Old code cannot leave this turn through wait. A bounded synthetic
        // final answer ends it after two observed failures, without polling
        // forever or relying on the loop guard to clean up this fixture.
        if(initialRequests===3){
          const block={type:'text',text:'Bounded diagnostic end of original turn.'};
          yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'stop'}};return;
        }
      }
      const block={type:'tool-call',id:'wait-'+randomUUID(),name:'expert_teams_wait',arguments:JSON.stringify({reason:'Await external review for t1',task_ids:['t1']})};
      yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'tool-calls'}};
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['next-turn-wait-local'],new Adapter()));
  const handle=(id,resume=false)=>ctx.agents[resume?'resume':'create']({[resume?'resumeSessionId':'sessionId']:id,
    agentOptions:{provider:'next-turn-wait-local',model:'stub'},...(resume?{}:{meta:{cwd:workspace,agentPreset:'standard'}}),
    setup:async c=>{await ctx.agentPresets.mount(c,'standard');c.plugin(preset,{stateDir:'expert-teams',memberProvider:'spawn'})}});
  const call=(a,name,args)=>a.ctx.tools.get('expert_teams_'+name,a).execute(args,{agent:a,signal:new AbortController().signal});
  const server=ctx.get('webServer')??ctx.get('httpServer');
  ctx.effect(()=>server.register({kind:'exact',path:'/plugins/team-communication-host-smoke',handler:async(req,res)=>{
    if(req.headers['x-smoke-nonce']!==${JSON.stringify(nonce)}){res.writeHead(403);res.end();return}
    try{
      const action=new URL(req.url,'http://localhost').searchParams.get('action');let result;
      if(action==='schema')result={realInbox:true,boundedRequests:4,expectRegression};
      else if(action==='prepare'&&req.method==='POST'){
        const h=await handle('next-turn-wait-captain-'+randomUUID()),a=h.agent;
        await call(a,'create',{name:teamId,description:'Isolated external review waiting fixture'});
        await call(a,'create_task',{subject:'Await external fixture input',assignee:'captain'});
        const claimed=await call(a,'claim_task',{task_id:'t1'});
        await call(a,'update_task',{task_id:'t1',attempt_id:claimed.attempt_id,status:'in_progress',execution_state:'blocked_external',wait_reason:'External review result is absent',output:'Saved fixture progress'});
        await a.whenIdle();assert.equal(requests.length,0);
        a.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'fixture-initial-event: wait for the external review.'}]}));
        await until(()=>requests.some(r=>r.queuedInput),'queued message admission');
        await until(()=>a.status==='idle'&&a.inbox.nextTurn.length===0&&a.inbox.nextStep.length===0,'both turns idle');
        const count=requests.length;await pause(150);assert.equal(requests.length,count);
        assert.equal(count,expectRegression?4:2);assert.equal(initialRequests,expectRegression?3:1);
        assert.equal(requests.filter(r=>r.queuedInput).length,1);
        assert.equal(new Set(requests.map(r=>r.turn)).size,2);
        const accepted=events(a).filter(e=>e.type==='user/message'&&e.data?.id===queuedId);
        assert.equal(accepted.length,1,'queued input must be admitted exactly once');
        const saved=await state();assert.equal(saved.tasks[0].executionState,'blocked_external');assert.ok(saved.runtimeWaits?.[a.id]);
        const turnEnds=events(a).filter(e=>e.type==='turn/end').map(e=>({turn:e.data.turn,kind:e.data.reason?.kind}));
        assert.ok(turnEnds.every(e=>e.kind==='completed'));
        await writeFile(fixturePath,JSON.stringify({sessionId:a.id,attemptId:claimed.attempt_id,queuedId}));
        result={requests,initialRequests,metadataRequests,queuedAcceptedOnce:true,queuedInputPreserved:true,turnEnds,taskStateUnchanged:true,expectedRegressionObserved:expectRegression};
      }else if(action==='finish'&&req.method==='POST'){
        const f=JSON.parse(await readFile(fixturePath,'utf8')),h=await handle(f.sessionId,true),a=h.agent;
        await a.whenIdle();await pause(150);assert.equal(requests.length,0);
        const saved=await state();assert.ok(saved.runtimeWaits?.[a.id]);assert.equal(saved.tasks[0].attemptId,f.attemptId);assert.equal(saved.tasks[0].executionState,'blocked_external');
        assert.equal(events(a).filter(e=>e.type==='user/message'&&e.data?.id===f.queuedId).length,1);
        assert.equal(a.inbox.nextTurn.length,0);assert.equal(a.inbox.nextStep.length,0);
        result={coldWaitPreserved:true,coldModelRequests:0,queuedInputNotReplayed:true};
      }else{res.writeHead(400);res.end();return}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
    }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error?.stack??error)}))}
  }}));
}
`
}

runTeamCommunicationHostSmoke({probePlugin,kind:'next-turn-wait-real-host',preserveFailure:true,
  limitations:['Actual Host inbox, wait tool, turn closure and cold recovery; deterministic local adapter only, no paid model/business calls.','Task assignment/reviewer capacity is covered separately by member and goal wait Host tests.'],
}).then(result=>process.stdout.write(JSON.stringify({...result,status:expectRegression?'EXPECTED_FAILURE_REPRODUCED':result.status},null,2)+'\n'))
  .catch(error=>{process.stderr.write(String(error?.message??error)+'\n');process.exitCode=1})
