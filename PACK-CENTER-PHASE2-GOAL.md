# 第二阶段 Goal：真实租户闭环（W2–W5）

日期：2026-09-24。状态：已完成（W2-Gate、W3-Gate、W4-Gate、W5 收口全部通过，证据索引见 `PACK-CENTER-PHASE2-EVIDENCE.md`）。对应开发计划 W2–W5 波次。

## 1. 目标与交付物

在第一阶段"开发者提交 → 审核 → 签名发布 → 授权下载"之上，完成租户闭环：两个隔离 DSH 部署点从 **设置 → 领域包** 真实绑定中心、下载安装、显式启用、版本分叉、依赖阻断、断网回退、失败保旧、长任务快照、state 恢复；中心治理矩阵、legacy 接管、重启/恢复、第二实例复建与硬限额；最终以 A01–A24 矩阵、全量回归与文档冻结收口。

## 2. Gate 验收

| Gate | 状态 | 摘要 |
|---|---|---|
| W2-Gate | 通过 | A/B 绑定（独立 deploymentId/凭据/密钥指纹，密钥零泄漏）；v1 真实下载安装（三摘要=phase1）默认未启用→显式启停/全停用；A 升级 v2、B 保持 v1，发布不自动切换；依赖阻断链（DEPENDENCY_BLOCKED/RELEASE_ACTIVE）无级联。证据 `artifacts/pack-center/phase2-20260923/dag/T2.*.verdict.json`、`W2-GATE.summary.json` |
| W3-Gate | 通过 | 断网：本地库存可读、check-updates 返回 stale 缓存不误报、离线回退 v1 成功；失败注入：篡改归档/清单/state、stale generation 全部拒绝且旧版保活；长任务切换：旧快照目录哈希不变未被 GC；state 损坏与 SIGKILL 提交前/后恢复。证据 `R3.*.verdict.json`、`W3-GATE.summary.json` |
| W4-Gate | 通过 | 7 行治理矩阵（自审/跨组织/机器凭据/撤权重绑/下架/范围审核/成员禁用）；legacy 接管/停用/恢复（备份收据+非中心身份）；中心重启/worker 中断/制品备份验签一致；空目录复建 C 实例（负向阻断先于停旧进程）并绑定；限额端到端（GIT_CONTENT_LIMIT/GIT_PATH_REJECTED/STORAGE_LIMIT）+回收审计。证据 `G4.*.verdict.json`、`W4-GATE.summary.json` |
| W5 | 通过 | C5.1 A01–A24 矩阵收口（`PACK-CENTER-GOAL-ACCEPTANCE.md` §7）；C5.2 全量回归（见下）；C5.3 文档冻结（本文件、EVIDENCE、DAG） |

## 3. C5.2 全量回归结果（2026-09-24）

| 检查 | 结果 |
|---|---|
| 插件 typecheck / 全库测试 | exit 0 / **934/934**（node22） |
| 中心测试（真实 docker PG 17.11） | exit 0 / **177/177** |
| 协议/归档契约 | exit 0 / **85/85** |
| no-network | exit 0 / **7/7** |
| DSH 核心修改 | **0 文件**（`/usr/lib/node_modules/@deepseek-ai/dsh` porcelain 为空） |
| 敏感信息扫描 | 证据目录命中 **0**（机器凭据/绑定码/DB 密码/会话 cookie 全模式） |
| 源码指纹 | `artifacts/pack-center/phase2-20260923/c52-fingerprint.txt` |

本轮源码增量（隔离树内，均记录于指纹）：中心侧环境门控的 loopback Git fixture 通道（`PACK_CENTER_GIT_ALLOW_LOOPBACK_FIXTURE`，默认关闭时行为与生产规则一致）+ fixture-transport + 启动调试门控；`scripts/phase2/*` 验收 runner。插件运行源码 phase2 期间零改动。

## 4. 已声明缺口（不折算为通过）

1. S3 兼容制品适配未实现（storage.ts 仅 LocalArtifactStore；STORAGE_LIMIT 已在本地 CAS 上真实验证）。
2. 完整数据库 drop-restore 演练未执行（pg_dump 备份与制品恢复验签已完成；避免对运行库做不可逆操作）。
3. A17 长任务为快照级证据（真实切换+目录保持），对话级任务为近似。
4. 生产试点、正式域名、身份服务、生产部署不在本轮范围（沿用第一阶段边界）。

## 5. 边界确认

DSH 核心、生产服务（3080/nginx）、正式 DNS、生产凭据、公开 Git 仓库：零修改。全部验证使用隔离 DSH_HOME/profile/workspace/端口（18281/18282/18283）/schema（pack_center_phase2）/制品目录/测试身份；未自动推送代码、未生产部署。

关联：[开发计划](PACK-CENTER-DEVELOPMENT-PLAN.md) §9、[总目标验收](PACK-CENTER-GOAL-ACCEPTANCE.md) §7、[第二阶段证据](PACK-CENTER-PHASE2-EVIDENCE.md)、[DAG](PACK-CENTER-PHASE2-DAG.md)。
