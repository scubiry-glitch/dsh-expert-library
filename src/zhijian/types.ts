/**
 * 智见点评 (Zhijian Review) domain types — native data model for the
 * real-estate expert review subsystem. Everything the review flow needs is
 * structured plugin data: expert metas, routing tables, stance comparison,
 * and output frameworks. The model never parses the raw skill files.
 * @module dsh-expert-library/zhijian/types
 */

/** Output framework ids (SKILL.md 框架 A/B/C/D/E). */
export type ZhijianFrameworkId = 'A' | 'B' | 'C' | 'D' | 'E'

/** Expert id namespace: BK = real-estate/macro/policy, BANK = banking/finance,
 * S = pipeline 特级专家, XHS = 小红书运营, E<域> = pipeline 行业专家（e01/e08/e13…）. */
export type ExpertNamespace = 'bk' | 'bank' | 's' | 'xhs' | `e${string}` | (string & {})

/** Fields of the expert roster（BK 五大领域 + BANK 银行领域 + pipeline 领域）. */
export type ZhijianField =
  | '宏观经济'
  | '政策制度'
  | '行业研究'
  | '城市发展'
  | '居住服务'
  | '零售金融'
  | '银行经营'
  | '房地产'
  | '资产配置'
  | '江苏银行高层'

/**
 * One expert meta, extracted from `<姓名>_专家Profile_BK-NNN.json` plus the
 * roster table (专家总表.md) by scripts/build-zhijian-data.mjs (BK 命名空间)
 * or scripts/build-bank-data.mjs (BANK 命名空间). Both namespaces share the
 * same shape so registry / routing / persona / pack projection treat them
 * uniformly (整合设计：单一生成数据层 + 单一注册表 + 单一路由表).
 */
export interface ZhijianExpertMeta {
  /** Stable expert id (`bk-004` / `bank-09`), usable with expert_teams_add_member(expert=…). */
  readonly id: string
  /** Original roster id (`BK-004` / `BANK-09`). */
  readonly bk: string
  /** Real name (internal routing only; output is anonymized). */
  readonly name: string
  /** Persona display name (e.g. `宏观周期派 X 首席`). */
  readonly personaName: string
  /** Primary field (BK 五大领域 + bank 领域). */
  readonly field: ZhijianField | string
  /** Secondary field, when any. */
  readonly secondaryField?: string
  /** Stance label (e.g. `宏观周期派` / `操盘手`). */
  readonly stance: string
  /** Capability tags (数据/研判/解读/理论/实操). */
  readonly tags: readonly string[]
  /** One-line stance summary from the roster. */
  readonly summary: string
  /** Output initials (匿名化标注用). */
  readonly initials: string
  /** Persona style rules from the Profile JSON. */
  readonly style: readonly string[]
  /** Mental-model names (method.frameworks). */
  readonly mentalModels: readonly string[]
  /** Signature phrases (金句). */
  readonly signaturePhrases: readonly string[]
  /** Anti-patterns (禁区). */
  readonly antiPatterns: readonly string[]
  /** Analysis steps (method.analysis_steps). */
  readonly analysisSteps: readonly string[]
  /** Deceased experts may only be cited for historical views. */
  readonly deceased?: boolean
  /** Id namespace (absent = bk, for legacy metas). */
  readonly namespace?: ExpertNamespace
  /** Expert data version (P1.5; 1.0.0 起，内容变化 +0.1). */
  readonly version?: string
  /** Provenance of the underlying source (P1.5). */
  readonly source?: {
    readonly origin: string
    readonly sha256?: string
    readonly material?: { readonly md?: boolean; readonly raw?: boolean; readonly knowledge?: boolean }
  }
  /** 1.1.0: rich persona detail lifted verbatim from the Profile JSON (absent stays absent). */
  readonly personaDetail?: ZhijianPersonaDetail
  /** 1.1.0: rich method detail (reviewLens/dataPreference/evidenceStandard/agenticProtocol). */
  readonly methodDetail?: ZhijianMethodDetail
  /** 1.1.0: evaluation model (emm) — factor hierarchy + veto rules + aggregation. */
  readonly emm?: ZhijianEmm
  /** 1.1.0: output constraints (must_conclude / allow_assumption). */
  readonly constraints?: ZhijianExpertConstraints
  /** 1.1.0: output schema (format / sections / rubrics). */
  readonly outputSchema?: ZhijianOutputSchema
}

/** One rich mental model from `persona.cognition.mentalModels`. */
export interface ZhijianMentalModelDetail {
  readonly name: string
  readonly summary?: string
  readonly evidence?: readonly string[]
  readonly applicationContext?: string
  readonly failureCondition?: string
}

/** Rich persona detail from the Profile JSON `persona` section (conservative projection). */
export interface ZhijianPersonaDetail {
  readonly tone?: string
  readonly bias?: readonly string[]
  readonly values?: {
    readonly excites?: readonly string[]
    readonly irritates?: readonly string[]
    readonly qualityBar?: string
    readonly dealbreakers?: readonly string[]
  }
  readonly taste?: {
    readonly admires?: readonly string[]
    readonly disdains?: readonly string[]
    readonly benchmark?: string
  }
  readonly voice?: {
    readonly disagreementStyle?: string
    readonly praiseStyle?: string
  }
  readonly cognition?: {
    readonly mentalModel?: string
    readonly mentalModels?: readonly ZhijianMentalModelDetail[]
    readonly decisionStyle?: string
    readonly riskAttitude?: string
    readonly timeHorizon?: string
  }
  readonly blindSpots?: {
    readonly knownBias?: readonly string[]
    readonly weakDomains?: readonly string[]
    readonly selfAwareness?: string
    readonly confidenceThreshold?: string
  }
}

/** Rich method detail from the Profile JSON `method` section (conservative projection). */
export interface ZhijianMethodDetail {
  /** Most experts carry a structured lens; BK-034 carries a plain string — both kept verbatim. */
  readonly reviewLens?: {
    readonly firstGlance?: string
    readonly deepDive?: readonly string[]
    readonly killShot?: string
    readonly bonusPoints?: readonly string[]
  } | string
  readonly dataPreference?: string
  readonly evidenceStandard?: string
  readonly agenticProtocol?: {
    readonly requiresResearch?: boolean
    readonly researchSteps?: readonly string[]
    readonly noGuessPolicy?: boolean
  }
}

/** Evaluation model (emm): weighted factor hierarchy + veto rules + aggregation. */
export interface ZhijianEmm {
  readonly criticalFactors?: readonly string[]
  readonly factorHierarchy?: Readonly<Record<string, number>>
  readonly vetoRules?: readonly string[]
  readonly aggregationLogic?: string
}

/** Output constraints from the Profile JSON `constraints` section. */
export interface ZhijianExpertConstraints {
  readonly mustConclude?: boolean
  readonly allowAssumption?: boolean
}

/** One rubric level of an object-shaped rubric ({score: 1..5, description}). */
export interface ZhijianRubricLevel {
  readonly score?: number
  readonly description?: string
}

/** Object-shaped rubric ({dimension, levels[]}); string rubrics are plain strings. */
export interface ZhijianRubric {
  readonly dimension?: string
  readonly levels?: readonly ZhijianRubricLevel[]
}

/** Output schema from the Profile JSON `output_schema` section. */
export interface ZhijianOutputSchema {
  readonly format?: string
  readonly sections?: readonly string[]
  readonly rubrics?: ReadonlyArray<string | ZhijianRubric>
}

/** One topic type of the routing table (路由规则.md §一). */
export interface ZhijianRouteTopic {
  /** User wording / topic type. */
  readonly topic: string
  /** Output framework for this topic. */
  readonly framework: ZhijianFrameworkId
  /** Primary responsible field. */
  readonly primaryField: ZhijianField | string
  /** Preferred capability tags. */
  readonly preferredTags: readonly string[]
  /**
   * 归属领域包切片（整合设计：运行时共享一张路由表，各包发射器只投影自己的
   * 切片）。缺省 'zhijian'；bank 话题标 'bank'，pipeline 话题标 'pipeline'。
   */
  readonly packScope?: 'zhijian' | 'bank' | 'pipeline' | 'pipeline-general'
}

/** One routing scenario (路由规则.md §二). */
export interface ZhijianRouteScenario {
  /** Scenario id (also usable as a team scenario). */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Framework used for this scenario's reviews. */
  readonly framework: ZhijianFrameworkId
  /** Primary responsible field. */
  readonly primaryField: ZhijianField | string
  /** Candidate expert ids (`bk-…`), in recommendation order. */
  readonly candidates: readonly string[]
  /** Constraints from the routing rules (主答/口径/内测等). */
  readonly constraints?: string
}

/** One stance-comparison row (专家总表.md 立场对照). */
export interface ZhijianStancePair {
  /** Topic of the comparison. */
  readonly topic: string
  /** Optimistic/bottom-call expert ids. */
  readonly optimistic: readonly string[]
  /** Risk-flagging expert ids. */
  readonly risk: readonly string[]
  /** Additional unique-perspective expert ids. */
  readonly unique?: readonly string[]
}

/** One output framework spec (专家输出框架规范). */
export interface ZhijianFrameworkSpec {
  readonly id: ZhijianFrameworkId
  /** Display name. */
  readonly name: string
  /** Which topics this framework applies to. */
  readonly appliesTo: string
  /** Step templates, used to build the review task DAG. */
  readonly steps: readonly string[]
  /** Word limit, when the framework has a gate. */
  readonly wordLimit?: string
  /** Output sections for the rendered review. */
  readonly outputSections: readonly string[]
  /** Hard constraints (四要素/数字核实/禁区…). */
  readonly constraints: readonly string[]
}

/** The routed candidate list presented for user sign-off. */
export interface ZhijianRouteResult {
  /** Matched topic type. */
  readonly topic: string
  /** Chosen framework. */
  readonly framework: ZhijianFrameworkId
  /** Primary responsible field. */
  readonly primaryField: string
  /** Candidate experts (anonymized presentation ready — no real names). */
  readonly candidates: readonly {
    readonly id: string
    readonly bk: string
    readonly field: string
    readonly stance: string
    readonly initials: string
    readonly tags: readonly string[]
    readonly deceased?: boolean
    /** P1.5: 专家数据版本与命名空间（provenance）. */
    readonly version?: string
    readonly namespace?: 'bk' | 'bank' | string
    /** P1.1: 能力匹配增强（命中标签/分值/理由）. */
    readonly matchedTags?: readonly string[]
    readonly matchScore?: number
    readonly matchReason?: string
  }[]
  /** Scenario constraints to honor. */
  readonly constraints?: string
  /** P1.1: 能力匹配摘要（供队长展示匹配理由）. */
  readonly capabilityNote?: string
  /** P1.4: 心智模型注册表规模. */
  readonly mentalModelsCount?: number
}

/** Durable review metadata stored on the team record. */
export interface ReviewMeta {
  /** Data source (统计局/克而瑞/贝壳/中指/自算). */
  readonly dataSource?: string
  /** City / region the data covers. */
  readonly city?: string
  /** Time window of the data. */
  readonly period?: string
  /** Chosen output framework. */
  readonly framework?: ZhijianFrameworkId
  /** Chosen expert ids after user sign-off. */
  readonly selectedExperts?: readonly string[]
  /** Output form: 讨论稿 (default) or 正式稿. */
  readonly outputForm?: 'discussion' | 'final'
  /** 主基调 keynote, when already set. */
  readonly keynote?: string
  /** Topic type of the request. */
  readonly topicType?: string
}
