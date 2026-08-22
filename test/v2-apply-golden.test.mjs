/**
 * Golden contract tests for the apply bridge: the physical DAG produced from
 * a compiled V1 scenario (the `expert_teams_scenario_apply` path) is exactly
 * the DAG the previous imperative `scenarioApplyCore` built — task ids,
 * subjects after the six V1 placeholder keys, dependencies, assignees, and
 * the member add order (`scenario.experts` first). Runs against the built
 * `lib/` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { compileV1ScenarioExecutionPlan } from '../lib/v2/index.js'
import { expandExecutionPlan } from '../lib/apply.js'

/** Minimal V1 Expert fixture (same shape as the bridge tests). */
function expert(id) {
  return { id, name: `Expert ${id}`, role: 'research', background: '背景', principles: ['结论先行'], deliverables: ['研判稿'] }
}

/** A V1 scenario whose DAG mirrors a real registry scenario (has a shared task). */
function v1Scenario(overrides = {}) {
  return {
    id: 'market-research',
    name: 'Market Research',
    description: '调研',
    // Assembly roster: 'designer' owns no task but must still be a member.
    experts: ['researcher', 'data-analyst', 'designer'],
    tasks: [
      { subject: '界定问题', description: '目标：{goal}', expert: 'researcher' },
      { subject: '数据搜集（{city}）', expert: 'data-analyst', dependsOn: [0] },
      { subject: '数据分析', expert: 'data-analyst', dependsOn: [1] },
      { subject: '调研报告', dependsOn: [2] }, // shared — no expert
    ],
    deliverable: '调研报告',
    ...overrides,
  }
}

const EXPERTS = [expert('researcher'), expert('data-analyst'), expert('designer')]

const V1_OPTS = {
  teamName: 'Market Research',
  description: '调研',
  interpolations: {
    goal: '调研 2026 市场',
    team_name: 'Market Research',
    scenario: 'market-research',
    data: '样本 1000',
    city: '上海',
    period: '2026H1',
  },
  // The previous assembler added members in scenario.experts order.
  memberOrder: ['researcher', 'data-analyst', 'designer'],
}

test('golden: V1 scenario expands to the exact imperative DAG (ids/subjects/deps/assignees)', () => {
  const result = compileV1ScenarioExecutionPlan(EXPERTS, v1Scenario())
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors))
  if (!result.ok) return
  const expanded = expandExecutionPlan(result.plan, V1_OPTS)

  // Member add order = scenario.experts order (memberOrder knob).
  assert.deepEqual(expanded.members.map(member => member.expertId), ['researcher', 'data-analyst', 'designer'])

  // Physical tasks t1..t4, ids/deps/subjects identical to the imperative core.
  assert.deepEqual(expanded.tasks.map(task => task.id), ['t1', 't2', 't3', 't4'])
  assert.deepEqual(expanded.tasks.map(task => task.dependsOn), [[], ['t1'], ['t2'], ['t3']])
  assert.deepEqual(expanded.tasks.map(task => task.subject), [
    '界定问题',
    '数据搜集（上海）',
    '数据分析',
    '调研报告',
  ])
  // Assignees: researcher, data-analyst, data-analyst, shared (unassigned).
  assert.deepEqual(expanded.tasks.map(task => task.assigneeExpertId), ['researcher', 'data-analyst', 'data-analyst', undefined])
  // Description interpolation: {goal} resolves, {city} resolves, missing keys → ''.
  assert.equal(expanded.tasks[0]?.description, '目标：调研 2026 市场')

  // Provenance: the legacy template + scenario identity, digest stable.
  assert.deepEqual(expanded.planRef, {
    planId: result.plan.planId,
    digest: result.plan.digest,
    templateId: 'market-research.legacy-team',
    templateVersion: '0.0.0-legacy',
    scenarioId: 'market-research',
  })
})

test('golden: every V1 placeholder key resolves (missing → empty), unknown tokens stay verbatim', () => {
  const scenario = v1Scenario({
    tasks: [
      { subject: '{goal} / {team_name} / {scenario} / {data} / {city} / {period} / {missing}', expert: 'researcher' },
    ],
  })
  const result = compileV1ScenarioExecutionPlan(EXPERTS, scenario)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const expanded = expandExecutionPlan(result.plan, V1_OPTS)
  assert.equal(
    expanded.tasks[0]?.subject,
    '调研 2026 市场 / Market Research / market-research / 样本 1000 / 上海 / 2026H1 / {missing}',
  )
})

test('golden: the skill task suffix appends after interpolation (and becomes the description when none)', () => {
  const result = compileV1ScenarioExecutionPlan(EXPERTS, v1Scenario())
  assert.equal(result.ok, true)
  if (!result.ok) return
  const expanded = expandExecutionPlan(result.plan, {
    ...V1_OPTS,
    // The adapter trims the block for description-less tasks (no leading \n\n).
    taskSuffixes: { t4: 'SKILL_BLOCK' },
  })
  // t4 has no description of its own → the suffix becomes the description.
  assert.equal(expanded.tasks[3]?.description, 'SKILL_BLOCK')
})

test('golden: a skill bound to a described task appends the block to the interpolated text', () => {
  const scenario = v1Scenario({
    tasks: [
      { subject: '界定问题', description: '目标：{goal}', expert: 'researcher' },
    ],
  })
  const result = compileV1ScenarioExecutionPlan(EXPERTS, scenario)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const expanded = expandExecutionPlan(result.plan, {
    ...V1_OPTS,
    taskSuffixes: { t1: '\n\nSKILL_BLOCK' },
  })
  assert.equal(expanded.tasks[0]?.description, '目标：调研 2026 市场\n\nSKILL_BLOCK')
})

test('golden: expansion is deterministic for the V1 bridge (identical twice)', () => {
  const result = compileV1ScenarioExecutionPlan(EXPERTS, v1Scenario())
  assert.equal(result.ok, true)
  if (!result.ok) return
  const a = expandExecutionPlan(result.plan, V1_OPTS)
  const b = expandExecutionPlan(result.plan, V1_OPTS)
  assert.deepEqual(a, b)
})
