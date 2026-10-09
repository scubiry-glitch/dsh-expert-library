# 授权分发 HTTP 边界

`src/distribution-http.ts` 由独立中心的 `createCenterServer` 装配；不修改 DSH 核心，也不向既有生产服务接线。业务授权由部署点、目录与发布治理服务逐次执行，路由本身不是授权凭证。

## 身份与凭据

- 管理请求使用中心 OIDC 会话 Cookie；所有浏览器写请求同时要求精确同源 Origin 与 CSRF token。Bearer 不能提交、审核、下架或管理部署点。
- 同时提供 Cookie 与 Authorization 一律拒绝。Bearer 不会被忽略，也不会在鉴权失败后降级为 Cookie。
- 绑定码兑换仅接受宿主到中心的 JSON 请求：不得有 Cookie、Origin、任何 `Sec-Fetch-*` 或 Authorization。管理员浏览器只能得到短时绑定码，不能兑换或读取机器凭据。
- 机器目录与下载使用 `Authorization: Bearer <credential>`，同样拒绝 Cookie、Origin 与任何 `Sec-Fetch-*`。宿主客户端应使用 Node `http` / `https` 等不自动附加浏览器元信息的传输；Node `fetch` 默认的 `Sec-Fetch-Mode: cors` 也会被拒绝。
- 一次性绑定码、机器凭据和下载许可不得写入日志、URL、审计明文或幂等结果。绑定码签发及兑换不是可重放的幂等接口；丢失兑换响应时需要重新签发绑定码，并酌情撤销未知凭据。
- 兑换响应附带 `trustInfo`（centerId、公钥、SHA-256 指纹），仅用于展示。客户端必须通过可信管理渠道确认并固定指纹，不能自动相信刚收到的密钥。

## 路由

全部路由以 `/api/v1` 开头。未列明字段和查询参数拒绝；分页为 `limit`（1–100）与 `beforeId`。

| 方法与路径 | 身份 | 内容 |
|---|---|---|
| `POST /deployment-bindings/exchange` | 无身份、仅宿主 | `{bindingCode}` → 一次性机器凭据与公开信任信息 |
| `GET /deployments?organizationId=...` | 组织管理员 | 分页列表 |
| `POST /deployments` | 组织管理员 | `{organizationId,name}`；要求 Idempotency-Key |
| `GET /deployments/:id` | 组织管理员 | 部署点及凭据/绑定码的非敏感元数据 |
| `POST /deployments/:id/binding-codes` | 组织管理员 | `{expiresInMs?}`；签发新码并撤销旧的未用码，不缓存明文幂等结果 |
| `POST /deployments/:id/credentials/revoke` | 组织管理员 | `{credentialId}`；要求 Idempotency-Key |
| `POST /deployments/:id/binding-codes/revoke` | 组织管理员 | `{bindingCodeId}`；要求 Idempotency-Key |
| `POST /deployments/:id/status` | 组织管理员 | `{status,expectedVersion}`；要求 Idempotency-Key |
| `GET /releases` | 有效人类/机器 | 已授权目录；可按 `packId` 筛选并分页 |
| `GET /releases/:id` | 有效人类/机器 | 固定签名清单、报告与详情 |
| `POST /releases/:id/download-grants` | 有效人类/机器 | `{}` → 短时下载许可、固定签名清单与无密钥相对路径 |
| `GET /releases/:id/artifact` | 有效人类/机器及下载许可 | 需 `X-Pack-Download-Grant` 请求头；不接受 URL grant |
| `GET /releases/:id/manage` | 管理员或授权审核员 | 当前发布/分发状态；与分发目录详情分开 |
| `GET /organizations/:id/releases` | 组织管理员或授权审核员 | 分页管理列表，包括发布中、失败、已发布和下架；不授予制品下载权限 |
| `POST /releases/:id/yank` | 组织管理员 | `{expectedVersion,reason}`；要求 Idempotency-Key |
| `GET /releases/:id/distribution-requests` | 管理员或授权审核员 | 分页分发变更请求 |
| `POST /releases/:id/distribution-requests` | 组织管理员 | `{expectedVersion,scope,reason}`；版本针对当前分发状态；要求 Idempotency-Key |
| `GET /distribution-requests/:id` | 管理员或授权审核员 | 固定变更申请 |
| `POST /distribution-requests/:id/review` | 独立授权审核员 | `{expectedVersion,decision,comment}`；版本针对申请；禁止自审；要求 Idempotency-Key |
| `GET /organizations/:id/distribution-review-queue` | 授权审核员 | 分页待审列表；可附 `status` |

下载许可与调用者绑定，机器调用还绑定具体 credential；它不是独立 Bearer，也不是对象存储公开 URL。下载前重新检查凭据、组织/部署点状态、当前分发范围、下架状态、固定依赖、许可有效期和归档完整性。撤权后的新下载不会仅凭旧许可继续。

只返回完整 tar，不支持 Range 或条件 GET，不发送 ETag、304、跨域许可或存储重定向；响应固定文件名 `domain-pack.tar`，`Cache-Control: no-store`。断开连接时销毁下载流。已开始且授权成功的传输不是可回收的远程副本；本地既有副本不由中心删除。

## 隔离测试

在本应用目录执行：

```sh
npm run build
node --test test/distribution-http.test.mjs
```

测试使用真实本地 OIDC issuer、隔离 PostgreSQL schema、私有 CAS 和 Ed25519 发布器。测试仅为分发 HTTP 集成：校验快照来自检查入库的样例并直接写入测试数据库，Git 完整链路另见 `center-flow.test.mjs`；不冒充浏览器 UI、插件安装或两个真实 DSH 部署点的验收。测试服务、数据库和临时文件均与生产隔离。
