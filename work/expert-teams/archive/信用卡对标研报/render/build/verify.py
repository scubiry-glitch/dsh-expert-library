# -*- coding: utf-8 -*-
"""渲染岗终验：pypdf 结构 / 数字一致性 / 过程词禁例 / md5 复核 / 正文页几何"""
import hashlib, pathlib, re, sys
from pypdf import PdfReader
from pdfminer.high_level import extract_pages
from pdfminer.layout import LTTextContainer

BASE = pathlib.Path("/root/zhijian/dsh-expert-library/work/expert-teams/信用卡对标研报")
MD = BASE / "研报主文_信用卡对标_20260830.md"
RD = BASE / "render"
HTML_F = RD / "研报主文_信用卡对标_20260830.html"
PDF_F = RD / "研报主文_信用卡对标_20260830.pdf"

fail = []
def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  :: " + str(detail)))
    if not ok: fail.append(name)

# ---- 0) md5 复核 ----
md5 = hashlib.md5(MD.read_bytes()).hexdigest()
check("md5 复核", md5 == "8dd471a098b4a3fa5cacca8f94af11c3", md5)

# ---- 1) pypdf 结构 ----
r = PdfReader(str(PDF_F))
n_pages = len(r.pages)
check("PDF 页数 17（封面+15 正文+封底）", n_pages == 17, n_pages)

expect_outline = ["卷首速览", "总论：为什么是现在——行业收缩期的三笔账",
 "第一章 单位经济对标：EVA -2.85%——风险成本吃掉几乎全部收益",
 "第二章 产品要素对标：卡在缩、账在分、人在变",
 "第三章 风险生成对标：不良率是后视镜，生成率才是仪表盘",
 "第四章 客群端破局：从池子管理到客群结构重构",
 "第五章 产品端破局：从现金分期到场景分期+中收",
 "总结：收什么、保什么、建什么", "来源披露"]
outline_titles = []
def walk(ol):
    for it in ol:
        if isinstance(it, list): walk(it)
        else: outline_titles.append(it.title)
walk(r.outline)
hit = [t for t in expect_outline if t in outline_titles]
check("大纲章节逐项命中 9/9", len(hit) == 9, f"{len(hit)}/9 缺:{set(expect_outline)-set(outline_titles)}")

pdf_text = "\n".join((p.extract_text() or "") for p in r.pages)
foot = re.findall(r"99wiki ｜ 智见点评 · 行业研究 — (\d+) / (\d+)", pdf_text)
check("页脚格式 N/总页数 ×15", len(foot) == 15, len(foot))
check("页脚总页数一致", all(b == "17" for _, b in foot), set(b for _, b in foot))
nums = sorted(int(a) for a, _ in foot)
check("页脚页码连续 2..16", nums == list(range(2, 17)), nums)
p1 = r.pages[0].extract_text() or ""; p17 = r.pages[-1].extract_text() or ""
check("封面无页码", "行业研究 — 1 /" not in p1)
check("封底无页码", "行业研究 — 17 /" not in p17)

# ---- 2) 正文页几何（pdfminer 抽 3 页） ----
bad_x = []
for pageno, pl in enumerate(extract_pages(str(PDF_F)), start=1):
    if pageno not in (3, 9, 15): continue
    for el in pl:
        if isinstance(el, LTTextContainer):
            for ln in el:
                if hasattr(ln, "bbox") and ln.bbox[0] < 40 and ln.bbox[1] > 60 and ln.bbox[3] < 800:
                    bad_x.append((pageno, round(ln.bbox[0], 1), getattr(ln, "get_text", lambda: "")()[:16]))
check("正文页无异常左移（x0≥40pt 或页边框元素）", not bad_x, bad_x[:3])

# ---- 3) 数字一致性抽检（≥15 处：封面四格/图表/正文锚点） ----
html_text = HTML_F.read_text(encoding="utf-8")
md_text = MD.read_text(encoding="utf-8")
anchors = ["-2.85%", "-21.09%", "3.68%", "+0.62pct", "1.52%", "4.90%", "4.37%",
           "-60.58", "220.4", "-2.93%", "534.33", "104.3%", "3,597", "-9.55%",
           "50.12", "13,801.32", "0.91", "2.47%", "1.53%", "297.97", "3,784.28",
           "7.61%", "11,975", "8,088", "0.81%", "-70 亿", "+8 亿", "4.1%-4.7%",
           "1.13 亿", "2.30pct", "1.08pct", "3.38pct", "218.76", "194,683.31"]
miss_pdf = [a for a in anchors if a not in pdf_text]
miss_html = [a for a in anchors if a not in html_text]
miss_md = [a for a in anchors if a not in md_text]
check(f"数字锚点 md 在案 {len(anchors)} 处", not miss_md, miss_md)
check(f"数字锚点 PDF 全命中 {len(anchors)-len(miss_pdf)}/{len(anchors)}", not miss_pdf, miss_pdf)
check(f"数字锚点 HTML 全命中 {len(anchors)-len(miss_html)}/{len(anchors)}", not miss_html, miss_html)

# ---- 4) 过程词禁例（HTML 文本去标签后 + PDF 文本） ----
BANNED = ["一一", "Data Analyst", "风控守门员", "队长", "轮次", "评审"]
body_only = re.sub(r"<style>.*?</style>|<[^>]+>", "", html_text, flags=re.S)
hit_banned_h = [b for b in BANNED if b in body_only]
hit_banned_p = [b for b in BANNED if b in pdf_text]
check("HTML 过程词 0 命中", not hit_banned_h, hit_banned_h)
check("PDF 过程词 0 命中", not hit_banned_p, hit_banned_p)

# ---- 5) 关键版式件在位（PDF 侧按去空白比对，规避字距抽取空格） ----
pdf_ns = re.sub(r"\s+", "", pdf_text)
for token, name in [("行内材料 · 勿外发", "封面半敏感角标"),
                    ("完整报告 v1 · 2026-08-30", "封面版本行"),
                    ("2026 中报季 · 产品对标 × 单位经济 × 风险生成 × 客群/产品破局", "封面副标题"),
                    ("江苏银行信用卡业务对标研报", "封面主标题"),
                    ("G1 · G2 Final v2 PASS", "封底门禁说明"),
                    ("行业研究，不构成投资建议；测算/估算/研判推断非官方统计", "免责一行"),
                    ("情景测算", "mix-shift 图注"),
                    ("章眼金句", "章眼金句块")]:
    tok_ns = re.sub(r"\s+", "", token)
    check("版式件·" + name, tok_ns in pdf_ns and token in html_text)

# ---- 6) 外链/CDN 禁用 ----
check("无外部 CDN/网络资源", not re.search(r'(src|href)="https?://', html_text.replace('href="#', '')))

print("\n== %s ==" % ("全部通过" if not fail else f"失败 {len(fail)} 项: {fail}"))
sys.exit(1 if fail else 0)
