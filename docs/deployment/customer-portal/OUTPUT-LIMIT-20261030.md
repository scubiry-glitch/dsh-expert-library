# C 账号会话输出上限处理（2026-10-30）

## 现象与根因

- 会话 `e6250457-af2e-4ed2-b00a-bfa157ea93c7` 的最近一轮在 `turn/end` 记录 `reason.kind=max-tokens`，没有完成答复。该轮路由到 `glm/glm-5.3`；模型网关的所有聊天路由目前将单次输出限制为 8192 tokens。
- 协作室会话投影此前只把 `error` 类结束原因传给客户页，漏掉 `max-tokens`。页面因此继续显示“已送达 · 等待回复”，即使后端已停止。

## 本次处理

- `src/host/review-conversation.ts` 把 `max-tokens` 投影为不含模型私有信息的 `output_limit`；C 账号运行时已更新该编译文件并重启，A/B 运行时未改。
- 客户页显示“达到输出上限，回复未完成”，即使本轮此前已有阶段性助手消息。用户可点“继续未完成的回复”，它在同一会话发送一次明确的续做请求，要求检查已有成果并避免重复执行外部写入。已有草稿时不会覆盖草稿。
- 模型网关增加有界的账号级 `maxOutputTokens` 配置，C 账号设为 16384；A/B 未设置该项，继续使用 8192。[智谱官方 GLM-5.3 模型页](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)标注最大输出 128K；这里先只增加到 16K，控制单次调用的时延与额度占用。网关代码和配置发布后已重启，健康检查返回 200。
- 前端静态资源共用，但 A/B 后端未投影 `output_limit`，新按钮不会出现。

## 验证与边界

- `pnpm build`、`node --test test/review-conversation.test.mjs`、`node --check apps/customer-portal/public/app.js`、`node --test apps/model-gateway/test/gateway.test.mjs` 均通过。网关测试覆盖 C 的 GLM 路由 16K 与其他账号默认 8K。
- 用 C 历史会话原始事件验证：最新 `turnFailures` 为 `{seq:191, kind:'output_limit'}`；C 和客户页服务均为 active，公网 `/app` 与版本化 JS/CSS 返回 200，资源 SHA-256 与页面版本参数一致。
- 此修复处理静默停滞、人工续做，并将 C 的单次输出上限提高一倍。长任务仍可能达到 16K 或其他额度限制；自动续做可能重放工具副作用或继续消耗额度，因此未在后台无条件触发。

## 回退

- 门户静态文件备份：`/opt/zhijian/customer-portal/.backup-output-limit-20261030T115738Z/`（`app.js`、`style.css`、`index.html`）。恢复到 `dist/` 后无需重启门户。
- C 插件文件备份：`/opt/zhijian/customer-dsh-runtime-c-mentions/.backup-output-limit-20261030T115738Z/review-conversation.js`。恢复到同名插件路径后重启 `zhijian-dsh-demo-c.service`。
- 网关代码备份：`/opt/zhijian/model-gateway/.backup-output-limit-20261030T120405Z/server.mjs`；受限配置备份：`/etc/zhijian/.backup-output-limit-20261030T120405Z/model-gateway.json`。按原位置恢复后重启 `zhijian-model-gateway.service`。

## 基于 C 账号历史输出的分路线调整与续做验证

- 2026-10-30 核对 C 账号 242 个会话的 14,415 条有 usage 的助手消息。历史 8K 附近的输出中，DeepSeek 路线 135 次，耗时 95 分位不超过约 47 秒；GLM/ZAI 路线 55 次，耗时 95 分位约 107–140 秒。网关上游请求超时为 300 秒，故统一放到 128K 不适合此部署。
- 新增账号内的路线级 `maxOutputTokensByProvider`，C 账号设为 `deepseek: 24576`、`glm: 12288`、`zai: 12288`；A/B 继续使用默认 8192。配置中的旧 `maxOutputTokens: 16384` 保留作未单列路线的回退值。`node --check` 与网关 10 项测试通过，服务重启后健康检查通过。
- 在原 `e6250457-af2e-4ed2-b00a-bfa157ea93c7` 会话发送续做请求，要求先检查已有文件，再补缺或只读验收。会话结束事件为 `reason.kind=completed`，没有再次出现 `max-tokens`。文件此前已由另一轮写盘，本次没有重写；表 3～8 共 32 条，全文件 148 个 ID 唯一、291 条 evidence 引用均存在。
- 本次续做输出均低于 12K，证实的是会话可继续并完成该短工作包；尚不能从这次调用证明 12K/24K 上限下长输出必能完成。
- 本轮代码备份：`/opt/zhijian/model-gateway/.backup-route-limits-20261030T122823Z/server.mjs`；受限配置备份：`/etc/zhijian/.backup-route-limits-20261030T122823Z/model-gateway.json`。
