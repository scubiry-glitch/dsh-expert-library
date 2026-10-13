/** V2 DAG in an isolated DSH session, real Host stage/approve, no paid model calls. */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { runTeamCommunicationHostSmoke } from './team-communication-host-smoke.mjs'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const url = path => JSON.stringify(pathToFileURL(path).href)
function probePlugin(workspace, nonce) { return `
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LlmAdapter, createUserMessage } from ${url('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js')};
import * as preset from ${url(join(repo, 'lib/preset.js'))};
import { requiredOutlineMaterials } from ${url(join(repo, 'lib/deep-research-gates.js'))};
import { readHumanChoice } from ${url(join(repo, 'lib/human-choice.js'))};
export const name='deep-research-dag-host-probe';
export const inject=['tools','webServer','agents','llm','agentPresets'];
const workspace=${JSON.stringify(workspace)}, nonce=${JSON.stringify(nonce)};
const file=join(workspace,'deep-research-smoke.json');
const source='/root/.openclaw/workspace/98wiki/projects/供平过租见底路径/深度研究团队DAG-v2.json';
export function apply(ctx){
 class Adapter extends LlmAdapter{
  providerInfo(id){return {id,name:'Local no-cost DAG fixture'}}
  async listModels(){return [{id:'stub',name:'Stub model'}]}
  async *stream(){yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'Fixture session ready.'};yield {type:'block-end',index:0,block:{type:'text',text:'Fixture session ready.'}};yield {type:'finish',reason:{kind:'stop'}}}
 }
 ctx.effect(()=>ctx.llm.registerAdapter(['deep-research-smoke'],new Adapter()));
 const open=async(id,resume=false)=>(await ctx.agents[resume?'resume':'create']({[resume?'resumeSessionId':'sessionId']:id,agentOptions:{provider:'deep-research-smoke',model:'stub'},...(resume?{}:{meta:{cwd:workspace,agentPreset:'standard'}}),setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'standard');agentCtx.plugin(preset,{stateDir:'expert-teams',memberProvider:'spawn',memberModel:{provider:'deep-research-smoke',model:'stub'}})}})).agent;
 const call=(agent,name,args)=>agent.ctx.tools.get('expert_teams_'+name,agent).execute(args,{agent,signal:new AbortController().signal});
 const participant=id=>({id,status:'idle',session:{header:{cwd:workspace},events:[],append(){},steer(){}}});
 const callAs=(id,name,args)=>{const agent=participant(id);return ctx.tools.get('expert_teams_'+name,agent).execute(args,{agent,session:agent.session,signal:new AbortController().signal})};
 const server=ctx.get('webServer');
 ctx.effect(()=>server.register({kind:'exact',path:'/plugins/team-communication-host-smoke',handler:async(req,res)=>{
  if(req.headers['x-smoke-nonce']!==nonce){res.writeHead(403);res.end();return}
  try{
   const action=new URL(req.url,'http://localhost').searchParams.get('action');let result;
   if(action==='schema')result={deepResearchDag:true,newIsolatedSession:true,noPaidModel:true};
   else if(action==='prepare'){
    const draft=JSON.parse(await readFile(source,'utf8'));
    const profile=structuredClone(draft.profile);
    for(const member of profile.members)member.route={provider:'deep-research-smoke',model:'stub'};
    const captain=await open('deep-research-captain-'+randomUUID());
    captain.followup(createUserMessage({content:[{type:'text',text:'试跑供平过租深度研究：先生成三版大纲，等待用户选择；不执行付费完整报告。'}],source:{kind:'user'}}));
    await captain.whenIdle();
    const staged=await call(captain,'plan_stage',{profile,report_outline:draft.report_outline,team_name:'deep-research-smoke-'+randomUUID().slice(0,8),goal:'供平过租：测试三版大纲、用户选择、逐章点睛图与两份参考件渲染门。'});
    assert.equal(staged.waitingFor,'user-confirmation');
    await writeFile(file,JSON.stringify({captainId:captain.id,planId:staged.planId,digest:staged.digest,revision:staged.revision}));
    result={sessionId:captain.id,planId:staged.planId,waitingFor:staged.waitingFor,taskCount:staged.plan?.tasks?.length??profile.tasks.length};
   }else if(action==='finish'){
    const staged=JSON.parse(await readFile(file,'utf8'));
    const captain=await open(staged.captainId,true);
    const response=await fetch('http://'+req.headers.host+'/plugins/dsh-expert-library/teams',{method:'POST',headers:{'content-type':'application/json',cookie:req.headers.cookie??''},body:JSON.stringify({action:'approve',captainSessionId:captain.id,planId:staged.planId,expectedDigest:staged.digest,expectedRevision:staged.revision})});
    const payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));
    const teamId=payload.plan.appliedTeamId??payload.team?.id;assert.ok(teamId,JSON.stringify(payload));
    const stateRoot=join(workspace,'expert-teams'),teamPath=join(stateRoot,teamId,'team.json');
    let team=JSON.parse(await readFile(teamPath,'utf8'));
    const byId=id=>team.tasks.find(task=>task.planTask?.logicalId===id);
    let candidates=byId('outline_candidates');
    const choice=byId('outline_choice'),final=byId('outline_final'),research=byId('research_main'),counter=byId('research_counter'),city=byId('research_view_city'),figures=byId('point_figures'),renderer=byId('renderer'),visual=byId('visual_review');
    for(const item of [candidates,choice,final,research,counter,city,figures,renderer,visual])assert.ok(item,'missing DAG task');
    assert.ok(choice.dependencies.includes(candidates.id));
    assert.ok(final.dependencies.includes(choice.id));
    assert.ok(research.dependencies.includes(final.id));
    assert.ok(counter.dependencies.includes(final.id));
    assert.ok(city.dependencies.includes(final.id));
    assert.ok(figures.dependencies.includes(final.id));
    assert.ok(renderer.dependencies.includes(figures.id));
    assert.ok(visual.dependencies.includes(renderer.id));
    assert.deepEqual(choice.humanChoice.options,['A','B','C','A+C']);
    assert.ok(team.qualityRuns[candidates.id]);
    assert.ok(!team.qualityRuns[choice.id]);
    assert.ok(team.qualityRuns[figures.id]);
    for(const logicalId of team.tasks.map(task=>task.planTask?.logicalId).filter(id=>id?.startsWith('expert_brief_'))){
      const brief=byId(logicalId),name=logicalId+'.md';
      const briefOwner=team.members.find(member=>member.name===brief.assignee);
      const briefReviewer=team.members.find(member=>member.name!==brief.assignee);
      assert.ok(briefOwner&&briefReviewer&&brief.attemptId);
      await writeFile(join(stateRoot,teamId,brief.project.path,'artifacts',name),'# 独立研判\\n机制待核；反方待核；无新增数字。\\n');
      await callAs(briefOwner.id,'update_task',{task_id:brief.id,attempt_id:brief.attemptId,status:'in_progress'});
      await callAs(briefOwner.id,'publish_artifact',{task_id:brief.id,attempt_id:brief.attemptId,source_path:'artifacts/'+name,name});
      await callAs(briefOwner.id,'update_task',{task_id:brief.id,attempt_id:brief.attemptId,output:'Synthetic brief for Host DAG verification.',execution_state:'awaiting_review'});
      const current=JSON.parse(await readFile(teamPath,'utf8'));
      const acceptance=current.qualityRuns[brief.id].contract.acceptance.map(item=>({id:item.id,passed:true,detail:'Synthetic brief for Host protocol test only.'}));
      await callAs(briefReviewer.id,'quality_review',{task_id:brief.id,event_id:'brief-review-'+randomUUID(),reviewer:briefReviewer.name,verdict:'pass',acceptance_results:acceptance});
      await call(captain,'quality_integrate',{task_id:brief.id,event_id:'brief-integrate-'+randomUUID(),actor:'captain',complete_task:true});
      team=JSON.parse(await readFile(teamPath,'utf8'));
    }
    candidates=byId('outline_candidates');
    if(candidates.status==='pending'){
      const nextOwner=team.members.find(member=>member.name===candidates.assignee);
      await callAs(nextOwner.id,'claim_task',{task_id:candidates.id});
      team=JSON.parse(await readFile(teamPath,'utf8'));
      candidates=byId('outline_candidates');
    }
    const owner=team.members.find(member=>member.name===candidates.assignee);
    const reviewer=team.members.find(member=>member.name!==candidates.assignee);
    assert.ok(owner&&reviewer);
    const materials=(await requiredOutlineMaterials()).map(item=>item.id+' '+item.sha256+' 用于章节设计：测试选题问题、证据、战略收口。').join('\\n');
    const candidateText='## A 主基调\\n问题、机制、行动。\\n## B 风险揭示\\n反方与失效条件。\\n## C 时间轴\\n路径对照与决策。\\n'+materials+'\\n';
    const candidateFile=join(stateRoot,teamId,candidates.project.path,'artifacts','outline-candidates.md');
    await writeFile(candidateFile,candidateText);
    await callAs(owner.id,'update_task',{task_id:candidates.id,attempt_id:candidates.attemptId,status:'in_progress'});
    await callAs(owner.id,'publish_artifact',{task_id:candidates.id,attempt_id:candidates.attemptId,source_path:'artifacts/outline-candidates.md',name:'outline-candidates.md'});
    await callAs(owner.id,'update_task',{task_id:candidates.id,attempt_id:candidates.attemptId,output:'Synthetic A/B/C candidate for Host workflow verification only.',execution_state:'awaiting_review'});
    team=JSON.parse(await readFile(teamPath,'utf8'));
    const acceptance=team.qualityRuns[candidates.id].contract.acceptance.map(item=>({id:item.id,passed:true,detail:'Synthetic Host-gate fixture; only protocol wiring is under test.'}));
    await callAs(reviewer.id,'quality_review',{task_id:candidates.id,event_id:'candidate-review-'+randomUUID(),reviewer:reviewer.name,verdict:'pass',acceptance_results:acceptance});
    await call(captain,'quality_integrate',{task_id:candidates.id,event_id:'candidate-integrate-'+randomUUID(),actor:'captain',complete_task:true});
    team=JSON.parse(await readFile(teamPath,'utf8'));
    const preview=await readHumanChoice(stateRoot,team,team.tasks.find(task=>task.id===choice.id));
    assert.equal(preview.content,candidateText);
    assert.equal(team.tasks.find(task=>task.id===choice.id).status,'pending');
    assert.equal(team.tasks.find(task=>task.id===research.id).status,'pending');
    result={sessionId:captain.id,teamId,taskCount:team.tasks.length,outlineCandidates:{id:candidates.id,status:team.tasks.find(task=>task.id===candidates.id).status,sha256:createHash('sha256').update(candidateText).digest('hex')},choice:{id:choice.id,status:'pending',options:choice.humanChoice.options,candidatePreviewReadable:true},selectedOutline:{id:final.id,status:team.tasks.find(task=>task.id===final.id).status},research:{id:research.id,status:team.tasks.find(task=>task.id===research.id).status},counterResearch:{id:counter.id,status:team.tasks.find(task=>task.id===counter.id).status},pointFigures:{id:figures.id,status:team.tasks.find(task=>task.id===figures.id).status},renderer:{id:renderer.id,status:team.tasks.find(task=>task.id===renderer.id).status},visualReview:{id:visual.id,status:team.tasks.find(task=>task.id===visual.id).status},hostApproval:payload.plan.approval.source,qualityRuns:Object.keys(team.qualityRuns).length};
   }else{res.writeHead(400);res.end();return}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error.stack??error)}))}
 }}));
}
` }

runTeamCommunicationHostSmoke({probePlugin,kind:'deep-research-dag-v2-new-session',preserveFailure:true,probeTimeoutMs:60_000,
  limitations:['New isolated DSH Host session with a deterministic local model; production Web login and real content generation are outside this smoke test.','No paid provider calls; approval uses the authenticated isolated Host browser route.']})
  .then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n'))
  .catch(error=>{process.stderr.write(String(error.message??error)+'\n');process.exitCode=1})
