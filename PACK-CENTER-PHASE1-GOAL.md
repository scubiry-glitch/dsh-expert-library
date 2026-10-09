# 第一阶段 Goal：开发者自助提交与平台审核发布

日期：2026-09-24。状态：已完成（S1-01–S1-09 全部通过）。对应开发计划 W0 准备 + W1 发布闭环。

## 1. 目标与交付物

开发者将真实公开 Git 仓库中的 V2 领域包提交到独立中心，在网页查看校验报告、接收退回意见并创建修订；独立审核员审核固定快照并批准，发布 Worker 生成不可覆盖的签名发布物。授权部署点机器身份能下载，并验证下载内容就是批准内容。

本阶段交付一个可复现的审核发布闭环、一份真实包的发布证据、双版本样例基线、隔离环境清单及逐项验收索引。完成本阶段不等于领域包中心首版整体完成。

租户端的产品入口已确定为 **设置 → 领域包**。实际安装、启用、更新、回退、两个 DSH 的版本分叉属于下一阶段；本阶段只验证机器分发出口，不将下载成功认作租户已经安装或启用。

## 2. 验收标准

| 编号 | 操作与通过条件 | 必需证据 | 对应总验收 |
|---|---|---|---|
| S1-01 环境与样例 | **通过** | `artifacts/pack-center/phase1-20260924-final/environment.txt`、`source-fingerprint.json`、`public-sample-versions.json`；真实 PostgreSQL/OIDC/中心 API/校验 Worker/发布 Worker/制品目录均由测试启动并清理。 | W0；A23/A24 准备 |
| S1-02 网页提交 | **通过** | `browser-public-github.tap`；`browser-public-github/summary.json` 记录真实公开 Git、submission/snapshot/release/deployment ID，以及刷新后的固定校验结果。 | A01；A21 中心部分 |
| S1-03 失败拒绝 | **通过** | `git-snapshot.tap` 17/17、`center-stage.tap` 70/70；覆盖错误结构、错误 ref、抓取失败、重定向/SSRF、文件/字节/对象/诊断/时间超限、脚本声明不执行及无发布残留。 | A02 应用校验部分 |
| S1-04 退回修订 | **通过** | `browser-public-github/summary.json` 的 `reviewRevision=true`、`oldReviewAndSnapshotUnchanged=true`；截图 `07-independent-revision-request.png`、`08-approved-published-revision.png`。 | A03 |
| S1-05 权限隔离 | **通过** | 浏览器链验证作者自审和匿名机器访问拒绝；`real-github-flow.tap` 验证机器审核 403、作者自审拒绝、跨组织读取拒绝；`auth-governance-deployments.tap` 43/43。 | A04 |
| S1-06 固定快照 | **通过** | `center-stage.tap` 首个用例在送审后移动隔离 Git 分支，发布 Worker 不再抓取变化 ref；`real-github-flow.tap` 和网页链验证 `fixedCommit=true`、批准快照/发布/下载摘要一致。 | A05 |
| S1-07 并发与重试 | **通过** | `center-stage.tap` 70/70，包含并发审核仅一次有效决定、并发发布租约、发布失败重试和冻结 envelope/签名不可覆盖用例。 | A06 |
| S1-08 签名与授权下载 | **通过** | 网页链 `signedPublication=true`、`signatureVerified=true`、`authorizedHttpDownload=true`、`anonymousDownloadRejected=true`；`real-github-flow.tap` 另验证两个机器身份隔离、旧 grant 吊销和重复发布摘要不变。 | C06/C07；A07/A08 分发部分 |
| S1-09 回归与证据收口 | **通过** | `build-plugin-rerun.log`、`build-center-rerun.log` 均 exit 0；`center-stage.tap` 70/70、`shared.tap` 85/85、公开 Git Chromium 1/1、真实 HTTP 1/1；`repository-state.txt` 和源码指纹已收口。 | A23 阶段部分 |

S1-02、S1-04、S1-08 的正常业务链以同一个真实公开 Git 包贯通。需要改分支、恶意输入或故障注入的用例使用隔离 Git/测试环境，避免修改外部仓库。隔离 fixture 的成功不能替代公开 Git 正常业务链。

包身份按当前契约验收：新包推荐 `orgslug.packslug`；带点号的 ID 必须属于当前组织前缀；安全的历史裸 ID 可接受，但全局唯一、组织归属及提交/包清单/发布清单一致性仍必须满足。无需为验收擅自重命名外部仓库。

S1-03 的应用层超限拒绝不等于部署硬配额通过。S3、磁盘/内存/时间部署硬限额、完整备份恢复、legacy 迁移和第二 DSH 复建仍按 W4 验收；本阶段不将相关 A02/A22/A24 整项提前标为通过。

## 3. Goal 完成判据

S1-01–S1-09 全部有当前源码的有效通过证据，且正常业务链从公开 Git 的网页提交贯通到签名校验下载，才将**本阶段 Goal**标为完成。历史测试数字、文档、截图或单独组件通过不能替代对应完整行为。首版总目标 A01–A24 继续保留未完成状态。

实现目录：`/root/zhijian/dsh-pack-center-dev.ZGtty5`。阶段证据保存在其 `artifacts/pack-center/phase1-<run-id>/`；索引记录源码版本及未提交差异指纹、环境版本、命令、退出码、预期/实际结果和脱敏证据路径。只清理本轮唯一标识的隔离资源。

本阶段继续沿用现有范围：不修改 DSH 核心、生产服务、正式 DNS、生产凭据及生产启动接线；不自动推送代码、修改公开仓库或执行公开/生产部署。

## 4. 启动基线与执行记录

2026-09-23 已创建活动 Goal，未指定 token 预算。2026-09-24 完成当前源码下的公开 Git 网页链、真实 HTTP 链、负向/并发/重试回归和证据收口。

最新隔离代码与 `PACK-CENTER-MACRO-CAPITAL-EVIDENCE.md` 显示：`macro-capital-analyst@2.3.0` 已有 approved/published 记录，提交服务已接受安全历史裸 ID。此记录纠正上一轮文档的强制命名空间阻塞判断；仍须核验原始证据、当前源码及完整网页/下载链，不能直接将本阶段判为完成。

| 验收 | 当前状态 | 证据 |
|---|---|---|
| S1-01 | 已通过 | `PACK-CENTER-PHASE1-EVIDENCE.md` §环境与样例 |
| S1-02–S1-08 | 已通过 | `PACK-CENTER-PHASE1-EVIDENCE.md` §S1 验收索引与关键业务链记录 |
| S1-09 | 已通过 | `PACK-CENTER-PHASE1-EVIDENCE.md` §S1 验收索引；构建/70+85 回归/指纹/差异检查均有 artifact |

关联：[开发计划](PACK-CENTER-DEVELOPMENT-PLAN.md)、[总目标验收](PACK-CENTER-GOAL-ACCEPTANCE.md)、[业务目标](PACK-CENTER-BUSINESS-OBJECTIVE.md)。
