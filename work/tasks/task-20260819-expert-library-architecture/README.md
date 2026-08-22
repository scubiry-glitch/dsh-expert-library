# Task: expert-library 架构设计与实施交接

- 任务目录：`work/tasks/task-20260819-expert-library-architecture/`
- 日期：2026-08-19
- 状态：**实施进行中：智见模式 preset 入口已补齐，Host typecheck/build 已通过，Client Settings 与其余 P0 改造待继续**

## 交付物

| 文件 | 说明 | 状态 |
|---|---|---|
| `ARCHITECTURE-DESIGN.md` | 目标架构：DSH Core / Expert Library / Domain Plugin 边界、Agent preset、Workflow、Tool Policy、Artifact、Skill、模型继承、API/CLI/Auto 工具模式、设置 UI、执行链路、首阶段范围/非目标/验收 | ✅ 已写入 |
| `HANDOFF-IMPLEMENTATION.md` | 实施交接：当前源码缺口、文件修改清单、Host Settings namespace、Client settings.plugin.item、package/tsconfig/build 接线、schema、验证命令、回滚、完成定义 | ✅ 已写入 |
| `README.md` | 本文档：状态与交接步骤 | ✅ 已写入 |

## 关键结论（供接手 Agent 快速了解）

1. **client 构建链未接线**：package.json 缺 `./client` exports、缺 `dsh.client.inject`、build 只跑 host tsc；tsdown.config.ts externals 缺 `dsh-client-ui-settings`。
2. **Host 未注册 Settings namespace**：需 `installSettingsSection(ctx, settingsNamespace('expert-library'), Config, entry, ...)`。
3. **Client 未注册设置卡片**：需 `ctx.settingsScope.bind` + `ctx.slots.inject('settings.plugin.item', ...)`。
4. **模型继承**：任务 > 场景 > 专家 > Expert Library 默认值 > DSH 当前路由。
5. **工具模式**：api / cli / auto；任务 > 场景 > 工具默认值；CLI 必须受控 adapter；API Key 不进 persona/任务/mailbox/前端/报告。
6. 参考实现：`dsh-ssh` / `dsh-desktop-launcher`（在 profiles/web/node_modules 下）的 settings-form.ts 与 settings 注册代码。

## 交接步骤

1. 接手 Agent 阅读 `ARCHITECTURE-DESIGN.md` 与 `HANDOFF-IMPLEMENTATION.md`；
2. 按 2.x 清单逐项实施（建议先 2.1 package/构建，再 2.3/2.4 Settings，再 2.5-2.8 工作流）；
3. 每次改动后执行 `pnpm typecheck`；
4. 全部完成后 `pnpm build`，并做设置读写/重启保持/场景建队/失败重试手工验证；
5. 更新本 README 状态列与完成定义勾选。

## Artifact 白名单实施进展

- ✅ 当前任务 Project 已具备独立 `input/`、`output/`、`artifacts/` 目录；
- ✅ 创建任务时写入 `input/task.json`，任务更新时同步写入 `output/result.json`；
- ✅ scheduler 已明确要求 Worker 只处理当前任务 Project；
- ⏳ 显式 Artifact manifest、上游 Artifact 引用和依赖输出白名单尚未完成，下一步需补充 Artifact 发布/读取工具及依赖校验。

## 任务 Project 隔离进展

- ✅ 新任务自动创建 `.expert-teams/<team-id>/expert-tasks/<task-id>/`；
- ✅ Project 包含 `project.json`、`input/task.json`、`output/result.json` 和 `artifacts/`；
- ✅ `TeamTask.project` 为可选字段，旧 TeamTask/TeamState 继续兼容；
- ✅ scheduler assignment prompt 已要求 Worker 只处理当前 task project；
- ✅ 任务更新时同步维护 Project 输出文件；
- ⏳ 显式上游 Artifact 引用、代码任务 Git worktree 和 GUI 手工验证待后续阶段。

## 当前实施进展

- ✅ 新增 `src/preset.ts`，为 Agent Preset 提供 Expert Library 工具入口，并避免 Web Host 已注册工具时重复注册；
- ✅ `package.json` 增加 `./preset` exports；
- ✅ 已生成 `lib/preset.js` 与 `lib/types/preset.d.ts`；
- ✅ 已验证 `lib/preset.js` 可被 Node ESM 正常导入；
- ✅ `pnpm typecheck` 与 `pnpm build` 已通过。
- ✅ Client 构建链已接通：`./client` exports、`dsh.client.inject`、client TypeScript 编译和 tsdown bundle 均已通过；
- ✅ 修复 client 组件文件名/导入大小写问题，并补齐 CSS Modules 类型声明；
- ✅ 新增 Client Settings 页面，绑定 `expert-library` namespace，并通过当前 rc.8 实际存在的 `settings.section` slot 注册；
- ✅ Settings 页面支持运行时目录、成员上限、提示词顺序、默认模型和协议开关读写；
- ✅ 场景任务支持 `{goal}`、`{team_name}`、`{scenario}`、`{data}`、`{city}`、`{period}` 插值；
- ✅ `expert_teams_scenario_apply` 暴露 data/city/period 上下文参数；
- ✅ debate 拒绝空专家和 pro/con 使用同一专家；
- ✅ scheduler 对 failed/cancelled 任务增加最多 3 次自动回池重试；达到上限后保留 terminal 状态；
- ✅ scheduler 在全部任务进入 terminal 后向 captain mailbox 写入一次性完成通知，并记录 `completionNotifiedAt` 防重复；
- ✅ `ScenarioSkillBinding.appliesToTaskIndex` 已实现；缺省时 skill 引用落到最后一个产出任务 description；
- ✅ 代码级最终回归：`pnpm typecheck`、`pnpm build`、preset ESM 导入和 `lib/client.js` 产物检查均通过；
- ⏳ Web GUI 手工设置、预设选择和最终回归验证待在已认证 GUI 会话中执行（当前匿名 curl 返回 401）。

## 未实施事项（留给接手 Agent）

- 源码全部改动（本任务仅交付文档，不改源码）；
- `pnpm install` / `pnpm build` / `pnpm typecheck`；
- 设置界面读写与重载验证；
- 场景匹配、任务插值、完成事件、失败重试、skill 绑定、融合指派、debate 立场校验的实施与回归。
