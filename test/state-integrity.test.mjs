/**
 * State-layer regression tests: mailbox concurrency safety and team-record
 * referential integrity. Runs against the built `lib/` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { appendMailbox, acknowledgeMailbox, admitTeamMessage, createMessage, discardMailbox, findTeamRouteHeaderByCaptain, readMailbox, readTeam, readTeamActivity, readTeamRouteHeader, readTeamSync, readUnreadMailbox, writeTeam } from '../lib/state.js'
import { createQualityRun, reviewQualityRun } from '../lib/quality-run.js'
import { assembleTeamSnapshot } from '../lib/snapshot.js'

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
    await assert.rejects(
      () => appendMailbox(root, 'team', 'alice', createMessage('captain', 'alice', 'one-again', { idempotencyKey: 'k1' })),
      /MAILBOX_IDEMPOTENCY_CONFLICT/,
    )
    const second = await appendMailbox(root, 'team', 'alice', createMessage('captain', 'alice', 'two'))
    assert.equal(first.sequence, 1)
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

test('validated snapshots stay isolated and changed bytes are revalidated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-state-cache-'))
  try {
    await writeTeamFixture(root, 'cached', {})
    const first = await readTeam(root, 'cached')
    assert.ok(first)
    first.tasks[0].subject = 'mutated only in memory'
    const second = readTeamSync(root, 'cached')
    assert.equal(second?.tasks[0].subject, 'a')
    assert.notStrictEqual(second, first)

    await writeTeamFixture(root, 'cached', {
      tasks: [{ id: 't1', subject: 'a', status: 'pending', dependencies: ['t404'], attempt: 0, createdAt: 1, updatedAt: 1 }],
      taskSeq: 1,
    })
    await assert.rejects(() => readTeam(root, 'cached'), /invalid Expert Teams state/)
    assert.throws(() => readTeamSync(root, 'cached'), /invalid Expert Teams state/)

    await writeTeamFixture(root, 'cached', {})
    assert.equal((await readTeam(root, 'cached'))?.tasks.length, 2)
    await mkdir(join(root, 'different'), { recursive: true })
    const sameBytes = await readFile(join(root, 'cached', 'team.json'))
    await writeFile(join(root, 'different', 'team.json'), sameBytes)
    await assert.rejects(() => readTeam(root, 'different'), /invalid Expert Teams state/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('activity projection omits review history without changing the durable team', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-activity-cache-'))
  try {
    const run = createQualityRun({
      id: 'contract-1', taskId: 't2', attempt: 1, assignee: 'alice', kind: 'implementation',
      objective: 'produce the artifact', inScope: ['src/**'], acceptance: [{ id: 'a1', statement: 'it works' }],
      verify: ['pnpm test'], deliverables: ['artifact'], changedPaths: ['src/out.md'],
    }, 'quality-1')
    await writeTeamFixture(root, 'activity', { qualityRuns: { t2: run }, qualityRunHistory: { t2: [] } })
    const first = await readTeamActivity(root, 'activity')
    assert.equal(first?.tasks.length, 2)
    assert.equal(first?.qualityRuns, undefined)
    const ctx = { agents: { get: () => undefined }, logger: { warn: () => undefined } }
    assert.deepEqual(
      await assembleTeamSnapshot(ctx, root, 'workspace', first),
      await assembleTeamSnapshot(ctx, root, 'workspace', await readTeam(root, 'activity')),
    )
    first.tasks[0].subject = 'modified in caller'
    const second = await readTeamActivity(root, 'activity')
    assert.equal(second?.tasks[0].subject, 'a')
    assert.equal((await readTeam(root, 'activity'))?.qualityRuns?.t2?.runId, 'quality-1')

    await writeTeamFixture(root, 'activity', { name: 'Changed', qualityRuns: { t2: run } })
    assert.equal((await readTeamActivity(root, 'activity'))?.name, 'Changed')
    await writeTeamFixture(root, 'activity', { tasks: [{ id: 't1', subject: 'a', status: 'pending', dependencies: ['missing'], attempt: 0, createdAt: 1, updatedAt: 1 }], taskSeq: 1 })
    await assert.rejects(() => readTeamActivity(root, 'activity'), /invalid Expert Teams state/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('customer route header follows durable ownership changes and rejects duplicate teams', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-route-header-'))
  try {
    await writeTeamFixture(root, 'first', {})
    await mkdir(join(root, 'plans'))
    assert.equal((await findTeamRouteHeaderByCaptain(root, 'sess-1'))?.id, 'first')
    const first = await readTeamRouteHeader(root, 'first')
    assert.equal(first?.captainSessionId, 'sess-1')
    assert.deepEqual(first?.activeMemberIds, ['m1'])
    first.activeMemberIds.push('poison')
    assert.deepEqual((await readTeamRouteHeader(root, 'first'))?.activeMemberIds, ['m1'])
    await writeTeamFixture(root, 'first', { captainSessionId: 'sess-2' })
    assert.equal(await findTeamRouteHeaderByCaptain(root, 'sess-1'), undefined)
    assert.equal((await findTeamRouteHeaderByCaptain(root, 'sess-2'))?.id, 'first')
    await writeTeamFixture(root, 'second', { captainSessionId: 'sess-2' })
    await assert.rejects(() => findTeamRouteHeaderByCaptain(root, 'sess-2'), /multiple active teams/)
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

test('compact team file restores root alias and review evidence without changing legacy semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-teams-compact-'))
  try {
    const content = 'research evidence\n'.repeat(20_000)
    const contract = {
      id: 'contract-1', taskId: 't2', attempt: 1, assignee: 'alice', kind: 'implementation',
      objective: 'produce the artifact', inScope: ['src/**'], acceptance: [{ id: 'a1', statement: 'it works' }],
      verify: ['true'], deliverables: ['artifact'], changedPaths: ['src/out.md'],
    }
    const run = reviewQualityRun(createQualityRun(contract, 'quality-1'), {
      eventId: 'review-1', reviewer: 'reviewer', verdict: 'pass',
      evidence: { taskId: 't2', attempt: 1, artifacts: [{ id: 'artifact', taskId: 't2', attempt: 1,
        path: 'src/out.md', sha256: createHash('sha256').update(content).digest('hex'), content }],
        acceptanceResults: [{ id: 'a1', passed: true }], commandsRun: [{ command: 'true', exitCode: 0, passed: true }],
        changedPaths: ['src/out.md'] },
    }).run
    await writeTeamFixture(root, 'compact', { qualityRun: run, qualityRuns: { t2: run } })
    const path = join(root, 'compact', 'team.json')
    const legacyBytes = (await readFile(path)).length
    const legacy = await readTeam(root, 'compact')
    await writeTeam(root, legacy)
    const compactRaw = await readFile(path, 'utf8')
    const disk = JSON.parse(compactRaw)
    assert.ok(compactRaw.length < legacyBytes * 0.4, `${compactRaw.length} / ${legacyBytes}`)
    assert.equal(disk.teamStorageFormat, 2)
    assert.equal(disk.qualityRunTaskId, 't2')
    assert.equal(disk.qualityRun, undefined)
    assert.equal(disk.qualityRuns.t2.latestEvidence, undefined)
    assert.deepEqual(await readTeam(root, 'compact'), legacy)
    assert.deepEqual(readTeamSync(root, 'compact'), legacy)
    assert.equal((await readTeamActivity(root, 'compact')).id, 'compact')
    disk.qualityRunTaskId = 'missing'
    await writeFile(path, JSON.stringify(disk))
    await assert.rejects(() => readTeam(root, 'compact'), /invalid Expert Teams quality run reference/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
