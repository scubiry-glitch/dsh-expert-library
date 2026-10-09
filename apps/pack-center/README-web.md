# 中心网页：开发者、审核员与管理员

网页由独立中心 API 同源提供，不依赖 DSH 进程或其 Cookie。首版使用原生 DOM / ES modules 与本地 CSS，无前端运行时框架、外部 CDN、内联脚本或运行时编译。它管理 **Git 提交的 V2 领域包**，不是上传任意可执行 DSH 插件或 ZIP。

## 页面与操作

| 入口 | 操作与权限 |
|---|---|
| `/` | OIDC 登录；首次加入填写管理员签发的邀请代码，不开放注册 |
| `/#/submissions` | 我的可见提交、分页、新建版本；查询失败不伪装为空列表 |
| `/#/submissions/new` | 组织、包 ID/名称、SemVer、HTTPS Git/ref、说明/许可证、分发范围、插件兼容与固定依赖 |
| `/#/submissions/:id` | 编辑草稿、异步校验、手动刷新；固定 commit/摘要/报告、纯文本文件预览、差异、送审/撤回、独立修订、审核与发布时间线 |
| `/#/reviews` | 授权组织队列；独立审核员填写意见，批准/退回/拒绝固定快照；作者不能自审 |
| `/#/organizations` | 平台管理员建组织、分配跨组织审核范围和禁用账号；组织管理员维护成员、角色、邀请、组织状态 |
| `/#/deployments`、`/#/deployments/:id` | 登记部署点、停用/启用、一次性绑定码、撤销绑定码/机器凭据；不显示实时在线或本地安装状态 |
| `/#/releases`、`/#/releases/:id` | 本组织管理员或授权审核员查看各发布状态；管理员下架、申请范围变更；发布失败可从有权提交详情重试 |
| `/#/distribution-reviews` | 授权审核员批准或拒绝独立分发范围申请；申请者不能自审 |

查询参数放 hash 内，例如 `/#/releases?organizationId=demo`。审核员有跨组织范围但不是该组织成员时，组织选择器显示组织 ID；不为显示名称绕开现有身份 API 权限。发布管理列表与授权下载目录独立：管理记录可见不等于获得其私有制品。

创建→校验→送审有独立显式操作。校验和发布由后台 Worker 执行；网页手动刷新状态，不会把 HTTP 202 当作校验通过，把“已批准”当作“已发布”。修订创建新的 submission，旧快照和审核意见仍可查看。提交详情的现有 API 不返回包显示名时使用 pack ID，不虚构名称。

## 会话、内容和错误边界

- API 逐请求检查权限；菜单隐藏和按钮禁用不代替后端权限。写入使用同源 Origin、CSRF、预期状态版本；要求幂等的接口同时发送操作标识。
- OIDC 浏览器回调成功固定 303 到 `/`，失败固定到 `/#/login-error`；不携带身份、邀请码、授权 code/state 或任意 returnTo。API 客户端的 JSON 回调约定保留。
- 公共 HTML 根页面允许跨站导航，以支持不同域名 IdP 回跳；该例外不适用于 `/api/me` 等受保护 API。资产固定白名单，无文件目录映射、源文件、source map 或 CORS。
- HTML CSP 只允许同源外置脚本、CSS 和连接，拒绝内联/eval/iframe；服务端与 Git 文本只作为文本节点或 `pre`，不执行 Markdown 内嵌 HTML、脚本声明或仓库脚本。
- 保存草稿期间锁定表单；页面重绘中止旧请求，避免旧完成回调覆盖新输入。身份刷新开始及 pagehide 立即移除受保护 DOM；恢复后实际重新请求会话。
- 未确认的非秘密写操作保留本页内存中的幂等标识，跨 hash 页面重绘可复用。**整页刷新、关闭标签或账号切换后必须先核对记录再重提**；不持久化请求键、不自动重试、不把传输中断当成失败已回滚。
- 邀请与绑定签发不会缓存或自动重试。回执只在当前 DOM 显示，可手动清除，离开、刷新、过期会清除；不写 URL、localStorage、sessionStorage。响应丢失须先查记录、撤销不明记录，再手动签发。
- 浏览器不能兑换绑定码或持有机器 Bearer。机器凭据仅由后续插件宿主客户端兑换并私密保存；本页的两个部署点不是两套实际 DSH 客户端。

## 启动与浏览器复现

按 [README.md](README.md) 在隔离目录安装/构建，配置真实数据库、身份服务与私有存储，显式迁移和 bootstrap 管理员，再分别运行 API / 两类 Worker。浏览器访问配置的 `PACK_CENTER_PUBLIC_ORIGIN`。反向代理需把 `/`、`/assets/*` 和 `/api/*` 一并转发中心，并保留固定公共 HTTPS origin；无需修改任何 Harness 部署域名。

`web/` 的 6 个固定文件必须随 `dist/` 一同交付；服务创建时整体预读，修改资产后应重启**隔离**服务再验证。没有服务自动安装/启动、DNS 写入或生产发布步骤。

测试专用依赖固定为 `playwright-core 1.55.0`，不是运行时依赖。安装不会下载浏览器；浏览器测试不会因缺少浏览器而静默跳过。首次准备专用测试机时可显式执行以下下载命令（需联网），或设置 `PACK_CENTER_BROWSER_EXECUTABLE` 指向已准备的 Chromium。此次验证版本为 Chromium `140.0.7339.16` / revision `1187`。

```sh
# apps/pack-center 内；下载仅在测试机确有需要时执行。
node node_modules/playwright-core/cli.js install chromium
npm run test:browser
```

浏览器运行使用真实独立 PostgreSQL、OIDC/PKCE/RS256、smart HTTPS Git、校验与发布 Worker；测试 issuer 仅在自身 authorize 请求上选择测试身份，不注入假的中心 session 或 API 响应。真实传输失败/延迟用于验证错误和取消，不伪造成功。浏览器启动为一次性测试配置（含 no-sandbox），不得将此启动方式推广为生产浏览器安全配置。

`npm test` 覆盖组件/API 和静态 HTTP 边界，`npm run test:browser` 单独执行 Chromium，避免无浏览器的后端测试暗中被跳过。截图默认写入仓库 `artifacts/pack-center/p3-web/`，可用 `PACK_CENTER_BROWSER_SCREENSHOTS` 指定本次专属证据目录；截图前清除一次性代码并检查文本与输入值。完整最新结果见根目录 `PACK-CENTER-P3-WEB-EVIDENCE.md`。

尚未交付：Harness 插件远端连接/四页签、两套真实 DSH 联调、生产部署与完整恢复演练。此网页交付不等于总 Goal 完成或已经上线。
