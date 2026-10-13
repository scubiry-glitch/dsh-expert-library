# 智见客户独立页 S0 线上部署记录

日期：2026-10-08。公开地址：`https://zhijian.meizu.life`。这是无客户数据的 S0 底座；登录功能尚未开放。

## 当前拓扑

`zhijian.meizu.life` 的 Cloudflare 代理 A 记录指向当前 DSH 服务器 `43.156.49.59`。Nginx 为该域名提供 HTTPS，反代到本机 `127.0.0.1:18460` 的 `zhijian-customer-portal.service`。发布包位于 `/opt/zhijian/customer-portal`，环境文件位于 `/etc/zhijian/customer-portal.env`，权限只允许 root 读取。服务端的 `DSH_BACKEND_URL` 当前指向本机 DSH `http://127.0.0.1:3080`；浏览器只访问客户页域名，不拿到该内部地址。

Nginx 源配置见 [`zhijian.meizu.life.s0.conf`](zhijian.meizu.life.s0.conf)。源站证书位于 `/etc/ssl/zhijian.meizu.life/`，由 acme.sh 定时续期并在安装后重载 Nginx。Cloudflare 仅对 `zhijian.meizu.life` 启用 Full (strict) 配置规则；`meizu.life` 的区级 SSL 模式未修改。Cloudflare DNS 记录 ID 为 `bbe5866c61bbc73025e1f34f1be7dbfd`，Configuration Rules 规则集 ID 为 `da981de4d1574cca9a87eb924ab9d9cd`，规则 ID 为 `e7ab723e07494abd8ef1e50dae4df90c`。

## 发布与回滚

在 `apps/customer-portal` 构建和测试后，把 `release/` 安装到独立应用目录，再重启 `zhijian-customer-portal.service`。应用只绑定 `127.0.0.1:18460`；Nginx 是唯一公开入口。更新 Nginx 时先执行 `nginx -t`，再执行 `nginx -s reload`。证书续期脚本也使用这一重载方式。

应用回滚：保留上一个 `release/` 包，替换 `/opt/zhijian/customer-portal` 的应用文件并重启该服务；不动 DSH 主服务。若该域名需要暂时下线，只撤销独立 Nginx 站点和 Cloudflare 的该域名 DNS/配置规则，不更改 `yy.meizu.life` 与 DSH 现有路由。删除 DNS 或证书属于对外下线动作，应按发布负责人批准的回滚决定执行。

## 已验证

- `nginx -t` 通过，客户页 systemd 服务为 active。
- 源站 HTTPS 证书校验通过，源站 HTTP 跳转到 HTTPS；公网 HTTPS `/login`、`/preview`、`/healthz`、`/api/bootstrap` 返回 200，公网 HTTP 只有一次跳转。
- `/api/bootstrap` 返回 `authenticated:false`、`phase:S0`；登录按钮不可用，未读取客户会话、数据或报告。
- 旧入口 `https://yy.meizu.life/plugins/dsh-expert-library/review` 返回 200。
- 现有 DSH 审阅路由连通性探测通过；这只说明服务可达，不代表账号授权调用已完成。

客户真实登录前仍需完成 [S0 状态记录](S0-STATUS-20261008.md) 的身份、权限和双账号交叉访问闸门。
