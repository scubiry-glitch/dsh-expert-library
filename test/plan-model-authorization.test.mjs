import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, cp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerExpertTeamsTools, scenarioPreviewCore, scenarioStageCore, scenarioEditCore, scenarioApproveCore, scenarioApproveFromHost, scenarioApplyCore } from '../lib/tools.js'
import { authorizePlanExecution, revokePlanExecution, readPlanExecutionAuthorization, planInputSha256, requireAuthorizedTeamCreation, assertReviewedReportPlan } from '../lib/plan-authorization.js'
import { captureSharedTaskContext } from '../lib/shared-task-context.js'
import { readStagedPlan } from '../lib/staged-plan.js'
import { planToWire } from '../lib/team-wire.js'

async function fixture(t, opts = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'plan-authority-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const tools = new Map(), starts = [], deliveries = [], routes = []
  const events = [{ type: 'user/message', seq: 1, data: { id: 'user-original', source: { kind: 'user' }, content: [{ type: 'text', text: opts.prompt ?? 'Research the original task.' }] } }]
  const captain = { id: 'captain-id', options: { provider: 'test', model: 'captain-model' }, session: { id: 'captain-id', header: { id: 'captain-id', cwd: workspace }, requestHeader: () => ({ config: { provider: 'test', model: 'captain-model' } }), events, append() {} } }
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool) } }, logger: { debug() {}, info() {}, warn() {} },
    agents: { get: () => undefined, withInitiator: (agent, action) => action() },
    llm: { resolveCallConfig: async config => { routes.push(config); if (opts.unavailable?.has(config.model)) throw new Error('model unavailable'); return config } },
    subagents: { registerContinuableSetup() { return () => undefined }, list: () => ['spawn'], listChildren: async () => [], listDescendants: async () => [],
      getProvider: () => ({ prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }),
      async startContinuable(input) { starts.push(input); return { childId: input.childId } }, followup: async (...args) => deliveries.push(args), interrupt() {} }, effect() {}, on() {}, get() { return undefined },
  }
  const config = { stateDir: '.expert-teams', memberProvider: 'spawn', maxMembers: 8, knowledgeDir: 'knowledge', packsDir: 'domain-packs', ...opts.config }
  const core = registerExpertTeamsTools(ctx, config)
  return { workspace, stateRoot: join(workspace, config.stateDir), ctx, config, captain, tools, starts, deliveries, routes, core, events }
}
const profile = (extra = {}) => ({ schemaVersion: 1, id: 'route-review', version: '1', description: 'Research', protocol: [], taskPlanning: 'seed',
  members: [{ id: 'author', name: 'Author', expert: 'researcher' }], tasks: [{ id: 'draft', subject: 'Draft', owner: 'author', acceptance: ['Cite original evidence'] }], ...extra })
const approve = (f, p, host = false) => (host ? scenarioApproveFromHost : scenarioApproveCore)(f.ctx, f.config, f.captain, p.planId, new AbortController().signal, f.core, p.digest, p.revision)
async function grant(f, requestId = 'user-authorization-1') {
  const context = captureSharedTaskContext(f.captain)
  return authorizePlanExecution(f.stateRoot, f.captain.id, context, { requestId, expectedInputSha256: planInputSha256(context), reason: 'User explicitly authorized this isolated rerun.', scope: 'single-plan-for-direct-user-input' })
}

test('preset and profile routes freeze settings priority before approval; later settings do not change execution', async t => {
  const f = await fixture(t, { config: { memberModel: { provider: 'test', model: 'plugin' }, expertModelOverrides: { researcher: { provider: 'test', model: 'user-research' } } } })
  const p = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile() })
  assert.equal(p.plan.roster[0].modelPolicy.model, 'user-research')
  assert.equal(p.plan.roster[0].modelRouteSource, 'expert-override')
  f.config.expertModelOverrides.researcher.model = 'later-setting'
  const done = await approve(f, p, true)
  const team = JSON.parse(await readFile(join(f.stateRoot, done.appliedTeamId, 'team.json'), 'utf8'))
  assert.equal(team.members[0].model, 'user-research')
  assert.equal(done.approval.source, 'authenticated-host-user')
  assert.equal(planToWire(done).preview.members[0].routeSource, 'expert-override')
  assert.equal(planToWire(done).preview.tasks[0].acceptance[0].statement, 'Cite original evidence')
})

test('explicit member route wins profile route, then expert settings; preview exposes exact actual route/source', async t => {
  const f = await fixture(t, { config: { expertModelOverrides: { researcher: { provider: 'test', model: 'settings' } } } })
  const p = profile({ route: { provider: 'test', model: 'profile' }, members: [
    { id: 'a', name: 'A', expert: 'researcher', route: { provider: 'test', model: 'explicit' } },
    { id: 'b', name: 'B', expert: 'researcher' }], tasks: [{ id: 'work', subject: 'Work', owner: 'a' }] })
  const preview = await scenarioPreviewCore(f.ctx, f.config, f.captain, { profile: p })
  assert.deepEqual(preview.member_routes.map(m => [m.route.model, m.source]), [['explicit', 'profile-member'], ['profile', 'profile-default']])
  assert.equal(f.starts.length, 0)
})

test('changed model settings alter new draft digest; unavailable frozen routes create no team or members', async t => {
  const unavailable = new Set()
  const f = await fixture(t, { unavailable, config: { expertModelOverrides: { researcher: { provider: 'test', model: 'chosen' } } } })
  const p = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile() })
  f.config.expertModelOverrides.researcher.model = 'replacement'
  const edit = await scenarioEditCore(f.ctx, f.config, f.captain, p.planId, {}, p.digest, p.revision)
  assert.notEqual(edit.digest, p.digest)
  assert.equal(edit.plan.roster[0].modelPolicy.model, 'replacement')
  unavailable.add('replacement')
  await assert.rejects(() => approve(f, edit, true), /PLAN_MODEL_UNAVAILABLE/)
  assert.equal(f.starts.length, 0)
  assert.equal((await readStagedPlan(f.stateRoot, edit.planId)).status, 'staged')
  assert.deepEqual((await readdir(f.stateRoot)).filter(path => !['plans', '.locks'].includes(path)), [])
})

test('default and forged model approval remain waiting for a user; Host user approval applies once', async t => {
  const f = await fixture(t)
  let concluded = 0
  const exec = { agent: f.captain, session: f.captain.session, signal: new AbortController().signal, concludeTurn() { concluded++ } }
  const p = await f.tools.get('expert_teams_plan_stage').execute({ profile: profile() }, exec)
  assert.equal(p.waitingFor, 'user-confirmation')
  const denied = await f.tools.get('expert_teams_plan_approve').execute({ plan_id: p.planId, expected_digest: p.digest, expected_revision: p.revision, user_approved: true, authority: 'authenticated-host-user' }, exec)
  assert.equal(denied.status, 'staged')
  assert.equal(denied.approval, undefined)
  assert.equal(f.starts.length, 0)
  assert.equal(concluded, 2)
  const done = await approve(f, p, true)
  assert.equal(done.status, 'completed')
  assert.equal(done.approval.source, 'authenticated-host-user')
  assert.equal((await approve(f, p, true)).appliedTeamId, done.appliedTeamId)
  assert.equal(f.starts.length, 1)
})

test('Host delegation is exact-input, idempotent, revocable, and bound to one approved revision', async t => {
  const f = await fixture(t)
  const first = await grant(f)
  assert.deepEqual(await grant(f), first)
  const p = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile() })
  assert.equal(p.waitingFor, undefined)
  const done = await approve(f, p)
  const receipt = await readPlanExecutionAuthorization(f.stateRoot, f.captain.id)
  assert.equal(done.approval.source, 'delegated-host-authorization')
  assert.equal(done.approval.authorizationRequestId, first.requestId)
  assert.deepEqual([receipt.consumed.planId, receipt.consumed.digest, receipt.consumed.revision], [p.planId, p.digest, p.revision])
  assert.equal(receipt.consumed.contextSha256, p.runtime.sharedTaskContext.sha256)
  assert.ok((await revokePlanExecution(f.stateRoot, f.captain.id, first.requestId)).revokedAt)
  assert.equal(f.starts.length, 1)
})

test('revocation, added direct-user text, and a copied foreign-session grant cannot authorize approval', async t => {
  for (const kind of ['revoked', 'changed-input', 'foreign']) {
    const f = await fixture(t)
    const g = await grant(f)
    if (kind === 'revoked') await revokePlanExecution(f.stateRoot, f.captain.id, g.requestId)
    if (kind === 'changed-input') f.events.push({ type: 'user/message', seq: 2, data: { id: 'new', source: { kind: 'user' }, content: [{ type: 'text', text: 'Change the scope.' }] } })
    if (kind === 'foreign') { f.captain.id = 'foreign'; f.captain.session.id = 'foreign'; f.captain.session.header.id = 'foreign' }
    const p = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile() })
    assert.equal((await approve(f, p)).waitingFor, 'user-confirmation', kind)
    assert.equal(f.starts.length, 0, kind)
  }
})

test('preauthorization matches only the exact future source=user input and refuses unavailable history', async t => {
  const f = await fixture(t)
  const captured = captureSharedTaskContext(f.captain), digest = planInputSha256(captured)
  f.events.length = 0
  const empty = captureSharedTaskContext(f.captain)
  await authorizePlanExecution(f.stateRoot, f.captain.id, empty, { requestId: 'pre-start', expectedInputSha256: digest, reason: 'Authorized future input', scope: 'single-plan-for-direct-user-input' })
  f.events.push({ type: 'user/message', seq: 1, data: { id: 'original', source: { kind: 'user' }, content: [{ type: 'text', text: captured.messages[0].text }] } })
  const p = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile() })
  assert.equal((await approve(f, p)).approval.source, 'delegated-host-authorization')
})

test('plan user wait pauses the native Goal once and exact user approval resumes it; manual goal edits are preserved', async t => {
  for (const manualChange of [false, true]) {
    const f = await fixture(t)
    let goal = { id: 'goal', revision: 1, phase: 'active', activation: 'armed' }, pauses = 0, resumes = 0, flushes = 0
    const goals = { get: () => goal, pause(agent, ref) { assert.equal(ref.revision, goal.revision); pauses++; return goal = { ...goal, revision: goal.revision + 1, phase: 'paused', activation: 'disarmed' } }, resume(agent, ref) { assert.equal(ref.revision, goal.revision); resumes++; return goal = { ...goal, revision: goal.revision + 1, phase: 'active', activation: 'armed' } } }
    f.ctx.get = name => name === 'goals' ? goals : name === 'sessions' ? { flush: async () => { flushes++; return true } } : undefined
    const p = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile() })
    assert.equal(pauses, 1)
    assert.equal(p.goalWait.pausedRevision, 2)
    await approve(f, p)
    assert.equal(pauses, 1)
    if (manualChange) goal = { ...goal, revision: 3 }
    await approve(f, p, true)
    assert.equal(resumes, manualChange ? 0 : 1)
    assert.ok(flushes >= 1)
  }
})

test('legacy preset immediate apply saves a reviewable plan and creates no members without Host authorization', async t => {
  const f = await fixture(t, { config: { expertModelOverrides: { researcher: { provider: 'test', model: 'settings-research' } } } })
  const result = await scenarioApplyCore(f.ctx, f.config, f.captain, { scenario: 'market-research' }, new AbortController().signal, f.core)
  assert.equal(result.status, 'waiting_user')
  assert.equal(f.starts.length, 0)
  const p = await readStagedPlan(f.stateRoot, result.plan_id)
  const researcher = p.plan.roster.find(m => m.expertId === 'researcher')
  assert.equal(researcher.modelPolicy.model, 'settings-research')
})

test('failed plan-goal resume durability re-parks exact owned revision and completed approval replay recovers', async t => {
  const f = await fixture(t)
  let goal = { id: 'goal', revision: 1, phase: 'active', activation: 'armed' }, failResumeFlush = true
  const goals = {
    get: () => goal,
    pause(_agent, ref) { assert.equal(ref.revision, goal.revision); return goal = { ...goal, revision: goal.revision + 1, phase: 'paused', activation: 'disarmed' } },
    resume(_agent, ref) { assert.equal(ref.revision, goal.revision); return goal = { ...goal, revision: goal.revision + 1, phase: 'active', activation: 'armed' } },
  }
  f.ctx.get = name => name === 'goals' ? goals : name === 'sessions' ? { async flush() {
    if (goal.phase === 'active' && failResumeFlush) { failResumeFlush = false; throw new Error('fixture resume journal unavailable') }
    return true
  } } : undefined
  const p = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile() })
  await assert.rejects(() => approve(f, p, true), /resume journal unavailable/)
  assert.equal(goal.phase, 'paused')
  const persisted = await readStagedPlan(f.stateRoot, p.planId)
  assert.equal(persisted.status, 'completed')
  assert.equal(persisted.goalWait.pausedRevision, goal.revision)
  const count = f.starts.length
  await approve(f, p, true)
  assert.equal(goal.phase, 'active')
  assert.equal(f.starts.length, count, 'recovering the Goal must not create another team/member')
})


test('authenticated reviewed-report requirement blocks ad-hoc and report-free plans without consuming approval', async t => {
  const f = await fixture(t)
  const context = captureSharedTaskContext(f.captain)
  const input = { requestId: 'reviewed-report', expectedInputSha256: planInputSha256(context), reason: 'User requires independently accepted three-format report', scope: 'single-plan-for-direct-user-input', requireReviewedReport: true }
  const receipt = await authorizePlanExecution(f.stateRoot, f.captain.id, context, input)
  assert.equal(receipt.requireReviewedReport, true)
  await assert.rejects(() => authorizePlanExecution(f.stateRoot, f.captain.id, context, { ...input, requireReviewedReport: undefined }), /REQUEST_ID_CONFLICT/)
  const create = () => f.tools.get('expert_teams_create').execute({ name: 'bypass' }, { agent: f.captain, signal: new AbortController().signal })
  await assert.rejects(create, /REVIEWED_REPORT_PLAN_REQUIRED/)
  await assert.rejects(() => scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile() }), /REVIEWED_REPORT_PLAN_REQUIRED/)
  assert.equal((await readPlanExecutionAuthorization(f.stateRoot, f.captain.id)).consumed, undefined)
  assert.equal(f.starts.length, 0)
  assert.deepEqual((await readdir(f.stateRoot)).filter(path => !['plans', '.locks'].includes(path)), [])
  await revokePlanExecution(f.stateRoot, f.captain.id, input.requestId)
  assert.ok((await create()).team_id)
})

for (const [policyLabel, review] of [['explicit', { required: true }], ['empty-default', {}], ['omitted-default', undefined]]) {
test('reviewed-report requirement accepts current approved plan with ' + policyLabel + ' review policy', async t => {
  const f = await fixture(t)
  await cp(new URL('../domain-packs/zhijian-realestate', import.meta.url), join(f.workspace, 'domain-packs', 'zhijian-realestate'), { recursive: true })
  f.config.enabledPacks = ['zhijian-realestate']
  const context = captureSharedTaskContext(f.captain)
  await authorizePlanExecution(f.stateRoot, f.captain.id, context, { requestId: 'full-report', expectedInputSha256: planInputSha256(context), reason: 'Full reviewed report required', scope: 'single-plan-for-direct-user-input', requireReviewedReport: true })
  const reportBundle = { md: 'report.md', html: 'report.html', pdf: 'report.pdf', craft: { version: 3, evidence: 'craft-evidence.json', selections: [
    { packId: 'zhijian-realestate', skillId: 'zhijian-report-craft', reason: 'Engineering fixture content choice' },
    { packId: 'zhijian-realestate', skillId: 'zhijian-designer-render', variant: 'credit-policy', reason: 'Engineering fixture render choice' },
  ] } }
  const p = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile({ review, tasks: [{ id: 'draft', subject: 'Final report', owner: 'author', reportBundle }] }) })
  await assert.rejects(() => requireAuthorizedTeamCreation(f.stateRoot, f.captain.id, context, p.plan), /REVIEWED_REPORT_APPROVAL_REQUIRED/)
  assert.throws(() => assertReviewedReportPlan({ ...p.plan, reviewPolicy: { required: false } }), /REVIEWED_REPORT_PLAN_REQUIRED/)
  const done = await approve(f, p)
  const team = JSON.parse(await readFile(join(f.stateRoot, done.appliedTeamId, 'team.json'), 'utf8'))
  assert.equal(team.structuredQualityPolicy.required, true)
  assert.equal(team.tasks[0].reportBundle.craft.version, 3)
  assert.ok(team.qualityRuns[team.tasks[0].id])
  assert.equal((await readPlanExecutionAuthorization(f.stateRoot, f.captain.id)).consumed.planId, p.planId)
})

}

test('expired approval does not silently drop the matching delivery requirement; changed input is independent', async t => {
  const f = await fixture(t)
  const context = captureSharedTaskContext(f.captain)
  await authorizePlanExecution(f.stateRoot, f.captain.id, context, { requestId: 'expiring-report', expectedInputSha256: planInputSha256(context), reason: 'Report required', scope: 'single-plan-for-direct-user-input', requireReviewedReport: true })
  const directory = join(f.stateRoot, 'plans', 'authorizations')
  for (const name of await readdir(directory)) {
    const path = join(directory, name), row = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...row, expiresAt: Date.now() - 1 }))
  }
  await assert.rejects(() => requireAuthorizedTeamCreation(f.stateRoot, f.captain.id, context), /REVIEWED_REPORT_PLAN_REQUIRED/)
  f.events.push({ type: 'user/message', seq: 2, data: { id: 'next-task', source: { kind: 'user' }, content: [{ type: 'text', text: 'A different task' }] } })
  await requireAuthorizedTeamCreation(f.stateRoot, f.captain.id, captureSharedTaskContext(f.captain))
})
