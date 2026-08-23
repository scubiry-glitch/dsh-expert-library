/**
 * P3.1 pipeline 专家同步/构建测试（离线：不访问线上 API）。
 * - 归一化 adapter：线上详情 → 标准 Profile（确定性推导 field/stance/tags/initials）
 * - roster 生成：分组编号、parser 兼容
 * - 数据链路：pipeline-domains source 解析 → e01/e08/e13 命名空间 → 包校验
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizePipelineProfile, derivePipelineMeta, emitPipelineRoster } from '../scripts/sync-pipeline-experts.mjs'
import { parseZhijianSource } from '../scripts/zhijian-source.mjs'

/** 线上详情样张（E08-08 左晖 / E13-02 高增银，字段与线上一致，无 classification/initials）。 */
const SAMPLE_LEFT = {
  expert_id: 'E08-08',
  name: '左晖',
  domain: ['房地产', '平台经济', '服务品质', '长期主义'],
  persona: { style: ['平台与产业互联网视角'], tone: '克制' },
  method: { frameworks: ['平台生态论'], analysis_steps: ['看服务品质'] },
  emm: { critical_factors: ['服务品质'], factor_hierarchy: { 服务品质: 1 } },
  constraints: { must_conclude: true },
  output_schema: { format: 'markdown', sections: ['结论'] },
  anti_patterns: ['讲空话'],
  signature_phrases: ['做难而正确的事'],
}

test('normalizePipelineProfile derives standard Profile deterministically', () => {
  const { profile, derived } = normalizePipelineProfile(SAMPLE_LEFT)
  assert.equal(profile.expert_id, 'E08-08')
  assert.equal(profile.name, '左晖')
  assert.equal(profile.initials, '左')
  assert.equal(profile.classification.category, '房地产')
  assert.equal(derived.field, '房地产')
  assert.equal(derived.stance, '平台经济')
  assert.equal(derived.secondaryField, '服务品质')
  assert.deepEqual(profile.anti_patterns, ['讲空话'])
  // persona/method/emm 逐字节保留
  assert.deepEqual(profile.persona, SAMPLE_LEFT.persona)
  assert.deepEqual(profile.emm, SAMPLE_LEFT.emm)
  // 确定性
  const again = normalizePipelineProfile(SAMPLE_LEFT)
  assert.deepEqual(profile, again.profile)
})

test('derivePipelineMeta maps domain keywords to capability tags', () => {
  const macro = derivePipelineMeta('高善文', ['宏观经济', '资本市场', '经济周期', '资产配置'])
  assert.deepEqual(macro.tags, ['研判', '理论'])
  assert.equal(macro.field, '宏观经济')
  const bank = derivePipelineMeta('高增银', ['江苏银行高层', '银行经营管理', '量化目标评审'])
  assert.ok(bank.tags.includes('数据'))
  assert.ok(bank.tags.includes('实操'))
  const bare = derivePipelineMeta('王建国', ['房地产'])
  assert.deepEqual(bare.tags, ['研判'], '无关键词命中时回退默认标签')
})

test('emitPipelineRoster groups by field with parser-compatible rows', async () => {
  const a = normalizePipelineProfile(SAMPLE_LEFT)
  const b = normalizePipelineProfile({ expert_id: 'E13-02', name: '高增银', domain: ['江苏银行高层', '银行经营管理'] })
  const roster = emitPipelineRoster([b, a].map(({ profile, derived }) => ({ profile, derived })))
  assert.ok(roster.includes('### 1. 房地产（1 位）'))
  assert.ok(roster.includes('### 2. 江苏银行高层（1 位）'))
  assert.ok(roster.includes('| E08-08 | 左晖 | 左晖 | 平台经济 | 服务品质 |'))
  // parser 可回读：roster 行格式与 parseRoster 兼容
  const { parseRoster } = await import('../scripts/zhijian-source.mjs')
  const parsed = parseRoster(roster)
  assert.equal(parsed.size, 2)
  assert.equal(parsed.get('E08-08').name, '左晖')
})

test('pipeline-domains source parses into e01/e08 namespaced metas (E13 moved to bank)', async () => {
  const parsed = await parseZhijianSource('domain-packs/pipeline-domains/source')
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors))
  assert.equal(parsed.experts.length, 19)
  const ids = parsed.experts.map(e => e.id)
  assert.ok(ids.includes('e08-08'))
  assert.ok(ids.includes('e01-08'))
  assert.ok(!ids.includes('e13-02'), 'E13 已迁移到 bank-finance source')
  const left = parsed.experts.find(e => e.id === 'e08-08')
  assert.equal(left.field, '房地产')
  assert.equal(left.stance, '平台经济')
  // bank source 现含 E13 三位
  const bank = await parseZhijianSource('domain-packs/bank-finance/source')
  assert.equal(bank.ok, true, JSON.stringify(bank.errors))
  const bankIds = bank.experts.map(e => e.id)
  assert.ok(bankIds.includes('e13-01') && bankIds.includes('e13-02') && bankIds.includes('e13-03'))
  assert.equal(bank.experts.length, 4)
})
