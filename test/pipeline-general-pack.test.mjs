/**
 * P3 续收：pipeline-general 领域包测试（S 特级 40 + XHS 1）。
 * - DomainPackV2 校验零错误、41 位、1 通用场景；
 * - 并入单一注册表（s-32 巴菲特 / xhs-01 可解析）；
 * - 共享路由话题「特级专家研判」→ 非空候选。
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPipelineGeneralDomainPack, validateDomainPack } from '../lib/v2/index.js'
import { GENERAL_EXPERTS } from '../lib/pipeline-general/data/experts.generated.js'
import { ZHIJIAN_EXPERT_BY_ID, zhijianMetaById } from '../lib/zhijian/registry.js'
import { routeRequest } from '../lib/zhijian/tools.js'
import { topicRouteFor } from '../lib/zhijian/routing.js'

test('pipeline-general pack validates clean with 41 experts (S 40 + XHS 1)', () => {
  const pack = buildPipelineGeneralDomainPack()
  const result = validateDomainPack(pack)
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics.filter(d => d.severity === 'error')))
  assert.equal(pack.experts.length, 41)
  assert.equal(pack.scenarios.length, 1)
  assert.equal(pack.scenarios[0].id, 'pipeline-general')
  assert.equal(pack.teamTemplates[0].id, 'pipeline-general.team.B')
  assert.equal(pack.outputTemplates[0].id, 'pipeline-general.output.B')
})

test('general experts merge into the single registry with per-id namespaces', () => {
  assert.equal(GENERAL_EXPERTS.length, 41)
  assert.equal(zhijianMetaById('s-32')?.name, '巴菲特')
  assert.equal(zhijianMetaById('s-32')?.namespace, 's')
  assert.equal(zhijianMetaById('s-40')?.namespace, 's')
  assert.equal(zhijianMetaById('xhs-01')?.namespace, 'xhs')
  assert.equal(ZHIJIAN_EXPERT_BY_ID.has('s-40'), true)
  assert.equal(ZHIJIAN_EXPERT_BY_ID.has('xhs-01'), true)
})

test('shared route table routes 特级专家研判 to general candidates', () => {
  const route = topicRouteFor('特级专家研判（战略、投资、产品、组织、AI 趋势、科学思维）')
  assert.equal(route?.framework, 'B')
  assert.equal(route?.primaryField, '特级专家')
  const result = routeRequest('特级专家研判（战略、投资、产品、组织、AI 趋势、科学思维）')
  assert.ok(result.candidates.length > 0)
  assert.ok(result.candidates.some(c => c.id.startsWith('s-')), '特级专家候选应来自 s- 命名空间')
})

test('pack slices stay clean: general pack carries only its own scenario', async () => {
  const pack = buildPipelineGeneralDomainPack()
  assert.equal(pack.scenarios.some(s => s.id === 'pipeline-realestate-ops'), false)
  assert.equal(pack.experts.some(e => e.id.startsWith('e0')), false)
})
