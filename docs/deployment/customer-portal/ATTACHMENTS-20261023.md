# 客户会话附件上传（2026-10-23）

## 行为

- 会话输入框支持选择最多 4 份文件；PDF、DOCX、XLSX、TXT、MD、CSV、PNG、JPG、WebP，单份 8 MiB。
- BFF 校验登录或协作分享的写权限及会话归属；DSH 网关再次验证会话归属，并把文件写入该账号工作空间的 `customer-uploads/<session-id>/`。未发送前移除会删除文件。
- 发送消息时才把文件路径加入用户消息，Agent 从工作空间读取。只读分享与历史预览不能上传或删除。
- Nginx 仅对 `/api/sessions/<id>/attachments` 放宽请求体至 12 MiB，以覆盖 base64 编码；其他路径仍为 1 MiB。

## 验证与发布

- 插件构建、客户页 37 项测试、插件网关与文件边界测试、桌面和 390px 手机浏览器上传→移除→再上传→发送闭环通过。
- 上线前备份：`/opt/zhijian/.backup-customer-attachments-20261023T014821Z/`（门户、C 与 A/B 插件、Nginx 配置）。
- A/B 原已停用且处于 failed 状态；仅预置兼容改动，没有启动实例。
- 等 C 实例运行中任务结束后，于 10:03:45（Asia/Singapore）重启 C，10:04:17 重启客户门户；两项服务均为 `active`。A/B 保持原 failed 状态。
- 公网 `/app` 和版本化 JS/CSS 返回 200，内容哈希与 HTML 参数一致；公网 2 MiB 附件请求在无授权时返回 401（未被反代的 1 MiB 限制拦截）。C 内网网关对一份 5 字节测试文件完成上传与删除，测试文件已清理。
