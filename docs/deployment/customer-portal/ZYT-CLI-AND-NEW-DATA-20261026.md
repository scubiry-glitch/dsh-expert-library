# 智见政研通 CLI 升级与新增数据能力部署说明

- 记录日期：2026-10-26
- 适用实例：`zhijian-dsh-demo-c`（智见客户测试账号 C）
- 源码分支：[`zhijian-cli-public/yanjiuyuan.query.data`](https://github.com/scubiry-glitch/zhijian-cli-public/tree/yanjiuyuan.query.data)
- 部署提交：`d0a47b9ec6be037e79f0bcd905a8242d57a8f12b`
CLI 声明版本：`ZYT_AGENT_VERSION=2026.08.12-2`

## 1. 本次变更范围与结论

这次变更分为两层。第一层把客户实例使用的 Python 版 `zyt` 更新到上述提交，并修复系统入口；同时重建 root 终端使用的 TypeScript 版 `zyt`。第二层在 `@zhijian/dsh-expert-library` 的政研通 provider 和数据集目录登记 9 项新增只读数据能力，再把编译后的两个模块部署到客户运行时。客户 C 的 provider 路由已设为优先 CLI，服务已重启。

本次验证证明：CLI 入口、HTTP 数据接口、9 项新增命令和应用运行时的能力登记均可用。部分接口返回 HTTP 200 但样例期数据为空，见第 5 节；“解读”“专家匹配”因远程专家服务地址未配置，尚不可用。应用内完整自然语言会话对每个新能力的调用、专家计划权限和数据快照未逐项验收，不能把能力登记等同于这些链路已完成。

## 2. 部署位置与调用路径

| 项目 | 当前值 |
|---|---|
| Python CLI 源码副本 | `/opt/zhijian/customer-zyt-cli/` |
| 客户实例 CLI 入口 | `/opt/zhijian/customer-zyt-cli/zyt` |
| 系统入口 | `/usr/local/bin/zyt`，转发到上述 `/opt` 入口 |
| root 终端裸 `zyt` | `/root/.nvm/versions/node/v22.23.2/bin/zyt`，指向源码仓库 `packages/ts-cli/dist/index.js` |
| 客户实例 Linux 身份 | `zhijian-dsh-demo-c`；工作目录 `/var/lib/zhijian/customer-dsh-zhijian-demo-c/workspace` |
| 服务 | `zhijian-dsh-demo-c`，监听 `127.0.0.1:3193` |
| 服务 CLI 绑定 | `/etc/systemd/system/zhijian-dsh-demo-c.service.d/20-provider-grants.conf` 中的 `ZYT_CLI` |
| provider 路由偏好 | `/var/lib/zhijian/customer-dsh-zhijian-demo-c/settings.yaml` 中 `expert-library.providers.zyt.preferCli: true` |
| 运行时包 | `/opt/zhijian/customer-dsh-runtime/node_modules/@zhijian/dsh-expert-library/` 与 `/opt/zhijian/customer-dsh-runtime-c-mentions/node_modules/@zhijian/dsh-expert-library/` |

客户链路为“智见应用 → C 实例的专家库 provider → `ZYT_CLI` → 政研通开放 API”。`preferCli: true` 影响已登记能力的 provider 选择；HTTP 直连接口仍可独立调用。程序副本不带 API Key，客户凭据由该实例私有配置管理，不应复制进 `/opt`、仓库或本文档。

## 3. 升级过程

以下按本次实际发布顺序整理，路径和版本可用于复核；执行新的发布前仍应先确认源码、账号和目标实例。

1. **核对源码。** 本机仓库为 `/root/.openclaw/workspace/98wiki/projects/政研通zytCLI/src/未命名`，当前分支 `yanjiuyuan.query.data`，本地 `HEAD` 与远端该分支均为 `d0a47b9ec6be037e79f0bcd905a8242d57a8f12b`。上一个提交 `94bd266` 增加研究院城市月报；`d0a47b9` 修正 Python CLI 中 `sys` 导入遮蔽问题。部署前确认 `git status` 无未提交改动，并记录 `git rev-parse HEAD`。
2. **备份旧入口与部署。** 本次备份目录为 `/opt/zhijian/.backup-customer-zyt-cli-20261026T125939Z/`，包含旧的客户 CLI 入口与旧 `/usr/local/bin/zyt`。客户实例设置另备份为 `/var/lib/zhijian/customer-dsh-zhijian-demo-c/settings.yaml.backup-zyt-d0a47b9-20261026`。
3. **更新 Python CLI。** 将该提交的 `python/zyt/`、`ZYT_AGENT_VERSION` 复制到 `/opt/zhijian/customer-zyt-cli/`，在部署根目录写入完整哈希 `SOURCE_COMMIT`。部署入口 `zyt` 通过 `PYTHONPATH=/opt/zhijian/customer-zyt-cli/python` 执行 `/usr/bin/python3 -m zyt "$@"`。本次比对了源码与部署副本的 18 个受控文件，SHA-256 一致。
4. **修复系统入口。** `/usr/local/bin/zyt` 改为可执行的 shell 入口，直接 `exec /opt/zhijian/customer-zyt-cli/zyt "$@"`。它与 root 的 NVM 全局入口是两条不同路径，排查时要使用绝对路径分别验证。
5. **重建 TypeScript CLI。** root 裸 `zyt` 原指向源码仓库 `packages/ts-cli/dist/index.js`，旧 dist 未包含新增命令。本次先备份 dist 到 `/opt/zhijian/.backup-root-zyt-dist-20261026/`，再于 `packages/ts-cli/` 执行 `npm run build`。此步骤只更新该 root 入口使用的构建产物，不改变客户实例的 Python CLI 绑定。
6. **切换客户 provider。** 保持服务环境变量 `ZYT_CLI=/opt/zhijian/customer-zyt-cli/zyt`，把 C 实例设置中的 `expert-library.providers.zyt.preferCli` 置为 `true`，重启 `zhijian-dsh-demo-c`。
7. **登记新增能力。** 在 `/root/zhijian/dsh-expert-library/src/v2/providers/zyt.ts` 增加请求规划、CLI 参数转换、operation 与 capability；在 `src/host/dataset-registry.ts` 增加对应 9 项数据集。`ym` 格式限制为 `YYYYMM`，土地交易明细只收 `city`。编译后仅将 `lib/v2/providers/zyt.js`、`lib/host/dataset-registry.js` 发布到上表所列两个运行时包，避免带入同一源码仓库中其他未发布修改。旧模块备份在 `/opt/zhijian/.backup-zyt-provider-20261026T132816Z/`，随后重启 C 实例。**这 4 个注册相关源码/测试文件目前仍是未提交的工作区修改；已部署的运行时文件需要后续纳入正式版本，避免下次整包安装覆盖。**

## 4. 新增数据能力及参数

以下 9 项均已进入 provider manifest 和数据集目录，数据集名与 capability ID 相同；`city` 为城市名称，`ym` 为 6 位年月。对应 HTTP 路径均为只读 GET，CLI 调用须加 `--json`。

| 能力 / 数据集 ID 前缀 `realestate.` | CLI 命令 | HTTP 路径后缀 | 必填参数 |
|---|---|---|---|
| `creis.land-market` | `中指 土地统计` | `/creis/land-market` | `city, ym` |
| `creis.land-transaction` | `中指 土地明细` | `/creis/land-transaction` | `city` |
| `creis.new-home-market` | `中指 新房统计` | `/creis/new-home-market` | `city, ym` |
| `creis.new-home-project` | `中指 新房项目` | `/creis/new-home-project` | `city, ym` |
| `creis.resale-market` | `中指 二手统计` | `/creis/resale-market` | `city, ym` |
| `city-report2026.city` | `城市专报 城市级` | `/city-report2026/city` | `city, ym` |
| `city-report2026.area` | `城市专报 面积` | `/city-report2026/area` | `city, ym` |
| `city-report2026.district` | `城市专报 城区` | `/city-report2026/district` | `city, ym`；`district` 可选 |
| `city-report2026.total-price` | `城市专报 总价` | `/city-report2026/total-price` | `city, ym` |

表中的 HTTP 后缀均接在 `https://dss.ke.com/openapi/v1` 之后。示例：`/opt/zhijian/customer-zyt-cli/zyt 中指 土地统计 --city 北京 --ym 202609 --json`；应用内对应 `realestate.creis.land-market`，输入为 `{"city":"北京","ym":"202609"}`。土地明细的源接口没有年月参数，不应额外传 `ym`。

## 5. 验证结果（2026-10-26）

- 本地源码与远端分支哈希一致；部署目录 `SOURCE_COMMIT` 与版本文件一致；`/usr/local/bin/zyt`、客户专用 Python 入口和 root 的 NVM TypeScript 入口分别检查。客户 Linux 身份下 `身份 --json` 成功，`指标目录 --json` 返回 48 项。
- `https://dss.ke.com/openapi/v1/me` 与 `/indicators/catalog`：HTTP 200，客户 CLI 退出码 0。9 个新增数据路径：HTTP 均为 200，客户 CLI 均为退出码 0；root TypeScript 入口重建后新增命令也可执行。
- 北京 `ym=202609` 样本：中指土地统计 6 行、土地明细 0 行、新房统计 150 行、新房项目 540 行、二手统计 0 行；城市专报 4 项均 0 行。上海 `202608`、北京 `202601/202608` 的城市专报补充样本亦为空。**成功响应表示接口和授权通路可达，不表示每个城市月份已有数据。**
- 中指新房项目样本约耗时 31.8 秒，曾被 25 秒的临时验收超时截断；延长验收等待至 100 秒后正常完成。调用方应按大结果集留足超时和分页/输出处理预算，不能把临时超时判断为上游接口失败。
- `@zhijian/dsh-expert-library` TypeScript 编译通过；`v2-providers` 与 `dataset-gate` 两组测试合计 39/39 通过，`git diff --check` 通过。两个已安装运行时包均可加载 9 项新增 capability 与 9 项数据集，C 实例的绑定选择为 CLI。服务 `zhijian-dsh-demo-c` 为 active，插件 health 为 200，公网 `/app` 为 200。
- 直接在客户 Linux 身份下验证 CLI 时，先切换到其可访问的工作目录；若从 root 私有目录直接 `runuser`，CLI 读取项目配置会遇到 `PermissionError`，这不代表客户实例中的入口失效。

## 6. 尚未完成的环节

1. `解读`、`专家匹配` 为专家编排能力，不属于上述 9 个数据 GET 接口。C 实例当前专家模式为 remote，但 `expertsRemoteUrl` 为空，直接调用返回 `EXPERTS_REMOTE_UNCONFIGURED`；本次未部署内部专家库，也未宣称两项能力可用。
2. provider manifest 与数据集已注册，应用中的专家计划若设置了 `allowedCapabilities`，还需按具体计划开放这些能力，并做自然语言请求 → provider → 数据快照 → 答复的端到端验收。当前验证只覆盖到模块加载、绑定和接口实调。
3. `@zhijian/dsh-expert-library` 的本次登记修改尚未形成独立提交。后续发版应把 `src/v2/providers/zyt.ts`、`src/host/dataset-registry.ts` 及对应测试纳入正式版本，构建并按发布流程替换运行时；避免直接用旧包整包覆盖本次编译模块。

## 7. 回滚与复核

若仅新能力登记异常，先停止 C 实例，从 `/opt/zhijian/.backup-zyt-provider-20261026T132816Z/` 恢复 `lib/v2/providers/zyt.js` 与 `lib/host/dataset-registry.js` 到两个已安装运行时包，再启动服务。该备份目录按模块保存旧文件；恢复前核对相对目录及文件哈希。若客户 Python CLI 异常，从 `/opt/zhijian/.backup-customer-zyt-cli-20261026T125939Z/` 恢复旧入口与旧程序副本，并将设置文件从 `.backup-zyt-d0a47b9-20261026` 恢复；root TypeScript CLI 可用 `/opt/zhijian/.backup-root-zyt-dist-20261026/` 的 dist 恢复。每次回滚后均需重启 `zhijian-dsh-demo-c`，复查 `systemctl is-active`、绝对路径的 `zyt 身份 --json` 和所需能力的实际调用。

所有回滚和重新部署均沿用客户实例原有私有凭据；不要把 API Key、服务 token、配置文件明文或内部专家库放入共享文档、Git 仓库或群文件。
