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
