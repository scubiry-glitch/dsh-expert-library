/**
 * 归型澄清层（Clarification Layer）——「先归型、再路由」的系统化设计。
 *
 * 任何请求（尤其自由/模糊文本）在进入 expert_review_route/apply 前，先经
 * 澄清层把领域包所需的口径全部确认清楚：
 * - 通用口径（所有领域包）：用途受众 / 数据来源 / 城市区域 / 时段 /
 *   输出形态 / 优先级约束；
 * - 领域口径（按包）：zhijian=量价供需库存；bank=机构范围+敏感脱敏；
 *   beike=视角侧重+贝壳口径+内测引用；pipeline/pipeline-general=行业域+视角分类；
 * - 场景可覆盖/追加（场景级 questions 优先于包级、包级优先于通用，按 id 去重）。
 *
 * 答案经 `answersToRouteContext` 映射为 apply 的路由参数（data 上下文 /
 * data_source / city / period / output_form / 归型 topic），口径齐了再路由，
 * 避免进入团队后反复追问。
 *
 * 纯数据 + 纯函数：无 I/O、无模型调用、确定性输出。
 * @module dsh-expert-library/zhijian/clarify
 */

/** 澄清问题分组（用于向用户分批/分类展示）。 */
export type ClarifyGroup = '意图' | '用途受众' | '数据口径' | '领域' | '输出'

/** 一条澄清问题。 */
export interface ClarificationQuestion {
  /** 稳定 id（答案以它为键）。 */
  readonly id: string
  /** 面向用户的问题文本。 */
  readonly question: string
  /** 分组。 */
  readonly group: ClarifyGroup
  /** 候选选项（供用户快速选择，可自由补充）。 */
  readonly options?: readonly string[]
  /** 必须确认（缺失会显著影响路由质量）。 */
  readonly required?: boolean
  /** 适用领域包 scope 或场景 id（缺省=通用）。 */
  readonly appliesTo?: readonly string[]
}

/** 用户对澄清问题的答案。 */
export interface ClarificationAnswers {
  readonly [questionId: string]: string
}

/** 路由上下文（由答案映射而来，供 apply 使用）。 */
export interface RouteClarifiedContext {
  /** 数据本体（含口径/城市/时段，拼装为 dataContext）。 */
  readonly data: string
  readonly dataSource?: string
  readonly city?: string
  readonly period?: string
  readonly outputForm?: 'discussion' | 'final'
  /** 归一后的意图/归型话题（自由请求时由队长据此归型）。 */
  readonly intent?: string
}

/* ------------------------------------------------------------------ */
/* 问题集注册表                                                        */
/* ------------------------------------------------------------------ */

/** 通用口径（所有领域包必答项，required）。 */
const COMMON_QUESTIONS: readonly ClarificationQuestion[] = [
  {
    id: 'purpose',
    question: '这份材料/问题的用途与目标受众是什么？',
    group: '用途受众',
    options: ['对外招商/客户展示', '领导汇报', '内部评审', '公开传播', '个人决策'],
    required: true,
  },
  {
    id: 'data_source',
    question: '数据来源/口径？（数字必须带口径，无法核实只给框架）',
    group: '数据口径',
    options: ['统计局', '克而瑞', '贝壳', '中指', '自算', '无数据/定性'],
    required: true,
  },
  {
    id: 'city',
    question: '覆盖城市/区域？',
    group: '数据口径',
  },
  {
    id: 'period',
    question: '数据时段？',
    group: '数据口径',
  },
  {
    id: 'output_form',
    question: '输出形态？',
    group: '输出',
    options: ['讨论稿（带匿名标注）', '正式稿（去标注）'],
  },
  {
    id: 'priority',
    question: '本次迭代的优先级/硬约束？（如必须保留的要素、时间窗口）',
    group: '用途受众',
  },
]

/** zhijian（房地产）领域口径。 */
const ZHIJIAN_QUESTIONS: readonly ClarificationQuestion[] = [
  {
    id: 'zj_dimension',
    question: '侧重哪类指标？',
    group: '领域',
    options: ['量价', '供需/库存', '城市分化', '政策联动', '金融风险'],
    appliesTo: ['zhijian', 'zhijian-realestate'],
  },
  {
    id: 'zj_market_caliber',
    question: '主答领域与口径？（月度研判必须行业研究主答）',
    group: '领域',
    options: ['行业研究（克而瑞/中指/贝壳）', '政策制度', '宏观经济', '城市发展', '居住服务'],
    appliesTo: ['zhijian', 'zhijian-realestate'],
  },
]

/** bank（银行）领域口径。 */
const BANK_QUESTIONS: readonly ClarificationQuestion[] = [
  {
    id: 'bank_scope',
    question: '机构范围？',
    group: '领域',
    options: ['总行', '全省', '单分行', '样板分行对比'],
    appliesTo: ['bank', 'bank-finance'],
  },
  {
    id: 'bank_sensitive',
    question: '是否含敏感数据（账号/卡号/手机号/客户粒度）？——涉及时必须脱敏',
    group: '数据口径',
    options: ['仅聚合口径', '含样例但须脱敏', '无敏感数据'],
    appliesTo: ['bank', 'bank-finance'],
    required: true,
  },
  {
    id: 'bank_angle',
    question: '侧重视角？',
    group: '领域',
    options: ['零售信贷/操盘', '信用卡', '战略与量化目标', '数智化转型', '外部合作'],
    appliesTo: ['bank', 'bank-finance'],
  },
]

/** beike（贝壳生态）领域口径。 */
const BEIKE_QUESTIONS: readonly ClarificationQuestion[] = [
  {
    id: 'beike_angle',
    question: '侧重哪个视角？',
    group: '领域',
    options: ['平台生态', '经纪渠道', '房源/挂牌', '租赁/长租供应链', '政策研究产品'],
    appliesTo: ['beike'],
    required: true,
  },
  {
    id: 'beike_caliber',
    question: '数据口径？（贝壳成出口径与克而瑞/中指/统计局有差异）',
    group: '数据口径',
    options: ['贝壳成出口径', '统计局/克而瑞/中指', '混合（标注各自口径）'],
    appliesTo: ['beike'],
    required: true,
  },
  {
    id: 'beike_internal',
    question: '是否引用内测对比项（陶琦 bk-031，贝壳/NIFD 口径）？——对外交付不引用',
    group: '领域',
    options: ['不引用', '仅内部讨论引用'],
    appliesTo: ['beike'],
  },
]

/** pipeline（E 域 / 特级专家）口径。 */
const PIPELINE_QUESTIONS: readonly ClarificationQuestion[] = [
  {
    id: 'pipe_industry',
    question: '所属行业域？',
    group: '领域',
    options: ['宏观经济/资本市场', '房地产经营', '金融科技', 'AI/半导体', '新能源/制造', '消费/传媒', '特级专家（战略/投资/产品）'],
    appliesTo: ['pipeline', 'pipeline-domains', 'pipeline-general'],
    required: true,
  },
  {
    id: 'pipe_angle',
    question: '侧重视角分类？（框架 D 多视角融合时每类 ≥2 专家）',
    group: '领域',
    options: ['产品', '渠道/经营', '政策/监管', '技术/方法论'],
    appliesTo: ['pipeline', 'pipeline-domains', 'pipeline-general'],
  },
]

/** 全量问题集（确定性注册表）。 */
export const CLARIFICATION_QUESTIONS: readonly ClarificationQuestion[] = [
  ...COMMON_QUESTIONS,
  ...ZHIJIAN_QUESTIONS,
  ...BANK_QUESTIONS,
  ...BEIKE_QUESTIONS,
  ...PIPELINE_QUESTIONS,
]

/* ------------------------------------------------------------------ */
/* 解析与映射                                                          */
/* ------------------------------------------------------------------ */

/** 场景 id → 归属包 scope（供问题集解析；未识别返回 undefined）。 */
const SCENARIO_SCOPES: Readonly<Record<string, string>> = {
  // zhijian
  'zhijian-monthly': 'zhijian',
  'zhijian-policy': 'zhijian',
  'zhijian-macro': 'zhijian',
  'zhijian-finance': 'zhijian',
  'zhijian-city': 'zhijian',
  'zhijian-industry': 'zhijian',
  'zhijian-services': 'zhijian',
  'zhijian-institution': 'zhijian',
  // bank
  'bank-retail': 'bank',
  'bank-credit-card': 'bank',
  'bank-strategy': 'bank',
  // pipeline
  'pipeline-realestate-ops': 'pipeline',
  'pipeline-macro-capital': 'pipeline',
  // general
  'pipeline-general': 'pipeline-general',
  // beike
  'beike-ecosystem': 'beike',
  'beike-rental-supply-chain': 'beike',
}

/** 由场景 id / packScope 解析该请求适用的澄清问题集
 * （场景级 > 包级 > 通用，按声明顺序去重 id）。 */
export function clarificationSetFor(options: { scenarioId?: string; packScope?: string }): ClarificationQuestion[] {
  const scope = options.scenarioId !== undefined ? SCENARIO_SCOPES[options.scenarioId] : options.packScope
  const seen = new Set<string>()
  const out: ClarificationQuestion[] = []
  for (const question of CLARIFICATION_QUESTIONS) {
    if (question.appliesTo === undefined) {
      // 通用：总是包含
    } else if (scope !== undefined && question.appliesTo.includes(scope)) {
      // 包/场景适用
    } else if (options.scenarioId !== undefined && question.appliesTo.includes(options.scenarioId)) {
      // 场景级覆盖
    } else {
      continue
    }
    if (seen.has(question.id)) continue
    seen.add(question.id)
    out.push(question)
  }
  return out
}

/** 必备澄清项（required 且尚未回答）。 */
export function pendingRequiredQuestions(questions: readonly ClarificationQuestion[], answers: ClarificationAnswers): ClarificationQuestion[] {
  return questions.filter(question => question.required === true && (answers[question.id] ?? '').trim() === '')
}

/**
 * 答案 → 路由上下文：把澄清答案拼装为 apply 可用的参数
 * （data 本体含口径/城市/时段；data_source/city/period/output_form 归一）。
 * 未提供的字段保持缺省（不捏造）。
 */
export function answersToRouteContext(answers: ClarificationAnswers): RouteClarifiedContext {
  const dataSource = answers.data_source?.trim()
  const city = answers.city?.trim()
  const period = answers.period?.trim()
  const outputForm = answers.output_form?.includes('正式稿') ? 'final' as const : 'discussion' as const
  const parts: string[] = []
  if (city !== undefined && city !== '') parts.push(`城市/区域：${city}`)
  if (period !== undefined && period !== '') parts.push(`数据时段：${period}`)
  if (dataSource !== undefined && dataSource !== '') parts.push(`数据来源/口径：${dataSource}`)
  if ((answers.bank_sensitive ?? '').includes('脱敏')) parts.push('敏感数据要求：脱敏（账号/卡号/客户粒度不外发）')
  if ((answers.beike_caliber ?? '') !== '') parts.push(`贝壳口径：${answers.beike_caliber}`)
  const extra: string[] = []
  for (const key of ['purpose', 'priority', 'zj_dimension', 'zj_market_caliber', 'bank_scope', 'bank_angle', 'beike_angle', 'beike_internal', 'pipe_industry', 'pipe_angle']) {
    const value = answers[key]?.trim()
    if (value !== undefined && value !== '') extra.push(`${key}：${value}`)
  }
  const data = [
    ...(answers.data !== undefined && answers.data.trim() !== '' ? [`数据本体：${answers.data.trim()}`] : []),
    ...parts,
    ...(extra.length > 0 ? [`澄清口径：${extra.join('；')}`] : []),
  ].join('\n')
  return {
    data,
    ...(dataSource === undefined || dataSource === '' ? {} : { dataSource }),
    ...(city === undefined || city === '' ? {} : { city }),
    ...(period === undefined || period === '' ? {} : { period }),
    outputForm,
  }
}
