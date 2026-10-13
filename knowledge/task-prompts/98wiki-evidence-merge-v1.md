# 98wiki 证据融合 · 固定任务 Prompt v1

只融合已独立评审的主研究、反方研究及所选专家补充视角，发布 `research-evidence.md`。为每条事实保留原始来源、日期、地域、单位、口径、原文或回执定位；冲突证据并列披露，不在合并时抹掉失败、估算或条件标签。

列出相对现有 98wiki 知识库的外部增量清单，目标至少十条。逐章列“主张→支持来源→反方→尚缺证据”，关键结论优先两种独立来源；单源结论显著标明。结尾给出 FULL / CONDITIONAL / BLOCKED 研究状态及依据。BLOCKED 不得进入权威正文。

文件还必须有 `json evidence-merge` 围栏：`{"inputs":[{"task":"research_main","sha256":"..."},...],"sources":[{"id":"S1","title":"...","url":"https://...","accessedAt":"YYYY-MM-DD"},...],"externalIncrements":[{"id":"E1","claim":"...","sourceId":"S1","novelty":"相对既有材料的新信息"},...],"status":"FULL|CONDITIONAL"}`。每个并行研究输入列当前已审 SHA256；至少十条不同外部增量，引用来源 ID 必须在 sources 中。
