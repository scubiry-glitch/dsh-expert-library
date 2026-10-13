# 98wiki 独立视觉评审 · 固定任务 Prompt v1

由设计者以外的 critic 检查当前 HTML、PDF 和工艺结果。先看可用检测器，再人工核对 DOM、实际默认可见内容、宽/窄屏、A4 首中末页、字号、键盘可达、替代说明、假 CTA、死按钮和 reveal 脆性。检测器零结果不算通过。发布 `visual-review.md`，内含一个 `json visual-audit` 块：`verdict`、`checkedAt`、`method`、`pageCount`、`pages:{first,middle,last}`、`blockers`、`htmlSha256`、`pdfSha256`、`dom`、`wide`、`narrow`、`interactions`、`accessibility`；每个 page 填一基页码 `index`、当前 PDF 72dpi PNG 的 `sha256` 和实际观察 `finding`。Host 会独立重渲染当前 PDF 并比对三张截图哈希。每个 blocker 写定位、证据、归因与修复责任。发现 blocker 不得提交 PASS，也不得让终检开始。
