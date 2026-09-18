# -*- coding: utf-8 -*-
"""渲染门 G3-PDF：文本 bbox 越界/出血检测 + weasyprint 警告捕获"""
import io, logging, pathlib, sys
from pypdf import PdfReader

BASE = pathlib.Path("/root/zhijian/dsh-expert-library/work/expert-teams/信用卡对标研报/render_playbook")
PDF = BASE / "别人的打法_溯源与迁移_20260830.pdf"

# 1) weasyprint 重渲染捕获警告（字体缺失等）
logging.basicConfig(level=logging.DEBUG)
buf = io.StringIO()
h = logging.StreamHandler(buf)
h.setLevel(logging.WARNING)
log = logging.getLogger("weasyprint")
log.addHandler(h)
from weasyprint import HTML
HTML(filename=str(BASE / "别人的打法_溯源与迁移_20260830.html")).write_pdf(str(BASE / "build" / "_qa.pdf"))
warns = [l for l in buf.getvalue().splitlines() if l.strip()]
print("weasyprint warnings:", len(warns))
for w in warns[:20]:
    print("  ", w[:200])

# 2) 文本 bbox 越界检测
try:
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LTTextContainer, LTTextLine
except ImportError:
    print("pdfminer 不可用，跳过 bbox 审计"); sys.exit(0)

r = PdfReader(str(PDF))
issues = 0
for pageno, page_layout in enumerate(extract_pages(str(PDF)), start=1):
    W = float(page_layout.width); H = float(page_layout.height)
    for el in page_layout:
        if isinstance(el, LTTextContainer):
            for line in el:
                if not hasattr(line, "bbox"):
                    continue
                x0, y0, x1, y1 = line.bbox
                if x1 > W + 0.5 or x0 < -0.5 or y1 > H + 0.5 or y0 < -0.5:
                    txt = getattr(line, "get_text", lambda: "")().strip()[:40]
                    print(f"  OUT p{pageno} bbox=({x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f}) W={W:.0f} H={H:.0f} :: {txt}")
                    issues += 1
print("bbox out-of-page issues:", issues)
