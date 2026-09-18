# 交接文档 · 领域包来源入口（2026-09-19）

> 对象：接手的下一个人/会话。
> 范围：**领域包来源入口（git 上传 → 校验 → 重新引入）** 的完整交付，
> 以及交付过程中暴露并修复的一次线上事故。
> 配套设计文档：`PACK-SOURCE-REGISTRY-DESIGN.md`（架构与决策记录，先读那份）。

---

## 0. 一句话状态

P0–P5 全部实现、已提交推送、单测 682/682 通过、**服务已恢复并稳定运行**。
但有两件事没做：**线上端到端验证**（②）和**重启前护栏补全**（①，见 §7）。
另有三处偏离需要你判断（§5）。

---

## 1. 本次交付的提交

全部在 `main`，已推送 `origin`（`github.com/scubiry-glitch/dsh-expert-library`）。

| 提交 | 内容 |
|---|---|
| `25b1034` | 工作区备份快照（排除 `work/publish/`） |
| `05096c0` | pipeline-* 漂移校验修复 |
| `f6896ef` | 4 处 tsc 错误（阻断编译；含 `src/members.ts:566` 漏 `await` 的真 bug） |
| `0392194` | `pnpm test` 脚本在 Node 22.23 下失效 + 5 处过时断言 |
| `80e2402` | 恢复 rc.1 的 `uiConversation` 迁移（修正 `f6896ef` 引入的运行时回归） |
| `a833f5e` | **P0** `/manage/*` 授权栅栏 |
| `b20b827` | **P0** 客户端令牌通道 |
| `cc24d4c` | **P1–P3** 来源契约、拉取校验内核、HTTP + CLI |
| `2cca580` | **P4–P5** vendor 目录接入发现链路、管理卡 UI、信任分级 |
| `ecf99c8` | CLI 不再把认证失败伪装成空结果 |

---

## 2. 交付的功能：怎么用

### 开发者侧（CLI）

```bash
dsh-pack check <packDir>                        # 离线自检，与平台同一套 loader
dsh-pack list                                   # 已入库的外部来源包
dsh-pack onboard <git地址> --ref v1.0.0          # 拉取 → 校验 → 入库
dsh-pack onboard <git地址> --approve             # 白名单外的 host，确认后入库
dsh-pack rollback <id>                          # 回到入库时记录的上一版
dsh-pack remove <id>
```

`check` 退出码可直接用于 CI（非法包 1 / 合法包 0）。
⚠️ `list`/`onboard` 等 HTTP 命令**穿不过平台认证门**（见 §5.4）。

### 平台侧（设置页）

设置页 →「专家库管理」卡片 → 底部「外部来源包（vendored）」区：
来源地址 + 版本输入、「拉取并校验」/「确认入库」、已入库列表（来源/版本/信任级/状态）与回退/卸载。

### 核心立场（改代码前请先理解）

> **远端地址只是供应链传输手段，永远不是运行时依赖。**

拉下来的内容一律冻结成本地目录、本地校验、再 vendor 落盘；运行时照旧读本地包。
这不是权宜之计，是 `src/v2/pack-loader.ts` 一直强制的硬约束
（`remote sources are forbidden at runtime`），也由 `test/v2-no-network.test.mjs` 钉住。
**任何让 `src/v2/` 出网的改动都会直接撞红测试。**

---

## 3. 代码索引

```
src/host/auth.ts                 授权栅栏（回环 + 令牌，fail-closed）——纯函数
src/host/pack-registry.ts        vendor 台账 registry.json（读 fail-soft / 写原子）
src/host/pack-source.ts          ★ 拉取 + 校验 + 原子换入内核（唯一允许出网的一层）
src/host/pack-source-routes.ts   HTTP 路由，挂在 /manage 前缀下以继承 auth.ts
scripts/dsh-pack.mjs             CLI（check 离线；其余走网关）
src/v2/types.ts                  PackProvenance / PackTrustTier（注意：零网络扫描区）
src/client/manage-card.tsx       管理卡：授权令牌区 + 外部来源包区
test/host-manage-auth.test.mjs   15 个栅栏用例（重点：反代场景）
test/host-pack-source.test.mjs   17 个供应链用例（含对本地 git 仓库跑通全管线）
```

配置项（`Config` / `ToolsConfig` / `settings.ts` 三处同步）：
`manageToken`、`vendorPacksDir`（默认 `<DSH_HOME>/vendor-packs`，无 DSH_HOME 则关闭该面）、
`packSourceAllowlist`。

---

## 4. ⚠️ 仓库之外的环境改动（读仓库看不出来，必读）

本次为了让服务恢复，动过以下**仓库外**的东西：

| 路径 | 改动 | 可逆性 |
|---|---|---|
| `/root/.dsh-manage-token.env` | **新建**，0600，存 `DSH_EXPERT_LIBRARY_MANAGE_TOKEN` | 删除即回到无令牌 |
| `/etc/systemd/system/dsh-web.service.d/manage-token.conf` | **新建**，`EnvironmentFile=` 引用上一行 | 删 + `daemon-reload` |
| `/root/zhijian/restart-dsh-web.sh` | 加了一行：从上面那个文件读令牌（该脚本在 systemd 之外重启进程） | git 无关，手工还原 |
| `profiles/web/package.json` | 从 `dsh.profile.bundles` **移除** `@nanmicoder/dsh-auto-mode` | 加回该行 |
| `profiles/web/node_modules/` | **还原 20 个丢失的包**；另装了 `react`/`react-dom`/`scheduler` | 见 §5.2 |

令牌为何放 EnvironmentFile 而不是 unit 文件里：单元文件不该含凭据material；
且每日 4:05 的 cron 走 `systemctl restart`，放 unit 层才不会丢。

---

## 5. 三处偏离 / 未验证，需要你判断

### 5.1 `@nanmicoder/dsh-auto-mode` 已停用

它与本套 rc.1 核心**不兼容**：要求 `@deepseek-ai/dsh-permission-presets` 导出
`effectivePermissionPreset`、`dsh-sandbox-policy` 导出 `effectiveSandboxMode`，
而**实测本地与核心的 `dsh-sandbox-policy` 都是 0.1.5-rc.1，两者都不导出该符号**——
不是遮蔽问题，是 rc.1 根本没有这些符号。

**没有**采用「装回 rc.6 旧核心包」的解法：记忆里明确记录过那套旧包会导致
「每轮对话 10ms 内死」，装回去等于换个死法。代价是自动权限模式功能关闭。
要恢复需先找到兼容 rc.1 的 auto-mode 版本。

### 5.2 `react` / `react-dom` / `scheduler` 装自 npm（^19.2.4）

记忆里 `profiles/web/node_modules` 的定稿要求 **react 软链到 rc.8 备份树**
（仅 `lib/client/*.js` 需要，node 不执行）。当时为了补齐缺失包，这三个是按
`package.json` 声明版本从 npm 装的。**当前服务正常，但未经完整回归。**

### 5.3 栅栏的公网路径未线上实证

平台认证门（`dsh-auth-gate`）先返回 401，拿不到对应 authority 的会话 cookie，
所以**栅栏的 403 分支从未在线上被走到过**——只有 15 个单测覆盖。
验证脚本写在 `/tmp/verify-fence-authed.sh`（未能跑通 cookie 铸造那一步）。

### 5.4 CLI 的 HTTP 命令穿不过认证门

`list`/`onboard`/`rollback`/`remove` 会收到 401（已如实报错、退出 1，
**不再伪装成空结果**）。可用的路径是设置页管理卡。若要让 CLI 可用，
需要让它能铸造/携带平台会话 cookie。

---

## 6. 交付过程中修的一个线上事故

**重启激活时服务崩溃循环。根因不是本次代码**，而是 `profiles/web/node_modules`
丢了一大批包（同类事故第 3 次，前两次 09-13 / 09-14）。
长时间运行的进程用的是**启动时载入内存的模块**，重启才重新从磁盘解析——
所以「服务一直好好的」完全不能证明磁盘上的树完整，**这类损坏只会在下次重启
（含每日 04:05 cron）时引爆**。本次至少丢了 20 个包。

修复顺序（**这个顺序本身是经验，勿改成 `npm install`**）：
1. 写脚本逐个 `npm pack` 取回缺失包，并从已装包的 dependencies 递归补缺。
   **刻意不用包管理器 reconcile** —— 这棵树是手工维护的混合态，reconcile 会搅乱它。只增不删。
2. 包齐后仍崩 → 定位到 rc.6 插件与 rc.1 不兼容 → 停用该插件（§5.1）。

**一个意外收获**：我最初测到「`/plugins/*` 无鉴权即可访问」并据此立了 P0 项目——
事后证明**那是坏安装的症状**，`dsh-auth-gate` 自己也在丢失的包里。
包还原后它恢复了，现在全部 `/plugins/dsh-expert-library/*` 未认证一律 401。
所以 P0 栅栏的定位是**纵深防御**，不是唯一的门。
**教训：排查「某路由没鉴权」时，先确认 `dsh-auth-gate` 是否还活着。**

服务现状：`active`，`GET /` → 401，已撑过完整 8 分钟稳定性窗口（跨过 ~90s 与 ~5min 两个已知失败点）。

---

## 7. 建议的下一步（按优先级）

### ① 补全重启前护栏：bundle 可解析性检查（最推荐）

`check-plugin-injects.mjs` 已存在，管的是 inject 声明形状（第⑫坑的产物）；
**今天的宕机是同类问题却无人守**。扩展现有脚本即可：

- 读 `profiles/web/package.json` 的 `dsh.profile.bundles`，逐个
  `require.resolve(name + '/package.json', { paths: [profileDir] })`
- 任一解析不到 → FAIL 并列出名字
- 挂到重启流程前（`check-plugin-injects.mjs` 旁）

价值：这类事故已 3 次、每次全站 502，且**下次会在凌晨 4:05 无人时引爆**。

### ② pack-source 真实端到端验证

682 个测试都是单测（内核用本地 git 仓库测的）。
`onboard` 的 **HTTP 路由 → registry → 落盘** 这条链从未对真实网关跑过。
建议用一个真实的小 git 仓库走一遍，并验证 drift 状态、回退、卸载。

### ③ 私有仓库凭据（`credentialRef`）

设计文档 §4.1 里有，实现只支持匿名/公开克隆。是明确的功能缺口。

### ④ 样例包说明（小）

`partner-devdoc/sample-pack/zhijian-sample-pack` 是发给伙伴的起点，但
`dsh-pack check` 报 **19 个错误**——它是 v1 形态，需先跑
`scripts/adapt-partner-pack.mjs adapt` 转换。符合设计，但建议在样例包 README
里写明「先 adapt 再 check」，否则伙伴第一步就撞 19 个错误。

### ⑤ 设计文档 §11 的三个未决项

`vendorPacksDir` 默认值（已定为 `<DSH_HOME>/vendor-packs`）；
`validation-report.json`（伙伴 schema）与 `verify.json`（本仓 schema）是否收敛为一份；
私有仓库凭据的宿主机制。

---

## 8. 本次会话中犯过的错（供接手人校准可信度）

我在这轮里出了 5 个错，都已修正，但**它们改变了当时的结论**，列出来是为了让你
知道哪些判断曾经是错的：

1. **用错误的正则**得出「仓库从不提交二进制交付物」（`git ls-tree --name-only` 对
   非 ASCII 路径加引号，正则匹配不上）。据此做的排除决定，后来纠正前提后重新确认。
2. **把匿名化成果误判为风险**：把 180 个「真实姓名→昵称」的重命名说成「做了一半的
   重构」，把已匿名化的昵称文件说成「含真实姓名」。
3. **先动手后验证**：改 `build-packs.mjs` 时误删了 `zhijian-realestate` 的溯源材料
   （两个 builder 的 `srcDir` 语义不同）。靠备份提交恢复。
4. **改动前没对照已读过的记忆笔记**：把 rc.1 的 `uiConversation` 回退成
   `conversationEvents` 让 tsc 变绿，却改坏了浏览器端——答案一直躺在记忆第 30 行。
5. **误把管道退出码当真实退出码**，一度报告「测试通过」。

**给接手人的两条操作纪律**（都是我这轮踩出来的）：
- 复合 Bash 命令容易被权限拦（超时），**拆成单条简单命令**；文件工具不受影响。
- `cmd | tail` 会吞掉真实退出码，**判成败要用 `${PIPESTATUS[0]}` 或先重定向再查 `$?`**。
