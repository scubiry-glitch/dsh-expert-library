# DeepSeek Harness 与专家库部署手册

适用制品：`clean-deploy-20261004-124220` 中的四个压缩包。本文针对新机器安装；命令是给目标服务器执行的步骤，本次编写文档没有启动、重启或修改线上服务。

## 1. 包、仓库与部署范围

| 组件 | 压缩包 | 对应 GitHub |
| --- | --- | --- |
| Harness 核心 | `dsh-core.tar.gz` | [scubiry-glitch/zhijianharness，dsh-core 分支](https://github.com/scubiry-glitch/zhijianharness/tree/dsh-core) |
| 专家库插件 | `dsh-expert-library.tar.gz` | [scubiry-glitch/dsh-expert-library，main 分支](https://github.com/scubiry-glitch/dsh-expert-library/tree/main) |
| 配置、预设与皮肤 | `dsh-home-template.tar.gz` | [scubiry-glitch/zhijianharness，main 分支](https://github.com/scubiry-glitch/zhijianharness/tree/main) |
| 领域包中心 | `pack-center.tar.gz` | 本包自带源码、README、数据库迁移及服务模板 |

这些地址已核对本机 Git origin 与分支；访问权限由仓库账号决定。核心与配置是同一仓库的不同分支。配置包是从配置仓库提取静态资源并生成的最小 Profile，不是线上 DSH_HOME 整目录备份。

压缩包封存的是打包时的本机文件和已安装运行依赖，不能假定 GitHub 当前分支与其字节一致。首次部署优先使用压缩包，不要通过 `npm install` 或 `git pull` 覆盖随包依赖中的本地补丁。核心主要是编译后 JavaScript 与兼容层，不包含上游完整 TypeScript monorepo。

前三个包用于运行 Harness 与专家库。只有需要自行提供领域包发布、审核、签名和分发服务时，才需要部署第四个包。报告工艺及参考资料随专家库的 `domain-packs/zhijian-realestate` 交付。

## 2. 环境与目录

本制品面向 Linux x86_64；归档验证使用 Node.js **22.23.2**。其他平台或 Node 主版本需要重新验证原生依赖。服务器应已安装 Node.js、tar、sha256sum；报告功能另需 Python 和渲染工具，见第 7 节。领域包中心另需 PostgreSQL 17+、Git、OpenSSL、`prlimit` 和 HTTPS 入口。

下文使用独立新目录 `/opt/zhijian-clean`，不覆盖已有部署。命令按 Bash 编写；创建系统目录和服务单元需要管理员权限。

```text
/opt/zhijian-clean/
├── dsh-core/                 核心及运行依赖
├── dsh-expert-library/       插件、领域包、知识与运行依赖
├── dsh-home-template/        实际 DSH_HOME；运行后会产生状态
├── pack-center/             中心代码，可选
└── workspace/               新业务工作区，安装时创建
```

保留前三个目录的同级关系。Profile 中的插件链接是相对链接，只移动其中一个目录会导致加载失败。`dsh-home-template` 是交付时的名称；开始运行后它就是有状态的用户目录，不能再当作清洁模板分发。

## 3. 校验并解压

把四个压缩包和 `SHA256SUMS` 放到服务器同一个目录，从该目录执行：

```bash
set -euo pipefail
uname -m
node --version
sha256sum -c SHA256SUMS

test ! -e /opt/zhijian-clean
install -d -m 0755 /opt/zhijian-clean
tar -xzf dsh-core.tar.gz -C /opt/zhijian-clean
tar -xzf dsh-expert-library.tar.gz -C /opt/zhijian-clean
tar -xzf dsh-home-template.tar.gz -C /opt/zhijian-clean
tar -xzf pack-center.tar.gz -C /opt/zhijian-clean
install -d -m 0700 /opt/zhijian-clean/workspace
chmod 0700 /opt/zhijian-clean/dsh-home-template
```

已有同名目录时，改用另一个新的父目录，不要跳过保护后直接覆盖。使用非 root 运行账号时，工作区与 DSH_HOME 必须归该账号所有；报告浏览器默认路径也需按第 7 节处理。

检查入口和配置组合，不启动服务：

```bash
node /opt/zhijian-clean/dsh-core/lib/bin.js --help
DSH_HOME=/opt/zhijian-clean/dsh-home-template \
  node /opt/zhijian-clean/dsh-core/lib/bin.js --profile web --dump-config
DSH_HOME=/opt/zhijian-clean/dsh-home-template \
  node /opt/zhijian-clean/dsh-core/lib/bin.js --profile headless --dump-config
readlink -f /opt/zhijian-clean/dsh-home-template/profiles/web/node_modules/@zhijian/dsh-expert-library
```

最后一条应指向 `/opt/zhijian-clean/dsh-expert-library`。配置输出应包含 `expert-library`。模板已注册插件，不需要再次运行插件安装命令。

## 4. 首次启动与访问

先以前台方式确认运行，再设置守护服务：

```bash
cd /opt/zhijian-clean/workspace
DSH_HOME=/opt/zhijian-clean/dsh-home-template \
  node /opt/zhijian-clean/dsh-core/lib/bin.js \
  --profile web --host 127.0.0.1 --port 8080 --no-open
```

启动后终端打印 `dsh web:` 登录链接，其中含本次进程的认证 token。使用该完整链接访问；分享日志前应去掉认证参数。每次重启使用新打印的链接。

远程服务器可在自己的电脑开 SSH 隧道：

```bash
ssh -N -L 8080:127.0.0.1:8080 USER@SERVER
```

然后在本机浏览器打开启动链接中的 `http://127.0.0.1:8080/...`。若本机 8080 被占用，换一个本地端口并同步修改浏览器地址的端口，保留认证参数。

包内 Web 启动器拒绝 `--host 0.0.0.0`，不要用它暴露公网。本手册先采用 SSH 隧道。面向多人公网服务时，还需单独部署身份登录、反向代理和 WebSocket 转发；本清洁模板不包含原线上全部登录和租户隔离组件，也不会自动重建名为 `real` 的租户。

## 5. 模型、专家库与领域包

1. 在 Web 的模型/提供方授权入口配置目标机器自己的凭据；配置后确认模型在可选列表中出现。
2. 先发起一次简单模型请求，确认不是仅有页面而模型不可用。该步骤会实际消耗模型额度。
3. 检查专家库能列出专家和技能，并确认 `zhijian-realestate` 已被宿主发现、启用。实际加载目录以宿主包信息为准，不能把“文件存在”当作“已经加载”。
4. 如果本次业务要求 **Kimi K2.8 Preview**，分别核对会话/队长预设和专家成员路由。专家库 `defaultModel` 只是成员缺省路由，有独立模型路由的专家仍可能覆盖它；不能只修改一个全局字段就视为全员切换。
5. 在新会话实际运行记录中核对队长与成员的 provider/model。显示名称与接口 ID 可以不同，必须使用目标提供方注册的有效 ID。

本地凭据通常保存在 `$DSH_HOME/.credentials.yaml`，要求仅属主可读写（0600）。可经配置界面保存，不要把真实密钥写进本文或代码库。启动时注入的凭据优先于保存的凭据；修改服务环境后需重启对应进程。

专家库配置覆盖文件是：

```text
/opt/zhijian-clean/dsh-home-template/profiles/web/cordis.patch.yml
```

模板初始为 `[]`。修改配置时注意 Cordis 补丁可能替换整段 `config`；应保留原有字段并用 `--dump-config` 检查最终结果。模型 ID、中心 origin、包目录等按目标环境填写，不复制原服务器的账号状态。

## 6. systemd 常驻运行

先关闭第 4 节的前台进程，避免端口冲突。确认 `command -v node` 的绝对路径；服务中的 `ExecStart` 必须使用目标机器的 Node 路径。

创建 `/etc/systemd/system/zhijian-clean.service`，以下 `/usr/local/bin/node` 为示例，需换成实际路径：

```ini
[Unit]
Description=Zhijian Harness and Expert Library
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/zhijian-clean/workspace
Environment=DSH_HOME=/opt/zhijian-clean/dsh-home-template
Environment=PATH=/opt/zhijian-report-venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/node /opt/zhijian-clean/dsh-core/lib/bin.js --profile web --host 127.0.0.1 --port 8080 --no-open
Restart=on-failure
RestartSec=5
TimeoutStopSec=120
UMask=0077

[Install]
WantedBy=multi-user.target
```

此示例未指定 `User`，按 systemd 系统服务默认使用 root，与包内报告浏览器的原始 `/root/...` 路径相容。如改为专用账号，应设置 `User`/`Group`、目录所有者，并完成第 7 节的浏览器路径适配。

```bash
systemd-analyze verify /etc/systemd/system/zhijian-clean.service
systemctl daemon-reload
systemctl enable --now zhijian-clean.service
systemctl status zhijian-clean.service --no-pager
journalctl -u zhijian-clean.service -n 80 --no-pager
```

journal 中可能包含启动认证链接，不应原样分享。

## 7. MD / HTML / PDF 报告环境

Python 检查通过 `python3 -I` 启动；只装在 `pip --user` 下的包可能不可见。可使用独立 venv，并将其 `bin` 放入服务 PATH 的首位；上面的 unit 已预留该路径。

以下命令会在目标机安装 Python 依赖、Chromium 及其系统依赖，需要软件源网络；这些内容没有包含在四个压缩包中：

```bash
python3 -m venv /opt/zhijian-report-venv
/opt/zhijian-report-venv/bin/python3 -m pip install \
  markdown-it-py beautifulsoup4 pypdf PyMuPDF weasyprint playwright
/opt/zhijian-report-venv/bin/python3 -m playwright install --with-deps chromium
/opt/zhijian-report-venv/bin/python3 -I -c \
  'import markdown_it, bs4, pypdf, fitz, weasyprint; from playwright.sync_api import sync_playwright; print("imports OK")'
```

上面是依赖名称清单，不是经过完整业务验收的版本锁。目标机跑通后用 `pip freeze` 留存实际版本。系统还需中文字体与字体缓存；例如由系统软件源安装 Noto CJK，并用 `fc-match sans-serif:lang=zh` 确认不是缺字回退。WeasyPrint 所需系统库也须满足，不能用“pip 成功”代替渲染测试。

**本包的已知路径限制：** `zhijian-realestate/checks/report-craft-checker-v2.mjs` 的默认浏览器为：

```text
/root/.cache/dsh-report-craft/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell
```

仅设置 `PLAYWRIGHT_BROWSERS_PATH` 不会改掉这个显式路径。root 部署可将该位置链接到已经安装的 Chromium；仅在目标不存在时创建，不覆盖已有浏览器：

```bash
report_browser=$(/opt/zhijian-report-venv/bin/python3 - <<'PY'
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    print(p.chromium.executable_path)
PY
)
test -x "$report_browser"
report_browser_alias=/root/.cache/dsh-report-craft/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell
install -d -m 0700 "$(dirname "$report_browser_alias")"
if [ ! -e "$report_browser_alias" ] && [ ! -L "$report_browser_alias" ]; then
  ln -s "$report_browser" "$report_browser_alias"
fi
test -x "$report_browser_alias"
```

非 root 部署需将检查器的浏览器路径接入实际 Host 配置，或调整领域包默认路径后重新生成和验证领域包摘要；不要只在 `generated` 中改一个文件，否则包完整性检查可能失败。当前包内预检没有通用的浏览器路径环境变量开关。

先确认浏览器可启动，再做完整报告任务。业务发布验收至少包括：最终 MD/HTML/PDF、所选技能必需材料、与最终文件 SHA-256 绑定的检查及独立审核证据。缺失、失败、未验证或过期证据均不能按成功交付。包内生成器/预检只是工艺工具，不会单独签发 Host 收据，也不替代独立审核。

具体参数以实际加载领域包的 `references/render-v2.md` 和 `scripts/preflight-report.mjs` 为准。打包时的入口、依赖检查通过，不代表新服务器已通过真实业务验收。

## 8. 可选：独立部署领域包中心

中心代码位于 `/opt/zhijian-clean/pack-center`，运行入口在 `apps/pack-center/dist/main.js`，不是 Harness 的子命令。运行依赖和编译结果已带入，无需为了启动再次 build。

### 8.1 先处理域名与 OIDC

包内 `oidc/service.mjs` 写死了原部署的以下值：

- issuer：`https://packs.meizu.life/oidc`；
- client ID：`packs-center-web`；
- 允许的 callback：`https://packs.meizu.life/api/auth/callback`；
- TLS key/cert：`/root/.acme.sh/packs.meizu.life_ecc/` 下对应文件；
- 本地监听：`127.0.0.1:18450`。

新域名部署必须同步改这些值、中心环境配置与反向代理，或接入已经配置好的外部 OIDC 提供方。仅修改 `PACK_CENTER_PUBLIC_ORIGIN` 不足以完成迁移。改动的是目标部署副本，需留存差异；原压缩包和 SHA 保持不变。

OIDC 需要 `OIDC_USERS_DIR` 与 `OIDC_RSA_KEY_FILE`。后者实际保存持久化 RSA JWK JSON，不是随意生成的随机 seed；首次缺失时程序生成并保存，应保留到后续重启。账号文件为 `<用户名>.cred`：第一行是 `sha512(salt + ":" + password)` 的 hex，第二行是 salt；属主私有权限。用户名限定小写字母、数字、连字符，最长 32 字符。先创建可登录的管理员身份，再用该 issuer 的真实 subject 执行中心 bootstrap。

### 8.2 准备数据库、目录与凭据

准备独立 PostgreSQL 数据库；schema 不能为 `public` 或 `pg_*`。预建制品和暂存目录，暂存目录归运行账号所有且权限 0700，并提供容量限制。账号、DB、制品和密钥均应放在代码目录外，例如 `/var/lib/pack-center-clean`。

| 环境项 | 内容 |
| --- | --- |
| `PACK_CENTER_DATABASE_URL` | 目标 PostgreSQL 连接串，通过目标凭据机制配置 |
| `PACK_CENTER_DATABASE_SCHEMA` | 例如 `pack_center` |
| `PACK_CENTER_ID` | 稳定且唯一的中心 ID |
| `PACK_CENTER_PUBLIC_ORIGIN` | 目标 HTTPS origin |
| `PACK_CENTER_LISTEN_HOST` / `PACK_CENTER_LISTEN_PORT` | `127.0.0.1` / `18440` |
| `PACK_CENTER_ARTIFACT_ROOT` / `PACK_CENTER_SCRATCH_ROOT` | 预建的真实绝对目录 |
| `PACK_CENTER_OIDC_ISSUER` / `PACK_CENTER_OIDC_CLIENT_ID` | 与身份服务完全一致 |
| `PACK_CENTER_LOGIN_KEY_FILE` | 恰好 32 个原始随机字节的文件 |
| `PACK_CENTER_TRUSTED_SIGNING_KEYS_FILE` | JSON：key ID → Ed25519 公钥 SPKI PEM |
| `PACK_CENTER_GIT_ALLOWED_HOSTS` | 发布源允许的精确域名，逗号分隔 |
| `PACK_CENTER_SIGNING_KEY_ID` / `PACK_CENTER_SIGNING_KEY_FILE` | 只给 publish-worker 注入；Ed25519 私钥 |
| `PACK_CENTER_BOOTSTRAP_SUBJECT` / `PACK_CENTER_BOOTSTRAP_DISPLAY_NAME` | 只在初始化管理员时注入 |

凭据文件使用真实绝对路径、运行账号所有、0600，不用符号链接。生产环境变量可以放到受保护的 systemd EnvironmentFile；它不会因为文件存在而自动加载到交互式 shell。不要把含签名私钥配置的整份环境同时注入 API 与校验 Worker。

### 8.3 初始化与启动顺序

下列命令假定已由目标凭据机制注入相应环境。先迁移数据库，再启动 OIDC 并验证 discovery，随后 bootstrap 管理员：

```bash
cd /opt/zhijian-clean/pack-center/apps/pack-center
node dist/main.js migrate
# 确认 OIDC 已启动，HTTPS discovery 可访问后：
node dist/main.js bootstrap-admin
```

长期服务分别为四个进程，不要在一个顺序 shell 中串行运行后期待全部启动：

| 单元 | 工作目录 | 启动入口 |
| --- | --- | --- |
| OIDC | 中心代码根 | `node oidc/service.mjs`，使用包内 OIDC 时 |
| API | `apps/pack-center` | `node dist/main.js api` |
| 校验 Worker | `apps/pack-center` | `node dist/main.js validate-worker` |
| 发布 Worker | `apps/pack-center` | `node dist/main.js publish-worker` |

`deploy/*.service` 只是原服务器模板，必须改 Node 绝对路径、代码根和 EnvironmentFile；不要直接复制后启动。配置完成后先用 `systemd-analyze verify`，再按 OIDC → API → 两类 Worker 的顺序启动。中心启动不会自动执行数据库迁移。

HTTPS 反代将 `/oidc/` 转发到本地 OIDC（HTTPS，注意去掉前缀），其余请求转发到 API（HTTP）。公网域名、证书、issuer、client 与 callback 必须相互一致。反代示例见包内根 README，替换其中原域名和证书路径。

验收：中心首页可访问；OIDC discovery 正常；未登录访问 `/api/me` 应拒绝；管理员能登录；一次测试发布经历校验、独立审核、签名发布；宿主用一次性绑定码绑定并固定公钥指纹，然后下载和安装授权领域包。

专家库接入中心时，在其配置中设置目标 `packCenterOrigin` 和独立 `packCenterDir`。机器凭据由新绑定产生，不复制原部署点的 `connection.json`。

## 9. 验收与排错

| 现象 | 检查方向 |
| --- | --- |
| `Cannot find package` | 是否同级解压；插件相对链接是否有效；是否误删随包 node_modules |
| 端口占用 | 是否仍有前台实例；检查 8080 占用再决定停哪个进程 |
| Web 打开但不能使用 | 使用本次启动认证链接；核对 SSH 转发端口；检查模型授权 |
| 凭据权限错误 | 凭据文件 0600、运行账号所有；不要把权限放宽到 0644 |
| 专家路由与预期不符 | 会话/队长、专家覆盖和全局缺省三处分别核对 |
| 报告检查 `unverified` | 服务 PATH 下的 `python3 -I` 是否可导入依赖；浏览器路径、字体是否齐全 |
| 中心启动迁移错误 | 显式执行迁移；确认 schema 与历史迁移摘要一致 |
| 中心登录失败 | 对照 issuer、client ID、callback、TLS 路径与 discovery |
| 签名/绑定失败 | 公钥指纹、key ID、机器凭据是否对应目标中心；不能禁用验签绕过 |

基础验收通过后，使用新会话跑业务。需要独立审核的 MD/HTML/PDF 任务应保持作者与审核者分离，并核对审核证据绑定的是最后一版制品。启动成功、预检通过和真实业务通过是不同验收项。

## 10. 升级与回滚

1. 保存原压缩包、SHA、本文和目标环境差异。凭据/用户状态另行私密备份，不重新塞回清洁代码包。
2. 升级解压到新父目录，保留旧代码；新版本先做配置组合和隔离验证。
3. 切换前等待或正常停止业务任务，记录服务 `ExecStart`、工作区及 DSH_HOME。避免两个实例同时写同一状态目录。
4. 回滚代码时将服务入口、DSH_HOME 和相关路径改回原部署，重新加载 systemd 并启动。若升级改过状态格式，应恢复与旧版本配套的状态备份。
5. 中心数据库先做备份再迁移；回滚代码前检查旧代码是否兼容新 schema，不能认为切回目录就撤销了数据库迁移。

本批归档的已有验证记录见同目录 `VERIFICATION.json`，各文件清单见 `*.manifest.json`。部署文档是后补文件，四个原压缩包的 SHA 未改变。
