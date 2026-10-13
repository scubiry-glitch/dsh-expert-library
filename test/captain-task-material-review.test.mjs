import test from 'node:test'
import assert from 'node:assert/strict'
import { qualityPublicationFixture } from './support/quality-publication-fixture.mjs'
import { resolveTaskMaterialContract, prepareTaskMaterialDelivery, saveTaskMaterialDelivery } from '../lib/task-material-binding.js'

async function setup(t, receiptSession='captain-id', receiptAttempt=2) {
  const f=await qualityPublicationFixture(t,{verify:['true']})
  const team=await f.read(), task=team.tasks[0]
  task.assignee='captain'; task.attempt=2; task.attemptId='captain-attempt-2'; task.executionState='awaiting_review'
  team.qualityRuns.t1.attempt=2; team.qualityRuns.t1.contract.attempt=2; team.qualityRuns.t1.contract.assignee='captain'
  team.qualityRun=team.qualityRuns.t1
  task.skillBindings=[{packId:'dsh-expert-library',skillId:'98wiki-five-articles-gated-research',materialRole:'producer',required:true,reason:'Real frozen materials'}]
  task.promptBinding={packId:'dsh-expert-library',templateId:'98wiki-finalqa-v1',required:true,variables:[]}
  task.frozenTaskMaterialContract=resolveTaskMaterialContract(task.skillBindings,task.promptBinding)
  if(receiptSession) saveTaskMaterialDelivery(task,prepareTaskMaterialDelivery(task,receiptSession,receiptAttempt,'producer',true).receipt)
  await f.write(team)
  return f
}
test('independent review preparation accepts the real captain producer receipt without creating another producer receipt',async t=>{
  const f=await setup(t),before=await f.read()
  const result=await f.call('quality_review',{task_id:'t1',prepare_only:true},'reviewer')
  assert.equal(result.status,'prepared_for_independent_review');assert.ok(result.material_receipt)
  const after=await f.read(), receipts=after.tasks[0].taskMaterialDeliveries
  assert.deepEqual(receipts.filter(r=>r.role==='producer'),before.tasks[0].taskMaterialDeliveries)
  assert.equal(receipts.find(r=>r.role==='reviewer').sessionId,'reviewer-id')
  assert.equal(after.qualityRuns.t1.status,before.qualityRuns.t1.status)
  assert.equal(after.tasks[0].attemptId,'captain-attempt-2')
})
for (const [label,session,attempt] of [['missing',null,2],['wrong-session','worker-id',2],['old-attempt','captain-id',1]]) {
  test(`captain review still rejects ${label} producer receipt without changing state`,async t=>{
    const f=await setup(t,session,attempt),before=await f.read()
    await assert.rejects(f.call('quality_review',{task_id:'t1',prepare_only:true},'reviewer'),/TASK_BINDING_DELIVERY_REQUIRED/)
    assert.deepEqual(await f.read(),before)
  })
}
test('captain producer cannot review their own task even with a valid producer receipt',async t=>{
  const f=await setup(t),before=await f.read()
  await assert.rejects(f.call('quality_review',{task_id:'t1',prepare_only:true},'captain'),/independent|author|review|captain/i)
  assert.deepEqual(await f.read(),before)
})
