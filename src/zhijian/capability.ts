/**
 * 三维能力索引与匹配器（P1.1/P1.4，整合设计）——
 * 在既有「话题 → 框架 → 领域 → 候选专家」路由之上叠加能力匹配：
 * 每位专家的能力签名 = { 领域, 标签(数据/研判/解读/理论/实操), 立场, 心智模型, 命名空间, 版本 }；
 * 话题解析复用 ROUTE_TOPICS（共享路由表），按标签命中数排序并给出匹配理由，
 * 供 expert_review_route 输出增强（候选 ≤5、理由含命中标签）。
 *
 * 心智模型注册表（P1.4）：mentalModelCatalog() 聚合全量专家 meta，
 * findExpertsByMentalModel(name) 支持「债务-通缩循环 → bk-007」式反查。
 * 纯函数模块：无 I/O、无模型调用、确定性输出。
 * @module dsh-expert-library/zhijian/capability
 */

import { ALL_EXPERT_METAS } from './registry.ts'
import { topicRouteFor } from './routing.ts'
import type { ZhijianExpertMeta } from './types.ts'

/** 能力标签词汇（与专家总表 tags 一致）。 */
export const CAPABILITY_TAGS: readonly string[] = ['数据', '研判', '解读', '理论', '实操']

/** 一位专家的能力签名（由 meta 确定性派生，无捏造）。 */
export interface ExpertCapabilitySignature {
  readonly id: string
  readonly namespace: string
  readonly field: string
  readonly secondaryField?: string
  readonly tags: readonly string[]
  readonly stance: string
  readonly mentalModels: readonly string[]
  readonly version?: string
}

/** 话题解析结果（复用共享路由表）。 */
export interface TopicCapabilityParse {
  readonly matchedTopic: string
  readonly preferredTags: readonly string[]
  readonly primaryField: string
  readonly framework: string
}

/** 一位匹配候选及其理由。 */
export interface CapabilityMatch {
  readonly id: string
  readonly bk: string
  readonly namespace: string
  readonly field: string
  readonly stance: string
  readonly tags: readonly string[]
  readonly version?: string
  /** 命中的能力标签（按 ROUTE_TOPICS.preferredTags ∩ 专家 tags）。 */
  readonly matchedTags: readonly string[]
  /** 0-3 匹配分：领域命中 +1、标签命中 +1/个（上限 +2）、非 deceased。 */
  readonly score: number
  /** 人类可读的匹配理由。 */
  readonly reason: string
}

/** meta → 能力签名（确定性）。 */
export function capabilitySignatureOf(meta: ZhijianExpertMeta): ExpertCapabilitySignature {
  return {
    id: meta.id,
    namespace: meta.namespace ?? (meta.id.startsWith('bank-') ? 'bank' : 'bk'),
    field: meta.field,
    ...(meta.secondaryField !== undefined ? { secondaryField: meta.secondaryField } : {}),
    tags: [...meta.tags],
    stance: meta.stance,
    mentalModels: [...meta.mentalModels],
    ...(meta.version !== undefined ? { version: meta.version } : {}),
  }
}

/** 话题 → 能力解析（复用共享 ROUTE_TOPICS；匹配失败返回 undefined）。 */
export function parseTopicCapability(topic: string, question?: string): TopicCapabilityParse | undefined {
  const route = topicRouteFor(topic, question)
  if (route === undefined) return undefined
  return {
    matchedTopic: route.topic,
    preferredTags: [...route.preferredTags],
    primaryField: route.primaryField,
    framework: route.framework,
  }
}

/** 匹配分：领域命中 +1、每个命中标签 +1（上限 +2）、已故专家 -1。 */
function scoreOf(meta: ZhijianExpertMeta, parse: TopicCapabilityParse): { score: number; matchedTags: string[] } {
  let score = 0
  const matchedTags: string[] = []
  const fieldHit = meta.field === parse.primaryField
    || (meta.secondaryField !== undefined && meta.secondaryField === parse.primaryField)
    || (parse.primaryField === '按问题落点最近领域' && meta.field !== '')
  if (fieldHit) score += 1
  for (const tag of parse.preferredTags) {
    if (meta.tags.includes(tag)) {
      matchedTags.push(tag)
      score += 1
    }
  }
  score = Math.min(score, 3)
  if (meta.deceased === true) score -= 1
  return { score, matchedTags }
}

/**
 * 能力匹配：给定话题（与可选问题文本），返回按分排序的候选（默认 ≤5）。
 * 跨领域话题（框架 D / 多分类）按标签互补扩展候选池；同分按立场互补排序。
 */
export function matchExperts(
  topic: string,
  question?: string,
  options: { limit?: number; preferStance?: 'optimistic' | 'risk' } = {},
): CapabilityMatch[] {
  const parse = parseTopicCapability(topic, question)
  if (parse === undefined) return []
  const limit = options.limit ?? 5
  const ranked = ALL_EXPERT_METAS
    .map(meta => {
      const { score, matchedTags } = scoreOf(meta, parse)
      const reasons: string[] = []
      if (meta.field === parse.primaryField) reasons.push(`主领域 ${meta.field}`)
      else if (meta.secondaryField === parse.primaryField) reasons.push(`辅领域 ${meta.secondaryField}`)
      else if (parse.primaryField === '按问题落点最近领域') reasons.push(`领域 ${meta.field}`)
      if (matchedTags.length > 0) reasons.push(`标签命中 ${matchedTags.join('/')}`)
      if (reasons.length === 0) reasons.push('通用研判能力')
      return {
        id: meta.id,
        bk: meta.bk,
        namespace: meta.namespace ?? (meta.id.startsWith('bank-') ? 'bank' : 'bk'),
        field: meta.field,
        stance: meta.stance,
        tags: [...meta.tags],
        ...(meta.version !== undefined ? { version: meta.version } : {}),
        matchedTags,
        score,
        reason: reasons.join('；'),
      }
    })
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return ranked.slice(0, limit)
}

/* ------------------------------------------------------------------ */
/* 心智模型注册表（P1.4）                                                */
/* ------------------------------------------------------------------ */

/** 心智模型目录：name → 使用该模型的专家 id 列表（确定性，按 id 排序）。 */
export interface MentalModelCatalogEntry {
  readonly name: string
  readonly experts: readonly string[]
}

/** 聚合全量专家 meta 的心智模型目录（去重、排序、确定性）。 */
export function mentalModelCatalog(): MentalModelCatalogEntry[] {
  const byName = new Map<string, Set<string>>()
  for (const meta of ALL_EXPERT_METAS) {
    for (const name of meta.mentalModels) {
      if (name === '') continue
      let set = byName.get(name)
      if (set === undefined) {
        set = new Set()
        byName.set(name, set)
      }
      set.add(meta.id)
    }
  }
  return [...byName.entries()]
    .map(([name, experts]) => ({ name, experts: [...experts].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/** 按心智模型名反查专家（子串匹配，大小写不敏感）；返回按 id 排序的 meta 列表。 */
export function findExpertsByMentalModel(name: string): ZhijianExpertMeta[] {
  const needle = name.trim().toLowerCase()
  if (needle === '') return []
  const hit = new Set<string>()
  for (const meta of ALL_EXPERT_METAS) {
    for (const model of meta.mentalModels) {
      if (model.toLowerCase().includes(needle) || needle.includes(model.toLowerCase())) {
        hit.add(meta.id)
        break
      }
    }
  }
  return ALL_EXPERT_METAS.filter(meta => hit.has(meta.id)).sort((a, b) => a.id.localeCompare(b.id))
}
