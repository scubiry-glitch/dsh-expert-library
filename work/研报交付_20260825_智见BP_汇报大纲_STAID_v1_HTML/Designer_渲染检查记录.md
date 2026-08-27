# Designer 渲染检查记录

- 交付物：`智见BP_汇报大纲_STAID_v1_视觉稿.html`（单文件自包含，68 KB，996 行）
- 渲染日期：2026-08-25
- 渲染引擎：Headless Chromium（playwright-core · chromium-1234）本地验证
- 底稿：`7934893075d2-20260825_智见BP_汇报大纲_STAID_v1.md`（210 行，数字与口径全部照抄，未新增任何数字）

---

## 1. 交付物清单

| 文件 | 说明 |
|---|---|
| `智见BP_汇报大纲_STAID_v1_视觉稿.html` | 单文件自包含 HTML5 视觉稿，无外部依赖（无 CDN / 无字体 / 无图表库），可直接浏览器打开 |
| `智见BP_汇报大纲_STAID_v1_视觉稿.pdf` | weasyprint 导出的 A4 PDF（16 页，含逐页页眉页脚），见第 7 节 |
| `Designer_渲染检查记录.md` | 本记录 |
| `_check/desktop-1440.png` / `_check/mobile-390.png` | 全页截图验证（chromium 渲染） |
| `_check/pdf-page-1.png` / `_check/pdf-page-3.png` / `_check/pdf-page-16.png` | PDF 抽查页渲染（fitz 100dpi） |

## 2. sha256

```
eac9d93a94e6861b2ccdaa23e47780746837f7fecdc40f86884c2e212e269d35  智见BP_汇报大纲_STAID_v1_视觉稿.html
b41698d4128254477dca63332c21ff6bad17e59e25879f346e9c7c775220e295  智见BP_汇报大纲_STAID_v1_视觉稿.pdf
```

> 注：HTML 在 PDF 导出阶段追加了打印适配（全部位于 `@media print` 内：表格去 min-width、行防拆分、网格简化、masthead 字号钉定），故 HTML sha256 由初版 `fa73e2a0…` 更新为本版 `eac9d93a…`；屏幕渲染行为不变。

## 3. 关键设计决策

- **Register**：`product`（报告/BP 大纲文档页）。不启用 brand 的 grain / vignette / hero engine；SPECTACLE=2（仅 reveal + 计数动效，纯 CSS + 原生 IntersectionObserver，零外部库）；DENSITY=7（中高密度长文）。
- **配色（贝壳蓝金双色，锁定）**：
  - 页面底色 tinted neutral `#edf0f6`（偏冷蓝灰，非纯白）；卡片 `#fcfdff`；嵌套块 `#f3f6fb`
  - 品牌双色：Cobalt `#2d5bd8`（正文级强调用加深 `#1e44a8` 保证对比度）+ 金 `#c98a2e`（文字级 `#8a5f14`）
  - 语义色与品牌色分离：`--up #1d7a4f / --down #b3402f / --warn #8a6a13`，与蓝金不冲突；图表系列色未使用红绿语义冲突
  - hairline 边框 `rgba(20,32,56,.08)`，whisper 阴影 `0 1px 3px rgba(20,34,64,.06)`，全部阴影无纯黑
- **布局**：单页长文滚动（有意不用 v37 的 100vh deck 分页，因这是汇报大纲文档）；顶部 sticky 导航 + 滚动进度条；masthead（品牌 kicker + 大标题 + 一句话定位 + 元信息 chips + 4 个计数统计）；六个章节 chapter 带（深蓝渐变 + 金色点缀 + corner glow，呼应 v37 深蓝 chapter 页）。
- **mermaid 改造**：流程图完全重构为纯 HTML/CSS 静态分层图（客户六类 chips → ↓ → S 方案四件卡 → ↓ → STAID 四层堆叠条 → 五条横向链），无 mermaid 依赖，浏览器直接可看；客户→方案映射（C1/C2→P1、C3→P3、C4/C5→P2、C6→P4）以角标呈现。
- **字体**：系统中文字体栈 `PingFang SC / Microsoft YaHei / Noto Sans CJK SC / Source Han Sans SC`，标题 800-900 字重，数字用 tabular-nums；拉丁链名（Identity 等）用系统等宽栈点缀。
- **表格**：竞品地图 7 行、数据矩阵 6 行、数据源 4 行，深蓝表头 + hairline 行分隔 + 斑马纹；窄屏（<760px 内容宽）表格在卡内横向滚动（`overflow-x:auto`，不截断、不压缩）。
- **动效**：`.reveal` 上浮淡入（stagger 由 `--d` 控制）+ masthead 计数 roll-up + 滚动进度条 + 导航 scrollspy；全部有 `prefers-reduced-motion` 回退（CSS 全局 kill + JS `no-motion` 分支 + 计数直接落终值）。

## 4. 检查项与结果（Headless Chromium 实测）

### 4.1 无横向溢出 ✅
| 视口 | scrollWidth - clientWidth | 结果 |
|---|---|---|
| 1440×900 | 0 px | 通过 |
| 768×900 | 0 px | 通过 |
| 390×844 | 0 px | 通过 |
| 320×900 | 0 px | 通过 |

过程中发现并修复：390px 下 STAID 底座 chips（`white-space:nowrap` 超宽）曾造成 498px 溢出 → 改为允许折行；320px 下商业模式三包 chips 同因 → 修复。表格类内容宽度按设计在容器内滚动，不参与页面级溢出。

### 4.2 对比度抽查（WCAG，正文 ≥4.5:1）✅
| 组合 | 比值 | 结果 |
|---|---|---|
| 正文 ink `#16233c` on 页面 `#edf0f6` | 13.73 | 通过 |
| 次级 ink-2 `#3d4c66` on 卡片 `#fcfdff` | 8.51 | 通过 |
| 弱化 ink-3 `#57677f` on 页面 | 5.04 | 通过 |
| 弱化 ink-3 on 卡片 | 5.65 | 通过 |
| 强调蓝 `#1e44a8` on 页面 | 7.52 | 通过 |
| 金 `#8a5f14` on 卡片 | 5.54 | 通过 |
| 表头白字 `#eef3fb` on 深蓝 `#12294e` | 12.97 | 通过 |
| 导航激活白字 on `#1e44a8` | 8.58 | 通过 |
| 金底金字（gold-soft / gold-deep） | 4.86 | 通过 |
| 语义红 `#b3402f`、绿 `#1d7a4f` on 卡片 | 5.59 / 5.22 | 通过 |

### 4.3 表格 / 卡片无截断 ✅
- 三张表格渲染行数实测：竞品地图 7、数据矩阵 6、数据源 4，与底稿一致；表头 `scope=col`，行分隔 hairline，无内容裁切（单元格自动高度，min-width 由容器滚动承载）。
- 六张客户卡、三张 T·A·I 层卡、政策库三卡、支撑机制四卡均为正常流布局，实测无重叠、无溢出元素（脚本遍历全部元素 bounding box，无未收容溢出）。

### 4.4 无纯黑阴影 / 无纯白页面 ✅
- 全部 16 处 `box-shadow` 均为 tinted 阴影（`rgba(20,34,64,…)`），无 `rgba(0,0,0,…)` / `#000` 阴影。
- 页面背景 `#edf0f6`（tinted），卡片 `#fcfdff`；CSS 中唯一 `background:#fff` 位于 `@media print`（A4 纸张白底，属打印约定，非屏幕）。
- 屏幕上的 `#fff` 均为深蓝底上的文字色，非表面色。

### 4.5 动效 reduced-motion 回退 ✅
- `emulateMedia({reducedMotion:'reduce'})` 实测：全部 `.reveal` 立即可见（无隐藏元素）、计数直接显示终值 6/4/5/5、`html.no-motion` 生效；CSS 兜底 `animation/transition-duration:.01ms!important` + `scroll-behavior:auto`。
- 正常模式：滚动至页底后全部 reveal 终态可见（stuck=0），计数终值 6/4/5/5；另加 600ms×12 次的安全网，锚点跳转/快速滚动亦收敛。

### 4.6 打印约定 ✅
- 屏幕页脚：「98wiki ｜ 智见 / 行业研究报告」+ 底稿来源行。
- `@page` A4：`@bottom-center` 页脚「98wiki ｜ 智见 / 行业研究报告 · 第 X 页 / 共 Y 页」、`@top-center` 文档标题；打印时隐藏导航/进度条，深色 chapter/masthead 保留色（`print-color-adjust:exact`）。
- print 媒体模拟实测：导航隐藏、正文白底正常。

### 4.7 控制台与脚本 ✅
- 4 个视口 × 全页滚动：`pageerror` 0、console error 0；mermaid 残留 0。

## 5. 截图验证说明

- 环境可用 Headless Chromium，已生成 `_check/desktop-1440.png`（全页 1440×8630）与 `_check/mobile-390.png`（全页 390×15506）存档，供人工复核。
- 本环境视觉模型通道（describe-image）配置不可用，改用程序化 DOM/CSS 审计（上表）完成等价检查，覆盖溢出、对比度、截断、阴影、动效终态与打印媒体。

## 6. 遗留说明

- 页内数字均为底稿原文；「银行千万级合同为目标假设（需验证）」「信心指数暂缓对外」等边界表述已在稿内显式标注。
- ~~未做 PDF 导出~~：已于 2026-08-25 完成 weasyprint A4 导出，见第 7 节。

## 7. PDF 导出（weasyprint · A4）

- 工具：weasyprint 69.0（CLI）+ PyMuPDF 1.27.2（验证）；字体 Noto Sans CJK SC（系统安装）。
- 输出：`智见BP_汇报大纲_STAID_v1_视觉稿.pdf`（911 KB）
- sha256：`b41698d4128254477dca63332c21ff6bad17e59e25879f346e9c7c775220e295`
- **页数：16 页**（A4）
- 页眉页脚逐页断言（fitz 文本抽取）：16/16 页页脚「98wiki ｜ 智见 / 行业研究报告 · 第 X 页 / 共 16 页」存在且页码计数器逐页正确；16/16 页页眉文档标题存在。
- 溢出/截断抽查：逐页 text-block 几何扫描，0 个文本块越出可打印区（A4 595×842pt，左右边距 16mm，容差 10pt）；表格在打印媒体内去除 min-width 后按列宽自适应折行，竞品地图（7 行）、数据矩阵（6 行）、数据源（4 行）关键内容关键词全部在文本流中命中，无截断。
- 配色保留：第 2 页起深蓝 chapter 带以填色绘制（flat fill 实测 3 处/页级），金色点缀 fills 全文档 87 处；第 1 页 masthead 渐变以 shading/大面积 fill 渲染；`print-color-adjust:exact` 全文档生效。
- 打印隐藏：`@media print` 下 topnav 与进度条 `display:none!important` 生效。
- 已知偏差（weasyprint 忽略项，均不影响内容与布局完整性）：`text-wrap:balance/pretty`、`box-shadow:var(--…)`、`clip:rect`（visually-hidden 标题）、屏幕端 `@media (max-width:…)` 与 `prefers-reduced-motion` 规则在打印解析时被忽略——打印样式已用独立覆盖块钉定。
- 抽查页渲染存档：`_check/pdf-page-1.png`（封面/masthead）、`_check/pdf-page-3.png`（章节带+内容）、`_check/pdf-page-16.png`（末页+页脚）。

---

## 8. 贝壳生态研判版（v2 增量更新 · 2026-08-25）

> 基于 v1 视觉稿增量更新：**保留 v1 原版不动**，新建 `智见BP_汇报大纲_STAID_v2_贝壳生态版.html`，叠加 t5 融合结论《贝壳生态研判_智见BP_STAID_v1_结论.md》（四位专家：杨现领 bk-033 / 左晖 e08-08 / 柴强 bk-018 / 琉 bank-11，框架 B 四段式，正式稿）。

### 8.1 交付物清单

| 文件 | 说明 |
|---|---|
| `智见BP_汇报大纲_STAID_v2_贝壳生态版.html` | 单文件自包含 HTML5（v1 原版保留），无外部依赖 |
| `智见BP_汇报大纲_STAID_v2_贝壳生态版.pdf` | weasyprint A4 导出（24 页，98wiki 页脚约定逐页断言通过） |
| `_check/v2-desktop-1440.png` / `_check/v2-mobile-390.png` | 全页截图存档 |
| `_check/v2-pdf-page-cover.png` / `-appendix-first.png` / `-appendix-last.png` | PDF 抽查页（第 1 / 19 / 24 页） |

### 8.2 sha256（终版）

```
f1a27bfadb1b19f16e709dde29904a94d499d16e9bb0931e41dbeef8094f50c4  智见BP_汇报大纲_STAID_v2_贝壳生态版.html
859153307120b6be862c761f95a995bb747a6147f21c5752009d87a8e7a87a33  智见BP_汇报大纲_STAID_v2_贝壳生态版.pdf
```

> 注：HTML 终版清理了一处多余 `</div>`（浏览器/weasyprint 均忽略、渲染字节级不变，PDF 哈希与清理前一致）；终版标签平衡校验 0 错误。

### 8.3 新增内容摘要

- **新章节「附录 · 贝壳生态研判结论」（SEC.A，置于支撑机制之后）**：
  - A.1 核心结论 5 条（编号卡：定位成立 / 方向正确节奏错配 / 壁垒在工程不在条数 / 落地须聚焦 / 关键待验证）
  - A.2 专家观点矩阵表（议题 × 四视角，5 行）
  - A.3 共识 5 条 / 分歧 4 条（蓝金双栏）
  - A.4 增补修正建议 → 本稿落点对照表（10 行，可追溯每处正文修改）
  - A.5 风险与验证指标表（7 行）
  - 口径声明引用块（数字一律沿用底稿口径，未新增编造数字）
- **正文融入（10 条建议，原文保留、批注显式标注）**：客户①复现边界限定、客户②40/50 城分层、客户③评估机构分润补位、客户④DSCR 监管压力情景对标、§1.2 付费测试卡＋政府端免费投入 ≤20% 上限卡、竞品表 7→6 行（贝壳研究院移出）＋生态协同卡＋差异化结论补位条、A 层多专家分歧管理、I 层活跃指数分层＋信心指数重启条件、§5 60 天灯塔聚焦制（方案甲/乙）＋三步走补 Ask。

### 8.4 检查项与结果（Headless Chromium + weasyprint 实测）

| 检查项 | 结果 |
|---|---|
| 无横向溢出（1440 / 768 / 390 / 320） | 通过，页面级 scrollWidth−clientWidth = 0（4/4 视口）；表格在 `.table-scroll` 容器内滚动，容器自身不越界 |
| 对比度 ≥4.5:1（新增 20 组色对：rev-note 金深、eco-card、cons-col 双栏、concl-card、revise、quote-box 等） | 全部通过，最低 4.86（金深 on 金软），最高 15.40 |
| 表格无截断（6 张表：竞品 6 行、矩阵 6、数据源 4、观点矩阵 5、落点对照 10、风险 7） | 通过，长单元格关键词全部在 PDF 文本流命中；打印媒体 min-width 清零按列宽折行 |
| reduced-motion 回退 | 通过：`no-motion` 生效、reveal 全部立即可见、计数直落终值 6/4/5/5 |
| PDF 页脚逐页断言 | 24/24 页「98wiki ｜ 智见 / 行业研究报告 · 第 X 页 / 共 24 页」页码计数器逐页正确；页眉 24/24 |
| PDF 内容溢出扫描 | 0 个内容文本块越出可打印区（排除页眉页脚边距盒后） |
| 控制台与脚本 | 4 视口 × 全页滚动 pageerror 0、console error 0 |

### 8.5 本版修复的两个缺陷

1. **reveal 安全网滞留**（发现于 390px 快速滚动测试）：原 sweep 只释放视口内元素，IO 尚未触发就被滚过的上方元素会永久滞留不可见。修复：sweep 对视口上方元素一并放行（`r.top<innerHeight`），并在 12 轮后强制收敛全部 reveal。4 视口 × 首屏 100ms 内直滚页底的苛刻用例全部 stuck=0。
2. **weasyprint 网格跨轨道 bug**：`.concl` 内第 5 张结论卡用 `grid-column:1/-1`（宽卡）时，weasyprint 69 的自动放置错乱（卡片丢失、右列被压缩至 ~58pt 并溢出页边，最小化复现确认与轨道尺寸/`minmax`/`min-width:0` 无关）。修复：第 5 卡移出网格、作为独立通栏卡（`margin-top:14px`），屏幕与打印视觉一致（1440 实测 w=1064 通栏）；同时打印网格改用 `minmax(0,1fr)` 与卡片 `min-width:0` 防御。

### 8.6 weasyprint 已知偏差（延续 v1，不影响内容与布局完整性）

`text-wrap:balance/pretty`、`box-shadow:var(--…)`、`clip:rect`（visually-hidden 标题）、屏幕端媒体查询与 reduced-motion 规则在打印解析时被忽略；打印样式已用独立覆盖块钉定。
