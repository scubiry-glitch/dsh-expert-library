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
| `expert_teams_chat` | P2.1 成员追问通道：向成员发起一轮追问（不重建团队/不新建任务，回合计数累计） |
| `expert_review_route` | 智见点评路由：话题类型 → 输出框架 → 主责领域 → 候选专家（用户拍板）；输出含能力匹配分/命中标签/专家版本/心智模型目录 |
| `expert_review_apply` | 智见点评组队：按拍板结果建队 + 框架任务 DAG（并行研判 → 融合 → 渲染） |
| `expert_review_feedback` | P2.2 专家反馈评分回写（evaluations.jsonl，persona 注入既往反馈摘要） |

### 智见点评领域包（33 位房地产专家 + 1 位银行专家 + 22 位 pipeline 专家，原生数据）

- 专家 id：`bk-002` ~ `bk-034`（五大领域 33 位）+ `bank-09` + `e13-*`（**bank-finance 包**：BANK 零售操盘 + E13 江苏银行高层 3 位）+ `e01-*`/`e08-*`（**pipeline-domains 包**：E01 宏观 9 / E08 房地产 10，公众人物实名，`scripts/sync-pipeline-experts.mjs` 从线上专家库同步）
- Profile JSON 已由 `scripts/build-zhijian-data.mjs` / `scripts/build-bank-data.mjs` **编译为插件原生数据**（`src/zhijian/data/experts.generated.ts` + `src/bank/data/experts.generated.ts`）：风格/立场/金句/禁区/分析步骤在 spawn 时**烘焙进 persona**，成员不需要自己解析资料
- 路由规则原生化为结构化路由表：话题 → 框架（A 五维/B 四段/C 用户视角五层/D 多分类融合/E 顾问式）→ 主责领域 → 候选专家 + 立场对照 + 执行约束；**零售金融/银行经营** 话题已并入同一路由表（共享注册表：bk+bank 双命名空间）
- P1 增强：三维能力索引匹配（领域×标签×立场，候选 ≤5 带理由）、立场对照自动配对（debate 可省略 pro/con）、心智模型注册表反查（`债务-通缩循环 → bk-007`）、专家版本/来源 provenance
- 流程：`expert_review_route` 判题 → 用户拍板选人（匿名呈现「BK · 领域 · 首字母」）→ `expert_review_apply` 建队执行（并行专家研判 → 基调融合 → 讨论稿/正式稿渲染）；框架 E 不建队，队长直接顾问式作答
- 约束内建：口径缺失先问用户、数字必须核实、已故专家（顾云昌 bk-022）只引历史观点、匿名化、文风禁区、**银行 PII 脱敏硬门（pii-redaction：手机号/身份证/银行卡号/账号）**
- **捆绑技能（bank-finance 包）**：`bank-retail-finance-analysis`（银行零售金融五层分析/交叉销售）、`strategy-consulting`（萌翻咨询：假设驱动/金字塔表达）——内容随包分发（`domain-packs/bank-finance/skills/` + `knowledge/skills/`），声明见 `skill-packages/`
- **知识库 = 本地 99wiki**：`bank-99wiki` provider + `bank.99wiki` 知识库声明（projects/银行业研究助手、江苏银行高端信用卡/算力金融/信用卡提质增效、银保渠道、干翻宁波、贝壳合作、feishu 素材等 10 个集合），每位银行专家 knowledgeBindings 绑定 `99wiki` 作用域

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

### 场景 ↔ 外部 skill 绑定（仅本地）

场景（或 `expert_teams_ppt` 的 `skill_id` 参数）可绑定**本地安装**的 skill：

- skill 内容由用户预先放置到 `<workspace>/knowledge/skills/<skillId>/SKILL.md`；运行时**不联网、不自动下载、不自动更新**（上游 GitHub 来源仅作为离线引入时的审计记录，运行时不可访问）
- 路径注入团队描述，成员用文件工具自行阅读参考
- 未安装/非法 id/路径逃逸/超限（1 MiB）时优雅降级为安装提示，不阻断建队
- 实例：`ppt-gen` 场景绑定本地 `video-shotcraft`（Remotion 电影感产品视频）作为可选增强

```yaml
# 自定义场景 JSON 示例（knowledge/scenarios/<id>.json）
{
  "id": "my-ppt",
  "name": "My PPT",
  "description": "…",
  "experts": ["docs-coordinator", "bk-024"],
  "skill": { "id": "video-shotcraft", "purpose": "可选增强" },
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
- **输入校验**：专家/场景 id 必须是安全路径段（字母/数字开头，仅 `._-`，≤64 字符，禁止 `..` 与路径分隔符）；场景任务的 `dependsOn` 只能引用前序任务索引（自依赖/前向引用/循环一律拒绝整个 pack）；`skill.id` 必须是安全本地 skill id，SKILL.md 读取上限 1 MiB（仅本地读取，运行时不联网）；非法 pack 跳过并告警，不会导致插件挂载失败；
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

## V2 能力基座（`@zhijian/dsh-expert-library/v2`）

> Phase 1–4 的 V2 数据/编译/门控层已作为公共子路径导出（`import … from '@zhijian/dsh-expert-library/v2'`；纯数据 + 纯函数，运行时零网络）。**现有 V1 工具（`expert_teams_*` / `expert_review_*` / 协作模式）不受影响、继续可用**；Host 注册与 Web UI 迁移按 `NEXT-GENERATION-ARCHITECTURE.md` 分阶段进行，尚未接线。

- **领域包**：`buildZhijianDomainPack()` 由 32 位专家原生数据构建 `zhijian-realestate` 包；`validateDomainPack()` 做结构/交叉引用校验；`migrateDomainPack()` / `buildLegacyDomainPack()` 提供 V1→V2 兼容迁移（保守映射，均带 `legacySource: 'v1'`）；`loadPackFromDir()` / `loadPackFromFile()` / `mergePackLayers()` 本地装载与确定性覆盖合并（builtin < domain-pack < workspace < request，含 id/版本冲突诊断）。
- **Provider 运行时**：`ProviderRegistry` 按 capability 索引注册 provider manifest（含审计）；`CapabilityResolver` 按 `任务 ∩ 角色 ∩ 已装 provider ∩ 凭据/口径` 解析绑定；`ProviderInvoker` 是 **Host 注入的适配器接口**——v2 模块自身不启动进程、不开网络，具体 transport 适配（mcp-stdio/mcp-http/http-api/local-cli）由 Host 侧接线，尚未内置。
- **模板编译**：`compileExecutionPlan()` 将 TeamTemplate + 场景策略编译为**不可变 ExecutionPlan**（roster + 任务 DAG + 输入/gate/deliverable 绑定 + digest）；每个逻辑任务**盖章其角色槽位的 `expertIds`**（roster 顺序），由后续执行适配器在保持 DAG 依赖的前提下按专家 id **确定性扇出**物理任务（编译器本身不展开物理任务）；同模板 + 同绑定 ⇒ 同构 DAG（可做 golden 对比）。
- **质量门控**：`runQualityChain()` 执行固定门控链（结构 → 数据/引用 → 合规/匿名 → 格式 → 风格 → 语义 → 修复 ≤2 轮 → 终检）；`createBuiltinGateEvaluators()` 提供内置确定性 gate（`schema-structure` / `data-citation` / `compliance-anonymization` / `style-lint`）。**已接线到任务完成环节**：`expert_teams_update_task` 将任务置为 `completed` 时，会评估团队计划的质量链（编译计划在 apply 时盖章 `qualityPlan`；无计划/无可解析策略的 ad-hoc 团队行为不变）——硬 gate 失败会**阻止完成**并返回含 gate id/原因/修改指引的结构化错误（任务保持 claimed，成员修改输出后重试），软 gate 产生附加到任务结果的警告；修复预算 ≤2 轮，超过后第三次完成尝试可带警告放行。每次门控运行还会派生一个 0–100 聚合分并**幂等写入任务标题**（如「融合成文 〔质 92〕」；硬门未过时如「〔质 39·硬门未过〕」），活动面板直接可见。计分规则（`deriveQualityScore`，透明可审计）：**硬门全过 = 基础 80 + 软门通过比例 ×20**（无软门视为比例 1 → 100；软门有 warn 视为未完全通过）；**任一硬门未过 = 低分区 0–59 × 整体通过比例**。**输出 schema 强制校验**：策略声明 `schema-structure` 且任务绑定可解析 outputTemplate 契约时，完成时注入契约驱动结构门——输出必须满足计划声明的输出 schema（JSON 模板须可解析；markdown 模板须包含全部必填章节标记），缺失时以 correction 指出；legacy/collab/ad-hoc 团队不受影响。**强制恢复**：任务完成写回时，`qualityScore` 与 `repairCount`（已用修复轮数 = 硬门阻断次数）由系统侧恒写入工具结果与 `output/result.json`（无质量策略的团队记 `qualityScore: null` 但字段恒在，不依赖成员输出自觉），工具 text 输出与 `expert_teams_status`/活动面板同步显示「质量分 X ｜ 修复 N 轮」。智见点评的匿名化检查（已故专家 bk-022、对外只列「领域·首字母」）经由同一路径执行。
- 阶段迁移与验收见 `NEXT-GENERATION-ARCHITECTURE.md` §11；回归测试见 `test/v2-*.test.mjs`。

## 项目结构

```
src/
├── index.ts                  # 入口：系统提示协议 + 工具注册 + Web 路由
├── tools.ts                  # 11 个 expert_teams_* 工具（含 scenario_apply + chat 追问）+ 可复用核心
├── members.ts                # 成员子代理生命周期 + 专家 persona（expertMemberPersona）
├── state.ts                  # 持久化/锁/任务状态机（原插件移植）
├── scheduler.ts              # 事件驱动共享任务调度（原插件移植）
├── snapshot.ts / events.ts / event-types.ts   # 面板快照与会话事件（移植）
├── types.ts                  # TeamState（新增 scenarioId 字段）
├── knowledge.ts              # 知识包目录约定 + 知识指引（含 VERSION 版本锚点，P2.4）
├── skills.ts                 # ★ 外部 skill 绑定：仅本地解析/降级（场景可挂 skill，运行时不联网）
├── expert-library/           # 通用专家库：类型/内置专家/内置场景/注册表
├── bank/                     # ★ BANK 命名空间原生数据（build-bank-data.mjs 生成）
│   └── data/experts.generated.ts   # bank-09 王一帆（零售金融/银行经营）
├── pipeline/                  # ★ pipeline 命名空间原生数据（build-pipeline-data.mjs 生成）
│   └── data/experts.generated.ts   # e01-* 宏观 / e08-* 房地产 / e13-* 江苏银行
├── zhijian/                  # ★ 智见点评领域子系统（原生数据）
│   ├── types.ts              # 领域类型（专家 meta/路由/框架/ReviewMeta）
│   ├── data/experts.generated.ts  # ★ 33 位专家原生数据（脚本生成，勿手改）
│   ├── capability.ts         # ★ P1 三维能力索引/匹配 + 心智模型注册表
│   ├── evaluations.ts        # ★ P2.2 专家反馈评分回写（evaluations.jsonl）
│   ├── routing.ts            # ★ 原生路由表（话题→框架→主责领域→候选；含 bank 话题与立场配对）
│   ├── frameworks.ts         # ★ 框架 A/B/C/D/E 模板与全局输出规则
│   ├── registry.ts           # ★ meta → Expert 注册（bk+bank 单一合并注册表）
│   ├── persona.ts            # ★ Profile 烘焙 persona（zhijianExpertPersona）
│   └── tools.ts              # ★ expert_review_route / apply / feedback
└── collab/
    └── tools.ts              # ★ 协作模式：debate（可自动立场配对）/ roundtable / ppt / report
scripts/
├── build-zhijian-data.mjs    # BK 资料包 → 原生数据生成脚本
├── build-bank-data.mjs       # BANK 资料包 → 原生数据生成脚本
├── build-zhijian-pack.mjs    # zhijian-realestate 领域包发射器
├── build-bank-pack.mjs       # bank-finance 领域包发射器（共享 pack-common）
├── build-packs.mjs           # ★ 多包驱动（构建/漂移检查唯一入口）
├── pack-common.mjs           # ★ 共享确定性发射器（实体写入/自验/树摘要）
├── verify-bk-sources.mjs     # ★ P0.3 BK 素材交叉核对（政研通/feishu vs 包内 raw）
├── import-persons.mjs        # ★ P2.3 人物转专家半自动管线（逐字稿→画像草稿）
├── sync-pipeline-experts.mjs  # ★ P3.1 pipeline 剩余专家同步（线上归一化→标准 Profile→roster）
├── build-pipeline-data.mjs    # pipeline 命名空间 → 原生数据生成
└── build-pipeline-pack.mjs    # pipeline-domains 领域包发射器（共享 pack-common）
```

## 开发验证

```sh
pnpm typecheck   # TS 类型检查（host + client）
pnpm test        # 构建 + node --test（输入边界与路由回归，见 test/）
pnpm build       # 完整构建（tsc + client bundle）
```

## 说明

- **与 dsh-agent-teams 的关系**：fork 后独立迭代，注册面全部改名——工具 `expert_teams_*`、会话事件 `expert-teams/*`、HTTP 路由 `/plugins/dsh-expert-library/*`、状态目录 `.expert-teams`。原插件与本插件**互不依赖、互不冲突**，可同时安装；是否同时启用由你决定（两套队长协议同时在系统提示中时模型可能混淆，建议按需启用其一）。
- 状态持久化在 `<workspace>/.expert-teams/`，删除团队时归档到 `archive/` 供复盘。
- **建队是事务性的**：场景/协作模式组装团队时先全量校验专家引用；成员或任务创建中途失败会自动回滚（成员退役 + 中断 + 状态归档），不会留下卡住队长单团队配额的半成品团队。
- **mailbox 跨进程安全**：邮箱 JSONL 的追加与确认经 O_EXCL 锁文件跨进程互斥（含崩溃持有者 30s 超时接管、10s 等待后降级直写），两个 DSH 进程同时投递不会丢消息。
- **状态恢复引用完整性**：`team.json` 恢复时校验任务依赖存在性、依赖无环、assignee 必须是现存成员，损坏记录会被拒绝而不是带着悬空引用继续授权。
- Web 活动面板（原插件的 client 部分）已随插件打包（`lib/client.js`，exports `"./client"`）：活动面板、团队卡片与设置卡片在 Web UI 插件配置页可用。
