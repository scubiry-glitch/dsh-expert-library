import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerExpertTeamsTools } from '../../lib/tools.js'
import { createQualityRun } from '../../lib/quality-run.js'

// Real registered tools and durable filesystem state; only the model-facing
// Host transport is substituted. No live team, model or provider is contacted.
export async function qualityPublicationFixture(t, { verify = ['node --version'] } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'published-review-admission-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const stateRoot = join(workspace, '.expert-teams')
  const teamId = 'publication-admission'
  const teamRoot = join(stateRoot, teamId)
  const project = {
    path: 'expert-tasks/t1', inputPath: 'expert-tasks/t1/input/task.json',
    outputPath: 'expert-tasks/t1/output/result.json', artifactsPath: 'expert-tasks/t1/artifacts', version: 1,
  }
  for (const dir of ['input', 'output', 'artifacts']) await mkdir(join(teamRoot, project.path, dir), { recursive: true })
  const task = {
    id: 't1', subject: 'Publish the report', status: 'in_progress', assignee: 'worker', attempt: 1,
    attemptId: 'publication-attempt-1', dependencies: [], output: 'Reviewable report', createdAt: 1, updatedAt: 1, project,
  }
  const run = createQualityRun({
    id: 'publication-contract', taskId: 't1', attempt: 1, assignee: 'worker', kind: 'implementation',
    objective: task.subject, inScope: [`${teamId}/${project.path}/**`],
    acceptance: [{ id: 'present', statement: 'The publication is independently reviewed' }],
    verify, deliverables: ['task-output'], changedPaths: [`${teamId}/${project.path}/output/**`], maxRepairRounds: 2,
  }, 'publication-run')
  await writeFile(join(teamRoot, project.outputPath), JSON.stringify({ taskId: task.id, status: task.status, attempt: 1, output: task.output }))
  await writeFile(join(teamRoot, 'team.json'), JSON.stringify({
    id: teamId, name: teamId, captainSessionId: 'captain-id', createdAt: 1,
    members: ['worker', 'reviewer'].map(name => ({ id: `${name}-id`, name, joinedAt: 1, status: 'idle' })),
    tasks: [task], taskSeq: 1, qualityRun: run, qualityRuns: { t1: run },
  }))
  const registered = new Map()
  const agents = new Map(['captain', 'worker', 'reviewer'].map(name => [`${name}-id`, {
    id: `${name}-id`, status: 'idle', whenIdle: async () => {},
    session: { header: { cwd: workspace }, events: [], append() {}, steer() {} },
  }]))
  const ctx = {
    tools: { register(tool) { registered.set(tool.name, tool) } },
    agents: { get(id) { return agents.get(id) } },
    logger: { debug() {}, info() {}, warn() {} },
    subagents: {
      registerContinuableSetup() { return () => undefined }, list: () => [], listChildren: async () => [], listDescendants: async () => [],
      followup: async () => {}, getProvider: () => undefined,
      startContinuable: async () => { throw new Error('unexpected model spawn') }, interrupt() {},
    },
    effect() {}, on() {},
  }
  registerExpertTeamsTools(ctx, { stateDir: '.expert-teams', memberProvider: 'spawn', maxMembers: 8, knowledgeDir: 'knowledge', packsDir: 'domain-packs' })
  const call = async (name, args, caller) => {
    const tool = registered.get(`expert_teams_${name}`)
    assert.ok(tool)
    const agent = agents.get(`${caller}-id`)
    return tool.execute(args, { agent, session: agent.session, signal: new AbortController().signal })
  }
  return {
    stateRoot, workspace, teamRoot, registered, call,
    read: async () => JSON.parse(await readFile(join(teamRoot, 'team.json'), 'utf8')),
    write: team => writeFile(join(teamRoot, 'team.json'), JSON.stringify(team)),
    async publish(content) {
      await writeFile(join(teamRoot, project.path, 'artifacts/report.txt'), content)
      return call('publish_artifact', { task_id: 't1', attempt_id: task.attemptId, source_path: 'artifacts/report.txt', name: 'report.txt' }, 'worker')
    },
    review: eventId => call('quality_review', {
      task_id: 't1', event_id: eventId, reviewer: 'reviewer', verdict: 'pass',
      acceptance_results: [{ id: 'present', passed: true }],
    }, 'reviewer'),
  }
}
