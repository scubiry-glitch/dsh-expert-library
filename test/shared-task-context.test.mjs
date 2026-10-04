import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  captureSharedTaskContext, isSharedTaskContext, renderSharedTaskContext,
  MAX_SHARED_TASK_CONTEXT_BYTES, MAX_SHARED_TASK_CONTEXT_MESSAGES,
} from '../lib/shared-task-context.js'
import { registerExpertTeamsTools, scenarioStageCore, scenarioEditCore, scenarioApproveFromHost, createTeamCore, createTaskCore } from '../lib/tools.js'
import { readStagedPlan, isStagedPlan } from '../lib/staged-plan.js'
import { assignmentPrompt } from '../lib/scheduler.js'
import { readTeam, readTeamSync, syncTaskProjectInput, withTeamLock, sanitizeKey } from '../lib/state.js'
import { qualityPublicationFixture } from './support/quality-publication-fixture.mjs'

const human = (seq, text, id = `human-${seq}`) => ({
  seq, type: 'user/message', data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const participant = (events, extra = {}) => ({
  id: 'context-captain', session: { id: 'context-captain', ownEvents: () => events, ...extra },
})
const texts = context => context.messages.map(message => message.text)

test('capture selects accepted human messages, not role-looking tool/plugin/goal text or pending inbox input', () => {
  const original = 'Only create this run in work/fresh; never read prior reports.\nPreserve strict acceptance.'
  const events = [human(4, original)]
  for (const [index, source] of [
    { kind: 'plugin', plugin: 'dsh-expert-library' }, { kind: 'goal', goalId: 'g', revision: 1, round: 2 },
    { kind: 'tool', toolName: 'read' }, { kind: 'model' }, undefined,
  ].entries()) events.push({ ...human(10 + index, `UNTRUSTED-${index}`), data: { ...human(10 + index, `UNTRUSTED-${index}`).data, source } })
  events.push({ ...human(20, 'ASSISTANT-NOT-HUMAN'), type: 'assistant/message' })
  const captain = participant(events)
  captain.inbox = { nextTurn: [human(30, 'NOT-ACCEPTED-YET').data] }
  const captured = captureSharedTaskContext(captain)
  assert.equal(captured.status, 'captured')
  assert.deepEqual(texts(captured), [original])
  assert.equal(captured.captainSessionId, captain.id)
  assert.equal(isSharedTaskContext(captured), true)
})

test('modern ownEvents and legacy seedLength exclude inherited parent messages', () => {
  const inherited = human(1, 'PARENT-PRIVATE-OLD-TASK')
  const own = human(20, 'The present task must use only its isolated output directory.')
  const modern = captureSharedTaskContext(participant([own], { events: [inherited, own] }))
  const legacy = captureSharedTaskContext({ id: 'context-captain', session: { id: 'context-captain', header: { seedLength: 1 }, events: [inherited, own] } })
  assert.deepEqual(texts(modern), [own.data.content[0].text])
  assert.deepEqual(texts(legacy), texts(modern))
  assert.equal(legacy.sha256, modern.sha256)
})

test('first staging keeps original task plus all later direct-user constraints, including a standalone approval', () => {
  const events = [human(1, 'Original report and its hard output isolation.'), human(4, 'A new restriction before the first stage.'), human(7, 'Approved; continue.')]
  const captured = captureSharedTaskContext(participant(events))
  assert.deepEqual(texts(captured), events.map(event => event.data.content[0].text))
})

test('an explicit own-session team deletion starts a new input batch without semantic guessing', () => {
  const old = human(1, 'OLD-TEAM-PRIVATE-REQUEST')
  const retired = { seq: 4, type: 'expert-teams/team-deleted', data: { teamId: 'retired-team' } }
  const current = human(5, 'New task after the prior team was retired.')
  const captured = captureSharedTaskContext(participant([old, retired, current]))
  assert.deepEqual(texts(captured), [current.data.content[0].text])
  const previous = captureSharedTaskContext(participant([old]))
  assert.throws(() => captureSharedTaskContext(participant([old, retired, current]), previous), /SHARED_TASK_CONTEXT_RETIRED/)
})

test('without a lifecycle boundary the bounded batch does not pretend to classify unrelated human topics', () => {
  const events = [human(1, 'An earlier human question in this same session.'), human(3, 'The current requested report.')]
  const captured = captureSharedTaskContext(participant(events))
  assert.deepEqual(texts(captured), events.map(event => event.data.content[0].text))
})

test('captured instruction keeps its exact text including a constraint beyond a long body', () => {
  const text = `  原任务\n${'evidence '.repeat(1100)}\n不得读取旧报告，不得修改验收规则。  `
  const original = human(1, text)
  const captured = captureSharedTaskContext(participant([original]))
  assert.deepEqual(texts(captured), [text])
  assert.match(captured.sha256, /^[a-f0-9]{64}$/)
  // The captured snapshot must not remain aliased to the live event object.
  original.data.content[0].text = 'MUTATED-AFTER-CAPTURE'
  assert.deepEqual(texts(captured), [text])
})

test('new user amendments and approval append once without replacing frozen task text', () => {
  const events = [human(1, 'Original deliverable; do not change G1/G3/G5 rules.')]
  const first = captureSharedTaskContext(participant(events))
  events.push(human(5, 'Also keep all generated scripts inside this run directory.'), human(8, 'Approved, continue.'))
  const merged = captureSharedTaskContext(participant(events), first)
  assert.deepEqual(texts(merged), events.map(event => event.data.content[0].text))
  assert.notEqual(merged.sha256, first.sha256)
  assert.deepEqual(texts(first), ['Original deliverable; do not change G1/G3/G5 rules.'])
  assert.deepEqual(captureSharedTaskContext(participant(events), merged), merged)
})

test('cold suffix history cannot erase durable original instructions when adding a later human constraint', () => {
  const first = captureSharedTaskContext(participant([human(2, 'Original isolated task and fixed acceptance.')]))
  const laterOnly = participant([human(20, 'Additional constraint after recovery.')])
  const merged = captureSharedTaskContext(laterOnly, JSON.parse(JSON.stringify(first)))
  assert.deepEqual(texts(merged), ['Original isolated task and fixed acceptance.', 'Additional constraint after recovery.'])
})

test('a context from another captain cannot be imported as this task user authority', () => {
  const first = captureSharedTaskContext(participant([human(1, 'Private task A')]))
  assert.throws(() => captureSharedTaskContext({ id: 'foreign-captain', session: { id: 'foreign-captain', ownEvents: () => [human(2, 'Task B')] } }, first), /captain|identity|owner/i)
})

test('captain identity must match the authoritative source session header', () => {
  const captain = participant([human(1, 'Task from another session')], { header: { id: 'different-captain' } })
  assert.throws(() => captureSharedTaskContext(captain), /SHARED_TASK_CONTEXT_SOURCE_INVALID/)
})

test('live events cannot silently contradict a previously frozen user id, sequence or original text', () => {
  const original = human(2, 'Exact original constraint', 'stable-human-id')
  const first = captureSharedTaskContext(participant([original]))
  for (const replacement of [
    human(2, 'Rewritten constraint', 'stable-human-id'),
    human(3, 'Exact original constraint', 'stable-human-id'),
    human(2, 'Exact original constraint', 'changed-human-id'),
  ]) assert.throws(() => captureSharedTaskContext(participant([replacement]), first), /SHARED_TASK_CONTEXT_SOURCE_INVALID/)
})

test('missing human input is explicit unavailable context, never synthesized from a goal or description', () => {
  for (const captain of [
    { id: 'context-captain', session: { id: 'context-captain' } },
    participant([]),
    participant([{ ...human(1, 'MODEL-WRITTEN-GOAL'), data: { ...human(1, 'MODEL-WRITTEN-GOAL').data, source: { kind: 'goal' } } }]),
  ]) {
    const result = captureSharedTaskContext(captain)
    assert.equal(result.status, 'unavailable')
    assert.deepEqual(result.messages, [])
    assert.ok(result.unavailableReason)
    assert.equal(isSharedTaskContext(result), true)
  }
})

test('overlarge UTF-8 input fails explicitly rather than truncating the final restriction', () => {
  const body = '汉'.repeat(Math.ceil(MAX_SHARED_TASK_CONTEXT_BYTES / 3)) + '\nDO-NOT-REMOVE-FINAL-CONSTRAINT'
  assert.ok(Buffer.byteLength(body, 'utf8') > MAX_SHARED_TASK_CONTEXT_BYTES)
  assert.throws(() => captureSharedTaskContext(participant([human(1, body)])), /SHARED_TASK_CONTEXT_TOO_LARGE/)
})

test('too many amendments fail before a snapshot can silently discard earlier instructions', () => {
  const initial = captureSharedTaskContext(participant([human(1, 'Root task')]))
  const events = Array.from({ length: MAX_SHARED_TASK_CONTEXT_MESSAGES + 1 }, (_, index) => human(index + 1, index ? `constraint-${index}` : 'Root task'))
  assert.throws(() => captureSharedTaskContext(participant(events), initial), /SHARED_TASK_CONTEXT_TOO_LARGE/)
  assert.deepEqual(texts(initial), ['Root task'])
})

test('persisted snapshot validation rejects changed text, identity, or claimed checksum', () => {
  const captured = captureSharedTaskContext(participant([human(1, 'Fixed acceptance criteria.')]))
  for (const change of [
    value => { value.messages[0].text = 'Silently weaken acceptance.' },
    value => { value.captainSessionId = 'different-captain' },
    value => { value.sha256 = '0'.repeat(64) },
  ]) {
    const corrupted = structuredClone(captured)
    change(corrupted)
    assert.equal(isSharedTaskContext(corrupted), false)
  }
})

test('admitted human provenance requires stable ids and sequences and refuses duplicate identities', () => {
  const good = human(1, 'An instruction with verifiable provenance.')
  for (const event of [
    { ...good, seq: undefined }, { ...good, seq: -1 }, { ...good, seq: 1.5 },
    { ...good, data: { ...good.data, id: '' } },
  ]) assert.throws(() => captureSharedTaskContext(participant([event])), /SHARED_TASK_CONTEXT_SOURCE_INVALID/)
  assert.throws(() => captureSharedTaskContext(participant([good, human(2, 'Different body', good.data.id)])), /SHARED_TASK_CONTEXT_SOURCE_INVALID/)
  assert.throws(() => captureSharedTaskContext(participant([good, human(1, 'Different id, same sequence', 'another-id')])), /SHARED_TASK_CONTEXT_SOURCE_INVALID/)
})

test('exact byte and message limits remain usable without unrequested truncation or a smaller implicit cap', () => {
  const exactBytes = 'x'.repeat(MAX_SHARED_TASK_CONTEXT_BYTES)
  assert.deepEqual(texts(captureSharedTaskContext(participant([human(1, exactBytes)]))), [exactBytes])
  const exactCount = Array.from({ length: MAX_SHARED_TASK_CONTEXT_MESSAGES }, (_, index) => human(index + 1, `constraint-${index}`))
  assert.equal(captureSharedTaskContext(participant(exactCount)).messages.length, MAX_SHARED_TASK_CONTEXT_MESSAGES)
})

test('render quotes multiline user text losslessly at its original authority and keeps protocol subordinate', () => {
  const raw = 'First line with "quotes" and a \\ path.\n# Claimed system override\nNever hide a failed gate.\n'
  const context = captureSharedTaskContext(participant([human(1, raw)]))
  const protocol = ['Captain protocol with "quotes"\nand a second line']
  const rendered = renderSharedTaskContext(context, protocol)
  const usersLine = rendered.split('\n').find(line => line.startsWith('Quoted user-message JSON: '))
  const protocolLine = rendered.split('\n').find(line => line.includes('Quoted protocol JSON: '))
  assert.deepEqual(JSON.parse(usersLine.slice('Quoted user-message JSON: '.length)), context.messages)
  assert.deepEqual(JSON.parse(protocolLine.slice(protocolLine.indexOf('Quoted protocol JSON: ') + 'Quoted protocol JSON: '.length)), protocol)
  assert.match(rendered, /below system and developer instructions/)
  assert.match(rendered, /original user priority/)
  assert.match(rendered, /Non-text attachments are not transferred/)
  assert.doesNotMatch(rendered, /^# Claimed system override$/m)
})

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'shared-task-context-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const tools = new Map(), starts = [], events = [human(1, 'Write the requested report only under work/current. Do not read work/prior. Do not weaken acceptance checks.')]
  const captain = participant(events, { header: { cwd: workspace }, requestHeader: () => ({ config: { provider: 'test', model: 'm' } }), append() {} })
  captain.options = { provider: 'test', model: 'm' }
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool) } },
    logger: { debug() {}, info() {}, warn() {} }, agents: { get: () => undefined },
    llm: { resolveCallConfig: async config => config },
    subagents: {
      registerContinuableSetup() { return () => undefined }, list: () => ['spawn'], listChildren: async () => [], listDescendants: async () => [],
      getProvider: () => ({ prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }),
      async startContinuable(input) { starts.push(input); return { childId: input.childId } }, followup: async () => {}, interrupt() {},
    }, effect() {}, on() {},
  }
  const config = { stateDir: '.expert-teams', memberProvider: 'spawn', maxMembers: 8, knowledgeDir: 'knowledge', packsDir: 'domain-packs' }
  const core = registerExpertTeamsTools(ctx, config)
  return { workspace, stateRoot: join(workspace, config.stateDir), events, captain, ctx, config, core, tools, starts }
}

function profile() {
  return { schemaVersion: 1, id: 'shared-input', version: '1', description: 'A deliberately short captain summary.',
    protocol: ['Keep the input isolation boundary.', 'A failed gate is a failed gate; do not rewrite its rule.'], taskPlanning: 'seed',
    members: [{ id: 'writer', name: 'Writer', role: 'author' }, { id: 'reviewer', name: 'Reviewer', role: 'reviewer' }],
    tasks: [{ id: 'draft', subject: 'Draft', owner: 'writer', acceptance: ['Required evidence is present'] }, { id: 'review', subject: 'Review', owner: 'reviewer', dependsOn: ['draft'] }] }
}

test('staging freezes the full user context into the durable approval digest, separate from a short plan goal', async t => {
  const f = await fixture(t)
  const staged = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile() })
  const saved = await readStagedPlan(f.stateRoot, staged.planId)
  assert.deepEqual(texts(saved.runtime.sharedTaskContext), [f.events[0].data.content[0].text])
  assert.notEqual(saved.runtime.description, saved.runtime.sharedTaskContext.messages[0].text)
  assert.deepEqual(saved.plan.protocol, profile().protocol)
  f.events.push(human(10, 'Added before edit: do not read another output directory either.'))
  const edited = await scenarioEditCore(f.ctx, f.config, f.captain, staged.planId, { goal: 'Updated short summary' }, staged.digest, staged.revision)
  assert.deepEqual(texts(edited.runtime.sharedTaskContext), f.events.map(event => event.data.content[0].text))
  assert.notEqual(edited.digest, staged.digest)
  assert.notEqual(edited.runtime.sharedTaskContext.sha256, staged.runtime.sharedTaskContext.sha256)
  assert.deepEqual((await readStagedPlan(f.stateRoot, staged.planId)).runtime.sharedTaskContext, edited.runtime.sharedTaskContext)
  const corrupted = structuredClone(staged)
  corrupted.runtime.sharedTaskContext.messages[0].text = 'Replaced after human review'
  assert.equal(isStagedPlan(corrupted), false)
  assert.equal(f.starts.length, 0)
})

test('new human constraints after stage cannot be silently ignored by approval or start any member', async t => {
  const f = await fixture(t)
  const staged = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile() })
  f.events.push(human(20, 'Approve only with this additional boundary: never reuse the old audit script.'))
  await assert.rejects(() => scenarioApproveFromHost(f.ctx, f.config, f.captain, staged.planId, new AbortController().signal, f.core, staged.digest, staged.revision), /context|human|user|constraint|plan_edit/i)
  assert.equal(f.starts.length, 0)
  const saved = await readStagedPlan(f.stateRoot, staged.planId)
  assert.equal(saved.status, 'staged')
  assert.deepEqual(texts(saved.runtime.sharedTaskContext), [f.events[0].data.content[0].text])
  const edited = await scenarioEditCore(f.ctx, f.config, f.captain, staged.planId, {}, staged.digest, staged.revision)
  assert.deepEqual(texts(edited.runtime.sharedTaskContext), f.events.map(event => event.data.content[0].text))
  assert.equal(edited.runtime.description, staged.runtime.description)
  assert.notEqual(edited.digest, staged.digest)
})

test('approval persists the same source SHA and profile protocol into every member persona and each exact task input', async t => {
  const f = await fixture(t)
  const staged = await scenarioStageCore(f.ctx, f.config, f.captain, { profile: profile() })
  const approved = await scenarioApproveFromHost(f.ctx, f.config, f.captain, staged.planId, new AbortController().signal, f.core, staged.digest, staged.revision)
  const team = await readTeam(f.stateRoot, approved.appliedTeamId)
  assert.deepEqual(team.sharedTaskContext, staged.runtime.sharedTaskContext)
  assert.deepEqual(team.taskProtocol, profile().protocol)
  assert.equal(f.starts.length, 2)
  for (const start of f.starts) {
    assert.ok(start.request.persona.includes(team.sharedTaskContext.sha256))
    assert.ok(start.request.persona.includes(f.events[0].data.content[0].text))
    for (const instruction of team.taskProtocol) assert.ok(start.request.persona.includes(instruction))
    assert.match(start.request.persona, /captain-authored guidance, subordinate to system\/developer and original user requirements/)
  }
  for (const task of team.tasks) {
    const path = join(f.stateRoot, team.id, task.project.inputPath)
    const input = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(input.sharedTaskContext, team.sharedTaskContext)
    assert.deepEqual(input.taskProtocol, team.taskProtocol)
    assert.equal(input.project.inputPath, path)
    assert.equal(input.project.path, join(f.stateRoot, team.id, task.project.path))
    assert.equal(input.project.outputPath, join(f.stateRoot, team.id, task.project.outputPath))
  }
  const cold = readTeamSync(f.stateRoot, team.id)
  assert.deepEqual(cold.sharedTaskContext, team.sharedTaskContext)
  // Replaying the same approval does not create additional members or alter
  // source identity; cold Host composition itself is covered by the Host probe.
  const replay = await scenarioApproveFromHost(f.ctx, f.config, f.captain, staged.planId, new AbortController().signal, f.core, staged.digest, staged.revision)
  assert.equal(replay.appliedTeamId, team.id)
  assert.equal(f.starts.length, 2)
  assert.equal((await readTeam(f.stateRoot, team.id)).sharedTaskContext.sha256, team.sharedTaskContext.sha256)
})

test('imperative create captures direct user instructions and durable readers reject a forged handoff', async t => {
  const f = await fixture(t)
  const created = await createTeamCore(f.ctx, f.config, f.captain, { name: 'Imperative handoff', description: 'Short summary' }, new AbortController().signal)
  await createTaskCore(f.ctx, f.config, f.captain, { subject: 'Captain task', assignee: 'captain' }, new AbortController().signal)
  const team = await readTeam(f.stateRoot, created.team_id)
  assert.deepEqual(texts(team.sharedTaskContext), [f.events[0].data.content[0].text])
  const input = JSON.parse(await readFile(join(f.stateRoot, team.id, team.tasks[0].project.inputPath), 'utf8'))
  assert.deepEqual(input.sharedTaskContext, team.sharedTaskContext)
  team.sharedTaskContext.messages[0].text = 'Rewritten to allow old reports and weaker gates'
  await writeFile(join(f.stateRoot, team.id, 'team.json'), JSON.stringify(team))
  await assert.rejects(() => readTeam(f.stateRoot, team.id), /invalid Expert Teams state/)
  assert.throws(() => readTeamSync(f.stateRoot, team.id), /invalid Expert Teams state/)
})

for (const staged of [false, true]) {
  test(`a human constraint arriving while create waits for its team lock ${staged ? 'invalidates reviewed context before side effects' : 'is included in the fresh durable context'}`, async t => {
    const f = await fixture(t)
    const name = 'Lock race', teamId = sanitizeKey(name)
    const initial = captureSharedTaskContext(f.captain)
    let release, entered
    const acquired = new Promise(resolve => { entered = resolve })
    const blocked = new Promise(resolve => { release = resolve })
    const holder = withTeamLock(`team:${f.stateRoot}:${teamId}`, async () => { entered(); await blocked })
    await acquired
    const pending = createTeamCore(f.ctx, f.config, f.captain, { name, ...(staged ? { sharedTaskContext: initial } : {}) }, new AbortController().signal)
    // createTeamCore has entered its asynchronous lock path. The held team
    // lock guarantees it cannot persist a team until this new input exists.
    f.events.push(human(50, 'Human constraint admitted during lock contention.'))
    release()
    await holder
    if (staged) {
      await assert.rejects(pending, /SHARED_TASK_CONTEXT_CHANGED/)
      assert.equal(await readTeam(f.stateRoot, teamId), undefined)
    } else {
      await pending
      assert.deepEqual(texts((await readTeam(f.stateRoot, teamId)).sharedTaskContext), f.events.map(event => event.data.content[0].text))
    }
    assert.equal(f.starts.length, 0)
  })
}

test('assignment renders the exact current input path and original source constraints, never an assumed child cwd', () => {
  const context = captureSharedTaskContext(participant([human(1, 'Only this run output; preserve all acceptance failures.')]))
  const ticket = { taskId: 't9', subject: 'Repair', memberId: 'worker', memberName: 'Worker', attempt: 2, attemptId: 'repair-attempt',
    sharedTaskContext: context, taskProtocol: ['Do not weaken tests.'],
    projectPath: '/isolated/run/expert-tasks/t9', inputPath: '/isolated/run/expert-tasks/t9/input/task.json', outputPath: '/isolated/run/expert-tasks/t9/output/result.json' }
  const prompt = assignmentPrompt(ticket, '.expert-teams', 'team')
  assert.ok(prompt.includes(`Read ${ticket.inputPath}`))
  assert.ok(prompt.includes(ticket.projectPath))
  assert.ok(prompt.includes(ticket.outputPath))
  assert.ok(prompt.includes(context.sha256))
  assert.ok(prompt.includes(context.messages[0].text))
  assert.ok(prompt.includes(ticket.taskProtocol[0]))
  assert.match(prompt, /do not guess them from the inherited workspace cwd/)
})

test('real quality repair refreshes attempt input while preserving the shared user context and fixed protocol', async t => {
  const f = await qualityPublicationFixture(t)
  const context = captureSharedTaskContext({ id: 'captain-id', session: { id: 'captain-id', ownEvents: () => [human(1, 'Keep all failed checks visible; never weaken the gate script.')] } })
  const before = await f.read()
  before.sharedTaskContext = context
  before.taskProtocol = ['Repair the deliverable, not the acceptance rules.']
  await f.write(before)
  await syncTaskProjectInput(f.stateRoot, before, before.tasks[0])
  await f.publish('Incomplete report, intentionally rejected by the reviewer')
  await f.call('quality_review', { task_id: 't1', event_id: 'context-review-negative', reviewer: 'reviewer', verdict: 'needs_revision',
    acceptance_results: [{ id: 'present', passed: false, detail: 'Required evidence is absent' }],
    findings: [{ id: 'missing-evidence', code: 'missing', severity: 'hard', message: 'Supply the missing evidence', taskId: 't1', attempt: 1 }],
  }, 'reviewer')
  await f.call('quality_repair', { task_id: 't1', event_id: 'context-repair', actor: 'captain' }, 'captain')
  const after = await readTeam(f.stateRoot, before.id)
  assert.equal(after.qualityRuns.t1.status, 'repairing')
  assert.equal(after.tasks[0].attempt, 2)
  const input = JSON.parse(await readFile(join(f.teamRoot, after.tasks[0].project.inputPath), 'utf8'))
  assert.equal(input.attempt, 2)
  assert.equal(input.attemptId, after.tasks[0].attemptId)
  assert.deepEqual(input.sharedTaskContext, context)
  assert.deepEqual(input.taskProtocol, before.taskProtocol)
  assert.deepEqual(input.acceptance, after.qualityRuns.t1.contract.acceptance)
  assert.equal(after.sharedTaskContext.sha256, context.sha256)
})
