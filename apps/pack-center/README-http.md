# 独立中心 HTTP 接口

状态：真实身份/组织/提交业务接口已实现；显式进程入口在 `src/main.ts`，尚无静态前端。新增授权分发和发布管理见 [README-distribution-http.md](README-distribution-http.md)。本文不表示整个 Goal 已通过。

`src/server.ts` 导出 `createCenterServer({ database, identity, submissions, distribution?, publicOrigin, allowLoopbackHttp?, maxBodyBytes? })`，返回标准 `node:http.Server`。生产入口装配 `distribution: {deployments,catalog,governance}`；选填仅保留旧组件独立测试能力。调用方负责 `listen()` / `close()`，以及数据库迁移和独立 Worker 生命周期。它不自动启动 Worker、不执行 Git、不读取 DSH 会话、不包含 bootstrap HTTP 入口。

## 登录与 Cookie

OIDC 回调必须配置为 `<publicOrigin>/api/auth/callback`。当前支持 RS256；接入使用精确 issuer 字符串及 client ID，可配置 client secret。登录使用 `openid-client 6.8.8` 的 code + PKCE，强制 state / nonce / issuer / audience / 时间校验，并显式开启 JWS 签名验证；后者依据 [官方 enableNonRepudiationChecks 文档](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md) 配置。

1. 浏览器向 `POST /api/auth/login` 发送 JSON `{}`，或 `{ "invitationToken": "一次性邀请值" }`。
2. API 设置短期 HttpOnly 登录 Cookie，返回 `{ authorizationUrl, expiresAt }`；页面导航到该 URL。
3. OIDC 回调经固定 publicOrigin 验证后，设置 session / CSRF Cookie、清除登录 Cookie。当前回调返回 JSON `{ principal, csrfToken, expiresAt }`；前端整合时可改为固定站内跳转，禁止接受自由 redirect URL。
4. 页面刷新后调用 `GET /api/me`，获取 `{ principal, csrfCookieName }`。按该名称读取同源 CSRF Cookie，写请求带 `X-CSRF-Token`。
5. `POST /api/auth/logout` 携带 JSON `{}`、Origin 和 CSRF；服务端撤销会话，清除三种 Cookie。

生产 Cookie 分别为 `__Host-pack-center-login`、`__Host-pack-center-session`、`__Host-pack-center-csrf`。它们都为 `Secure; Path=/; SameSite=Lax` 且无 Domain；前两者 HttpOnly，CSRF Cookie 故意可由同源页面读取。session 明文只通过 Set-Cookie 返回，不出现在 API JSON、数据库、审计中。

仅 `allowLoopbackHttp: true` 且 publicOrigin 为 HTTP loopback 时允许开发模式，Cookie 使用不同的 `pack-center-dev-*` 名称且不带 Secure。HTTPS reverse proxy 后仍应把 publicOrigin 配为外部 HTTPS。服务端不从 `Host` 或 `X-Forwarded-*` 推导 origin / 回调地址。

## API 路由

本文既有路径前缀均为 `/api`，新增分发为 `/api/v1`；没有 CORS 跨站接口。本文登录之外的业务接口要求当前真实人类会话；Bearer 不能用于这些旧接口，Cookie 与 Authorization 混用一律拒绝。管理角色和组织边界在服务层逐事务检查，隐藏按钮不能代替授权。

| 方法与路径 | 输入 / 作用 |
|---|---|
| `GET /me` | 当前身份与 CSRF Cookie 名称 |
| `GET /organizations` | 可管理/所属组织列表 |
| `POST /organizations` | `{id,slug,name}`，平台管理员新建组织 |
| `GET /organizations/:id/members` | 组织成员列表，组织管理员 |
| `POST /organizations/:id/members` | `{userId,roles,status}`，更新已存在成员 |
| `GET /organizations/:id/invitations` | 邀请元数据，不含 token 或其哈希 |
| `POST /organizations/:id/invitations` | `{roles,expiresInMs?}`；邀请明文仅本次创建返回 |
| `POST /invitations/:id/revoke` | `{}`；撤销邀请 |
| `POST /organizations/:id/status` | `{status}`，平台管理员禁用/恢复组织 |
| `POST /organizations/:id/review-scopes` | `{reviewerId,granted}`，平台管理员分配审核范围 |
| `POST /users/:id/status` | `{status}`，平台管理员禁用/恢复用户 |
| `GET /submissions?organizationId=...` | 本组织可见提交；可选 limit / beforeId |
| `POST /submissions` | `SubmissionInput` 创建草稿 |
| `GET /submissions/:id` | 受权限保护的提交、固定快照、报告、记录及独立 release 发布状态 |
| `PATCH /submissions/:id` | `{expectedVersion,...完整可编辑字段}`，仅 draft |
| `POST /submissions/:id/validate` | `{expectedVersion}`，提交持久校验任务，返回 202 |
| `POST /submissions/:id/submit` | `{expectedVersion}`，将已校验快照送审 |
| `POST /submissions/:id/withdraw` | `{expectedVersion}`，撤回待审提交 |
| `GET /reviews?organizationId=...` | 分配范围内的待审队列，支持跨组织审核；可选 limit / beforeId |
| `POST /submissions/:id/review` | `{expectedVersion,contentTreeSha256,decision,comment}` |
| `POST /submissions/:id/retry-publication` | `{expectedReleaseVersion}`；有权管理员/审核员重试原批准快照，返回 202 |

全部提交写请求（包括发布重试）必须有 `Idempotency-Key`。同一操作者同 key / 同内容回放已提交结果；不同内容冲突 409。除创建外须有正整数 `expectedVersion`；发布重试改用 `expectedReleaseVersion`，不混淆两个状态版本。组织、用户、邀请管理尚未使用通用幂等重放；创建邀请的网络结果不明时查元数据、撤销旧邀请并重新创建，不重放泄露 token。

`GET /health` 仅返回 `{status:"ok"}`，不暴露依赖连接地址、凭据、版本或包内容。

## 请求与错误保护

- 本文所有写请求（包括登录）要求精确匹配配置 publicOrigin 的 `Origin`；受保护写请求还要求服务端校验 `X-CSRF-Token`。OIDC 回调 GET 是跨站导航例外，但必须绑定浏览器登录 Cookie、state 和 nonce。仅新分发模块中严格识别的宿主绑定兑换/机器目录下载允许无 Origin，且拒绝一切浏览器元信息。
- POST/PATCH 使用 `application/json`（可带 UTF-8 charset），拒绝非对象 JSON、压缩 body、未知输入字段与重复关键查询参数。
- 默认 body 上限 128 KiB，最多可配置 1 MiB；同时限制 headers 和请求时间。不支持 OPTIONS/CORS。
- 所有响应 no-store / nosniff / frame deny / no-referrer；HTTPS 模式输出 HSTS。当前纯 API CSP 禁止页面脚本，未来静态 UI 需独立确定其 CSP。
- 错误 JSON 为 `{error:{code,message,requestId}}`。message 为安全通用提示，不回显数据库错误、用户输入、原始 URL、令牌或堆栈。
- 失败审计只记录服务端固定 route 标签、method、code、status、requestId 和已认证 actor；不记录请求 body / query / Cookie / authorization code / 邀请值。数据库故障导致审计写入失败时，不会把连接细节泄露给客户端。

## 可复现验证

```bash
cd apps/pack-center
npm run build
node --test test/auth.test.mjs test/server.test.mjs
```

测试使用真正 PostgreSQL 及本地协议 issuer（真实 RSA JWS、JWKS、code exchange、PKCE），不注入假会话。HTTP 用随机 loopback 监听端口模拟反向代理后的服务端，publicOrigin 单独配置；生产 Secure Cookie 属性在 HTTPS publicOrigin 模式检验。测试容器唯一命名并带任务标签，退出只清理本次容器与临时数据库卷。

HTTP 层测试覆盖登录/退出、Cookie 属性、登录 CSRF、跨组织访问、组织角色、审核范围与自审、失败审计脱敏、body 限制、草稿编辑及校验任务幂等。`test/center-flow.test.mjs` 另证明真实 HTTP/OIDC → Git Worker → 固定快照 → 独立审核 → 分支移动 → 签名发布 → 机器 HTTP 下载及重复投递不变，并检验两个机器身份隔离和下架后旧许可失效；仍不是浏览器或两个真实 DSH 实例验收。
