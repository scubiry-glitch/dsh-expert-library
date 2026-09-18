# 领域包来源入口设计（Pack Source Registry）

> 版本 v1.0 ｜ 2026-09-18 ｜ 状态：**设计待评审，未实现**
> 目标：让开发者能自助「提交 git 地址 → 平台校验 → 引入为领域包」，并支持后续版本刷新。
> 关联文档：`NEXT-GENERATION-ARCHITECTURE.md` §3.7、`partner-devdoc/zhijian-partner-devdoc.md` §9、
> `PIPELINE-100PLUS-EXPANSION-PLAN.md`、`multi-tenant-design.md` §5.5。

---

## 0. 一句话定位

本入口是 **partner-devdoc 那套人工评审流程的机器化外壳**，不是它的替代品。
人工评审（§9.1 第三步）保留；本入口负责把它前面"交付物制作 + 自检"和后面"灰度挂载 + 入库"之间
的重活自动化，并把每一次引入变成可审计、可复现、可回滚的记录。

---

## 1. 硬约束（先读这节，它决定了后面所有设计）

### 1.1 运行时禁止远程来源

`src/v2/pack-loader.ts:1068`：

> `skill source.kind must be builtin|workspace — remote sources are forbidden at runtime`

`NEXT-GENERATION-ARCHITECTURE.md:104,303,323` 进一步写死：

> 运行时**禁止任何 GitHub/HTTP 拉取、禁止 remote repo source、禁止自动更新**
> **运行时不提供任何"检查更新"路径**

### 1.2 零网络是被测试强制的，不只是文档口径

`test/v2-no-network.test.mjs` 对 `lib/v2/{pack-loader,validate,types}.js` 与 `lib/knowledge.js`
逐文件扫描，禁止出现：

- `fetch(` / `https?://`（**注释里的 URL 字面量也算**）
- `node:http` / `net` / `dns` / `tls` / `http2` / `undici`
- WebSocket / XHR / axios
- pack-loader 的 import specifier 必须是相对路径或 `node:` 内建

**推论**：git/网络逻辑一律不得进入 `src/v2/`。新增 `PackMeta` 来源字段时，
`src/v2/types.ts` 里**不能出现 URL 字面量，注释里也不行**——字段类型声明本身没问题。

### 1.3 由此确定的模型

> **git 是供应链传输手段，不是运行时依赖。**

```
git URL → 一次性显式拉取 → 冻结为本地目录 → 本地校验 → vendor 落盘 → 运行时照常读本地
```

运行时永远离线、可复现、可摘要校验。**「更新」= 显式重新引入，不是 agent 自动轮询。**

### 1.4 与既有叙事的口径冲突（需一并收敛）

- `src/host/manage.ts:6`、`src/client/manage-card.tsx:486`、`src/v2/compat.ts:614` 声称
  「领域包是构建产物，UI 绝不直接写」「workspace `domain-packs/` 保持 preview-only」
- 但 `src/v2/runtime-pack.ts:3` 已说明 audit gap #6 修复后，**workspace packs 确实驱动编译路径**

本设计站在 `runtime-pack.ts` 的实际行为一侧，并在实现时同步订正前两处过时注释——
否则会做出一个自家文档都否定的入口。

---

## 2. 决策记录

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 信任模型 | **分级**：白名单 git host 自动入库；其余进评审队列 | 兼顾自助体验与风险 |
| D2 | 安装位置 | **全局 vendor 目录**，所有工作区共享 | 单点更新；避免与平台自带包混目录 |
| D3 | 首发范围 | 核心 + CLI + HTTP + UI **三个面一起做** | 一次交付完整形态 |
| D4 | 更新语义 | **显式重新引入**，不提供运行时自动检查更新 | 不破 §1.1 硬边界 |
| D5 | 授权 | **先修 `/manage/*` 鉴权，再加 git 功能** | 见 §7，现存公网注入点 |

---

## 3. 分层架构

```
src/host/pack-source.ts        ← 新增：git 拉取 / 暂存 / 安装编排（网络只允许在这层）
   │  复用，不重写 ↓
scripts/adapt-partner-pack.mjs check   ← 既有校验 CLI（已直接 import loadPackFromDir）
src/v2/pack-loader.ts / validate.ts    ← 既有校验器（保持零网络）
src/v2/digest.ts + hashPackageTree     ← 既有摘要
src/host/health.ts (probePackHealth)   ← 既有漂移三态 clean/dirty/unknown
   ↓
src/host/registry.ts      HTTP 面  ─┐
scripts/dsh-pack.mjs      CLI 面   ─┼─ 同一内核，三个消费面
src/client/pack-source-card.tsx  UI ─┘
```

**关键原则：校验环节几乎不用新写。** 既有栈已覆盖结构校验（`validateDomainPack`）、
整包摘要（`hashPackageTree`/`packDigest`）、漂移检测（`probePackHealth`）、
只读体检 CLI（`adapt-partner-pack.mjs check`，退出码 0 = 达入库形态）。
本设计新增的只有：**拉取、来源登记、安装/换入、授权**。

### 3.1 两个真实缺口

1. **无包级 provenance** —— `upstreamProvenance{repository, revision}` 只存在于
   SkillPackage（`src/v2/types.ts:713-756`），`PackMeta`（`:767-780`）完全没有来源字段。
2. **两份互不兼容的校验报告** —— 外部伙伴包带 `validation/validation-report.json`
   （`zhijian_pack_validation.v1`），本仓库既不生成也不消费；本仓库的等价物是
   `generated/verify.json`（`scripts/pack-common.mjs:142-181`）。本入口统一发 `verify.json` 形状。

---

## 4. 数据契约

### 4.1 包级来源记录（新增，镜像 SkillPackage 形状）

沿用 `SkillPackageManifest.source` 的字段命名，不发明新形状。审计专用，**运行时永不访问**：

```jsonc
// <vendorRoot>/registry.json
{
  "schemaVersion": 1,
  "packs": [{
    "id": "partner-risk-advisory",
    "gitUrl": "…",                  // 原样记录
    "requestedRef": "v1.2.0",       // 开发者要的 tag/branch
    "resolvedCommit": "9f3c…",      // 实际钉死的 commit SHA（唯一权威）
    "digest": "sha256:…",           // = generated/pack.sha256
    "license": "Apache-2.0",
    "trust": "verified",            // reviewed | auto-allowlisted | community
    "installedAt": "2026-09-18T…",
    "previous": { "resolvedCommit": "…", "digest": "…" }   // 回滚锚点
  }]
}
```

**只钉 commit SHA，不钉分支。** 分支会漂移，SHA 不会——沿用本仓既有的
gitlink(160000) + 固定 commit 先例（见 `.slim-quarantine/20260913/RESTORE-marketplace-src.md`）。

凭据走 `credentialRef`（label），落宿主凭据机制，**绝不写进 registry.json**（全局规则 4）。

### 4.2 落盘产出

引入成功后，vendor 包内**强制**生成（补上现存缺陷——`/root/zhijian/domain-packs/zhijian-residential-advisory/generated/`
当前缺 `pack.sha256`，导致漂移态是 `unknown` 而非 `clean`）：

- `generated/verify.json` —— 校验诊断 + 实体计数
- `generated/pack.sha256` —— 树摘要，漂移锚点

---

## 5. 三段式管线

```
① 登记 register   gitUrl + ref + credentialRef → 查授权 + 查 host 白名单
        ↓
② 拉取 + 校验     冻结到 .staging/<id>/ → 本地校验（复用既有栈）→ 出报告
        ↓
③ 换入 install    原子 rename → 写 registry → 生成 verify.json + pack.sha256
```

### 5.1 拉取（`src/host/pack-source.ts`）

**不引入 git 依赖。** 本仓零 git npm 包（无 simple-git / isomorphic-git），
一律 `spawn` 系统 CLI 并传显式 argv、**不经 shell**——沿用 `manage.ts:379` 与
`provider-transports.ts:116` 的既有范式。

```bash
git -c core.symlinks=false -c core.hooksPath=/dev/null \
    clone --depth 1 --no-tags --single-branch --no-recurse-submodules \
    --branch <ref> <url> <staging>
```

必要环境与限额：

- `GIT_TERMINAL_PROMPT=0` —— 否则遇私有库会挂起等输入
- 体积上限 + 超时（对标 `MAX_ZIP_BYTES = 16 MiB`，`manage.ts:51`）
- 拉完 `rev-parse HEAD` 记 `resolvedCommit`；**校验阶段起不再碰网络**
- 拉取后立即 `rm -rf .git/`，只留内容树（避免把远端 ref 带进运行时）

### 5.2 校验（复用，不新写）

复用顺序即 `adapt-partner-pack.mjs check` 的既有路径：`loadPackFromDir` → 诊断分组。
在其上补四项本入口特有的检查：

| 检查 | 依据 |
|---|---|
| **全局 id 唯一性** | `PIPELINE-100PLUS-EXPANSION-PLAN.md:273` 已识别的双命名空间冲突；撞 builtin id 会被 `mergePackLayers` **静默覆盖** |
| **`dependsOn` 可解析** | 该字段目前是**死字段**（声明了无消费者）；跨包依赖缺包时无诊断，第三方包必须先拦 |
| **符号链接逐分量 lstat** | 对标 `multi-tenant-design.md:299` 的双重围栏；vendor 根内直接禁 symlink |
| **凭据/内网地址扫描** | 自动化 `SUBMISSION-CHECKLIST.md` 末条 |

### 5.3 换入与回滚

- 暂存目录 → **原子 rename** 换入 vendor 根（沿用 `writeJsonAtomic` 的 tmp+rename 范式）
- **漂移闸门**：换入前跑 `probePackHealth`，目标包为 `dirty` 时**拒绝静默覆盖**——
  这正是平台保护自家包的逻辑，第三方包一视同仁
- 失败不留半成品；`previous` 锚点支持回到上一版

---

## 6. 信任分级（D1）

| 级别 | 条件 | 行为 |
|---|---|---|
| `auto-allowlisted` | git host 在白名单内（对标 `PACK_BUILD_ALLOWLIST` 范式，`manage.ts:42`） | 校验通过即入库 |
| `reviewed` | 白名单外 | 校验通过 → 进评审队列 → 人工放行后入库 |
| `community` | 自助发布、仅过校验 | 标注来源，运行时可被 `enabledPacks` 排除 |

无论哪级，**校验失败一律拒绝**，只返回逐条 diagnostics。

---

## 7. 授权（D5，**必须最先做**）

`/plugins/dsh-expert-library/manage/*` 的 handler 自身不做任何身份校验
（只有 SafeId、zip-slip 这类输入校验）。而 `multi-tenant-design.md:274` 指出：
DSH 只把 `settings.*` / `credentials.*` / `agentPreset.*` / `host.pickDirectory` /
`llm.discoverModels` 钉死为**仅回环来源**——**`/plugins/...` 自定义路由不在保护范围内**，
经 nginx 反代即可被公网触达。

**现存的 `POST /manage/skills`（zip 落盘）已经暴露在这个缺口下。** 再加"任意 git 地址"
接口等于开一个公网可达、无鉴权的内容注入点。

因此 P0 先补授权层，覆盖**整个 `/manage/*`（含既有 skills 上传）**：

- 回环判定（对齐 DSH 自带栅栏语义）
- 显式 token（写操作）
- fail-closed：无审批即拒绝，不降级不绕行（`multi-tenant-design.md` §6.1）

---

## 8. 三个入口面

### 8.1 CLI（开发者 + CI）

```bash
dsh-pack init <id>              # 由 partner-devdoc/sample-pack 起脚手架
dsh-pack check <packDir>        # 本地自检 —— 与平台同一实现，杜绝"我这儿过了"
dsh-pack submit <gitUrl> --ref v1.0.0
dsh-pack update <id> --ref v1.1.0     # = 显式重新引入；失败自动回滚
dsh-pack list / status
```

`check` 直接复用 `adapt-partner-pack.mjs check`，**不另写一份校验实现**。

### 8.2 HTTP（`src/host/registry.ts`，`manage.ts` 的兄弟模块）

挂在既有 prefix 路由 `/plugins/dsh-expert-library/manage/*` 下（`src/index.ts:940`），
沿用同一写侧范式（SafeId 白名单 → 临时目录 → 逃逸检查 → 校验通过才 rename → 原子写）：

```
POST   /manage/packs/register      { gitUrl, ref, credentialRef? }
GET    /manage/packs/registry
POST   /manage/packs/install       { id }        # 评审放行后
DELETE /manage/packs/<id>
GET    /manage/packs/<id>/report                 # verify.json 形状
```

注意：**不得挂到 `settings.*`**——那层被钉死为仅回环（`multi-tenant-design.md:274`），
经反代的请求一律 403。

### 8.3 UI（`src/client/pack-source-card.tsx`）

设置页新卡片，沿用 `src/client/index.tsx:48-74` 的 `ctx.slots.register({ name: 'settings.section' })`
模式（现有三张卡：`expert-library` / `expert-library-packs` / `expert-library-manage`）。
上传交互可参考 `manage-card.tsx:318` 既有的 multipart POST 先例。
只读展示校验报告与漂移状态（对标 `domain-packs-card.tsx`）。

---

## 9. 全局 vendor 目录（D2）

新增 settings 字段 `vendorPacksDir`（与既有 `packsDir` 并列，`src/index.ts:301`）。
**需接入三处发现逻辑**，否则装了也不生效：

| # | 位置 | 现状 |
|---|---|---|
| 1 | `src/v2/preview.ts:252` `discoverPackDirs` | 扫各 workspace root |
| 2 | `src/index.ts:984` health 路由的 pack 目录集合 | 模块根 ∪ 各 workspace |
| 3 | `src/v2/runtime-pack.ts:143` `resolveRuntimePack` | 实际驱动编译路径 |

vendor 根目录自身**必须禁止 symlink**（`multi-tenant-design.md:299` 双重围栏）。

---

## 10. 落地顺序

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| **P0** | 授权层覆盖 `/manage/*`（含既有 skills 上传） | 公网反代请求被拒；本地正常 |
| **P1** | 契约：`PackMeta` 来源字段 + `registry.json` schema | `pnpm typecheck` + `pnpm test` 全绿（含 no-network） |
| **P2** | `src/host/pack-source.ts`：拉取 + 校验编排 + 原子换入 + 漂移闸门 | 单测覆盖：恶意仓库、体积超限、id 冲突、dirty 拒绝 |
| **P3** | HTTP 面 + CLI 面（共用内核） | 端到端：真实 git 仓库引入 + 回滚 |
| **P4** | UI 卡片 | 三面一致 |
| **P5** | 信任分级 + 评审队列 | 白名单自动 / 其余进队列 |

---

## 11. 验收

- [ ] `test/v2-no-network.test.mjs` 保持绿——`src/v2/` 零网络未被污染
- [ ] `scripts/build-packs.mjs --check` 保持绿（`test/v2-builtin-pack.test.mjs:70` 依赖）
- [ ] 恶意仓库用例：带可执行脚本 / 路径穿越 / symlink 逃逸 / 超大体积，全部拒绝且不留半成品
- [ ] 引入后 `probePackHealth` 为 `clean`（不是 `unknown`）
- [ ] 公网反代触达 `/manage/*` 写操作被拒（fail-closed）
- [ ] 更新失败可回滚到 `previous` 锚点

### 未决

1. `vendorPacksDir` 默认值取哪里？（`moduleRoot` 下的目录会被插件升级覆盖，不宜；建议用户级稳定目录，待定）
2. 私有仓库凭据的具体宿主机制（`credentialRef` 指向哪套存储）待定
3. `validation-report.json`（伙伴 schema）与 `verify.json`（本仓 schema）是否收敛为一份，待定
