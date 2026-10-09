# 受保护本地管理、异步安装和四页签：验证记录

日期：2026-09-20（Asia/Singapore）。隔离树 `/root/zhijian/dsh-pack-center-dev.ZGtty5`，分支 `codex/pack-center-ZGtty5`，基线 `784a6ac07b96a67c89b8516664172c0973f98079`。本批对应 L04-B、L05–L07/U04，不是新增计划阶段；未部署生产、未修改 DSH 核心、未提交或推送。

## 本批交付

- `pack-center-routes.ts`：固定管理前缀、独立 manage 授权、CSRF/Origin/Fetch Metadata、自定义 UI 头、重复头/路径/方法/字段校验、有界 JSON 与安全 DTO。不能借 Harness 页面 cookie 获得权限。
- `pack-center-operations.ts`：持久异步 operationId、不可变请求、真实阶段、跨进程单执行器、崩溃回执恢复、明确中断与显式重试；部分失败不伪报成功，存储异常不覆盖。
- `pack-center-manager.ts`：宿主私密连接/库存与队列的组合、授权目录、详情、SemVer 手动更新、依赖阻断、同 revision 成功快照/stale、换绑丢弃旧远端历史。
- `pack-center-host.ts` 与插件入口：packCenterOrigin/packCenterDir、真实 builtin/Zhijian/workspace-collaboration 三类 base 预检、纯本地 activeSnapshot；改源需重启且保留当前本地源。
- `pack-center-card.tsx`、API helper/CSS 和客户端注册：设置 → 领域包中心的目录/已安装/更新/来源设置，固定目标确认、进度恢复、手动更新/启停/回滚/卸载、只读 legacy 标识和独立信任绑定。
- SDK/库存增强：updateEnable、真实阶段、已安装缓存离线复用、历史回执三摘要严格核对，卸载后查询回执不重新安装；签名元数据防符号链接/多硬链接/FIFO/超限与读取中替换。

配置、路由表、请求字段、队列恢复与明确限制见 [PACK-CENTER-HOST-CLIENT.md](PACK-CENTER-HOST-CLIENT.md)。浏览器不接收机器 token、完整公钥或私密路径；输入的管理员令牌仅内存使用，绑定码提交后清空。

## 真实链路与专项

真实 Chromium 测试使用已编译的宿主 manager/routes 和已编译 React 卡片，容器为测试壳，不冒充实际 DSH。底层为真实 PostgreSQL、OIDC/PKCE、smart HTTPS Git、独立开发者/审核员 HTTP、校验 Worker、Ed25519 发布 Worker、真实 grant/归档传输。

宿主流程：强制令牌 → 独立公钥确认/一次绑定 → 授权目录及签名详情 → 202 安装 → 真实队列/本地 generation → 仅缓存 → 刷新重新鉴权且不重复安装 → 显式启用 → 手动更新 → 中心真实停用部署后显示旧快照而非“已是最新” → 解绑仍保留已启用本地版本。附加验证 320px 无横向溢出、发布说明只按文本显示、切换令牌清旧权限内容、两个浏览器存储为空、敏感值不进 URL、无 pageerror。

新专项覆盖跨进程 flock、SIGKILL/提交边界恢复、部分安装失败、SemVer 1.10 > 1.9、预发布排除、兼容/依赖阻断、缓存候选不重复下载、更新不改 generation、损坏本地内容拒绝启用、真实工作区冲突和来源改动保持旧快照。并发测试使用独立 SDK 换绑/解绑，避免只验证 manager 自己清缓存的路径。

真实反代安全回归曾复现：loopback socket + loopback Host + 仅 X-Forwarded-Proto 头错误获得免令牌。现新 center 路由将任意转发头（含空值）视为非本机直连，重复头拒绝，正确令牌仍允许；既有 legacy auth.ts 未修改。

## 最终验证结果

根插件 `pnpm build`（host/client TypeScript 和客户端 bundle）两次退出 0；最后反代修正后再次执行 host `tsc -p tsconfig.json` 退出 0。独立中心 `npm run build` 退出 0。未安装依赖。反代修正晚于全库测试，最终相关范围和宿主浏览器已用最后编译版本补跑。

| 范围 | 当前实际结果 | 证据 |
|---|---|---|
| 插件全库（本批初始记录） | 928/932 通过，4 失败，0 skip/cancel，退出 1；310567.71722 ms | `p5-host-ui-final/plugin.tap`；失败已由后续兼容源修正复验 |
| 插件全库（兼容源修正后） | 934/934 通过，0 fail/skip/cancel，退出 0；47682.376507 ms | `p6-generation-fix/plugin-full.tap` |
| 协议/归档 | 85/85，0 fail/skip/cancel，退出 0；14733.598076 ms | `p5-host-ui-final/shared.tap` |
| 两个 compiled 浏览器流程 | 2/2，0 fail/skip/cancel，退出 0；172936.484541 ms | `p5-host-ui-final/browser.tap`；center 14 + host 10 张图 |
| 最后反代修正相关回归 | 162/162，0 fail/skip/cancel，退出 0；155087.811373 ms | `p5-host-ui-final/host-scope.tap` |
| 最后反代修正宿主浏览器补跑 | 1/1，0 fail/skip/cancel，退出 0；80159.384256 ms | `p5-host-ui-final/browser-host-final.tap`；更新 host 10 张图，不重复计数 |
| 中心全库 | 176/176，0 fail/skip/cancel，退出 0；579383.562255 ms | `p5-host-ui-final/center.tap`；首轮不完整日志另存 `center-initial.tap` |

所有日志位于 `artifacts/pack-center/`。中间 source 重跑与旧宿主浏览器重复结果不累加到最终数量。

可复现命令（从隔离树开始；Docker 和 Chromium 为测试前置，日志目录按新 run-id 指定，勿覆盖本批证据）：

```bash
pnpm build
node --test --test-concurrency=2 'test/**/*.test.mjs'
node --test 'packages/pack-contract/test/*.test.mjs' 'packages/pack-artifact/test/*.test.mjs'
node --test --test-concurrency=2 test/host-pack-center-client.test.mjs test/host-pack-center-routes.test.mjs test/host-pack-center-operations.test.mjs test/host-pack-center-manager.test.mjs test/host-pack-center-manager-races.test.mjs test/host-pack-center-host.test.mjs test/client-pack-center-api.test.mjs test/host-pack-store.test.mjs test/host-pack-runtime.test.mjs test/v2-center-runtime.test.mjs test/v2-no-network.test.mjs
cd apps/pack-center
npm run build
node --test --test-concurrency=1 'test/*.test.mjs'
node --test --test-concurrency=1 'test/browser/*.test.mjs'
node --test test/browser/host-ui.test.mjs
```

浏览器可配置 `PACK_CENTER_BROWSER_EXECUTABLE`，截图分别用 `PACK_CENTER_BROWSER_SCREENSHOTS` 和 `PACK_CENTER_HOST_BROWSER_SCREENSHOTS` 指定独立绝对目录。最终测试未设置 `PACK_CENTER_MANAGER_SOURCE=1`，使用编译产物。保存 TAP 时使用 Node 的 `--test-reporter=tap` 与 `--test-reporter-destination`；本批同时输出 dot 便于现场观察。

### 既有并行编辑导致的全库失败

本轮开始前即存在的 `domain-packs/zhijian-realestate/experts/bk-011.json`、`bk-024.json`、`bk-025.json` 增加了两种 pipeline review capability，但嵌入的生成源及 generated/pack.sha256 未同步。生成器差异明确列出这三个文件，导致：加载包与内存投影不一致、从源重新生成不一致、树摘要不一致、build-zhijian-pack --check 失败。相关四个测试/生成脚本未由本轮改写。另有 pipeline-general 三文件的并行改动也保留。

没有重建/覆盖这些用户改动，没有改预期摘要或跳过测试；因此**全库不绿，A23 和整个 Goal 不得标完成**。应另行协调这些专家内容的权威源和生成流程，再重建并重跑全库。

### P6 生成漂移修正

按用户确认保留三位专家的 pipeline review 兼容能力，但不把它们伪装成历史 Profile/roster 声明。新增 `src/v2/zhijian-pipeline-compat.ts` 作为唯一、窄范围、可审计的 V2 兼容源，仅声明 `bk-011`、`bk-024`、`bk-025` 的 `pipeline-general.review` 与 `pipeline.general.review`，证据引用为 `zhijian:compatibility/pipeline-review`。投影器消费该源；生成器只重建三个专家 JSON 和 `generated/pack.sha256`，没有改 raw profile、roster 或 pipeline-general 的三份并行编辑。

`node scripts/build-zhijian-pack.mjs --check` 现为 clean（81 files，tree SHA-256 `c07567d4b2bdf3a114b956e11c65e0088944c8c1ad6e41c5eee32b848333931a`）；兼容投影及迁移/技能相关测试 44/44 通过。全库随后 934/934 通过，故本节初始四项失败不再是当前源码状态；此前的 928/932 TAP 作为问题定位原始证据保留。

### 首轮调试与重跑说明

新增浏览器夹具两处构建问题（CSS 虚拟模块后缀、pnpm transitive 的 react-dom/client 解析）仅修测试 bundler；不安装依赖。CDP 二次读响应正文不可靠，改为断言真实 202、不可变请求、页面状态和持久回执，没有伪造响应。

中心原宿主测试把“已安装缓存 + 新操作键”当作必须重新取授权。按本轮显式本地缓存语义，撤销测试改为请求未缓存的 releaseId，仍要求中心 401、新 grant 被拒、无新归档传输、generation 不变。首轮中心日志另有提前结束且无最终 TAP summary，原因未确认，不计作完成；原日志保留，最终降为单并发重跑。

## 冻结与交付边界

本批指纹脚本新增覆盖 domain-packs，避免只验证代码而漏掉真实预检读取的生成内容。P5 初始版本的 1001 个输入文件组合 SHA-256 为 `52616c55999c7219636f8a6cd3dfaa7516089a5efc7f8e74fea07f3ea1d48651`；P6 兼容声明源加入后见下方 1002 文件指纹。并行编辑不属于本功能修改，但列入被测输入。构建输出、文档和测试证据不属于源码指纹。

以下文件均位于 `artifacts/pack-center/p5-host-ui-final/`：

| 文件 | SHA-256 |
|---|---|
| `plugin.tap` | `62f93955bb2230742d0161b76b3a85721f38ddeba8d209882043091595458e35` |
| `host-scope.tap` | `c5aba5093b21a772e5c2f3b5b8481e7d60facd223f92aeb16f772384bab428c4` |
| `shared.tap` | `f8bba963f689760ca793d7a2d0b3dbac9907cf1896746437b05f275a4008b19b` |
| `center.tap` | `a012b62544fc087c34f2abf5c846dd794e3886126c56b1cd85541d4219383dfe` |
| `browser.tap` | `f3167024060839fa3708eba155310fc13c77d127164edf30d28532886155403d` |
| `browser-host-final.tap` | `9327976362e75e325a030292e8673100078b756e900059ec9c6048af737b8653` |
| `source-fingerprint.json` | `860aba761cd50a735761c0cac97ea21920797ab398282dc64dc7c39c19a13928` |
| `p6-generation-fix/plugin-full.tap` | `db0a8d4acd8be7694140708a704b22de73ba39cf5d4b4218633d42734355083e` |
| `p6-generation-fix/source-fingerprint.json` | `334da5a14dc226ce12f1301cfd442c930ce95ccd7f2307e0c11560821fcccbf2` |

7 份 TAP（含首轮不完整日志）按绑定码、机器 token、私钥块、带密码 PostgreSQL URL 做仅计数扫描，匹配均为 0。截图实际 24 张；宿主最终重跑覆盖宿主 10 张，不重复计入数量。

## P6 两实例实际 DSH 进程探针

在生成修正后，使用已编译隔离 worktree 插件启动两套真实 DSH Web 进程：各自独立 `DSH_HOME`、profile、工作目录和 loopback 端口 `18181`/`18182`；插件通过 profile 的精确 symlink 加载，没有安装依赖、没有使用生产 profile、没有读取或打印生产凭据。两端管理连接请求均返回 HTTP 200，安全数据为 `configured=false`、`activationAvailable=true`、`revision=0`、`connection=null`；两端状态目录互不相交。

同一接口的跨源请求均返回 HTTP 403 `CENTER_CSRF_REJECTED`，缺少 `X-Pack-Center-UI: 1` 均返回 HTTP 403 `CENTER_UI_REQUIRED`。探针仅证明实际 DSH 进程加载插件、端口/状态隔离和本地接口防护；没有把它计作完整 A15/A17/A18/A22/A24，也没有声称已完成远端绑定、v1/v2 安装或真实 provider 长任务。

P6 指纹输入为 1002 个文件，组合 SHA-256 为 `3b3ffa9de635c4376cc0ce871789d12a8c1487882e9404f3cca7e4004848f5ab`，复核变化 0 项。新增证据位于 `artifacts/pack-center/p6-generation-fix/`；两套临时 DSH 进程已停止，profile 临时目录仅用于探针，不是生产配置。

已核对生产 package.json、pnpm-lock.yaml、lib/index.js、lib/client.js、node_modules/.modules.yaml 五项摘要与既有基线一致；不表示共享机器完全没有其他人的改动。没有 root 安装依赖或生产构建。测试仅清理各自精确标识的一次性数据库容器/匿名卷，不清理其他人的资源。

最终中心测试的 13 个夹具容器由各自 fixture 正常关闭；首轮遗留的 publisher 与 governance 两个容器经归属和精确 ID 核对后清理，未按通用标签批量删除。删除的匿名卷仅含一次性测试数据、不可恢复，原始 TAP 保留。文档同步后两棵工作树 `git diff --check` 退出 0，1001 项指纹再次核对变化 0 项。

后续必需项仍包括两个实际隔离 DSH 的 v1/v2 独立运行、实际 provider 和长任务惰性资源、完整浏览器升级/回退、legacy 迁移、S3/硬配额及备份恢复/第二实例复建。本批测试壳与多个本地目录不代替这些验收。
