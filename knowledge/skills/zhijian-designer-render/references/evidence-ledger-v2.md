# craftEvidence JSON（schemaVersion 1）

这是生产者提供的定位与计算台账，不是通过回执。发布前填入最终 MD/HTML/PDF 的真实 SHA256；Host 对指定字节重新读取、重算与渲染。不得提供自报 PASS、截图通过标志或材料已读声明。

顶层：`{schemaVersion:1,reportSha256:{md,html,pdf},body:{htmlId},chapters:[],calculations:[]}`。body 是 main/article 正文容器，含 MD 完整正文。id 唯一、字母开头、其后仅字母数字_-，最长96字。额外封面封底可在外层，数字仍源于正文。

Span 是 `{markdown:"MD 原文精确子串",htmlId:"对应唯一元素id"}`。markdown 保留原文的强调、引用等语法；先解析为可见文本，再与 HTML 元素文本空白归一后逐字比较。不得用隐藏段落、伪造跨度或占位标记通过检查。

每章：`{heading:"真实 MD h2 标题",htmlId:"章容器id",parts:{quote:Span,roles:Span,basis:Span,inference:Span,opportunityRisk:{opportunity:Span,risk:Span}}}`。全部适用分析章都登记；机会、风险各自独立具名块。元信息章节的例外按写作规范，不通过重命名避检。

反比收益率场景：`{id,kind:"inverse-yield-range",baseYield:"基准百分数",base:Span,scenarios:[{yield:"场景收益率",change:"相对共同基准涨跌",claim:Span}]}`。base 明写共同基准且恰含一个基准百分数；每个独立 claim 恰含其 yield/change 两个百分数，DOM id 各异。按 y₀/y−1 重算，不能换基准。六个章节 part 不可重叠；inference 可包含这些计算子块。

ledger 同报告一起发布为声明的 `craftEvidence` 文件。任何一个报告文件改变后重新计算三 SHA并更新台账；旧 ledger 不得配新文件。不能自动判定的事实与计算，独立审核逐项保留证据和限制，不用空 calculations 数组掩盖正文中的适用公式。
