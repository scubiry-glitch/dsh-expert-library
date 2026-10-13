# 智见客户页 S1 登录试点发布记录

> 本文记录登录试点发布时的状态。三个测试账号后续已开放隔离实例中的会话与首问；当前状态见 [S1 运行实例记录](S1-RUNTIME-STAGING-20261008.md)。

2026-10-08。公开入口为 `https://zhijian.meizu.life`，仍指向现有服务器。此次只开放身份验证和待开通登记；没有把临时双 DSH Host 接到公网客户页，研究按钮保持禁用。

## 已发布

- Pack Center OIDC 新增精确客户端 `zhijian-customer-portal`，回调固定为 `https://zhijian.meizu.life/api/auth/callback`。旧 `packs-center-web` 的登录页在线返回 200，新客户端返回 200，未登记的回调返回 400。
- 客户页从独立 `apps/customer-portal/release/` 发布。`/api/bootstrap` 在线返回 `phase: S1-auth`、`loginProviders: [developer-center]`、`researchReady: false`；`/api/auth/start` 302 到身份服务；`/login` 为 200。原审阅页仍为 200。
- `zhijian-customer-portal.service` 继续以 `zhijian-portal` 用户运行。新增私有目录 `/var/lib/zhijian/customer-portal`（0700）和 `accounts.sqlite`（0600）；systemd 仅对此目录增加 `ReadWritePaths`。OIDC issuer、客户端 ID 和数据库路径在服务器环境文件中配置。当前数据库没有客户账号或成员，验证成功的陌生身份只会登记待开通。
- 后续安全修正禁止把客户账号绑定到 `DSH_BACKEND_URL` 的 `default` 别名，只接受 `DSH_BACKENDS_JSON` 中显式配置的隔离实例别名；12 项客户应用测试再次通过并已更新公网发布包。
- 发布前独立本地实例已验证 OIDC 入口可用，客户应用测试 12/12 通过；真实双隔离 Host 冒烟与冷会话恢复见 [S1 隔离与网关](S1-ISOLATION-AND-GATEWAY.md)。
- 发布后使用**合成且临时的开发者中心身份**走完公网 OIDC 链路：首次验证进入待开通，运维通过受控开通工具显式加入测试账号，再次登录得到该账号的登录态，退出后登录态失效。测试凭据文件、账号、成员、会话和待开通记录均已清理；生产库各表回到 0 行，完整性检查为 `ok`。这不替代两个真实试点身份的交叉验收。

## 数据备份与回滚

在应用运行时，使用固定的发布版 Node 22.23.2 `node:sqlite.backup` 对生产数据库做在线备份，目标为 `/var/lib/zhijian/customer-portal/backups/accounts-20261008-before-first-member.sqlite`（0600）。`PRAGMA integrity_check` 返回 `ok`；另外用含模拟账号与成员的独立数据库完成备份、重新打开及身份归属恢复检查。数据库还没有真实账号，生产备份账号数为 0。

初次启用登录前的应用目录保存在 `/opt/zhijian/customer-portal.backup-20261008-s0-before-auth`，后续后端别名修正前的应用目录保存在 `/opt/zhijian/customer-portal.backup-20261008-before-backend-guard`；环境文件保存在 `/etc/zhijian/customer-portal.env.backup-20261008-before-auth`。如登录试点需回滚，应同时还原应用目录、环境文件和 systemd 的 `10-data.conf` 配置后重启客户页服务；原 DSH Web 服务不在此次发布范围。已创建的账号数据库和备份应保留供审计，不随应用回滚删除。

## 仍需完成

1. 用两个真实试点身份完成登录、待开通、显式加入不同账号、退出与撤权验证；身份值只在私有运维通道处理。
2. 给每个正式隔离 DSH 实例配置授权模型凭据，验证第一问收到模型回复，再绑定账号到独立后端别名。临时 Host 的空白会话和首问接收不等于客户可用。
3. 正式试点前复核提供方用量、私有报告路径、数据库升级和备份恢复，以及端到端双账号权限与回滚。
