/**
 * Golden tests for the V1→V2 compiler bridge `compileV1ScenarioExecutionPlan`
 * (src/v2/compat.ts): a legacy V1 scenario compiles through the V2
 * TeamTemplate compiler with a task DAG isomorphic to V1's `t1..tn`, and the
 * V1 **assembly-roster** semantics — every `scenario.experts` entry is
 * rostered through its own `role.<expertId>` slot, even when the expert owns
 * no task, while `role.shared` (min 0) stays empty/unassigned. The bridge
 * returns the exact same CompileResult as calling `compileExecutionPlan`
 * directly. Runs against the built `lib/`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compileV1ScenarioExecutionPlan,
  compileExecutionPlan,
  buildLegacyDomainPack,
  validateDomainPack,
} from '../lib/v2/index.js'

/** Minimal V1 Expert fixture (same shape as the migrate/legacy tests). */
function expert(id) {
  return {
    id,
    name: `Expert ${id}`,
    role: 'research',
    background: '背景',
    principles: ['结论先行'],
    deliverables: ['研判稿'],
  }
}

/** A V1 scenario whose task DAG mirrors a real registry scenario. */
function v1Scenario(overrides = {}) {
  return {
    id: 'market-research',
    name: 'Market Research',
    description: '调研',
    // Assembly roster: 'designer' owns no task but must still be rostered.
    experts: ['researcher', 'data-analyst', 'designer'],
    tasks: [
      { subject: '界定问题', expert: 'researcher' },
      { subject: '数据搜集', expert: 'data-analyst', dependsOn: [0] },
      { subject: '数据分析', expert: 'data-analyst', dependsOn: [1] },
      { subject: '调研报告', dependsOn: [2] }, // shared — no expert
    ],
    deliverable: '调研报告',
    ...overrides,
  }
}

const EXPERTS = [expert('researcher'), expert('data-analyst'), expert('designer')]

// ── 1. Golden isomorphism: task ids / dependencies / subjects === V1 t1..tn ──

test('golden: compiled task ids/dependencies/subjects are isomorphic to V1 t1..tn', () => {
  const scenario = v1Scenario()
  const result = compileV1ScenarioExecutionPlan(EXPERTS, scenario)
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors))
  if (!result.ok) return
  const plan = result.plan

  // Task ids follow V1's t1..tn array-order convention.
  assert.deepEqual(plan.tasks.map(task => task.id), ['t1', 't2', 't3', 't4'])
  assert.deepEqual(plan.executionOrder, ['t1', 't2', 't3', 't4'])

  // dependsOn indexes become t{n+1} references, isomorphic to V1.
  assert.deepEqual(plan.tasks[0].dependsOn, [])
  assert.deepEqual(plan.tasks[1].dependsOn, ['t1'])
  assert.deepEqual(plan.tasks[2].dependsOn, ['t2'])
  assert.deepEqual(plan.tasks[3].dependsOn, ['t3'])

  // Subjects survive verbatim in order.
  assert.deepEqual(plan.tasks.map(task => task.subject), ['界定问题', '数据搜集', '数据分析', '调研报告'])

  // Template/scenario identity of the legacy projection.
  assert.deepEqual(plan.template, { id: 'market-research.legacy-team', version: '0.0.0-legacy' })
  assert.deepEqual(plan.scenario, { id: 'market-research', version: '0.0.0-legacy' })
})

// ── 2. Assembly roster: every scenario.experts entry is compiled ─────────────

test('roster includes every scenario.experts entry, task-ownership notwithstanding', () => {
  const result = compileV1ScenarioExecutionPlan(EXPERTS, v1Scenario())
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors))
  if (!result.ok) return
  const { roster } = result.plan

  const bySlot = (slotId) => roster.filter(member => member.slotId === slotId).map(member => member.expertId)
  assert.deepEqual(bySlot('role.researcher'), ['researcher'])
  assert.deepEqual(bySlot('role.data-analyst'), ['data-analyst'])
  // 'designer' owns no task but is in scenario.experts — its unreferenced
  // role slot still compiles through the explicit assignment.
  assert.deepEqual(bySlot('role.designer'), ['designer'])
  // role.shared (min 0) stays empty/unassigned — never auto-filled.
  assert.deepEqual(bySlot('role.shared'), [])
  assert.equal(roster.length, 3)
})

test('the legacy team template declares a role slot per scenario.experts entry', () => {
  const pack = buildLegacyDomainPack({ experts: EXPERTS, scenarios: [v1Scenario()] })
  const slotIds = pack.teamTemplates[0].slots.map(slot => slot.id).sort()
  assert.deepEqual(slotIds, ['role.data-analyst', 'role.designer', 'role.researcher', 'role.shared'])
  for (const slot of pack.teamTemplates[0].slots) {
    assert.deepEqual(slot.cardinality, { min: 0, max: 1 })
  }
})

// ── 3. Same CompileResult as a direct compileExecutionPlan delegation ────────

test('bridge returns the same CompileResult as the direct compileExecutionPlan call', () => {
  const scenario = v1Scenario()
  const direct = compileExecutionPlan({
    pack: buildLegacyDomainPack({ experts: EXPERTS, scenarios: [scenario] }),
    templateId: 'market-research.legacy-team',
    scenarioId: 'market-research',
    binding: {
      assignments: {
        'role.researcher': ['researcher'],
        'role.data-analyst': ['data-analyst'],
        'role.designer': ['designer'],
        'role.shared': [],
      },
    },
  })
  const bridged = compileV1ScenarioExecutionPlan(EXPERTS, scenario)
  assert.equal(direct.ok, true)
  assert.equal(bridged.ok, true)
  if (direct.ok && bridged.ok) {
    assert.deepEqual(bridged.plan, direct.plan)
    assert.equal(bridged.plan.digest, direct.plan.digest)
  }
})

test('bridge is deterministic: two calls produce byte-identical plans', () => {
  const a = compileV1ScenarioExecutionPlan(EXPERTS, v1Scenario())
  const b = compileV1ScenarioExecutionPlan(EXPERTS, v1Scenario())
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  if (a.ok && b.ok) {
    assert.deepEqual(a.plan, b.plan)
    assert.equal(a.plan.digest, b.plan.digest)
  }
})

// ── 4. Deliverables / pack validity ──────────────────────────────────────────

test('compiled deliverables collect every task and resolve the legacy output template', () => {
  const result = compileV1ScenarioExecutionPlan(EXPERTS, v1Scenario())
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors))
  if (!result.ok) return
  const plan = result.plan
  assert.equal(plan.deliverables.length, 1)
  assert.deepEqual(plan.deliverables[0].fromTasks, ['t1', 't2', 't3', 't4'])
  assert.equal(plan.deliverables[0].outputTemplate, 'market-research.legacy-output')
})

test('the bridge pack itself is validator-clean (conservative legacy views)', () => {
  const pack = buildLegacyDomainPack({ experts: EXPERTS, scenarios: [v1Scenario()] })
  const validation = validateDomainPack(pack)
  assert.equal(validation.ok, true)
  assert.deepEqual(validation.diagnostics.filter(diag => diag.severity === 'error'), [])
})

// ── 5. Failure semantics surface structured roster errors, never throws ──────

test('a task assigning an expert outside the experts list fails with a roster error', () => {
  const scenario = v1Scenario({ tasks: [{ subject: 'x', expert: 'nobody' }] })
  const result = compileV1ScenarioExecutionPlan(EXPERTS, scenario)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errorKind, 'roster')
  assert.ok(result.errors.some(error => error.code === 'unknown-expert'))
  assert.ok(result.errors.some(error => error.path === 'binding.assignments.role.nobody'))
})

test('an expert in scenario.experts but missing from the experts list fails as unknown', () => {
  const scenario = v1Scenario({ experts: ['researcher', 'ghost'] })
  const result = compileV1ScenarioExecutionPlan(EXPERTS, scenario)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errorKind, 'roster')
  assert.ok(result.errors.some(error => error.code === 'unknown-expert' && error.path === 'binding.assignments.role.ghost'))
})

test('a shared-only scenario rosters scenario.experts via unreferenced slots; role.shared stays empty', () => {
  const scenario = v1Scenario({
    tasks: [
      { subject: 'A' },
      { subject: 'B', dependsOn: [0] },
    ],
  })
  const result = compileV1ScenarioExecutionPlan(EXPERTS, scenario)
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors))
  if (!result.ok) return
  const plan = result.plan
  assert.deepEqual(plan.tasks.map(task => task.id), ['t1', 't2'])
  assert.deepEqual(plan.tasks.map(task => task.subject), ['A', 'B'])
  assert.deepEqual(plan.tasks[1].dependsOn, ['t1'])
  assert.deepEqual(plan.tasks.map(task => task.role), ['role.shared', 'role.shared'])
  // Every scenario.experts entry is rostered through its unreferenced slot…
  const bySlot = (slotId) => plan.roster.filter(member => member.slotId === slotId).map(member => member.expertId)
  assert.deepEqual(bySlot('role.researcher'), ['researcher'])
  assert.deepEqual(bySlot('role.data-analyst'), ['data-analyst'])
  assert.deepEqual(bySlot('role.designer'), ['designer'])
  // …while role.shared (min 0) has no member.
  assert.deepEqual(bySlot('role.shared'), [])
  assert.equal(plan.roster.length, 3)
})

test('legacy tools are untouched: the bridge never mutates its inputs', () => {
  const experts = EXPERTS.map(item => ({ ...item }))
  const scenario = v1Scenario()
  const before = JSON.stringify({ experts, scenario })
  compileV1ScenarioExecutionPlan(experts, scenario)
  assert.equal(JSON.stringify({ experts, scenario }), before)
})
