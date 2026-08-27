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
import type { ZhijianField, ZhijianFrameworkId, ZhijianRouteScenario } from '../zhijian/types.ts'
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
  type SkillPackageManifest,
  type TeamTemplate,
} from './types.ts'
import {
  FIELD_DOMAINS,
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

/** Skill 内容版本约定（技能自身无版本号时用本地基线版本，同 zhijian 包）。 */
export const BANK_SKILL_BASELINE_VERSION = '0.0.0-local'

/** bank-finance 包捆绑技能（内容在 `domain-packs/bank-finance/source/skills/<id>/`，
 * 发射时保留为包内 `skills/<id>/`；SKILL.md 树为内容本体，manifest 为声明）。
 * finesse-ui / gsap-* 为渲染增强技能（同 zhijian-realestate 域，内容从插件
 * bundled knowledge/skills/ 复制到本域 source/skills/ 随包分发——技能引用规则
 * 见 src/skills-discovery.ts：权威路径以 GET /plugins/dsh-expert-library/skills
 * 为准，包内副本仅供打包分发）。 */
export const BANK_SKILL_PACKAGES: readonly { id: string; name: string; version: string; license?: string }[] = [
  { id: 'bank-retail-finance-analysis', name: 'bank-retail-finance-analysis', version: BANK_SKILL_BASELINE_VERSION },
  { id: 'strategy-consulting', name: 'strategy-consulting', version: BANK_SKILL_BASELINE_VERSION },
  { id: 'finesse-ui', name: 'finesse-ui', version: '0.20.0', license: 'MIT' },
  { id: 'gsap-core', name: 'gsap-core', version: BANK_SKILL_BASELINE_VERSION, license: 'MIT' },
  { id: 'gsap-scrolltrigger', name: 'gsap-scrolltrigger', version: BANK_SKILL_BASELINE_VERSION, license: 'MIT' },
  { id: 'gsap-timeline', name: 'gsap-timeline', version: BANK_SKILL_BASELINE_VERSION, license: 'MIT' },
]

/**
 * 声明级 digest：sha256 over the declaration identity（id/version/root）。
 * 内容树由发射器在 SOURCE-MANIFEST 中以逐文件 sha256 记录（lossless），
 * 与 zhijian 包的 skill 声明模式一致。
 */
function bankSkillPackageDigest(decl: { id: string; version: string }): string {
  return createHash('sha256')
    .update(`bank:skill-package:${decl.id}:${decl.version}:skills/${decl.id}`)
    .digest('hex')
}

/** One bundled bank skill → {@link SkillPackageManifest}（local-only，无 license ⇒ internalOnly）。 */
function bankSkillPackageManifest(decl: { id: string; name: string; version: string; license?: string }): SkillPackageManifest {
  return {
    id: decl.id,
    name: decl.name,
    version: decl.version,
    schemaVersion: SCHEMA_VERSION,
    source: {
      kind: 'builtin',
      // 相对包根：发射后包内 `skills/<id>/` 存在（内容树由发射器拷贝）。
      root: `skills/${decl.id}`,
      digest: bankSkillPackageDigest(decl),
      ...(decl.license === undefined ? {} : { license: decl.license }),
    },
    // 技能主体在 SKILL.md 树（运行时 resolveSkill 读取），声明本身无实体贡献。
    contributions: {},
    permissions: {
      execScripts: [],
      ...(decl.license === undefined ? { internalOnly: true } : {}),
    },
  }
}

/** Scenario id → controlled intent vocabulary (pack-defined). */
const BANK_SCENARIO_INTENTS: Readonly<Record<string, readonly string[]>> = {
  'bank-retail': ['retail-rollout'],
  'bank-credit-card': ['credit-card-performance'],
  'bank-strategy': ['bank-strategy-execution'],
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
  {
    id: 'bank-strategy',
    name: '银行战略与经营',
    framework: 'B',
    primaryField: '江苏银行高层',
    candidates: ['e13-01', 'e13-02', 'e13-03'],
    constraints: 'E13 江苏银行高层（pipeline 命名空间，公众人物实名）：袁军 e13-01 战略/客户经营，高增银 e13-02 量化目标评审，梁斌 e13-03 零售/网络金融/数智化。敏感数据按 pii-redaction 硬门脱敏。',
  },
]

/** One bank routing scenario → ScenarioV2 (candidates stay routing hints). */
function bankScenarioV2(scenario: ZhijianRouteScenario, packVersion: string): ScenarioV2 {
  const fieldCapability = `${FIELD_DOMAINS[scenario.primaryField as ZhijianField] ?? 'bank.general'}.review`
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
      optional: ['local-knowledge', 'bank-99wiki'],
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
    {
      // 本包知识库 = 本地 99wiki 目录（江苏银行/银行研究 Obsidian 知识库）。
      id: 'bank-99wiki',
      version: packVersion,
      schemaVersion: SCHEMA_VERSION,
      kind: 'structured-wiki',
      capabilities: ['search', 'read', 'cite', 'history'],
      freshness: 'monthly',
      // scope 根：相对队长工作区的 `99wiki/`（如 workspace 为
      // /root/.openclaw/workspace 时即 /root/.openclaw/workspace/99wiki）。
      scopes: ['99wiki'],
      domainKnowledgeIds: ['bank.99wiki'],
    },
  ]
}

/**
 * 本地 99wiki 知识库声明（DomainKnowledgeManifest）——bank-finance 包的
 * 领域知识底座。collections.root 相对 99wiki 目录本身；snapshot 为声明级
 * （构建期纯函数不读目录：digest 对集合描述计算，recordCount 由运行时枚举）。
 */
function bank99wikiKnowledgeManifest(packVersion: string): DomainKnowledgeManifest {
  const collections = [
    { id: 'expert-system', root: 'projects/专家体系', format: 'markdown', description: '专家体系（BANK-99 调用说明、专家画像）' },
    { id: 'banking-research-assistant', root: 'projects/银行业研究助手', format: 'markdown', description: '银行业研究助手系统设计（SDD）与专家辩论纪要' },
    { id: 'credit-card-premium', root: 'projects/江苏银行高端信用卡', format: 'markdown', description: '高端信用卡方案与权益评审圆桌' },
    { id: 'credit-card-performance', root: 'projects/江苏银行信用卡提质增效研究', format: 'markdown', description: '信用卡提质增效研究' },
    { id: 'ai-computing-finance', root: 'projects/江苏银行算力金融', format: 'markdown', description: '算力金融与 AI 银行卡评审' },
    { id: 'retail-credit-coop', root: 'projects/银保渠道零售信贷合作', format: 'markdown', description: '银保渠道零售信贷合作' },
    { id: 'branch-diagnosis', root: 'projects/干翻宁波', format: 'markdown', description: '分行对标诊断（宁波）与专家圆桌' },
    { id: 'beike-cooperation', root: 'projects/贝壳x江苏银行', format: 'markdown', description: '贝壳×江苏银行合作' },
    { id: 'retail-key-tasks', root: 'projects/零售信贷重点工作', format: 'markdown', description: '零售信贷重点工作' },
    { id: 'feishu-materials', root: 'feishu', format: 'mixed', description: '银行研究素材（政策/研报/纪要/报表）' },
  ] as const
  const digest = createHash('sha256')
    .update(`bank:99wiki:${collections.map(c => c.id).join(',')}:${BANK_PACK_VERSION}`)
    .digest('hex')
  return {
    id: 'bank.99wiki',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    domain: 'banking.jiangsu',
    boundary: '本地 99wiki（江苏银行/银行研究 Obsidian 知识库）：专家体系、银行业研究助手、江苏银行高端信用卡/算力金融/信用卡提质增效、银保渠道零售信贷合作、分行诊断、贝壳合作、feishu 素材（政策/研报/纪要/日报表）。内部资料，引用须注明出处；敏感数据不外发。',
    ontology: {
      entities: [
        { id: 'project', description: '银行研究项目/专题' },
        { id: 'expert', description: '专家画像与调用说明（BANK-99 体系）' },
        { id: 'meeting', description: '圆桌纪要/辩论/评审' },
        { id: 'policy', description: '监管与地方政策材料' },
      ],
      relations: [
        { id: 'project-has-expert', from: 'project', to: 'expert', description: '项目关联专家' },
        { id: 'project-references-policy', from: 'project', to: 'policy', description: '项目引用政策材料' },
      ],
    },
    collections: collections.map(collection => ({ ...collection })),
    snapshot: {
      id: '99wiki-local-2026-08-23',
      takenAt: BANK_BASELINE_DATE,
      digest,
      // 构建期纯函数不枚举目录；运行时按 collections.root 枚举实际记录数。
      recordCount: 0,
    },
    retrievalProfiles: [
      { id: 'by-keyword', method: 'keyword' },
      { id: 'by-project', method: 'keyword', config: { scope: 'projects' } },
    ],
    policies: { citation: 'required', freshness: 'monthly', access: 'readonly' },
  }
}

/**
 * bank-finance 域品牌与视觉规范（C-1：渲染环节不再依赖任务文本口述色值）。
 * 声明式 manifest：内容本体为 boundary/collections 描述（SkillPackage 式的
 * 纯声明，无内嵌文件）；渲染专家（designer/docs-coordinator）读取本声明后按
 * 蓝金变体执行 finesse-ui product register。任务口径以主蓝 #2d5bd8、金
 * #c98a2e 为准；finesse Set 9 的 --accent:#2D5BD8/--accent-2:#E08A2E 仅参考。
 */
function bankBrandKnowledgeManifest(packVersion: string): DomainKnowledgeManifest {
  const digest = createHash('sha256')
    .update(`bank:brand:blue-gold:${packVersion}:2d5bd8:c98a2e`)
    .digest('hex')
  return {
    id: 'bank.brand',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    domain: 'banking.jiangsu.visual',
    boundary: '江苏银行域视觉规范（蓝金变体）：主蓝 #2d5bd8、深蓝 #2447b8、金 #c98a2e（金文字压深 #8a5a14 保对比度）、tinted 底 #eef1f8 系；对应 finesse-ui Set 9 Cobalt Trust（product-palettes.md §4：--accent:#2D5BD8、--accent-2:#E08A2E——任务口径以 #2d5bd8/#c98a2e 为准，Set 9 的 #E08A2E 仅参考）；语义色（绿/红）与品牌色分离；对比度下限 4.5:1。渲染银行域页面须先读本声明，不再依赖任务文本口述色值。',
    ontology: {
      entities: [
        { id: 'brand-color', description: '品牌主色/深色/金色/金文字压深/tinted 底' },
        { id: 'semantic-color', description: '语义色（绿/红）与品牌色分离' },
        { id: 'finesse-set9', description: 'finesse-ui product-palettes Set 9 Cobalt Trust 参考值' },
      ],
      relations: [
        { id: 'brand-maps-to-finesse', from: 'brand-color', to: 'finesse-set9', description: '品牌色映射到 finesse Set 9 参考值' },
      ],
    },
    collections: [
      { id: 'visual-spec', root: 'domain-knowledge', format: 'manifest', description: '品牌与视觉规范声明（boundary 文本即规范本体）' },
    ],
    snapshot: {
      id: 'bank-brand-blue-gold-2026-08-25',
      takenAt: BANK_BASELINE_DATE,
      digest,
      recordCount: 1,
    },
    retrievalProfiles: [
      { id: 'full-read', method: 'full-read' },
    ],
    policies: { citation: 'optional', freshness: 'static', access: 'readonly' },
  }
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
    description: `${BANK_EXPERTS.length} 位银行金融领域专家基线（bank-09 零售操盘 + e13-* 江苏银行高层，零售金融/银行经营/江苏银行高层）。V2 投影源为 src/bank/data/experts.generated.ts + routing 表；复用 zhijian-realestate 的模板/质量/方法构建器（bank 前缀）。`,
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
        // 银行专家统一声明通用评审能力 bank.review（bankScenarioV2 的
        // requiredCapabilities 硬门：每个 bank 场景至少一位专家声明它；
        // zhijianMetaToExpertV2 只投影领域子能力如 bank.strategy.review）。
        capabilities: [
          ...expert.capabilities,
          { capability: BANK_REVIEW_CAPABILITY, proficiency: 1, coverage: 'medium', evidenceRefs: ['zhijian:roster'] },
        ],
        // Bank internal experts: the real identity must never leave the org.
        ...(BANK_INTERNAL_ONLY_IDS.has(meta.id)
          ? { compliance: { ...expert.compliance, internalOnly: true } }
          : {}),
        // 知识库 = 本地 99wiki：每位银行专家绑定 99wiki 作用域（追加声明）。
        knowledgeBindings: [
          ...expert.knowledgeBindings,
          { providerId: 'bank-99wiki', scope: '99wiki' },
        ],
      }
    }),
    teamTemplates: [teamTemplate],
    outputTemplates: [outputTemplate],
    qualityPolicies: [bankQuality],
    scenarios: BANK_SCENARIOS.map(scenario => bankScenarioV2(scenario, packVersion)),
    toolProviders: [], // provider runtime is Phase 2 — nothing asserted yet
    knowledgeProviders: bankKnowledgeProviders(packVersion),
    domainKnowledge: [
      bankDomainKnowledgeManifest(packVersion),
      bank99wikiKnowledgeManifest(packVersion),
      bankBrandKnowledgeManifest(packVersion),
    ],
    methodPacks: [
      bankRetailMethodPack(packVersion),
      frameworkMethodPack(frameworkB, packVersion, 'bank'),
    ],
    skillPackages: BANK_SKILL_PACKAGES.map(bankSkillPackageManifest),
  }
}

/** Type-only re-export for consumers building overlay packs. */
export type { TeamTemplate, OutputTemplate }
