import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { createCapabilityScope, memberWorkTools } from '../lib/capability-scope.js'
import { installMemberSelectionRuntime, memberToolFilter, MEMBER_PENDING_SETUP_TIMEOUT_MS } from '../lib/members.js'
import { installContinuableMemberSetup, installIdleMemberBootstrap, installMemberToolBoundary, memberBootstrapPrompt, memberContinuableDescriptor } from '../lib/harness-compat.js'

function context(agent) {
  const hooks = new Map()
  const guards = []
  const effects = []
  const ctx = {
    agent,
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
    on(name, fn) {
      const values = hooks.get(name) ?? []
      hooks.set(name, [...values, fn])
      return () => hooks.set(name, hooks.get(name).filter(value => value !== fn))
    },
    tools: { guard(fn) { guards.push(fn); return () => guards.splice(guards.indexOf(fn), 1) } },
  }
  return {
    ctx, guards, hookCount(name) { return (hooks.get(name) ?? []).length },
    dispose() { for (const dispose of effects.splice(0).reverse()) dispose?.() },
    async waterfall(name, args, initial) {
      const values = hooks.get(name) ?? []
      const next = index => index === values.length ? Promise.resolve(initial) : values[index](...args, () => next(index + 1))
      return next(0)
    },
  }
}
const message = text => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const scope = allowedTools => createCapabilityScope({ expertId: 'fixture', role: 'worker', allowedTools, maxDepth: 0 })

test('member identity reads both tested Host descriptor versions and fails closed for future member formats', () => {
  const descriptor = { mode: 'continuable', provider: 'spawn', label: 'expert-teams:team:worker', agentProvider: 'fixture', agentModel: 'stub' }
  const read = data => memberContinuableDescriptor([{ type: 'subagent/descriptor', data }], 'expert-teams:')
  assert.equal(read({ version: 2, ...descriptor }).label, descriptor.label)
  assert.equal(read({ version: 3, ...descriptor, agentReasoningEffort: 'high' }).label, descriptor.label)
  assert.throws(() => read({ version: 4, ...descriptor }), /expected tested version/)
  assert.throws(() => read({ version: 2, ...descriptor, agentReasoningEffort: 'high' }), /unknown composition/)
  assert.throws(() => read({ version: 3, ...descriptor, toolFilter: { allow: 'read' } }), /toolFilter.allow/)
  assert.equal(read({ version: 4, ...descriptor, label: 'unrelated-child' }), undefined)
})

test('creation defaults are explicit while generic and explicit-empty scopes stay least-privileged', () => {
  assert.deepEqual(memberWorkTools(), ['bash', 'read', 'read_image', 'write', 'edit', 'glob', 'grep'])
  assert.deepEqual(memberWorkTools([]), [])
  assert.deepEqual(createCapabilityScope({ expertId: 'fixture', role: 'worker' }).allowedTools, [])
  assert.deepEqual(scope([]).allowedTools, [])
  for (const allowedTools of [[], memberWorkTools()]) {
    const filter = memberToolFilter(scope(allowedTools))
    assert.ok(filter.allow.includes('expert_teams_quality_review'))
    assert.ok(filter.allow.includes('expert_teams_wait'))
    assert.ok(!filter.allow.includes('expert_teams_add_member'))
    assert.ok(!filter.allow.includes('expert_teams_chat'))
    assert.ok(filter.deny.includes('expert_teams_chat'))
    assert.equal(filter.allow.includes('bash'), allowedTools.length > 0)
    assert.equal(filter.allow.includes('read_image'), allowedTools.length > 0)
  }
  const contaminated = memberToolFilter(scope(['expert_teams_add_member', 'expert_teams_quality_integrate', 'read', 'read']))
  assert.ok(!contaminated.allow.includes('expert_teams_add_member'))
  assert.ok(!contaminated.allow.includes('expert_teams_quality_integrate'))
  assert.equal(contaminated.allow.filter(value => value === 'read').length, 1)
})

test('scoped tools and reserved code transport cannot bypass the actual member execution boundary', async () => {
  const fixture = context()
  const dispose = installMemberToolBoundary(fixture.ctx, memberToolFilter(scope(memberWorkTools())), true)
  const names = ['bash', 'read', 'read_image', 'write', 'subagent', 'list_subagent_models', 'expert_teams_add_member', 'expert_teams_chat', 'expert_teams_quality_review', 'expert_teams_wait', 'run_code']
  const assembly = { tools: names.map(name => ({ name })), sections: [], contexts: [], variables: {} }
  const result = await fixture.waterfall('system-prompt/assemble', [assembly, {}], assembly)
  assert.deepEqual(result.tools.map(tool => tool.name), ['bash', 'read', 'read_image', 'write', 'expert_teams_quality_review', 'expert_teams_wait'])
  for (const name of ['subagent', 'expert_teams_add_member', 'expert_teams_chat', 'run_code']) {
    assert.match(fixture.guards[0]({ name }), /expert-teams:/)
    assert.match(fixture.guards[0]({ name, parent: Symbol('code-child-call') }), /expert-teams:/)
  }
  assert.equal(fixture.guards[0]({ name: 'expert_teams_quality_review' }), undefined)
  assert.equal(fixture.guards[0]({ name: 'bash' }), undefined)
  assert.equal(fixture.guards[0]({ name: 'read_image' }), undefined)
  dispose()
  assert.equal(fixture.guards.length, 0)
})

test('current Host lifecycle binds the payload agent through its injected scope, never through the routing receiver', () => {
  const hooks = new Map()
  const warnings = []
  const ctx = {
    subagents: {},
    logger: { warn(value) { warnings.push(value) } },
    effect(fn) { return fn() },
    on(name, fn) { hooks.set(name, fn); return () => hooks.delete(name) },
  }
  const scopeKey = Symbol('host-scope')
  const scoped = {
    [scopeKey]: 'host-owned-child-scope',
    tools: { hostToolRegistry: true },
    extend(meta) { return Object.assign(Object.create(this), meta) },
    effect(fn) { return fn() },
  }
  let injectCalls = 0
  const agent = {
    id: 'actual-event-agent',
    session: { ownEvents: () => [{ type: 'subagent/descriptor', data: { label: 'expert-teams:team:worker' } }] },
    ctx: {
      inject(deps, fn) {
        injectCalls++
        assert.ok(deps.includes('tools'))
        fn(scoped)
        return { dispose() {} }
      },
      effect(fn) { return fn() },
      on() { return () => {} },
    },
  }
  let setups = 0
  installContinuableMemberSetup(ctx, childCtx => {
    setups++
    assert.equal(childCtx.agent, agent)
    assert.equal(childCtx[scopeKey], 'host-owned-child-scope')
    assert.equal(childCtx.tools.hostToolRegistry, true)
    return () => {}
  })
  // A Scoped<Agent> event receiver intentionally has neither .agent nor .ctx.
  hooks.get('agent/session-start').call(Object.freeze({}), { agent })
  hooks.get('agent/session-start').call(Object.freeze({}), { agent })
  assert.equal(setups, 1)
  assert.equal(injectCalls, 1)
  assert.deepEqual(warnings, [])
})

test('deferred member setup gates and reassembles the first prompt once, while the captain remains untouched', async () => {
  const hooks = new Map()
  const ctx = {
    subagents: {}, logger: { warn() {} }, effect(fn) { return fn() },
    on(name, fn) { hooks.set(name, fn); return () => {} },
  }
  const fixture = context()
  let mount
  let reassemblies = 0
  const assembly = { tools: [{ name: 'subagent' }, { name: 'read' }], sections: [], contexts: [], variables: {} }
  const scoped = Object.assign(fixture.ctx, {
    inject(_deps, fn) { mount = fn; return { dispose() {} } },
    effect(fn) { return fn() },
    extend(meta) { return Object.assign(Object.create(this), meta) },
    systemPrompt: { async assemble(value) {
      reassemblies++
      return fixture.waterfall('system-prompt/assemble', [assembly, value], assembly)
    } },
  })
  const agent = { id: 'deferred-child', ctx: scoped,
    session: { ownEvents: () => [{ type: 'subagent/descriptor', data: { label: 'expert-teams:team:worker' } }] } }
  installContinuableMemberSetup(ctx, childCtx => {
    const release = installMemberToolBoundary(childCtx, memberToolFilter(scope(memberWorkTools())), true)
    const boot = installIdleMemberBootstrap(childCtx, agent.id)
    return () => { boot(); release() }
  })
  const captain = { session: { ownEvents: () => [] }, ctx: { inject() { throw new Error('captain must not be injected or gated') } } }
  hooks.get('agent/session-start')({ agent: captain })
  hooks.get('agent/session-start')({ agent })
  let settled = false
  const pending = fixture.waterfall('system-prompt/assemble', [assembly, {}], assembly).then(value => { settled = true; return value })
  await Promise.resolve()
  assert.equal(settled, false)
  mount(scoped)
  const ready = await pending
  assert.deepEqual(ready.tools.map(tool => tool.name), ['read'])
  assert.equal(reassemblies, 1)
  assert.match(fixture.guards[0]({ name: 'subagent' }), /delegation/)
  const boot = message(memberBootstrapPrompt(agent.id))
  assert.deepEqual(await fixture.waterfall('agent/pre-step', [{ messages: [boot] }], { kind: 'enter', messages: [boot] }), { kind: 'enter', messages: [] })
  await fixture.waterfall('system-prompt/assemble', [assembly, {}], assembly)
  assert.equal(reassemblies, 1)
})

test('member setup failure rejects assembly before any model request can be built', async () => {
  const hooks = new Map()
  const ctx = {
    subagents: {}, logger: { warn() {} }, effect(fn) { return fn() },
    on(name, fn) { hooks.set(name, fn); return () => {} },
  }
  const fixture = context()
  Object.assign(fixture.ctx, {
    inject(_deps, fn) { fn(this); return { dispose() {} } },
    effect(fn) { return fn() },
    extend(meta) { return Object.assign(Object.create(this), meta) },
  })
  const agent = { ctx: fixture.ctx, session: { ownEvents: () => [{ type: 'subagent/descriptor', data: { label: 'expert-teams:team:worker' } }] } }
  installContinuableMemberSetup(ctx, () => { throw new Error('controlled setup failure') })
  hooks.get('agent/session-start')({ agent })
  await assert.rejects(fixture.waterfall('system-prompt/assemble', [{}, {}], {}), /controlled setup failure/)
})

test('explicit empty scope rejects scoped filesystem tools; even explicitly named subagent has no depth-zero grant', () => {
  for (const tools of [[], ['subagent']]) {
    const fixture = context()
    installMemberToolBoundary(fixture.ctx, memberToolFilter(scope(tools)), true)
    assert.match(fixture.guards[0]({ name: 'bash' }), /capability scope/)
    assert.match(fixture.guards[0]({ name: 'subagent' }), /no nested delegation budget/)
  }
  assert.throws(() => installMemberToolBoundary({ tools: {} }, memberToolFilter(scope([])), true), /monotonic tools.guard/)
})

test('bootstrap consumes only its own provisioning message with zero model-entering messages', async () => {
  const fixture = context()
  installIdleMemberBootstrap(fixture.ctx, 'child-one')
  const boot = message(memberBootstrapPrompt('child-one'))
  boot.content.push({ type: 'text', text: 'Host return guidance' })
  const task = message('Review task t1 now')
  const runtimeContext = message('Host runtime context')
  const invoke = messages => fixture.waterfall('agent/pre-step', [{ messages }], { kind: 'enter', messages: [...messages, runtimeContext] })
  assert.deepEqual(await invoke([boot]), { kind: 'enter', messages: [] })
  assert.deepEqual((await invoke([boot, task])).messages, [task, runtimeContext])
  assert.deepEqual((await invoke([task])).messages, [task, runtimeContext])
  const other = message(memberBootstrapPrompt('child-two'))
  assert.deepEqual((await invoke([other])).messages, [other, runtimeContext])
})

test('fresh pending setup and a separately installed cold runtime both enforce the saved member scope', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'expert-member-boundary-'))
  const parentId = 'captain-fixture'
  const childId = 'child-fixture'
  const label = 'expert-teams:team-fixture:worker'
  const selection = { provider: 'fixture-provider', model: 'fixture-model' }
  const capabilityScope = scope(memberWorkTools())
  const descriptor = snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label, agentProvider: selection.provider, agentModel: selection.model })
  const child = { id: childId, session: { header: { cwd: workspace, parentSession: parentId }, ownEvents: () => [{ type: 'subagent/descriptor', data: descriptor }] } }
  const install = () => {
    let setup
    const parent = context({ id: parentId })
    parent.ctx.subagents = { registerContinuableSetup(fn) { setup = fn; return () => {} } }
    const runtime = installMemberSelectionRuntime(parent.ctx, 'expert-teams')
    return { runtime, parent, setup: (...args) => setup(...args) }
  }
  try {
    const fresh = install()
    const first = context(child)
    await fresh.runtime.withPending({ parentSessionId: parentId, childSessionId: childId, label }, selection, async () => fresh.setup(first.ctx), capabilityScope)
    assert.match(first.guards[0]({ name: 'subagent' }), /delegation/)
    assert.equal(first.guards[0]({ name: 'read' }), undefined)
    mkdirSync(join(workspace, 'expert-teams', 'team-fixture'), { recursive: true })
    writeFileSync(join(workspace, 'expert-teams', 'team-fixture', 'team.json'), JSON.stringify({
      id: 'team-fixture', name: 'team-fixture', captainSessionId: parentId, createdAt: 1, taskSeq: 0, tasks: [],
      members: [{ id: childId, name: 'worker', joinedAt: 1, status: 'idle', ...selection, capabilityScope }],
    }))
    const cold = install()
    // The supported newer Host writes v3 even when the plugin peer installed
    // with the repository is rc.8, whose upstream fold silently ignores v3.
    const resumedChild = { ...child, session: { ...child.session, ownEvents: () => [{ type: 'subagent/descriptor', data: { ...descriptor, version: 3, agentReasoningEffort: 'high' } }] } }
    const resumed = context(resumedChild)
    cold.setup(resumed.ctx)
    assert.match(resumed.guards[0]({ name: 'subagent' }), /delegation/)
    assert.equal(resumed.guards[0]({ name: 'read' }), undefined)
    const boot = message(memberBootstrapPrompt(childId))
    assert.deepEqual(await resumed.waterfall('agent/pre-step', [{ messages: [boot] }], { kind: 'enter', messages: [boot] }), { kind: 'enter', messages: [] })
    const notice = { ...message('It left no closing message.'), source: { kind: 'subagent-settled', senderSessionId: childId } }
    assert.deepEqual(await cold.parent.waterfall('agent/pre-step', [{ agent: { id: parentId }, messages: [notice] }], { kind: 'enter', messages: [notice] }), { kind: 'enter', messages: [] })
    // The next real task/review completion must still wake the captain.
    const real = message('Review t1 now')
    await resumed.waterfall('agent/pre-step', [{ messages: [real] }], { kind: 'enter', messages: [real] })
    assert.deepEqual(await cold.parent.waterfall('agent/pre-step', [{ agent: { id: parentId }, messages: [notice] }], { kind: 'enter', messages: [notice] }), { kind: 'enter', messages: [notice] })
    const unauthorized = context({ ...child, id: 'different-child' })
    assert.throws(() => cold.setup(unauthorized.ctx), /durable member capability boundary/)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

function provisioningFixture(t) {
  const workspace = mkdtempSync(join(tmpdir(), 'expert-pending-member-'))
  const identity = { parentSessionId: 'captain-fixture', childSessionId: 'child-fixture', label: 'expert-teams:team-fixture:worker' }
  const selection = { provider: 'fixture-provider', model: 'fixture-model' }
  const descriptor = snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label: identity.label,
    agentProvider: selection.provider, agentModel: selection.model })
  const child = { id: identity.childSessionId, session: { header: { cwd: workspace, parentSession: identity.parentSessionId },
    ownEvents: () => [{ type: 'subagent/descriptor', data: descriptor }] } }
  const parent = context({ id: identity.parentSessionId })
  let setup
  parent.ctx.subagents = { registerContinuableSetup(fn) { setup = fn; return () => {} } }
  const runtime = installMemberSelectionRuntime(parent.ctx, 'expert-teams')
  t.after(() => { parent.dispose(); rmSync(workspace, { recursive: true, force: true }) })
  return { workspace, identity, selection, descriptor, child, parent, runtime, setup: ctx => setup(ctx) }
}

for (const allowed of [[], memberWorkTools()]) {
  test(`delayed scoped initialization after start returns retains ${allowed.length ? 'work tools' : 'explicit empty scope'} before team write`, async t => {
    const workspace = mkdtempSync(join(tmpdir(), 'expert-delayed-member-'))
    const identity = { parentSessionId: 'captain', childSessionId: 'deferred-child', label: 'expert-teams:team-fixture:worker' }
    const selection = { provider: 'fixture-provider', model: 'fixture-model' }
    const originalScope = scope([...allowed])
    const descriptor = { version: 3, mode: 'continuable', provider: 'spawn', label: identity.label,
      agentProvider: selection.provider, agentModel: selection.model }
    const parent = context({ id: identity.parentSessionId })
    parent.ctx.subagents = {}
    parent.ctx.logger = { warn() {} }
    const runtime = installMemberSelectionRuntime(parent.ctx, 'expert-teams')
    const fixture = context()
    let mount
    const assembly = { tools: ['bash', 'read', 'write', 'subagent', 'expert_teams_wait'].map(name => ({ name })),
      variables: {}, sections: [], contexts: [] }
    Object.assign(fixture.ctx, {
      inject(_deps, callback) { mount = callback; return { dispose() {} } },
      extend(meta) { return Object.assign(Object.create(this), meta) },
      systemPrompt: { assemble(value) { return fixture.waterfall('system-prompt/assemble', [assembly, value], assembly) } },
    })
    const child = { id: identity.childSessionId, ctx: fixture.ctx, session: {
      header: { cwd: workspace, parentSession: identity.parentSessionId },
      ownEvents: () => [{ type: 'subagent/descriptor', data: descriptor }],
    } }
    t.after(() => { fixture.dispose(); parent.dispose(); rmSync(workspace, { recursive: true, force: true }) })
    const receipt = await runtime.withPending(identity, selection, async () => {
      // The real Host emits session-start but asynchronous inject has not
      // mounted when startContinuable acknowledges its inbox admission.
      await parent.waterfall('agent/session-start', [{ agent: child }], undefined)
      return { childId: child.id }
    }, originalScope)
    assert.equal(receipt.childId, child.id)
    assert.equal(existsSync(join(workspace, 'expert-teams', 'team-fixture', 'team.json')), false)
    assert.equal(fixture.guards.length, 0)
    // Caller mutation after admission must not widen the retained snapshot.
    originalScope.allowedTools.push('subagent', 'run_code', ...(allowed.length ? [] : ['bash']))
    selection.provider = 'wrong-default-provider'
    const assembled = fixture.waterfall('system-prompt/assemble', [assembly, {}], assembly)
    mount(fixture.ctx)
    const result = await assembled
    assert.equal(result.variables.provider, 'fixture-provider')
    assert.equal(result.variables.model, 'fixture-model')
    assert.deepEqual(result.tools.map(x => x.name), allowed.length ? ['bash', 'read', 'write', 'expert_teams_wait'] : ['expert_teams_wait'])
    assert.match(fixture.guards[0]({ name: 'subagent' }), /delegation/)
    assert.match(fixture.guards[0]({ name: 'run_code' }), /capability scope/)
    if (!allowed.length) assert.match(fixture.guards[0]({ name: 'bash' }), /capability scope/)
    const boot = message(memberBootstrapPrompt(child.id))
    assert.deepEqual(await fixture.waterfall('agent/pre-step', [{ messages: [boot] }], { kind: 'enter', messages: [boot] }),
      { kind: 'enter', messages: [] })
  })
}

test('pending admission is bound to child, parent and label, and is consumed exactly once', async t => {
  const f = provisioningFixture(t)
  await f.runtime.withPending(f.identity, f.selection, async () => 'admitted', scope([]))
  for (const child of [
    { ...f.child, id: 'other-child' },
    { ...f.child, session: { ...f.child.session, header: { ...f.child.session.header, parentSession: 'other-captain' } } },
    { ...f.child, session: { ...f.child.session, ownEvents: () => [{ type: 'subagent/descriptor', data: { ...f.descriptor, label: 'expert-teams:other-team:worker' } }] } },
  ]) {
    const rejected = context(child)
    assert.throws(() => f.setup(rejected.ctx), /identity mismatch|durable member capability boundary/)
    assert.equal(rejected.guards.length, 0)
  }
  const accepted = context(f.child)
  const dispose = f.setup(accepted.ctx)
  assert.match(accepted.guards[0]({ name: 'bash' }), /capability scope/)
  dispose()
  assert.throws(() => f.setup(context(f.child).ctx), /durable member capability boundary/)
})

test('failed admission and cancellation never leave a usable pending grant', async t => {
  const f = provisioningFixture(t)
  await assert.rejects(f.runtime.withPending(f.identity, f.selection, async () => { throw new Error('start failed') }, scope([])), /start failed/)
  assert.throws(() => f.setup(context(f.child).ctx), /durable member capability boundary/)
  const controller = new AbortController()
  await f.runtime.withPending(f.identity, f.selection, async () => 'admitted', scope([]), controller.signal)
  controller.abort(new Error('captain cancelled'))
  assert.throws(() => f.setup(context(f.child).ctx), /durable member capability boundary/)
  let entered = false
  await assert.rejects(f.runtime.withPending(f.identity, f.selection, async () => { entered = true }, scope([]), controller.signal), /captain cancelled/)
  assert.equal(entered, false)
})

test('pending children with the same label cannot overwrite or borrow one another scopes', async t => {
  const f = provisioningFixture(t)
  await f.runtime.withPending(f.identity, f.selection, async () => 'admitted', scope(['read']))
  let overwritten = false
  await assert.rejects(f.runtime.withPending(f.identity, f.selection, async () => { overwritten = true }, scope(['bash'])), /already pending/)
  assert.equal(overwritten, false)
  const otherIdentity = { ...f.identity, childSessionId: 'other-child' }
  await f.runtime.withPending(otherIdentity, f.selection, async () => 'admitted', scope([]))
  const first = context(f.child)
  const second = context({ ...f.child, id: otherIdentity.childSessionId })
  const cleanFirst = f.setup(first.ctx)
  const cleanSecond = f.setup(second.ctx)
  assert.equal(first.guards[0]({ name: 'read' }), undefined)
  assert.match(first.guards[0]({ name: 'bash' }), /capability scope/)
  assert.match(second.guards[0]({ name: 'read' }), /capability scope/)
  cleanFirst()
  cleanSecond()
})

test('failed scoped setup releases the admission instead of allowing an unbounded retry', async t => {
  const f = provisioningFixture(t)
  await f.runtime.withPending(f.identity, f.selection, async () => 'admitted', scope([]))
  const broken = context(f.child)
  broken.ctx.tools = {}
  assert.throws(() => f.setup(broken.ctx), /monotonic tools.guard/)
  assert.throws(() => f.setup(context(f.child).ctx), /durable member capability boundary/)
  await f.runtime.withPending(f.identity, f.selection, async () => 'admitted', scope([]))
  const mismatch = context({ ...f.child, session: { ...f.child.session,
    ownEvents: () => [{ type: 'subagent/descriptor', data: { ...f.descriptor, agentModel: 'wrong-model' } }] } })
  assert.throws(() => f.setup(mismatch.ctx), /saved model route/)
  assert.throws(() => f.setup(context(f.child).ctx), /durable member capability boundary/)
})

test('unconsumed provisioning expires and plugin disposal revokes remaining admissions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = provisioningFixture(t)
  await f.runtime.withPending(f.identity, f.selection, async () => 'admitted', scope([]))
  t.mock.timers.tick(MEMBER_PENDING_SETUP_TIMEOUT_MS)
  assert.throws(() => f.setup(context(f.child).ctx), /durable member capability boundary/)
  await f.runtime.withPending(f.identity, f.selection, async () => 'admitted', scope([]))
  f.parent.dispose()
  assert.throws(() => f.setup(context(f.child).ctx), /durable member capability boundary/)
  await assert.rejects(f.runtime.withPending(f.identity, f.selection, async () => 'admitted', scope([])), /runtime was disposed/)
})

function sharedApplication(t) {
  const root = context()
  root.ctx.root = root.ctx
  const setups = new Set()
  const stats = { registrations: 0, disposals: 0 }
  root.ctx.subagents = { registerContinuableSetup(fn) {
    stats.registrations++
    setups.add(fn)
    return () => { if (setups.delete(fn)) stats.disposals++ }
  } }
  const owners = []
  t.after(() => { for (const owner of owners) owner.dispose(); root.dispose() })
  return {
    root, setups, stats,
    owner(stateDir = 'expert-teams') {
      const fixture = context()
      fixture.ctx.root = root.ctx
      fixture.runtime = installMemberSelectionRuntime(fixture.ctx, stateDir)
      owners.push(fixture)
      return fixture
    },
    setup(ctx) {
      assert.equal(setups.size, 1, 'one application has exactly one child setup registration')
      return [...setups][0](ctx)
    },
  }
}

test('host and preset owners share one setup; preset disposal does not revoke host or installed child boundaries', async t => {
  const f = provisioningFixture(t)
  const app = sharedApplication(t)
  const host = app.owner()
  const preset = app.owner()
  assert.equal(app.stats.registrations, 1)
  assert.equal(app.root.hookCount('agent/pre-step'), 1)
  await preset.runtime.withPending(f.identity, f.selection, async () => 'admitted', scope([]))
  const child = context(f.child)
  const teardown = app.setup(child.ctx)
  preset.dispose()
  assert.equal(app.setups.size, 1)
  assert.match(child.guards[0]({ name: 'bash' }), /capability scope/)
  const nextIdentity = { ...f.identity, childSessionId: 'host-admitted-child' }
  await host.runtime.withPending(nextIdentity, f.selection, async () => 'admitted', scope(['read']))
  const second = context({ ...f.child, id: nextIdentity.childSessionId })
  const teardownSecond = app.setup(second.ctx)
  assert.equal(second.guards[0]({ name: 'read' }), undefined)
  teardown()
  teardownSecond()
  host.dispose()
  assert.equal(app.setups.size, 0)
  assert.equal(app.root.hookCount('agent/pre-step'), 0)
  assert.equal(app.stats.disposals, 1)
  // Re-mount starts one new coordinator, without a retained legacy hook.
  const replacement = app.owner()
  assert.equal(app.stats.registrations, 2)
  assert.equal(app.setups.size, 1)
  replacement.dispose()
  assert.equal(app.stats.disposals, 2)
})

test('owner cancellation revokes only its admissions and application roots never share pending state', async t => {
  const f = provisioningFixture(t)
  const app = sharedApplication(t)
  const otherApp = sharedApplication(t)
  const host = app.owner()
  const preset = app.owner()
  otherApp.owner()
  await host.runtime.withPending(f.identity, f.selection, async () => 'admitted', scope(['read']))
  const secondIdentity = { ...f.identity, childSessionId: 'preset-child' }
  await preset.runtime.withPending(secondIdentity, f.selection, async () => 'admitted', scope([]))
  assert.throws(() => otherApp.setup(context(f.child).ctx), /durable member capability boundary/)
  preset.dispose()
  assert.throws(() => app.setup(context({ ...f.child, id: secondIdentity.childSessionId }).ctx), /durable member capability boundary/)
  const accepted = context(f.child)
  const dispose = app.setup(accepted.ctx)
  assert.equal(accepted.guards[0]({ name: 'read' }), undefined)
  dispose()
})

test('cold recovery requires one exact identity across explicitly registered state roots', async t => {
  const f = provisioningFixture(t)
  const app = sharedApplication(t)
  app.owner('host-teams')
  const preset = app.owner('preset-teams')
  const team = {
    id: 'team-fixture', name: 'team-fixture', captainSessionId: f.identity.parentSessionId, createdAt: 1, taskSeq: 0, tasks: [],
    members: [{ id: f.child.id, name: 'worker', joinedAt: 1, status: 'idle', ...f.selection, capabilityScope: scope([]) }],
  }
  const put = (dir, value) => {
    const folder = join(f.workspace, dir, 'team-fixture')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'team.json'), JSON.stringify(value))
  }
  put('host-teams', { ...team, captainSessionId: 'another-captain' })
  put('preset-teams', team)
  const exact = context(f.child)
  const stop = app.setup(exact.ctx)
  assert.match(exact.guards[0]({ name: 'read' }), /capability scope/)
  stop()
  put('host-teams', { ...team, members: [{ ...team.members[0], capabilityScope: scope(['bash']) }] })
  assert.throws(() => app.setup(context(f.child).ctx), /ambiguous durable member capability boundary/)
  // Removing a scope owner stops cold recovery from consulting its directory.
  preset.dispose()
  const remaining = context(f.child)
  const stopRemaining = app.setup(remaining.ctx)
  assert.equal(remaining.guards[0]({ name: 'bash' }), undefined)
  stopRemaining()
})

test('current Host dual installation contributes a single lifecycle barrier for the same Agent', async t => {
  const f = provisioningFixture(t)
  const root = context()
  root.ctx.root = root.ctx
  root.ctx.subagents = {}
  root.ctx.logger = { warn() {} }
  const host = context()
  const preset = context()
  host.ctx.root = root.ctx
  preset.ctx.root = root.ctx
  installMemberSelectionRuntime(host.ctx, 'expert-teams')
  const runtime = installMemberSelectionRuntime(preset.ctx, 'expert-teams')
  const fixture = context()
  let mount, mounts = 0
  Object.assign(fixture.ctx, {
    inject(_deps, callback) { mounts++; mount = callback; return { dispose() {} } },
    extend(meta) { return Object.assign(Object.create(this), meta) },
    systemPrompt: { assemble(value) { return fixture.waterfall('system-prompt/assemble', [assembly, value], assembly) } },
  })
  const child = { ...f.child, ctx: fixture.ctx }
  const assembly = { tools: [{ name: 'read' }, { name: 'subagent' }], variables: {}, sections: [], contexts: [] }
  t.after(() => { fixture.dispose(); preset.dispose(); host.dispose(); root.dispose() })
  assert.equal(root.hookCount('agent/session-start'), 1)
  await runtime.withPending(f.identity, f.selection, async () => {
    await root.waterfall('agent/session-start', [{ agent: child }], undefined)
    await root.waterfall('agent/session-start', [{ agent: child }], undefined)
    return 'admitted'
  }, scope(['read']))
  assert.equal(mounts, 1)
  const waiting = fixture.waterfall('system-prompt/assemble', [assembly, {}], assembly)
  mount(fixture.ctx)
  assert.deepEqual((await waiting).tools.map(tool => tool.name), ['read'])
  assert.equal(fixture.guards.length, 1)
  preset.dispose()
  assert.equal(root.hookCount('agent/session-start'), 1)
  assert.match(fixture.guards[0]({ name: 'subagent' }), /delegation/)
  host.dispose()
  assert.equal(root.hookCount('agent/session-start'), 0)
})

test('legacy setup registration must expose its actual disposal contract', () => {
  let disposed = 0
  const stop = installContinuableMemberSetup({ subagents: { registerContinuableSetup() { return () => { disposed++ } } } }, () => () => {})
  stop()
  assert.equal(disposed, 1)
  assert.throws(() => installContinuableMemberSetup({ subagents: { registerContinuableSetup() {} } }, () => () => {}), /has no disposer/)
})
