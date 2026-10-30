# 账号 C 联网搜索发布记录（2026-10-28）

范围：仅账号 `zhijian-demo-c` 可通过模型网关调用 DeepSeek Search/Fetch。客户页共享静态资源提供会话开关；其他账号的后端未安装搜索工具，模型网关配置拒绝其搜索和抓取请求。

## 发布内容

- `zhijian-model-gateway.service`：增加固定上游 Search/Fetch 代理、请求校验、每会话日次数限制与成功调用记录；配置中仅 C 账号设置 `webSearchEnabled: true`。
- `zhijian-dsh-demo-c.service`：部署 `lib/index.js`、`lib/host/customer-gateway.js` 和新文件 `lib/host/customer-web-search.js`。默认策略为 `ask`，首次调用显示搜索词并等待用户选择；策略持久化于 C 的 DSH home。
- 客户门户静态资源：更新 `dist/app.js`、`dist/index.html`，在当前线上页面布局中增加“联网”会话开关。BFF 的策略路由和 DSH 网关客户端在发布前已与源码一致，本次未重启门户服务。

备份目录：`/opt/zhijian/.backup-web-search-c-20261028T151341Z/`，包含上述原始生产文件和模型网关原始配置。备份目录仅 root 可读。仓库中其他未发布的页面布局改动未进入此次静态资源发布。

## 验证

- 本地 TypeScript 检查通过；模型网关 9 项测试、客户网关和联网策略测试通过。
- C 的 DSH 网关 `/health` 返回 200；已有会话的 `/web-search` 返回 `{"policy":"ask"}`，策略数据库已创建。
- 使用 C 的代理身份经生产模型网关真实请求 DeepSeek Search：HTTP 200，返回两条结果；Fetch：HTTP 200，取得 5697 字网页正文。测试只用了公开的 DeepSeek 文档关键词和 URL，未发送客户会话内容。
- 使用 A/B 的代理身份请求 Search 均返回 403。A/B/C、模型网关和门户服务均为 active。
- 公网 `/app`、版本化 `/assets/app.js` 均返回 200；HTML 包含会话开关，JS 包含策略加载与授权问题处理逻辑。

本次未在客户浏览器登录态中触发完整对话，因为那会向已有客户会话追加测试消息。真实 Search/Fetch 通路、策略读取、前端资源和隔离边界已经分别验证。

## 回退

1. 从备份目录的 `original/model-gateway/server.mjs` 和 `original/model-gateway.json` 恢复原文件与原权限，重启 `zhijian-model-gateway.service`。
2. 恢复 `original/plugin/index.js` 和 `original/plugin/customer-gateway.js`，删除本次新增的 `lib/host/customer-web-search.js`，重启 `zhijian-dsh-demo-c.service`。
3. 恢复 `original/portal/app.js`、`original/portal/index.html`。静态资源按请求读取，无需重启门户。

新增的策略表和网关计数表为独立的附加数据，回退程序时可保留。
