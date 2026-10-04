# 渲染审核入口

先接收同版本工艺包的 reviewer 角色正文，再按 [独立审核规则](references/review-v2.md) 与 [验收矩阵](references/acceptance-v2.md) 检查本次固定 MD/HTML/PDF。路径以本技能目录解析。

静态局部预检：`bash <本技能目录>/craft_gate_report.sh <HTML>`。它仅检查可解析章节、局部文本、实际图元素与少量过程标记，不检查实际 AA、算式、PDF 或完整事实，结果不能等同“发布通过”。

使用 Host 对当前字节生成的实际浏览器与计算/PDF回执。非作者逐项记录位置、依据、复算及未决问题；不按“像历史样例”或批量 acceptance=true 放行。
