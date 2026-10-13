# 精简研究 v4（新增版本）

## 交付状态

2026-10-06 已构建并部署到 dsh-web。新增版本 4.0.0，保留原 v2/v3 模板及所有已应用任务。未迁移现有租赁研究、未代用户确认任何计划/正文、未创建真实研究数据。

入口：原 `expert_teams_plan_preview` / `expert_teams_plan_stage` 新增 `research_flow: "compact-v4"`。仍传明确路由的专家名单、分析框架、专家选择回执和 renderer 的报告/设计工艺。Host 构造并展示新 DAG，经用户确认后应用。

使用 `research_flow: "original"` 或省略此字段，保持传入原 profile 的版本和 DAG。保存草稿时记录的是已物化的 v4 profile；后续编辑和恢复不会退回原 DAG。不得给运行中的原团队切换版本。

## 新结构

| 阶段 | 执行与审核 |
| --- | --- |
| 研究设计 | outline_final：问题、至少五章大纲、最小数据可得性探针；独立评审 |
| 提纲确认 | outline_choice：Host 用户确认已审大纲及其输入包 |
| 并行取证 | research_main / research_counter；两名不同专家、独立评审 |
| 正文与内容评审 | writer：证据融合、正文、来源台账；独立专家逐章审核同一个 attempt |
| 正文确认 | report_release：用户确认正文，回执同时绑定已审包 digest |
| 成品与交付评审 | renderer：点睛图、HTML、PDF；指定 design-critic 审核真实浏览器检查及 PDF 首/中/末页 |

五个执行任务、两个用户控制节点。评审作为生产任务的验收活动，不另造复制正文和层层汇总的任务。

## 系统事务

### 提交

`expert_teams_update_task` 使用 `submission_id`、当前 `attempt_id`、完整 `publications`、`output`、`status=in_progress`、`execution_state=awaiting_review`。

- 先读取并验证全部文件路径/名称/字节，随后发布不可变快照。
- 一次 team.json 原子写入提交权威状态。重复请求按提交回执去重，参数冲突拒绝。
- 单个文件/状态写入失败不会让任务成为已完成或解锁下游。失败的文件准备可能留下未引用快照；它们不是已提交版本，不能被下游自动选择。
- 项目 output 文件是可重建投影；team.json、不可变发布物及其回执是权威。现有项目写入补偿机制保留。
- 待审状态本身是持久的派发意图。调度器按 task/run/attempt 幂等投递独立评审；恢复时可重建丢失的待发消息，不依赖队长发送一段提示词。

### 评审与推进

- 必须由指定独立成员提交真实评审；原身份、冻结材料、文件哈希、机器检查、工艺和质量预算门保留。
- 正文 pass 还需 `review_audit`：正文/台账哈希、PASS 结论、逐章复核笔记。
- 成品 pass 还需实际 visual-audit：HTML/PDF 哈希、DOM/宽窄视口/交互/可访问性检查、PDF 首中末页渲染回执。Host 重渲染 PDF 核对，不接受假页面哈希。
- pass 在同一权威提交内记录评审、集成、已审输入包和任务完成；下游由调度器推进。用户门仍等待用户选择。
- `needs_revision + repair_action=revise`：记录失败证据并在原任务打开下一 attempt，累计修订预算不重置。精确重试不会多扣预算。
- `wait_external`：保留失败和待恢复条件；不把持续远端故障伪装成修复。
- 并发相同评审读取已提交回执，不因验证命令时间信息变化而重复集成或误报冲突。

## 正文版本与已审输入包

- 正文修订留在 writer 原任务 ID 内，以 attempt 区分；历史发布物、失败评审和修订预算保留。
- 已审输入包绑定 task/attempt/run、独立评审事件和人、审核笔记摘要、系统推进事件、全部发布文件哈希及固定上游输入。
- 下游绑定 release digest 与不可变发布物；文件/审核/来源发生漂移时拒绝执行，不能悄悄换成最新文件。
- 活动页显示已审版本和包摘要，并可下载 `reviewed-input-bundle.json`、正文独立审核笔记。
- 已通过并经用户确认的正文继续保持不可变。若此后用户改变研究范围/正文要求，应走新计划确认，不能静默改写已批准内容。本轮未实现已发布流程的自动回滚重跑。

## 验证与部署证据

- 构建通过：`docs/evidence/compact-v4-build-20261006.txt`。
- 定向回归 **64/64**：`docs/evidence/compact-v4-regression-20261006.txt`。覆盖提交失败回滚、重复/并发请求、真实注册工具的审核+推进、同任务修订、预算、拒绝自审/代理审核、冻结包/输入校验、恢复派发、下载鉴权，以及原 v3、旧输入修订、人审门兼容。
- 所有在线 native agent 空闲后重启 dsh-web，进程 1468015。原队长由已保留的原生生命周期持有者恢复。
- 线上工具 schema 确认含 research_flow / submission_id / publications / review_audit / repair_action。
- 重启前后原研究 planRef、依赖图、T12/T13/T19 历史发布物逐项一致。
- 公网 review.js HTTP 200，包含新版版本标签/已审包入口。核验期间该共享前端文件仍有其他修改，未以整个文件持续相同作为验收条件；本次新增标记已在线确认。
- 结构化部署回执：`docs/compact-v4-deploy-evidence-20261006.json`。

范围说明：上述流程测试使用隔离合成协议数据，不是真实业务研究验收；没有冒充新研究完成，也没有制造业务来源或消费记录。原任务继续走原来的流程和质量门。
