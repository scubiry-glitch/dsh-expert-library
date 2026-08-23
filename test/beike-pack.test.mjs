/**
 * beike（贝壳生态）领域包测试：
 * - 交叉投影包校验零错误（7 位：BK 居住服务派 5 + 左晖 e08-08 + 一濛 e04-05）；
 * - 专家实体按 id 引用共享注册表（不重复注册）；
 * - 路由「贝壳生态与居住服务」→ 候选含 bk-033/e08-08；
 * - 知识库 = 本地 99wiki 贝壳合作材料。
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildBeikeDomainPack, validateDomainPack, BEIKE_EXPERT_IDS } from '../lib/v2/index.js'
import { ZHIJIAN_EXPERT_BY_ID } from '../lib/zhijian/registry.js'
import { routeRequest } from '../lib/zhijian/tools.js'
import { scenarioForTopic, topicRouteFor } from '../lib/zhijian/routing.js'

test('beike pack validates clean with 7 cross-projected experts', () => {
  const pack = buildBeikeDomainPack()
  const result = validateDomainPack(pack)
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics.filter(d => d.severity === 'error')))
  assert.equal(pack.experts.length, 7)
  assert.deepEqual(pack.experts.map(e => e.id).sort(), [...BEIKE_EXPERT_IDS].sort())
  assert.equal(pack.scenarios.length, 2)
  assert.ok(pack.scenarios.some(s => s.id === 'beike-ecosystem'))
  assert.ok(pack.scenarios.some(s => s.id === 'beike-rental-supply-chain'))
  assert.equal(pack.teamTemplates[0].id, 'beike.team.B')
})

test('beike experts are shared registry entries (no duplicate registration)', () => {
  for (const id of BEIKE_EXPERT_IDS) {
    assert.equal(ZHIJIAN_EXPERT_BY_ID.has(id), true, `${id} in shared registry`)
  }
  const left = ZHIJIAN_EXPERT_BY_ID.get('e08-08')
  assert.equal(left?.name, '左晖')
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
  const { buildZhijianDomainPack } = await import('../lib/v2/zhijian-pack.js')
  const zhijian = buildZhijianDomainPack()
  assert.equal(zhijian.scenarios.some(s => s.id === 'beike-ecosystem'), false)
})
