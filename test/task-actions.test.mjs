import test from 'node:test'
import assert from 'node:assert/strict'
import { currentTaskAction } from '../lib/task-actions.js'
const task={id:'t1',status:'in_progress',assignee:'writer',attempt:1,attemptId:'current',dependencies:[],publishedArtifacts:[]}
const team={tasks:[task],qualityRuns:{t1:{status:'pending',contract:{deliverables:['published:a.md','published:b.pdf'],acceptance:[{id:'quality',statement:'Verify evidence'}]}}}}
test('owner sees every missing publication and the exact current attempt; other roles cannot submit',()=>{
 const action=currentTaskAction(team,task,'writer')
 assert.equal(action.kind,'publish');assert.deepEqual(action.missing_publications,['published:a.md','published:b.pdf']);assert.deepEqual(action.arguments,{task_id:'t1',attempt_id:'current'})
 assert.equal(currentTaskAction(team,task,'captain').kind,'wait')
})
test('review actions resolve identity at runtime and keep captain integration separate from review',()=>{
 const submitted={...task,executionState:'awaiting_review',reportBundle:{craft:{version:3}}}
 assert.deepEqual(currentTaskAction(team,submitted,'reviewer').arguments,{task_id:'t1',prepare_only:true})
 assert.equal(currentTaskAction(team,submitted,'writer').kind,'wait');assert.equal(currentTaskAction(team,submitted,'captain').kind,'wait')
 const passed={...team,qualityRuns:{t1:{...team.qualityRuns.t1,status:'passed'}}}
 assert.equal(currentTaskAction(passed,submitted,'captain').kind,'integrate')
 assert.equal(currentTaskAction(passed,submitted,'reviewer').kind,'wait')
})
test('pending, blocked and terminal tasks cannot be mislabeled ready to submit',()=>{
 for(const value of [{...task,runtimeBlock:{}},{...task,executionState:'blocked_external'},{...task,dependencies:['missing']}]) assert.equal(currentTaskAction(team,value,'writer').kind,'wait')
 assert.equal(currentTaskAction(team,{...task,status:'completed'},'writer').kind,'terminal')
 const pending=currentTaskAction(team,{...task,status:'pending',attemptId:undefined},'writer')
 assert.equal(pending.kind,'claim');assert.deepEqual(JSON.parse(JSON.stringify(pending)),pending)
})
test('ordinary tasks without structured quality receive a completion action, not a nonexistent review',()=>{
 const action=currentTaskAction({tasks:[task]},task,'writer')
 assert.equal(action.kind,'complete')
 assert.deepEqual(action.arguments,{task_id:'t1',attempt_id:'current',status:'completed'})
})

for (const templateVersion of ['2.0.0','3.1.0','4.0.0']) test(`renderer ${templateVersion} guidance routes to the bound critic before gate rejection`,()=>{
 const submitted={...task,planTask:{logicalId:'renderer'},executionState:'awaiting_review',reportBundle:{craft:{version:3}}}
 const research={...team,planRef:{scenarioId:'98wiki-deep-research',templateVersion},members:[
  {id:'researcher',name:'researcher',status:'idle',capabilityScope:{expertId:'bk-010'}},
  {id:'critic',name:'critic',status:'idle',capabilityScope:{expertId:'design-critic'}}]}
 assert.equal(currentTaskAction(research,submitted,'critic').kind,'prepare_review')
 for (const viewer of ['researcher','captain','writer']) {
  const action=currentTaskAction(research,submitted,viewer)
  assert.equal(action.kind,'wait');assert.equal(action.reviewer,'critic');assert.match(action.reason,/critic/)
 }
 research.members[1].status='removed'
 const unavailable=currentTaskAction(research,submitted,'researcher')
 assert.equal(unavailable.kind,'wait');assert.equal(unavailable.reviewer,null)
})
