/**
 * Zhijian expert registry: converts the generated expert metas into native
 * Expert definitions (registered into the expert library), and maps fields
 * to the review scenarios they are suited for.
 * @module dsh-expert-library/zhijian/registry
 */

import type { Expert, ExpertModelRoute } from '../expert-library/types.ts'
import { ZHIJIAN_EXPERTS } from './data/experts.generated.ts'
import { BANK_EXPERTS } from '../bank/data/experts.generated.ts'
import { PIPELINE_EXPERTS } from '../pipeline/data/experts.generated.ts'
import { GENERAL_EXPERTS } from '../pipeline-general/data/experts.generated.ts'
import type { ZhijianExpertMeta } from './types.ts'

/** The preset model route applied to every Zhijian expert (environment default). */
export const ZHIJIAN_ROUTE: ExpertModelRoute = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'max',
}

/**
 * All native expert metas, every namespace, in deterministic order
 * (BK 智见点评 + BANK 银行金融 + pipeline E 域 + pipeline-general S/XHS)——
 * one merged data set feeding the registry, routing tables, persona baker and
 * pack projection (整合设计).
 */
export const ALL_EXPERT_METAS: readonly ZhijianExpertMeta[] = [
  ...ZHIJIAN_EXPERTS,
  ...BANK_EXPERTS,
  ...PIPELINE_EXPERTS,
  ...GENERAL_EXPERTS,
]

/** Field → suited review scenarios. */
const FIELD_SCENARIOS: Readonly<Record<string, readonly string[]>> = {
  '宏观经济': ['zhijian-macro', 'zhijian-finance'],
  '政策制度': ['zhijian-policy', 'zhijian-institution'],
  '行业研究': ['zhijian-monthly', 'zhijian-industry'],
  '城市发展': ['zhijian-city'],
  '居住服务': ['zhijian-services'],
  '零售金融': ['bank-retail', 'bank-credit-card'],
  '银行经营': ['bank-retail', 'bank-credit-card'],
  // pipeline 命名空间领域（E08 房地产经营 / E01 宏观 / E13 江苏银行 / 资产配置）
  '房地产': ['zhijian-monthly', 'zhijian-industry'],
  '资产配置': ['zhijian-finance'],
  '江苏银行高层': ['bank-retail', 'bank-credit-card'],
}

/** Fold one meta into a native Expert definition. */
export function zhijianExpertToExpert(meta: ZhijianExpertMeta): Expert {
  const principles: string[] = []
  for (const style of meta.style.slice(0, 2)) {
    const trimmed = style.trim()
    if (trimmed !== '') principles.push(trimmed.slice(0, 180))
  }
  for (const anti of meta.antiPatterns.slice(0, 2)) {
    const trimmed = anti.trim()
    if (trimmed !== '') principles.push(`禁区：${trimmed.slice(0, 100)}`)
  }
  if (principles.length === 0) principles.push('按本人立场与风格研判，结论先行，数字带口径。')

  const background = `${meta.personaName}（${meta.stance}）。${meta.summary}`
  return {
    id: meta.id,
    name: meta.name,
    role: `${meta.field}·${meta.stance}`,
    background,
    principles,
    deliverables: [
      `按选定框架输出研判稿（匿名标注「${meta.field}·${meta.initials}」）`,
      '结构化的关键事实与数字（带口径）',
      '不确定性与风险提示',
    ],
    model: ZHIJIAN_ROUTE,
    suitedFor: FIELD_SCENARIOS[meta.field] ?? [],
  }
}

/** Native registry map: expert id → Expert (merged into the library registry). */
export const ZHIJIAN_EXPERT_BY_ID: ReadonlyMap<string, Expert> = new Map(
  ALL_EXPERT_METAS.map(meta => [meta.id, zhijianExpertToExpert(meta)]),
)

/** Meta lookup by expert id (both namespaces). */
export function zhijianMetaById(id: string): ZhijianExpertMeta | undefined {
  return ALL_EXPERT_METAS.find(meta => meta.id === id)
}

/** Whether an Expert definition is a native (bk-* / bank-* / s-* / e*-* / xhs-*) expert. */
export function isZhijianExpertId(id: string): boolean {
  return ZHIJIAN_EXPERT_BY_ID.has(id)
}

/** All native expert ids, for roster display. */
export const ZHIJIAN_EXPERT_IDS: readonly string[] = ALL_EXPERT_METAS.map(meta => meta.id)

/** BK-namespace expert ids only（zhijian 包切片用）. */
export const ZHIJIAN_BK_EXPERT_IDS: readonly string[] = ZHIJIAN_EXPERTS.map(meta => meta.id)
