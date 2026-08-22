/**
 * BANK 命名空间领域包测试（整合设计验收）：
 * - bank-finance DomainPackV2 校验零错误（复用 zhijian 的模板/质量/方法构建器）；
 * - BANK-09 并入同一注册表（resolveLibrary 合并点）与同一路由表；
 * - expert_review_route 能路由零售金融/银行经营话题到 bank-09；
 * - pii-redaction 硬门按银行 PII 模式拦截、聚合数字不误报。
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildBankDomainPack,
  validateDomainPack,
  createBuiltinGateEvaluators,
  runQualityChain,
} from '../lib/v2/index.js'
import { BANK_EXPERTS } from '../lib/bank/data/experts.generated.js'
import { ZHIJIAN_EXPERT_BY_ID, isZhijianExpertId, zhijianMetaById } from '../lib/zhijian/registry.js'
import { routeRequest } from '../lib/zhijian/tools.js'
import { topicRouteFor, scenarioForTopic } from '../lib/zhijian/routing.js'

const now = () => () => '2026-08-23T00:00:00.000Z'

function gate(gateId, { severity = 'hard', config } = {}) {
  return {
    id: `policy/${gateId}`,
    kind: 'deterministic',
    phase: 'compliance',
    chainOrder: 0,
    policyId: 'bank.quality',
    policyVersion: '1.0.0',
    gateId,
    severity,
    appliesTo: ['d1'],
    ...(config === undefined ? {} : { config }),
  }
}

function runPii(evaluators, content) {
  return runQualityChain({
    gates: [gate('pii-redaction', { config: { sensitiveMarkers: ['账号', '卡号', '身份证', '手机号', '余额', '客户姓名'] } })],
    evaluators,
    artifacts: { d1: { content } },
    now: now(),
  })
}

// ── 1. bank-finance 包校验 ──────────────────────────────────────────────────

test('bank-finance pack validates clean with bank-09', () => {
  const pack = buildBankDomainPack()
  const result = validateDomainPack(pack)
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics.filter(d => d.severity === 'error')))
  assert.equal(pack.experts.length, 1)
  assert.equal(pack.experts[0].id, 'bank-09')
  assert.equal(pack.experts[0].compliance.internalOnly, true)
  assert.equal(pack.scenarios.length, 2)
  assert.ok(pack.qualityPolicies[0].gates.some(g => g.id === 'pii-redaction'))
})

test('bank pack reuses the shared framework B template with bank prefix', () => {
  const pack = buildBankDomainPack()
  const template = pack.teamTemplates[0]
  assert.equal(template.id, 'bank.team.B')
  assert.ok(template.gates.every(binding => binding.policy === 'bank.quality'))
  assert.equal(pack.outputTemplates[0].id, 'bank.output.B')
  assert.equal(pack.methodPacks.some(m => m.id === 'bank.method.retail-ops'), true)
})

// ── 2. 单一注册表 / 单一数据层 ───────────────────────────────────────────────

test('bank-09 is merged into the native expert registry (single merge point)', () => {
  assert.equal(BANK_EXPERTS.length, 1)
  assert.equal(BANK_EXPERTS[0].bk, 'BANK-09')
  assert.equal(ZHIJIAN_EXPERT_BY_ID.has('bank-09'), true)
  assert.equal(isZhijianExpertId('bank-09'), true)
  const meta = zhijianMetaById('bank-09')
  assert.equal(meta?.field, '零售金融')
  assert.equal(meta?.stance, '操盘手')
  assert.equal(meta?.version, '1.0.0')
  assert.equal(meta?.namespace, 'bank')
  const expert = ZHIJIAN_EXPERT_BY_ID.get('bank-09')
  assert.equal(expert?.role.includes('零售金融'), true)
})

test('BK registry unaffected: bk-004 and bk-034 still resolve', () => {
  assert.equal(zhijianMetaById('bk-004')?.stance, '宏观周期派')
  assert.equal(ZHIJIAN_EXPERT_BY_ID.has('bk-034'), true)
})

// ── 3. 共享路由表：零售金融/银行经营 → bank-09 ───────────────────────────────

test('routeRequest routes 零售金融 to framework B with bank-09 candidate', () => {
  const route = topicRouteFor('零售金融（零售信贷、分行经营、考核推动）')
  assert.equal(route?.framework, 'B')
  assert.equal(route?.primaryField, '零售金融')
  const result = routeRequest('零售金融（零售信贷、分行经营、考核推动）')
  assert.equal(result.framework, 'B')
  const candidate = result.candidates.find(c => c.id === 'bank-09')
  assert.ok(candidate !== undefined, 'bank-09 must be a candidate for 零售金融')
  assert.equal(candidate.bk, 'BANK-09')
  assert.equal(candidate.initials, 'W')
})

test('scenarioForTopic resolves bank-retail for 零售金融 topics', () => {
  const scenario = scenarioForTopic('零售金融（零售信贷、分行经营）', 'B')
  assert.equal(scenario?.id, 'bank-retail')
  const card = scenarioForTopic('银行经营（信用卡、息差）', 'B')
  assert.equal(card?.id, 'bank-credit-card')
})

test('zhijian-realestate scenarios do not leak bank scenarios (pack slice)', async () => {
  const pack = buildBankDomainPack()
  const { buildZhijianDomainPack } = await import('../lib/v2/zhijian-pack.js')
  const zhijianPack = buildZhijianDomainPack()
  assert.equal(zhijianPack.scenarios.some(s => s.id === 'bank-retail'), false)
  assert.equal(zhijianPack.scenarios.length, 8)
  assert.equal(pack.scenarios.some(s => s.id === 'zhijian-monthly'), false)
})

// ── 4. pii-redaction 硬门 ────────────────────────────────────────────────────

test('pii-redaction blocks mobile / ID / bank-card / account values', () => {
  const evaluators = createBuiltinGateEvaluators()
  const bad = runPii(evaluators, '客户手机号 13800138000 与卡号 6222020202020202 已核对（来源：行内）。')
  assert.equal(bad.outcome, 'failed')
  const codes = bad.rounds[0].results[0].issues.map(i => i.code)
  assert.ok(codes.includes('pii-mobile'), `codes=${codes.join(',')}`)
  assert.ok(codes.includes('pii-bank-card'), `codes=${codes.join(',')}`)

  const id = runPii(evaluators, '身份证 110101199003071234 已归档。')
  assert.equal(id.outcome, 'failed')
  assert.ok(id.rounds[0].results[0].issues.some(i => i.code === 'pii-id-card'))

  const marker = runPii(evaluators, '该分行客户余额：856432 元。')
  assert.equal(marker.outcome, 'failed')
  assert.ok(marker.rounds[0].results[0].issues.some(i => i.code === 'pii-marker-value'))
})

test('pii-redaction does not flag aggregates / dates / masked citations', () => {
  const evaluators = createBuiltinGateEvaluators()
  const ok = runPii(evaluators, '分行余额 8.56 亿元（口径：行内，2026-07），户均 3.2 万元，同比 +5%。')
  assert.equal(ok.outcome, 'pass', JSON.stringify(ok.rounds[0].results[0].issues))
  const okMasked = runPii(evaluators, '联系方式已脱敏（138****0000）。')
  assert.equal(okMasked.outcome, 'pass')
})
