# 客户页会话输入区压缩（2026-10-10）

- 用户反馈 `/app` 的 `conversationCompose` 整体过高。默认输入框改为单行 42px，输入多行内容时自动增高，最高仍受视口高度限制；工作空间、模型选择和发送按钮保持同排。可见标题与快捷键提示收起，保留标签及 `aria-describedby` 供屏幕阅读器读取。
- 公网发布仅替换 `/opt/zhijian/customer-portal/dist/` 下的 `index.html`、`style.css`、`app.js`；原文件备份于 `/opt/zhijian/customer-portal/.backup-conversation-compose-20261010T085219Z/`。静态文件按请求读取，无需重启服务。
- Chromium 公网 `/preview` 回归：1440px 宽默认高度从 204px 降到 108px，390px 从 175px 降到 99px，320px 从 207px 降到 99px。多行输入扩展正常，无横向溢出或脚本错误。公网三个文件哈希与本地构建一致，指定 `/app` 地址返回 200，客户页服务为 active。
- 如需回退，将备份目录中的三个文件复制回 `dist/`；不涉及账号和会话数据。
