/**
 * P3.1 pipeline-domains 领域包测试：
 * - DomainPackV2 校验零错误（22 位 e01/e08/e13 专家，复用 zhijian/bank 构建器）；
 * - 并入单一注册表（e08-08 左晖 可解析）与共享路由表（房地产企业经营 → e08-*）；
 * - pii-redaction 硬门随 pipeline.quality 生效。
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPipelineDomainPack, validateDomainPack } from '../lib/v2/index.js'
import { PIPELINE_EXPERTS } from '../lib/pipeline/data/experts.generated.js'
import { ZHIJIAN_EXPERT_BY_ID, zhijianMetaById, isZhijianExpertId } from '../lib/zhijian/registry.js'
import { routeRequest } from '../lib/zhijian/tools.js'
import { topicRouteFor } from '../lib/zhijian/routing.js'

// ── 1. 包校验 ───────────────────────────────────────────────────────────────

test('pipeline-domains pack validates clean with 106 experts (E01-E12; E13 已并入 bank)', () => {
  const pack = buildPipelineDomainPack()
  const result = validateDomainPack(pack)
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics.filter(d => d.severity === 'error')))
  assert.equal(pack.experts.length, 106)
  assert.equal(pack.scenarios.length, 2)
  assert.equal(pack.scenarios.some(sc => sc.id === 'bank-strategy'), false, 'bank-strategy 归 bank-finance 包')
  assert.ok(pack.qualityPolicies[0].gates.some(g => g.id === 'pii-redaction'))
  assert.equal(pack.teamTemplates[0].id, 'pipeline.team.B')
})

test('pipeline pack reuses shared template builders with pipeline prefix', () => {
  const pack = buildPipelineDomainPack()
  assert.equal(pack.outputTemplates[0].id, 'pipeline.output.B')
  assert.ok(pack.teamTemplates[0].gates.every(b => b.policy === 'pipeline.quality'))
  assert.equal(pack.methodPacks.some(m => m.id === 'pipeline.method.review-protocol'), true)
})

// ── 2. 单一注册表 / 命名空间 ────────────────────────────────────────────────

test('pipeline experts are merged into the native registry with per-id namespaces', () => {
  assert.equal(PIPELINE_EXPERTS.length, 106)
  assert.equal(zhijianMetaById('e08-08')?.namespace, 'e08')
  assert.equal(zhijianMetaById('e01-08')?.namespace, 'e01')
  assert.equal(zhijianMetaById('e13-02')?.namespace, 'e13', 'e13 保留命名空间（数据在 bank-finance 包）')
  assert.equal(zhijianMetaById('e07-07')?.namespace, 'e07', 'E 其余域并入 pipeline-domains')
  assert.equal(zhijianMetaById('s-32')?.namespace, 's', 'S 特级并入 pipeline-general 命名空间')
  assert.equal(zhijianMetaById('xhs-01')?.namespace, 'xhs')
  assert.equal(ZHIJIAN_EXPERT_BY_ID.has('e08-08'), true)
  assert.equal(isZhijianExpertId('e08-08'), true)
  const left = ZHIJIAN_EXPERT_BY_ID.get('e08-08')
  assert.ok(left?.name === '左晖')
  assert.ok((left?.suitedFor ?? []).length > 0, '房地产 field maps to review scenarios')
})

test('BK registry unaffected by pipeline merge (slice intact)', () => {
  assert.equal(zhijianMetaById('bk-007')?.stance, '债务金融派')
  assert.equal(zhijianMetaById('bank-09')?.namespace, 'bank')
})

// ── 3. 共享路由表 ───────────────────────────────────────────────────────────

test('routeRequest routes 房地产企业经营 to e08 candidates', () => {
  const route = topicRouteFor('房地产企业经营（房企经营、平台经济、服务品质）')
  assert.equal(route?.framework, 'B')
  const result = routeRequest('房地产企业经营（房企经营、平台经济、服务品质）')
  assert.ok(result.candidates.some(c => c.id === 'e08-08'), '左晖 must be a candidate')
  const left = result.candidates.find(c => c.id === 'e08-08')
  assert.equal(left?.namespace, 'e08')
  assert.equal(left?.version, '1.0.0')
})

test('routeRequest routes 银行战略与经营 to e13 candidates (shared table, pack=bank)', () => {
  const result = routeRequest('银行战略与经营（银行战略、量化目标、数智化转型）')
  assert.ok(result.candidates.some(c => c.id === 'e13-02'))
})

test('pack slices stay clean: zhijian excludes pipeline; pipeline excludes bank-strategy; bank carries it', async () => {
  const { buildZhijianDomainPack } = await import('../lib/v2/zhijian-pack.js')
  const { buildBankDomainPack } = await import('../lib/v2/bank-pack.js')
  const zhijian = buildZhijianDomainPack()
  assert.equal(zhijian.scenarios.some(s => s.id === 'pipeline-realestate-ops'), false)
  const pipeline = buildPipelineDomainPack()
  assert.equal(pipeline.scenarios.some(s => s.id === 'zhijian-monthly'), false)
  assert.equal(pipeline.scenarios.some(s => s.id === 'bank-strategy'), false)
  const bank = buildBankDomainPack()
  assert.ok(bank.scenarios.some(s => s.id === 'bank-strategy'), 'E13 场景归 bank-finance 包')
  assert.ok(bank.experts.some(e => e.id === 'e13-02'))
})
