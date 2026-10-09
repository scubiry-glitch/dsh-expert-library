# 第二阶段验收证据索引（W2–W5）

日期：2026-09-24（UTC）。run-id：`phase2-20260923`。实现根目录：`/root/zhijian/dsh-pack-center-dev.ZGtty5`。DAG 与逐节点记录：`PACK-CENTER-PHASE2-DAG.md`。执行方式：每个节点由 `codex exec` 子进程撰写 runner（边界+超时+独立日志），宿主侧执行并以真实退出码/证据回填；节点未验证不标通过。

## 隔离环境

| 资源 | 值 |
|---|---|
| DSH A | `DSH_HOME=/tmp/p2-20260923/dsh-a`，profile `p2-a`，:18281，workspace-a，pack-center-a |
| DSH B | `DSH_HOME=/tmp/p2-20260923/dsh-b`，profile `p2-b`，:18282，workspace-b，pack-center-b |
| DSH C（第二实例） | `DSH_HOME=/tmp/p2-20260923/dsh-c`，profile `p2-c`，:18283 |
| 中心 | API :18430 + 隔离 CA TLS front :18431（`https://127.0.0.1:18431`），OIDC :35531（固定端口），PG 容器 `dsh.pack-center.phase2-20260923-t22`（postgres:17.11 pinned，schema `pack_center_phase2`，端口 32796 仅 loopback），签名密钥 `phase2-key`（Ed25519，/tmp 0600） |
| Git fixture | `https://git.fixture.invalid:8443/fixture.git`（:8443 本地 smart HTTPS，隔离 CA 签名；中心经 `PACK_CENTER_GIT_ALLOW_LOOPBACK_FIXTURE` 门控接入，默认关闭） |
| 信任锚 | 签名公钥指纹 `d69b6390…da5f9`（t22-trusted.json）；A/B/C 均以此校验 |
| 凭据卫生 | 机器凭据/绑定码/DB 密码/cookie 仅存 /tmp/p2-20260923/secrets（0700/0600）；全部证据经精确扫描零泄漏 |

真实样例：`macro-capital-analyst` v1=2.2.0（commit 96548f2…）、v2=2.3.0（commit f42bf4c…），三个 SHA-256 摘要与 phase1 逐一匹配（`dag/T2.3.publish.json`、`T2.4.publish.json`）。依赖样例：phase2-dep-a/b（隔离 fixture，实体 ID 互相独立）。Legacy 样例：phase2-legacy-demo。

## Gate 索引

| Gate | 摘要文件 | 节点 verdict |
|---|---|---|
| W2-Gate | `W2-GATE.summary.json` | T2.1/T2.2/T2.3/T2.4/T2.5 |
| W3-Gate | `W3-GATE.summary.json` | R3.1/R3.2/R3.3/R3.4 |
| W4-Gate | `W4-GATE.summary.json` | G4.1/G4.2/G4.3/G4.4/G4.5 |
| W5 | `c52-summary.json`、`c52-fingerprint.txt` | C5.1/C5.2/C5.3 |

关键单点证据（均在 `dag/`，0600）：
- 绑定/凭据：`T2.2.bind.json`、`T2.2.connection-{A,B}.html/png`、`T2.2.secret-scan.txt`
- 安装/启停：`T2.3.publish.json`（摘要对照）、`T2.3.install-{A,B}.json`
- 版本分叉：`T2.4.check-updates.json`（stale/元数据只读）、`T2.4.fork.json`、`T2.4.更新-A.html`、`T2.4.已安装-B.html`
- 依赖阻断：`T2.5.matrix.json`（DEPENDENCY_BLOCKED×2、RELEASE_ACTIVE 阻断链、affected=phase2-dep-a）、`T2.5.recovery.json`
- 断网回退：`R3.1.log`（stale:true、离线 enable v1、中心恢复）
- 失败注入：`R3.2.injections.json`（CONTENT_DIGEST_MISMATCH、签名失败、state 篡改、GENERATION 冲突）
- 长任务快照：`R3.3.snapshot.json`（旧快照目录哈希切换前后不变、未被 GC）
- state 恢复：`R3.4.recovery.json`（损坏非空库、SIGKILL 提交前/后）
- 治理矩阵：`G4.1.matrix.json`（7 行）
- legacy：`G4.2.legacy.json`（接管/停用/恢复、备份收据 SHA256、非中心身份）
- 恢复：`G4.3.recovery.json`（重启/worker/制品验签一致；DB dump 备份）
- 第二实例：`G4.4.instance.json`（负向阻断+C 复建绑定 b2d40c7b、目录 9 项）
- 限额：`G4.5.limits.json`（GIT_CONTENT_LIMIT/GIT_PATH_REJECTED/STORAGE_LIMIT、回收审计、S3 缺口如实记录）

## C5.2 回归（exit code 均为 0）

`c52-plugin-typecheck.log`、`c52-plugin-test.log`（934/934）、`c52-center-test.log`（177/177，真实 docker PG）、`c52-contract-artifact.log`（85/85）、`c52-no-network.log`（7/7）、`c52-fingerprint.txt`；DSH 核心 porcelain=0；敏感扫描命中=0（`/tmp/p2-scan-all.txt` 全模式）。

## 边界

零修改：DSH 核心、生产服务（3080/nginx）、正式 DNS、生产凭据、公开 Git 仓库。零推送、零生产部署。测试自有资源清理清单：PG 容器（ID+标签见 `T2.2.resources.json`）、:18430/18431/35531/8443/18281-18283 常驻进程、/tmp/p2-20260923。

## 已声明缺口

见 `PACK-CENTER-PHASE2-GOAL.md` §4（S3 适配、完整 DB drop-restore、A17 对话级近似、生产试点后置）。
