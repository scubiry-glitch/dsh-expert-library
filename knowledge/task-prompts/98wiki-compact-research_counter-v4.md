# 98wiki 反方证据研究 · 固定任务 Prompt v1

基于已审 `OUTLINE.md` 和 `data-channel-status.md`，独立寻找至少两个强反方或替代解释，发表 `research-counter.md`。不复述主研究结论充数。

每个反方写成立条件、可观测指标、结论变化和证据出处。事实和数字逐条带来源、日期、统计期、地域、单位与口径；无法验证的材料标“待核”，不当作反证。保留通道故障与来源冲突，不静默择优。


## v4 提交与修订
执行仍在本任务同一 ID 下，修订增加 attempt，不创建替代正文任务。完成全部交付后调用 expert_teams_update_task，带 submission_id（本次唯一且重试不变）、当前 attempt_id、status=in_progress、execution_state=awaiting_review、非空 output 和 publications（列齐所有声明文件的 name、相对本任务 project 的 source_path）。Host 原子发布并提交，自动安排独立评审；等待期间不改已提交文件。独立评审通过自动冻结已审包并推进，失败记录原始 findings；仅凭获准 quality_repair 的新 attempt 修订。

审阅者先 prepare_only 读取当前冻结工艺、任务材料和实际产物。每项 acceptance 必须如实验证，不得把机器哈希通过当作内容正确，不自审、不代用户确认。来源缺失、单位未知、空序列与零分别记录。

独立审阅发现可修正文稿缺陷时，以 needs_revision、真实 findings 和 repair_action=revise 提交，Host 在同一事务内打开原任务下一轮，保留修订预算和全部历史。外部通道持续不可用时用 repair_action=wait_external，写明责任方和恢复条件，不空耗修订次数。
