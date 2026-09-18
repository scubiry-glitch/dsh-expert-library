# Agent QC Reminder

- decision: `hard_blocked`
- target_milestone: `final`
- hard_groups: `1`
- soft_groups: `0`
- advisory_groups: `1`
- full_report: `/root/zhijian/dsh-expert-library/work/研报交付_20260829_房地产信贷新政点评/deck_v54_pro/validation/package_preflight/history/package_preflight_20260830_132706.json`

## Must Fix Before Milestone

### `artifact_integrity.package.slide_count_mismatch` × 1

`docProps/app.xml` 中的 `Slides` 统计与实际 slide 数不一致，这对移动端解析器是高风险信号。

suggested_fix: 在最终打包前重写 `docProps/app.xml` 的 slide 统计，保证和真实 deck 一致。

sample_locations:
- ppt

## Advisories

### `compatibility.mobile.embedded_object` × 1

deck 中存在嵌入对象，这类对象在微信预览与移动端 WPS 中兼容性更脆弱。

suggested_fix: 如果外发目标包含微信或移动端 WPS，优先改为图片化 chart 或移除 workbook embedding。

sample_locations:
- ppt

rendered_group_count: `2`
