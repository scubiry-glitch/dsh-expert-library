# dsh-agent-teams 与 dsh-expert-library 架构分析对比

> 版本：原插件 `@nanmicoder/dsh-agent-teams` v0.1.7（fork 基线） vs 新插件 `@zhijian/dsh-expert-library` v0.1.0（当前迭代）
> 日期：2026-08-19 · 依据：双方完整源码（Host + Client）
> Phase 0 刷新（2026-08-22）：调度器/状态层已加硬化（cancelled 终态、补偿事务），skill 绑定改为仅本地，代码规模与打包状态按当前源码更新。
> V2 刷新（2026-08-23）：V2 数据与运行时层落地——Domain Packs（schema validator / pack-loader / 确定性 overlay 合并）、Provider Runtime（ProviderRegistry / CapabilityResolver / ProviderEnvelope + host provider-service）、TeamTemplate Compiler → ExecutionPlan、Quality Gate Chain；client/settings 已打包；专家 capability overlay 按 capability id 合并；质量 gate 逻辑 id 重绑定到物理 fan-out 任务产物。

---

## 一、一句话定位

| | dsh-agent-teams（原） | dsh-expert-library（新） |
|---|---|---|
| 定位 | **通用多智能体协作引擎**：任何会话可拉起"队长 + 成员 + 任务"的团队 | **领域化专家编排系统**：在协作引擎之上叠加专家库、场景模板、领域路由、知识包与外部 skill |
| 本质 | 一套工具 + 一套协议（机制层） | 机制层（继承）+ 数据层（原生）+ 策略层（路由/场景）（机制 + 数据 + 策略） |
| 典型入口 | "用 AgentTeams 审查最近的提交" | "用专家库做代码审查" / "请专家点评数据" / "做 PPT" |

---

## 二、全景对比表

| 维度 | 原 dsh-agent-teams | 新 dsh-expert-library |
|---|---|---|
| 插件名 | `agent-teams` | `expert-library` |
| 工具总数 | **10** | **21**：12 `expert_teams_*`（含 `scenario_apply`/`chat`）+ 4 协作（debate/roundtable/ppt/report）+ 4 智见（route/apply/clarify/feedback）+ 1 `expert_provider_call` |
| 内置专家 | 无（成员是通用 worker，仅 role 字符串） | **33 位智见（bk-002~bk-034）** + 通用/银行/pipeline 专家（s-*/xhs-*/e*-*/bank-*），按领域包装载（如 beike 包 13 位跨命名空间交叉投影） |
| 场景模板 | 无 | **10 个**（6 通用 + 4 协作） |
| 领域路由 | 无 | **原生路由表**（11 话题 → 框架 → 主责领域 → 候选专家） |
| 输出框架 | 无 | **5 套**（A 五维 / B 四段 / C 用户视角 / D 融合 / E 顾问） |
| 知识包 | 无（成员可读工作区文件，但无指引机制） | **knowledge/** 目录约定 + persona 自动注入知识指引 |
| 外部 skill 绑定 | 无 | **场景/工具可挂本地安装 skill**（仅本地解析，运行时不联网、不自动更新） |
| 成员 persona | 单一模板（worker 规则 + role） | 三级：通用 worker → 专家 persona → **智见 Profile 烘焙**（风格/金句/禁区/步骤） |
| 会话事件 | `agent-teams/*`（7 种） | `expert-teams/*`（7 种，已改名） |
| HTTP 路由 | `/plugins/dsh-agent-teams/{state,assets}` | `/plugins/dsh-expert-library/{state,assets}` |
| 状态目录 | `<workspace>/.agent-teams/` | `<workspace>/.expert-teams/` |
| 客户端 UI | 完整（ActivityPanel + 会话卡片） | 已打包（`lib/client.js` + exports `./client`）：活动面板 + 会话卡片 + 文件视图 + 设置卡片 |
| Host 代码量 | 3567 行 / 9 文件 | 30+ 文件（含 `v2/` 数据与运行时层：schema validator / pack-loader / provider-runtime / compiler / quality / domain-pack builders） |
| Domain Packs（V2） | 无 | **内置 5 包 + 工作区 overlay**：zhijian-realestate / bank-finance / pipeline-domains / pipeline-general / beike；可加载、校验、确定性合并（builtin < domain-pack < workspace < request） |
| Provider 运行时（V2） | 无 | **ProviderRegistry + CapabilityResolver + ProviderEnvelope + host provider-service**：Wind/zyt/beike 归一化、凭据/只读审批/新鲜度约束、仅显式 fallback、provenance 审计 |
| 模板编译 + 质量运行时（V2） | 无 | **TeamTemplate Compiler → 不可变 ExecutionPlan（roster/DAG/gates/digest）+ Quality Gate Chain**：硬门阻断、≤2 轮修复预算、artifact 哈希；逻辑 gate id 重绑定到物理 fan-out 产物 |
| 依赖关系 | 独立插件 | fork 后独立迭代，注册面全部改名，互不冲突 |

---

## 三、分层架构对比

### 3.1 挂载与组合层（相同骨架）

两者都是 **Host 平面插件**：`cordis.patch.yml` 插入一行插件 → 工具注册进共享 `tools` 注册表 → 协议段注入全局 `systemPrompt` → 无需 realm，所有会话可用。

**差异**：新插件注册面全部独立命名（工具前缀 `expert_teams_*`、事件 `expert-teams/*`、路由 `/plugins/dsh-expert-library/*`、状态目录 `.expert-teams`），因此**可与原插件共存**；而原插件体系内无法挂第二个同名插件（dsh-tools 注册表重名即抛错）。

### 3.2 协议层（systemPrompt）

| | 原 | 新 |
|---|---|---|
| section | `agent-teams:usage` | `expert-library:usage` |
| 内容 | 7 步通用队长协议 | 通用协议 + **智见点评流程**（判题→拍板→组队→融合→渲染）+ **协作模式**（辩论/圆桌/PPT/研报）+ skill/知识包说明 |
| 策略来源 | 全部靠 prompt 文本约束 | prompt 只留流程骨架，**领域细节下沉为原生数据**（路由表/框架模板/专家档案） |

设计要点：原插件把"怎么当队长"写进 prompt；新插件把"这个领域怎么做"从 prompt 搬到数据（工具查询路由、成员自带 persona），prompt 变薄而决策变准。

### 3.3 工具层（差异最大）

| 家族 | 原 | 新 | 说明 |
|---|---|---|---|
| 核心编排 | 10 个 `agent_teams_*` | 12 个 `expert_teams_*`（含 `remove_member`/`chat`，+`scenario_apply`） | 机制同源：create/add_member/create_task/reassign/claim/update/send_message/status/delete |
| 场景一键 | — | `expert_teams_scenario_apply` | 建队 + 加专家 + 生成任务 DAG 一步完成 |
| 领域路由 | — | `expert_review_route` | 结构化路由：话题 → 框架 → 候选专家（用户拍板） |
| 领域组队 | — | `expert_review_apply` | 按拍板结果建队 + 框架任务 DAG（并行研判 → 融合 → 渲染） |
| 协作模式 | — | `expert_teams_{debate,roundtable,ppt,report}` | 参数化动态组队（任意专家组合） |
| 工具内部结构 | 每个工具独立 execute | **核心函数提取 + Core API 复用**：createTeamCore/addMemberCore/createTaskCore 被场景与协作工具共用，逻辑单一来源 | |

关键架构改进：原插件 10 个工具各自实现完整逻辑；新插件把 create/add_member/create_task 提炼为可复用核心（`ExpertToolsCore` 返回 memberSelections + scheduler 依赖），4 个协作工具 + 场景应用器全部复用同一套锁/鉴权/事件/落盘路径——**工具增长 70%，核心逻辑零复制**。

### 3.4 成员与 persona 层

| | 原 | 新 |
|---|---|---|
| 成员本质 | 可续聊子代理（不变） | 可续聊子代理（不变） |
| persona | `memberPersona`：通用 worker 规则 | `expertMemberPersona`：专家背景/原则/交付物 |
| 领域烘焙 | — | `zhijianExpertPersona`：Profile JSON 的 style/立场/金句/禁区/分析步骤**编译进 persona**，成员第一轮就以专家身份思考 |
| 模型路由 | 默认快照队长路由，可显式覆盖 | 三级：**专家预置路由 > 显式参数 > 插件 memberModel > 队长路由**（每位 bk-* 专家绑定 deepseek-official/deepseek-v4-flash） |
| 知识指引 | 无 | 成员 persona 自动注入其知识包目录与文件清单 |
| 退役守卫/冷恢复 | 有（不变） | 有（继承） |

### 3.5 状态与调度层（继承 + Phase 0 硬化）

`state.ts`（锁/原子写/JSON 校验/任务状态机/attempt 代际/邮箱租约/归档）与 `scheduler.ts`（事件驱动领取 + 冷恢复重试 + 投递失败精确回滚）继承自原插件，并在 Phase 0 硬化：

- 调度器新增 `shouldAutoRetryTask`：**cancelled 是终态、永不自动复活**；仅 failed 且 attempt ∈ {1,2}（预算 3 次内）才回池，旧数据（attempt 0）保持终态。
- 状态层新增 `commitTaskUpdate` 补偿事务：先写任务 project 输出、后提交 team 记录；team 写失败时用快照回滚 project 文件，杜绝"team 记录声明了 project 没有的输出"。
- TeamState 新增 `scenarioId`（场景溯源，persona 据此推断框架）
- 状态目录改名 `.expert-teams`（与原名隔离）

### 3.6 数据与策略层（全新）

```
dsh-agent-teams                     dsh-expert-library
┌────────────────────┐              ┌──────────────────────────────┐
│ tools（机制）       │              │ tools（机制，继承）            │
│ state（持久化）     │              │ state（持久化，继承）          │
│ scheduler（调度）   │              │ scheduler（调度，继承）        │
│ members（成员）     │              │ members（成员 + persona 三级） │
└────────────────────┘              ├─ expert-library/ 通用专家库    │
                                    │   （8 专家 + 10 场景 + 注册表） │
                                    ├─ zhijian/ 领域子系统 ★        │
                                    │   ├─ 原生专家数据（33 位）     │
                                    │   ├─ 原生路由表                │
                                    │   ├─ 框架模板 A/B/C/D/E        │
                                    │   └─ 立场对照/执行约束          │
                                    ├─ collab/ 协作模式 ★           │
                                    │   （辩论/圆桌/PPT/研报 DAG）    │
                                    ├─ knowledge.ts 知识包指引 ★     │
                                    └─ skills.ts 本地 skill 绑定 ★   │
                                    └──────────────────────────────┘
```

---

### 3.7 V2 数据与运行时层（Phase 1–4，2026-08 落地）

在 V1 机制层之上，新插件新增独立的 `src/v2/` 数据与运行时层（纯 JSON 契约，经 `@zhijian/dsh-expert-library/v2` exports）：

- **schema-v2 + `validateDomainPack`**：`ExpertV2 / ScenarioV2 / TeamTemplate / OutputTemplate / QualityPolicy / ToolProviderManifest / SkillPackageManifest` 等一等公民对象；零依赖纯结构校验（安全 id、版本、重复 id、DAG 环、交叉引用），输出错误/警告诊断而非布尔。
- **pack-loader（Domain Packs）**：本地加载（JSON 文件 / 目录布局，路径包含与 symlink 逃逸校验）+ 确定性 overlay 合并（`builtin < domain-pack < workspace < request`）；专家实体按 **capability id 合并**（`mergeExpertCapabilities`）——高层字段覆盖、低层独有 capability（如 `beike.review`）保留，避免 overlay 整体替换静默丢失包级能力声明。
- **provider-runtime（Provider Registry + Capability Resolver）**：`ProviderRegistry`（注册/替换/注销 + 审计 + capability 索引）、`CapabilityResolver`（任务 allowlist ∩ 已安装 ∩ 允许集合 ∩ 凭据可用 ∩ 只读审批 ∩ 数据新鲜度；仅显式 fallback，不做 Wind↔zyt 隐式替换）、`ProviderEnvelope`（provenance/caliber/unit/retry 指令）；Wind / zyt / beike 归一化适配器；Host `provider-service` 注入 invoker，`expert_provider_call` 工具走同一解析/审批/审计路径。
- **template-compiler + quality-runtime**：`compileExecutionPlan` 把 TeamTemplate 编译为不可变 `ExecutionPlan`（roster/DAG/gates/digest）；`runQualityChain` 执行确定性 gate 链（data-citation / compliance-anonymization / schema-structure / pii-redaction…），硬门阻断 + ≤2 轮修复预算 + artifact 哈希；任务完成时逻辑 gate id **重绑定到物理 fan-out 任务产物**（如融合任务逻辑 t2 → 物理 t6），修复 `gate-artifact-missing`。
- **domain-pack builders**：zhijian-realestate（33 位 bk-*）、bank-finance、pipeline-domains、pipeline-general（s-*/xhs-*）、beike（13 位跨命名空间交叉投影）等；设置页提供只读 pack 预览与专家路由查看。
- **client/settings**：`lib/client.js` 打包（exports `./client`）、Settings namespace `expert-library`、设置卡片（stateDir/knowledgeDir/pack 选择/模型路由/工具模式），settings 服务缺席时降级不白屏。

---

## 四、数据模型对比

| 对象 | 原 | 新 |
|---|---|---|
| TeamState | name/id/description/captainSessionId/members/tasks/taskSeq | + `scenarioId` |
| TeamTask | id/subject/status/assignee/dependencies/output/**attempt/attemptId/handoffId**/reassigning/时间戳 | 相同（attempt 代际机制继承） |
| TeamMember | id/name/role/provider/model/reasoningEffort/status | 相同（路由快照继承） |
| TeamMessage | from/to/content/ts + 投递租约 | 相同（双通道投递继承） |
| Expert | — | id/name/role/background/principles/deliverables/**model 预置**/suitedFor |
| Scenario | — | id/experts/**任务 DAG**/deliverable/knowledge/**skill 绑定** |
| 路由/框架 | — | ZhijianRouteTopic/Scenario/StancePair/FrameworkSpec |

---

## 五、关键机制对比

| 机制 | 原 | 新 | 变化 |
|---|---|---|---|
| attempt 代际转派 | ✅ | ✅ | 继承 |
| 退役守卫（retired-members.json） | ✅ | ✅ | 继承 |
| 冷恢复续跑 | ✅ | ✅ | 继承 |
| 双通道消息（steer/followup + 邮箱） | ✅ | ✅ | 继承 |
| 调度器事件驱动领取 | ✅ | ✅ | 继承 |
| 失败自动重试（attempt 预算 3 次） | — | ✅ Phase 0：`shouldAutoRetryTask`，cancelled 终态永不复活 | 新增硬化 |
| 任务提交补偿事务 | — | ✅ Phase 0：`commitTaskUpdate`（project 先写、team 后提交、失败回滚） | 新增硬化 |
| 删除归档（archive/） | ✅ | ✅ | 继承 |
| 专家注册表 | — | ✅ 多命名空间（bk-*/bank-*/s-*/xhs-*/e*-*）按领域包装载，用户 JSON 可覆盖 | 新增 |
| 场景任务 DAG | — | ✅ 10 个 | 新增 |
| 结构化路由 | — | ✅ 话题→框架→候选 | 新增 |
| persona 三级烘焙 | — | ✅ 通用/专家/智见 | 新增 |
| 模型路由三级预置 | — | ✅ | 新增 |
| 知识包指引 | — | ✅ 惰性生效 | 新增 |
| 外部 skill 绑定 | — | ✅ 仅本地解析 + 降级（运行时不联网） | 新增 |
| 专家 capability overlay 合并（V2） | — | ✅ `mergeExpertCapabilities`：按 capability id union，低层 pack 独有声明保留 | 新增 |
| 质量 gate 逻辑→物理重绑定（V2） | — | ✅ `selectStampedGates`：逻辑任务 id 重绑定到物理 fan-out 产物，deliverable 源逻辑 id 展开为物理任务 | 新增 |

---

## 六、使用流程对比（时序）

**原插件（通用协作）**
```
用户："用 AgentTeams 审查提交"
队长：create → add_member(researcher/engineer/qa) → create_task ×N（依赖）
     → 调度器自动派活 → 成员 claim/update/report → 队长汇总 → delete
```

**新插件（三种入口）**
```
① 场景入口："做一份研报"
   scenario_apply(research-report) → 建队+加专家+任务 DAG → 同上协作
② 领域路由入口："请专家点评：X市6月数据"
   review_route(判题→框架A→候选5位) → 用户拍板选3位
   → review_apply(建队+框架DAG: 并行研判→融合→渲染)
③ 点名入口："让邢自强和付鹏辩一辩"
   debate(pro=bk-004, con=bk-008) → 立论→反驳→回应→裁判总结
```

---

## 七、模块对照（职责描述，行数未重新测量）

| 模块 | 原 | 新 | 说明 |
|---|---|---|---|
| tools.ts | 机制层 10 工具 | 12 个 `expert_teams_*`（含 remove_member/chat）+ 核心提取 | 增量小，核心复用 |
| members.ts | 成员 persona / 模型路由 | 专家 persona / 烘焙钩子 / `memberRouteRequest` 路由优先级 | persona 三级烘焙 |
| state.ts | 锁 / 原子写 / JSON 校验 | + scenarioId 校验 / `commitTaskUpdate` 补偿事务 | Phase 0 硬化 |
| scheduler.ts | 事件驱动调度 | + `shouldAutoRetryTask`（cancelled 终态 / attempt 预算） | Phase 0 硬化 |
| index.ts | 插件入口 / 协议 | 协议 / 注册 / 领域工具清单 | — |
| 新模块 | — | v2/ 数据与运行时层 + 领域 pack 构建器 | schema validator / pack-loader / provider-runtime / compiler / quality / digest / preview / runtime-pack / 5 个 domain-pack builders + 生成数据 |
| Host 合计 | 机制层 9 文件 | 30+ 文件（含 v2/ 层与生成数据） | 体积显著大于原插件（生成数据 + V2 数据/运行时层） |
| Client | 活动面板 / 会话卡片 | 活动面板 / 会话卡片 / 文件视图 / 设置卡片（已打包 `lib/client.js`） | 职责描述，无行数口径 |

---

## 八、设计演进分析

1. **从"机制"到"机制 + 数据 + 策略"**：原插件是纯机制（工具 + 协议），所有领域知识靠模型现场发挥；新插件把领域知识（专家档案、路由规则、框架规范）**编译为原生数据**，模型从"读文档执行"变为"查表执行"——决策质量提升且可审计。
2. **从"单一人设"到"persona 三级烘焙"**：worker → 专家 → 领域 Profile，越具体越少依赖模型对资料的自主解析，越接近"真正的专家分身"。
3. **从"prompt 约束"到"结构化约束"**：原插件依赖系统提示文本约束行为；新插件把约束（字数闸门、四要素、数字核实、匿名化、已故专家）下沉为数据与任务描述，协议变薄。
4. **组合爆炸的收敛**：若按"专家为主入口"，跨命名空间专家（bk-/bank-/s-/xhs-/e*-）× 多套产出框架的组合无法人工选择；以场景为主入口 + 专家为参数 + 路由收敛 + 用户拍板，组合被结构化消解。
5. **可插拔性**：知识包（数据）、自定义专家/场景（JSON）、外部 skill（本地安装，运行时不联网）三层可插拔，全部惰性生效——插件本体不动，能力持续增长。
6. **兼容性策略**：注册面全部改名换取共存能力，机制层保持同源（继承成熟度），这是"独立迭代"的稳妥路径。

---

## 九、共存、迁移与取舍

| 问题 | 结论 |
|---|---|
| 能否共存 | ✅ 可以。注册面（工具/事件/路由/状态目录）全部独立，互不干扰 |
| 是否建议同时启用 | ⚠️ 不建议。两套队长协议同时在系统提示中会让模型混淆入口；按需二选一 |
| 迁移成本 | 低。机制同源，原团队数据（`.agent-teams/`）可通过改目录名导入新插件（scenarioId 缺失不影响） |
| 新插件的代价 | 体积显著大于原插件（含生成数据 + V2 数据/运行时层）、协议更长 |

---

## 十、结论

- **原插件**：一个完成度很高的通用协作引擎，机制（attempt 代际/退役守卫/冷恢复/双通道消息/事件调度）至今仍是新插件的地基。
- **新插件**：在引擎之上完成了"领域化 + 数据化 + 可插拔"的三层升级，把"会协作"升级为"懂领域地协作"；代价是体积与协议复杂度。
- **演进主线**：机制不变，知识从 prompt 走进数据，组合从枚举变成路由，能力从内建变成可插拔。
