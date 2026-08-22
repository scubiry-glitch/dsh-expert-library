# 下一代专家库架构设计基线（V2）

> 状态：Design Baseline · 2026-08
> 依据：`@zhijian/dsh-expert-library` 当前源码；本机 Wind MCP CLI 实测；政研通 zyt CLI 源码契约；贝壳 beike CLI 二进制静态分析（`beike-cli.zip`）；`智见点评_skill_20260819.zip`（156 文件）反向建模；99wiki 分型验收规范。
> 性质：设计文档，不改动任何运行时代码。文中所有结论按【实测】【源码契约】【待验证】三级标注。

---

## 1. 目标与非目标

### 1.1 目标

把"专家 + 场景"系统升级为**可编译、可校验、可追溯的能力组合系统**：

```text
用户请求
  → TaskSpec（领域/目标/交付物/口径/权限）
  → Capability Resolver（先求能力，再选专家）
  → Expert + ToolProvider + KnowledgeProvider + OutputTemplate 组合
  → TeamTemplate Compiler（统一 roster/DAG/gates）
  → Team Runtime（建队/执行/事务回滚/冷恢复）
  → Quality Gate Chain（确定性 → 语义 → 视觉 → 有限修复）
  → Deliverable + Provenance（交付物 + 来源/版本/门控报告）
```

成功标准：

1. 100+ 跨领域专家不进入系统 prompt、不硬编码进主插件；按领域包惰性加载、按 capability 索引路由。
2. Wind、政研通、贝壳等工具以 Provider 契约接入；场景只声明 capability，不依赖具体命令名。
3. 99wiki 等知识系统拥有检索/结构/版本/引用/验收语义，不退化为普通文件夹。
4. scenario、debate、roundtable、ppt、report、智见点评 A–E 全部走同一个 TeamTemplate 编译器。
5. 输出结构与质量要求可执行："去 AI 味""格式整齐""数字有口径"有确定的 gate 结果，而非 prompt 口号。
6. 决策可追溯：选了哪个专家/工具/知识快照/模板/gate 版本，为什么。

### 1.2 非目标（明确不做）

- 不把 Wind 的 39 个底层工具直接全部暴露给每个成员。
- 不把 API Key / 凭据写入 Domain Pack 或 Settings 文档（归凭据层）。
- 不在第一阶段就用一个巨型 union 的 `template_apply` 替代所有语义工具（先收敛实现，后收敛模型可见面）。
- 不让 semantic reviewer 兼职确定性格式检查。
- 不把 99wiki 当普通附件目录；不把输出框架复制进每个 persona。
- 接口未稳定前不把当前 fork 固化为 Host 公共服务。
- 不假定"贝壳 CLI = zyt 政研通"——**已由 `beike-cli.zip` 静态分析证实为独立产品**（见 §5.3）；beike 与 zyt 建为两个互补 Provider。

---

## 2. 分层架构与 Harness 平面

### 2.1 四层模型

| 层 | 归属 | 责任 | 不应包含 |
|---|---|---|---|
| L0 Team Runtime | Harness Host | 团队/任务/attempt 代际/mailbox/调度/事务回滚/冷恢复/事件 | 领域专家、路由、文章模板 |
| L1 Capability Runtime | expert-library Host 插件 | Provider 注册、能力解析、TeamTemplate 编译、Gate 执行、审计 | 具体领域事实 |
| L2 Domain Pack | 可安装/可覆盖数据包 | Expert、Scenario、Routing、OutputTemplate、QualityPolicy | 进程状态与密钥 |
| L3 Workspace Overlay | 会话工作区 | 用户专家、私有知识、项目模板、策略覆盖 | 宿主注册表与全局权限 |

覆盖语义：`内置默认 < Domain Pack < Workspace Overlay < 请求级参数`。

### 2.2 Cordis 平面决策

- 跨会话共享的 Team Runtime、Provider Registry、凭据/审批、状态查询 → **Host composition**（参照 subagents 注册表的先例：跨会话消费者在宿主侧，preset 只贡献工具）。
- 一个会话贡献的工具、persona、prompt section、工作区 overlay → **agent preset / session scope**。
- Wind/zyt Provider 作为 Host 服务注册；成员只获得经策略收敛的调用工具，不直接获得任意 shell。
- Domain Pack 是不可执行数据，由 L1 校验、索引、版本化。
- **不立即拆宿主包**：先在当前插件内稳定服务接口；出现第二个正式消费者后再上收 `dsh-teams-core`。

---

## 3. 一等公民对象（结构化契约）：Expert / ToolProvider / KnowledgeProvider / Scenario / TeamTemplate / OutputTemplate + QualityGate / SkillPackage

### 3.1 ExpertV2 —— 身份与能力分离

专家不是场景角色；同一专家可在不同模板中任主答/数据解释者/反方/校对。

```ts
interface ExpertV2 {
  id: string
  version: string
  display: { internalName: string; publicLabel: string; initials: string }  // 匿名双轨
  domains: string[]
  capabilities: CapabilityClaim[]
  persona: PersonaProfile        // style/tone/bias/mentalModels/blindSpots/…
  methods: MethodRef[]           // analysisSteps、reviewLens、agenticProtocol
  knowledgeBindings: KnowledgeBinding[]
  toolAffinities: string[]       // 擅长的 capability，不是工具名
  modelPolicy?: ModelPolicy      // provider/model/reasoningEffort
  compliance: { deceased?: boolean; internalOnly?: boolean; citationPolicy?: string }
}

interface CapabilityClaim {
  capability: string
  proficiency: 1|2|3|4|5
  coverage: 'high'|'medium'|'low'
  evidenceRefs?: string[]
  validFrom?: string; validTo?: string
}
```

路由顺序：`任务所需能力 → capability 索引检索候选 → 覆盖度/口径/立场互补/模型成本排序 → 策略要求的 approval gate（用户拍板）`。知识覆盖度权重（旧包"高=专家知识 60-70%"）变成可计算 routing score 并输出评分解释。

### 3.2 ToolProvider —— 具体工具隐藏在能力之后；Tool 与 Skill 分离

**硬边界：Tool 与 Skill 是两类东西。** Tool 是运行时调用外部能力的通道，允许联网；Skill 是本地装载的静态方法/知识内容，运行时禁止任何 GitHub/HTTP 拉取、禁止 remote repo source、禁止自动更新（见 §3.7）。凭据只以 `credentialRef` 指向凭据层，manifest 永不保存密钥。

```ts
interface ToolProvider {
  id: string; version: string
  capabilities: ToolCapability[]            // capability + operation + transportId + 输入输出 schema + 口径
  transports: ToolTransport[]               // 非空；capability 绑定到具体 transport id
  discovery?: DiscoveryDescriptor           // 动态 inputSchema（如 wind list-tools）
  invoke(request: CapabilityRequest): Promise<ProviderEnvelope>
}

type ToolTransport =
  | { kind: 'mcp-stdio'; id; command; args?; timeoutMs?; readOnly?; auth? }   // 本地 MCP（stdio）
  | { kind: 'mcp-http';   id; endpoint; timeoutMs?; readOnly?; auth? }        // 远程/本地 MCP（HTTP）
  | { kind: 'http-api';   id; baseUrl; timeoutMs?; readOnly?; auth? }         // HTTP API（如 zyt /openapi/v1）
  | { kind: 'local-cli';  id; command; workingDirectory?; timeoutMs?; readOnly?; auth? }  // 受控本地 CLI

// 每个 transport：id 在 Provider 内唯一；auth = { credentialRef } 指向凭据层，不存密钥

interface ProviderEnvelope {                // 所有 Provider 归一化的返回信封
  ok: boolean
  data?: unknown
  provenance: { provider: string; operation: string; fetchedAt: string; source?: string; caliber?: string }
  warnings: ProviderWarning[]
  error?: { code: string; retry: 'never'|'correct-input'|'backoff'; correction?: string }
}
```

场景写 `financial.stock.snapshot` → Resolver 绑定 Wind；写 `realestate.indicators.timeseries` → 绑定政研通；写 `realestate.listing.search` → 绑定贝壳。工具名、认证、transport 参数不进入 persona 或场景 DAG。

### 3.3 KnowledgeProvider —— 知识系统不是目录

```ts
interface KnowledgeProvider {
  id: string
  kind: 'files'|'structured-wiki'|'search-index'|'database'|'stream'
  capabilities: ('search'|'read'|'cite'|'history'|'write'|'validate')[]
  freshness: 'static'|'monthly'|'daily'|'realtime'
  domainKnowledgeIds?: string[]            // 服务哪些结构化领域知识库（pack 内解析）
  query(request: KnowledgeQuery): Promise<KnowledgeResult>
}

interface KnowledgeResult {
  chunks: KnowledgeChunk[]
  citations: Citation[]
  snapshotId: string        // 版本锚点
  generatedAt: string
  coverage: 'complete'|'partial'|'unknown'
}
```

规划实例：`local-knowledge`（现有 knowledge/ 目录，只读索引）、`zhijian-expert-memory`（Profile 基线 + 月度增量 + 观点漂移事件）、`99wiki`（实体/版本/引用/写入/验收）。输出不得只写"根据资料"——必须落到 citation + snapshotId。

#### 3.3.1 领域知识库（DomainKnowledgeManifest）——结构定义

普通知识目录只有文件；领域知识库有**机器可校验的结构**：边界、本体、集合、快照、检索方式、使用策略。Expert 只绑定 scope（`knowledgeBindings`），从不复制知识内容。

```ts
interface DomainKnowledgeManifest {
  id: string; version: string
  domain: string                    // 覆盖领域（如 realestate.research）
  boundary: string                  // 边界断言：什么属于库内
  ontology: {                       // 受控词表：实体与关系
    entities: { id: string; description: string }[]
    relations?: { id: string; from: string; to: string; description?: string }[]
  }
  collections: { id: string; root: string; format?: string; description?: string }[]  // root 为库内安全相对路径
  snapshot: { id: string; takenAt: string; digest: string; recordCount: number }      // 当前不可变快照
  retrievalProfiles: { id: string; method: 'keyword'|'semantic'|'graph'|'full-read'; config?: object }[]
  policies: { citation: 'required'|'optional'; freshness: 'static'|'monthly'|'daily'|'realtime'; access: 'readonly'|'append' }
}

interface KnowledgeRecordMetadata {   // 每条入库记录必须携带（Data gate 的校验基础）
  id: string
  source: string                     // 来源（provider id / URL / 文件）
  observedAt?: string                // 观测时点
  validTime?: { from?: string; to?: string }  // 事实有效期
  region?: string                    // 地域（如 上海）
  unit?: string                      // 数量单位
  caliber?: string                   // 口径（克而瑞口径 / 贝壳成出口径…）
  sensitivity: 'public'|'internal'|'confidential'
  checksum: string                   // 内容校验和
}
```

建议目录布局（本地、随 pack 或 overlay 安装）：

```text
<knowledgeDir>/domain/<kbId>/
├── manifest.json            # DomainKnowledgeManifest
├── ontology.json            # 实体/关系词表（可并入 manifest）
├── sources/                 # 原始来源（只读留存，含来源与许可记录）
├── documents/               # 归一化后的文档（collections 的实体）
├── snapshots/               # 不可变快照：<snapId>/（records + digest + recordCount）
├── indexes/                 # 检索索引（keyword/semantic/graph 产物，可重建）
└── policies.json            # citation/freshness/access 策略
```

**知识入库流水线**（离线/受控执行，成员不直接跑）：

```text
ingest（sources 落盘）
  → normalize（统一格式 + 记录级 metadata：source/observedAt/validTime/region/unit/caliber/sensitivity）
  → dedupe（id + checksum 去重）
  → validate（schema/边界断言/敏感级检查）
  → snapshot（生成 <snapId>/，计算 digest 与 recordCount，不可变）
  → index（按 retrievalProfiles 重建索引）
  → publish（manifest.snapshot 指向新快照；旧快照保留供 citation 追溯）
```

Expert 通过 `knowledgeBindings: [{ providerId, scope }]` 绑定知识库的某个 scope（集合/实体域），运行时按任务渐进检索；**persona 永不内嵌知识内容**。引用必须落到 `recordId + snapshotId`，Data gate 据此核对数字的口径/时段/地域/单位。

### 3.4 ScenarioV2 —— 任务意图，不手写执行细节

```ts
interface ScenarioV2 {
  id: string; domain: string
  intents: string[]                          // 受控词表
  requiredCapabilities: CapabilityRequirement[]
  routingPolicy: RoutingPolicy               // 硬约束：如"月度研判必须行业研究主答"
  teamTemplate: string                       // 引用 TeamTemplate id
  outputTemplate: string
  qualityPolicy: string
  knowledgePolicy: KnowledgePolicy           // required/optional 知识源
  toolPolicy: ToolPolicy                     // 允许的 capability 集
  approvalPolicy?: ApprovalPolicy            // 用户拍板门
}
```

固定专家名单只作 routing hints；口径提示（丁祖昱=克而瑞、黄瑜=中指、陶琦=贝壳/NIFD）进 policy assertions。

### 3.5 TeamTemplate —— 统一三套 DAG 构建器

现状：`scenarioApplyCore` / `buildCollabTeam`（debate/roundtable/ppt/report）/ `expert_review_apply` 三套平行编排，已共用 Core 与事务回滚，但任务 DAG 仍是各自手写命令式代码。V2 统一为：

```ts
interface TeamTemplate {
  id: string; version: string
  parameters: JsonSchema                    // debate{pro/con/moderator}、fusion{categories≥2,…} 等参数化
  slots: RoleSlot[]
  tasks: TaskTemplate[]
  gates: GateBinding[]
  deliverables: DeliverableBinding[]
}

interface RoleSlot {
  id: string
  capabilities: string[]
  cardinality: { min: number; max: number }
  diversity?: { fields?: number; stances?: number; tags?: string[] }   // 框架D/同题对比规则声明化
  approval?: 'none' | 'user-signoff'
}

interface TaskTemplate {
  id: string; role: string; dependsOn: string[]
  inputs: InputBinding[]                    // 上游产物/知识/工具 capability 绑定
  allowedCapabilities: string[]
  outputSchema: string                      # OutputTemplate 引用
  retryPolicy: 'never' | 'provider-only' | 'quality-repair'
}
```

编译器产物只有一个执行路径：`validate → resolve experts/tools/knowledge → compile DAG → create → spawn → execute → gate → repair → deliver`。旧工具成为薄参数适配器（模型可见面暂不合并，见 §9.1）。

### 3.6 OutputTemplate + QualityGate —— 结构与验收分离

```ts
interface OutputTemplate {
  id: string; version: string
  media: ('markdown'|'html'|'pdf'|'pptx'|'json')[]
  sections: SectionSpec[]                   // 必填章节/字数/字段/来源要求
  renderModes: Record<string, RenderPolicy> // discussion 带匿名标注 / final 去标注
  stylePolicy?: string
}

interface QualityGate {
  id: string
  kind: 'deterministic'|'semantic'|'visual'
  appliesTo: string[]
  severity: 'hard'|'soft'
  evaluate(input: GateInput): Promise<GateResult>
}

interface GateResult {
  gateId: string
  status: 'pass'|'warn'|'fail'
  score?: number
  issues: Array<{ code: string; severity: 'info'|'warning'|'error'; location?: string; evidence?: string; correction?: string }>
  artifactHashes?: Record<string, string>
  evaluatedAt: string
}
```

门控链固定顺序：`Schema/Structure → Data & Citation → Compliance/Anonymization → Format/DOM/Visual → Style Lint → Semantic Review → Repair(≤2轮) → Final Gate`。

### 3.7 SkillPackage / MethodPack —— skill 是本地发行容器，不是万能 Provider

> 依据：Ponytail、GSAP Skills、Finesse、video-shotcraft 四仓结构调研（2026-08）。
>
> **Skill 仅本地装载（硬约束）**：运行时**禁止** GitHub/HTTP 拉取、禁止 remote repo source、禁止自动更新。skill 内容只能来自插件 builtin 目录或 workspace overlay 本地目录（`<knowledgeDir>/skills/<id>/`），按 `id/digest/license` 管理。上游 GitHub 来源仅作为**离线引入时的审计记录**（`upstreamProvenance`，纯字符串，loader 永不访问）。运行时解析器只读本地文件、校验安全 id 与真实路径不逃逸、限制体积，缺失时提示本地安装方式。

**核心判断**：skill（`SKILL.md` + references + examples + 脚本）本质是一个**带来源、版本、权限与依赖声明的发行容器**，不是第七个一等公民 Provider。**离线安装**（落盘到本地 skills 目录）之后，它向系统**贡献**已有的一等公民对象，而不是自己成为新的运行时类型：

```text
SkillPackage（发行容器，本地）
 ├── MethodPack            → agent-instructions 资产：任务编译时渐进加载（不进 persona）
 ├── KnowledgeProvider manifest → 只读渐进加载的 references/examples
 ├── OutputTemplate        → 可选：交付结构
 ├── QualityPolicy/Gate    → 可选：验收规则
 ├── Tool requirements     → 可选：声明所需 capability（不自带执行）
 └── TeamTemplate          → 可选：推荐组队方式
```

**边界规则**：

1. **可执行脚本 ≠ 静态内容**：skill 内的脚本（如 Finesse 的 `detect.mjs`）若要被成员调用，必须**单独注册为受控 ToolProvider**（进入 allowlist、readOnly/审批门、错误信封规范化）；SKILL.md/references/examples 是静态知识，保持只读、按需注入 prompt，**永不执行**。
2. **内容不进 persona**：skill 的方法论文本是 `mediaType: 'agent-instructions'`、`load: 'progressive'` 的 MethodPack 资产——**任务编译时**按需拼入具体任务的指引，而不是把整份 SKILL.md 复制进每个专家 persona（吸取智见包"框架复制进 32 份 persona"的教训）。
3. **大媒体懒加载**：视频/图片素材（如 video-shotcraft 的样片）不随包加载，KnowledgeProvider 按引用惰性读取本地文件，manifest 记录字节数与 SHA-256；不联网下载。
4. **来源可追溯（本地）**：每个 SkillPackage 记录 `source: { kind: 'builtin'|'workspace', root, digest, license?, upstreamProvenance? }`——`root` 是本地安全相对路径，`digest` 为整包 SHA-256；无 license 或 license 不明确的包默认 `internalOnly: true`，不外发产出。
5. **离线晋级**：升级 = 用户离线重新安装新版本（上游 CI/测试通过是建议前置）；loader 重新校验 digest、重跑受影响 gate 基准样本后才启用。运行时不提供任何"检查更新"路径。

**四仓映射表**：

| Skill 仓库 | 定位 | 贡献对象 | 关键取舍 |
|---|---|---|---|
| **Ponytail** | 方法论 skill | MethodPack（评审/分析方法）+ review/audit QualityGate | 纯方法论文本，无脚本；gate 规则直接可执行化 |
| **GSAP Skills** | 领域知识 skill | KnowledgeProvider（references）+ framework MethodPack + best-practices gate | 大量最佳实践文档渐进加载；不复制进 persona |
| **Finesse** | 渐进式 SkillPackage | 渐进加载协议样板；`detect.mjs` 单独注册为受控 audit ToolProvider；Design Read/asset sourcing 走 approval gate | 展示"静态内容懒加载 + 脚本受控执行"的分界标准做法 |
| **video-shotcraft** | 交付型 skill | MethodPack（拍摄方法）+ OutputTemplate（分镜/成片结构）+ Gate + Knowledge | 重渲染管线暂不注册 ToolProvider（无稳定 CLI 契约），先作为方法论与模板来源 |

```ts
interface SkillPackageManifest {
  schemaVersion: 2
  id: string; version: string
  source: {
    kind: 'builtin' | 'workspace'   // 只允许本地来源；remote 一律拒绝
    root: string                    // 本地安全相对路径（如 skills/video-shotcraft）
    digest: string                  // 整包 SHA-256，重装必须复验
    license?: string                // 缺失 ⇒ internalOnly
    upstreamProvenance?: { repository: string; revision: string }  // 仅审计字符串，loader 禁网络
  }
  contributions: {
    methodPacks?: string[]          // 引用本包 MethodPack id（agent-instructions，渐进加载）
    knowledgeProviders?: string[]   // 引用 KnowledgeProvider manifest id
    outputTemplates?: string[]
    qualityPolicies?: string[]
    toolRequirements?: string[]     // 声明所需 capability，不自带执行
    teamTemplates?: string[]
  }
  lazyMedia?: Array<{ path: string; bytes: number; sha256: string }>
  permissions: { execScripts: string[]; internalOnly?: boolean }
}
```

---

## 4. 统一 Capability Resolver 与 TeamTemplate Compiler

### 4.1 Resolver

```text
可调用能力 = 任务允许 capability
           ∩ 专家角色允许 capability
           ∩ 当前 Profile 已安装 Provider
           ∩ 凭据/审批允许
           ∩ 数据口径适配（dataView/freshness/region）
```

- Wind 与政研通**不互相兜底**：Wind=金融/宏观广域，政研通=房地产指标/城市/政策/报告。仅 Scenario 显式声明可替代时才允许 fallback。
- 解析结果写入 team 记录：`{capability → provider.operation, 为什么}`，可审计。

### 4.2 Compiler 执行管线（唯一路径）

```text
template + params
  → schema 校验（参数/slot 多样性/依赖图合法）
  → roster 解析（capability 检索 → 候选 → approval gate → 确认名单）
  → 资源绑定（knowledge providers / tool capabilities / output template）
  → DAG 编译（任务/依赖/输入输出 schema/重试策略）
  → 事务化建队（当前 rollbackTeamAssembly 语义）
  → 执行 + gate 循环（≤2 轮修复）
  → 交付（deliverable + provenance + gate report）
```

编译失败的类别必须可区分：参数错（不重试）、provider 不可用（换源或降级）、gate 硬失败（禁止交付）。

### 4.3 系统时序与 Pipeline 状态机

端到端阶段序列（每个阶段是一次状态迁移，产物不可变、可审计）：

```text
RawRequest          用户原始请求（自然语言 + 附件/数据）
  → TaskSpec        结构化任务：领域/目标/交付物/口径要求/权限边界
  → ScenarioDecision 场景判定：匹配 ScenarioV2（intents/受控词表）或判定为直接回答
  → CapabilityPlan  能力计划：所需 capability × 基数 × 约束（allowedProviders/口径适配）
  → BindingPlan     绑定计划：capability → provider.operation + transport；专家/slot 候选与排序；知识库 scope 绑定
  → ExecutionPlan   编译产物（不可变）：roster + 任务 DAG + 输入绑定 + gate 绑定 + deliverable 声明
  → TeamState       建队落盘（事务化，失败全回滚）；ExecutionPlan 摘要写入 team 记录
  → TaskResults     各任务产出（attempt 代际、artifact 清单、provenance）
  → GateReport      门控链执行结果（含修复轮次、逐 gate 诊断与哈希）
  → Deliverable     最终交付（render mode、citation、provenance、gate report 附卷）
```

**Pipeline 是阶段状态机**：`RawRequest → Deliverable` 每个阶段有明确的入口契约与出口产物，阶段内可重入（如 repair 回到 TaskResults），但产物一旦进入下一阶段即不可变（快照 + digest）。

**TeamTemplate 是执行阶段的声明式 DAG**：它只描述"执行阶段怎么组织"——slots（角色槽位）、tasks（依赖图）、inputs（task-output/knowledge/tool-capability/parameter 四类绑定）、gates（何时验什么）、deliverables（从哪些任务产出什么）。它不含执行细节（成员名、模型路由、transport 参数）。

**Compiler 把后者编译成不可变 ExecutionPlan**：`TeamTemplate + ScenarioPolicy + BindingPlan + params` 一次性解析所有引用（role→专家、capability→provider.operation+transportId、knowledge→scope+snapshot），产出冻结的 ExecutionPlan；执行期只消费该计划，不再回改模板或绑定。同一模板 + 同一绑定 ⇒ 同构 DAG（可做 golden/snapshot 对比测试）。

### 4.4 端到端示例：城市月度市场分析（DAG）

以"上海 2026-07 二手房市场月度研判"为例（口径校准 → 并行采集 → 独立研判 → 融合 → 渲染 → 门控 → 定向修复）：

```text
[t1 口径校准]（analyst slot）
    输入：TaskSpec.city/period + 各 provider 的 caliber 声明（zyt dataView、贝壳成出口径、克而瑞/中指对照）
    输出：CaliberSheet——本报告统一口径与单位、各源换算规则、禁用绝对量的来源标注
    ↓（CaliberSheet 是所有采集与研判任务的输入绑定）
[t2a zyt 指标采集] ‖ [t2b 贝壳成交采集] ‖ [t2c Wind 宏观采集] ‖ [t2d 本地领域知识检索]
    各自按 allowedCapabilities 调用对应 provider；每条数字带 provenance（provider/operation/caliber/fetchedAt）
    ↓
[t3 独立研判 ×N]（expert slots 并行，框架按 routingPolicy 主答+互补立场）
    每位专家只读 t1 口径 + t2 采集产物 + 自己 knowledgeBindings 的 scope 快照；独立出判断
    ↓
[t4 融合]（fusion slot；主基调为锚，偏离观点降级为边界条件，禁止和稀泥并列）
    ↓
[t5 渲染]（render slot；OutputTemplate A/B/C + renderMode discussion/final）
    ↓
[t6 门控链] Data/Citation → Semantic → Format（对 deliverable 执行）
    仅失败 gate 生成定向 repair task（如"修复引用缺失：表 3 第 2 行"），插回 DAG 对应节点重跑
    修复 ≤2 轮；仍 hard fail ⇒ BLOCKED，不交付
```

要点：t2 四路采集是纯 Provider 调用（互不依赖、可并行）；t3 专家互不读取对方产出（独立研判）；repair task 是**定向**的（只修失败 gate 指向的章节/任务），不是整链重跑。

### 4.5 失败 / 重试 / 审批 / 溯源 / 取消语义

- **failure 分类**：参数错（用户输入，不重试，直接反馈）；provider 不可用（transport 失败/凭据缺失——按 Scenario 声明 fallback 或降级为"缺该源"继续，禁止静默编数）；gate 硬失败（禁止交付，进入修复）；成员崩溃（attempt 代际失效，任务回池或重派）。
- **retry 三级**：transport 级（遵循 provider 错误信封的 retry 指令：never/correct-input/backoff，不统一重试三次）；任务级（attempt 预算 3 次；`cancelled` 是终态、永不自动复活——Phase 0 已实现 `shouldAutoRetryTask`）；质量级（gate 失败 → 定向 repair task，≤2 轮，之后 BLOCKED 或降级交付需人工确认）。
- **approval**：两类门——建队前 approval gate（roster/参数，用户拍板，来自 `approvalPolicy`/slot.approval）；运行中 approval gate（写操作、external 资产引用、internalOnly 内容外发——升级到 captain/用户，不得自动通过）。审批请求挂起时对应任务处于 blocked-for-approval，不占调度。
- **provenance**：ExecutionPlan 摘要（模板/绑定/参数 digest）、每次 provider 调用（provider/operation/transport/caliber/fetchedAt）、每条引用（recordId+snapshotId）、每轮 gate（gateId/issues/artifactHashes）全部写入 team 记录；交付物附 provenance 卷宗，可回答"这个数字从哪来"。
- **cancellation**：用户/队长显式取消 ⇒ 任务与团队进入 `cancelled` 终态（不可自动重试）；团队成员被中断回收，已发布 artifact 保留（可审计），未提交产出丢弃；团队删除前归档 team.json + gate report。子任务级取消不取消父团队；父团队取消级联标记所有未终态任务。

## 5. Provider 调研结论与接入契约

### 5.1 Wind Provider【实测】

**定位（实测）**：PATH/npm/pip 均无独立 `wind` 命令；实际 CLI 为 `/root/.agents/skills/wind-mcp-skill/scripts/cli.mjs`（Node ESM，1362 行），配套 `tool-manifest.json`（7 域 × 39 工具白名单）、`call-rules.json`（schema_version 13）、`references/*.md` 参数契约；`wind-find-finance-skill` 为同族安装路由器。

**命令面（实测）**：

```text
node scripts/cli.mjs call <server_type> <tool_name> '<params_json>|@file>'
node scripts/cli.mjs list-tools <server_type>
node scripts/cli.mjs open-portal
node scripts/cli.mjs setup-key <KEY> --scope <global|skill>
```

无 `--help/--version`（`--help` 返回 USAGE_ERROR 信封 exit 1）。

**关键事实（实测）**：

- 7 个 server_type：stock_data(10)/fund_data(10)/index_data(6)/bond_data(4)/financial_docs(2)/economic_data(1)/analytics_data(1)；后端 7 个 MCP endpoint `https://mcp.wind.com.cn/vserver_<域>/mcp/`。
- 成功（exit 0）：MCP 双层 JSON——外层 `content[0].text + cli_meta{schema_version, completeness, tables, warnings}`，内层 `data.columns/rows/unit`（单位元数据必须保留）。实测 `get_stock_price_indicators {"windcode":"600519.SH"}` 返回真实行情 → API Key 已配置可用（`~/.wind-aifinmarket/config`）。
- 失败（exit≠0）：`{code, details, retry{allowed,mode,max_attempts}, circuit_breaker{tripped,scope,action}, correction, agent_action}`。实测三种：USAGE_ERROR（禁原样重试）、ROUTE_ERROR（details 给 allowed_values，可重试）、INVALID_PARAMS_JSON（circuit_breaker.tripped=true → abort_remaining_calls）。**Provider 必须透传并遵循该指令，不能统一"失败重试三次"。**
- `list-tools` 返回官方 inputSchema → 作为 Provider discovery，不复制 39 套参数 schema。
- 行为约束【实测+文档交叉】：windcode 逗号批量、价格指标单次 ≤50 码、默认串行/并发 ≤10、null=缺失禁当 0。
- 认证【推断，源码阅读】：Bearer Key；优先级 全局配置 > skill 本地 > `WIND_API_KEY`；401→AUTH_ERROR。`setup-key`/`open-portal` 属管理操作，不暴露给普通成员。

**建议 capability**：`wind.discovery.list-tools`、`financial.stock.snapshot/timeseries`、`financial.fund.screen`、`financial.index.query`、`financial.bond.valuation`、`financial.macro.query`、`financial.docs.search`。

### 5.2 政研通 zyt Provider【源码契约，本机不可执行实测】

**定位（实测）**：本机 PATH 无 `zyt`；`pip import` 失败；但存在源码包 `/root/.openclaw/media/inbound/zhengyantong---*.zip`（TS/Python 双实现同契约）与残留配置 `~/.config/zyt/config.json`（baseUrl `https://dss.ke.com` + btg_ key，已脱敏）。接入前需安装或经 API 直连——**标记待验证**。

**契约（源码提取）**：

- 子命令（中文主命令+英文别名）：`身份 me`、`指标目录/时序 indicators`、`批量时序 batch-series`、`多城对比 compare`、`地理数据包/时序/树/搜索 geo *`、`行政区分布 districts`、`市场快照 market-snapshot`（联调 500，勿成硬依赖）、`报告 reports`、`政策 policies`、`配置 config`。中文长选项（--城市/--指标/--期数）。
- 输出：人读默认；**Agent 必须 `--json`**；目录响应字段 `entries`。
- 认证：`X-Api-Key`（btg_ 前缀）；优先级 flag > `ZYT_API_KEY/ZYT_BASE_URL/ZYT_INSECURE` > `~/.config/zyt/config.json`。
- 退出码：0 成功 / 1 业务参数错（如 CITY_NOT_ALLOWED）/ 2 鉴权 / 3 网络 5xx；JSON 错误 `{"error":{code,message,httpStatus?}}`。
- **口径（关键）**：`身份` 返回 `dataView`——`internal`=真实绝对量；`external`=量类指数化（首值=100，勿当绝对量）。该口径必须进入 ProviderEnvelope.provenance.caliber 与 DataGate。
- 可测性：两端导出 `buildRequestPlan(argv)` 供契约测试（cases.json + compare-request-plans.mjs）。

**建议 capability**：`realestate.auth.identity`、`realestate.indicators.catalog/timeseries/batch`、`realestate.city.compare`、`realestate.geo.search/timeseries`、`realestate.reports.search`、`realestate.policies.search`。

### 5.3 贝壳 beike CLI【二进制静态分析——macOS arm64，本机 Linux 不可执行，待实测复核】

**定位（实测）**：用户已提供 `beike-cli.zip`（本会话附件，已只读解压到 `/tmp/beike-cli`）。包含两个文件：`beike`（Mach-O 64-bit **arm64** Rust 二进制，自称版本 **0.2.24**）与 `.beike/BEIKE_MCP_API_KEY`（密钥文件，未读取内容）。本机为 Linux，二进制**无法执行**，以下结论来自 strings/Rust 符号静态分析。

**形态**：`building.ke.com/mcp` 的 **MCP 代理**（serverInfo 名 `beike-mcp-proxy`，MCP protocolVersion 2025-03-26）。同一二进制支持 `beike mcp` **stdio 与 HTTP 双模式**——可直接作为 harness 的 MCP 工具源挂载，不必逐命令包 CLI。

**命令面**（clap 注册，实测-字符串）：

```text
login [--source]        # 扫码/网页取 key（qrcode_url，action=get-key）
auth <KEY> [--save]     # 写 ~/.beike/BEIKE_MCP_API_KEY（0600）
install [--force]       # 注册进 Claude Desktop stdio MCP 配置
uninstall [--purge]
doctor                  # 三项健康检查：key 存在/有效/API 可达
buy  …                  # 二手/新房：search detail sold resblock market plate rank
                        #   school district agent contact store land unready resolve（需 -c 城市）
rent …                  # search detail resblock market agent appoint(约看) contact store
sell …                  # list / dynamic --house-code（业主房源与动态）
decor …                 # stores / price(估价 --area --rooms --parlors…) / contact
policy search -c …      # 政策检索
map  …                  # geo(地理编码) / driving / transit(通勤路线)
mcp  …                  # stdio / HTTP server 模式
全局：--json --pretty
```

**认证与配置**：`BEIKE_MCP_API_KEY`（env + `~/.beike/BEIKE_MCP_API_KEY` 文件双形态）、`BEIKE_MCP_BASE_URL`（默认 `https://building.ke.com/mcp`）、`BEIKE_SOURCE`、`PORT`。优先级【推断】env > 文件。

**错误语义（关键差异）**：二进制内**无稳定业务错误码表**；Rust anyhow 风格，推断 clap 参数错→退出码 2、panic→101。与 Wind（结构化错误信封）和 zyt（0/1/2/3 退出码 + JSON error）不同，Provider envelope 适配层必须以 `--json` 输出与 stderr 文本判定成败并**补偿统一错误模型**。

**数据口径与新鲜度**：【推断】实时透传贝壳线上数据，无本地缓存；统计口径（成交/均价口径）由服务端定义，需实测响应确认后写入 DataGate。

**写/敏感操作**：`rent appoint`（预约看房）、`agent contact`、`sell` 系列、`decor contact` 是写操作或涉及个人信息，Provider 必须标记 `readOnly: false` 并走审批门，默认不向成员开放。

**与 zyt 的关系（已定稿）**：二进制中无任何 `zyt`/政研字符串，**非同源、独立产品、能力互补**——beike 承载房源/成交/小区/学区/地图/装修交易级数据，zyt 承载指标/城市/政策研究数据。唯一交点是 beike `policy search` 与 zyt 政策检索部分重叠；Resolver 仅在 Scenario 显式声明可替代时 fallback，provenance 记录实际命中方。

**建议 capability**：`realestate.auth.health`(doctor)、`realestate.listing.search/detail`(buy search/detail)、`realestate.deal.search`(buy sold)、`realestate.resblock.profile`(buy resblock/rank)、`realestate.market.trend`(buy|rent market)、`realestate.school.district`(buy school/district)、`realestate.land.search`、`realestate.rent.search`、`realestate.rent.appoint`(写，审批)、`realestate.decor.estimate`、`realestate.policy.search`、`realestate.geo.code`(map geo/driving/transit)。

---

## 6. 99wiki：结构化 Knowledge + Delivery Provider

99wiki 不是 `knowledge/shared` 子目录。拆成两个接口：

1. **`knowledge.99wiki`**：实体模板继承、历史版本、引用、项目快照、写入。
2. **`delivery.99wiki`**：主文/逻辑附件分型结构、HTML/PDF 渲染、gate 报告。

**Part B / Part C 分型门控（来自 wiki-gated-research 规范）**：

- Part B 主文：12 页级 T1 实体骨架（或批准的 10–14 页）、封面+4 KPI+章节+主题视觉对象、正文字数/来源绑定/表格/机制图/量化模型/决策树、重复块与占位句、HTML/DOM 嵌套/溢出/JS 错误、宽屏与 A4 首/中/末页截图。
- Part C 逻辑附件：`logic_template_id=logic-annex-v2`、15 张速览卡 + 15 张详细逻辑卡 + ≥12 张逻辑图 + 每卡白话总结 + Key Takeaways + 替代解释与验证设计 + 1 个独立补数协议；旧模板类名/重复 15 卡不得存在。
- **B 与 C 必须用不同验收器**：C 没有 `.page`/封面/KPI 不是错误；用错验收器造成的 page_count=0 不算内容失败。
- **DOM 优先**：嵌套/卡片数/溢出以 Chromium 加载后 DOM 为准（如 `document.querySelectorAll('p p').length`），禁止正则扫 HTML。
- **渲染与哈希同步**：每次 gate 重生成 PDF/截图并重算 HTML/PDF hash；gate 必须含类型、最终双哈希、渲染时间、首/中/末页检查。
- **交付判定**：B 过 C 败 → `BLOCKED_PART_C`；B 败 C 过 → `BLOCKED_PART_B`；双过才 `PASS`。
- 页脚署名：`98wiki ｜ 智见 / 行业研究报告`。

这些进 OutputTemplate + GatePolicy，不进专家 persona。

---

## 7. 旧智见点评包（20260819）的迁移映射与债务

来源：`/root/.openclaw/media/outbound/智见点评_skill_20260819.zip`（156 文件：SKILL.md + 5 份规范 + 31 个拍平专家页 + 32 位专家完整材料）。

### 7.1 保留并升级

| 旧资产 | V2 去向 |
|---|---|
| Profile JSON `persona/method/classification`（mentalModels 带证据/盲区、金句、反模式） | ExpertV2 1:1 迁移；`classification/initials` 抽出为匿名/合规章节 |
| `emm`（factor_hierarchy 加权 + veto_rules 一票否决） | QualityGate 策略输入（veto → hard fail） |
| `output_schema.rubrics`（1–5 分制） | 语义 Gate 评分维度 |
| 月度基线 + 近期动态增量 + 观点变化提示（不改写历史 Profile） | zhijian-expert-memory KnowledgeProvider（baseline/monthlyDelta/viewpointDrift） |
| 匿名化、已故专家（bk-022 顾云昌）仅历史引用、陶琦内测不外发 | compliance 字段 + ComplianceGate 确定性测试 |
| 主基调为锚、偏离观点降级为边界条件 | TeamTemplate fusion 任务的方法论约束 |
| 框架 A–E 规范 + discussion/final 双形态 | OutputTemplate（renderModes） |
| 路由规则/同题对比/框架 D 组队规则 | RoutingPolicy + RoleSlot.diversity 声明化 |
| 事故硬化规则（硬数字必须核实、编数字比不回答更严重、429 后禁并发检索） | DataGate 最高优先级 + Provider 并发策略 |

### 7.2 债务（必须修）

1. **双源冗余**：Profile JSON / BK-*.md 拍平版 / Profile.md 三层人肉同步 → Profile JSON 唯一事实源，其余全部生成物。
2. **路由是自然语言表格**：无 schema 校验，新增专家要改三处 → 受控词表 + 结构化路由 + 版本化。
3. **框架规范复制进 32 份 persona.style**：A/B 在 profile 内、C/D/E 在独立文件，两套维护点 → 全部剥离为 OutputTemplate。
4. **emm/rubrics 是死代码**（SKILL.md 明言"不做验收自评（预留）"）→ 接成可执行 QualityGate。
5. **failureCondition 大多为空** → 迁移时补齐或显式标 unknown。
6. **人设名 vs 实名双轨**有泄露面（专家库 md 挂实名）→ internalName 仅内部视图；public 输出用 publicLabel/initials。
7. **覆盖度规则无计算落地** → routing score + 解释输出。
8. **日期文件名版本管理**（_20260809/_v1）→ pack 语义版本。

### 7.3 智见领域包布局

```text
domain-packs/zhijian-realestate/
├── pack.json                        # 版本/依赖/口径声明
├── experts/*.json                   # 唯一事实源
├── routing/{topics,stance-pairs}.json
├── scenarios/*.json
├── team-templates/*.json            # 框架A–E 组队模板
├── output-templates/{A,B,C,D,E}.json
├── quality-policies/*.json
├── knowledge-manifests/*.json
└── generated/                       # markdown/索引，可重建
```

---

## 8. 质量门控设计（确定性 / 语义 / 视觉）

### 8.1 确定性 Gate（代码，不用模型）

- **Schema**：章节/字段/附件齐全；JSON/YAML/Markdown 可解析。
- **Data & Citation**：硬数字有来源+时间+区域+单位+口径；null 禁转 0；zyt external 指数不当绝对量；数字与表格行对应。
- **Compliance**：实名泄漏、已故专家近期言论、internalOnly 外发。
- **Format**：标题层级、表格列一致性、列表缩进、空段、重复块。
- **Visual**：DOM 嵌套/溢出/JS 错误、截图与 PDF hash、PPT 文本越界（univer_lint 类）。

### 8.2 语义 Gate（专用 Reviewer）

- 是否真正回答用户问题、是否有新增信息。
- 事实与判断是否分开；结论是否超过证据强度。
- 是否和稀泥式并列观点而无主基调。
- AI 套话/课堂式过渡/重复结论/空泛建议。
- 是否实际使用了指定知识库与工具（对照 provenance），而非文字声称。

**"去 AI 味"不做成禁词表**：确定性 lint 统计模板短语密度（"值得注意的是/综上所述/一方面…另一方面…"）、句式重复、无事实段落；语义 Reviewer 决定是否重写。目标 = 每段都有事实、判断或行动含义，而非消灭个别词。

### 8.3 修复循环

`生成 → 确定性 → 语义 → 修复 → 再检`，**最多 2 轮**；第三轮失败进入人工确认或降级交付（明确标注未过门），不无限自改。

---

## 9. 工具与方法论收敛

### 9.1 模型可见工具

以"意图清晰 + 实现单一来源"为目标，不以数量最少为目标：

```text
expert_route            # TaskSpec → capability/候选/模板建议
expert_template_apply   # 编译并应用 TeamTemplate（唯一执行路径）
expert_team_status / reassign / update / message / end
expert_gate_report      # gate/provenance/修复轮次查询
```

`debate/roundtable/report/ppt/review_apply` 暂保留为薄语义入口（内部转 template_apply），稳定后按调用数据决定是否从模型工具表移除。

### 9.2 方法论唯一事实源（每条规则只有一个归属）

```text
Persona      → 这个专家如何思考
Method       → 擅长的分析方法
Scenario     → 这次任务要解决什么
TeamTemplate → 怎么组织人和任务
OutputTemplate → 交付物长什么样
QualityPolicy  → 怎样才算通过
Provider Contract → 事实从哪里来、错误如何解释
```

字数/章节不进 persona；数据口径不进场景文案；工具错误语义不进专家 prompt。

---

## 10. 设置与资产编辑器

"设置 → 专家库"拆两层：

1. **运行设置**（现有卡片）：stateDir/knowledgeDir/memberProvider/maxMembers/defaultModel/toolExecution。
2. **资产管理**（新增）：Expert/Scenario/Routing/Template/GatePolicy/Provider manifest 的列表、版本、schema 校验、overlay 发布。

原则：不直接改内置包——用户编辑保存为 Workspace Overlay，显示 diff、校验结果、引用影响与回滚版本；实名字段仅内部视图显示；匿名预览用 publicLabel。

---

## 11. 阶段迁移路线

| Phase | 内容 | 出口标准 |
|---|---|---|
| **0 一致性修复**（短期） | cancelled 任务不被调度器复活；单独 reasoning_effort 不被 memberModel 吞掉；team 终态与 project output 提交一致性；ARCHITECTURE-COMPARISON 过期数据刷新 | 缺陷回归测试全绿 |
| **1 Schema 与 Pack** | V2 schemas + 版本迁移器；智见 Profile JSON 定唯一事实源，生成 V1 兼容视图；routing/output/gate overlay；skill-package-loader（本地装载校验、digest/license 记录、contributions 解析、静态/脚本分界，**零网络**）；设置页只读预览校验 | 32 专家 pack 化，V1 行为不变；SkillPackage 校验/懒加载就绪 |
| **2 Provider Runtime** | Provider Registry + CapabilityResolver + ProviderEnvelope + provenance 审计；接入 Wind（discovery/call）与 zyt（JSON CLI/API）；local-files 与 99wiki KnowledgeProvider | Wind/zyt 契约测试通过；错误码/口径/单位不丢失 |
| **3 TeamTemplate Compiler** | 迁移顺序：research-report → roundtable/debate/ppt → 智见 A–E；旧工具变参数适配器；snapshot 对比 | 同模板三入口产出同构 DAG |
| **4 Quality Gate Runtime** | 确定性 gates → 语义 Reviewer + 两轮修复；激活 emm/rubrics；gate 版本与基准样本集 | hard fail 不可交付；报告含定位/证据 |
| **5 Harness 原生化** | L0 抽 `dsh-teams-core` Host 服务；Domain Pack/Provider 成可安装 Bundle；preset 只贡献工具与领域技能 | 第二消费者上线且无回归 |

---

## 12. 代码任务拆分

1. `schema-v2`：ExpertV2/Provider/ScenarioV2/TeamTemplate/OutputTemplate/GatePolicy/SkillPackage schema 与版本验证。
2. `zhijian-pack-migrator`：旧 Profile JSON → V2 pack；markdown/总表/索引生成器。
3. `skill-package-loader`：skill 包**本地装载**校验（builtin/workspace 来源、安全相对路径、digest/license 记录、upstreamProvenance 仅审计）、contributions 解析（MethodPack/KnowledgeProvider/OutputTemplate/QualityPolicy/Tool requirements/TeamTemplate）、静态内容与可执行脚本分界、大媒体懒加载清单；**运行时零网络**，升级=离线重装+digest 复验。
3. `provider-runtime`：Registry、CapabilityResolver、ProviderEnvelope、provenance 审计。
4. `provider-wind`：manifest discovery、MCP 双层信封规范化、retry/circuit_breaker 透传。
5. `provider-zyt`：身份/dataView、指标/城市/政策/报告、退出码与 JSON 错误规范化。
6. `provider-beike`：**部分解除阻塞**——契约已按二进制静态分析定稿（MCP 双模式挂载、--json envelope 适配、写操作审批门）；剩余阻塞仅"命令响应 schema 与口径需 macOS/arm64 或 Linux 版实测"。
7. `knowledge-99wiki`：实体/版本/引用 + Part B/C delivery 与 gate adapter（DOM 验收、双哈希）。
8. `template-compiler`：roster/DAG/input binding/gate/deliverable 统一编译。
9. `quality-runtime`：确定性 gate、语义 reviewer、两轮 repair、GateReport。
10. `asset-editor`：设置页资产列表、overlay 编辑、diff/校验/版本回滚。
11. `compatibility`：V1 adapter、旧工具薄封装、迁移期双读与 golden tests。

---

## 13. 验收矩阵

| 能力 | 验收标准 |
|---|---|
| 100+ 专家 | 启动 prompt 不增长；capability 检索可诊断 id/version 冲突 |
| Provider | Wind/zyt 契约测试通过；错误码/口径/单位/provenance 不丢失；retry/circuit breaker 遵循 provider 指令；transports 只出现 mcp-stdio/mcp-http/http-api/local-cli 四类且凭据仅 credentialRef |
| 贝壳 | 静态契约已完成（独立 Provider、与 zyt 互补已定稿）；剩余：Linux/macOS 实测响应 schema、错误行为、口径固化 |
| 知识库 | 99wiki snapshot/citation/version 可追溯；本地文件惰性生效；领域知识库 manifest（边界/本体/集合/快照/检索/策略）+ 记录级 metadata（source/observedAt/validTime/region/unit/caliber/sensitivity/checksum）可校验；ingest→publish 流水线产物带 digest |
| 模板 | 同一 TeamTemplate 经 CLI/API/模型入口调用产出同构 DAG |
| 回滚 | spawn/task/provider/gate 任一故障不留下活动半团队 |
| 门控 | hard gate 失败不得交付；两轮修复后状态明确；报告含定位与证据；B/C 分型正确 |
| 匿名化 | public 输出无实名（确定性测试）；deceased/internalOnly 规则生效 |
| 兼容 | V1 专家/场景继续可用；旧工具输出 schema 迁移期不破坏 |
| 可追溯 | 每次交付的专家/工具/知识快照/模板/gate 版本可查 |
| SkillPackage | 来源仅 builtin/workspace 本地路径（零网络，源代码级测试保证）；digest/license/upstreamProvenance 完整；静态内容只读懒加载、脚本必须经受控 ToolProvider；contributions 引用全部可解析；无 license 默认 internalOnly |

---

## 附：结论置信度总表

| 结论 | 置信级别 |
|---|---|
| Wind CLI 位置/命令面/7域39工具/双层信封/三种错误码/Key 可用 | 【实测】 |
| Wind 经 V2 transport 栈真实取数（600519.SH 行情；`cli_meta.completeness:'not_asserted'` 漂移补偿；`data.unit` 列→单位对象映射） | 【实测 2026-08-22，scripts/live-smoke-wind.mjs】 |
| Wind AUTH_ERROR/批量≤50/并发≤10 的运行时强制方式 | 【源码+文档，待触发验证】 |
| zyt 命令面/--json/X-Api-Key/退出码/dataView/buildRequestPlan | 【源码契约，本机不可执行】 |
| zyt HTTP API 直连（`/openapi/v1/me`，X-Api-Key；`dataView: internal` → caliber `zyt.internal(真实绝对量)` 进入 provenance） | 【实测 2026-08-22，scripts/live-smoke-zyt.mjs】 |
| 贝壳独立 CLI 存在性、命令面、MCP 双模式、认证路径、与 zyt 非同源 | 【二进制静态分析（strings/符号），zip 已收到】 |
| 贝壳 MCP HTTP 直连（Bearer 认证；serverInfo 布丁MCP服务 3.4.6；17 个线上工具；工具名与 CLI 静态分析推导不同，capability→工具映射以实测为准；house_search 真实房源召回） | 【实测 2026-08-22，scripts/live-smoke-beike.mjs】 |
| 贝壳逐响应 schema 的完整字段枚举与 DataGate 口径规则 | 【部分实测（单一工具），随业务使用固化】 |
| 智见包结构与 schema/债务 | 【实测（zip 解析）】 |
| 99wiki 分型门控规则 | 【规范文档，来自 wiki-gated-research skill】 |
| V2 对象契约/分层/迁移路线 | 【设计】 |
