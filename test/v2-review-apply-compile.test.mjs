/**
 * Review-apply compile tests: `expert_review_apply` is a thin adapter that
 * compiles `zhijian.team.<framework>` (via `buildZhijianDomainPack`) with the
 * user-sign-off `selectedExpertIds` plus the runtime-shape params, then
 * applies the plan. These tests lock the compile contract: roster from the
 * selection, reviewer fan-out, the fusion task staying unassigned, and the
 * compiler's enforcement (deceased, framework-D diversity, scenario primary
 * field). Runs against the built `lib/` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { compileExecutionPlan, buildZhijianDomainPack } from '../lib/v2/index.js'
import { expandExecutionPlan } from '../lib/apply.js'
import { ZHIJIAN_EXPERTS } from '../lib/zhijian/data/experts.generated.js'

const metaById = new Map(ZHIJIAN_EXPERTS.map(meta => [meta.id, meta]))

function displayMap(ids) {
  return new Map(ids.map(id => {
    const meta = metaById.get(id)
    return [id, { name: meta.name, field: meta.field, initials: meta.initials }]
  }))
}

function compileReview(framework, selectedExpertIds, overrides = {}) {
  const base = {
    selectedExpertIds,
    data: '上海 2026-07 二手房市场',
    dataContext: '数据本体：上海 2026-07 二手房市场\n数据来源：贝壳\n城市/区域：上海\n数据时段：2026-07',
    frameworkName: '五维递进',
    frameworkSteps: '1. 一句话定性\n2. 指标解读',
    frameworkConstraints: '1. 结论先行\n2. 数字带口径',
    wordLimitLine: '\n字数约束：约 500 字 ±10%',
    frameworkWordLimitParen: '（约 500 字 ±10%）',
    outputFormText: '讨论稿',
    fusionExtraRules: '5. 数字必须核实',
    outputForm: 'discussion',
    ...overrides,
  }
  return compileExecutionPlan({
    pack: buildZhijianDomainPack(),
    templateId: `zhijian.team.${framework}`,
    ...(overrides.scenarioId === undefined ? {} : { scenarioId: overrides.scenarioId }),
    params: base,
  })
}

// ── 1. Roster + fan-out + fusion unassigned ─────────────────────────────────

test('framework A: roster = selected ids, reviewer fan-out, fusion task unassigned', () => {
  const result = compileReview('A', ['bk-024', 'bk-025'])
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors))
  if (!result.ok) return
  const plan = result.plan
  const reviewers = plan.roster.filter(member => member.slotId === 'role.reviewer')
  assert.deepEqual(reviewers.map(member => member.expertId), ['bk-024', 'bk-025'])
  assert.equal(reviewers[0]?.approval, 'user-signoff')
  const t1 = plan.tasks.find(task => task.id === 't1')
  const t2 = plan.tasks.find(task => task.id === 't2')
  assert.deepEqual(t1?.expertIds, ['bk-024', 'bk-025'])
  // role.fusion is optional (min 0) → the fusion task stays in the shared pool.
  assert.deepEqual(t2?.expertIds, [])
  assert.deepEqual(plan.executionOrder, ['t1', 't2'])
  assert.deepEqual(plan.bindings.tool, [])

  // Physical expansion: one review per selected expert + one unassigned fusion.
  const expanded = expandExecutionPlan(plan, { teamName: 'T', description: '', expertDisplay: displayMap(['bk-024', 'bk-025']) })
  assert.deepEqual(expanded.tasks.map(task => task.id), ['t1', 't2', 't3'])
  assert.deepEqual(expanded.tasks.map(task => task.assigneeExpertId), ['bk-024', 'bk-025', undefined])
  assert.deepEqual(expanded.tasks[2]?.dependsOn, ['t1', 't2'])
  assert.deepEqual(expanded.members.map(member => member.expertId), ['bk-024', 'bk-025'])
})

test('review copy reproduces the V1 strings after interpolation (subject, steps, constraints, fusion)', () => {
  const result = compileReview('A', ['bk-024'])
  assert.equal(result.ok, true)
  if (!result.ok) return
  const expanded = expandExecutionPlan(result.plan, {
    teamName: 'T', description: '', expertDisplay: displayMap(['bk-024']),
  })
  const meta = metaById.get('bk-024')
  const review = expanded.tasks[0]
  const fusion = expanded.tasks[1]
  // Subject: 专家研判：<name>（<field>·<initials>）
  assert.equal(review?.subject, `专家研判：${meta.name}（${meta.field}·${meta.initials}）`)
  // Description: framework name, data context, numbered steps/constraints,
  // word-limit line, anonymization note — exactly the V1 assembler's text.
  assert.equal(
    review?.description,
    `以专家「${meta.name}」身份独立研判，输出框架 五维递进。\n\n数据本体：上海 2026-07 二手房市场\n数据来源：贝壳\n城市/区域：上海\n数据时段：2026-07\n\n1. 一句话定性\n2. 指标解读\n字数约束：约 500 字 ±10%\n约束：1. 结论先行\n2. 数字带口径\n匿名标注：文内身份只标「${meta.field}·${meta.initials}」。完成后提交完整点评文本到 output。`,
  )
  // Fusion: {dependencies} = comma-joined physical review ids; output form and
  // the literal `5. ` fusion rules are folded in.
  assert.ok(fusion?.description.startsWith('综合以下专家研判任务：t1（用 expert_teams_status 读取各任务 output）。'))
  assert.ok(fusion?.description.includes('框架：五维递进（约 500 字 ±10%）'))
  assert.ok(fusion?.description.includes('输出形态：讨论稿。'))
  assert.ok(fusion?.description.includes('5. 数字必须核实'))
  assert.ok(fusion?.description.endsWith('完成后把全文写入 output。'))
  assert.equal(fusion?.subject, '融合合成与渲染（讨论稿/正式稿）')
})

test('1 and 5 selected experts expand to 1..1 and 1..5 reviews', () => {
  const one = compileReview('A', ['bk-002'])
  assert.equal(one.ok, true)
  if (one.ok) {
    const expanded = expandExecutionPlan(one.plan, { teamName: 'T', description: '' })
    assert.equal(expanded.tasks.length, 2)
  }
  const five = compileReview('A', ['bk-002', 'bk-003', 'bk-004', 'bk-005', 'bk-006'])
  assert.equal(five.ok, true, five.ok ? '' : JSON.stringify(five.errors))
  if (five.ok) {
    const expanded = expandExecutionPlan(five.plan, { teamName: 'T', description: '' })
    assert.equal(expanded.tasks.length, 6)
    assert.deepEqual(expanded.tasks[5]?.dependsOn, ['t1', 't2', 't3', 't4', 't5'])
  }
})

// ── 2. Compiler enforcement (documented tightening) ─────────────────────────

test('deceased expert (bk-022) is rejected by the roster gate', () => {
  const result = compileReview('B', ['bk-022'])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errorKind, 'roster')
  assert.ok(result.errors.some(error => error.code === 'deceased-expert'))
})

test('framework D requires ≥2 distinct fields; same-field selection fails, 2-field passes', () => {
  const sameField = compileReview('D', ['bk-024', 'bk-025'])
  assert.equal(sameField.ok, false)
  if (!sameField.ok) {
    assert.ok(sameField.errors.some(error => error.code === 'diversity-fields-unsatisfied'))
  }
  const twoFields = compileReview('D', ['bk-024', 'bk-002'])
  assert.equal(twoFields.ok, true, twoFields.ok ? '' : JSON.stringify(twoFields.errors))
})

test('scenario-bound review enforces the primary-field capability (zhijian-monthly needs 行业研究)', () => {
  // bk-002 is 居住服务 → does not claim realestate.research.review.
  const missing = compileReview('A', ['bk-002'], { scenarioId: 'zhijian-monthly' })
  assert.equal(missing.ok, false)
  if (!missing.ok) {
    assert.ok(missing.errors.some(error => error.code === 'required-capability-unsatisfied'))
  }
  // bk-024 claims realestate.research.review → compiles.
  const present = compileReview('A', ['bk-024'], { scenarioId: 'zhijian-monthly' })
  assert.equal(present.ok, true, present.ok ? '' : JSON.stringify(present.errors))
  if (present.ok) assert.equal(present.plan.scenario?.id, 'zhijian-monthly')
})

// ── 3. No scenario / invalid inputs ─────────────────────────────────────────

test('compile without a scenario leaves plan.scenario undefined (the adapter note branch)', () => {
  const result = compileReview('B', ['bk-004'])
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.plan.scenario, undefined)
  const expanded = expandExecutionPlan(result.plan, { teamName: 'T', description: '' })
  assert.equal(expanded.planRef.scenarioId, undefined)
})

test('unknown expert id and empty selection are rejected', () => {
  const unknown = compileReview('A', ['bk-999'])
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.ok(unknown.errors.some(error => error.code === 'unknown-expert'))

  const empty = compileReview('A', [])
  assert.equal(empty.ok, false)
  if (!empty.ok) {
    // Empty array satisfies "present" but violates the reviewer slot cardinality.
    assert.ok(empty.errors.some(error => error.code === 'assignment-count'))
  }
})
