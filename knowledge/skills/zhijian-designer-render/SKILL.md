---
name: zhijian-designer-render
description: 将固定 Markdown 渲染为智见风格响应式 HTML/PDF，使用版本化组件并核对证据；不替代写作、事实判断或独立审核。
metadata:
  short-description: 智见渲染 v2：可用组件、自包含副本与真实检查
---

# 智见渲染 v2

使用 Host 给定身份、主样式和本角色完整材料；链接按技能目录解析。必读：[核心边界](references/core-v2.md)、[渲染规范](references/render-v2.md)、[数据纪律](references/data-v2.md)、[章节映射](references/writing-v2.md)、[验收矩阵](references/acceptance-v2.md)、[台账 schema](references/evidence-ledger-v2.md)。

选择 [credit-policy](references/style-credit-policy-v2.md) 或 [designer-paper](references/style-designer-paper-v2.md)。将 [base CSS](assets/base-v2.css) 与对应 [政策](assets/credit-policy-v2.css) / [纸本色板](assets/designer-paper-v2.css) 内联进 [文档壳](assets/document-shell-v2.html)。[组件](chart-templates.html) 提供章节、对照卡、定性流程、区间和来源表；无固定图数或隐喻数要求。用任务内容替换全部占位。

[政策示例](references/credit-policy-v1.html)、[纸本示例](references/designer-v1.html) 与[来源记录](references/source-provenance-v2.json) 仅供追溯，不作本轮事实。

按[渲染规范](references/render-v2.md)运行[官方七项预检](scripts/preflight-report.mjs)，修复后再提交。`scripts/verify_material_copy.py` 只校验副本；旧 `craft_gate_report.sh`/`craft_density_check.py` 仅静态局部检查，不得称 ALL PASS。不得自写替代检查器；本地 passed 仍需 Host 重检和独立审核。
