# HANDOFF-IMPLEMENTATION（实施交接文档）

- 版本：v0.1
- 日期：2026-08-19
- 交接对象：负责实施改造的 Agent
- 前置阅读：`ARCHITECTURE-DESIGN.md`

## 1. 当前源码结构与已知缺口

项目根：`/root/zhijian/dsh-expert-library`

关键文件：

```text
package.json                     # 包定义、exports、scripts、deps
cordis.patch.yml                 # bundle patch：插入 expert-library 插件行
tsconfig.json                    # Host TS 配置
tsconfig.client.json             # Client TS 配置（已存在）
tsdown.config.ts                 # Client bundle 配置
src/index.ts                     # Host 入口：工具注册、协议、Web 路由
src/tools.ts                     # expert_teams_* 工具 + scenario_apply
src/members.ts                   # 成员 persona、模型路由、工具过滤（deny list）
src/types.ts / state.ts          # Team/Task 状态与持久化
src/scheduler.ts                 # 任务调度
src/skills.ts                    # 外部 skill 缓存
src/expert-library/              # 内置专家/场景/注册表
src/zhijian/                     # 智见点评子系统
src/collab/tools.ts              # debate/roundtable/ppt/report
src/client/                      # Web 客户端（活动面板 + 会话卡片）
```

已知缺口（审计结论，2026-08-19）：

1. `package.json` 缺 `./client` exports、缺 `dsh.client.inject` 声明、build 只编译 Host、缺 tsdown/lightningcss/react 依赖；`lib/` 无 client 产物。
2. `tsdown.config.ts` 的 CLIENT_EXTERNALS 缺 `@deepseek-ai/dsh-client-ui-settings`。
3. Host 未注册 `expert-library` Settings namespace。
4. Client 未通过 `ctx.settingsScope.bind` 注册 `settings.plugin.item` 卡片。
5. 成员工具过滤是 deny list（`MEMBER_DENIED_TOOLS`），非 allowlist。
6. 场景任务模板为静态文本，无目标/数据插值。
7. 场景匹配无独立工具，依赖模型自觉。
8. 无 team-ready 完成事件、无失败自动重试、融合任务无明确 assignee。
9. `memberModel` 为嵌套对象，设置表单需扁平化。

## 2. 目标改造清单（P0）

### 2.1 package.json 接线

- exports 增加 `"./client": "./lib/client.js"`（以及 types）；
- 增加 `dsh.client.inject` 声明（`dsh-client-runtime`、`dsh-client-ui-settings`、`dsh-client-ui-settings-plugins`、`dsh-client-ui-slots`）；
- build 脚本改为：`tsc -p tsconfig.json && tsc -p tsconfig.client.json && tsdown`；
- devDependencies 增加：`react@18.3`、`@types/react`、`tsdown`、`lightningcss`、DSH client 相关包（rc.8 匹配现有版本）；
- peerDependencies 增加 `@deepseek-ai/dsh-settings`。

### 2.2 tsdown.config.ts

- CLIENT_EXTERNALS 增加 `@deepseek-ai/dsh-client-ui-settings`。

### 2.3 Host Settings namespace

- 新增 `src/settings.ts`（或并入 index.ts）：
  - `settingsNamespace('expert-library')`；
  - `installSettingsSection(ctx, ns, Config, entry, { setSource, onChange })`；
  - settings 服务缺席时优雅降级到 entry config；
  - 保存时把扁平字段组装回嵌套 `memberModel`。
- 运行时字段：stateDir、knowledgeDir、memberProvider、memberMaxDepth、maxMembers、promptSectionOrder。
- 模型字段：memberModelProvider、memberModelName、memberReasoningEffort、allowScenarioModelOverride、allowTaskModelOverride、fallbackModelProvider、fallbackModelName、fallbackReasoningEffort。
- 工具绑定字段：tools.<id>.mode(api/cli/auto)、timeoutMs、maxRetries、readOnly、allowedRoles、allowedScenarios。

### 2.4 Client Settings 卡片

- 新增 `src/client/settings-card.tsx`（参考 dsh-ssh / dsh-desktop-launcher 的 settings-form + SnapshotStore staged form）；
- `src/client/index.tsx`：
  - inject 增加 `'settingsScope'`；
  - `ctx.settingsScope.bind({ namespace: 'expert-library' })`；
  - `ctx.slots.inject('settings.plugin.item', register({ key: 'expert-library', order, locale, inject }, SettingsCard))`；
  - 不可用时展示原因，不白屏；
  - restart-required 字段标注；
  - 不显示任何 secret。

### 2.5 场景匹配与任务插值

- 新增 `expert_scenario_match(goal)`：10 场景关键词表 → top3 + best + confidence + missing inputs；
- usage 协议第一条改为“先匹配再 apply”；
- 场景任务 description 支持 `{goal}`、`{team_name}`、`{scenario}`、`{data}`、`{city}`、`{period}` 占位符插值。

### 2.6 完成事件与失败重试

- scheduler 在全部任务 terminal 时推送队长 mailbox（防重：`completionNotifiedAt`）；
- failed/cancelled 任务在 attempt < 3 时自动回池，超限留给队长 reassign；
- 融合/成文任务显式指派（docs-coordinator 或主答专家）。

### 2.7 skill 任务级绑定

- `ScenarioSkillBinding.appliesToTaskIndex`；
- skill 引用落指定任务 description（缺省最后产出任务）。

### 2.8 debate 立场校验

- 拒绝 pro == con；
- 拒绝立场表同题同侧组合。

## 3. 模型继承实现

优先级：

```text
任务级 > 场景级 > 专家级 > Expert Library 默认值 > DSH 当前 Agent 路由
```

实现位置：`src/members.ts` `resolveMemberLlmSelection` 增加来源标注；工具/接口返回 `effectiveRoute` 与 `inheritedFrom`。

## 4. API/CLI/Auto 工具模式实现

- 新增 `src/tool-adapter/`（或 `src/tools/bindings.ts`）：
  - `resolveToolMode(toolId, task?, scenario?) -> 'api' | 'cli' | 'auto'`；
  - `api` 优先调用结构化 API；`cli` 走受控 command adapter；`auto` 先健康检查再降级；
  - 两种模式都失败时明确失败，不伪造数据。
- CLI adapter 要求：命令白名单、参数 schema、工作目录限制、超时、退出码解析、日志脱敏。
- 凭据只在 Host/Tool Adapter 层持有；不进入 persona、任务描述、mailbox、前端状态、报告。

## 5. 兼容性要求

- 旧 `.expert-teams` 状态（TeamTask/TeamState）向后兼容：新增字段全部可选；
- `isTeamState` 兼容旧文件；
- 旧配置（cordis.patch.yml / entry config）继续可用；
- settings 服务缺席时降级 entry config，不阻塞启动；
- 与 dsh-agent-teams 并存不冲突（注册面已独立）。

## 6. 验证命令

```bash
cd /root/zhijian/dsh-expert-library
pnpm install
pnpm typecheck
pnpm build
```

产物：`lib/index.js`（Host）+ `lib/client.js`（Client bundle）。

手工验证：

1. 重启 DSH，进入 设置 → 插件配置，应出现「专家库」卡片；
2. 修改 stateDir/knowledgeDir/memberModel 并保存；
3. 重启后配置保持；
4. 触发一次 scenario 建队，确认任务 description 包含目标插值；
5. 触发一次失败任务，确认自动回池并在 3 次后升级；
6. 配置工具模式 api/cli/auto 并确认 resolve 结果；
7. 确认日志与报告无 API Key。

## 7. 风险与回滚

风险：

- 第三方 namespace 可能不在官方 apiproxy settings 允许列表 → 卡片显示不可用而非白屏（已由 settings-form 处理）；
- DSH Settings API 随 rc 变化 → 用结构类型导入 + 可选服务降级；
- 多数配置项重启生效 → UI 标注；
- client 依赖版本需与现有 rc.8 匹配。

回滚：

- `git`/副本备份 `src` 与 `package.json`；
- 恢复后 `pnpm install && pnpm build` 验证。

## 8. 完成定义

- [ ] package/tsdown/client 构建链完整，`pnpm build` 通过；
- [ ] Host Settings namespace 注册成功，无设置时降级正常；
- [ ] Client 卡片在 设置 → 插件配置 显示并可读写；
- [ ] 模型继承（任务/场景/专家/默认）生效且可解释；
- [ ] API/CLI/Auto 模式可配置且 resolve 正确；
- [ ] 旧团队状态与旧配置兼容；
- [ ] 无 API Key 泄漏路径；
- [ ] typecheck/build 无错误；
- [ ] 场景匹配、任务插值、完成事件、失败重试、skill 绑定、融合指派、debate 校验均已落地或列入 P1 且说明原因。
