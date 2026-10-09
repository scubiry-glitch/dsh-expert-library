# 独立领域包中心：提交、审核、发布与管理网页

状态：已实现独立 HTTP API、邀请制 OIDC、组织权限、Git 固定快照校验、人工审核、Ed25519 签名发布、下架/范围审核，以及部署点绑定和授权目录下载。`test/center-flow.test.mjs` 串联真实 HTTP/OIDC、PostgreSQL、smart HTTPS Git、本地私有制品存储与机器 HTTP 下载，证明分支移动不改变实际下载字节。

现已增加同源管理网页：邀请登录、开发者提交/修订、独立审核、组织成员、发布治理及部署点管理，见 [README-web.md](README-web.md)。**客户端远程接线、四页签及 S3 适配器仍未交付。** 尚未上线，不代表 A01–A24 完整验收通过。网页验证见根目录 `PACK-CENTER-P3-WEB-EVIDENCE.md`；后端历史证据为 `PACK-CENTER-P2-EVIDENCE.md`，下文早期 13 项记录仅为历史持久层证据。

中心独立安装依赖，不需要启动 DSH。禁止在根目录安装这些依赖，禁止替换根目录已有的 `node_modules` 链接。

## 安装、构建与真实数据库测试

要求 Linux、Node.js 22+、PostgreSQL 17+；Git Worker 需要 `/usr/bin/git`（本轮 2.43.7）、`/usr/bin/prlimit`。Git 测试还需要 OpenSSL 和 Git smart HTTP backend。独立 lockfile 锁定 `pg 8.23.0`、`openid-client 6.8.8`、`@types/pg 8.23.1`、`typescript 5.9.3`、`@types/node 22.20.4`；测试 issuer 使用 `jose 6.2.12`。OIDC 当前支持 RS256 身份令牌，发布签名独立使用 Ed25519。

```bash
# 在隔离开发树根目录先构建共享纯校验入口，不在生产插件目录构建。
pnpm build
cd apps/pack-center
npm ci --include=dev --ignore-scripts
npm run typecheck
npm test
```

`--include=dev` 必须显式保留：宿主可能设置生产模式，默认安装会省略编译器和类型。

测试使用真正的 PostgreSQL，不用内存替身：

- 默认通过 Docker 启动唯一命名、带唯一任务标签的临时容器，端口仅绑定 `127.0.0.1` 的随机端口。
- 镜像固定为 `postgres@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995`（本轮验证版本 17.11）。未缓存时 Docker 需要联网拉取。
- 密码在测试进程中随机生成，不写入仓库、不打印连接字符串。每项测试使用独立随机 schema。
- 测试结束校验容器 ID 与标签，**只**删除本次创建的容器及其匿名测试数据库卷；不清理其他容器或镜像。
- 可显式提供 `PACK_CENTER_TEST_DATABASE_URL` 使用专用测试数据库；测试只创建/删除 `pc_test_<随机值>` schema。不要提供生产数据库或共享生产账号。
- 测试进程被强制终止时，依据测试输出中的准确容器 ID 和 `dsh.pack-center.test` 标签人工清理本轮容器；不要执行批量 Docker prune。

迁移配置如下；数据库 URL 通过运行环境/凭据系统注入，不放 `.env` 或文档实值。

| 环境变量 | 用途 |
|---|---|
| `PACK_CENTER_DATABASE_URL` | 专属 PostgreSQL 数据库连接信息，必需 |
| `PACK_CENTER_DATABASE_SCHEMA` | 专属 schema，默认 `pack_center`，禁止 `public` / `pg_*` |
| `PACK_CENTER_DATABASE_POOL_SIZE` | 连接池上限，默认 10 |
| `PACK_CENTER_ID` | 固定中心标识，必需 |
| `PACK_CENTER_PUBLIC_ORIGIN` | 外部 HTTPS origin，必需；仅本机测试允许 HTTP loopback |
| `PACK_CENTER_LISTEN_HOST` | API 监听地址，默认 `127.0.0.1` |
| `PACK_CENTER_LISTEN_PORT` | API 端口，默认 4310 |

```bash
npm run build
npm run migrate
```

迁移事务使用专属 schema 和 advisory lock，记录 SQL 摘要；已执行迁移缺失或改写会阻断。失败整体回滚。后续结构变更新增迁移，不改历史。服务启动只读验证完整迁移集合及摘要，不自动迁移。目前必须保留 monorepo 相对布局：app 的 `dist/`、`migrations/`、`web/`，同源根目录 `packages/pack-contract/`、`packages/pack-artifact/`、`lib/pack-validator.js` 及引用的构建文件；尚非独立 npm 包/镜像。API 启动预读固定网页资产，缺失或不是受支持的真实普通文件时拒绝启动；不能仅部署 `dist/`。

## 显式进程入口与凭据分离

以下命令仅在配置好的隔离环境由操作者运行；安装不会自动启动服务。不同进程只注入所需凭据，API/Git Worker 不得获得签名私钥。

```bash
node dist/main.js migrate
node dist/main.js bootstrap-admin
node dist/main.js api
node dist/main.js validate-worker
node dist/main.js publish-worker
```

后三个是独立长驻进程，不应在同一顺序 shell 中当初始化脚本执行。API 不运行 Git、不读取签名私钥；校验 Worker 只领校验任务；发布 Worker 只用已批准快照，不访问 Git。`SIGINT` / `SIGTERM` 停止领取新任务并等待当前工作收尾，强制终止靠租约恢复。反向代理使用固定外部 HTTPS origin，不根据 Host/转发头推断信任域名。bootstrap 明确指定可信 issuer 下已确认的 subject，首个访客不能领取管理员，且无 HTTP bootstrap 后门。

| 配置 | 使用进程及要求 |
|---|---|
| `PACK_CENTER_OIDC_ISSUER`, `PACK_CENTER_OIDC_CLIENT_ID` | API/bootstrap；可信 issuer 与登记客户端，callback 固定 `/api/auth/callback` |
| `PACK_CENTER_OIDC_CLIENT_SECRET_FILE` | API/bootstrap；可选机密客户端凭据文件 |
| `PACK_CENTER_LOGIN_KEY_FILE` | API/bootstrap；32 个原始随机字节，加密短期登录材料；重启保持，轮换会使在途登录失效 |
| `PACK_CENTER_BOOTSTRAP_SUBJECT`, `PACK_CENTER_BOOTSTRAP_DISPLAY_NAME` | 仅 bootstrap；issuer 使用上述 OIDC 配置 |
| `PACK_CENTER_ALLOW_LOOPBACK_HTTP` | 默认 false；只有隔离 loopback HTTP 测试可显式 true |
| `PACK_CENTER_GIT_ALLOWED_HOSTS` | API/校验 Worker；逗号分隔、精确小写 DNS 主机名，无通配、IP 或端口 |
| `PACK_CENTER_ARTIFACT_ROOT` | API/两类 Worker；共同访问的私有本地制品根，现有真实父目录；不是 S3 |
| `PACK_CENTER_SCRATCH_ROOT` | 两类 Worker；预先创建、归当前用户且 `0700` 的真实目录；部署须提供硬配额临时卷，组件监控不是硬配额证明 |
| `PACK_CENTER_SIGNING_KEY_ID`, `PACK_CENTER_SIGNING_KEY_FILE` | 仅发布 Worker；固定 key ID 与 Ed25519 PEM 私钥；不得注入 API/Git 进程 |
| `PACK_CENTER_TRUSTED_SIGNING_KEYS_FILE` | API 必需；受保护 JSON 文件，格式 `{keyId: Ed25519 公钥 SPKI PEM}`，拒绝私钥、非 Ed25519、空库存；历史发布公钥须保留 |
| `PACK_CENTER_BUILTIN_VERSIONS` | 两类 Worker；可信插件构建提供的 `{packId:version}` JSON；默认 `{}`，未配置的 builtin 依赖拒绝 |

凭据文件要求绝对真实路径、当前用户所有、无软/硬链接、无组/其他用户权限，并有大小上限。使用宿主凭据机制，不把真实值写入仓库、Obsidian 或日志。制品与临时目录没有自动 GC；失败保留原批准和不可变产物。

详细接口见 [README-http.md](README-http.md) 和 [README-distribution-http.md](README-distribution-http.md)，目录信任/下载语义见 [README-catalog.md](README-catalog.md)，下架与范围审核见 [README-governance.md](README-governance.md)，存储见 [README-storage.md](README-storage.md)，签名恢复见 [README-publisher.md](README-publisher.md)，Git 隔离边界见 [git-fixture.md](test/support/git-fixture.md)。

开发者链路：邀请登录 → 创建/编辑草稿 → `validate` 返回 202 异步任务 → 查看固定 commit/预览/差异/报告 → `submit` → 另一位授权审核员 `review`。新包建议使用 `orgslug.packslug` 命名空间；为兼容既有领域包，也接受安全的无点号包 ID，但包 ID 仍全局唯一且绑定首个所属组织。严格 SemVer；选择分发对象须为有效组织/部署点。改动须新建 submission 并引用 previousSubmissionId，不覆写旧报告。

审核通过只是排队发布，不等于已可下载。详情的 `release` 独立显示 `publishing` / `publish_failed` / `published`；有权管理员/审核员凭预期 release 版本及幂等键 `retry-publication`，重试同一快照，不能重新抓取来源。

## 数据模型与后续 API 接口

`src/database.ts` 导出 `createDatabase(DatabaseConfig)`，提供 `query`、`transaction`、`migrate`、`close`、`health` 及下述任务 API；`transaction` 的所有业务 SQL 必须使用回调收到的同一个 `PoolClient`。没有自动重试业务事务，避免重复执行回调中的外部副作用。

| 表 | 数据约束/后续服务责任 |
|---|---|
| `organizations`, `users` | 用户唯一键为 `(oidc_issuer, oidc_subject)`，不是 email；人员与组织有禁用状态 |
| `memberships`, `review_scopes` | 组织角色和审核授权范围；API 每次请求重新检查有效身份/成员资格/审核范围 |
| `invitations`, `sessions`, `oidc_login_attempts` | 邀请令牌、会话及 CSRF 验证材料只存摘要；PKCE verifier 只允许加密短期材料，密钥不在数据库 |
| `packages` | 全局 `pack_id`，拥有组织不可直接改写 |
| `submissions` | 状态和 `state_version`；开始验证后来源、版本、说明、许可证和分发范围冻结；改内容须新提交 |
| `submission_snapshots` | 提交与快照复合外键绑定；字节摘要、私有制品键、报告/预览/差异；禁止更新和删除 |
| `validation_attempts` | 每次执行结果，失败不能覆写上一快照 |
| `reviews` | 每份提交只接受一次审查；禁止自审，强绑定待审版本、快照和树摘要；审查记录不可变 |
| `releases` | 只有已批准快照才能创建；`pack_id + 完整 version` 唯一；已有签名清单、快照与身份不可覆盖，禁止删除 |
| `release_distribution`, `distribution_reviews` | 当前范围及独立审核申请；扩大/缩小范围均经独立审核；变更不改签名与制品 |
| `deployments`, `deployment_binding_codes`, `deployment_credentials` | 一次性绑定码、机器凭据摘要；机器 scopes 仅目录读取和下载；事务内兑换/撤销与实时检查 |
| `download_grants` | 短时许可摘要，绑定身份/具体机器凭据/发布与清单摘要；仍须实时授权，不是公开下载链接 |
| `audit_events` | 只追加；禁止更新或删除。调用者必须脱敏，不能保存密钥、cookie、完整下载 URL |
| `request_idempotency` | 业务事务幂等结果；不能把会话/绑定码兑换的明文凭据放入 `result` |
| `jobs`, `job_attempts` | 持久任务、独占租约、重试上限和每次租约历史 |

所有表位于独立 schema。数据库约束是第二道防线，**不是接口权限系统**：组织隔离、OIDC 校验、角色判定、分发范围完整 schema 校验、HTTPS Git SSRF 防护、签名验证、发布清单与快照逐字段一致性仍必须在服务层完成。数据库管理员可以修改数据库，本方案不把数据库管理员视为不可信租户。

Submission / Release 状态名遵循 `packages/pack-contract`。更新必须显式使用预期版本条件，并将 `state_version` 增加 1；SQL 影响行数为 0 时由 API 返回冲突，不能悄悄重试改目标。审查插入会锁定 submission 并检查 `expected_state_version`；审核决定、submission 状态迁移、release 创建及发布 job 入队应在**同一业务事务**完成。

## 任务领取、重试与崩溃恢复

```ts
await db.transaction(async client => {
  // 同一个 client 更新 submission 状态。
  await enqueueJob(client, {
    kind: 'validate_submission',
    idempotencyKey: 'validate:submission-id',
    payload: { submissionId: 'submission-id' },
    maxAttempts: 3,
  })
})

const lease = await db.claimJob('worker-instance-id', {
  kinds: ['validate_submission'],
  leaseMs: 30_000,
})
if (lease) {
  // 拉取/验证在事务之外完成；及时 renewJob(lease)，不可执行仓库代码。
  // 保存不可变制品后，结果与任务成功在同一有租约保护的事务提交。
  await db.withJobTransaction(lease, async client => {
    // 使用 client 写入快照、验证结果并迁移 submission。
    return { submissionId: 'submission-id' }
  })
}
```

- `enqueueJob(client, input)` / `db.enqueueJob(input)` 按 `(kind, idempotencyKey)` 去重，并校验规范化 payload 与重试策略摘要；同键不同请求报 `IDEMPOTENCY_CONFLICT`。
- `claimJob(workerId, { kinds, leaseMs })` 使用 `FOR UPDATE SKIP LOCKED`，每次领取生成新的随机 `leaseToken` 并增加 attempt。
- `renewJob`、`completeJob`、`failJob`、`withJobTransaction` 都检查当前 token、owner 和数据库租约时间；过期 worker 报 `LEASE_LOST`，不能续活旧租约。
- `withJobTransaction` 开始与结束都校验租约，失效时业务写入和完成状态一起回滚。
- 崩溃留下的过期任务可重新领取；最后一次尝试崩溃由下一轮 `claimJob` 收敛为 failed，不永久显示 running。
- `failJob(lease, { code, message }, { retry: true, delayMs })` 仅在尚有重试额度时回到 queued。日志消息必须由 Worker 脱敏后传入。
- 任务投递语义是**至少一次**，不宣称跨 PostgreSQL 与对象存储“正好一次”。制品先按不可变键写入，业务 DB 事务以固定快照/唯一版本/租约 token 防重复；失败最多保留可审计未引用制品，不能先删除旧发布。
- 队列本身不拿签名密钥。Git 校验 worker 与签名发布 worker 应通过不同 `kinds` 领取，并使用不同进程和凭据边界。

参考：[node-postgres 事务说明](https://node-postgres.com/features/transactions)、[PostgreSQL 17 SELECT 锁语义](https://www.postgresql.org/docs/17/sql-select.html)、[显式锁与 advisory lock](https://www.postgresql.org/docs/17/explicit-locking.html)。

## 早期持久层实测记录（2026-09-19，历史版本）

在隔离开发树运行 `npm test && npm run typecheck`，最终退出码 0：13 / 13 测试通过，无跳过，测试进程耗时约 12.7 秒（不含构建）。PostgreSQL 实际版本 `17.11`，不是模拟数据库。覆盖迁移并发幂等/历史摘要/失败回滚、schema 参数覆盖防护、事务回滚、OIDC 身份唯一性/包拥有关系、固定快照、自审拒绝/并发审核、完整版本唯一性/签名字段不可变/下架、机器凭据 scope、追加审计、队列幂等/独占领取/租约失效和重试耗尽、跨 Node 进程持久化。

最终临时容器 ID：`9994e86c5fa5487a67f03cccf1e5d133132019e27e14e9728df81bd266cc07c1`。测试结束已验证标签并删除该容器和其匿名测试卷；随后按任务标签只读检查未发现遗留测试容器。没有启动或修改生产服务。

该轮 `migrations/001_core.sql` SHA-256：`feb6c2e63ddbc640b3f80ed067ea56ee9e63ae9cd57961723b629155469f2a52`；独立 `package-lock.json` SHA-256：`248cf06ff49349876c8bd701f2a5182da7ae02355a2dfe042e8cba4e263c06dd`。这些结果只证明上述持久化组件，不证明尚未实现的登录、HTTP 权限、公开 Git 拉取、签名分发或 UI 完成。
