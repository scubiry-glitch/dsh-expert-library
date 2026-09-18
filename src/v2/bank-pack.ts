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
export const BANK_PACK_VERSION = '1.1.0'

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
export const BANK_SKILL_PACKAGES: readonly { id: string; name: string; version: string; license?: string; internalOnly?: boolean }[] = [
  { id: 'bank-retail-finance-analysis', name: 'bank-retail-finance-analysis', version: BANK_SKILL_BASELINE_VERSION, license: 'UNLICENSED', internalOnly: true },
    { id: 'bank-activity-eval', name: 'bank-activity-eval', version: BANK_SKILL_BASELINE_VERSION, license: 'UNLICENSED', internalOnly: true },
  { id: 'strategy-consulting', name: 'strategy-consulting', version: BANK_SKILL_BASELINE_VERSION, license: 'UNLICENSED', internalOnly: true },
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
function bankSkillPackageManifest(decl: { id: string; name: string; version: string; license?: string; internalOnly?: boolean }): SkillPackageManifest {
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
      // 无 license ⇒ internalOnly（§3.7 默认）；自研内部技能显式声明
      // license 'UNLICENSED'（SPDX 私有约定）+ internalOnly: true，
      // 行为不变并消除 missing-license 校验警告。
      ...(decl.internalOnly === true || decl.license === undefined ? { internalOnly: true } : {}),
    },
  }
}

/** Scenario id → controlled intent vocabulary (pack-defined). */
const BANK_SCENARIO_INTENTS: Readonly<Record<string, readonly string[]>> = {
  'bank-retail': ['retail-rollout'],
  'bank-credit-card': ['credit-card-performance', 'methodology-extraction'],
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
    constraints: '信贷舵手 bank-09：城商行零售信贷一线操盘手，主答分行执行/样板复制/考核推动/外部合作；政治账+经济账双算、自主可控为底线。考核与渠道机制引用 bank.method.incentive-governance，目标拆解引用 bank.method.attribution，外部合作评审引用 bank.method.partnership-diligence。',
  },
  {
    id: 'bank-credit-card',
    name: '信用卡提质增效',
    framework: 'B',
    primaryField: '银行经营',
    candidates: ['bank-09'],
    constraints: '信用卡经营以 bank-09 操盘视角主答（考核/渠道/客户分层），收益模型与资负视角联动 BK 金融数据派。方法论提取类任务（methodology-extraction）优先使用 bank.output.method-record 七字段记录模板，直引句须过 quote-verbatim 门、历史样本数字须过 historical-timestamp 门；阈值类结论引用 bank.method.threshold-calc（历史参数必须本行重算），对标前引用 bank.method.caliber-restore（同源材料不构成独立验证）；客群工程引用 bank.method.customer-tiering，任务启动时按目的整链取用 bank.method.work-chains 六条成品工作链。',
  },
  {
    id: 'bank-strategy',
    name: '银行战略与经营',
    framework: 'B',
    primaryField: '江苏银行高层',
    candidates: ['e13-01', 'e13-02', 'e13-03'],
    constraints: 'E13 江苏银行高层（pipeline 命名空间，行业花名）：战略沙盘官 e13-01 战略/客户经营，息差账房 e13-02 量化目标评审，风控守门员 e13-03 零售/网络金融/数智化。敏感数据按 pii-redaction 硬门脱敏。产品线损益评审引用 bank.method.tiered-pnl，对标与口径处理引用 bank.method.caliber-restore。',
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
      optional: ['local-knowledge', 'bank-99wiki', 'bank-analytics'],
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
      // 银行分析数据库（SQLite）：同业周度/行内/分行/行业/宏观数据，含
      // meta_sources 来源可信度分级。方法包「本行重算」的数据入口。
      id: 'bank-analytics',
      version: packVersion,
      schemaVersion: SCHEMA_VERSION,
      kind: 'database',
      capabilities: ['search', 'read', 'cite', 'history'],
      freshness: 'daily',
      scopes: ['99wiki/projects/银行分析数据库'],
      domainKnowledgeIds: ['bank.analytics'],
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
 * 银行分析数据库声明（DomainKnowledgeManifest）——bank-finance 包的结构化
 * 数据底座（SQLite）。collections.root 指向库文件（相对 99wiki 目录）；
 * meta_sources 表为全库溯源：引用须带来源与可信度等级（年报/行研=high，
 * 微信文章=medium）。方法包 threshold-calc / caliber-restore / attribution
 * 的「本行重算」以此库为数据入口。
 */
function bankAnalyticsKnowledgeManifest(packVersion: string): DomainKnowledgeManifest {
    const collections = [
        { id: 'analytics-peer-weekly', root: 'projects/银行分析数据库/bank_analytics.db', format: 'sqlite', description: '同业周度快照：peer_15banks_weekly / peer_city_product_weekly / industry_consumer_loan_bigbank（15 家银行零售贷款余额·增减·排名，含 is_us 江苏银行标记）——双基准对标（B-06-02）与同业比较的数据源' },
        { id: 'analytics-jsbank-internal', root: 'projects/银行分析数据库/bank_analytics.db', format: 'sqlite', description: '行内经营：jsbank_retail_loan_weekly / jsbank_income_progress_weekly / jsbank_pricing_monitor_monthly / jsbank_new_pricing_weekly / jsbank_target_scenario / jsbank_biz_loan_snapshot / jsbank_product_eva_h1 / jsbank_province_share_weekly——阈值验算（threshold-calc「本行重算」）与定价实测（B-06-04）的数据源' },
        { id: 'analytics-branch', root: 'projects/银行分析数据库/bank_analytics.db', format: 'sqlite', description: '分行维度：branch_benchmarking_weekly / branch_capacity / branch_market_share / branch_product_matrix / branch_product_metrics / branch_mortgage——归责切分（attribution）与样板复制的数据源' },
        { id: 'analytics-industry', root: 'projects/银行分析数据库/bank_analytics.db', format: 'sqlite', description: '行业年度/趋势：industry_bank_annual / industry_dupont / industry_nim_trend / industry_retail_segment / retail_loan_snapshot / retail_new_lending_rate / retail_product_income / retail_target_gap——三类损益（tiered-pnl）与口径还原对标（caliber-restore）的数据源' },
        { id: 'analytics-macro', root: 'projects/银行分析数据库/bank_analytics.db', format: 'sqlite', description: '宏观：macro_indicators / macro_policy / dim_banks / dim_branches / dim_products / dim_partners 及合作方定价（partner_auto_pricing / partner_housing_products）' },
        { id: 'analytics-provenance', root: 'projects/银行分析数据库/bank_analytics.db', format: 'sqlite', description: '溯源：meta_sources（每条数据的来源 URL/类型/可信度 high·medium 与日期）+ load_weekly_*.py / build_db_v2.py 建库脚本（可复现）——引用任何本库数字必须带 meta_sources 来源与等级' },
        { id: 'analytics-legacy', root: 'projects/银行分析数据库', format: 'sqlite', description: '存量库：bank_industry.db（bank_overview/banks/nim_peer/retail_performance）、jsbank_internal.db（jsbank_new_lending_rate/jsbank_target_gap/retail_loan_snapshot/jsbank_product_income/peer_banks）；另有民生/浦发/邮储 2026 半年报 PDF 原件同目录' },
    ];
    const digest = createHash('sha256')
        .update(`bank:analytics:${collections.map(c => c.id).join(',')}:${BANK_PACK_VERSION}`)
        .digest('hex');
    return {
        id: 'bank.analytics',
        version: packVersion,
        schemaVersion: SCHEMA_VERSION,
        domain: 'banking.jiangsu',
        boundary: '银行分析数据库（SQLite，99wiki/projects/银行分析数据库/）：同业周度、行内零售、分行对标、行业年度、宏观与政策。引用任何数字必须带 meta_sources 来源与可信度等级（年报/行研=high、微信=medium）；内部数据脱敏后使用，受 pii-redaction 硬门约束。方法包「本行重算」入口：阈值验算→jsbank_pricing_monitor_monthly，双基准对标→peer_15banks_weekly，归责→branch_*，损益对标→industry_*。',
        ontology: {
            entities: [
                { id: 'snapshot', description: '周度/月度数据快照（带 snapshot_date）' },
                { id: 'bank', description: '银行维度（dim_banks，is_us 标记江苏银行）' },
                { id: 'branch', description: '分行维度（dim_branches）' },
                { id: 'product', description: '产品维度（dim_products）' },
                { id: 'source', description: '数据来源与可信度（meta_sources）' },
            ],
            relations: [
                { id: 'snapshot-from-source', from: 'snapshot', to: 'source', description: '快照来自来源（batch/source 列）' },
                { id: 'snapshot-of-bank', from: 'snapshot', to: 'bank', description: '快照属于银行' },
            ],
        },
        collections: collections.map(collection => ({ ...collection })),
        snapshot: {
            id: 'bank-analytics-2026-09-16',
            takenAt: BANK_BASELINE_DATE,
            digest,
            recordCount: 0, // 构建期纯函数不枚举；运行时按表统计。
        },
        retrievalProfiles: [
            { id: 'by-table', method: 'keyword' },
            { id: 'by-source', method: 'keyword', config: { scope: 'meta_sources' } },
        ],
        policies: { citation: 'required', freshness: 'daily', access: 'readonly' },
    };
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
    { id: 'credit-card-methodology', root: 'projects/信用卡方法论提取', format: 'mixed', description: '信用卡方法论提取沉淀（81 条结构化记录 methodology-records.json / 总报告 / 待验证结果 / 落地台账模板）；条目「本行重算」数据入口见 bank.analytics 各 collection' },
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
/**
 * Verbatim-quote gate（方法论提取实测沉淀，2026-09 信用卡方法论提取团队）：
 * 交付件中的「」直引句必须可逐字回溯到材料原文（text/ 对应页/幻灯片单元），
 * 允许空白/换行差异，不允许改词、加粗或"顺手改通顺"；含省略号者逐段匹配。
 * 原件 OCR 讹字照录并标注"原文如此"，不得字形纠错后比对。
 */
export function quoteVerbatimGate(): QualityGateSpec {
  return {
    id: 'quote-verbatim',
    kind: 'deterministic',
    appliesTo: ['deliverable'],
    severity: 'hard',
    phase: 'data',
    config: {
      quoteMarkers: ['「」'],
      rules: [
        '直引句须逐字匹配材料原文对应页/幻灯片单元',
        '允许空白与换行差异，不允许改词',
        '省略号切段逐段匹配',
        'OCR 讹字照录并标注「原文如此」，不得纠错后比对',
      ],
    },
  }
}
/**
 * Historical-timestamp gate（同上沉淀）：历史样本（往期汇报/外部研究/平台
 * 经营分析）中的数字必须带原时点标注；缺失时点或把历史数据当现行事实引用
 * 即 block。日期不明的材料必须显式标注"推断时点 + 依据"。
 */
export function historicalTimestampGate(): QualityGateSpec {
  return {
    id: 'historical-timestamp',
    kind: 'deterministic',
    appliesTo: ['deliverable'],
    severity: 'hard',
    phase: 'data',
    config: {
      rules: [
        '历史样本数字必须保留原时点',
        '不得把历史数据当现行事实引用',
        '日期不明材料须标注「推断时点+依据」',
        '四类来源（行方/券商/历史分享/平台经营分析）不得混层归因',
      ],
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
 * 阈值测算协议 method pack（方法论沉淀：早偿临界点/盈亏平衡门槛测算法，
 * 2026-09 信用卡方法论提取团队 from B07/天风 B05）。
 */
/**
 * 客群分层工具箱 method pack（方法论沉淀：阿蒙森客群分层体系 + 行方标签
 * 投放打法，2026-09 信用卡方法论提取团队 from A01-01/A01-02/A09-01/A16-01/
 * A17-01/A03-01/B-06-06）。分层→标签→投放→定价全链。
 */
function bankCustomerTieringMethodPack(packVersion: string): MethodPack {
  return {
    id: 'bank.method.customer-tiering',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: '客群分层工具箱（分层→标签→投放→定价全链）',
    mediaType: 'agent-instructions',
    load: 'progressive',
    body: [
      '客群工程全链标准推进：',
      '1. 分层骨架：客户生命周期五阶段×经营层级双轴（获客→成长→成熟→睡眠→流失，每阶段内按价值分八层）；切分点用 vintage 曲线定（按放款/开卡月份分组看走势的拐点），不拍脑袋。',
      '2. 分层维度年度迭代：随业务阶段换维度，一次只换一个并保留对照期。',
      '3. 分层手段按数据丰度选：聚类要素法（切分点+交叉）→ 类决策树单因素 → TGI 定阵地（TGI 只反映相对浓度不含绝对规模，且不可跨口径拼接）。',
      '4. 策略分层：意愿×营销响应四象限分资源；睡眠户用睡眠倾向分+价格敏感度双模型替代固定阈值（模型阈值须本行重训，不引历史数值）。',
      '5. 标签与投放：分期客户按生命周期+价值+行为+风险做四层标签，投放文案/权益/定价按标签组装，禁止全量同文案。',
      '6. 边界：「渗透率最高的客群」≠「实际获批客群结构」（受批核策略筛选）；平台场景份额不等于客户价值，八层切分点必须用本行行为数据重算。',
      '输出结构：分层骨架与切分点 → 各层策略 → 标签字段与投放映射 → 定价联动 → 本行重算清单。',
    ].join('\n'),
  }
}
/**
 * 六条成品工作链 method pack（方法论沉淀：三层方法论的可组装配方，2026-09
 * 信用卡方法论提取团队 6.1 节）。每条链=目的+组件条目+前置条件，供任务
 * 启动时按目的整链取用，不逐条重找。
 */
function bankWorkChainsMethodPack(packVersion: string): MethodPack {
  return {
    id: 'bank.method.work-chains',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: '六条成品工作链（三层方法论的组装配方）',
    mediaType: 'agent-instructions',
    load: 'progressive',
    body: [
      '三层方法论（分析/打法/外部视角）单独看都成立，按目的组装成六条成品工作链：',
      '链1 年度经营计划模板（指标树+杠杆排序+正负分同表）＝ 杠杆量化：单位提升×覆盖面 ＋ 分期核心指标树（过程指标优先）＋ 追回率挂绩效负分法。',
      '链2 活动与定价测试标准流程（立项即填五栏：目的/指标/对照组/增量口径/迭代结论）＝ 平行世界对照 ＋ 活动定位定指标 ＋ 差异化定价 A/B 实测 ＋ 分期实际年化复算。',
      '链3 口径对照表（任何比较先过表）＝ 收入结构解构+科目还原 ＋ 人均指标分母修正 ＋ 分环节漏斗的归属口径。',
      '链4 阈值与定价验算规程（先算后定）＝ 分期实际年化现金流测算 ＋ 早偿率临界点测算法 ＋ 返佣封顶与差额底线。',
      '链5 客群工程全链（分层→标签→投放→定价）＝ 生命周期五阶段八层 ＋ 意愿×响应四象限 ＋ 分期客户四层标签精准触达。',
      '链6 线上转化+消保一体化（转化与消保同批下发）＝ 曝光-转化结构定节点（阈值须本行重测）＋ 前十大来电压降/消保前置 ＋ 未激活客户不付 CPS。',
      '使用规则：接到任务先辨认属于哪条链，整链取用再按需裁剪；跨链共用的条目（如实际年化测算）以链3/链4 的口径为准；每条链落地前检查其组件的「适用条件与边界」。',
    ].join('\n'),
  }
}
/**
 * 渠道与考核治理协议 method pack（方法论沉淀：返佣/追回/清退/考核机制设计，
 * 2026-09 信用卡方法论提取团队 from B-01-01/02/03、B-07-01/02、B-02-01/02/03）。
 */
function bankIncentiveGovernanceMethodPack(packVersion: string): MethodPack {
  return {
    id: 'bank.method.incentive-governance',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: '渠道与考核治理协议（封顶底线双下·正负分同表·清退配替换）',
    mediaType: 'agent-instructions',
    load: 'progressive',
    body: [
      '渠道返佣与队伍考核的机制设计标准推进：',
      '1. 封顶与底线双下：返佣合计设上限 + 对客费率与返佣差额设下限，两条必须同批下发——只压返佣不设底线，渠道会用降价绕开，规模与利润两头落空。',
      '2. 摊销与显性化：佣金当期计提、按期数等额摊销；提前还款当期一次性摊销把损失显性化，配套追回条款写进协议并系统留痕。',
      '3. 考核正负分同表：追回/违规挂绩效负分（个人与机构双挂、当期与半年各计一半），但必须与正分激励同表下发——只挂负分不给收益，队伍会整体退出该品种（已有前车之鉴）。',
      '4. 清退分级配替换：阈值分级（如 ≤5% 续作 / 5–10% 换签 / >10% 清退），清退必须配可替换商户清单，阈值按品种重估。',
      '5. 真实抵触先排：队伍不愿干通常不是能力问题而是收益问题（直销"已基本放弃营销"是前鉴）；机制下发前先评估执行意愿，意愿问题用收益机制解，能力问题才用培训解。',
      '6. 附属工具：催收沿链条设入催/逾期/不良三段降损目标（各配目标+手段+测算，配再逾期监测与回收上限）；驻场诊断式攻坚（不打报告改流程、逐环节找堵点、回款数据收口）；费用三分类（一次性可收回/刚性减压调优准入/运营细抠）。',
      '输出结构：机制条款（可填数值+触发动作）→ 考核正负分表 → 协议换签与系统留痕要求 → 执行意愿评估 → 分级管控台账设计。',
    ].join('\n'),
  }
}
/**
 * 外部合作尽调与自主可控评估 method pack（方法论沉淀：B-08-24 三路径决策 +
 * B-08-25 尽调七条 + bank-09 自主可控底线，2026-09 信用卡方法论提取团队）。
 */
function bankPartnershipDiligenceMethodPack(packVersion: string): MethodPack {
  return {
    id: 'bank.method.partnership-diligence',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: '外部合作尽调与自主可控评估（三路径×七条清单×规则留行内）',
    mediaType: 'agent-instructions',
    load: 'progressive',
    body: [
      '平台/外部合作评审标准推进：',
      '1. 路径先定：Build（自建）/ Partnership（合作）/ Buy（采购）三路径，按优点/缺点/适用条件逐项对照后再选，不先入为主。',
      '2. 尽调七条当谈判用尺：反过来逐项要求对方给出可验证投入（团队/技术/流量/数据/资金/风控/运营），口头赋能不算数。',
      '3. 自主可控底线：可让渡流量与场景，不让渡客户、数据、账户、定价规则与账期节奏——规则留行内写进合作管理办法。',
      '4. 立场定性：合作方材料按商务材料对待（末页诉求、团队背书、目标行数据均自证立场）；其对目标客户劣势的描述可反向采信，对其自身优势的描述须第三方验证。',
      '5. 赋能 vs 架空判定：判断合作方是补我的能力还是替代我的客户关系——客户触点、数据沉淀、定价权是否仍在本行手中。',
      '输出结构：三路径对照 → 七条尽调结果 → 自主可控检查项（逐项是/否）→ 立场与证据等级标注 → 合作边界条款建议。',
    ].join('\n'),
  }
}
/**
 * 产品线三层损益框架 method pack（方法论沉淀：B-08-12 获客/交易/资产三层
 * 损益，通用 P&L 归因工具，2026-09 信用卡方法论提取团队）。
 */
function bankTieredPnlMethodPack(packVersion: string): MethodPack {
  return {
    id: 'bank.method.tiered-pnl',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: '产品线三层损益框架（获客层·交易层·资产层分别算账）',
    mediaType: 'agent-instructions',
    load: 'progressive',
    body: [
      '判断任一产品线能否赚钱、亏损停在谁头上，把损益拆三层分别算账：',
      '1. 获客层：发卡/开户成本 vs 首年贡献，通常亏损——亏损是否可接受取决于后两层。',
      '2. 交易层：支付/交易带来的中收与活客价值，通常保本或微利——核心是活跃度与频次。',
      '3. 资产层：贷款/分期利息收入，才是盈利所在——核心是定价（实际年化，见 threshold-calc）与风险成本。',
      '4. 判断规则：任一层的补贴必须问「资产层能否覆盖获客层」；三层俱全是产品线最完整形态，缺层的替代盈利点要显式说明。',
      '5. 口径纪律：三层收入不得混计（手续费还原为利息后再算资产层，见 caliber-restore）；历史样本参数须本行重算。',
      '输出结构：三层损益表（各层收入/成本/净额）→ 补贴流向与覆盖判断 → 缺层风险 → 本行重算清单。',
    ].join('\n'),
  }
}
/**
 * 经营归因工具箱 method pack（方法论沉淀：A10-01 杠杆量化 + A04-01 端到端
 * 漏斗归责 + B-02-01 三段拆解，年度经营计划的定量底座，2026-09 信用卡方法论
 * 提取团队）。
 */
function bankAttributionMethodPack(packVersion: string): MethodPack {
  return {
    id: 'bank.method.attribution',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: '经营归因工具箱（杠杆量化·端到端漏斗·三段拆解）',
    mediaType: 'agent-instructions',
    load: 'progressive',
    body: [
      '年度经营计划与目标拆解的定量标准推进：',
      '1. 杠杆量化排序：每个经营动作 = 单位净提升 × 覆盖面，对核心指标做因素分解后按杠杆大小排序——只用于排序与资源分配，不作单独加压依据。',
      '2. 端到端漏斗归责：前端环节指标有跷跷板效应（此消彼长）时改用端到端指标，按发卡/放款账龄拆段归责到团队，防局部优化伤害全局。',
      '3. 三段拆解：沿业务链条设分段目标，每段配「目标+手段+测算」三件套；放宽类手段必须配对冲监测（如协商还款配再逾期监测与回收上限）。',
      '4. 指标树：结果指标（余额/收入）与过程指标（成交额/渗透率×户均）一起考核并加留存修正——只考快变量会掩盖提前还款与留存恶化。',
      '输出结构：指标分解树 → 动作杠杆排序表 → 归责切分 → 分段目标与对冲监测 → 正负分同表的考核建议。',
    ].join('\n'),
  }
}
function bankThresholdCalcMethodPack(packVersion: string): MethodPack {
  return {
    id: 'bank.method.threshold-calc',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: '银行经营阈值测算协议（临界点→安全边际→协议化）',
    mediaType: 'agent-instructions',
    load: 'progressive',
    body: [
      '阈值类经营参数（早偿率红线、返佣上限、盈亏平衡量等）的标准测算与落地：',
      '1. 先定量测算临界点：对收益模型求正负分界（如放款后一年早偿率在临界笔数时行内净利润转负；分期实际年化用现金流法 pv/pmt/期数/费率换算，不用月费率×12）。',
      '2. 压一档留安全边际：在临界点基础上向安全侧收一档（如临界 11–12 笔 → 红线定 6% 或更低），边际大小与数据置信度成反比。',
      '3. 落成协议可填数：把红线写成协议/考核表里可直接填的数值与触发动作（如 >5% 续作 / 5–10% 换签 / >10% 清退），并绑定监测指标与责任人。',
      '4. 边界声明：材料中的具体阈值是历史样本参数，换机构/换客群/换费率环境必须用本行数据重算，不得照搬数值。',
      '输出结构：临界点测算过程 → 安全边际取值 → 协议化条款（可填数值+触发动作）→ 参数适用边界与本行重算要求。',
    ].join('\n'),
  }
}
/**
 * 口径还原与对标协议 method pack（方法论沉淀：天风口径还原三步法 +
 * 证据独立性规则，2026-09 信用卡方法论提取团队 from B05/B08）。
 */
function bankCaliberRestoreMethodPack(packVersion: string): MethodPack {
  return {
    id: 'bank.method.caliber-restore',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: '口径还原与对标协议（先还原、再对标、后归因）',
    mediaType: 'agent-instructions',
    load: 'progressive',
    body: [
      '跨机构/跨时期比较前的口径处理标准推进：',
      '1. 科目→实质映射：逐项列出报表科目对应的业务实质（如分期手续费实质是利息收入、渠道佣金全额当期抵扣不摊销）。',
      '2. 口径还原：按实质重算指标（还原后"实际"利息收入占比约七成即典型结果），人均类指标检查分母口径（全国人口 vs 目标客群）。',
      '3. 才允许对标：还原后同一口径再比，不可比时只列差异不做伪精确排名。',
      '4. 证据独立性：核对多篇材料的判断是否同源同法（如"对标美国还有N倍空间"）；同源结论不得叠加为多来源印证。',
      '5. 立场标注：引用外部材料先定性立场（卖方研报含评级荐股、平台商务材料含合作诉求），其判断降级为方向提示；但商务材料对自身目标客户劣势的描述反而更接近事实，可反向采信。',
      '输出结构：科目映射表 → 还原后指标 → 可比结论与不可比项 → 同源/独立性核查 → 立场标注。',
    ].join('\n'),
  }
}
/**
 * 方法论七字段记录输出模板（方法论提取任务沉淀，2026-09 信用卡方法论提取
 * 团队；条目级产出协议，与 HANDOFF 产出要求一致）。
 */
function bankMethodRecordOutputTemplate(packVersion: string): OutputTemplate {
  const sections = ['编号', '方法名', '出处', '原文关键句', '方法拆解', '适用条件与边界', '可迁移性初判']
  return {
    id: 'bank.output.method-record',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    media: ['markdown'],
    sections: sections.map((section) => ({
      id: section,
      required: true,
      requires: section === '出处' || section === '原文关键句' ? ['source'] : [],
    })),
    renderModes: {
      discussion: { anonymize: true },
      final: { anonymize: false },
    },
  }
}
/**
 * 口径对照表输出模板（方法论沉淀：工作链 3「任何比较先过表」的固化，
 * 2026-09 信用卡方法论提取团队；同业/跨期比较类交付的附录标准）。
 */
function bankCaliberTableOutputTemplate(packVersion: string): OutputTemplate {
  const sections = ['指标名', '会计科目', '经济实质', '本行口径', '外部口径', '分母口径', '差异说明', '可比结论与不可比项']
  return {
    id: 'bank.output.caliber-table',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    media: ['markdown'],
    sections: sections.map((section) => ({
      id: section,
      required: true,
      requires: ['source', 'caliber'],
    })),
    renderModes: {
      discussion: { anonymize: true },
      final: { anonymize: false },
    },
  }
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
  const bankQuality = qualityPolicy(packVersion, BANK_QUALITY_POLICY_ID, [
    piiRedactionGate(),
    quoteVerbatimGate(),
    historicalTimestampGate(),
  ])
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
    outputTemplates: [outputTemplate, bankMethodRecordOutputTemplate(packVersion), bankCaliberTableOutputTemplate(packVersion)],
    qualityPolicies: [bankQuality],
    scenarios: BANK_SCENARIOS.map(scenario => bankScenarioV2(scenario, packVersion)),
    toolProviders: [], // provider runtime is Phase 2 — nothing asserted yet
    knowledgeProviders: bankKnowledgeProviders(packVersion),
    domainKnowledge: [
      bankDomainKnowledgeManifest(packVersion),
      bank99wikiKnowledgeManifest(packVersion),
      bankAnalyticsKnowledgeManifest(packVersion),
      bankBrandKnowledgeManifest(packVersion),
    ],
    methodPacks: [
      bankRetailMethodPack(packVersion),
      frameworkMethodPack(frameworkB, packVersion, 'bank'),
      bankThresholdCalcMethodPack(packVersion),
      bankCaliberRestoreMethodPack(packVersion),
      bankCustomerTieringMethodPack(packVersion),
      bankWorkChainsMethodPack(packVersion),
      bankIncentiveGovernanceMethodPack(packVersion),
      bankPartnershipDiligenceMethodPack(packVersion),
      bankTieredPnlMethodPack(packVersion),
      bankAttributionMethodPack(packVersion),
    ],
    skillPackages: BANK_SKILL_PACKAGES.map(bankSkillPackageManifest),
  }
}

/** Type-only re-export for consumers building overlay packs. */
export type { TeamTemplate, OutputTemplate }
