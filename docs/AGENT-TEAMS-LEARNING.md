# AgentTeams 学习对照

本笔记记录 `@nanmicoder/dsh-agent-teams` 对 `@zhijian/dsh-expert-library` 的可迁移经验。参考实现快照为 `f60d40d`（2026-09-25，AgentTeams 0.1.21）；目标是学习协议和验证方法，不复制领域包内容。

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
| 持久状态 | team 目录保存 `team.json` 和 per-agent JSONL mailbox，成员会话只是投影 | `src/state.ts` 已有锁、原子写、归档和邮箱 | 增加 staged plan schema、recovery journal 和状态迁移 |
| 计划审批 | staged 只保存 roster/DAG，Approve & Run 才 spawn/dispatch | `src/apply.ts` 已有统一 apply，但 scenario/collab 仍直接 materialize | 抽出 preview/stage/edit/approve/discard |
| 动态规划 | profile 的 `captain` 只给 roster 和约束，`seed` 才给固定任务 | `src/collab/templates.ts` 以固定模板为主 | 增加 profile schema，保留 legacy seed |
| 任务并发 | completed-only 依赖、attemptId、handoff/quiescence、冷启动恢复 | `src/scheduler.ts` 和 `src/state.ts` 已有大部分机制 | 补宿主 e2e、重启、并发 claim 和停驻 attempt 证据 |
| 消息准入 | 消息记录 source task/attempt/status，落盘后唤醒；stale mail 不得改变状态 | `TeamMessage` 有 lease/delivery/read，但缺来源代际和幂等键 | 增加 provenance、sequence、idempotency 和 ack admission |
| 质量闭环 | 结构化 kind、verdict、finding、acceptance、commands、changed paths，自动 repair/review | `src/task-gates.ts` 主要是完成时 gate 和 repairCount | 独立 QualityRun，reviewer 与 assignee 分离，预算跨重启 |
| 成员能力 | 成员持久化 provider/model/reasoning/fallback，`maxDepth=0` 默认禁止递归委派 | 已有 route 解析、provider runtime 和部分 capability gate | 增加成员 scope、bootstrap、spawnError 和冷恢复 |
| 诊断发布 | doctor、compatibility matrix、offline/stress/real-model/GUI 分层验证 | 有 typecheck、全量测试和 pack 校验 | 增加 doctor、真实 host 矩阵和故障演练 |

## 学习时的三个判断

- 先看状态和工具契约，再看 prompt。Prompt 只能指导模型，不能替代 attempt、依赖、权限和质量状态机。
- 先区分已有底座和缺口。专家库已经有锁、原子写、artifact、V2 digest、provider runtime 和 inline quality gate，优先补行为边界与证据，避免重复造实现。
- 每个借鉴点都要有负向验收。至少验证 stale attempt、重复 ack、并发 claim、坏 JSON、半成品恢复、reviewer 自审、越界 changed paths 和宿主能力缺失。

## 学习完成的最小演示

在隔离 workspace 中完成一次：

`captain profile → staged plan → 用户编辑 → approve → 并行任务 → 失败 attempt 重分配 → review finding → repair/re-review → integration → archive`

演示必须能从 `team.json`、mailbox、事件日志和 UI 快照还原；杀掉进程后恢复同一个 team/member/task 身份，旧 attempt 的迟到消息不能改变新状态。
