/**
 * P1 能力索引 / 立场配对 / 心智模型注册表 / 版本 provenance 测试。
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  capabilitySignatureOf,
  matchExperts,
  parseTopicCapability,
  mentalModelCatalog,
  findExpertsByMentalModel,
} from '../lib/zhijian/capability.js'
import { stancePairForTopic } from '../lib/zhijian/routing.js'
import { routeRequest } from '../lib/zhijian/tools.js'
import { zhijianMetaById } from '../lib/zhijian/registry.js'

// ── 1. 能力签名与匹配器（P1.1）──────────────────────────────────────────────

test('capabilitySignatureOf is deterministic and namespace-aware', () => {
  const bank = capabilitySignatureOf(zhijianMetaById('bank-09'))
  assert.equal(bank.namespace, 'bank')
  assert.equal(bank.field, '零售金融')
  assert.deepEqual(bank.tags, ['实操', '解读'])
  assert.ok(bank.mentalModels.includes('样板复制法'))
  const bk = capabilitySignatureOf(zhijianMetaById('bk-007'))
  assert.equal(bk.namespace, 'bk')
  assert.ok(bk.tags.includes('数据'))
  assert.ok(bk.tags.includes('研判'))
})

test('parseTopicCapability reuses the shared routing table', () => {
  const parse = parseTopicCapability('零售金融（零售信贷、分行经营）')
  assert.equal(parse?.primaryField, '零售金融')
  assert.equal(parse?.framework, 'B')
  const macro = parseTopicCapability('宏观形势展望（GDP、利率）')
  assert.equal(macro?.primaryField, '宏观经济')
})

test('matchExperts ranks bank-09 first for 零售金融 and caps at limit', () => {
  const matches = matchExperts('零售金融（零售信贷、分行经营、考核推动）', undefined, { limit: 5 })
  assert.ok(matches.length > 0 && matches.length <= 5)
  assert.equal(matches[0].id, 'bank-09')
  assert.ok(matches[0].matchedTags.includes('实操'))
  assert.ok(matches[0].score >= 2)
  assert.ok(matches[0].reason.includes('零售金融'))
})

test('matchExperts surfaces data+judgment experts for 金融风险', () => {
  const matches = matchExperts('金融风险（涉房贷款、不良、断贷）')
  assert.ok(matches.length > 0 && matches.length <= 5)
  const top3 = matches.slice(0, 3).map(m => m.id)
  assert.ok(['bk-007', 'bk-014', 'bk-029', 'bk-004', 'bk-032'].some(id => top3.includes(id)), `top3=${top3.join(',')}`)
  assert.ok(matches.every(m => m.matchedTags.length > 0), '金融风险候选应命中 数据/研判 标签')
})

test('matchExperts excludes zero-score candidates (no fabricated hits)', () => {
  const matches = matchExperts('零售金融（零售信贷）')
  assert.ok(matches.every(m => m.score > 0))
})

// ── 2. 心智模型注册表（P1.4）────────────────────────────────────────────────

test('mentalModelCatalog aggregates across namespaces deterministically', () => {
  const catalog = mentalModelCatalog()
  assert.ok(catalog.length > 0)
  const 样板 = catalog.find(entry => entry.name === '样板复制法')
  assert.ok(样板 !== undefined)
  assert.deepEqual(样板.experts, ['bank-09'])
  // deterministic: two calls give identical results
  assert.deepEqual(catalog, mentalModelCatalog())
})

test('findExpertsByMentalModel reverse-lookup (债务-通缩循环 → bk-007)', () => {
  const experts = findExpertsByMentalModel('债务-通缩')
  assert.ok(experts.some(e => e.id === 'bk-007'), `ids=${experts.map(e => e.id).join(',')}`)
  assert.equal(findExpertsByMentalModel('样板复制法')[0].id, 'bank-09')
  assert.deepEqual(findExpertsByMentalModel('   '), [])
})

// ── 3. 立场对照配对（P1.3）──────────────────────────────────────────────────

test('stancePairForTopic matches the stance table for 市场是否见底', () => {
  const pair = stancePairForTopic('一线城市是否已见底？')
  assert.equal(pair?.topic, '市场是否见底')
  assert.equal(pair?.optimistic[0], 'bk-024')
  assert.equal(pair?.risk[0], 'bk-008')
})

test('stancePairForTopic returns undefined for unmatched topics', () => {
  assert.equal(stancePairForTopic('量子计算前景如何'), undefined)
})

// ── 4. 路由输出增强（P1.2/P1.5）─────────────────────────────────────────────

test('routeRequest candidates carry version/namespace and capability match fields', () => {
  const result = routeRequest('零售金融（零售信贷、分行经营、考核推动）')
  const candidate = result.candidates.find(c => c.id === 'bank-09')
  assert.ok(candidate !== undefined)
  assert.equal(candidate.namespace, 'bank')
  assert.equal(candidate.version, '1.0.0')
  assert.ok(candidate.matchScore !== undefined && candidate.matchScore > 0)
  assert.ok(candidate.matchedTags?.length !== undefined)
  assert.ok(result.capabilityNote !== undefined)
  assert.ok((result.mentalModelsCount ?? 0) > 0)
})

test('routeRequest bk candidates carry bk namespace and version 1.1.0', () => {
  const result = routeRequest('宏观形势展望（GDP、利率、汇率）')
  const candidate = result.candidates.find(c => c.id === 'bk-007')
  assert.ok(candidate !== undefined)
  assert.equal(candidate.namespace, 'bk')
  assert.equal(candidate.version, '1.1.0')
})
