/** Independent regression cases for ordinary plan lifecycle races and isolation. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerExpertTeamsTools, scenarioStageCore, scenarioApproveCore, scenarioApproveFromHost, scenarioDiscardCore } from '../lib/tools.js'
import { readStagedPlan } from '../lib/staged-plan.js'

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'independent-plan-boundary-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const starts = [], agents = new Map()
  const agent = id => ({ id, options: { provider: 'test', model: 'm' }, session: { id, header: { id, cwd: workspace }, requestHeader: () => ({ config: { provider: 'test', model: 'm' } }),
    events: [{ type: 'user/message', seq: 1, data: { id: `message-${id}`, source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic original user request' }] } }], append() {} } })
  const captain = agent('captain-a'); agents.set(captain.id, captain)
  const ctx = { tools: { register() {} }, logger: { debug() {}, info() {}, warn() {} }, agents: { get: id => agents.get(id), withInitiator: (_a, action) => action() },
    llm: { resolveCallConfig: async config => config },
    subagents: { registerContinuableSetup() { return () => undefined }, list: () => ['spawn'], listChildren: async () => [], listDescendants: async () => [],
      getProvider: () => ({ prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }),
      async startContinuable(input) { starts.push(input); return { childId: input.childId } }, async followup() {}, interrupt() {} }, effect() {}, on() {}, get() { return undefined } }
  const config = { stateDir: '.expert-teams', memberProvider: 'spawn', maxMembers: 8, knowledgeDir: 'knowledge', packsDir: 'domain-packs' }, core = registerExpertTeamsTools(ctx, config)
  return { workspace, stateRoot: join(workspace, config.stateDir), starts, agents, agent, captain, ctx, config, core }
}
const profile = { schemaVersion: 1, id: 'boundary', version: '1', description: 'Research task', protocol: [], taskPlanning: 'seed', members: [{ id: 'writer', name: 'Writer', expert: 'researcher' }], tasks: [{ id: 'draft', subject: 'Draft', owner: 'writer' }] }
const stage = (f, args = { profile }, captain = f.captain) => scenarioStageCore(f.ctx, f.config, captain, args)
const approve = (f, plan, host) => (host ? scenarioApproveFromHost : scenarioApproveCore)(f.ctx, f.config, f.captain, plan.planId, new AbortController().signal, f.core, plan.digest, plan.revision)

test('concurrent model call cannot treat a still-live Host approval as an interrupted apply', async t => {
  const f = await fixture(t), plan = await stage(f)
  let release, entered
  const blocked = new Promise(resolve => { release = resolve })
  const spawnEntered = new Promise(resolve => { entered = resolve })
  f.ctx.subagents.startContinuable = async input => { f.starts.push(input); entered(); await blocked; return { childId: input.childId } }
  const first = approve(f, plan, true)
  const hostResult = first.then(value => ({ value }), error => ({ error }))
  await spawnEntered
  const second = approve(f, plan, false)
  const modelResult = second.then(value => ({ value }), error => ({ error }))
  // Let the second approval reach its durable reservation while the actual
  // owner's spawn is blocked. The explicit live handle is still first.
  await new Promise(resolve => setTimeout(resolve, 50))
  const during = await readStagedPlan(f.stateRoot, plan.planId)
  release()
  const [host, model] = await Promise.all([hostResult, modelResult])
  assert.notEqual(during.status, 'failed', 'an unprivileged concurrent call must not mark a live operation crashed')
  assert.equal(host.error, undefined)
  assert.equal(host.value.status, 'completed')
  assert.equal(f.starts.length, 1)
  assert.notEqual((await readStagedPlan(f.stateRoot, plan.planId)).status, 'failed')
  // The second call may fail authorization or share the completed outcome;
  // it must not mutate the first caller's receipt into failure.
  assert.ok(model.error === undefined || !/interrupted before apply/.test(String(model.error)))
})

test('two captains in one workspace can independently review the same preset', async t => {
  const f = await fixture(t), first = await stage(f)
  const other = f.agent('captain-b'); f.agents.set(other.id, other)
  const second = await stage(f, { profile }, other)
  assert.notEqual(second.planId, first.planId)
  assert.equal(second.createdBy, other.id)
  assert.equal(first.createdBy, f.captain.id)
  assert.equal(f.starts.length, 0)
})

test('legacy preset can be staged after discard for a new explicit team and task goal', async t => {
  const f = await fixture(t)
  const first = await stage(f, { scenario: 'market-research', team_name: 'draft-one', goal: 'First research question' })
  await scenarioDiscardCore(f.config, f.captain, first.planId, first.digest, first.revision)
  const second = await stage(f, { scenario: 'market-research', team_name: 'draft-two', goal: 'Second research question' })
  assert.notEqual(second.planId, first.planId)
  assert.equal((await readStagedPlan(f.stateRoot, first.planId)).status, 'discarded')
  assert.equal(second.waitingFor, 'user-confirmation')
  assert.equal(f.starts.length, 0)
})

test('a Host approval following an in-flight unprivileged check still performs its own authenticated transition', async t => {
  const f = await fixture(t), plan = await stage(f)
  let release, entered, once = false
  const blocked = new Promise(resolve => { release = resolve })
  const validationEntered = new Promise(resolve => { entered = resolve })
  f.ctx.llm.resolveCallConfig = async config => { if (!once) { once = true; entered(); await blocked } return config }
  const modelCall = approve(f, plan, false)
  const modelResult = modelCall.then(value => ({ value }), error => ({ error }))
  await validationEntered
  const hostCall = approve(f, plan, true)
  const hostResult = hostCall.then(value => ({ value }), error => ({ error }))
  release()
  const [model, host] = await Promise.all([modelResult, hostResult])
  assert.equal(model.error, undefined)
  assert.equal(model.value.status, 'staged')
  assert.equal(host.error, undefined)
  assert.equal(host.value.status, 'completed')
  assert.equal(host.value.approval.source, 'authenticated-host-user')
  assert.equal(f.starts.length, 1)
})

test('discard then restage retains exact ownership of a plan-induced Goal pause until the replacement is approved', async t => {
  const f = await fixture(t)
  let goal = { id: 'same-goal', revision: 1, phase: 'active', activation: 'armed' }, resumes = 0
  const goals = { get: () => goal,
    pause(_agent, ref) { assert.equal(ref.revision, goal.revision); return goal = { ...goal, revision: goal.revision + 1, phase: 'paused', activation: 'disarmed' } },
    resume(_agent, ref) { assert.equal(ref.revision, goal.revision); resumes++; return goal = { ...goal, revision: goal.revision + 1, phase: 'active', activation: 'armed' } } }
  f.ctx.get = name => name === 'goals' ? goals : name === 'sessions' ? { list: () => [f.captain.session], flush: async () => true } : undefined
  const original = await stage(f, { profile, team_name: 'first-draft' })
  assert.equal(goal.phase, 'paused')
  await scenarioDiscardCore(f.config, f.captain, original.planId, original.digest, original.revision)
  const replacement = await stage(f, { profile, team_name: 'replacement-draft', goal: 'Revised synthetic request' })
  assert.equal(goal.phase, 'paused', 'discard/restage must not start uncontrolled Goal polling')
  const applied = await approve(f, replacement, true)
  assert.equal(applied.status, 'completed')
  assert.equal(goal.phase, 'active', 'approval must restore the Goal paused by the superseded plan')
  assert.equal(resumes, 1)
})

test('restaging must not restore a Goal whose plan-induced pause was manually changed', async t => {
  const f = await fixture(t)
  let goal = { id: 'same-goal', revision: 1, phase: 'active', activation: 'armed' }, resumes = 0
  const goals = { get: () => goal,
    pause(_agent, ref) { assert.equal(ref.revision, goal.revision); return goal = { ...goal, revision: goal.revision + 1, phase: 'paused', activation: 'disarmed' } },
    resume(_agent, ref) { assert.equal(ref.revision, goal.revision); resumes++; return goal = { ...goal, revision: goal.revision + 1, phase: 'active', activation: 'armed' } } }
  f.ctx.get = name => name === 'goals' ? goals : name === 'sessions' ? { list: () => [f.captain.session], flush: async () => true } : undefined
  const original = await stage(f, { profile, team_name: 'first-draft' })
  goal = { ...goal, revision: goal.revision + 1 } // A later human operation owns this pause.
  await scenarioDiscardCore(f.config, f.captain, original.planId, original.digest, original.revision)
  const replacement = await stage(f, { profile, team_name: 'replacement-draft', goal: 'Revised synthetic request' })
  await approve(f, replacement, true)
  assert.equal(goal.phase, 'paused')
  assert.equal(resumes, 0)
})
