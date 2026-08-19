/**
 * Builtin task scenarios.
 *
 * Each scenario presets: which experts to assemble, a task DAG with
 * dependencies (indexes into the tasks array), and the final deliverable.
 * `expert_teams_scenario_apply` creates the team, adds the experts as members
 * (with their preset AI model routes), and seeds the task DAG in one call.
 * @module dsh-expert-library/expert-library/builtin-scenarios
 */

import type { Scenario } from './types.ts'

export const BUILTIN_SCENARIOS: readonly Scenario[] = [
  {
    id: 'code-review',
    name: 'Code Review Team',
    description: '审查指定代码变更/提交区间：先梳理变更全貌，再从性能、安全、质量三个角度分工审查，最后输出一份带严重级别的问题汇总报告。',
    experts: ['researcher', 'engineer', 'qa-engineer', 'security-reviewer'],
    tasks: [
      {
        subject: '梳理变更全貌',
        description: '列出变更范围（提交/文件/模块）、变更意图与风险面，供后续审查分工使用。',
        expert: 'researcher',
      },
      {
        subject: '性能与实现审查',
        description: '审查实现质量：算法复杂度、资源使用、并发与错误处理、可维护性。',
        dependsOn: [0],
        expert: 'engineer',
      },
      {
        subject: '安全审查',
        description: '从攻击者视角审查输入处理、鉴权、密钥、注入面与供应链风险，给出严重级别与缓解方案。',
        dependsOn: [0],
        expert: 'security-reviewer',
      },
      {
        subject: '测试与回归审查',
        description: '评估测试覆盖，设计补充测试用例，验证变更是否破坏既有行为。',
        dependsOn: [1, 2],
        expert: 'qa-engineer',
      },
      {
        subject: '汇总审查报告',
        description: '合并各审查结论，输出按严重级别排序的问题清单、结论与修改建议。',
        dependsOn: [1, 2, 3],
        expert: 'researcher',
      },
    ],
    deliverable: '一份代码审查报告：变更概述、按严重级别排序的问题清单（含复现步骤/定位）、修复建议、总体结论。',
  },
  {
    id: 'market-research',
    name: 'Market Research Team',
    description: '对指定市场/主题做调研：先界定问题与搜集资料，再做数据分析与竞品对比，最后输出结构化的调研报告。',
    experts: ['researcher', 'data-analyst', 'docs-coordinator'],
    tasks: [
      {
        subject: '界定调研问题',
        description: '把目标转成可回答的调研问题清单，确定信息需求与口径。',
        expert: 'researcher',
      },
      {
        subject: '资料搜集与整理',
        description: '按问题清单搜集资料（市场报告、竞品、用户反馈），记录来源与日期。',
        dependsOn: [0],
        expert: 'researcher',
      },
      {
        subject: '数据分析',
        description: '对可量化的数据做统计与分析（规模、增速、份额、价格带），说明口径与假设。',
        dependsOn: [1],
        expert: 'data-analyst',
      },
      {
        subject: '撰写调研报告',
        description: '整合资料与数据，输出结构化调研报告：结论、依据、风险与开放问题。',
        dependsOn: [2],
        expert: 'docs-coordinator',
      },
    ],
    deliverable: '一份调研报告：执行摘要、核心数据（含来源）、竞品对比、结论与建议、开放问题。',
  },
  {
    id: 'product-design',
    name: 'Product Design Team',
    description: '从需求到设计方向：先调研用户与场景，再产出设计方向与交互流程，最后形成可实施的设计说明。',
    experts: ['researcher', 'designer', 'docs-coordinator'],
    tasks: [
      {
        subject: '用户与场景调研',
        description: '明确目标用户、核心场景、痛点和约束条件。',
        expert: 'researcher',
      },
      {
        subject: '设计方向与交互流程',
        description: '基于调研产出设计方向（视觉基调、信息架构）与核心交互流程，附取舍理由。',
        dependsOn: [0],
        expert: 'designer',
      },
      {
        subject: '设计说明文档',
        description: '把设计整理成可实施说明：页面/组件清单、状态与边界、验收要点。',
        dependsOn: [1],
        expert: 'docs-coordinator',
      },
    ],
    deliverable: '一份设计说明：用户与场景结论、设计方向、交互流程、组件与状态清单、验收要点。',
  },
  {
    id: 'fullstack-build',
    name: 'Fullstack Build Team',
    description: '按需求完成一个端到端功能：设计先行，工程师实现，QA 验证，最后交付可运行的成果与说明。',
    experts: ['designer', 'engineer', 'qa-engineer'],
    tasks: [
      {
        subject: '设计实现方案',
        description: '把需求转成实现方案：界面结构、数据流、接口约定、技术选型。',
        expert: 'designer',
      },
      {
        subject: '后端/数据层实现',
        description: '按方案实现服务端与数据层，保证接口与数据约定一致。',
        dependsOn: [0],
        expert: 'engineer',
      },
      {
        subject: '前端/交互实现',
        description: '按方案实现前端界面与交互，对接后端接口。',
        dependsOn: [1],
        expert: 'engineer',
      },
      {
        subject: '测试与验证',
        description: '按需求设计并执行测试，覆盖主流程与边界，输出测试结果。',
        dependsOn: [2],
        expert: 'qa-engineer',
      },
      {
        subject: '交付说明',
        description: '汇总实现成果：功能清单、如何运行、已知问题与后续建议。',
        dependsOn: [3],
        expert: 'qa-engineer',
      },
    ],
    deliverable: '可运行的实现 + 交付说明：功能清单、运行方式、测试结果、已知问题。',
  },
  {
    id: 'security-audit',
    name: 'Security Audit Team',
    description: '对指定目标（代码/配置/依赖）做系统化安全审计：威胁建模先行，逐面审查，输出带缓解方案的审计报告。',
    experts: ['security-reviewer', 'engineer', 'docs-coordinator'],
    tasks: [
      {
        subject: '威胁建模',
        description: '明确资产、信任边界、攻击者能力，建立威胁清单。',
        expert: 'security-reviewer',
      },
      {
        subject: '漏洞面审查',
        description: '按威胁清单审查输入处理、鉴权授权、密钥管理、注入面与供应链。',
        dependsOn: [0],
        expert: 'security-reviewer',
      },
      {
        subject: '修复方案验证',
        description: '对确认的问题给出具体修复方案，并验证方案可行性。',
        dependsOn: [1],
        expert: 'engineer',
      },
      {
        subject: '审计报告',
        description: '输出审计报告：威胁模型、按严重级别排序的发现、修复方案、复测建议。',
        dependsOn: [2],
        expert: 'docs-coordinator',
      },
    ],
    deliverable: '一份安全审计报告：威胁模型、发现清单（严重级别+复现+缓解方案）、修复优先级与复测建议。',
  },
  {
    id: 'documentation',
    name: 'Documentation Team',
    description: '针对指定主题产出高质量文档：先研究梳理，再写作，最后校对定稿。',
    experts: ['researcher', 'docs-coordinator'],
    tasks: [
      {
        subject: '资料研究与提纲',
        description: '搜集并梳理素材，确定读者对象，输出文档提纲。',
        expert: 'researcher',
      },
      {
        subject: '文档写作',
        description: '按提纲完成初稿：结构清晰、术语一致、含示例与代码块。',
        dependsOn: [0],
        expert: 'docs-coordinator',
      },
      {
        subject: '校对与定稿',
        description: '对照素材校对准确性，统一风格与格式，输出终稿。',
        dependsOn: [1],
        expert: 'docs-coordinator',
      },
    ],
    deliverable: '定稿文档：目标读者说明、正文、术语表（如需要）、修订记录。',
  },
  {
    id: 'cross-debate',
    name: 'Cross Debate Team',
    description: '交叉辩论：立场对立的两位专家就同一议题立论-反驳-回应，主持专家裁判总结。默认组合为示例（丁祖昱 vs 付鹏），可替换为任意立场对立组合。',
    experts: ['team-lead', 'bk-024', 'bk-008'],
    tasks: [
      {
        subject: '辩题与规则确认',
        description: '明确辩题、双方立场与判定标准（论据须带口径与来源），输出辩论议程。',
        expert: 'team-lead',
      },
      {
        subject: '正方立论',
        description: '陈述立场与核心论据（数据带口径、引用来源），结构：立场声明 → 论据 2-3 条 → 预期对方弱点。',
        dependsOn: [0],
        expert: 'bk-024',
      },
      {
        subject: '反方反驳',
        description: '逐条反驳正方论据并给出反论据，结构：反驳点 → 反论据（带口径）→ 正方立场中的漏洞。',
        dependsOn: [1],
        expert: 'bk-008',
      },
      {
        subject: '正方回应',
        description: '回应反驳：承认有效点、澄清误解、强化核心立场。',
        dependsOn: [2],
        expert: 'bk-024',
      },
      {
        subject: '裁判总结',
        description: '输出辩论纪要：双方核心论点、交锋点、共识、分歧、判定逻辑与最终观点（不强制二选一，可给条件性结论）。',
        dependsOn: [3],
        expert: 'team-lead',
      },
    ],
    deliverable: '辩论纪要：辩题与规则、双方立论/反驳/回应要点、交锋点、共识与分歧、裁判结论。',
  },
  {
    id: 'roundtable',
    name: 'Roundtable Team',
    description: '圆桌研讨：多位专家就同一议题独立发言（并行），纪要将共识/分歧/开放问题整理成文。',
    experts: ['bk-004', 'bk-005', 'bk-008', 'docs-coordinator'],
    tasks: [
      {
        subject: '专家发言：邢自强',
        description: '以本人立场独立发言：核心判断 → 依据（数据带口径）→ 前瞻。',
        expert: 'bk-004',
      },
      {
        subject: '专家发言：任泽平',
        description: '以本人立场独立发言：核心判断 → 依据（数据带口径）→ 前瞻。',
        expert: 'bk-005',
      },
      {
        subject: '专家发言：付鹏',
        description: '以本人立场独立发言：核心判断 → 依据（数据带口径）→ 前瞻。',
        expert: 'bk-008',
      },
      {
        subject: '圆桌纪要整理',
        description: '综合全部发言整理纪要：共识点、分歧点（含各自依据）、开放问题、后续可验证的观察指标。',
        dependsOn: [0, 1, 2],
        expert: 'docs-coordinator',
      },
    ],
    deliverable: '圆桌纪要：各专家核心观点（匿名标注）、共识、分歧、开放问题、观察指标。',
  },
  {
    id: 'ppt-gen',
    name: 'PPT Generation Team',
    description: 'PPT 生成：先做内容架构（听众/目标/大纲），再供给领域内容，最后产出逐页文案与演讲备注（markdown 结构化，可直接导入 PPT 工具）。',
    experts: ['docs-coordinator', 'designer', 'bk-024'],
    skill: {
      repo: 'Vincentwei1021/video-shotcraft',
      name: 'video-shotcraft',
      purpose: '可选增强：若用户同时需要产品视频/宣传片（Remotion 电影感视频），按该 skill 制作；其 SKILL.md 作为参考。',
    },
    tasks: [
      {
        subject: '内容架构',
        description: '确定听众、目标与篇幅（页数/时长），输出 PPT 大纲：章节结构 + 每页标题与要点。',
        expert: 'docs-coordinator',
      },
      {
        subject: '领域内容供给',
        description: '按大纲供给关键数据、结论与案例（数字带口径与来源），标注每页建议引用。',
        dependsOn: [0],
        expert: 'bk-024',
      },
      {
        subject: '逐页文案生成',
        description: '按大纲与内容产出逐页文案：封面/目录/每页标题+要点（每页≤5 条）/图表建议/演讲备注，markdown 结构化输出。',
        dependsOn: [0, 1],
        expert: 'docs-coordinator',
      },
    ],
    deliverable: 'PPT 内容包（markdown）：封面、目录、逐页标题+要点、图表建议、演讲备注，可直接导入 PPT 工具排版。',
  },
  {
    id: 'research-report',
    name: 'Research Report Team',
    description: '研报生成：资料梳理先行，多位专家并行研判（宏观/风险等视角），融合成结构完整的研报（摘要/正文/结论/风险/附录）。',
    experts: ['researcher', 'bk-004', 'bk-007', 'docs-coordinator'],
    tasks: [
      {
        subject: '资料与数据梳理',
        description: '梳理主题相关资料与数据：关键事实、数据口径、时间线、争议点。',
        expert: 'researcher',
      },
      {
        subject: '宏观研判',
        description: '从宏观经济视角研判：周期定位、政策路径、量化测算（数据带口径）。',
        dependsOn: [0],
        expert: 'bk-004',
      },
      {
        subject: '风险与债务视角',
        description: '从债务金融视角研判：风险点、债务-通缩风险、关键监控指标。',
        dependsOn: [0],
        expert: 'bk-007',
      },
      {
        subject: '融合成文',
        description: '整合全部研判输出完整研报：标题、摘要、正文（背景/分析/展望）、结论、风险提示、附录（数据与口径）。',
        dependsOn: [1, 2],
        expert: 'docs-coordinator',
      },
    ],
    deliverable: '完整研报（markdown）：标题、摘要、正文、结论、风险提示、附录（数据与口径）。',
  },
]

/** Builtin scenario lookup by id. */
export const BUILTIN_SCENARIO_BY_ID: ReadonlyMap<string, Scenario> = new Map(
  BUILTIN_SCENARIOS.map((scenario) => [scenario.id, scenario]),
)
