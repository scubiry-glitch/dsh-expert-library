# 独立中心网页：实现与浏览器证据

日期：2026-09-19。隔离树 `/root/zhijian/dsh-pack-center-dev.ZGtty5`，分支 `codex/pack-center-ZGtty5`，基线 `784a6ac07b96a67c89b8516664172c0973f98079`。未提交、推送或上线，未修改 DSH 核心及生产运行文件。**中心网页主流程已接通，不代表插件四页签、两个真实 DSH 或总 Goal 完成。**

## 本批交付

- 同源登录和按角色导航，开发者 Git 草稿/版本/依赖/分发范围表单、校验报告、固定文件纯文本预览、差异、送审/撤回及独立修订。
- 授权审核队列，版本与快照摘要绑定的批准、退回、拒绝；校验、审核和发布状态分开显示，失败发布可从有权提交详情重试。
- 组织成员/邀请、跨组织审核范围、账号/组织状态；部署点登记、绑定码和凭据元数据、撤销及禁用。
- 发布管理列表/详情、下架与独立分发范围申请/审核。新增 `GET /api/v1/organizations/:id/releases`，覆盖 publishing / publish_failed / published / yanked；管理可见不赋予私有下载权限。
- 原生 DOM / ES modules 与本地 CSS，无前端运行时框架或外部 CDN。服务创建时预读 6 个固定资产，不能将任意服务端路径映射给浏览器。HTML/API 分别使用严格 CSP，浏览器 OIDC 回调固定重定向，失败回到明确登录错误页。

源码入口：`apps/pack-center/web/{index.html,app.js,shared.js,submissions.js,admin.js,style.css}`、`src/web.ts`、`src/server.ts`，管理列表位于 `src/release-governance.ts` 和 `src/distribution-http.ts`。页面路由、启动布局与操作者说明见 [README-web.md](apps/pack-center/README-web.md)。上传对象仍为公开 HTTPS Git 的 **V2 领域包**，不是 ZIP 或可执行插件。

## 审阅后加固

1. 保留按钮回调的真实事件上下文；select 初值在选项加入后设置；本地校验错误只以受控纯文本提示，不显示服务端原始异常。
2. 草稿保存锁定整个表单并恢复原 disabled 状态；刷新/完成统一重建页面 signal，取消旧请求，旧响应不能覆盖新输入。
3. 身份刷新开始和 pagehide 同步移除受保护 DOM，独立取消过期身份请求；过期请求的 401 不跨会话代际注销新会话。浏览器测试派发生命周期事件后，实际请求中心 `/api/me`，不是伪造成功会话。
4. 非秘密写操作在页面内存保留不确定请求的幂等标识，管理页面跨重绘保留，达到容量不静默丢键。整页刷新/关闭后的内存丢失有明确核对要求。邀请码/绑定码签发不缓存、不自动重试；一次性回执在离开、刷新、手动清除或到期后清理。
5. 跨组织审核员可从发布详情的“批准提交”链接回到有权提交详情，不因离开待审队列而丢失失败发布重试入口；仍由后端判断独立审核权限。
6. 既有发布器测试在负载下可能由无条件续租失败提前退出，却仍假设数据库租约已到期。改为在真实业务事务回调完成后、最终租约检查前定向过期同一租约，断言确实到达注入点、发布/成功审计一起回滚，再明确过期旧测试租约供正常 Worker 回收。去掉短时 sleep，不更改发布器运行代码。

## 冻结验证

插件与中心 typecheck/build、4 个浏览器 JS 模块语法检查均退出 0。最终全量 **1047/1047 通过**，零失败/取消/跳过：插件 786 + 协议/归档 85 + 中心 175 + 浏览器 1。只统计最终覆盖，不累加中间重跑。

| 验证 | 结果 | TAP 日志（`artifacts/pack-center/p3-final/`） |
|---|---|---|
| 插件完整回归 | 786/786；154361.173437 ms；退出 0 | `plugin.tap` |
| 协议与安全归档 | 85/85；7846.480818 ms；退出 0 | `shared.tap` |
| 中心组件/API/静态 HTTP | 175/175（顶层 162）；259586.154052 ms；退出 0 | `center.tap` |
| 真实 Chromium 业务链 | 1/1；94618.643948 ms；退出 0 | `browser.tap` |

本次新增中心回归为组织发布管理 2 项、对应 HTTP 1 项、网页静态/OIDC HTTP 1 项；浏览器流程单独执行，不重复计数其中的各个断言或截图。初次全量有 2 个失败：新增测试写死发布状态版本，以及既有租约故障测试提前退出。第二次全量仅剩后者，均已按上文修正；中间诊断保留于 `center-initial.tap`、`center-timing-diagnostic.tap`，不计为最终通过。另已对齐人类 HTTP 拒绝码与协议对浮点数的严格拒绝码。

```sh
# 隔离树根目录；不在生产插件目录构建或安装依赖。
pnpm typecheck
pnpm build
node --test 'test/**/*.test.mjs'
node --test 'packages/pack-contract/test/*.test.mjs' 'packages/pack-artifact/test/*.test.mjs'
cd apps/pack-center
npm run build
npm run typecheck
node --test --test-concurrency=2 'test/*.test.mjs'
node --test 'test/browser/*.test.mjs'
```

上述测试实际同时附加 `--test-reporter=dot --test-reporter=tap --test-reporter-destination=stdout --test-reporter-destination=<对应绝对日志路径>`。报告目录预先创建。也可用 `npm run test:browser` 构建并运行浏览器测试；不因浏览器缺失而 skip。

环境：Node `v22.22.0`，Git `2.43.7`，PostgreSQL `17.11`，Playwright Core `1.55.0`，Chromium `140.0.7339.16` / revision `1187`。新增的 Playwright 是 app 独立、精确锁定的开发依赖，本轮使用已有匹配浏览器，没有下载浏览器。运行时 pg/OIDC 依赖、原插件依赖及数据库迁移不变。PostgreSQL 镜像仍固定为 `postgres@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995`，每组测试使用独立容器/schema、随机凭据与 loopback 端口，按自身 ID/标签清理，不运行 prune。

## 浏览器实际证明的内容

`apps/pack-center/test/browser/center-ui.test.mjs` 使用真实中心、OIDC PKCE/RS256、PostgreSQL、smart HTTPS Git、校验 Worker 和 Ed25519 发布 Worker。测试身份选择只发生在本地测试 issuer 的 authorize 请求，中心不注入假 session、假 API 响应或已发布数据。

真实操作链：管理员建组织/邀请 → 开发者网页登录 → 故意中断创建传输并确认没有假成功 → 创建草稿且整页刷新仍在 → 真实 Git 校验 → 送审 → 拒绝作者自审（UI 与 API） → 独立审核员退回 → 新版本/新提交/新快照修订 → 再校验并独立批准 → 发布 Worker 签名原批准内容 → 发布目录及详情 → 两个部署点登记、签发绑定码、刷新后不再显示、撤销绑定码。

额外断言：名称/说明中的恶意 HTML 只显示文本；无页面 JS 错误、无浏览器 Authorization 请求；存储和审计不包含本次邀请码/绑定码；浏览器不能兑换绑定码，数据库机器凭据行数仍为 0；发布阶段不再访问 Git，旧/新快照均保留。延迟真实 PATCH（仅暂停后 continue，不伪造响应）验证锁表单、取消和旧响应隔离。

静态 HTTP 用例独立验证固定资产白名单、HEAD、路径穿越/编码/NUL、HTML CSP、自源资产、API 原严格 CSP、成功/失败 OIDC 回调及不可控 Host/redirect。公共根页面可接受跨站文档导航，不将该许可扩展到 `/api/me`。

14 张脱敏截图位于 `artifacts/pack-center/p3-web/`；逐文件摘要与尺寸见 `p3-final/screenshots.json`。截图前检查 body 文本及 input/textarea 的值不含已签发秘密，并回到页顶以避免 sticky 导航误位。关键视图：

- [登录](artifacts/pack-center/p3-web/01-login.png)、[组织与成员](artifacts/pack-center/p3-web/02-organization-members.png)、[传输失败](artifacts/pack-center/p3-web/04-unconfirmed-network-error.png)。
- [固定校验报告](artifacts/pack-center/p3-web/06-fixed-validation-report.png)、[独立退回](artifacts/pack-center/p3-web/07-independent-revision-request.png)、[修订批准与发布](artifacts/pack-center/p3-web/08-approved-published-revision.png)。
- [发布管理](artifacts/pack-center/p3-web/10-release-management.png)、[部署点 A 撤销记录](artifacts/pack-center/p3-web/11-deployment-a-revoked.png)、[部署点 B 撤销记录](artifacts/pack-center/p3-web/12-deployment-b-revoked.png)。
- [390px 登录](artifacts/pack-center/p3-web/13-mobile-login.png)、[390px 我的提交](artifacts/pack-center/p3-web/14-mobile-submissions.png)，另有横向溢出断言。

截图只辅助观察；不替代服务端或浏览器行为断言。U03 的下架/范围审核、成员/账号禁用等已接真实接口并有服务端回归，但本批浏览器自动化没有逐项操作完所有管理按钮，仍须补齐；不宣称整组 U03/A21 完成。

## 输入指纹与隔离

54 个中心源码/测试/迁移/依赖配置/网页输入集合 SHA-256：`96a7cc239ca12a7652c2a9384395883e132a3b8083d711c47357d4b22426d13f`。`node scripts/pack-center-fingerprint.mjs` 可复核；本轮扩展覆盖 `web/`，不能与 P2 的 44 文件集合直接当作同一集合比较。完整清单为 `p3-final/source-fingerprint.json`，文档和生成报告不计入源码集合。

| 文件 | SHA-256 |
|---|---|
| `plugin.tap` | `8f6cbd235fdca0ef14bc446d92ce57f7b8c7ddd4609aa9b210753f821f69038a` |
| `shared.tap` | `b0cdcb07f64d278293b96bba7267ac95427f1118ca5d881ad03a2636d12be417` |
| `center.tap` | `da3653b5ba9b8f8eb83257e4e021164a7f5ff4056dc20d077692fbf3be0ffd69` |
| `browser.tap` | `2a7e95825f96d0f9f63ed52c2c823f402bb9153821bbd65d2adccb629cce1c37` |
| `source-fingerprint.json` | `abf4c19de6b3b374558e63c0e98c69763ddcc38ac3613f15ede286b3f71c55e9` |
| `screenshots.json` | `6d8e44e5c4ef3e26ecad3f3d8b81200fd726bb471a93e141e5c58a035b2b558c` |

上表文件均位于 `artifacts/pack-center/p3-final/`。独立 app lockfile SHA-256 为 `694b2b506fb1dedafcd7bd063633d6fffb7aa711a0bcb0869240bc8b43484ac1`。原生产插件的 package、lockfile、宿主与客户端构建入口、依赖布局 5 项摘要与既有基线一致；原目录仅维护三份规划文档。本轮没有生产安装、重启、DNS、签名凭据或部署写入。

最终 54 项输入与指纹逐项一致，源码尾随空白检查及两工作树 `git diff --check` 无问题。所有本轮测试容器及各自匿名卷已由 fixture 按精确 ID/标签删除，最终按测试标签查询无遗留；没有清理其他容器或用户数据。TAP 中的私钥头、带凭据数据库 URL、完整绑定码/机器 token 模式抽查无匹配；这不是通用秘密检测承诺。

收尾时原生产仓库另出现 `src/harness-compat.ts` 修改及 `test/harness-compat.test.mjs` 新文件；本任务未修改这两项，按用户/其他并行工作变更保留，未回退或纳入本批源码指纹。上述 5 项生产依赖/构建入口摘要仍一致；不能将本任务未修改生产运行文件表述为整个共享仓库没有其他变化。

## 验收映射与下一步

- **A01、A03：通过本批浏览器链路验收**，只适用于本次固定源码与测试环境。A02、A04–A24 保持待验收；已有组件/部分 UI 证据不替代对应整条要求。
- 下一步为 L04：插件宿主中心连接/绑定、独立确认信任公钥、私密机器凭据、授权目录与下载接本地 pack-store；浏览器不持有机器凭据。
- 随后 L05–L07/U04：手动更新检查、下载/启用/更新/回退与四页签，补齐 U03 剩余浏览器边缘路径。
- 实际 provider 初始化、长任务惰性资源、两个隔离 DSH 的真实运行/断网回退、S3/镜像、硬配额与限流、最小权限角色、备份恢复、第二实例复建和部署前检查仍未完成。

**两个管理记录或机器身份不是两套运行中的 DSH；中心网页和组件通过不构成整个 Goal 完成。**
