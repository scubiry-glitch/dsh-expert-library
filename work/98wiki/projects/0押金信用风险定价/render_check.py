#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""render_check: 渲染同步验收 —— 计算 HTML/PDF SHA-256、页数、首/中/末页 PNG 截图。
Usage: python3 render_check.py <pdf> <html> <out_prefix> <part_label>
"""
import sys, hashlib, time
import fitz

def main():
    pdf, html, prefix, label = sys.argv[1:5]
    def sha(p):
        return hashlib.sha256(open(p, 'rb').read()).hexdigest()
    doc = fitz.open(pdf)
    n = len(doc)
    mid = max(1, n // 2)
    pages_to_shot = sorted(set([1, mid, n]))
    shots = {}
    for pg in pages_to_shot:
        pix = doc[pg - 1].get_pixmap(dpi=100)
        out = f"{prefix}_p{pg:02d}.png"
        pix.save(out)
        shots[pg] = out
    report = {
        "part": label,
        "pdf": pdf,
        "pdf_sha256": sha(pdf),
        "html": html,
        "html_sha256": sha(html),
        "pages": n,
        "checked_pages": pages_to_shot,
        "screenshots": shots,
        "rendered_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "render_method": "weasyprint 69 (md->html5->pdf, A4)",
        "note": "Part B/C 分别用各自验收器; 本记录随渲染同步生成",
    }
    import json
    with open(f"{prefix}_render_check.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
