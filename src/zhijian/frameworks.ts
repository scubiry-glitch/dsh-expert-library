/**
 * Output framework specs (专家输出框架规范_20260809.md) — native templates for
 * the review task DAG and the final render.
 * @module dsh-expert-library/zhijian/frameworks
 */

import type { ZhijianFrameworkId, ZhijianFrameworkSpec } from './types.ts'

export const FRAMEWORKS: readonly ZhijianFrameworkSpec[] = [
  {
    id: 'A',
    name: '五维递进',
    appliesTo: '城市月度市场分析解读',
    steps: [
      '一句话定性（结论先行，直接给判断）',
      '指标解读 2-3 项（数字克制、带口径）',
      '趋势预测（落脚量价与筑底）',
      '不确定性 1-2 条',
      '关注指标',
    ],
    wordLimit: '约 500 字 ±10%（超 550 或低于 450 提示重写）',
    outputSections: ['一句话定性', '指标 2-3 项', '趋势预测', '不确定性', '关注指标'],
    constraints: [
      '连续一段无小标题',
      '结论先行',
      '禁通用套话/引导语/声明式开场',
      '解读紧扣给定城市当期的具体数据与市场状态',
    ],
  },
  {
    id: 'B',
    name: '通用四段式',
    appliesTo: '政策解读 / 宏观形势 / 金融风险 / 城市机会 / 行业经营 / 服务业务 / 制度设计',
    steps: [
      '关键性结论',
      '关键事实及其变化',
      '归因分析',
      '收尾（洞察 + 展望 + 不确定性）',
    ],
    outputSections: ['关键性结论', '关键事实及其变化', '归因分析', '收尾'],
    constraints: ['无字数上限', '结论先行', '数字带口径', '禁止通用套话'],
  },
  {
    id: 'C',
    name: '用户视角五层',
    appliesTo: '特定问题/目标城市形势判断（"X市见底了吗"）',
    steps: [
      '一句话结论',
      '三句话记忆点',
      '条件清单（每条=指标+口径来源+阈值+验证周期，四要素缺一按零信息）',
      '补数路径（缺什么+去哪拿+怎么校准，禁只说缺数据）',
      '防误导清单（地王≠见底、单月网签≠见底、70城均值≠目标城市、政策≠见底）',
    ],
    outputSections: ['一句话结论', '记忆点', '条件清单', '补数路径', '防误导清单'],
    constraints: [
      '结论先行',
      '数字带口径',
      '城市本地为主（通用≤1/3 且标口径）',
      '阈值冲突显式说明',
      '不输出行动建议',
    ],
  },
  {
    id: 'D',
    name: '多分类多专家融合',
    appliesTo: '跨领域综合分析（"该不该买""何时企稳""政策全链条影响"）',
    steps: [
      '核心结论（即主基调 keynote）',
      '关键事实与分析（按分类，只保留支撑主基调的论证）',
      '不确定性与趋势（偏离主基调的观点转边界条件/风险提示）',
      '未来关注（文字条目，不列表格）',
    ],
    outputSections: ['核心结论', '关键事实与分析', '不确定性与趋势', '未来关注'],
    constraints: [
      '问题拆 2~4 分类，每类 ≥2 专家（标签互补）',
      '主基调为锚：融合而非陈列分歧',
      '分类内融合、跨分类整合',
      '向用户展示候选时匿名：只列「BK-NNN · 主领域 · 首字母」',
    ],
  },
  {
    id: 'E',
    name: '专家式顾问',
    appliesTo: '自由提问 / FAQ / 购房决策 / 政策逻辑问答',
    steps: [
      '直判定调（"不是X而是Y"正名式）',
      '框架拆解（一问一框架：城市/板块/房子；自住/改善/投资；六维抗跌；四维投资；产业-人口-配套）',
      '破除误区',
      '量化阈值（月供≤税后35%、租金回报率≥3%好/2-3%主流/<2%谨慎、挂牌成交比<8:1好/>10:1供大于求/>15:1积压、满二免增值税/满五唯一免个税）',
      '可操作落点（看什么指标/比什么/用什么标准，不武断下"该买/不该买"指令）',
      '口径校准提醒（当期政策数字按最新校准）',
    ],
    outputSections: ['直判定调', '框架拆解', '破除误区', '量化阈值', '可操作落点', '口径校准'],
    constraints: [
      '单一顾问口吻、中性市场观察者视角，不按购房者/业主/经纪人角色拆分',
      '不拆分类、不列专家、不标「分类+首字母」；可内部援引专家方法论不外显来源',
      '简答版默认：自然行文 ≤2000 字、六段骨架内化为行文、结尾「总结一下：」；详细版可显式六段超 2000 字',
      '讨论稿正文前加一行「问题类型/路由」+「选取专家分类」；正式稿不写该首段',
      '涉及具体城市/当期/具体房源的任何硬数字必须先 WebSearch 核实；无法核实时只给框架与方向并注明"具体数字需核实"',
      '文风禁区：禁课堂式过渡句（"容易踩坑""记住""我来拆解一下"），用平实陈述；转折词一篇 ≤1-2 次',
    ],
  },
]

/** Framework lookup by id. */
export function frameworkById(id: ZhijianFrameworkId): ZhijianFrameworkSpec | undefined {
  return FRAMEWORKS.find(framework => framework.id === id)
}

/** Global output rules shared by every framework (SKILL.md 输出形态/基调/数字核实). */
export const GLOBAL_OUTPUT_RULES: readonly string[] = [
  '匿名化：对外只列「分类（主领域）+ 姓名首字母」，不列全名/流派；内部路由保留 BK 号/实名供定位。',
  '讨论稿（默认）：顶部「数据口径/方法/匿名化」三行 + 分类副标题 + 正文关键处标「分类·首字母」+ 文末框架/口径/心智模型元信息。',
  '正式稿（用户说"正式稿/外发/可发布/对外"）：去全部标注与元信息，仅留一行数据来源。',
  '基调融合：先定主基调 keynote（据数据事实判定；用户指定基调则严格跟随）；支撑主基调的论证保留，偏离的观点降级为边界条件/风险提示（"若 X 成立，基调需下修"），不作"另一派"并列。',
  '数字必须核实：涉及具体城市/当期/具体房源的任何硬数字必须先 WebSearch 核实来源；无法核实时只给框架与方向并注明"具体数字需核实"。编数字比不回答更严重。',
  '已故/停更专家只可引用历史观点，不得臆造或推断其近期言论，引用注明时间背景。',
  '口径缺失必须先问用户，不生成点评。',
  '文风禁区（防 AI 腔）：禁课堂式过渡句（"容易踩坑""记住""我们来拆解一下"），用平实陈述（"值得关注的是""需要留意的是"）；同篇不重复同款过渡句式；转折词一篇 ≤1-2 次；读感像有经验的从业者。',
]

/** Build one expert's review task description from the framework spec. */
export function expertReviewTaskDescription(
  expertName: string,
  framework: ZhijianFrameworkSpec,
  dataContext: string,
): string {
  return `以专家「${expertName}」的身份独立研判，输出框架：${framework.name}（${framework.appliesTo}）。

数据背景：
${dataContext}

按框架步骤产出（保持专家本人的立场、风格与金句口吻）：
${framework.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}

${framework.wordLimit !== undefined ? `字数约束：${framework.wordLimit}\n` : ''}约束：
${[...framework.constraints, '匿名标注：文内引用身份只标「领域·首字母」，不写全名。'].map((rule, index) => `${index + 1}. ${rule}`).join('\n')}

完成后：调用 expert_teams_update_task 提交 output（含完整点评文本与匿名标注），并向队长 expert_teams_send_message 汇报要点。`
}
