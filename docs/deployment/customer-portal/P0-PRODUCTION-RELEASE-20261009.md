# 客户工作区 P0 生产发布（2026-10-09）

## 范围

- 客户 `/app` 工作区：动态研究标题与四阶段状态、当前会话统一待办、提问/计划/稿件确认、压缩任务列表、唯一正式报告入口、状态驱动专家人物、人物路线与依赖线。
- 客户页服务端：允许 `sync-context` 动作，提供人物全身像 WebP 素材。
- A/B 共用 DSH 运行时：补充待确认计划的新消息对照和 `sync-context` 动作。C 运行时已含相同能力，保持原版本且未重启。

## 发布记录

- 发布时间：2026-10-09 10:04（Asia/Singapore）。
- 生产入口：<https://zhijian.meizu.life/app>。
- 备份：`/opt/zhijian/customer-p0-backup-20261009T020413Z`（客户页 `server.mjs`、完整 `dist`、A/B 插件两个原文件）。原客户页目录同时保留 `dist.before-p0-20261009T020413Z`。
- A/B 插件仅更新 `lib/index.js` 和 `lib/host/customer-gateway.js` 的 P0 增量，未覆盖 C 的独立运行时或其他插件改动。
- 滚动重启 `zhijian-dsh-demo-a`、`zhijian-dsh-demo-b`；更新客户页文件后重启 `zhijian-customer-portal`。`zhijian-dsh-demo-c` 保持运行。

## 验证

- 发布前本地：客户页 12 项测试通过；后端测试、类型检查和 320/390/1280/1440px 浏览器 QA 通过；人物路线缩放、任务定位、依赖线与动态形态已检查。
- 发布后四个服务均为 `active`；本机和公网 `/healthz`、`/app` 返回 200，专家全身像和头像返回 200。
- 使用生产服务凭据在本机做只读网关核验：A/B/C 的现有客户会话工作区均可读取；B 的已执行团队返回 13 份文档，C 的已执行团队返回 4 份文档。没有对真实客户会话执行写操作。
- 目前生产库中没有仍处于待确认阶段的样本，因此 `sync-context` 的真实客户端点击闭环尚无生产样本；该动作已通过本地测试与接口校验。

## 回退

从上述备份恢复 A/B 插件两个文件和客户页 `server.mjs`、`dist`，依次重启 A、B、客户页服务。C 不需回退。

## 10:15 顶部区域紧凑调整

依据客户反馈压缩 `heroCopy` 与 `workspaceSteps` 的内边距、字号和按钮高度，并同步收紧人物场景，使桌面端顶部整体高度约从 279px 降至 212px，390px 手机端约从 565px 降至 428px。手机端保留每位专家的状态标签，隐藏场景内重复的汇总文字。320/390/1280/1440px 浏览器回归无溢出、脚本错误或人物动画丢失。生产只替换 `dist/style.css`，备份为 `/opt/zhijian/customer-portal/style.before-compact-20261009T021554Z.css`；公网 CSS 与本地构建 SHA-256 一致，`/app` 返回 200。

## 10:18 手机阶段导航单行调整

手机端四个 `workspaceSteps` 阶段同排显示，保留完成图标和阶段名称，详细状态留在按钮提示及无障碍名称中。320/390/1280/1440px 浏览器回归无横向溢出或脚本错误。生产仅更新 `dist/style.css` 与 `dist/app.js` 的对应增量；线上 `app.js` 已有独立的会话列表修复，本次以线上版本为底稿，只加入阶段提示改动。备份：`/opt/zhijian/customer-portal/.backup-workspace-steps-20261009T021858Z`。公网两份文件与发布文件 SHA-256 一致，`/app` 返回 200。
