import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateArgs } from '@deepseek-ai/dsh-tools'
import { authorizePlanExecution, planInputSha256 } from '../lib/plan-authorization.js'
import { captureSharedTaskContext } from '../lib/shared-task-context.js'
import { registerExpertTeamsTools, scenarioStageCore, scenarioEditCore, scenarioApproveFromHost, scenarioDiscardCore } from '../lib/tools.js'
import { parseProfile, profileToExecutionPlan } from '../lib/profiles.js'
import { PROFILE_SCHEMA, PROFILE_TASKS_SCHEMA, PROFILE_STAGE_EXAMPLE } from '../lib/profile-schema.js'
import { applyExecutionPlan, expandExecutionPlan } from '../lib/apply.js'
import { validateAcceptanceResults } from '../lib/quality-run.js'
import { createStagedPlan, readStagedPlan, transitionStagedPlan, writeStagedPlan } from '../lib/staged-plan.js'

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'profile-planning-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const tools = new Map(), starts = [], deliveries = []
  const captain = { id: 'captain-id', options: { provider: 'test', model: 'm' }, session: { id: 'captain-id', header: { cwd: workspace }, requestHeader: () => ({ config: { provider: 'test', model: 'm' } }), events: [{ type: 'user/message', seq: 1, data: { id: 'fixture-user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Authorized isolated engineering fixture' }] } }], append() {} } }
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool) } },
    logger: { debug() {}, info() {}, warn() {} }, agents: { get: () => undefined },
    llm: { resolveCallConfig: async config => config },
    subagents: {
      registerContinuableSetup() { return () => undefined }, list: () => ['spawn'], listChildren: async () => [], listDescendants: async () => [],
      getProvider: () => ({ prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }),
      async startContinuable(input) { starts.push(input); return { childId: input.childId } },
      followup: async (...args) => { deliveries.push(args) }, interrupt() {},
    }, effect() {}, on() {},
  }
  const config = { stateDir: '.expert-teams', memberProvider: 'spawn', maxMembers: 8, knowledgeDir: 'knowledge', packsDir: 'domain-packs' }
  const core = registerExpertTeamsTools(ctx, config)
  const context = captureSharedTaskContext(captain)
  await authorizePlanExecution(join(workspace, config.stateDir), captain.id, context, { requestId: 'fixture-authorization', expectedInputSha256: planInputSha256(context), reason: 'Explicit isolated test authorization', scope: 'single-plan-for-direct-user-input' })
  return { workspace, stateRoot: join(workspace, config.stateDir), ctx, config, captain, tools, starts, deliveries, core }
}

function profile(overrides = {}) {
  return { schemaVersion: 1, id: 'same-expert', version: '1', description: 'Review evidence independently', protocol: [], taskPlanning: 'seed',
    members: [{ id: 'author', name: 'Author', expert: 'researcher', role: 'author', route: { provider: 'test', model: 'author-model' } }, { id: 'reviewer', name: 'Reviewer', expert: 'researcher', role: 'reviewer', route: { provider: 'test', model: 'review-model' } }],
    tasks: [{ id: 'draft', subject: 'Draft', owner: 'author', acceptance: ['Each factual claim cites a source'] }, { id: 'revise', subject: 'Revise', owner: 'Author', dependsOn: ['draft'] }, { id: 'review', subject: 'Review', owner: 'reviewer', dependsOn: ['revise'] }],
    ...overrides }
}

test('all three registered profile tools expose the same complete strict nested wire schema and valid example', async t => {
  const f = await fixture(t)
  for (const name of ['preview', 'stage', 'edit']) {
    const definition = f.tools.get(`expert_teams_plan_${name}`)
    const properties = definition.parameters.properties
    assert.equal(properties.profile.additionalProperties, false)
    assert.deepEqual(properties.profile.required, ['schemaVersion', 'id', 'version', 'description', 'protocol', 'members', 'taskPlanning'])
    assert.equal(properties.profile.properties.schemaVersion.const, 1)
    const route = properties.profile.properties.members.items.properties.route
    assert.deepEqual(route.required, ['provider', 'model'])
    assert.equal(route.additionalProperties, false)
    assert.equal(properties.tasks.items.additionalProperties, false)
    assert.ok(properties.tasks.items.properties.dependsOn)
    assert.equal(properties.tasks.items.properties.dependencies.type, 'array')
    assert.equal(properties.tasks.items.properties.dependencies.items.type, 'string')
    const args = structuredClone(PROFILE_STAGE_EXAMPLE)
    if (name === 'edit') Object.assign(args, { plan_id: 'p', expected_digest: 'd', expected_revision: 0 })
    assert.deepEqual(validateArgs({ profile: PROFILE_SCHEMA, tasks: PROFILE_TASKS_SCHEMA }, args), [])
  }
  assert.equal(f.starts.length, 0)
})

test('validation still rejects unrelated field aliases, incomplete routes and missing metadata', () => {
  assert.throws(() => parseProfile({ ...profile(), roster: [], reviewPolicy: {} }), /use members instead of roster.*use review instead of reviewPolicy/s)
  assert.throws(() => parseProfile({ ...profile(), members: [{ id: 'x', name: 'X', route: { provider: 'test' } }] }), /route.model.*both provider and model inside/s)
  assert.throws(() => parseProfile({ ...profile(), tasks: [{ id: 't', subject: 'T', depends_on: [] }] }), /unknown profile field/)
  assert.throws(() => parseProfile({ ...profile(), schemaVersion: undefined }), /schemaVersion must be 1.*Valid captain call shape/s)
})

test('shared expert personas keep independent runtime members and repeated task owners', () => {
  const input = parseProfile(profile())
  const plan = profileToExecutionPlan(input)
  const expanded = expandExecutionPlan(plan, { teamName: 'T', description: 'G', memberOrder: input.members.map(m => m.id) })
  assert.deepEqual(expanded.members.map(m => [m.expertId, m.sourceExpertId, m.role, m.modelPolicy.model]), [['author', 'researcher', 'author', 'author-model'], ['reviewer', 'researcher', 'reviewer', 'review-model']])
  assert.deepEqual(expanded.tasks.map(t => t.assigneeExpertId), ['author', 'author', 'reviewer'])
  assert.deepEqual(expanded.tasks.map(t => t.dependsOn), [[], ['t1'], ['t2']])
  assert.deepEqual(plan.tasks[0].acceptance, ['Each factual claim cites a source'])
})

test('stage/edit validate profiles before mutation and repeating stage cannot overwrite history', async t => {
  const f = await fixture(t)
  const args = { profile: profile() }
  const staged = await scenarioStageCore(f.ctx, f.config, f.captain, args)
  assert.deepEqual(staged.runtime.memberOrder, ['author', 'reviewer'])
  assert.deepEqual(await scenarioStageCore(f.ctx, f.config, f.captain, args), staged)
  await assert.rejects(() => scenarioEditCore(f.ctx, f.config, f.captain, staged.planId, { profile: profile({ tasks: [{ id: 'bad', subject: 'Bad', dependencies: ['missing'] }] }) }, staged.digest, staged.revision), /unknown dependency/)
  assert.deepEqual(await readStagedPlan(f.stateRoot, staged.planId), staged)
  const edited = await scenarioEditCore(f.ctx, f.config, f.captain, staged.planId, { goal: 'Revised' }, staged.digest, staged.revision)
  assert.equal(edited.revision, 1)
  await assert.rejects(() => scenarioStageCore(f.ctx, f.config, f.captain, args), /cannot overwrite/)
  assert.deepEqual(await readStagedPlan(f.stateRoot, staged.planId), edited)
  assert.equal(f.starts.length, 0)
})

test('apply creates two sessions from one persona plus a custom member and retains required acceptance', async t => {
  const f = await fixture(t)
  const input = parseProfile(profile({ members: [...profile().members, { id: 'custom', name: 'Custom', role: 'custom role' }] }))
  const plan = profileToExecutionPlan(input)
  const result = await applyExecutionPlan(f.ctx, f.config, f.captain, plan, { teamName: 'Apply', description: 'G', memberOrder: input.members.map(m => m.id), structuredQuality: true, kick: false }, new AbortController().signal, { ...f.core, memberSelections: { withPending: (...args) => args.find(arg => typeof arg === 'function')() } })
  assert.equal(f.starts.length, 3)
  assert.equal(new Set(f.starts.map(s => s.childId)).size, 3)
  assert.deepEqual(result.members.map(m => m.member_name), ['Author', 'Reviewer', 'Custom'])
  assert.deepEqual(result.tasks.map(t => t.assignee), ['Author', 'Author', 'Reviewer'])
  const team = JSON.parse(await readFile(join(f.stateRoot, result.team_id, 'team.json'), 'utf8'))
  const contract = team.qualityRuns.t1.contract
  assert.deepEqual(contract.acceptance, [{ id: 'output-present', statement: 'the task output is present and reviewable' }, { id: 'profile-acceptance-1', statement: 'Each factual claim cites a source' }])
  assert.throws(() => validateAcceptanceResults(contract, [{ id: 'output-present', passed: true }]), /profile-acceptance-1.*missing/)
  validateAcceptanceResults(contract, [{ id: 'output-present', passed: true }, { id: 'profile-acceptance-1', passed: true }])
})

test('failed-plan recovery gives a usable new-plan action and never resets terminal receipts', async t => {
  const f = await fixture(t)
  const staged = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile() })
  const failed = transitionStagedPlan(transitionStagedPlan(transitionStagedPlan(staged, 'approved'), 'running'), 'failed', { failureReason: 'historical duplicate runtime identity' })
  await writeStagedPlan(f.stateRoot, failed)
  const signal = new AbortController().signal
  const operations = [
    () => scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile() }),
    () => scenarioEditCore(f.ctx, f.config, f.captain, failed.planId, { goal: 'retry' }, failed.digest, failed.revision),
    () => scenarioApproveFromHost(f.ctx, f.config, f.captain, failed.planId, signal, f.core, failed.digest, failed.revision),
    () => scenarioDiscardCore(f.config, f.captain, failed.planId, failed.digest, failed.revision),
  ]
  for (const operation of operations) {
    await assert.rejects(operation, /next_action:.*new profile.id and team_name/s)
    assert.deepEqual(await readStagedPlan(f.stateRoot, failed.planId), failed)
  }
  const replacement = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile({ id: 'corrected-profile' }), team_name: 'Corrected team' })
  assert.notEqual(replacement.planId, failed.planId)
  assert.equal(replacement.status, 'staged')
  assert.deepEqual(await readStagedPlan(f.stateRoot, failed.planId), failed)
  assert.equal(f.starts.length, 0)
})

test('legacy staged expansion errors are rejected before approval and remain editable', async t => {
  const f = await fixture(t)
  const compiled = profileToExecutionPlan(parseProfile(profile()))
  const old = createStagedPlan({ plan: compiled, request: { profile: JSON.stringify(profile()) }, runtime: { teamName: 'Old', description: 'G', memberOrder: ['author', 'author', 'reviewer'] }, createdBy: f.captain.id, expiresAt: Date.now() + 60_000 })
  await writeStagedPlan(f.stateRoot, old)
  await assert.rejects(() => scenarioApproveFromHost(f.ctx, f.config, f.captain, old.planId, new AbortController().signal, f.core, old.digest, old.revision), /memberOrder must not contain duplicates/)
  assert.deepEqual(await readStagedPlan(f.stateRoot, old.planId), old)
  const corrected = await scenarioEditCore(f.ctx, f.config, f.captain, old.planId, { goal: 'Corrected' }, old.digest, old.revision)
  assert.equal(corrected.status, 'staged')
  assert.deepEqual(corrected.runtime.memberOrder, ['author', 'reviewer'])
  assert.equal(corrected.revision, 1)
  assert.equal(f.starts.length, 0)
})

test('explicit captain task remains captain-owned through apply and cannot dispatch its blocked workers', async t => {
  const f = await fixture(t)
  const input = parseProfile(profile({ tasks: [{ id: 'gate', subject: 'Captain gate', owner: 'captain' }, { id: 'worker', subject: 'Worker after gate', owner: 'author', dependsOn: ['gate'] }] }))
  const plan = profileToExecutionPlan(input)
  const result = await applyExecutionPlan(f.ctx, f.config, f.captain, plan, { teamName: 'Captain Gate', description: 'G', memberOrder: input.members.map(m => m.id), structuredQuality: true, kick: false }, new AbortController().signal, { ...f.core, memberSelections: { withPending: (...args) => args.find(arg => typeof arg === 'function')() } })
  assert.deepEqual(result.tasks.map(t => t.assignee), ['captain', 'Author'])
  await f.core.scheduler.kickTeam(f.workspace, result.team_id, f.captain)
  const team = JSON.parse(await readFile(join(f.stateRoot, result.team_id, 'team.json'), 'utf8'))
  assert.equal(team.tasks[0].assignee, 'captain')
  assert.equal(team.tasks[0].status, 'pending')
  assert.equal(team.tasks[1].status, 'pending')
  assert.equal(f.deliveries.length, 0)
  const shared = profileToExecutionPlan(parseProfile(profile({ tasks: [{ id: 'shared', subject: 'Shared pool' }] })))
  assert.equal(expandExecutionPlan(shared, { teamName: 'S', description: 'G' }).tasks[0].assignee, undefined)
})

function captainDraft() {
  const input = profile({ taskPlanning: 'captain', members: [{ id: 'author', name: 'Author', role: 'author' }, { id: 'reviewer', name: 'Reviewer', role: 'reviewer' }] })
  delete input.tasks
  return input
}

function generatedGraph() {
  return ['gate', 'draft', 'revise', 'render', 'check', 'review'].map((id, index, ids) => ({
    id, subject: id, owner: index === 0 ? 'captain' : index === 5 ? 'reviewer' : 'author',
    dependsOn: index === 0 ? [] : [ids[index - 1]],
    acceptance: Array.from({ length: index === 5 ? 2 : 3 }, (_, criterion) => `${id} criterion ${criterion + 1}`),
  }))
}

test('registered alias graph survives stage, cold read, profile edit and CAS approval without losing edges', async t => {
  const f = await fixture(t), input = captainDraft()
  const controller = new AbortController()
  t.after(() => controller.abort())
  const exec = { agent: f.captain, session: f.captain.session, signal: controller.signal }
  const call = (name, args) => f.tools.get(`expert_teams_plan_${name}`).execute(args, exec)
  const ids = ['t1-trend', 't2-pricing', 't3-finance', 't4-compose', 't5-render', 't6-review']
  const edges = [[], [], [], ids.slice(0, 3), [ids[3]], [ids[4]]]
  const tasks = ids.map((id, index) => ({ id, subject: id, owner: index < 3 ? 'captain' : index === 5 ? 'reviewer' : 'author',
    ...(index < 3 ? {} : { dependencies: edges[index] }) }))
  const preview = await call('preview', { profile: input, tasks })
  assert.deepEqual(preview.tasks.map(task => task.depends_on), [[], [], [], ['t1', 't2', 't3'], ['t4'], ['t5']])
  const staged = await call('stage', { profile: input, tasks, team_name: 'Alias graph' })
  assert.deepEqual(staged.plan.tasks.map(task => task.dependsOn), edges)
  assert.ok(staged.plan.tasks.every(task => !Object.hasOwn(task, 'dependencies')))
  const cold = await readStagedPlan(f.stateRoot, staged.planId)
  assert.deepEqual(cold.plan.tasks, staged.plan.tasks)
  const conflicting = tasks.map((task, index) => index === 3 ? { ...task, dependsOn: [] } : task)
  await assert.rejects(() => call('edit', { plan_id: cold.planId, expected_digest: cold.digest, expected_revision: cold.revision,
    tasks: conflicting }), /dependsOn and dependencies conflict/)
  assert.deepEqual(await readStagedPlan(f.stateRoot, cold.planId), cold, 'invalid edit must not overwrite the staged graph')
  assert.equal(f.starts.length, 0)
  const edited = await call('edit', { plan_id: cold.planId, expected_digest: cold.digest, expected_revision: cold.revision,
    profile: { ...input, route: { provider: 'test', model: 'alias-route' } } })
  assert.deepEqual(edited.plan.tasks, cold.plan.tasks)
  assert.deepEqual(JSON.parse(edited.request.tasks), tasks)
  await assert.rejects(() => call('approve', { plan_id: cold.planId, expected_digest: cold.digest, expected_revision: cold.revision }), /stale/)
  const approved = await call('approve', { plan_id: edited.planId, expected_digest: edited.digest, expected_revision: edited.revision })
  const team = JSON.parse(await readFile(join(f.stateRoot, approved.appliedTeamId, 'team.json'), 'utf8'))
  assert.deepEqual(team.tasks.map(task => task.dependencies), [[], [], [], ['t1', 't2', 't3'], ['t4'], ['t5']])
  assert.equal(f.deliveries.length, 0, 'alias prerequisites must keep dependent members asleep')
})

test('registered stage -> profile-only route edit -> approve preserves the six-task captain DAG and all 17 acceptance criteria', async t => {
  const f = await fixture(t)
  const signal = new AbortController()
  t.after(() => signal.abort())
  const exec = { agent: f.captain, session: f.captain.session, signal: signal.signal }
  const call = (name, args) => f.tools.get(`expert_teams_plan_${name}`).execute(args, exec)
  const render = (name, args, result) => f.tools.get(`expert_teams_plan_${name}`).output.render(args, result).map(block => block.text ?? '').join('\n')
  const initialProfile = captainDraft(), tasks = generatedGraph()
  const args = { profile: initialProfile, tasks, team_name: 'Preserved graph' }
  const preview = await call('preview', args)
  assert.match(render('preview', args, preview), /Members: 2; tasks: 6/)
  const staged = await call('stage', args)
  assert.match(render('stage', args, staged), /Members: 2; tasks: 6/)
  const patch = { plan_id: staged.planId, expected_digest: staged.digest, expected_revision: staged.revision, profile: { ...initialProfile, route: { provider: 'test', model: 'routed-model' } } }
  const edited = await call('edit', patch)
  assert.equal(edited.revision, 1)
  assert.notEqual(edited.digest, staged.digest)
  assert.deepEqual(JSON.parse(edited.request.tasks), tasks)
  assert.deepEqual(edited.plan.tasks, staged.plan.tasks)
  assert.match(render('edit', patch, edited), /Members: 2; tasks: 6/)
  await assert.rejects(() => call('approve', { plan_id: staged.planId, expected_digest: staged.digest, expected_revision: staged.revision }), /stale/)
  const approval = { plan_id: edited.planId, expected_digest: edited.digest, expected_revision: edited.revision }
  const approved = await call('approve', approval)
  assert.equal(approved.status, 'completed')
  assert.match(render('approve', approval, approved), /Members: 2; tasks: 6/)
  const team = JSON.parse(await readFile(join(f.stateRoot, approved.appliedTeamId, 'team.json'), 'utf8'))
  assert.equal(team.members.length, 2)
  assert.ok(team.members.every(member => member.model === 'routed-model'))
  assert.equal(team.tasks.length, 6)
  assert.deepEqual(team.tasks.map(task => task.assignee), ['captain', 'Author', 'Author', 'Author', 'Author', 'Reviewer'])
  assert.deepEqual(team.tasks.map(task => task.dependencies), [[], ['t1'], ['t2'], ['t3'], ['t4'], ['t5']])
  let retainedCriteria = 0
  for (const task of team.tasks) {
    const expected = tasks.find(original => original.id === task.planTask.logicalId)
    const acceptance = team.qualityRuns[task.id].contract.acceptance
    assert.deepEqual(acceptance.slice(1).map(item => item.statement), expected.acceptance)
    retainedCriteria += acceptance.length - 1
    assert.equal(acceptance[0].id, 'output-present')
  }
  assert.equal(retainedCriteria, 17)
  assert.equal(f.deliveries.length, 0, 'captain gate must still prevent member dispatch')
})

test('profile-only roster edits revalidate retained task owners without changing the staged receipt on failure', async t => {
  const f = await fixture(t), input = captainDraft()
  const staged = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: input, tasks: generatedGraph() })
  await assert.rejects(() => scenarioEditCore(f.ctx, f.config, f.captain, staged.planId, { profile: { ...input, members: input.members.filter(member => member.id !== 'author') } }, staged.digest, staged.revision), /unknown task owner "author"/)
  assert.deepEqual(await readStagedPlan(f.stateRoot, staged.planId), staged)
})

test('explicit replacement and empty arrays replace or clear captain tasks rather than falling back to the prior DAG', async t => {
  const f = await fixture(t), input = captainDraft()
  let current = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: input, tasks: generatedGraph() })
  const replacement = [{ id: 'replacement', subject: 'Explicit replacement', owner: 'captain', acceptance: ['Replacement criterion'] }]
  current = await scenarioEditCore(f.ctx, f.config, f.captain, current.planId, { profile: input, tasks: replacement }, current.digest, current.revision)
  assert.deepEqual(current.plan.tasks.map(task => task.id), ['replacement'])
  current = await scenarioEditCore(f.ctx, f.config, f.captain, current.planId, { profile: input, tasks: [] }, current.digest, current.revision)
  assert.deepEqual(current.plan.tasks, [])
  assert.equal(current.request.tasks, '[]')
  const rendered = f.tools.get('expert_teams_plan_edit').output.render({}, current).map(block => block.text ?? '').join('\n')
  assert.match(rendered, /Members: 2; tasks: 0.*No task DAG is staged/)
  const preservedEmpty = await scenarioEditCore(f.ctx, f.config, f.captain, current.planId, { profile: { ...input, route: { provider: 'test', model: 'm' } } }, current.digest, current.revision)
  assert.deepEqual(preservedEmpty.plan.tasks, [])
  assert.equal(preservedEmpty.request.tasks, '[]')
})

test('switching captain/seed mode selects the explicit new graph placement and keeps empty seed invalid', async t => {
  const f = await fixture(t), input = captainDraft()
  let current = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: input, tasks: generatedGraph() })
  const seedTasks = [{ id: 'seed-task', subject: 'Seed', owner: 'captain', acceptance: ['Seed criterion'] }]
  const seedProfile = { ...input, taskPlanning: 'seed', tasks: seedTasks }
  current = await scenarioEditCore(f.ctx, f.config, f.captain, current.planId, { profile: seedProfile }, current.digest, current.revision)
  assert.equal(current.request.tasks, undefined)
  assert.deepEqual(current.plan.tasks.map(task => task.id), ['seed-task'])
  await assert.rejects(() => scenarioEditCore(f.ctx, f.config, f.captain, current.planId, { tasks: [] }, current.digest, current.revision), /seed profiles/)
  assert.deepEqual(await readStagedPlan(f.stateRoot, current.planId), current)
  current = await scenarioEditCore(f.ctx, f.config, f.captain, current.planId, { profile: input }, current.digest, current.revision)
  assert.equal(current.request.tasks, undefined)
  assert.deepEqual(current.plan.tasks, [])
})

test('historical report bundle preserves compilation and cold parsing but cannot create a fresh legacy report', async t => {
  const f = await fixture(t)
  const reportBundle = { md: 'report.md', html: 'report.html', pdf: 'report.pdf' }
  const declared = profile({ tasks: [{ id: 'report', subject: 'Final report', owner: 'author', reportBundle }] })
  assert.ok(validateArgs({ profile: PROFILE_SCHEMA }, { profile: declared }).length > 0, 'new model-visible report schema requires explicit v3 selection')
  const p = parseProfile(declared), plan = profileToExecutionPlan(p)
  assert.deepEqual(plan.tasks[0].reportBundle, reportBundle)
  const old = createStagedPlan({ plan, request: { profile: JSON.stringify(declared) }, runtime: { teamName: 'Historical report', description: 'G' }, createdBy: f.captain.id, expiresAt: Date.now()+60_000 })
  await writeStagedPlan(f.stateRoot,old)
  assert.deepEqual((await readStagedPlan(f.stateRoot,old.planId)).plan.tasks[0].reportBundle,reportBundle)
  await assert.rejects(scenarioStageCore(f.ctx,f.config,f.captain,{profile:declared}),/REPORT_SKILL_SELECTION_REQUIRED/)
  await assert.rejects(scenarioApproveFromHost(f.ctx,f.config,f.captain,old.planId,new AbortController().signal,f.core,old.digest,old.revision),/REPORT_SKILL_SELECTION_REQUIRED/)
  await assert.rejects(applyExecutionPlan(f.ctx,f.config,f.captain,plan,{teamName:'New legacy forbidden',description:'G',structuredQuality:true,kick:false},new AbortController().signal,f.core),/REPORT_SKILL_SELECTION_REQUIRED/)
  assert.equal((await readStagedPlan(f.stateRoot,old.planId)).status,'staged')
  assert.equal(f.starts.length,0)
})

test('report checks require explicit valid opt-in and cannot coexist with disabled review', () => {
  for (const reportBundle of [null, {}, { md: '../report.md', html: 'report.html', pdf: 'report.pdf' }, { md: 'report.txt', html: 'report.html', pdf: 'report.pdf' }, { md: 'report.md', html: 'report.html', pdf: 'report.pdf', verify: 'true' }]) {
    assert.throws(() => parseProfile(profile({ tasks: [{ id: 'report', subject: 'R', reportBundle }] })), /reportBundle/)
  }
  const declared = profile({ review: { required: false }, tasks: [{ id: 'report', subject: 'R', reportBundle: { md: 'report.md', html: 'report.html', pdf: 'report.pdf' } }] })
  assert.throws(() => parseProfile(declared), /requires structured independent review/)
  const ordinary = profile({ description: 'Mentions 智见报告工艺 as quoted text, without selection' })
  assert.ok(profileToExecutionPlan(parseProfile(ordinary)).tasks.every(task => task.reportBundle === undefined))
})
