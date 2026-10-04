import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DISPATCH_COOLDOWN_MS, MAX_DISPATCH_FAILURES, installTeamScheduler, planDispatch } from '../lib/scheduler.js'
import { appendMailbox, claimMailboxDelivery, createMessage, createTeamDir, createTaskProject, publishTaskArtifact, readMailbox, readTeam, readUnreadMailbox, writeTeam } from '../lib/state.js'
import { deliverCaptainMailbox, deliverToMember, MEMBER_DELIVERY_TIMEOUT_MS, memberToolFilter } from '../lib/members.js'
import { createQualityRun, reviewQualityRun } from '../lib/quality-run.js'
import { createHash } from 'node:crypto'

function task(overrides = {}) {
  return {
    id: 't1', subject: 'produce reviewed evidence', status: 'in_progress',
    assignee: 'worker', attempt: 1, attemptId: 'attempt-1', dependencies: [],
    createdAt: 1, updatedAt: 1, ...overrides,
  }
}

function manualClock() {
  let now = Date.now()
  const pending = new Map()
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const timer = { unref() {} }
      pending.set(timer, { callback, dueAt: now + delay })
      return timer
    },
    clearTimeout(timer) { pending.delete(timer) },
    get pending() { return pending.size },
    advance(ms) {
      now += ms
      for (const [timer, entry] of [...pending]) {
        if (entry.dueAt > now) continue
        pending.delete(timer)
        entry.callback()
      }
    },
  }
}

async function eventually(predicate) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.fail('asynchronous scheduler recovery did not settle')
}

async function fixture(t, overrides = {}, clock) {
  const workspace = await mkdtemp(join(tmpdir(), 'scheduler-waiting-'))
  const stateRoot = join(workspace, '.expert-teams')
  const captainMessages = []
  const captain = { id: 'captain-id', status: 'idle', session: { header: { cwd: workspace }, events: [] },
    inbox: { nextTurn: [], nextStep: [] },
    steer(message) { captainMessages.push(message); this.inbox.nextStep.push(message) },
  }
  const worker = { id: 'worker-id', status: 'idle', inbox: { hasPending: false }, session: { header: { cwd: workspace }, events: [] } }
  const calls = []
  const callbacks = new Map()
  const warnings = []
  const disposers = []
  t.after(async () => {
    for (const dispose of disposers) dispose()
    await rm(workspace, { recursive: true, force: true })
  })
  const ctx = {
    agents: { get: id => id === captain.id ? captain : id === worker.id ? worker : undefined },
    subagents: { async followup(_captain, id, content) { calls.push({ id, content }); worker.inbox.hasPending = true } },
    logger: { warn: warning => warnings.push(warning) },
    effect(setup) { const dispose = setup(); disposers.push(dispose); callbacks.set('dispose', dispose) },
    on(name, callback) { callbacks.set(name, callback); if (name === 'dispose') disposers.push(callback) },
  }
  await createTeamDir(stateRoot, {
    id: 'team', name: 'team', captainSessionId: captain.id, createdAt: 1,
    members: [{ id: worker.id, name: 'worker', joinedAt: 1, status: 'working' }],
    tasks: [task(overrides)], taskSeq: 1,
  })
  const reload = () => installTeamScheduler(ctx, { stateDir: '.expert-teams', clock })
  return { workspace, stateRoot, captain, captainMessages, worker, calls, callbacks, warnings, ctx, reload,
    scheduler: reload(), read: () => readTeam(stateRoot, 'team'),
    async update(edit) { const team = await readTeam(stateRoot, 'team'); edit(team.tasks[0], team); await writeTeam(stateRoot, team) },
  }
}

test('waiting blocks dispatch without depending on cooldown, output, or attempt age', () => {
  for (const executionState of ['awaiting_review', 'blocked_external']) {
    assert.deepEqual(planDispatch(task({ executionState }), 'worker', undefined, 1_000_000), { blocked: true })
    assert.deepEqual(planDispatch(task({ executionState, output: 'ready', dispatch: { attemptId: 'attempt-1', id: 'old', dispatchedAt: 1 } }), 'worker', 1, 1_000_000), { blocked: true })
  }
  for (const executionState of [undefined, 'active', 'interrupted']) {
    assert.deepEqual(planDispatch(task({ executionState, output: 'partial progress' }), 'worker', undefined, 1_000_000), { blocked: false, reuse: true })
  }
})

test('durable dispatch cooldown survives loss of the in-memory scheduler cache', () => {
  const now = 1_000_000
  const sent = task({ dispatch: { attemptId: 'attempt-1', id: 'dispatch-1', dispatchedAt: now - 1, acceptedAt: now } })
  assert.deepEqual(planDispatch(sent, 'worker', undefined, now), { blocked: true })
  assert.deepEqual(planDispatch(sent, 'worker', undefined, now + DISPATCH_COOLDOWN_MS), { blocked: false, reuse: true })
  assert.deepEqual(planDispatch({ ...sent, attemptId: 'attempt-2' }, 'worker', undefined, now), { blocked: false, reuse: true })
  assert.deepEqual(planDispatch({ ...sent, status: 'pending' }, 'worker', now - 1, now), { blocked: false, reuse: false })
})

test('repair into a new attempt bypasses the previous receipt in the same scheduler', async t => {
  const f = await fixture(t)
  await f.scheduler.kickMember(f.workspace, 'team', 'worker', f.captain)
  const first = (await f.read()).tasks[0]
  f.worker.inbox.hasPending = false
  await f.update(current => {
    current.status = 'pending'
    current.attemptId = undefined
    current.dispatch = undefined
  })
  await f.scheduler.kickMember(f.workspace, 'team', 'worker', f.captain)
  assert.equal(f.calls.length, 2)
  const repaired = (await f.read()).tasks[0]
  assert.equal(repaired.attempt, 2)
  assert.notEqual(repaired.attemptId, first.attemptId)
  f.worker.inbox.hasPending = false
  await f.scheduler.kickMember(f.workspace, 'team', 'worker', f.captain)
  assert.equal(f.calls.length, 2, 'the new attempt still has its own cooldown')
})

test('explicit resume clears the current receipt without inheriting its cached cooldown', async t => {
  const f = await fixture(t)
  await f.scheduler.kickMember(f.workspace, 'team', 'worker', f.captain)
  f.worker.inbox.hasPending = false
  await f.update(current => {
    current.executionState = 'blocked_external'
    current.waitReason = 'waiting for approved input'
  })
  await f.scheduler.kickMember(f.workspace, 'team', 'worker', f.captain)
  assert.equal(f.calls.length, 1)
  await f.update(current => {
    current.executionState = 'active'
    current.waitReason = undefined
    current.dispatch = undefined
  })
  await f.scheduler.kickMember(f.workspace, 'team', 'worker', f.captain)
  assert.equal(f.calls.length, 2)
  assert.equal((await f.read()).tasks[0].attemptId, 'attempt-1')
  assert.equal((await f.read()).tasks[0].attempt, 1)
})

test('waiting survives idle notifications, repeated kicks and restart recovery', async t => {
  const f = await fixture(t, { executionState: 'awaiting_review', waitReason: 'independent review', output: 'submitted evidence' })
  f.callbacks.get('agent/status')({ agent: f.worker, status: 'idle' })
  // Wait for the asynchronous observer's durable status update; its kick is
  // serialized with the explicit kicks below and cannot escape the wait guard.
  for (let i = 0; i < 100; i++) {
    if ((await f.read()).members[0].status === 'idle') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal((await f.read()).members[0].status, 'idle')
  await f.scheduler.kickTeam(f.workspace, 'team', f.captain)
  await f.scheduler.kickTeam(f.workspace, 'team', f.captain)
  await f.reload().recoverWorkspace(f.workspace)
  assert.equal(f.calls.length, 0)
  const current = (await f.read()).tasks[0]
  assert.equal(current.executionState, 'awaiting_review')
  assert.equal(current.output, 'submitted evidence')
  assert.equal(current.attemptId, 'attempt-1')
  assert.deepEqual(f.warnings, [])
})

test('ordinary communication is delivered once without clearing an external wait or redispatching', async t => {
  const f = await fixture(t, { executionState: 'blocked_external', waitReason: 'waiting for source owner approval' })
  await appendMailbox(f.stateRoot, 'team', 'worker', createMessage('captain', 'worker', 'Status acknowledged; no new input.'))
  await f.scheduler.kickMember(f.workspace, 'team', 'worker', f.captain)
  assert.equal(f.calls.length, 1)
  assert.match(f.calls[0].content[0].text, /Status acknowledged/)
  f.worker.inbox.hasPending = false
  await f.reload().kickTeam(f.workspace, 'team', f.captain)
  assert.equal(f.calls.length, 1)
  assert.equal((await f.read()).tasks[0].executionState, 'blocked_external')
  assert.deepEqual(await readUnreadMailbox(f.stateRoot, 'team', 'worker'), [])
})

test('explicitly unblocked or interrupted work resumes under the original capability', async t => {
  const f = await fixture(t, { executionState: 'blocked_external', waitReason: 'missing input' })
  await f.scheduler.kickMember(f.workspace, 'team', 'worker', f.captain)
  assert.equal(f.calls.length, 0)
  await f.update(current => { current.executionState = 'active'; current.waitReason = undefined })
  await f.scheduler.kickMember(f.workspace, 'team', 'worker', f.captain)
  assert.equal(f.calls.length, 1)
  const accepted = (await f.read()).tasks[0]
  assert.equal(accepted.attemptId, 'attempt-1')
  assert.equal(accepted.attempt, 1)
  assert.equal(accepted.dispatch.attemptId, 'attempt-1')
  assert.equal(typeof accepted.dispatch.acceptedAt, 'number')
  assert.match(f.calls[0].content[0].text, /Attempt id: attempt-1/)
  f.worker.inbox.hasPending = false
  await f.update(current => { current.executionState = 'interrupted'; current.dispatch.dispatchedAt = 1 })
  await f.reload().kickMember(f.workspace, 'team', 'worker', f.captain)
  assert.equal(f.calls.length, 2)
  const resumed = (await f.read()).tasks[0]
  assert.equal(resumed.attemptId, 'attempt-1')
  assert.equal(resumed.attempt, 1)
  assert.notEqual(resumed.dispatch.id, accepted.dispatch.id)
})

test('accepted FIFO work blocks duplicate assignments even after cooldown and scheduler restart', async t => {
  const f = await fixture(t)
  await f.scheduler.kickMember(f.workspace, 'team', 'worker', f.captain)
  await f.update(current => { current.dispatch.dispatchedAt = 1; current.dispatch.nextRetryAt = undefined })
  await f.reload().recoverWorkspace(f.workspace)
  await f.reload().kickMember(f.workspace, 'team', 'worker', f.captain)
  assert.equal(f.calls.length, 1)
  assert.equal((await f.read()).tasks[0].attempt, 1)
})

test('failed delivery keeps a reused capability recoverable without immediate retry storms', async t => {
  const f = await fixture(t, { executionState: 'interrupted' })
  f.ctx.subagents.followup = async () => { throw new Error('transport unavailable') }
  await f.scheduler.kickMember(f.workspace, 'team', 'worker', f.captain)
  const failed = (await f.read()).tasks[0]
  assert.equal(failed.attemptId, 'attempt-1')
  assert.equal(failed.status, 'in_progress')
  assert.equal(failed.dispatch.acceptedAt, undefined)
  assert.deepEqual(planDispatch(failed, 'worker', undefined), { blocked: true })
  await f.update(current => { current.dispatch.dispatchedAt = 1; current.dispatch.nextRetryAt = undefined })
  f.ctx.subagents.followup = async (_captain, id, content) => { f.calls.push({ id, content }); f.worker.inbox.hasPending = true }
  await f.reload().kickMember(f.workspace, 'team', 'worker', f.captain)
  assert.equal(f.calls.length, 1)
  assert.equal((await f.read()).tasks[0].attemptId, 'attempt-1')
})

test('a failed first delivery retains its claim and retries the same attempt after cooldown', async t => {
  const f = await fixture(t, { status: 'pending', attempt: 0, attemptId: undefined })
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  let deliveryAttempts = 0
  f.ctx.subagents.followup = async () => { deliveryAttempts++; throw new Error('transport unavailable') }
  await f.scheduler.kickMember(f.workspace, 'team', 'worker', f.captain)
  const failed = (await f.read()).tasks[0]
  assert.equal(failed.status, 'claimed')
  assert.equal(failed.attempt, 1)
  assert.equal(failed.executionState, 'interrupted')
  assert.match(failed.waitReason, /^DISPATCH_DELIVERY_FAILED:/)
  assert.equal(failed.dispatch.acceptedAt, undefined)
  for (let i = 0; i < 3; i++) await f.scheduler.kickMember(f.workspace, 'team', 'worker', f.captain)
  await f.reload().kickMember(f.workspace, 'team', 'worker', f.captain)
  assert.equal(deliveryAttempts, 1, 'in-memory and durable cooldowns suppress repeated failed kicks')
  assert.equal((await f.read()).tasks[0].attemptId, failed.attemptId)
  now += DISPATCH_COOLDOWN_MS
  f.ctx.subagents.followup = async (_captain, id, content) => {
    deliveryAttempts++
    f.calls.push({ id, content })
    f.worker.inbox.hasPending = true
  }
  await f.scheduler.kickMember(f.workspace, 'team', 'worker', f.captain)
  const accepted = (await f.read()).tasks[0]
  assert.equal(deliveryAttempts, 2)
  assert.equal(accepted.attempt, 1)
  assert.equal(accepted.attemptId, failed.attemptId)
  assert.notEqual(accepted.dispatch.id, failed.dispatch.id)
  assert.equal(accepted.dispatch.acceptedAt, now)
  assert.equal(accepted.executionState, 'active')
  assert.equal(accepted.waitReason, undefined)
  assert.match(f.calls[0].content[0].text, new RegExp(`Attempt id: ${failed.attemptId}`))
})

test('failed dispatch retries automatically without another status event and stops after a durable budget', async t => {
  const clock = manualClock()
  const f = await fixture(t, { status: 'pending', attempt: 0, attemptId: undefined }, clock)
  let attempts = 0
  f.ctx.subagents.followup = async () => { attempts++; throw new Error('transport unavailable') }
  await f.scheduler.kickTeam(f.workspace, 'team', f.captain)
  const first = (await f.read()).tasks[0]
  assert.equal(first.dispatch.failureCount, 1)
  assert.equal(clock.pending, 1)
  for (let count = 2; count <= MAX_DISPATCH_FAILURES; count++) {
    clock.advance(DISPATCH_COOLDOWN_MS)
    await eventually(async () => (await f.read()).tasks[0].dispatch.failureCount === count)
  }
  await eventually(() => f.captainMessages.length === 1)
  await eventually(async () => (await readMailbox(f.stateRoot, 'team', 'captain'))[0]?.readAt !== undefined)
  const blocked = (await f.read()).tasks[0]
  assert.equal(blocked.attempt, 1)
  assert.equal(blocked.attemptId, first.attemptId)
  assert.equal(blocked.executionState, 'blocked_external')
  assert.match(blocked.waitReason, /^DISPATCH_DELIVERY_EXHAUSTED:/)
  assert.equal(blocked.dispatch.nextRetryAt, undefined)
  clock.advance(DISPATCH_COOLDOWN_MS * 10)
  await f.scheduler.kickTeam(f.workspace, 'team', f.captain)
  assert.equal(attempts, MAX_DISPATCH_FAILURES)
  assert.equal((await readMailbox(f.stateRoot, 'team', 'captain')).length, 1)
})

test('restart restores remaining retry delay and accepted redelivery clears its transport failure', async t => {
  const clock = manualClock()
  const f = await fixture(t, { status: 'pending', attempt: 0, attemptId: undefined }, clock)
  f.ctx.subagents.followup = async () => { throw new Error('transport unavailable') }
  await f.scheduler.kickTeam(f.workspace, 'team', f.captain)
  const first = (await f.read()).tasks[0]
  f.callbacks.get('dispose')()
  assert.equal(clock.pending, 0)
  clock.advance(12_000)
  f.ctx.subagents.followup = async (_captain, id, content) => { f.calls.push({ id, content }); f.worker.inbox.hasPending = true }
  await f.reload().recoverWorkspace(f.workspace)
  assert.equal(clock.pending, 1)
  clock.advance(DISPATCH_COOLDOWN_MS - 12_000 - 1)
  assert.equal(f.calls.length, 0)
  clock.advance(1)
  await eventually(async () => (await f.read()).tasks[0].dispatch.acceptedAt !== undefined)
  const current = (await f.read()).tasks[0]
  assert.equal(f.calls.length, 1)
  assert.equal(current.attemptId, first.attemptId)
  assert.equal(current.attempt, 1)
  assert.equal(current.executionState, 'active')
  assert.equal(current.dispatch.failureCount, undefined)
  assert.equal(current.dispatch.nextRetryAt, undefined)
})

test('recovery schedules an uncertain receipt persisted before acceptance or failure was recorded', async t => {
  const clock = manualClock()
  const f = await fixture(t, { dispatch: { attemptId: 'attempt-1', id: 'crashed-dispatch', dispatchedAt: clock.now() } }, clock)
  await f.scheduler.recoverWorkspace(f.workspace)
  assert.equal(f.calls.length, 0)
  assert.equal(clock.pending, 1)
  clock.advance(DISPATCH_COOLDOWN_MS)
  await eventually(async () => (await f.read()).tasks[0].dispatch.acceptedAt !== undefined)
  assert.equal(f.calls.length, 1)
  assert.equal((await f.read()).tasks[0].attemptId, 'attempt-1')
})

test('recovery waits out a pre-crash mailbox lease then delivers without another event', async t => {
  const clock = manualClock()
  t.mock.method(Date, 'now', clock.now)
  const f = await fixture(t, { executionState: 'awaiting_review' }, clock)
  const message = await appendMailbox(f.stateRoot, 'team', 'worker', createMessage('captain', 'worker', 'leased input'))
  await claimMailboxDelivery(f.stateRoot, 'team', 'worker', [message.id])
  await f.scheduler.recoverWorkspace(f.workspace)
  assert.equal(f.calls.length, 0)
  assert.equal(clock.pending, 1)
  clock.advance(59_999)
  assert.equal(f.calls.length, 0)
  clock.advance(1)
  await eventually(async () => (await readMailbox(f.stateRoot, 'team', 'worker'))[0].readAt !== undefined)
  assert.equal(f.calls.length, 1)
})

test('scheduled retries respect halt, removed members, reassignment and disposal', async t => {
  for (const change of ['halt', 'removed', 'new-attempt', 'dispose']) {
    const clock = manualClock()
    const f = await fixture(t, { status: 'pending', attempt: 0, attemptId: undefined }, clock)
    let attempts = 0
    f.ctx.subagents.followup = async () => { attempts++; throw new Error('transport unavailable') }
    await f.scheduler.kickTeam(f.workspace, 'team', f.captain)
    if (change === 'dispose') f.callbacks.get('dispose')()
    else await f.update((current, team) => {
      if (change === 'halt') team.halted = true
      if (change === 'removed') team.members[0].status = 'removed'
      if (change === 'new-attempt') {
        current.attemptId = 'replacement-attempt'
        current.executionState = 'awaiting_review'
        current.dispatch = undefined
      }
    })
    clock.advance(DISPATCH_COOLDOWN_MS)
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal(attempts, 1, change)
    assert.equal(clock.pending, 0, change)
  }
})

test('mailbox-only transport failure is retried without an external event', async t => {
  const clock = manualClock()
  const f = await fixture(t, { executionState: 'awaiting_review' }, clock)
  await appendMailbox(f.stateRoot, 'team', 'worker', createMessage('captain', 'worker', 'new review finding'))
  const deliver = f.ctx.subagents.followup
  f.ctx.subagents.followup = async () => { throw new Error('transport unavailable') }
  await f.scheduler.kickTeam(f.workspace, 'team', f.captain)
  assert.equal(clock.pending, 1)
  f.ctx.subagents.followup = deliver
  clock.advance(DISPATCH_COOLDOWN_MS)
  // A live delivery lease also hides the message from readUnreadMailbox,
  // before the transport has accepted it. Wait for the durable ACK itself.
  await eventually(async () => (await readMailbox(f.stateRoot, 'team', 'worker'))[0]?.readAt !== undefined)
  assert.equal(f.calls.length, 1)
  assert.equal((await f.read()).tasks[0].executionState, 'awaiting_review')
})

test('mailbox retries stop after three recovery rounds and preserve unread content with one captain notice', async t => {
  const clock = manualClock()
  const f = await fixture(t, { executionState: 'awaiting_review' }, clock)
  await appendMailbox(f.stateRoot, 'team', 'worker', createMessage('captain', 'worker', 'pending input'))
  let attempts = 0
  f.ctx.subagents.followup = async () => { attempts++; throw new Error('transport unavailable') }
  await f.scheduler.kickTeam(f.workspace, 'team', f.captain)
  for (let round = 1; round <= 3; round++) {
    clock.advance(DISPATCH_COOLDOWN_MS)
    await eventually(() => attempts === round + 1)
    // Wait for the failed delivery's lease release and scheduling decision.
    await eventually(async () => (await readMailbox(f.stateRoot, 'team', 'worker'))[0].deliveryClaimedAt === undefined)
    if (round < 3) await eventually(() => clock.pending === 1)
  }
  await eventually(() => f.captainMessages.length === 1)
  await eventually(async () => (await readMailbox(f.stateRoot, 'team', 'captain'))[0]?.readAt !== undefined)
  assert.equal(clock.pending, 0)
  clock.advance(DISPATCH_COOLDOWN_MS * 10)
  assert.equal(attempts, 4)
  assert.equal((await readUnreadMailbox(f.stateRoot, 'team', 'worker'))[0].content, 'pending input')
  assert.equal((await readMailbox(f.stateRoot, 'team', 'captain')).length, 1)
})

test('member delivery has an abortable deadline even when the Host transport never settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  const warnings = []
  const ctx = {
    subagents: { followup(_captain, _id, _content, options) { signal = options.signal; return new Promise(() => {}) } },
    logger: { warn(value) { warnings.push(value) } },
  }
  const pending = deliverToMember(ctx, { id: 'captain' }, 'worker', 'assignment', new AbortController().signal)
  t.mock.timers.tick(MEMBER_DELIVERY_TIMEOUT_MS)
  assert.equal(await pending, false)
  assert.equal(signal.aborted, true)
  assert.match(warnings[0], /timed out/)
  const canceled = new AbortController()
  canceled.abort(new Error('already disposed'))
  signal = undefined
  assert.equal(await deliverToMember(ctx, { id: 'captain' }, 'worker', 'assignment', canceled.signal), false)
  assert.equal(signal, undefined, 'already canceled delivery must not invoke the transport')
})

test('late dispatch acknowledgement cannot modify a reassigned generation', async t => {
  const f = await fixture(t)
  f.ctx.subagents.followup = async () => {
    await f.update(current => {
      current.attemptId = 'attempt-2'
      current.attempt = 2
      current.dispatch = { attemptId: 'attempt-2', id: 'new-dispatch', dispatchedAt: 1 }
    })
  }
  await f.scheduler.kickMember(f.workspace, 'team', 'worker', f.captain)
  const current = (await f.read()).tasks[0]
  assert.equal(current.dispatch.id, 'new-dispatch')
  assert.equal(current.dispatch.acceptedAt, undefined)
  assert.equal(current.attemptId, 'attempt-2')
})

test('captain fallback: offline reports are replayed once after reconnect and acknowledged', async t => {
  const f = await fixture(t, { executionState: 'awaiting_review' })
  const message = createMessage('worker', 'captain', 'Review this submitted version.')
  await appendMailbox(f.stateRoot, 'team', 'captain', message)
  const get = f.ctx.agents.get
  f.ctx.agents.get = id => id === f.captain.id ? undefined : get(id)
  await f.scheduler.kickTeam(f.workspace, 'team')
  assert.equal(f.captainMessages.length, 0)
  f.ctx.agents.get = get
  await f.reload().recoverWorkspace(f.workspace)
  await f.reload().recoverWorkspace(f.workspace)
  assert.equal(f.captainMessages.length, 1)
  assert.match(f.captainMessages[0].content[0].text, /Review this submitted version/)
  assert.deepEqual(await readUnreadMailbox(f.stateRoot, 'team', 'captain'), [])
})

test('captain fallback: a thrown live delivery releases its lease for retry', async t => {
  const f = await fixture(t, { executionState: 'awaiting_review' })
  await appendMailbox(f.stateRoot, 'team', 'captain', createMessage('worker', 'captain', 'queued report'))
  const steer = f.captain.steer
  f.captain.steer = () => { throw new Error('driver unavailable') }
  await f.scheduler.kickTeam(f.workspace, 'team')
  const pending = await readUnreadMailbox(f.stateRoot, 'team', 'captain')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].deliveryClaimedAt, undefined)
  f.captain.steer = steer
  await f.reload().recoverWorkspace(f.workspace)
  assert.equal(f.captainMessages.length, 1)
})

test('captain fallback: accepted pending or consumed reports survive lost mailbox acknowledgements', async t => {
  for (const consumed of [false, true]) {
    const f = await fixture(t, { executionState: 'awaiting_review' })
    const message = createMessage('worker', 'captain', 'acknowledgement crashed')
    await appendMailbox(f.stateRoot, 'team', 'captain', message)
    assert.equal(deliverCaptainMailbox(f.captain, message), true)
    if (consumed) {
      f.captain.session.events.push({ type: 'user/message', data: f.captainMessages[0] })
      f.captain.inbox.nextStep.length = 0
    }
    await f.reload().recoverWorkspace(f.workspace)
    assert.equal(f.captainMessages.length, 1)
    assert.deepEqual(await readUnreadMailbox(f.stateRoot, 'team', 'captain'), [])
  }
})

test('captain fallback: canceled unconsumed reports remain eligible for a later delivery', async t => {
  const f = await fixture(t, { executionState: 'awaiting_review' })
  const message = createMessage('worker', 'captain', 'pending then canceled')
  await appendMailbox(f.stateRoot, 'team', 'captain', message)
  deliverCaptainMailbox(f.captain, message)
  f.captain.inbox.nextStep.length = 0
  await f.reload().recoverWorkspace(f.workspace)
  assert.equal(f.captainMessages.length, 2)
})

function qualityRun(maxRepairRounds = 2) {
  return createQualityRun({
    id: 'contract-t1', taskId: 't1', attempt: 1, assignee: 'worker', kind: 'implementation',
    objective: 'verify output', inScope: ['result.md'], acceptance: [{ id: 'a1', statement: 'result is correct' }],
    verify: ['check-result'], deliverables: ['result.md'], changedPaths: ['result.md'], maxRepairRounds,
  }, 'quality-t1')
}

test('quality retry: failed execution forks the contract and archives its original generation', async t => {
  const f = await fixture(t, { status: 'failed', attemptId: undefined, finalizedAttemptId: 'attempt-1' })
  const original = qualityRun()
  await f.update((_task, team) => { team.qualityRun = original; team.qualityRuns = { t1: original } })
  await f.scheduler.kickTeam(f.workspace, 'team')
  const current = await f.read()
  assert.equal(f.calls.length, 1)
  assert.equal(current.tasks[0].attempt, 2)
  assert.equal(current.qualityRuns.t1.attempt, 2)
  assert.equal(current.qualityRun.runId, current.qualityRuns.t1.runId)
  assert.deepEqual(current.qualityRunHistory.t1, [JSON.parse(JSON.stringify(original))])
  assert.equal(current.qualityRun.latestEvidence, undefined)
  await f.reload().recoverWorkspace(f.workspace)
  assert.equal((await f.read()).qualityRunHistory.t1.length, 1)
})

test('quality retry: exhausted review budget keeps failure and emits one durable blocker', async t => {
  const f = await fixture(t, { status: 'failed', attemptId: undefined, finalizedAttemptId: 'attempt-1' })
  const content = 'incorrect'
  const original = reviewQualityRun(qualityRun(0), {
    eventId: 'review-failed', reviewer: 'reviewer', verdict: 'needs_revision',
    findings: [{ id: 'f1', code: 'incorrect', severity: 'hard', message: 'wrong result', taskId: 't1', attempt: 1 }],
    evidence: { taskId: 't1', attempt: 1,
      artifacts: [{ id: 'result.md', taskId: 't1', attempt: 1, path: 'result.md', content, sha256: createHash('sha256').update(content).digest('hex') }],
      acceptanceResults: [{ id: 'a1', passed: true }], commandsRun: [{ command: 'check-result', exitCode: 0, passed: true }], changedPaths: ['result.md'] },
  }).run
  await f.update((_task, team) => { team.qualityRun = original; team.qualityRuns = { t1: original } })
  await f.scheduler.kickTeam(f.workspace, 'team')
  await f.reload().recoverWorkspace(f.workspace)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.read()).tasks[0].status, 'failed')
  assert.equal((await f.read()).qualityRun.runId, original.runId)
  const blockers = (await readMailbox(f.stateRoot, 'team', 'captain')).filter(message => message.idempotencyKey?.startsWith('auto-retry-blocked:'))
  assert.equal(blockers.length, 1)
  assert.match(blockers[0].content, /explicit policy decision/)
})

async function pinnedInput(t) {
  const f = await fixture(t, { status: 'pending', attempt: 0, attemptId: undefined })
  const team = await f.read()
  const source = task({ id: 'upstream', subject: 'upstream', status: 'completed', assignee: 'captain', attemptId: undefined })
  source.project = await createTaskProject(f.stateRoot, 'team', source)
  const artifact = await publishTaskArtifact(f.stateRoot, team, source, { name: 'data.txt', content: 'verified input' })
  source.publishedArtifacts = [artifact]
  team.tasks.push(source)
  team.tasks[0].dependencies = ['upstream']
  team.tasks[0].inputArtifacts = [{ sourceTaskId: source.id, artifactId: artifact.id }]
  await writeTeam(f.stateRoot, team)
  return { ...f, source, artifact }
}

test('artifact preflight: a verified pinned version is included in the assignment manifest', async t => {
  const f = await pinnedInput(t)
  await f.scheduler.kickTeam(f.workspace, 'team')
  assert.equal(f.calls.length, 1)
  const text = f.calls[0].content[0].text
  assert.ok(text.includes(f.artifact.id))
  assert.ok(text.includes(f.artifact.sha256))
  assert.ok(text.includes(f.artifact.relativePath))
  assert.match(text, /expert_teams_read_artifact/)
  assert.ok(!text.includes('verified input'))
})

test('artifact preflight: hash drift blocks a pending task without waking it and reports once', async t => {
  const f = await pinnedInput(t)
  await writeFile(join(f.stateRoot, 'team', f.source.project.artifactsPath, f.artifact.relativePath), 'changed upstream')
  await f.scheduler.kickTeam(f.workspace, 'team')
  await f.reload().recoverWorkspace(f.workspace)
  assert.equal(f.calls.length, 0)
  const current = (await f.read()).tasks[0]
  assert.equal(current.status, 'pending')
  assert.equal(current.attempt, 0)
  assert.equal(current.executionState, 'blocked_external')
  assert.match(current.waitReason, /hash mismatch/)
  const blockers = (await readMailbox(f.stateRoot, 'team', 'captain')).filter(message => message.idempotencyKey?.startsWith('input-artifact-blocked:'))
  assert.equal(blockers.length, 1)
})

test('artifact tools remain available within an explicitly scoped worker', () => {
  const filter = memberToolFilter({ allowedTools: [] })
  assert.ok(filter.allow.includes('expert_teams_publish_artifact'))
  assert.ok(filter.allow.includes('expert_teams_read_artifact'))
})
