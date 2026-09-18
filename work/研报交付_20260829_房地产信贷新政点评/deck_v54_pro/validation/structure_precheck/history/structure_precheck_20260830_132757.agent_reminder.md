# Agent QC Reminder

- decision: `hard_blocked`
- target_milestone: `final`
- hard_groups: `2`
- soft_groups: `1`
- advisory_groups: `7`
- full_report: `/root/zhijian/dsh-expert-library/work/研报交付_20260829_房地产信贷新政点评/deck_v54_pro/validation/structure_precheck/history/structure_precheck_20260830_132757.json`

## Must Fix Before Milestone

### `layout.overlap.object_overlap` × 10

文本估计边界与更高层对象发生显著重叠，存在相邻对象压字风险。

suggested_fix: 移动遮挡对象、增加留白，或重排文本框与卡片边界。

sample_locations:
- slide 6 | shape 12 | shape_text
- slide 6 | shape 13 | shape_text
- slide 6 | shape 14 | shape_text
- omitted `7` locations; see full report.

### `layout.text_fit.bounds_overflow` × 21

文本估计边界已经越出可用内容区，存在明确的文本框 fit 失败风险。

suggested_fix: 增加文本框高度、减少文案密度，或把内容拆到更多卡片 / 更多页。

actual_values: 9pt×1, 10.5pt×16, 24pt×3, 26pt×1

sample_locations:
- slide 10 | shape 11 | shape_text
- slide 11 | shape 11 | shape_text
- slide 12 | shape 11 | shape_text
- omitted `18` locations; see full report.

## Needs Evidence Or Exception

### `layout.overlap.chart_label_collision` × 4

首期 `structure_precheck` 还没有读取原生 chart 内部 label 的真实边界，因此该 chart 的内部标签碰撞未自动检查。

suggested_fix: 当前先保留逐页预览复核；后续可补 chart title / axis / legend / data label 的结构化检查。

sample_locations:
- slide 10 | shape 23 | chart
- slide 10 | shape 24 | chart
- slide 9 | shape 8 | chart
- omitted `1` locations; see full report.

## Advisories

### `layout.text_fit.width_pressure` × 3

短标题或标签的有效宽度过窄，已经进入 forced-wrap / width-pressure 区间，即使当前还没完全越界，也很容易出现被迫换行、压边或字形挤压。

suggested_fix: 增加该标签框宽度，或缩短短标题文案，避免把本应单行的短文本塞进过窄容器。

actual_values: 9pt×3

sample_locations:
- slide 11 | shape 19 | shape_text
- omitted `2` locations; see full report.

### `layout.text_fit.width_pressure` × 7

短标题或标签的有效宽度过窄，已经进入 forced-wrap / width-pressure 区间，即使当前还没完全越界，也很容易出现被迫换行、压边或字形挤压。

suggested_fix: 增加该标签框宽度，或缩短短标题文案，避免把本应单行的短文本塞进过窄容器。

actual_values: 9pt×7

sample_locations:
- slide 14 | shape 13 | shape_text
- omitted `6` locations; see full report.

### `typography.font_size.fragmentation` × 1

检测到字号系统问题；当前未解析出 active role token，需先确认模板、语言和语义 role。

suggested_fix: 把相同语义的文字收敛到 hero / section / page title / subtitle / body / label / caption / table token。

sample_locations:
- ppt

### `typography.font_size.outside_scale` × 54

检测到字号系统问题为 9.5pt×22, 13pt×8, 10pt×8；当前未解析出 active role token，需先确认模板、语言和语义 role。

suggested_fix: 把该文本绑定到已有 typography token；确需新档位时先更新 theme_tokens 并记录语义用途。

actual_values: 9.5pt×22, 10pt×8, 13pt×8, 20pt×5, 22pt×3, 26pt×4, 34pt×4

sample_locations:
- slide 1 | shape 10 | shape_text
- omitted `53` locations; see full report.

### `typography.font_size.outside_scale` × 1

当前中文正文字号为 18pt×1；active `theme_tokens.body_font_pt` 推荐 12pt。

suggested_fix: 如无模板、品牌或已登记的 profile 例外，直接改为 12pt。

actual_values: 18pt×1

sample_locations:
- slide 3 | shape 11 | shape_text

### `typography.font_size.role_drift` × 44

当前中文正文字号为 10.5pt×30, 9pt×8, 11pt×3；active `theme_tokens.body_font_pt` 推荐 12pt。

suggested_fix: 如无模板、品牌或已登记的 profile 例外，直接改为 12pt。

actual_values: 9pt×8, 9.5pt×3, 10.5pt×30, 11pt×3

related_codes: `font_size_outside_theme_scale`

sample_locations:
- slide 32 | shape 10 | shape_text
- omitted `43` locations; see full report.

### `typography.font_size.role_drift` × 8

当前中文图注/表注字号为 8.5pt×8；active `theme_tokens.caption_font_pt` 推荐 9pt。

suggested_fix: 如无模板、品牌或已登记的 profile 例外，直接改为 9pt。

actual_values: 8.5pt×8

related_codes: `font_size_outside_theme_scale`

sample_locations:
- slide 24 | shape 14 | shape_text
- omitted `7` locations; see full report.

rendered_group_count: `10`
