#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Render 京沪深广房地产政策联合分析 md -> HTML -> PDF (weasyprint).
Usage: python3 render_report.py <input.md> <output_base> <title> <subtitle> <header>
"""
import sys
import markdown
import weasyprint

def main():
    md_path, out_base, title, subtitle, header = sys.argv[1:6]
    md_text = open(md_path, encoding='utf-8').read()

    body = markdown.markdown(
        md_text,
        extensions=['tables', 'fenced_code', 'sane_lists', 'nl2br'],
        output_format='html5',
    )
    # Autolink bare http(s) URLs so they become clickable in HTML/PDF
    import re as _re
    _url = _re.compile(r'(?<!href=")(?<!">)(https?://[^\s<>"\)\uff09\uff1b\uff0c\u3002\uff1a\u3001\uff01\uff1f\u300b\u300a\'\u2019\u201d]+)')
    body = _url.sub(lambda m: '<a href="%s">%s</a>' % (m.group(1), m.group(1)), body)

    css = """
@page {
  size: A4;
  margin: 24mm 18mm 20mm 18mm;
  @top-center {
    content: "__HEADER__";
    font-family: "Noto Sans CJK SC", sans-serif;
    font-size: 8pt; color: #8a8f99;
    border-bottom: 0.5pt solid #c9ced6;
    width: 100%; vertical-align: bottom; padding-bottom: 2mm;
  }
  @bottom-center {
    content: "本报告仅供内部研判参考 · 第 " counter(page) " 页 / 共 " counter(pages) " 页";
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
  font-size: 10pt; line-height: 1.72; color: #1f2733; margin: 0;
  text-align: justify;
}
h1 {
  font-size: 19pt; font-weight: 700; color: #14304f; text-align: center;
  margin: 0 0 2mm 0; letter-spacing: 1pt;
}
.subtitle {
  text-align: center; font-size: 11.5pt; color: #3d5573; font-weight: 600;
  margin: 0 0 6mm 0;
}
.rule { border: none; border-top: 1.6pt solid #14304f; margin: 0 0 4mm 0; }
.meta {
  background: #f3f6fa; border-left: 3pt solid #14304f;
  padding: 3mm 4mm; font-size: 8.8pt; line-height: 1.65; margin-bottom: 5mm;
}
.meta p { margin: 0.6mm 0; }
h2 {
  font-size: 13pt; color: #14304f; margin: 6.5mm 0 2.5mm 0;
  padding-bottom: 1mm; border-bottom: 1pt solid #b9c4d2; font-weight: 700;
  page-break-after: avoid;
}
h3 { font-size: 11pt; color: #23486e; margin: 4.5mm 0 2mm 0; font-weight: 700; page-break-after: avoid; }
p { margin: 0 0 2.6mm 0; }
strong { color: #10263f; }
table {
  width: 100%; border-collapse: collapse; margin: 2.5mm 0 4mm 0;
  font-size: 8.6pt; line-height: 1.5; table-layout: fixed;
  page-break-inside: auto;
}
th, td {
  border: 0.5pt solid #aab4c0; padding: 1.6mm 2mm;
  vertical-align: top; word-wrap: break-word; overflow-wrap: anywhere;
}
th { background: #14304f; color: #ffffff; font-weight: 600; text-align: center; }
tr:nth-child(even) td { background: #f5f8fb; }
td.center { text-align: center; }
blockquote {
  margin: 2.5mm 0; padding: 2mm 4mm; background: #fbf6ec;
  border-left: 3pt solid #b8860b; font-size: 9pt; color: #5a4a1e;
}
ul { margin: 1mm 0 2.6mm 0; padding-left: 6mm; }
li { margin: 0.6mm 0; }
ul.refs { font-size: 8.8pt; }
ul.refs li { word-wrap: break-word; overflow-wrap: anywhere; }
.note { font-size: 8.6pt; color: #5b6570; }
.tag { display: inline-block; background:#14304f; color:#fff; font-size:7.6pt; padding:0.2mm 1.6mm; border-radius:1.5mm; margin-right:1mm; }
.tag-inf { background:#8a6d1a; }
tr { page-break-inside: avoid; }
""".replace('__HEADER__', header.replace('"', '\\"'))

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>{title}</title>
<style>{css}</style>
</head>
<body>
<h1>{title}</h1>
<p class="subtitle">{subtitle}</p>
<hr class="rule">
{body}
</body>
</html>
"""

    html_path = out_base + '.html'
    pdf_path = out_base + '.pdf'
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html)
    weasyprint.HTML(string=html, base_url='.').write_pdf(pdf_path)
    print('WROTE', html_path)
    print('WROTE', pdf_path)

if __name__ == '__main__':
    main()
