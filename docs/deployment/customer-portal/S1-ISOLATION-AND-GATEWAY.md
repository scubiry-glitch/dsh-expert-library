# 智见客户页 S1：账号运行隔离与 DSH 网关

> 2026-10-08。此文是 S1 实施契约；当前公网 `zhijian.meizu.life` 已开放身份验证试点和待开通提示，尚未开放客户会话或 DSH 运行。

## 已落地的调用链

1. 浏览器从 `zhijian.meizu.life` 进入 OIDC。客户应用是单独客户端 `zhijian-customer-portal`，精确回调为 `/api/auth/callback`；开发者中心原客户端 `packs-center-web` 及回调保持原值。OIDC 客户端校验授权码、PKCE、state、nonce、签名、issuer 和 audience。
2. 客户 BFF 从已验证的 `issuer+sub` 查显式开通的用户和账号成员关系，发自己域名下的 HttpOnly 会话 Cookie。首次验证但尚未开通的身份留在待开通清单，由管理员指定账号；不会凭姓名或邮箱合并。浏览器会话与 CSRF 仅存摘要，成员被撤销后随即拒绝新请求。
3. 账号在服务端绑定 `workspace_id` 和唯一 `backend_ref`；部署配置把不同 ref 映射到不同受限 DSH 入口。别名和 URL 不接收浏览器参数，也不出现在 API 响应里；两个账号不能绑定同一后端别名，配置拒绝两个别名指向同一个 Origin。
4. 新建会话先以账号和请求 ID 写入幂等索引，再调用该账号 DSH 的 `/customer-gateway/sessions`，使用 `session-<会话 UUID>` 作为 Host 显式会话 ID。失败重试沿用同一 ID；创建成功后绑定 DSH ID。发送、读取对话前均查账号归属。
5. DSH 内网网关只在专属进程同时配置 `DSH_CUSTOMER_WORKSPACE_DIR` 与 `DSH_CUSTOMER_GATEWAY_TOKEN_FILE` 时注册；限定环回入口和 Bearer 服务凭据。它不接收浏览器账号、工作区路径或通用 RPC 参数，只暴露固定工作区创建会话、发送消息与读取人类可见对话。

## 必须满足的部署边界

- **一个不互信客户账号一个 DSH 实例与运行身份**，各自拥有独立工作目录、会话持久化和网关 token 文件。不同实例不得挂载彼此的私有工作区；共享领域包以只读发行物提供。`workspace-write` 只限制写入，不能充当跨账号读取隔离。
- Portal 的 `DSH_BACKENDS_JSON` 按账号配置实例 Origin，例如两个不同本地端口。`DSH_GATEWAY_TOKEN_DIR/<backend_ref>.token` 仅由 Portal 服务账号读取，内容须足够随机且至少 32 字节；DSH 实例通过自己的 token 文件读取同一值。token 不进 Git、记忆库、URL、浏览器和日志。远端部署使用私网加认证隧道，使 DSH 网关实际连接仍来自环回地址。
- Portal 的 `ACCOUNT_DB_PATH` 保存在仅服务账号可写目录，服务需对该目录授予 `ReadWritePaths`。当前 Node 22 SQLite API 属实验状态；已固定运行时 Node 22.23.2 并完成在线备份与模拟数据恢复，后续运行时升级仍须回归。
- 旧 `/plugins/dsh-expert-library/review` 分享审阅路由继续按原权限运行；客户网关是单独路径和单独服务凭据。

## 2026-10-08 真实 Host 隔离冒烟

已从当前插件构建出独立 tgz，在两个新 `DSH_HOME` 中分别安装；两个 Host 运行在 `127.0.0.1:3188/3189`，进程用户分别为 `zhijian-dsh-smoke` 与 `zhijian-dsh-smoke-b`，私有目录为 0700。它们是本机**临时试验实例**，尚非客户生产实例，也未接到公网客户页。
冒烟结束后两个临时 Host 已停止，端口不再监听；原 DSH Web、Pack Center OIDC 和客户页服务保持运行。

- 两个网关自己的服务凭据返回 200，交换凭据返回 401；A 的会话在 B 网关用 B 凭据读取返回 404。
- A 运行用户读取 B 私有目录、B 运行用户读取 A 的凭据文件均被操作系统拒绝。
- `scripts/smoke-isolated-hosts.mjs` 以真实双 Host、临时 BFF 和两个模拟已开通身份完成空白会话创建、自己的会话读取、跨账号直链拒绝与缺失 CSRF 拒绝：`PASS / hosts=2 / ownRead=200 / foreignRead=404 / missingCsrf=403`。脚本只建空白会话，不请求模型。
- 重启后首次读取旧会话曾返回 404；原因是网关只从内存 Session 列表核对归属。现已改为通过 SessionQuery 读取持久化会话头和 cwd 后验权；重新构建、打包、安装到两个试验实例后，重启前的旧会话读取返回 200。两个实例的 BFF 交叉测试再次通过。
- 从 B 的运行用户直连 A 的 DSH 原生 `/` 和 `/api` 返回 401；旧审阅页 HTML 路由仍可返回静态页面，但无分享授权无法读取会话。网关凭据和私有文件访问另按上面的检查拒绝。
- 真正向 A 网关发送第一问返回 202，用户消息已可投影；隔离实例未配置模型提供方凭据，Host 记录 `no API key for provider route deepseek-official`，所以**模型回复未通过**。凭据须走实例自己的受控凭据机制，不能借用主 DSH profile 的私有配置文件。
- Pack Center OIDC 服务已重新加载精确客户端登记：旧 `packs-center-web` 和新 `zhijian-customer-portal` 登录入口均为 200，未登记的 callback 为 400。客户页公网已开放登录试点，未开通的身份无研究权限；见 [S1 登录发布记录](S1-AUTH-DEPLOYMENT-20261008.md)。

真实 Host 冒烟可用以下环境变量重跑，变量仅是本地地址和凭据**文件路径**，脚本不会输出凭据：

```bash
DSH_SMOKE_BACKEND_A=http://127.0.0.1:3188 \
DSH_SMOKE_BACKEND_B=http://127.0.0.1:3189 \
DSH_SMOKE_TOKEN_A=/var/lib/zhijian/customer-dsh-smoke/gateway.token \
DSH_SMOKE_TOKEN_B=/var/lib/zhijian/customer-dsh-smoke-b/gateway.token \
node apps/customer-portal/scripts/smoke-isolated-hosts.mjs
```

## 已验证与待验收

代码测试已覆盖：双账号会话列表与直链拒绝、后台实例选择、幂等会话 ID、首问路由、网关未认证/外账号拒绝、OIDC 真实签名校验及错误 audience 拒绝。插件 TypeScript 构建、客户应用构建和独立发布包均通过。

**未验收：**隔离 DSH **生产**实例尚未创建；首次真实账号尚未开通；两个试点身份的 OIDC 登录、模型回复、重启恢复和 token 用量仍待验证。因此对外入口维持 S0。下一道发布闸门是给独立实例配置授权模型路由，并以两个真实试点身份完成端到端交叉测试。
