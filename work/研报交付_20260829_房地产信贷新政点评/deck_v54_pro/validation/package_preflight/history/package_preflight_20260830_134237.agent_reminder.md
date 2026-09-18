# Agent QC Reminder

- decision: `proceed_with_advisories`
- target_milestone: `final`
- hard_groups: `0`
- soft_groups: `0`
- advisory_groups: `1`
- full_report: `/root/zhijian/dsh-expert-library/work/研报交付_20260829_房地产信贷新政点评/deck_v54_pro/validation/package_preflight/history/package_preflight_20260830_134237.json`

## Advisories

### `compatibility.mobile.embedded_object` × 1

deck 中存在嵌入对象，这类对象在微信预览与移动端 WPS 中兼容性更脆弱。

suggested_fix: 如果外发目标包含微信或移动端 WPS，优先改为图片化 chart 或移除 workbook embedding。

sample_locations:
- ppt

rendered_group_count: `1`
