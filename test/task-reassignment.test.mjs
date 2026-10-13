import test from 'node:test'
import assert from 'node:assert/strict'
import { checkTaskReassignment } from '../lib/task-reassignment.js'

const now=1_000_000
const base=()=>({id:'t1',subject:'work',status:'in_progress',assignee:'worker',attempt:1,attemptId:'a1',attemptStartedAt:100,
  createdAt:100,updatedAt:now,dependencies:[]})
const observation=()=>({expectedAttempt:1,expectedAttemptId:'a1',activity:'idle',member:{name:'worker',id:'worker-id'},now})

test('publication seven seconds ago prevents takeover without mutating task',()=>{
  const t=base();t.publishedArtifacts=[{id:'fresh',attempt:1,createdAt:now-7199}];const before=structuredClone(t)
  assert.throws(()=>checkTaskReassignment(t,observation()),/REASSIGNMENT_RECENT_PROGRESS/)
  assert.deepEqual(t,before)
})
for(const activity of ['running','unknown']) test('active or unconfirmed owner cannot lose its attempt: '+activity,()=>{
  assert.throws(()=>checkTaskReassignment(base(),{...observation(),activity}),/REASSIGNMENT_OWNER_ACTIVE/)
})
test('pending independent review and passed evidence use existing review/integration flow',()=>{
  assert.throws(()=>checkTaskReassignment({...base(),executionState:'awaiting_review'},observation()),/AWAITING_REVIEW/)
  for(const status of ['reviewing','passed']) assert.throws(()=>checkTaskReassignment(base(),{...observation(),quality:{status}}),/AWAITING_REVIEW/)
})
test('escalated quality requires captain closeout before reassignment',()=>{
  assert.throws(()=>checkTaskReassignment(base(),{...observation(),quality:{status:'escalated'}}),/QUALITY_ESCALATED_CLOSEOUT_REQUIRED/)
})
test('external block is not bypassed by replacing the worker',()=>{
  assert.throws(()=>checkTaskReassignment({...base(),executionState:'blocked_external'},observation()),/EXTERNAL_BLOCK/)
})
test('stale attempt and stale capability cannot revoke current work',()=>{
  for(const override of [{expectedAttempt:0},{expectedAttemptId:'old'},{expectedAttemptId:undefined}])
    assert.throws(()=>checkTaskReassignment(base(),{...observation(),...override}),/REASSIGNMENT_STALE/)
})
test('status-only timestamp does not prolong idle task; old attempt publications do not count',()=>{
  const t=base();t.publishedArtifacts=[{id:'old',attempt:0,createdAt:now}]
  const result=checkTaskReassignment(t,observation());assert.equal(result.lastProgressAt,100);assert.deepEqual(result.publicationIds,[])
})
test('accepted current dispatch and fresh activation get an idle grace',()=>{
  assert.throws(()=>checkTaskReassignment({...base(),dispatch:{attemptId:'a1',acceptedAt:now-5000}},observation()),/RECENT_PROGRESS/)
  assert.throws(()=>checkTaskReassignment({...base(),attemptStartedAt:now-5000},observation()),/RECENT_PROGRESS/)
})
test('confirmed idle stale work admits a bounded auditable transfer; failed retry has no idle grace',()=>{
  const result=checkTaskReassignment(base(),observation());assert.equal(result.previousAttemptId,'a1');assert.equal(result.observedAt,now)
  const failed={...base(),status:'failed',attemptId:undefined,attemptStartedAt:now}
  assert.equal(checkTaskReassignment(failed,{...observation(),expectedAttemptId:undefined}).previousAttempt,1)
})
