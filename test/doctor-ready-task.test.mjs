import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectExpertTeamsState } from '../lib/doctor.js'
import { createTeamDir } from '../lib/state.js'

test('doctor flags only assigned, ready tasks stuck at attempt zero', async t => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-ready-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const old = 1_000
  const fresh = 10 * 60_000
  const task = (id, overrides = {}) => ({ id, subject: id, status: 'pending', attempt: 0,
    assignee: 'writer', dependencies: [], createdAt: old, updatedAt: old, ...overrides })
  await createTeamDir(root, { id: 'team', name: 'team', captainSessionId: 'captain', createdAt: old,
    members: [{ id: 'writer', name: 'writer', joinedAt: old, status: 'idle' }],
    tasks: [
      task('stuck'),
      task('recent', { createdAt: fresh, updatedAt: fresh }),
      task('blocked', { dependencies: ['recent'] }),
      task('external', { executionState: 'blocked_external' }),
    ], taskSeq: 4 })
  const report = await inspectExpertTeamsState(root, fresh + 60_000)
  assert.deepEqual(report.findings.filter(finding => finding.code === 'task.ready_unclaimed').map(finding => finding.path),
    [join(root, 'team', 'team.json') + ':task:stuck'])
})
