#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""t6 交付门禁：G1 文字 / G2 数字 / G3 设计 / G5 PDF（G4 PPT 由 ppt skill 的 precheck 单独跑）。
输出 gates_report.json + gates_summary.md，作为交付证据留存。"""
import json, re, subprocess, sys, hashlib
from pathlib import Path
from collections import Counter

HERE = Path(__file__).resolve().parent
MD = HERE / "AI无佣与人机协同_正式稿_v1.md"
HTML = HERE / "AI无佣与人机协同_正式稿_v1.html"
PDF = HERE / "AI无佣与人机协同_正式稿_v1.pdf"
PPTX = HERE / "AI无佣与人机协同_汇报版_v1.pptx"
DETECT = Path("/root/zhijian/dsh-expert-library/knowledge/skills/finesse-ui/scripts/detect.mjs")
NUM = re.compile(r"\d+(?:\.\d+)?")
STRUCTURAL = {"98", "00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13"}
MD_FORBIDDEN = ["渠道灯塔", "统筹会长", "制度君", "海外瞭望员", "居住服务·Q", "居住服务·C",
                "居住服务·Z", "居住服务·H", "BK-019", "讨论稿", "v5.4", "修订清单", "评审轮次",
                "250 万亿", "核验约 40 项"]

report = {"gates": {}, "artifacts": {}}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def visible(html):
    b = re.sub(r"(?s)<script.*?</script>|<style.*?</style>|<!--.*?-->", " ", html)
    return re.sub(r"(?s)<[^>]+>", " ", b)


md = MD.read_text(); html = HTML.read_text(); body = visible(html)

# G1 文字门
hits = [t for t in MD_FORBIDDEN if t in body]
brand_ok = body.count("98wiki ｜ 智见 / 行业研究报告") >= 0
report["gates"]["G1_text"] = {
    "forbidden_hits": hits,
    "pass": len(hits) == 0,
    "note": "禁例清单：专家实名/匿名标注/过程痕迹/未核实量值",
}

# G2 数字门
md_nums, body_nums = set(NUM.findall(md)), set(NUM.findall(body))
extra = sorted(body_nums - md_nums - STRUCTURAL, key=lambda x: (len(x), x))
report["gates"]["G2_numbers"] = {
    "md_distinct": len(md_nums), "html_distinct": len(body_nums),
    "new_in_html": extra, "pass": len(extra) == 0,
    "structural_allowlist": sorted(STRUCTURAL),
}

# G3 设计门（detector + 静态）
out = subprocess.run(["node", str(DETECT), "--json", str(HTML)],
                     capture_output=True, text=True).stdout
det = json.loads(out)
findings = [f for x in det.get("files", []) for f in x.get("findings", [])]
report["gates"]["G3_design"] = {"p0": det.get("p0"), "findings": findings,
                                "pass": det.get("p0") == 0 and not findings}

# G5 PDF 门
import fitz
doc = fitz.open(PDF)
mm = 2.834645
box = fitz.Rect(14 * mm, 15 * mm, (210 - 14) * mm, (297 - 15) * mm)
viol = 0
for pg in doc:
    for b in pg.get_text("blocks"):
        r = fitz.Rect(b[:4])
        if r.y0 > 805:
            continue
        if r.x0 < box.x0 - 3 or r.x1 > box.x1 + 3 or r.y0 < box.y0 - 3 or r.y1 > box.y1 + 3:
            viol += 1
FOOT = "98wiki ｜ 智见 / 行业研究报告"
pages = doc.page_count
foot_ok = all(FOOT in doc[i].get_text() for i in range(1, pages - 1))
report["gates"]["G5_pdf"] = {
    "pages": pages, "content_box_violations": viol,
    "footer_on_body_pages": foot_ok,
    "cover_unfooted": FOOT not in doc[0].get_text(),
    "back_unfooted": FOOT not in doc[pages - 1].get_text(),
    "pass": viol == 0 and foot_ok,
}

# 交付物指纹
for f in ["AI无佣与人机协同_正式稿_v1.md", "AI无佣与人机协同_正式稿_v1.html",
          "AI无佣与人机协同_正式稿_v1.pdf", "AI无佣与人机协同_汇报版_v1.pptx"]:
    p = HERE / f
    report["artifacts"][f] = {"sha256": sha(p), "bytes": p.stat().st_size}

report["all_pass"] = all(g.get("pass") for g in report["gates"].values())
(HERE / "gates_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
print(json.dumps({k: v.get("pass") for k, v in report["gates"].items()}, ensure_ascii=False))
print("new_in_html:", extra, "| pdf pages:", report["gates"]["G5_pdf"]["pages"],
      "| all_pass:", report["all_pass"])
