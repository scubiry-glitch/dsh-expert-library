/** V3 phase 3 in an isolated DSH Host, from outline choice through final delivery. */
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
import { requiredOutlineMaterials, inspectPdfPages } from ${url(join(repo, 'lib/deep-research-gates.js'))};
import { createDeepResearchStage3Fixture } from ${url(join(repo, 'test/support/deep-research-stage3-fixture.mjs'))};
import { readHumanChoice } from ${url(join(repo, 'lib/human-choice.js'))};
export const name='deep-research-dag-host-probe';
export const inject=['tools','webServer','agents','llm','agentPresets'];
const workspace=${JSON.stringify(workspace)}, nonce=${JSON.stringify(nonce)}, repo=${JSON.stringify(repo)}, visualRevision=${JSON.stringify(process.env.DEEP_RESEARCH_VISUAL_REVISION_SMOKE === '1')};
const file=join(workspace,'deep-research-smoke.json');
const source='/root/.openclaw/workspace/98wiki/projects/供平过租见底路径/深度研究团队DAG-v3.json';
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
    const previewResponse=await fetch('http://'+req.headers.host+'/plugins/dsh-expert-library/teams?captainSessionId='+encodeURIComponent(captain.id)+'&planId='+encodeURIComponent(staged.planId),{headers:{cookie:req.headers.cookie??''}});
    const planPreview=await previewResponse.json();assert.equal(previewResponse.status,200,JSON.stringify(planPreview));
    assert.equal(planPreview.plan?.preview?.expertSelection?.candidates?.filter(item=>item.selected).length,3);
    assert.ok(planPreview.plan.preview.expertSelection.candidates.every(item=>item.reason?.length&&item.recommendedRole?.length));
    assert.ok(planPreview.plan?.preview?.analysisFramework?.falsifiers?.length);
    assert.equal(planPreview.plan?.preview?.tasks?.find(task=>task.id==='outline_candidates')?.taskMaterials?.prompt.templateId,'98wiki-outline-candidates-v1');
    const response=await fetch('http://'+req.headers.host+'/plugins/dsh-expert-library/teams',{method:'POST',headers:{'content-type':'application/json',cookie:req.headers.cookie??''},body:JSON.stringify({action:'approve',captainSessionId:captain.id,planId:staged.planId,expectedDigest:staged.digest,expectedRevision:staged.revision})});
    const payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));
    const teamId=payload.plan.appliedTeamId??payload.team?.id;assert.ok(teamId,JSON.stringify(payload));
    const stateRoot=join(workspace,'expert-teams'),teamPath=join(stateRoot,teamId,'team.json');
    let team=JSON.parse(await readFile(teamPath,'utf8'));
    const byId=id=>team.tasks.find(task=>task.planTask?.logicalId===id);
    let candidates=byId('outline_candidates');
    for(const expertId of ['bk-024','bk-031','bk-010'])assert.ok(team.members.some(member=>member.capabilityScope?.expertId===expertId),'missing bound expert '+expertId);
    const candidateOwner=team.members.find(member=>member.name===candidates.assignee);
    await assert.rejects(callAs(candidateOwner.id,'claim_task',{task_id:candidates.id}),/blocked by unfinished dependencies/);
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
    assert.ok(candidates.frozenTaskMaterialContract?.digest);
    assert.equal(candidates.promptBinding?.templateId,'98wiki-outline-candidates-v1');
    assert.ok(team.tasks.filter(t=>t.planTask?.logicalId?.startsWith('expert_brief_')).every(t=>t.frozenTaskMaterialContract?.digest));
    assert.ok(!team.qualityRuns[choice.id]);
    assert.ok(team.qualityRuns[figures.id]);
    for(const logicalId of team.tasks.map(task=>task.planTask?.logicalId).filter(id=>id?.startsWith('expert_brief_'))){
      const brief=byId(logicalId),name=logicalId+'.md';
      const briefOwner=team.members.find(member=>member.name===brief.assignee);
      const briefReviewer=team.members.find(member=>member.name!==brief.assignee);
      assert.ok(briefOwner&&briefReviewer&&brief.attemptId);
      await callAs(briefOwner.id,'claim_task',{task_id:brief.id});
      await writeFile(join(stateRoot,teamId,brief.project.path,'artifacts',name),'# 独立研判\\n机制待核；反方待核；无新增数字。\\n');
      await callAs(briefOwner.id,'update_task',{task_id:brief.id,attempt_id:brief.attemptId,status:'in_progress'});
      await callAs(briefOwner.id,'publish_artifact',{task_id:brief.id,attempt_id:brief.attemptId,source_path:'artifacts/'+name,name});
      await callAs(briefOwner.id,'update_task',{task_id:brief.id,attempt_id:brief.attemptId,output:'Synthetic brief for Host DAG verification.',execution_state:'awaiting_review'});
      const current=JSON.parse(await readFile(teamPath,'utf8'));
      const acceptance=current.qualityRuns[brief.id].contract.acceptance.map(item=>({id:item.id,passed:true,detail:'Synthetic brief for Host protocol test only.'}));
      const prepared=await callAs(briefReviewer.id,'quality_review',{task_id:brief.id,reviewer:briefReviewer.name,prepare_only:true});
      assert.ok(prepared.task_materials?.includes('Host-frozen task materials'));
      await callAs(briefReviewer.id,'quality_review',{task_id:brief.id,material_receipt:prepared.material_receipt,event_id:'brief-review-'+randomUUID(),reviewer:briefReviewer.name,verdict:'pass',acceptance_results:acceptance});
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
    const prepared=await callAs(reviewer.id,'quality_review',{task_id:candidates.id,reviewer:reviewer.name,prepare_only:true});
    assert.ok(prepared.task_materials?.includes('Host-frozen task materials'));
    await callAs(reviewer.id,'quality_review',{task_id:candidates.id,material_receipt:prepared.material_receipt,event_id:'candidate-review-'+randomUUID(),reviewer:reviewer.name,verdict:'pass',acceptance_results:acceptance});
    await call(captain,'quality_integrate',{task_id:candidates.id,event_id:'candidate-integrate-'+randomUUID(),actor:'captain',complete_task:true});
    team=JSON.parse(await readFile(teamPath,'utf8'));
    const preview=await readHumanChoice(stateRoot,team,team.tasks.find(task=>task.id===choice.id));
    assert.equal(preview.content,candidateText);
    assert.equal(team.tasks.find(task=>task.id===choice.id).status,'pending');
    assert.equal(team.tasks.find(task=>task.id===research.id).status,'pending');
    assert.ok(team.tasks.find(task=>task.id===candidates.id).taskMaterialDeliveries?.some(r=>r.role==='reviewer'&&r.accepted));
    result={sessionId:captain.id,teamId,taskCount:team.tasks.length,outlineCandidates:{id:candidates.id,status:team.tasks.find(task=>task.id===candidates.id).status,sha256:createHash('sha256').update(candidateText).digest('hex')},choice:{id:choice.id,status:'pending',options:choice.humanChoice.options,candidatePreviewReadable:true},selectedOutline:{id:final.id,status:team.tasks.find(task=>task.id===final.id).status},research:{id:research.id,status:team.tasks.find(task=>task.id===research.id).status},counterResearch:{id:counter.id,status:team.tasks.find(task=>task.id===counter.id).status},pointFigures:{id:figures.id,status:team.tasks.find(task=>task.id===figures.id).status},renderer:{id:renderer.id,status:team.tasks.find(task=>task.id===renderer.id).status},visualReview:{id:visual.id,status:team.tasks.find(task=>task.id===visual.id).status},hostApproval:payload.plan.approval.source,qualityRuns:Object.keys(team.qualityRuns).length};
    const digest=value=>createHash('sha256').update(value).digest('hex');
    const chooseResponse=await fetch('http://'+req.headers.host+'/plugins/dsh-expert-library/teams',{method:'POST',headers:{'content-type':'application/json',cookie:req.headers.cookie??''},body:JSON.stringify({action:'choose',captainSessionId:captain.id,teamId,taskId:choice.id,choice:'A',expectedSha256:preview.sha256})});
    const chosen=await chooseResponse.json();assert.equal(chooseResponse.status,200,JSON.stringify(chosen));
    const load=()=>readFile(teamPath,'utf8').then(JSON.parse);
    const find=(current,id)=>current.tasks.find(item=>item.planTask?.logicalId===id);
    const complete=async(logicalId,files)=>{
      let current=await load(),task=find(current,logicalId);
      assert.ok(task,'missing '+logicalId);
      const author=current.members.find(member=>member.name===task.assignee);
      assert.ok(author,'missing owner for '+logicalId);
      if(task.status==='pending')await callAs(author.id,'claim_task',{task_id:task.id});
      current=await load();task=find(current,logicalId);
      assert.ok(['claimed','in_progress'].includes(task.status),logicalId+' must be claimed or in progress');
      assert.ok(task.frozenTaskMaterialContract?.digest,logicalId+' requires frozen materials');
      await callAs(author.id,'update_task',{task_id:task.id,attempt_id:task.attemptId,status:'in_progress'});
      for(const [name,content] of Object.entries(files)){
        await writeFile(join(stateRoot,teamId,task.project.path,'artifacts',name),content);
        await callAs(author.id,'publish_artifact',{task_id:task.id,attempt_id:task.attemptId,source_path:'artifacts/'+name,name});
      }
      await callAs(author.id,'update_task',{task_id:task.id,attempt_id:task.attemptId,output:'Synthetic protocol fixture only; no business assertions.',execution_state:'awaiting_review'});
      current=await load();task=find(current,logicalId);
      const domainReviewer=current.members.find(member=>member.name!==task.assignee&&member.capabilityScope?.expertId?.startsWith('bk-')&&!current.tasks.some(active=>active.assignee===member.name&&active.status==='in_progress'));
      const reviewer=task.reportBundle?.craft?current.members.find(member=>member.capabilityScope?.expertId==='design-critic'):domainReviewer??current.members.find(member=>member.capabilityScope?.expertId==='design-critic');
      assert.ok(reviewer&&current.qualityRuns[task.id],logicalId+' reviewer/quality run missing');
      const acceptance=current.qualityRuns[task.id].contract.acceptance.map(item=>({id:item.id,passed:true,detail:'Deterministic isolated protocol fixture; semantic business quality not asserted.'}));
      const prepared=await callAs(reviewer.id,'quality_review',{task_id:task.id,reviewer:reviewer.name,prepare_only:true});
      assert.ok(prepared.task_materials?.includes('Host-frozen task materials'),logicalId+' material delivery missing');
      const craft=task.reportBundle?.craft?{task_material_receipt:prepared.task_material_receipt,independent_review:prepared.independent_review_areas.map(area=>({id:area.id,status:'passed',coverage:'Isolated current report fixture and all eight current machine checks inspected; no business claim.',evidence:[{artifactId:'published:report.md',quote:'本轮只验证结构，不作为业务研究结论。',reason:'Current Markdown anchor for deterministic protocol-only review.'}]}))}:{};
      await callAs(reviewer.id,'quality_review',{task_id:task.id,material_receipt:prepared.material_receipt,event_id:'stage3-review-'+randomUUID(),reviewer:reviewer.name,verdict:'pass',acceptance_results:acceptance,...craft});
      await call(captain,'quality_integrate',{task_id:task.id,event_id:'stage2-integrate-'+randomUUID(),actor:'captain',complete_task:true});
      current=await load();assert.equal(find(current,logicalId).status,'completed',logicalId+' did not complete');
      return current;
    };
    const names=['问题与反常识结论','机制与证据','情景与反方','战略收口','行动与复盘'];
    const outlineText='选择: A\\n候选稿SHA256: '+preview.sha256+'\\n\\n'+names.map(name=>'## '+name+'\\n### 角度一\\n### 视角二\\n反常识结论：待核验。').join('\\n\\n')+'\\n';
    await complete('outline_final',{'OUTLINE.md':outlineText});
    const probes=['北京','上海'].flatMap(city=>['wind','beike','zyt'].map(channel=>({city,channel,status:'failed',tool:'isolated-fixture',request:city+'/'+channel,reason:'隔离 Host 合成故障回执',attemptedAt:'2026-10-06T00:00:00Z',receiptSha256:digest(city+'/'+channel+'/fixture-failed'),errorCode:'FIXTURE_UNAVAILABLE',fallback:'公开材料且标条件分析'})));
    const fence=String.fromCharCode(96).repeat(3);
    const channelText='# 合成通道预检，仅验证协议\\n\\n'+fence+'json channel-status\\n'+JSON.stringify({cities:['北京','上海'],researchMode:'CONDITIONAL',probes})+'\\n'+fence+'\\n';
    await complete('data_preflight',{'data-channel-status.md':channelText});
    const notes={};
    const researchIds=['research_main','research_counter','research_view_city'];
    for(const id of researchIds){
      const current=await load(),task=find(current,id),author=current.members.find(member=>member.name===task.assignee);
      if(task.status==='pending')await callAs(author.id,'claim_task',{task_id:task.id});
    }
    const parallel=await load();
    assert.ok(researchIds.every(id=>['claimed','in_progress'].includes(find(parallel,id).status)),'parallel research must be claimable together');
    for(const id of researchIds){
      const filename=id==='research_main'?'research-main.md':id==='research_counter'?'research-counter.md':id+'.md';
      const content='# '+id+' 合成证据\\n\\nS1 和 S2 是隔离测试标签；无真实房产数据。\\n';
      notes[id]=content;await complete(id,{[filename]:content});
    }
    const merge={inputs:researchIds.map(task=>({task,sha256:digest(notes[task])})),sources:[{id:'S1',title:'隔离测试来源一',url:'https://example.org/fixture-1',accessedAt:'2026-10-06'},{id:'S2',title:'隔离测试来源二',url:'https://example.org/fixture-2',accessedAt:'2026-10-06'}],externalIncrements:Array.from({length:10},(_,index)=>({id:'E'+index,claim:'合成增量 '+index,sourceId:index%2?'S1':'S2',novelty:'只验证外部增量台账结构 '+index})),status:'CONDITIONAL'};
    const evidenceText='# 合成证据融合，不能作为业务事实\\n\\n'+fence+'json evidence-merge\\n'+JSON.stringify(merge)+'\\n'+fence+'\\n';
    await complete('evidence_merge',{'research-evidence.md':evidenceText});
    const fixture=createDeepResearchStage3Fixture(names);
    const reportText=fixture.md;
    const ledger={schemaVersion:1,outlineSha256:digest(outlineText),evidenceSha256:digest(evidenceText),reportSha256:digest(reportText),chapters:fixture.rows.map(row=>({heading:row.name,parts:row.parts,sourceIds:['S1','S2'],numericClaims:[]}))};
    const ledgerText=JSON.stringify(ledger);
    await complete('writer',{'report.md':reportText,'report-source-ledger.json':ledgerText});
    const reviewText='报告SHA256: '+digest(reportText)+'\\n来源台账SHA256: '+digest(ledgerText)+'\\n结论: PASS\\n'+names.map(name=>'## '+name+'\\n已复核合成来源和五件套；不代表业务质量。').join('\\n')+'\\n';
    await complete('content_review',{'review-notes.md':reviewText,'report.md':reportText});
    team=await load();
    const releasePreview=await readHumanChoice(stateRoot,team,find(team,'report_release'));
    assert.equal(releasePreview.content,reportText,'Host release gate must display the reviewed report in full');
    assert.equal(releasePreview.sha256,digest(reportText));
    for(const id of ['report_release','point_figures','renderer','visual_review','finalqa'])assert.equal(find(team,id).status,'pending',id+' must remain pending after phase 2');
    const releaseResponse=await fetch('http://'+req.headers.host+'/plugins/dsh-expert-library/teams',{method:'POST',headers:{'content-type':'application/json',cookie:req.headers.cookie??''},body:JSON.stringify({action:'choose',captainSessionId:captain.id,teamId,taskId:find(team,'report_release').id,choice:'进入点睛图',expectedSha256:releasePreview.sha256})});
    const released=await releaseResponse.json();assert.equal(releaseResponse.status,200,JSON.stringify(released));
    await complete('point_figures',{'figure-spec.md':fixture.figureSpec,'figure-fragments.html':fixture.fragments});
    const references=[{id:'designer-v1.html',file:'zhijian-designer-v1.html',sourceSelector:'.fig',chapter:names[0]},{id:'credit-policy-v1.html',file:'zhijian-credit-policy-v1.html',sourceSelector:'.num.tnum',chapter:names[1]}];
    const referenceMap={references:await Promise.all(references.map(async item=>({id:item.id,sha256:digest(await readFile(join(repo,'domain-packs','zhijian-realestate','references',item.file))),sourceSelector:item.sourceSelector,outputSelector:'.fig',chapter:item.chapter,reason:'隔离 Host 验证当前参考结构与成品图卡映射'})))};
    await complete('renderer',{'report.md':fixture.md,'report.html':fixture.html,'report.pdf':fixture.pdf,'craft-evidence.json':fixture.craftText,'reference-map.json':JSON.stringify(referenceMap)});
    const renderedPages=await inspectPdfPages(fixture.pdf);
    const pages=Object.fromEntries(Object.entries(renderedPages.pages).map(([name,page])=>[name,{...page,finding:name==='middle'?'正文、章节与图卡在隔离测试中可读':'封面或封底在隔离测试中可读'}]));
    const visualData={verdict:'PASS',checkedAt:'2026-10-06T00:00:00Z',method:'Host domain browser checker 1280/375 and synthetic PDF inspection',pageCount:renderedPages.pageCount,pages,blockers:0,htmlSha256:digest(fixture.html),pdfSha256:digest(fixture.pdf),dom:'已读当前 DOM，无隐藏正文',wide:'1280 视口无裁切',narrow:'375 视口无裁切',interactions:'无 CTA、死按钮或 reveal 门控',accessibility:'语义标题与对比度预检通过'};
    const visualText='# 独立视觉复核，仅限隔离合成样本\\n\\n'+fence+'json visual-audit\\n'+JSON.stringify(visualData)+'\\n'+fence+'\\n';
    if(visualRevision){
      let current=await load(),oldReview=find(current,'visual_review');
      const author=current.members.find(member=>member.name===oldReview.assignee);
      if(oldReview.status==='pending')await callAs(author.id,'claim_task',{task_id:oldReview.id});
      current=await load();oldReview=find(current,'visual_review');
      await callAs(author.id,'update_task',{task_id:oldReview.id,attempt_id:oldReview.attemptId,status:'in_progress'});
      await writeFile(join(stateRoot,teamId,oldReview.project.path,'artifacts','visual-review.md'),'# 隔离测试 hard blocker：PDF 中页不可读\\n');
      await callAs(author.id,'publish_artifact',{task_id:oldReview.id,attempt_id:oldReview.attemptId,source_path:'artifacts/visual-review.md',name:'visual-review.md'});
      await callAs(author.id,'update_task',{task_id:oldReview.id,attempt_id:oldReview.attemptId,output:'Synthetic hard visual blocker for versioned recovery test.',execution_state:'awaiting_review'});
      current=await load();oldReview=find(current,'visual_review');
      const independent=current.members.find(member=>member.name!==oldReview.assignee&&member.capabilityScope?.expertId?.startsWith('bk-'));
      const prepared=await callAs(independent.id,'quality_review',{task_id:oldReview.id,reviewer:independent.name,prepare_only:true});
      const acceptance=current.qualityRuns[oldReview.id].contract.acceptance.map(item=>({id:item.id,passed:item.id==='output-present',detail:'Synthetic visual rejection; no business claim.'}));
      await callAs(independent.id,'quality_review',{task_id:oldReview.id,reviewer:independent.name,material_receipt:prepared.material_receipt,event_id:'visual-reject-'+randomUUID(),verdict:'reject',acceptance_results:acceptance,findings:[{id:'synthetic-visual-blocker',code:'PDF_MIDDLE_UNREADABLE',severity:'hard',message:'Synthetic middle-page visual blocker',taskId:oldReview.id,attempt:oldReview.attempt}]});
      const opened=await call(captain,'open_visual_revision',{});
      current=await load();
      assert.equal(find(current,'visual_review').status,'failed');
      assert.equal(current.qualityRuns[oldReview.id].status,'blocked');
      assert.ok(find(current,'finalqa').dependencies.includes(opened.render_task_id));
      assert.ok(find(current,'finalqa').dependencies.includes(opened.visual_review_task_id));
      assert.ok(!find(current,'finalqa').dependencies.includes(oldReview.id));
      await assert.rejects(call(captain,'open_visual_revision',{}),/already exists/);
      await complete('render_revision_1',{'report.md':fixture.md,'report.html':fixture.html,'report.pdf':fixture.pdf,'craft-evidence.json':fixture.craftText,'reference-map.json':JSON.stringify(referenceMap)});
      await complete('visual_review_1',{'visual-review.md':visualText});
    }else await complete('visual_review',{'visual-review.md':visualText});
    const artifacts=Object.fromEntries([['report.md',fixture.md],['report.html',fixture.html],['report.pdf',fixture.pdf],['craft-evidence.json',fixture.craftText],['reference-map.json',JSON.stringify(referenceMap)]].map(([name,content])=>[name,digest(content)]));
    const deliveryData={verdict:'PASS',checkedAt:'2026-10-06T00:00:00Z',method:'Isolated Host current-byte artifact and three-page review',pageCount:3,pages,blockers:0,visualReviewSha256:digest(visualText),artifacts};
    const deliveryText='# 隔离 Host 交付验收\\n\\n'+fence+'json delivery-audit\\n'+JSON.stringify(deliveryData)+'\\n'+fence+'\\n';
    await complete('finalqa',{'delivery-check.md':deliveryText});
    team=await load();
    for(const id of ['report_release','point_figures','renderer',visualRevision?'visual_review_1':'visual_review','finalqa'])assert.equal(find(team,id).status,'completed',id+' must complete');
    const renderTask=find(team,'renderer'),checks=team.qualityRuns[renderTask.id]?.latestEvidence?.artifactCheckReceipts??[];
    assert.equal(team.qualityRuns[renderTask.id]?.contract?.maxRepairRounds,1,'renderer repair budget must be bounded');
    assert.equal(checks.length,1,'renderer must have one domain check receipt');
    assert.equal(checks[0].results.length,8,'all eight craft checks must run');
    assert.ok(checks[0].results.every(item=>item.status==='passed'),'all eight craft checks must pass');
    result={...result,phase:visualRevision?4:3,visualRevision,authenticatedOutlineChoice:chosen.ok===true,authenticatedReportRelease:released.ok===true,reportSha256:digest(reportText),figureSha256:digest(fixture.fragments),htmlSha256:digest(fixture.html),pdfSha256:digest(fixture.pdf),visualReviewSha256:digest(visualText),deliverySha256:digest(deliveryText),completed:['report_release','point_figures','renderer',visualRevision?'visual_review_1':'visual_review','finalqa'],renderSkillBound:renderTask.frozenTaskMaterialContract?.skills.map(item=>item.skillId),craftChecks:checks.flatMap(receipt=>receipt.results.map(item=>({id:item.id,status:item.status}))),repairBudget:team.qualityRuns[renderTask.id]?.contract?.maxRepairRounds};
   }else{res.writeHead(400);res.end();return}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error.stack??error)}))}
 }}));
}
` }

runTeamCommunicationHostSmoke({probePlugin,kind:process.env.DEEP_RESEARCH_VISUAL_REVISION_SMOKE === '1'?'deep-research-dag-v3-stage4-visual-revision':'deep-research-dag-v3-stage3-new-session',preserveFailure:true,probeTimeoutMs:360_000,domainPackSource:join(repo,'domain-packs','.zhijian-realestate-v15-src'),
  limitations:['New isolated DSH Host session with deterministic synthetic content; production Web login, paid provider calls and business quality are outside this smoke test.','Visual review text is a synthetic protocol assertion, not human visual certification.']})
  .then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n'))
  .catch(error=>{process.stderr.write(String(error.message??error)+'\n');process.exitCode=1})
