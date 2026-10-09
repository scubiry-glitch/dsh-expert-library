# 独立中心后端：实现与复核证据

日期：2026-09-19。工作树：`/root/zhijian/dsh-pack-center-dev.ZGtty5`；分支 `codex/pack-center-ZGtty5`；基线 `784a6ac07b96a67c89b8516664172c0973f98079`。所有更改尚未提交、未推送、未部署。本文只记录后端/API 和相关组件，不将其视为 Goal 或浏览器/双部署验收完成。

## 本批已接通

- 独立 OIDC code/PKCE/state/nonce/RS256 校验，邀请制入库、显式管理员 bootstrap，组织成员/审核范围/即时撤权；会话/CSRF 只存摘要，短期登录材料加密。
- HTTP Cookie/Origin/CSRF 边界；组织/邀请管理、草稿编辑、异步校验、送审、审核、撤回、独立修订、授权发布重试。审核绑定 stateVersion 和树摘要；机器形式的匿名请求不能借用人类路由。
- 公网 HTTPS Git 白名单、DNS pin、拒绝重定向和 dumb-HTTP 绕行，原始 blob 导出、固定 commit；不运行 hooks、filters、子模块或仓库脚本。共享校验、归档/内容摘要、内容预览与文件/实体/权限差异。
- 私有本地 CAS，真实 PostgreSQL 的持久任务/租约、过期写入隔离和最终崩溃协调。校验失败保留诊断，不变成可发布包。
- 独立 Ed25519 发布 Worker；只用已批准归档和报告，重新验证固定依赖及当前分发权限，签名清单先冻结、再持久化、再原子发布；重试不换来源、版本或签名。
- API/校验/发布进程显式入口、启动只读检查迁移集合/摘要、凭据文件校验，以及两类 Worker 共同使用显式私有 scratchRoot。

审查中修复并补回归：迁移不完整仍启动、嵌套 null 输入导致 500、归档写读条目上限不一致、发布解包绕过配置临时卷、旧实体预览不完整导致差异崩溃，以及中心/组织/包/key 标识长度与签名协议不一致。尚未证明物理磁盘配额，仅提供一致的配置入口和组件上限。

## 当前复核

| 验证 | 结果 | 日志 |
|---|---|---|
| 隔离插件完整构建 `pnpm build` | 退出 0；现有 tsdown 弃用提示，不影响构建 | 本次工具执行记录 |
| 插件完整测试 | 786/786，零失败/跳过，74287.933669 ms | `artifacts/pack-center/p1-final/plugin.tap` |
| 协议与安全归档 | 85/85，零失败/跳过，4302.051093 ms | `artifacts/pack-center/p1-final/shared.tap` |
| 中心最终冻结源码回归 | build/typecheck 退出 0；112/112，零失败/跳过，247493.311942 ms | `artifacts/pack-center/p1-final/center-final.tap` |

本次不重复计数合计 **983 项通过**：786 插件 + 85 共享协议/归档 + 112 中心。中心细分：身份 10、HTTP 7、数据库 14、Git 17、校验 Worker 20、存储 16、提交事务 9、发布 14、运行配置 4、完整 API 链路 1（含嵌套子测试，TAP 顶层 99）。最后一次 app 命令、插件构建/回归命令均退出 0；两个工作树的 `git diff --check` 退出 0。

| 最终日志 | SHA-256 |
|---|---|
| `plugin.tap` | `910766544cb39350f3e8eb732896906062e8e20398f1c0cf3a7dc65a4d3d3af9` |
| `shared.tap` | `25be5b2228d877d904918745482ee76c21a0d7386a596d7a7b9e6ca2194fee78` |
| `center-final.tap` | `ea4290baf1afa3898a72062516fa6aee7a93a55f4cb12844fe9ca2f2dcd6f872` |

运行环境：Node `v22.22.0`、Git `2.43.7`、PostgreSQL `17.11`。PostgreSQL 测试镜像固定为 `postgres@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995`。测试 Git/OIDC 为真实协议 loopback fixture；Git 使用仅测试基础设施的 transport seam 把已检查公网主机映射到 TLS fixture，生产入口没有允许私网的请求参数。不是公网部署或浏览器自动化证据。

最短复核命令（隔离开发树根目录；需要已安装依赖和 Docker）：

```bash
pnpm build
node --test 'test/**/*.test.mjs'
node --test 'packages/pack-contract/test/*.test.mjs' 'packages/pack-artifact/test/*.test.mjs'
cd apps/pack-center
npm test
npm run typecheck
```

最终日志使用 Node 的 TAP reporter 写出；报告目录须先创建。曾因 reporter 目录未预先存在而在测试初始化阶段退出 7；该次未作为通过证据。已核对唯一标签并删除该次遗留测试容器 `d36dab421a21ca1c27f502a2ee690b898810963e21134f63384ab0738520e7f4` 及其一次性匿名卷；无用户业务数据。源码修正期间的中间回归仅供诊断，最终以冻结源码的 `center-final.tap` 为准。

## 固定内容集成证明

`test/center-flow.test.mjs` 通过真实 HTTP 创建组织/邀请和提交；开发者登录、校验、送审后移动 Git 分支；另一位在独立组织且获审核范围授权的审核员批准；发布 Worker 只读原 CAS 并签名。测试核对归档解包仍为 `1.0.0`、Git 请求数发布期间不增加、重复投递不增加发布审计、不改变签名或 published_at；同时拒绝作者自审和跨组织私有读取。

固定样例摘要（commit 与 releaseId 每轮不同，由最终 TAP 的 JSON diagnostic 记录）：

最终运行：批准 commit `0816195776b2f034eed73cac5b96ef4322e403cc`；移动后 commit `8497ada3cb91f6ff62b502b0e5c8e45dcde46a62`；发布 ID `0dce18e3-3bf8-47af-a9f5-56078dc0f452`。两次发布保留同一签名与 published_at。

| 项 | SHA-256 |
|---|---|
| 归档 | `c4b3e156d108df3a4ce56aed9937523640920bff2649a6ca1746dcb60986cd1f` |
| 内容树 | `46b911cffc02b1e4288d283c33b3ac63db080c1a030dbcced24afc8b9136f596` |
| 校验报告 | `211e5a349fd683cc3719398516aca184ff746b829da8520643fc5933b36380af` |

## 源码与隔离边界

中心 31 个可执行/测试/迁移/依赖配置输入的集合 SHA-256：`2128d83eec257c227ec9c0597d83bf7d0be1106372b52aa9eecfd814250c95bb`。运行 `node scripts/pack-center-fingerprint.mjs` 可复核：路径排序，对每个文件计算 SHA-256，再对紧凑 JSON `[{path,sha256},...]` 计算集合摘要；报告与文档不在此集合内。共享协议/插件另由上一批源码记录及本轮完整回归覆盖。

- 原 `001_core.sql` 未改；SHA-256 `feb6c2e63ddbc640b3f80ed067ea56ee9e63ae9cd57961723b629155469f2a52`。
- 新增 `002_identity.sql`（浏览器登录绑定）及 `003_submission_requirements.sql`（冻结兼容/依赖要求），不覆写旧迁移。
- app lockfile SHA-256 `47d6c35bbc4ffe9e89cda405c0491c076bfe9100eb5944ce552a95c223d8c758`；依赖独立，不替换根目录 node_modules 链接。
- 原生产插件工作树 `/root/zhijian/dsh-expert-library` 仍仅三份规划文档未跟踪；package/lock、宿主入口、客户端入口及依赖布局摘要均与 F01 相同。未修改 DSH 核心，未重启服务，未操作生产 DNS、凭据或部署。
- 每个数据库测试只删除其创建并核对 ID/标签的临时容器与匿名卷；不做批量 prune，不清理其他 Agent 容器。
- 最终中心测试完成后按 `dsh.pack-center.test` 标签只读检查，未发现遗留测试容器。测试日志的私钥标记、数据库 URL 和常见密钥模式检查均无匹配；该检查是防意外回显抽查，不宣称通用秘密检测。

## 保留的未完成项

1. C07：部署点登记/一次性绑定、机器凭据撤销、统一授权目录/清单/下载接口，下载时重验授权。
2. C06 剩余管理接口：下架、扩大分发范围的独立审核与审计（数据库状态约束已有，不等于接口交付）。
3. U01–U03 管理页面和 Harness 四页签；当前 OIDC callback 返回 JSON，无完成态管理 UI。
4. 插件远程目录与安装接线、provider 初始化、离线提示、A17 跨切换任务/惰性资源快照。
5. S3 兼容存储、部署硬配额、安全进程/数据库权限分离、备份恢复演练和两个隔离 DSH 实例完整验收。

因此 A01–A24 均未宣告整条通过，Goal 未标为完成。无需生产域名或真实业务凭据即可继续上述隔离开发；正式部署/试点仍需独立授权和配置。
