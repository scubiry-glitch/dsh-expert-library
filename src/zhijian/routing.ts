/**
 * Native routing tables for the Zhijian review flow — the 路由规则.md /
 * 专家总表.md content upgraded from prose into structured plugin data:
 * topic → framework → primary field → candidate experts (user signs off).
 * @module dsh-expert-library/zhijian/routing
 */

import type {
  ZhijianField,
  ZhijianFrameworkId,
  ZhijianRouteScenario,
  ZhijianRouteTopic,
  ZhijianStancePair,
} from './types.ts'

/** 路由规则.md §一: 话题类型 → 框架 → 主责领域 → 优先标签. */
export const ROUTE_TOPICS: readonly ZhijianRouteTopic[] = [
  {
    topic: '城市月度市场分析（量价、供需、库存、城市月度解读）',
    framework: 'A',
    primaryField: '行业研究',
    preferredTags: ['数据', '研判'],
  },
  {
    topic: '特定问题/目标城市形势判断（"X市见底了吗""X政策影响如何"）',
    framework: 'C',
    primaryField: '按问题落点最近领域',
    preferredTags: [],
  },
  {
    topic: '政策解读（新政策出台、政治局会议、定调变化）',
    framework: 'B',
    primaryField: '政策制度',
    preferredTags: ['解读'],
  },
  {
    topic: '宏观形势展望（GDP、利率、汇率、关税、经济周期）',
    framework: 'B',
    primaryField: '宏观经济',
    preferredTags: ['研判', '解读'],
  },
  {
    topic: '金融风险（涉房贷款、不良、断贷、收储资金、REITs）',
    framework: 'B',
    primaryField: '宏观经济',
    preferredTags: ['数据', '研判'],
  },
  {
    topic: '城市机会（区域比较、城市更新、人口、土地）',
    framework: 'B',
    primaryField: '城市发展',
    preferredTags: ['研判', '理论'],
  },
  {
    topic: '行业经营（房企经营、产品、转型、信用风险）',
    framework: 'B',
    primaryField: '行业研究',
    preferredTags: ['实操', '数据'],
  },
  {
    topic: '服务业务（经纪、租赁、家装、物业、监管）',
    framework: 'B',
    primaryField: '居住服务',
    preferredTags: ['实操', '解读'],
  },
  {
    topic: '制度设计（长效机制、住房制度改革、保障体系）',
    framework: 'B',
    primaryField: '政策制度',
    preferredTags: ['理论', '解读'],
  },
  {
    topic: '多视角综合分析（跨领域/需融合，"该不该买""何时企稳""政策全链条影响"）',
    framework: 'D',
    primaryField: '按问题拆 2~4 分类，每类≥2 专家',
    preferredTags: [],
  },
  {
    topic: '自由提问/FAQ/购房决策/政策逻辑问答（想要一个清晰建议）',
    framework: 'E',
    primaryField: '统一顾问口吻，不拆分类',
    preferredTags: [],
  },
  {
    topic: '零售金融（零售信贷、分行经营、考核推动、外部平台合作、样板复制）',
    framework: 'B',
    primaryField: '零售金融',
    preferredTags: ['实操', '解读'],
    packScope: 'bank',
  },
  {
    topic: '银行经营（信用卡、息差、客群、负债、零售转型）',
    framework: 'B',
    primaryField: '银行经营',
    preferredTags: ['实操', '数据'],
    packScope: 'bank',
  },
  {
    topic: '房地产企业经营（房企经营、平台经济、服务品质、不动产金融、物业）',
    framework: 'B',
    primaryField: '房地产',
    preferredTags: ['实操', '研判'],
    packScope: 'pipeline',
  },
  {
    topic: '宏观经济与资本市场（宏观、利率、汇率、资本市场、资产配置）',
    framework: 'B',
    primaryField: '宏观经济',
    preferredTags: ['研判', '理论'],
    packScope: 'pipeline',
  },
  {
    topic: '银行战略与经营（银行战略、量化目标、数智化转型、零售网络金融）',
    framework: 'B',
    primaryField: '江苏银行高层',
    preferredTags: ['实操', '数据'],
    packScope: 'pipeline',
  },
]

/** 路由规则.md §二: 场景 → 主责领域 → 候选专家（BK 号 → 专家 id）. */
export const ROUTE_SCENARIOS: readonly ZhijianRouteScenario[] = [
  {
    id: 'zhijian-monthly',
    name: '月度/季度市场研判',
    framework: 'A',
    primaryField: '行业研究',
    candidates: ['bk-024', 'bk-025', 'bk-011', 'bk-031', 'bk-010'],
    constraints: '必须由行业研究专家主答。陶琦适合当期量价/挂牌/成交周期数据研判；杨现领适合存量流通/渠道/经纪生态作辅答，不替代行业研究专家给月度主判断。口径：丁祖昱=克而瑞/普睿，黄瑜=中指，陶琦=贝壳/NIFD，与统计局口径均有差异。',
  },
  {
    id: 'zhijian-policy',
    name: '政策解读',
    framework: 'B',
    primaryField: '政策制度',
    candidates: ['bk-020', 'bk-021', 'bk-022', 'bk-006', 'bk-034', 'bk-012', 'bk-013', 'bk-028', 'bk-003'],
    constraints: '涉货币/财税的政策联动到宏观经济（邢自强 bk-004、盛松成 bk-014、楼继伟 bk-032、罗志恒 bk-009）。顾云昌 bk-022 已故：仅可引用历史观点。陈杰 bk-034：制度研究（九字方针/公积金政策性金融）。',
  },
  {
    id: 'zhijian-macro',
    name: '宏观形势展望',
    framework: 'B',
    primaryField: '宏观经济',
    candidates: ['bk-005', 'bk-004', 'bk-007', 'bk-008', 'bk-009', 'bk-014', 'bk-015', 'bk-029', 'bk-032'],
  },
  {
    id: 'zhijian-finance',
    name: '金融风险',
    framework: 'B',
    primaryField: '宏观经济',
    candidates: ['bk-007', 'bk-014', 'bk-029', 'bk-032', 'bk-004'],
    constraints: '房企信用风险归行业研究（刘洪玉 bk-026、冯俊 bk-027）。住房金融/公积金制度视角（辅）：陈杰 bk-034（公积金政策性金融、REITs、收储资金）。',
  },
  {
    id: 'zhijian-city',
    name: '城市机会/城市更新',
    framework: 'B',
    primaryField: '城市发展',
    candidates: ['bk-017', 'bk-023', 'bk-030', 'bk-003'],
  },
  {
    id: 'zhijian-industry',
    name: '行业经营/房企',
    framework: 'B',
    primaryField: '行业研究',
    candidates: ['bk-026', 'bk-027', 'bk-024', 'bk-016', 'bk-025'],
    constraints: '标签细分：房企经营/信用风险/产品转型。',
  },
  {
    id: 'zhijian-services',
    name: '服务业务（经纪/租赁/家装/物业）',
    framework: 'B',
    primaryField: '居住服务',
    candidates: ['bk-033', 'bk-018', 'bk-002', 'bk-019'],
    constraints: '服务链条落地。',
  },
  {
    id: 'zhijian-institution',
    name: '制度设计/长效机制',
    framework: 'B',
    primaryField: '政策制度',
    candidates: ['bk-020', 'bk-034', 'bk-022', 'bk-026', 'bk-016', 'bk-032', 'bk-021'],
    constraints: '顾云昌 bk-022 已故：仅可引用历史观点。陈杰 bk-034：公积金政策性金融、REITs、收储资金视角。',
  },
  {
    id: 'bank-retail',
    name: '零售金融/分行经营',
    framework: 'B',
    primaryField: '零售金融',
    candidates: ['bank-09'],
    constraints: '王一帆 bank-09：城商行零售信贷一线操盘手，主答分行执行/样板复制/考核推动/外部合作；政治账+经济账双算、自主可控为底线。涉信贷风险的宏观/政策联动到 BK 宏观派（bk-007/bk-014/bk-029）。',
  },
  {
    id: 'bank-credit-card',
    name: '信用卡提质增效',
    framework: 'B',
    primaryField: '银行经营',
    candidates: ['bank-09'],
    constraints: '信用卡经营以 bank-09 操盘视角主答（考核/渠道/客户分层），收益模型与资负视角联动 BK 金融数据派（bk-014/bk-029）。样例素材：work/江苏银行信用卡提质增效_任务归档。',
  },
  {
    id: 'pipeline-realestate-ops',
    name: '房地产企业经营',
    framework: 'B',
    primaryField: '房地产',
    candidates: ['e08-08', 'e08-06', 'e08-07', 'e08-09', 'e08-yong-bang'],
    constraints: 'pipeline 命名空间（E08 房地产/不动产金融，公众人物实名）。左晖 e08-08 平台/服务品质/产业互联网视角，吴亚军 e08-06 房企经营，魏行空 e08-09 不动产金融/估值。经营与周期问题可联动 BK 行业研究派。',
  },
  {
    id: 'pipeline-macro-capital',
    name: '宏观经济与资本市场',
    framework: 'B',
    primaryField: '宏观经济',
    candidates: ['e01-08', 'e01-09', 'e01-07', 'e01-02', 'e01-06'],
    constraints: 'pipeline 命名空间（E01 宏观经济，公众人物实名）。高善文 e01-08 资本市场/周期，鲁政委 e01-09 汇率/利率，李扬 e01-07 宏观审慎/债务。',
  },
  {
    id: 'bank-strategy',
    name: '银行战略与经营',
    framework: 'B',
    primaryField: '江苏银行高层',
    candidates: ['e13-01', 'e13-02', 'e13-03'],
    constraints: 'pipeline 命名空间（E13 江苏银行高层，公众人物实名）。袁军 e13-01 战略/客户经营，高增银 e13-02 战略执行/量化目标，梁斌 e13-03 零售/网络金融/数智化。',
  },
]

/** 专家总表.md 立场对照: 同题多专家对比选法. */
export const STANCE_TABLE: readonly ZhijianStancePair[] = [
  {
    topic: '市场是否见底',
    optimistic: ['bk-024', 'bk-014', 'bk-018'],
    risk: ['bk-008', 'bk-013'],
    unique: ['bk-015', 'bk-025'],
  },
  {
    topic: '跌幅归因',
    optimistic: ['bk-005'],
    risk: ['bk-008', 'bk-007'],
    unique: ['bk-017', 'bk-030', 'bk-023'],
  },
  {
    topic: '政策取向',
    optimistic: ['bk-016', 'bk-009'],
    risk: ['bk-020'],
    unique: ['bk-032', 'bk-023'],
  },
  {
    topic: '城市分化',
    optimistic: ['bk-010', 'bk-024'],
    risk: [],
    unique: ['bk-017', 'bk-031'],
  },
  {
    topic: '产品方向',
    optimistic: ['bk-024', 'bk-028'],
    risk: [],
    unique: ['bk-033', 'bk-027'],
  },
]

/** 路由规则.md §三/§四: 特殊路由与组合策略. */
export const SPECIAL_ROUTING: readonly string[] = [
  '突发事件/市场异动：按事件涉及领域映射对应场景。',
  '组合解读/多视角校验：一主一辅跨领域，主领域与标签均不重叠。',
  '观点交叉验证：同领域两位不同标签专家（如数据型 vs 研判型），事实与判断分开校验。',
  '同题多专家对比：从立场对照表的乐观/底部派与风险揭示派各选一位，必要时加独特视角。',
  '框架 D 融合：从五大领域选 2~4 个最相关分类，每分类 ≥2 专家（数据型+研判型互补）；分类内提炼共识+分歧，跨分类标注交集共识与冲突点。',
]

/** 执行约束 (路由规则.md §五). */
export const ROUTING_CONSTRAINTS: readonly string[] = [
  '月度/季度市场研判必须由行业研究专家主答。',
  '陶琦 bk-031 为内测对比项，政研通产品不引用；skill 内部使用无妨。',
  '跨领域问题以提问落点最近的领域为主责，另一领域做补充。',
  '同领域内优先数据型+研判型组合，保证"事实+判断"双覆盖。',
  '候选专家列出后由用户拍板，不自动选定。',
  '顾云昌 bk-022 已故：仅可引用历史观点，不得臆造近期言论。',
]

/** Lookup helpers. */
export function topicRouteFor(topic: string, question?: string): ZhijianRouteTopic | undefined {
  const matched = matchTopic(topic)
  if (matched !== undefined) return matched
  // The free-form question also participates: when the topic type itself does
  // not match, fall back to matching the question text against the topics.
  return question === undefined ? undefined : matchTopic(question)
}

/**
 * P1.3: 立场对照配对（专家总表.md 立场对照结构化）。按话题/问题文本匹配
 * STANCE_TABLE（双向包含 + 简洁头匹配 + 关键词回退），返回该议题的
 * 乐观/底部派与风险揭示派建议专家。供 debate 自动配对与同题多专家对比使用。
 */
export function stancePairForTopic(topic: string, question?: string): ZhijianStancePair | undefined {
  const text = `${topic} ${question ?? ''}`
  const direct = STANCE_TABLE.find(pair => {
    if (text.includes(pair.topic) || pair.topic.includes(text)) return true
    const head = pair.topic.replace(/（.*?）|[（(].*?[)）]/g, '').trim()
    return head.length >= 2 && text.includes(head)
  })
  if (direct !== undefined) return direct
  // 关键词回退：去掉「是否/市场/城市/跌幅/取向/方向」等泛词后，议题中的
  // 关键词（见底/归因/政策/分化/产品）出现在问题文本里即命中。
  const stopwords = ['是否', '市场', '城市', '跌幅', '取向', '方向']
  return STANCE_TABLE.find(pair => {
    let core = pair.topic.replace(/（.*?）|[（(].*?[)）]/g, '').trim()
    for (const word of stopwords) core = core.replaceAll(word, '')
    return core.length >= 2 && text.includes(core)
  })
}

/** Match one text blob against the topic table (both containment directions). */
function matchTopic(text: string): ZhijianRouteTopic | undefined {
  return ROUTE_TOPICS.find(route => {
    if (text.includes(route.topic) || route.topic.includes(text)) return true
    // Topic labels carry a parenthetical elaboration ("政策解读（新政策出台…）");
    // match the concise head too so a question embedding just "政策解读" routes.
    const head = route.topic.replace(/（.*?）|[（(].*?[)）]/g, '').trim()
    return head.length >= 2 && text.includes(head)
  })
}

export function scenarioById(id: string): ZhijianRouteScenario | undefined {
  return ROUTE_SCENARIOS.find(scenario => scenario.id === id)
}

export function scenarioForTopic(
  topic: string,
  framework: ZhijianFrameworkId,
  question?: string,
): ZhijianRouteScenario | undefined {
  const byName = ROUTE_SCENARIOS.find(scenario => topic.includes(scenario.name))
    ?? (question === undefined
      ? undefined
      : ROUTE_SCENARIOS.find(scenario => question.includes(scenario.name)))
  if (byName !== undefined) return byName
  // Fall back to the scenario matching the topic's primary field.
  const route = topicRouteFor(topic, question)
  if (route === undefined) return undefined
  return ROUTE_SCENARIOS.find(scenario => scenario.primaryField === route.primaryField)
}

/** Whether a field name is a known primary field. */
export function isZhijianField(value: string): value is ZhijianField {
  return value === '宏观经济' || value === '政策制度' || value === '行业研究'
    || value === '城市发展' || value === '居住服务'
    || value === '零售金融' || value === '银行经营'
}

export type { ZhijianFrameworkId }
