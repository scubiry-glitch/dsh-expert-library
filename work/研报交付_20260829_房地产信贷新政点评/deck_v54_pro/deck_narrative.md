---
deck:
  title: "一场「角色重写」——房地产金融新政对行业参与主体的影响（完整报告 v5.4）"
  audience: "行业研究读者：机构研究员、涉房业务条线管理者；自读为主、会后转发"
  scenario: "研报三件套 PPTX 渲染位（与 v54 HTML/PDF 同源同版本）"
  objective: "接受「1+N 新政=风险产权界定/角色重写」主判断；记住十三主体净效应与三个可证伪预言"
  source_context: "no_template"
  delivery_context: "self-contained_reading_deck"
  communication_profile: "research_review"
  visual_profile: "editorial_ink"
  density_profile: "dense_reference"
  editability_profile: "fully_editable"
  template_file: null
  theme_tokens:
    typography_profile: "zh_formal"
    domain_profile: "financial_report_review"
    visual_theme_preset: "editorial_ink_zhijian_ink_teal_amber"
    page_width_in: 13.333
    page_height_in: 7.5
    hero_title_font_pt: 40
    section_title_font_pt: 30
    page_title_font_pt: 24
    subtitle_font_pt: 16
    minor_title_font_pt: 14
    body_font_pt: 12
    label_font_pt: 10.5
    caption_font_pt: 9
    title_line_spacing_multiple: 1.0
    body_line_spacing_multiple: 1.5
    title_paragraph_space_lines: 0.5
    body_first_line_indent_chars: 0
    body_paragraph_space_lines: 0.5
    latin_font_name: "Times New Roman"
    east_asia_font_name: "宋体"
    table_font_pt: 10.5
    table_line_spacing_multiple: 1.0
    table_paragraph_space_lines: 0
    table_first_line_indent_chars: 0
    table_vertical_anchor: "middle"
    table_header_alignment: "center"
    table_index_alignment: "left"
    table_text_alignment: "left"
    table_numeric_alignment: "right"
    left_margin_in: 0.78
    right_margin_in: 12.55
    color_ink_teal: "#0E6A55"
    color_amber: "#A9741F"
    color_text: "#1F2933"
    color_muted: "#5B6B73"
    color_paper: "#FFFFFF"
    color_paper_warm: "#F7F5F0"
    color_ink_deep: "#0A3D32"
---

# 一场「角色重写」——房地产金融新政对行业参与主体的影响（完整报告 v5.4）

## Global Narrative
- 主判断：这套 1+N 文件重新分配的不是钱，而是知情权（谁能看见项目）、控制权（谁摸得着资金）、责任（谁为风险签字）；旧模式赚"预期"的钱，新模式只能赚"交付"的钱。
- 论证主线：卷首速览（30 秒读完）→ 总论（为什么是现在/为什么是这个形状：数据底座+体系地图）→ 十三章主体（每章五件套同构：金句定位→角色对照→条款依据→推论与数据→机会风险）→ 总结（三重再分配收口+风险产权+预言+失灵+时序）→ 结语表 → 来源披露。
- 主题词：角色重写、风险产权、基于项目、交付的定价说明书。禁区：正文零版本号/零评审痕迹（过程信息只在来源披露页）；不得以单一公司命名行业主体；量值脱敏禁例 token 绝对零出现；每个非引用数字带四级标注之一。
- 视觉纪律：financial_report_review（来源/单位/图号/免责/稳定版心/表格语义）× editorial_ink（白底为主、深青墨 #0e6a55 主色、琥珀金 #a9741f 强调、衬线中文大标题、ghost number、hairline、深浅节奏页 S01/S03/S25/S33）。
- Anti-slop 承诺：卡片只承载分组/比较/状态（对照表、三方卡、卡阵、金句引言块）；直角为默认角语言；金句引言块=4px 左边框 accent 条；无阴影；无整页背景图；节点/卡片文字直接写入 shape.text_frame；装饰仅 hairline+ghost number+留白。

## Planning Checkpoint
- 全局基调：券商研报出品人纪律 × 杂志式 editorial_ink；白底正文页 + 4 页深青墨底节奏页。
- 章节结构（33 页）：S01 封面 → S02-03 卷首速览 → S04-09 总论 → S10-24 十三章主体 → S25-30 总结 → S31 结语表 → S32 来源披露 → S33 封底。
- 每页角色/读者问题/文案方向/资产/layout：见下方逐页合同（reader_question / page_task / archetype / rhythm_role / key_message / asset_slots 全量在位）。
- 页面可见文案方向：只写外发读者可读的判断/事实/证据/口径；讲稿进 speaker notes；元叙述零出现。
- 资产路线：office-chart-native ×3（S08 按揭余额折线、S09 二手价格锚点对比、S10 月供/总利息双柱）；diagram-visual 结构图 ×11（S11 水位、S12 ROE、S13 并购链条、S14 三道坎、S15 资金路径、S16 悬崖带、S17 四段接力、S19 收入变迁、S22 闭环、S23 天平、S24 卡阵、S27 区间标尺、S29 时间轴——md 无数字的比例图一律标注「定性示意」）；table-native ×5（S02 速览、S07 体系地图、S08 数据底座、S26 风险产权、S31 结语表）；icon-accent 仅节奏增强。
- 预览与验证降级：环境无 PowerPoint/LibreOffice/pdftoppm → 逐页预览导出与 render_review 显式记 not_checked，以 structure_precheck 量化指标 + 自建边界自检脚本补证。
- 用户授权：任务书已明确授权连续执行（"按 skill 纪律走完整流程……修复到通过"），checkpoint 以本文档落盘为证，不等逐页口头确认。

### S01 | 封面·一场「角色重写」
```yaml slide_spec
title: "一场「角色重写」"
reader_question: "这份报告讲什么、凭什么值得读完？"
page_task: "persuade"
reading_mode: "scan"
archetype: "hero-statement"
asset_mode: "text-layout-native"
validation_mode: "preview_only"
key_message: "旧模式赚预期的钱，新模式赚交付的钱。"
layout_recipe: "editorial-cover"
rhythm_role: "opener"
required_assets: []
asset_slots: []
```
**Page Role.** 全 deck 定调页：主判断 + 四格硬数据锚。
**On-slide Copy.** 品牌行「98wiki ｜ 智见点评 · 行业研究」；主标题「一场「角色重写」」；副标题「房地产金融新政对行业参与主体的影响」；版本行「完整报告 v5.4 · 2026-08-29」；金句带「旧模式赚预期的钱，新模式赚交付的钱。」；四格数字条：36.29 万亿·较峰值-4.2%（个人住房贷款余额）｜-11.8%（商品房销售面积累计同比）｜-19.2%（开发投资累计同比）｜约1.5%（商业银行净息差）；口径行「Wind EDB 2026-07/2026Q2；金监总局 2026Q2」。
**Notes 方向.** 讲稿：开宗明义——文件分配的不是钱，是知情权/控制权/责任；预告十三章主体与三个可证伪预言；封面四个数字即"旧引擎熄火"的证据链开场。
**Layout Notes.** 深青墨底纯色块（非渐变图片）；衬线特大主标题白字；琥珀金句带；四格数字条白卡不透明；无装饰图片。

### S02 | 卷首速览·十三主体一页读完
```yaml slide_spec
title: "卷首速览：一页读完"
reader_question: "十三类主体各自的一句话结论和关键数字是什么？"
page_task: "archive"
reading_mode: "reference"
archetype: "board-memo"
asset_mode: "table-native"
validation_mode: "table_native"
key_message: "每个主体都拿到了新角色说明书：交付替代预期。"
layout_recipe: "business-summary-grid"
rhythm_role: "dense"
required_assets: []
asset_slots: []
```
**Page Role.** 30 秒读者入口：13 行结论表全量呈现。
**On-slide Copy.** 表（主体｜一句话结论｜关键数字）13 行逐行照 md（购房者→补列七类）；表下来源行「口径：Wind EDB 2026-07/2026Q2；金监总局 2026Q2；测算/估算项见各章」。
**Notes 方向.** 讲稿：不逐行念表；点出三组对照——购房者与银行（保护与惜贷）、开发商与央企（出清与准入）、地方政府与城投（席位与生死线）；提示后文每章展开。
**Layout Notes.** 原生表格 10.5pt、行高压缩、表头深青底白字；类目列居左；页脚品牌+页码。

### S03 | 三个可证伪预言·五个失灵变量·总纲
```yaml slide_spec
title: "预言、失灵与总纲"
reader_question: "这份体系把哪些判断放在可证伪的位置上？最怕什么失灵？"
page_task: "explain"
reading_mode: "decision"
archetype: "hero-statement"
asset_mode: "text-layout-native"
validation_mode: "preview_only"
key_message: "制度底座先行，市场底未确认；先立后破——立已到位，破在执行。"
layout_recipe: "editorial-big-number"
rhythm_role: "breath"
required_assets: []
asset_slots: []
```
**Page Role.** 深色节奏页：全书三大悬念前置。
**On-slide Copy.** 三个可证伪预言（研判推断）：期房占比三年内降至三成以下（中位约 45-55%）｜项目信贷二级市场（中位约 50%，分歧最大）｜3-5 家 F+EPC+O 千亿级运营商（中位约 30%，最脆弱）；五个失灵变量：银行惜贷 ＞ 现金流注水 ＞ 数据断供 ＞ 核验被俘获 ＞ 并购通道不足；总纲金句大字。
**Notes 方向.** 讲稿：解释"可证伪"的诚意——概率给区间给中位，验证锚在总结章；失灵变量按风险权重排序，惜贷是启动器；总纲两句是全书坐标系。
**Layout Notes.** 深青墨底；衬线大字金句；预言三条编号行（区间数字入文）；hairline 分隔；S27 再上区间标尺图。

### S04 | 总论·窗户纸与钥匙
```yaml slide_spec
title: "预售制是一项隐性金融制度"
reader_question: "为什么说读懂全部条文只有一把钥匙？"
page_task: "explain"
reading_mode: "guided"
archetype: "research-note"
asset_mode: "text-layout-native"
validation_mode: "preview_only"
key_message: "先显性化，再收缩融资功能、保留销售功能。"
layout_recipe: "editorial-margin-mechanism"
rhythm_role: "evidence"
required_assets: []
asset_slots: []
```
**Page Role.** 总论起点：立"窗户纸"判断并给出全书解码器。
**On-slide Copy.** 窗户纸：预售制从来不是一种"销售方式"，而是一项隐性金融制度——购房者在房子建成之前，向开发商提供无抵押、无知情权、最后受偿的开发资金；烂尾不是消费纠纷，是一场没人认领的信用危机。钥匙：先把这项隐性制度显性化（承认购房款就是开发融资→监管账户、受托支付、专款专用，个贷办法 20-22 条），再收缩融资功能（还给开发贷、REITs、并购、不动产私募基金）、保留销售功能（"能拿房、再还贷"）；第 37 条新老划断决定收缩是渐进的——被拆掉的是预售的隐性融资属性。
**Notes 方向.** 讲稿：把"隐性金融制度"翻译白话——二十年居民储蓄→开发融资的大规模转化，代价是金融风险伪装成消费行为；钥匙句是后面十三章的解码器。
**Layout Notes.** 左 margin 金句引言块（4px accent 左边框）；"显性化/收缩/保留"三步直角文本面板（文字写入 shape）；无卡片墙。

### S05 | 总论·旧模式的三重错位
```yaml slide_spec
title: "旧模式为什么撑不住：三重错位"
reader_question: "旧模式的病根是什么？"
page_task: "explain"
reading_mode: "guided"
archetype: "research-note"
asset_mode: "text-layout-native"
validation_mode: "preview_only"
key_message: "所有人都在赚「预期」的钱，唯独「交付」最不被定价。"
layout_recipe: "swiss-duo-compare"
rhythm_role: "evidence"
required_assets: []
asset_slots: []
```
**Page Role.** 制度变迁的成因论证。
**On-slide Copy.** 融资主体错位：最扛不起风险的人（购房者）承担链条最前端的风险；风控最强的机构（银行）躲在抵押物后面做第二顺位。信息错位：项目真实的资金与进度混在集团资金池里，外人看不见——尽调靠关系，定价靠信仰。激励错位：房企赚地价上涨、银行赚抵押物升值、中介赚成交频次、地方赚土地财政——唯独"交付"最不被定价。收口：当维持旧制度的成本（保交楼、兜底）超过重建成本，变革才会发生；人口与城镇化拐点打破了地价的自我实现，旧模式就走到了头。
**Notes 方向.** 讲稿：三重错位逐条给生活化例子；"激励错位"是变革时点的经济学解释，为"为什么是现在"埋伏笔。
**Layout Notes.** 三栏直角面板；每栏 ghost 序号；栏内文字写进 shape；底部收口句独立强调行。

### S06 | 总论·为什么是 1+N，为什么是现在
```yaml slide_spec
title: "文件群的形状与时点"
reader_question: "为什么是一部文件群而不是一部大法？为什么是现在？"
page_task: "explain"
reading_mode: "guided"
archetype: "research-note"
asset_mode: "text-layout-native"
validation_mode: "preview_only"
key_message: "政策的函数变了：过去是 f(市场热度) 的周期调节，现在是 g(制度架构) 的恒定约束。"
layout_recipe: "editorial-data-pipeline"
rhythm_role: "evidence"
required_assets: []
asset_slots: []
```
**Page Role.** 回答"形状与时点"两问，衔接数据底座。
**On-slide Copy.** 为什么是 1+N：预售制的金融化是全链条的——只管银行，资金改走信托；只管信贷，融资改走资本市场；只管增量，存量没人接；所以只能全口径堵截、分工具适配：央行出总纲，金监总局按条线出四个办法，住建部联署管城市更新，证监会打开股权通道——七个文件第一次共用同一把尺子："基于项目"；文件群的好处是快（印发即适用于新签合同），代价是执行依赖监管力度——文件能快进，也能快改。为什么是现在：销售面积累计同比 -11.8%、开发投资 -19.2%、按揭余额较峰值净减 1.61 万亿（Wind EDB，2026-07/2026Q2）；旧通知集中废止，宣告补丁式监管谢幕；g 管十年，周期工具（收库存、保主体、贴按揭）管当下十二个月，并联才成立；这套文件只是金融子系统的总则，住房、土地、财税三翼尚未联动。
**Notes 方向.** 讲稿：用"补丁式监管谢幕"讲旧通知废止的意义；提醒 f/g 并联才成立，防止误读为"只讲制度不看周期"。
**Layout Notes.** 上下两段；上段三条"只管X→改走Y"漏改路径小箭头；下段数字行加粗；"f→g"函数式作为视觉锚点（文本形状）。

### S07 | 总论·体系地图：谁在管什么
```yaml slide_spec
title: "体系地图：谁在管什么"
reader_question: "七个文件各自管什么、什么定位？"
page_task: "archive"
reading_mode: "reference"
archetype: "appendix-dense"
asset_mode: "table-native"
validation_mode: "table_native"
key_message: "银行管过程、资本市场管结构、信托被收编、宏观审慎管总量。"
layout_recipe: "business-summary-grid"
rhythm_role: "transition"
required_assets: []
asset_slots: []
```
**Page Role.** 1+N 全景坐标页，后续十三章的检索地图。
**On-slide Copy.** 7 行表（文件｜发文主体｜管什么｜定位）逐行照 md；底部收口句「银行管过程、资本市场管结构、信托被收编、宏观审慎管总量。」
**Notes 方向.** 讲稿：教读者按"过程/结构/影子/总量"四象限记文件群；《意见》是总纲，其余按条线适配。
**Layout Notes.** 原生表格 10.5pt；定位列琥珀色强调；表头深青底。

### S08 | 总论·数据底座与按揭余额走势
```yaml slide_spec
title: "数据底座：周期工具已经失效"
reader_question: "利率历史低位而余额仍在降，说明什么？"
page_task: "evidence"
reading_mode: "decision"
archetype: "chart-spotlight"
asset_mode: "office-chart-native"
validation_mode: "chart_editable"
key_message: "利率走到历史低位而余额仍在降——只剩制度变量可用，L 型磨底仍需 2-3 年。"
layout_recipe: "chart-spotlight-with-takeaways"
rhythm_role: "evidence"
required_assets: []
asset_slots:
  - slot_id: "s08_mortgage_line"
    page_role: "main_evidence"
    asset_type: "chart"
    module: "office-chart-native"
    backend: "python-pptx"
    validation_mode: "chart_editable"
    status: "planned"
```
**Page Role.** 全书数据底座：5 指标表 + 余额折线主图。
**On-slide Copy.** 表 5 行（指标｜最新值｜关键变化）照 md；图A｜发现式图题「个人住房贷款余额：连降通道」；单位：万亿元；季度序列 37.56→37.68→37.90→37.74→37.44→37.01→36.72→36.29（横轴 ①…⑧ 为季度序号；2025-03 峰值 37.90、最新 2026-06 为 36.29）；来源：Wind EDB（W1409719）；结论两条：利率走到历史低位而余额仍在降——周期性工具已经失效，只剩制度变量可用；制度变量只修供给侧的风险归属，不创造需求——制度底座先行，市场底未确认，L 型磨底仍需 2-3 年。
**Notes 方向.** 讲稿：先表后图；"弹性钝化"——利率连降而余额八季下行，是周期工具失效的直接证据；2-3 年是节奏判断不是点位预测。
**Layout Notes.** 左表右图；native LINE chart 带数据标签；图注含图号/单位/来源/口径；横轴圈数字序号避免新增日期 token。

### S09 | 总论·分城市快照与关键补充数据
```yaml slide_spec
title: "市场底不是一个底，是很多个"
reader_question: "城市间分化到什么程度？哪些补充数据必须记住？"
page_task: "evidence"
reading_mode: "decision"
archetype: "chart-spotlight"
asset_mode: "office-chart-native"
validation_mode: "chart_editable"
key_message: "京宁分化证明市场底分城市、分环节到来；量先于价得到成交端独立验证。"
layout_recipe: "chart-spotlight-with-takeaways"
rhythm_role: "dense"
required_assets: []
asset_slots:
  - slot_id: "s09_resale_anchor_bar"
    page_role: "main_evidence"
    asset_type: "chart"
    module: "office-chart-native"
    backend: "python-pptx"
    validation_mode: "chart_editable"
    status: "planned"
```
**Page Role.** 城市分化证据 + 全书补充数据锚集中页。
**On-slide Copy.** 京宁快照表 4 行（销售面积/二手价格/新宅价格/开发投资 × 北京/南京）照 md；图B｜发现式图题「70 城二手住宅价格同比：探底→最新锚点对比」（全国 -6.3→-5.4、北京 -8.7→-4.5、南京 -8.6→-5.4；单位 %；锚点对比，中间月份未披露；来源 Wind EDB S2707425 等）；成交动能行：京宁二手成交量同比 2026 年 3-6 月连续四个月为正（贝壳政研通口径，趋势性信号；北京 4 月冲高后回落企稳、南京逐月放缓）——二手价格同比仍负而成交动能已转正，"量先于价"的修复路径在城市级得到成交端的独立验证；关键补充数据面板：租金回报率约 2% 出头、低于约 3% 资金成本（测算口径）；土地出让金自 2021 年 8.7 万亿峰值接近腰斩（财政部口径）；收储贴息测算约 3 万亿元、100-200 万套（测算口径）；商业银行净息差约 1.5%（金监总局，2026Q2）；存量按揭降 50bp 年减负约 1814 亿元，仅占居民可支配收入约 0.3%——是"减负"不是"引擎"；带押过户按 300 万贷款、30 天过桥、日万五测算，单笔省约 4.5 万元（测算口径）。
**Notes 方向.** 讲稿：北京销售 5 月转正序列（+0.6→+2.0→+1.4）；补充数据条每项口径词逐个念；二手成交量只给趋势不给绝对值（委托方口径）。
**Layout Notes.** 上表下图；负值柱向下；右下"关键补充数据"直角面板两列；来源注齐全。

### S10 | 第一章 购房者
```yaml slide_spec
title: "购房者：从「影子出资人」到「受保护的消费者」"
reader_question: "40 年期限与 50%/60% 红线改变了购房者的什么？"
page_task: "explain"
reading_mode: "guided"
archetype: "research-note"
asset_mode: "office-chart-native"
validation_mode: "chart_editable"
key_message: "交房之前先还贷的时代结束了——购房者第一次有了风控部门。"
layout_recipe: "five-piece-with-chart"
rhythm_role: "evidence"
required_assets: []
asset_slots:
  - slot_id: "s10_payment_bars"
    page_role: "main_evidence"
    asset_type: "chart"
    module: "office-chart-native"
    backend: "python-pptx"
    validation_mode: "chart_editable"
    status: "planned"
```
**Page Role.** 五件套首章示范页：确立全书章节同构节奏。
**On-slide Copy.** 章眼金句「交房之前先还贷的时代结束了——购房者第一次有了风控部门」；角色对照 3 行（身份/风控/救济）；条款（放款后置到竣工备案 个贷 22 条；受托支付进监管账户；带押过户 20 条；存量利率偏离可协商置换 24 条；失收可协商展期 26 条；月供收入比 ≤50%、全债务支出比 ≤60% 硬红线 10 条；期限最长 40 年 13 条）；推论要点：①40 年不是降月供，是给"收入合格、月供不合格"的人扩容——测算（100 万、3.06%、等额本息）：30 年月供约 4247 元、总利息约 52.9 万；40 年月供约 3614 元、总利息约 73.5 万——月供降约 15%，总利息升约 39%（+20.6 万）；50% 红线下同等月供能力可支撑的本金上限提高约 17.5%（测算口径）；银行将第一次依法"保护性拒贷"；红线既是保护条款，也是需求收缩条款 ②居民端减负，银行端加久期：按揭久期从约 8-10 年拉长到 11-14 年（估算口径）③风险没有消失，只是改了形状：选择风险+时机风险；第 37 条新老划断是缓冲垫——现房销售只能小步慢走 ④存量利率救济有制度通道、量级有限：经第 24 条降 50bp，按 36.29 万亿余额测算年减负约 1814 亿元——占居民可支配收入约 0.3%，是减负不是刺激 ⑤购房者不是一个人：刚需/改善/投资客处境完全不同；图①｜30 年 vs 40 年对比（月供 元/月：4247/3614；总利息 万元：52.9/73.5；测算口径，100 万、3.06%、等额本息）；机会/风险（机会=交付确定性+制度化利率救济；风险=选择自负+红线挡掉边际需求→总结·失灵①的镜像）。
**Notes 方向.** 讲稿：月供 -15% 换总利息 +39% 的取舍；"保护性拒贷"是银行行为新词；红线同时是收缩条款的边界意识。
**Layout Notes.** 标准五件套版心：金句块/对照小表/条款 tag 列/编号推论/机会风险虚线胶囊；右侧 native 双柱图（图号+单位+口径+来源注齐全）；条款号琥珀 tag。

### S11 | 第二章 主办银行
```yaml slide_spec
title: "主办银行：从「资金贩子」到「责任承包商」"
reader_question: "银行审的为什么不再是财报，是工地？"
page_task: "explain"
reading_mode: "guided"
archetype: "research-note"
asset_mode: "text-layout-native"
validation_mode: "diagram_visual"
key_message: "责任无限、对价稀薄，惜贷不是失职，是理性。"
layout_recipe: "five-piece-with-diagram"
rhythm_role: "evidence"
required_assets: []
asset_slots:
  - slot_id: "s11_nim_waterlevel"
    page_role: "main_evidence"
    asset_type: "diagram"
    module: "diagram-visual"
    backend: "python-pptx"
    validation_mode: "diagram_visual"
    status: "planned"
```
**Page Role.** 五件套 + 息差水位图：银行行为逻辑的证据核。
**On-slide Copy.** 章眼金句「银行审的不再是财报，是工地」；对照 3 行（岗位/审什么/责任）；条款（一项目一行、账户结清前不变更 开发贷办法 7-8 条；放款进度=实物进度 15 条；销售回款先还本项目贷款 16 条；信托资金由主办行审核划拨、托管行与主办行同一法人 信托办法 21-22 条；违规点名处罚 57 条；重大事项事先告知主办行 《意见》12 条）；推论：①一个新的 to-B 行业被凭空创造：银行内部诞生"工程监理岗"，第三方工程核验机构成为标配外采（21 条预留接口）②项目信息独占者：主办行比地方政府、比集团更早知道真实去化 ③会出现"银行不敢抢的项目"：主办行向有工程风控能力的头部行集中——项目资质分层取代客户资质分层 ④惜贷不是失职，是理性：净息差约 1.5%（金监总局，2026Q2）；此时存量按揭若降 50bp，行业息差静态再收约 -4bp，存款利率联动可对冲六七成、净影响约 -1~-2bp（估算口径）——若不联动，冲击不容忽视 ⑤警惕新数据租金：谁审计数据垄断者？图②｜息差水位图：净息差约 1.5% 基线、降 50bp 的 -4bp 静态冲击与对冲后 -1~-2bp 净影响（估算口径）；机会/风险（机会=信息资产+主办行集中度提升；风险=责任无对价的惜贷螺旋→总结·失灵①）。
**Notes 方向.** 讲稿：水位图三层读法（基线/冲击/对冲）；-4bp 白话换算；数据租金之问与第十章呼应。
**Layout Notes.** 水位图三条水平带+右向差值标注；基线深青、冲击琥珀、对冲后灰；文字全部入 shape；标"估算口径"。

### S12 | 第三章 房地产开发企业
```yaml slide_spec
title: "开发商：集团信用被「没收」"
reader_question: "杠杆被拆后，行业靠什么赚钱？"
page_task: "explain"
reading_mode: "guided"
archetype: "research-note"
asset_mode: "text-layout-native"
validation_mode: "diagram_visual"
key_message: "八个瓶七个盖的时代结束了——行业第一次被迫变得像制造业。"
layout_recipe: "five-piece-with-diagram"
rhythm_role: "evidence"
required_assets: []
asset_slots:
  - slot_id: "s12_roe_sketch"
    page_role: "main_evidence"
    asset_type: "diagram"
    module: "diagram-visual"
    backend: "python-pptx"
    validation_mode: "diagram_visual"
    status: "planned"
```
**Page Role.** 供给端主战场的机制解释。
**On-slide Copy.** 章眼金句；对照 3 行（核心能力/现金流/土储）；条款（项目单独建账、资金不得混同、不得划拨集团/关联方、不得缴地价/分红 开发贷办法 13 条；集团风险与项目风险分开评估 4 条；全链条禁缴土地出让金贷款 《意见》5 条）；推论：①ROE 公式里的杠杆项被拆掉——每个项目一个封闭水池，只剩周转率和利润率可以卷 ②从"垫资的甲方"到"被垫资的乙方"：资本金先到位、贷款按进度放、还本等竣工、回款先还贷 ③土地市场被釜底抽薪：缴地价贷款全链条禁止，拿地只剩真资本金 ④"周转率"的含义变了：期房转现房把项目周期拉长 2-3 年；两条活路=好房子溢价或轻资产化 ⑤存量土储是下一个战场：土储从融资工具变回纯成本项——历史高价地的存货减值与"被动退地"先出现在报表上；图③｜ROE 拆解示意（定性示意）：杠杆×周转×利润率三因子中杠杆项被移除，只剩两条活路；机会/风险（机会="好房子"信贷溢价 开发贷 13/14 条；风险=土储减值集中暴露+转型慢者出清）。
**Notes 方向.** 讲稿：制造业类比；土储包袱一句历史定价；ROE 图明确"定性示意"。
**Layout Notes.** ROE 三因子横排，杠杆块删除线表达（边框+对角线）；"两条活路"箭头；右上角"定性示意"角标。

### S13 | 第四章 上市房企与资本市场
```yaml slide_spec
title: "上市房企：一封印着「基于项目」的再上市邀请函"
reader_question: "谁会当整合者？为什么说整合者未必是同行？"
page_task: "explain"
reading_mode: "guided"
archetype: "research-note"
asset_mode: "text-layout-native"
validation_mode: "diagram_visual"
key_message: "真正的主角不是再融资，是并购重组。"
layout_recipe: "five-piece-with-diagram"
rhythm_role: "evidence"
required_assets: []
asset_slots:
  - slot_id: "s13_ma_chain"
    page_role: "main_evidence"
    asset_type: "diagram"
    module: "diagram-visual"
    backend: "python-pptx"
    validation_mode: "diagram_visual"
    status: "planned"
```
**Page Role.** 权益通道章：并购逻辑链 + 三方整合者对比。
**On-slide Copy.** 章眼金句；对照 3 行（融资/出清方式/监管基调）；条款（发行准入突出"基于项目" 证监会文件 6 条；募集资金穿透式专户监管 8 条；打击第三方配合造假、零容忍 9 条；严格执行退市 11 条）；推论：①出清终局不是倒闭清算，而是项目级资产被好公司批量接走——"收购+配套融资"取代法拍折价，A 股将出现"项目整合型房企" ②每个项目的封闭账户就是一份实时、真实、第三方托管的项目报表——并购尽调成本骤降 ③中介从通道费生意变成无限连带看门人（9 条）——"会计所分层拒单" ④谁当整合者：同行头部房企（有能力但在缩表，再融资资格存疑）/建筑央企（有通道有工程能力，受负债率 75-80% 与"一利五率"考核约束）/城投（有地方协调力，受隐债红线约束）；图④｜并购链条（项目封闭账户=实时真实报表→尽调成本骤降→收购+配套融资→项目级整合）+三方对比卡（✓能力｜约束），卡区标注"整合者未必是同行"；机会/风险（机会=并购主导权+集中度提升；风险=承接方资产负债表空间不足、"好公司"缺位→总结·失灵⑤）。
**Notes 方向.** 讲稿：链条四步讲完；三方卡"✓/约束"一起看；"谁最先转化项目级真实报表，谁定义出清后的行业结构"。
**Layout Notes.** 上半链条 4 直角节点+箭头；下半三张对比卡并排；"整合者未必是同行"琥珀标注条。

### S14 | 第五章 建筑央企
```yaml slide_spec
title: "建筑央企：「参照涉房」是准入，不是激励"
reader_question: "门开了，为什么未必有钱进、未必该干？"
page_task: "explain"
reading_mode: "guided"
archetype: "research-note"
asset_mode: "text-layout-native"
validation_mode: "diagram_visual"
key_message: "门开了，未必有钱进；能干，未必该干。"
layout_recipe: "five-piece-with-diagram"
rhythm_role: "evidence"
required_assets: []
asset_slots:
  - slot_id: "s14_three_gates"
    page_role: "main_evidence"
    asset_type: "diagram"
    module: "diagram-visual"
    backend: "python-pptx"
    validation_mode: "diagram_visual"
    status: "planned"
```
**Page Role.** 最易被忽略条款的专章。
**On-slide Copy.** 章眼金句；对照 3 行（身份/能用的工具/现实约束）；条款：证监会文件（二）"建筑等与房地产密切相关行业的上市公司，参照上市房地产开发企业政策执行"——一句话，全文最容易被忽略；三道坎：①通道不等于弹药：负债率普遍 75-80%（行业口径），叠加"两金压降"与"一利五率"考核，收购要真资本金 ②能干不等于会干：施工主业毛利 2-4%（行业口径），与重资产持有是两种回报结构 ③REITs 出口与坏资产自相矛盾：出险项目过不了分派率门槛——2018-2021 年央企纾困接盘的减值教训就在眼前；更现实的两条路径：轻资产先跑（代建+总承包+运营，不背融资）/以房抵债转自持（用工程款债权换资产）；千亿级要按合同额和管理规模计——三家中位概率约 30%，是最脆弱的预言；图⑤｜三道坎卡图（负债率 75-80% / 毛利 2-4% / REITs 分派率门槛）配"准入≠激励"标尺；机会/风险（机会=F+EPC+O 与代建的先行身位；风险=接盘减值重演、考核冲突）。
**Notes 方向.** 讲稿："参照涉房"四个字的分量；三道坎逐个过；约 30% 中位概率是全书最脆弱预言（研判推断）。
**Layout Notes.** 三道坎三张直角卡+底部"准入≠激励"标尺条；数字大字居中卡内。

### S15 | 第六章 信托公司
```yaml slide_spec
title: "信托：被「收编」的外包资管"
reader_question: "资金出口被银行接管后，信托还剩什么生意？"
page_task: "explain"
reading_mode: "guided"
archetype: "research-note"
asset_mode: "text-layout-native"
validation_mode: "diagram_visual"
key_message: "资金出口被银行接管之后，信托要么做深，要么出局。"
layout_recipe: "five-piece-with-diagram"
rhythm_role: "evidence"
required_assets: []
asset_slots:
  - slot_id: "s15_trust_path"
    page_role: "main_evidence"
    asset_type: "diagram"
    module: "diagram-visual"
    backend: "python-pptx"
    validation_mode: "diagram_visual"
    status: "planned"
```
**Page Role.** 影子端收编章。
**On-slide Copy.** 章眼金句；对照 3 行（身份/资金/客群）；条款（非标准入三道杠：监管评级 2 级以上、净资产不低于 10 亿、近两年非连亏 16 条；专户+同一法人+三方合同 21-22 条；集中度双限：余额≤信托实收规模 5%、单一企业≤20% 45 条；未上市股权原则禁止、已建成项目例外≤净资产 25% 24 条；48 小时冷静期 34 条；不得设预期收益率 33 条；薪酬递延+追索扣回 46 条；一项目一管理人 14 条；2027-03-01 施行、存量到期结清）；推论：①三个新物种身份：与 AMC 联手处置存量风险（29 条，从风险制造者转行特殊机会投资）/已建成优质资产的股权物权投资（25% 条款=私有 REITs 前置仓）/资产服务信托（财富管理/行政管理）②监管要的是小而精的地产专业户：一项目一管理人+异地驻点（44 条）——收缩成特殊机会投资、不动产服务信托两条赛道（历史规模量级为估算口径，以信托业协会披露为准）；图⑥｜收编前后资金路径图：信托自行保管、自行划拨 → 进主办行专户、主办行审核划拨，配三个新身份卡；机会/风险（机会=特殊机会投资先发身位+服务信托转型；风险=存量结清期的收入断档与人才流失）。
**Notes 方向.** 讲稿：集中度双限与三道杠用"入场券"白话；2027-03-01 是日历锚（呼应传导时序）。
**Layout Notes.** 路径图前后两态左右对照+箭头；三身份卡横排；条款 tag 列表压缩左列。

### S16 | 第七章 地方政府
```yaml slide_spec
title: "地方政府：有了席位，也被掐了资金链"
reader_question: "卖地模式退场后，地方靠什么接住财政斜率？"
page_task: "explain"
reading_mode: "guided"
archetype: "research-note"
asset_mode: "text-layout-native"
validation_mode: "diagram_visual"
key_message: "从「卖地给开发商」到「卖项目给资本」——城市更新项目库就是新的招商产品手册。"
layout_recipe: "five-piece-with-diagram"
rhythm_role: "evidence"
required_assets: []
asset_slots:
  - slot_id: "s16_land_cliff"
    page_role: "main_evidence"
    asset_type: "diagram"
    module: "diagram-visual"
    backend: "python-pptx"
    validation_mode: "diagram_visual"
    status: "planned"
```
**Page Role.** 财政维度章：悬崖与新引擎接力。
**On-slide Copy.** 章眼金句；对照 3 行（身份/收入引擎/责任）；条款（白名单直报城市融资协调机制 开发贷 26 条；违约处置配合注册地政府 证监会 11 条；风险联防联控 12 条；城市更新办法由金监总局+住建部联署——项目入库+城市体检+经营性收入足额覆盖本息、禁隐性增信、禁政府应付款项/无收益公益资产抵质押、不得用于净地供应前征收补偿）；推论：①席位是"条文固化"而非"首创"：协调机制与白名单 2024 年已是实践，新政的意义是写进办法、可问责 ②资金链被掐：缴地价贷款没了、一级开发垫资没了——旧循环的资金工具全部收回 ③最大悬案在过渡期：土地出让金自 2021 年 8.7 万亿峰值接近腰斩（财政部口径），"卖项目"的转型收益能否接得住下滑斜率，决定地方财政成色；图⑦｜土地出让金悬崖图：8.7 万亿峰值到"接近腰斩"的下滑带（财政部口径；下滑带为定性示意）与"卖项目"新引擎的接力示意；机会/风险（机会=项目库招商+城市更新中心化；风险=过渡期现金流缺口+项目注水诱惑→总结·失灵②）。
**Notes 方向.** 讲稿：席位与资金链"一升一降"并陈；悬崖带不落现值数字（如实标注"接近腰斩"）。
**Layout Notes.** 左五件套；右侧悬崖带两级实色面积块（8.7 万亿标注+「接近腰斩」文字带）+「定性示意」角标；新引擎箭头接力。

### S17 | 第八章 持有与运营端
```yaml slide_spec
title: "持有与运营端：全生命周期产品菜单"
reader_question: "运营端第一次拿到了哪些金融产品？卡在哪？"
page_task: "explain"
reading_mode: "guided"
archetype: "research-note"
asset_mode: "text-layout-native"
validation_mode: "diagram_visual"
key_message: "不动产资管产业链的开工许可证发下来了。"
layout_recipe: "five-piece-with-diagram"
rhythm_role: "evidence"
required_assets: []
asset_slots:
  - slot_id: "s17_four_leg_relay"
    page_role: "main_evidence"
    asset_type: "diagram"
    module: "diagram-visual"
    backend: "python-pptx"
    validation_mode: "diagram_visual"
    status: "planned"
```
**Page Role.** 持有运营端产品线全景。
**On-slide Copy.** 章眼金句「运营阶段第一次拥有与开发阶段平起平坐的金融产品线——不动产资管产业链的开工许可证发下来了」；对照 3 行（融资/退出/定价）；条款（《意见》四-五章+商业地产办法：租赁开发建设贷 3-5 年→租赁团体购房贷 ≤30 年/评估值 80%→租赁经营性贷：自有产权 ≤20 年/80%、改造 ≤5 年/应收租金 70%→经营性物业贷 ≤15 年/评估值 70%→商业地产购买贷 10-15 年→RMBS/CMBS/REITs/扩募；保障房开发贷保本微利、利率低于商品房开发贷）；推论：①"开发商"与"持有商"物种分化——开发-持有-退出闭环第一次在制度上跑通 ②两道闸门未开：定价闸门——租金回报率约 2% 出头、低于约 3% 资金成本（测算口径），菜单每一档都以租金覆盖本息为前提；买方闸门——REITs 的终局买家是保险、养老金等长期资金，其监管规则下的配置约束决定"钱从哪来" ③分派率要求若下调，更多资产够得着退出通道，反过来抬高今天的收购定价——团租机构与建筑央企是定价权转移的先受益者；图⑧｜四段接力图（开发端→收储端→运营端→退出端，期限/成数入图；保障房"保本微利"标签）+底部两道闸门横条；机会/风险（机会=持有型资产的公司化运营；风险=租金回报率不修复则菜单空转→总结·传导时序的收储节点）。
**Notes 方向.** 讲稿：接力图按段念期限/成数；两道闸门是本章记忆点，呼应第十三章险资与总结收储节点。
**Layout Notes.** 四段横向接力箭头带（各段期限/成数小字）；底部"定价闸门/买方闸门"双横条；期限数字全部 md 在案。

### S18 | 第九章 经纪行业·上
```yaml slide_spec
title: "经纪行业·上：三刀切掉金融化收入"
reader_question: "切掉的是哪三刀？量的修复为什么先于价？"
page_task: "explain"
reading_mode: "guided"
archetype: "research-note"
asset_mode: "text-layout-native"
validation_mode: "preview_only"
key_message: "金融化的钱被三刀切掉——切掉的是租金，留下的是本事。"
layout_recipe: "editorial-margin-mechanism"
rhythm_role: "evidence"
required_assets: []
asset_slots: []
```
**Page Role.** 第九章上半：三刀机制 + 量价修复证据。
**On-slide Copy.** 章眼金句（本章讨论经纪行业整体；头部平台仅作案例参照，参照不等于豁免）；对照 3 行（收入/新房分销/小中介生态）；三刀：赎楼被带押过户终结（过桥是金融化利润大头）/新项目预售阶段按揭代办消失（放款后置 22 条；存量按 37 条过渡）/返点渠道终结（23 条名单制+"风控核心事项银行独立开展"直接掐断）；验真的想象空间在"验真"：主办行专户流水是"账户级的真"，平台数据只是"颗粒度更粗的补充真"；悬空点是谁为验真付费（取决于《意见》34 条全口径统计是否把平台数据列为法定来源）——方向成立，时点存疑；头部平台的应对是把"通道费"换成"服务费"，转型路径对全行业有参照意义，但参照不等于豁免；量的修复先于价：全国 70 城二手价格同比 2026 年初 -6.3 筑底后连续 5 个月收窄至 -5.4（S2707425）；北京更早更深（-8.7→-4.5，领先约 0.9 个百分点）、销售面积 5 月转正；带押过户单笔省 15-30 天、约 4.5 万元（测算口径），摩擦下降理论上提升均衡换手率 10-20%（必要不充分条件）；成交动能同步验证：京宁二手成交量同比 2026 年 3-6 月连续四个月为正（贝壳政研通口径，趋势性信号）——"量修复"是成交放量的主动过程；边界钉死：收窄不等于转正（-5.4% 仍深度负增长）；北京是先行个案，不能放大为全国（全国销售 -11.8%）。
**Notes 方向.** 讲稿：三刀逐条落条款号；量价修复用"量先于价"收拢；两次钉边界。
**Layout Notes.** 左金句块+对照表；右侧"三刀"编号列；量价数字行加粗；边界句虚线胶囊。

### S19 | 第九章 经纪行业·下
```yaml slide_spec
title: "经纪行业·下：出清顺序与第二曲线"
reader_question: "谁先出局？剩下的生意长什么样？"
page_task: "explain"
reading_mode: "guided"
archetype: "research-note"
asset_mode: "text-layout-native"
validation_mode: "diagram_visual"
key_message: "返佣断流，出清先小后大；入口+家装转化飞轮与政策同向。"
layout_recipe: "five-piece-with-diagram"
rhythm_role: "dense"
required_assets: []
asset_slots:
  - slot_id: "s19_income_shift"
    page_role: "main_evidence"
    asset_type: "diagram"
    module: "diagram-visual"
    backend: "python-pptx"
    validation_mode: "diagram_visual"
    status: "planned"
```
**Page Role.** 第九章下半：收入结构变迁全景图。
**On-slide Copy.** 推论 3 返佣断流：新房分销返点、按揭代办费、渠道返佣本是中小门店的生命线收入——现房分销又把"低费率+快回款"换成"高费率+长账期"，佣金结算周期拉长进一步挤压现金流；行业出清顺序：先小后大、先返佣依赖型、后服务能力型——无底薪佣金制从业者的收入断崖从这里发生；新房分销份额向绑定现房与"好房子"项目的头部平台集中。推论 4 第二、三曲线顺风：团购房贷（≤30 年/80%）推动机构化收房放量；保租房 REITs 扩募需要可审计现金流；"好房子"带动存量翻新与改善装修——经纪入口+家装转化飞轮与政策同向。推论 5 约束仍是那条：交易频次取决于基本面——政策决定谁能活下来吃增量，不创造增量本身。图⑨｜经纪行业收入结构变迁（定性示意）：旧收入堆叠柱（佣金+赎楼过桥+按揭返点+首付包装+装修贷导流五段）→三把刀（带押过户 20 条/放款后置 22 条/名单制+独立核验 23 条）→新收入柱（撮合+验真+数据+家装租赁四段）；柱下高亮条："返佣依赖型小中介：首当其冲——出清先小后大"；右下小图：全国 -6.3→-5.4 与北京 -8.7→-4.5 双锚点线（图注：中间月份未披露）；机会/风险（机会=验真、撮合、数据的重新定价；风险=变现时点后移+佣金结算周期拉长压垮中小代理）。
**Notes 方向.** 讲稿：变迁图从左讲到右；双锚点线强调只有首尾锚点（如实披露）；S18 已给全部数字，本页图形为定性。
**Layout Notes.** 左右双柱（堆叠色块无金额刻度=定性）+中间三把刀箭头；高亮条琥珀；小图两锚点直连；"定性示意"角标。

### S20 | 第十章 数据与评估机构
```yaml slide_spec
title: "数据与评估：从「额度的化妆师」到「风控基础设施」"
reader_question: "评估的责任化与存量重估的市场有多大？"
page_task: "explain"
reading_mode: "guided"
archetype: "research-note"
asset_mode: "text-layout-native"
validation_mode: "preview_only"
key_message: "评估从此不再创造额度，只负责说真话——说真话第一次有了责任价格。"
layout_recipe: "editorial-margin-mechanism"
rhythm_role: "evidence"
required_assets: []
asset_slots: []
```
**Page Role.** 风控基础设施章（对标页前置）。
**On-slide Copy.** 章眼金句；对照 3 行（评估/数据/责任）；条款（成交价与评估价孰低 个贷 19 条；押品每年重估、不得以再评估净值追加贷款 25 条；不得高估项目价值过度融资 商地 13 条；经营性物业贷封顶评估值 70% 36 条；信托不得仅凭外部信息论证 11 条；服务机构违规通报主管部门 59-60 条；全口径统计+严防数据造假 《意见》34 条）；推论：①孰低原则的精确含义：它管押品认定，额度仍由抵押率上限与银行风险偏好决定——但"按单流水线"的生意模式终结了：责任定价开始，评估费因责任溢价上涨，小评估所出局 ②最大的增量在存量重估：36 万亿级按揭每年重估+物业贷/CMBS/REITs 持续估值+城市更新收益测算——一个常年滚动的全国不动产定价基础设施，被文件顺手建成 ③工程量核验是新物种：放款与实物进度匹配、竣工备案成为全体系关键节点——造价咨询、工程监理机构切入金融核验市场 ④现金流数据是第三个生态位——但记住第二章那颗雷：数据权力集中之后，谁来审计数据持有者？
**Notes 方向.** 讲稿：责任价格白话——错要赔、假要通报；"36 万亿级年度重估"是最大增量记忆点；结尾悬念交给下一页 Cotality 镜子。
**Layout Notes.** 标准五件套；条款 tag 列表；四推论编号列；无图页用留白+hairline 分层。

### S21 | 第十章续 Cotality 对标
```yaml slide_spec
title: "Cotality 之镜：数据底座的门槛与路径"
reader_question: "全球最深的数据底座是怎么建成的？中国路径差在哪？"
page_task: "compare"
reading_mode: "reference"
archetype: "comparison-matrix"
asset_mode: "text-layout-native"
validation_mode: "diagram_visual"
key_message: "护城河公式=标识统一×来源直采×持续保鲜——制度解决了来源，剩下两环就是未来五年的全部竞争。"
layout_recipe: "swiss-duo-compare"
rhythm_role: "dense"
required_assets: []
asset_slots:
  - slot_id: "s21_cotality_path"
    page_role: "main_evidence"
    asset_type: "diagram"
    module: "diagram-visual"
    backend: "python-pptx"
    validation_mode: "diagram_visual"
    status: "planned"
```
**Page Role.** 对标研究页（公司公开口径，2026-08-28）。
**On-slide Copy.** 五阶段路径：承继县级公共记录→并购拼图（2011-2021，已披露对价约 11 亿美元，私有化估值约 59 亿美元）→CLIP 统一标识→数据制造工厂→保鲜机制（AVM 每日重算+夜间盲测）；底座数字卡：约 30 年建设、157M+ 统一房产标识（CLIP，匹配率 99.2%）、22,000+ 数据源、550 亿+ 条记录（50+ 年纵深）、年 1,100 亿次 API 调用、服务五大客群；经济门槛：全成本约 5-6 亿美元/年（约 35-42 亿元人民币），占年营收（约 115 亿 RMB）的 35-40%；照这面镜子看中国：①需求不用培育，制度已经开票——每一条条款都是数据采购的法律授权书 ②缺统一标识、富交易流水——中国版 CLIP 的主键（不动产权单元/网签编号）谁来跨省归并，谁占 backbone；同时中国独有主办行专户流水这一层制度性数据 ③门槛决定格局——对标 35-42 亿元/年，未来是国家队、平台型数据商、转型估值模型运营商的头部评估所三类玩家；中小评估所要么被整合进估值链，要么退守司法鉴定等细分；图⑩｜Cotality 五阶段建设路径+中美路径对照（市场并购拼图 vs 制度强制报送）双栏图。
**Notes 方向.** 讲稿：数字卡快读；重点讲"缺统一标识、富交易流水"的不对称与专户流水这层中国独有优势。
**Layout Notes.** 左栏 Cotality 五阶段竖列+数字卡；右栏中国三行对照；双栏 hairline 分隔；来源注「公司公开口径研究，2026-08-28」。

### S22 | 第十一章 城投
```yaml slide_spec
title: "城投：从「杠杆放大器」到「存量资产运营商」"
reader_question: "大扫除之后，什么样的城投能活下来？"
page_task: "explain"
reading_mode: "guided"
archetype: "research-note"
asset_mode: "text-layout-native"
validation_mode: "diagram_visual"
key_message: "大扫除之后，很多城投会发现自己「很大，但很空」。"
layout_recipe: "five-piece-with-diagram"
rhythm_role: "evidence"
required_assets: []
asset_slots:
  - slot_id: "s22_rental_loop"
    page_role: "main_evidence"
    asset_type: "diagram"
    module: "diagram-visual"
    backend: "python-pptx"
    validation_mode: "diagram_visual"
    status: "planned"
```
**Page Role.** 存量盘活章：保租房闭环。
**On-slide Copy.** 章眼金句；对照 3 行（信用/现金管道/分化）；条款（城市更新办法"负面清单+入场券"：不得新增隐性债务、不得接受任何政府隐性增信、不得以政府应付款项/无收益公益性资产抵质押 13 条；不得用于净地供应前征收补偿 8 条；借款人须为"市场化运营主体"且经营性收入足额覆盖本息 7、11 条；大额项目银团 9 条）；推论：①资产负债表强制大扫除：能进金融市场的只剩真经营性现金流——政府应付款和公益资产一夜之间"不可质押" ②"托底拿地"的死亡比房企暴雷更深刻：土地市场失去最后护盘资金，价格发现彻底真实化 ③生死线是"市场化运营主体"资格：够格者切换为资产收益率定价；不够格者退出房地产金融视野 ④保租房闭环是二十年来第一个"投入有退出、退出有倍数"的模型：保障房开发贷（保本微利）→团购房贷批量收房→租赁经营贷→REITs 退出；但定价闸门未开：租金回报率 2% 出头对 3% 资金成本——"算大账"能否成立，看分派率要求与利率走向；图⑪｜保租房闭环循环图（开发贷→团购收房→经营贷→REITs 退出→资金滚动）配 2% vs 3% 定价闸门标尺；机会/风险（机会=三条跑道+AMC 合作处置 信托 29 条；风险=注水诱惑→总结·失灵②、转型不及现金流缺口）。
**Notes 方向.** 讲稿："很大，但很空"解释信用幻觉；闭环四步循环；2% vs 3% 是闭环能否转动的物理常数。
**Layout Notes.** 环形四节点循环（箭头首尾相接）；旁挂闸门标尺（2%/3% 两刻度）；节点文字入 shape。

### S23 | 第十二章 沉默角色
```yaml slide_spec
title: "沉默角色：谁在进场，谁在出局，谁被忽略"
reader_question: "账单的背面写着谁的名字？"
page_task: "compare"
reading_mode: "reference"
archetype: "comparison-matrix"
asset_mode: "text-layout-native"
validation_mode: "diagram_visual"
key_message: "处置制度化、灰色清零、金融化机构化——但三类代价尚无制度回应。"
layout_recipe: "swiss-split-statement"
rhythm_role: "transition"
required_assets: []
asset_slots:
  - slot_id: "s23_balance_scale"
    page_role: "main_evidence"
    asset_type: "diagram"
    module: "diagram-visual"
    backend: "python-pptx"
    validation_mode: "diagram_visual"
    status: "planned"
```
**Page Role.** 进出场格局页+改革代价页。
**On-slide Copy.** 章眼金句「处置制度化、灰色清零、金融化机构化——但账单的背面写着三类人的名字」；进场/出局对照（进场：AMC——信托 29 条盖章合作处置、特殊机会投资制度化；机构投资人。出局：灰色助贷——名单制+银行独立核验、包装生意定点清除；散户投资人——非标只卖机构+48 小时冷静期，散户被请出了地产金融化的餐桌；1998 年个贷办法、九项央行旧通知、三项信托旧规——补丁版时代结束）；三类被忽略者（必须写在正面清单的背面）：①存量期房的已签约购房者——第 37 条"滞留乘客"：新制度保护增量，存量项目交付风险不变甚至恶化（银行资源向新体系项目倾斜）②非主办行中小银行及其储户股东——让出主办行资格的背面：让出资格不等于让出风险，坏账最终落在存款保险与股东身上 ③地方中小代理从业者——佣金结算后置+现房去化慢，返佣通道又被名单制掐断，无底薪佣金制的收入断崖，是"交付定价说明书"的人力成本背面；图⑫｜进场/出局天平图（左盘 AMC+机构，右盘助贷+散户+旧规则）底座标注三类被忽略者；机会/风险（机会=AMC/特殊机会赛道制度化；风险=三类代价长期无制度回应，侵蚀改革合法性）。
**Notes 方向.** 讲稿：天平讲完翻"背面"——三类被忽略者是改革合法性的账；"滞留乘客"比喻展开。
**Layout Notes.** 天平形状（横杆+双盘+底座文字条）；出局侧用警示色语义；"三类被忽略者"三行直角卡。

### S24 | 第十三章 补上的七类主体
```yaml slide_spec
title: "补上的七类主体：灯外的人"
reader_question: "十二个座位之外，谁最重大？"
page_task: "explain"
reading_mode: "reference"
archetype: "board-memo"
asset_mode: "text-layout-native"
validation_mode: "diagram_visual"
key_message: "十二个座位之外，还有七个人站在灯外——公积金是最大的那个缺席。"
layout_recipe: "matrix-with-stat"
rhythm_role: "dense"
required_assets: []
asset_slots:
  - slot_id: "s24_card_grid"
    page_role: "main_evidence"
    asset_type: "diagram"
    module: "diagram-visual"
    backend: "python-pptx"
    validation_mode: "diagram_visual"
    status: "planned"
```
**Page Role.** 补列章：2×4 卡阵全景。
**On-slide Copy.** 章眼金句；八卡（2×4）：公积金中心（最重大缺席——50%/60% 红线按"全部债务"计，公积金贷款与组合贷怎么计入，直接决定实际可贷空间；存量利率降到 3.05% 后公积金利差优势收窄，配置偏差需要重估；从强制储蓄向政策性金融拓展是 1+N 之后最顺理成章的制度接续点·高亮边框）/险资与养老金（REITs 与不动产私募最大的潜在资金方，久期天然匹配；配置约束决定产品菜单"钱从哪来"）/物业公司（社区场景入口与存量服务端——"好房子"与城市更新落地后的服务收入与现金流核验场景，隐藏受益者）/外资特殊机会基金（与 AMC 并肩的处置力量，价格出清到位后的潜在买方）/施工企业应收款链条（开发商现金流切为经营驱动后，工程款拖欠与应收款证券化的传导需要单独监测——既是接盘者，也是上游风险暴露者）/多套房持有者（"选择风险"的定价主体、二手供给主源——存量出清速度由他们决定）/卖旧买新的存量业主（带押过户+利率置换直接改写交易成本，单笔约省 4.5 万元，测算口径——改善链加速的微观基础）/附卡："好房子"第一次有了信贷价格（开发贷优先支持"好房子"项目 13/14 条——品质供给第一次与利率、额度分层挂钩；谁认证、什么标准、如何挂钩，是 2027 年最值得跟踪的执行点）；图⑬｜制度接续卡阵；机会/风险（机会=政策性金融与长期资金的制度接续；风险=悬而未决的问题拖成新的灰色地带）。
**Notes 方向.** 讲稿：公积金三问展开；其余卡快读；附卡"好房子"作为 2027 观察点收尾。
**Layout Notes.** 2×4 直角卡阵，公积金卡高亮边框；每卡=主体名+一行待答问题；卡内文字写入 shape。

### S25 | 总结·三重再分配
```yaml slide_spec
title: "总结：三重再分配"
reader_question: "十三章的变化能收拢成哪三件事？"
page_task: "persuade"
reading_mode: "decision"
archetype: "hero-statement"
asset_mode: "text-layout-native"
validation_mode: "preview_only"
key_message: "钱从此跟项目走，不跟老板走；责任第一次被写进岗位，而不是写进应急预案。"
layout_recipe: "editorial-big-number"
rhythm_role: "breath"
required_assets: []
asset_slots: []
```
**Page Role.** 总结开篇（深色节奏页）：回到总论三要素收口。
**On-slide Copy.** 一、知情权：信息从"集团内部人"流向"项目托管人"——主办行通过封闭账户成为第一知情人，并购市场因此降低尽调成本，评估机构被要求"可审计地知情"；知情权从关系网络中剥离，交给了制度位置。二、控制权：资金控制权逐级上收到"项目"这一层——集团资金池被拆掉（第三章）→项目封闭账户（第二章）→支付环节受托制（第二、六章）→购房款进监管账户（第一章）；控制权的终点不是监管机构，而是项目本身——钱从此跟项目走，不跟老板走。三、责任：从"事后救火"到"事前签字"——主办行签工程进度、保荐审计签披露、信托签项目管理人、评估签价值结论、平台签房源真伪、地方政府签白名单；签字者薪酬递延、追索扣回、通报主管机关——责任第一次被写进岗位，而不是写进应急预案。
**Notes 方向.** 讲稿：三重再分配逐条回扣章号；深色页只讲三句话，细节留给讲稿。
**Layout Notes.** 深青墨底；三个 ghost 大序号；每重金句+一行机制链；无卡片。

### S26 | 总结·风险产权的界定
```yaml slide_spec
title: "更深一层：风险产权的界定（科斯式起点）"
reader_question: "每类风险的主人是谁？为什么叫「科斯式起点」？"
page_task: "explain"
reading_mode: "decision"
archetype: "research-note"
asset_mode: "table-native"
validation_mode: "table_native"
key_message: "风险有主、部分有价、暂不可易——谁是风险的主人，风险才有价格。"
layout_recipe: "business-summary-grid"
rhythm_role: "evidence"
required_assets: []
asset_slots: []
```
**Page Role.** 全书理论定位页。
**On-slide Copy.** 病根句：旧模式真正的病根是风险产权不清——烂尾了，银行说购房人还贷、房企说资本金没了、地方说要维稳——每个主体都持有风险却不为风险付费，最后风险归零于全社会。新体系第一次给每类风险定了主人。风险产权表 4 行：交付风险→房企→工程能力=融资资格（开发贷优先"好房子"与现售）；项目信用风险→主办银行→利差与拨备；银团可分散、不可转嫁；市场风险（价格/时机）→购房人与投资者→选择自负；流动性风险→资本市场→RMBS/CMBS/REITs 的折价就是价格。准确叫法是"科斯式起点"而非"科斯时刻"：本质是产权清晰化降低交易成本；风险产权不是民法上的财产权，不可转让、没有独立定价市场，定价只能经利差、拨备、折价间接实现。检验信号要定准：不是"高风险项目被拒贷"（惜贷环境下拒贷是配给，不是价格），而是开发贷利差是否出现分项目评级的可观察分层。收口：定价维度已落地（核心竞争力排序翻转为产品＞运营＞融资），交易维度是半成品——风险有主、部分有价、暂不可易。谁是风险的主人，风险才有价格。
**Notes 方向.** 讲稿：科斯式起点白话——把"谁疼谁出钱"写进制度；检验信号别定错（拒贷≠定价）。
**Layout Notes.** 原生表格（风险｜归属｜定价机制）；"科斯式起点"词条式强调；收口句独立行。

### S27 | 总结·三层付费者与三个预言
```yaml slide_spec
title: "谁在买单，预言立在哪儿"
reader_question: "改革成本由谁承担？三个预言的区间和中位是什么？"
page_task: "evidence"
reading_mode: "reference"
archetype: "comparison-matrix"
asset_mode: "text-layout-native"
validation_mode: "diagram_visual"
key_message: "显性、隐性、延期三层付费者已经排队；三个预言全部可证伪。"
layout_recipe: "matrix-with-stat"
rhythm_role: "dense"
required_assets: []
asset_slots:
  - slot_id: "s27_forecast_rulers"
    page_role: "main_evidence"
    asset_type: "diagram"
    module: "diagram-visual"
    backend: "python-pptx"
    validation_mode: "diagram_visual"
    status: "planned"
```
**Page Role.** 代价与预言合并页。
**On-slide Copy.** 三层付费者：显性——高杠杆房企、通道信托、灰色助贷、小评估所（旧利润就是制度租金，租金随制度一起取消）；隐性——地方政府（拔掉土地金融杠杆）、银行体系（责任成本上升，以信息地位换对价；若数据变现不兑现，叠加净息差约 1.5%，惜贷就是唯一理性选择）；延期——购房者以"选择风险"替换"交付风险"（50%/60% 红线就是强制预算约束：既是保护，也是收缩）。三个可证伪预言（研判推断）：①三年内期房销售占比降至三成以下，准现房成为主流——区间 30%-65%，中位约 45-55%：方向共识、量级分歧；验证锚：新增预售证中"封顶/竣工后取证"销售占比（主锚）；必须做归因分解——防"总量萎缩的分母假象"冒充模式切换 ②主办银行制催生项目信贷二级市场——区间 35%-60%，中位约 50%：分歧最大；验证锚：开发贷 ABS 与信贷资产流转成交额（主锚）；"转让后主办行责任移转"细则——责任不随份额移转，二级市场只在银团内部打转 ③出现 3-5 家"F+EPC+O"千亿级涉房建筑/城投运营商——区间 20%-55%，中位约 30%：最脆弱——"参照涉房"是准入不是激励；千亿级按管理规模/合同额计；区间标尺（区间带+中位标记，数字入图，标"研判推断"）。
**Notes 方向.** 讲稿：付费者讲"谁疼"；预言强调可证伪与验证锚，特别是归因分解防分母假象。
**Layout Notes.** 上半三列付费者直角面板；下半三条区间标尺（0-100 刻度线+区间块+中位三角标）；标"研判推断"。

### S28 | 总结·五个失灵变量
```yaml slide_spec
title: "体系的五个失灵变量"
reader_question: "哪个失灵会启动连锁？哪个最危险？"
page_task: "explain"
reading_mode: "decision"
archetype: "decision-logic"
asset_mode: "text-layout-native"
validation_mode: "preview_only"
key_message: "惜贷是启动器，注水最危险；惜贷×通道不足=出清停滞。"
layout_recipe: "editorial-data-pipeline"
rhythm_role: "evidence"
required_assets: []
asset_slots: []
```
**Page Role.** 风险清单页（按风险权重排序）。
**On-slide Copy.** ①银行惜贷（启动器）：净息差约 1.5%、降息静态冲击约 -4bp（对冲后 -1~-2bp）之下，少做是理性；主办行不投放，放款时点、受托支付、进度匹配全部空转，并同时杀死开发贷、并购配套与按揭置换。第一检验：开发投资 -19.2% 的斜率能否在 2027 年收窄至 -10% 以内；2026Q4 白名单贷款覆盖率。②项目现金流注水（最危险）：把财政性收入化妆成经营性收入，城市更新通道就变成新的隐性债务入口——不是失灵，是反向利用；且直接污染风险定价的信息底座；立竿见影的不如它，但它是永久性的。③知情权二次垄断/数据断供：知情权再分配只完成了"房企→银行"一半，"银行→市场"没有强制共享条款，而银行有独占激励；一旦断供，并购尽调、评估基建、REITs 核验三处推论同时落空，且不可政策自纠——盲购，通道再宽没人敢走。④评估核验被俘获（可对冲）：名单制、追索、头部化在降低概率；孰低原则也降低了对单一结论的依赖。⑤并购通道容量不足（可调节）：法拍、AMC 受让、信托合作处置都是替代通道，审批节奏监管可自主调节；但防交互风险：惜贷×通道不足=出清停滞。
**Notes 方向.** 讲稿：五项按"启动器/最危险/可对冲/可调节"标签讲；两个检验锚（-10% 以内、白名单覆盖率）是听众可自查的公开数据。
**Layout Notes.** 五行阶梯列表（序号 ghost 大字）；标签词语义色小 tag；无卡片墙。

### S29 | 总结·传导时序
```yaml slide_spec
title: "传导时序：日历上钉三个锚"
reader_question: "接下来十二个月看什么、何时看？"
page_task: "explain"
reading_mode: "guided"
archetype: "process-flow"
asset_mode: "text-layout-native"
validation_mode: "diagram_visual"
key_message: "2026Q4 看惜贷，2027H1 看止跌，2027-03 看切换。"
layout_recipe: "editorial-data-pipeline"
rhythm_role: "evidence"
required_assets: []
asset_slots:
  - slot_id: "s29_timeline"
    page_role: "main_evidence"
    asset_type: "diagram"
    module: "diagram-visual"
    backend: "python-pptx"
    validation_mode: "diagram_visual"
    status: "planned"
```
**Page Role.** 执行观察时间轴页。
**On-slide Copy.** 总则：新办法即行适用于新签合同；第 37 条新老划断缓冲存量；信托办法 2027-03-01 施行、存量结清。三锚：2026Q4——白名单覆盖率与主办行投放（检验惜贷）；2027H1——按揭余额能否止跌：无周期工具并联，止跌概率约 55-60%；收储贴息（约 3 万亿、100-200 万套，测算口径）落地并联后可上修至 70% 以上；2027-03——信托新旧切换，警惕过渡期抢跑。存量循环收拢成一张图：卖旧（带押过户+置换）→买新（现房+按揭衔接）→租赁吸收（团购/经营贷）→REITs 退出（分派率核验）——每一环的摩擦都被新政降低，但需求端基本面仍是决定项。传导时序时间轴+概率上修标尺（55-60%→70% 以上）。
**Notes 方向.** 讲稿：三锚逐个给"看什么数据、去哪查"；止跌概率的上修条件（收储并联）讲清因果。
**Layout Notes.** 水平时间轴三节点（日期大字）；概率标尺从 55-60% 带延伸至 70% 以上箭头；底部四环循环条。

### S30 | 总结·数据互证、最大不确定性与收束
```yaml slide_spec
title: "与数据的互证，与终局的距离"
reader_question: "市场底到了吗？最大的不确定性是什么？"
page_task: "persuade"
reading_mode: "decision"
archetype: "hero-statement"
asset_mode: "text-layout-native"
validation_mode: "preview_only"
key_message: "成败不在条文，在未来十二个月每个签字者的选择。"
layout_recipe: "editorial-big-number"
rhythm_role: "evidence"
required_assets: []
asset_slots: []
```
**Page Role.** 总结收束页。
**On-slide Copy.** 与数据的互证：全国政策底不等于市场底（销售 -11.8%、投资 -19.2%）；北京（二手六连窄、销售转正）与南京（新房修复最快、二手仍在出清）的分化说明市场底分城市、分环节到来——这份体系不承诺统一的市场底，它承诺的是：无论哪里先见底，每个角色都已在正确的位置上。最大的不确定性：旧函数借过渡安排还魂——制度可迭代是双刃剑，若 2027 年下行压力超预期，新老划断弹性化、白名单扩容、利率窗口指导都可能让旧模式借壳回归；监管自身的执行，是终局变量；短期回暖不急于加大供地，短期下行不重启总量刺激——两份定力，是一枚硬币的两面。收束：这是一次风险产权的界定——交付风险归房企、信用风险归主办行、市场风险归购房人与投资者、流动性风险归资本市场，每一类风险第一次有了主人，也就第一次有机会有价格；成败不在条文，在未来十二个月每个签字者的选择——旧模式里所有人都在赚"预期"的钱，新模式里所有人只能赚"交付"的钱。
**Notes 方向.** 讲稿：互证回扣 S09 分化；不确定性讲"两份定力"；收束句放慢语速，衔接结语表。
**Layout Notes.** 三段式：互证/不确定性/收束；收束金句衬线大字；hairline 分隔；无图。

### S31 | 结语·谁获益、谁付费
```yaml slide_spec
title: "结语：谁获益、谁付费"
reader_question: "十三类主体的净效应清单是什么？"
page_task: "archive"
reading_mode: "reference"
archetype: "appendix-dense"
asset_mode: "table-native"
validation_mode: "table_native"
key_message: "总收束：制度底座先行，市场底未确认；先立后破——立已到位，破在执行。"
layout_recipe: "business-summary-grid"
rhythm_role: "dense"
required_assets: []
asset_slots: []
```
**Page Role.** 全书索引式收尾表。
**On-slide Copy.** 13 行表（主体｜新身份｜一句话净效应）逐行照 md（购房者→补列七类）；底部总收束行「制度底座先行，市场底未确认；先立后破——立已到位，破在执行。」
**Notes 方向.** 讲稿：不逐行念；横向对比"新身份"列的角色跃迁词（消费者/托管人/项目经理/发行人/合伙人……）。
**Layout Notes.** 原生表格 10.5pt；表头深青底；行高均匀；总收束行琥珀强调。

### S32 | 来源披露
```yaml slide_spec
title: "数据与条款来源"
reader_question: "每个数字从哪来、什么口径、哪些待补？"
page_task: "archive"
reading_mode: "reference"
archetype: "appendix-dense"
asset_mode: "text-layout-native"
validation_mode: "preview_only"
key_message: "全程未编造数字；测算/估算/研判推断/待补四级标注。"
layout_recipe: "editorial-margin-mechanism"
rhythm_role: "transition"
required_assets: []
asset_slots: []
```
**Page Role.** 可追责性落点页（domain_profile 纪律核心）。
**On-slide Copy.** 条款：引自文件原文，条号以正文为准。宏观数据：Wind CLI（Wind EDB：中国人民银行、国家统计局），月度截至 2026-07、季度截至 2026Q2，指标代码可溯源（按揭余额 W1409719、按揭利率 M0058005/X1390479、新宅价格 S2707411、二手价格 S2707425、开发投资 S0029657、销售面积 S0073300、北京 S0147146/S0030589/S0073345/M0004504、南京 S0147156/S0030649 等）。分城市：国家统计局 70 城指数与地方统计局序列；南京销售面积市统计局口径更新滞后（最新 2026-02），已如实标注。贝壳政研通（zyt）通道经修复后已可透出数值明细，本报告采用其趋势性结论（京宁二手成交动能：3-6 月同比连续为正），价格与信贷定量仍以 Wind 为准，全程未编造数字。Cotality 部分引自对标研究《Cotality 数据基建深度分析 V1》（公司公开口径，2026-08-28），仅作能力参照。四级标注："测算"者为模型测算（100 万/3.06%/等额本息；存量降 50bp×36.29 万亿；过桥 4.5 万/单；收储 3 万亿/100-200 万套），"估算"者为量级推断，"研判推断"者为分析性判断，"待补"者为观察清单项：期房/现房占比基线、30 城二手成交量同比（京宁已补、30 城口径待补）、涉宅用地成交与城投拿地占比、竣工面积同比、房企到位资金分项（定金及预收款占比）、新开工面积、克而瑞百强销售与集中度、白名单授信覆盖率、公积金贷款余额、货币化安置规模、收储专项债发行额、信托投向房地产余额、住户杠杆与收入分布。评审说明：本报告经五位独立评审专家（行业研究、政策制度、宏观经济方向）两轮评审复核。
**Notes 方向.** 讲稿：三通道状态口径（Wind 已透出数值/zyt 趋势性）；四级标注各举一例。
**Layout Notes.** 双栏 10.5pt 小字文本；来源组间 hairline；无图。

### S33 | 封底
```yaml slide_spec
title: "封底·交付的定价说明书"
reader_question: "用什么一句话带走整份报告？"
page_task: "persuade"
reading_mode: "scan"
archetype: "hero-statement"
asset_mode: "text-layout-native"
validation_mode: "preview_only"
key_message: "这份 1+N 文件体系，就是交付的定价说明书。"
layout_recipe: "editorial-cover"
rhythm_role: "closing"
required_assets: []
asset_slots: []
```
**Page Role.** 收束页（深色节奏页）。
**On-slide Copy.** 收束金句大字「这份 1+N 文件体系，就是交付的定价说明书。」；版本块：《一场「角色重写」——房地产金融新政对行业参与主体的影响》完整报告 v5.4 · 2026-08-29｜数据口径：Wind EDB 月度截至 2026-07、季度截至 2026Q2；金监总局 2026Q2｜分析对象：房地产金融 1+N 文件体系（2026-08-27 印发）；免责一行「行业研究，不构成投资建议；测算/估算/研判推断非官方统计」；品牌行「98wiki ｜ 智见点评 · 行业研究」。
**Notes 方向.** 讲稿：金句收束+一句行动指引（盯 2026Q4 白名单覆盖率）；致谢与口径提醒。
**Layout Notes.** 深青墨底；衬线金句白字；版本块小字左对齐；免责行 9pt 图注档；与封面呼应的 hairline。

## 逐页 speaker notes 原则
- 每页 notes 写讲稿（约 120-220 字）：先承接上一页，再给本页"怎么讲"，不复读页面文字；数字朗读与页面一致。
- 深色节奏页（S01/S03/S25/S33）notes 承担被省略的细节，形成"页面少、讲稿厚"的 editorial_ink 节奏。
- 敏感性处理：二手成交量一律趋势表述；预测一律"研判推断"；测算/估算带口径词。
