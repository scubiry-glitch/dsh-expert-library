# dsh-expert-library 架构修复补丁

> 交付方：受限子代理（沙箱仅可写 `work/`，无法直接改插件源码），以**自校验补丁脚本**形式交付。
> 应用方式：`node apply-patches.mjs`（dry-run 校验）→ `node apply-patches.mjs --apply`（写入）。

## 一、修复范围（对应分析报告缺口编号）

| 缺口 | 修复内容 | 涉及文件 |
|---|---|---|
| **G2 场景匹配** | 新增 `expert_scenario_match(goal)` 工具（10 场景关键词表，返回 top3 + best）；usage 协议第 1 条改为"先匹配再 apply" | `src/tools.ts`、`src/index.ts` |
| **G3 终态收敛** | 调度器新增一次性"全部任务已结束"通知：`TeamState.completionNotifiedAt` 防重 + 队长 mailbox 持久化 + steer 实时投递；`isTeamState` 校验新字段 | `src/types.ts`、`src/state.ts`、`src/scheduler.ts` |
| **G5 任务模板插值** | 场景任务 description 支持 `{goal}`/`{team_name}`/`{scenario}` 占位符，应用时注入具体目标（自定义场景 JSON 立即可用） | `src/tools.ts` |
| **G6 failed 自动重试** | failed/cancelled 任务在 `attempt < 3` 时自动回到派发池（保持原 assignee 优先），超限留给队长手动 reassign；状态机不破坏（beginTaskAttempt 代际递增） | `src/scheduler.ts` |
| **G7-light skill 分层** | `ScenarioSkillBinding.appliesToTaskIndex`：skill 引用除团队描述外，同时落到指定任务（缺省最后一个产出任务）的 description；`resolvedSkill` 保留供任务注入 | `src/types.ts`、`src/tools.ts` |
| **G9 融合指派** | 智见点评 fusion/渲染任务显式指派给第一位选定专家（不再交调度器随机派） | `src/zhijian/tools.ts` |
| **G12 立场校验** | debate 工具：pro==con 拒绝；两专家出现在同一立场对照行且同侧（乐观/底部 vs 风险 vs 独特）时拒绝并提示；不同行/未收录则放行（不阻塞自定义组合） | `src/collab/tools.ts` |

## 二、应用步骤

```sh
cd /root/zhijian/dsh-expert-library
cp -r src src.bak                      # 备份
node work/fix-expert-library/apply-patches.mjs          # dry-run：每个替换必须恰好命中 1 次
node work/fix-expert-library/apply-patches.mjs --apply  # 写入
pnpm build                             # 编译验证
# 重启 DSH 后验证：expert_scenario_match / 一次 review_apply 全链路
```

dry-run 出现 `✗ … found 0/2 times` 即说明 old 与当前源码不一致（版本漂移），**不要**用 `--apply`，先 diff 对照 `src.bak`。

## 三、行为变化与回归注意点

1. **failed 自动重试**：同一失败任务最多自动重派 2 次（attempt 1→2→3），第 3 次失败后停止，需队长 `reassign_task`。重试会清空旧 output（beginTaskAttempt 语义）。
2. **完成通知**：所有任务 terminal（completed/failed/cancelled）时推送一次；`completionNotifiedAt` 落盘，冷恢复/重启不会重复推送。旧团队文件（无该字段）校验兼容。
3. **融合指派**：`expert_review_apply` 的融合任务现在有 assignee（第一位专家）。若该专家被 remove，融合任务重新入共享池（调度器兜底）。
4. **辩论校验**：内置立场表仅覆盖 5 个话题行；未收录组合不受限。`pro_expert`/`con_expert` 现在不能相同。
5. **skill 落任务**：`ppt-gen` 的 video-shotcraft 等场景 skill，其引用会追加到最后一个任务的 description（原团队描述保留）。

## 四、本轮未修复（说明）

| 缺口 | 未修原因 | 建议承接方 |
|---|---|---|
| G1 协议预设化 | 需 DSH Agent preset 机制（~/.dsh/.agent-presets 由宿主插件管理），插件内无法独立完成 | 宿主/liangshen 插件层：把 usage 段做成「专家库队长」预设 |
| G4 成员工具白名单 | 现为 deny 黑名单；改 allow 需枚举宿主全部工具（含各插件工具），风险高、超出本会话权限范围 | 插件层后续：`toolFilter: { allow }` + 显式放行清单 |
| G8 review request_id 衔接 | 涉及工具契约变更（route/apply 加 token 校验），需与协议文本同步改 | 插件层后续 |
| G10/G11/G13 | P2 增强（生成脚本 CI、多工作区知识根、模型降档），本轮不动 | 插件层后续 |

## 五、文件清单

- `apply-patches.mjs` —— 自校验补丁脚本（20 组替换、7 个文件，dry-run 默认）
- `README.md` —— 本说明
