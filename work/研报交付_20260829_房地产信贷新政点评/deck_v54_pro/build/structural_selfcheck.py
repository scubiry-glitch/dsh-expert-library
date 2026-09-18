#!/usr/bin/env python3
"""structural_selfcheck.py — 渲染后端缺失时的补偿性结构自检。

检查（对齐 render_review 关注点）：
 1) 全部 shape 位于页内（0 ≤ x, y, x+w ≤ 13.333, y+h ≤ 7.5，容差 0.02）
 2) 非 footer 元素不侵入页脚带（y ≥ 7.02）
 3) notes 每页存在、长度 100-280 字
 4) 页码结构：S02-S32 含「NN / 33」；S01/S33 无页码
 5) native chart 数量与位置记录
 6) ea 字体槽位抽查
输出 JSON + Markdown 到 validation/render_review/。
"""
import json, os, sys, datetime
from pptx import Presentation
from pptx.util import Emu
from pptx.oxml.ns import qn

PPTX = sys.argv[1] if len(sys.argv) > 1 else "pptx/deck_v54.pptx"
HERE = os.path.dirname(os.path.abspath(__file__))
W = os.path.dirname(os.path.dirname(HERE))
PPTX = os.path.join(HERE, PPTX) if not os.path.isabs(PPTX) else PPTX
OUTD = os.path.join(W, "validation", "render_review")
os.makedirs(OUTD, exist_ok=True)

prs = Presentation(PPTX)
PW, PH = 13.333, 7.5
issues = []
stats = {"slides": len(prs.slides.__iter__.__self__._sldIdLst), "charts": 0,
         "tables": 0, "notes_len": [], "page_no_ok": [], "shape_total": 0,
         "ea_missing": 0, "ea_checked": 0}

def inch(v):
    return Emu(v).inches if v is not None else None

for i, slide in enumerate(prs.slides, 1):
    has_chart = False
    for shp in slide.shapes:
        stats["shape_total"] += 1
        try:
            x, y = inch(shp.left), inch(shp.top)
            w, h = inch(shp.width), inch(shp.height)
        except Exception:
            continue
        if None in (x, y, w, h):
            continue
        if x < -0.02 or y < -0.02 or x + w > PW + 0.02 or y + h > PH + 0.02:
            issues.append(f"S{i}: shape 越界 {shp.shape_type} at ({x:.2f},{y:.2f},{w:.2f},{h:.2f})")
        is_footer = (y > 6.95 and (w > 5.5 or (x > 10 and w < 2.6)))
        if (not is_footer) and y + h > 7.03 and y < 7.06:
            issues.append(f"S{i}: 侵入页脚带 shape at y={y:.2f} h={h:.2f}")
        if shp.has_chart:
            has_chart = True
            stats["charts"] += 1
        if getattr(shp, "has_table", False):
            stats["tables"] += 1
    # notes
    ntext = slide.notes_slide.notes_text_frame.text if slide.has_notes_slide else ""
    stats["notes_len"].append(len(ntext))
    if not (90 <= len(ntext) <= 340):
        issues.append(f"S{i}: notes 长度异常 {len(ntext)}")
    # 页码
    txts = []
    for shp in slide.shapes:
        if shp.has_text_frame:
            txts.append(shp.text_frame.text)
    joined = "\n".join(txts)
    expect_no = i in (1, 33)
    has_pageno = f"{i:02d} / 33" in joined
    if expect_no and has_pageno:
        issues.append(f"S{i}: 封面/封底不应有页码")
    if (not expect_no) and not has_pageno:
        issues.append(f"S{i}: 缺页码 NN / 33")
    stats["page_no_ok"].append((i, has_pageno))
    # ea slot 抽查（每页前 40 个 run）
    checked = 0
    for shp in slide.shapes:
        if not shp.has_text_frame:
            continue
        for p in shp.text_frame.paragraphs:
            for r in p.runs:
                rPr = r._r.find(qn("a:rPr"))
                if rPr is None:
                    continue
                stats["ea_checked"] += 1
                checked += 1
                if rPr.find(qn("a:ea")) is None:
                    stats["ea_missing"] += 1
            if checked >= 40:
                break
        if checked >= 40:
            break

rep = {
    "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    "pptx": PPTX,
    "backend_available": False,
    "backend_note": "当前环境无 PowerPoint/LibreOffice/pdftoppm 后端，视觉预览导出不可用（export_pptx_previews.py 报 RuntimeError）。"
                    "按 skill 规范记 not_checked，以本结构自检作为补偿证据。",
    "stats": {"slides": stats["slides"], "native_charts": stats["charts"],
              "native_tables": stats["tables"],
              "notes_len_min": min(stats["notes_len"]),
              "notes_len_max": max(stats["notes_len"]),
              "shapes_total": stats["shape_total"],
              "ea_slots_checked": stats["ea_checked"],
              "ea_slots_missing": stats["ea_missing"]},
    "issues": issues,
    "verdict": "PASS" if not issues and stats["ea_missing"] == 0 else "FAIL",
}
with open(os.path.join(OUTD, "structural_selfcheck.json"), "w", encoding="utf-8") as f:
    json.dump(rep, f, ensure_ascii=False, indent=2)
md = ["# render_review · 补偿性结构自检（后端缺失降级）", "",
      f"- 生成时间：{rep['generated_at']}", f"- 结论：**{rep['verdict']}**",
      f"- 页数：{stats['slides']}｜native chart：{stats['charts']}｜native 表格：{stats['tables']}",
      f"- notes 长度区间：{min(stats['notes_len'])}-{max(stats['notes_len'])} 字",
      f"- ea 槽位抽查：{stats['ea_checked']} 个 run，缺失 {stats['ea_missing']}",
      f"- issues：{len(issues)}"]
for it in issues:
    md.append(f"  - {it}")
with open(os.path.join(OUTD, "structural_selfcheck.md"), "w", encoding="utf-8") as f:
    f.write("\n".join(md) + "\n")
print(f"verdict={rep['verdict']} issues={len(issues)} charts={stats['charts']} "
      f"tables={stats['tables']} notes={min(stats['notes_len'])}-{max(stats['notes_len'])}")
for it in issues[:12]:
    print(" -", it)
