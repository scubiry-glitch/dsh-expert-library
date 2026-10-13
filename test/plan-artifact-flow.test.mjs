import test from 'node:test'
import assert from 'node:assert/strict'
import { parseProfile, profileToExecutionPlan } from '../lib/profiles.js'
import { requireReportOutline, requireStagedReportOutline } from '../lib/plan-review.js'
import { validatePlanArtifactFlow } from '../lib/plan-artifact-flow.js'
const task = (id, extra={}) => ({id,subject:id,owner:'author',dependsOn:[],...extra})
const input = (fromTask,artifact,phase='work')=>({fromTask,artifact,purpose:'Required primary evidence',phase})
const profile = tasks=>({schemaVersion:1,id:'artifact-flow',version:'1',description:'Synthetic flow',protocol:[],members:[{id:'author',name:'Author'}],taskPlanning:'seed',tasks})
test('unmapped report producers identify all missing mappings and the editable outline field',()=>{
 const p={template:{id:'profile:synthetic'},tasks:[task('research',{artifactInputs:[]}),...['report','appendix'].map(id=>task(id,{artifactInputs:[],reportBundle:{md:id+'.md',html:id+'.html',pdf:id+'.pdf'}}))],reportOutline:{chapters:[{id:'main',title:'Evidence',questions:['What is known?'],evidence:['Sources'],taskIds:['research']}],attachments:[]}}
 assert.throws(()=>requireReportOutline(p),e=>e.message.includes('PLAN_OUTLINE_UNMAPPED_PRODUCER') && e.message.includes('report, appendix') && e.message.includes('expert_teams_plan_edit') && e.message.includes('report_outline.chapters[].taskIds'))
 p.reportOutline.chapters[0].taskIds.push('report')
 assert.throws(()=>requireReportOutline(p),/PLAN_OUTLINE_UNMAPPED_PRODUCER: appendix/)
 p.reportOutline.chapters[0].taskIds.push('appendix')
 requireReportOutline(p)
})
test('artifact prerequisites reveal an acceptance cycle hidden by the ordinary task DAG',()=>{
 const tasks=[task('report',{produces:['report.md'],artifactInputs:[input('ledger','ledger.json','acceptance')]}),task('ledger',{dependsOn:['report'],produces:['ledger.json'],artifactInputs:[input('report','report.md')]})]
 assert.throws(()=>parseProfile(profile(tasks)),/PLAN_ARTIFACT_CYCLE.*report -> ledger -> report/)
})
test('independent research stays independent while real inputs preserve their prerequisites',()=>{
 const p=parseProfile(profile([task('data',{produces:['raw.json'],artifactInputs:[]}),task('policy',{produces:['policy.md'],artifactInputs:[]}),task('analysis',{dependsOn:['data'],artifactInputs:[input('data','raw.json')]})]))
 const compiled=profileToExecutionPlan(p,{})
 assert.deepEqual(compiled.tasks.find(t=>t.id==='policy').dependsOn,[])
 assert.deepEqual(compiled.tasks.find(t=>t.id==='analysis').artifactInputs,[input('data','raw.json')])
 validatePlanArtifactFlow(compiled.tasks)
})
test('unjustified ordering, unknown output, missing edge and unknown source are rejected before execution',()=>{
 const base=task('data',{produces:['raw.json'],artifactInputs:[]})
 for(const [analysis,pattern] of [
  [task('analysis',{dependsOn:['data'],artifactInputs:[]}),/PLAN_DEPENDENCY_UNJUSTIFIED/],
  [task('analysis',{dependsOn:['data'],artifactInputs:[input('data','missing.json')]}),/PLAN_ARTIFACT_OUTPUT_UNDECLARED/],
  [task('analysis',{artifactInputs:[input('data','raw.json')]}),/PLAN_ARTIFACT_DEPENDENCY_MISSING/],
  [task('analysis',{artifactInputs:[input('unknown','raw.json')]}),/PLAN_ARTIFACT_SOURCE_UNKNOWN/],
 ]) assert.throws(()=>parseProfile(profile([base,analysis])),pattern)
})
test('legacy DAGs retain their meaning; malformed declarations do not silently become legacy',()=>{
 assert.equal(parseProfile(profile([task('data'),task('analysis',{dependsOn:['data']})])).tasks.length,2)
 assert.throws(()=>parseProfile(profile([task('data',{artifactInputs:[{fromTask:'data',artifact:'raw.json',purpose:' '} ]})])),/PLAN_ARTIFACT_INPUTS_INVALID/)
})

test('new formal profile reports cannot omit artifact declarations at confirmation',()=>{
 const p={template:{id:'profile:synthetic'},tasks:[task('report',{reportBundle:{md:'r.md',html:'r.html',pdf:'r.pdf'}})],reportOutline:{chapters:[{id:'main',title:'Evidence',questions:['What is known?'],evidence:['Sources'],taskIds:['report']}],attachments:[]}}
 assert.throws(()=>requireReportOutline(p),/PLAN_ARTIFACT_INPUTS_REQUIRED/)
 p.tasks[0].artifactInputs=[]
 requireReportOutline(p)
})

test('staging rejects a report that promises eight chapters without eight structured chapters',()=>{
 const report=task('report',{subject:'按八章大纲完成报告',reportBundle:{md:'r.md',html:'r.html',pdf:'r.pdf'}})
 const p={template:{id:'profile:synthetic',version:'1'},tasks:[report]}
 assert.throws(()=>requireStagedReportOutline(p),/PLAN_OUTLINE_REQUIRED.*Do not leave chapter creation to the user/)
 const chapter=index=>({id:`chapter-${index}`,title:`Chapter ${index}`,questions:['What is supported?'],evidence:['Source records'],taskIds:['report']})
 const outline={chapters:[chapter(1)],attachments:[]}
 assert.throws(()=>requireStagedReportOutline({...p,reportOutline:outline}),/PLAN_OUTLINE_INVALID: report task promises 8 chapters but report_outline contains 1/)
 assert.doesNotThrow(()=>requireStagedReportOutline({...p,reportOutline:{...outline,chapters:Array.from({length:8},(_,index)=>chapter(index+1))}}))
})
