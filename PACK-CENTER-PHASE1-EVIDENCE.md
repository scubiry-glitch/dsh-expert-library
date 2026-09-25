# 第一阶段验收证据：开发者自助提交与平台审核发布

日期：2026-09-24（Asia/Singapore）。实现根目录：`/root/zhijian/dsh-pack-center-dev.ZGtty5`。本文件只覆盖 W0 准备和 W1 开发者/平台发布闭环；租户在 **设置 → 领域包** 中的安装、更新、回退，以及双 DSH 版本运行属于下一阶段。

## 真实公开样例

来源：<https://github.com/weixkcornell/macro-capital-analyst.git>，V2 合法包 `macro-capital-analyst`。

| 样例 | 固定 commit | report SHA-256 | content-tree SHA-256 | artifact SHA-256 | 文件数/字节数 |
|---|---|---|---|---|---|
| 2.2.0 | `96548f280d7bdeab8f5167a6c21b429d1a7153f3` | `77279e79e1417b8277f32d2e99303c054e88f78529ec7e481c20d2fac0f51821` | `22b71f525cd339683947de438842edf12f5c794aa3c2a7a228fcf56a3305734b` | `63279f9fe60412169806ababfddf026c0d473190ce1bbfdb930e40ef2b72b8ff` | 22 / 113664 |
| 2.3.0 | `f42bf4c8068294726ab7c780fe23ad121d72f34e` | `889366b441f09a30511c3ffaa7d1306402b5911751e996f9b7b5ce132a5c3382` | `7c0eb511d79f2e4a20d7f1cfe45a7e0195c679e8485efd880853390f62016696` | `3d3fac90491ca858a16319c7b58db8fa45ea78840e92f1bd101cfa7fc69077e0` | 27 / 158720 |

完整 JSON：`artifacts/pack-center/phase1-20260924-final/public-sample-versions.json`。

## 可复现环境与边界

环境版本和清理规则见 `artifacts/pack-center/phase1-20260924-final/environment.txt`。测试使用 `postgres:17-alpine@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995`、Node `v22.23.2`、Chromium `140.0.7339.16`，OIDC、HTTP、数据库 schema、Git scratch 和 artifact store 均为测试自有隔离资源，测试结束清理。源码集合指纹为 `3aaec79d73b61945d59792998259807cad82427ad7c0e6dade91f4548970425e`，完整条目见 `source-fingerprint.json`。

本轮只在隔离实现树中工作；未修改 DSH 核心、生产服务、DNS、凭据或公开 Git 仓库，也没有生产重启/部署。边界记录见 `repository-state.txt`；工作树存在 78 个有意保留的实现和证据差异，`git diff --check` 为 0。

## S1 验收索引

| 验收 | 结果 | 证据与复现 |
|---|---|---|
| S1-01 环境与样例 | 通过 | `environment.txt`、`source-fingerprint.json`、`public-sample-versions.json`；真实 PostgreSQL/OIDC/中心 API/校验 Worker/发布 Worker/制品目录均由测试启动并清理。 |
| S1-02 网页提交 | 通过 | `browser-public-github.tap`；`browser-public-github/summary.json` 记录真实公开 Git、submission/snapshot/release/deployment ID，以及刷新后的固定校验结果。 |
| S1-03 失败拒绝 | 通过 | `git-snapshot.tap` 17/17、`center-stage.tap` 70/70；覆盖错误结构、错误 ref、抓取失败、重定向/SSRF、文件/字节/对象/诊断/时间超限、脚本声明不执行及无发布残留。 |
| S1-04 退回修订 | 通过 | `browser-public-github/summary.json`：`reviewRevision=true`、旧审核和快照保持不变；截图 `07-independent-revision-request.png`、`08-approved-published-revision.png`。 |
| S1-05 权限隔离 | 通过 | 浏览器链验证作者自审和匿名机器访问拒绝；`real-github-flow.tap` 验证机器审核返回 403（`HUMAN_REQUIRED` 或 `HUMAN_AUTHENTICATION_REQUIRED`）、作者自审拒绝、跨组织读取拒绝；`auth-governance-deployments.tap` 43/43。 |
| S1-06 固定快照 | 通过 | `center-stage.tap` 首个用例在送审后移动隔离 Git 分支，发布 Worker 不再抓取变化 ref；`real-github-flow.tap` 和网页链验证 `fixedCommit=true`、批准快照/发布/下载摘要一致。 |
| S1-07 并发与重试 | 通过 | `center-stage.tap` 70/70，包含并发审核仅一次有效决定、并发发布租约、发布失败重试和冻结 envelope/签名不可覆盖用例。 |
| S1-08 签名与授权下载 | 通过 | 网页链 `signedPublication=true`、`signatureVerified=true`、`authorizedHttpDownload=true`、`anonymousDownloadRejected=true`；`real-github-flow.tap` 另验证两个机器身份隔离、旧 grant 吊销和重复发布摘要不变。 |
| S1-09 回归与收口 | 通过 | `build-plugin-rerun.log`、`build-center-rerun.log` 均 exit 0；`center-stage.tap` 70/70、`shared.tap` 85/85、公开 Git Chromium 1/1、真实 HTTP 1/1；`repository-state.txt` 和源码指纹已收口。 |

## 关键业务链记录

Chromium 公开 Git 链产生：首次提交 `8bb7b4d6-1bc2-4dac-93f3-2be2b0f6875c`、修订提交 `671a2e65-008b-4e79-a35a-c980aa2fb20c`、首次快照 `dc657d64-849c-4590-a026-a68210dfc6ed`、修订快照 `3ef74f48-966f-4dda-a8d9-39c1fe336a74`、release `19f7981f-46f4-49c5-8404-a4c6044cf451`。修订从公开 commit `96548…` 切换到 `f42bf…`，发布归档 SHA-256 为 `3d3fac…77e0`，签名清单、内容树和报告摘要均复验成功。

真实 HTTP 链的摘要还记录 `duplicatePublicationUnchanged=true`、`twoMachineIdentityIsolation=true`、`oldGrantRejectedAfterYank=true`。浏览器不持有机器 token（`noBrowserMachineToken=true`），机器下载只通过授权部署点 HTTP 身份完成。

## 范围结论

S1-01–S1-09 已有当前源码、当前命令和当前数据证据，第一阶段 Goal 可以标记完成。包 ID 继续按当前契约验收：新包推荐 `orgslug.packslug`，安全历史裸 ID `macro-capital-analyst` 可接受；没有重命名公开仓库。整体 A01–A24 不在本文件中提前宣称完成，下一阶段从租户 **设置 → 领域包** 的真实安装/更新/回退和双 DSH 运行开始。
