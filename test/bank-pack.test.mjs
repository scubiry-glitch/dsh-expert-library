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

test('bank-finance pack validates clean with bank-09 + e13-* 江苏银行高层', () => {
  const pack = buildBankDomainPack()
  const result = validateDomainPack(pack)
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics.filter(d => d.severity === 'error')))
  assert.equal(pack.experts.length, 6)
  const ids = pack.experts.map(e => e.id)
  assert.ok(ids.includes('bank-09'))
  assert.ok(ids.includes('e13-01') && ids.includes('e13-02') && ids.includes('e13-03'))
  assert.equal(pack.experts.find(e => e.id === 'bank-09').compliance.internalOnly, true)
  assert.equal(pack.scenarios.length, 3)
  assert.ok(pack.scenarios.some(sc => sc.id === 'bank-strategy'), 'bank-strategy 场景承载 E13')
  assert.ok(pack.qualityPolicies[0].gates.some(g => g.id === 'pii-redaction'))
})

test('bank pack declares local 99wiki as its knowledge base', () => {
  const pack = buildBankDomainPack()
  const wikiProvider = pack.knowledgeProviders.find(p => p.id === 'bank-99wiki')
  assert.ok(wikiProvider !== undefined)
  assert.equal(wikiProvider.kind, 'structured-wiki')
  assert.deepEqual(wikiProvider.scopes, ['99wiki'])
  const wiki = pack.domainKnowledge.find(d => d.id === 'bank.99wiki')
  assert.ok(wiki !== undefined)
  assert.equal(wiki.domain, 'banking.jiangsu')
  assert.ok(wiki.collections.length >= 8, '99wiki collections enumerated')
  assert.ok(wiki.collections.some(c => c.root === 'projects/银行业研究助手'))
  assert.ok(wiki.collections.some(c => c.root === 'feishu'))
  // 每位银行专家绑定 99wiki 作用域
  for (const expert of pack.experts) {
    assert.ok(expert.knowledgeBindings.some(b => b.providerId === 'bank-99wiki'), `${expert.id} binds 99wiki`)
  }
  // 场景知识策略引用 99wiki
  assert.ok(pack.scenarios[0].knowledgePolicy.optional?.includes('bank-99wiki'))
  assert.ok(pack.scenarios[0].knowledgePolicy.optional?.includes('bank-analytics'))
  // 银行分析数据库 provider + 领域知识清单
  const analyticsProvider = pack.knowledgeProviders.find(x => x.id === 'bank-analytics')
  assert.ok(analyticsProvider !== undefined)
  assert.equal(analyticsProvider.kind, 'database')
  assert.deepEqual(analyticsProvider.scopes, ['99wiki/projects/银行分析数据库'])
  const analytics = pack.domainKnowledge.find(x => x.id === 'bank.analytics')
  assert.ok(analytics !== undefined)
  assert.equal(analytics.collections.length, 7)
  assert.ok(analytics.collections.some(c => c.id === 'analytics-provenance'))
  assert.ok(analytics.boundary.includes('meta_sources'))
})

test('bank pack bundles both consulting skills with pack-relative roots', () => {
  const pack = buildBankDomainPack()
  assert.equal(pack.skillPackages.length, 7)
  const ids = pack.skillPackages.map(s => s.id).sort()
  assert.deepEqual(ids, ['bank-activity-eval','bank-retail-finance-analysis','finesse-ui','gsap-core','gsap-scrolltrigger','gsap-timeline','strategy-consulting'])
  const retail = pack.skillPackages.find(s => s.id === 'bank-retail-finance-analysis')
  assert.equal(retail.source.kind, 'builtin')
  assert.equal(retail.source.root, 'skills/bank-retail-finance-analysis')
  assert.equal(retail.permissions.internalOnly, true, '无 license 技能默认 internalOnly')
  assert.deepEqual(retail.contributions, {})
})

test('bank pack reuses the shared framework B template with bank prefix', () => {
  const pack = buildBankDomainPack()
  const template = pack.teamTemplates[0]
  assert.equal(template.id, 'bank.team.B')
  assert.ok(template.gates.every(binding => binding.policy === 'bank.quality'))
  assert.equal(pack.outputTemplates[0].id, 'bank.output.B')
  assert.equal(pack.methodPacks.some(m => m.id === 'bank.method.retail-ops'), true)
})

test('bank pack carries methodology-distilled gates / method packs / output template (v1.1.0)', () => {
  const pack = buildBankDomainPack()
  // 质量硬门：直引逐字回验 + 历史时点标注（信用卡方法论提取团队实测沉淀）
  const gateIds = pack.qualityPolicies[0].gates.map(g => g.id)
  assert.ok(gateIds.includes('pii-redaction'))
  assert.ok(gateIds.includes('quote-verbatim'))
  assert.ok(gateIds.includes('historical-timestamp'))
  // 方法包：阈值测算协议 + 口径还原对标协议
  const methodIds = pack.methodPacks.map(m => m.id)
  assert.ok(methodIds.includes('bank.method.threshold-calc'))
  assert.ok(methodIds.includes('bank.method.caliber-restore'))
  assert.ok(methodIds.includes('bank.method.customer-tiering'))
  assert.ok(methodIds.includes('bank.method.work-chains'))
  assert.ok(methodIds.includes('bank.method.incentive-governance'))
  assert.ok(methodIds.includes('bank.method.partnership-diligence'))
  assert.ok(methodIds.includes('bank.method.tiered-pnl'))
  assert.ok(methodIds.includes('bank.method.attribution'))
  // 口径对照表输出模板
  const caliber = pack.outputTemplates.find(x => x.id === 'bank.output.caliber-table')
  assert.ok(caliber !== undefined)
  assert.deepEqual(caliber.sections.map(x => x.id), ['指标名','会计科目','经济实质','本行口径','外部口径','分母口径','差异说明','可比结论与不可比项'])
  // 场景接线：bank-retail / bank-strategy 亦引用新方法包
  const retail = pack.scenarios.find(x => x.id === 'bank-retail')
  assert.ok(retail.routingPolicy.assertions[0].includes('incentive-governance'))
  const strategy = pack.scenarios.find(x => x.id === 'bank-strategy')
  assert.ok(strategy.routingPolicy.assertions[0].includes('tiered-pnl'))
  // 六条工作链：链目齐备
  const chains = pack.methodPacks.find(m => m.id === 'bank.method.work-chains')
  for (const name of ['年度经营计划模板','活动与定价测试','口径对照表','阈值与定价验算','客群工程全链','线上转化+消保一体化']) {
    assert.ok(chains.body.includes(name), `work-chains 缺链：${name}`)
  }
  // 输出模板：方法论七字段记录
  const methodRecord = pack.outputTemplates.find(t => t.id === 'bank.output.method-record')
  assert.ok(methodRecord !== undefined)
  assert.deepEqual(methodRecord.sections.map(s => s.id), ['编号','方法名','出处','原文关键句','方法拆解','适用条件与边界','可迁移性初判'])
  // 场景接线：bank-credit-card 声明 methodology-extraction intent 并引用新模板/门
  const card = pack.scenarios.find(s => s.id === 'bank-credit-card')
  assert.ok(card.intents.includes('methodology-extraction'))
  assert.ok(card.routingPolicy.assertions[0].includes('method-record'))
})

// ── 2. 单一注册表 / 单一数据层 ───────────────────────────────────────────────

test('bank-09 is merged into the native expert registry (single merge point)', () => {
  assert.equal(BANK_EXPERTS.length, 6)
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
  assert.equal(candidate.initials, 'X')
})

test('scenarioForTopic resolves bank-retail / bank-strategy', () => {
  const scenario = scenarioForTopic('零售金融（零售信贷、分行经营）', 'B')
  assert.equal(scenario?.id, 'bank-retail')
  const card = scenarioForTopic('银行经营（信用卡、息差）', 'B')
  assert.equal(card?.id, 'bank-credit-card')
  const strategy = scenarioForTopic('银行战略与经营（银行战略、量化目标）', 'B')
  assert.equal(strategy?.id, 'bank-strategy')
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
