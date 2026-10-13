# 独立页会话客户端：实现与验收

> 后续状态：用户授权发布后，已于 2026-10-08 完成生产发布、重启和公网验证，详见 [发布记录](REVIEW-CLIENT-DEPLOYMENT-20261008.md)。下文部署说明保留实现验收时的历史状态。

目标：保留原队长会话及现有发送、排队、去重和授权，通过 SSE 展示对话与生成中文字，可靠恢复断线，减少完整状态/历史查询，保持只读浏览不唤醒会话。

## 实施结果

- `review-stream.ts`：订阅先于历史读取，先顺序补齐历史分页，再发送并发到达的实时消息；序号去重及 checkpoint 支持重连。初次连接可返回快照。单次回放最多 100 页，更多页通过下一次连接继续。积压超过 512 帧或 2 MiB、写入背压、读取失败、连接关闭时释放订阅。
- `review-event-hub.ts`：全局宿主事件按授权队长会话分发。可用宿主的 `agent/assistant-stream` 以 150 ms 合并生成中文字；不展示推理、工具参数或子代理内容。正式回复替换临时预览。当前生成中的预览有限缓存，支持中途打开/重连；未提供此事件的旧宿主仍显示已保存的正式回复。
- `review-state-watch.ts`：按文件复用只读元数据监测，默认每 2 秒检查团队/计划文件是否改变，发生变化才通知前端读取。不是零轮询：元数据检查不读取完整团队正文，连接正常仍有 60 秒完整状态兜底。
- 页面：历史读取与 SSE 并发时缓冲、合并消息；消息、快照与游标共同恢复；离线/隐藏/离开页面关闭连接，恢复后重新订阅；15 秒服务端心跳，45 秒无事件触发重新连接。推送不支持或握手仍是旧协议时回退到增量查询。
- 权限：沿用 review Cookie、绑定会话校验与同源发送检查；长连接定期复核授权，撤销或过期后关闭。浏览只使用已有只读查询和事件订阅，没有调用会话恢复或模型执行入口。
- 消息发送：继续调用 `sessionController.prompt`，保留 `mode: queue` 和稳定 `requestId`。本次没有加入 steer、停止任务或新的操作权限。

## 验收证据

| 要求 | 证据 |
|---|---|
| 原会话发送、queue、去重与访问范围 | `review-conversation.test.mjs`、`review-routes.test.mjs`、`review-access.test.mjs`；浏览器模拟回执丢失后重试同一 requestId，用户消息只保存一次 |
| 首次快照、回放顺序与不漏消息 | `review-stream.test.mjs` 覆盖快照期间并发、分页期间并发、失败不跳游标；实际浏览器断网后补齐 75 条消息，逐条验证顺序和唯一性 |
| 生成流及安全过滤 | `review-event-hub.test.mjs` 覆盖分块合并、重连预览、序号缺口、子代理隔离；浏览器确认预览显示、正式回复替换、推理文字不出现 |
| 不唤醒冷会话 | 保留 `readReviewConversation` 的 `sessionQuery.observeSession(...projectionMode: none)`；既有冷观察与继承消息隔离测试通过。新代码只订阅事件和检查文件元数据，没有新增激活调用 |
| 减少无效完整查询 | 隔离浏览器稳定连接后的 17 秒内，额外完整状态请求 0 次、聊天历史查询 0 次；原子替换团队文件后页面自动更新 |
| 降级、心跳和清理 | 断网重连、无 EventSource、旧后端握手、浏览器关闭释放连接；单测覆盖撤销、背压、积压超限和读取中断 |
| 前端并发与布局 | 实际 HTTP 快照延迟期间到达 SSE 新消息，最终保留且不重复；390/1440 宽度无横向溢出，无页面脚本错误 |

相关回归共 **40 项通过，0 失败**。`npm run typecheck`、`npm run check:craft`、`npm run check:report-domain` 均通过。宿主 TypeScript 在 `/tmp/review-client-build-20261008/lib` 隔离输出，编译成功；没有覆盖生产 `lib`。

浏览器测试用 loopback HTTP 服务、临时授权和模拟会话事件。测试中的发送仅进入模拟 runtime，没有向真实会话发消息，没有触发团队任务或模型调用。17 秒观察仅证明本次隔离条件下没有多余完整查询，不代表生产环境延迟或吞吐量测量。

证据：[浏览器结果](evidence/review-client-20261008/browser.json)、[回归结果](evidence/review-client-20261008/regression.tap)、[源码摘要与验收清单](evidence/review-client-20261008/manifest.json)、[相对于本轮开始状态的改动](evidence/review-client-20261008/implementation.patch)。

## 复现

```sh
npm run typecheck
node --test test/review-state-watch.test.mjs test/review-stream.test.mjs test/review-event-hub.test.mjs test/review-conversation.test.mjs test/review-routes.test.mjs test/review-access.test.mjs test/review-documents.test.mjs test/review-presentation.test.mjs test/review-share-link.test.mjs
node scripts/qa/review-client-stream.mjs
```

浏览器脚本可通过 `REVIEW_PLAYWRIGHT_MODULE` 和 `REVIEW_CHROMIUM` 指定当地安装位置。

## 部署状态与边界

**代码及隔离验收完成；本次未安装新的生产后端，也未重启生产 DSH，未声称线上已启用新 SSE 协议。** 插件安装目录指向源码仓库，静态资源可能由运行中服务直接读取，因此页面已经兼容“前端已更新、后端尚未重启”的组合，自动回退到增量查询。

仓库已有大量其他未提交修改。本轮改动已单独记录为补丁，不能把整个当前构建目录直接当作只包含本轮改动的发布包。上线需在确认发布基线后集成这些改动、构建安装，并在合适窗口重启宿主；随后用授权页面做只读连接验证。没有对真实生产会话做发送测试。
