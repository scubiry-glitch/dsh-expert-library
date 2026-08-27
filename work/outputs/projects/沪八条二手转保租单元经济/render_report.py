#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Render 研报 md -> HTML -> PDF (weasyprint), 页脚署名: 98wiki ｜ 智见 / 行业研究报告
Usage: python3 render_report.py <input.md> <output_base> <title> <subtitle> <header>
"""
import sys, re, hashlib
import markdown
import weasyprint

def main():
    md_path, out_base, title, subtitle, header = sys.argv[1:6]
    md_text = open(md_path, encoding='utf-8').read()

    body = markdown.markdown(
        md_text,
        extensions=['tables', 'fenced_code', 'sane_lists', 'nl2br', 'md_in_html'],
        output_format='html5',
    )
    _url = re.compile(r'(?<!href=")(?<!">)(https?://[^\s<>"\)\uff09\uff1b\uff0c\u3002\uff1a\u3001\uff01\uff1f\u300b\u300a\'\u2019\u201d]+)')
    body = _url.sub(lambda m: '<a href="%s">%s</a>' % (m.group(1), m.group(1)), body)

    css = """
@page {
  size: A4;
  margin: 22mm 17mm 19mm 17mm;
  @top-center {
    content: "__HEADER__";
    font-family: "Noto Sans CJK SC", sans-serif;
    font-size: 8pt; color: #8a8f99;
    border-bottom: 0.5pt solid #c9ced6;
    width: 100%; vertical-align: bottom; padding-bottom: 2mm;
  }
  @bottom-center {
    content: "98wiki ｜ 智见 / 行业研究报告 · 第 " counter(page) " 页 / 共 " counter(pages) " 页";
    font-family: "Noto Sans CJK SC", sans-serif;
    font-size: 8pt; color: #8a8f99;
    border-top: 0.5pt solid #c9ced6;
    width: 100%; vertical-align: top; padding-top: 2mm;
  }
}
@page :first { @top-center { content: none; border: none; } }
html { -weasy-hyphens: auto; }
body {
  font-family: "Noto Sans CJK SC", "Noto Sans CJK HK", sans-serif;
  font-size: 9.6pt; line-height: 1.68; color: #1f2733; margin: 0;
  text-align: justify;
}
/* ---- 封面 ---- */
.cover { page-break-after: always; text-align: center; padding-top: 30mm; }
.cover .kicker { font-size: 10pt; color: #b8860b; letter-spacing: 3pt; margin-bottom: 8mm; }
.cover h1.title {
  font-size: 21pt; font-weight: 700; color: #14304f; text-align: center;
  margin: 0 0 4mm 0; letter-spacing: 1pt; line-height: 1.4;
}
.cover .subtitle {
  text-align: center; font-size: 12pt; color: #3d5573; font-weight: 600;
  margin: 0 0 10mm 0;
}
.cover .rule { border: none; border-top: 1.6pt solid #14304f; margin: 0 auto 8mm auto; width: 60%; }
.cover .meta {
  background: #f3f6fa; border-left: 3pt solid #14304f; border-right: 3pt solid #14304f;
  padding: 4mm 6mm; font-size: 9pt; line-height: 1.7; margin: 0 auto 8mm auto;
  text-align: left; width: 82%;
}
.cover .meta p { margin: 0.8mm 0; }
.kpi-grid { display: flex; flex-wrap: wrap; justify-content: center; gap: 4mm; margin: 0 auto 10mm auto; width: 90%; }
.kpi-card {
  border: 1pt solid #b9c4d2; border-top: 3pt solid #14304f; background: #ffffff;
  padding: 3mm 3mm; width: 42%; text-align: center; page-break-inside: avoid;
}
.kpi-card .k { font-size: 8pt; color: #5b6570; margin-bottom: 1mm; }
.kpi-card .v { font-size: 13.5pt; font-weight: 700; color: #14304f; }
.kpi-card .s { font-size: 7.6pt; color: #8a8f99; margin-top: 0.6mm; }
/* ---- 正文 ---- */
h2 {
  font-size: 13pt; color: #14304f; margin: 6mm 0 2.5mm 0;
  padding-bottom: 1mm; border-bottom: 1.2pt solid #b9c4d2; font-weight: 700;
  page-break-after: avoid;
}
h3 { font-size: 10.8pt; color: #23486e; margin: 4mm 0 1.8mm 0; font-weight: 700; page-break-after: avoid; }
p { margin: 0 0 2.4mm 0; }
strong { color: #10263f; }
table {
  width: 100%; border-collapse: collapse; margin: 2mm 0 3.5mm 0;
  font-size: 8.2pt; line-height: 1.45; table-layout: fixed;
  page-break-inside: auto;
}
th, td {
  border: 0.5pt solid #aab4c0; padding: 1.4mm 1.8mm;
  vertical-align: top; word-wrap: break-word; overflow-wrap: anywhere;
}
th { background: #14304f; color: #ffffff; font-weight: 600; text-align: center; }
tr:nth-child(even) td { background: #f5f8fb; }
tr { page-break-inside: avoid; }
blockquote {
  margin: 2.2mm 0; padding: 2mm 4mm; background: #fbf6ec;
  border-left: 3pt solid #b8860b; font-size: 8.8pt; color: #5a4a1e;
}
ul { margin: 1mm 0 2.4mm 0; padding-left: 5.5mm; }
li { margin: 0.5mm 0; }
ul.refs { font-size: 8.4pt; }
ul.refs li { word-wrap: break-word; overflow-wrap: anywhere; }
.note { font-size: 8.4pt; color: #5b6570; }
.tag { display: inline-block; background:#14304f; color:#fff; font-size:7.4pt; padding:0.2mm 1.6mm; border-radius:1.5mm; margin-right:1mm; }
.tag-inf { background:#8a6d1a; }
.tag-ok { background:#1d6f42; }
.tag-risk { background:#a33; }
.callout {
  background: #eef4fb; border-left: 3pt solid #14304f; padding: 2.5mm 4mm;
  font-size: 9.2pt; margin: 2.5mm 0; page-break-inside: avoid;
}
.svg-wrap { text-align: center; margin: 2.5mm 0; page-break-inside: avoid; }
.svg-wrap svg { max-width: 100%; height: auto; }
.figure-cap { font-size: 8pt; color: #5b6570; text-align: center; margin: 0.8mm 0 3mm 0; }
""".replace('__HEADER__', header.replace('"', '\\"'))

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>{title}</title>
<style>{css}</style>
</head>
<body>
{body}
</body>
</html>
"""

    html_path = out_base + '.html'
    pdf_path = out_base + '.pdf'
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html)
    weasyprint.HTML(string=html, base_url='.').write_pdf(pdf_path)
    def sha(p):
        return hashlib.sha256(open(p, 'rb').read()).hexdigest()
    print('WROTE', html_path, sha(html_path))
    print('WROTE', pdf_path, sha(pdf_path))

if __name__ == '__main__':
    main()
