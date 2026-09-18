# Agent QC Reminder

- decision: `hard_blocked`
- target_milestone: `final`
- hard_groups: `3`
- soft_groups: `1`
- advisory_groups: `3`
- full_report: `/root/zhijian/dsh-expert-library/work/研报交付_20260829_房地产信贷新政点评/deck_v54_pro/validation/structure_precheck/history/structure_precheck_20260830_133025.json`

## Must Fix Before Milestone

### `layout.overlap.object_overlap` × 6

文本估计边界与更高层对象发生显著重叠，存在相邻对象压字风险。

suggested_fix: 移动遮挡对象、增加留白，或重排文本框与卡片边界。

sample_locations:
- slide 10 | shape 21 | shape_text
- slide 10 | shape 22 | shape_text
- slide 21 | shape 22 | shape_text
- omitted `3` locations; see full report.

### `layout.text_fit.bounds_overflow` × 19

文本估计边界已经越出可用内容区，存在明确的文本框 fit 失败风险。

suggested_fix: 增加文本框高度、减少文案密度，或把内容拆到更多卡片 / 更多页。

actual_values: 10.5pt×16, 24pt×3

sample_locations:
- slide 10 | shape 11 | shape_text
- slide 11 | shape 11 | shape_text
- slide 12 | shape 11 | shape_text
- omitted `16` locations; see full report.

### `layout.overlap.object_overlap` × 3

文本估计边界与更高层对象发生显著重叠，存在相邻对象压字风险。

suggested_fix: 移动遮挡对象、增加留白，或重排文本框与卡片边界。

sample_locations:
- slide 6 | shape 12 | shape_text
- slide 6 | shape 13 | shape_text
- slide 6 | shape 14 | shape_text

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

### `layout.text_fit.width_pressure` × 1

短标题或标签的有效宽度过窄，已经进入 forced-wrap / width-pressure 区间，即使当前还没完全越界，也很容易出现被迫换行、压边或字形挤压。

suggested_fix: 增加该标签框宽度，或缩短短标题文案，避免把本应单行的短文本塞进过窄容器。

actual_values: 9pt×1

sample_locations:
- slide 11 | shape 19 | shape_text

### `layout.text_fit.width_pressure` × 2

短标题或标签的有效宽度过窄，已经进入 forced-wrap / width-pressure 区间，即使当前还没完全越界，也很容易出现被迫换行、压边或字形挤压。

suggested_fix: 增加该标签框宽度，或缩短短标题文案，避免把本应单行的短文本塞进过窄容器。

actual_values: 9pt×2

sample_locations:
- slide 15 | shape 19 | shape_text
- omitted `1` locations; see full report.

### `typography.font_size.role_drift` × 44

当前中文正文字号为 10.5pt×33, 9pt×11；active `theme_tokens.body_font_pt` 推荐 12pt。

suggested_fix: 如无模板、品牌或已登记的 profile 例外，直接改为 12pt。

actual_values: 9pt×11, 10.5pt×33

sample_locations:
- slide 32 | shape 10 | shape_text
- omitted `43` locations; see full report.

rendered_group_count: `7`
