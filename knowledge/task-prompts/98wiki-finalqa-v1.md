# 98wiki 成品终检 · 固定任务 Prompt v1

核对独立视觉 PASS 回执与当前发布版的 `report.md`、`report.html`、`report.pdf`、`craft-evidence.json`、`reference-map.json`。主文按主文门验收，附件如存在另走附件门。重新渲染当前 HTML/PDF，记录 SHA256、渲染时间与方法、PDF 页数、首中末页检查，核对图卡顺序、来源披露、结语、所有工艺门与交付文件。发布 `delivery-check.md`，内含一个 `json delivery-audit` 块：`verdict`、`checkedAt`、`method`、`pageCount`、`pages:{first,middle,last}`、`blockers`、`visualReviewSha256`、`artifacts` 五份成品 SHA256；每个 page 填一基页码 `index`、当前 PDF 72dpi PNG 的 `sha256` 与实际观察 `finding`。Host 会重渲染并核对。任一文件或图层哈希漂移、检查未通过、视觉 blocker 未关闭则 BLOCKED。不能将旧版检查记录用于新字节。
