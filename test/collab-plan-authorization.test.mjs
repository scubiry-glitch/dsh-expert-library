/** Registered collaboration APIs against durable plans and synthetic domain materials.
 * No real business data, provider calls or production sessions. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerExpertTeamsTools, scenarioApproveCore, scenarioApproveFromHost, scenarioEditCore } from '../lib/tools.js'
import { registerCollabTools } from '../lib/collab/tools.js'
import { authorizePlanExecution, readPlanExecutionAuthorization, planInputSha256 } from '../lib/plan-authorization.js'
import { captureSharedTaskContext } from '../lib/shared-task-context.js'
import { readStagedPlan } from '../lib/staged-plan.js'
import { planToWire } from '../lib/team-wire.js'
import { createInstalledSkillCraftPack } from './support/skill-craft-fixture.mjs'

async function fixture(t, specs) {
  const workspace = await mkdtemp(join(tmpdir(), 'collab-approval-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const selected = await createInstalledSkillCraftPack(join(workspace, 'domain-packs', 'fixture-policy'), { packId: 'fixture-policy', ...(specs ? { skills: specs } : {}) })
  const registered = new Map(), starts = [], deliveries = [], routes = []
  const events = [{ type: 'user/message', seq: 1, data: { id: 'original', source: { kind: 'user' }, content: [{ type: 'text', text: 'Research this synthetic topic using the selected workflow.' }] } }]
  const captain = { id: 'captain-id', options: { provider: 'test', model: 'captain-model' }, session: { id: 'captain-id', header: { id: 'captain-id', cwd: workspace }, requestHeader: () => ({ config: { provider: 'test', model: 'captain-model' } }), events, append() {} } }
  let goal = { id: 'synthetic-goal', revision: 1, phase: 'active', activation: 'armed' }, pauses = 0, resumes = 0, concludes = 0
  const goals = { get: () => goal,
    pause(_agent, ref) { assert.equal(ref.revision, goal.revision); pauses++; return goal = { ...goal, revision: goal.revision + 1, phase: 'paused', activation: 'disarmed' } },
    resume(_agent, ref) { assert.equal(ref.revision, goal.revision); resumes++; return goal = { ...goal, revision: goal.revision + 1, phase: 'active', activation: 'armed' } } }
  const ctx = {
    tools: { register(tool) { registered.set(tool.name, tool) } }, logger: { debug() {}, info() {}, warn() {} },
    agents: { get: () => undefined, withInitiator: (_agent, action) => action() },
    llm: { resolveCallConfig: async config => { routes.push(config); return config } },
    subagents: { registerContinuableSetup() { return () => undefined }, list: () => ['spawn'], listChildren: async () => [], listDescendants: async () => [],
      getProvider: () => ({ prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }),
      async startContinuable(input) { starts.push(input); return { childId: input.childId } }, followup: async (...args) => deliveries.push(args), interrupt() {} },
    effect() {}, on() {}, get: name => name === 'goals' ? goals : name === 'sessions' ? { list: () => [captain.session], get: id => id === captain.id ? captain.session : undefined, flush: async () => true } : undefined,
  }
  const expertModelOverrides = Object.fromEntries(['researcher', 'data-analyst', 'docs-coordinator', 'team-lead'].map(id => [id, { provider: 'test', model: `configured-${id}` }]))
  const config = { stateDir: '.expert-teams', memberProvider: 'spawn', maxMembers: 8, knowledgeDir: 'knowledge', packsDir: 'domain-packs', enabledPacks: ['fixture-policy'], expertModelOverrides }
  const core = registerExpertTeamsTools(ctx, config)
  registerCollabTools(ctx, config, core)
  const stateRoot = join(workspace, config.stateDir)
  const bundle = { md: 'final.md', html: 'final.html', pdf: 'final.pdf', craft: { version: 3, selections: selected.selections, evidence: 'proof.json' } }
  const exec = { agent: captain, session: captain.session, signal: new AbortController().signal, concludeTurn() { concludes++ } }
  const call = (mode, args) => registered.get(`expert_teams_${mode}`).execute(args, exec)
  const counts = () => ({ pauses, resumes, concludes, goal })
  return { ...selected, workspace, stateRoot, registered, starts, deliveries, routes, ctx, config, captain, core, bundle, call, counts }
}
const cases = [
  ['debate', () => ({ topic: 'Synthetic topic', pro_expert: 'researcher', con_expert: 'data-analyst' })],
  ['roundtable', () => ({ topic: 'Synthetic topic', experts: ['researcher', 'data-analyst'] })],
  ['ppt', () => ({ topic: 'Synthetic topic', content_experts: ['researcher'] })],
  ['report', f => ({ topic: 'Synthetic topic', experts: ['researcher', 'data-analyst'], report_bundle: f.bundle })],
]
const approve = (f, plan, host = true) => (host ? scenarioApproveFromHost : scenarioApproveCore)(f.ctx, f.config, f.captain, plan.planId, new AbortController().signal, f.core, plan.digest, plan.revision)
async function grant(f) {
  const context = captureSharedTaskContext(f.captain)
  return authorizePlanExecution(f.stateRoot, f.captain.id, context, { requestId: 'authenticated-user-request', expectedInputSha256: planInputSha256(context), reason: 'Explicit user permission for this synthetic execution.', scope: 'single-plan-for-direct-user-input' })
}

for (const [mode, makeArgs] of cases) {
  test(`${mode}: default and forged authority persist waiting, pause Goal and create no team; user approval preserves frozen routes`, async t => {
    const f = await fixture(t), args = { ...makeArgs(f), user_approved: true, authority: 'authenticated-host-user' }
    const result = await f.call(mode, args)
    assert.equal(result.status, 'waiting_user')
    assert.equal(result.team_id, undefined)
    assert.deepEqual(result.members, [])
    assert.deepEqual(result.tasks, [])
    assert.equal(f.starts.length, 0)
    assert.equal(f.deliveries.length, 0)
    assert.deepEqual((await readdir(f.stateRoot)).filter(name => name !== 'plans'), [])
    assert.deepEqual([f.counts().pauses, f.counts().concludes, f.counts().goal.phase], [1, 1, 'paused'])
    const rendered = f.registered.get(`expert_teams_${mode}`).output.render(args, result).map(part => part.text).join('\n')
    assert.match(rendered, /等待用户确认/)
    assert.doesNotMatch(rendered, /团队已组建/)
    const plan = await readStagedPlan(f.stateRoot, result.plan_id)
    assert.equal(plan.waitingFor, 'user-confirmation')
    assert.equal(plan.request.compiled_source.startsWith('collab.'), true)
    for (const member of plan.plan.roster) {
      assert.equal(member.modelPolicy.model, `configured-${member.expertId}`)
      assert.equal(member.modelRouteSource, 'expert-override')
      assert.equal(member.modelRouteFrozen, true)
    }
    assert.ok(planToWire(plan).preview.members.every(member => member.routeSource === 'expert-override'))
    await approve(f, plan, false)
    assert.equal(f.starts.length, 0)
    assert.equal(f.counts().pauses, 1)
    for (const override of Object.values(f.config.expertModelOverrides)) override.model = 'changed-after-preview'
    const done = await approve(f, plan)
    assert.equal(done.approval.source, 'authenticated-host-user')
    const team = JSON.parse(await readFile(join(f.stateRoot, done.appliedTeamId, 'team.json'), 'utf8'))
    const expectedMembers = new Map(plan.plan.roster.map(member => [member.expertId, member.modelPolicy.model]))
    assert.deepEqual(team.members.map(member => member.model), [...expectedMembers.values()])
    assert.equal(f.counts().resumes, 1)
    await approve(f, plan)
    assert.equal(f.starts.length, expectedMembers.size, 'approval replay must not create more members')
  })

  test(`${mode}: exact-input authenticated Host grant authorizes the same staged path`, async t => {
    const f = await fixture(t)
    await grant(f)
    const result = await f.call(mode, makeArgs(f))
    assert.equal(result.status, 'applied')
    assert.ok(result.team_id)
    assert.ok(result.members.length > 0)
    assert.equal(f.starts.length, result.members.length)
    assert.equal(f.counts().concludes, 0)
    const plan = await readStagedPlan(f.stateRoot, result.plan_id)
    const authorization = await readPlanExecutionAuthorization(f.stateRoot, f.captain.id)
    assert.equal(plan.approval.source, 'delegated-host-authorization')
    assert.equal(authorization.consumed.planId, plan.planId)
    assert.equal(authorization.consumed.digest, plan.digest)
    assert.equal(authorization.consumed.revision, plan.revision)
  })
}

test('report rejects absent, malformed and legacy contracts before any plan/team/member writes', async t => {
  for (const report_bundle of [undefined, { md: 'bad.md' }, { md: 'final.md', html: 'final.html', pdf: 'final.pdf', craft: { version: 2, style: 'designer-paper', evidence: 'proof.json' } }]) {
    const f = await fixture(t)
    await assert.rejects(f.call('report', { topic: 'Synthetic topic', experts: ['researcher'], ...(report_bundle ? { report_bundle } : {}) }), /REPORT_SKILL_SELECTION_REQUIRED|report_bundle/)
    assert.equal(f.starts.length, 0)
    assert.deepEqual(await readdir(f.stateRoot).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), [])
  }
})

test('single and multi expert reports bind the exact selected pack to the final producer and quality run', async t => {
  for (const experts of [['researcher'], ['researcher', 'data-analyst']]) {
    const f = await fixture(t), result = await f.call('report', { topic: 'Synthetic topic', experts, report_bundle: f.bundle })
    const plan = await readStagedPlan(f.stateRoot, result.plan_id)
    const bound = plan.plan.tasks.filter(task => task.reportBundle !== undefined)
    assert.equal(bound.length, 1)
    assert.equal(bound[0].id, experts.length === 1 ? 't3' : 't4')
    assert.deepEqual(bound[0].reportBundle, f.bundle)
    assert.deepEqual(bound[0].frozenSkillCraftContract.packs.map(pack => pack.packId), ['fixture-policy'])
    await assert.rejects(scenarioEditCore(f.ctx, f.config, f.captain, plan.planId, { goal: 'Different' }, plan.digest, plan.revision), /Discard.*restage/)
    const done = await approve(f, plan)
    const team = JSON.parse(await readFile(join(f.stateRoot, done.appliedTeamId, 'team.json'), 'utf8'))
    const finalTask = team.tasks.find(task => task.planTask.logicalId === bound[0].id)
    assert.deepEqual(finalTask.reportBundle, f.bundle)
    assert.deepEqual(team.qualityRuns[finalTask.id].contract.artifactChecks[0].selection, bound[0].frozenSkillCraftContract)
    assert.equal(team.qualityRuns[finalTask.id].status, 'pending')
  }
})

test('report refuses partial skill coverage and changed selected pack bytes without implicit extra selection', async t => {
  const partial = await fixture(t, [{ id: 'writer-only', artifactRoles: ['md', 'evidence'] }])
  await assert.rejects(partial.call('report', { topic: 'Synthetic topic', experts: ['researcher'], report_bundle: partial.bundle }), /OUTPUT_COVERAGE/)
  assert.equal(partial.starts.length, 0)
  const f = await fixture(t), result = await f.call('report', { topic: 'Synthetic topic', experts: ['researcher'], report_bundle: f.bundle })
  const plan = await readStagedPlan(f.stateRoot, result.plan_id)
  await writeFile(join(f.root, 'references', 'compose.md'), 'Modified after the reviewable draft.')
  await assert.rejects(approve(f, plan), /DRIFT|CONTRACT_CHANGED/)
  assert.equal(f.starts.length, 0)
  assert.equal((await readStagedPlan(f.stateRoot, result.plan_id)).status, 'staged')
})


test('PPT keeps an explicitly requested legacy skill as a labelled reference, without claiming report admission', async t => {
  const f = await fixture(t)
  const result = await f.call('ppt', { topic: 'Synthetic topic', content_experts: ['researcher'], skill_id: 'not-installed-synthetic-skill' })
  assert.equal(result.status, 'waiting_user')
  const plan = await readStagedPlan(f.stateRoot, result.plan_id)
  assert.match(plan.runtime.description, /兼容 skill 引用（仅参考，不是领域包报告质量合同）/)
  assert.match(plan.runtime.description, /not-installed-synthetic-skill/)
  assert.ok(plan.plan.tasks.every(task => task.reportBundle === undefined))
  assert.equal(f.starts.length, 0)
})
