import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTeamWaitTool } from '../lib/team-wait.js'
import { persistGoalAwareWait } from '../lib/goal-wait.js'
import { appendMailbox, createMessage, createTeamDir, readTeam, writeTeam } from '../lib/state.js'

async function fixture(t, initialGoal) {
  const workspace = await mkdtemp(join(tmpdir(), 'team-wait-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const stateRoot = join(workspace, 'expert-teams')
  const team = {
    id: 'wait-team', name: 'wait-team', captainSessionId: 'captain', createdAt: 1, taskSeq: 1,
    members: [{ id: 'worker-session', name: 'worker', status: 'working', joinedAt: 1 }],
    tasks: [{ id: 't1', subject: 'Analyze', status: 'in_progress', assignee: 'worker',
      dependencies: [], attempt: 2, attemptId: 'attempt-current', createdAt: 1, updatedAt: 1 }],
  }
  await createTeamDir(stateRoot, team)
  let tool
  let conclusions = 0
  let kicks = 0
  let hook
  let initiator
  let goal = initialGoal === undefined ? undefined : { ...initialGoal }
  const changes = []
  const warnings = []
  let flushes = 0
  const sessions = { async flush() { flushes++; return true } }
  const goals = {
    get() { return goal === undefined ? undefined : { ...goal } },
    pause(agent, ref) {
      assert.equal(initiator, agent, 'waiting must not cancel its own running turn')
      assert.deepEqual(ref, { id: goal.id, revision: goal.revision })
      assert.equal(goal.phase, 'active')
      goal = { ...goal, revision: goal.revision + 1, phase: 'paused', activation: 'disarmed' }
      changes.push('pause')
      return { ...goal }
    },
    resume(agent, ref) {
      assert.equal(initiator, agent)
      assert.deepEqual(ref, { id: goal.id, revision: goal.revision })
      goal = { ...goal, revision: goal.revision + 1, phase: 'active', activation: 'armed' }
      changes.push('resume')
      return { ...goal }
    },
  }
  const ctx = {
    tools: { register(value) { tool = value } },
    on(name, value) { assert.equal(name, 'agent/pre-step'); hook = value; return () => undefined },
    get(name) {
      if (name === 'sessions') return sessions
      assert.equal(name, 'goals'); return initialGoal === undefined ? undefined : goals
    },
    agents: { withInitiator(agent, fn) { initiator = agent; try { return fn() } finally { initiator = undefined } } },
    logger: { warn(value) { warnings.push(value) } },
  }
  registerTeamWaitTool(ctx, { stateDir: 'expert-teams' },
    { scheduler: { async kickTeam() { kicks++ } } })
  const agent = { id: 'captain', session: { header: { cwd: workspace } }, inbox: { hasPending: false } }
  const exec = { agent, signal: new AbortController().signal, concludeTurn() { conclusions++ } }
  return { tool, team, agent, exec, stateRoot, ctx, changes, warnings, goals, sessions,
    get flushes() { return flushes },
    get goal() { return goals.get() }, set goal(value) { goal = value },
    admit: (source, decision) => hook({ agent, signal: exec.signal }, async () => decision ?? {
      kind: 'enter', messages: [{ source, content: [{ type: 'text', text: 'New accepted input' }] }],
    }),
    read: () => readTeam(stateRoot, team.id),
    save: () => writeTeam(stateRoot, team), get conclusions() { return conclusions }, get kicks() { return kicks } }
}

test('wait concludes a captain turn and persists a restart-readable wait without completing work', async t => {
  const f = await fixture(t)
  const result = await f.tool.execute({ reason: 'Worker must finish its analysis', task_ids: ['t1'] }, f.exec)
  assert.equal(result.waiting, true)
  assert.equal(f.conclusions, 1)
  assert.equal(f.kicks, 1)
  const persisted = await f.read()
  assert.deepEqual(persisted.tasks, f.team.tasks)
  assert.deepEqual(persisted.runtimeWaits.captain.taskIds, ['t1'])
  assert.equal(persisted.runtimeWaits.captain.reason, 'Worker must finish its analysis')
})

const activeGoal = { id: 'goal-test', revision: 7, phase: 'active', activation: 'armed' }
const teamSource = { kind: 'plugin', plugin: 'dsh-expert-library' }

test('goal wait pauses the exact active armed goal and resumes only before admitted team input runs', async t => {
  const f = await fixture(t, activeGoal)
  await f.tool.execute({ reason: 'Await reviewed artifact' }, f.exec)
  assert.deepEqual(f.changes, ['pause'])
  assert.equal(f.goal.phase, 'paused')
  const state = await f.read()
  assert.equal(state.goalWaits.captain.goalId, activeGoal.id)
  assert.equal(state.goalWaits.captain.pausedRevision, 8)
  // Existing scheduler clears runtimeWaits on delivery admission; its cleanup
  // must not erase the independent goal ownership receipt.
  delete state.runtimeWaits.captain
  await writeTeam(f.stateRoot, state)
  const entered = await f.admit(teamSource)
  assert.equal(entered.kind, 'enter')
  assert.deepEqual(f.changes, ['pause', 'resume'])
  assert.equal(f.goal.revision, 9)
  assert.equal((await f.read()).goalWaits.captain, undefined)
  await f.tool.execute({ reason: 'Await next reviewed artifact' }, f.exec)
  assert.equal(f.goal.phase, 'paused')
  assert.equal((await f.read()).goalWaits.captain.pausedRevision, 10)
})

test('ordinary human input takes control without inferring permission to rearm a paused goal', async t => {
  const f = await fixture(t, activeGoal)
  await f.tool.execute({ reason: 'Await external input' }, f.exec)
  await f.admit({ kind: 'user' })
  assert.equal(f.goal.activation, 'disarmed')
  assert.deepEqual(f.changes, ['pause'])
  assert.equal((await f.read()).goalWaits.captain, undefined)
  await f.admit(teamSource)
  assert.deepEqual(f.changes, ['pause'], 'a later team message cannot undo human takeover')
})

test('goal rounds, bootstrap, settlement notices, unrelated plugins and rejected input cannot rearm a wait', async t => {
  const f = await fixture(t, activeGoal)
  await f.tool.execute({ reason: 'Await worker' }, f.exec)
  for (const source of [{ kind: 'goal' }, { kind: 'subagent-settled' }, { kind: 'agent-message' },
    { kind: 'plugin', plugin: 'other-plugin' }]) await f.admit(source)
  await f.admit(teamSource, { kind: 'reject' })
  await f.admit(teamSource, { kind: 'enter', messages: [] })
  assert.deepEqual(f.changes, ['pause'])
  assert.equal((await f.read()).goalWaits.captain.pausedRevision, 8)
})

test('manual goal edits, replacement, completion and clear retire tickets without rearming', async t => {
  for (const changed of [
    { ...activeGoal, phase: 'paused', activation: 'disarmed', revision: 9 },
    { ...activeGoal, phase: 'paused', activation: 'disarmed', id: 'replacement', revision: 8 },
    { ...activeGoal, phase: 'complete', activation: 'disarmed', revision: 9 },
    undefined,
  ]) {
    const f = await fixture(t, activeGoal)
    await f.tool.execute({ reason: 'Await worker' }, f.exec)
    f.goal = changed
    await f.admit(teamSource)
    assert.deepEqual(f.changes, ['pause'])
    assert.deepEqual(f.goal, changed)
    assert.equal((await f.read()).goalWaits.captain, undefined)
  }
})

test('already paused, blocked, complete or disarmed goals are never adopted by event waiting', async t => {
  for (const initial of [
    { ...activeGoal, phase: 'paused', activation: 'disarmed' },
    { ...activeGoal, phase: 'blocked', activation: 'disarmed' },
    { ...activeGoal, phase: 'complete', activation: 'disarmed' },
    { ...activeGoal, activation: 'disarmed' },
  ]) {
    const f = await fixture(t, initial)
    await f.tool.execute({ reason: 'Await worker' }, f.exec)
    await f.admit(teamSource)
    assert.deepEqual(f.changes, [])
    assert.deepEqual(f.goal, initial)
    assert.equal((await f.read()).goalWaits, undefined)
  }
})

test('halt and runtime external block preserve paused goals even when input is admitted', async t => {
  for (const blocker of [{ halted: true }, { captainRuntimeBlock: {
    id: 'block1', sessionId: 'captain', code: 'QUOTA402', message: 'Quota exhausted',
    at: 1, turn: 1,
  } }]) {
    const f = await fixture(t, activeGoal)
    await f.tool.execute({ reason: 'Await worker' }, f.exec)
    const state = await f.read()
    Object.assign(state, blocker)
    await writeTeam(f.stateRoot, state)
    await f.admit(teamSource)
    assert.deepEqual(f.changes, ['pause'])
    assert.equal((await f.read()).goalWaits.captain.pausedRevision, 8)
    await f.admit({ kind: 'user' })
    assert.equal((await f.read()).goalWaits.captain, undefined)
    assert.equal(f.goal.phase, 'paused')
  }
})

test('ordinary persistence failure rolls back only its exact goal pause', async t => {
  const f = await fixture(t, activeGoal)
  await assert.rejects(persistGoalAwareWait(f.ctx, f.agent, f.team, async () => {
    throw new Error('disk unavailable')
  }), /disk unavailable/)
  assert.deepEqual(f.changes, ['pause', 'resume'])
  assert.equal(f.goal.phase, 'active')
  assert.equal((await f.read()).goalWaits, undefined)
  assert.equal(f.flushes, 2, 'pause is flushed before persisting; rollback resume is also flushed')
  const g = await fixture(t, activeGoal)
  await assert.rejects(persistGoalAwareWait(g.ctx, g.agent, g.team, async () => {
    g.goal = { ...g.goal, revision: 9 }
    throw new Error('disk unavailable')
  }), /disk unavailable/)
  assert.deepEqual(g.changes, ['pause'])
  assert.equal(g.goal.phase, 'paused')
  assert.equal(g.goal.revision, 9)
})

test('goal journal flush failure never persists a resumable ticket and compensates its exact pause', async t => {
  const f = await fixture(t, activeGoal)
  let attempts = 0
  f.sessions.flush = async () => { if (++attempts === 1) throw new Error('goal journal unavailable'); return true }
  let persisted = false
  await assert.rejects(persistGoalAwareWait(f.ctx, f.agent, f.team, async () => { persisted = true }), /goal journal unavailable/)
  assert.equal(persisted, false)
  assert.deepEqual(f.changes, ['pause', 'resume'])
  assert.equal(attempts, 2)
  assert.equal(f.goal.phase, 'active')
})

test('a Host with no durability listener fails before persisting a goal wait receipt', async t => {
  const f = await fixture(t, activeGoal)
  let attempts = 0
  f.sessions.flush = async () => ++attempts !== 1
  let persisted = false
  await assert.rejects(persistGoalAwareWait(f.ctx, f.agent, f.team, async () => { persisted = true }), /durability listener/)
  assert.equal(persisted, false)
  assert.equal(attempts, 2)
  assert.deepEqual(f.changes, ['pause', 'resume'])
  assert.equal(f.goal.phase, 'active')

  const g = await fixture(t, activeGoal)
  g.sessions.flush = async () => false
  await assert.rejects(persistGoalAwareWait(g.ctx, g.agent, g.team, async () => assert.fail('must not persist')), error => {
    assert.equal(error instanceof AggregateError, true)
    assert.match(error.message, /inspect the current goal/)
    assert.doesNotMatch(error.message, /remains paused/)
    return true
  })
  assert.equal(g.goal.phase, 'active', 'failed rollback flush does not imply the in-memory goal is paused')
})

test('failed resume flush reparks the unchanged goal with a durable replacement ticket', async t => {
  const f = await fixture(t, activeGoal)
  await f.tool.execute({ reason: 'Await worker' }, f.exec)
  let attempts = 0
  f.sessions.flush = async () => { if (++attempts === 1) throw new Error('resume journal unavailable'); return true }
  const decision = await f.admit(teamSource)
  assert.equal(decision.kind, 'enter', 'the real input is not lost on a goal checkpoint failure')
  assert.deepEqual(f.changes, ['pause', 'resume', 'pause'])
  assert.equal(f.goal.phase, 'paused')
  assert.equal(f.goal.activation, 'disarmed')
  assert.equal((await f.read()).goalWaits.captain.pausedRevision, 10)
  assert.equal(f.warnings.length, 1)
  assert.match(f.warnings[0], /resume journal unavailable/)
})

test('a persisted pause resumes from a fresh plugin hook after restart without polling', async t => {
  const f = await fixture(t, activeGoal)
  await f.tool.execute({ reason: 'Await worker' }, f.exec)
  let freshHook
  registerTeamWaitTool({ ...f.ctx, on(name, hook) { freshHook = hook; return () => undefined } },
    { stateDir: 'expert-teams' }, { scheduler: { async kickTeam() {} } })
  assert.deepEqual(f.changes, ['pause'])
  await freshHook({ agent: f.agent, signal: f.exec.signal }, async () => ({
    kind: 'enter', messages: [{ source: teamSource, content: [] }],
  }))
  assert.deepEqual(f.changes, ['pause', 'resume'])
  assert.equal((await f.read()).goalWaits.captain, undefined)
})

test('a durable unread result prevents parking before it is processed', async t => {
  const f = await fixture(t)
  await appendMailbox(f.stateRoot, f.team.id, 'captain', createMessage('worker', 'captain', 'New reviewed artifact'))
  const result = await f.tool.execute({ reason: 'Wait for worker' }, f.exec)
  assert.equal(result.waiting, false)
  assert.equal(f.conclusions, 0)
  assert.equal((await f.read()).runtimeWaits, undefined)
})

test('already queued Host input is not hidden by a persisted wait', async t => {
  const f = await fixture(t)
  f.agent.inbox.hasPending = true
  assert.equal((await f.tool.execute({ reason: 'Await reviewer' }, f.exec)).waiting, false)
  assert.equal(f.conclusions, 0)
  assert.equal((await f.read()).runtimeWaits, undefined)
})

test('a worker must save an actual review/blocker state before concluding unfinished work', async t => {
  const f = await fixture(t)
  f.agent.id = 'worker-session'
  await assert.rejects(f.tool.execute({ reason: 'Await reviewer' }, f.exec), /still active under your ownership/)
  assert.equal(f.conclusions, 0)
  f.team.tasks[0].executionState = 'awaiting_review'
  f.team.tasks[0].waitReason = 'Independent review requested'
  await f.save()
  assert.equal((await f.tool.execute({ reason: 'Await reviewer' }, f.exec)).waiting, true)
  const state = await f.read()
  assert.equal(state.tasks[0].attemptId, 'attempt-current')
  assert.equal(state.tasks[0].executionState, 'awaiting_review')
  assert.equal(f.conclusions, 1)
})

test('unrelated and removed sessions cannot create team waits', async t => {
  const f = await fixture(t)
  f.agent.id = 'unrelated'
  await assert.rejects(f.tool.execute({ reason: 'Await work' }, f.exec), /No team found/)
  f.agent.id = 'worker-session'
  f.team.members[0].status = 'removed'
  await f.save()
  await assert.rejects(f.tool.execute({ reason: 'Await work' }, f.exec), /No team found/)
  assert.equal(f.conclusions, 0)
})

test('a captain cannot park while its own pending task is ready', async t => {
  const f = await fixture(t)
  f.team.tasks[0].status = 'pending'
  f.team.tasks[0].assignee = 'captain'
  await f.save()
  await assert.rejects(f.tool.execute({ reason: 'Wait for member' }, f.exec), /ready and assigned to you/)
  assert.equal(f.conclusions, 0)
  assert.equal((await f.read()).runtimeWaits, undefined)
})

test('terminal work is not parked or relabeled as successful', async t => {
  const f = await fixture(t)
  f.team.tasks[0].status = 'failed'
  await f.save()
  const result = await f.tool.execute({ reason: 'Await something' }, f.exec)
  assert.equal(result.waiting, false)
  assert.match(result.next_action, /actual acceptance outcome/)
  assert.equal((await f.read()).tasks[0].status, 'failed')
  assert.equal(f.conclusions, 0)
  await assert.rejects(f.tool.execute({ reason: 'Await failed task', task_ids: ['t1'] }, f.exec), /is terminal/)
})

test('unsupported Host terminal protocol fails before persisting a wait', async t => {
  const f = await fixture(t)
  delete f.exec.concludeTurn
  await assert.rejects(f.tool.execute({ reason: 'Await reviewer' }, f.exec), /cannot conclude/)
  assert.equal((await f.read()).runtimeWaits, undefined)
})
