/**
 * 贝壳（beike）领域包构建器 —— 居住服务/平台生态交叉投影包。
 *
 * 装载与贝壳生态强相关的专家（跨命名空间交叉投影：BK 居住服务派 +
 * pipeline 左晖/一濛），复用同一投影/模板/质量/方法构建器与发射器
 * （整合设计：专家实体按 id 在多包投影，运行时注册表不重复）。
 *
 * 知识库 = 本地 99wiki 的贝壳合作材料（projects/贝壳x江苏银行、
 * projects/贝壳合作方案、projects/VLC租房平台）+ feishu 贝壳纪要。
 *
 * @module dsh-expert-library/v2/beike-pack
 */

import { createHash } from 'node:crypto'
import { ALL_EXPERT_METAS, ZHIJIAN_ROUTE } from '../zhijian/registry.ts'
import { FRAMEWORKS } from '../zhijian/frameworks.ts'
import type { ZhijianFrameworkId, ZhijianRouteScenario, ZhijianExpertMeta } from '../zhijian/types.ts'
import {
  SCHEMA_VERSION,
  type DomainKnowledgeManifest,
  type DomainPackV2,
  type ExpertV2,
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
  REVIEW_CAPABILITY,
  zhijianMetaToExpertV2,
} from './zhijian-pack.ts'
import { piiRedactionGate } from './bank-pack.ts'

/** Pack id (SafeId). */
export const BEIKE_PACK_ID = 'beike'

/** Baseline pack version (semver). */
export const BEIKE_PACK_VERSION = '1.0.0'

/** Snapshot id of the current beike profile baseline. */
export const BEIKE_PACK_SNAPSHOT = 'beike-v1-2026-08-23'

/** Baseline timestamp. */
export const BEIKE_BASELINE_DATE = '2026-08-23T00:00:00Z'

/** Quality policy id shared by every beike scenario/team template. */
export const BEIKE_QUALITY_POLICY_ID = 'beike.quality'

/** The universal review capability every beike expert claims. */
export const BEIKE_REVIEW_CAPABILITY = 'beike.review'

/** Evidence ref for the beike pack roster-level capability claim. */
const BEIKE_ROSTER_EVIDENCE = 'beike:roster'

/**
 * 贝壳生态相关专家（跨命名空间装载，按 id 引用现有 meta，不重复注册）：
 * - bk-002 廖俊平（制度派·经纪/居住服务）
 * - bk-018 柴强（存量统筹派·经纪/居住服务）
 * - bk-019 徐斌（海外监管派·经纪管理）
 * - bk-031 陶琦（挂牌量派·贝壳/NIFD 口径，internalOnly）
 * - bk-033 杨现领（渠道崛起派·贝壳研究院院长）
 * - e08-08 左晖（贝壳创始人·平台经济）
 * - e04-05 一濛（居住服务·住房租赁/长租资管）
 * - s-07 张勇（组织设计·商业模式创新·数字化转型）
 * - s-13 朱啸虎（平台商业模式·单位经济·网络效应）
 * - s-23 程维（双边平台·规模经济·运营执行）
 * - bk-016 黄奇帆（前市长·制度与产业政策设计）
 * - bk-027 冯俊（住建部/房协政策语境，引用须标注时点）
 * - bk-028 赵晖（住建部原总经济师·住房品质与治理）
 * - bank-11 琉（战略咨询·SPQA 问题定义/假设驱动/对标机制提炼，萌翻咨询方法论）
 */
export const BEIKE_EXPERT_IDS: readonly string[] = [
  'bk-002',
  'bk-018',
  'bk-019',
  'bk-031',
  'bk-033',
  'e08-08',
  'e04-05',
  's-07',
  's-13',
  's-23',
  'bk-016',
  'bk-027',
  'bk-028',
  'bank-11',
]

/** 贝壳专家 meta（从全量合并 meta 按 id 装载；缺失即构建失败——防丢）。 */
export function beikeExpertMetas(): readonly ZhijianExpertMeta[] {
  const metas = BEIKE_EXPERT_IDS
    .map(id => ALL_EXPERT_METAS.find(meta => meta.id === id))
  const missing = BEIKE_EXPERT_IDS.filter((id, index) => metas[index] === undefined)
  if (missing.length > 0) {
    throw new Error(`beike pack: 缺少贝壳相关专家 meta：${missing.join(', ')}（检查注册表合并）`)
  }
  return metas as readonly ZhijianExpertMeta[]
}

/** 贝壳路由场景（routing.ts beike-* 行）。 */
const BEIKE_SCENARIOS: readonly ZhijianRouteScenario[] = [
  {
    id: 'beike-ecosystem',
    name: '贝壳生态与居住服务',
    framework: 'B',
    primaryField: '居住服务',
    candidates: ['bk-033', 'e08-08', 'bk-018', 'bk-002', 'bk-019'],
    constraints: '贝壳生态研判：杨现领 bk-033（贝壳研究院院长）渠道/存量流通主答；左晖 e08-08（贝壳创始人）平台/服务品质/产业互联网；柴强 bk-018 存量统筹、廖俊平 bk-002 经纪制度、徐斌 bk-019 监管对比作辅。陶琦 bk-031 贝壳/NIFD 口径仅内部使用。',
  },
  {
    id: 'beike-rental-supply-chain',
    name: '长租与租赁供应链',
    framework: 'B',
    primaryField: '居住服务',
    candidates: ['e04-05', 'bk-033', 'e08-08'],
    constraints: '长租/供应链合作（如贝壳×梦百合长租供应链）：一濛 e04-05 住房租赁/长租资管主答；杨现领 bk-033 租赁市场/租购同权；左晖 e08-08 平台合作视角。素材：feishu 贝壳与梦百合长租供应链合作洽谈纪要。',
  },
]

/** 场景 → controlled intent vocabulary。 */
const BEIKE_SCENARIO_INTENTS: Readonly<Record<string, readonly string[]>> = {
  'beike-ecosystem': ['beike-ecosystem-review'],
  'beike-rental-supply-chain': ['rental-supply-chain'],
}

/** One beike routing scenario → ScenarioV2. */
function beikeScenarioV2(scenario: ZhijianRouteScenario, packVersion: string): ScenarioV2 {
  return {
    id: scenario.id,
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    domain: 'beike',
    intents: [...(BEIKE_SCENARIO_INTENTS[scenario.id] ?? [scenario.id])],
    requiredCapabilities: [
      // Roster gate against the capability every zhijian-projected expert
      // claims (`zhijian.review`), NOT the pack-scoped `beike.review`.
      // Expert overlays now union capability claims by capability id
      // (mergeExpertCapabilities in pack-loader), so a `beike.review` stamp
      // on beike experts survives a higher-precedence zhijian-realestate
      // re-projection; the shared gate keeps a pack-scoped affinity from
      // ever becoming mandatory for roster eligibility. `beike.review`
      // remains a capability marker on beike experts (see beikeExpertToV2)
      // for future tool/知识路由 and capability-index lookups.
      { capability: REVIEW_CAPABILITY, minProficiency: 1, cardinality: 1 },
    ],
    routingPolicy: {
      ...(scenario.constraints !== undefined ? { assertions: [scenario.constraints] } : {}),
      candidateHints: [...scenario.candidates],
    },
    teamTemplate: 'beike.team.B',
    outputTemplate: 'beike.output.B',
    qualityPolicy: BEIKE_QUALITY_POLICY_ID,
    knowledgePolicy: {
      required: ['beike-expert-memory'],
      optional: ['local-knowledge', 'beike-99wiki'],
    },
    toolPolicy: { allowed: [] },
  }
}

/** Knowledge provider manifests the beike pack binds to. */
function beikeKnowledgeProviders(packVersion: string): KnowledgeProviderManifest[] {
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
      id: 'beike-expert-memory',
      version: packVersion,
      schemaVersion: SCHEMA_VERSION,
      kind: 'database',
      capabilities: ['search', 'read', 'cite', 'history'],
      freshness: 'monthly',
      scopes: ['experts'],
      domainKnowledgeIds: ['beike.expert-memory'],
    },
    {
      // 贝壳知识库 = 本地 99wiki 贝壳合作材料。
      id: 'beike-99wiki',
      version: packVersion,
      schemaVersion: SCHEMA_VERSION,
      kind: 'structured-wiki',
      capabilities: ['search', 'read', 'cite', 'history'],
      freshness: 'monthly',
      scopes: ['99wiki'],
      domainKnowledgeIds: ['beike.99wiki'],
    },
  ]
}

/** 本地 99wiki 贝壳合作材料知识库声明。 */
function beike99wikiKnowledgeManifest(packVersion: string): DomainKnowledgeManifest {
  const collections = [
    { id: 'beike-jiangsu', root: 'projects/贝壳x江苏银行', format: 'markdown', description: '贝壳×江苏银行合作' },
    { id: 'beike-cooperation', root: 'projects/贝壳合作方案', format: 'markdown', description: '贝壳合作方案' },
    { id: 'vlc-rental', root: 'projects/VLC租房平台', format: 'markdown', description: 'VLC 租房平台产品与规划' },
    { id: 'beike-minutes', root: 'feishu', format: 'mixed', description: '贝壳相关纪要/素材（贝壳×梦百合长租供应链、业务布局讨论）' },
  ] as const
  const digest = createHash('sha256')
    .update(`beike:99wiki:${collections.map(c => c.id).join(',')}:${BEIKE_PACK_VERSION}`)
    .digest('hex')
  return {
    id: 'beike.99wiki',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    domain: 'beike',
    boundary: '本地 99wiki 贝壳合作材料：贝壳×江苏银行、贝壳合作方案、VLC 租房平台、feishu 贝壳纪要（长租供应链洽谈/业务布局讨论）。内部资料，引用须注明出处；敏感数据不外发。',
    ontology: {
      entities: [
        { id: 'project', description: '贝壳合作项目/方案' },
        { id: 'meeting', description: '贝壳相关洽谈纪要' },
        { id: 'rental', description: '租房平台/长租供应链' },
      ],
      relations: [
        { id: 'project-has-meeting', from: 'project', to: 'meeting', description: '项目关联纪要' },
        { id: 'project-involves-rental', from: 'project', to: 'rental', description: '项目涉及租赁' },
      ],
    },
    collections: collections.map(collection => ({ ...collection })),
    snapshot: {
      id: 'beike-99wiki-2026-08-23',
      takenAt: BEIKE_BASELINE_DATE,
      digest,
      recordCount: 0,
    },
    retrievalProfiles: [
      { id: 'by-keyword', method: 'keyword' },
      { id: 'by-project', method: 'keyword', config: { scope: 'projects' } },
    ],
    policies: { citation: 'required', freshness: 'monthly', access: 'readonly' },
  }
}

/** Structured knowledge base over the beike expert records. */
function beikeDomainKnowledgeManifest(packVersion: string): DomainKnowledgeManifest {
  const metas = beikeExpertMetas()
  const digest = createHash('sha256').update(JSON.stringify(metas)).digest('hex')
  return {
    id: 'beike.expert-memory',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    domain: 'beike',
    boundary: '贝壳生态专家 Profile 投影（2026-08-23）：bk-002/018/019/031/033 居住服务与经纪 + e08-08 左晖（贝壳创始人）+ e04-05 一濛（长租资管）+ s-07 张勇/s-13 朱啸虎/s-23 程维（商业模式与平台经济）+ bk-016 黄奇帆/bk-027 冯俊/bk-028 赵晖（政策治理，引用标注时点）。',
    ontology: {
      entities: [
        { id: 'expert', description: '贝壳生态相关专家' },
        { id: 'field', description: '居住服务/经纪/平台/租赁' },
      ],
      relations: [
        { id: 'expert-belongs-to-field', from: 'expert', to: 'field', description: '专家属于主领域' },
      ],
    },
    collections: [
      { id: 'experts', root: 'experts', format: 'json', description: '每专家一个 Profile 记录' },
    ],
    snapshot: {
      id: BEIKE_PACK_SNAPSHOT,
      takenAt: BEIKE_BASELINE_DATE,
      digest,
      recordCount: metas.length,
    },
    retrievalProfiles: [
      { id: 'by-id', method: 'keyword' },
      { id: 'by-field', method: 'keyword' },
    ],
    policies: { citation: 'required', freshness: 'monthly', access: 'readonly' },
  }
}

/** The beike review protocol method pack (progressive, never persona-injected). */
function beikeProtocolMethodPack(packVersion: string): MethodPack {
  return {
    id: 'beike.method.ecosystem-protocol',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: '贝壳生态研判协议（平台/经纪/渠道/租赁）',
    mediaType: 'agent-instructions',
    load: 'progressive',
    body: [
      '贝壳生态研判协议：',
      '1. 区分平台视角（左晖/杨现领）与经纪制度视角（廖俊平/徐斌/柴强），按问题落点选主答；',
      '2. 口径：贝壳成出口径（bk-031 陶琦）与克而瑞/中指/统计局均有差异，须标注；',
      '3. 陶琦 bk-031 为内测对比项，对外交付不引用；',
      '4. 商业与平台经济议题可选张勇 s-07（组织/商业模式）、朱啸虎 s-13（单位经济/网络效应）、程维 s-23（双边平台/运营执行），分别校验组织生态、单位经济与平台执行；',
      '5. 政策治理议题可选黄奇帆 bk-016、冯俊 bk-027、赵晖 bk-028；引用必须标注前任/原任身份和观点时点，不得表述为现任官员意见；',
      '6. 输出结构按框架 B 四段式：关键结论 → 关键事实及变化 → 归因 → 展望与不确定性。',
    ].join('\n'),
  }
}

/**
 * Project one beike expert meta into an {@link ExpertV2} and stamp the
 * pack-wide `beike.review` capability marker. The scenarios' roster gates
 * use the shared `zhijian.review` claim (see beikeScenarioV2) — this
 * pack-scoped marker is not roster-required; it is stamped for future
 * tool/知识路由 and capability-index lookups, and the overlay merge
 * preserves it across re-projections via the capability-id union in
 * `mergeExpertCapabilities`. The shared zhijian projection injects the
 * generic `zhijian.review` plus field-scoped `realestate.*.review` claims
 * but never the pack-scoped marker.
 */
function beikeExpertToV2(
  meta: ZhijianExpertMeta,
  options: { packVersion?: string; modelPolicy?: import('./types.ts').ModelPolicy } = {},
): ExpertV2 {
  const expert = zhijianMetaToExpertV2(meta, options)
  if (expert.capabilities.some(claim => claim.capability === BEIKE_REVIEW_CAPABILITY)) {
    return expert
  }
  return {
    ...expert,
    capabilities: [
      ...expert.capabilities,
      {
        capability: BEIKE_REVIEW_CAPABILITY,
        proficiency: 1,
        coverage: 'high',
        evidenceRefs: [BEIKE_ROSTER_EVIDENCE],
      },
    ],
  }
}

/** Builder options. */
export interface BuildBeikePackOptions {
  /** Version stamped on every pack object; defaults to {@link BEIKE_PACK_VERSION}. */
  packVersion?: string
  /** Preset model route applied to every expert (defaults to the shared ZHIJIAN_ROUTE). */
  modelPolicy?: import('./types.ts').ModelPolicy
}

/**
 * Build the complete `beike` domain pack. JSON-safe, deterministic,
 * validator-clean.
 */
export function buildBeikeDomainPack(options: BuildBeikePackOptions = {}): DomainPackV2 {
  const packVersion = options.packVersion ?? BEIKE_PACK_VERSION
  const modelPolicy = options.modelPolicy ?? ZHIJIAN_ROUTE
  const metas = beikeExpertMetas()
  const pack: PackMeta = {
    id: BEIKE_PACK_ID,
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: '贝壳生态领域包（居住服务/平台/经纪/租赁）',
    description: `${metas.length} 位贝壳生态相关专家（居住服务/平台创始人 + 商业模式/平台经济外部专家 + 前政府及行业治理专家）。V2 投影源为共享注册表 meta；复用 zhijian/bank 的模板/质量/方法构建器（beike 前缀）。知识库 = 本地 99wiki 贝壳合作材料。`,
    dependsOn: ['zhijian-realestate', 'pipeline-domains', 'pipeline-general'],
    caliberDeclarations: {
      '贝壳': '贝壳成出口径',
      '克而瑞': '克而瑞/普睿监测口径',
      '中指': '中指院口径',
    },
  }
  const frameworkB = FRAMEWORKS.find(framework => framework.id === 'B' as ZhijianFrameworkId)
  if (frameworkB === undefined) {
    throw new Error('beike pack requires framework B from the shared framework table')
  }
  return {
    pack,
    experts: metas.map(meta => beikeExpertToV2(meta, { packVersion, modelPolicy })),
    teamTemplates: [frameworkTeamTemplate(frameworkB, packVersion, {
      prefix: 'beike',
      qualityPolicyId: BEIKE_QUALITY_POLICY_ID,
    })],
    outputTemplates: [frameworkOutputTemplate(frameworkB, packVersion, 'beike')],
    qualityPolicies: [qualityPolicy(packVersion, BEIKE_QUALITY_POLICY_ID, [piiRedactionGate()])],
    scenarios: BEIKE_SCENARIOS.map(scenario => beikeScenarioV2(scenario, packVersion)),
    toolProviders: [],
    knowledgeProviders: beikeKnowledgeProviders(packVersion),
    domainKnowledge: [beikeDomainKnowledgeManifest(packVersion), beike99wikiKnowledgeManifest(packVersion)],
    methodPacks: [
      beikeProtocolMethodPack(packVersion),
      frameworkMethodPack(frameworkB, packVersion, 'beike'),
    ],
    skillPackages: [],
  }
}

/** Type-only re-export for consumers building overlay packs. */
export type { OutputTemplate }
