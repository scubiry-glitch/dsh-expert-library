/** Goal-aware team waiting through real Host Agents and goal-round-driver; local adapter only. */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { runTeamCommunicationHostSmoke } from './team-communication-host-smoke.mjs'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const url = path => JSON.stringify(pathToFileURL(path).href)
const expectRegression = process.argv.includes('--expect-regression')
const unknown = process.argv.slice(2).filter(arg => arg !== '--expect-regression')
if (unknown.length) throw new Error('Unsupported probe arguments')

function probePlugin(workspace, nonce) {
  return `
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LlmAdapter,createUserMessage } from ${url('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js')};
import * as expertToolsPreset from ${url(join(repo,'lib/preset.js'))};
export const name='team-communication-host-probe';
export const inject=['tools','webServer','agents','subagents','llm','agentPresets','goals'];
const workspace=${JSON.stringify(workspace)},expectRegression=${JSON.stringify(expectRegression)};
const teamId='goal-wait-runtime-probe';
const fixturePath=join(workspace,'goal-wait-fixture.json');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const state=async()=>JSON.parse(await readFile(join(workspace,'expert-teams',teamId,'team.json'),'utf8'));
const events=agent=>agent.session.ownEvents?.()??agent.session.snapshotEvents?.()??agent.session.events;
const ref=goal=>({id:goal.id,revision:goal.revision});
async function until(check,label){const deadline=Date.now()+12000;while(Date.now()<deadline){if(await check())return;await pause(20)}throw Error('Timed out: '+label)}
export function apply(ctx){
  const requests=[];
  class Adapter extends LlmAdapter{
    providerInfo(provider){return {id:provider,name:'Local goal wait probe'}}
    async listModels(){return [{id:'stub',name:'Local deterministic goal waiter'}]}
    async *stream(options){
      const agent=ctx.agents.get(options.sessionId);assert.ok(agent);
      assert.ok(options.tools.some(tool=>tool.name==='expert_teams_wait'),'actual request must expose wait tool');
      const input=events(agent).filter(e=>e.type==='user/message'&&(e.data?.source?.kind==='goal'||e.data?.source?.kind==='user'||e.data?.source?.plugin==='dsh-expert-library')).at(-1);
      requests.push({sessionId:options.sessionId,at:Date.now(),goal:{...ctx.goals.get(agent)},inputSource:input?.data?.source,inputSeq:input?.seq});
      // A real tool turn: concludeTurn and the goal driver must cooperate.
      const block={type:'tool-call',id:'wait-'+randomUUID(),name:'expert_teams_wait',arguments:JSON.stringify({reason:'Await explicit fixture input for externally blocked t1; receipt '+requests.length,task_ids:['t1']})};
      yield {type:'block-start',index:0,blockType:'tool-call'};
      yield {type:'block-end',index:0,block};
      yield {type:'finish',reason:{kind:'tool-calls'}};
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['round5-goal-probe'],new Adapter()));
  const captainHandle=(id,resume=false)=>ctx.agents[resume?'resume':'create']({
    [resume?'resumeSessionId':'sessionId']:id,agentOptions:{provider:'round5-goal-probe',model:'stub'},
    ...(resume?{}:{meta:{cwd:workspace,agentPreset:'standard'}}),
    setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'standard');agentCtx.plugin(expertToolsPreset,{stateDir:'expert-teams',memberProvider:'spawn'})},
  });
  const call=(agent,name,args)=>agent.ctx.tools.get('expert_teams_'+name,agent).execute(args,{agent,signal:new AbortController().signal});
  const snapshot=async agent=>{
    const rows=events(agent),team=await state();
    return {goal:ctx.goals.get(agent),requestCount:requests.filter(r=>r.sessionId===agent.id).length,
      automaticGoalMessages:rows.filter(e=>e.type==='user/message'&&e.data?.source?.kind==='goal'&&e.data.source.round>0).map(e=>({seq:e.seq,time:e.time,source:e.data.source})),
      goalChanges:rows.filter(e=>e.type==='goal/change').map(e=>({seq:e.seq,time:e.time,data:e.data})),
      turnStarts:rows.filter(e=>e.type==='turn/start').map(e=>({seq:e.seq,time:e.time,turn:e.data.turn})),
      turnEnds:rows.filter(e=>e.type==='turn/end').map(e=>({seq:e.seq,time:e.time,turn:e.data.turn,reason:e.data.reason})),
      waitCalls:rows.filter(e=>e.type==='tool/call'&&e.data?.name==='expert_teams_wait').map(e=>({seq:e.seq,turn:e.data.turn,step:e.data.step})),
      runtimeWait:team.runtimeWaits?.[agent.id]??null,
      goalWait:team.goalWaits?.[agent.id]??null,
      task:team.tasks.find(t=>t.id==='t1')};
  };
  const stablePaused=async agent=>{
    await until(()=>{const g=ctx.goals.get(agent);return agent.status==='idle'&&g?.phase==='paused'},'paused idle goal');
    const before=await snapshot(agent);await pause(350);const after=await snapshot(agent);
    assert.equal(after.requestCount,before.requestCount,'waiting generated model requests');
    assert.equal(after.goal.roundsStarted,before.goal.roundsStarted,'waiting generated automatic goal rounds');
    assert.equal(after.automaticGoalMessages.length,before.automaticGoalMessages.length,'waiting admitted automatic goal messages');
    assert.equal(after.goal.activation,'disarmed');
    assert.ok(after.runtimeWait,'wait must be durable');
    return after;
  };
  const goalResumes=s=>s.goalChanges.filter(e=>e.data.operation==='resume').length;
  const mailboxWake=async(agent,label,shouldResume=true)=>{
    const before=await snapshot(agent);
    const receipt=await call(agent,'send_message',{to:'captain',content:'Verified fixture event '+label,idempotency_key:label});
    await until(()=>requests.filter(r=>r.sessionId===agent.id).length>before.requestCount,'mailbox model turn');
    const after=await stablePaused(agent);
    assert.equal(after.requestCount,before.requestCount+1,'one team event must create exactly one handling turn');
    assert.equal(after.goal.roundsStarted,before.goal.roundsStarted,'mailbox wake must not create a competing goal round');
    assert.equal(goalResumes(after)-goalResumes(before),shouldResume?1:0,'goal resume must honor the exact owned pause ref');
    const request=requests.filter(r=>r.sessionId===agent.id).at(-1);
    assert.equal(request.goal.phase,shouldResume?'active':'paused','actual model request must see the correct goal phase');
    assert.equal(request.inputSource?.plugin,'dsh-expert-library','wake model request must consume the real team receipt');
    const consumed=events(agent).filter(e=>e.type==='user/message'&&e.data?.source?.kind==='plugin'&&JSON.stringify(e.data.content).includes('Expert Teams mailbox message '+receipt.message_id));
    assert.equal(consumed.length,1,'real plugin mailbox message must be consumed exactly once');
    assert.equal(after.task.status,'in_progress');assert.equal(after.task.executionState,'blocked_external');
    return {before,after,request,messageId:receipt.message_id,consumedSource:consumed[0].data.source};
  };
  const server=ctx.get('webServer')??ctx.get('httpServer');
  ctx.effect(()=>server.register({kind:'exact',path:'/plugins/team-communication-host-smoke',handler:async(req,res)=>{
    if(req.headers['x-smoke-nonce']!==${JSON.stringify(nonce)}){res.writeHead(403);res.end();return}
    try{
      const action=new URL(req.url,'http://localhost').searchParams.get('action');let result;
      if(action==='schema'){
        assert.ok(ctx.goals);assert.ok(ctx.tools.get('expert_teams_wait'));
        result={realGoalService:true,realWaitTool:true,maxGoalRounds:3,expectRegression,hostAndAgentPresetBothMounted:true};
      }else if(action==='prepare'&&req.method==='POST'){
        const handle=await captainHandle('goal-wait-captain-'+randomUUID()),captain=handle.agent;
        await call(captain,'create',{name:teamId,description:'Isolated goal-aware wait fixture'});
        const task=await call(captain,'create_task',{subject:'Await externally supplied fixture input',assignee:'captain'});
        assert.equal(task.task_id,'t1');
        const claim=await call(captain,'claim_task',{task_id:'t1'});
        await call(captain,'update_task',{task_id:'t1',attempt_id:claim.attempt_id,status:'in_progress',output:'Fixture progress is saved',execution_state:'blocked_external',wait_reason:'Only an explicit external fixture event can unblock this task'});
        await captain.whenIdle();
        assert.equal(requests.length,0,'fixture setup must not invoke a model');
        ctx.goals.create(captain,{objective:'Complete the fixture only after external input; wait while it is absent',maxGoalRounds:3});
        await until(async()=>Boolean((await state()).runtimeWaits?.[captain.id]),'first durable wait');
        let first,wake;
        if(expectRegression){
          await until(()=>ctx.goals.get(captain)?.phase==='blocked'&&captain.status==='idle','bounded old goal loop reaches round limit');
          first=await snapshot(captain);
          assert.equal(first.goal.roundsStarted,3);assert.equal(first.requestCount,3);assert.equal(first.automaticGoalMessages.length,3);
          assert.equal(first.goal.blockedReason?.code,'round-limit');assert.equal(first.waitCalls.length,3);
        }else{
          first=await stablePaused(captain);
          assert.equal(first.goal.roundsStarted,1);assert.equal(first.requestCount,1);assert.equal(first.automaticGoalMessages.length,1);
          wake=await mailboxWake(captain,'live-mailbox-event');
        }
        await writeFile(fixturePath,JSON.stringify({captainId:captain.id,first,expectedGoal:ctx.goals.get(captain)}));
        result={first,...(wake?{liveMailboxWake:wake}:{}),requests,expectedRegressionObserved:expectRegression};
      }else if(action==='finish'&&req.method==='POST'){
        const fixture=JSON.parse(await readFile(fixturePath,'utf8'));
        const handle=await captainHandle(fixture.captainId,true),captain=handle.agent;
        await captain.whenIdle();await pause(350);
        const cold=await snapshot(captain);
        assert.equal(cold.requestCount,0,'cold attach alone must not request model');
        assert.equal(cold.goal.id,fixture.expectedGoal.id);assert.equal(cold.goal.revision,fixture.expectedGoal.revision);
        assert.equal(cold.goal.roundsStarted,fixture.expectedGoal.roundsStarted);
        if(expectRegression){
          assert.equal(cold.goal.phase,'blocked');
          result={oldRoundLimitSurvivesRestart:true,cold};
        }else{
          assert.equal(cold.goal.phase,'paused');assert.ok(cold.runtimeWait);
          const wake=await mailboxWake(captain,'cold-mailbox-event');
          const beforeUser=await snapshot(captain);
          captain.followup(createUserMessage({content:[{type:'text',text:'Explicit human fixture input: inspect the blocked task then park again.'}],source:{kind:'user'}}));
          await until(()=>requests.filter(r=>r.sessionId===captain.id).length>beforeUser.requestCount,'explicit human input model turn');
          const afterUser=await stablePaused(captain),userRequest=requests.filter(r=>r.sessionId===captain.id).at(-1);
          assert.equal(afterUser.requestCount,beforeUser.requestCount+1);
          assert.equal(afterUser.goal.roundsStarted,beforeUser.goal.roundsStarted);
          assert.equal(goalResumes(afterUser)-goalResumes(beforeUser),0,'ordinary human input must not arm a paused goal');
          assert.equal(userRequest.inputSource.kind,'user');assert.equal(userRequest.goal.phase,'paused');
          assert.equal(afterUser.goal.revision,beforeUser.goal.revision);assert.equal(afterUser.goalWait,null,'human input must retire plugin ownership');
          const afterHumanMailbox=await mailboxWake(captain,'after-human-takeover-event',false);
          assert.equal(afterHumanMailbox.after.goal.revision,afterUser.goal.revision);
          assert.equal(afterHumanMailbox.after.goalWait,null,'a later team message cannot recover retired ownership');
          // Only an explicit public goal command can arm it again. Its real
          // automatic round parks a fresh owned pause for the stale-ref case.
          const beforeExplicitResume=await snapshot(captain);
          ctx.goals.resume(captain,ref(ctx.goals.get(captain)));
          await until(()=>requests.filter(r=>r.sessionId===captain.id).length>beforeExplicitResume.requestCount,'explicit public goal resume round');
          const explicitResume=await stablePaused(captain);
          assert.equal(explicitResume.requestCount,beforeExplicitResume.requestCount+1);
          assert.equal(explicitResume.goal.roundsStarted,beforeExplicitResume.goal.roundsStarted+1);
          assert.ok(explicitResume.goalWait,'fresh wait after explicit resume owns its pause');
          const beforeEdit=ctx.goals.get(captain);
          const edited=ctx.goals.edit(captain,ref(beforeEdit),{objective:'Human changed the paused goal; keep it paused until explicitly resumed'});
          assert.equal(edited.phase,'paused');assert.ok(edited.revision>beforeEdit.revision);
          const manual=await mailboxWake(captain,'manual-ref-event',false);
          assert.equal(manual.after.goal.revision,edited.revision,'plugin must not mutate the human-edited paused goal');
          assert.equal(manual.after.goal.phase,'paused');
          assert.equal(manual.after.goalWait,null,'wait must not claim an already-paused goal owned by a human');
          result={cold,afterColdMailboxWake:wake,humanInputPreservesPause:{before:beforeUser,after:afterUser,request:userRequest,followingMailbox:afterHumanMailbox},explicitPublicResume:explicitResume,humanEditedRefPreserved:manual};
        }
      }else{res.writeHead(400);res.end();return}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
    }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error?.stack??error)}))}
  }}));
}
`
}

runTeamCommunicationHostSmoke({
  probePlugin, kind:'team-goal-wait-real-host-runtime', preserveFailure:true,
  limitations:[
    'Actual Host Agents, scoped Expert Library preset, real goal service and goal-round-driver, with a local deterministic adapter; zero paid model/business calls.',
    'Goal rounds are capped at three even when the old wait implementation spins.',
    'Team messages use the registered send_message tool and real scheduler delivery. No synthetic source=user is used to stand in for plugin mailbox input.',
  ],
}).then(result=>process.stdout.write(JSON.stringify({...result,status:expectRegression?'EXPECTED_FAILURE_REPRODUCED':result.status},null,2)+'\n')).catch(error=>{
  process.stderr.write((error?.code==='ERR_ASSERTION'?error.message:error?.code?'HOST_SMOKE_'+error.code:error?.message??'HOST_SMOKE_FAILED')+'\n');
  process.exitCode=1;
})
