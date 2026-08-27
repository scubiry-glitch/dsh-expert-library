# 实施记录：Beike roster 扩容 / capability union / gate 物理重绑定（2026-08-23）

- 任务目录：`work/tasks/task-20260819-expert-library-architecture/`
- 日期：2026-08-23
- 性质：对 `@zhijian/dsh-expert-library` 后续迭代的记录（承接 2026-08-19 架构设计）

## 1. Beike 领域包 roster 扩容：7 → 13

`src/v2/beike-pack.ts` 的 `BEIKE_EXPERT_IDS` 由 7 位扩展为 13 位，全部按 id 引用共享注册表 meta（不重复注册）：

- 原有：bk-002 / bk-018 / bk-019 / bk-031 / bk-033（居住服务与经纪）+ e08-08 左晖（贝壳创始人）+ e04-05 一濛（长租资管）
- 新增：
  - 商业与平台经济：s-07 张勇（组织/商业模式创新）、s-13 朱啸虎（单位经济/网络效应）、s-23 程维（双边平台/运营执行）
  - 政策治理（引用须标注前任/原任身份与观点时点）：bk-016 黄奇帆、bk-027 冯俊、bk-028 赵晖

同步更新：pack 描述与 `dependsOn`（加入 `pipeline-general`）、beike 研判协议方法包（新增商业/政策议题可选专家说明）、`beike.expert-memory` 边界说明。

## 2. 专家 capability overlay 按 capability id 合并（capability union）

`src/v2/pack-loader.ts` 新增 `mergeExpertCapabilities`：同 id 专家被更高优先级 overlay 覆盖时，非 capability 字段沿用"高层整体覆盖"，`capabilities` 则按 capability id 取并集——同名 capability 由高层 claim 覆盖，低层独有 capability（如 beike 包的 `beike.review`）保留，杜绝"zhijian-realestate 重投影覆盖 beike 交叉投影后静默丢失包级能力"。

配套决策：`beikeScenarioV2` 的 `requiredCapabilities` 保持单一 `zhijian.review` 共享 roster gate（所有 zhijian 投影专家必然认领），不把包级 `beike.review` 设为组队门槛；`beike.review` 仍作为专家上的 capability marker（`beikeExpertToV2`）供未来 tool/知识路由与 capability 索引使用。

## 3. 质量 gate 逻辑 id → 物理 fan-out 产物重绑定

`src/task-gates.ts` 的 `selectStampedGates` 修复 `gate-artifact-missing`：编译计划里的 gate 绑定逻辑任务 id（如融合任务 t2），评审专家 fan-out 后物理融合任务变为 t6（`planTask.logicalId === 't2'`）。选择 gate 后将其 `appliesTo` 重绑定到完成任务的物理 id，并把 deliverable 的逻辑 `fromTasks` 展开为团队内物理任务 id（`physicalTaskIdsFor`），使质量运行时总能解析到 artifact。

## 4. 回归测试（已存在）

- `test/beike-pack.test.mjs`：13 位专家、每位声明 `beike.review`、每个场景仅单一 `zhijian.review` gate、真实 overlay 合并顺序（beike → zhijian-realestate → pipeline-domains）后保留 `beike.review` 且 `beike-ecosystem` 可编译。
- `test/v2-pack-loader.test.mjs`：`expert overlays merge capability contributions by capability id`（高层字段覆盖 + 同名 claim 高层胜出 + 低层独有保留）。
- `test/v2-task-gates.test.mjs`：`logical t2 gates bind to physical t6 after five-reviewer fan-out`（无 `gate-artifact-missing`）。

## 5. 验证

- 仓库约定命令：`pnpm typecheck && pnpm build && node --test test/`。
- 已知历史（2026-08-23 beike roster-gate 修复记录 `work/.dsh-filess/…/20260823_beike-pack-rostergate-fix.md`）：`pnpm build` 与完整运行时链模拟（base zhijian + workspace overlays）ROSTER GATE PASS。
- 本次为文档/注释修订（不改代码行为），**未重新执行全量测试**；合并前需重新跑一遍 `pnpm typecheck && pnpm build && node --test test/` 确认全绿。

## 6. Remaining design debt：qualityPlan 契约解析仍依赖 builtin 源

`src/task-gates.ts` 的 `stampQualityPlan`（apply 时把编译 plan 的质量面写到团队持久记录）在解析 policy 与 output-template 实体时，`resolvedPolicy` / `resolveOutputTemplate` 只查两个 builtin 源：`builtinLegacyPack()`（V1 legacy 视图）与 `buildZhijianDomainPack()`（zhijian 包缓存）。因此：

- Zhijian 团队的 `schema-structure` 契约注入与 `data-citation`/`compliance-anonymization` 门禁可用；
- 但 **Beike 专属 schema 契约（如 `beike.output.B`）不会被 stamp 解析**——Beike 团队目前拿不到契约驱动的 schema-structure 校验（Beike 模板虽引用该 output template，stamp 侧无法从 builtin 源解析到它）。

后续债项：使契约 stamp 与 pack 无关（pack-independent）——要么把解析后的契约直接携带进 `ExecutionPlan`（plan 侧 `bindings.outputTemplates` 已存在，stamp 直接消费而不重新查 builtin 源），要么把编译所用的运行时 pack（`resolveRuntimePack` 的 merged pack）传入 `stampQualityPlan` 参与实体解析。两者都不改变 V1/legacy 行为。

**不影响本次 t6 修复的有效性**：`gate-artifact-missing` 修复位于 `selectStampedGates`（逻辑任务 id → 物理 fan-out 产物重绑定 + deliverable 源展开），只依赖已 stamp 的 gate 列表与团队任务记录，与 policy/output-template 实体从哪个源解析无关；t6 的 `data-citation` / `compliance-anonymization` artifact 绑定不受上述债项影响。
