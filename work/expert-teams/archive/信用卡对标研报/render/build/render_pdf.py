# -*- coding: utf-8 -*-
"""渲染岗：HTML → PDF（weasyprint，A4，命名页封面封底，章节大纲 bookmarks）"""
import pathlib, time
from weasyprint import HTML

BASE = pathlib.Path("/root/zhijian/dsh-expert-library/work/expert-teams/信用卡对标研报/render")
src = BASE / "研报主文_信用卡对标_20260830.html"
out = BASE / "研报主文_信用卡对标_20260830.pdf"
t0 = time.time()
HTML(filename=str(src)).write_pdf(str(out))
print("PDF written:", out, out.stat().st_size, "bytes in %.1fs" % (time.time() - t0))
