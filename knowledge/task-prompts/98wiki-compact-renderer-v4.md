# 精简研究 v4 · 成品制作与交付评审

用户确认已审正文后，读取 Host 固定的 writer 已审输入包。本任务同时制作点睛图、HTML、PDF。没有独立 point_figures 或 visual_review 任务。发布 report.md、report.html、report.pdf、craft-evidence.json、reference-map.json、figure-spec.md、figure-fragments.html。正文逐字保持已审版本，新增观点退回研究决策，不能修改渲染副本。

# 98wiki 点睛图 · 固定任务 Prompt v1

从 Host 固定输入读取已审 `report.md`、`OUTLINE.md`与用户放行回执。按每个选定分析章恰好一张图发布 `figure-spec.md` 与 `figure-fragments.html`。规格包含 `json figure-spec` 块，逐图写 `chapter`、`selector`、`claim`、`sourceQuote`、`data`。每项必须指向本章真实正文；图中数字不得新增，不能把“待核”改成事实。图卡顺序与大纲一致，每卡一个 `data-chapter`。采用已冻结的 Finesse 报告工艺，默认可见、无假按钮。正文证据不足时上报上游，不编图。

# 98wiki Designer 渲染 · 固定任务 Prompt v1

逐字节复制已审 `report.md`；用本任务生成且纳入本次独立评审的 `figure-fragments.html` 与 `figure-spec.md` 渲染 `report.html`、`report.pdf`，发布 `craft-evidence.json`、`reference-map.json`。图卡在 HTML 中原样出现一次，逐章顺序不变；PDF 包含图卡文字。用领域包 zhijian-report-craft 和 zhijian-designer-render 的当前冻结版本检查；图文报告 craft evidence 用 schemaVersion 3 的 `figureLayer` 登记本次片段原文、SHA256、章节数组。参考件只取版式结构，映射当前哈希，不能搬示例事实。先完成 Finesse pre-flight，再交由独立视觉专家评审；失败时只修可归因渲染问题，上游正文问题返上游，修复预算耗尽上报。


## 独立交付评审
由指定 design-critic 读取实际页面与 PDF，复核最终包一致性。pass 时 review_audit 提交 json visual-audit 围栏，字段：verdict="PASS",checkedAt=<ISO时间>,method=<实际方法>,blockers=0,htmlSha256,pdfSha256,dom,wide,narrow,interactions,accessibility,pageCount,pages。pages 含 first/middle/last，每行有 index（从1起）、sha256（PyMuPDF 1倍、alpha=false 渲染 PNG 的真实哈希）、finding。Host 重渲染当前 PDF 核对首、中、末页；浏览器宽窄视口、DOM、交互和可访问性必须实际检查。未通过保持原任务修订，严禁声称未做的真机/浏览器核验。


## v4 提交与修订
执行仍在本任务同一 ID 下，修订增加 attempt，不创建替代正文任务。完成全部交付后调用 expert_teams_update_task，带 submission_id（本次唯一且重试不变）、当前 attempt_id、status=in_progress、execution_state=awaiting_review、非空 output 和 publications（列齐所有声明文件的 name、相对本任务 project 的 source_path）。Host 原子发布并提交，自动安排独立评审；等待期间不改已提交文件。独立评审通过自动冻结已审包并推进，失败记录原始 findings；仅凭获准 quality_repair 的新 attempt 修订。

审阅者先 prepare_only 读取当前冻结工艺、任务材料和实际产物。每项 acceptance 必须如实验证，不得把机器哈希通过当作内容正确，不自审、不代用户确认。来源缺失、单位未知、空序列与零分别记录。

独立审阅发现可修正文稿缺陷时，以 needs_revision、真实 findings 和 repair_action=revise 提交，Host 在同一事务内打开原任务下一轮，保留修订预算和全部历史。外部通道持续不可用时用 repair_action=wait_external，写明责任方和恢复条件，不空耗修订次数。
