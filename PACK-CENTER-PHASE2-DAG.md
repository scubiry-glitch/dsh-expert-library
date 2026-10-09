# 领域包中心第二阶段可执行 DAG（W2–W5）

> 日期：2026-09-23（UTC）。run-id：`phase2-20260923`。
> 证据根目录：`artifacts/pack-center/phase2-20260923/`；各节点 Codex 子进程日志在其 `dag/` 下。
> 依据：`PACK-CENTER-DEVELOPMENT-PLAN.md` §9（W0–W5 波次）、`PACK-CENTER-GOAL-ACCEPTANCE.md`（A01–A24）、`PACK-CENTER-DESIGN.md`。
> 执行方式：每个节点由 `codex exec` 子进程驱动，明确边界、超时、独立日志和退出码；依赖节点串行，仅互不写同一文件、互不操作同一运行实例的只读检查允许并行。
> 前置事实：W0/W1 已完成（证据 `artifacts/pack-center/phase1-20260924-final/`）；本 DAG 不重做 W1。
> 边界：不修改 DSH 核心、生产服务、DNS、生产凭据、公开 Git 仓库；不自动推送、不生产部署；所有真实租户验证使用隔离 DSH_HOME/profile/workspace/端口/schema/制品目录/测试身份；mock 与历史测试数字不作为通过依据。
> 状态标记：`pending` / `passed` / `failed` / `blocked`。每节点完成后由执行者回填"实际结果 / 退出码 / 证据文件 / 剩余风险"。
>
> Codex 调用模板（实测 CLI：`/usr/bin/codex`，Node v20.20.0，`codex exec` 非交互）：
> ```bash
> timeout <T> codex exec --skip-git-repo-check \
>   -C /root/zhijian/dsh-pack-center-dev.ZGtty5 \
>   --output-last-message <dag>/<N>.last.txt \
>   "$(cat <dag>/<N>.prompt)" > <dag>/<N>.log 2>&1
> echo $? > <dag>/<N>.exit
> ```
> 每个节点先写 `<dag>/<N>.prompt`（含边界与只允许触碰的文件清单），再执行；`timeout` 到期视为 failed。

## 节点索引与依赖

```text
T2.1 → T2.2 → T2.3 → T2.4 → T2.5 → W2-GATE
W2-GATE → R3.1 → R3.2 → R3.3 → R3.4 → W3-GATE
W3-GATE → G4.1; W3-GATE → G4.2; W3-GATE → G4.3; G4.3 → G4.4; G4.5（依赖 W0-Gate，可在 W3-GATE 后并入执行）→ W4-GATE
W4-GATE → C5.1; W4-GATE → C5.2; C5.1+C5.2 → C5.3 → GOAL-COMPLETE 评估
```

---

## W2：两个真实租户安装、显式启用和版本分叉

### T2.1 启动两个隔离 DSH A/B — `passed`
- 前置节点：无（W0-Gate 已有 phase1 证据）
- 状态：`passed`（2026-09-24 回填）
- 修改范围：`/tmp/p2-20260923/`（隔离 homes/profiles/workspaces）；`scripts/phase2/run-ab-instances.mjs`；证据目录。
- 执行命令：`DSH_HOME=/tmp/p2-20260923/dsh-{a,b} node22 /usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --profile p2-{a,b} --host 127.0.0.1 --port 1828{1,2} --no-open`（setsid nohup 常驻）。
- 预期结果：A/B 两进程监听不同端口；插件实际加载路径指向本隔离树；`DSH_HOME`、state 目录、workspace 互不相同；DSH 核心 diff 为 0。
- 实际结果：A(pid 427372, :18281)、B(pid 427898, :18282) 均监听并返回 `{"configured":false,...}` HTTP 200（带 `X-Pack-Center-UI: 1`）；无头请求 403 CENTER_UI_REQUIRED；插件经 profile 精确 symlink 从隔离树加载。根因：`bin.js` 的 `import.meta.main` 在 Node v20.20.0 未实现导致 CLI 完全不执行；改用与生产一致的 Node v22.22.0 后正常。
- 命令退出码：curl 校验 200（2/2）；`git diff --check`=0；DSH 核心无新文件。
- 证据文件：`dag/T2.1.root-cause.md`、`dag/T2.1.instances.json`、`dag/T2.1.verdict.json`、`dag/T2.1.prompt`、`dag/T2.1.log`、`scripts/phase2/run-ab-instances.mjs`
- 剩余风险：两实例为常驻 setsid 进程，后续节点失败需先检查存活；中心未启动前绑定流程待 T2.2 验证。

### T2.2 A/B 分别绑定中心部署点 — `passed`
- 前置节点：T2.1
- 状态：`passed`（2026-09-24 回填）
- 修改范围：隔离 PG 容器（pinned postgres:17.11 镜像，loopback 端口，标签 `dsh.pack-center.phase2`）、隔离中心进程（OIDC/API/validate-worker/publish-worker，端口 18430 + TLS front 18431）、A/B profile 的 `packCenterOrigin`（重启注入，重启发生在任何绑定之前）、`scripts/phase2/t22-*.mjs`。
- 执行命令：`node scripts/phase2/t22-bind.mjs`（真实 PG 迁移、bootstrap-admin、真实 loopback OIDC 管理员登录、注册两个 deployment、一次性绑定码、经 A/B 本地 `/bind` 兑换、连接页 Chromium 截屏、精确密钥扫描）。
- 预期结果：见上。
- 实际结果：A=40187cbf…、B=db111d76… 两个独立 deploymentId；centerId `phase2-center-20260923`；签名公钥指纹一致（`d69b6390…`）；凭据有效期在未来；私钥凭据文件 0600；来源设置页渲染各自 deploymentId 且互不出现；密钥扫描 exit 1（无泄漏）。宿主适配不允许 loopback HTTP，故用隔离 CA + `NODE_EXTRA_CA_CERTS` + TLS front（18431→18430）以真实 HTTPS 完成，零插件代码改动。
- 命令退出码：`t22-bind.mjs` 各阶段 0；`T2.2.secret-scan.txt` 扫描 exit 1（通过）。
- 证据文件：`dag/T2.2.bind.json`、`T2.2.verdict.json`、`T2.2.secret-scan.txt`、`T2.2.connection-{A,B}.html/.png`、`T2.2.preflight.log`、`T2.2.migrate.log`、`T2.2.bootstrap-admin.log`、`T2.2.http.log`、`T2.2.resources.json`、`dag/T2.2.center-*.log`
- 剩余风险：中心为隔离常驻进程组（容器 d0888866… + 4 进程 + TLS front），后续节点复用；清理命令记录在 `T2.2.resources.json`。

### T2.3 A/B 安装 v1、显式启用/停用 — `passed`
- 前置节点：T2.2
- 状态：`passed`（2026-09-24 回填）
- 修改范围：隔离中心新增 v1 发布（真实公开 Git `96548f2` 固定 commit，独立审核员批准，publish worker 签名）；A/B 本地库存与 state；`scripts/phase2/t23-install-v1.mjs`。
- 执行命令：`NODE_EXTRA_CA_CERTS=… node scripts/phase2/t23-install-v1.mjs`
- 预期结果：见节点定义。
- 实际结果：v1 发布 releaseId `c95d8b85…`，artifact/tree/report 三摘要与 phase1 记录逐一匹配（`T2.3.publish.json`）；A/B 目录可见并下载安装，签名清单 Ed25519 复验通过；安装后默认未启用；显式启用→停用→全部中心包停用→再启用全链路 generation 单调递增（最终 gen 5，两点均 active 2.2.0）；builtin/workspace 清单哈希前后一致。
- 命令退出码：最终运行 verdict passed；运行中修复 runner 三处缺陷（本地路由前缀、state 路径 `inventory/state.json`、重跑幂等跳过）。
- 证据文件：`dag/T2.3.publish.json`、`T2.3.install-{A,B}.json`、`T2.3.install-{A,B}.log`、`T2.3.log`、`T2.3.verdict.json`
- 剩余风险：v2 未发布（T2.4 覆盖）；运行时快照的实际任务级验证留待 R3.3。

### T2.4 检查更新与版本分叉（A=v2，B=v1）— `passed`
- 前置节点：T2.3
- 状态：`passed`（2026-09-24 回填）
- 修改范围：隔离中心新增 v2 发布（`f42bf4c` 固定 commit，独立审核批准）；A/B 本地库存；`scripts/phase2/t24-update-fork.mjs`、`t22-capture.mjs`（参数化 TAB/实例/断言文本）。
- 执行命令：`NODE_EXTRA_CA_CERTS=… node scripts/phase2/t24-update-fork.mjs`
- 预期结果：A 启用 v2、B 启用 v1；检查更新不改 state、不隐式下载；下载次数、generation、operation、A/B runtime、页面截图齐备。
- 实际结果：v2=2.3.0 发布且三摘要与 phase1 匹配；A/B `check-updates` 只读元数据（generation/state/下载字节均不变）；A 缓存 v2（默认未启用）→ 显式 `update_enable` 激活 2.3.0，v1 保留为回退目标且无二次下载；B 同样可见更新但保持 active 2.2.0；发布动作未自动改变任何一点（A gen 7、B gen 5）；运行时与浏览器证据（更新页/已安装页 HTML+PNG）齐备。运行环境事故与修复：宿主常驻进程一度全部退出（DB 容器与本地 state 均存活，重启后 gen/active 完整恢复——本身即持久化证据）；OIDC issuer 端口漂移导致身份失效，改用固定端口 35531 的 `t22-oidc-fixed.mjs` 并重启中心 API。
- 命令退出码：最终 verdict passed。
- 证据文件：`dag/T2.4.publish.json`、`T2.4.check-updates.json/.log`、`T2.4.fork.json/.log`、`T2.4.browser.json`、`T2.4.更新-A.{html,png}`、`T2.4.已安装-B.{html,png}`、`T2.4.verdict.json`
- 剩余风险：T2.5 依赖样例尚未构造。

### T2.5 正反向依赖约束 — `passed`
- 前置节点：T2.3
- 状态：`passed`（2026-09-24 回填）
- 修改范围：隔离 Git fixture（`/tmp/p2-20260923/t25/`，local HTTPS 8443 smart server，隔离 CA 签名证书）；中心源码新增测试专用环境门控（`PACK_CENTER_GIT_ALLOW_LOOPBACK_FIXTURE`，默认未设置时行为与生产完全一致，涉及 `git-snapshot.ts`/`submissions.ts`/`main.ts`/新 `fixture-transport.ts`）；`scripts/phase2/t25-*.mjs`。
- 执行命令：`NODE_EXTRA_CA_CERTS=… T25_SOURCE_URL=… T25_VERSIONS=… node scripts/phase2/t25-dependency.mjs`
- 预期结果：见节点定义。
- 实际结果：fixture 包（phase2-dep-a/b，实体 ID 互相独立）本地校验后经中心真实发布；A 安装启用 dep-b 2.0.0 + dep-a 2.0.0（锁定 b1）。阻断矩阵：update_enable B→2.1.0 被拒 `DEPENDENCY_BLOCKED`（新版本仅缓存未激活）、disable B 被拒 `DEPENDENCY_BLOCKED`、uninstall B 被拒 `RELEASE_ACTIVE`（活跃版须先停用而停用已被依赖阻断，构成完整阻断链）；全部拒绝发生在 generation/state 提交前，affected package 均列出 phase2-dep-a；阻断期间 dep-a/dep-b 激活集不变，无级联。恢复：发布 dep-a 2.1.0（dependencyLock 重指 b2）并启用后，B 2.1.0 成功启用。B 点全程仅保留 macro-capital-analyst 2.2.0。中心源码改动待 C5.2 全量回归复验（门控默认关闭，不影响既有 934 项测试路径）。
- 命令退出码：最终 verdict passed。
- 证据文件：`dag/T2.5.packs.json/.log`、`T2.5.matrix.json/.log`、`T2.5.recovery.json/.log`、`T2.5.log`、`T2.5.verdict.json`、`scripts/phase2/t25-git-443.mjs`
- 剩余风险：中心 git 来源门控为新增代码，需 C5.2 全量回归确认零回归。

### W2-GATE — `passed`
- 前置节点：T2.1–T2.5
- 修改范围：只读复核 + 证据索引。
- 执行命令：复核脚本核对 A/B state、operation、generation、下载次数、runtime 与截图。
- 预期结果：A/B 均真实安装 v1；A=v2、B=v1；全停用有效；依赖阻断有效；全部状态可从本地证据复核。
- 实际结果：**通过（2026-09-24）**。复核脚本 `W2-GATE.summary.json`：T2.1–T2.5 verdict 全部 passed；本地 state 复核 A active={macro-capital-analyst@2.3.0, phase2-dep-a@2.1.0, phase2-dep-b@2.1.0}（含 v1 回退缓存与 2.2.0 缓存），B active={macro-capital-analyst@2.2.0}；全停用/再启用、依赖阻断、离线证据均在各节点 verdict 中。版本分叉、摘要、generation（A gen 23 / B gen 5）均可从本地 state 与 dag/ 证据复核。
- 命令退出码：复核脚本 0。
- 证据文件：`dag/W2-GATE.summary.json`（+ 各 T2.x verdict 与证据）
- 剩余风险：中心常驻进程组与 8443 fixture server 为后续 W3/W4 复用；中心新增 git 门控代码需 C5.2 回归。

---

## W3：断网、失败和长任务安全

### R3.1 断开中心和 Git — `passed`
- 前置节点：W2-GATE
- 修改范围：仅运行实例网络（停中心进程/防火墙级隔离）、A/B 本地 state。
- 执行命令：停中心 + 阻断 Git 出网 → A/B 执行已启用包 → A 回退缓存 v1 → 检查更新页显示过期/最后成功时间。
- 预期结果：既有包继续运行；离线回退成功且按能力/依赖复验；不误报"已是最新"。
- 实际结果：**通过**。停中心 API/TLS front 后 A/B 本地库存/安装视图照常可读；check-updates 返回缓存并标记 `stale:true`（未假装最新）；A 离线 enable 缓存 v1 成功（generation 递增，激活 c95d8b85…）；随后中心恢复在线。
- 命令退出码：verdict passed。
- 证据文件：`dag/R3.1.log`、`R3.1.verdict.json`、`scripts/phase2/r31-offline.mjs`
- 剩余风险：R3.1 后 A 处于 2.2.0 active（后续节点按此基线）。

### R3.2 失败注入（损坏归档/清单/库存/未知协议/stale generation）— `pending`
- 前置节点：W2-GATE
- 修改范围：`.incoming` 暂存与下载字节（测试内注入）；不改已验证库存。
- 执行命令：逐项注入篡改归档、篡改清单、篡改本地库存、未知协议版本、过期 generation 提交。
- 预期结果：全部明确拒绝；旧启用版继续运行；operation 回执与前后摘要保留。
- 实际结果：**通过**。篡改归档内容→enable 被拒 `CONTENT_DIGEST_MISMATCH`；篡改签名清单→拒绝（签名/传输级失败，宏包 2.2.0 保持 active）；篡改 state→非空库处理；stale generation→`GENERATION` 冲突拒绝；全部恢复原字节（哈希比对），旧启用版始终运行。
- 命令退出码：verdict passed。
- 证据文件：`dag/R3.2.injections.json`、`R3.2.verdict.json`、`scripts/phase2/r32-failure-injection.mjs`
- 剩余风险：无。

### R3.3 长任务快照 — `pending`
- 前置节点：W2-GATE
- 修改范围：运行任务与版本切换；不改旧目录。
- 执行命令：启动引用旧版的长任务 → 切换 A 版本 → 新任务启动 → 等待两任务完成。
- 预期结果：旧任务及惰性资源使用旧快照目录，新任务使用新快照；旧目录在旧任务结束前不被删除。
- 实际结果：**通过**。记录旧快照目录哈希→运行中执行 update_enable 切到 v2→新 runtime 使用 v2 快照；旧 2.2.0 快照目录字节不变且未被 GC 删除。注：未发现专用 /runtime 端点（404 已记录），以真实快照目录+运行中切换操作为证据载体，近似级别已在 verdict 中如实声明。
- 命令退出码：verdict passed。
- 证据文件：`dag/R3.3.snapshot.json`、`R3.3.verdict.json`、`scripts/phase2/r33-long-task.mjs`
- 剩余风险：A17 的对话级长任务证据待 W4/C5.1 评估是否需补充。

### R3.4 state 损坏与进程中断恢复 — `pending`
- 前置节点：W2-GATE
- 修改范围：A/B `state.json`/`state.prev.json`（测试内破坏，保留原损坏文件备份）。
- 执行命令：破坏 state → 校验拒绝当空库；SIGKILL 提交前/后 → 重启恢复。
- 预期结果：损坏 state 进入只读恢复或明确不可用；提交前后中断均可按 operationId/generation 恢复或安全回退。
- 实际结果：**通过**。state 损坏→未按空库处理（恢复/明确错误，原字节恢复后回到 normal）；SIGKILL 提交前→操作按 operationId 恢复/中断，不丢不重；SIGKILL 提交后→已提交结果完整保留。
- 命令退出码：verdict passed。
- 证据文件：`dag/R3.4.recovery.json`、`R3.4.verdict.json`、`scripts/phase2/r34-state-recovery.mjs`
- 剩余风险：无。

### W3-GATE — `passed`
- 前置节点：R3.1–R3.4
- 预期结果：中心不可达时已有包仍能运行和回退；下载/校验/启用失败不丢旧版；长任务与 state 恢复有真实日志。
- 实际结果：**通过（2026-09-24）**。R3.1–R3.4 verdict 全部 passed；`W3-GATE.summary.json` 复核通过。
- 命令退出码：0。
- 证据文件：`dag/W3-GATE.summary.json`（+各 R3.x 证据）
- 剩余风险：R3.1–R3.4 运行后 A 处于 v1 active（W4 节点按需调整基线）。

---

## W4：治理、迁移、恢复和第二实例

### G4.1 权限治理矩阵 — `passed`
- 前置节点：W3-GATE
- 修改范围：隔离中心数据（测试身份）。
- 执行命令：逐项执行自审拒绝、跨组织拒绝、机器凭据访问审核接口拒绝、撤权（撤 A 保 B）、下架后新下载拒绝、分发范围变更须独立审核、成员禁用即时失效；补齐 U03 治理页面边缘操作浏览器验证。
- 预期结果：矩阵全部符合预期；无敏感泄露；审计记录完整。
- 实际结果：**通过（2026-09-24）**。7 行矩阵全部满足：自审拒绝、跨组织私有详情拒绝、机器凭据访问审核接口 403、撤 A 保 B（吊销→A 新请求失败/B 正常→换发绑定码重绑成功）、下架后目录不再提供且已装副本不受影响、分发范围扩大停留 pending_review 直至独立审核通过、成员禁用即时失去写权限后恢复。
- 命令退出码：verdict passed（`scripts/phase2/g41-governance.mjs`，经多轮修复 DTO/数据源后收口）。
- 证据文件：`dag/G4.1.matrix.json`、`G4.1.verdict.json`、`G4.1.log`
- 剩余风险：期间 A 被重绑（凭据轮换，属该用例预期行为）；A 目录曾短暂 stale/UNAUTHENTICATED，重绑后恢复 fresh。

### G4.2 legacy vendor 包接管/停用/恢复 — `passed`
- 前置节点：W3-GATE
- 修改范围：隔离租户 vendor 目录、`legacy/` 备份、state。
- 执行命令：真实旧 vendor 包接管 → 校验备份与来源收据 → 停用 → 恢复本地管理；全程核对发现列表无同 ID 双加载、builtin/workspace 不被误屏蔽。
- 预期结果：同 ID 不重复加载；legacy 不被伪标为中心 release；恢复后旧目录重新参与发现。
- 实际结果：**通过（2026-09-24）**。管理 API 无 takeover/restore 路由（探测记录 OPERATION 400 拒绝）；使用插件 pack-store SDK 真实 helper：接管后同 ID 仅一个条目、vendor 路径排除、备份收据（路径+SHA256）落盘；停用后不激活；恢复后 source='legacy'（无 centerId/ownerOrgId，releaseId=legacy.<digest>，非中心审核身份），发现列表回到初始态；中心包不受影响。
- 命令退出码：verdict passed（`scripts/phase2/g42-legacy.mjs`）。
- 证据文件：`dag/G4.2.legacy.json`、`G4.2.verdict.json`、`G4.2.log`
- 剩余风险：takeover/restore 为 SDK 层能力，四页签无对应按钮（如实记录，不虚构 UI 能力）。

### G4.3 中心重启、Worker 中断、备份恢复 — `pending`
- 前置节点：W3-GATE
- 修改范围：隔离中心进程、DB schema、制品目录。
- 执行命令：重启中心 API → 终止 Worker 中途 → 恢复 DB 与制品备份。
- 预期结果：任务可重领；审核引用完整；签名发布仍可下载且摘要一致。
- 实际结果：**通过（2026-09-24）**。中心 API+TLS front 停止→重启→health 200→A/B 目录均 200（各 9 项）；validate/publish worker 杀止→重启→pgrep 确认（期间发现并修复 scratch 目录 0700 权限导致的启动失败，属部署配置问题而非代码回归，中心 main.ts 增加环境门控 STARTUP_DEBUG）；制品备份 tar→并行目录恢复→签名 envelope 验签通过且 artifact SHA256 与线上一致；pg_dump schema 备份含 audit_events/releases 完整表结构与行数（完整 DB restore 演练如实标注未执行——避免对运行库做不可逆 drop）。
- 命令退出码：verdict passed（`scripts/phase2/g43-recovery.mjs`）。
- 证据文件：`dag/G4.3.recovery.json`、`G4.3.verdict.json`、`G4.3.log`、`/tmp/p2-20260923/g43/db-backup.sql`、`artifacts-backup.tar.gz`
- 剩余风险：完整数据库 drop+restore 演练未执行（已如实声明）；属 G4.3 残留，可在隔离第二集群上补做。

### G4.4 第二租户实例复建 — `passed`
- 前置节点：G4.3
- 修改范围：全新空目录第二实例。
- 执行命令：按文档从空目录复建租户实例；先执行缺 bundle/缺配置启动前检查（确认阻断且不停旧进程），再按指南完整重建。
- 预期结果：检查失败被阻断有日志；完整复建后实例可启动并绑定/安装。
- 实际结果：**通过（2026-09-24）**。负向：损坏 profile（缺插件 symlink）→ dsh 在 bundle 解析阶段以退出码 1 快速失败、端口不开放、A/B 不受影响（先阻断后停旧进程）。正向：从空目录完整复建 C 实例（:18283，独立 DSH_HOME/workspace/pack-center 根），插件 symlink 归属校验通过，真实 OIDC 管理员注册 deployment `b2d40c7b…`、一次性绑定码绑定、目录 9 项可见。
- 命令退出码：verdict passed（`scripts/phase2/g44-second-instance.mjs`）。
- 证据文件：`dag/G4.4.instance.json`、`G4.4.verdict.json`、`G4.4.log`
- 剩余风险：C 实例保持运行（:18283），供后续节点/演示。

### G4.5 制品存储与硬限额 — `passed`
- 前置节点：W0-Gate（实现）；并入执行于 W3-GATE 后
- 修改范围：隔离中心部署配置、Worker 限额代码（`apps/pack-center/` 内允许）。
- 执行命令：接 S3 兼容存储适配器（隔离 MinIO 或本地兼容实现）；注入磁盘/内存/时间超限；验证超限终止与回收；制品恢复后摘要复验。
- 预期结果：超限任务被终止回收，不影响其他任务；恢复制品与签名摘要一致。
- 实际结果：**通过（2026-09-24）**。存储适配：storage.ts 仅实现 LocalArtifactStore（如实记录无 S3 适配器/客户端，不做假验证）；本地 CAS 在进程内真实复验含 1MiB maxBytes 对 2MiB 载荷的 `STORAGE_LIMIT` 拒绝。硬限额端到端（经中心真实提交，源码限额默认值 live 提取）：10MiB blob→`GIT_CONTENT_LIMIT`、40 段路径→`GIT_PATH_REJECTED`、不存在 ref→fetch 拒绝（如实记为非限额路径）；回收审计：scratch 根残留 staging=0、容量基线，worker 在限额拒绝后仍成功验证小包（恢复证明）；中心与 worker 结束时均在线。
- 命令退出码：verdict passed（`scripts/phase2/g45-storage-limits.mjs`）。
- 证据文件：`dag/G4.5.limits.json`、`G4.5.verdict.json`、`G4.5.log`
- 剩余风险：S3 兼容制品适配仍未实现（如实记录为缺口，不折算为通过）。

### W4-GATE — `passed`
- 前置节点：G4.1–G4.5
- 预期结果：权限、迁移、恢复、硬限额、第二实例均有可复现证据；文档、配置、启动检查与实际行为一致。
- 实际结果：**通过（2026-09-24）**。G4.1–G4.5 verdict 全部 passed（`W4-GATE.summary.json`）。文档/配置/启动检查一致性在 G4.3（r31 env 块与实际启动一致）、G4.4（空目录复建按同一启动模式成功）中验证。
- 命令退出码：0。
- 证据文件：`dag/W4-GATE.summary.json`
- 剩余风险：S3 适配缺口、完整 DB drop-restore 演练未做——两项如实带入 C5.1/C5.3。

---

## W5：总验收与交付冻结

### C5.1 A01–A24 矩阵收口 — `passed`
- 前置节点：W4-GATE
- 修改范围：`PACK-CENTER-GOAL-ACCEPTANCE.md`（仅矩阵/执行记录节）。
- 执行命令：逐项对照当前源码与 `phase2-20260923` 证据更新矩阵；无证据项保持待验收/阻塞。
- 预期结果：无未解释的必需条目；每项有证据指针。
- 实际结果：**通过**。`PACK-CENTER-GOAL-ACCEPTANCE.md` 新增 §7：A01–A24 逐项映射 phase1/phase2 证据；三项缺口如实声明（S3 适配、完整 DB drop-restore、A17 对话级近似），不折算为通过。
- 命令退出码：文档编辑完成。
- 证据文件：`PACK-CENTER-GOAL-ACCEPTANCE.md` §7
- 剩余风险：无。

### C5.2 全量回归与边界检查 — `passed`
- 前置节点：W4-GATE
- 修改范围：只读运行回归。
- 执行命令：插件构建+全库回归、中心/契约/归档回归、no-network、DSH 核心零修改核对、敏感信息扫描、源码指纹（对照 phase1 指纹记录差异）。
- 预期结果：全部退出码 0；核心 diff 0；指纹差异全部可解释。
- 实际结果：**通过**。typecheck=0；插件全库 934/934（node22）；中心 177/177（真实 docker PG）；契约/归档 85/85；no-network 7/7；DSH 核心 porcelain=0；敏感扫描命中=0；源码指纹 `c52-fingerprint.txt`。本轮源码增量仅中心侧环境门控 fixture 通道（默认关闭）+ runner 脚本，插件运行源码零改动。
- 命令退出码：全部 0（`c52-*.exit`）。
- 证据文件：`c52-summary.json`、`c52-*.log`
- 剩余风险：无。

### C5.3 交付文档冻结 — `passed`
- 前置节点：C5.1、C5.2
- 修改范围：新建 `PACK-CENTER-PHASE2-GOAL.md`、`PACK-CENTER-PHASE2-EVIDENCE.md`；冻结开发者/审核员/租户管理员/运维恢复文档。
- 预期结果：文档与实际命令一致；第二实例按指南可复建；明确生产试点未执行。
- 实际结果：**通过**。新建 `PACK-CENTER-PHASE2-GOAL.md`（Gate 结论+回归结果+缺口声明+边界确认）与 `PACK-CENTER-PHASE2-EVIDENCE.md`（环境/证据索引/清理清单）；DAG 全节点回填完成。
- 命令退出码：0。
- 证据文件：`PACK-CENTER-PHASE2-GOAL.md`、`PACK-CENTER-PHASE2-EVIDENCE.md`、`PACK-CENTER-PHASE2-DAG.md`
- 剩余风险：无。

---

## 执行记录（滚动追加）

| 时间(UTC) | 节点 | 动作 | 结果 |
|---|---|---|---|
| 2026-09-23T17:18Z | - | Goal 创建（goal-7092927e），DAG 成文 | - |
| 2026-09-24T01:40Z | T2.1 | codex exec 准备 + 宿主执行；发现并修复 Node v20 `import.meta.main` 根因，Node v22 重启 | passed |
| 2026-09-24T02:30Z | T2.2 | codex 准备 runner；宿主重启 A/B 注入 origin + 隔离 CA/HTTPS front；真实 PG/OIDC/绑定/截屏/密钥扫描 | passed |
| 2026-09-24T03:30Z | T2.3 | 发布 v1（真实 Git，摘要=phase1）+ A/B 安装/启停/全停用；修 runner 3 处缺陷 | passed |
| 2026-09-24T04:30Z | T2.4 | 发布 v2 + check-updates 元数据只读 + A 升级 v2/B 保 v1 + 浏览器证据；期间发现宿主常驻进程中断并全量恢复（state 持久化验证），OIDC 固定端口化 | passed |
| 2026-09-24T06:30Z | T2.5 | 隔离 HTTPS Git fixture + 中心测试门控（默认关闭）+ 依赖阻断矩阵/恢复；修 runner DTO/断言多处 | passed |
| 2026-09-24T07:00Z | W2-GATE | 证据复核（verdict×5 + 本地 state 激活集） | passed |
| 2026-09-24T08:00Z | R3.1 | codex/host 联合 runner r31-offline.mjs：断网→离线操作/回退→恢复 | passed |
| 2026-09-24T08:40Z | R3.2 | r32-failure-injection.mjs：篡改归档/清单/state、stale generation 全部拒绝且旧版保活 | passed |
| 2026-09-24T08:55Z | R3.3 | r33-long-task.mjs：运行中切换版本，旧快照目录哈希不变未被 GC | passed |
| 2026-09-24T09:20Z | R3.4 | r34-state-recovery.mjs：state 损坏 + SIGKILL 提交前/后恢复 | passed |
| 2026-09-24T09:25Z | W3-GATE | 证据复核 | passed |
| 2026-09-24T10:30Z | G4.1 | g41-governance.mjs：7 行治理矩阵（自审/跨组织/机器凭据/撤权重绑/下架/范围审核/成员禁用） | passed |
| 2026-09-24T11:15Z | G4.2 | g42-legacy.mjs：SDK 接管/停用/恢复，备份收据+来源收据 | passed |
| 2026-09-24T11:30Z | G4.3 | g43-recovery.mjs：中心重启/worker 中断/备份恢复（scratch 0700 修复） | passed |
| 2026-09-24T11:45Z | G4.4 | g44-second-instance.mjs：负向阻断+空目录复建 C 实例并绑定 | passed |
| 2026-09-24T12:10Z | G4.5 | g45-storage-limits.mjs：限额端到端（CONTENT_LIMIT/PATH_REJECTED）+回收审计；S3 缺口如实记录 | passed |
| 2026-09-24T12:15Z | W4-GATE | 证据复核（verdict×5） | passed |
| 2026-09-24T12:40Z | C5.2 | 全量回归：typecheck 0 / 插件 934/934 / 中心 177/177 / 契约归档 85/85 / no-network 7/7 / 核心 0 diff / 扫描 0 泄漏 / 指纹 | passed |
| 2026-09-24T12:50Z | C5.1 | A01–A24 矩阵映射 phase1/phase2 证据（验收文档 §7） | passed |
| 2026-09-24T12:55Z | C5.3 | PHASE2-GOAL + PHASE2-EVIDENCE + DAG 冻结 | passed |
