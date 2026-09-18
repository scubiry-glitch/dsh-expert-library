# -*- coding: utf-8 -*-
"""渲染岗终验（UE 专题 v3 · 客群×产品框架）：pypdf 结构/大纲/页码 / 数字一致性 / 过程词禁例 / md5 复核 / 版式件"""
import hashlib, pathlib, re, sys
from pypdf import PdfReader
from pdfminer.high_level import extract_pages
from pdfminer.layout import LTTextContainer

BASE = pathlib.Path("/root/zhijian/dsh-expert-library/work/expert-teams/信用卡对标研报")
MD = BASE / "UE视角分析_信用卡_20260830.md"
RD = BASE / "render_ue"
HTML_F = RD / "UE视角分析_信用卡_20260830.html"
PDF_F = RD / "UE视角分析_信用卡_20260830.pdf"
MD5 = "d2411929ec89f32713c7ba7f6ce74823"

fail = []
def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  :: " + str(detail)))
    if not ok: fail.append(name)

# ---- 0) md5 复核（渲染不得改动 md） ----
md5 = hashlib.md5(MD.read_bytes()).hexdigest()
check("md5 复核 " + MD5, md5 == MD5, md5)

# ---- 1) pypdf 结构 ----
r = PdfReader(str(PDF_F))
n_pages = len(r.pages)
check("PDF 页数 = 封面 + 正文 + 封底（≥7，无空页）", n_pages >= 7, n_pages)

expect_outline = ["卷首", "第一章 现状诊断：亏在风险端", "第二章 客群端：客群结构是风险成本的配方",
                  "第三章 产品端：先过线，再放量", "第四章 行动：四杠杆节奏",
                  "局限与待补", "来源披露（一段）"]
outline_titles = []
def walk(ol):
    for it in ol:
        if isinstance(it, list): walk(it)
        else: outline_titles.append(it.title)
walk(r.outline)
hit = [t for t in expect_outline if t in outline_titles]
check("大纲章节逐项命中 7/7（卷首+四章+局限+来源披露）", len(hit) == 7,
      f"{len(hit)}/7 缺:{set(expect_outline)-set(outline_titles)}")

pdf_text = "\n".join((p.extract_text() or "") for p in r.pages)
foot = re.findall(r"99wiki ｜ 智见点评 · 行业研究 — (\d+) / (\d+)", pdf_text)
check(f"页脚格式 N/总页数 ×{n_pages-2}", len(foot) == n_pages - 2, len(foot))
check("页脚总页数一致", all(b == str(n_pages) for _, b in foot), set(b for _, b in foot))
nums = sorted(int(a) for a, _ in foot)
check(f"页脚页码连续 2..{n_pages-1}", nums == list(range(2, n_pages)), nums)
p1 = r.pages[0].extract_text() or ""; plast = r.pages[-1].extract_text() or ""
check("封面无页码", f"行业研究 — 1 /" not in p1)
check("封底无页码", f"行业研究 — {n_pages} /" not in plast)

# ---- 2) 正文页几何（pdfminer 抽 3 页，x0 异常左移） ----
bad_x = []
picks = {2, max(2, n_pages // 2), n_pages - 1}
for pageno, pl in enumerate(extract_pages(str(PDF_F)), start=1):
    if pageno not in picks: continue
    for el in pl:
        if isinstance(el, LTTextContainer):
            for ln in el:
                if hasattr(ln, "bbox") and ln.bbox[0] < 40 and ln.bbox[1] > 60 and ln.bbox[3] < 800:
                    bad_x.append((pageno, round(ln.bbox[0], 1), getattr(ln, "get_text", lambda: "")()[:16]))
check("正文页无异常左移（x0≥40pt）", not bad_x, bad_x[:3])

# ---- 3) 数字一致性抽检（去空白归一后三方比对；含封面四格/阶梯图 7 项/六行 21 项） ----
html_text = HTML_F.read_text(encoding="utf-8")
md_src = MD.read_text(encoding="utf-8")
norm = lambda s: re.sub(r"\s+", "", s)
html_n, pdf_n, md_n = norm(html_text), norm(pdf_text), norm(md_src)
anchors = [
    # -- 恒等式表 7 行全数 --
    "-2.85%", "4.90%", "2.30%", "4.37%", "1.08%", "8.53%", "2.96%", "7.61%", "0.89%", "-2.93%",
    "8.32%", "1.86%", "3.80%", "1.75%", "+0.91%", "3.52%", "1.89%", "1.34%", "-0.60%",
    "2.95%", "1.92%", "0.56%", "0.55%", "-0.08%", "2.56%", "1.41%", "0.69%", "0.50%", "-0.04%",
    "5.35%", "1.91%", "2.13%", "1.12%", "+0.19%",
    # -- 卷首总判断 / 结论表 --
    "285万", "226.6", "6.5亿", "2.60pct", "1.52pct", "2倍", "w≈23%", "2.1-2.5pct",
    "2.47%", "1.53%", "3.38pct", "1.13亿/年", "4.0%", "168%", "4.37÷2.60",
    # -- 第一章 --
    "+6.46%", "5.57%", "7.61%×23%", "3.4%×77%", "52亿", "1.45", "4.22%", "1.45%-4.22%",
    "8,909.08", "8,158.49", "4,025.90", "17-39倍", "1.96", "19,111.84", "9,770.73", "9,485.47",
    "236.98", "+39.29", "3.68%", "+0.62pct", "39亿", "1.4倍", "0.39pct", "2.24pct", "0.5pct",
    # -- 第二章 --
    "23%→10%", "13pct", "29亿", "52.1→22.7", "1.9%", "-0.95%", "6.8亿", "-0.01%", "218.76",
    "2,850万", "2,470万", "534.33", "+5pct", "26.7亿", "1.3亿", "-0.38%", "70%", "50亿",
    "-0.01pct", "-0.70%", "77%",
    # -- 第三章 --
    "7.75%", "2.85pct", "4.1%-4.7%", "2.0%-2.3%", "2.1%/2.7%", "0.72%-1.32%", "+0.32%", "-0.28%",
    "11.3/18.1", "297.97", "7.87%", "5免2", "7%", "+10.93%", "3,000", "0.35亿", "-35.2%",
    "50.12", "0.2%-0.5pct", "+18.40%", "447", "-6.01%", "5,700", "500亿", "877", "+0.5pct",
    "2.27亿",
    # -- 第四章 / 阶梯图 7 项 --
    "-1pct", "-1.35%", "-2.85+1.0+0.5", "2026Q3", "2026Q4", "2027", "-3亿", "红线4.0%",
    "手续费同比转正", "守4.90%/S4剪刀差", "S1+S2+S3", "4.90%/S4", "1倍",
    # -- 局限 / 来源披露 --
    "0.78pct", "0.30pct", "0.81%", "-60.58", "-21.09%", "287.2", "M0001428", "M0251917",
    "12次调用", "-5.13%", "-4.03%", "+0.16pct", "+0.17pct", "-5.43%", "4,285.21", "超1万亿元",
    "2026-08-13", "2026-06-30", "2026-08-30", "1.5%",
]
miss_md = [a for a in anchors if norm(a) not in md_n]
miss_pdf = [a for a in anchors if norm(a) not in pdf_n]
miss_html = [a for a in anchors if norm(a) not in html_n]
check(f"数字锚点 md 在案 {len(anchors)} 处", not miss_md, miss_md)
check(f"数字锚点 HTML 全命中 {len(anchors)-len(miss_html)}/{len(anchors)}", not miss_html, miss_html)
check(f"数字锚点 PDF 全命中 {len(anchors)-len(miss_pdf)}/{len(anchors)}", not miss_pdf, miss_pdf)

# ---- 4) 过程词禁例 + v2 残留（HTML 去标签 + PDF 文本，均归一空白） ----
BANNED = ["一一", "Data Analyst", "风控守门员", "队长", "轮次", "评审",
          "· 并六行", "UE 专题 v2"]  # 含 v2 版本残留检查（"并六行后…"为 v3 md 正文，不在禁例）
body_only = re.sub(r"<style>.*?</style>|<[^>]+>", "", html_text, flags=re.S)
hit_banned_h = [b for b in BANNED if b in body_only]
hit_banned_p = [b for b in BANNED if b in pdf_text]
check("HTML 过程词/v2 残留 0 命中", not hit_banned_h, hit_banned_h)
check("PDF 过程词/v2 残留 0 命中", not hit_banned_p, hit_banned_p)

# ---- 5) 关键版式件在位（PDF 侧按去空白比对） ----
for token, name in [("99wiki ｜ 智见点评 · 行业研究", "品牌行"),
                    ("UE 视角分析：江苏银行信用卡", "封面主标题"),
                    ("钱亏在哪一项，哪个杠杆最值钱（2026 中报季）", "封面副标题"),
                    ("客群×产品框架 · UE 方法论内嵌", "封面框架行"),
                    ("UE 专题 v3 · 客群×产品框架 · 2026-08-30", "封面版本行"),
                    ("行内材料 · 勿外发", "封面角标"),
                    ("客群端与产品端的全部动作，都围绕「把风险成本压下来」这一件事。", "封面金句"),
                    ("先过线，再放量——降险开路，中收跟进，提价守成，规模殿后。", "封底金句（第四章）"),
                    ("UE 专题 v3 · 客群×产品框架", "封底版本行"),
                    ("G3 渲染自检 · t12+t12 复验 PASS", "封底门禁说明"),
                    ("内部经营分析，不构成投资建议；测算/估算/研判推断非官方统计", "封底免责行"),
                    ("点睛图① · UE 恒等式分解瀑布", "点睛图1标题"),
                    ("点睛图② · 六行不良率 × 余额降幅发散条", "点睛图2标题"),
                    ("点睛图③ · mix-shift 情景对比", "点睛图3标题"),
                    ("点睛图④ · 四抓手卡阵 ＋ 弹性对比条", "点睛图4标题"),
                    ("点睛图⑤ · 四杠杆优先级阶梯", "点睛图5标题"),
                    ("图注：优先级为", "阶梯图注（研判推断）"),
                    ("情景测算", "mix 图注（情景测算）"),
                    ("过线 1.52%（EVA≈0）", "mix 过线虚线标注"),
                    ("2 倍 ≈2.27 亿", "阶梯·降险价值"),
                    ("1 倍 ≈1.13 亿", "阶梯·中收价值"),
                    ("1 倍 守成", "阶梯·提价价值"),
                    ("冻结 · UE<0 放量=放大亏损", "阶梯·规模冻结")]:
    tok_ns = norm(token)
    check("版式件·" + name, tok_ns in pdf_n and token in html_text.replace("&lt;", "<"))

# ---- 6) 结构与卫生 ----
for fid in ("fig-ue", "fig-div", "fig-mix", "fig-grip", "fig-stairs"):
    check("点睛图在位 id=" + fid, f'id="{fid}"' in html_text)
check("卷首全文结论表在位（4 行结论）", html_text.count("concl-table") >= 1 and
      all(k in html_text for k in ("一 现状诊断", "二 客群端", "三 产品端", "四 行动")))
check("无未替换占位符 @x@", not re.search(r"@[a-z]+@", re.sub(r"<style>.*?</style>", "", html_text, flags=re.S)))
check("无外部 CDN/网络资源", not re.search(r'(src|href)="https?://', html_text))
check("无渲染泄漏词（undefined/NaN）", "undefined" not in body_only and "NaN" not in body_only)

print("\n== %s ==" % ("全部通过" if not fail else f"失败 {len(fail)} 项: {fail}"))
sys.exit(1 if fail else 0)
