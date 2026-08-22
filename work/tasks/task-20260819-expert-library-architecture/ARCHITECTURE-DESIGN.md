# DSH × Expert Library 目标架构设计

- 版本：v0.1
- 日期：2026-08-19
- 状态：设计定稿，待实施

## 1. 背景与目标

`dsh-expert-library` 当前在插件内实现了专家 Profile、场景模板、持久成员、任务 DAG、mailbox 消息和智见点评子系统。下一步不是继续堆叠领域专家，而是明确 DSH 平台与领域插件的边界，并完成首阶段可落地改造：目标架构文档、模型与 API/CLI 配置、Settings UI 接入、构建与验证。

最终目标：DSH 负责 Agent 的创建、授权、调度、恢复、验证和交付；Expert Library 负责哪些专家适合什么场景、采用什么专业方法；zyt、智见点评等领域插件负责数据源、指标语义和行业规则。

## 2. 目标分层

```text
DSH Core
├── Agent Runtime
│   ├── Agent Preset / persona
│   ├── child-agent lifecycle / resume
│   ├── model routing
│   └── tool capability policy
├── Workflow Runtime
│   ├── task DAG
│   ├── retry / timeout
│   ├── approval gate
│   └── completion events
├── Tool Runtime
│   ├── tool registry
│   ├── role/task allowlist
│   ├── credentials
│   └── audit
├── Artifact Runtime
│   ├── file / dataset / report
│   ├── schema and validation
│   └── provenance
└── Skill Registry
    ├── version / cache
    ├── scope
    ├── input/output contract
    └── required tools

Expert Library
├── generic expert profiles (researcher/engineer/qa/security/designer/docs/data-analyst/team-lead)
├── scenario templates (code-review/market-research/product-design/fullstack-build/security-audit/documentation/cross-debate/roundtable/ppt-gen/research-report)
├── collaboration modes
└── knowledge-pack bindings

Domain Plugins
├── Zhijian review: BK profiles, routing, frameworks A-E, anonymization
├── zyt data: API/CLI adapter, dataset semantics, data口径
└── other industry tools
```

## 3. 职责边界

### DSH Core

- Agent preset 与 persona 注入；
- child agent 生命周期、冷恢复、interrupt/followup；
- 模型路由与 reasoning effort 解析；
- 工具注册、角色/任务 allowlist、凭据、审批、审计；
- Workflow/DAG、任务状态机、重试、超时、完成事件；
- Artifact/Dataset/Report 存储、schema、校验、血缘；
- Skill 注册、版本、缓存、作用域；
- Settings namespace、持久化、Web settings 基础能力。

### Expert Library

- 8 个通用专家 Profile（persona、原则、交付物、推荐场景、模型默认值）；
- 10 个场景模板（专家组合、任务 DAG、交付物、可选外部 skill 绑定）；
- 协作模式（debate/roundtable/ppt/report）；
- 场景到 DSH Workflow 的适配层；
- 知识包绑定（experts/scenarios/shared）。

### Domain Plugin

- 智见点评：BK 专家、路由、框架、匿名化、已故专家约束；
- zyt：API/CLI adapter、指标语义、查询参数、Dataset Artifact；
- 其他行业数据能力。

## 4. Agent Preset 设计

### 队长预设

- 场景匹配与用户澄清；
- 团队编排与 DAG 设计；
- 状态监控、失败转派、冲突融合；
- 质量门禁、交付与归档；
- 何时使用 scenario_apply，何时需要用户拍板/补口径。

### Worker 预设

- 领取任务（claim）、读取输入产物、执行领域方法；
- 提交结构化结果（summary/artifacts/evidence/risks/openQuestions/validation/confidence）；
- 报告证据与自检；
- 禁止：创建团队、添加成员、删除团队、转派他人任务。

### 专家 Profile

在 Worker 预设之上增加：背景、原则、交付物、领域知识指引、模型默认值、允许的工具能力。不将 32 位 BK 专家全部常驻 Agent 预设；使用 route → 用户拍板 → 动态 persona 加载。

## 5. 模型配置

模型优先级：

```text
任务级 > 场景级 > 专家级 > Expert Library 默认值 > DSH 当前 Agent 路由
```

模型配置结构：

```ts
interface ModelRoute {
  provider: string
  model: string
  reasoningEffort?: string
  timeoutMs?: number
}
```

建议默认策略：

- researcher/data-analyst/engineer/security-reviewer/team-lead：高推理；
- docs-coordinator：中等推理；
- 简单校对、格式化：低成本模式；
- 数据研判、代码实现、安全审计、最终融合：不自动降档。

设置界面必须显示最终生效路由，并标注继承来源（任务/场景/专家/全局）。

## 6. API / CLI 工具模式

外部工具属于 Tool Adapter，不属于专家或场景。以 zyt 为例：

```text
zyt API / CLI Adapter
  ↓
结构化数据查询和 Dataset Artifact
  ↓
researcher / data-analyst
  ↓
BK 专家解释和研判
```

### 模式

- `api`：结构化、生产查询、凭据隔离、参数 schema、重试、审计；
- `cli`：本地调试、批处理、文件产出；必须通过受控 adapter；
- `auto`：API 健康时优先 API，否则受控降级 CLI；两者不可用时明确失败，不伪造结果。

模式优先级：

```text
任务级 > 场景级 > 工具默认值
```

CLI adapter 必须：命令白名单、参数 schema、工作目录限制、超时、退出码解析、日志脱敏。不得直接给 Agent 任意 shell 权限。

API Key 只能由 Host 凭据/工具适配层持有，不得进入 persona、任务描述、mailbox、前端普通状态或报告。

## 7. 设置界面设计

Settings namespace：`expert-library`。

### 运行时字段

- `stateDir`
- `knowledgeDir`
- `memberProvider`
- `memberMaxDepth`
- `maxMembers`
- `promptSectionOrder`

### 默认模型字段

- `memberModelProvider`
- `memberModelName`
- `memberReasoningEffort`
- `allowScenarioModelOverride`
- `allowTaskModelOverride`
- `fallbackModelProvider`
- `fallbackModelName`
- `fallbackReasoningEffort`

### 工具绑定字段

- 工具 id；
- 执行模式 `api/cli/auto`；
- timeout；
- maxRetries；
- readOnly；
- allowedRoles；
- allowedScenarios/Tasks。

### UI 行为

- 使用 DSH Settings mirror/scope；
- 写入使用 namespace scope 的 `set/unset`；
- 嵌套 `memberModel` 在表单展开，Host 保存时组装；
- restart-required 字段明确标注；
- 设置不可用时展示原因，不白屏；
- 不显示秘密字段。

## 8. 端到端执行链路

```text
用户意图标准化
  → 场景匹配 + 置信度
  → 缺失输入/口径门禁
  → 计划实例化（目标、输入、输出、验收条件）
  → 创建 Agent/Workflow
  → 任务 DAG 执行
  → 结构化 Artifact
  → 中间 validator
  → 专家融合
  → 最终质量门禁
  → 交付与归档
```

任务完成不能只写长字符串。至少提交：summary、artifacts、evidence、risks、openQuestions、validation、confidence。

## 9. 首阶段范围

- 场景匹配工具化（候选、置信度、缺失输入）；
- 任务描述支持目标/数据插值；
- 完成事件与失败有限重试；
- skill 任务级绑定；
- 融合任务责任人；
- Settings UI 接入（Host namespace + Client 卡片）；
- 模型配置与 API/CLI/Auto 工具模式配置；
- 构建链接线（exports、client inject、client build）。

## 10. 非目标

- 不将 BK 专家、房地产框架、zyt 指标语义或外部 skill 内容并入 DSH 核心；
- 不立即重写 durable member runtime；
- 不直接给成员开放任意 shell/API 凭据；
- 不把 API Key 写入前端设置或 persona。

## 11. 验收标准

- 设置页显示 Expert Library 卡片并可读写；
- 保存后重载保持配置；
- typecheck/build 通过；
- 默认/专家/场景/任务模型继承规则可解释；
- API/CLI/Auto 模式可配置；
- 旧配置和旧团队状态向后兼容；
- 无 API Key 泄漏；
- 场景计划显示目标、依赖、责任人和交付物；
- 数据和报告输出可追溯到输入产物。
