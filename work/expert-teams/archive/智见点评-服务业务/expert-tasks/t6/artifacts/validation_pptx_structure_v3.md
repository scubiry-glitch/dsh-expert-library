# PPTX Structure Precheck Report

- 输入文件：`/root/zhijian/dsh-expert-library/work/expert-teams/智见点评-服务业务/expert-tasks/t6/artifacts/AI无佣与人机协同_汇报版_v3.pptx`
- 错误数：`0`
- 警告数：`0`
- 未检查数：`1`

## 摘要

- `not_checked` / `structured_chart_label_collision_not_checked`: 1

## 问题清单

### `not_checked`

#### `structured_chart_label_collision_not_checked`

首期 `structure_precheck` 还没有读取原生 chart 内部 label 的真实边界，因此该 chart 的内部标签碰撞未自动检查。

建议：当前先保留逐页预览复核；后续可补 chart title / axis / legend / data label 的结构化检查。

出现位置：
- slide 5 | shape 7
