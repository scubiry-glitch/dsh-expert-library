# 精简研究 v4 · 研究设计

合并研究问题、分析框架、主假设、反证、至少五章大纲和最小数据可得性探针。发布 OUTLINE.md 与 data-channel-status.md。大纲每章至少两个小节，包含视角、证据需求、反方、图位、决策收口；保留既定正文深度门控。OUTLINE.md 明示当前 PROMPT-深度研究.md、98wiki-five-articles-gated-research/SKILL.md、strategy-consulting/SKILL.md 的真实 SHA256，调用既有 craft_gate.sh outline 检查。此步骤在用户确认前仅做最小探针，不批量取数；用户确认后才开始主证据/反证研究。
# 98wiki 三通道预检 · 固定任务 Prompt v1

读取本次提出的 `OUTLINE.md` 中的城市、时段和指标需求。按 Host 注入的 `98wiki-data-channels` 材料，在任何批量取数前对 Wind、贝壳、证研通 dataset 分别执行最小探针；同一课题涉及多个城市时逐城留痕。不要把历史 playbook 的成功案例当作本轮结果。

发布 `data-channel-status.md`：对每个城市×通道列出实际调用时间、调用入口与最小参数（不写凭据）、返回状态/错误码、数据可用性、统计口径、允许的降级路径和是否停止重试。错误、空系列与零值分开记录；积分不足与鉴权失败不重试。无法调用时写“未执行”及原因，不声称已探通。不得编造数据。

文件包含 `json channel-status` 围栏，结构为 `{"cities":["北京","上海"],"researchMode":"FULL|CONDITIONAL|BLOCKED","probes":[...]}`。每城必须各有 `wind`、`beike`、`zyt` 一行；每行写 `city,channel,status,tool,request,reason`。状态仅可为 `available|failed|empty|unconfigured|not_run`。实际调用行另写 ISO `attemptedAt` 与真实响应 SHA256 `receiptSha256`；失败行加 `errorCode,fallback`。未调用行不得伪造调用时间或响应哈希。全部不可用时不得标 FULL。


## v4 提交与修订
执行仍在本任务同一 ID 下，修订增加 attempt，不创建替代正文任务。完成全部交付后调用 expert_teams_update_task，带 submission_id（本次唯一且重试不变）、当前 attempt_id、status=in_progress、execution_state=awaiting_review、非空 output 和 publications（列齐所有声明文件的 name、相对本任务 project 的 source_path）。Host 原子发布并提交，自动安排独立评审；等待期间不改已提交文件。独立评审通过自动冻结已审包并推进，失败记录原始 findings；仅凭获准 quality_repair 的新 attempt 修订。

审阅者先 prepare_only 读取当前冻结工艺、任务材料和实际产物。每项 acceptance 必须如实验证，不得把机器哈希通过当作内容正确，不自审、不代用户确认。来源缺失、单位未知、空序列与零分别记录。

独立审阅发现可修正文稿缺陷时，以 needs_revision、真实 findings 和 repair_action=revise 提交，Host 在同一事务内打开原任务下一轮，保留修订预算和全部历史。外部通道持续不可用时用 repair_action=wait_external，写明责任方和恢复条件，不空耗修订次数。
