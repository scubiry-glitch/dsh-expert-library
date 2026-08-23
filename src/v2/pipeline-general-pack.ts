/**
 * pipeline-general 领域包构建器（`pipeline-general`）——P3 续收。
 *
 * 承载 pipeline 特级专家（S-* 40 位，s 命名空间）与小红书操盘手（XHS-*，
 * xhs 命名空间）。与所有包共用同一投影/模板/质量/方法构建器与发射器
 * （整合设计，无平行机制）；pii 硬门复用 bank-pack 导出的 piiRedactionGate。
 *
 * @module dsh-expert-library/v2/pipeline-general-pack
 */

import { createHash } from 'node:crypto'
import { GENERAL_EXPERTS } from '../pipeline-general/data/experts.generated.ts'
import { FRAMEWORKS } from '../zhijian/frameworks.ts'
import { ZHIJIAN_ROUTE } from '../zhijian/registry.ts'
import type { ZhijianFrameworkId } from '../zhijian/types.ts'
import {
  SCHEMA_VERSION,
  type DomainKnowledgeManifest,
  type DomainPackV2,
  type KnowledgeProviderManifest,
  type MethodPack,
  type OutputTemplate,
  type PackMeta,
  type ScenarioV2,
} from './types.ts'
import {
  frameworkMethodPack,
  frameworkOutputTemplate,
  frameworkTeamTemplate,
  qualityPolicy,
  zhijianMetaToExpertV2,
} from './zhijian-pack.ts'
import { piiRedactionGate } from './bank-pack.ts'

/** Pack id (SafeId). */
export const GENERAL_PACK_ID = 'pipeline-general'

/** Baseline pack version (semver). */
export const GENERAL_PACK_VERSION = '1.0.0'

/** Snapshot id of the current pipeline-general profile baseline. */
export const GENERAL_PACK_SNAPSHOT = 'pipeline-general-v1-2026-08-23'

/** Baseline timestamp. */
export const GENERAL_BASELINE_DATE = '2026-08-23T00:00:00Z'

/** Quality policy id shared by every pipeline-general scenario/team template. */
export const GENERAL_QUALITY_POLICY_ID = 'pipeline-general.quality'

/** The universal review capability every general expert claims. */
export const GENERAL_REVIEW_CAPABILITY = 'pipeline-general.review'

/** 通用场景：特级专家研判（候选为全部 s-/xhs- 命名空间专家，hints 不作硬约束）。 */
const GENERAL_SCENARIOS: readonly { id: string; name: string; primaryField: string; candidates: readonly string[] }[] = [
  {
    id: 'pipeline-general',
    name: '特级专家研判（战略/投资/产品/组织/AI）',
    primaryField: '特级专家',
    candidates: GENERAL_EXPERTS.map(meta => meta.id),
  },
]

/** One general scenario → ScenarioV2. */
function generalScenarioV2(scenario: { id: string; name: string; primaryField: string; candidates: readonly string[] }, packVersion: string): ScenarioV2 {
  return {
    id: scenario.id,
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    domain: 'pipeline.general',
    intents: ['general-advisory'],
    requiredCapabilities: [
      { capability: GENERAL_REVIEW_CAPABILITY, minProficiency: 1, cardinality: 1 },
      { capability: 'pipeline.general.review', minProficiency: 1, cardinality: 1 },
    ],
    routingPolicy: {
      assertions: ['特级专家为公众人物，可实名引用；研判结论先行、数字带口径'],
      candidateHints: [...scenario.candidates],
    },
    teamTemplate: 'pipeline-general.team.B',
    outputTemplate: 'pipeline-general.output.B',
    qualityPolicy: GENERAL_QUALITY_POLICY_ID,
    knowledgePolicy: {
      required: ['pipeline-general-expert-memory'],
      optional: ['local-knowledge'],
    },
    toolPolicy: { allowed: [] },
  }
}

/** Knowledge provider manifests the general pack binds to. */
function generalKnowledgeProviders(packVersion: string): KnowledgeProviderManifest[] {
  return [
    {
      id: 'local-knowledge',
      version: packVersion,
      schemaVersion: SCHEMA_VERSION,
      kind: 'files',
      capabilities: ['read'],
      freshness: 'static',
      scopes: ['experts', 'scenarios', 'shared'],
    },
    {
      id: 'pipeline-general-expert-memory',
      version: packVersion,
      schemaVersion: SCHEMA_VERSION,
      kind: 'database',
      capabilities: ['search', 'read', 'cite', 'history'],
      freshness: 'monthly',
      scopes: ['experts'],
      domainKnowledgeIds: ['pipeline-general.expert-memory'],
    },
  ]
}

/** Structured knowledge base over the pipeline-general expert records. */
function generalDomainKnowledgeManifest(packVersion: string): DomainKnowledgeManifest {
  const digest = createHash('sha256').update(JSON.stringify(GENERAL_EXPERTS)).digest('hex')
  return {
    id: 'pipeline-general.expert-memory',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    domain: 'pipeline.general',
    boundary: `pipeline 特级专家（S-* 40 位：巴菲特/芒格/乔布斯/Karpathy/张一鸣…）与小红书操盘手（XHS-*）Profile 基线（2026-08-23）：实名（公众人物）、领域、风格、心智模型、金句、禁区、分析步骤、评估模型与输出 rubric；不含实时业务数据。`,
    ontology: {
      entities: [
        { id: 'expert', description: '特级专家（s-*）/小红书操盘手（xhs-*）' },
        { id: 'field', description: '领域（投资/产品/组织/战略/AI/科学思维…）' },
        { id: 'mental-model', description: '心智模型（method.frameworks）' },
      ],
      relations: [
        { id: 'expert-belongs-to-field', from: 'expert', to: 'field', description: '专家属于主领域' },
        { id: 'expert-uses-model', from: 'expert', to: 'mental-model', description: '专家使用心智模型' },
      ],
    },
    collections: [
      { id: 'experts', root: 'experts', format: 'json', description: '每专家一个 Profile 记录' },
    ],
    snapshot: {
      id: GENERAL_PACK_SNAPSHOT,
      takenAt: GENERAL_BASELINE_DATE,
      digest,
      recordCount: GENERAL_EXPERTS.length,
    },
    retrievalProfiles: [
      { id: 'by-id', method: 'keyword' },
      { id: 'by-field', method: 'keyword' },
    ],
    policies: { citation: 'required', freshness: 'monthly', access: 'readonly' },
  }
}

/** The general review protocol method pack (progressive, never persona-injected). */
function generalProtocolMethodPack(packVersion: string): MethodPack {
  return {
    id: 'pipeline-general.method.review-protocol',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: '特级专家研判协议（实名/结论先行/数字带口径）',
    mediaType: 'agent-instructions',
    load: 'progressive',
    body: [
      'pipeline-general 命名空间研判协议：',
      '1. 特级专家为公众人物，可以实名身份研判（内部实名，对外可实名引用）；',
      '2. 结论先行，数字带来源/时段/区域/单位/口径，无法核实只给框架与方向；',
      '3. 输出结构按框架 B 四段式：关键结论 → 关键事实及变化 → 归因 → 展望与不确定性；',
      '4. 跨领域问题时优先本人最擅长的心智模型切入，再补其他视角。',
    ].join('\n'),
  }
}

/** Builder options. */
export interface BuildPipelineGeneralPackOptions {
  /** Version stamped on every pack object; defaults to {@link GENERAL_PACK_VERSION}. */
  packVersion?: string
  /** Preset model route applied to every expert (defaults to the shared ZHIJIAN_ROUTE). */
  modelPolicy?: import('./types.ts').ModelPolicy
}

/**
 * Build the complete `pipeline-general` domain pack from the in-repo general
 * metas. JSON-safe, deterministic, validator-clean.
 */
export function buildPipelineGeneralDomainPack(options: BuildPipelineGeneralPackOptions = {}): DomainPackV2 {
  const packVersion = options.packVersion ?? GENERAL_PACK_VERSION
  const modelPolicy = options.modelPolicy ?? ZHIJIAN_ROUTE
  const pack: PackMeta = {
    id: GENERAL_PACK_ID,
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: 'pipeline 特级专家领域包（S-* 40 + XHS-* 1）',
    description: `${GENERAL_EXPERTS.length} 位 pipeline 特级专家/操盘手基线（s-*/xhs-*，公众人物实名）。V2 投影源为 src/pipeline-general/data/experts.generated.ts；复用 zhijian/bank 的模板/质量/方法构建器（pipeline-general 前缀）。`,
    dependsOn: ['zhijian-realestate'],
    caliberDeclarations: {
      '线上': 'paper.morning.rocks 专家库口径',
    },
  }
  const frameworkB = FRAMEWORKS.find(framework => framework.id === 'B' as ZhijianFrameworkId)
  if (frameworkB === undefined) {
    throw new Error('pipeline-general pack requires framework B from the shared framework table')
  }
  return {
    pack,
    experts: GENERAL_EXPERTS.map(meta => zhijianMetaToExpertV2(meta, { packVersion, modelPolicy })),
    teamTemplates: [frameworkTeamTemplate(frameworkB, packVersion, {
      prefix: 'pipeline-general',
      qualityPolicyId: GENERAL_QUALITY_POLICY_ID,
    })],
    outputTemplates: [frameworkOutputTemplate(frameworkB, packVersion, 'pipeline-general')],
    qualityPolicies: [qualityPolicy(packVersion, GENERAL_QUALITY_POLICY_ID, [piiRedactionGate()])],
    scenarios: GENERAL_SCENARIOS.map(scenario => generalScenarioV2(scenario, packVersion)),
    toolProviders: [],
    knowledgeProviders: generalKnowledgeProviders(packVersion),
    domainKnowledge: [generalDomainKnowledgeManifest(packVersion)],
    methodPacks: [
      generalProtocolMethodPack(packVersion),
      frameworkMethodPack(frameworkB, packVersion, 'pipeline-general'),
    ],
    skillPackages: [],
  }
}

/** Type-only re-export for consumers building overlay packs. */
export type { OutputTemplate }
