# PPTX Structure Precheck Report

- 输入文件：`/root/zhijian/dsh-expert-library/work/研报交付_20260829_房地产信贷新政点评/deck_v54_pro/build/pptx/deck_v54.pptx`
- 错误数：`9`
- 警告数：`49`
- 未检查数：`4`

## 摘要

- `error` / `text_occluded_by_shape`: 2
- `error` / `textbox_fit_failure`: 7
- `not_checked` / `structured_chart_label_collision_not_checked`: 4
- `warning` / `body_text_below_theme_token`: 47
- `warning` / `compact_textbox_width_pressure`: 2

## 问题清单

### `error`

#### `text_occluded_by_shape`

文本估计边界与更高层对象发生显著重叠，存在相邻对象压字风险。

建议：移动遮挡对象、增加留白，或重排文本框与卡片边界。

出现位置：
- slide 15 | shape 28 | occluder=30 | overlap_ratio=0.1039
- slide 27 | shape 26 | occluder=29 | overlap_ratio=0.8518

#### `textbox_fit_failure`

文本估计边界已经越出可用内容区，存在明确的文本框 fit 失败风险。

建议：增加文本框高度、减少文案密度，或把内容拆到更多卡片 / 更多页。

出现位置：
- slide 19 | shape 8 | occurrences=3 | font_sizes_pt=10.5 | overflow_ratio=0.3439 | bottom_gap_pt=-7.8 | right_gap_pt=89.86
- slide 23 | shape 8 | font_sizes_pt=10.5 | overflow_ratio=0.3439 | bottom_gap_pt=-7.8 | right_gap_pt=122.09
- slide 24 | shape 8 | occurrences=3 | font_sizes_pt=10.5 | overflow_ratio=0.3439 | bottom_gap_pt=-7.8 | right_gap_pt=93.83

### `warning`

#### `body_text_below_theme_token`

较长文本低于 active body_font_pt，疑似通过压小字号解决版面密度。

建议：先减少文案、放宽容器或拆页；确需更小字号时，记录该语义角色和例外原因。

出现位置：
- slide 1 | shape 13 | font_sizes_pt=9
- slide 2 | shape 6 | font_sizes_pt=9
- slide 4 | shape 8 | font_sizes_pt=10.5
- slide 4 | shape 10 | font_sizes_pt=10.5
- slide 8 | shape 10 | font_sizes_pt=9
- slide 9 | shape 7 | font_sizes_pt=9
- slide 9 | shape 9 | occurrences=5 | font_sizes_pt=10.5
- slide 11 | shape 26 | font_sizes_pt=9
- slide 14 | shape 14 | font_sizes_pt=10.5
- slide 16 | shape 18 | font_sizes_pt=10.5
- slide 17 | shape 21 | font_sizes_pt=9
- slide 18 | shape 11 | occurrences=4 | font_sizes_pt=10.5
- slide 18 | shape 12 | font_sizes_pt=10.5
- slide 19 | shape 17 | font_sizes_pt=9
- slide 20 | shape 21 | font_sizes_pt=9
- slide 21 | shape 13 | occurrences=2 | font_sizes_pt=10.5
- slide 21 | shape 16 | font_sizes_pt=9
- slide 23 | shape 18 | font_sizes_pt=9
- slide 25 | shape 6 | font_sizes_pt=10.5
- slide 25 | shape 9 | font_sizes_pt=10.5
- slide 25 | shape 12 | font_sizes_pt=10.5
- slide 27 | shape 5 | font_sizes_pt=10.5
- slide 27 | shape 6 | font_sizes_pt=10.5
- slide 27 | shape 7 | font_sizes_pt=10.5
- slide 28 | shape 7 | font_sizes_pt=10.5
- slide 28 | shape 11 | font_sizes_pt=10.5
- slide 28 | shape 15 | font_sizes_pt=10.5
- slide 28 | shape 23 | font_sizes_pt=10.5
- slide 29 | shape 14 | font_sizes_pt=10.5
- slide 29 | shape 26 | font_sizes_pt=10.5
- slide 32 | shape 8 | font_sizes_pt=10.5
- slide 32 | shape 10 | font_sizes_pt=10.5
- slide 32 | shape 12 | font_sizes_pt=10.5
- slide 32 | shape 14 | font_sizes_pt=10.5
- slide 32 | shape 16 | font_sizes_pt=10.5
- slide 32 | shape 18 | font_sizes_pt=10.5
- slide 32 | shape 20 | font_sizes_pt=10.5
- slide 33 | shape 6 | occurrences=2 | font_sizes_pt=10.5

#### `compact_textbox_width_pressure`

短标题或标签的有效宽度过窄，已经进入 forced-wrap / width-pressure 区间，即使当前还没完全越界，也很容易出现被迫换行、压边或字形挤压。

建议：增加该标签框宽度，或缩短短标题文案，避免把本应单行的短文本塞进过窄容器。

出现位置：
- slide 15 | shape 15 | font_sizes_pt=9
- slide 20 | shape 19 | font_sizes_pt=9

### `not_checked`

#### `structured_chart_label_collision_not_checked`

首期 `structure_precheck` 还没有读取原生 chart 内部 label 的真实边界，因此该 chart 的内部标签碰撞未自动检查。

建议：当前先保留逐页预览复核；后续可补 chart title / axis / legend / data label 的结构化检查。

出现位置：
- slide 8 | shape 9
- slide 9 | shape 8
- slide 10 | shape 23
- slide 10 | shape 24
