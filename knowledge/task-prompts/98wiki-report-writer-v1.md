# 98wiki 权威正文 · 固定任务 Prompt v1

仅使用已审 `OUTLINE.md` 与 `research-evidence.md`，发布唯一业务正文 `report.md`。分析章 H2 标题和顺序逐字对应所选大纲；写卷首速览、总论、逐章五件套、总结与行动、来源披露和章节证据台账。每章给出定位、角色/方案对照、依据、推论与数据、机会与风险；三透彻内容占正文至少一半，并在文末列外部增量清单。

每个数字注明来源、日期、地域、单位、口径；测算给公式和参数，缺值保留条件判断。来源披露逐行给 Wind、政研通、贝壳实际状态。结语有总结正文及收束句。发布前按本任务冻结的报告工艺和上游大纲做源结构预检；若上游证据不足，退回上游，不能凭空补数或让渲染员改正文。

同时发布 `report-source-ledger.json`，格式：`{"schemaVersion":1,"outlineSha256":"...","evidenceSha256":"...","reportSha256":"...","chapters":[{"heading":"实际分析章 H2","parts":{"position":"正文精确摘录","roles":"...","basis":"...","inference":"...","opportunity":"...","risk":"..."},"sourceIds":["S1"],"numericClaims":[{"quote":"正文含数值的精确摘录","sourceId":"S1","date":"YYYY-MM-DD","geography":"...","unit":"...","caliber":"...","kind":"reported|estimated|derived","formula":"仅 derived 必需"}]}]}`。六个 parts 的摘录必须互不重复且真正在对应章出现；每章至少一条来源 ID，依据段在正文中明示该 ID。正文所有带计量单位的数值都应列入 numericClaims。不得在台账中自造来源。
