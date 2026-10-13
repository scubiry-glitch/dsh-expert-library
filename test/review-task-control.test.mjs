import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTeamDir, readTeam, writeTeam } from '../lib/state.js'
import { changeReviewTaskExecution, REVIEW_USER_PAUSED } from '../lib/host/review-task-control.js'

test('scoped review pauses and restarts the same task attempt without changing its owner', async t => {
  const root = await mkdtemp(join(tmpdir(), 'review-task-control-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const now = Date.now()
  const task = { id: 't1', subject: 'writer', status: 'in_progress', executionState: 'active',
    assignee: 'writer', attempt: 2, attemptId: 'attempt-12345678', dependencies: [], createdAt: now, updatedAt: now }
  const team = { id: 'team', name: 'team', captainSessionId: 'captain', createdAt: now,
    members: [{ id: 'member-session', name: 'writer', joinedAt: now, status: 'idle' }], tasks: [task], taskSeq: 1 }
  await createTeamDir(root, team); await writeTeam(root, team)
  const target = { stateRoot: root, teamId: 'team', captainSessionId: 'captain', archived: false }
  assert.deepEqual(await changeReviewTaskExecution(target, 'task-pause', 't1', task.attemptId),
    { teamId: 'team', memberSessionId: 'member-session' })
  const paused = (await readTeam(root, 'team')).tasks[0]
  assert.equal(paused.executionState, 'blocked_external')
  assert.equal(paused.waitReason, REVIEW_USER_PAUSED)
  assert.equal(paused.attemptId, task.attemptId)
  await assert.rejects(changeReviewTaskExecution(target, 'task-pause', 't1', task.attemptId), /REVIEW_TASK_NOT_RUNNING/)
  await assert.rejects(changeReviewTaskExecution({ ...target, captainSessionId: 'other' }, 'task-start', 't1', task.attemptId), /REVIEW_TASK_NOT_AVAILABLE/)
  await assert.rejects(changeReviewTaskExecution(target, 'task-start', 't1', 'stale-attempt'), /REVIEW_TASK_STALE/)
  const interrupted = await readTeam(root, 'team')
  const block = { id: 'runtime:member-session:4', sessionId: 'member-session', turn: 4,
    code: 'INTERRUPTED', message: 'Paused turn ended', at: now }
  interrupted.members[0].runtimeBlock = block
  interrupted.tasks[0].runtimeBlock = { ...block, attemptId: task.attemptId }
  await writeTeam(root, interrupted)
  await changeReviewTaskExecution(target, 'task-start', 't1', task.attemptId)
  const resumed = await readTeam(root, 'team')
  const restarted = resumed.tasks[0]
  assert.equal(restarted.executionState, 'active')
  assert.equal(restarted.waitReason, undefined)
  assert.equal(restarted.runtimeBlock, undefined)
  assert.equal(resumed.members[0].runtimeBlock, undefined)
  assert.equal(restarted.attemptId, task.attemptId)
  assert.equal(restarted.assignee, 'writer')
})

test('review can start a claimed task but cannot release an unrelated external blocker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'review-claimed-control-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const now = Date.now()
  const task = { id: 't1', subject: 'writer', status: 'claimed', executionState: 'active',
    assignee: 'writer', attempt: 1, attemptId: 'attempt-12345678', dependencies: [], createdAt: now, updatedAt: now }
  const team = { id: 'team', name: 'team', captainSessionId: 'captain', createdAt: now,
    members: [{ id: 'member-session', name: 'writer', joinedAt: now, status: 'idle' }], tasks: [task], taskSeq: 1 }
  await createTeamDir(root, team); await writeTeam(root, team)
  const target = { stateRoot: root, teamId: 'team', captainSessionId: 'captain', archived: false }
  await changeReviewTaskExecution(target, 'task-start', 't1', task.attemptId)
  task.executionState = 'blocked_external'; task.waitReason = 'Waiting for source data'
  await writeTeam(root, team)
  await assert.rejects(changeReviewTaskExecution(target, 'task-start', 't1', task.attemptId), /REVIEW_TASK_NOT_STARTABLE/)
})

test('review recovers an exact restart-blocked attempt and preserves its draft', async t => {
  const root = await mkdtemp(join(tmpdir(), 'review-restart-control-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const now = Date.now(), attemptId = 'attempt-12345678'
  const block = { id: 'runtime:member-session:2:recovery:abc', sessionId: 'member-session', turn: 2,
    code: 'HOST_RESTART_UNCONFIRMED', message: 'Unconfirmed delivery after restart', at: now }
  const waitReason = 'RUNTIME_HOST_RESTART_UNCONFIRMED: Unconfirmed delivery after restart'
  const task = { id: 't8', subject: 'render', status: 'in_progress', executionState: 'blocked_external',
    waitReason, runtimeBlock: { ...block, attemptId }, assignee: 'renderer', attempt: 1, attemptId,
    output: 'draft retained', dependencies: [], createdAt: now, updatedAt: now }
  const team = { id: 'team', name: 'team', captainSessionId: 'captain', createdAt: now,
    members: [{ id: 'member-session', name: 'renderer', joinedAt: now, status: 'idle', runtimeBlock: block }],
    tasks: [task], taskSeq: 1 }
  await createTeamDir(root, team); await writeTeam(root, team)
  const target = { stateRoot: root, teamId: 'team', captainSessionId: 'captain', archived: false }
  await assert.rejects(changeReviewTaskExecution(target, 'task-recover', 't8', attemptId, 'stale reason'), /REVIEW_TASK_RECOVERY_STALE/)
  assert.equal((await readTeam(root, 'team')).tasks[0].waitReason, waitReason)
  await changeReviewTaskExecution(target, 'task-recover', 't8', attemptId, waitReason)
  const resumed = await readTeam(root, 'team')
  assert.equal(resumed.tasks[0].executionState, 'active')
  assert.equal(resumed.tasks[0].runtimeBlock, undefined)
  assert.equal(resumed.members[0].runtimeBlock, undefined)
  assert.equal(resumed.tasks[0].attemptId, attemptId)
  assert.equal(resumed.tasks[0].output, 'draft retained')
})
