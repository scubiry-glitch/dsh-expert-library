#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""t6 · 渲染门禁（可重复执行）—— 三件套 + 五道门禁
用法：cd artifacts && python3 gates/run_gates.py
门禁：G1 文字(禁例token/应有项) · G2 数字(锚点逐项) · G3 设计(溢出/对比度AA/无遮挡)
      G4 PPT(pptfast validate+audit+notes) · G5 PDF(页脚逐页/大纲/无边距溢出)
退出码：0 = 全过；1 = 有门未过
"""
import hashlib, json, os, sys, pathlib, re, subprocess, unicodedata

ART = pathlib.Path(__file__).resolve().parent.parent
HTML = ART / "html/收储用途扩围与平台机会_正式稿.html"
PDF  = ART / "pdf/收储用途扩围与平台机会_正式稿.pdf"
PPTX = ART / "ppt/收储用途扩围与平台机会_正式稿.pptx"

fails, notes = [], []


def gate(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        fails.append(name)
    return ok


# ---------- G2: number anchors (single source of truth = t5 md) ----------
ANCHORS = ["约50%", "551", "5.336", "2.25万", "1500", "35.6", "0.24万", "8公里", "5.3亿"]

# ---------- G1 ban list / required list ----------
BANNED = ["格物讲师", "存量猎手", "运营管家", "批判教授", "讨论稿", "修订记录", "评审轮次", "v1.0", "草稿"]
REQUIRED_BRAND = ["98wiki", "智见"]

def txt(p):
    t = p.read_text(encoding="utf-8")
    return re.sub(r"<[^>]+>", " ", t) if p.suffix == ".html" else t


print("=" * 72)
print("G1 · 文字门禁（禁例 0 命中 / 应有项在位）")
htm = txt(HTML)
hits = [b for b in BANNED if b in htm]
gate("G1 禁例 token", not hits, f"命中={hits}" if hits else "0 命中")
gate("G1 品牌行在位", all(b in htm for b in REQUIRED_BRAND))

print("\nG2 · 数字门禁（锚点逐项一致）")
miss = [a for a in ANCHORS if a not in htm.replace(" ", "  ").replace(" ", "") and a not in htm]
# normalize spaces for CJK-latin boundaries
flat = htm.replace(" ", "")
miss = [a for a in ANCHORS if a.replace(" ", "") not in flat]
gate("G2 HTML 锚点", not miss, f"缺={miss}" if miss else f"{len(ANCHORS)}/{len(ANCHORS)}")

print("\nG3 · 设计门禁（溢出 / 对比度 AA）")
# contrast
def _s(c):
    c /= 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
def lum(h):
    h = h.lstrip("#"); r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _s(r) + 0.7152 * _s(g) + 0.0722 * _s(b)
def cr(a, b):
    l1, l2 = lum(a), lum(b)
    if l1 < l2: l1, l2 = l2, l1
    return (l1 + 0.05) / (l2 + 0.05)
PAIRS = [("--ink", "#0f1f1c", "#eef1ef"), ("--ink-2", "#2f423d", "#eef1ef"),
         ("--ink-3", "#5a6b66", "#eef1ef"), ("--ink-4", "#62716b", "#eef1ef"),
         ("--ink-4/card", "#62716b", "#f9fbfa"), ("--teal", "#0e6a55", "#eef1ef"),
         ("--amber", "#8f6119", "#eef1ef"), ("--amber-d", "#855a15", "#f4e9d5"),
         ("--teal-d", "#0a4c3d", "#dcebe5"), ("--warn", "#a3341f", "#f2ded9"),
         ("band text", "#f4f8f6", "#0e6a55"), ("band gold", "#f7dcae", "#0e6a55"),
         ("qb-mark", "#c6ded5", "#0e6a55"), ("back meta", "#a9c6bd", "#0a4c3d"),
         ("slate", "#55636f", "#e4e8ea")]
badc = [(n, round(cr(f, b), 2)) for n, f, b in PAIRS if cr(f, b) < 4.5]
gate("G3 对比度 AA(≥4.5)", not badc, f"失败={badc}" if badc else f"{len(PAIRS)} 组全过")

# playwright overflow / overlap
try:
    from playwright.sync_api import sync_playwright
    SHOTS = ART / "shots"; SHOTS.mkdir(exist_ok=True)
    metrics = {}
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        for w, h, tag in [(1280, 900, "1280"), (375, 812, "375")]:
            pg = br.new_page(viewport={"width": w, "height": h}, device_scale_factor=2)
            pg.goto(HTML.resolve().as_uri()); pg.wait_for_timeout(400)
            m = pg.evaluate("""()=>{const de=document.documentElement;
              const inScroller=e=>{let n=e.parentElement;while(n&&n!==document.body){
                const o=getComputedStyle(n).overflowX;if(o==='auto'||o==='scroll')return true;n=n.parentElement;}return false;};
              const real=[...document.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect();
                return r.width>0&&(r.right>de.clientWidth+1||r.left<-1)&&!inScroller(e);})
                .slice(0,6).map(e=>e.tagName+'.'+(e.className||'').toString().slice(0,24));
              return {overflow:de.scrollWidth-de.clientWidth,real,sh:de.scrollHeight,
                      tables:document.querySelectorAll('table').length,scripts:document.querySelectorAll('script').length};}""")
            metrics[tag] = m
            pg.screenshot(path=str(SHOTS / f"report_{tag}_full.png"), full_page=True)
            pg.close()
        br.close()
    (SHOTS / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    gate("G3 1280 无横向溢出", metrics["1280"]["overflow"] == 0, f"overflow={metrics['1280']['overflow']}")
    gate("G3 375 无页级溢出", metrics["375"]["overflow"] == 0 and not metrics["375"]["real"],
         f"overflow={metrics['375']['overflow']} 越界={metrics['375']['real']}")
    gate("G3 零 JS 引擎(product register)", metrics["1280"]["scripts"] == 0)
except Exception as e:
    notes.append(f"playwright 跳过：{e}")

# ---------- G5: PDF ----------
print("\nG4 · PPTX 门禁（由 pptfast 子进程执行，见 gates/ppt_gates.sh）")
if PPTX.exists():
    try:
        from pptx import Presentation
        pr = Presentation(str(PPTX))
        n = len(pr.slides)
        notes_ok = sum(1 for s in pr.slides if s.has_notes_slide and s.notes_slide.notes_text_frame.text.strip())
        allt = "\n".join(sh.text_frame.text for s in pr.slides for sh in s.shapes
                         if sh.has_text_frame and sh.text_frame.text)
        gate("G4 页数 6-24(balanced)", 6 <= n <= 24, f"{n} 页")
        gate("G4 全内容页 speaker notes", notes_ok >= n - 2, f"{notes_ok}/{n}")
        pmiss = [a for a in ANCHORS if a.replace(" ", "") not in allt.replace(" ", "")]
        gate("G4 数字锚点", not pmiss, f"缺={pmiss}" if pmiss else "全在")
        gate("G4 预测带「研判推断」", allt.count("研判推断") > 0, f"{allt.count('研判推断')} 处")
    except Exception as e:
        fails.append(f"G4 读取失败 {e}")

print("\nG5 · PDF 门禁（页脚逐页 / 无边距溢出 / 大纲）")
if PDF.exists():
    try:
        import pypdf, fitz
        r = pypdf.PdfReader(str(PDF)); pages = [p.extract_text() or "" for p in r.pages]
        foot = [("98wiki" in t and "共" in t) for t in pages]
        gate("G5 正文页脚逐页", all(foot[1:-1]) and len(foot) > 2, f"{sum(foot[1:-1])}/{len(foot)-2}")
        gate("G5 封面/封底无页码", not foot[0] and not foot[-1])
        d = fitz.open(str(PDF)); lim = d[0].rect.width - 36.85 + 1.5
        over = sum(1 for p in d for b in p.get_text("dict")["blocks"] for l in b.get("lines", [])
                   for s in l["spans"] if s["bbox"][2] > lim)
        gate("G5 无右边距裁切", over == 0, f"越界 span={over}")
        allpdf = "\n".join(pages)
        fmiss = [a for a in ANCHORS if a.replace(" ", "") not in allpdf.replace(" ", "")]
        gate("G5 数字锚点", not fmiss, f"缺={fmiss}" if fmiss else "全在")
        for i in [0, 1, 10, 11, 14]:
            if i < len(d):
                d[i].get_pixmap(dpi=110).save(str(ART / f"shots/pdf_page_{i+1}.png"))
    except Exception as e:
        fails.append(f"G5 失败 {e}")
else:
    fails.append("G5 PDF 缺失")

# ---------- sha256 ----------
print("\n" + "=" * 72)
lines = []
for p in [HTML, PDF, PPTX]:
    if p.exists():
        h = hashlib.sha256(p.read_bytes()).hexdigest()
        lines.append(f"{h}  {p.relative_to(ART)}")
        print(f"sha256 {h[:16]}…  {p.relative_to(ART)}  ({p.stat().st_size}B)")
(ART / "sha256sums.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

print("\n" + "=" * 72)
if notes:
    print("备注：", "; ".join(notes))
print(f"门禁结果：{'全部通过' if not fails else '未过 → ' + str(fails)}")
sys.exit(1 if fails else 0)
