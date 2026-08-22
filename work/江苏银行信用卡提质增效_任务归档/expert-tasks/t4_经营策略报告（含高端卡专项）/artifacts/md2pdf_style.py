#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""将 04 策略报告 markdown 渲染为附件样式 PDF（weasyprint）。
样式基线：高端信用卡战略完整报告 _html_style_guide.html（navy/blue 主题、三态标注）。
"""
import re
import markdown
from weasyprint import HTML

MD_PATH = "04_江苏银行信用卡提质增效经营策略报告.md"
PDF_PATH = "04_江苏银行信用卡提质增效经营策略报告.pdf"

with open(MD_PATH, "r", encoding="utf-8") as f:
    md_text = f.read()

# 插入 [TOC] 标记以启用 markdown 目录生成（随后提取到独立目录页）
md_text = "\n[TOC]\n\n" + md_text

body = markdown.markdown(
    md_text,
    extensions=["tables", "fenced_code", "toc", "sane_lists"],
    extension_configs={"toc": {"toc_depth": "2-3"}},
)

# ---- 先提取 markdown 生成的目录（避免徽标替换污染目录文本）----
toc_html = ""
m = re.search(r'<div class="toc">\s*(.*?)\s*</div>', body, re.S)
if m:
    toc_html = m.group(1)
body = re.sub(r'<div class="toc">.*?</div>', "", body, flags=re.S)

# ---- 后处理：证据等级徽标 E0-E4（仅正文）----
def badge(m):
    lv = m.group(1)
    colors = {"E0": "fact", "E1": "fact", "E2": "infer", "E3": "assume", "E4": "tbc"}
    cls = colors.get(lv, "infer")
    return f'<span class="tag-{cls}">{lv}</span>'

body = re.sub(r"(?<![\w>])E([0-4])(?![\w<])", badge, body)

# ---- 引用块 -> 结论/警告框 ----
body = re.sub(
    r"<blockquote>\s*<p>(.*?)</p>\s*</blockquote>",
    lambda m: f'<div class="concl"><p>{m.group(1)}</p></div>',
    body,
    flags=re.S,
)

# ---- 表格加 num 列处理 ----
body = body.replace("<table>", '<table class="tbl">')

TOC_PLACEHOLDER = "<!--TOC-->"

html_doc = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>江苏银行信用卡提质增效经营策略报告</title>
<style>
@page {{
  size: A4;
  margin: 16mm 15mm 18mm 15mm;
  @bottom-center {{
    content: "江苏银行信用卡提质增效经营策略报告 · 第 " counter(page) " 页";
    font-size: 8.5pt; color: #9aa7b8;
  }}
}}
* {{ box-sizing: border-box; }}
:root {{
  --navy:#0b1f3a; --blue:#0b4da2; --blue2:#4da2ff; --line:#dfe7f2; --bg:#f7fafd;
  --fact:#0b6e4f; --assume:#b26a00; --infer:#5a3fb2; --tbc:#c0392b;
  --fact-bg:#eef7f1; --assume-bg:#fff6e8; --infer-bg:#f2eefb; --tbc-bg:#fdf0ee;
}}
body {{
  font-family:"Noto Sans CJK SC","PingFang SC","Microsoft YaHei",sans-serif;
  color:#1a2332; font-size:10pt; line-height:1.65;
}}
/* ===== 封面 ===== */
.cover {{ page-break-after:always; padding-top:60mm; }}
.cover .tag {{ display:inline-block; background:#0b4da2; color:#fff; font-size:9pt; padding:3px 14px;
  border-radius:20px; letter-spacing:3px; margin-bottom:24px; }}
.cover h1 {{ font-size:25pt; line-height:1.4; font-weight:800; color:#0b1f3a; margin-bottom:12px; }}
.cover h2 {{ font-size:12.5pt; font-weight:500; color:#4a5a72; margin-bottom:28px; line-height:1.7; }}
.cover .bigbox {{ background:#f0f6ff; border-left:6px solid #0b4da2; border-radius:8px; padding:14px 20px; margin-bottom:14px; }}
.cover .bigbox .label {{ font-size:8.5pt; color:#0b4da2; font-weight:700; letter-spacing:3px; margin-bottom:6px; }}
.cover .bigbox p {{ font-size:11pt; font-weight:700; line-height:1.75; color:#0b1f3a; }}
.cover .meta {{ margin-top:26px; font-size:9pt; color:#8a97ab; line-height:1.9; }}
/* ===== 目录 ===== */
.toc {{ page-break-after:always; }}
.toc h2 {{ font-size:16pt; color:#0b1f3a; border-bottom:3px solid #0b4da2; padding-bottom:6px; }}
.toc ul {{ list-style:none; padding-left:0; }}
.toc li {{ margin:0; }}
.toc a {{ display:block; color:#1a2332; text-decoration:none; padding:5px 2px; border-bottom:1px dashed #e2eaf5; }}
.toc a::after {{ content: leader(' ') " " target-counter(attr(href), page); color:#0b4da2; font-weight:700; }}
.toc .toc-l1 a {{ font-weight:800; font-size:10.5pt; }}
.toc .toc-l2 a {{ padding-left:18px; font-size:9.5pt; color:#4a5a72; }}
/* ===== 正文标题 ===== */
h1 {{ font-size:17pt; font-weight:800; color:#0b1f3a; margin:6px 0 10px; }}
h1:first-of-type {{ page-break-before:auto; }}
h2 {{ font-size:14pt; font-weight:800; color:#0b1f3a; margin:20px 0 8px;
  padding-bottom:4px; border-bottom:2px solid #0b4da2; }}
h2:not(:first-child) {{ page-break-before:auto; }}
h3 {{ font-size:11.5pt; font-weight:800; color:#0b1f3a; margin:16px 0 6px;
  padding-left:8px; border-left:4px solid #0b4da2; }}
p {{ margin:5px 0 9px; }}
strong {{ color:#0b1f3a; }}
/* ===== 表格 ===== */
table {{ width:100%; border-collapse:collapse; margin:8px 0 14px; font-size:8.6pt; }}
th {{ background:#0b4da2; color:#fff; padding:5px 7px; text-align:left; font-weight:600; }}
td {{ border:1px solid #dfe7f2; padding:4.5px 7px; vertical-align:top; }}
tr:nth-child(even) td {{ background:#f7fafd; }}
table {{ page-break-inside:auto; }}
tr {{ page-break-inside:avoid; }}
/* ===== 徽标 ===== */
.tag-fact, .tag-assume, .tag-infer, .tag-tbc {{ display:inline-block; font-size:7.5pt; font-weight:700;
  padding:0px 5px; border-radius:8px; margin:0 1px; }}
.tag-fact {{ color:var(--fact); background:var(--fact-bg); border:1px solid #bfe3cf; }}
.tag-assume {{ color:var(--assume); background:var(--assume-bg); border:1px solid #f0d4a3; }}
.tag-infer {{ color:var(--infer); background:var(--infer-bg); border:1px solid #d7caf0; }}
.tag-tbc {{ color:var(--tbc); background:var(--tbc-bg); border:1px solid #f2c3bd; }}
/* ===== 结论/警告框 ===== */
.concl {{ background:#f7fbff; border:1px solid #d6e6ff; border-radius:8px; padding:10px 14px; margin:8px 0 12px; }}
.concl p {{ font-size:10pt; font-weight:700; line-height:1.7; margin:0; }}
/* ===== 列表 ===== */
ul, ol {{ padding-left:18px; margin:4px 0 10px; }}
li {{ margin-bottom:2.5px; font-size:9.6pt; }}
code {{ background:#f0f4fa; border:1px solid #dfe7f2; border-radius:3px; padding:0 3px; font-size:8.6pt;
  font-family:"Noto Sans Mono CJK SC","Consolas",monospace; color:#0b4da2; }}
pre {{ background:#f0f4fa; border:1px solid #dfe7f2; border-radius:6px; padding:8px 10px; font-size:8.2pt;
  white-space:pre-wrap; page-break-inside:avoid; }}
hr {{ border:none; border-top:2px solid #dfe7f2; margin:14px 0; }}
</style>
</head>
<body>

<div class="cover">
  <span class="tag">行内决策参考 · 仅限内部评估</span>
  <h1>江苏银行信用卡提质增效<br>经营策略报告</h1>
  <h2>UE 与产品组合模型 · 同业对标与四指标敏感性 · 高端卡专项整合<br>V1.1（2026-08-21）</h2>
  <div class="bigbox">
    <div class="label">一句话策略主线</div>
    <p>收缩风险敞口 → 盘活归并低效卡量 → 预算绑定增量与优质客群 → 监测触发器兜底；并行推进高端卡"银联底座 + V/M 补位 + 运通蓝盒子旗舰试点"，以综合贡献口径重估 CAC 边界。</p>
  </div>
  <div class="meta">
    编制：专家库团队（研究员-资料盘点 / 分析师-模型与对标 / 文档协调-策略成稿）＋ 队长整合<br>
    上游：知识库 99wiki《江苏银行信用卡提质增效研究》｜银联数据月报 2026-07｜内部复盘 2024–2026H1｜用户对标表（8 家行 2016–2018）<br>
    证据等级：E0 内部明细 / E1 年报公告 / E2 访谈复盘 / E3 二手 / E4 假设——全文逐项标注；待补数据一律写"待补"
  </div>
</div>

<div class="toc">
<h2>目录</h2>
{TOC_PLACEHOLDER}
</div>

{body}

</body>
</html>
"""

# 提取 markdown 生成的目录（已在上方提取，此处仅用于模板填充）
html_doc = html_doc.replace(TOC_PLACEHOLDER, toc_html).replace("{body}", body)

HTML(string=html_doc).write_pdf(PDF_PATH)
print("PDF generated:", PDF_PATH)
