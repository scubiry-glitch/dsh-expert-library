# Pack Center 开发基线（F01）

> 状态：原插件基线验证完成；不是 Pack Center 功能验收。
> 验证日期：2026-09-19（测试完成约 12:02 UTC）。
> 工作树：`/root/zhijian/dsh-pack-center-dev.ZGtty5`。
> 基线提交：`784a6ac07b96a67c89b8516664172c0973f98079`。

## 结果

本轮实际运行类型检查、完整构建和原有测试，均退出 `0`。原有测试共 **682 项，682 通过、0 失败、0 跳过、0 取消**，测试报告耗时 `38528.770733 ms`。

验证开始与结束时，工作树跟踪文件的 `git diff --name-only` 均为空。设计/计划文档及其他 Agent 同期创建的 `examples/` 是未跟踪文件；没有进入本次构建或测试输入。主 Agent 在收到基线完成通知后才开始改动 `src/`、`test/` 和 `package.json`，因此后续实现应另行验收，不沿用本结果。

## 环境与依赖

| 项目 | 本轮实测 |
|---|---|
| shell `node` | `v22.23.2`，`/root/.nvm/versions/node/v22.23.2/bin/node` |
| `pnpm --version` | `11.22.0` |
| pnpm 入口 | `/usr/local/bin/pnpm`，包装脚本用 Node `v22.22.0` 启动 `/root/.nvm/versions/node/v22.22.0/bin/pnpm` |
| TypeScript | `5.9.3` |
| tsdown / rolldown | `0.22.2` / `1.1.5` |
| React | `18.3.1` |
| `@types/node` | `24.13.3` |
| `@deepseek-ai/cordis` | `4.0.1` |
| `@deepseek-ai/dsh-agent` | `0.1.0-rc.8` |
| `@deepseek-ai/dsh-client-runtime` | `0.1.0-rc.8` |

没有执行 `pnpm install`、依赖 reconcile 或修改生产依赖。隔离工作树建立了以下软链接，仅用于读取现有工具与依赖：

```text
/root/zhijian/dsh-pack-center-dev.ZGtty5/node_modules
  -> /root/zhijian/dsh-expert-library/node_modules
```

软链接是依赖复用，不是文件系统只读权限隔离：后续禁止经此路径执行安装、更新或会写依赖目录的任务。新增中心应用应使用独立依赖环境，不能将此链接当成可写的 monorepo 安装根。

已检查 `tsconfig.json`、`tsconfig.client.json` 与 `tsdown.config.ts`：输出均落到当前工作树的 `lib/`；tsdown 未启用写入 `node_modules/.rolldown` 的 devtools 配置。测试中的可写夹具使用临时目录，生成器调用是 `--check`。本轮未在原插件目录构建，未启动或重启服务，未修改 DSH 核心。

现有 `.gitignore` 的 `node_modules/` 规则不会隐藏同名软链接，因此 `git status` 中的 `?? node_modules` 是本地环境链接，**不得提交**。

## 实际命令与退出码

所有以下命令的工作目录均为 `/root/zhijian/dsh-pack-center-dev.ZGtty5`。

| 顺序 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `pnpm typecheck` | `0` | 服务端与客户端 TypeScript 检查通过 |
| 2 | `pnpm build` | `0` | 两次 tsc 编译及 tsdown 客户端打包通过 |
| 3 | `node --test 'test/**/*.test.mjs'` | `0` | 原有 682 项测试全部通过 |

原 `pnpm test` 定义为 `pnpm build && node --test 'test/**/*.test.mjs'`。本轮将它分成顺序执行的步骤 2、3，使用同一份刚生成的构建产物，避免重复构建；没有宣称额外执行过一次 `pnpm test`。

测试汇总原文：

```text
1..682
# tests 682
# suites 0
# pass 682
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 38528.770733
```

构建存在三类非失败提示：`external` 已弃用、`noExternal` 已弃用、tsdown 推荐 ESM。现有客户端配置有意生成宿主要求的 CommonJS closure-factory，F01 未更改构建配置。没有 typecheck/build/test 失败需要修复。

## 原插件未写入核对

在构建和测试前后检查了以下原插件文件，其 SHA-256、大小和修改时间均相同。这里是关键文件抽样核对，不声称对整个依赖树做了完整逐文件审计。

原插件根目录：`/root/zhijian/dsh-expert-library`。

| 相对路径 | SHA-256 |
|---|---|
| `package.json` | `67dee8551fefa3c3ec2031152db822e465bb72c4adac8d4b042a1c91a4804ae2` |
| `pnpm-lock.yaml` | `5f9206f44f36d2871bce5a5b317dc757f9bd8df8950f2eb978746afab4c0a540` |
| `lib/index.js` | `1a8052610ca81661c9919ad527aa2089e70ca9225e4bdb1140ee2a9c6541cd5f` |
| `lib/client.js` | `6f4e1bbdb9b9d90c6ae71b3ecf0e1d28006d9f9c26d35d4c17378893012805d7` |
| `node_modules/.modules.yaml` | `889ccd71eb76c51ad4024cfb7ba3f306045f0a89affd36ceaa7feb7e66b68283` |

## 适用范围

本结果证明该提交在已记录依赖环境中能够构建并通过现有测试；不证明设计中已指出的安装事务、审核快照、摘要排除或离线回退缺口已修复，也不替代中心服务、客户端更新流程或真实网关的后续验收。

新功能以 [PACK-CENTER-DEVELOPMENT-PLAN.md](PACK-CENTER-DEVELOPMENT-PLAN.md) 的任务编号推进，并为每批实现记录自己的验证结果。本轮没有 git commit、push 或生产部署。
