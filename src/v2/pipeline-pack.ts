/**
 * pipeline 命名空间领域包构建器（`pipeline-domains`）——P3.1。
 *
 * 整合设计：与 zhijian/bank 包共用同一投影（zhijianMetaToExpertV2）、同一
 * 模板/输出/方法/质量构建器（zhijian-pack.ts，pipeline 前缀）、同一发射器
 * （pack-common）。本文件只提供 pipeline 专属数据：PIPELINE_EXPERTS 投影、
 * 两个领域场景（房地产企业经营 / 宏观与资本市场）与 pii-redaction 硬门
 * （银行/金融敏感数据脱敏；E13 江苏银行高层已并入 bank-finance 包）。
 *
 * @module dsh-expert-library/v2/pipeline-pack
 */

import { createHash } from 'node:crypto'
import { PIPELINE_EXPERTS } from '../pipeline/data/experts.generated.ts'
import { FRAMEWORKS } from '../zhijian/frameworks.ts'
import { ZHIJIAN_ROUTE } from '../zhijian/registry.ts'
import type { ZhijianFrameworkId, ZhijianRouteScenario } from '../zhijian/types.ts'
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
export const PIPELINE_PACK_ID = 'pipeline-domains'

/** Baseline pack version (semver). */
export const PIPELINE_PACK_VERSION = '1.0.0'

/** Snapshot id of the current pipeline profile baseline. */
export const PIPELINE_PACK_SNAPSHOT = 'pipeline-v1-2026-08-23'

/** Baseline timestamp. */
export const PIPELINE_BASELINE_DATE = '2026-08-23T00:00:00Z'

/** Quality policy id shared by every pipeline scenario/team template. */
export const PIPELINE_QUALITY_POLICY_ID = 'pipeline.quality'

/** The universal review capability every pipeline expert claims. */
export const PIPELINE_REVIEW_CAPABILITY = 'pipeline.review'

/** pipeline 路由场景（routing.ts pipeline-* 行）——每个场景即一个领域切片。 */
const PIPELINE_SCENARIOS: readonly ZhijianRouteScenario[] = [
  {
    id: 'pipeline-realestate-ops',
    name: '房地产企业经营',
    framework: 'B',
    primaryField: '房地产',
    candidates: ['e08-08', 'e08-06', 'e08-07', 'e08-09', 'e08-yong-bang'],
    constraints: 'pipeline 命名空间（E08，公众人物实名）。左晖 e08-08 平台/服务品质/产业互联网，吴亚军 e08-06 房企经营，魏行空 e08-09 不动产金融/估值。',
  },
  {
    id: 'pipeline-macro-capital',
    name: '宏观经济与资本市场',
    framework: 'B',
    primaryField: '宏观经济',
    candidates: ['e01-08', 'e01-09', 'e01-07', 'e01-02', 'e01-06'],
    constraints: 'pipeline 命名空间（E01，公众人物实名）。高善文 e01-08 资本市场/周期，鲁政委 e01-09 汇率/利率，李扬 e01-07 宏观审慎/债务。',
  },
]

/** 场景 → controlled intent vocabulary（pack-defined）。 */
const PIPELINE_SCENARIO_INTENTS: Readonly<Record<string, readonly string[]>> = {
  'pipeline-realestate-ops': ['realestate-operations'],
  'pipeline-macro-capital': ['macro-capital-markets'],
}

/** 领域 → pack 域词汇（与 FIELD_DOMAINS 一致；未知领域不捏造）。 */
function pipelineFieldDomain(field: string): string {
  const map: Record<string, string> = {
    '房地产': 'realestate.operations',
    '宏观经济': 'realestate.macro',
    '江苏银行高层': 'bank.strategy',
    '资产配置': 'finance.allocation',
  }
  return map[field] ?? 'pipeline.general'
}

/** One pipeline routing scenario → ScenarioV2 (candidates stay routing hints). */
function pipelineScenarioV2(scenario: ZhijianRouteScenario, packVersion: string): ScenarioV2 {
  return {
    id: scenario.id,
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    domain: 'pipeline',
    intents: [...(PIPELINE_SCENARIO_INTENTS[scenario.id] ?? [scenario.id])],
    requiredCapabilities: [
      { capability: PIPELINE_REVIEW_CAPABILITY, minProficiency: 1, cardinality: 1 },
      { capability: `${pipelineFieldDomain(scenario.primaryField)}.review`, minProficiency: 1, cardinality: 1 },
    ],
    routingPolicy: {
      ...(scenario.constraints !== undefined ? { assertions: [scenario.constraints] } : {}),
      candidateHints: [...scenario.candidates],
    },
    teamTemplate: 'pipeline.team.B',
    outputTemplate: 'pipeline.output.B',
    qualityPolicy: PIPELINE_QUALITY_POLICY_ID,
    knowledgePolicy: {
      required: ['pipeline-expert-memory'],
      optional: ['local-knowledge'],
    },
    toolPolicy: { allowed: [] },
  }
}

/** Knowledge provider manifests the pipeline pack binds to. */
function pipelineKnowledgeProviders(packVersion: string): KnowledgeProviderManifest[] {
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
      id: 'pipeline-expert-memory',
      version: packVersion,
      schemaVersion: SCHEMA_VERSION,
      kind: 'database',
      capabilities: ['search', 'read', 'cite', 'history'],
      freshness: 'monthly',
      scopes: ['experts'],
      domainKnowledgeIds: ['pipeline.expert-memory'],
    },
  ]
}

/** Structured knowledge base over the pipeline expert profile records. */
function pipelineDomainKnowledgeManifest(packVersion: string): DomainKnowledgeManifest {
  const digest = createHash('sha256').update(JSON.stringify(PIPELINE_EXPERTS)).digest('hex')
  return {
    id: 'pipeline.expert-memory',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    domain: 'pipeline.general',
    boundary: `pipeline 专家库（paper.morning.rocks）归一化 Profile 基线（2026-08-23，E01 宏观 9 / E08 房地产 10；E13 江苏银行 3 已并入 bank-finance 包）：实名（公众人物）、领域、立场、风格、心智模型、金句、禁区、分析步骤、评估模型与输出 rubric；不含实时业务数据。`,
    ontology: {
      entities: [
        { id: 'expert', description: 'pipeline 领域专家（e01-* 宏观 / e08-* 房地产；e13-* 已并入 bank-finance）' },
        { id: 'field', description: '领域（房地产/宏观经济/江苏银行高层/资产配置）' },
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
      id: PIPELINE_PACK_SNAPSHOT,
      takenAt: PIPELINE_BASELINE_DATE,
      digest,
      recordCount: PIPELINE_EXPERTS.length,
    },
    retrievalProfiles: [
      { id: 'by-id', method: 'keyword' },
      { id: 'by-field', method: 'keyword' },
    ],
    policies: { citation: 'required', freshness: 'monthly', access: 'readonly' },
  }
}

/** The pipeline review protocol method pack (progressive, never persona-injected). */
function pipelineProtocolMethodPack(packVersion: string): MethodPack {
  return {
    id: 'pipeline.method.review-protocol',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: 'pipeline 研判协议（领域化研判/数字带口径/敏感脱敏）',
    mediaType: 'agent-instructions',
    load: 'progressive',
    body: [
      'pipeline 命名空间研判协议：',
      '1. 以本人实名（公众人物）与领域立场研判，结论先行；',
      '2. 数字带来源/时段/区域/单位/口径，无法核实只给框架与方向；',
      '3. 银行/金融敏感数据（账号/卡号/手机号/身份证）一律脱敏，只给聚合口径；',
      '4. 输出结构按框架 B 四段式：关键结论 → 关键事实及变化 → 归因 → 展望与不确定性。',
    ].join('\n'),
  }
}

/** Builder options. */
export interface BuildPipelinePackOptions {
  /** Version stamped on every pack object; defaults to {@link PIPELINE_PACK_VERSION}. */
  packVersion?: string
  /** Preset model route applied to every expert (defaults to the shared ZHIJIAN_ROUTE). */
  modelPolicy?: import('./types.ts').ModelPolicy
}

/**
 * Build the complete `pipeline-domains` domain pack from the in-repo pipeline
 * metas. The result is JSON-safe, deterministic, and passes
 * `validateDomainPack` with zero error diagnostics.
 */
export function buildPipelineDomainPack(options: BuildPipelinePackOptions = {}): DomainPackV2 {
  const packVersion = options.packVersion ?? PIPELINE_PACK_VERSION
  const modelPolicy = options.modelPolicy ?? ZHIJIAN_ROUTE
  const pack: PackMeta = {
    id: PIPELINE_PACK_ID,
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: 'pipeline 领域包（E01 宏观 / E08 房地产 / E13 江苏银行）',
    description: `${PIPELINE_EXPERTS.length} 位 pipeline 专家库归一化专家基线（e01-* 宏观 / e08-* 房地产，公众人物实名；e13-* 江苏银行高层已并入 bank-finance 包）。V2 投影源为 src/pipeline/data/experts.generated.ts + routing 表；复用 zhijian/bank 的模板/质量/方法构建器（pipeline 前缀）。`,
    dependsOn: ['zhijian-realestate', 'bank-finance'],
    caliberDeclarations: {
      '线上': 'paper.morning.rocks 专家库口径',
      '行内': '行内经营口径（脱敏）',
    },
  }
  const frameworkB = FRAMEWORKS.find(framework => framework.id === 'B' as ZhijianFrameworkId)
  if (frameworkB === undefined) {
    throw new Error('pipeline pack requires framework B from the shared framework table')
  }
  return {
    pack,
    experts: PIPELINE_EXPERTS.map(meta => zhijianMetaToExpertV2(meta, { packVersion, modelPolicy })),
    teamTemplates: [frameworkTeamTemplate(frameworkB, packVersion, {
      prefix: 'pipeline',
      qualityPolicyId: PIPELINE_QUALITY_POLICY_ID,
    })],
    outputTemplates: [frameworkOutputTemplate(frameworkB, packVersion, 'pipeline')],
    qualityPolicies: [qualityPolicy(packVersion, PIPELINE_QUALITY_POLICY_ID, [piiRedactionGate()])],
    scenarios: PIPELINE_SCENARIOS.map(scenario => pipelineScenarioV2(scenario, packVersion)),
    toolProviders: [],
    knowledgeProviders: pipelineKnowledgeProviders(packVersion),
    domainKnowledge: [pipelineDomainKnowledgeManifest(packVersion)],
    methodPacks: [
      pipelineProtocolMethodPack(packVersion),
      frameworkMethodPack(frameworkB, packVersion, 'pipeline'),
    ],
    skillPackages: [],
  }
}

/** Type-only re-export for consumers building overlay packs. */
export type { OutputTemplate }
