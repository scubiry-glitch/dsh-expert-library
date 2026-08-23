/**
 * BANK-namespace domain pack builder (`bank-finance`).
 *
 * Integration design (PIPELINE-100PLUS-EXPANSION-PLAN.md P0.2/P0.4): the
 * bank pack is built with the SAME projection (`zhijianMetaToExpertV2`),
 * the SAME framework template / output template / method pack / quality
 * policy builders as `zhijian-realestate` (re-exported from
 * `zhijian-pack.ts` with a `bank` prefix), and the same registry merge
 * (routing + `resolveLibrary`). Nothing here reimplements pack machinery —
 * it only supplies bank-specific data: metas, field domains (extended in
 * FIELD_DOMAINS), a PII-redaction quality gate and two bank scenarios.
 *
 * @module dsh-expert-library/v2/bank-pack
 */

import { createHash } from 'node:crypto'
import { BANK_EXPERTS } from '../bank/data/experts.generated.ts'
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
  type QualityGateSpec,
  type ScenarioV2,
  type TeamTemplate,
} from './types.ts'
import {
  frameworkMethodPack,
  frameworkOutputTemplate,
  frameworkTeamTemplate,
  qualityPolicy,
  zhijianMetaToExpertV2,
} from './zhijian-pack.ts'

/** Pack id (SafeId). */
export const BANK_PACK_ID = 'bank-finance'

/** Baseline pack version (semver). */
export const BANK_PACK_VERSION = '1.0.0'

/** Snapshot id of the current BANK profile baseline. */
export const BANK_PACK_SNAPSHOT = 'bank-v1-2026-08-23'

/** Immutable baseline timestamp of the current BANK profile revision. */
export const BANK_BASELINE_DATE = '2026-08-23T00:00:00Z'

/** Bank quality policy id shared by every bank scenario/team template. */
export const BANK_QUALITY_POLICY_ID = 'bank.quality'

/** The bank review capability every bank expert claims. */
export const BANK_REVIEW_CAPABILITY = 'bank.review'

/** Scenario id → controlled intent vocabulary (pack-defined). */
const BANK_SCENARIO_INTENTS: Readonly<Record<string, readonly string[]>> = {
  'bank-retail': ['retail-rollout'],
  'bank-credit-card': ['credit-card-performance'],
}

/** Internal-only bank experts: real identity must never leave the org. */
const BANK_INTERNAL_ONLY_IDS: ReadonlySet<string> = new Set(['bank-09'])

/** One bank routing scenario (routing.ts bank-* rows). */
const BANK_SCENARIOS: readonly ZhijianRouteScenario[] = [
  {
    id: 'bank-retail',
    name: '零售金融/分行经营',
    framework: 'B',
    primaryField: '零售金融',
    candidates: ['bank-09'],
    constraints: '王一帆 bank-09：城商行零售信贷一线操盘手，主答分行执行/样板复制/考核推动/外部合作；政治账+经济账双算、自主可控为底线。',
  },
  {
    id: 'bank-credit-card',
    name: '信用卡提质增效',
    framework: 'B',
    primaryField: '银行经营',
    candidates: ['bank-09'],
    constraints: '信用卡经营以 bank-09 操盘视角主答（考核/渠道/客户分层），收益模型与资负视角联动 BK 金融数据派。',
  },
]

/** One bank routing scenario → ScenarioV2 (candidates stay routing hints). */
function bankScenarioV2(scenario: ZhijianRouteScenario, packVersion: string): ScenarioV2 {
  const fieldCapability = `${scenario.primaryField === '零售金融' ? 'bank.retail' : 'bank.operations'}.review`
  return {
    id: scenario.id,
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    domain: 'banking',
    intents: [...(BANK_SCENARIO_INTENTS[scenario.id] ?? [scenario.id])],
    requiredCapabilities: [
      { capability: BANK_REVIEW_CAPABILITY, minProficiency: 1, cardinality: 1 },
      { capability: fieldCapability, minProficiency: 1, cardinality: 1 },
    ],
    routingPolicy: {
      ...(scenario.constraints !== undefined ? { assertions: [scenario.constraints] } : {}),
      candidateHints: [...scenario.candidates],
    },
    teamTemplate: 'bank.team.B',
    outputTemplate: 'bank.output.B',
    qualityPolicy: BANK_QUALITY_POLICY_ID,
    knowledgePolicy: {
      required: ['bank-expert-memory'],
      optional: ['local-knowledge'],
    },
    toolPolicy: { allowed: [] },
  }
}

/** Knowledge provider manifests the bank pack binds to. */
function bankKnowledgeProviders(packVersion: string): KnowledgeProviderManifest[] {
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
      id: 'bank-expert-memory',
      version: packVersion,
      schemaVersion: SCHEMA_VERSION,
      kind: 'database',
      capabilities: ['search', 'read', 'cite', 'history'],
      freshness: 'monthly',
      scopes: ['experts'],
      domainKnowledgeIds: ['bank.expert-memory'],
    },
  ]
}

/** Structured knowledge base over the BANK expert profile records. */
function bankDomainKnowledgeManifest(packVersion: string): DomainKnowledgeManifest {
  const digest = createHash('sha256').update(JSON.stringify(BANK_EXPERTS)).digest('hex')
  return {
    id: 'bank.expert-memory',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    domain: 'banking.retail',
    boundary: `银行金融领域专家 Profile 基线（2026-08-23，BANK-09 首发）：身份（匿名）、领域（零售金融/银行经营）、立场（操盘手）、风格、心智模型（样板复制/考核绑定/政治账经济账双算/自主可控）、金句、禁区、分析步骤、评估模型（emm 加权+一票否决）与输出 rubric；不含实时业务数据。`,
    ontology: {
      entities: [
        { id: 'expert', description: '银行领域专家（bank-09~）' },
        { id: 'field', description: '银行主领域（零售金融/银行经营）' },
        { id: 'mental-model', description: '心智模型（样板复制法/考核绑定法/双算/自主可控）' },
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
      id: BANK_PACK_SNAPSHOT,
      takenAt: BANK_BASELINE_DATE,
      digest,
      recordCount: BANK_EXPERTS.length,
    },
    retrievalProfiles: [
      { id: 'by-id', method: 'keyword' },
      { id: 'by-model', method: 'keyword' },
    ],
    policies: { citation: 'required', freshness: 'monthly', access: 'readonly' },
  }
}

/** The bank retail-ops method pack (progressive, never persona-injected). */
function bankRetailMethodPack(packVersion: string): MethodPack {
  return {
    id: 'bank.method.retail-ops',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: '银行零售操盘·分行执行协议',
    mediaType: 'agent-instructions',
    load: 'progressive',
    body: [
      '银行零售一线操盘（BANK-09 王一帆视角）标准推进：',
      '1. 先判断政治账和经济账是否都成立。',
      '2. 查找已跑通的样板及其真实数据（如苏州）。',
      '3. 评估各分行执行意愿、能力和抵触点。',
      '4. 设计绩效挂钩、通报和排名机制（指标简单可量化）。',
      '5. 准备标准化工具，减少分行定制工作。',
      '6. 判断外部合作方是赋能银行还是架空银行（自主可控底线）。',
      '输出结构：结论摘要 → 分行执行评估 → 可复制性判断 → 外部合作风险 → 推进路径建议。',
    ].join('\n'),
  }
}

/** The PII-redaction gate spec bound into the bank quality policy (P0.5). */
export function piiRedactionGate(): QualityGateSpec {
  return {
    id: 'pii-redaction',
    kind: 'deterministic',
    appliesTo: ['deliverable'],
    severity: 'hard',
    phase: 'compliance',
    config: {
      sensitiveMarkers: ['账号', '卡号', '身份证', '手机号', '余额', '客户姓名'],
    },
  }
}

/** Builder options. */
export interface BuildBankPackOptions {
  /** Version stamped on every pack object; defaults to {@link BANK_PACK_VERSION}. */
  packVersion?: string
  /** Preset model route applied to every expert (defaults to the shared ZHIJIAN_ROUTE). */
  modelPolicy?: import('./types.ts').ModelPolicy
}

/**
 * Build the complete `bank-finance` domain pack from the in-repo BANK metas.
 * The result is JSON-safe, deterministic, and passes `validateDomainPack`
 * with zero error diagnostics.
 */
export function buildBankDomainPack(options: BuildBankPackOptions = {}): DomainPackV2 {
  const packVersion = options.packVersion ?? BANK_PACK_VERSION
  const modelPolicy = options.modelPolicy ?? ZHIJIAN_ROUTE
  const pack: PackMeta = {
    id: BANK_PACK_ID,
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: '银行金融领域包',
    description: `${BANK_EXPERTS.length} 位银行金融领域专家基线（${BANK_EXPERTS[0]?.id ?? 'bank-09'}，零售金融/银行经营）。V2 投影源为 src/bank/data/experts.generated.ts + routing 表；复用 zhijian-realestate 的模板/质量/方法构建器（bank 前缀）。`,
    dependsOn: ['zhijian-realestate'],
    caliberDeclarations: {
      '行内': '行内经营口径（脱敏）',
      '监管': '监管披露口径',
      '外部': '外部数据口径（需标注来源）',
    },
  }
  const frameworkB = FRAMEWORKS.find(framework => framework.id === 'B' as ZhijianFrameworkId)
  if (frameworkB === undefined) {
    throw new Error('bank pack requires framework B (四段式) from the shared framework table')
  }
  const bankQuality = qualityPolicy(packVersion, BANK_QUALITY_POLICY_ID, [piiRedactionGate()])
  const teamTemplate = frameworkTeamTemplate(frameworkB, packVersion, {
    prefix: 'bank',
    qualityPolicyId: BANK_QUALITY_POLICY_ID,
  })
  const outputTemplate = frameworkOutputTemplate(frameworkB, packVersion, 'bank')
  return {
    pack,
    experts: BANK_EXPERTS.map(meta => {
      const expert = zhijianMetaToExpertV2(meta, { packVersion, modelPolicy })
      return {
        ...expert,
        // Bank internal experts: the real identity must never leave the org.
        ...(BANK_INTERNAL_ONLY_IDS.has(meta.id)
          ? { compliance: { ...expert.compliance, internalOnly: true } }
          : {}),
      }
    }),
    teamTemplates: [teamTemplate],
    outputTemplates: [outputTemplate],
    qualityPolicies: [bankQuality],
    scenarios: BANK_SCENARIOS.map(scenario => bankScenarioV2(scenario, packVersion)),
    toolProviders: [], // provider runtime is Phase 2 — nothing asserted yet
    knowledgeProviders: bankKnowledgeProviders(packVersion),
    domainKnowledge: [bankDomainKnowledgeManifest(packVersion)],
    methodPacks: [
      bankRetailMethodPack(packVersion),
      frameworkMethodPack(frameworkB, packVersion, 'bank'),
    ],
    skillPackages: [], // bank-99 is a workspace skill, not bundled
  }
}

/** Type-only re-export for consumers building overlay packs. */
export type { TeamTemplate, OutputTemplate }
