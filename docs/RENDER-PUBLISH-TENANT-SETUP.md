# 租户渲染产物发布

`render_publish` 仍由会话内调用，接受工作区中的 HTML/PDF 文件、`teamId` 和 `slug`，返回免登录的公开链接。单个文件上限 16 MiB。调用方须确认内容可以公开。

为每个客户实例准备独立的发布目录，例如 `/var/www/dsh-render/tenants/<tenant>`。`tenants` 父目录由 root 管理（`0755`）；子目录由该实例的服务用户拥有（`0755`）。不要把整个 `/var/www/dsh-render` 加入实例的可写路径。

在该实例的 systemd drop-in 中配置：

```ini
[Service]
Environment=DSH_RENDER_PUBLIC_DIR=/var/www/dsh-render/tenants/<tenant>
Environment=DSH_RENDER_PUBLIC_BASE=https://yy.meizu.life/render/tenants/<tenant>
ReadWritePaths=/var/www/dsh-render/tenants/<tenant>
```

两项环境变量须同时配置；均未配置时，工具沿用历史发布目录和 URL。nginx 的 `/render/tenants/` 路由从对应目录直出，只为 HTML/PDF 指定可内联的类型，并对 HTML 设置 sandbox CSP。新的租户共用这条路由，只需建立各自目录和 systemd 配置。

部署后执行 `nginx -t`，加载 nginx 配置，`systemctl daemon-reload` 并重启客户实例。用客户实例自己的 UID 和挂载命名空间调用 `render_publish`，再访问返回的公网 URL；检查 HTTP 200、Content-Type，并比较下载文件与源文件的 SHA-256。首次发布前应检查源文件是否适合公开。
