# dsh-agent-teams 与 dsh-expert-library 架构分析对比

> 版本：原插件 `@nanmicoder/dsh-agent-teams` v0.1.7（fork 基线） vs 新插件 `@zhijian/dsh-expert-library` v0.1.0（当前迭代）
> 日期：2026-08-19 · 依据：双方完整源码（Host + Client）

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
| 工具总数 | **10** | **17**（+7） |
| 内置专家 | 无（成员是通用 worker，仅 role 字符串） | **40 位**：8 通用 + 32 智见（bk-002~bk-033） |
| 场景模板 | 无 | **10 个**（6 通用 + 4 协作） |
| 领域路由 | 无 | **原生路由表**（11 话题 → 框架 → 主责领域 → 候选专家） |
| 输出框架 | 无 | **5 套**（A 五维 / B 四段 / C 用户视角 / D 融合 / E 顾问） |
| 知识包 | 无（成员可读工作区文件，但无指引机制） | **knowledge/** 目录约定 + persona 自动注入知识指引 |
| 外部 skill 绑定 | 无 | **场景/工具可挂 GitHub skill**（拉取 + 缓存 + 降级） |
| 成员 persona | 单一模板（worker 规则 + role） | 三级：通用 worker → 专家 persona → **智见 Profile 烘焙**（风格/金句/禁区/步骤） |
| 会话事件 | `agent-teams/*`（7 种） | `expert-teams/*`（7 种，已改名） |
| HTTP 路由 | `/plugins/dsh-agent-teams/{state,assets}` | `/plugins/dsh-expert-library/{state,assets}` |
| 状态目录 | `<workspace>/.agent-teams/` | `<workspace>/.expert-teams/` |
| 客户端 UI | 完整（ActivityPanel + 会话卡片，1246 行） | 源码保留未打包（后续版本） |
| Host 代码量 | 3567 行 / 9 文件 | 8195 行 / 24 文件 |
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
| 核心编排 | 10 个 `agent_teams_*` | 11 个 `expert_teams_*`（+`scenario_apply`） | 机制同源：create/add_member/create_task/reassign/claim/update/send_message/status/delete |
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

### 3.5 状态与调度层（继承不变）

`state.ts`（锁/原子写/JSON 校验/任务状态机/attempt 代际/邮箱租约/归档）与 `scheduler.ts`（事件驱动领取 + 冷恢复重试 + 投递失败精确回滚）**原样继承**。新插件仅：
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
                                    │   ├─ 原生专家数据（32 位）     │
                                    │   ├─ 原生路由表                │
                                    │   ├─ 框架模板 A/B/C/D/E        │
                                    │   └─ 立场对照/执行约束          │
                                    ├─ collab/ 协作模式 ★           │
                                    │   （辩论/圆桌/PPT/研报 DAG）    │
                                    ├─ knowledge.ts 知识包指引 ★     │
                                    └─ skills.ts 外部 skill 绑定 ★   │
                                    └──────────────────────────────┘
```

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
| 删除归档（archive/） | ✅ | ✅ | 继承 |
| 专家注册表 | — | ✅ 40 位，用户 JSON 可覆盖 | 新增 |
| 场景任务 DAG | — | ✅ 10 个 | 新增 |
| 结构化路由 | — | ✅ 话题→框架→候选 | 新增 |
| persona 三级烘焙 | — | ✅ 通用/专家/智见 | 新增 |
| 模型路由三级预置 | — | ✅ | 新增 |
| 知识包指引 | — | ✅ 惰性生效 | 新增 |
| 外部 skill 绑定 | — | ✅ 拉取+缓存+降级 | 新增 |

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

## 七、代码规模与模块对照

| 模块 | 原 | 新 | 说明 |
|---|---|---|---|
| tools.ts | 1160 行 / 10 工具 | 1475 行 / 11 工具 + 核心提取 | 增量小，核心复用 |
| members.ts | 490 行 | 545 行 | +专家 persona / 烘焙钩子 |
| state.ts | 882 行 | 883 行 | +scenarioId 校验 |
| scheduler.ts | 265 行 | 265 行 | 未动 |
| index.ts | 224 行 | 275 行 | +协议/注册 |
| 新模块 | — | +3345 行 | 专家数据 1745 + 路由/框架/工具/知识/skill 1600 |
| Host 合计 | 3567 行 | 8195 行 | 2.3×（其中 21% 为生成数据） |
| Client | 1246 行 | 保留未打包 | 后续版本 |

---

## 八、设计演进分析

1. **从"机制"到"机制 + 数据 + 策略"**：原插件是纯机制（工具 + 协议），所有领域知识靠模型现场发挥；新插件把领域知识（专家档案、路由规则、框架规范）**编译为原生数据**，模型从"读文档执行"变为"查表执行"——决策质量提升且可审计。
2. **从"单一人设"到"persona 三级烘焙"**：worker → 专家 → 领域 Profile，越具体越少依赖模型对资料的自主解析，越接近"真正的专家分身"。
3. **从"prompt 约束"到"结构化约束"**：原插件依赖系统提示文本约束行为；新插件把约束（字数闸门、四要素、数字核实、匿名化、已故专家）下沉为数据与任务描述，协议变薄。
4. **组合爆炸的收敛**：若按"专家为主入口"，40 专家 × 10 产出 = 400 组合无法选择；以场景为主入口 + 专家为参数 + 路由收敛 + 用户拍板，组合被结构化消解。
5. **可插拔性**：知识包（数据）、自定义专家/场景（JSON）、外部 skill（repo）三层可插拔，全部惰性生效——插件本体不动，能力持续增长。
6. **兼容性策略**：注册面全部改名换取共存能力，机制层保持同源（继承成熟度），这是"独立迭代"的稳妥路径。

---

## 九、共存、迁移与取舍

| 问题 | 结论 |
|---|---|
| 能否共存 | ✅ 可以。注册面（工具/事件/路由/状态目录）全部独立，互不干扰 |
| 是否建议同时启用 | ⚠️ 不建议。两套队长协议同时在系统提示中会让模型混淆入口；按需二选一 |
| 迁移成本 | 低。机制同源，原团队数据（`.agent-teams/`）可通过改目录名导入新插件（scenarioId 缺失不影响） |
| 新插件的代价 | 体积 2.3×（含 1745 行生成数据）、客户端 UI 暂缺、协议更长 |

---

## 十、结论

- **原插件**：一个完成度很高的通用协作引擎，机制（attempt 代际/退役守卫/冷恢复/双通道消息/事件调度）至今仍是新插件的地基。
- **新插件**：在引擎之上完成了"领域化 + 数据化 + 可插拔"的三层升级，把"会协作"升级为"懂领域地协作"；代价是体积与协议复杂度。
- **演进主线**：机制不变，知识从 prompt 走进数据，组合从枚举变成路由，能力从内建变成可插拔。
