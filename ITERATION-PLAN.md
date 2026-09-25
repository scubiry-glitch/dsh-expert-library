# dsh-expert-library 迭代计划

基线提交：`f3523c0`（已推送到 `origin/main`）。本基线包含 Pack Center 本地运行时、pack contract/artifact、管理 API/UI、V2 pipeline 兼容声明和测试夹具；旧版 `zhijian-realestate` 领域包保持完整。

## 目标

把当前“编译后直接执行”的专家团队升级为可审阅、可恢复、可追责的执行系统，同时保留已有 V1/V2 兼容、领域包分层和 fail-closed 约束。所有新状态都必须可持久化、可重放、可审计；不重写已有 compiler、provider runtime、quality chain 和 Pack Center 核心。

## 阶段 0：基线与发布纪律（P0）

**工作项**

- 固定每个迭代的 commit、包版本、领域包 tree digest 和测试报告。
- 保持 `pnpm typecheck`、`pnpm test`、`pnpm check:pack`、`pnpm test:pack-center` 为发布门禁；测试入口使用串行模式，避免生成包共享目录互相覆盖。
- 更新 `ARCHITECTURE-COMPARISON.md`，将 AgentTeams v0.1.21 的“已继承 / 缺口 / 本项目实现”分栏维护。

**出口**：新环境按 README 完成安装、构建、领域包校验；`pnpm test` 690/690 通过；提交中不包含 `work/` 交付物或临时报告。

## 阶段 1：Staged Plan 与审批（P0）

**源码落点**：`src/tools.ts` 的 `scenarioApplyCore`、`src/v2/types.ts` 的 `ApprovalPolicy`、`src/state.ts`、`src/team-core.ts`。

**工作项**

- 新增持久化 `StagedPlan`：`planId`、`digest`、状态（`staged/approved/discarded/running/completed/failed`）、创建会话、参数与 roster、编辑日志、过期时间、`planProvenance` 和 `qualityPlan`。
- 统一执行路径：`compile → stage → review/edit → approve → apply → archive`；未审批的计划不得创建 active team、成员或任务。
- 增加 `expert_teams_plan_preview/edit/approve/discard`；编辑只允许参数、指派、渲染模式和目标描述白名单，编辑后必须重新编译并更新 digest。
- 使用现有锁、原子写和归档机制；approve 幂等，过期与 discard 可回收，保留 V1 legacy 直接行为的兼容开关。

**验收**：同输入生成稳定 digest；preview 无副作用；旧 digest 在编辑后被拒绝；并发 approve 不重复建队；重启后 staged 状态可恢复；V1 场景 golden 测试不变。

## 阶段 2：质量审查闭环（P0/P1）

**源码落点**：`src/v2/quality.ts`、`src/task-gates.ts`、`src/tools.ts`。

**工作项**

- 在现有 `runQualityChain` 上增加 `QualityTaskContract`、`Finding`、证据引用、修复位置、artifact hash 和 provenance。
- 将完成后的质量流程拆为独立 reviewer → 定向 repair → re-review → integration DAG；reviewer 不得与原 assignee 相同。
- 硬门失败最多自动修复 2 轮，预算跨重启保存；超限转 `blocked`，只能显式 waiver，不能静默放行。
- integration 只消费通过的 artifact refs；所有 captain 修改写入 amendment ledger，并关联 task attempt 与 plan digest。

**验收**：覆盖 pass、soft warn、hard block、repair-pass、第三次失败、artifact 缺失和旧 attempt 拒绝；质量分、修复数、报告和 UI 数据一致。

## 阶段 3：能力边界与冷恢复（P1）

**源码落点**：`src/members.ts`、`src/team-core.ts`、`src/harness-compat.ts`、`src/state.ts`。

**工作项**

- 为成员持久化 `capabilityScope`：身份、允许工具/provider、知识范围、任务范围、delegation depth 和 schema 版本；成员默认 `maxDepth=0`，显式 profile 才能开一层。
- spawn admission 与每次工具调用都执行 allowlist；上下文压缩、重启、冷恢复时用固定 bootstrap 恢复身份、task、attempt 和 scope。
- 增加宿主能力缺失时的 lenient filter、`spawnError`、fallback route 和 stopping 状态；自动降级必须记录被剔除的能力并 fail-closed。

**验收**：越权工具、provider、知识路径返回结构化 denied；重启后 scope 不漂移；默认不允许嵌套 delegation；缺少宿主过滤 API 时团队可启动且有可见降级记录。

## 阶段 4：消息 provenance 与 attempt admission（P1）

**源码落点**：`src/types.ts`、`src/state.ts`、`src/scheduler.ts`、`src/collab/tools.ts`。

**工作项**

- 为 `TeamMessage` 增加 `sourceTaskId/sourceAttemptId/sourceTaskStatus/sequence/idempotencyKey`，旧 JSONL 采用 tolerant parser 兼容读取。
- live 与 mailbox 统一 admission：终态任务、过期 attempt、已退休成员的消息拒绝并记录原因；相同 idempotency key 只处理一次。
- 失败实时投递回 mailbox；读取采用 claim lease、去重、ack；停驻 attempt 不增加代际，只有冷恢复才开启新 attempt。

**验收**：并发投递不丢不重放；重分配后旧报告不改变任务状态；重复 ack、重启、过期消息均可审计；邮箱坏行不影响其他消息。

## 阶段 5：Doctor、兼容矩阵与路由安全（P1）

**源码落点**：`src/host/*`、`src/host/auth.ts`、`src/index.ts`、`src/harness-compat.ts`。

**工作项**

- 新增 `expert_library_doctor`（工具或 CLI）：检查 provider、continuable/depth/tool-filter、配置 schema、team/mailbox 完整性、pack/provider/credential 可见性和 route/auth/CORS。
- 输出 machine-readable findings、修复建议及 Harness/插件版本能力矩阵；doctor 必须无副作用。
- 逐路由复用 auth、Origin/CSRF fence；覆盖 `/state`、`/assets`、`/project`、Pack Center 和 manage 写面，默认 fail-closed。

**验收**：缺失能力、坏 JSON、stale lock、损坏 team 和错误来源均能诊断；未认证或跨 Origin 读写被拒；测试覆盖 loopback、token、forwarded request 和 CSRF。

## 阶段 6：Workspace UI 与产品化（P2）

**源码落点**：`src/client/*`、`src/pack-center-wire.ts`。

**工作项**

- 在现有活动/设置/Pack Center 卡片加入 staged plan 列表、详情、参数/roster 编辑、digest/provenance、approve/discard、质量 finding、修复轮次和消息时间线。
- UI 与工具 API 使用同一 wire schema；补空状态、错误恢复、刷新/重启恢复、键盘可达、多语言和主题支持。
- 增加 `/expert` 或等价显式入口，提供 profile/skill 发现与 scoped activation，避免把全量专家提示词注入每个成员。

**验收**：UI 操作与 API 结果一致；刷新后状态不丢；未认证写操作被拒；a11y smoke、路由安全和 wire schema 回归通过。

## 里程碑

- **M1**：阶段 1完成；preview/edit/approve/discard 可用，preview 无副作用。
- **M2**：阶段 2、4完成；质量 DAG、修复预算、消息 provenance 和 attempt admission 可审计。
- **M3**：阶段 3、5完成；scope、冷恢复、doctor、兼容矩阵和逐路由安全门禁完成。
- **M4**：阶段 6完成；UI 与 API 同构，完成隔离环境、故障注入、回滚和双实例验收。

每个里程碑都必须通过 typecheck、全量串行测试、Pack 校验、崩溃恢复测试和安全回归后再 bump minor 版本；未达到出口条件的阶段不宣称完成。

## 当前下一步

从阶段 1开始：先冻结 `StagedPlan` wire schema 和状态机，再为 `scenarioApplyCore` 加 preview/stage 分支；完成 no-side-effect、digest 稳定性、并发 approve、过期回收和 V1 兼容 golden 测试后，才接入质量 DAG 自动化。

## 后续开发拆解：S0–S7 波次

上面的阶段描述用于说明能力边界，下面的波次用于直接安排开发和验收。每个波次都要同时满足“代码具备能力”和“验收证据已经留存”两个条件；单元测试、mock 中心和编译浏览器流程不能替代故障注入或真实恢复证据。Pack Center 的真实公开包、双租户和离线回退继续按 [PACK-CENTER-DEVELOPMENT-PLAN.md](PACK-CENTER-DEVELOPMENT-PLAN.md) 的 W0–W5 执行，本节只拆专家团队编排主线。

### S0：基线、契约和夹具冻结

**目标**：在改动执行路径前冻结计划、审批、质量和 provenance 的数据边界，保证后续状态可迁移、可重放。

**开发任务**

- 在 `src/v2/types.ts`、`src/types.ts`、`src/v2/quality.ts` 中定义 `StagedPlan`、状态机、`QualityTaskContract`、`Finding`、`ReviewRun`、`Amendment` 和 `schemaVersion`；记录字段必填性、枚举和未知字段策略。
- 在 `src/v2/digest.ts` 固定 canonical serialization 和 digest 输入；在 `test/fixtures/` 建立 V1 golden、旧 JSONL、坏 JSON、未知字段和完整 staged/quality 样例。
- 写 schema 迁移说明和状态恢复约定；所有新记录必须能关联 `planId`、`taskId`、`attemptId`、来源会话和 actor。

**验收标准**

- 相同执行计划和参数在不同键顺序、进程和重启后得到相同 digest；参数、roster、provider、quality policy 的任一改变都会改变 digest。
- 新旧 JSON 均可按约定读取；坏 JSON、未知 schema 和缺失必填字段返回结构化错误，不被当成空状态。
- 所有 fixture 通过 JSON round-trip、schema 校验和类型检查；此波不修改 active team、member、task 或 mailbox。

**出口与停止条件**：schema、迁移策略、golden fixture 和测试报告已提交。若 digest 输入尚未冻结，停止后续 `scenarioApplyCore` 改造。

### S1：纯编译和预览边界

**目标**：将“编译计划”和“执行计划”拆开，让用户可以安全审阅计划内容。

**开发任务**

- 从 `src/tools.ts` 的 `scenarioApplyCore` 抽出纯函数 `compilePlanDraft(input)`，复用现有 compiler、provenance 和 quality plan，产出稳定的 `ExecutionPlan`/`StagedPlanDraft`。
- 增加 `expert_teams_plan_preview`；返回 `planId`、digest、roster、task DAG、provider/quality 摘要和诊断，不写入 state、team、member、task、mailbox 或 live wake。
- 将需要持久化的 stage 操作与 preview 分开设计；preview 不因“查看”而创建过期记录。若产品需要保存草稿，另由 S2 的 stage 接口显式完成。

**验收标准**

- preview 前后 state-root tree digest、team 列表、成员列表、任务列表和 mailbox digest 完全相同。
- 同一输入重复 preview 的 digest、roster、DAG 和诊断稳定；参数错误、模板错误、roster 错误和 provider 绑定错误可区分。
- 现有 V1 golden DAG 和 legacy immediate apply 行为不变，兼容开关明确标注，不默认扩大旧路径权限。

**出口与停止条件**：no-side-effect 证据和 V1 golden 回归通过。若 preview 仍调用写状态的执行函数，停止并先完成 adapter 拆分。

### S2：Stage 持久化与生命周期内核

**目标**：让计划在审批前可持久化、可恢复、可过期回收，并保证状态转移是单向且可审计的。

**开发任务**

- 在 `src/state.ts` 增加 plans 存储、原子写、锁、CAS/revision、归档和恢复 journal；记录 `planId`、digest、status、createdBy/session、expiresAt、params、roster、planProvenance、qualityPlan 和 editLog。
- 实现状态转移 `staged → approved|discarded|expired`、`approved → running`、`running → completed|failed`；非法跳转返回稳定错误码。
- 增加 `expert_teams_plan_stage`、过期扫描和 discard；同 digest stage 幂等，坏临时文件和 stale lock 可恢复或明确阻断。

**验收标准**

- 进程在 stage 后退出，重启可恢复同一个 `planId`、digest、revision 和有效期；过期计划可回收且保留审计记录。
- 并发 stage 不产生重复记录；非法状态跳转、旧 revision、坏临时文件和错误 actor 均拒绝。
- stage 本身不创建 active team、成员、业务任务或 mailbox；每次状态变化均可由 journal 重放。

**里程碑 M1 出口**：S0–S2 全部通过，形成可重放的 preview→stage 流程；未通过前不接入审批和自动 apply。

### S3：编辑、审批和并发控制

**目标**：把人工审阅变成受约束的、可比较的批准操作。

**开发任务**

- 增加 `expert_teams_plan_edit`、`expert_teams_plan_approve`、`expert_teams_plan_discard`；编辑只允许参数、assignments/roster、renderMode、goal/target 等白名单字段。
- 每次 edit 重新编译，更新 digest、revision、parentDigest 和 editLog；禁止通过编辑直接改 template、provider policy、quality gate 或 capability policy。
- approve 要求当前 digest/revision、未过期和权限通过；对 plan 与 captain 使用锁和 CAS，保存批准 actor、时间和来源。

**验收标准**

- 编辑后的旧 digest/revision 审批必拒；越权字段、超 cardinality、过期计划和错误 actor 返回结构化 denied。
- N=2 和 N=10 并发 approve 只有一次实际建队资格；重复 approve 返回同一个批准结果，不创建第二个 team。
- approve、discard、过期回收和重启恢复后的 wire fixture 可稳定比较；approved 后 edit/discard 被拒。

### S4：批准后的 apply、归档和崩溃恢复

**目标**：让执行路径只消费已批准且 digest 固化的计划，解决审批与建队之间的崩溃窗口。

**开发任务**

- 在 `src/tools.ts`、`src/team-core.ts` 增加 `expert_teams_plan_apply` 或 approve 后显式 apply；只消费 approved 计划，创建 team 时写入 `planRef`、`planProvenance` 和 `qualityPlan`。
- 在创建 team/member/task 的关键点写事件日志和唯一 `planId → teamId` 映射；失败时标记 failed 并按恢复策略清理半成品。
- 重启扫描 running 计划，继续未完成步骤或进入可诊断的 failed；完成后归档，不重复 spawn。

**验收标准**

- 未批准计划永远不能创建 active team、成员、业务任务、live wake 或 mailbox 投递。
- 同一 plan 重复 apply 幂等；在 create team、member、task、kick 任一步注入失败，都不会留下不可解释的半队状态。
- apply 中途退出后重启能恢复或安全失败；旧 V1 golden 仍通过，legacyImmediateApply 的开关和审计可见。

**里程碑 M2 出口**：S3–S4 通过后，完成 preview→stage→edit→approve→apply→archive 的最小闭环；无并发、重启和失败注入证据不得进入质量自动化。

### S5：质量合同和证据数据层

**目标**：把现有质量检查结果变成能关联任务尝试、artifact 和计划 digest 的持久合同。

**开发任务**

- 在 `src/v2/quality.ts`、`src/task-gates.ts` 增加 `QualityTaskContract`：`contractId`、`planId`、`sourceTaskId/attemptId`、artifact refs/hash、policy/gate refs、output schema、reviewer selector、maxRepairRounds。
- 增加 `Finding`、`ReviewRun` 和 `Amendment`：每条 finding 记录 severity/code/location/evidence/expected/actual/provenance；每次 captain 修改记录前后 hash、原因和来源 attempt。
- 让旧 inline quality gate 继续兼容；staged path 使用 contract 并生成统一报告，缺失 artifact、hash 不符和旧 attempt 默认 fail-closed。

**验收标准**

- contract、finding、review run 和 amendment 可 round-trip；artifact ref 必须在允许范围且 hash 匹配。
- reviewer 与 assignee 相同、旧 attempt、缺 artifact、过期 plan digest 均被拒并保留 finding。
- runtime、归档报告和后续 UI 使用同一字段和 hash；旧计划读取不因新增字段失败。

### S6：质量 reviewer→repair→re-review→integration DAG

**目标**：形成有限预算、可恢复、不可静默放行的质量闭环。

**开发任务**

- 在 `src/v2/quality.ts`、`src/tools.ts` 建立独立 QualityRun DAG；源任务完成只生成一个以 `planId+taskId+attemptId` 为幂等键的 reviewer run。
- reviewer 必须与 assignee 分离；pass/soft warn 进入 integration，hard fail 只生成定向 repair，repair 后 re-review，最多两轮。
- 第三次失败进入 blocked，只有显式 waiver 才能继续；integration 只消费通过的 artifact refs，并把最终 hashes 和 findings 写入报告。

当前 `runQualityChain` 虽有可选 repair callback，但生产完成门禁仍主要是 `gateFailCount` 与同 attempt 重试；在独立 QualityRun、reviewer/repair task 和 provenance 接通前，只能算旧闭环，不能作为本波完成证据。

**验收标准**

- 覆盖 pass、soft warn、hard block、repair-pass、两轮后通过、第三次失败 blocked、artifact missing/hash mismatch、reviewer=assignee 拒绝。
- 重启、重复事件和重复 ack 不重复生成 reviewer/repair；repair 预算跨重启保存，不能由新进程重置。
- 未完成 integration 的任务不向下游发布；报告能还原每轮 reviewer、repair、finding、预算和最终 artifact hash。

**里程碑 M3 出口**：S5–S6 通过，质量 DAG、修复预算和证据链可恢复；未通过的质量结果不能被 captain 修改后直接标为通过。

### S7：能力范围、消息准入、Doctor 和产品入口

**目标**：在闭环能力稳定后补齐运行边界、消息可信来源、诊断和用户操作面。

**开发任务**

- 在 `src/members.ts`、`src/team-core.ts`、`src/harness-compat.ts`、`src/state.ts` 固化 `capabilityScope`、默认 `maxDepth=0`、provider/tool/knowledge/task allowlist、bootstrap 和冷恢复；缺宿主能力时记录过滤项、`spawnError` 和 stopping/fallback。
- 在 `src/types.ts`、`src/scheduler.ts`、`src/collab/tools.ts` 为消息增加 `sourceTaskId/sourceAttemptId/sourceTaskStatus/sequence/idempotencyKey`；统一 live/mailbox admission、claim lease、dedupe、ack 和旧 JSONL tolerant parser。
- 在 `src/host/*`、`src/host/auth.ts`、`src/index.ts` 增加无副作用 `expert_library_doctor`，检查 provider、continuable/depth/tool-filter、state/team/mailbox、pack/provider 可见性及 route/auth/Origin/CSRF；输出机器可读 findings 和兼容矩阵。
- 在 `src/client/*`、`src/pack-center-wire.ts` 接入 staged plan、digest/provenance、approval/expiry、quality findings/rounds、消息时间线、doctor 结果和 `/expert` scoped activation；旧工具和 V1 wire 保持兼容。

**验收标准**

- 越权工具/provider/知识路径、默认嵌套 delegation、终态任务、过期 attempt、退休成员消息和重复 idempotency key 均结构化拒绝且可审计；坏邮箱行不影响其他消息。
- 重启、上下文压缩和宿主缺能力时 scope 不漂移；缺失过滤 API 时团队可按 lenient filter 启动，但被剔除能力和 fallback 必须可见，禁止静默放宽。
- doctor 对缺 provider、坏 JSON、stale lock、损坏 team、错误 Origin、未认证写请求给出稳定 finding；doctor 不修改状态。
- UI 与工具 API 对同一状态深比较一致；刷新/重启恢复、空/错误/无权限状态、键盘可达和 route 安全回归通过；全量 V1 测试保持 690/690。

**里程碑 M4 出口**：S7 通过并完成隔离环境故障注入、回滚和双实例证据；随后才可以 bump minor 版本并把对应能力标为完成。

## 波次依赖、并行和统一完成定义

依赖关系为 `S0 → S1 → S2 → S3 → S4 → S5 → S6 → S7`。S3 通过后，能力范围和消息准入可以分支实现；S5 通过后，UI 可以按冻结 wire schema 并行开发。Pack Center 的 W0–W5 与 S0–S4 可并行，但真实双租户验收必须同时满足 W1/W2/W3 出口和 S4 的批准执行语义。

每个波次完成时必须留下：任务编号对应的代码/文档位置、受影响测试及完整结果、故障注入记录、状态/摘要前后对照、已知限制、可演示入口和回滚方法。只完成代码或只通过 mock 不得关闭任务；任何失败、过期、权限拒绝和降级路径都必须有稳定错误码、审计记录和恢复动作。

下一组三个可直接开工的 PR：

1. **PR-S0/S1**：冻结 schema、digest 和 fixtures，抽出纯编译函数，实现 preview no-side-effect。
2. **PR-S2/S3**：实现 stage 存储、状态机、edit/approve/discard、CAS 和并发审批测试。
3. **PR-S4/S5**：接批准 apply、崩溃恢复、plan provenance 和 `QualityTaskContract`/`Finding` 数据层。
