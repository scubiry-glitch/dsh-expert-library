/**
 * Phase 0 regression tests: scheduler terminal-state semantics, member model
 * route precedence, and the compensating task commit. Runs against the built
 * `lib/` output (plain JS).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldAutoRetryTask } from '../lib/scheduler.js'
import { memberRouteRequest } from '../lib/members.js'
import { commitTaskUpdate } from '../lib/state.js'

function task(overrides = {}) {
  return {
    id: 't1',
    subject: 'a',
    status: 'failed',
    dependencies: [],
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

// --- 1. scheduler: explicit cancellation is final, only retried failures revive

test('cancelled tasks are never auto-requeued, at any attempt', () => {
  assert.equal(shouldAutoRetryTask(task({ status: 'cancelled', attempt: 1 })), false)
  assert.equal(shouldAutoRetryTask(task({ status: 'cancelled', attempt: 2 })), false)
  assert.equal(shouldAutoRetryTask(task({ status: 'cancelled', attempt: 0 })), false)
})

test('failed tasks auto-requeue only for attempt 1 and 2', () => {
  assert.equal(shouldAutoRetryTask(task({ status: 'failed', attempt: 1 })), true)
  assert.equal(shouldAutoRetryTask(task({ status: 'failed', attempt: 2 })), true)
})

test('failed attempt 0 (legacy) and attempt 3 (budget exhausted) stay terminal', () => {
  assert.equal(shouldAutoRetryTask(task({ status: 'failed', attempt: 0 })), false)
  assert.equal(shouldAutoRetryTask(task({ status: 'failed', attempt: 3 })), false)
  assert.equal(shouldAutoRetryTask(task({ status: 'failed', attempt: undefined })), false)
})

test('non-terminal and other statuses never auto-requeue', () => {
  assert.equal(shouldAutoRetryTask(task({ status: 'pending' })), false)
  assert.equal(shouldAutoRetryTask(task({ status: 'in_progress' })), false)
  assert.equal(shouldAutoRetryTask(task({ status: 'completed' })), false)
})

// --- 2. member route precedence

const configModel = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'medium' }

test('a lone reasoning_effort overrides the config effort but keeps the config route', () => {
  const request = memberRouteRequest({ reasoning_effort: 'max' }, undefined, configModel)
  assert.deepEqual(request, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'max',
  })
})

test('no explicit route and no effort falls back to the config route with its effort', () => {
  const request = memberRouteRequest({}, undefined, configModel)
  assert.deepEqual(request, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'medium',
  })
})

test('explicit provider/model keep the defaultModel hint and the explicit effort', () => {
  const request = memberRouteRequest(
    { provider: 'other', model: 'm1', reasoning_effort: 'high' },
    undefined,
    configModel,
  )
  assert.deepEqual(request, {
    provider: 'other',
    model: 'm1',
    defaultModel: 'deepseek-v4-flash',
    reasoningEffort: 'high',
  })
})

test('the preset expert route wins over explicit arguments and config', () => {
  const request = memberRouteRequest(
    { provider: 'other', model: 'm1', reasoning_effort: 'high' },
    { provider: 'expert-provider', model: 'expert-model', reasoningEffort: 'low' },
    configModel,
  )
  assert.deepEqual(request, {
    provider: 'expert-provider',
    model: 'expert-model',
    reasoningEffort: 'low',
  })
})

test('without expert and config, a lone effort rides on the captain route placeholders', () => {
  const request = memberRouteRequest({ reasoning_effort: 'max' }, undefined, undefined)
  assert.deepEqual(request, { reasoningEffort: 'max' })
})

// --- 3. compensating task commit

test('commitTaskUpdate writes the project first and the team record second', async () => {
  const calls = []
  await commitTaskUpdate('root', { id: 'team' }, task(), task(), {
    writeProject: async () => { calls.push('project') },
    writeTeamRecord: async () => { calls.push('team') },
  })
  assert.deepEqual(calls, ['project', 'team'])
})

test('a project write failure never touches the team record', async () => {
  let teamWritten = false
  await assert.rejects(
    () => commitTaskUpdate('root', { id: 'team' }, task(), task(), {
      writeProject: async () => { throw new Error('disk full') },
      writeTeamRecord: async () => { teamWritten = true },
    }),
    /disk full/,
  )
  assert.equal(teamWritten, false)
})

test('a team write failure restores the project from the snapshot and surfaces the original error', async () => {
  const written = []
  const mutated = task({ status: 'completed', output: 'done' })
  const snapshot = task({ status: 'in_progress' })
  const error = await commitTaskUpdate('root', { id: 'team' }, mutated, snapshot, {
    writeProject: async (current) => { written.push(current.status) },
    writeTeamRecord: async () => { throw new Error('team.json locked') },
  }).then(() => null, (reason) => reason)
  assert.ok(error instanceof Error)
  assert.match(error.message, /team\.json locked/)
  // The mutated task was written first, then rolled back with the snapshot.
  assert.deepEqual(written, ['completed', 'in_progress'])
})

test('a rollback failure during a team-write failure aggregates both errors', async () => {
  let firstProjectWriteDone = false
  const error = await commitTaskUpdate('root', { id: 'team' }, task(), task(), {
    writeProject: async () => {
      if (firstProjectWriteDone) throw new Error('rollback failed')
      firstProjectWriteDone = true
    },
    writeTeamRecord: async () => { throw new Error('team.json locked') },
  }).then(() => null, (reason) => reason)
  assert.ok(error instanceof AggregateError, `expected AggregateError, got ${String(error)}`)
  assert.equal(error.errors.length, 2)
  assert.match(error.errors[0].message, /team\.json locked/)
  assert.match(error.errors[1].message, /rollback failed/)
})

test('production defaults write real files: project output, then team.json stays consistent', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-commit-'))
  try {
    const team = {
      id: 'team1', name: 'T', captainSessionId: 's1', createdAt: 1,
      members: [], tasks: [], taskSeq: 1,
    }
    const withProject = task({
      status: 'completed',
      output: 'done',
      project: { path: 'tasks/t1', outputPath: 'tasks/t1/output.json' },
    })
    const snapshot = task({
      status: 'in_progress',
      project: { path: 'tasks/t1', outputPath: 'tasks/t1/output.json' },
    })
    await mkdir(join(root, 'team1', 'tasks', 't1'), { recursive: true })
    await writeFile(join(root, 'team1', 'team.json'), JSON.stringify(team), 'utf8')
    await commitTaskUpdate(root, team, withProject, snapshot)
    const output = JSON.parse(await readFile(join(root, 'team1', 'tasks', 't1', 'output.json'), 'utf8'))
    assert.equal(output.status, 'completed')
    assert.equal(output.output, 'done')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
