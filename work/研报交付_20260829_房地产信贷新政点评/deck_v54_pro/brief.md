# 一场「角色重写」——房地产金融新政对行业参与主体的影响（v5.4 完整报告 deck）

## 任务定义
- 目标读者：行业研究读者（机构/研究员/涉房业务条线管理者），发出去自己读懂为主，兼顾会后转发与讲解。
- 主使用场景：研报三件套中的 PPTX 渲染位——与既有 HTML/PDF（v54 版）同源同版本，本 deck 为可编辑演示/阅读版。
- 目标动作：让读者接受"1+N 新政=风险产权界定/角色重写"的主判断，并记住十三主体净效应与三个可证伪预言。
- 是否需要无人讲解也能读懂：是（self-contained：每页带结论句、口径、来源注；全页 speaker notes 写讲稿）。
- 参考模板文件：无继承模板。旧 `角色重写_十二主体_20260829_v54.pptx`（pptfast 版，已备份为 `*.pptx.pptfast-bak`）仅作内容参照，本次整体重渲染。
- 模板 / 品牌约束：品牌行「98wiki ｜ 智见点评 · 行业研究」；finesse 视觉 register（深青墨 #0e6a55 + 琥珀金 #a9741f，见 zhijian-report-craft/references/report-template-fivepiece-v1.md §四）。
- 交付物要求：**仅产出/替换 `角色重写_十二主体_20260829_v54.pptx`**；HTML/PDF 及 shots_v54/ 零触碰（不读写改删，存在性与 mtime 均不得变）。
- 验证要求：skill 三道 deck 级 gate（package_preflight / structure_precheck / render_review）+ 模块验证 + 数字纪律扫描（锚点逐 token + 量值禁例 0 命中）。

## Deck Contract
- source_context: no_template（旧 pptfast 版仅 content_migration 参照，页面系统整体重建）
- delivery_context: self-contained_reading_deck
- communication_profile: research_review
- visual_profile: editorial_ink
- density_profile: dense_reference（速览表/结语表/来源披露页为 dense_reference；机制页 balanced）
- editability_profile: fully_editable（原生文本/原生表格/native chart/原生形状；零位图截图）
- typography / table policy: 见 `deck_narrative.md` frontmatter 的 `theme_tokens`；标题类 1.0 倍行距+段前后 0.5 行；正文类 1.5 倍行距；表格 10.5pt 单倍行距、上下居中、表头居中、文本列居左、数值列靠右。

## 模板取证（对旧 pptfast 版，audit 详见 validation/template_audit/）
- 页面系统判断：pptfast 生成物，30 页，layout_usage=content:28/cover:1/ending:1；不构成可继承研报模板 → 路线=空白页直生（editorial_ink 品牌重建）。
- 关键母版 / layout 元素：母版无共享 logo/页脚/页码（pptfast 全部页内对象）→ 新 deck 页脚/页码/来源注由构建脚本逐页绘制，保证研报纪律元素在位且稳定。
- 字号系统：旧版碎片化严重（8.25/9.0/9.75/11.25/13.5/14.25…大量 0.75 步长档位，无 0.5pt 网格纪律）→ 本次严格 0.5pt 网格 + theme_tokens，消除碎片字号。
- 计划采用的构建路线：editable_pptx（python-pptx 空白直生）+ office_chart_native（md 在案数据图）+ diagram_visual（定性机制图，原生形状）。
- 最小 PoC 结论：python-pptx 1.0.2 可用；native chart/表格/connector 校验脚本可用；LibreOffice/PowerPoint/pdftoppm 缺失 → 逐页预览导出与 render_review 无可用 backend，按 skill 纪律显式降级为 not_checked，并以结构层量化自检补证（详见 validation/）。

## 风格与边界
- 风格参考：editorial_ink × domain_profile: financial_report_review——白底为主、深青墨 #0e6a55 主色、琥珀金 #a9741f 强调、衬线中文大标题（宋体系）、无衬线正文、克制装饰、ghost number/细线/留白；封面/总纲/三重再分配/封底用深青墨底做深浅节奏（rhythm）。
- typography_profile: zh_formal（中文宋体 + 西文 Times New Roman；卡片/标签可用黑体系作 minor 层级）。
- domain_profile: financial_report_review——来源/单位/图号/免责、稳定版心（左右边距 0.78/12.55in）、表格语义对齐、每图带"图N｜发现式图题+单位+来源注"。
- visual_theme_preset: finesse zhijian（ink-teal #0e6a55 + amber #a9741f；警示色仅用于"被切/出局"语义段）。
- 允许使用的素材：skill assets 的 tabler-outline 图标（icon-accent，节奏增强）、原生形状、原生表格、native chart。
- 禁止使用的品牌元素：任何真实机构 logo/受保护标识；来源注按 md 口径纯文字呈现。
- 免责声明 / 风险边界：封底免责一行「行业研究，不构成投资建议；测算/估算/研判推断非官方统计」。
- 不允许发生的错误：①HTML/PDF/shots 零触碰违例；②页面/notes 出现量值脱敏禁例 token（二手成交绝对套数：4,932/2,392/5,364/5,770/6,039/7,920/2,606/3,097/4,684/3,366/2,429 及不带千分位变体）；③数字与 md 不逐 token 一致或新增编造；④跳过 brief/narrative/checkpoint 直接组页；⑤md 无数字的图未标"定性示意"。

## 数字纪律（G1/G2 执行口径）
- 唯一权威源：`角色重写_十二主体影响_v5.4.md`（485 行）。页面与 notes 中每个数字逐 token 与 md 一致，零新增。
- 结构性编号豁免清单（不参与锚点扫描）：页脚页码（NN / 33）、图号（图①…图⑬，中文圈数字）、章节号（中文序数）。除此之外全部数字 token 必须可在 md 中逐字检索。
- 量值脱敏禁例：二手成交量绝对套数（清单见上）不得出现在任何页面或 notes；只允许"同比连续四个月为正"类趋势表述。
- 关键锚点（必在位）：4247 / 3614 / +17.5% / -4bp / 1814 亿 / 8.7 万亿 / 3 万亿·100-200 万套 / 4.5 万/单 / 45-55% / 50% / 30% / 55-60% → 70% 以上 / Cotality 157M+·99.2%·35-42 亿 / S2707425 -6.3→-5.4 / 北京 -8.7→-4.5 / 36.29 万亿 / -4.2% / -11.8% / -19.2% / 约 1.5%。
- 四级标注：测算/估算/研判推断/待补，页面数字按 md 原文口径词随行标注。

## Anti-AI-Slop Prompt Intake（build 前已读 slide_design_system.md §Anti-AI-Slop）
- 先读 prompt，再开始设计或写代码：已读并内化，以下约束写入每页 Layout Notes。
- 卡片使用理由：卡片仅用于承载分组/比较/状态（五件套的角色对照、三方对比卡、卡阵、金句引言块）；纯文字推论页用编号+留白分组，不卡片化。
- 背景实现方式：深色页用 slide.background.fill 纯色（#0e6a55 系），白底页默认白底；装饰仅用 hairline 细线与 ghost number（原生 shape，低层）；无整页图片/形状背景。
- 圆角 / 色条 / 阴影 / 渐变使用理由：研报文体 → 直角为默认角语言；金句引言块用 4px 左边框 accent 条（模板规范语汇，编码"章眼"语义）；无阴影；土地出让金"下滑带"用两级实色面积块表达，非装饰渐变。
- 矩形、节点、panel、卡片内部文字是否直接写入对应 shape：是——节点/卡片文字一律写入 shape.text_frame；仅独立标题/图注/页脚/来源注用独立文本框。

## Planning Checkpoint
- 全局基调：券商研报纪律（来源/单位/图号/免责/稳定版心）× editorial_ink 杂志气质（衬线大标题、细线、ghost number、深浅节奏）。
- 章节结构与逐页合同：33 页，详见 `deck_narrative.md`（封面→卷首速览→总论 6 页→十三章主体 15 页→总结 6 页→结语表→来源披露→封底）。
- 每页角色和读者问题：见逐页 `reader_question / page_task / archetype / rhythm_role / key_message`。
- 页面可见文案方向：只写外发读者可读的判断/事实/证据/口径；讲稿进 speaker notes；元叙述零出现。
- 资产 / 配图 / 图表需求：native chart 4 处（按揭余额折线、月供/总利息对比、二手价格锚点对比、数据底座无图纯表）；diagram-visual 定性图 9 处（ROE 拆解、并购链条、三道坎、资金路径、悬崖带、四段接力、收入结构变迁、天平、卡阵、闭环——全部标"定性示意"或按 md 数字精确绘制）；icon-accent 少量节奏增强。
- layout 与节奏安排：rhythm_role 逐页标注（opener/dense/transition/evidence/breath/closing）；深青墨底页 = S01/S03/S25/S33，形成 editorial_ink 深浅节奏。
