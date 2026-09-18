# 渲染检查记录 · t6 渲染与生成（HTML5 → PDF/PPTX → 视频）

项目：收储用途扩围与平台机会 · 制度机制的识别与检验（正式稿）
渲染节点：Designer（智见点评 · 制度设计）· 2026-09-16
内容单源：`expert-teams/智见点评-制度设计/expert-tasks/t5/output/融合稿_收储用途扩围与平台机会_正式稿.md`

## 交付物清单（路径 + sha256）

| 交付物 | 路径（相对 `artifacts/`） | 大小 | sha256 |
|---|---|---|---|
| HTML5 视觉稿 | `html/收储用途扩围与平台机会_正式稿.html` | 54,851 B | `59df81acec3d47e5e0d3fdf46409caea6ccaba080e9f81ed1710d80caec316a7` |
| PDF（A4 正式稿，15 页） | `pdf/收储用途扩围与平台机会_正式稿.pdf` | 1,083,089 B | `766b47ed6f81981101bfee8d8f29b535846a6a670b28bc9c9d3e244085a229d0` |
| PPTX（可编辑，22 页） | `ppt/收储用途扩围与平台机会_正式稿.pptx` | 107,476 B | `dd0e1404ac4cd196536dd4d0a20ef40ba5e219a902b333a70a26efb59d09da80` |

- **外网链接（免登录）**：<https://yy.meizu.life/render/智见点评-制度设计/shouchu-kuowei.html> — 实测 HTTP 200，且与本地 HTML **sha256 逐字节一致**（已 diff 校验）。
- deck 源工程：`ppt/`（`deck.spec.json` + `pages/*.json` × 22 + `style.json` + `build_deck.py`），可随时改页重渲染。
- 门禁脚本：`gates/run_gates.py`（G1–G5 一键）、`gates/ppt_gates.sh`（pptfast 四连）。
- 截图与证据：`shots/`（`report_1280_full.png`、`report_375_full.png`、`metrics.json`、`pdf_page_*.png`）。

## 设计决策（finesse-ui register）

- **register=product**（研报/报告页，pages you read）；**SOUL 6 · SPECTACLE 2 · DENSITY 7**。
- **零 JS 引擎**：全部图表为手写 CSS/SVG（横向条按 最大值 50% 归一、水位图、色阶矩阵），无任何 `<script>`（门禁实测 scripts=0）。
- **配色**：深青墨 `#0e6a55` + 琥珀金 `#8f6119`（模板 `report-template-fivepiece-v1.md` §4 的权威 register）。
  - ⚠ **与任务书示例「贝壳蓝金」的取舍（已向队长报备，待用户一句话拍板）**：任务书原文为「配色按场景主题（如贝壳蓝金）」，「如」为示例；模板 §4 明确 智见点评·行业研究报告 的 register 是「深青墨+琥珀金」。同时按 anti-sameness 原则，上一版收储类报告（南京江北新区合资收储）已用 cobalt 蓝金，本版沿色会同调。故默认取模板权威色，并把全部颜色收敛为 `:root` token，**切换贝壳蓝金 ≈ 1 分钟**。
- **weasyprint 兼容**：多列数字条一律 `flex`（不用 grid，避列宽塌陷）；SVG/图形不用 box-shadow。
- **A4 打印**：8 列「用途—现金流矩阵」在打印态切 `table-layout:fixed` + 逐列宽度 + `7.6pt`，避免右侧裁切（实测越界 span=0）。

## 门禁结果（五道门全过，`gates/run_gates.py` exit 0）

| 门 | 检查 | 结果 |
|---|---|---|
| G1 文字 | 禁例 token（专家实名/过程痕迹/版本号 9 项）；品牌行 | **0 命中**；品牌行在位 |
| G2 数字 | 9 个锚点逐项（约50% / 551 / 5.336 / 2.25万 / 1500 / 35.6 / 0.24万 / 8公里 / 5.3亿） | HTML **9/9**、PDF **全在**、PPTX **全在** |
| G3 设计 | finesse detect；playwright 双视口；对比度 AA | **P0=0**；1280 overflow=0；375 页级 overflow=0 且无越界元素；**对比度 15 组全过 ≥4.5:1**；零 JS |
| G4 PPT | pptfast `validate` + `audit` + notes | validate **OK 零 warning**；audit **exit 0 / 0 findings**；notes **20/22**（封面封底无 notes 属正常）；「研判推断」38 处、「待补」7 处 |
| G5 PDF | 页数/页脚逐页/大纲/边距 | 15 页；正文页脚 **13/13**；封面封底无页码；右边距越界 **0** |

**finesse detect 剩余 1 项 P1（accepted，有据）**：`side-stripe` ×1 —— 即「金句引言块」的 4px 琥珀左边框。这是模板 §4 明文规定的智见研报组件语汇（pull-quote 装置，非卡片装饰），属**经论证的刻意偏离**，非 AI-slop。原 `pure-bw` 项已修（去掉打印态 `#fff`）。

## 过程中发现并规避的坑（可复用）

1. **pptfast 0.20.0 要求 Node ≥22.19**，本机默认 `node -v` = **20.20**，技能自带 `scripts/run.sh` 会直接拒绝（`selected: none`）。解法：`export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"`（本机 nvm 已装）。
2. **`balanced` pacing 只接受 6–24 页**，3 页 deck 在 `spec validate` 即被拒。
3. **`cover`/`ending` 是边界页**，不渲染 components，但**必须存在同名 `pages/*.json` 空对象 `{}`**，否则 `render` 以「unfilled placeholder」拒绝出片。
4. **`data_table.rows[].cells` 是按 column `key` 索引的 record**（不是数组）；**`kpi_cards.items[]` 无 `note` 字段**（只有 value/unit/label/delta/icon/source）。
5. **`theme.json` 自动加载且需 `brand extract` 全量 schema**（`style.id/fonts/defaultBackgrounds`）。捷径：spec 用内置主题（本稿用 `pulse`，primary `#0E6E66` ≈ 深青墨）+ `render --style style.json` 叠加精确颜色。
6. **bullet 有渲染安全上限**（约 50 宽度单位，按布局浮动，CJK≈2 单位）——超长会硬报错；`validate` warning 提示 balanced pacing 每页 ≤5 条、每条 ≈2 行。
7. **`audit` 的 content-truncated** 会真实报出标题/页脚/表格 source 被省略号截断；需缩短标题或把细节移入 footnote。

## 待用户确认事项（渲染节点不是终点）

1. **配色一句话拍板**：维持深青墨+琥珀金（默认），还是切「贝壳蓝金」（Cobalt `#2D5BD8` + 金 `#B97A1E`）？切换约 1 分钟，重出 HTML/PDF/PPTX 并重新发布。
2. **是否做 60–90s 电影感短视频**（video-shotcraft：Remotion + 页面截图 + 2.5D 运镜 + 节奏卡点）。
   现状：本机 Remotion **未安装**（`template/`、历史 video 工程均无 `node_modules`），需先 `npm install`（Remotion 4.0.484 + React 19，含浏览器依赖），再取 22 页分区截图、编排、整片渲染。**属可选增强，等你一句话即开工。**
3. **是否调整 PPT**（增删页、改文案、换布局）——deck 源工程在 `ppt/`，改单页只需改 `pages/<id>.json` 后 `assemble`+`validate`+`audit` 重出。
4. 是否转**正式稿最终版**（确认后即可定稿交付）。

## 口径免责（随稿）

数字四级标注：引用 / 测算 / 研判推断 / 待补。50%／20%／5% 为公开案例归纳、**非统一统计口径**，只有分子没有分母，不可加总为全国结构、不可用于推算全国规模；深圳大学 5.336 亿元为披露金额口径，床位与单套折算待补；单床 35.6 万元、单位面积 0.24 万元／㎡ 为**测算**。行业研究，不构成投资建议。
