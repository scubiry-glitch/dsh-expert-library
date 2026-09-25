# dsh-expert-library：学习 AgentTeams 的迭代计划

实现基线：`f3523c0`。当前计划修订基于 `@nanmicoder/dsh-agent-teams` 主线快照 `f60d40d`（2026-09-25，0.1.21 代码）和专家库当前实现。

这份计划只处理专家团队编排能力。学习对象是 AgentTeams 的状态模型、工具协议、调度恢复、质量门禁、宿主兼容和验证方法；专家库自己的 V2 compiler、provider runtime、专家画像、领域知识和质量 policy 继续作为业务底座，不复制对方的领域内容，也不修改 DSH 核心。

## 学习结论：借鉴什么，保留什么

AgentTeams 的关键经验不是“多开几个子代理”，而是把团队当成一个可恢复的持久工作单元：磁盘状态是真相源，成员会话只是运行时投影；计划先 staged，用户批准后才创建成员和派工；任务依赖、attempt、邮箱和质量合同都由工具与状态机约束。它还把 Captain 动态规划和固定 seed profile 分成两种明确模式，并用离线故障矩阵、真实模型运行、GUI 和兼容矩阵共同作为发布证据。

专家库当前已经具备一部分底座：`src/state.ts` 有团队锁、原子写、任务 attempt、邮箱和归档；`src/scheduler.ts` 有 ready task 调度和重试；`src/v2/compiler.ts`、`src/apply.ts` 有声明式计划编译与统一 apply；`src/v2/quality.ts`、`src/task-gates.ts` 有质量 gate；`src/members.ts`、`src/harness-compat.ts` 有成员启动和宿主能力适配；`src/client/ActivityPanel.tsx` 有活动面板。

需要借鉴并补齐的差距是：

1. 当前 `scenarioApplyCore` 和协作模式仍在编译后直接 materialize；需要加入 staged plan、审阅、批准、恢复和归档边界。
2. 当前质量链主要在任务完成时计数和重试；需要形成独立的 requirements/implementation/verification/review/repair/integration 合同链。
3. 当前任务已有 attempt，但消息没有完整的来源 task/attempt/status 和 exactly-once admission；需要让迟到消息不能覆盖新状态。
4. 当前专家画像和 V2 capability 是任务/领域能力；需要增加成员级 scope、模型路由、fallback、delegation depth 和冷恢复快照。
5. 当前有活动面板和 API，但没有 AgentTeams 式的 profile 模式、计划编辑反馈、停止/恢复语义和独立 doctor/兼容矩阵。

## 借鉴矩阵

| AgentTeams 机制 | 专家库的学习方式 | 不直接照搬的部分 |
|---|---|---|
| `team.json` + `inbox/*.jsonl` 是持久真相源 | 保持现有 stateRoot，补齐 schema、归档、恢复和消息 provenance | 不改变专家包和领域知识的目录契约 |
| staged → 用户审阅 → Approve & Run | 将 `scenarioApplyCore` 接到统一 staged/apply bridge | 不把批准流程做成宿主专属 UI，工具 API 必须可独立调用 |
| `taskPlanning: captain` / `seed` | profile 只提供 roster、模型和门禁；Captain 可按目标生成 DAG | 不删除现有 V2 场景模板，legacy scenario 保留兼容模式 |
| `attempt` + `attemptId` + 迟到写入拒绝 | 将来源代际写入任务更新和消息 admission | 不用无限自动重派掩盖成员失败 |
| review → repair → re-review → integration | 把专家库 quality policy 映射为结构化合同和 artifact refs | 不让 captain 通过普通更新静默绕过硬门 |
| capability seam、provider/model fallback、maxDepth | 复用现有 provider runtime，补 scope、fallback 和 doctor | 不把宿主所有 capability 注入每个专家 persona |
| 离线、故障矩阵、真实模型、GUI、发布门禁 | 建立同样的证据分层和失败注入 | 不把一次 mock 或单次浏览器截图当成完成证明 |

## 开发阶段和验收标准

### A0：基线审计和学习样例

**目标**：把 AgentTeams 的机制映射到专家库现有实现，先建立可比较的行为样例。

**交付物**

- `docs/AGENT-TEAMS-LEARNING.md`：记录状态机、工具协议、profile、质量合同、恢复策略和兼容边界的对照表。
- 一组专家库 fixture：空团队、staged 团队、带依赖 DAG、失败 attempt、归档团队、邮箱突发和质量 finding。
- 记录现有 `pnpm typecheck`、串行全量测试、`pnpm check:pack` 的提交、版本和结果。

**验收标准**

- 相同输入重复编译的 plan/digest、roster、task DAG 和 quality bindings 稳定。
- 旧 V1/V2 fixture、领域包、专家画像和 provider capability 行为保持不变。
- 新环境能按 README 复现；提交不包含 `work/` 临时交付物。

**出口**：对照表和 fixtures 合并后，才开始改变 `scenarioApplyCore` 的执行边界。

### A1：持久计划和两阶段审批

**目标**：实现 AgentTeams 的核心交互：先生成可编辑计划，批准后才创建成员、任务和调度。

**源码范围**：`src/types.ts`、`src/state.ts`、`src/tools.ts`、`src/apply.ts`、`src/team-core.ts`。

**开发任务**

- 增加 `StagedPlan`、`schemaVersion`、`planId`、`digest`、`revision`、`expiresAt`、`planProvenance`、`editLog` 和 `approval`；状态固定为 `staged → approved → running → completed|failed`，另有 `discarded|expired` 终态。
- 增加 `expert_teams_plan_preview`、`expert_teams_plan_stage`、`expert_teams_plan_edit`、`expert_teams_plan_approve`、`expert_teams_plan_discard`；preview 是纯读，stage 才落盘。
- approve 使用 team/plan 锁和 CAS；只有 approved plan 可以调用现有 `applyExecutionPlan`，并建立唯一 `planId → teamId` 映射。
- 重启扫描 staged/running 计划；半成品按 journal 清理或进入可诊断 failed；完成后归档。

**验收标准**

- preview 前后 state、team、member、task、mailbox 和 live wake 的 tree digest 不变。
- edit 只允许 params、roster/assignment、renderMode、goal/target；编辑后 digest/revision 改变，旧 digest approve 必须拒绝。
- 两个和十个并发 approve 只产生一次 team/member/task 创建；重复 approve 返回同一结果。
- 未批准计划零 spawn；apply 在 team/member/task 任一创建点失败时可回滚或留下明确 failed，不留下无法解释的半队。
- staged、approved、running 在进程退出后可恢复；过期、discard、坏 JSON、stale lock 和非法状态转移均有稳定错误码和审计记录。

**里程碑 M1**：preview → stage → edit → approve → apply → archive 贯通，V1 golden 和旧场景兼容通过。

### A2：Profile 与 Captain 动态规划

**目标**：学习 AgentTeams 将“固定模板”和“按目标动态规划”分开的方式，避免专家库把每种任务都写成硬编码协作工具。

**源码范围**：新增 `src/profiles.ts`；调整 `src/collab/templates.ts`、`src/collab/tools.ts`、`src/tools.ts`、`src/types.ts`。

**开发任务**

- 定义 profile schema：description、protocol、members、provider/model/reasoning route、fallback、`taskPlanning: captain|seed`、review policy。
- `seed` 模式继续展开现有 roundtable、debate、research 等固定模板；`captain` 模式只冻结 roster、能力和门禁，由 Captain 在 staged 阶段生成任务 DAG。
- profile 解析只接受显式 `--profile name` 或工具参数；配置键、成员数、任务数、依赖环、重复名称和未知字段在 spawn 前拒绝。
- 计划面板和工具结果展示可编辑 member route、role、task assignee、dependencies 和 acceptance；反馈回到同一个 plan，不另建团队。

**验收标准**

- 同一 profile 在 seed/captain 两种模式下行为可区分；captain 模式不偷偷注入固定 DAG，seed 模式结果保持旧 golden。
- profile 校验失败时没有 state/team/member/task 写入；显式 profile 解析不把普通目标文本误认为 profile。
- 计划反馈、取消、放弃和批准都作用于原 `planId`；放弃后不能自动重建同一计划。
- Captain 生成的 DAG 依赖可拓扑排序、无环、每个 task 有 owner 或可领取规则，并能在 preview 中审阅。

### A3：任务 attempt、调度和消息准入

**目标**：把 AgentTeams 的“任务状态是真相、attempt 是执行能力、邮箱是可靠补偿通道”落实到专家库。

**源码范围**：`src/types.ts`、`src/state.ts`、`src/scheduler.ts`、`src/collab/tools.ts`、`src/tools.ts`。

**开发任务**

- 固定任务状态转移 `pending → claimed → in_progress → completed|failed|cancelled`；每次 claim/retry/reassign 产生单调 `attempt` 和唯一 `attemptId`。
- update、reassign、remove member 前先撤销旧 attempt，再等待旧成员收敛；迟到更新、终态覆盖和双重领取必须拒绝。
- `TeamMessage` 增加 `sourceTaskId/sourceAttemptId/sourceTaskStatus/sequence/idempotencyKey`；live 投递失败回 mailbox，读取使用 claim lease、dedupe、ack。
- 停驻 attempt 不自动升代；只在冷启动或显式 retry/reassign/resume 时开启新 attempt。支持 halted/resume，并区分 halted 与自动升级上限。

**验收标准**

- 依赖未完成的 task 不可 claim；一个成员不能同时持有两个未完成任务；failed/cancelled 不解锁下游。
- 重分配后旧 attempt 的 update、message、ack 不改变新状态；同 idempotencyKey 只处理一次。
- 并发 claim/reassign/send 不丢消息、不重复 spawn；邮箱坏行不影响其他消息；重启后 lease 可恢复。
- halted 团队不能被普通 create_task 静默恢复，resume 必须显式携带原因；归档保留任务、依赖图、attempt 和 mailbox。

**里程碑 M2**：动态计划可以在重启、延迟消息、成员失败和显式暂停后继续或安全停止。

### A4：结构化质量合同和多轮修复

**目标**：直接学习 AgentTeams 的 quality-gates 设计，把专家库当前“完成时 gate 检查”升级成可审计的交付闭环。

**源码范围**：`src/v2/quality.ts`、`src/task-gates.ts`、`src/types.ts`、`src/scheduler.ts`。

**开发任务**

- 为 requirements、implementation、verification、review、repair、integration 增加 `kind`、objective、inScope、outOfScope、acceptance、verify、deliverables、changedPaths 和 `coverageOf`。
- 增加 `Finding`、`ReviewVerdict`、`AcceptanceResult`、`CommandResult`、`ReviewRun`、`TaskEvidence` 和 `TaskRevision`；artifact ref 必须带 task/attempt/hash。
- reviewer 与 assignee 分离；review 只有 `pass` 能 completed，`needs_revision|reject` 必须 failed 并带 finding；失败自动生成不依赖 failed review 的 repair 和下一轮 review。
- repair round 和 review round 跨重启保存；超过 policy 上限进入 escalated/blocked，不能静默放行。Captain 只能通过显式 amendment 修改非终态合同，修订进入 append-only ledger，审查通过后冻结。
- 保留旧 inline quality gate 的 V1 兼容；新 staged/profile 路径使用独立 QualityRun，不把业务 TaskStatus 和 review 状态混为一谈。

**验收标准**

- 覆盖 pass、soft warn、hard block、repair-pass、两轮后通过、第三次失败、缺 artifact、hash mismatch、旧 attempt 和 reviewer=assignee。
- 完成任务必须有 acceptanceResults、commandsRun、changedPaths 和最终 artifact hash；越界 changedPaths 被拒。
- review 失败自动生成 repair → re-review；integration 只消费通过的 artifact refs，下游不会被 failed review 解锁。
- 重启和重复事件不重复生成 review/repair；repair 预算不因新进程重置；amendment 不能修改已通过并冻结的合同。

**里程碑 M3**：质量循环由机器状态、finding、证据和预算决定，不依赖成员在文本中自报“已通过”。

### A5：成员能力、模型路由和宿主兼容

**目标**：学习 AgentTeams 的 capability seam：成员的身份、模型路由、工具范围和宿主能力必须可解释、可恢复。

**源码范围**：`src/members.ts`、`src/harness-compat.ts`、`src/team-core.ts`、`src/v2/provider-runtime.ts`、`src/types.ts`。

**开发任务**

- 持久化 `capabilityScope`：expert id、role、允许 provider/tool/knowledge/task、delegation depth、schema version、来源 profile 和 bootstrap 摘要；默认 `maxDepth=0`。
- 固定 route 优先级：成员显式 route → expert/profile route → plugin default → Captain 当前 route；模型切换时重新校验 reasoning effort，并保存 fallback route 和实际生效 route。
- spawn 和 provider call 都做 scope admission；缺少宿主过滤、continuable 或工具能力时采用显式 lenient filter，记录剔除能力、`spawnError`、fallback/stopping，不静默放宽权限。
- 冷启动、压缩和重启按 durable member id、task、attempt、scope 和 route 恢复；成员 session 是投影，不能反向覆盖持久身份。

**验收标准**

- 不在 allowlist 的 tool/provider/knowledge/task 返回结构化 denied；默认不能嵌套 delegation；scope 重启前后一致。
- route 解析优先级、fallback、reasoning effort 和 provider 不兼容均有矩阵测试；实际 route 写入 team state。
- 宿主缺 capability 时团队能按约定启动或明确 stopping；被过滤项、降级理由和恢复动作出现在 status/doctor。
- 成员失败、冷恢复、旧 state 缺字段和旧 plugin compatibility case 不会生成重复成员或丢失任务能力。

### A6：活动面板、Doctor 和证据化发布

**目标**：学习 AgentTeams 的产品和验证闭环，让专家团队可观察、可诊断、可复盘。

**源码范围**：`src/client/*`、`src/index.ts`、`src/host/*`、新增 `src/doctor.ts` 或等价模块。

**开发任务**

- 活动面板展示当前会话团队、阶段、真实成员状态、task DAG、attempt、quality finding、repair round、消息和归档入口；提供 staged plan 编辑、反馈、批准、停止、resume 和放弃。
- API 与 UI 共用 wire schema；刷新、会话切换和重启从磁盘恢复，不依赖内存缓存；空、加载、错误、无权和历史团队状态均可操作。
- 增加 `expert_library_doctor`：检查 state/schema、stale lock、team/mailbox、provider/model、capability、profile、quality policy、路由安全和迁移版本，输出机器可读 finding、原因和修复建议，运行无副作用。
- 建立四层验证：离线纯函数/状态测试；故障矩阵；真实 provider/headless e2e；GUI/无障碍 smoke。版本发布前执行兼容矩阵、构建、全量串行测试和回滚演练。

**验收标准**

- UI 与工具 API 对同一 plan/team/task 深比较一致；刷新和重启不丢阶段、attempt、finding、消息和归档。
- doctor 对坏 JSON、stale lock、损坏 team、缺 provider、scope 越权、错误来源和旧 schema 返回固定 code/path/remediation；doctor 不写磁盘、不触发 spawn。
- 覆盖 loopback/token/forwarded/Origin/CSRF 的路由安全负例；未认证写操作被拒，错误响应不泄露凭据。
- 真实运行至少完成一条“动态规划 → 批准 → 并行任务 → review/repair → integration → 归档”链路，并保留 state、事件、日志和 UI 证据。

**里程碑 M4**：完成产品化、诊断、兼容和回滚证据后，才允许 bump minor 版本。

## 依赖、分支和完成定义

主依赖为 `A0 → A1 → A2 → A3 → A4 → A5 → A6`。A1 完成后 A2 与 A3 可并行；A3 的消息准入应早于 A4 的质量调度；A4 完成后 A5/A6 可按冻结的 wire schema 并行。每一阶段拆成独立 commit 或 feature flag，不在同一提交同时改变 state migration、wire contract 和 UI。

每个阶段关闭前必须留下：代码位置、schema/migration、正向与负向测试、故障注入、状态前后对照、兼容回归、文档、回滚方法和真实演示入口。只通过 mock、只增加字段或只完成 UI 都不算阶段完成。

第一批建议顺序：

1. **A0/A1**：写学习对照文档和 fixtures，先实现 staged plan、preview no-side-effect、approve CAS。
2. **A2/A3**：实现 profile captain/seed、attempt provenance、消息 admission、halt/resume。
3. **A4**：把现有 quality gate 拆成结构化 review/repair/integration 合同和恢复测试。

## 参考

- AgentTeams 使用、状态文件、staged 协议、profile 和恢复语义：[docs/usage.md](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/docs/usage.md)
- AgentTeams 质量合同、review/repair 门禁和当前缺口：[docs/quality-gates.md](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/docs/quality-gates.md)
- AgentTeams 版本兼容与真实验证边界：[README.md](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/README.md)、[v0.1.21 release notes](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/release-notes/v0.1.21.md)
