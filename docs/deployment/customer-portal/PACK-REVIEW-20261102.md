# 账号 C 领域包优化检查发布（2026-11-02）

## 发布范围

- 客户门户 `/manage#packs`：当前启用的版本中心领域包显示「优化检查」，结果在已安装版本下方展示；本地包保留结构检查。入口由服务端 `packReviewAvailable` 控制，当前仅对账号 C 管理员显示，A/B 页面不显示该按钮。
- 门户 BFF：管理员专用 `GET /api/capabilities/pack-review?packId=...`。分享访客不能调用。
- 账号 C DSH 插件：只读 `GET /admin/pack-review?packId=...`，只解析当前账号已启用的本地或版本中心包。
- 未更改领域包安装版本、账号配置、会话记录或 A/B DSH 插件。

## 文件与恢复点

发布文件：门户 `server.mjs`、`dsh-gateway.mjs`、`dist/manage.html`、`dist/manage.js`、`dist/manage.css`；账号 C 插件 `lib/index.js`、`lib/host/customer-gateway.js`、`lib/host/customer-capabilities.js`、新增 `lib/host/pack-improvement-review.js`。

发布前原文件保存在 `/opt/zhijian/.stage-pack-review-20261102-e4GiyB/old/`；发布文件和 SHA-256 清单保存在同目录的 `new/` 与 `new-sha256.txt`。回退时先确认账号 C 无运行中的任务，恢复 `old/plugin` 下三个原文件并删除新增的 `pack-improvement-review.js`，重启 `zhijian-dsh-demo-c.service`；再恢复 `old/portal`，重启 `zhijian-customer-portal.service`。门户静态文件按 JS/CSS、最后 HTML 的顺序恢复。

## 线上验证

- 账号 C `prod.city-house-price` v2.5.1 的内网检查返回 HTTP 200、Schema 有效、4 条建议；门户管理员接口返回同一包与版本。
- 公网 `/manage`、`/assets/manage.js`、`/assets/manage.css` 与发布文件逐字节一致；未登录检查接口返回 HTTP 401。
- 390px 浏览器实际点击账号 C 的「优化检查」后显示 4 条建议；A 账号页面无此按钮。两页均无脚本错误或横向溢出。验收用短期浏览器会话均已撤销。
- `zhijian-dsh-demo-c.service` 和 `zhijian-customer-portal.service` 均为 active；A/B DSH 服务未重启。
