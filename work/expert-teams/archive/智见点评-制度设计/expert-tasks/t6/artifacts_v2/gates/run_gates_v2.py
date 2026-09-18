#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""t6 v2 · 渲染门禁（可重复执行）
用法：cd artifacts_v2 && python3 gates/run_gates_v2.py
门禁：G1 文字(禁例/应有) · G2 数字锚点 · G3 设计(320–1280 零溢出 + 对比度AA + finesse P0=0)
      G4 PPTX(python-pptx 原生对象/全页 notes/锚点/越界) · G5 PDF(页脚逐页/栅格化/图卡不跨页/无边距裁切)
退出码：0 = 全过
"""
import hashlib, json, pathlib, re, subprocess, sys, unicodedata

ART = pathlib.Path(__file__).resolve().parent.parent
HTML = ART / "html/收储用途扩围与平台机会_正式稿.html"
PDF  = ART / "pdf/收储用途扩围与平台机会_正式稿.pdf"
PPTX = ART / "ppt/收储用途扩围与平台机会_正式稿.pptx"
SLUG_URL = "https://yy.meizu.life/render/智见点评-制度设计/shouchu-kuowei-v2.html"

fails = []
def gate(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")
    if not ok: fails.append(name)

ANCHORS = ["约50%", "551", "5.336", "2.25", "1500", "35.6", "0.24", "8", "5.3"]
BANNED = ["格物讲师", "存量猎手", "运营管家", "批判教授", "讨论稿", "融合说明", "修订记录", "评审轮次"]

print("=" * 74)
print("G1 · 文字门禁")
htm = HTML.read_text(encoding="utf-8")
flat = re.sub(r"<[^>]+>", " ", htm)
hits = [b for b in BANNED if b in flat]
gate("G1 禁例 token（含【融合说明】）", not hits, f"命中={hits}" if hits else "0 命中")
gate("G1 品牌行", "98wiki" in flat and "智见" in flat)
gate("G1 四级标注色块在位", all(f'tag-{c}' in htm for c in ["ref", "calc", "jud", "todo", "est"]))

print("\nG2 · 数字门禁（锚点逐项）")
n = HTML.read_text(encoding="utf-8").replace(" ", "")
gate("G2 HTML 锚点", all(a.replace(" ", "") in n for a in ANCHORS), f"{len(ANCHORS)} 项")

print("\nG3 · 设计门禁")
# --- finesse detect ---
DET = "/root/zhijian/dsh-expert-library/knowledge/skills/finesse-ui/scripts/detect.mjs"
try:
    r = subprocess.run(["node", DET, "--json", str(HTML)], capture_output=True, text=True, timeout=120)
    d = json.loads(r.stdout)
    p0 = d.get("p0", -1)
    soft = [(f["severity"], f["id"], f["count"]) for f in d["files"][0]["findings"]]
    gate("G3 finesse P0=0", p0 == 0, f"P0={p0}｜余软项 {soft}")
except Exception as e:
    gate("G3 finesse P0=0", False, f"detector 失败 {e}")

# --- contrast (final tokens) ---
def _s(c):
    c /= 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
def lum(h):
    h = h.lstrip("#"); r, g, b = (int(h[i:i+2], 16) for i in (0, 2, 4))
    return 0.2126*_s(r) + 0.7152*_s(g) + 0.0722*_s(b)
def cr(a, b):
    l1, l2 = lum(a), lum(b)
    if l1 < l2: l1, l2 = l2, l1
    return (l1 + 0.05) / (l2 + 0.05)
PAPER, CARD = "#F1EEE7", "#FDFCF9"
PAIRS = [("ink-1", "#1A1714"), ("ink-2", "#443E37"), ("ink-3", "#6B6459"), ("ink-4", "#6E675D"),
         ("peacock", "#10605A"), ("gold-ink", "#7E5618"), ("warn", "#8A3A26")]
bads = []
for nm, c in PAIRS:
    for bg, bgn in ((PAPER, "paper"), (CARD, "card")):
        v = cr(c, bg)
        if v < 4.5: bads.append((nm, bgn, round(v, 2)))
for nm, f, b in [("on-peacock", "#F2F7F5", "#10605A"), ("gold-soft", "#7E5618", "#F0E6D3"),
                 ("peacock-soft", "#10605A", "#E2EDEA"), ("warn-soft", "#8A3A26", "#F2E2DC"),
                 ("judge-soft", "#443E37", "#EAE6DE"), ("backcover-gold", "#EFC98A", "#0B4A45"),
                 ("backcover-meta", "#BBD5D0", "#0B4A45")]:
    v = cr(f, b)
    if v < 4.5: bads.append((nm, "tag", round(v, 2)))
gate("G3 对比度 AA ≥4.5（paper+card+tag）", not bads, f"失败={bads}" if bads else f"{len(PAIRS)*2+7} 组全过")

# --- 320–1280 zero overflow ---
try:
    from playwright.sync_api import sync_playwright
    SHOTS = ART / "shots"; SHOTS.mkdir(exist_ok=True)
    res = {}
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        for w, h in [(320, 700), (375, 812), (414, 896), (768, 1024), (1280, 900)]:
            pg = br.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
            pg.goto(HTML.resolve().as_uri()); pg.wait_for_timeout(350)
            m = pg.evaluate("""()=>{const de=document.documentElement;
              const inScroller=e=>{let n=e.parentElement;while(n&&n!==document.body){
                const o=getComputedStyle(n).overflowX;if(o==='auto'||o==='scroll')return true;n=n.parentElement;}return false;};
              const real=[...document.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect();
                return r.width>0&&(r.right>de.clientWidth+1||r.left<-1)&&!inScroller(e);})
                .slice(0,5).map(e=>e.tagName+'.'+(e.className||'').toString().slice(0,20));
              return {ov:de.scrollWidth-de.clientWidth, real,
                      script:document.querySelectorAll('script').length};}""")
            res[w] = m
            if w in (320, 1280):
                pg.screenshot(path=str(SHOTS / f"html_{w}_full.png"), full_page=True)
            pg.close()
        br.close()
    (SHOTS / "metrics.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    ov = {w: m["ov"] for w, m in res.items()}
    rl = {w: m["real"] for w, m in res.items() if m["real"]}
    gate("G3 320–1280 视口零溢出", all(v == 0 for v in ov.values()) and not rl,
         f"overflow={ov} 越界={rl}")
    gate("G3 零 JS 引擎", all(m["script"] == 0 for m in res.values()))
except Exception as e:
    gate("G3 视口零溢出", False, f"playwright 失败 {e}")

print("\nG4 · PPTX 门禁（python-pptx 原生对象 + 全页 notes）")
try:
    from pptx import Presentation
    pr = Presentation(str(PPTX))
    n = len(pr.slides)
    notes = sum(1 for s in pr.slides if s.has_notes_slide and s.notes_slide.notes_text_frame.text.strip())
    tbs = sum(1 for s in pr.slides for sh in s.shapes if sh.has_table)
    txt = []
    for s in pr.slides:
        for sh in s.shapes:
            if sh.has_text_frame: txt.append(sh.text_frame.text)
            if sh.has_table:
                for r in sh.table.rows:
                    for c in r.cells: txt.append(c.text)
    full = "\n".join(txt)
    oob = 0
    for s in pr.slides:
        for sh in s.shapes:
            try:
                if sh.left + sh.width > pr.slide_width + 1000 or sh.top + sh.height > pr.slide_height + 1000:
                    oob += 1
            except TypeError:
                pass
    gate("G4 全页 speaker notes", notes == n, f"{notes}/{n}")
    gate("G4 原生对象（表格/形状）", tbs >= 10, f"native_tables={tbs}")
    gate("G4 无越界形状", oob == 0, f"越界={oob}")
    gate("G4 数字锚点", all(a.replace(" ", "") in full.replace(" ", "") for a in ANCHORS))
    gate("G4 「研判推断」标注在位", full.count("研判推断") > 0, f"{full.count('研判推断')} 处")
except Exception as e:
    gate("G4 PPTX", False, str(e))

print("\nG5 · PDF 门禁（页脚逐页 / 栅格化留证 / 图卡不跨页 / 无边距裁切）")
try:
    import fitz, pypdf
    r = pypdf.PdfReader(str(PDF)); pages = [p.extract_text() or "" for p in r.pages]
    d = fitz.open(str(PDF))
    foot = [(("98wiki" in t) and ("共" in t)) for t in pages]
    gate("G5 正文页脚逐页(含页码)", all(foot[1:-1]) and len(foot) > 4, f"{sum(foot[1:-1])}/{len(foot)-2}")
    gate("G5 封面有品牌行、封底无页脚", ("98wiki" in pages[0]) and ("98wiki" not in pages[-1]))
    lands = [i+1 for i in range(len(d)) if d[i].rect.width > d[i].rect.height]
    gate("G5 宽表独占横向页", len(lands) == 1, f"landscape 页={lands}")
    # per-page limit: the landscape page is 842pt wide, so a single portrait limit is wrong
    ov = 0
    for p in d:
        lim = p.rect.width - 36.85 + 1.5
        ov += sum(1 for b in p.get_text("dict")["blocks"] for l in b.get("lines", [])
                  for s in l["spans"] if s["bbox"][2] > lim)
    gate("G5 无右边距裁切", ov == 0, f"越界 span={ov}")
    EX = {"Ex.1": ("已落地，融资成本一侧明显下移", "尚未成型，无需求清单"),
          "Ex.2": ("上年末形成经财政与住建联审的年度需求清单", "退出通道普遍缺位"),
          "Ex.3": ("市场租金折价，偏低", "均为点状案例；分项待补"),
          "Ex.4": ("房源落在真实用工与就学半径内", "可得则加分"),
          "Ex.5": ("现金流稳定可预测、资产权属与运营数据可审计", "否则属隐性挂账"),
          "Ex.6": ("以同板块可比真实成交价为基准", "不作单点承诺"),
          "Ex.7": ("官方或决算口径，非报道口径", "具体数字待核实"),
          "Ex.8": ("用途继续扩围，采购仍逐单推进", "第三方付费空间被压扁")}
    def pg_of(s):
        s = s.replace(" ", "").replace("\n", "")
        return [i+1 for i, t in enumerate(pages) if s in t.replace(" ", "").replace("\n", "")]
    split = [k for k, (a, b) in EX.items() if not (set(pg_of(a)) & set(pg_of(b)))]
    gate("G5 图卡/表单不跨页断裂", not split, f"断裂={split}" if split else f"{len(EX)}/{len(EX)} 同页")
    gate("G5 PDF 逐页栅格化留证", len(list((ART/"shots/pdf_pages").glob('p*.png'))) == len(d),
         f"{len(list((ART/'shots/pdf_pages').glob('p*.png')))}/{len(d)} 页")
    gate("G5 数字锚点", all(a.replace(" ", "") in "".join(pages).replace(" ", "") for a in ANCHORS))
except Exception as e:
    gate("G5 PDF", False, str(e))

print("\n" + "=" * 74)
lines = []
for p in [HTML, PDF, PPTX]:
    if p.exists():
        h = hashlib.sha256(p.read_bytes()).hexdigest()
        lines.append(f"{h}  {p.relative_to(ART)}")
        print(f"sha256 {h}  ({p.stat().st_size}B)  {p.relative_to(ART)}")
(ART / "sha256sums.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

print("\n外链：", SLUG_URL)
print(f"门禁结果：{'全部通过' if not fails else '未过 → ' + str(fails)}")
sys.exit(1 if fails else 0)
