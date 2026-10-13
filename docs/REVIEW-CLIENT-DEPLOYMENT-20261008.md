# 独立页实时通信发布记录

## 发布范围

在现网编译产物基线上更新 `lib/index.js`、`lib/host/review-routes.js`、`review-event-hub.js`，新增 `review-stream.js` 和 `review-state-watch.js`。保留现网已有的启动图静态路由，没有整包覆盖其他未提交改动。候选编译文件的 16 项定向回归通过。

外层 `dsh-auth-gate/lib/guard.js` 精确增加 `GET /plugins/dsh-expert-library/review/api/events`，由独立页接口继续执行 Cookie、访问范围与撤销检查。`issue/revoke`、其他事件接口、POST events 及相似路径仍不在委托名单内。部署补丁在 `docs/deployment/auth-gate-review-events.patch`。

## 备份与回滚

备份目录：`/root/zhijian/deploy-backups/review-client-20261007-204021`。`manifest.json` 记录本轮 5 个后端文件的原始摘要；网关原文件保存为 `auth-gate-guard.js`。恢复备份的已有文件、删除此次新增的两个运行时文件，再使用原有重启脚本重启 `dsh-web.service`，即可回滚后端。新版静态前端可识别旧握手并自动降级。

发布摘要：[deployment.json](evidence/review-client-20261008/deployment.json)。候选验证：[release-regression.tap](evidence/review-client-20261008/release-regression.tap)。

## 生效验证

已发布并生效。2026-10-08 04:45（Asia/Singapore）通过公网 `https://yy.meizu.life` 完成：

- 新进程 PID 400024，启动稳定检查 `ok`。
- 真实授权会话 SSE `protocol: 2`、`stateUpdates: true`，收到心跳。
- 浏览器页面显示“已连接 · 实时更新”。
- 无授权 SSE 返回 401；验证临时授权已撤销。
- 发布后公网 JavaScript 与本地文件字节一致；验证未发送真实聊天消息或启动新任务。

记录：[live-verification.json](evidence/review-client-20261008/live-verification.json)。

主 HTTP 服务先就绪，专家库路由随后加载；验收等待了具体页面路由和真实 SSE 成功，没有只以 systemd active 判断生效。

发布后的摘要复核发现：另一次构建在 04:45 更新了 `lib/index.js` 和 `lib/host/review-routes.js`，差异为其他任务的暂停/启动操作及静态路由变化。本次三个实时通信模块和网关规则仍与发布版本一致，线上协议验证成功；没有覆盖其他任务的改动。回滚时必须核对并保留这些后续改动，不可直接整文件覆盖。发布时摘要和后续磁盘摘要均已记入 `deployment.json`。
