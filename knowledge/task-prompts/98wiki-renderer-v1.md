# 98wiki Designer 渲染 · 固定任务 Prompt v1

逐字节复制已审 `report.md`；用已审 `figure-fragments.html` 与 `figure-spec.md` 渲染 `report.html`、`report.pdf`，发布 `craft-evidence.json`、`reference-map.json`。图卡在 HTML 中原样出现一次，逐章顺序不变；PDF 包含图卡文字。用领域包 zhijian-report-craft 和 zhijian-designer-render 的当前冻结版本检查；图文报告 craft evidence 用 schemaVersion 3 的 `figureLayer` 登记已审片段原文、SHA256、章节数组。参考件只取版式结构，映射当前哈希，不能搬示例事实。先完成 Finesse pre-flight，再交由独立视觉专家评审；失败时只修可归因渲染问题，上游正文问题返上游，修复预算耗尽上报。
