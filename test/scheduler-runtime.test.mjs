import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installTeamScheduler } from '../lib/scheduler.js'
import { captureRuntimeTurn, recordRuntimeFailure } from '../lib/runtime-failure.js'
import { appendMailbox, createMessage, createTeamDir, readMailbox, readTeam, resumeRuntimeMember, writeTeam } from '../lib/state.js'

const makeTask = (id, assignee) => ({ id, subject: id, status: 'pending', assignee, dependencies: [], createdAt: 1, updatedAt: 1 })
async function fixture(t, cap = 2) {
  const workspace = await mkdtemp(join(tmpdir(), 'scheduler-runtime-'))
  const root = join(workspace, '.expert-teams')
  const agents = new Map(['captain', 'one', 'two', 'three', 'reviewer'].map(id => [id, {
    id, status: 'idle', inbox: { hasPending: false, nextTurn: [], nextStep: [] },
    session: { header: { id, cwd: workspace }, events: [] },
    steer(message) { this.inbox.nextStep.push(message) },
  }]))
  const callbacks = new Map(), disposers = [], calls = []
  const ctx = { agents: { get: id => agents.get(id) }, logger: { warn() {} },
    on(name, fn) { callbacks.set(name, fn) }, effect(setup) { disposers.push(setup()) },
    subagents: { async followup(_captain, id, content) { calls.push({ id, content }); agents.get(id).inbox.hasPending = true } },
  }
  await createTeamDir(root, { id: 'team', name: 'team', captainSessionId: 'captain', createdAt: 1,
    members: ['one', 'two', 'three', 'reviewer'].map(id => ({ id, name: id, joinedAt: 1, status: 'idle' })),
    tasks: [makeTask('t1', 'one'), makeTask('t2', 'two'), makeTask('t3', 'three')], taskSeq: 3 })
  const scheduler = installTeamScheduler(ctx, { stateDir: '.expert-teams', maxActiveMembers: cap })
  t.after(async () => { for (const dispose of disposers) dispose(); await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) })
  return { workspace, root, agents, callbacks, calls, ctx, scheduler,
    read: () => readTeam(root, 'team'),
    async edit(fn) { const team = await readTeam(root, 'team'); fn(team); await writeTeam(root, team) },
    event(id, type, data) {
      const agent = agents.get(id), event = { type, data, seq: agent.session.events.length, time: Date.now() }
      agent.session.events.push(event)
      callbacks.get('session/event')({ ...agent.session, id }, event)
    },
  }
}
async function eventually(check) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail('scheduler did not settle')
}

test('concurrent task kicks and reviewer mail share two actual admission slots', async t => {
  const f = await fixture(t)
  await Promise.all(['one', 'two', 'three'].map(name => f.scheduler.kickMember(f.workspace, 'team', name)))
  assert.equal(f.calls.length, 2)
  assert.equal((await f.read()).members.filter(member => member.activation).length, 2)
  await appendMailbox(f.root, 'team', 'reviewer', createMessage('captain', 'reviewer', 'Review the submitted evidence'))
  await f.scheduler.kickMember(f.workspace, 'team', 'reviewer')
  assert.equal(f.calls.length, 2)
  assert.equal((await readMailbox(f.root, 'team', 'reviewer'))[0].readAt, undefined)
  const first = f.calls[0].id
  await f.edit(team => { team.tasks.find(task => task.assignee === first).executionState = 'awaiting_review' })
  f.agents.get(first).inbox.hasPending = false
  f.callbacks.get('agent/status')({ agent: f.agents.get(first), status: 'idle' })
  await eventually(() => f.calls.length === 3)
  assert.equal((await f.read()).members.filter(member => member.activation).length, 2)
  // Release the second work slot, so queued review is admitted next.
  const second = f.calls[1].id
  await f.edit(team => { team.tasks.find(task => task.assignee === second).executionState = 'awaiting_review' })
  f.agents.get(second).inbox.hasPending = false
  f.callbacks.get('agent/status')({ agent: f.agents.get(second), status: 'idle' })
  await eventually(() => f.calls.some(call => call.id === 'reviewer'))
  assert.equal((await f.read()).members.filter(member => member.activation).length, 2)
})

for (const failure of [{ code: 'QUOTA', status: 402, message: 'Insufficient Balance' }, { code: 'RATE_LIMIT', status: 429, message: 'Final retry exhausted' }, { code: 'NETWORK', message: 'Connection closed' }]) {
  test(`terminal ${failure.code} blocks the exact session after accepted dispatch, including restart`, async t => {
    const f = await fixture(t)
    await f.scheduler.kickMember(f.workspace, 'team', 'one')
    f.event('one', 'turn/start', { turn: 1 })
    await eventually(async () => (await f.read()).members[0].runtimeTurn?.turn === 1)
    const before = (await f.read()).tasks[0]
    f.event('one', 'turn/end', { turn: 1, reason: { kind: 'error', error: failure } })
    f.agents.get('one').inbox.hasPending = false
    f.callbacks.get('agent/status')({ agent: f.agents.get('one'), status: 'idle' })
    await eventually(async () => (await f.read()).members[0].runtimeBlock?.code === failure.code)
    let team = await f.read()
    assert.equal(team.tasks[0].executionState, 'blocked_external')
    assert.equal(team.tasks[0].attemptId, before.attemptId)
    const calls = f.calls.filter(call => call.id === 'one').length
    const restarted = installTeamScheduler(f.ctx, { stateDir: '.expert-teams' })
    await restarted.recoverWorkspace(f.workspace)
    await restarted.kickMember(f.workspace, 'team', 'one')
    assert.equal(f.calls.filter(call => call.id === 'one').length, calls)
    team = await f.read()
    assert.equal(resumeRuntimeMember(team, 'one', 'Provider restored', team.members[0].runtimeBlock.id), true)
    await writeTeam(f.root, team)
    // Explicitly free other slots to isolate the resumed member.
    await f.edit(current => { for (const member of current.members.slice(1)) member.status = 'removed' })
    await restarted.kickMember(f.workspace, 'team', 'one')
    assert.equal(f.calls.filter(call => call.id === 'one').length, calls + 1)
    assert.equal((await f.read()).tasks[0].attemptId, before.attemptId)
  })
}

test('terminal error preserves awaiting_review and uses task-attempt and turn CAS', () => {
  const team = { captainSessionId: 'captain', members: [{ id: 'one', name: 'one', status: 'working' }], tasks: [
    { ...makeTask('t1', 'one'), status: 'in_progress', executionState: 'awaiting_review', attemptId: 'attempt-1', output: 'review me', publishedArtifacts: [{ id: 'artifact' }] },
  ], qualityRuns: { t1: { status: 'reviewing' } } }
  captureRuntimeTurn(team, 'one', 1)
  const quality = JSON.stringify(team.qualityRuns), artifacts = JSON.stringify(team.tasks[0].publishedArtifacts)
  recordRuntimeFailure(team, 'one', 1, { code: 'QUOTA', message: 'Insufficient Balance' }, 10)
  assert.equal(team.tasks[0].executionState, 'awaiting_review')
  assert.equal(team.tasks[0].output, 'review me')
  assert.equal(JSON.stringify(team.qualityRuns), quality)
  assert.equal(JSON.stringify(team.tasks[0].publishedArtifacts), artifacts)
  resumeRuntimeMember(team, 'one', 'Provider restored')
  assert.equal(recordRuntimeFailure(team, 'one', 1, { code: 'QUOTA', message: 'late error replay' }, 20), undefined)
  assert.equal(team.tasks[0].executionState, 'awaiting_review')
  captureRuntimeTurn(team, 'one', 2)
  team.tasks[0].attemptId = 'attempt-2'
  recordRuntimeFailure(team, 'one', 2, { code: 'NETWORK', message: 'old attempt' }, 30)
  assert.equal(team.tasks[0].runtimeBlock, undefined, 'reassignment is not blocked by an old attempt failure')
  captureRuntimeTurn(team, 'one', 3)
  assert.equal(recordRuntimeFailure(team, 'one', 2, { code: 'QUOTA', message: 'old turn' }, 40), undefined)
})

test('resuming a captain route never clears failed member routes', () => {
  const team = { captainSessionId: 'captain', members: [{ id: 'one', name: 'one', status: 'idle' }], tasks: [] }
  recordRuntimeFailure(team, 'captain', 1, { code: 'QUOTA', message: 'empty' }, 10)
  recordRuntimeFailure(team, 'one', 1, { code: 'QUOTA', message: 'empty' }, 10)
  resumeRuntimeMember(team, 'captain', 'Captain model changed')
  assert.equal(team.captainRuntimeBlock, undefined)
  assert.equal(team.members[0].runtimeBlock.code, 'QUOTA')
})

test('a normally ended but unfinished turn waits for an event instead of redispatching the accepted task', async t => {
  const f = await fixture(t)
  await f.scheduler.kickMember(f.workspace, 'team', 'one')
  f.event('one', 'turn/start', { turn: 1 })
  await eventually(async () => (await f.read()).members[0].runtimeTurn?.turn === 1)
  f.event('one', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  f.agents.get('one').inbox.hasPending = false
  f.callbacks.get('agent/status')({ agent: f.agents.get('one'), status: 'idle' })
  await eventually(async () => (await f.read()).runtimeWaits?.one !== undefined)
  await f.edit(team => { team.tasks[0].dispatch.dispatchedAt = 1 })
  await f.scheduler.kickTeam(f.workspace, 'team')
  await f.scheduler.kickMember(f.workspace, 'team', 'one')
  assert.equal(f.calls.filter(call => call.id === 'one').length, 1)
  const notice = (await readMailbox(f.root, 'team', 'captain')).filter(message => message.idempotencyKey?.startsWith('unfinished-turn:'))
  assert.equal(notice.length, 1)
})

test('cold restart does not blindly rerun a previously accepted unknown turn', async t => {
  const f = await fixture(t)
  await f.scheduler.kickMember(f.workspace, 'team', 'one')
  f.agents.delete('one')
  await f.scheduler.recoverWorkspace(f.workspace)
  const team = await f.read()
  assert.equal(team.members[0].runtimeBlock.code, 'HOST_RESTART_UNCONFIRMED')
  assert.equal(team.tasks[0].executionState, 'blocked_external')
  await f.scheduler.recoverWorkspace(f.workspace)
  assert.equal(f.calls.filter(call => call.id === 'one').length, 1)
})

test('hot concurrency changes govern new admissions and ready dependency work releases a wait', async t => {
  const f = await fixture(t)
  let limit = 1
  const scheduler = installTeamScheduler(f.ctx, { stateDir: '.expert-teams', get maxActiveMembers() { return limit } })
  await f.edit(team => { team.runtimeWaits = { one: { reason: 'Waiting for prerequisites', taskIds: ['t1'], since: 1 } } })
  await scheduler.kickTeam(f.workspace, 'team')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].id, 'one')
  assert.equal((await f.read()).runtimeWaits.one, undefined)
  limit = 2
  await scheduler.kickTeam(f.workspace, 'team')
  assert.equal(f.calls.length, 2)
  limit = 1
  await scheduler.kickTeam(f.workspace, 'team')
  assert.equal(f.calls.length, 2, 'lowering the cap does not cancel already active turns or admit a third')
})

test('repeated cold admission failures use activation identity without suppressing the next real turn error', () => {
  const team = { captainSessionId: 'captain', members: [{ id: 'one', name: 'one', status: 'idle',
    runtimeResolvedThroughTurn: 1, runtimeTurn: { turn: 1, taskAttempts: [] },
    activation: { id: 'reservation-2', sessionId: 'one', reservedAt: 2, taskAttempts: [{ taskId: 't1', attemptId: 'attempt-2' }] },
  }], tasks: [{ ...makeTask('t1', 'one'), status: 'claimed', attemptId: 'attempt-2' }] }
  const recovery = recordRuntimeFailure(team, 'one', 1, { code: 'HOST_RESTART_UNCONFIRMED', message: 'Unknown outcome' }, 3, 'reservation-2')
  assert.ok(recovery)
  assert.equal(team.tasks[0].runtimeBlock.attemptId, 'attempt-2')
  resumeRuntimeMember(team, 'one', 'Saved session inspected')
  assert.equal(team.members[0].runtimeResolvedThroughTurn, 1)
  captureRuntimeTurn(team, 'one', 2)
  assert.ok(recordRuntimeFailure(team, 'one', 2, { code: 'QUOTA', message: 'New genuine failure' }, 4))
  assert.equal(team.members[0].runtimeBlock.turn, 2)
})
