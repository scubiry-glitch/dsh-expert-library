# 授权分发与发布治理：实现证据

日期：2026-09-19。隔离工作树：`/root/zhijian/dsh-pack-center-dev.ZGtty5`；分支 `codex/pack-center-ZGtty5`；基线提交 `784a6ac07b96a67c89b8516664172c0973f98079`。未提交、未推送、未部署。本批交付 C07 和 C06 剩余管理 API，不代表整个 Goal、管理网页或客户端已完成。

## 已实现

- 管理员登记部署点、签发/撤销一次性绑定码；宿主兑换独立只读机器凭据。凭据撤销、到期、组织/部署点禁用逐次生效；禁用后再启用不复活旧凭据。
- 已授权发布目录、详情、签名清单、报告、短时下载许可及真实归档 HTTP 流。私有条目在分页前过滤；平台管理员不自动越过私有分发规则；selected 不隐含授权拥有组织。
- 下载许可绑定身份、具体机器 credential、release、签名清单与归档摘要，不放 URL；实际下载重新验证当前授权、下架、许可到期与传递依赖。新下载失败不会删除已下载的本地副本。
- 下架接口及独立分发范围审核：所有范围变更（含收窄）必须申请和独立决定；乐观版本与幂等、不可自审、依赖图再检查；签名/已批准快照/归档不变。
- HTTP 严格区分人类 Cookie 与宿主 Bearer。机器不能审核或管理，Cookie/Bearer 混用拒绝；宿主接口拒绝 Origin/Cookie/Sec-Fetch-*。签名私钥仅供发布 Worker，API 只加载受保护 Ed25519 公钥库存。

说明与接口：[中心 README](apps/pack-center/README.md)、[分发路由](apps/pack-center/README-distribution-http.md)、[目录与下载语义](apps/pack-center/README-catalog.md)、[发布治理](apps/pack-center/README-governance.md)。

## 审阅后补强

1. 历史差异会包含旧文件名、实体、脚本和 baseline ID。当前版本可见但旧版私有/下架时，详情返回 `diff:null` 与明确不可用标记，不泄漏旧差异；这不是“没有变化”。
2. 同 actor/key 跨 release/dependency 操作原先存在行锁→幂等键的环锁风险。治理及所有 submission 写操作统一先取 operation 锁，再取业务行锁；缓存重放之前仍重验权限。真实 PostgreSQL 锁队列和 NOWAIT 探测验证了治理与发布重试之间也不保留反向锁序。
3. 无权访问的部署点与不存在的 ID 统一 404，避免管理接口的存在性侧信道；真正认证失效仍返回认证错误。
4. 下载异常流、事务失败和客户端断连均释放流/文件描述符；存储先校验字节再用同一 FD 惰性发送，无公开存储 URL。异常消息不写审计，响应失败不暴露堆栈或凭据。

## 实际验证记录

插件构建与 typecheck、中心 build/typecheck 均退出 0。最终全量 **1042/1042 通过**，零失败/取消/跳过，不累加中间重跑：

| 验证 | 结果 | 日志 |
|---|---|---|
| 插件完整回归 | 786/786；81598.858957 ms；退出 0 | `artifacts/pack-center/p2-final/plugin.tap` |
| 协议与安全归档 | 85/85；4848.457967 ms；退出 0 | `artifacts/pack-center/p2-final/shared.tap` |
| 中心全部组件/API | 171/171；322645.371215 ms；退出 0 | `artifacts/pack-center/p2-final/center.tap` |

中心 171 项（TAP 顶层 158）细分：身份 10、目录 16、完整链路 1、数据库 14、部署身份 16、分发 HTTP 8、Git 17、跨模块锁序 3、发布 14、发布治理 15、运行配置 5、旧 HTTP 7、存储 16、提交事务 9、校验 Worker 20。

| 文件 | SHA-256 |
|---|---|
| `plugin.tap` | `464c7440ac8eb9e7a80ffafaac652d6ef7f29275aa6755d4b385beb242aafaf7` |
| `shared.tap` | `ddc285c9e59eba7e82d02a53cddc854bad8eb3155cb3680339890a675d080828` |
| `center.tap` | `39164563273a99ad627dab422eab63b301858fa077765aa9944bafcec3bd28a5` |
| `source-fingerprint.json` | `c000b2f2fdcdea76afb82f251e34aade1192293626fbeb98e0cf3462ce5d315d` |

上述文件均位于 `artifacts/pack-center/p2-final/`。中间诊断发现旧 HTTP 混用凭据断言需由 401 改为严格 400，以及权限下降后本人发布重试会得到更严格的 `SELF_REVIEW_DENIED`；已修正测试预期。最后完整回归确实包含这两项修正且全部通过，不将中间失败计为通过。

```bash
# 隔离开发树根目录；使用现有依赖，不在生产插件目录构建。
pnpm typecheck
pnpm build
node --test 'test/**/*.test.mjs'
node --test 'packages/pack-contract/test/*.test.mjs' 'packages/pack-artifact/test/*.test.mjs'
cd apps/pack-center
npm run build
npm run typecheck
node --test 'test/*.test.mjs'
```

本轮使用 Node TAP reporter 写入 `artifacts/pack-center/p2-final/`；目录在开始测试前创建。上述测试命令实际附加 `--test-reporter=tap --test-reporter-destination=<绝对报告路径>`，另用 dot reporter 显示进度，没有重复计数构建或中间重跑。

环境：Node `v22.22.0`、Git `2.43.7`、真实 PostgreSQL `17.11`。测试镜像固定为 `postgres@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995`；每组数据库使用唯一标签的 loopback 临时容器和独立 schema，只有其自身容器及匿名测试卷会被删除，不使用 Docker prune。

## 贯通证据与边界

`apps/pack-center/test/center-flow.test.mjs` 现在贯通：真实 OIDC/HTTP 邀请身份 → Git 提交 → smart HTTPS Git Worker 固定快照 → 独立审核 → 分支移动 → 发布原批准签名/归档 → A/B 两个机器身份绑定 → A 通过 HTTP 下载原字节、B 不可见 → 下架后 A 旧许可的新下载被拒。

测试对下载归档做签名/摘要对照和实际安全解包；发布 Worker 不再次请求 Git；重复任务不改签名、published_at 或发布审计。最终 TAP 的脱敏 JSON diagnostic 保存 commit、releaseId 与摘要，不保存凭据。

最终贯通运行：批准 commit `e02bd362ce2c8933cca916dc87d684cf3b292ba6`，移动后 commit `998f96189db331f165092375e7929b049f109c0a`，releaseId `14f2ec3a-68d6-416c-b988-cd51697134c3`；实际下载归档 SHA-256 `c4b3e156d108df3a4ce56aed9937523640920bff2649a6ca1746dcb60986cd1f`，内容树 `46b911cffc02b1e4288d283c33b3ac63db080c1a030dbcced24afc8b9136f596`，报告 `211e5a349fd683cc3719398516aca184ff746b829da8520643fc5933b36380af`。

其他分发测试为真实 OIDC/PG/CAS/签名的组件/API 测试；部分直接建立固定审核快照以隔离授权路径，不能冒充 Git Worker 流程。完整 Git→发布→机器 HTTP 链由上述贯通用例单独证明。**两个机器身份不是两套运行中的 DSH 实例，下载成功也不是客户端安装/启用完成。**

## 源码与生产隔离

最终中心 44 个可执行/测试/迁移/依赖配置输入的集合摘要：`9ac40636e4d731f793e8a14a6b657a38dfd246498a63b0d6d061d83fc7142f50`。完整逐文件清单在 `source-fingerprint.json`；根目录运行 `node scripts/pack-center-fingerprint.mjs` 可复核。文档与生成报告不在该输入集合中。

- 新增迁移 `004_deployments.sql`、`005_governance.sql`、`006_download_grants.sql`；旧迁移不改写。`001_core.sql` SHA-256 仍为 `feb6c2e63ddbc640b3f80ed067ea56ee9e63ae9cd57961723b629155469f2a52`。
- 本轮未增加依赖；app lockfile SHA-256 仍为 `47d6c35bbc4ffe9e89cda405c0491c076bfe9100eb5944ce552a95c223d8c758`。
- 原生产插件目录 `/root/zhijian/dsh-expert-library` 的 package、lockfile、宿主入口、客户端入口、依赖布局摘要均与 F01 相同；其中只维护三份规划文档。未修改 DSH 核心、生产服务、正式域名或生产凭据；没有服务重启和代码推送。
- 最终数据库容器及其一次性匿名卷已按各自 ID/唯一标签清理；按测试标签只读检查无遗留。报告中的私钥头、数据库凭据 URL、完整机器 token/绑定码模式抽查无匹配；不将该抽查宣称为通用秘密检测。两工作树 `git diff --check` 通过。

## 下一步与未完成项

1. U01–U03：独立中心开发者提交页、审核页及组织/发布/部署管理页，接当前真实 API；先贯通退回→修订→独立批准的浏览器流程。
2. L04–L07/U04：插件宿主中心客户端、私密凭据保存、远端下载接本地 `pack-store`、更新检查和四页签；浏览器不持机器凭据。传输使用 Node http/https，信任公钥须独立确认。
3. 实际 provider 初始化、长任务惰性资源生命周期、两套独立 DSH 的运行/断网回退与完整 A01–A24 验收仍未完成。
4. S3/镜像部署、生产硬配额与限流、最小权限角色、数据库和制品备份恢复、部署前检查与第二实例复建演练仍必须交付；历史 download_grants/CAS 安全保留与 GC 尚未实现。

Goal 不标记 complete，不将历史 blocked 标志、接口或组件通过数替代总体验收。
