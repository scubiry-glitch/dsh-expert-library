# macro-capital-analyst 真实提交链路证据

本次验证使用隔离 PostgreSQL、隔离中心 HTTP 服务、隔离 OIDC 测试身份和真实 GitHub HTTPS 来源；没有连接现有 DSH 实例，也没有修改生产配置。

## 来源

- Git：`https://github.com/weixkcornell/macro-capital-analyst.git`
- ref：`main`
- 固定 commit：`f42bf4c8068294726ab7c780fe23ad121d72f34e`
- 包 ID：`macro-capital-analyst`
- 版本：`2.3.0`
- 包自检：通过（1 expert、2 scenarios、2 teamTemplates、2 outputTemplates、1 qualityPolicy、1 knowledgeProvider）

## 链路结果

1. 管理员创建 `macro` 组织和独立审核组织。
2. 邀请开发者登录，创建 `macro-capital-analyst@2.3.0` 草稿。
3. API 返回 `202`，异步 Worker 从 GitHub 固定 `main` 对应 commit 并生成报告、归档和预览。
4. 报告有效，提交进入送审状态。
5. 不同用户的授权审核员批准固定快照。
6. Publisher 对同一固定归档签名并完成发布。

最终观察：`submission=approved`、`release=published`。

## 兼容性修正

该包的 `pack.json` 使用历史裸 ID `macro-capital-analyst`。设计文档将 `orgslug.packslug` 定义为建议，而非所有历史包的硬性要求；中心现改为：带点号的 ID 必须使用所属组织前缀，无点号的安全旧包允许登记，但仍由全局唯一键和组织所有权约束防止冲突。提交服务针对性回归为 `9/9`，中心完整回归为 `177/177`（其中包含本次真实 GitHub 链路）。

工作区中已安装的 `macro-capital-analyst@2.2.0` 未被修改；它仍是本地工作区来源，不等于此次 GitHub `2.3.0` 发布已自动安装到 DSH。

两份包均通过同一 V2 loader 的只读加载检查：`2.2.0` 和 `2.3.0` 均为 1 个 expert、2 个 scenario、无 error diagnostics。下一步仍需在隔离 DSH 中完成真实远程安装、显式启用和离线回退；这份加载检查不替代那组验收。
