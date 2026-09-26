/**
 * State-layer regression tests: mailbox concurrency safety and team-record
 * referential integrity. Runs against the built `lib/` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendMailbox, acknowledgeMailbox, admitTeamMessage, createMessage, discardMailbox, readMailbox, readTeam, readUnreadMailbox } from '../lib/state.js'
import { createQualityRun } from '../lib/quality-run.js'

/** Build a minimal durable team.json fixture. */
async function writeTeamFixture(stateRoot, teamId, override) {
  await mkdir(join(stateRoot, teamId), { recursive: true })
  const base = {
    id: teamId,
    name: 'T',
    captainSessionId: 'sess-1',
    createdAt: 1,
    members: [{ id: 'm1', name: 'alice', joinedAt: 1, status: 'idle' }],
    tasks: [
      { id: 't1', subject: 'a', status: 'completed', dependencies: [], attempt: 0, createdAt: 1, updatedAt: 1 },
      { id: 't2', subject: 'b', status: 'pending', dependencies: ['t1'], assignee: 'alice', attempt: 0, createdAt: 1, updatedAt: 1 },
    ],
    taskSeq: 2,
  }
  await writeFile(join(stateRoot, teamId, 'team.json'), JSON.stringify({ ...base, ...override }))
}

function message(i) {
  return { id: `msg-${i}`, from: 'captain', to: 'alice', content: `hello ${i}`, ts: i }
}

test('concurrent appendMailbox calls never lose messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-mailbox-'))
  try {
    const N = 40
    // Fire all appends concurrently WITHOUT the in-process team lock — this
    // is the interleaving a second process would produce.
    await Promise.all(Array.from({ length: N }, (_, i) => appendMailbox(root, 'team', 'alice', message(i))))
    const messages = await readMailbox(root, 'team', 'alice')
    assert.equal(messages.length, N)
    const ids = new Set(messages.map(m => m.id))
    for (let i = 0; i < N; i += 1) assert.ok(ids.has(`msg-${i}`))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('acknowledge racing an append does not drop the new message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-mailbox-'))
  try {
    await appendMailbox(root, 'team', 'alice', message(0))
    // Acknowledge the first message while a concurrent append lands.
    await Promise.all([
      acknowledgeMailbox(root, 'team', 'alice', ['msg-0']),
      appendMailbox(root, 'team', 'alice', message(1)),
    ])
    const messages = await readMailbox(root, 'team', 'alice')
    assert.equal(messages.length, 2)
    assert.equal(messages.find(m => m.id === 'msg-0').readAt !== undefined, true)
    assert.equal(messages.find(m => m.id === 'msg-1').readAt === undefined, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mailbox allocates per-sender sequence and deduplicates idempotency keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-mailbox-'))
  try {
    const first = await appendMailbox(root, 'team', 'alice', createMessage('captain', 'alice', 'one', { idempotencyKey: 'k1' }))
    const duplicate = await appendMailbox(root, 'team', 'alice', createMessage('captain', 'alice', 'one-again', { idempotencyKey: 'k1' }))
    const second = await appendMailbox(root, 'team', 'alice', createMessage('captain', 'alice', 'two'))
    assert.equal(first.sequence, 1)
    assert.equal(duplicate.id, first.id)
    assert.equal(second.sequence, 2)
    assert.equal((await readMailbox(root, 'team', 'alice')).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stale sourced mail is rejected and discarded without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-mailbox-'))
  try {
    const team = {
      id: 'team', name: 'T', captainSessionId: 'sess-1', createdAt: 1,
      members: [{ id: 'm1', name: 'alice', joinedAt: 1, status: 'idle' }],
      tasks: [{ id: 't1', subject: 'a', status: 'in_progress', assignee: 'alice', attempt: 2, attemptId: 'new-attempt', dependencies: [], createdAt: 1, updatedAt: 1 }],
      taskSeq: 1,
    }
    const message = await appendMailbox(root, 'team', 'alice', createMessage('captain', 'alice', 'late', {
      sourceTaskId: 't1', sourceAttemptId: 'old-attempt', sourceTaskStatus: 'in_progress', idempotencyKey: 'late-1',
    }))
    assert.deepEqual(admitTeamMessage(team, message), { accepted: false, reason: 'stale_attempt' })
    await discardMailbox(root, 'team', 'alice', [message.id], 'stale_attempt')
    assert.equal((await readUnreadMailbox(root, 'team', 'alice')).length, 0)
    const stored = (await readMailbox(root, 'team', 'alice'))[0]
    assert.equal(stored.discardReason, 'stale_attempt')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readTeam rejects a dangling task dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-state-'))
  try {
    await writeTeamFixture(root, 'team1', {})
    await writeTeamFixture(root, 'bad-dep', {
      tasks: [
        { id: 't1', subject: 'a', status: 'pending', dependencies: ['t404'], attempt: 0, createdAt: 1, updatedAt: 1 },
      ],
      taskSeq: 1,
    })
    assert.equal((await readTeam(root, 'team1'))?.id, 'team1')
    await assert.rejects(() => readTeam(root, 'bad-dep'), /invalid Expert Teams state/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readTeam rejects a dependency cycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-state-'))
  try {
    await writeTeamFixture(root, 'cycle', {
      tasks: [
        { id: 't1', subject: 'a', status: 'pending', dependencies: ['t2'], attempt: 0, createdAt: 1, updatedAt: 1 },
        { id: 't2', subject: 'b', status: 'pending', dependencies: ['t1'], attempt: 0, createdAt: 1, updatedAt: 1 },
      ],
      taskSeq: 2,
    })
    await assert.rejects(() => readTeam(root, 'cycle'), /invalid Expert Teams state/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readTeam rejects a task assigned to a nonexistent member', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-state-'))
  try {
    await writeTeamFixture(root, 'bad-assignee', {
      tasks: [
        { id: 't1', subject: 'a', status: 'pending', dependencies: [], assignee: 'ghost', attempt: 0, createdAt: 1, updatedAt: 1 },
      ],
      taskSeq: 1,
    })
    await assert.rejects(() => readTeam(root, 'bad-assignee'), /invalid Expert Teams state/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── Apply-bridge provenance fields (additive-optional) ─────────────────────

test('planRef/planProvenance on TeamState and planTask on TeamTask round-trip through readTeam', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-state-'))
  try {
    await writeTeamFixture(root, 'team1', {
      planRef: {
        planId: 'ep-abc123',
        digest: 'deadbeef',
        templateId: 'collab.roundtable',
        templateVersion: '1.0.0-collab',
        scenarioId: 'roundtable',
      },
      planProvenance: {
        params: { topic: '市场是否见底', noteTaker: 'bk-004' },
        compile: [{ step: 'roster.assign', detail: 'slot=role.speaker experts=[bk-004,bk-005]' }],
      },
      tasks: [
        { id: 't1', subject: 'a', status: 'completed', dependencies: [], attempt: 0, createdAt: 1, updatedAt: 1, planTask: { logicalId: 't1', fanOutIndex: 0 } },
        { id: 't2', subject: 'b', status: 'pending', dependencies: ['t1'], assignee: 'alice', attempt: 0, createdAt: 1, updatedAt: 1 },
      ],
    })
    const team = await readTeam(root, 'team1')
    assert.equal(team?.planRef?.planId, 'ep-abc123')
    assert.equal(team?.planRef?.scenarioId, 'roundtable')
    assert.deepEqual(team?.planProvenance?.params, { topic: '市场是否见底', noteTaker: 'bk-004' })
    assert.equal(team?.tasks[0]?.planTask?.logicalId, 't1')
    assert.equal(team?.tasks[0]?.planTask?.fanOutIndex, 0)
    // Optional fields are not required: a legacy record without them still reads.
    assert.equal(team?.tasks[1]?.planTask, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a legacy team record without provenance fields reads back unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-state-'))
  try {
    await writeTeamFixture(root, 'legacy', {})
    const team = await readTeam(root, 'legacy')
    assert.equal(team?.planRef, undefined)
    assert.equal(team?.planProvenance, undefined)
    assert.equal(team?.tasks.every(task => task.planTask === undefined), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('structured qualityRun survives team restart and malformed runs are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-state-'))
  try {
    const qualityRun = createQualityRun({
      id: 'contract-1', taskId: 't2', attempt: 1, assignee: 'alice', kind: 'implementation',
      objective: 'produce the artifact', inScope: ['src/**'], acceptance: [{ id: 'a1', statement: 'it works' }],
      verify: ['pnpm test'], deliverables: ['artifact'], changedPaths: ['src/out.md'],
    }, 'quality-1')
    await writeTeamFixture(root, 'quality-team', { qualityRun })
    const restored = await readTeam(root, 'quality-team')
    assert.equal(restored?.qualityRun?.runId, 'quality-1')
    assert.equal(restored?.qualityRun?.status, 'pending')

    await writeTeamFixture(root, 'bad-quality', { qualityRun: { ...qualityRun, status: 'integrated', events: 'broken' } })
    await assert.rejects(() => readTeam(root, 'bad-quality'), /invalid Expert Teams state/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
