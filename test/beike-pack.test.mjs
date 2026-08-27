/**
 * beike（贝壳生态）领域包测试：
 * - 交叉投影包校验零错误（13 位：居住服务/平台创始人 + 商业模式/平台经济
 *   外部专家 + 政策治理专家）；
 * - 专家实体按 id 引用共享注册表（不重复注册）；
 * - 每位 beike 专家声明 `beike.review`，每个场景仅以单一 `zhijian.review`
 *   roster gate 组队（不依赖 overlay 顺序）；
 * - 真实 overlay 合并顺序（beike → zhijian-realestate → pipeline-domains）
 *   后，专家仍保留 `beike.review`，且 `beike-ecosystem` 可编译；
 * - 路由「贝壳生态与居住服务」→ 候选含 bk-033/e08-08；
 * - 知识库 = 本地 99wiki 贝壳合作材料。
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildBeikeDomainPack,
  buildPipelineDomainPack,
  buildZhijianDomainPack,
  compileExecutionPlan,
  mergePackLayers,
  validateDomainPack,
  BEIKE_EXPERT_IDS,
} from '../lib/v2/index.js'
import { ZHIJIAN_EXPERT_BY_ID } from '../lib/zhijian/registry.js'
import { routeRequest } from '../lib/zhijian/tools.js'
import { scenarioForTopic, topicRouteFor } from '../lib/zhijian/routing.js'

test('beike pack validates clean with 13 cross-projected experts', () => {
  const pack = buildBeikeDomainPack()
  const result = validateDomainPack(pack)
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics.filter(d => d.severity === 'error')))
  assert.equal(pack.experts.length, 13)
  assert.deepEqual(pack.experts.map(e => e.id).sort(), [...BEIKE_EXPERT_IDS].sort())
  assert.equal(pack.scenarios.length, 2)
  assert.ok(pack.scenarios.some(s => s.id === 'beike-ecosystem'))
  assert.ok(pack.scenarios.some(s => s.id === 'beike-rental-supply-chain'))
  assert.equal(pack.teamTemplates[0].id, 'beike.team.B')
})

test('beike experts claim beike.review and scenarios use one shared roster gate', () => {
  const pack = buildBeikeDomainPack()
  for (const expert of pack.experts) {
    assert.ok(
      expert.capabilities.some(claim => claim.capability === 'beike.review'),
      `${expert.id} claims beike.review`,
    )
  }
  for (const scenario of pack.scenarios) {
    assert.deepEqual(scenario.requiredCapabilities, [
      { capability: 'zhijian.review', minProficiency: 1, cardinality: 1 },
    ])
  }
})

test('real overlay order preserves beike capabilities and compiles beike-ecosystem', () => {
  const beike = buildBeikeDomainPack()
  const zhijian = buildZhijianDomainPack()
  const pipeline = buildPipelineDomainPack()
  const merged = mergePackLayers([
    { pack: zhijian, layer: 'builtin', label: 'builtin-zhijian' },
    { pack: beike, layer: 'workspace', label: 'beike' },
    { pack: zhijian, layer: 'workspace', label: 'zhijian-realestate' },
    { pack: pipeline, layer: 'workspace', label: 'pipeline-domains' },
  ], { reportReplaces: false })
  assert.equal(merged.ok, true, JSON.stringify(merged.diagnostics))
  const selectedExpertIds = ['bk-033', 'e08-08', 'bk-018', 'bk-002', 'bk-019']
  for (const id of selectedExpertIds) {
    const expert = merged.pack.experts.find(item => item.id === id)
    assert.ok(expert !== undefined, `${id} survives overlay merge`)
    assert.ok(expert.capabilities.some(claim => claim.capability === 'beike.review'), `${id} retains beike.review`)
    assert.ok(expert.capabilities.some(claim => claim.capability === 'zhijian.review'), `${id} claims zhijian.review`)
  }
  const scenario = merged.pack.scenarios.find(item => item.id === 'beike-ecosystem')
  assert.ok(scenario !== undefined)
  const compiled = compileExecutionPlan({
    pack: merged.pack,
    templateId: scenario.teamTemplate,
    scenarioId: scenario.id,
    params: { selectedExpertIds, data: '贝壳生态测试数据' },
  })
  assert.equal(compiled.ok, true, compiled.ok ? undefined : JSON.stringify(compiled.errors))
})

test('beike experts are shared registry entries (no duplicate registration)', () => {
  for (const id of BEIKE_EXPERT_IDS) {
    assert.equal(ZHIJIAN_EXPERT_BY_ID.has(id), true, `${id} in shared registry`)
  }
  const left = ZHIJIAN_EXPERT_BY_ID.get('e08-08')
  assert.equal(left?.name, '左晖')
  const zhang = ZHIJIAN_EXPERT_BY_ID.get('s-07')
  assert.equal(zhang?.name, '张勇')
  const huang = ZHIJIAN_EXPERT_BY_ID.get('bk-016')
  assert.equal(huang?.name, '黄奇帆')
})

test('routeRequest routes 贝壳生态与居住服务 to beike candidates', () => {
  const route = topicRouteFor('贝壳生态与居住服务（平台、经纪、房源、渠道、长租）')
  assert.equal(route?.framework, 'B')
  const result = routeRequest('贝壳生态与居住服务（平台、经纪、房源、渠道、长租）')
  const ids = result.candidates.map(c => c.id)
  assert.ok(ids.includes('bk-033'), '杨现领 must be a candidate')
  assert.ok(ids.includes('e08-08'), '左晖 must be a candidate')
  const scenario = scenarioForTopic('贝壳生态与居住服务（平台、经纪）', 'B')
  assert.equal(scenario?.id, 'beike-ecosystem')
})

test('beike pack declares 99wiki knowledge base and internal-only 陶琦', () => {
  const pack = buildBeikeDomainPack()
  const wiki = pack.domainKnowledge.find(d => d.id === 'beike.99wiki')
  assert.ok(wiki !== undefined)
  assert.ok(wiki.collections.some(c => c.root === 'projects/贝壳x江苏银行'))
  const taoqi = pack.experts.find(e => e.id === 'bk-031')
  assert.equal(taoqi.compliance.internalOnly, true, '陶琦 贝壳口径 internalOnly')
})

test('pack slices stay clean: beike carries only its own scenarios', async () => {
  const pack = buildBeikeDomainPack()
  assert.equal(pack.scenarios.some(s => s.id === 'zhijian-monthly'), false)
  assert.equal(pack.scenarios.some(s => s.id === 'pipeline-general'), false)
  const zhijian = buildZhijianDomainPack()
  assert.equal(zhijian.scenarios.some(s => s.id === 'beike-ecosystem'), false)
})
