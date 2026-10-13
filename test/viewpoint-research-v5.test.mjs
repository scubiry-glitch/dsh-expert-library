import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {qualityPublicationFixture} from './support/quality-publication-fixture.mjs'
import {viewpointResearchProfile,validateViewpointResearchPlan} from '../lib/viewpoint-research-plan.js'
import {parseProfile,profileToExecutionPlan} from '../lib/profiles.js'
import {requireReportOutline} from '../lib/plan-review.js'
import {assertResearchRelease,isResearchRelease} from '../lib/research-release.js'
import {prepareDependencyInputs} from '../lib/dependency-inputs.js'
import {readHumanChoice,completeHumanChoice} from '../lib/human-choice.js'
import {checkV5Ledger,checkV5FigurePlan,checkV5FigureImplementation} from '../lib/viewpoint-research-checks.js'
import {collectV5WriterPreflight} from '../lib/deep-research-gates.js'
import {currentTaskAction} from '../lib/task-actions.js'
const old='/root/.openclaw/workspace/98wiki/projects/供平过租见底路径/深度研究团队DAG-v3.json'
const sha=s=>createHash('sha256').update(s).digest('hex')
test('V5 additive profile keeps all selected experts and drops inherited editorial quotas',async()=>{
 const src=parseProfile(JSON.parse(await readFile(old,'utf8')).profile), before=JSON.stringify(src)
 const p=viewpointResearchProfile(src);assert.equal(JSON.stringify(src),before)
 validateViewpointResearchPlan(parseProfile(p))
 const focused=structuredClone(p);focused.analysisFramework.axes=focused.analysisFramework.axes.slice(0,1);focused.analysisFramework.hypotheses=focused.analysisFramework.hypotheses.slice(0,1);assert.doesNotThrow(()=>validateViewpointResearchPlan(parseProfile(focused)))
 const plan=profileToExecutionPlan(p)
 assert.doesNotThrow(()=>requireReportOutline(plan))
 for(const m of p.members.filter(m=>/^bk-\d+$/u.test(m.expert??''))){assert(p.tasks.some(t=>t.id===`expert_view_${m.id}`));assert(p.tasks.some(t=>t.id===`research_${m.id}`))}
 assert.equal(p.tasks.filter(t=>t.humanChoice).length,2)
 assert(!JSON.stringify(p.tasks).includes('至少五章'));assert(!JSON.stringify(p.tasks).includes('三透彻正文至少一半'))
 assert.equal(p.tasks.find(t=>t.id==='renderer').reportBundle.craft.selections[0].skillId,'zhijian-research-craft-v5')
 const broken=structuredClone(p);broken.tasks.pop();assert.throws(()=>validateViewpointResearchPlan(broken))
})
async function fixture(t){
 const f=await qualityPublicationFixture(t),team=await f.read()
 team.planRef={planId:'v5-test',digest:'0'.repeat(64),templateId:'profile:98wiki-deep-research',templateVersion:'5.0.0',scenarioId:'98wiki-deep-research'}
 team.qualityRuns={};delete team.qualityRun;team.structuredQualityPolicy={required:true,maxRepairRounds:2}
 team.tasks[0].planTask={logicalId:'viewpoints'};team.tasks[0].declaredPublications=['viewpoints.md'];await f.write(team)
 const content='# Candidate\n供给改善先于租金恢复。\n```viewpoint-options\n["供给改善先于租金恢复","需求结构改变"]\n```\n'
 await writeFile(join(f.teamRoot,'expert-tasks/t1/artifacts/viewpoints.md'),content)
 const submit={task_id:'t1',attempt_id:'publication-attempt-1',submission_id:'v5-work-1',status:'in_progress',execution_state:'awaiting_review',output:'Material ready; no independent review claimed',publications:[{name:'viewpoints.md',source_path:'artifacts/viewpoints.md'}]}
 return {...f,submit,content}
}
test('internal material advances atomically without fake review; retries and frozen bytes',async t=>{
 const f=await fixture(t), before=await f.read()
 assert.equal(currentTaskAction(before,before.tasks[0],'worker').kind,'submit')
 await assert.rejects(f.call('update_task',{...f.submit,publications:[]},'worker'),/INCOMPLETE/)
 assert.deepEqual(await f.read(),before)
 await f.call('update_task',f.submit,'worker');const after=await f.read(),task=after.tasks[0]
 assert.equal(task.status,'completed');assert.equal(task.researchRelease.schemaVersion,2);assert(!('reviewer' in task.researchRelease));assert(isResearchRelease(task.researchRelease));assertResearchRelease(after,task)
 await f.call('update_task',f.submit,'worker');assert.deepEqual(await f.read(),after)
 await assert.rejects(f.call('update_task',{...f.submit,output:'different'},'worker'),/IDEMPOTENCY_CONFLICT/)
 const consumer={id:'t3',planTask:{logicalId:'research_expert'},status:'pending',dependencies:['t1'],plannedArtifactInputs:[{fromTask:'viewpoints',artifact:'viewpoints.md',purpose:'viewpoint',phase:'work'}]};after.tasks.push(consumer)
 const refs=await prepareDependencyInputs(f.stateRoot,after,consumer,1);assert.equal(refs.length,1)
 await writeFile(refs[0].versionPath,'changed')
 await assert.rejects(prepareDependencyInputs(f.stateRoot,after,consumer,1),/HASH|CHANGED|hash|digest/i)
})
test('rejected multi-file submission does not poison a declared working release',async t=>{
 const f=await fixture(t)
 await writeFile(join(f.teamRoot,'expert-tasks/t1/artifacts/calculation-log.txt'),'Synthetic calculation trace')
 await f.call('publish_artifact',{task_id:'t1',attempt_id:f.submit.attempt_id,name:'calculation-log.txt',source_path:'artifacts/calculation-log.txt'},'worker')
 const before=await f.read()
 await assert.rejects(f.call('update_task',{...f.submit,publications:[...f.submit.publications,{name:'calculation-log.txt',source_path:'artifacts/calculation-log.txt'}]},'worker'),/SUBMISSION_FILES_INCOMPLETE/)
 assert.deepEqual(await f.read(),before)
 await f.call('update_task',f.submit,'worker')
 const team=await f.read(),source=team.tasks[0]
 assert.equal(source.status,'completed')
 assert.deepEqual(source.researchRelease.artifacts.map(a=>a.reviewId),['published:viewpoints.md'])
 assertResearchRelease(team,source)
 const consumer={id:'t3',planTask:{logicalId:'research_expert'},status:'pending',dependencies:['t1']}
 team.tasks.push(consumer)
 const refs=await prepareDependencyInputs(f.stateRoot,team,consumer,1)
 assert.deepEqual(refs.map(ref=>ref.reviewArtifactId),['published:viewpoints.md'])
})
test('viewpoint choice comes from immutable actual candidates, not placeholder labels',async t=>{
 const f=await fixture(t);await f.call('update_task',f.submit,'worker');const team=await f.read()
 const gate={id:'t2',planTask:{logicalId:'outline_choice'},subject:'Choose viewpoint',status:'pending',dependencies:['t1'],humanChoice:{sourceTaskId:'t1',artifact:'viewpoints.md',options:['选择材料中的观点']},createdAt:1,updatedAt:1};team.tasks.push(gate)
 const read=await readHumanChoice(f.stateRoot,team,gate);assert.deepEqual(read.options,['供给改善先于租金恢复','需求结构改变'])
 await assert.rejects(completeHumanChoice(f.stateRoot,team,gate,'选择材料中的观点',read.sha256),/INVALID_OPTION/)
 await assert.rejects(completeHumanChoice(f.stateRoot,team,gate,[read.options[0],read.options[0]],read.sha256),/INVALID_OPTION/)
 await assert.rejects(completeHumanChoice(f.stateRoot,team,gate,[read.options[0],'无关观点'],read.sha256),/INVALID_OPTION/)
 await completeHumanChoice(f.stateRoot,team,gate,read.options,read.sha256)
 assert.equal(gate.status,'completed');assert.equal(gate.humanChoiceReceipt.sourceReleaseDigest,team.tasks[0].researchRelease.digest)
 assert.deepEqual(gate.humanChoiceReceipt.choices,read.options)
 assert.equal(gate.humanChoiceReceipt.choice,`主观点：${read.options[0]}；补充观点：${read.options[1]}`)
 const persisted=await f.read()
 assert.deepEqual(persisted.tasks.find(task=>task.id==='t2')?.humanChoiceReceipt?.choices,read.options)
})
test('V5 accepts short viewpoint-led text, rejects unknown units and stale ledger',()=>{
 const report='# 判断\n租赁指数为 97.9。\n',ledger={schemaVersion:2,reportSha256:sha(report),sources:[{id:'s1',title:'synthetic protocol fixture',url:'https://example.com/fixture',accessedAt:'2026-10-07'}],claims:[{id:'c1',quote:'租赁指数为 97.9。',kind:'fact',sourceIds:['s1'],numeric:true,unit:'指数点',period:'2026-09',caliber:'synthetic test only'}],unresolved:[]}
 assert.doesNotThrow(()=>checkV5Ledger(report,JSON.stringify(ledger)))
 ledger.claims[0].unit='未知';assert.throws(()=>checkV5Ledger(report,JSON.stringify(ledger)),/confirmed unit/)
 ledger.claims[0].unit='指数点';assert.throws(()=>checkV5Ledger(report+'changed',JSON.stringify(ledger)),/reportSha256/)
})
test('V5 calculation contract reports the required scalar type before publication',()=>{
 const report='# 计算\n由 2 和 3 得到 5。\n'
 const ledger={schemaVersion:2,reportSha256:sha(report),sources:[{id:'s1',title:'synthetic fixture',url:'https://example.com/fixture',accessedAt:'2026-10-08'}],claims:[{id:'c1',quote:'由 2 和 3 得到 5。',kind:'calculation',sourceIds:['s1'],calculation:{inputs:[2,3],formula:'2+3',result:5}}],unresolved:[]}
 assert.throws(()=>checkV5Ledger(report,JSON.stringify(ledger)),/calculation must be one nonempty string/)
 ledger.claims[0].calculation='输入 A=2、B=3；公式 A+B；结果 5'
 assert.doesNotThrow(()=>checkV5Ledger(report,JSON.stringify(ledger)))
})
test('V5 ledger reports independent source and claim errors in one preflight pass',async()=>{
 const report='# 判断\n租赁指数为 97.9。\n'
 const ledger={schemaVersion:2,reportSha256:sha(report),sources:[{id:'s1',title:'',url:'https://example.com/fixture',accessedAt:'bad date'}],claims:[{id:'c1',quote:'租赁指数为 97.9。',kind:'calculation',sourceIds:['s1'],numeric:true,unit:'未知',period:'2026-09',caliber:'synthetic test only',calculation:{inputs:[97.9]}}],unresolved:[]}
 const raw=JSON.stringify(ledger)
 assert.throws(()=>checkV5Ledger(report,raw),error=>['sources[0].title','sources[0].accessedAt','claims[0].unit','claims[0].calculation'].every(issue=>error.message.includes(issue)))
 const errors=await collectV5WriterPreflight('.',new Map([['report.md',report],['report-source-ledger.json',raw],['OUTLINE.md','# 判断'],['figure-plan.json','{}']]))
 for(const issue of ['sources[0].title','sources[0].accessedAt','claims[0].unit','claims[0].calculation']) assert(errors.some(error=>error.includes(issue)),issue)
})
test('V5 writer preflight reports independent errors and matches the acceptance gate',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os')
 const teamRoot=await mkdtemp(join(tmpdir(),'v5-preflight-'));t.after(()=>rm(teamRoot,{recursive:true,force:true}))
 const report='# Report\n\n## 判断\n\n由 2 和 3 得到 5。\n'
 const ledger={schemaVersion:2,reportSha256:sha(report),sources:[{id:'s1',title:'synthetic fixture',url:'https://example.com/fixture',accessedAt:'2026-10-08'}],claims:[{id:'c1',quote:'由 2 和 3 得到 5。',kind:'calculation',sourceIds:['s1'],calculation:{inputs:[2,3],formula:'2+3',result:5}}],unresolved:[]}
 const plan={schemaVersion:1,reportSha256:sha(report),chapters:[{chapter:'判断',claim:'计算成立',relation:'输入相加得到结果',encoding:'equation',decision:'核实输入',sourceQuote:'由 2 和 3 得到 5。',sourceClaimIds:['c1']}]}
 const files=new Map([['report.md',report],['OUTLINE.md',''],['report-source-ledger.json',JSON.stringify(ledger)],['figure-plan.json',JSON.stringify(plan)]])
 const first=await collectV5WriterPreflight(teamRoot,files)
 assert(first.some(error=>error.includes('calculation must be one nonempty string')))
 assert(first.some(error=>error.includes('V5_OUTLINE_MISSING')))
 ledger.claims[0].calculation='输入 A=2、B=3；公式 A+B；结果 5'
 files.set('OUTLINE.md','# 本次材料支持的判断\n')
 files.set('report-source-ledger.json',JSON.stringify(ledger))
 assert.deepEqual(await collectV5WriterPreflight(teamRoot,files),[])
})
test('V5 figure handoff binds every actual chapter to approved claims and final figures',()=>{
 const report='# Report\n\n## Claim A\n\nEvidence A.\n\n## Claim B\n\nEvidence B.\n\n## 附录\n\nMethod.\n'
 const ledger={schemaVersion:2,reportSha256:sha(report),sources:[{id:'s1',title:'fixture',url:'https://example.com/fixture',accessedAt:'2026-10-07'}],claims:[{id:'a',quote:'Evidence A.',kind:'inference',sourceIds:['s1']},{id:'b',quote:'Evidence B.',kind:'inference',sourceIds:['s1']}],unresolved:[]}
 const chapters=[['Claim A','Evidence A.','a'],['Claim B','Evidence B.','b']].map(([chapter,sourceQuote,id])=>({chapter,claim:chapter,relation:'Evidence limits '+chapter,encoding:'mechanism',decision:'Interpret '+chapter+' cautiously',sourceQuote,sourceClaimIds:[id]}))
 const plan=JSON.stringify({schemaVersion:1,reportSha256:sha(report),chapters})
 assert.doesNotThrow(()=>checkV5FigurePlan(report,plan,checkV5Ledger(report,JSON.stringify(ledger))))
 assert.throws(()=>checkV5FigurePlan(report,JSON.stringify({schemaVersion:1,reportSha256:sha(report),chapters:chapters.slice(0,1)}),ledger),/exactly one/)
 assert.throws(()=>checkV5FigurePlan(report,JSON.stringify({schemaVersion:1,reportSha256:sha(report),chapters:[{...chapters[0],sourceQuote:'Evidence B.'},chapters[1]]}),ledger),/own chapter/)
 const figures=chapters.map((c,i)=>({id:'f'+i,...c}))
 assert.doesNotThrow(()=>checkV5FigureImplementation(plan,JSON.stringify({figurePlanSha256:sha(plan),figures})))
 assert.throws(()=>checkV5FigureImplementation(plan,JSON.stringify({figurePlanSha256:sha(plan),figures:figures.slice(0,1)})),/missing planned/)
 assert.throws(()=>checkV5FigureImplementation(plan,JSON.stringify({figurePlanSha256:'0'.repeat(64),figures})),/exact frozen/)
})
test('real stage and Host apply freeze V5 materials and create only two independent review runs',async t=>{
 const {mkdtemp,cp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os')
 const tools=await import('../lib/tools.js'),state=await import('../lib/state.js')
 const workspace=await mkdtemp(join(tmpdir(),'v5-stage-'));t.after(()=>rm(workspace,{recursive:true,force:true}))
 await cp(await (await import('node:fs/promises')).realpath(new URL('../domain-packs/zhijian-realestate',import.meta.url)),join(workspace,'domain-packs/zhijian-realestate'),{recursive:true})
 const agents=new Map(),registered=new Map()
 const make=id=>{const a={id,status:'idle',whenIdle:async()=>{},options:{provider:'test',model:'test'},session:{id,header:{cwd:workspace},requestHeader:()=>({config:{provider:'test',model:'test'}}),events:[],append(){},steer(){}}};agents.set(id,a);return a}
 const captain=make('captain-v5')
 const ctx={tools:{register(t){registered.set(t.name,t)}},agents:{get:id=>agents.get(id)},llm:{resolveCallConfig:async c=>c},logger:{debug(){},info(){},warn(){}},effect(){},on(){},
 subagents:{registerContinuableSetup(){return()=>{}},list:()=>['spawn'],listChildren:async()=>[],listDescendants:async()=>[],getProvider:()=>({prepareContinuable(){},capabilities:{persona:true,toolFilter:true}}),async startContinuable(i){make(i.childId);return{childId:i.childId}},async followup(){},interrupt(){}}}
 const config={stateDir:'.expert-teams',memberProvider:'spawn',maxMembers:8,knowledgeDir:'knowledge',packsDir:'domain-packs',enabledPacks:['zhijian-realestate']}
 const core=tools.registerExpertTeamsTools(ctx,config)
 const profile=JSON.parse(await readFile(old,'utf8')).profile
 const staged=await tools.scenarioStageCore(ctx,config,captain,{profile,research_flow:'viewpoint-v5',team_name:'v5-stage-test'})
 assert.equal(staged.plan.template.version,'5.0.0');assert(!staged.plan.reportOutline)
 assert(staged.plan.tasks.every(t=>t.humanChoice||t.frozenTaskMaterialContract))
 const renderer=staged.plan.tasks.find(t=>t.id==='renderer');assert.equal(renderer.frozenSkillCraftContract.packs[0].version,'1.6.0')
 await tools.scenarioApproveFromHost(ctx,config,captain,staged.planId,new AbortController().signal,core,staged.digest,staged.revision)
 const team=await state.readTeam(join(workspace,'.expert-teams'),'v5-stage-test')
 assert.deepEqual(Object.keys(team.qualityRuns).map(id=>team.tasks.find(t=>t.id===id).planTask.logicalId).sort(),['renderer','writer'])
 for(const task of team.tasks.filter(t=>!t.humanChoice))assert(task.declaredPublications.length)
 const root=join(workspace,'.expert-teams'),read=()=>state.readTeam(root,'v5-stage-test')
 const call=(name,args,agent)=>registered.get('expert_teams_'+name).execute(args,{agent,session:agent.session,signal:new AbortController().signal})
 async function submit(logical,files){
  let current=await read(),task=current.tasks.find(t=>t.planTask?.logicalId===logical)
  const agent=agents.get(current.members.find(m=>m.name===task.assignee).id)
  const claimed=await call('claim_task',{task_id:task.id},agent)
  current=await read();task=current.tasks.find(t=>t.id===task.id)
  const publications=[]
  for(const [name,content] of Object.entries(files)){await writeFile(join(root,current.id,task.project.artifactsPath,name),content);publications.push({name,source_path:'artifacts/'+name})}
  await call('update_task',{task_id:task.id,attempt_id:task.attemptId,submission_id:'synthetic-'+task.id,status:'in_progress',execution_state:'awaiting_review',output:'Synthetic integration fixture only',publications},agent)
  return task.id
 }
 for(const task of team.tasks.filter(t=>t.planTask.logicalId.startsWith('expert_view_'))) await submit(task.planTask.logicalId,{'view.md':'# Synthetic viewpoint\nEvidence must precede confidence.'})
 await submit('viewpoints',{'viewpoints.md':'# Synthetic viewpoint\nEvidence must precede confidence.\n```viewpoint-options\n["Evidence must precede confidence"]\n```'})
 let live=await read(),choice=live.tasks.find(t=>t.planTask.logicalId==='outline_choice')
 const preview=await readHumanChoice(root,live,choice);await completeHumanChoice(root,live,choice,preview.options[0],preview.sha256)
 for(const task of team.tasks.filter(t=>t.planTask.logicalId.startsWith('research_'))) await submit(task.planTask.logicalId,{'evidence.md':'# Synthetic evidence\nNo real business claims. Source fixture https://example.com/fixture.'})
 await submit('expression',{'expression-brief.md':'# Synthetic expression\nUse one clear thesis and generous readable type.'})
 const report='# Synthetic protocol report\n\n## Evidence must precede confidence\n\nEvidence must precede confidence.\n'
 const figurePlan=JSON.stringify({schemaVersion:1,reportSha256:sha(report),chapters:[{chapter:'Evidence must precede confidence',claim:'Evidence must precede confidence',relation:'Evidence constrains confidence',encoding:'mechanism diagram',decision:'Keep conclusions bounded by evidence',sourceQuote:'Evidence must precede confidence.',sourceClaimIds:['c1']}]})
 const writerId=await submit('writer',{'report.md':report,'OUTLINE.md':'# One argument\nEvidence must precede confidence.','figure-plan.json':figurePlan,'report-source-ledger.json':JSON.stringify({schemaVersion:2,reportSha256:sha(report),sources:[{id:'s1',title:'Synthetic source fixture',url:'https://example.com/fixture',accessedAt:'2026-10-07'}],claims:[{id:'c1',kind:'inference',quote:'Evidence must precede confidence.',sourceIds:['s1']}],unresolved:[]})})
 live=await read();const writer=live.tasks.find(t=>t.id===writerId)
 assert.equal(writer.executionState,'awaiting_review');assert.notEqual(writer.status,'completed')
 const reviewer=live.members.find(m=>m.name!==writer.assignee&&/^bk-/.test(m.capabilityScope?.expertId??'')),agent=agents.get(reviewer.id)
 const prep=await call('quality_review',{task_id:writerId,prepare_only:true},agent)
 const audit=Object.fromEntries(['argument','novelty','sources','calculations','uncertainty','coverage'].map(k=>[k,'Synthetic protocol inspection: one declared inference and fixture URL; no empirical measurements or arithmetic.']))
 await call('quality_review',{task_id:writerId,event_id:'synthetic-writer-review',verdict:'pass',material_receipt:prep.material_receipt,acceptance_results:prep.acceptance.map(c=>({id:c.id,passed:true,detail:'Synthetic protocol fixture: exact declared files, matching source text and recorded inspection outputs; no business acceptance claimed.'})),review_audit:'```content-audit\n'+JSON.stringify(audit)+'\n```'},agent)
 live=await read();assert.equal(live.tasks.find(t=>t.id===writerId).status,'completed')
 const release=live.tasks.find(t=>t.planTask.logicalId==='report_release'),rp=await readHumanChoice(root,live,release)
 await completeHumanChoice(root,live,release,rp.options[0],rp.sha256)
 live=await read();const render=live.tasks.find(t=>t.planTask.logicalId==='renderer'),renderAgent=agents.get(live.members.find(m=>m.name===render.assignee).id)
 await call('claim_task',{task_id:render.id},renderAgent)
 live=await read();assert(live.tasks.find(t=>t.id===render.id).inputArtifactManifest.some(m=>m.sourceTaskId===writerId))
 const {execFileSync}=await import('node:child_process')
 const html='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>@page{size:A4;margin:18mm}*{box-sizing:border-box}body{margin:0;background:#f5f4eb;color:#20301f;font:16px sans-serif}main{max-width:900px;padding:24px;margin:auto}h1{font-size:28px}p{line-height:1.8}</style><main id="report-body"><h1>Synthetic protocol report</h1><h2>Evidence must precede confidence</h2><p>Evidence must precede confidence.</p><figure data-v5-figure="f1"><figcaption>Evidence must precede confidence</figcaption><div>Evidence → confidence</div></figure></main></html>'
 const pdf=execFileSync('python3',['-c','import sys;from weasyprint import HTML;sys.stdout.buffer.write(HTML(string=sys.stdin.read()).write_pdf())'],{input:html,maxBuffer:2000000})
 const craft={schemaVersion:5,mdSha256:sha(report),htmlSha256:sha(html),pdfSha256:sha(pdf),style:renderer.reportBundle.craft.selections[0].variant,references:{'credit-policy':'Synthetic fixture does not use policy comparison components.','designer-paper':'Synthetic fixture uses warm paper and forest text.'},figurePlanSha256:sha(figurePlan),referenceApplication:[{source:renderer.reportBundle.craft.selections[0].variant,principle:'Readable report structure',selector:'main#report-body',appliedHow:'Semantic main preserves reading order'}],figures:[{id:'f1',chapter:'Evidence must precede confidence',claim:'Evidence must precede confidence',relation:'Evidence constrains confidence',encoding:'mechanism diagram',decision:'Keep conclusions bounded by evidence',sourceQuote:'Evidence must precede confidence.'}]}
 await submit('renderer',{'report.md':report,'report.html':html,'report.pdf':pdf,'craft-evidence.json':JSON.stringify(craft)})
 live=await read();const critic=live.members.find(m=>m.capabilityScope?.expertId==='design-critic'),criticAgent=agents.get(critic.id)
 const prepared=await call('quality_review',{task_id:render.id,prepare_only:true},criticAgent)
 assert(prepared.machine_checks.every(r=>r.results.every(c=>c.status==='passed')),JSON.stringify(prepared.machine_checks))
 const {inspectPdfPages}=await import('../lib/deep-research-gates.js'),pages=await inspectPdfPages(pdf,1)
 assert.equal(prepared.visual_audit_template.htmlSha256,sha(html))
 assert.equal(prepared.visual_audit_template.pdfSha256,sha(pdf))
 assert.equal(prepared.visual_audit_template.pageCount,pages.pageCount)
 assert.deepEqual(Object.fromEntries(Object.entries(prepared.visual_audit_template.pages).map(([name,page])=>[name,{index:page.index,sha256:page.sha256}])),pages.pages)
 assert.equal(prepared.visual_audit_template.pages.first.finding,'')
 assert.equal(prepared.visual_audit_template.verdict,'')
 const visual={verdict:'PASS',checkedAt:new Date().toISOString(),method:'Synthetic transport validation only; actual DOM/A4 checker and deterministic page render, not business-report visual acceptance.',blockers:0,htmlSha256:sha(html),pdfSha256:sha(pdf),pageCount:pages.pageCount,pages:Object.fromEntries(Object.entries(pages.pages).map(([k,v])=>[k,{...v,finding:'Synthetic one-page text fixture. Page identity validated.'}])),dom:'Synthetic text content identical.',wide:'Actual Host checker at 1280, no overflow.',narrow:'Actual Host checker at 375, no overflow.',accessibility:'Synthetic fixture declares language and semantic heading/main.',references:'credit-policy consciously not used; designer-paper primary reference application checked on actual main.',figures:'Evidence must precede confidence: figure f1 checked against its source quote and relationship.'}
 await call('quality_review',{task_id:render.id,event_id:'synthetic-render-review',verdict:'pass',material_receipt:prepared.material_receipt,task_material_receipt:prepared.task_material_receipt,acceptance_results:prepared.acceptance.map(c=>({id:c.id,passed:true,detail:'Synthetic protocol fixture: exact declared files, matching source text and recorded inspection outputs; no business acceptance claimed.'})),independent_review:prepared.independent_review_areas.map(a=>({id:a.id,status:'passed',coverage:'Synthetic protocol fixture, not business acceptance.',evidence:[{artifactId:'published:report.md',quote:'Evidence must precede confidence.',reason:'Exact synthetic source line reproduced.'}]})),review_audit:'```json visual-audit\n'+JSON.stringify(visual)+'\n```'},criticAgent)
 live=await read();assert(live.tasks.every(t=>t.status==='completed'));assert(Object.values(live.qualityRuns).every(r=>r.status==='integrated'))
})
