import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { activateTaskAttempt, admitTeamMessage, createMessage, finalizeTerminalTask } from '../lib/state.js'
import { registerExpertTeamsTools } from '../lib/tools.js'

function baseTask(overrides = {}) {
  return {
    id: 't1', subject: 'completion', status: 'in_progress', dependencies: [],
    assignee: 'worker', attempt: 1, attemptId: 'attempt-1', createdAt: 1, updatedAt: 1,
    ...overrides,
  }
}

function terminalTeam(task) {
  return {
    id: 'team', name: 'team', captainSessionId: 'captain-id', createdAt: 1,
    members: [{ id: 'worker-id', name: 'worker', joinedAt: 1, status: 'idle' }],
    tasks: [task], taskSeq: 1,
  }
}

test('terminal finalization retains only the exact retired generation for delayed mail', () => {
  const task = baseTask({ status: 'completed' })
  finalizeTerminalTask(task)
  assert.equal(task.attemptId, undefined)
  assert.equal(task.finalizedAttemptId, 'attempt-1')

  const accepted = createMessage('worker', 'captain', 'done', {
    sourceTaskId: 't1', sourceAttemptId: 'attempt-1', sourceTaskStatus: 'in_progress',
  })
  assert.deepEqual(admitTeamMessage(terminalTeam(task), accepted), { accepted: true })
  assert.deepEqual(admitTeamMessage(terminalTeam(task), { ...accepted, sourceAttemptId: 'old' }), { accepted: false, reason: 'stale_attempt' })
  assert.deepEqual(admitTeamMessage(terminalTeam(task), { ...accepted, sourceAttemptId: undefined }), { accepted: false, reason: 'missing_attempt' })

  const next = baseTask({ status: 'pending', attemptId: undefined, finalizedAttemptId: 'attempt-1' })
  const nextId = activateTaskAttempt(next, 'worker')
  assert.equal(next.finalizedAttemptId, undefined)
  assert.equal(next.attemptId, nextId)
})

function agent(workspace, id) {
  return { id, session: { header: { cwd: workspace }, events: [], append() {}, steer() {} } }
}

function fakeHost() {
  const registered = new Map()
  const ctx = {
    tools: { register(tool) { registered.set(tool.name, tool) } },
    logger: { debug() {}, info() {}, warn() {} },
    subagents: { registerContinuableSetup() { return () => undefined }, list: () => [], listChildren: async () => [], listDescendants: async () => [], followup: async () => {}, getProvider: () => undefined, startContinuable: async () => { throw new Error('not used') }, interrupt: async () => {} },
    agents: { get() { return undefined } }, effect() {}, on() {},
  }
  registerExpertTeamsTools(ctx, { stateDir: '.expert-teams', memberProvider: 'spawn', maxMembers: 8, knowledgeDir: 'knowledge', packsDir: 'domain-packs' })
  return registered
}

test('send_message requires the finalized attempt for an explicit terminal task source', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'a6-message-finalization-'))
  const stateRoot = join(workspace, '.expert-teams', 'team')
  await mkdir(join(stateRoot, 'inbox'), { recursive: true })
  const task = baseTask({ status: 'completed', attemptId: undefined, finalizedAttemptId: 'attempt-1' })
  await writeFile(join(stateRoot, 'team.json'), JSON.stringify(terminalTeam(task)))
  const registered = fakeHost()
  const tool = registered.get('expert_teams_send_message')
  const worker = agent(workspace, 'worker-id')
  const run = (args) => tool.execute(args, { agent: worker, session: worker.session, signal: new AbortController().signal })

  await assert.rejects(() => run({ to: 'captain', task_id: 't1', content: 'late' }), /finalized attempt_id/)
  const result = await run({ to: 'captain', task_id: 't1', attempt_id: 'attempt-1', content: 'done' })
  assert.equal(result.to, 'captain')
  const lines = (await readFile(join(stateRoot, 'inbox', 'captain.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(lines[0].sourceAttemptId, 'attempt-1')
})
