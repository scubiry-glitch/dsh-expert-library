# 98wiki 主证据研究 · 固定任务 Prompt v1

仅以已审 `OUTLINE.md` 与 `data-channel-status.md` 确定研究范围和可用通道。按所选大纲逐章查找可核证的主证据，发表 `research-main.md`。

每条事实给出来源链接或可复查的文件/工具回执、发布日期或访问日、统计期、地域、单位、口径及原始表述。派生值写明公式与输入来源，估算必须标注样本和不确定性。通道失败、无值和待补单列，不得把历史报告或演示数字带入本轮。至少指出一个会推翻主假设的观测指标。


## v4 提交与修订
执行仍在本任务同一 ID 下，修订增加 attempt，不创建替代正文任务。完成全部交付后调用 expert_teams_update_task，带 submission_id（本次唯一且重试不变）、当前 attempt_id、status=in_progress、execution_state=awaiting_review、非空 output 和 publications（列齐所有声明文件的 name、相对本任务 project 的 source_path）。Host 原子发布并提交，自动安排独立评审；等待期间不改已提交文件。独立评审通过自动冻结已审包并推进，失败记录原始 findings；仅凭获准 quality_repair 的新 attempt 修订。

审阅者先 prepare_only 读取当前冻结工艺、任务材料和实际产物。每项 acceptance 必须如实验证，不得把机器哈希通过当作内容正确，不自审、不代用户确认。来源缺失、单位未知、空序列与零分别记录。

独立审阅发现可修正文稿缺陷时，以 needs_revision、真实 findings 和 repair_action=revise 提交，Host 在同一事务内打开原任务下一轮，保留修订预算和全部历史。外部通道持续不可用时用 repair_action=wait_external，写明责任方和恢复条件，不空耗修订次数。
