# dsh-expert-library（专家库系统）

[fork 自 dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) 并**独立迭代**的专家库系统——所有注册面已改名（`expert_teams_*` 工具、`expert-teams/*` 会话事件、`/plugins/dsh-expert-library/*` 路由、`.expert-teams` 状态目录），不再依赖也不与原插件冲突，可与原插件共存于同一 profile：

- **预置专家 AI 模型**：每位内置专家绑定自己的 persona、LLM 路由（provider/model/reasoningEffort）与知识指引，建队即生效，无需逐个询问用户选模型；
- **任务场景模板**：`expert_teams_scenario_apply` 一键按场景建队——自动添加预设专家、自动生成带依赖的任务 DAG；
- **知识包接入**：`<workspace>/knowledge/{experts,scenarios,shared}/` 目录即插即用，成员 persona 自动获得对应资料指引，**惰性生效**（放入文件后下次唤醒即读到，无需重启/重新构建）；
- 保留原插件的全部协作能力：attempt 代际转派、退役守卫、冷恢复续跑、双通道消息投递、活动面板数据路由。

## 安装

```sh
cd dsh-expert-library
pnpm install
pnpm build
dsh plugin --profile web add .
```

重启 DSH 并刷新 Web UI 后，直接用自然语言驱动：

> 用专家库做一次代码审查，审查范围是 v0.5.3 之后的提交

> 用专家库做市场调研：桌面端 AI 编程工具的定价趋势

## 使用方式

| 方式 | 说明 |
|---|---|
| `expert_teams_scenario_apply` | 按场景一键建队（推荐）：创建团队 → 添加专家成员（含预置模型路由与 persona）→ 生成任务 DAG |
| `expert_teams_add_member(expert=…)` | 手动建队时按专家档案添加成员 |
| `expert_teams_add_member(name=…)` | 普通成员（行为同原插件） |
| `expert_review_route` | 智见点评路由：话题类型 → 输出框架 → 主责领域 → 候选专家（用户拍板） |
| `expert_review_apply` | 智见点评组队：按拍板结果建队 + 框架任务 DAG（并行研判 → 融合 → 渲染） |

### 智见点评领域包（32 位房地产专家，原生数据）

- 专家 id：`bk-002` ~ `bk-033`（五大领域：宏观经济 9 / 政策制度 8 / 行业研究 8 / 城市发展 3 / 居住服务 4）
- Profile JSON 已由 `scripts/build-zhijian-data.mjs` **编译为插件原生数据**（`src/zhijian/data/experts.generated.ts`）：风格/立场/金句/禁区/分析步骤在 spawn 时**烘焙进 persona**，成员不需要自己解析资料
- 路由规则原生化为结构化路由表：话题 → 框架（A 五维/B 四段/C 用户视角五层/D 多分类融合/E 顾问式）→ 主责领域 → 候选专家 + 立场对照 + 执行约束
- 流程：`expert_review_route` 判题 → 用户拍板选人（匿名呈现「BK · 领域 · 首字母」）→ `expert_review_apply` 建队执行（并行专家研判 → 基调融合 → 讨论稿/正式稿渲染）；框架 E 不建队，队长直接顾问式作答
- 约束内建：口径缺失先问用户、数字必须核实、已故专家（顾云昌 bk-022）只引历史观点、匿名化、文风禁区

### 内置专家（8 位通用，均预置 `deepseek-official/deepseek-v4-flash` 路由）

| id | 角色 | 适用场景 |
|---|---|---|
| `researcher` | 调研分析 | market-research / product-design / documentation |
| `engineer` | 软件工程 | fullstack-build / code-review / security-audit |
| `qa-engineer` | 质量保障 | code-review / fullstack-build |
| `security-reviewer` | 安全审计 | security-audit / code-review |
| `designer` | 产品/UI 设计 | product-design / fullstack-build |
| `docs-coordinator` | 文档写作 | documentation / market-research / security-audit |
| `data-analyst` | 数据分析 | market-research |
| `team-lead` | 团队协调 | code-review / market-research / security-audit |

### 内置场景（10 个）

| id | 团队构成 | 任务 DAG |
|---|---|---|
| `code-review` | researcher + engineer + qa + security | 变更梳理 → (性能审查 ‖ 安全审查) → 测试回归 → 汇总报告 |
| `market-research` | researcher + data-analyst + docs | 界定问题 → 资料搜集 → 数据分析 → 调研报告 |
| `product-design` | researcher + designer + docs | 用户调研 → 设计方向/交互 → 设计说明 |
| `fullstack-build` | designer + engineer + qa | 方案设计 → 后端 → 前端 → 测试验证 → 交付说明 |
| `security-audit` | security + engineer + docs | 威胁建模 → 漏洞审查 → 修复验证 → 审计报告 |
| `documentation` | researcher + docs | 资料梳理/提纲 → 写作 → 校对定稿 |
| `cross-debate` | team-lead + bk-024 vs bk-008 | 规则确认 → 正方立论 → 反方反驳 → 正方回应 → 裁判总结 |
| `roundtable` | bk-004 + bk-005 + bk-008 + docs | 各专家独立发言（并行）→ 圆桌纪要 |
| `ppt-gen` | docs + designer + bk-024 | 内容架构 → 领域内容供给 → 逐页文案+备注 |
| `research-report` | researcher + bk-004 + bk-007 + docs | 资料梳理 → 并行研判 → 融合成文 |

> 后 4 个协作场景另有参数化工具（`expert_teams_debate` / `expert_teams_roundtable` / `expert_teams_ppt` / `expert_teams_report`），可按任意专家组合动态组队。

### 场景 ↔ 外部 skill 绑定

场景（或 `expert_teams_ppt` 的 `skill_repo` 参数）可绑定 GitHub 上的任意 skill：

- 应用场景时自动拉取该 repo 的 `SKILL.md`，缓存到 `<workspace>/knowledge/skills/<owner>-<repo>/SKILL.md`（首次联网拉取，之后离线可用）
- 缓存路径注入团队描述，成员用文件工具自行阅读参考
- 拉取失败优雅降级（提示手动放置，不阻断建队）
- 实例：`ppt-gen` 场景绑定 `Vincentwei1021/video-shotcraft`（Remotion 电影感产品视频）作为可选增强

```yaml
# 自定义场景 JSON 示例（knowledge/scenarios/<id>.json）
{
  "id": "my-ppt",
  "name": "My PPT",
  "description": "…",
  "experts": ["docs-coordinator", "bk-024"],
  "skill": { "repo": "Vincentwei1021/video-shotcraft", "purpose": "可选增强" },
  "tasks": [ { "subject": "…" } ],
  "deliverable": "…"
}
```

## 知识包（资料包）

```
<workspace>/knowledge/
├── experts/<expertId>/…        # 专家专属资料
├── scenarios/<scenarioId>/…    # 场景专属资料
└── shared/…                    # 共享资料
```

- 成员 persona 会注入知识指引（列出其目录与文件清单），成员用文件/阅读工具自行查阅；
- 自定义专家/场景 JSON（`experts/<id>.json`、`scenarios/<id>.json`）可覆盖内置定义，字段见 `src/expert-library/types.ts`；
- 详见 `knowledge/README.md`。

## 模型路由优先级

```
专家预置路由 (expert.model)
  > 显式参数 (provider/model/reasoning_effort)
  > 插件配置 memberModel
  > 队长当前路由（含 reasoningEffort 快照）
```

## 配置（cordis.patch.yml）

```yaml
- insert:
    - id: expert-library
      name: '@zhijian/dsh-expert-library'
      config:
        stateDir: .expert-teams        # 团队状态目录
        knowledgeDir: knowledge       # 知识包目录
        memberProvider: spawn         # 子代理后端（spawn/fork）
        # memberModel:                # 全局默认模型路由
        #   provider: deepseek-official
        #   model: deepseek-v4-flash
        #   reasoningEffort: max
        memberMaxDepth: 1
        maxMembers: 8
```

## 项目结构

```
src/
├── index.ts                  # 入口：系统提示协议 + 工具注册 + Web 路由
├── tools.ts                  # 11 个 expert_teams_* 工具（含 scenario_apply）+ 可复用核心
├── members.ts                # 成员子代理生命周期 + 专家 persona（expertMemberPersona）
├── state.ts                  # 持久化/锁/任务状态机（原插件移植）
├── scheduler.ts              # 事件驱动共享任务调度（原插件移植）
├── snapshot.ts / events.ts / event-types.ts   # 面板快照与会话事件（移植）
├── types.ts                  # TeamState（新增 scenarioId 字段）
├── knowledge.ts              # 知识包目录约定与成员知识指引
├── skills.ts                 # ★ 外部 skill 绑定：拉取/缓存/降级（场景可挂 skill）
├── expert-library/           # 通用专家库：类型/内置专家/内置场景/注册表
├── zhijian/                  # ★ 智见点评领域子系统（原生数据）
│   ├── types.ts              # 领域类型（专家 meta/路由/框架/ReviewMeta）
│   ├── data/experts.generated.ts  # ★ 32 位专家原生数据（脚本生成，勿手改）
│   ├── routing.ts            # ★ 原生路由表：话题→框架→主责领域→候选专家
│   ├── frameworks.ts         # ★ 框架 A/B/C/D/E 模板与全局输出规则
│   ├── registry.ts           # meta → Expert 注册（并入专家库注册表）
│   ├── persona.ts            # ★ Profile 烘焙 persona（zhijianExpertPersona）
│   └── tools.ts              # ★ expert_review_route / expert_review_apply
└── collab/
    └── tools.ts              # ★ 协作模式：debate / roundtable / ppt / report
scripts/
└── build-zhijian-data.mjs    # 资料包 → 原生数据生成脚本
```

## 说明

- **与 dsh-agent-teams 的关系**：fork 后独立迭代，注册面全部改名——工具 `expert_teams_*`、会话事件 `expert-teams/*`、HTTP 路由 `/plugins/dsh-expert-library/*`、状态目录 `.expert-teams`。原插件与本插件**互不依赖、互不冲突**，可同时安装；是否同时启用由你决定（两套队长协议同时在系统提示中时模型可能混淆，建议按需启用其一）。
- 状态持久化在 `<workspace>/.expert-teams/`，删除团队时归档到 `archive/` 供复盘。
- Web 活动面板（原插件的 client 部分）本版本暂未打包，仅保留 Host 侧数据路由；UI 可在后续版本接入。
