import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { registerExpertTeamsTools } from '../lib/tools.js'
import { createQualityContract, createQualityRun, reviewQualityRun } from '../lib/quality-run.js'
import { memberToolFilter } from '../lib/members.js'

function agent(workspace, id) {
  return { id, session: { header: { cwd: workspace }, events: [], append() {}, steer() {} } }
}

function fakeHost(workspace) {
  const registered = new Map()
  const agents = new Map()
  const ctx = {
    tools: { register(tool) { registered.set(tool.name, tool) } },
    logger: { debug() {}, info() {}, warn() {} },
    subagents: {
      registerContinuableSetup() { return () => undefined }, list: () => [], listChildren: async () => [], listDescendants: async () => [],
      followup: async () => {}, getProvider: () => undefined, startContinuable: async () => { throw new Error('not used') }, interrupt: async () => {},
    },
    agents: { get(id) { return agents.get(id) } },
    effect() {}, on() {},
  }
  registerExpertTeamsTools(ctx, { stateDir: '.expert-teams', memberProvider: 'spawn', maxMembers: 8, knowledgeDir: 'knowledge', packsDir: 'domain-packs' })
  return { ctx, registered, agents, workspace }
}

function contract() {
  return createQualityContract({
    id: 'a6-admission-contract', taskId: 't1', attempt: 1, assignee: 'worker', kind: 'implementation', objective: 'artifact',
    inScope: ['quality-admission/expert-tasks/t1/**'], acceptance: [{ id: 'present', statement: 'output exists' }],
    verify: ['true'], deliverables: ['task-output'], changedPaths: ['quality-admission/expert-tasks/t1/output/result.json'], maxRepairRounds: 1,
  })
}

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'a6-quality-admission-'))
  const stateRoot = join(workspace, '.expert-teams')
  const taskRoot = join(stateRoot, 'quality-admission', 'expert-tasks', 't1', 'output')
  await mkdir(taskRoot, { recursive: true })
  await writeFile(join(taskRoot, 'result.json'), JSON.stringify({ taskId: 't1', status: 'in_progress', attempt: 1, output: 'reviewed-output' }) + '\n')
  const run = createQualityRun(contract(), 'a6-admission-run')
  const team = {
    id: 'quality-admission', name: 'quality admission', captainSessionId: 'captain-id', createdAt: 1,
    members: [
      { id: 'worker-id', name: 'worker', role: 'engineer', joinedAt: 1, status: 'idle' },
      { id: 'reviewer-id', name: 'reviewer', role: 'reviewer', joinedAt: 1, status: 'idle' },
    ],
    tasks: [{ id: 't1', subject: 'artifact', status: 'in_progress', dependencies: [], assignee: 'worker', attempt: 1, attemptId: 'attempt-1', output: 'reviewed-output', createdAt: 1, updatedAt: 1,
      project: { path: 'expert-tasks/t1', inputPath: 'expert-tasks/t1/input/task.json', outputPath: 'expert-tasks/t1/output/result.json', artifactsPath: 'expert-tasks/t1/artifacts', version: 1 } }],
    taskSeq: 1, qualityRun: run, qualityRuns: { t1: run },
  }
  await mkdir(join(stateRoot, team.id), { recursive: true })
  await writeFile(join(stateRoot, team.id, 'team.json'), JSON.stringify(team))
  return { workspace, stateRoot, team, run }
}

function evidence() {
  return {
    artifacts: [{ id: 'task-output', path: 'quality-admission/expert-tasks/t1/output/result.json' }],
    acceptance_results: [{ id: 'present', passed: true, detail: 'present' }],
    changed_paths: ['quality-admission/expert-tasks/t1/output/result.json'],
  }
}

test('quality review requires a real caller identity and rejects self-review', async () => {
  const f = await fixture()
  const host = fakeHost(f.workspace)
  const captain = agent(f.workspace, 'captain-id')
  const reviewer = agent(f.workspace, 'reviewer-id')
  const worker = agent(f.workspace, 'worker-id')
  host.agents.set(captain.id, captain); host.agents.set(reviewer.id, reviewer); host.agents.set(worker.id, worker)
  const tool = host.registered.get('expert_teams_quality_review')
  await assert.rejects(() => tool.execute({ event_id: 'review-forged', task_id: 't1', reviewer: 'reviewer', verdict: 'pass', ...evidence() }, { agent: captain, session: captain.session, signal: new AbortController().signal }), /QUALITY_REVIEWER_IDENTITY/)
  await assert.rejects(() => tool.execute({ event_id: 'review-self', task_id: 't1', reviewer: 'worker', verdict: 'pass', ...evidence() }, { agent: worker, session: worker.session, signal: new AbortController().signal }), /QUALITY_SELF_REVIEW/)
  const result = await tool.execute({ event_id: 'review-real', task_id: 't1', reviewer: 'reviewer', verdict: 'pass', ...evidence() }, { agent: reviewer, session: reviewer.session, signal: new AbortController().signal })
  assert.equal(result.status, 'passed')
  assert.ok(memberToolFilter({ allowedTools: [], maxDepth: 0 }).allow.includes('expert_teams_quality_review'))
})

test('quality integration rejects evidence from a prior task attempt after takeover', async () => {
  const f = await fixture()
  const host = fakeHost(f.workspace)
  const captain = agent(f.workspace, 'captain-id'); const reviewer = agent(f.workspace, 'reviewer-id')
  host.agents.set(captain.id, captain); host.agents.set(reviewer.id, reviewer)
  const reviewed = reviewQualityRun(f.run, {
    eventId: 'review-before-takeover', reviewer: 'reviewer', verdict: 'pass',
    evidence: { taskId: 't1', attempt: 1, artifacts: [{ id: 'task-output', taskId: 't1', attempt: 1, path: 'quality-admission/expert-tasks/t1/output/result.json', sha256: createHash('sha256').update('{}').digest('hex'), content: '{}' }], acceptanceResults: [{ id: 'present', passed: true }], commandsRun: [{ command: 'true', exitCode: 0, passed: true }], changedPaths: ['quality-admission/expert-tasks/t1/output/result.json'] },
  }).run
  const state = JSON.parse(await (await import('node:fs/promises')).readFile(join(f.stateRoot, f.team.id, 'team.json'), 'utf8'))
  state.qualityRun = reviewed; state.qualityRuns.t1 = reviewed; state.tasks[0].assignee = 'captain'; state.tasks[0].attempt = 2; state.tasks[0].attemptId = 'attempt-2'
  await writeFile(join(f.stateRoot, f.team.id, 'team.json'), JSON.stringify(state))
  const integrate = host.registered.get('expert_teams_quality_integrate')
  await assert.rejects(() => integrate.execute({ task_id: 't1', event_id: 'integrate-stale', actor: 'captain' }, { agent: captain, session: captain.session, signal: new AbortController().signal }), /QUALITY_ATTEMPT_MISMATCH/)
})

test('quality integration and completion reject a task output changed after review', async () => {
  const f = await fixture()
  const host = fakeHost(f.workspace)
  const captain = agent(f.workspace, 'captain-id'); const reviewer = agent(f.workspace, 'reviewer-id'); const worker = agent(f.workspace, 'worker-id')
  host.agents.set(captain.id, captain); host.agents.set(reviewer.id, reviewer); host.agents.set(worker.id, worker)
  const review = host.registered.get('expert_teams_quality_review')
  const integrate = host.registered.get('expert_teams_quality_integrate')
  const update = host.registered.get('expert_teams_update_task')
  await review.execute({ event_id: 'review-output-binding', task_id: 't1', reviewer: 'reviewer', verdict: 'pass', ...evidence() }, { agent: reviewer, session: reviewer.session, signal: new AbortController().signal })
  const teamPath = join(f.stateRoot, f.team.id, 'team.json')
  const outputPath = join(f.stateRoot, f.team.id, f.team.tasks[0].project.outputPath)
  const changed = JSON.parse(await (await import('node:fs/promises')).readFile(teamPath, 'utf8'))
  changed.tasks[0].output = 'tampered-after-review'
  await writeFile(teamPath, JSON.stringify(changed))
  await writeFile(outputPath, JSON.stringify({ taskId: 't1', status: 'in_progress', attempt: 1, output: 'tampered-after-review' }) + '\n')
  await assert.rejects(() => integrate.execute({ task_id: 't1', event_id: 'integrate-output-binding', actor: 'captain' }, { agent: captain, session: captain.session, signal: new AbortController().signal }), /QUALITY_OUTPUT_MISMATCH/)
  changed.tasks[0].output = 'reviewed-output'
  await writeFile(teamPath, JSON.stringify(changed))
  await writeFile(outputPath, JSON.stringify({ taskId: 't1', status: 'in_progress', attempt: 1, output: 'reviewed-output' }) + '\n')
  const integrated = await integrate.execute({ task_id: 't1', event_id: 'integrate-output-binding', actor: 'captain' }, { agent: captain, session: captain.session, signal: new AbortController().signal })
  assert.equal(integrated.status, 'integrated')
  const afterIntegration = JSON.parse(await (await import('node:fs/promises')).readFile(teamPath, 'utf8'))
  afterIntegration.tasks[0].output = 'tampered-after-integration'
  await writeFile(teamPath, JSON.stringify(afterIntegration))
  await writeFile(outputPath, JSON.stringify({ taskId: 't1', status: 'in_progress', attempt: 1, output: 'tampered-after-integration' }) + '\n')
  await assert.rejects(() => update.execute({ task_id: 't1', status: 'completed', attempt_id: 'attempt-1' }, { agent: worker, session: worker.session, signal: new AbortController().signal }), /QUALITY_OUTPUT_MISMATCH/)
  afterIntegration.tasks[0].output = 'reviewed-output'
  await writeFile(teamPath, JSON.stringify(afterIntegration))
  await writeFile(outputPath, JSON.stringify({ taskId: 't1', status: 'in_progress', attempt: 1, output: 'reviewed-output' }) + '\n')
  await assert.rejects(() => update.execute({ task_id: 't1', status: 'completed', output: 'override-after-review', attempt_id: 'attempt-1' }, { agent: worker, session: worker.session, signal: new AbortController().signal }), /QUALITY_OUTPUT_MISMATCH/)
})
