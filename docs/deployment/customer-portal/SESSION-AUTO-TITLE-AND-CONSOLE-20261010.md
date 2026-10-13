# 新会话自动命名与客户页控制台修复（2026-10-10）

- 首条明确主题的用户消息被 DSH 接受后，客户页从该消息生成最多 24 字的标题。问候、链接或泛泛的“写一篇报告”等请求保留“新会话”。写入仅发生在原始标题仍为“新会话”且没有用户手动标题时；账号和会话范围由服务端校验。已有默认名会话首次读取历史对话时，也会按首条明确主题的用户消息补名。发送和读取响应带回标题，让当前页面同步显示。
- `workspace` 轮询同一会话同一视图代际只允许一个在途请求；移除每次工作区读取后重复触发的会话活动刷新。其他轮询仍按原定频率运行。用户报告的 `ERR_HTTP2_PING_FAILED` 属浏览器与 HTTP/2 连接未收到心跳响应；源站日志中该会话请求多次返回 200，未能据此定位浏览器到 Cloudflare 的失败点。本次修复请求重叠，但不宣称消除链路故障。
- Cloudflare 自动注入的 Web Analytics 脚本此前被 `script-src 'self'` 拦截；CSP 现在只允许该域名的 `beacon.min.js` 及其版本子路径，同源的 `connect-src` 保持不变。新增 `/favicon.ico`（200，`image/x-icon`），页面显式声明图标。
- 生产应用文件备份：`/opt/zhijian/customer-portal/.backup-session-title-console-20261010T091748Z/`；命名规则增强前的单文件备份：`/opt/zhijian/customer-portal/session-title.mjs.before-vague-title-guard`。账号数据库在线备份：`/var/lib/zhijian/customer-portal/backups/accounts-20261010-before-auto-title-091734Z.sqlite`，完整性检查为 `ok`。部署后重启 `zhijian-customer-portal.service`，不涉及 DSH 实例。
- 客户页完整测试 30/30 通过；公网 `/app`、`/favicon.ico` 和健康检查返回 200。公网 1440/390/320px 预览未出现页面脚本错误或横向溢出。自动命名的账号隔离、单次写入、手动标题保护、历史会话补名均由测试覆盖。
