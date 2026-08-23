/**
 * Phase 1 Zhijian V2 Domain Pack builder (`zhijian-realestate`).
 *
 * Projects the 32 in-repo Zhijian expert metas
 * (`src/zhijian/data/experts.generated.ts`) plus the in-repo routing and
 * framework tables into a validator-clean {@link DomainPackV2}. The generated
 * metas are the **sole in-repo data input**: every V2 asset (ExpertV2,
 * OutputTemplate, TeamTemplate, ScenarioV2, QualityPolicy, MethodPack,
 * KnowledgeProvider, DomainKnowledgeManifest) is derived deterministically
 * from them, and nothing here changes the V1 runtime — registry / persona /
 * tools keep consuming the same generated metas unchanged.
 *
 * Non-fabrication rules (per NEXT-GENERATION-ARCHITECTURE.md §7.1/§7.2 and
 * the `src/v2` conventions):
 *
 * - **capabilities** derive only from roster-asserted fields (`field`,
 *   `secondaryField`, `tags`) and always carry `evidenceRefs` pointing at the
 *   roster; the universal `zhijian.review` claim comes from roster membership
 *   itself. No capability is invented.
 * - **proficiency** is always the unassessed floor `1` — the metas assert
 *   membership, not level; calibration arrives later with
 *   `zhijian-expert-memory` monthly deltas.
 * - **coverage** differentiates assertion strength: primary field = `high`,
 *   roster tags / universal review = `medium`, secondary field = `low`.
 * - **display** uses the already-anonymized `personaName`/`initials` — never
 *   the `'legacy'` placeholder of the generic V1 adapter.
 * - **compliance** is set only where the data asserts it: `deceased` for
 *   bk-022 (顾云昌, 固化规则), `internalOnly` for bk-031 (陶琦, 路由规则内测
 *   对比项), `citationPolicy` for the experts whose caliber affiliation is
 *   stated in the routing constraints (丁祖昱=克而瑞/普睿, 黄瑜=中指,
 *   陶琦=贝壳/NIFD).
 * - **stance/summary** have no ExpertV2 slot; they stay at routing level
 *   (`candidateHints`, stance pairing in later routing overlays) and inside
 *   `display.publicLabel` (personaName embeds the stance). Documented gap.
 * - **team templates** model the V1 review shape "parallel reviews → fusion
 *   render" with two canonical review tasks (t1/t2) + fusion (t3); the Phase
 *   3 compiler expands review tasks per selected expert (1..5, slot
 *   cardinality + `parameters.selectedExpertIds`).
 * - The domain-knowledge snapshot digest is computed over the metas at build
 *   time, so the pack is self-describing and reproducible.
 *
 * @module dsh-expert-library/v2/zhijian-pack
 */

import { createHash } from 'node:crypto'
import { ZHIJIAN_EXPERTS } from '../zhijian/data/experts.generated.ts'
import { FRAMEWORKS, GLOBAL_OUTPUT_RULES } from '../zhijian/frameworks.ts'
import { ROUTE_SCENARIOS } from '../zhijian/routing.ts'
import type {
  ZhijianExpertMeta,
  ZhijianField,
  ZhijianFrameworkId,
  ZhijianFrameworkSpec,
  ZhijianRouteScenario,
} from '../zhijian/types.ts'
import {
  SCHEMA_VERSION,
  type CapabilityClaim,
  type ComplianceInfo,
  type DomainKnowledgeManifest,
  type DomainPackV2,
  type ExpertV2,
  type KnowledgeProviderManifest,
  type MentalModel,
  type MethodPack,
  type ModelPolicy,
  type OutputTemplate,
  type PackMeta,
  type QualityPolicy,
  type ScenarioV2,
  type SkillPackageManifest,
  type TeamTemplate,
} from './types.ts'

/** Pack id (SafeId). */
export const ZHIJIAN_PACK_ID = 'zhijian-realestate'

/** Baseline pack version (semver). Per-expert versions arrive with monthly deltas. */
export const ZHIJIAN_PACK_VERSION = '1.1.0'

/**
 * Snapshot id of the current profile baseline. 1.1.0 = the 2026-08-20/21
 * unpacked revision (adds 陈杰 BK-034 to the original 2026-08-19 zip
 * baseline; the pack's SOURCE-MANIFEST records both baselines).
 */
export const ZHIJIAN_PACK_SNAPSHOT = 'zhijian-v1-2026-08-21'

/** Immutable baseline timestamp of the current source skill package revision. */
export const ZHIJIAN_BASELINE_DATE = '2026-08-21T00:00:00Z'

/** The universal reviewer capability every roster expert claims. */
export const REVIEW_CAPABILITY = 'zhijian.review'

/* ------------------------------------------------------------------ *
 *  Bundled local skills inventory (skillPackages)
 *
 *  The pack is the inventory of record for the plugin's bundled local
 *  skills (`knowledge/skills/` next to `lib/`): finesse-ui, the 8-skill GSAP
 *  suite and video-shotcraft. These entities are LOCAL availability
 *  declarations — id/name/version/source-root convention, never embedded
 *  content (the on-disk SKILL.md tree is the content of record, re-verified
 *  by `loadSkillPackageFromDir` when a package is actually installed).
 * ------------------------------------------------------------------ */

/** One declared bundled skill package (availability declaration). */
export interface ZhijianSkillPackageDecl {
  /** Skill id — the folder name under the plugin's `knowledge/skills/`. */
  readonly id: string
  /** Display name (SKILL.md frontmatter `name:`, known for the shipped set). */
  readonly name: string
  /**
   * Version: the skill's own metadata version when known (finesse-ui
   * frontmatter declares 0.20.0); otherwise the local baseline
   * {@link LOCAL_SKILL_BASELINE_VERSION} — the shipped SKILL.md files carry
   * no version of their own, and no upstream release is asserted.
   */
  readonly version: string
  /** SPDX license from the skill's frontmatter when declared (else internalOnly). */
  readonly license?: string
}

/** Version convention for bundled skills whose own metadata declares none. */
export const LOCAL_SKILL_BASELINE_VERSION = '0.0.0-local'

/** The pack's bundled-skill inventory, in deterministic order. */
export const ZHIJIAN_SKILL_PACKAGES: readonly ZhijianSkillPackageDecl[] = [
  { id: 'finesse-ui', name: 'finesse-ui', version: '0.20.0', license: 'MIT' },
  { id: 'gsap-core', name: 'gsap-core', version: LOCAL_SKILL_BASELINE_VERSION, license: 'MIT' },
  { id: 'gsap-frameworks', name: 'gsap-frameworks', version: LOCAL_SKILL_BASELINE_VERSION, license: 'MIT' },
  { id: 'gsap-performance', name: 'gsap-performance', version: LOCAL_SKILL_BASELINE_VERSION, license: 'MIT' },
  { id: 'gsap-plugins', name: 'gsap-plugins', version: LOCAL_SKILL_BASELINE_VERSION, license: 'MIT' },
  { id: 'gsap-react', name: 'gsap-react', version: LOCAL_SKILL_BASELINE_VERSION, license: 'MIT' },
  { id: 'gsap-scrolltrigger', name: 'gsap-scrolltrigger', version: LOCAL_SKILL_BASELINE_VERSION, license: 'MIT' },
  { id: 'gsap-timeline', name: 'gsap-timeline', version: LOCAL_SKILL_BASELINE_VERSION, license: 'MIT' },
  { id: 'gsap-utils', name: 'gsap-utils', version: LOCAL_SKILL_BASELINE_VERSION, license: 'MIT' },
  // video-shotcraft declares no license in its frontmatter ⇒ internalOnly.
  { id: 'video-shotcraft', name: 'video-shotcraft', version: LOCAL_SKILL_BASELINE_VERSION },
]

/**
 * Deterministic declaration digest: sha256 over the declaration identity
 * (id/version/root). These entities declare availability only — the SKILL.md
 * tree is never embedded, so the digest pins the declaration, keeping the
 * builder pure (no I/O) and deterministic. A real on-disk package is
 * re-verified by `loadSkillPackageFromDir` (content-tree digest) when loaded.
 */
function skillPackageDigest(decl: ZhijianSkillPackageDecl): string {
  return createHash('sha256')
    .update(`zhijian:skill-package:${decl.id}:${decl.version}:${decl.id}`)
    .digest('hex')
}

/** One declared bundled skill → {@link SkillPackageManifest} (local-only). */
function skillPackageManifest(decl: ZhijianSkillPackageDecl): SkillPackageManifest {
  return {
    id: decl.id,
    name: decl.name,
    version: decl.version,
    schemaVersion: SCHEMA_VERSION,
    source: {
      kind: 'builtin',
      // Root convention: relative to the plugin's bundled knowledge/skills/.
      root: decl.id,
      digest: skillPackageDigest(decl),
      ...(decl.license === undefined ? {} : { license: decl.license }),
    },
    // Availability declarations contribute nothing to the pack's own entity
    // sets (the skills' real contributions live in their SKILL.md bodies).
    contributions: {},
    permissions: {
      execScripts: [],
      ...(decl.license === undefined ? { internalOnly: true } : {}),
    },
  }
}

/**
 * Read-only data capabilities a zhijian review task may invoke through
 * `expert_provider_call` (the plan-level runtime gate enforces this union
 * per member task). Wind market/financial reads + zyt indicators + beike
 * search reads — no write capabilities are ever stamped here.
 */
export const ZHIJIAN_DATA_CAPABILITIES: readonly string[] = [
  // Wind（行情/宏观/公告检索，全部只读）
  'financial.stock.snapshot',
  'financial.stock.quote',
  'financial.stock.kline',
  'financial.stock.screen',
  'financial.fund.snapshot',
  'financial.index.snapshot',
  'financial.index.quote',
  'financial.macro.query',
  'financial.docs.search',
  // zyt 政研通（指标/对比/快照）
  'realestate.indicators.catalog',
  'realestate.indicators.timeseries',
  'realestate.indicators.batch',
  'realestate.city.compare',
  'realestate.market-snapshot',
  // 贝壳（房源/小区/板块/租赁/政策检索，全部只读）
  'realestate.listing.search',
  'realestate.newhouse.search',
  'realestate.resblock.profile',
  'realestate.plate.search',
  'realestate.rent.search',
  'realestate.policy.search',
]

/** Roster primary fields → pack domain vocabulary (zhijian fields are data). */
export const FIELD_DOMAINS: Readonly<Record<ZhijianField, string>> = {
  '宏观经济': 'realestate.macro',
  '政策制度': 'realestate.policy',
  '行业研究': 'realestate.research',
  '城市发展': 'realestate.city',
  '居住服务': 'realestate.services',
  // BANK 命名空间（整合设计：同一投影函数服务两个命名空间）
  '零售金融': 'bank.retail',
  '银行经营': 'bank.operations',
  // pipeline 命名空间（E08 房地产经营 / E01 宏观 / E13 江苏银行 / 资产配置）
  '房地产': 'realestate.operations',
  '资产配置': 'finance.allocation',
  '江苏银行高层': 'bank.strategy',
}

/** Roster capability tags → review capability vocabulary (专家总表.md tags). */
export const TAG_CAPABILITIES: Readonly<Record<string, string>> = {
  '数据': 'review.data',
  '研判': 'review.judgment',
  '解读': 'review.interpretation',
  '理论': 'review.theory',
  '实操': 'review.practice',
}

/** Deceased experts (固化规则: 只可引用历史观点). */
const DECEASED_IDS: ReadonlySet<string> = new Set(['bk-022'])

/** Internal-only experts (路由规则.md §五: 陶琦 bk-031 为内测对比项, 政研通产品不引用). */
const INTERNAL_ONLY_IDS: ReadonlySet<string> = new Set(['bk-031'])

/** Known caliber affiliations (routing.ts zhijian-monthly constraints). */
const CITATION_POLICIES: Readonly<Record<string, string>> = {
  'bk-024': '克而瑞/普睿监测口径',
  'bk-025': '中指院口径',
  'bk-031': '贝壳/NIFD 口径',
}

/** Scenario id → controlled intent vocabulary (pack-defined, Phase 1b extends). */
const SCENARIO_INTENTS: Readonly<Record<string, readonly string[]>> = {
  'zhijian-monthly': ['monthly-review'],
  'zhijian-policy': ['policy-review'],
  'zhijian-macro': ['macro-outlook'],
  'zhijian-finance': ['financial-risk'],
  'zhijian-city': ['city-opportunity'],
  'zhijian-industry': ['industry-operations'],
  'zhijian-services': ['service-business'],
  'zhijian-institution': ['institution-design'],
}

/** Quality policy id shared by every scenario/team template of the pack. */
const QUALITY_POLICY_ID = 'zhijian.quality'

/** Map a roster field name to the pack domain vocabulary (fallback never fabricates a domain). */
function fieldDomain(field: ZhijianField | string): string {
  return FIELD_DOMAINS[field as ZhijianField] ?? 'realestate.general'
}

/**
 * One roster-asserted capability claim. Proficiency is always the unassessed
 * floor 1; coverage reflects assertion strength only.
 */
function rosterClaim(capability: string, coverage: CapabilityClaim['coverage']): CapabilityClaim {
  return {
    capability,
    proficiency: 1,
    coverage,
    evidenceRefs: ['zhijian:roster'],
  }
}

/** Compliance for one expert: only fields the data asserts. */
function complianceFor(meta: ZhijianExpertMeta): ComplianceInfo {
  return {
    ...(meta.deceased === true || DECEASED_IDS.has(meta.id) ? { deceased: true } : {}),
    ...(INTERNAL_ONLY_IDS.has(meta.id) ? { internalOnly: true } : {}),
    ...(CITATION_POLICIES[meta.id] !== undefined ? { citationPolicy: CITATION_POLICIES[meta.id] } : {}),
  }
}

/**
 * Copy a JSON-safe detail object into fresh plain objects/arrays so the pack
 * never shares the metas' readonly arrays (conservative ownership, no change
 * of shape or values).
 */
function copyDetail<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => copyDetail(item)) as unknown as T
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = copyDetail(item)
    return out as unknown as T
  }
  return value
}

/**
 * Rich mental models for ExpertV2.persona: prefer the Profile JSON's
 * `persona.cognition.mentalModels` (name/summary/evidence/applicationContext/
 * failureCondition) when present; fall back to the name-only
 * `method.frameworks` list with empty summaries (schema requires `summary`).
 * Never invents summaries the source did not assert.
 */
function richMentalModels(meta: ZhijianExpertMeta): MentalModel[] {
  const rich = meta.personaDetail?.cognition?.mentalModels
  if (rich !== undefined && rich.length > 0) {
    return rich.map(model => ({
      name: model.name,
      summary: model.summary ?? '',
      ...(model.evidence !== undefined ? { evidence: [...model.evidence] } : {}),
      ...(model.applicationContext !== undefined ? { applicationContext: model.applicationContext } : {}),
      ...(model.failureCondition !== undefined ? { failureCondition: model.failureCondition } : {}),
    }))
  }
  return meta.mentalModels.map(name => ({ name, summary: '' }))
}

/**
 * Project one generated Zhijian meta into an {@link ExpertV2}.
 * Identity/anonymization/compliance come from the meta itself; capabilities
 * derive from roster-asserted field + tags; nothing is fabricated.
 */
export function zhijianMetaToExpertV2(
  meta: ZhijianExpertMeta,
  options: { packVersion?: string; modelPolicy?: ModelPolicy } = {},
): ExpertV2 {
  const version = options.packVersion ?? ZHIJIAN_PACK_VERSION
  const claims: CapabilityClaim[] = [
    rosterClaim(REVIEW_CAPABILITY, 'medium'),
    rosterClaim(`${fieldDomain(meta.field)}.review`, 'high'),
  ]
  if (meta.secondaryField !== undefined) {
    claims.push(rosterClaim(`${fieldDomain(meta.secondaryField)}.review`, 'low'))
  }
  for (const tag of meta.tags) {
    const capability = TAG_CAPABILITIES[tag]
    if (capability !== undefined) claims.push(rosterClaim(capability, 'medium'))
  }
  return {
    id: meta.id,
    version,
    schemaVersion: SCHEMA_VERSION,
    display: {
      internalName: meta.name,
      publicLabel: meta.personaName,
      initials: meta.initials,
    },
    domains: [
      fieldDomain(meta.field),
      ...(meta.secondaryField !== undefined ? [fieldDomain(meta.secondaryField)] : []),
    ],
    capabilities: claims,
    persona: {
      style: [...meta.style],
      ...(meta.personaDetail?.tone !== undefined ? { tone: meta.personaDetail.tone } : {}),
      ...(meta.personaDetail?.bias !== undefined ? { bias: [...meta.personaDetail.bias] } : {}),
      ...(meta.personaDetail?.values !== undefined ? { values: copyDetail(meta.personaDetail.values) } : {}),
      ...(meta.personaDetail?.taste !== undefined ? { taste: copyDetail(meta.personaDetail.taste) } : {}),
      ...(meta.personaDetail?.voice !== undefined ? { voice: copyDetail(meta.personaDetail.voice) } : {}),
      // Rich mental models from persona.cognition.mentalModels (1.1.0); the
      // metas previously carried name-only method.frameworks entries.
      mentalModels: richMentalModels(meta),
      ...(meta.personaDetail?.blindSpots !== undefined ? { blindSpots: copyDetail(meta.personaDetail.blindSpots) } : {}),
      signaturePhrases: [...meta.signaturePhrases],
      antiPatterns: [...meta.antiPatterns],
    },
    methods: [{ id: 'zhijian.method.review-protocol' }],
    knowledgeBindings: [
      { providerId: 'zhijian-expert-memory', scope: `experts/${meta.id}` },
      { providerId: 'local-knowledge', scope: `experts/${meta.id}` },
    ],
    toolAffinities: [], // unknown in the metas — never guessed
    // 1.1.0 rich projection: only source-asserted detail is carried verbatim
    // (absent stays absent — no fabrication).
    ...(meta.methodDetail !== undefined ? { methodProfile: copyDetail(meta.methodDetail) } : {}),
    ...(meta.emm !== undefined ? { emm: copyDetail(meta.emm) } : {}),
    ...(meta.constraints !== undefined ? { constraints: copyDetail(meta.constraints) } : {}),
    ...(meta.outputSchema !== undefined ? { outputSchema: copyDetail(meta.outputSchema) } : {}),
    ...(options.modelPolicy === undefined ? {} : { modelPolicy: options.modelPolicy }),
    compliance: complianceFor(meta),
  }
}

/** Parse a framework word-limit string like "约 500 字 ±10%（…）" into numeric bounds. */
function wordLimits(wordLimit: string | undefined): { minWords?: number; maxWords?: number } {
  if (wordLimit === undefined) return {}
  const match = wordLimit.match(/约\s*(\d+)\s*字\s*±\s*(\d+)\s*%/)
  if (match === null) return {}
  const base = Number(match[1])
  const percent = Number(match[2])
  if (!Number.isFinite(base) || !Number.isFinite(percent) || base <= 0 || percent <= 0) return {}
  return {
    minWords: Math.floor(base * (1 - percent / 100)),
    maxWords: Math.ceil(base * (1 + percent / 100)),
  }
}

/** One framework spec → OutputTemplate (sections + discussion/final render modes). */
export function frameworkOutputTemplate(
  framework: ZhijianFrameworkSpec,
  packVersion: string,
  prefix = 'zhijian',
): OutputTemplate {
  const limits = wordLimits(framework.wordLimit)
  return {
    id: `${prefix}.output.${framework.id}`,
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    media: ['markdown'],
    sections: framework.outputSections.map(section => ({
      id: section,
      required: true,
      ...limits,
      requires: ['source', 'caliber'],
    })),
    renderModes: {
      discussion: { anonymize: true },
      final: { anonymize: false },
    },
  }
}

/**
 * One framework spec → TeamTemplate. Models the V1 review shape with ONE
 * **logical reviewer task** (`t1`, role.reviewer) + ONE fusion task (`t2`,
 * depends on `t1`). The roster for role.reviewer is driven by
 * `parameters.selectedExpertIds` (compiler: the unique `user-signoff` slot
 * takes the param as explicit assignments, 1..5 experts); the compiler
 * stamps `expertIds` onto the logical reviewer task, and execution adapters
 * fan out one physical review execution per expert deterministically — the
 * template itself stays declarative. Framework E builds no team
 * (顾问式自由问答, handled by the captain directly).
 */
export function frameworkTeamTemplate(
  framework: ZhijianFrameworkSpec,
  packVersion: string,
  options: { prefix?: string; qualityPolicyId?: string } = {},
): TeamTemplate {
  const prefix = options.prefix ?? 'zhijian'
  const qualityPolicyId = options.qualityPolicyId ?? QUALITY_POLICY_ID
  const outputTemplate = `${prefix}.output.${framework.id}`
  const reviewer = 'role.reviewer'
  return {
    id: `${prefix}.team.${framework.id}`,
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    parameters: {
      type: 'object',
      properties: {
        selectedExpertIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 5,
          description: '用户拍板选定的专家 id（bk-*），1-5 位',
        },
        data: { type: 'string', description: '数据本体（指标/数值/口径/城市/时段）' },
        outputForm: { type: 'string', enum: ['discussion', 'final'], description: '输出形态' },
        // Runtime-shape params: the review adapter folds the framework spec +
        // the request context into these, and the apply bridge interpolates
        // them into the placeholder-based task copy below. This keeps the
        // template declarative while reproducing the V1 review copy exactly
        // (framework steps/constraints numbered, word-limit line conditional,
        // fusion rules from GLOBAL_OUTPUT_RULES with the literal `5. ` prefix).
        dataContext: { type: 'string', description: '数据本体/来源/城市/时段上下文（适配器组装）' },
        frameworkName: { type: 'string', description: '框架名称（framework.name）' },
        frameworkSteps: { type: 'string', description: '框架步骤（编号 1..n 拼接）' },
        frameworkConstraints: { type: 'string', description: '框架约束（编号 1..n 拼接）' },
        wordLimitLine: { type: 'string', description: '字数约束行（含换行前缀；无约束为空串）' },
        frameworkWordLimitParen: { type: 'string', description: '括号内的字数约束（用于融合任务；无约束为空串）' },
        outputFormText: { type: 'string', description: '输出形态中文（讨论稿/正式稿）' },
        fusionExtraRules: { type: 'string', description: '融合任务附加规则行（GLOBAL_OUTPUT_RULES 过滤，字面 `5. ` 前缀）' },
      },
      required: ['selectedExpertIds', 'data'],
    },
    slots: [
      {
        id: reviewer,
        capabilities: [REVIEW_CAPABILITY],
        cardinality: { min: 1, max: 5 },
        // 框架 D: 问题拆 2~4 分类 → 至少两个领域（fields ≥ 2）.
        ...(framework.id === 'D' ? { diversity: { fields: 2 } } : {}),
        approval: 'user-signoff',
      },
      {
        id: 'role.fusion',
        capabilities: [REVIEW_CAPABILITY],
        // min 0: the fusion task stays UNASSIGNED (shared pool) exactly like
        // the V1 `expert_review_apply` runtime — an optional slot auto-fills
        // zero experts, so no extra member is rostered and no expert is pinned
        // to the fusion task. (min 1 would auto-fill the top-ranked reviewer,
        // adding a member and assigning the fusion task — a behavior change.)
        cardinality: { min: 0, max: 1 },
      },
    ],
    tasks: [
      {
        id: 't1',
        role: reviewer,
        dependsOn: [],
        inputs: [
          { kind: 'parameter', ref: 'data' },
          { kind: 'parameter', ref: 'selectedExpertIds' },
        ],
        // The review capability is a ROSTER requirement (scenario
        // requiredCapabilities), never a tool: leaving it out of
        // allowedCapabilities keeps the template compilable WITHOUT a
        // scenario (the adapter's "no standard scenario" note branch) — a
        // scenario-less compile treats every allowedCapability as tool-allowed
        // and would demand a tool provider for `zhijian.review`.
        // Read-only data capabilities ARE stamped: the runtime capability
        // gate (expert_provider_call) lets reviewers verify/fetch data.
        allowedCapabilities: ZHIJIAN_DATA_CAPABILITIES,
        outputSchema: outputTemplate,
        retryPolicy: 'quality-repair',
        // Logical reviewer task: compiled `expertIds` = the selected experts;
        // the apply bridge fans out one physical review per expert id and
        // interpolates the per-expert placeholders from the adapter-supplied
        // expertDisplay ({expertName}/{expertField}/{expertInitials}).
        subject: '专家研判：{expertName}（{expertField}·{expertInitials}）',
        description: '以专家「{expertName}」身份独立研判，输出框架 {frameworkName}。\n\n{dataContext}\n\n{frameworkSteps}{wordLimitLine}\n约束：{frameworkConstraints}\n匿名标注：文内身份只标「{expertField}·{expertInitials}」。完成后提交完整点评文本到 output。',
      },
      {
        id: 't2',
        role: 'role.fusion',
        dependsOn: ['t1'],
        inputs: [{ kind: 'task-output', ref: 't1' }],
        // Fusion may re-verify quoted numbers against the read-only data set.
        allowedCapabilities: ZHIJIAN_DATA_CAPABILITIES,
        outputSchema: outputTemplate,
        retryPolicy: 'quality-repair',
        subject: '融合合成与渲染（讨论稿/正式稿）',
        description: '综合以下专家研判任务：{dependencies}（用 expert_teams_status 读取各任务 output）。\n框架：{frameworkName}{frameworkWordLimitParen}\n输出形态：{outputFormText}。\n融合规则（主基调为锚）：\n1. 先定主基调 keynote（据数据事实判定；用户指定基调则严格跟随）。\n2. 支撑主基调的论证保留；偏离的观点降级为边界条件/风险提示（"若 X 成立，基调需下修"），不作"另一派"并列。\n3. 结论/归因/展望自洽，不前后矛盾。\n4. 匿名化：讨论稿正文关键处标「领域·首字母」+ 文末框架/口径/心智模型元信息；正式稿去全部标注仅留一行数据来源。\n{fusionExtraRules}\n完成后把全文写入 output。',
      },
    ],
    gates: [
      { policy: qualityPolicyId, gate: 'compliance-anonymization', appliesTo: ['t2'] },
      { policy: qualityPolicyId, gate: 'data-citation', appliesTo: ['t2'] },
    ],
    deliverables: [
      { id: 'd1', outputTemplate, fromTasks: ['t2'], renderMode: 'discussion' },
    ],
  }
}

/** The shared quality policy: gates derived from GLOBAL_OUTPUT_RULES + framework constraints. */
export function qualityPolicy(
  packVersion: string,
  id = QUALITY_POLICY_ID,
  extraGates: readonly QualityPolicy['gates'][number][] = [],
): QualityPolicy {
  return {
    id,
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    gates: [
      {
        id: 'schema-structure',
        kind: 'deterministic',
        appliesTo: ['deliverable'],
        severity: 'hard',
        phase: 'structure',
        config: { checks: ['必填章节齐全', '标题层级/表格列一致', 'JSON/YAML/Markdown 可解析'] },
      },
      {
        id: 'data-citation',
        kind: 'deterministic',
        appliesTo: ['deliverable'],
        severity: 'hard',
        phase: 'data',
        config: {
          rules: ['硬数字必须核实（编数字比不回答更严重）', '口径缺失必须先问用户', 'null 禁转 0', '数字带来源/时段/区域/单位/口径'],
        },
      },
      {
        id: 'compliance-anonymization',
        kind: 'deterministic',
        appliesTo: ['deliverable'],
        severity: 'hard',
        phase: 'compliance',
        config: { rules: ['对外只列「领域·首字母」', '已故专家（bk-022）仅可引用历史观点', 'internalOnly（bk-031）不得外发'] },
      },
      {
        id: 'style-lint',
        kind: 'deterministic',
        appliesTo: ['deliverable'],
        severity: 'soft',
        phase: 'style',
        config: { rules: ['禁课堂式过渡句', '同篇不重复同款过渡句式', '转折词一篇 ≤1-2 次'] },
      },
      {
        id: 'semantic-fusion',
        kind: 'semantic',
        appliesTo: ['deliverable'],
        severity: 'hard',
        phase: 'semantic',
        config: { rule: '主基调为锚：支撑主基调的论证保留，偏离观点降级为边界条件/风险提示' },
      },
      ...extraGates,
    ],
    maxRepairRounds: 2,
  }
}

/** One framework spec → progressive MethodPack (methodology, never persona-injected). */
export function frameworkMethodPack(
  framework: ZhijianFrameworkSpec,
  packVersion: string,
  prefix = 'zhijian',
): MethodPack {
  const steps = framework.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')
  const constraints = framework.constraints.map((rule, index) => `${index + 1}. ${rule}`).join('\n')
  const body = [
    `输出框架 ${framework.id}（${framework.name}）— ${framework.appliesTo}`,
    '',
    '步骤：',
    steps,
    ...(framework.wordLimit !== undefined ? ['', `字数约束：${framework.wordLimit}`] : []),
    '',
    '约束：',
    constraints,
  ].join('\n')
  return {
    id: `${prefix}.method.framework-${framework.id.toLowerCase()}`,
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: `输出框架 ${framework.id}（${framework.name}）`,
    mediaType: 'agent-instructions',
    load: 'progressive',
    body,
  }
}

/** The shared review protocol method pack (全局输出规则 + 融合协议). */
function reviewProtocolMethodPack(packVersion: string): MethodPack {
  return {
    id: 'zhijian.method.review-protocol',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: '智见点评·研判协议（基调融合/匿名化/数字核实）',
    mediaType: 'agent-instructions',
    load: 'progressive',
    body: [
      '智见点评全局输出规则（GLOBAL_OUTPUT_RULES）：',
      ...GLOBAL_OUTPUT_RULES.map((rule, index) => `${index + 1}. ${rule}`),
    ].join('\n'),
  }
}

/** One routing scenario → ScenarioV2 (candidates stay routing hints, never a fixed roster). */
function scenarioV2(scenario: ZhijianRouteScenario, packVersion: string): ScenarioV2 {
  const fieldCapability = `${fieldDomain(scenario.primaryField)}.review`
  return {
    id: scenario.id,
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    domain: 'realestate',
    intents: [...(SCENARIO_INTENTS[scenario.id] ?? [scenario.id])],
    requiredCapabilities: [
      { capability: REVIEW_CAPABILITY, minProficiency: 1, cardinality: 1 },
      { capability: fieldCapability, minProficiency: 1, cardinality: 1 },
    ],
    routingPolicy: {
      ...(scenario.constraints !== undefined ? { assertions: [scenario.constraints] } : {}),
      candidateHints: [...scenario.candidates],
    },
    teamTemplate: `zhijian.team.${scenario.framework}`,
    outputTemplate: `zhijian.output.${scenario.framework}`,
    qualityPolicy: QUALITY_POLICY_ID,
    knowledgePolicy: {
      required: ['zhijian-expert-memory'],
      optional: ['local-knowledge'],
    },
    toolPolicy: { allowed: [] }, // no tool capabilities asserted yet — provider runtime is Phase 2
  }
}

/** Knowledge provider manifests the pack binds to. */
function knowledgeProviders(packVersion: string): KnowledgeProviderManifest[] {
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
      id: 'zhijian-expert-memory',
      version: packVersion,
      schemaVersion: SCHEMA_VERSION,
      kind: 'database',
      capabilities: ['search', 'read', 'cite', 'history'],
      freshness: 'monthly',
      scopes: ['experts'],
      domainKnowledgeIds: ['zhijian.expert-memory'],
    },
  ]
}

/** Structured knowledge base over the expert profile records (§3.3.1). */
function domainKnowledgeManifest(packVersion: string): DomainKnowledgeManifest {
  const digest = createHash('sha256').update(JSON.stringify(ZHIJIAN_EXPERTS)).digest('hex')
  return {
    id: 'zhijian.expert-memory',
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    domain: 'realestate.research',
    boundary: `智见点评 ${ZHIJIAN_EXPERTS.length} 位房地产专家 Profile 基线（2026-08-21 更新：原 2026-08-19 基线 32 位 + 新增陈杰 BK-034）：身份、领域、立场、风格、心智模型、金句、禁区、分析步骤、方法细节（reviewLens/dataPreference/evidenceStandard/agenticProtocol）、评估模型（emm 加权+一票否决）、输出约束与 rubric；不含实时市场数据。`,
    ontology: {
      entities: [
        { id: 'expert', description: `领域专家（${ZHIJIAN_EXPERTS[0]?.id ?? 'bk-002'}~${ZHIJIAN_EXPERTS[ZHIJIAN_EXPERTS.length - 1]?.id ?? 'bk-033'}）` },
        { id: 'field', description: '五大主领域（宏观经济/政策制度/行业研究/城市发展/居住服务）' },
        { id: 'stance', description: '专家立场标签' },
        { id: 'capability-tag', description: '能力标签（数据/研判/解读/理论/实操）' },
        { id: 'framework', description: '输出框架 A-E' },
      ],
      relations: [
        { id: 'expert-belongs-to-field', from: 'expert', to: 'field', description: '专家属于主领域' },
        { id: 'expert-has-stance', from: 'expert', to: 'stance', description: '专家持有立场' },
      ],
    },
    collections: [
      { id: 'experts', root: 'experts', format: 'json', description: '每专家一个 Profile 记录' },
    ],
    snapshot: {
      id: ZHIJIAN_PACK_SNAPSHOT,
      takenAt: ZHIJIAN_BASELINE_DATE,
      digest,
      recordCount: ZHIJIAN_EXPERTS.length,
    },
    retrievalProfiles: [
      { id: 'by-id', method: 'keyword' },
      { id: 'by-field', method: 'keyword' },
    ],
    policies: { citation: 'required', freshness: 'monthly', access: 'readonly' },
  }
}

/** Builder options. */
export interface BuildZhijianPackOptions {
  /** Version stamped on every pack object; defaults to {@link ZHIJIAN_PACK_VERSION}. */
  packVersion?: string
  /** Preset model route applied to every expert (V1 registry constant moved here by callers). */
  modelPolicy?: ModelPolicy
}

/**
 * Build the complete `zhijian-realestate` domain pack from the in-repo
 * generated metas (33 since 1.1.0). The result is JSON-safe, deterministic,
 * and passes {@link validateDomainPack} with zero error diagnostics.
 */
export function buildZhijianDomainPack(options: BuildZhijianPackOptions = {}): DomainPackV2 {
  const packVersion = options.packVersion ?? ZHIJIAN_PACK_VERSION
  const pack: PackMeta = {
    id: ZHIJIAN_PACK_ID,
    version: packVersion,
    schemaVersion: SCHEMA_VERSION,
    name: '智见点评·房地产领域包',
    description: `${ZHIJIAN_EXPERTS.length} 位房地产领域专家基线（${ZHIJIAN_EXPERTS[0]?.id ?? 'bk-002'}~${ZHIJIAN_EXPERTS[ZHIJIAN_EXPERTS.length - 1]?.id ?? 'bk-033'}，五大领域）。V2 投影源为 src/zhijian/data/experts.generated.ts + routing/frameworks 表；V1 视图与运行行为不变。1.1.0：新增陈杰 bk-034，并投影完整 Profile 细节（persona/method/emm/constraints/output_schema）。`,
    caliberDeclarations: {
      '克而瑞': '克而瑞/普睿监测口径',
      '中指': '中指院口径',
      '贝壳': '贝壳成出口径',
      '统计局': '国家统计局口径',
    },
  }
  const expertOptions = {
    packVersion,
    ...(options.modelPolicy === undefined ? {} : { modelPolicy: options.modelPolicy }),
  }
  return {
    pack,
    experts: ZHIJIAN_EXPERTS.map(meta => zhijianMetaToExpertV2(meta, expertOptions)),
    teamTemplates: FRAMEWORKS
      .filter(framework => framework.id !== 'E') // E (顾问式) 不建队
      .map(framework => frameworkTeamTemplate(framework, packVersion)),
    outputTemplates: FRAMEWORKS.map(framework => frameworkOutputTemplate(framework, packVersion)),
    qualityPolicies: [qualityPolicy(packVersion)],
    // 整合设计下的包切片：运行时共享 ROUTE_SCENARIOS（含 bank-* 场景），但
    // 每个包只投影自己的场景（房地产包 = 候选全为 bk-* 的场景；BANK 场景归
    // bank-finance 包），保证包内交叉引用自洽、zhijian 包派生物品字节不变。
    scenarios: ROUTE_SCENARIOS
      .filter(scenario => scenario.candidates.every(id => id.startsWith('bk-')))
      .map(scenario => scenarioV2(scenario, packVersion)),
    toolProviders: [], // provider runtime is Phase 2 — nothing asserted yet
    knowledgeProviders: knowledgeProviders(packVersion),
    domainKnowledge: [domainKnowledgeManifest(packVersion)],
    methodPacks: [
      reviewProtocolMethodPack(packVersion),
      ...FRAMEWORKS.map(framework => frameworkMethodPack(framework, packVersion)),
    ],
    skillPackages: ZHIJIAN_SKILL_PACKAGES.map(skillPackageManifest),
  }
}

export type { ZhijianFrameworkId }
