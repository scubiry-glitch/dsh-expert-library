---
name: research-v5-renderer
description: 仅用于智见观点驱动 V5 的参考驱动的 HTML/PDF 成品阶段，不加载旧版配额门禁。
---
# 参考驱动的 HTML/PDF 成品

以已确认 report.md 为单源，发布原样 report.md、report.html、report.pdf、craft-evidence.json。阅读冻结的 V5 领域工艺和两份参考；遵循主样式，按表达策划实现神韵、层级与阅读逻辑。参考是视觉设定，不是可复制的旧事实。在 craft-evidence.json 写 referenceApplication=[{source,principle,selector,appliedHow}]：至少把主样式参考的一条设计原则映射到成品中真实存在的元素；另一份参考说明采用或不采用的理由。视觉评审需对照实际宽窄屏与 PDF 判断该原则是否真的改善论证层级和可读性。不要改已审判断；需改则回到正文修订。

先读取已审 figure-plan.json：它按最终章节绑定图的真实观点、逻辑关系、正文源句和台账 claim；renderer 应逐章兑现。craft-evidence.json 必须记录 figurePlanSha256（figure-plan.json 原字节 SHA256），图层台账逐章匹配计划的 chapter、claim、relation、sourceQuote；如改用另一种视觉编码，记录 planChangeReason 说明更准确的原因。逐项核对 expression-brief.md 的点睛图候选。先在已审 report.md 中定位源句、数值、口径与比较关系；高价值且有正文支撑的候选应落地。若未采用，逐图记录具体数据缺口、误导风险或替代呈现；不能因一张趋势图缺完整序列就否决已有对照值可做的图。允许基于已审数据做离散比较或定性机制示意，不得冒充连续趋势；跨口径、跨截止期的值不得用共同刻度暗示可比。每张图用 data-v5-figure 与 craft-evidence.json 的 figures/sourceQuote 绑定，图层不补写未经审核的事实。独立视觉评审对照候选逐图核实实际可见、移动端和 PDF 可读。

每个分析章至少有一张有证据支撑的图，附件不计。每张图以图题陈述真实观点，以视觉编码表达核心逻辑关系，以图注交代口径、时间与解释边界。图层台账逐图记录所属章节、观点、关系、视觉编码、决策含义和已审源句；跨多处证据时用 supportQuotes 逐条绑定。纯数字卡或装饰性图不算点睛图；评审须说明图形怎样支持或限制本章判断，关系不清或暗示错误时退回重做。正文不足以支撑图时退回补证或重组章节，不编图。

真实运行宽窄屏和 A4 渲染，独立视觉评审检查首中末页及逐章图的可读性，不以裁切隐藏溢出。无固定章数或封底引语要求。

## 独立视觉评审的提交契约

评审者在 `review_audit` 中提交 `json visual-audit` 代码块。JSON 顶层必须含 `verdict:"PASS"`、有效 ISO 时间 `checkedAt`、实际检查方法 `method`、`blockers:0`、当前 HTML/PDF 原字节的 `htmlSha256`/`pdfSha256`、实际 PDF 页数 `pageCount`，以及 **非空字符串** `dom`、`wide`、`narrow`、`accessibility`、`references`、`figures`。`references` 须写明 credit-policy 与 designer-paper 两份参考的实际取舍；`figures` 须逐字包含 figure-plan.json 每个 `chapters[].chapter` 标题及对应图的真实判断。`pages` 必须是对象，包含 `first`、`middle`、`last`；各值为含一基页码 `index`、64 位小写十六进制 `sha256` 和非空 `finding` 的对象。没有独立观察的内容不可编造；只填结构而不实际复核不能通过。

页图哈希须与 Host 同法：对当前 PDF 使用 PyMuPDF `page.get_pixmap(matrix=fitz.Matrix(1,1), alpha=False).tobytes('png')`，再对 PNG 字节做 SHA256；页序为第一页、`len(doc)//2` 的零基页、末页。不要改用 `dpi=110`、文本层或渲染方的其他截图回执。先本地检查完整 JSON 与实际哈希，再提交一次；失败按具体字段修正。

## 提交

遵循 Host 的 current_action，以本任务发布声明为准。在原任务同一 attempt 内修订，不为提交方式错误新建替代任务。内部材料由 Host 校验并锁定后自动流转；只有正文和成品进行独立评审，不把内部材料称为已审结论。提交失败按具体错误重试，不能伪造回执。
