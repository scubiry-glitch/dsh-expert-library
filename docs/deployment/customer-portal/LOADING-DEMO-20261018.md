# 会话恢复动效静态演示（2026-10-18）

- 公开预览：`https://zhijian.meizu.life/demo/loading`。它是独立的静态演示，不读取登录状态、会话或研究数据，不替换正式 `/app` 加载界面。
- 三个候选样式：花枝轻绘、水彩晕染、纸面微光。用本地 CSS/SVG 实现；分段文案模拟“会话信息 → 最近消息 → 工作区按需读取”，按钮可重播。支持 `prefers-reduced-motion`。
- 源文件：`apps/customer-portal/public/loader-demo.html`、`loader-demo.css`、`loader-demo.js`；`server.mjs` 只增加演示页和两个脚本/样式路由。
- 本地验收：`npm run build`、`node --test test/foundation.test.mjs` 通过；浏览器在桌面与 390px 宽度下无横向溢出，三种方案可切换，分段状态正常，无页面错误或 API 请求。
- 生产验收：演示页及 CSS/JS、原 `/app` 与 `/api/bootstrap` 均为 200；生产浏览器切换至纸面微光并完成模拟恢复，无失败请求、脚本错误或 API 请求。客户页服务为 `active`。
- 备份：`/opt/zhijian/customer-portal/.backup-loading-demo-20261018T191142/server.mjs`。回退时恢复此文件，删除 `dist/loader-demo.{html,css,js}`，重启 `zhijian-customer-portal.service`。
