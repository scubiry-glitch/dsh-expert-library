import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {normalizeReviewUi,mergeReviewUi,safePortrait} from '../lib/review-ui.js'
import {portraitFallback,reviewPresentation} from '../lib/host/review-presentation.js'
import {readReviewContext} from '../lib/host/review-context.js'
import {listReviewDocuments} from '../lib/host/review-documents.js'
import {createTeamDir,createTaskProject,publishTaskArtifact,writeTeam} from '../lib/state.js'
import {compileExecutionPlan} from '../lib/v2/compiler.js'
import {validateDomainPack} from '../lib/v2/validate.js'
const sample=async name=>JSON.parse(await readFile(new URL(`../examples/pack-center/${name}/pack.json`,import.meta.url),'utf8'))
const compile=pack=>compileExecutionPlan({pack,templateId:'demo.review.team',scenarioId:'demo.review.scenario',params:{}})
test('legacy samples need no presentation; new samples compile and invalid declarations warn',async()=>{
 for(const name of ['demo-v1','demo-v2','demo-review-ui','demo-review-ui-fallback']){
  const pack=await sample(name),validation=validateDomainPack(pack),result=compile(pack)
  assert.equal(validation.ok,true,JSON.stringify(validation.diagnostics));assert.equal(result.ok,true,JSON.stringify(result.diagnostics))
  if(name==='demo-v1'||name==='demo-v2')assert.equal(result.plan.reviewUi,undefined)
  if(name==='demo-review-ui')assert.equal(result.plan.reviewUi.experts['demo.review.expert'].portrait,'asset:finance')
  if(name.endsWith('fallback'))assert(validation.diagnostics.some(d=>d.code==='review-ui-fallback'&&d.severity==='warning'))
 }
})
test('scenario overrides template and pack; compiled snapshot stays immutable and affects digest',async()=>{
 const pack=await sample('demo-review-ui'),base=compile(pack)
 pack.teamTemplates[0].reviewUi={version:1,labels:{results:'模板成果'},experts:{'demo.review.expert':{role:'模板职责'}}}
 pack.scenarios[0].reviewUi={version:1,labels:{results:'场景成果'}}
 const result=compile(pack);assert.equal(result.ok,true);assert.equal(result.plan.reviewUi.labels.results,'场景成果')
 assert.equal(result.plan.reviewUi.experts['demo.review.expert'].portrait,'asset:finance','field-level inheritance keeps artwork')
 assert.notEqual(result.plan.digest,base.plan.digest)
 pack.scenarios[0].reviewUi.labels.results='changed';assert.equal(result.plan.reviewUi.labels.results,'场景成果')
})
test('unsupported/unsafe presentation uses a stable shared portrait without fetching URLs',()=>{
 assert.equal(normalizeReviewUi({version:9}).value,undefined)
 for(const unsafe of ['https://example.com/me.png','file:///etc/passwd','data:image/svg+xml;base64,abc','asset:unknown'])assert.equal(safePortrait(unsafe),false)
 const {value,issues}=normalizeReviewUi({version:1,experts:{x:{portrait:'https://example.test/me.png'}}});assert.equal(value.experts.x.portrait,undefined);assert.equal(issues.length,1)
 assert.equal(portraitFallback('x','金融分析'),'finance');assert.equal(portraitFallback('x','评审'),'reviewer');assert.equal(portraitFallback('anonymous',''),portraitFallback('anonymous',''))
 assert.equal(mergeReviewUi(undefined,undefined),undefined)
})
test('generic stages adapt to actual human choices and preserve expert identity aliases',()=>{
 const member={id:'m1',expertId:'bank-1',name:'金融专家',role:'金融分析'},task={id:'t1',status:'completed'}
 const context={team:{tasks:[task]},deliverables:[],research:false,issues:[],ui:{version:1,experts:{'bank-1':{portrait:'asset:finance'}}}}
 const result=reviewPresentation(context,{team:{members:[member]}},[])
 assert.equal(result.labels.outline,'待确认');assert.equal(result.stages.outline,'na');assert.equal(result.stages.activity,'done');assert.equal(result.stages.results,'pending')
 assert.equal(result.experts.m1,result.experts['bank-1']);assert.equal(result.experts.m1,result.experts['金融专家'])
 task.humanChoice={artifact:'decision.md'};task.status='pending';assert.equal(reviewPresentation(context,{team:{members:[member]}},[]).stages.outline,'pending')
})
test('research V5 treats a completed outline choice as a completed outline stage',()=>{
 const task={id:'t6',status:'completed',planTask:{logicalId:'outline_choice'},humanChoice:{artifact:'viewpoints.md'}}
 const context={team:{planRef:{planId:'v5'},tasks:[task]},research:true,issues:[]}
 const wire={team:{members:[]}}
 assert.equal(reviewPresentation(context,wire,[]).stages.outline,'done')
 task.status='pending'
 assert.equal(reviewPresentation(context,wire,[]).stages.outline,'pending')
})
test('approved report outline is complete while report tasks are still running',()=>{
 const plan={approval:{approvedAt:Date.now()},plan:{reportOutline:{chapters:[{id:'ch1',title:'研究结论'}]},tasks:[{id:'report'}]}}
 const team={planRef:{planId:'plan-1'},tasks:[{id:'report',status:'in_progress',planTask:{logicalId:'report'}}]}
 const context={team,plan,deliverables:[],research:true,issues:[]}
 const result=reviewPresentation(context,{team:{members:[]}},[])
 assert.equal(result.labels.outline,'研究大纲')
 assert.equal(result.stages.outline,'done')
 assert.equal(result.stages.activity,'pending')
 team.tasks.push({id:'outline',status:'pending',planTask:{logicalId:'outline_final'}})
 assert.equal(reviewPresentation(context,{team:{members:[]}},[]).stages.outline,'pending')
})
test('legacy report filename does not imply final; frozen declarations respect current attempts and confirmation',async t=>{
 const root=await mkdtemp(join(tmpdir(),'generic-review-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const now=Date.now(),task={id:'t1',subject:'行业点评',status:'completed',assignee:'captain',attempt:1,dependencies:[],createdAt:now,updatedAt:now,planTask:{logicalId:'analyze',fanOutIndex:0}}
 const team={id:'team',name:'team',captainSessionId:'captain',createdAt:now,members:[],tasks:[task],taskSeq:1}
 await createTeamDir(root,team);task.project=await createTaskProject(root,team.id,task)
 const old=await publishTaskArtifact(root,team,task,{name:'summary.md',content:'# old',mediaType:'text/markdown'});task.attempt=2
 const latest=await publishTaskArtifact(root,team,task,{name:'summary.md',content:'# current',mediaType:'text/markdown'});task.publishedArtifacts=[old,latest];await writeTeam(root,team)
 const target={stateRoot:root,teamId:team.id,captainSessionId:'captain',archived:false}
 let docs=await listReviewDocuments(target);assert.equal(docs.filter(d=>d.formal).length,0);assert.equal(docs.find(d=>d.id===old.id).fallback,undefined);assert.equal(docs.find(d=>d.id===latest.id).fallback,true)
 team.reviewSnapshot={deliverables:[{id:'summary',fromTasks:['analyze']}],gates:[],ui:{version:1,artifacts:[{key:'summary',label:'正式点评',kind:'final',fromTasks:['analyze'],names:['summary.md'],confirmTasks:['approve']}]}}
 await writeTeam(root,team);assert.equal((await readReviewContext(target)).ui.artifacts[0].label,'正式点评');assert.equal((await listReviewDocuments(target)).filter(d=>d.formal).length,0)
 team.tasks.push({id:'t2',subject:'确认',status:'completed',assignee:'captain',attempt:1,dependencies:['t1'],createdAt:now,updatedAt:now,planTask:{logicalId:'approve',fanOutIndex:0}});await writeTeam(root,team)
 docs=await listReviewDocuments(target);assert.deepEqual(docs.filter(d=>d.formal).map(d=>d.id),[latest.id]);assert.equal(docs.find(d=>d.id===latest.id).resultLabel,'正式点评')
 team.halted=true;await writeTeam(root,team);assert.equal((await listReviewDocuments(target)).filter(d=>d.formal).length,0)
 await assert.rejects(readReviewContext({...target,captainSessionId:'foreign'}))
})
test('frozen profile roster maps library, slot and runtime identities to the same portrait',()=>{
 const context={team:{tasks:[],reviewSnapshot:{roster:[{sourceExpertId:'library-expert',expertId:'profile-expert',slotId:'analyst',role:'金融'}]}},deliverables:[],research:false,issues:[],ui:{version:1,experts:{'library-expert':{portrait:'asset:finance'}}}}
 const result=reviewPresentation(context,{team:{members:[{id:'member',expertId:'profile-expert',name:'金融专家',role:'金融'}]}},[])
 for(const key of ['library-expert','profile-expert','analyst','member','金融专家'])assert.equal(result.experts[key].portrait,'asset:finance')
 assert.equal(result.experts.member.key,'library-expert')
})
