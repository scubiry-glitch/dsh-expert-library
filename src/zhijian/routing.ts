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
    candidates: ['bk-020', 'bk-021', 'bk-022', 'bk-006', 'bk-012', 'bk-013', 'bk-028', 'bk-003'],
    constraints: '涉货币/财税的政策联动到宏观经济（邢自强 bk-004、盛松成 bk-014、楼继伟 bk-032、罗志恒 bk-009）。顾云昌 bk-022 已故：仅可引用历史观点。',
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
    constraints: '房企信用风险归行业研究（刘洪玉 bk-026、冯俊 bk-027）。',
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
    candidates: ['bk-020', 'bk-022', 'bk-026', 'bk-016', 'bk-032', 'bk-021'],
    constraints: '顾云昌 bk-022 已故：仅可引用历史观点。',
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
export function topicRouteFor(topic: string): ZhijianRouteTopic | undefined {
  return ROUTE_TOPICS.find(route => topic.includes(route.topic) || route.topic.includes(topic))
}

export function scenarioById(id: string): ZhijianRouteScenario | undefined {
  return ROUTE_SCENARIOS.find(scenario => scenario.id === id)
}

export function scenarioForTopic(
  topic: string,
  framework: ZhijianFrameworkId,
): ZhijianRouteScenario | undefined {
  const byName = ROUTE_SCENARIOS.find(scenario => topic.includes(scenario.name))
  if (byName !== undefined) return byName
  // Fall back to the scenario matching the topic's primary field.
  const route = topicRouteFor(topic)
  if (route === undefined) return undefined
  return ROUTE_SCENARIOS.find(scenario => scenario.primaryField === route.primaryField)
}

/** Whether a field name is a known primary field. */
export function isZhijianField(value: string): value is ZhijianField {
  return value === '宏观经济' || value === '政策制度' || value === '行业研究'
    || value === '城市发展' || value === '居住服务'
}

export type { ZhijianFrameworkId }
