# L04-A 宿主中心客户端：实现与验证

日期：2026-09-20（Asia/Singapore）。隔离树 `/root/zhijian/dsh-pack-center-dev.ZGtty5`，分支 `codex/pack-center-ZGtty5`，基线 `784a6ac07b96a67c89b8516664172c0973f98079`。**本批交付内部宿主 SDK，不是整个 L04 或 Goal 完成。尚未注册插件入口、公开本地 RPC、实现异步进度或四页签，也没有部署到生产。**

## 实现与边界

- `src/host/pack-center-connection.ts`：单一私密连接文档，0700/0600、当前 UID/单硬链接/规范目录校验、FD 路径锚定、跨进程 flock、revision CAS 与 fsync+rename；严格 JSON 损坏不覆盖。解绑清 token，保留身份及离线签名 pins。`publicView` 不含 token、PEM 或本地路径。
- `src/host/pack-center-transport.ts`：明确配置的 HTTPS origin、固定宿主 API、短期 grant 请求头；无 Cookie/Origin/Sec-Fetch、无重定向、无自动重试或环境代理自动发现。TLS 始终验证；有界 JSON/归档、总期限、取消、长度和 SHA-256 校验、独有暂存文件清理，错误不泄露原始消息。
- `src/host/pack-center-client.ts`：绑定前独立确认公钥；交换后检查中心身份、指纹、scope 与有效期，原子替换凭据。授权目录/详情与真实下载接本地 pack-store，安装仅缓存，明确启用且要求真实宿主 preflight。
- `src/host/pack-store.ts` 新增 `replayInstall`：根据永久 release digest 重构 cache-only install 请求，在状态锁内检查操作类型、原 generation 和 request fingerprint。已提交操作可在撤权、解绑和离线后返回原回执及当前 state，不重新下载、启用或安装；不同请求拒绝。

每个部署固定独占 `<deploymentRoot>/private` 与 `/inventory`，禁止交叉配对和初绑接管非空库存；一个目录对永久对应一个 centerId。换中心使用新目录，同中心迁域名必须重新显式绑定，旧 token 不发送到新 origin。公钥轮换可独立确认后追加，历史 pins 保留，同 keyId 不能重映射。

下载不持有连接/库存锁。下载后的 `withRevision` 按 connection→inventory 锁序持有连接锁直至本地阶段结束，使解绑/换绑与缓存提交线性化。取得连接锁后最后一次取消检查就是不可取消本地阶段的起点；不承诺提交前任意时刻都能取消。绑定交换后的失败统一标为不确定，不自动复用一次性码；管理员须核对本地 revision 与中心凭据再领新码。

完整使用约束和下一层要求见 [PACK-CENTER-HOST-CLIENT.md](PACK-CENTER-HOST-CLIENT.md)。其中 `localState` / mutation 回执是含路径的宿主内部对象，不能直接序列化给浏览器。

## 定向与真实中心验证

新增私密存储 19 项、真实 HTTP(S) 传输 23 项、宿主客户端对抗 HTTP fixture 22 项，以及真实中心到宿主客户端集成 1 项。每类只计算最终全量中的覆盖，不累加中间重跑。

重点验证了错误/私钥 pin 在联网前拒绝、远端错误 pin 不落盘、并发绑定只有一个 CAS 赢家、同 keyId 重映射拒绝、历史 pin 留存、域名变化不外送旧凭据、一次性码无自动重试、非法归档 URL/签名/有效期/大小/兼容性拒绝、下载损坏保留原 active、传输中解绑阻止旧 revision 提交、取消清理、离线精确回放及错误脱敏。

`apps/pack-center/test/host-client-flow.test.mjs` 的真实链路：

1. 真 PostgreSQL、OIDC PKCE/签名身份、smart HTTPS Git、校验 Worker 与 Ed25519 发布 Worker；从 human HTTP 提交公开 Git 示例、独立审核并发布。
2. 管理员创建两部署点；错误中心/pin 的一次性交换不落盘，管理员在真实中心撤销未确认凭据，再签发新码；用事先独立获得的公钥正确绑定两个私密目录，重建 client 后身份仍在。
3. 私有目录仅授权部署可见；另一部署读详情及申请安装返回 404。授权部署获得真实 grant、通过中心 HTTP 流式下载并验证归档，安装 generation 1、active 为空。
4. 未提供宿主 preflight 时 enable 拒绝；提供实际 V1 示例内容断言后才 enable，generation 2。这个回调只是示例内容验证，**不是 DSH builtin/workspace merge**。
5. 中心管理员撤销机器凭据，目录与新安装返回 401，不发生第二次 artifact 传输。停掉中心、重建 client、解绑后，已有快照仍验证；同 install 精确回放且 generation/active 不回退，错 release/generation 拒绝；本地启停不联网，篡改库存返回 `CONTENT_DIGEST_MISMATCH`。

真实归档 SHA-256：`c4b3e156d108df3a4ce56aed9937523640920bff2649a6ca1746dcb60986cd1f`；内容树：`46b911cffc02b1e4288d283c33b3ac63db080c1a030dbcced24afc8b9136f596`。最终 center TAP 包含 releaseId、摘要及布尔验证项，没有机器 token。

定向集成前两次失败均为新测试 fixture/断言问题：组织 slug 与示例 `demo.review` namespace 不符、请求总数包含另一部署被拒绝的 grant。已修正组织 namespace，并改为授权安装前后 grant/artifact 请求分别增加 1；没有放宽签名、权限、撤销或默认不启用判据。TypeScript 首次检查指出新增 client 的 `never` 箭头函数无法完成所需控制流收窄，已改为明确函数声明。最终构建与测试以冻结版本为准。

## 冻结回归

根插件 `pnpm build` 和独立中心 `npm run build` 均退出 0；没有安装依赖。最终全量 **1111/1111 通过**（插件 850 + 协议/归档 85 + 中心 176），0 失败/取消/跳过。日志位于 `artifacts/pack-center/p4-host-final/`。

| 范围 | 结果 | 日志 |
|---|---|---|
| 插件完整回归 | 850/850，0 fail/skip/cancel；293414.929445 ms；退出 0 | `plugin.tap` |
| 协议与归档 | 85/85，0 fail/skip/cancel；6408.912911 ms；退出 0 | `shared.tap` |
| 中心组件/API/真实宿主集成 | 176/176（顶层 163），0 fail/skip/cancel；409342.990804 ms；退出 0 | `center.tap` |

本轮没有修改中心网页资产或页面 API，也没有重跑浏览器；不把上一批浏览器 1 项或 14 张截图加入本批数量。上一批 A01/A03 的冻结证据仍在 `PACK-CENTER-P3-WEB-EVIDENCE.md`。

复现命令（隔离树，不在生产目录执行）：

```sh
pnpm build
node --test 'test/**/*.test.mjs'
node --test 'packages/pack-contract/test/*.test.mjs' 'packages/pack-artifact/test/*.test.mjs'
cd apps/pack-center
npm run build
node --test --test-concurrency=2 'test/*.test.mjs'
```

最终测试实际附带 `--test-reporter=dot --test-reporter=tap --test-reporter-destination=stdout --test-reporter-destination=<日志路径>`，生成可复核的完整 TAP。Node `v22.22.0`；真实数据库 fixture 固定 PostgreSQL 17.11 镜像，独占测试容器、随机 loopback 端口与运行期凭据，按精确 ID 清理自身容器和卷，不执行 prune。

## 输入指纹与并行变更

`node scripts/pack-center-host-fingerprint.mjs` 覆盖根插件源码/测试、共享包、领域包示例、中心源码/测试/迁移/网页及依赖/构建配置，共 241 个文件。输入集合 SHA-256：`845d477252739c64c6bf8356ad0c34cf9f118f05badb4758ec525e2746a3a39c`。完整清单为 `source-fingerprint.json`，不是只覆盖中心的旧脚本，也不是所有知识内容的全量指纹。构建产物、文档及报告不计入输入集合。

| 文件 | SHA-256 |
|---|---|
| `plugin.tap` | `1160fa2dc1124639872f493079d03e5f006fcd0144a5fbba684f00e29abd5639` |
| `shared.tap` | `223640120b283cb2b5eb0e1d3424492a2fd1eb07dcbbbc0e29f91a2fbd28d80e` |
| `center.tap` | `b69ac1f1e1b273eca55d8ce90135d915d22e035795771438a4b3cbc21d5e269b` |
| `source-fingerprint.json` | `e76dda2c64d8ddaca6ef635e91a39cae359d98c623542f9ce7b125376caa68dd` |

检测到隔离树 `domain-packs/pipeline-general/scenarios/pipeline-general.json` 的非本任务改动，保留且不归入客户端功能修改；当前文件 SHA-256 为 `08a4408b699b0f145d72b77dd071085ad58f738ed1233c40eab80db8128d3744`，不在上述 241 项集合内。生产树也有领域包及 `src/harness-compat.ts` / `test/harness-compat.test.mjs` 的并行改动，均不回退。本任务仅在生产树同步三份规划/验收文档；生产 package/lock、lib/index.js、lib/client.js、依赖布局的 5 项摘要与既有基线一致，不将此表述为共享生产仓库完全无其他变化。

全量结束后复核 241 项输入摘要，0 不一致；两工作树 `git diff --check` 通过。本轮测试容器与自身匿名卷均由 fixture 清理，最终按 `dsh.pack-center.test` 标签查询无遗留；没有删除其他容器或用户数据。3 份最终 TAP 对私钥头、完整 dpc_bind / dpc_token 和带密码 PostgreSQL URL 的模式抽查为 0 匹配；这不是通用秘密检测承诺。

## 验收状态与下一步

L04-A 为内部 SDK 组件和真实中心链路通过。A07/A08/A09/A16/A18 增加了部分证据，但不替代完整客户端、真实宿主编译、运行任务或两个 DSH 的整条验收；A02、A04–A24 仍待总验收，Goal 未完成。没有重启生产服务、修改 DSH 核心、操作 DNS/正式凭据、提交、推送或发布。

下一步 L04-B：本地管理授权、JSON/CSRF/同源防护、白名单 DTO、持久异步 operation 与查询/重启恢复，接插件入口和实际 runtime preflight。之后 L05–L07/U04 实现四页签、手动更新和更新/回退；实际 provider、长任务惰性资源、两个隔离 DSH、迁移、S3/硬配额、备份恢复与第二实例复建仍未完成。
