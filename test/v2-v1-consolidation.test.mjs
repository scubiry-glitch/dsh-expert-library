/**
 * V1 dual-track consolidation tests: the process-wide cached builtin legacy
 * DomainPack (`builtinLegacyPack`) is built once and reused — object identity
 * is stable across calls; `compileV1ScenarioExecutionPlan` looks the builtin
 * scenario's legacy template up in the cache (compiled plan digest identical
 * to a fresh per-call build for multiple scenarios); caller-provided scenario
 * variants (fixtures / user-pack overrides) still compile byte-identically to
 * the pre-consolidation per-call projection, with preset model routes
 * preserved; and the collab projection reuses the cached expert entities.
 * Runs against the built `lib/` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compileV1ScenarioExecutionPlan,
  buildLegacyDomainPack,
  compileExecutionPlan,
  builtinLegacyPack,
  validateDomainPack,
} from '../lib/v2/index.js'
import { BUILTIN_EXPERT_BY_ID } from '../lib/expert-library/builtin-experts.js'
import { BUILTIN_SCENARIO_BY_ID } from '../lib/expert-library/builtin-scenarios.js'
import { ZHIJIAN_EXPERT_BY_ID } from '../lib/zhijian/registry.js'
import { buildCollabDomainPack } from '../lib/collab/templates.js'

const ALL_BUILTIN_EXPERTS = [...BUILTIN_EXPERT_BY_ID.values(), ...ZHIJIAN_EXPERT_BY_ID.values()]

/** The V1 roster assignment semantics (as documented in src/v2/compat.ts). */
function v1Assignments(scenario) {
  const assignments = {}
  for (const expertId of scenario.experts) {
    const slot = `role.${expertId}`
    if (assignments[slot] === undefined) assignments[slot] = [expertId]
  }
  for (const task of scenario.tasks) {
    if (task.expert === undefined) continue
    const slot = `role.${task.expert}`
    if (assignments[slot] === undefined) assignments[slot] = [task.expert]
  }
  if (scenario.tasks.some(task => task.expert === undefined)) assignments['role.shared'] = []
  return assignments
}

/** The pre-consolidation path: a fresh per-call legacy pack for one scenario. */
function freshCompile(experts, scenario) {
  return compileExecutionPlan({
    pack: buildLegacyDomainPack({ experts, scenarios: [scenario] }),
    templateId: `${scenario.id}.legacy-team`,
    scenarioId: scenario.id,
    binding: { assignments: v1Assignments(scenario) },
  })
}

// ── 1. Cache idempotency ────────────────────────────────────────────────────

test('builtinLegacyPack returns the same object identity every call, covering the full builtin library', () => {
  const a = builtinLegacyPack()
  const b = builtinLegacyPack()
  assert.equal(a, b, 'module-level singleton must be stable across calls')
  assert.equal(a.experts.length, BUILTIN_EXPERT_BY_ID.size + ZHIJIAN_EXPERT_BY_ID.size, 'all builtin experts (通用 + 智见 bk-*)')
  assert.equal(a.scenarios.length, BUILTIN_SCENARIO_BY_ID.size, 'all builtin scenarios')
  assert.equal(a.teamTemplates.length, BUILTIN_SCENARIO_BY_ID.size, 'one legacy team template per builtin scenario')
  const validation = validateDomainPack(a)
  assert.equal(validation.ok, true, validation.diagnostics.filter(d => d.severity === 'error').map(d => d.message).join('; '))
})

test('compiled plan digest is stable across two compileV1ScenarioExecutionPlan calls', () => {
  const scenario = BUILTIN_SCENARIO_BY_ID.get('market-research')
  const a = compileV1ScenarioExecutionPlan(ALL_BUILTIN_EXPERTS, scenario)
  const b = compileV1ScenarioExecutionPlan(ALL_BUILTIN_EXPERTS, scenario)
  assert.equal(a.ok, true, a.ok ? '' : JSON.stringify(a.errors))
  assert.equal(b.ok, true)
  if (a.ok && b.ok) {
    assert.equal(a.plan.digest, b.plan.digest)
    assert.deepEqual(a.plan, b.plan)
  }
})

// ── 2. Cached lookup == fresh per-call build (builtin scenarios) ────────────

test('builtin scenario compile from the cache equals a fresh-build compile (2+ scenarios, digest equal)', () => {
  for (const id of ['market-research', 'code-review']) {
    const scenario = BUILTIN_SCENARIO_BY_ID.get(id)
    const cached = compileV1ScenarioExecutionPlan(ALL_BUILTIN_EXPERTS, scenario)
    const fresh = freshCompile(ALL_BUILTIN_EXPERTS, scenario)
    assert.equal(cached.ok, true, `${id}: ${cached.ok ? '' : JSON.stringify(cached.errors)}`)
    assert.equal(fresh.ok, true, `${id}: ${fresh.ok ? '' : JSON.stringify(fresh.errors)}`)
    if (cached.ok && fresh.ok) {
      assert.equal(cached.plan.digest, fresh.plan.digest, `digest must match the fresh build for ${id}`)
      assert.deepEqual(cached.plan, fresh.plan)
    }
  }
})

// ── 3. Caller-provided variants still compile byte-identically ──────────────

test('a non-builtin scenario variant (fixture) compiles byte-identically to the fresh per-call build', () => {
  const fixture = {
    id: 'market-research',
    name: 'Market Research',
    description: 'fixture',
    experts: ['researcher', 'data-analyst'],
    tasks: [
      { subject: '界定问题', expert: 'researcher' },
      { subject: '数据搜集', expert: 'data-analyst', dependsOn: [0] },
      { subject: '调研报告', dependsOn: [1] },
    ],
    deliverable: 'd',
  }
  const experts = [BUILTIN_EXPERT_BY_ID.get('researcher'), BUILTIN_EXPERT_BY_ID.get('data-analyst')]
  const cached = compileV1ScenarioExecutionPlan(experts, fixture)
  const fresh = freshCompile(experts, fixture)
  assert.equal(cached.ok, true, cached.ok ? '' : JSON.stringify(cached.errors))
  assert.equal(fresh.ok, true)
  if (cached.ok && fresh.ok) {
    assert.equal(cached.plan.digest, fresh.plan.digest)
    assert.deepEqual(cached.plan, fresh.plan)
  }
  // The variant's own subjects survive — the cache must not leak the builtin ones.
  if (cached.ok) {
    assert.deepEqual(cached.plan.tasks.map(task => task.subject), ['界定问题', '数据搜集', '调研报告'])
  }
})

test('re-adaptation wins over cached entities when a builtin-id expert is overridden (preset route preserved)', () => {
  // A user override of a builtin id WITHOUT a model route must not inherit the
  // cached entity's modelPolicy — the compiled roster stays route-less.
  const override = { id: 'researcher', name: 'User Researcher', role: 'research', background: 'b', principles: ['p'], deliverables: ['d'] }
  const scenario = {
    id: 'doc', name: 'Doc', description: 'd',
    experts: ['researcher'], tasks: [{ subject: 'A', expert: 'researcher' }], deliverable: 'd',
  }
  const cached = compileV1ScenarioExecutionPlan([override], scenario)
  assert.equal(cached.ok, true, cached.ok ? '' : JSON.stringify(cached.errors))
  if (cached.ok) {
    const member = cached.plan.roster.find(m => m.expertId === 'researcher')
    assert.equal(member?.modelPolicy, undefined, 'override without a model must not pick up the cached modelPolicy')
  }
})

// ── 4. Collab still works and reuses the cached expert entities ─────────────

test('buildCollabDomainPack reuses the cached expert entities by reference and still compiles', () => {
  const cached = builtinLegacyPack()
  const pack = buildCollabDomainPack(ALL_BUILTIN_EXPERTS)
  // Builtin experts are the cached objects — no second projection.
  assert.equal(pack.experts.find(expert => expert.id === 'researcher'), cached.experts.find(expert => expert.id === 'researcher'))
  assert.equal(pack.experts.find(expert => expert.id === 'bk-024'), cached.experts.find(expert => expert.id === 'bk-024'))
  // Still validator-clean and compilable.
  const validation = validateDomainPack(pack)
  assert.equal(validation.ok, true, validation.diagnostics.filter(d => d.severity === 'error').map(d => d.message).join('; '))
  const debate = compileExecutionPlan({
    pack,
    templateId: 'collab.cross-debate',
    scenarioId: 'cross-debate',
    params: { topic: 'T', pro: 'bk-024', con: 'bk-008', moderator: 'team-lead' },
    binding: { assignments: { 'role.moderator': ['team-lead'], 'role.pro': ['bk-024'], 'role.con': ['bk-008'] } },
  })
  assert.equal(debate.ok, true, debate.ok ? '' : JSON.stringify(debate.errors))
})

test('collab pack re-adapts non-builtin experts instead of using the cache', () => {
  const pack = buildCollabDomainPack([{ id: 'custom', name: 'Custom', role: 'r', background: 'b', principles: [], deliverables: [] }])
  const custom = pack.experts.find(expert => expert.id === 'custom')
  assert.ok(custom !== undefined, 'custom expert must be present')
  assert.equal(custom.display.internalName, 'Custom')
})
