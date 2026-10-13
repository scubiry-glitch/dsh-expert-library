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

test('approved plans require a live captain task before business work while workflow tools remain available', async t => {
  const { planExecutionDenial } = await import('../lib/plan-execution-boundary.js')
  const f = await fixture(t)
  const p = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile({
    tasks: [{ id: 'collect', subject: 'Collect independent evidence', owner: 'captain', artifactInputs: [], produces: [] }],
  }) })
  await approve(f, p, true)
  const denial = name => planExecutionDenial({ agent: f.captain, name }, f.config)
  assert.match(await denial('bash'), /PLAN_TASK_EXECUTION_REQUIRED.*t1/)
  for (const name of ['expert_teams_claim_task', 'expert_teams_update_task', 'expert_teams_quality_review', 'expert_teams_send_message', 'read']) {
    assert.equal(await denial(name), undefined, name)
  }
  const exec = { agent: f.captain, signal: new AbortController().signal }
  const claim = await f.tools.get('expert_teams_claim_task').execute({ task_id: 't1', assignee: 'captain' }, exec)
  assert.match(await denial('bash'), /in_progress/)
  await f.tools.get('expert_teams_update_task').execute({ task_id: 't1', attempt_id: claim.attempt_id, status: 'in_progress' }, exec)
  assert.equal(await denial('bash'), undefined)
  await f.tools.get('expert_teams_update_task').execute({ task_id: 't1', attempt_id: claim.attempt_id, status: 'in_progress',
    execution_state: 'awaiting_review', wait_reason: 'Independent review required', output: 'Submitted evidence.' }, exec)
  assert.match(await denial('bash'), /PLAN_TASK_EXECUTION_REQUIRED/)
})

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
  await assert.rejects(create, /REVIEWED_REPORT_PLAN_REQUIRED/, 'revocation removes delegation, not the report requirement')
})

for (const [policyLabel, review] of [['explicit', { required: true }], ['empty-default', {}], ['omitted-default', undefined]]) {
test('reviewed-report requirement accepts current approved plan with ' + policyLabel + ' review policy', async t => {
  const f = await fixture(t)
  await cp(new URL('../domain-packs/.zhijian-realestate-v15-src', import.meta.url), join(f.workspace, 'domain-packs', 'zhijian-realestate'), { recursive: true, dereference: true })
  f.config.enabledPacks = ['zhijian-realestate']
  const context = captureSharedTaskContext(f.captain)
  await authorizePlanExecution(f.stateRoot, f.captain.id, context, { requestId: 'full-report', expectedInputSha256: planInputSha256(context), reason: 'Full reviewed report required', scope: 'single-plan-for-direct-user-input', requireReviewedReport: true })
  const reportBundle = { md: 'report.md', html: 'report.html', pdf: 'report.pdf', craft: { version: 3, evidence: 'craft-evidence.json', selections: [
    { packId: 'zhijian-realestate', skillId: 'zhijian-report-craft', reason: 'Engineering fixture content choice' },
    { packId: 'zhijian-realestate', skillId: 'zhijian-designer-render', variant: 'credit-policy', reason: 'Engineering fixture render choice' },
  ] } }
  const p = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile({ review, tasks: [{ id: 'draft', subject: 'Final report', owner: 'author', artifactInputs: [], reportBundle }] }), report_outline: { chapters: [{ id: 'main', title: 'Synthetic analysis', questions: ['What is supported?'], evidence: ['Original source'], taskIds: ['draft'] }], attachments: [] } })
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


test('outline and per-role model edits persist one version, reject stale approval, and reach actual task materialization', async t => {
  const f = await fixture(t)
  const outline = { chapters: [{ id: 'evidence', title: 'Evidence first', questions: ['What is observed?'], evidence: ['Primary observations'], taskIds: ['draft'] }], attachments: ['Raw data'] }
  const first = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile(), report_outline: outline })
  assert.deepEqual(planToWire(first).preview.reportOutline, outline)
  const revisedOutline = { ...outline, chapters: [{ ...outline.chapters[0], title: 'Revised evidence', questions: ['Which observations remain uncertain?'] }] }
  const edited = await scenarioEditCore(f.ctx, f.config, f.captain, first.planId, { report_outline: revisedOutline, plan_models: { author: { provider: 'test', model: 'edited-model', reasoningEffort: 'high' } } }, first.digest, first.revision)
  assert.notEqual(edited.digest, first.digest)
  assert.equal(edited.revision, first.revision + 1)
  assert.deepEqual((await readStagedPlan(f.stateRoot, first.planId)).plan.reportOutline, revisedOutline)
  await assert.rejects(() => approve(f, first, true), /stale/)
  assert.equal(f.starts.length, 0)
  const done = await approve(f, edited, true)
  const team = JSON.parse(await readFile(join(f.stateRoot, done.appliedTeamId, 'team.json'), 'utf8'))
  assert.equal(team.members[0].model, 'edited-model')
  assert.equal(team.members[0].reasoningEffort, 'high')
  assert.match(team.tasks[0].description, /Which observations remain uncertain/)
  assert.doesNotMatch(team.tasks[0].description, /What is observed/)
})

test('invalid outline, unknown role and unavailable chosen model leave the editable plan unchanged', async t => {
  const f = await fixture(t, { unavailable: new Set(['missing-model']) })
  const p = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile() })
  for (const patch of [
    { report_outline: { chapters: [{ id: 'bad', title: 'Bad', questions: ['Question'], evidence: ['Evidence'], taskIds: ['absent'] }], attachments: [] } },
    { plan_models: { unknown: { provider: 'test', model: 'm' } } },
    { plan_models: { author: { provider: 'test', model: 'missing-model' } } },
  ]) {
    await assert.rejects(() => scenarioEditCore(f.ctx, f.config, f.captain, p.planId, patch, p.digest, p.revision))
    assert.equal((await readStagedPlan(f.stateRoot, p.planId)).digest, p.digest)
    assert.equal(f.starts.length, 0)
  }
})

test('captain model changes require a real native route switch, never a display-only override', async t => {
  const f = await fixture(t)
  const p = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile(), plan_models: { captain: { provider: 'test', model: 'execution-model' } } })
  await assert.rejects(() => approve(f, p, true), /PLAN_CAPTAIN_MODEL_SWITCH_REQUIRED/)
  assert.equal(f.starts.length, 0)
  assert.equal((await readStagedPlan(f.stateRoot, p.planId)).status, 'staged')
  f.events.push({type:'model/selection',data:{provider:'test',model:'execution-model'}})
  assert.equal((await approve(f, p, true)).status, 'completed')
  const { planExecutionDenial } = await import('../lib/plan-execution-boundary.js')
  assert.match(await planExecutionDenial({agent:f.captain,name:'bash'},f.config),/PLAN_EXECUTION_MODEL_MISMATCH/, 'the old planning request still cannot execute business tools')
  f.captain.session.requestHeader = () => ({ config: { provider: 'test', model: 'execution-model' } })
  assert.match(await planExecutionDenial({agent:f.captain,name:'bash'},f.config),/PLAN_TASK_EXECUTION_REQUIRED/)
})

test('captain business tools stay blocked before approval, after restart, and after route drift', async t => {
  const { planExecutionDenial } = await import('../lib/plan-execution-boundary.js')
  const f = await fixture(t)
  const denial = name => planExecutionDenial({agent:f.captain,name},f.config)
  assert.equal(await denial('bash'),undefined,'ordinary unplanned work keeps its meaning')
  const staged=await scenarioStageCore(f.ctx,f.config,f.captain,{profile:profile()})
  for(const name of ['bash','exec_command','run_code','expert_provider_call','web_search','subagent']) assert.match(await denial(name),/PLAN_EXECUTION_APPROVAL_REQUIRED/,name)
  for(const name of ['read_file','expert_teams_plan_edit','expert_teams_plan_approve','expert_library_doctor']) assert.equal(await denial(name),undefined,name)
  const coldCaptain=structuredClone({id:f.captain.id,options:f.captain.options})
  coldCaptain.session=f.captain.session
  assert.match(await planExecutionDenial({agent:coldCaptain,name:'bash'},f.config),/PLAN_EXECUTION_APPROVAL_REQUIRED/)
  await approve(f,staged,true)
  assert.match(await denial('bash'),/PLAN_TASK_EXECUTION_REQUIRED/)
  f.captain.session.requestHeader=()=>({config:{provider:'test',model:'unapproved'}})
  assert.match(await denial('expert_provider_call'),/PLAN_EXECUTION_MODEL_MISMATCH/)
})

test('captain review of submitted member work remains possible; waiting and failed work do not authorize production', async t => {
  const { planExecutionDenial } = await import('../lib/plan-execution-boundary.js')
  const { readTeam, writeTeam } = await import('../lib/state.js')
  const f = await fixture(t)
  const p = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile() })
  const applied = await approve(f, p, true)
  const team = await readTeam(f.stateRoot, applied.appliedTeamId)
  const task = team.tasks[0]
  const denial = () => planExecutionDenial({ agent: f.captain, name: 'bash' }, f.config)
  assert.match(await denial(), /PLAN_TASK_EXECUTION_REQUIRED/)
  task.status = 'in_progress'; task.executionState = 'awaiting_review'; task.attemptId = 'review-attempt'
  await writeTeam(f.stateRoot, team)
  assert.equal(await denial(), undefined, 'captain can inspect the submitted member artifact')
  task.executionState = 'blocked_external'; task.waitReason = 'Missing source'; await writeTeam(f.stateRoot, team)
  assert.match(await denial(), /PLAN_TASK_EXECUTION_REQUIRED/)
  task.status = 'failed'; delete task.executionState; delete task.attemptId; await writeTeam(f.stateRoot, team)
  assert.match(await denial(), /PLAN_TASK_EXECUTION_REQUIRED/)
  task.status = 'completed'; await writeTeam(f.stateRoot, team)
  assert.equal(await denial(), undefined, 'completed tasks allow final delivery packaging')
})

test('explicit report requirement blocks business before staging and survives delegation revocation', async t => {
  const { planExecutionDenial } = await import('../lib/plan-execution-boundary.js')
  const f=await fixture(t),context=captureSharedTaskContext(f.captain)
  await authorizePlanExecution(f.stateRoot,f.captain.id,context,{requestId:'boundary-before-stage',expectedInputSha256:planInputSha256(context),reason:'Require reviewed report',scope:'single-plan-for-direct-user-input',requireReviewedReport:true})
  assert.match(await planExecutionDenial({agent:f.captain,name:'bash'},f.config),/PLAN_EXECUTION_APPROVAL_REQUIRED/)
  await revokePlanExecution(f.stateRoot,f.captain.id,'boundary-before-stage')
  assert.match(await planExecutionDenial({agent:f.captain,name:'expert_provider_call'},f.config),/PLAN_EXECUTION_APPROVAL_REQUIRED/)
})


test('persisted executable content cannot drift behind an unchanged approval digest', async t => {
  const f=await fixture(t)
  const outline={chapters:[{id:'main',title:'Observations',questions:['What is supported?'],evidence:['Primary evidence'],taskIds:['draft']}],attachments:[]}
  const p=await scenarioStageCore(f.ctx,f.config,f.captain,{profile:profile(),report_outline:outline})
  const path=join(f.stateRoot,'plans',p.planId+'.json'),original=await readFile(path,'utf8')
  for(const change of [row=>row.plan.reportOutline.chapters[0].questions=['Different approved question'],row=>row.plan.roster[0].modelPolicy.model='unapproved',row=>row.plan.tasks[0].acceptance=['Weaker check']]) {
    const row=JSON.parse(original);change(row);await writeFile(path,JSON.stringify(row))
    await assert.rejects(readStagedPlan(f.stateRoot,p.planId),/invalid staged plan/)
    await writeFile(path,original)
  }
  assert.equal((await readStagedPlan(f.stateRoot,p.planId)).digest,p.digest)
})

test('editing another role keeps prior per-plan model choices',async t=>{
 const f=await fixture(t)
 const first=await scenarioStageCore(f.ctx,f.config,f.captain,{profile:profile(),plan_models:{author:{provider:'test',model:'author-choice'}}})
 const next=await scenarioEditCore(f.ctx,f.config,f.captain,first.planId,{plan_models:{captain:{provider:'test',model:'captain-choice'}}},first.digest,first.revision)
 assert.equal(next.plan.roster[0].modelPolicy.model,'author-choice')
 assert.equal(next.plan.captainModel.model,'captain-choice')
})
