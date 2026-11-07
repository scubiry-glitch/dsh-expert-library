# 账号 C 会话 @领域包优化顾问发布（2026-11-02）

## 发布范围

- 账号 C 管理员在会话输入 `@` →「专家」后，可选择「领域包优化顾问·包名」。对象绑定当前已启用的包 ID 与版本，只读复用管理页的静态优化检查；会话最多展示前 20 条，更多问题可到能力管理查看。
- 门户 `/api/mentions` 对普通成员和分享访客隐藏该对象；消息提交拒绝非管理员选择。DSH 工具还核对最新用户消息中的服务端已验证选择，手打名称或复用旧回合不能触发检查。
- 普通专家问答、领域包说明和现有管理页检查保持原有路径。账号 A/B 服务未更新。
- 账号 C 的专家对象较多，@ 列表的模型路由校验按相同模型去重；门户列表请求超时兜底由 15 秒调到 30 秒。线上冷启动读取约 10 秒。

## 发布文件与恢复点

发布文件：门户 `server.mjs`、`dsh-gateway.mjs`、`dist/index.html`、`dist/app.js`；账号 C 插件 `lib/index.js`、`lib/host/customer-capabilities.js`、`lib/host/customer-mentions.js`。

原文件与发布文件在 `/opt/zhijian/.stage-pack-review-mention-KVCMo2nh/old/` 和 `new/`；`new-sha256.txt` 为发布文件清单。回退时从 `old/` 恢复同路径文件，重启 `zhijian-dsh-demo-c.service` 与 `zhijian-customer-portal.service`，确认 `/healthz` 与账号 C 网关 `/health` 正常。

## 验证

- TypeScript 类型检查、插件构建、门户构建、相关权限和网关测试通过。
- 线上账号 C `/mentions` 返回「领域包优化顾问·城市月报」v2.5.1；当前包静态检查返回 HTTP 200、Schema 有效、4 条建议。
- 门户与账号 C 服务均为 active；公网 `/app` 和带新资源版本号的 `/assets/app.js` 返回 HTTP 200。
