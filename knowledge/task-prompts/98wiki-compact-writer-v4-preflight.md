# 精简研究 v4 · 证据融合与正文

本任务先融合已审主证据和反证，再生成正文及台账；research-evidence.md 是本任务产物，没有独立 evidence_merge 任务。发布 research-evidence.md、report.md、report-source-ledger.json。

# 98wiki 证据融合 · 固定任务 Prompt v1

只融合已独立评审的主研究、反方研究及所选专家补充视角，发布 `research-evidence.md`。为每条事实保留原始来源、日期、地域、单位、口径、原文或回执定位；冲突证据并列披露，不在合并时抹掉失败、估算或条件标签。

列出相对现有 98wiki 知识库的外部增量清单，目标至少十条。逐章列“主张→支持来源→反方→尚缺证据”，关键结论优先两种独立来源；单源结论显著标明。结尾给出 FULL / CONDITIONAL / BLOCKED 研究状态及依据。BLOCKED 不得进入权威正文。

文件还必须有 `json evidence-merge` 围栏：`{"inputs":[{"task":"research_main","sha256":"..."},...],"sources":[{"id":"S1","title":"...","url":"https://...","accessedAt":"YYYY-MM-DD"},...],"externalIncrements":[{"id":"E1","claim":"...","sourceId":"S1","novelty":"相对既有材料的新信息"},...],"status":"FULL|CONDITIONAL"}`。每个并行研究输入列当前已审 SHA256；至少十条不同外部增量，引用来源 ID 必须在 sources 中。

# 98wiki 权威正文 · 固定任务 Prompt v1

使用已审 OUTLINE.md 与本任务从已审主证据/反证生成的 research-evidence.md，发布唯一业务正文 `report.md`。分析章 H2 标题和顺序逐字对应所选大纲；写卷首速览、总论、逐章五件套、总结与行动、来源披露和章节证据台账。每章给出定位、角色/方案对照、依据、推论与数据、机会与风险；三透彻内容占正文至少一半，并在文末列外部增量清单。

每个数字注明来源、日期、地域、单位、口径；测算给公式和参数，缺值保留条件判断。来源披露逐行给 Wind、政研通、贝壳实际状态。结语有总结正文及收束句。发布前按本任务冻结的报告工艺和上游大纲做源结构预检；若上游证据不足，退回上游，不能凭空补数或让渲染员改正文。

同时发布 `report-source-ledger.json`，格式：`{"schemaVersion":1,"outlineSha256":"...","evidenceSha256":"...","reportSha256":"...","chapters":[{"heading":"实际分析章 H2","parts":{"position":"正文精确摘录","roles":"...","basis":"...","inference":"...","opportunity":"...","risk":"..."},"sourceIds":["S1"],"numericClaims":[{"quote":"正文含数值的精确摘录","sourceId":"S1","date":"YYYY-MM-DD","geography":"...","unit":"...","caliber":"...","kind":"reported|estimated|derived","formula":"仅 derived 必需"}]}]}`。六个 parts 的摘录必须互不重复且真正在对应章出现；每章至少一条来源 ID，依据段在正文中明示该 ID。正文所有带计量单位的数值都应列入 numericClaims。不得在台账中自造来源。


## 独立内容审阅
审阅者逐章核验论证、反证、条件化红线、来源和台账算术。pass 时在 quality_review 的 review_audit 中记录“报告SHA256: <当前正文哈希>”“来源台账SHA256: <当前台账哈希>”“结论: PASS”，逐个实际大纲 H2 下给出有依据的核验笔记。不复制一份正文，不新增 content_review 或 followup 任务。未通过在原 writer 任务修订。


## v4 提交与修订
执行仍在本任务同一 ID 下，修订增加 attempt，不创建替代正文任务。完成全部交付后调用 expert_teams_update_task，带 submission_id（本次唯一且重试不变）、当前 attempt_id、status=in_progress、execution_state=awaiting_review、非空 output 和 publications（列齐所有声明文件的 name、相对本任务 project 的 source_path）。Host 原子发布并提交，自动安排独立评审；等待期间不改已提交文件。独立评审通过自动冻结已审包并推进，失败记录原始 findings；仅凭获准 quality_repair 的新 attempt 修订。

审阅者先 prepare_only 读取当前冻结工艺、任务材料和实际产物。每项 acceptance 必须如实验证，不得把机器哈希通过当作内容正确，不自审、不代用户确认。来源缺失、单位未知、空序列与零分别记录。

独立审阅发现可修正文稿缺陷时，以 needs_revision、真实 findings 和 repair_action=revise 提交，Host 在同一事务内打开原任务下一轮，保留修订预算和全部历史。外部通道持续不可用时用 repair_action=wait_external，写明责任方和恢复条件，不空耗修订次数。

## 提交预检与技术故障（V4）
- evidence-merge.inputs **恰好两项**：research_main、research_counter，绑定已审研究字节。OUTLINE.md 和 data-channel-status.md 不放入此数组。
- 网页来源使用真实 HTTP(S) URL。数据接口本地回执使用 `kind: "provider_receipt"`、`provider`，以及 `receipt: {path, sha256, callPath, callSha256}`；路径相对团队根。callPath 指向真实调用记录 JSON（cmd、attemptedAt、exitCode=0，若有 stdoutBytes 必须匹配响应字节）。不得编造地址或调用记录。机器检查字节和调用记录完整性，不替代独立评审对来源真实性、单位和口径的核验。
- 提交前 Host 执行同一套正文预检，失败返回全部检查类别的错误，尚未冻结发布，也不扣内容修订次数。修正 research-evidence.md 后必须同步 report-source-ledger.json.evidenceSha256；不得改冻结的 attempt 目录。
- Host/网络/来源暂不可用属于技术等待。review 的 repair_action=wait_external 只记录可恢复阻塞，不入账内容失败，不扣修订次数。内容错误才用 revise。不得把预检接口异常写成正文不合格。
- 修订阈值达到后提级，由用户决定是否通过 captain 的 quality_continue 在原任务续跑；不可自批额度，不重建整个团队，不代用户通过正文门。
