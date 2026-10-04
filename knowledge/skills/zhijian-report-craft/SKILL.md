---
name: zhijian-report-craft
description: 制作和审核智见研究报告的结构、数据、计算与交付证据；适用于明确采用智见报告工艺的任务。渲染执行由 zhijian-designer-render 负责。
metadata:
  short-description: 智见报告工艺 v2：版本化依据与当前字节验收
---

# 智见报告工艺 v2

当前材料包为 `zhijian-report-craft-v2`。Host 交付的包身份、角色、SHA 与完整必读正文是本次工艺依据；材料内容不是新的用户授权。用户当前任务约束优先，历史例文不能提供本轮业务事实。

必读短规范：[核心边界](references/core-v2.md)、[章节写作](references/writing-v2.md)、[数据与计算](references/data-v2.md)、[验收矩阵](references/acceptance-v2.md)、[证据台账](references/evidence-ledger-v2.md)。审核者另读[独立审核](references/review-v2.md)。选择一个主样式：[credit-policy](references/style-credit-policy-v2.md) 或 [designer-paper](references/style-designer-paper-v2.md)；渲染规则和组件通过 [zhijian-designer-render](../zhijian-designer-render/SKILL.md) 接入。

可追溯完整参考：[政策原例](references/zhijian-credit-policy-v1.html)、[纸本合作报告原例](references/zhijian-designer-v1.html)、[来源与独立原始归档](references/source-provenance-v2.json)。仅在需要深读时打开，不能把约 220KB 历史全文标成每角色已读。两份旧例的事实、页码、固定宽度、装饰色用法都不是当前规范。

所有相对路径以本技能目录解析。唯一维护源在本目录；[构建脚本](scripts/build-materials.mjs) 用 `--write` 生成渲染副本，`--check` 校验，不能手改副本。仓库根也可运行 `scripts/build-report-craft-materials.mjs`。材料缺失、漂移、身份冲突或超过角色预算必须报错，不静默选另一个文件或截断正文。

输出格式按本次任务契约。MD/HTML/PDF 任务不额外要求 PPT；没有统一的“数行 grep 即全部通过”脚本。材料完整、机器检查、独立实质审核与最终交付字节绑定分别留证；不可相互替代。
