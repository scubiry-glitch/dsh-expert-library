/**
 * Plan capability gate tests (architecture gap #3) — `expert_provider_call`
 * must enforce the compiled plan's per-task `allowedCapabilities` at execute
 * time.
 *
 * Covers:
 * - pure `resolveCapabilityAllowance` semantics: undefined team/session → open;
 *   captain → open; member union over plan-linked tasks; `[]` = none allowed;
 *   legacy team (no `planTaskCapabilities`) → open; member without plan-linked
 *   tasks → open; removed member → open; unknown logicalId → open;
 * - end-to-end through the registered tool with a real (temp-dir) team record:
 *   blocked member gets a never-retry `CAPABILITY_NOT_ALLOWED` whose
 *   correction lists the allowance, BEFORE resolution/invocation; allowed
 *   capability passes; legacy team unaffected; captain unaffected;
 *   empty-set semantics block even a valid capability;
 * - `planTaskCapabilities` round-trips through the durable team record.
 *
 * All offline: fake service, temp-dir team fixtures, no network.
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerProviderCallTool, resolveCapabilityAllowance } from '../lib/host/provider-tool.js'
import { readTeam } from '../lib/state.js'
import { okEnvelope } from '../lib/v2/index.js'

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

/** Minimal durable team record; `override` replaces any field wholesale. */
function planTeam(override) {
  return {
    id: 'team1',
    name: '计划团队',
    captainSessionId: 'sess-captain',
    createdAt: 1,
    members: [
      { id: 'sess-alice', name: 'alice', joinedAt: 1, status: 'idle' },
      { id: 'sess-bob', name: 'bob', joinedAt: 1, status: 'idle' },
      { id: 'sess-ghost', name: 'ghost', joinedAt: 1, status: 'removed' },
    ],
    tasks: [
      { id: 't1', subject: 'a', status: 'in_progress', dependencies: [], assignee: 'alice', attempt: 0, createdAt: 1, updatedAt: 1, planTask: { logicalId: 't1', fanOutIndex: 0 } },
      { id: 't2', subject: 'b', status: 'in_progress', dependencies: [], assignee: 'bob', attempt: 0, createdAt: 1, updatedAt: 1, planTask: { logicalId: 't2', fanOutIndex: 0 } },
      { id: 't3', subject: 'c', status: 'in_progress', dependencies: [], assignee: 'alice', attempt: 0, createdAt: 1, updatedAt: 1, planTask: { logicalId: 't3', fanOutIndex: 0 } },
      { id: 't4', subject: 'imperative', status: 'in_progress', dependencies: [], assignee: 'bob', attempt: 0, createdAt: 1, updatedAt: 1 },
    ],
    taskSeq: 4,
    planRef: { planId: 'ep-x', digest: 'd', templateId: 'tpl', templateVersion: '1.0.0' },
    planProvenance: { params: {}, compile: [] },
    planTaskCapabilities: {
      t1: ['financial.stock.snapshot'],
      t2: ['realestate.listing.search', 'realestate.market.trend'],
      t3: ['financial.stock.snapshot', 'financial.macro.query'],
    },
    ...override,
  }
}

/** Drop every plan-provenance field → a legacy/ad-hoc team record. */
function legacyTeam(override = {}) {
  const { planRef, planProvenance, planTaskCapabilities, ...rest } = planTeam()
  return { ...rest, ...override }
}

/** Write one team record under a fresh temp workspace state root. */
async function writeTeamFixture(workspace, teamId, team) {
  await mkdir(join(workspace, 'expert-teams', teamId), { recursive: true })
  await writeFile(join(workspace, 'expert-teams', teamId, 'team.json'), JSON.stringify({ ...team, id: teamId }))
}

/** Session-shaped exec for the tool; `cwd` points at the temp workspace. */
function memberExec(sessionId, cwd, agentId = sessionId) {
  return { agent: { id: agentId, session: { id: sessionId, header: { cwd } } }, signal: new AbortController().signal }
}

const readBinding = {
  capability: 'financial.stock.snapshot',
  providerId: 'wind',
  providerVersion: '1.0.0',
  operation: 'financial.stock.snapshot',
  transportId: 'cli',
  caliber: 'wind 实时行情口径',
  reason: 'test',
  boundAt: '2026-08-22T00:00:00.000Z',
}

/** Fake provider service that records resolve/invoke traffic. */
function fakeService(calls) {
  return {
    providers: ['wind'],
    availableCredentials: () => ['WIND_API_KEY'],
    resolver: {
      resolve: (request) => {
        calls.push(['resolve', request.capability])
        return {
          capability: request.capability,
          status: 'bound',
          binding: { ...readBinding, capability: request.capability },
          rejections: [],
        }
      },
    },
    invoke: async (request) => {
      calls.push(['invoke', request.binding.capability])
      return okEnvelope({ ok: true }, { provider: 'wind', operation: request.binding.capability })
    },
  }
}

function registerAndGetTool(service) {
  let registered = null
  const ctx = {
    tools: { register: (tool) => { registered = tool } },
    get: (name) => name === 'providerTransport' ? service : undefined,
  }
  registerProviderCallTool(ctx)
  assert.ok(registered, 'tool must be registered')
  return registered
}

/* ---------------------------------------------------------------------------
 * Pure resolution semantics
 * ------------------------------------------------------------------------- */

test('resolveCapabilityAllowance: no team / no session → open', () => {
  assert.deepEqual(resolveCapabilityAllowance(undefined, 'sess-alice'), { constrained: false, allowed: [], fromTasks: [] })
  assert.deepEqual(resolveCapabilityAllowance(planTeam(), undefined), { constrained: false, allowed: [], fromTasks: [] })
})

test('resolveCapabilityAllowance: captain keeps full access even under a constrained plan', () => {
  const allowance = resolveCapabilityAllowance(planTeam(), 'sess-captain')
  assert.equal(allowance.constrained, false)
  assert.deepEqual(allowance.allowed, [])
})

test('resolveCapabilityAllowance: legacy team without planTaskCapabilities stays open', () => {
  const allowance = resolveCapabilityAllowance(legacyTeam(), 'sess-alice')
  assert.equal(allowance.constrained, false)
})

test('resolveCapabilityAllowance: member union over plan-linked tasks with dedupe', () => {
  // alice owns t1 (snapshot) and t3 (snapshot + macro.query) → union.
  const allowance = resolveCapabilityAllowance(planTeam(), 'sess-alice')
  assert.equal(allowance.constrained, true)
  assert.deepEqual(allowance.allowed, ['financial.stock.snapshot', 'financial.macro.query'])
  assert.deepEqual(allowance.fromTasks, ['t1', 't3'])
})

test('resolveCapabilityAllowance: empty allowedCapabilities set means none allowed (constrained, empty union)', () => {
  const team = planTeam({ planTaskCapabilities: { t1: [] } })
  const allowance = resolveCapabilityAllowance(team, 'sess-alice')
  assert.equal(allowance.constrained, true)
  assert.deepEqual(allowance.allowed, [])
  assert.deepEqual(allowance.fromTasks, ['t1'])
})

test('resolveCapabilityAllowance: tasks without planTask linkage contribute nothing', () => {
  // bob owns t2 (linked) and t4 (imperative, unlinked) → constrained by t2 only.
  const allowance = resolveCapabilityAllowance(planTeam(), 'sess-bob')
  assert.equal(allowance.constrained, true)
  assert.deepEqual(allowance.allowed, ['realestate.listing.search', 'realestate.market.trend'])
  assert.deepEqual(allowance.fromTasks, ['t2'])
})

test('resolveCapabilityAllowance: member with only unlinked tasks stays open', () => {
  const team = planTeam({ tasks: [planTeam().tasks[3]] })
  const allowance = resolveCapabilityAllowance(team, 'sess-bob')
  assert.equal(allowance.constrained, false)
})

test('resolveCapabilityAllowance: rostered member with no assigned tasks stays open', () => {
  const team = planTeam({ tasks: [] })
  const allowance = resolveCapabilityAllowance(team, 'sess-alice')
  assert.equal(allowance.constrained, false)
})

test('resolveCapabilityAllowance: removed member stays open', () => {
  const allowance = resolveCapabilityAllowance(planTeam(), 'sess-ghost')
  assert.equal(allowance.constrained, false)
})

test('resolveCapabilityAllowance: logicalId missing from the persisted map stays open (defensive)', () => {
  const team = planTeam({ planTaskCapabilities: { t1: ['financial.stock.snapshot'] } })
  // alice's t3 maps to logicalId t3 which is absent → only t1 constrains.
  const allowance = resolveCapabilityAllowance(team, 'sess-alice')
  assert.equal(allowance.constrained, true)
  assert.deepEqual(allowance.allowed, ['financial.stock.snapshot'])
  assert.deepEqual(allowance.fromTasks, ['t1'])
})

/* ---------------------------------------------------------------------------
 * End-to-end through the registered tool (temp-dir team records)
 * ------------------------------------------------------------------------- */

test('member blocked for a capability not in the plan → CAPABILITY_NOT_ALLOWED before resolution', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'expert-teams-gate-'))
  try {
    await writeTeamFixture(workspace, 'team1', planTeam())
    const calls = []
    const tool = registerAndGetTool(fakeService(calls))
    const result = await tool.execute(
      { capability: 'realestate.rent.appoint', input: {} },
      memberExec('sess-alice', workspace),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'CAPABILITY_NOT_ALLOWED')
    assert.equal(result.error.retry, 'never')
    assert.match(result.error.correction, /financial\.stock\.snapshot/)
    assert.match(result.error.correction, /financial\.macro\.query/)
    assert.deepEqual(result.error.details.allowed, ['financial.stock.snapshot', 'financial.macro.query'])
    assert.deepEqual(result.error.details.tasks, ['t1', 't3'])
    // The gate sits BEFORE capability resolution: neither resolve nor invoke ran.
    assert.deepEqual(calls, [])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('member allowed for a capability granted by the plan passes through', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'expert-teams-gate-'))
  try {
    await writeTeamFixture(workspace, 'team1', planTeam())
    const calls = []
    const tool = registerAndGetTool(fakeService(calls))
    const result = await tool.execute(
      { capability: 'financial.stock.snapshot', input: {} },
      memberExec('sess-alice', workspace),
    )
    assert.equal(result.ok, true)
    assert.deepEqual(calls, [['resolve', 'financial.stock.snapshot'], ['invoke', 'financial.stock.snapshot']])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('legacy team (no plan capability info) is unaffected — call passes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'expert-teams-gate-'))
  try {
    await writeTeamFixture(workspace, 'legacy1', legacyTeam())
    const calls = []
    const tool = registerAndGetTool(fakeService(calls))
    const result = await tool.execute(
      { capability: 'realestate.rent.appoint', input: {} },
      memberExec('sess-alice', workspace),
    )
    assert.equal(result.ok, true)
    assert.deepEqual(calls, [['resolve', 'realestate.rent.appoint'], ['invoke', 'realestate.rent.appoint']])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('captain is unaffected even when the plan constrains members', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'expert-teams-gate-'))
  try {
    await writeTeamFixture(workspace, 'team1', planTeam())
    const calls = []
    const tool = registerAndGetTool(fakeService(calls))
    const result = await tool.execute(
      { capability: 'realestate.rent.appoint', input: {} },
      memberExec('sess-captain', workspace),
    )
    assert.equal(result.ok, true)
    assert.deepEqual(calls, [['resolve', 'realestate.rent.appoint'], ['invoke', 'realestate.rent.appoint']])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('empty-set semantics: a member whose tasks allow nothing is blocked for any capability', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'expert-teams-gate-'))
  try {
    // alice's only task grants [] — a capability the resolver would bind fine.
    await writeTeamFixture(workspace, 'team1', planTeam({ planTaskCapabilities: { t1: [] } }))
    const calls = []
    const tool = registerAndGetTool(fakeService(calls))
    const result = await tool.execute(
      { capability: 'financial.stock.snapshot', input: {} },
      memberExec('sess-alice', workspace),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'CAPABILITY_NOT_ALLOWED')
    assert.equal(result.error.retry, 'never')
    assert.match(result.error.correction, /为空/)
    assert.deepEqual(result.error.details.allowed, [])
    assert.deepEqual(calls, [])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('blocked error surfaces the correction through the renderer', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'expert-teams-gate-'))
  try {
    await writeTeamFixture(workspace, 'team1', planTeam())
    const tool = registerAndGetTool(fakeService([]))
    const args = { capability: 'realestate.rent.appoint', input: {} }
    const result = await tool.execute(args, memberExec('sess-alice', workspace))
    const text = tool.output.render(args, result)[0].text
    assert.match(text, /CAPABILITY_NOT_ALLOWED/)
    assert.match(text, /financial\.stock\.snapshot/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------------------------
 * Durable-record round-trip
 * ------------------------------------------------------------------------- */

test('planTaskCapabilities round-trips through readTeam like the other plan provenance fields', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'expert-teams-gate-'))
  try {
    await writeTeamFixture(workspace, 'team1', planTeam())
    const team = await readTeam(join(workspace, 'expert-teams'), 'team1')
    assert.deepEqual(team?.planTaskCapabilities, {
      t1: ['financial.stock.snapshot'],
      t2: ['realestate.listing.search', 'realestate.market.trend'],
      t3: ['financial.stock.snapshot', 'financial.macro.query'],
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
