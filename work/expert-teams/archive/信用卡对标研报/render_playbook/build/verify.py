# -*- coding: utf-8 -*-
"""渲染岗终验（打法研究 v1 · 溯源-迁移框架）：pypdf 结构/大纲/页码 / 数字一致性 / 过程词禁例 / md5 复核 / 版式件"""
import hashlib, pathlib, re, sys
from pypdf import PdfReader
from pdfminer.high_level import extract_pages
from pdfminer.layout import LTTextContainer

BASE = pathlib.Path("/root/zhijian/dsh-expert-library/work/expert-teams/信用卡对标研报")
MD = BASE / "别人的打法_溯源与迁移_20260830.md"
RD = BASE / "render_playbook"
HTML_F = RD / "别人的打法_溯源与迁移_20260830.html"
PDF_F = RD / "别人的打法_溯源与迁移_20260830.pdf"
MD5 = "a0a1f7bb06f6ee2178aa2fca327e69c1"

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
check("PDF 页数 = 封面 + 正文 + 封底（≥8，无空页）", n_pages >= 8, n_pages)

expect_outline = ["卷首", "第一章 获客与流量打法", "第二章 资产端打法", "第三章 收入结构打法",
                  "第四章 风险与出清打法", "第五章 组织与机制打法",
                  "第六章 迁移适配矩阵与采纳路线图", "局限与待补", "来源披露（一段）"]
outline_titles = []
def walk(ol):
    for it in ol:
        if isinstance(it, list): walk(it)
        else: outline_titles.append(it.title)
walk(r.outline)
hit = [t for t in expect_outline if t in outline_titles]
check("大纲章节逐项命中 9/9（卷首+六章+局限+来源披露）", len(hit) == 9,
      f"{len(hit)}/9 缺:{set(expect_outline)-set(outline_titles)}")

pdf_text = "\n".join((p.extract_text() or "") for p in r.pages)
foot = re.findall(r"99wiki ｜ 智见点评 · 行业研究 — (\d+) / (\d+)", pdf_text)
check(f"页脚格式 N/总页数 ×{n_pages-2}", len(foot) == n_pages - 2, len(foot))
check("页脚总页数一致", all(b == str(n_pages) for _, b in foot), set(b for _, b in foot))
nums = sorted(int(a) for a, _ in foot)
check(f"页脚页码连续 2..{n_pages-1}", nums == list(range(2, n_pages)), nums)
p1 = r.pages[0].extract_text() or ""; plast = r.pages[-1].extract_text() or ""
check("封面无页码", f"行业研究 — 1 /" not in p1)
check("封底无页码", f"行业研究 — {n_pages} /" not in plast)

# ---- 2) 正文页几何（pdfminer 抽 3 页，x0 异常左移 / 出页 bbox） ----
bad_x, bad_bbox = [], 0
picks = {2, max(2, n_pages // 2), n_pages - 1}
for pageno, pl in enumerate(extract_pages(str(PDF_F)), start=1):
    W, H = float(pl.width), float(pl.height)
    for el in pl:
        if isinstance(el, LTTextContainer):
            for ln in el:
                if not hasattr(ln, "bbox"): continue
                x0, y0, x1, y1 = ln.bbox
                if x1 > W + 0.5 or x0 < -0.5 or y1 > H + 0.5 or y0 < -0.5:
                    bad_bbox += 1
                if pageno in picks and x0 < 40 and y0 > 60 and y1 < 800:
                    bad_x.append((pageno, round(x0, 1), getattr(ln, "get_text", lambda: "")()[:16]))
check("正文页无异常左移（x0≥40pt）", not bad_x, bad_x[:3])
check("全文无出页文本 bbox", bad_bbox == 0, bad_bbox)

# ---- 3) 数字一致性抽检（去空白归一后三方比对；md → HTML → PDF） ----
html_text = HTML_F.read_text(encoding="utf-8")
md_src = MD.read_text(encoding="utf-8")
norm = lambda s: re.sub(r"\s+", "", s)
html_n, pdf_n, md_n = norm(html_text), norm(pdf_text), norm(md_src)
anchors = [
    # -- 封面四格 / 卷首总判断 / 方法说明 --
    "21条", "零新数", "15条", "拒绝3条", "参照1条", "前瞻1条",
    "直接采纳4+改造后采纳9+部分采纳1+方向采纳1", "3.38pct", "EVA≥0", "收益率+中收率", "风险成本+3.38pct",
    "458倍杠杆", "-2.85%", "19,111.84亿", "226.6亿",
    # -- 第一章 获客与流量 --
    "+17.27pct", "+1.46pct", "90.26万张", "2,442.61万户", "+1.80%", "326.90万", "13.4%",
    "4,363万张", "+0.71%", "1.43亿张", "0.79万亿元", "1.24亿张", "1.16万亿元",
    "1-2个数量级", "17-39倍", "1.52%",
    # -- 第二章 资产端 --
    "463亿元", "1.01亿元", "458倍", "463÷1.01", "100亿年亏2.85亿", "3,000元", "2026年底",
    "50亿×2.85%", "1.4亿", "1.5%", "+10.93%", "3.68%", "120多万笔", "86万户",
    "297.97亿", "+5.36亿", "3,785.45亿", "7.87%", "2.0%/2.3%", "2.1%/2.7%", "+0.32%",
    "11.3/18.1亿", "226.6亿×5%/8%", "7%", "2.1%-2.7%",
    # -- 第三章 收入结构 --
    "50.12亿元", "16.85%", "10,318.75亿元", "-12.12%", "0.35亿", "-35.2%", "0.2%-0.5pct",
    "1.13亿/年", "226.6亿×0.5%", "269.03亿", "97.76亿", "-6.64%", "-5.43%",
    "+17.27%", "+5.7pct", "104.3%", "-3.5%", "126.31亿元", "7,215.30亿元",
    # -- 第四章 风险与出清 --
    "+3.38pct", "116.45亿", "-4.72亿", "2.57%", "-0.05pct", "-21.09%", "236.98亿",
    "+39.29亿", "1.90%", "3.5%", "2.23%", "-0.01pct", "-0.70%", "4,285.21万户", "-1.9%",
    "-3亿", "+4亿", "7/31", "+8亿", "-9亿", "4.37%",
    # -- 第五章 组织与机制 --
    "3,597人", "15,905.72亿", "-4.24%", "8,088人", "2026-08-24", "2026-11-2524时",
    # -- 第六章 矩阵 / 路线图 --
    "2026Q3", "2026Q4", "2027", "4.0%", "AUM5万", "合规改造前置",
    # -- 局限 / 来源披露 --
    "2.30pct", "1.08pct", "0.78pct", "12条原文复核", "9条与底座一致", "0条待补", "medium",
    "5免2", "半年报p47",
]
miss_md = [a for a in anchors if norm(a) not in md_n]
miss_pdf = [a for a in anchors if norm(a) not in pdf_n]
miss_html = [a for a in anchors if norm(a) not in html_n]
check(f"数字锚点 md 在案 {len(anchors)} 处（≥25）", not miss_md and len(anchors) >= 25, miss_md)
check(f"数字锚点 HTML 全命中 {len(anchors)-len(miss_html)}/{len(anchors)}", not miss_html, miss_html)
check(f"数字锚点 PDF 全命中 {len(anchors)-len(miss_pdf)}/{len(anchors)}", not miss_pdf, miss_pdf)

# ---- 4) 过程词禁例（正文 0 命中；t16 仅封底版本块 1 处） ----
BANNED = ["一一", "Data Analyst", "守门员", "队长", "t13", "t14", "t15", "t17", "评审", "轮次"]
body_html_only = re.sub(r"<style>.*?</style>|<[^>]+>", "", html_text, flags=re.S)
_raw_body, _raw_back = html_text.split('id="backcover"', 1)
body_part = re.sub(r"<style>.*?</style>|<[^>]+>", "", _raw_body, flags=re.S)
back_part = re.sub(r"<[^>]+>", "", _raw_back, flags=re.S)
hit_banned_h = [b for b in BANNED if b in body_part]
hit_banned_p = [b for b in BANNED if b in pdf_text]
check("HTML 过程词 0 命中（正文）", not hit_banned_h, hit_banned_h)
check("PDF 过程词 0 命中", not hit_banned_p, hit_banned_p)
check("t16 仅封底版本块 1 处（正文 0）",
      body_part.count("t16") == 0 and back_part.count("t16") == 1,
      (body_part.count("t16"), back_part.count("t16")))

# ---- 5) 关键版式件在位（PDF 侧按去空白比对） ----
for token, name in [("99wiki ｜ 智见点评 · 行业研究", "品牌行"),
                    ("别人的打法：溯源、机制与本行适配", "封面主标题"),
                    ("研究学习同业打法 · 溯源-迁移框架（2026 中报季）", "封面副标题"),
                    ("打法研究 v1 · 2026-08-30", "封面版本行"),
                    ("行内材料 · 勿外发", "封面角标"),
                    ("不能过线的打法，写得再漂亮也是别人的。", "封面金句"),
                    ("EVA≥0 ⇔ 收益率+中收率 ≥ 风险成本+3.38pct", "封面/封底 UE 门槛"),
                    ("流量是客群的入口，但入口不筛客群", "第一章金句"),
                    ("贴息是客户的甜头，不是银行的 UE", "第二章金句"),
                    ("利息是顺周期的收入，非息是逆周期的缓冲", "第三章金句"),
                    ("出清的终点不是不良率归零", "第四章金句"),
                    ("组织不是成本项，是风险成本的前置开关", "第五章金句"),
                    ("打法全景表（21 条，按章分组）", "卷首全景表"),
                    ("迁移适配矩阵（21 条打法 × Fit × 前提 × 优先级", "第六章矩阵"),
                    ("采纳路线图（挂本行四杠杆节奏", "采纳路线图"),
                    ("没有一条绕过 UE 门槛，没有一条不需要前提", "收口句"),
                    ("点睛图① · 获客漏斗对比条", "点睛图1标题"),
                    ("点睛图② · 贴息杠杆对比条", "点睛图2标题"),
                    ("点睛图③ · 收入结构对比条", "点睛图3标题"),
                    ("点睛图④ · 出清路径对比条", "点睛图4标题"),
                    ("点睛图⑤ · 组织机制时序条", "点睛图5标题"),
                    ("点睛图⑥ · 21 条打法 Fit 泳道概览", "点睛图6（泳道）标题"),
                    ("图注「本行待补」", "图注1（本行待补）"),
                    ("图注「测算」", "图注2（测算）"),
                    ("图注「名义 vs 还原口径差异」", "图注4（口径差异）"),
                    ("图注「时序示意」", "图注5（时序示意）"),
                    ("打法没有好坏，只有恒等式适配与否", "封底金句（总判断）"),
                    ("G3 渲染自检 · t16 快检 PASS + 终修", "封底版本块（t16 快检+终修）"),
                    ("内部经营分析，不构成投资建议；测算/研判推断非官方统计", "封底免责行")]:
    tok_ns = norm(token)
    check("版式件·" + name, tok_ns in pdf_n and token in body_html_only)

# ---- 6) 结构与卫生 ----
for fid in ("fig-funnel", "fig-lever", "fig-income", "fig-clear", "fig-timeline", "fig-lanes"):
    check("点睛图在位 id=" + fid, f'id="{fid}"' in html_text)
check("泳道 6 条（5 泳道 + 参照/前瞻）", html_text.count('class="lane ') == 6)
check("打法卡头 19 条（三段式 seg 各 19）",
      html_text.count('class="play-head"') == 19 and
      html_text.count('>【溯源】</span>') == 19 and
      html_text.count('>【机制】</span>') == 19 and
      html_text.count('>【Fit】</span>') == 19)
check("点睛图建议行 5 处", html_text.count('class="chart-suggest"') == 5)
check("卷首总判断金句块在位", 'blockquote class="grand"' in html_text)
check("无未替换占位符 @x@", not re.search(r"@[a-z]+@", re.sub(r"<style>.*?</style>", "", html_text, flags=re.S)))
check("无外部 CDN/网络资源", not re.search(r'(src|href)="https?://', html_text))
check("无渲染泄漏词（undefined/NaN）", "undefined" not in body_html_only and "NaN" not in body_html_only)

print("\n== %s ==" % ("全部通过" if not fail else f"失败 {len(fail)} 项: {fail}"))
sys.exit(1 if fail else 0)
