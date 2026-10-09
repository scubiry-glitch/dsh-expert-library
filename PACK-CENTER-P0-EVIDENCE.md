# Pack Center 本地基础验证记录

> 日期：2026-09-19。工作树：`/root/zhijian/dsh-pack-center-dev.ZGtty5`。
> 基线提交：`784a6ac07b96a67c89b8516664172c0973f98079`，本批未提交差异以本页源码指纹和工作树文件为准。
> 本页是组件和插件回归证据。中心网页、真实远端分发及双 DSH 实例业务验收仍未完成。

## 本批最终结果

在所有参与模块冻结后，主 Agent 顺序完成完整构建，再运行两组测试：

| 命令 | 退出码 | 实际结果 |
|---|---|---|
| `pnpm build` | 0 | 服务端 tsc、客户端 tsc、tsdown 全部通过 |
| `node --test 'test/**/*.test.mjs'` | 0 | 786/786 通过；0 失败、0 跳过、0 取消；36898.324194 ms |
| `node --test 'packages/pack-contract/test/*.test.mjs' 'packages/pack-artifact/test/*.test.mjs'` | 0 | 85/85 通过；0 失败、0 跳过、0 取消；2749.452167 ms |
| `git diff --check` | 0 | 无空白格式错误 |

两组互不重复，共 **871 项通过**。原插件基线为 682 项；插件目录新增 104 项，协议/归档另有 85 项。测试使用刚构建的 `lib`（测试明确检查源代码时除外），未用旧编译产物替代新实现。

实际执行时为控制终端输出，测试命令后接 `rg -n -B3 -A25 'not ok|# tests|# pass|# fail|# cancelled|# skipped|# duration_ms'`，并先执行 `set -o pipefail`；管道保留测试失败退出码。没有将过滤工具的成功当成测试成功。

构建保留基线已有的 `external`/`noExternal` 弃用及 CommonJS 提示，未出现新的构建错误。此次没有额外声称运行 `pnpm test` 或 `pnpm test:pack-center`；前者的 build/test 两步已按上表分别实际执行。

## 新增测试的证明范围

| 测试 | 项数 | 实际证明 |
|---|---:|---|
| pack-contract | 35 | schema、状态边、SemVer、规范字节、摘要、可信 Ed25519、篡改和未来协议候选阻断 |
| pack-artifact | 50 | 两版真实样例往返、确定性、安全 USTAR、链接/路径/限额/并发/篡改拒绝 |
| host-pack-center-state | 34 | 跨进程锁/CAS/幂等、验证前态只读恢复、永久发布账本、5 个真实 SIGKILL 提交边界 |
| host-pack-store | 24 | 安装不启用、显式切换/离线回退、缓存结果、依赖/实体冲突、恢复、双目录版本独立、旧包接管/恢复 |
| host-pack-legacy | 13 | 原源不动、本地真实归档和摘要、同内容双路径复用、旧源后改动不影响备份、恢复时阻断冲突 |
| host-pack-runtime | 12 | 每调用本地快照、真实层冲突、预提交合并、路径抑制、快照捕获、错误不静默降级 |
| v2-center-runtime | 14 | 显式启用与全停用、实际编译版本差异、缓存身份、冻结结果、树篡改、旧层语义保留 |
| pack-center-fixtures | 7 | 纯校验入口复用、样例可编译、固定摘要向量和报告兼容 |

既有 runtime 的 10 项及 no-network 的 7 项包含在完整插件回归内。没有通过简单对象冻结推断完整长任务惰性资源绑定，也没有把两个本地目录测试说成两个真实 DSH 部署点。

## 审阅/集成发现与修复

本批不是仅运行已有测试：审阅实际发现并修复了以下问题，并补了对应回归：

1. RSA 生成的 64 字节签名可伪装算法；现在强制签名/验签密钥均为 Ed25519。
2. 同版本只比较部分摘要会漏掉兼容性/身份字段变化；现在比较完整规范清单。
3. 新协议元数据导致整次更新检查失败；现在可显示明确阻断，并继续寻找旧的兼容候选，安装仍严格拒绝未知协议。
4. 状态丢失时未识别实际 `releases`/`legacy` 库存；现在失败关闭，不初始化为空库。
5. 持锁子进程退出与 state rename 之间有锁丢失窗口；改为父进程 fd 持有内核锁，并用真实跨进程测试验证。
6. 幂等序列化忽略隐藏/装饰属性或执行 getter；现在严格拒绝并在异步前捕获请求。
7. 完整 SemVer build 标识被误当成相同版本身份；已区分不可变身份与更新优先级。
8. 只检查已安装记录，卸载后可忘记同版本历史绑定；新增不可变 `acceptedReleases` 账本。
9. 两个中心包实体可悄悄相互覆盖；新增本地和真实 runtime 合并冲突检查。
10. 下载成功、启用失败的结果不清楚；现在保留缓存并明确 `installed_not_enabled`，不报告更新启用成功。

开发中还出现过严格 state 请求字段与 store 展开额外字段不匹配、以及编译期间源码继续变化造成的旧 lib 回归失败。这些均已修复或在全部文件冻结后重建，并以本页最终 871 项结果重新验证；未把早期失败结果隐藏成始终通过。

## 本批核心源码指纹

```text
a97e7dae329a51c712b9c324ebe577a68e5868867157983eee50c44458b512e7  package.json
365cab02f394474d60acb4c171408f4b6e139f848cb5f058c4036669da6383ca  src/pack-validator.ts
7ec5b15b0a195c4c815fa5d68260d5bb97e5cae51e9618da8cc45acac08d52ea  src/host/pack-center-state.ts
b9b34276f6953ec8ef5a909974978a5305bd351ffff6d3468886edafcad26b4f  src/host/pack-store.ts
2a78a12f5a7295b788ed6c40c2d048edb3fcaebb6ec2a5ac2f658529e9cc810e  src/host/pack-legacy.ts
bb0c95637f3d816ebd3f7e9b1568194708208428dc1e4c25460abdcb60727c26  src/host/pack-runtime.ts
1125bb83c57d0161f62e6ce1de4e90b229d783adc8ac536a1ae261fda68fa269  src/v2/runtime-pack.ts
d2d42a73aaac7d7be4cf247d9f693180ddb0dc5b82e2083b0a0939c1e977b4de  packages/pack-contract/index.mjs
49056263549922f0c0d2705459bebfa324e400f964e7c8a6d26961fd30d08fa9  packages/pack-artifact/index.mjs
```

## 生产隔离核对

原插件目录 `/root/zhijian/dsh-expert-library` 的 git status 仅有三份计划/设计/验收文档，无源代码或 package 变更。再次实测 `package.json`、`pnpm-lock.yaml`、`lib/index.js`、`lib/client.js`、`node_modules/.modules.yaml` 的 SHA-256 与 F01 基线逐项相同，见 `PACK-CENTER-BASELINE.md`。

代码和编译均在隔离工作树；没有启动/重启 DSH 生产服务，没有正式 DNS/生产凭据改动，没有 commit/push。中心 PostgreSQL 的临时测试环境是独立任务，不把它当成生产部署。

## 下一步与未通过项

### C01 独立持久层追加复核

主 Agent 随后在 `apps/pack-center` 再次运行 `npm test && npm run typecheck`，退出 0。使用真正 PostgreSQL **17.11**，13/13 通过、0 跳过，11562.59685 ms；覆盖迁移历史与失败回滚、固定快照/审查/发布约束、组织拥有关系、持久任务独占租约、过期租约拒写及跨 Node 进程恢复。

该次只创建临时容器 `0911d6ea6be0eec0f8c943e7881c71deb9b2926c92284d0c4bebc2d1503bd1ae`，测试结束已按 ID 与任务标签校验，删除此容器及其匿名测试数据库卷。它是可由测试重建的临时夹具，不是生产业务库。中心完整复现和迁移摘要见 `apps/pack-center/README.md`。

该结果与上面的 871 项分开记录，累计本批验证 **884 项**。数据库约束不能代替 HTTP 认证/权限验收，C01 仍缺制品存储及服务启动链路，C02–C07 尚未交付。

### 尚未完成的功能

- C01 中心独立数据库/持久队列另有 app 测试；尚需 HTTP、OIDC、成员邀请、Git Worker、审核发布和授权分发。
- L04–L07 尚需真实 provider 初始化、连接/凭据、本地路由、远端下载和手动更新接线。
- A17 仍缺完整任务、惰性资源和依赖跨切换的生命周期证据。
- U01–U04 三组页面尚未交付，不能用组件测试替代浏览器业务链。
- Q/O/D 仍缺两真实隔离 DSH 部署点、中心备份恢复、部署前检查及完整重建演练。

因此 Goal 保持 active，A01–A24 全部仍待完整验收。P0 组件通过不等于 P0 阶段所有出口或完整 Goal 已完成。
