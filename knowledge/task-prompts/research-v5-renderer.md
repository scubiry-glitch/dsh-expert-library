# V5 · 参考驱动的 HTML/PDF 成品

以已确认 report.md 为单源，发布原样 report.md、report.html、report.pdf、craft-evidence.json。阅读冻结的 V5 领域工艺和两份参考；遵循主样式，按表达策划实现神韵、层级与阅读逻辑。参考是视觉设定，不是可复制的旧事实。在 craft-evidence.json 写 referenceApplication=[{source,principle,selector,appliedHow}]：至少把主样式参考的一条设计原则映射到成品中真实存在的元素；另一份参考说明采用或不采用的理由。视觉评审需对照实际宽窄屏与 PDF 判断该原则是否真的改善论证层级和可读性。不要改已审判断；需改则回到正文修订。

先读取已审 figure-plan.json：它按最终章节绑定图的真实观点、逻辑关系、正文源句和台账 claim；renderer 应逐章兑现。craft-evidence.json 必须记录 figurePlanSha256（figure-plan.json 原字节 SHA256），图层台账逐章匹配计划的 chapter、claim、relation、sourceQuote；如改用另一种视觉编码，记录 planChangeReason 说明更准确的原因。逐项核对 expression-brief.md 的点睛图候选：先从已审 report.md 找到可用的原句、数值、口径和比较关系，再选图形。凡高价值且数据已在正文中的候选，应在成品中实现；若放弃，逐图记录具体理由和替代呈现，不得把某张图缺少完整序列扩大为全部候选“数据不足”。可用已有对照值做离散比较或机制示意，但不能伪装成连续趋势；跨口径或不同截止期不共用暗示可比的刻度。图中文字与数字不得超出已审正文，使用 data-v5-figure 与 craft-evidence.json 的 figures/sourceQuote 绑定。独立视觉评审对照候选清单核验实际图卡，而不只检查 PDF 是否有图。

每个分析章至少有一张有证据支撑的图，附件不计。每张图的图题说出真实观点，视觉编码呈现核心逻辑关系，图注说明来源口径、时间和解释边界。图卡不能只把一串数字换成方框；评审应能指出关系如何支持或限制本章判断。图层台账逐图记录所属章节、观点、关系、视觉编码、决策含义与正文源句；若图使用多处证据，补充 supportQuotes 逐条对应，而非只挂一条概括句。逐图对照实际 HTML/PDF；表达不清或暗示错误关系时重做。正文不足以支撑图时退回补证或重组章节，不能造图。

真实运行宽窄屏和 A4 渲染，独立视觉评审检查首中末页及逐章图的可读性，不以裁切隐藏溢出。无固定章数或封底引语要求。

视觉评审的 `review_audit` 使用 `json visual-audit` 围栏：顶层 `verdict:"PASS"`、ISO `checkedAt`、`method`、`blockers:0`、当前 `htmlSha256`/`pdfSha256`、`pageCount`，及六个非空字符串 `dom`/`wide`/`narrow`/`accessibility`/`references`/`figures`。`references` 写出 credit-policy 和 designer-paper 的实际取舍；`figures` 逐字包含每个 `figure-plan.json chapters[].chapter` 标题和逐图判断。`pages` 是含 `first`/`middle`/`last` 的对象；每页有一基 `index`、当前 PDF 页图 `sha256`、实际观察 `finding`。页图按 Host 同法用 PyMuPDF `get_pixmap(matrix=fitz.Matrix(1,1), alpha=False).tobytes('png')` 计算 SHA256，不能沿用渲染方的 110dpi 回执。不得自签或填未做的检查。

仅执行本阶段。读取 Host 下发的已锁定输入和对应 skill；结束时按 current_action 一次提交声明文件，保留真实错误与未知项。
