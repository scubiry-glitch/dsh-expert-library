# Agent QC Reminder

- decision: `soft_blocked`
- target_milestone: `final`
- hard_groups: `0`
- soft_groups: `1`
- advisory_groups: `0`
- full_report: `validation_pptx_structure_v2.json`

## Needs Evidence Or Exception

### `layout.overlap.chart_label_collision` × 1

首期 `structure_precheck` 还没有读取原生 chart 内部 label 的真实边界，因此该 chart 的内部标签碰撞未自动检查。

suggested_fix: 当前先保留逐页预览复核；后续可补 chart title / axis / legend / data label 的结构化检查。

sample_locations:
- slide 4 | shape 7 | chart

rendered_group_count: `1`
