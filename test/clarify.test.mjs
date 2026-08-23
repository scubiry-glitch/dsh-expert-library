/**
 * 归型澄清层测试（clarify.ts）：
 * - 澄清集解析（通用 + 按领域包/场景叠加，去重）；
 * - 必备项判定（required 未答）；
 * - 答案 → 路由上下文映射（data 拼装 / 参数归一 / 脱敏标记）。
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clarificationSetFor,
  pendingRequiredQuestions,
  answersToRouteContext,
  CLARIFICATION_QUESTIONS,
} from '../lib/zhijian/clarify.js'

test('clarification set for beike combines common + beike domain questions', () => {
  const questions = clarificationSetFor({ packScope: 'beike' })
  const ids = questions.map(q => q.id)
  assert.ok(ids.includes('purpose'), '通用用途问题')
  assert.ok(ids.includes('data_source'), '通用数据口径问题')
  assert.ok(ids.includes('beike_angle'), '贝壳视角问题')
  assert.ok(ids.includes('beike_caliber'), '贝壳口径问题')
  assert.ok(!ids.includes('bank_scope'), '不混入他包问题')
  // 无重复 id
  assert.equal(new Set(ids).size, ids.length)
})

test('scenario-level resolution picks the owning pack scope', () => {
  const ecosystem = clarificationSetFor({ scenarioId: 'beike-ecosystem' })
  assert.ok(ecosystem.some(q => q.id === 'beike_angle'))
  const bankRetail = clarificationSetFor({ scenarioId: 'bank-retail' })
  assert.ok(bankRetail.some(q => q.id === 'bank_sensitive'))
  const monthly = clarificationSetFor({ scenarioId: 'zhijian-monthly' })
  assert.ok(monthly.some(q => q.id === 'zj_dimension'))
  assert.ok(!monthly.some(q => q.id === 'beike_angle'))
})

test('pendingRequiredQuestions lists unanswered required items only', () => {
  const questions = clarificationSetFor({ packScope: 'beike' })
  const pending = pendingRequiredQuestions(questions, {})
  const pendingIds = pending.map(q => q.id)
  assert.ok(pendingIds.includes('purpose'))
  assert.ok(pendingIds.includes('beike_caliber'))
  assert.ok(!pendingIds.includes('city'), 'city 非必答')
  const answered = pendingRequiredQuestions(questions, { purpose: '对外招商', data_source: '贝壳', beike_angle: '经纪渠道', beike_caliber: '贝壳成出口径' })
  assert.deepEqual(answered, [])
})

test('answersToRouteContext maps answers into apply-ready params', () => {
  const ctx = answersToRouteContext({
    data_source: '贝壳',
    city: '北京',
    period: '2026H1',
    output_form: '讨论稿（带匿名标注）',
    beike_caliber: '贝壳成出口径',
    beike_angle: '经纪渠道',
  })
  assert.equal(ctx.dataSource, '贝壳')
  assert.equal(ctx.city, '北京')
  assert.equal(ctx.period, '2026H1')
  assert.equal(ctx.outputForm, 'discussion')
  assert.ok(ctx.data.includes('城市/区域：北京'))
  assert.ok(ctx.data.includes('贝壳口径：贝壳成出口径'))
  assert.ok(ctx.data.includes('beike_angle：经纪渠道'))
  // 正式稿归一
  assert.equal(answersToRouteContext({ output_form: '正式稿（去标注）' }).outputForm, 'final')
  // 银行脱敏标记
  const bank = answersToRouteContext({ bank_sensitive: '含样例但须脱敏' })
  assert.ok(bank.data.includes('敏感数据要求：脱敏'))
})

test('registry is deterministic and covers every pack scope', () => {
  assert.ok(CLARIFICATION_QUESTIONS.length >= 15)
  for (const scope of ['zhijian', 'bank', 'pipeline', 'pipeline-general', 'beike']) {
    const questions = clarificationSetFor({ packScope: scope })
    assert.ok(questions.length >= 6, `${scope} 至少含通用集`)
  }
  // 确定性
  assert.deepEqual(clarificationSetFor({ packScope: 'beike' }), clarificationSetFor({ packScope: 'beike' }))
})
