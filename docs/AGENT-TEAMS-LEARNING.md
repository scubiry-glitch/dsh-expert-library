# AgentTeams 学习对照

本笔记记录 `@nanmicoder/dsh-agent-teams` 对 `@zhijian/dsh-expert-library` 的可迁移经验。参考实现快照为 `f60d40d`（2026-09-25，AgentTeams 0.1.21）；目标是学习协议和验证方法，不复制领域包内容。

## 当前验收状态（2026-09-27）

A0–A5 的状态、计划审批、profile captain/seed、attempt 与消息准入、结构化质量闭环、成员能力 scope 和模型 fallback 已完成；A6 的 wire/UI、doctor、离线故障/安全矩阵、真实 `pnpm pack` 隔离 profile 安装/旧包回滚已交付。历史 Host 运行暴露了 reviewer 身份、task/quality attempt 和最终 output binding admission 缺陷；前两项已在真实 reviewer member 运行中验证修复，第二次 fixed receipt 又因最终 output snapshot 不一致而降级；随后 output-binding 修复后的完整 Host 链路已通过独立 receipt。A6 仍保留一项原始 gate 限制：冷恢复后由原 worker 写入终态；GUI 活动计划续跑、同身份重启后的活动 session/plan 续跑，以及候选包宿主启动前后 rollback 均已有独立 PASS receipt。`docs/AGENT-TEAMS-BASELINE.md`、`docs/A6-EVIDENCE.md` 和 `docs/A6-HOST-EVIDENCE.md` 记录当前结果与限制。

## 先读什么

按下面顺序阅读参考实现，避免从 UI 反推运行时语义：

1. `docs/usage.md`：状态文件、staged/Approve & Run、profile captain/seed、暂停恢复和已知限制。
2. `src/types.ts`、`src/state.ts`：任务状态、attempt、成员、消息、归档和迁移兼容。
3. `src/scheduler.ts`、`src/members.ts`、`src/mailbox.ts`：ready task、冷恢复、成员唤醒、邮箱 lease/ack 和 stale message admission。
4. `docs/quality-gates.md`、`src/quality-gates.ts`：质量合同、finding、review/repair/re-review/integration 和 amendment freeze。
5. `src/capabilities.ts`、`src/harness-compat.ts`、`scripts/doctor.mjs`、`compatibility.json`：能力范围、模型路由、宿主兼容和诊断。
6. `src/snapshot.ts`、`src/web-routes.ts`、client workspace：状态快照、路由安全和 UI 与磁盘真相的一致性。

## 对照到专家库

| 学习主题 | AgentTeams 的做法 | 专家库现状 | 下一步 |
|---|---|---|---|
| 持久状态 | team 目录保存 `team.json` 和 per-agent JSONL mailbox，成员会话只是投影 | `src/state.ts`、`src/staged-plan.ts` 已有锁、原子写、归档、恢复扫描和 journal | doctor、离线归档和 Web 活动 plan/session 同身份重启续跑已完成；原 worker 冷恢复终态续写仍是明确限制 |
| 计划审批 | staged 只保存 roster/DAG，Approve & Run 才 spawn/dispatch | `src/tools.ts` 与 `src/apply.ts` 已贯通 preview/stage/edit/approve/discard/CAS/archive | wire/API、plan-only UI、真实 Host stage/approve 和 Web 活动 plan 同身份重启续跑已完成 |
| 动态规划 | profile 的 `captain` 只给 roster 和约束，`seed` 才给固定任务 | `src/profiles.ts` 已有显式 profile schema、确定性 digest、captain 动态任务和 seed 兼容 | 真实 Captain quality-chain receipt 与 GUI 活动计划截图均已完成 |
| 任务并发 | completed-only 依赖、attemptId、handoff/quiescence、冷启动恢复 | `src/scheduler.ts` 和 `src/state.ts` 已有 halt/resume、并发 claim、重分配和冷恢复 | 离线矩阵和 PARTIAL 独立成员重叠证据已完成；完整链路 resume 后由 captain 接管终态 |
| 消息准入 | 消息记录 source task/attempt/status，落盘后唤醒；stale mail 不得改变状态 | `TeamMessage` 已有 provenance、sequence、idempotency、lease/ack admission | A6 离线矩阵完成；跨 host 投递和发布回滚演练待独立确认 |
| 质量闭环 | 结构化 kind、verdict、finding、acceptance、commands、changed paths，自动 repair/review | `src/quality-run.ts`、`src/quality-runtime.ts` 已有 reviewer 分离、预算、真实 artifact/hash/command 证据与冻结；工具边界现要求真实 reviewer session、task/quality attempt 和 reviewed output binding | QualityRun 已接入 UI/doctor；旧 receipt 保留为缺陷复现，output-binding 修复后的 Host chain 已通过独立 receipt |
| 成员能力 | 成员持久化 provider/model/reasoning/fallback，`maxDepth=0` 默认禁止递归委派 | `src/capability-scope.ts`、`src/members.ts`、`src/host/provider-tool.ts` 已有 scope、route fallback、provider/task admission 和 fail-closed 恢复 | capability 矩阵与 doctor 展示已完成；候选 Host 启动/回滚的真实 profile 复核已通过 |
| 诊断发布 | doctor、compatibility matrix、offline/stress/real-model/GUI 分层验证 | 已有 doctor、全量测试、pack/builtin 校验、A6 故障/安全矩阵、真实 `pnpm pack` 隔离 profile 回滚和 fixed Host quality-chain receipt；Web identity smoke 单独留证 | **A6 已交付（带已记录限制）**；原 worker 冷恢复续写仍保留为后续增强 gate |

## 学习时的三个判断

- 先看状态和工具契约，再看 prompt。Prompt 只能指导模型，不能替代 attempt、依赖、权限和质量状态机。
- 先区分已有底座和缺口。专家库已经有锁、原子写、artifact、V2 digest、provider runtime 和 inline quality gate，优先补行为边界与证据，避免重复造实现。
- 每个借鉴点都要有负向验收。至少验证 stale attempt、重复 ack、并发 claim、坏 JSON、半成品恢复、reviewer 自审、越界 changed paths 和宿主能力缺失。

## 当前可复现演示与剩余证据

A0–A5 的离线链路与 A6 的隔离 package/profile 演练已经覆盖状态和工具契约；历史真实 Host 演示保留为 admission 缺陷复现：

`captain profile → staged plan → 批准 → worker-a/worker-b 初始执行 → reviewer pass/needs_revision → repair → re-review → integration → captain takeover 后完成 t3 → archive`

演示可从 `/tmp/expert-teams/archive/a6-host-short/team.json`、mailbox、QualityRun 事件和 [`docs/evidence/A6-REAL-HOST-QUALITY-CHAIN.json`](evidence/A6-REAL-HOST-QUALITY-CHAIN.json) 还原；该旧 receipt 已标为 `INVALIDATED_AFTER_ADMISSION_AUDIT`，不能作为当前独立审核通过。第二次 fixed 运行的 receipt [`docs/evidence/A6-REAL-HOST-QUALITY-CHAIN-FIXED.json`](evidence/A6-REAL-HOST-QUALITY-CHAIN-FIXED.json) 已因 output-binding 审计降级；新的 output-binding chain 已在 `/tmp/expert-teams-a6-fixed3` 完成并归档；receipt 为 [`docs/evidence/A6-REAL-HOST-QUALITY-CHAIN-FIXED-OUTPUT-BOUND.json`](evidence/A6-REAL-HOST-QUALITY-CHAIN-FIXED-OUTPUT-BOUND.json)。第一次独立成员重叠运行见 [`docs/evidence/A6-REAL-HOST-PARALLEL.json`](evidence/A6-REAL-HOST-PARALLEL.json)，因质量阶段超时而标为 PARTIAL。旧摘要 [`docs/evidence/A6-REAL-HOST-CHAIN.json`](evidence/A6-REAL-HOST-CHAIN.json) 仅作 `UNVERIFIED_LEGACY_SUMMARY` 历史记录。原 worker 冷恢复续写仍待证；GUI 活动 plan 与同身份重启续跑见 [`docs/evidence/A6-WEB-ACTIVE-RESTART.json`](evidence/A6-WEB-ACTIVE-RESTART.json)，候选包 Host 启动/回滚见 [`docs/evidence/A6-HOST-CANDIDATE-STARTUP-ROLLBACK.json`](evidence/A6-HOST-CANDIDATE-STARTUP-ROLLBACK.json)。
