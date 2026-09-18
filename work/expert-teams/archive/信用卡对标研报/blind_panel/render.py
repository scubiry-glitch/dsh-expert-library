#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""盲测研判 + 比对报告 → HTML/PDF（finesse register：ink-teal #0e6a55 + amber #a9741f，flex 数字条，weasyprint A4）"""
import markdown, re, sys
from weasyprint import HTML

DOCS = [
    dict(
        md="/root/zhijian/dsh-expert-library/work/expert-teams/信用卡对标研报/盲测研判_信用卡UE_独立稿_20260830.md",
        title="江苏银行信用卡 2026 中报季 · 独立盲测研判",
        subtitle="UE 恒等式诊断 × 六行对标 × 转正条件 × 客群重构 × 抓手判定",
        meta="独立交叉验证稿 ｜ 2026-08-30 ｜ 四专家独立进程 + 队长总裁判 ｜ 含行内数据 · 勿发公网",
        strip_first_h1=True,
        strip_meta_block=True,
        cards=[("-2.85%", "信用卡 EVA（风险成本 4.37% 单因素）"), ("1.51%", "过线平衡点（风险成本≤1.5% 转）"),
               ("w≈40%", "高风险口袋占比（1/3~1/2）"), ("-0.35%", "剔除网贷后个贷 EVA（单引擎）")],
        footer="智见点评 · 独立盲测研判",
    ),
    dict(
        md="/root/zhijian/dsh-expert-library/work/expert-teams/信用卡对标研报/盲测比对报告_20260830.md",
        title="盲测交叉验证比对报告",
        subtitle="江苏银行信用卡 2026 中报季 ｜ 盲测稿 × 出题方材料 逐维度比对",
        meta="比对时间 2026-08-30 ｜ 数字一致=底座可信 · 数字分歧=回查口径 · 结论分歧=讨论素材 ｜ 含行内数据 · 勿发公网",
        strip_first_h1=True,
        strip_meta_block=True,
        cards=[("5/5", "过线表·降险杠杆 双方一致"), ("23%↔40%", "w 分歧（L_g 假设）"), ("±2pct", "汽车分期贴息归属待核"), ("0", "共同引用数字漂移")],
        footer="智见点评 · 盲测比对报告",
    ),
]

CSS = """
@page { size: A4; margin: 16mm 15mm 18mm 15mm;
  @bottom-left { content: "%(footer)s"; font-family: "Noto Sans CJK SC"; font-size: 7pt; color: #8a9a94; }
  @bottom-right { content: "第 " counter(page) " 页 / 共 " counter(pages) " 页"; font-family: "Noto Sans CJK SC"; font-size: 7pt; color: #8a9a94; } }
* { box-sizing: border-box; }
body { font-family: "Noto Sans CJK SC", sans-serif; font-size: 9.3pt; line-height: 1.62; color: #22302c; margin: 0; }
.cover { background: #0e6a55; color: #fff; padding: 20px 22px 16px; border-radius: 4px; margin-bottom: 12px; }
.cover .brand { font-size: 8pt; letter-spacing: .2em; color: #bcd8cf; margin-bottom: 10px; }
.cover h1 { font-family: "Noto Serif CJK SC", serif; font-size: 20pt; font-weight: 900; margin: 0 0 6px; line-height: 1.3; }
.cover .sub { font-size: 10pt; color: #d9ebe5; margin-bottom: 8px; }
.cover .meta { font-size: 7.5pt; color: #a7c8be; border-top: 1px solid rgba(255,255,255,.25); padding-top: 7px; }
.cards { display: flex; gap: 8px; margin: 0 0 14px; }
.card { flex: 1; background: #fff; border: 1px solid #d8e4df; border-top: 3px solid #a9741f; border-radius: 3px; padding: 8px 10px; }
.card .num { font-family: "Noto Serif CJK SC", serif; font-size: 15pt; font-weight: 900; color: #0e6a55; line-height: 1.15; }
.card .lbl { font-size: 7.2pt; color: #5c6d67; margin-top: 3px; line-height: 1.4; }
h2 { font-family: "Noto Serif CJK SC", serif; font-size: 13pt; color: #0e6a55; border-left: 5px solid #0e6a55; padding-left: 9px; margin: 20px 0 8px; page-break-after: avoid; }
h3 { font-size: 10.5pt; color: #a9741f; margin: 13px 0 6px; page-break-after: avoid; }
p { margin: 5px 0; } li { margin: 2.5px 0; }
blockquote { margin: 10px 0; padding: 8px 12px; background: #f2f7f5; border-left: 4px solid #a9741f; color: #0e4a3c; font-weight: 700; font-size: 9.8pt; }
blockquote p { margin: 0; }
table { border-collapse: collapse; width: 100%%; margin: 8px 0 12px; font-size: 8.2pt; }
th { background: #0e6a55; color: #fff; font-weight: 700; padding: 4.5px 6px; text-align: left; border: 1px solid #0b5847; }
td { padding: 4px 6px; border: 1px solid #d8e4df; vertical-align: top; }
tr:nth-child(even) td { background: #f5f9f7; }
tr { page-break-inside: avoid; }
strong { color: #0b4a3c; }
code { background: #fdf6ea; color: #8a5a12; font-family: "Noto Sans CJK SC"; font-size: 8.2pt; padding: 0 3px; border-radius: 2px; font-weight: 700; }
hr { border: none; border-top: 1px dashed #c8d6d0; margin: 14px 0; }
ol, ul { padding-left: 18px; margin: 5px 0; }
"""

def render(cfg):
    src = open(cfg["md"], encoding="utf-8").read()
    if cfg["strip_first_h1"]:
        src = re.sub(r"^# .+?\n", "", src, count=1)
    if cfg["strip_meta_block"]:
        src = re.sub(r"^> .+?\n(> .+?\n)*", "", src, count=1)  # 去卷首引用块（信息已入封面）
    body = markdown.markdown(src, extensions=["tables"])
    cards = "".join(f'<div class="card"><div class="num">{n}</div><div class="lbl">{l}</div></div>' for n, l in cfg["cards"])
    html = f"""<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><style>{CSS % dict(footer=cfg["footer"])}</style></head>
<body><div class="cover"><div class="brand">98wiki ｜ 智见点评 · 交叉验证盲测</div><h1>{cfg["title"]}</h1>
<div class="sub">{cfg["subtitle"]}</div><div class="meta">{cfg["meta"]}</div></div>
<div class="cards">{cards}</div>{body}</body></html>"""
    base = cfg["md"].rsplit(".", 1)[0]
    open(base + ".html", "w", encoding="utf-8").write(html)
    HTML(string=html, base_url=".").write_pdf(base + ".pdf")
    return base

for cfg in DOCS:
    b = render(cfg)
    print("OK", b + ".html /", b + ".pdf")
