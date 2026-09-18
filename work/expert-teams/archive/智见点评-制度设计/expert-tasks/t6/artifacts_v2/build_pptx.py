#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""t6 v2 · 可编辑 PPTX（python-pptx 原生对象 + 全页 speaker notes）
设计：审计账本式纸墨（暖纸 #F1EEE7 / 近白卡 #FDFCF9 / 孔雀青 #10605A / 古金 #9A6B22）
纪律：全部为原生形状·原生表格·原生文本（可在 PowerPoint 直接编辑）；
      数字带口径；预测标「研判推断」；每页写 speaker notes。
"""
import pathlib
from pptx import Presentation
from pptx.util import Inches as In, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.oxml.ns import qn

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "ppt" / "收储用途扩围与平台机会_正式稿.pptx"

# ---------- palette ----------
PAPER = RGBColor(0xF1, 0xEE, 0xE7); CARD = RGBColor(0xFD, 0xFC, 0xF9)
PEACOCK = RGBColor(0x10, 0x60, 0x5A); PEACOCK_D = RGBColor(0x0B, 0x4A, 0x45)
PEACOCK_S = RGBColor(0xE2, 0xED, 0xEA)
GOLD = RGBColor(0x9A, 0x6B, 0x22); GOLD_INK = RGBColor(0x7E, 0x56, 0x18); GOLD_S = RGBColor(0xF0, 0xE6, 0xD3)
INK1 = RGBColor(0x1A, 0x17, 0x14); INK2 = RGBColor(0x44, 0x3E, 0x37); INK3 = RGBColor(0x6B, 0x64, 0x59)
WARN = RGBColor(0x8A, 0x3A, 0x26); WARN_S = RGBColor(0xF2, 0xE2, 0xDC)
RECESS = RGBColor(0xEA, 0xE6, 0xDE); ON_P = RGBColor(0xF2, 0xF7, 0xF5)
SERIF = "Noto Serif CJK SC"; SANS = "Noto Sans CJK SC"; MONO = "Noto Sans Mono CJK SC"

W, H = 13.333, 7.5
M = 0.62            # side margin
prs = Presentation()
prs.slide_width = In(W); prs.slide_height = In(H)
BLANK = prs.slide_layouts[6]


# ---------- helpers ----------
def ea(run, face):
    """set east-asian typeface so CJK renders in the intended family"""
    rPr = run._r.get_or_add_rPr()
    for tag in ("a:ea", "a:cs"):
        el = rPr.find(qn(tag))
        if el is None:
            el = rPr.makeelement(qn(tag), {}); rPr.append(el)
        el.set("typeface", face)


def sld(bg=PAPER):
    s = prs.slides.add_slide(BLANK)
    s.background.fill.solid(); s.background.fill.fore_color.rgb = bg
    return s


def tb(s, l, t, w, h, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, wrap=True):
    box = s.shapes.add_textbox(In(l), In(t), In(w), In(h))
    tf = box.text_frame; tf.word_wrap = wrap; tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.paragraphs[0].alignment = align
    return tf


def para(tf, text, size=12, color=INK2, bold=False, font=SANS, first=False,
         space_before=0, space_after=4, line=1.35, align=None):
    p = tf.paragraphs[0] if first else tf.add_paragraph()
    p.space_before = Pt(space_before); p.space_after = Pt(space_after)
    p.line_spacing = line
    if align is not None:
        p.alignment = align
    r = p.add_run(); r.text = text
    r.font.size = Pt(size); r.font.bold = bold; r.font.color.rgb = color; r.font.name = font
    ea(r, font)
    return p


def rect(s, l, t, w, h, fill=CARD, line=None, lw=0.75):
    from pptx.enum.shapes import MSO_SHAPE
    sh = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, In(l), In(t), In(w), In(h))
    sh.adjustments[0] = 0.04
    sh.fill.solid(); sh.fill.fore_color.rgb = fill
    if line is None:
        sh.line.fill.background()
    else:
        sh.line.color.rgb = line; sh.line.width = Pt(lw)
    sh.shadow.inherit = False
    sh.text_frame.word_wrap = True
    return sh


def head(s, kicker, title, sub=None, y=0.42):
    """账册章头：孔雀青 kicker + 衬线标题 + 古金双线"""
    tf = tb(s, M, y, W - 2 * M, 0.34)
    para(tf, kicker, size=10.5, color=GOLD_INK, bold=True, font=MONO, first=True, space_after=0)
    tf2 = tb(s, M, y + 0.32, W - 2 * M, 0.62)
    para(tf2, title, size=23, color=INK1, bold=True, font=SERIF, first=True, space_after=0, line=1.15)
    y2 = y + 0.32 + 0.62
    if sub:
        tf3 = tb(s, M, y2, W - 2 * M, 0.34)
        para(tf3, sub, size=11, color=INK3, first=True, space_after=0, line=1.3)
        y2 += 0.34
    ln = s.shapes.add_shape(1, In(M), In(y2 + 0.04), In(W - 2 * M), Pt(2.4))
    ln.fill.solid(); ln.fill.fore_color.rgb = GOLD; ln.line.fill.background(); ln.shadow.inherit = False
    return y2 + 0.26


def notes(s, text):
    s.notes_slide.notes_text_frame.text = text


def footnote(s, text, y=None):
    y = y if y is not None else H - 0.62
    tf = tb(s, M, y, W - 2 * M, 0.34)
    para(tf, text, size=9.5, color=INK3, first=True, space_after=0, line=1.35)


def numcards(s, items, y, h=1.5, gap=0.22):
    n = len(items); w = (W - 2 * M - gap * (n - 1)) / n
    for i, (big, unit, lbl, src) in enumerate(items):
        l = M + i * (w + gap)
        rect(s, l, y, w, h, CARD, line=RGBColor(0xD8, 0xD2, 0xC6))
        tf = tb(s, l + 0.18, y + 0.14, w - 0.36, 0.5)
        p = tf.paragraphs[0]
        r = p.add_run(); r.text = big; r.font.size = Pt(24); r.font.bold = True
        r.font.color.rgb = PEACOCK; r.font.name = MONO; ea(r, MONO)
        if unit:
            r2 = p.add_run(); r2.text = unit; r2.font.size = Pt(13); r2.font.color.rgb = INK2
            r2.font.name = SANS; ea(r2, SANS)
        tf2 = tb(s, l + 0.18, y + 0.62, w - 0.36, 0.34)
        para(tf2, lbl, size=11.5, color=INK1, bold=True, first=True, space_after=0, line=1.25)
        tf3 = tb(s, l + 0.18, y + 0.96, w - 0.36, h - 1.0)
        para(tf3, src, size=9, color=INK3, first=True, space_after=0, line=1.35)


def bullets(s, items, y, size=13, w=None, gap=0.30, color=INK2):
    w = w or (W - 2 * M)
    tf = tb(s, M, y, w, 0.4)
    for i, it in enumerate(items):
        para(tf, it, size=size, color=color, first=(i == 0), space_after=int(gap * 10), line=1.42)


def table(s, cols, rows, y, colw=None, rowh=0.42, hdrsz=10.5, bodysz=9.5, first_bold=True):
    """原生 pptx 表格（可编辑）"""
    nr, nc = len(rows) + 1, len(cols)
    tw = W - 2 * M
    shp = s.shapes.add_table(nr, nc, In(M), In(y), In(tw), In(rowh * nr))
    t = shp.table
    t.first_row = True; t.horz_banding = False
    if colw:
        tot = sum(colw)
        for i, cw in enumerate(colw):
            t.columns[i].width = Emu(int(In(tw) * cw / tot))
    def cell(txt, r, c, head=False):
        cl = t.cell(r, c); cl.text = ""
        cl.margin_left = In(0.06); cl.margin_right = In(0.05)
        cl.margin_top = In(0.03); cl.margin_bottom = In(0.03)
        cl.vertical_anchor = MSO_ANCHOR.TOP
        cl.fill.solid()
        cl.fill.fore_color.rgb = PEACOCK_S if head else (CARD if r % 2 else RGBColor(0xF7, 0xF5, 0xEF))
        tf = cl.text_frame; tf.word_wrap = True
        p = tf.paragraphs[0]; p.line_spacing = 1.3; p.space_after = Pt(0)
        r_ = p.add_run(); r_.text = str(txt)
        r_.font.size = Pt(hdrsz if head else bodysz)
        r_.font.bold = head or (first_bold and c == 0)
        r_.font.color.rgb = PEACOCK_D if head else (INK1 if (first_bold and c == 0) else INK2)
        r_.font.name = SANS; ea(r_, SANS)
    for c, h in enumerate(cols):
        cell(h, 0, c, head=True)
    for ri, row in enumerate(rows, start=1):
        for ci, v in enumerate(row):
            cell(v, ri, ci)
    return y + rowh * nr + 0.18


# ================= slides =================
# ---- 1 cover ----
s = sld(PEACOCK_D)
rect(s, 0, 0, W, 2.42, PEACOCK_D)
tf = tb(s, M, 1.02, W - 2 * M, 0.34)
para(tf, "98wiki ｜ 智见点评 · 制度设计", size=11, color=RGBColor(0xA9, 0xCF, 0xC8), bold=True,
     font=SANS, first=True, space_after=0)
tf = tb(s, M, 1.44, W - 2 * M, 1.5)
para(tf, "收储用途扩围与平台机会", size=40, color=ON_P, bold=True, font=SERIF, first=True,
     space_after=6, line=1.1)
para(tf, "制度机制的识别与检验：从个案化处置走向年度化准公共采购", size=16,
     color=RGBColor(0xC9, 0xE1, 0xDB), font=SERIF, space_after=0, line=1.35)
tf = tb(s, M, 3.05, W - 2 * M, 0.34)
para(tf, "正式稿 ｜ 证据窗 2025-09 — 2026-09 ｜ 全国（郑州、上海、杭州、武汉、深圳案例对比）",
     size=11.5, color=INK3, first=True, space_after=0)
rect(s, M, 3.62, W - 2 * M, 1.16, CARD, line=GOLD, lw=1.0)
tf = tb(s, M + 0.22, 3.80, W - 2 * M - 0.44, 0.9, anchor=MSO_ANCHOR.TOP)
para(tf, "用途扩围扩大的是需求池的口径，没有触动负carry、区位错配、改造合规这三项真实交易成本；"
         "退出不通时，收储会从准公共采购退化为准公共持有。", size=15, color=INK1, font=SERIF,
     first=True, space_after=0, line=1.5)
numcards(s, [("约50%", "", "保租房占收购用途", "中房网 2026-05-20；公开案例归纳，非统一统计"),
             ("551", "套", "上海三试点区累计收房", "应作全国上限锚点，不作起步基数"),
             ("5.336", "亿元", "深圳大学拟购楼作宿舍", "腾讯新闻 2026-09-09；高校自主采购"),
             ("4", "项", "评分卡一票否决", "区位·现金流·合规产权·退出可及性")],
         5.06, 1.42)
footnote(s, "行业研究，不构成投资建议；测算、估算与研判推断均非官方统计。")
notes(s, "开场：这份报告不讨论收储该不该做，而是判断它现在是什么、缺什么。核心一句话——用途扩围解决的是"
         "需求池口径，不是制度成型；退出没打通，收储就会从准公共采购变成准公共持有。右上四个数字分别对应"
         "结构、转化、买方与工具，口径都在数字下方标注。")

# ---- 2 legend + 四级标注 ----
s = sld(); y = head(s, "LEGEND ／ 标注体系", "全篇数字四级标注（版式一致）",
                    "原文每个数字均落到一级；角标色块与正文一致，不做二次改写")
items = [("引用", "来源明确，以原文口径为准", PEACOCK_S, PEACOCK),
         ("测算", "依据在案数据推算", GOLD_S, GOLD_INK),
         ("估算", "量级推断，区间口径", GOLD_S, GOLD_INK),
         ("研判推断", "无直接数据支撑的方向判断", RECESS, INK2),
         ("待补", "需官方文件或授权数据核验", WARN_S, WARN)]
cw = (W - 2 * M - 0.16 * 4) / 5
for i, (name, desc, bg, fg) in enumerate(items):
    l = M + i * (cw + 0.16)
    rect(s, l, y, cw, 1.55, CARD, line=RGBColor(0xD8, 0xD2, 0xC6))
    ch = rect(s, l + 0.16, y + 0.16, 0.86, 0.30, bg); ch.text_frame.text = ""
    tf = ch.text_frame; para(tf, name, size=10, color=fg, bold=True, first=True, space_after=0,
                             align=PP_ALIGN.CENTER)
    tf2 = tb(s, l + 0.16, y + 0.60, cw - 0.32, 0.85)
    para(tf2, desc, size=10, color=INK2, first=True, space_after=0, line=1.4)
tf = tb(s, M, y + 1.85, W - 2 * M, 1.6)
para(tf, "本稿标注分布（源文本实测）", size=12, color=INK1, bold=True, first=True, space_after=6)
para(tf, "【研判推断】54 处 ｜ 【引用】11 处（含口径限定，如「案例归纳非统一统计」）｜【测算】3 处 ｜【待补】2 处",
     size=11.5, color=INK2, space_after=6, line=1.45)
para(tf, "说明：【估算】在本稿源文本中未出现（0 处），此处保留其版式定义，以保证四级体系完整、跨稿一致。",
     size=10.5, color=INK3, space_after=0, line=1.45)
notes(s, "先讲标注纪律。四级的意义是让读者一眼分辨哪些是原文口径、哪些是推算、哪些只是方向判断。"
         "本稿【研判推断】占绝大多数，说明这是一份以制度判断为主的报告；硬数字很少且都带限定。"
         "特别说明【估算】在本文没有出现，但版式保留，保证与其他报告一致。")

# ---- 3 关键性结论 ----
s = sld(); y = head(s, "第一章 ／ 关键性结论", "主基调：转向准公共采购，但未跨过制度化门槛",
                    "对「年度化准公共采购已形成」予以证伪：现状是点状案例加价格型工具，不是采购制度")
rect(s, M, y, W - 2 * M, 0.86, PEACOCK_S, line=PEACOCK)
tf = tb(s, M + 0.24, y + 0.14, W - 2 * M - 0.48, 0.62)
para(tf, "收储在当期是止跌工具，不是回稳引擎：能压缩挂牌量、托住尾部成交价，创造不出新增有效需求。",
     size=15, color=PEACOCK_D, font=SERIF, bold=True, first=True, space_after=0, line=1.4)
bullets(s, ["用途扩围等于需求池扩容，不等于制度成型；三个卡点一处未动。",
            "制度判断落在三处机制缺口：政策边界未回答三问；缺可检验阈值；退出是最大缺口。",
            "平台的位置由此确定：不替政府持有资产，只提供可审计的筛选、估值、改造适配与运营数据。"], y + 1.12)
footnote(s, "标注体系：引用 / 测算 / 估算 / 研判推断 / 待补")
notes(s, "本章结论先行。第一句就把身份定死——止跌工具而非回稳引擎。三处缺口按严重度递进：前两处是"
         "可补的规则空白，第三处决定天花板。最后落到平台自身的位置，为第五章的责任边界做铺垫。")

# ---- 4 三处缺口 ----
s = sld(); y = head(s, "第一章 ／ 关键性结论", "三处机制缺口决定制度天花板",
                    "共同点：都不是资金问题，而是规则问题")
cards = [("缺口一", "政策边界未回答「谁来收、收什么、做什么」",
          "授权对象、房源边界、用途决定权都还停在地方探索层面，没有形成可复制的规则。【研判推断】"),
         ("缺口二", "缺可检验的判别阈值",
          "年度化采购与个案化处置之间没有判别标准，无法用一套阈值判断某个项目是否已制度化。【研判推断】"),
         ("缺口三", "退出是最大缺口",
          "退出不通时，收储会从准公共采购退化为准公共持有，资产负债表压力由开发商转到地方国企。【研判推断】")]
cw = (W - 2 * M - 0.24 * 2) / 3
for i, (no, t, d) in enumerate(cards):
    l = M + i * (cw + 0.24)
    rect(s, l, y, cw, 2.5, CARD, line=RGBColor(0xD8, 0xD2, 0xC6))
    tf = tb(s, l + 0.2, y + 0.18, cw - 0.4, 0.3)
    para(tf, no, size=10.5, color=GOLD_INK, bold=True, font=MONO, first=True, space_after=0)
    tf = tb(s, l + 0.2, y + 0.50, cw - 0.4, 0.7)
    para(tf, t, size=14, color=INK1, bold=True, font=SERIF, first=True, space_after=0, line=1.3)
    tf = tb(s, l + 0.2, y + 1.22, cw - 0.4, 1.15)
    para(tf, d, size=10.5, color=INK2, first=True, space_after=0, line=1.5)
notes(s, "三处缺口。讲法：缺口一、二是「规则空白」，可以补；缺口三是「结构缺位」，不补就没有天花板。"
         "一句话收口——钱已经到位了，缺的是规则和退出。")

# ---- 5 制度机制 ----
s = sld(); y = head(s, "第二章 ／ 关键事实及其变化", "制度机制：政策边界里的三问",
                    "授权链是地方授权加中央资金支持，不是全国统一授权，规则只能逐城形成")
y = table(s, ["机制问题", "当期答案", "标注"],
          [["谁来收", "地方政府指定的国有企业；承接保障性住房再贷款的政策性住房收购主体", "引用"],
           ["谁来收（边界）", "高校、医院以自有预算采购，属需求端机构购买方，不属政策性收储主体", "研判推断"],
           ["收什么", "存量商品房中的现房或准现房，须满足区位可用、权属清晰、消防结构合规、用途变更可行", "研判推断"],
           ["做的顺序", "先定使用对象、再定房源；不是先收房再找用途", "研判推断"],
           ["做什么", "保租房、人才房与青年公寓、高校宿舍、医院与养老配套四类", "引用·案例归纳"],
           ["三道审批", "用途变更、消防验收、结构安全；多数城市尚无标准路径", "研判推断"]],
          y, colw=[1.5, 6.6, 1.1], rowh=0.62)
footnote(s, "来源：中国现行政策边界与公开案例归纳；三道审批是新增用途的主要隐性成本。")
notes(s, "制度机制的底图。重点讲授权链形态——地方授权加中央资金，所以规则只能逐城形成、复制成本高。"
         "三道审批是新增用途的主要隐性成本，为后面「改造合规是确定性成本」埋线。")

# ---- 6 用途口径外扩 ----
s = sld(); y = head(s, "第二章 ／ 关键事实及其变化", "用途口径外扩：是案例结构示意，不是统计口径",
                    "三个比例只有分子、没有分母；不可加总为全国结构，不可推算全国规模")
bars = [("保租房", "约50%", 1.00), ("人才房·青年公寓", "约20%", 0.40), ("学生宿舍等新用途", "约5%", 0.10)]
bw = W - 2 * M - 2.05 - 1.05   # leave room for the value label inside the margin
for i, (name, val, ratio) in enumerate(bars):
    l = M
    yy = y + i * 0.85
    tf = tb(s, l, yy + 0.06, 2.0, 0.34)
    para(tf, name, size=12, color=INK1, bold=True, first=True, space_after=0)
    rect(s, l + 2.05, yy, bw, 0.46, RGBColor(0xEA, 0xE6, 0xDE))
    rect(s, l + 2.05, yy, max(bw * ratio, 0.12), 0.46, PEACOCK if i < 2 else GOLD)
    tf = tb(s, l + 2.05 + bw + 0.10, yy + 0.06, 0.95, 0.34)
    para(tf, val, size=13, color=INK1, bold=True, font=MONO, first=True, space_after=0)
tf = tb(s, M, y + 2.72, W - 2 * M, 0.9)
para(tf, "可用的部分是方向——新用途从无到有。任何据此推算全国收储规模的测算，都属于把案例当统计量用；"
         "分城市用途构成亦不可由此推导。【研判推断】", size=12.5, color=INK2, first=True, space_after=0, line=1.5)
footnote(s, "来源：中房网 2026-05-20（存量房收购两周年公开案例归纳）｜非统一统计口径｜上方条长为示意，非精确比例尺")
notes(s, "这页的核心是不要把这个图当统计看。三个比例来自公开案例归纳，只有分子没有分母。"
         "能用的只有方向性结论：新用途从无到有。条长是示意，不是精确比例尺。")

# ---- 7 买方结构变化 ----
s = sld(); y = head(s, "第二章 ／ 关键事实及其变化", "买方结构变化：高校以机构购买方身份进场",
                    "它证明床位需求真实、需求方扩展到事业单位；不能证明收储的年度化采购制度已形成")
numcards(s, [("5.336", "亿元", "深圳大学拟购楼作宿舍", "腾讯新闻 2026-09-09 披露金额口径"),
             ("2.25", "万㎡", "采购意向建筑面积（不低于）", "采购意向披露口径"),
             ("1500", "人", "可满足居住人数（至少）", "采购意向披露口径"),
             ("8", "公里", "距两校区直线距离（原则）", "采购意向披露口径")],
         y, 1.42)
bullets(s, ["另一路采购意向口径预算约 5.3 亿元、须整栋购置；两种口径存在表述差异，以最终公告为准。",
            "单床购置成本约 35.6 万元（5.336 亿元 ÷ 1500 床）【测算】；单位面积购置成本约 0.24 万元／平方米【测算】。",
            "这是高校自主采购：走学校基建与教育预算、定价走市场评估，与政府收储的资金来源、定价机制、退出安排完全不同。【研判推断】"],
        y + 1.72)
footnote(s, "床位与单套折算待补；把机构采购计入收储制度，会系统性高估制度成熟度。")
notes(s, "防止一个误读：把高校采购当成收储制度成型的证据。两者资金来源、定价机制、退出安排完全不同。"
         "真正有价值的信号有两个——床位需求真实，以及需求方可以自主选址；后者恰恰是收储主体没有的自由度。"
         "两个测算值都是按采购意向口径算的，标注为测算。")

# ---- 8 三条线 ----
s = sld(); y = head(s, "第二章 ／ 关键事实及其变化", "三条线不同步：资金端先行、采购制度化最慢",
                    "错配解释了为什么钱到位了、量却没起来")
y = table(s, ["线索", "当期状态", "证据", "标注"],
          [["资金端", "已落地，融资成本一侧明显下移", "中国人民银行2025-01-02优化保障性住房再贷款要求，调整支持比例（具体比例待补）", "引用＋待补"],
           ["政策端", "停留在方向与年度安排", "2026-03-05政府工作报告「盘活存量商品房」方向；2026-04-30深圳市住建局2026住房发展年度计划", "引用"],
           ["采购端", "尚未成型：无需求清单、无准入标准、无预算科目、无退出通道四项前置模块", "一线城市二手房收储案例与政策梳理（新浪财经2026-05-26）", "研判推断"]],
          y, colw=[1.0, 3.4, 4.8, 1.2], rowh=0.75)
footnote(s, "来源：中国人民银行 2025-01-02 / 中国政府网 2026-03-05 / 深圳市住建局 2026-04-30 / 新浪财经 2026-05-26")
notes(s, "三条线的节奏错配。资金端已经先动，政策和采购端没跟上。这个错配是当期最值得记的制度特征，"
         "也直接解释了「融资成本降了但收购量没起来」这个现象。")

# ---- 9 上海551套 ----
s = sld(); y = head(s, "第二章 ／ 关键事实及其变化", "上海551套：应作上限锚点，不是起步基数",
                    "最齐备的城市、一个窗口期；决定转化效率的不是资格名单长度，而是旧房处置与承接能力")
numcards(s, [("551", "套", "徐汇、浦东、静安三试点区累计收房", "2026-02 启动；试点报道口径"),
             ("2", "本账", "政策性账与商业性账无法并表", "吴晓波频道／新浪财经 2026-08-20 报道口径")],
         y, 1.55)
bullets(s, ["上海是全国资金、房源、需求三要素最齐备的城市；一个窗口期只有 551 套。【研判推断】",
            "该数字应作全国上限锚点使用，不能当作起步基数——用它反推全国总量，等于把最优城市的天花板当平均值。【研判推断】"],
        y + 1.85)
footnote(s, "「两本账」是本页新增的机构事实：政策性账与商业性账无法并表，直接影响可审计性。")
notes(s, "551 这个数字最容易用错：它是最优城市的单窗口成绩，是天花板不是起点。"
         "另外补充一个新事实——收储存在「两本账」，政策性账与商业性账无法并表，这直接影响后文讲的"
         "可审计性和第三方付费空间。")

# ---- 10 买断式修复 + 五城口径 ----
s = sld(); y = head(s, "第二章 ／ 关键事实及其变化", "补充事实与五城对照口径",
                    "收储重定义为对「卖旧买新」断裂处的买断式修复")
rect(s, M, y, W - 2 * M, 1.0, PEACOCK_S, line=PEACOCK)
tf = tb(s, M + 0.24, y + 0.16, W - 2 * M - 0.48, 0.72)
para(tf, "资格名单给的是购买权，成交取决于旧房能否处置。收储的真实作用在于给置换链条断裂处做一次买断式修复："
         "国企出钱收旧房，居民完成换新。这一定性把考核口径从「收购套数」拉回「循环是否修复」。【研判推断】",
     size=12.5, color=PEACOCK_D, first=True, space_after=0, line=1.5)
y2 = y + 1.24
tf = tb(s, M, y2, W - 2 * M, 0.34)
para(tf, "五城对照的口径", size=14, color=INK1, bold=True, font=SERIF, first=True, space_after=0)
table(s, ["城市", "暴露的问题", "观测口径"],
      [["上海", "转化瓶颈", "收房套数"],
       ["深圳", "买方多元化", "机构采购"],
       ["郑州／杭州／武汉", "分城市用途构成与收购决算数据暂缺", "清单是否公开、采购数量是否入预算、运营数据是否披露"]],
      y2 + 0.40, colw=[2.0, 4.4, 4.6], rowh=0.56)
footnote(s, "三城可比观测口径统一为三项：清单是否公开、数量是否入预算、运营数据是否披露。【研判推断】")
notes(s, "两个补充事实。第一，收储的真实作用是买断式修复，不是替新房去库存；这把考核口径从套数拉回循环。"
         "第二，五城对照：上海的瓶颈是转化、深圳是买方结构，另外三城数据暂缺，所以给出统一的可比观测口径。")

# ---- 11 归因 1-3 ----
s = sld(); y = head(s, "第三章 ／ 归因分析", "负carry、区位错配、改造合规：三处都是结构性的")
items = [("其一", "负carry 是结构性的，运营补不上",
          "保租房锚市场租金折价、人才房锚政策可承受价、高校宿舍锚学校付费能力，三类租金锚都低于改造后的"
          "综合资金成本，差额只能由财政或国企承担。核算口径：单位年净现金流＝租金×出租率−维护费−改造年摊，"
          "与同口径资金成本比较，为负即负carry项目。【研判推断】"),
         ("其二", "区位错配是结构性的，不是操作失误",
          "可收购房源集中在供给过剩的外围板块与商办尾盘，真实需求集中在主城就业带与校区周边，两个分布"
          "空间上天然不重合。高校那单之所以可能成立，正因需求方可以自主选址；收储主体没有这个自由度。【研判推断】"),
         ("其三", "改造合规是确定性成本，且新增用途两端最重",
          "学生宿舍涉及床位密度与消防分区，医疗养老涉及结构与合规，两类恰是改造强度最高的两端；"
          "非标房源越多，规模效应越被摊薄。消防能否通过，是运营侧最大的不确定性成本项。【研判推断】")]
ch = 1.72
for i, (no, t, d) in enumerate(items):
    yy = y + i * (ch + 0.14)
    rect(s, M, yy, W - 2 * M, ch, CARD, line=RGBColor(0xD8, 0xD2, 0xC6))
    tf = tb(s, M + 0.22, yy + 0.14, 1.1, 0.34)
    para(tf, no, size=11, color=GOLD_INK, bold=True, font=MONO, first=True, space_after=0)
    tf = tb(s, M + 1.35, yy + 0.12, W - 2 * M - 1.6, 0.36)
    para(tf, t, size=14, color=INK1, bold=True, font=SERIF, first=True, space_after=0)
    tf = tb(s, M + 1.35, yy + 0.52, W - 2 * M - 1.6, ch - 0.62)
    para(tf, d, size=10.5, color=INK2, first=True, space_after=0, line=1.5)
footnote(s, "三条共同点：都不是执行力问题，而是结构与规则问题。")
notes(s, "归因前三条。负carry那条把核算公式念出来，强调它是口径不是估算；核心是「结构性」——"
         "不是运营做得不好，是租金锚本身就低于资金成本。区位错配用高校自主选址做对照讲最直观。"
         "改造合规强调「确定性成本」：不是风险，是必然要花的钱。")

# ---- 12 归因 4-6 ----
s = sld(); y = head(s, "第三章 ／ 归因分析", "顺序倒置、退出缺位、补贴性质：后三条")
cards = [("其四", "筛选顺序倒置是执行层通病",
          "正确顺序是预租锁定、改造合规预审、现金流模型、估值、融资；现实往往先把收购量定下来再补前四项。"
          "顺序一倒置，考核必然落到收购套数。【研判推断】"),
         ("其五", "退出端缺位决定天花板，且三路径互斥",
          "REITs 在低租金、长回收期资产上并非普遍可行；整售依赖市场景气；划转与长期自持不产生现金回流。"
          "三条路径各有成立条件，不能同时承诺。【研判推断】"),
         ("其六", "补贴性质要区分",
          "制度性补贴是对民生任务的预算化安排，有科目、有额度、可跨年；运营性依赖是现金流为负后被动挂账，"
          "越滚越大。判别标准是补贴是否进预算科目、是否与项目一一对应。【研判推断】")]
cw = (W - 2 * M - 0.24 * 2) / 3
for i, (no, t, d) in enumerate(cards):
    l = M + i * (cw + 0.24)
    rect(s, l, y, cw, 3.0, CARD, line=RGBColor(0xD8, 0xD2, 0xC6))
    tf = tb(s, l + 0.2, y + 0.18, cw - 0.4, 0.3)
    para(tf, no, size=10.5, color=GOLD_INK, bold=True, font=MONO, first=True, space_after=0)
    tf = tb(s, l + 0.2, y + 0.50, cw - 0.4, 0.75)
    para(tf, t, size=13.5, color=INK1, bold=True, font=SERIF, first=True, space_after=0, line=1.3)
    tf = tb(s, l + 0.2, y + 1.28, cw - 0.4, 1.6)
    para(tf, d, size=10.5, color=INK2, first=True, space_after=0, line=1.5)
footnote(s, "顺序倒置是最容易改也最容易被忽略的一条：考核一旦落在套数上，其余四项就没人负责了。")
notes(s, "归因后三条打包讲。顺序倒置最可操作——先定量的结果就是其他四项让位。退出那条强调互斥："
         "不能同时承诺三条路径。补贴那条给出一个很实用的判别标准：看有没有进预算科目、有没有跟项目一一对应。")

# ---- 13 四项阈值 ----
s = sld(); y = head(s, "第三章 ／ 归因分析", "四项判别阈值：当期均未打勾",
                    "四项须同时成立，缺一项即判定为个案化处置")
y = table(s, ["阈值", "年度化采购的判据", "个案化处置的征象", "当期状态"],
          [["需求清单年度化", "上年末形成经财政与住建联审的年度需求清单，含套数、区位、户型、租金区间", "逐单临时立项、逐单定价", "未见公开清单"],
           ["定价用规则不用谈判", "同区位同品质有评估价区间与统一折扣基准", "每单单独过会定价", "多数项目仍逐单定价"],
           ["成本可跨年消化", "缺口由租金提升、运营降本或政策性资金成本覆盖", "缺口由财政补贴或国企利润逐年填补", "缺口主要靠补贴填补"],
           ["退出有预设通道", "立项即明确退出方式与持有主体", "立项不涉退出安排", "退出通道普遍缺位"]],
          y, colw=[1.7, 4.5, 2.6, 2.0], rowh=0.86)
footnote(s, "当期四项均未打勾，故判定为「个案化处置延续」。四项状态判断均为【研判推断】。")
notes(s, "全篇的判别工具。四个阈值是门槛制不是打分制，必须同时成立。念法就是一项一项对，"
         "当前四项全空——这就是「现状是个案化处置」的判定依据。")

# ---- 14 红队 ----
s = sld(); y = head(s, "第四章 ／ 红队独立复核", "四条预判逐条检验：全部成立",
                    "四条成立意味着本稿主张必须相应收窄：只主张制度要件可识别、可检验")
rows = [["预判一", "50%／20%／5% 不能当官方总体", "成立，降级为案例结构示意", "该组数字来自公开案例归纳、非统一统计，只有分子没有分母。"],
        ["预判二", "深圳大学 5.336 亿元不能作收储制度化证据", "成立", "该采购走教育预算与市场定价，计入收储会系统性高估制度成熟度。"],
        ["预判三", "点状案例不证制度化", "成立", "高校宿舍、医院与养老改造仍属单一标的自主决策，无法证明年度采购制度已形成。"],
        ["预判四", "REITs 退出并非普遍可行", "成立", "低租金、长回收期资产难满足现金流稳定性要求；宜作筛选标准，不宜作立项承诺。"]]
table(s, ["编号", "原预判", "复核结论", "要点"], rows, y, colw=[0.9, 3.6, 2.2, 5.3], rowh=0.86)
footnote(s, "红队节的作用是自证边界：本稿不主张制度已建立，只主张制度要件已可被识别和检验。")
notes(s, "红队节。四条预判全部成立，意味着本稿的主张必须相应收窄。语气要干脆——这是纪律不是谦虚。"
         "对外讲的时候可以直接说：我们把自己最强的反方论点先验了一遍。")

# ---- 15-16 用途—现金流矩阵（拆两页，宽表分列）----
s = sld(); y = head(s, "第五章 ／ 收尾", "用途—现金流矩阵（一）：需求与租金锚",
                    "用途是资本结构的选择变量：租金锚决定收入，改造强度决定成本，退出主线决定定价方式")
table(s, ["用途", "需求确定性", "租金锚（收入来源）", "租期与收入稳定性", "改造强度"],
      [["保租房", "高（轮候制、准入线）", "市场租金折价，偏低", "中高，长租为主", "中"],
       ["人才房·青年公寓", "中高（产业政策驱动）", "政策性可承受价，中", "中，3—5年租期", "低—中"],
       ["安置房", "高（征迁刚性需求）", "征迁补偿与安置标准", "高，计划驱动", "低"],
       ["高校宿舍", "高（刚性床位）", "学校付费，稳但低", "很高，长期", "中高（床位密度、消防）"],
       ["医疗·养老", "中（专业需求）", "专业服务收费，高", "高，长期服务合约", "高（结构与合规）"]],
      y, colw=[2.3, 2.6, 2.7, 2.4, 2.4], rowh=0.66)
footnote(s, "占比口径为案例归纳；分城市数据与绝对量待补。（二）见下页：适配资本、退出主线、主要风险与数据标注")
notes(s, "矩阵第一页。讲法：用途不是一个「要收什么房」的问题，而是资本结构选择。本页给需求端与成本端"
         "最关键的四个变量。窄表拆两页是为了在 16:9 上保持可读，两页合起来才是完整矩阵。")

s = sld(); y = head(s, "第五章 ／ 收尾", "用途—现金流矩阵（二）：资本、退出与风险",
                    "无退出通道的用途不得以退出溢价折让收购价，只能按长期自持的现金流定价")
table(s, ["用途", "适配资本", "退出主线", "主要风险", "数据标注"],
      [["保租房", "再贷款、专项债", "REITs（个案，非普遍）／长期自持", "负carry、财政依赖", "占比＝案例归纳；租金折价率待补"],
       ["人才房·青年公寓", "国企＋政策性贷款", "整售／自持", "产业波动带动需求波动", "占比＝案例归纳；分城市数据待补"],
       ["安置房", "财政＋城投", "划转／自持", "与征迁进度绑定、跨期错配", "结构＝研判推断；绝对量待补"],
       ["高校宿舍", "学校自有资金、教育专项", "无二级市场退出", "点状、非标、审批周期长", "深圳案例金额在案；床位待补"],
       ["医疗·养老", "财政／国企", "无标准退出通道", "改造合规成本最高、消防不确定性最大", "均为点状案例；分项待补"]],
      y, colw=[2.1, 2.4, 3.0, 2.6, 3.1], rowh=0.66)
footnote(s, "三条使用规则：租金锚低于资金成本的用途，规模扩张须同步锁定补贴来源；改造强度高的用途只能逐单审批；"
            "无退出通道的用途只能按长期自持现金流定价。【研判推断】")
notes(s, "矩阵第二页，也是全篇最有操作价值的一页。三条使用规则逐条念，尤其最后一条——"
         "没有退出通道就只能按长期自持定价。数据标注列说明每一行的口径成色，可以逐行追问。")

# ---- 17 评分卡 ----
s = sld(); y = head(s, "第五章 ／ 收尾", "房源准入评分卡：四项一票否决",
                    "一票否决优先于总分排序：评分卡的功能是筛掉不可行项目，不是在同一批次内排序")
table(s, ["维度", "观测变量", "判据方向", "一票否决"],
      [["区位与需求匹配", "房源落在真实用工与就学半径内的轮候需求覆盖度", "越高越好", "是（错配即否决）"],
       ["现金流", "单位年净现金流＝租金×出租率−维护−改造年摊，与同口径资金成本比较", "不低于融资成本方可入池", "是（低于融资成本即否决）"],
       ["合规与产权", "消防与结构可否通过、用途变更路径、抵押查封与分割登记状态", "全部可清", "是（不合规或产权瑕疵即否决）"],
       ["退出可及性", "是否存在可执行退出路径或明确长期持有主体", "二者至少有其一", "是（皆无即否决）"],
       ["改造经济性", "单套改造造价、工期、非标项占比", "越低越好", "否（超阈值降级）"],
       ["规模效率", "单项目套数是否达到运营团队经济性下限", "越高越好", "否（低于下限降级）"],
       ["运营数据可得性", "空置率、运营费率、维修更新数据可否采集与审计", "可得则加分", "否"]],
      y, colw=[2.0, 5.4, 2.3, 2.3], rowh=0.60, bodysz=9)
footnote(s, "使用纪律：每套评分留痕可复核，否则年度化无法审计。【研判推断】")
notes(s, "评分卡。关键在「一票否决优先于总分排序」——这是个筛子不是排行榜。前四项任何一项不过直接出局，"
         "后三项只是降级。这样设计是为了避免用总分把不可行项目算成可行。")

# ---- 18 退出谱系 ----
s = sld(); y = head(s, "第五章 ／ 收尾", "退出谱系：三条路径互斥，不能同时承诺")
y = table(s, ["退出路径", "成立条件", "不成立时的后果", "适用边界"],
          [["REITs 或不动产基金", "现金流稳定可预测、资产权属与运营数据可审计、通道对低租金资产开放", "无法发行", "需先通过筛选标准检验，不可作立项承诺"],
           ["整售", "市场景气与接盘方存在、价格不低于账面", "折价出售、损失确认", "不宜作为政策项目的默认路径"],
           ["划转与长期自持", "有明确的长期持有主体与预算安排", "资产与补贴责任长期挂在国企", "需锁定预算科目，否则属隐性挂账"]],
          y, colw=[2.3, 4.6, 2.3, 2.8], rowh=1.05)
footnote(s, "退出不通时，收储从准公共采购退化为准公共持有。【研判推断】")
notes(s, "退出谱系。核心是「互斥」：三条路径不能同时承诺。最容易犯的错是立项时暗示 REITs 退出，"
         "但资产本身不满足条件。结论：REITs 是筛选标准，不是立项承诺。")

# ---- 19 全周期模型 ----
s = sld(); y = head(s, "第五章 ／ 收尾", "全周期模型：五段结构与三项必备输出",
                    "三项须同时披露：静态回收期、净现值、补贴依赖度")
y = table(s, ["阶段", "变量", "口径要求", "输出用途"],
          [["① 购置", "收购价、交易税费、尽调与法务费、时间成本", "以同板块可比真实成交价为基准，不用挂牌价", "资产账起点"],
           ["② 改造", "单套改造造价、工期、合规审批成本、非标附加项", "以同类型已完工项目结算价为基准", "一次性资本支出"],
           ["③ 运营", "年租金、出租率、运营费率、维护更新率、租金递增假设", "出租率与运营费率须来自同一运营主体实测", "运营账现金流"],
           ["④ 持有", "资金成本、税费、通胀假设、折旧", "资金成本与实际资金结构一致，再贷款、专项债、自筹分列", "折现率与年摊"],
           ["⑤ 退出", "退出方式与退出时点", "以情景区间表述，不作单点承诺", "终值输入"]],
          y, colw=[1.2, 4.0, 4.6, 2.2], rowh=0.72)
tf = tb(s, M, y + 0.10, W - 2 * M, 0.6)
para(tf, "补贴依赖度是识别真假商业可行性的一眼判据；只报回收期不报补贴额视为不完整披露；"
         "补贴依赖度难以测算的项目，应判为结构未成立。【研判推断】", size=11, color=INK2, first=True,
     space_after=0, line=1.45)
notes(s, "全周期模型是本轮新增的一页，把收储从购置到退出拆成五段，每段给出变量和口径要求。"
         "重点讲三项必备输出必须同时披露，尤其补贴依赖度——它是识别真假商业可行性的一眼判据。")

# ---- 20 责任边界 ----
s = sld(); y = head(s, "第五章 ／ 收尾", "平台责任边界：交付判据，不承担资产",
                    "一句话边界：平台交付可审计的判据，政府与国企承担资产与预算")
cw = (W - 2 * M - 0.26) / 2
left = ["需求清单结构化与轮候匹配", "房源准入评分与留痕", "可比估值与市场价偏离度测算",
        "改造适配方案与改造单价成本库", "运营数据采集与审计留痕", "全周期测算与退出情景分析"]
right = ["资产持有与资产负债表风险", "政策性定价口径", "租金或退出兜底承诺",
         "政府预算审批与财力风险", "单方面出具合规结论", "REITs 发行承销"]
for i, (title, items, bg, fg) in enumerate([("可承接", left, PEACOCK_S, PEACOCK_D),
                                            ("不可承接", right, WARN_S, WARN)]):
    l = M + i * (cw + 0.26)
    rect(s, l, y, cw, 2.75, bg, line=RGBColor(0xD8, 0xD2, 0xC6))
    tf = tb(s, l + 0.22, y + 0.16, cw - 0.44, 0.34)
    para(tf, title, size=15, color=fg, bold=True, font=SERIF, first=True, space_after=0)
    tf = tb(s, l + 0.22, y + 0.60, cw - 0.44, 2.0)
    for k, it in enumerate(items):
        para(tf, "· " + it, size=11.5, color=INK2, first=(k == 0), space_after=5, line=1.4)
bullets(s, ["出具门槛：需求清单与现金流口径不公开的项目，不出具评分卡、现金流模型与责任边界清单——"
            "无法审计的输入，产出的只能是装饰性评分。【研判推断】"], y + 3.0)
footnote(s, "这一条也决定了第三方付费的性质：制度不成型阶段，付费更可能是一次性项目费或数据服务费。")
notes(s, "责任边界，对平台自身定位最重要。可承接的六项都是「可审计的判据」，不可承接的都是「资产与预算」。"
         "出具门槛要重点讲：口径不公开的项目我们不出报告，因为无法审计的输入只能产出装饰性评分。"
         "这也决定了付费形态更可能是一次性项目费而非年度运营服务费。")

# ---- 21 观察指标 ----
s = sld(); y = head(s, "第五章 ／ 收尾", "可证伪判据三条与观察指标七项",
                    "三条可证伪判据：预租锁定先于收购；审批路径清晰可预期；项目现金流可审计")
table(s, ["序号", "观察指标", "观测口径"],
      [["1", "全市年度收购套数与收购金额", "官方或决算口径，非报道口径"],
       ["2", "收购用途结构占比", "是否由案例归纳升格为可比统计"],
       ["3", "单套改造成本与改造周期", "同类型已完工项目结算均值"],
       ["4", "负carry 的实际承担方与预算科目", "补贴是否进预算、是否与项目一一对应"],
       ["5", "需求主体签约率与入住率", "床位型单列"],
       ["6", "地方国企自建与委托第三方比例及付费方式", "年度化服务费与一次性项目费分别统计"],
       ["7", "REITs 或不动产基金通道的实际发行数量", "具体数字待核实"]],
      y, colw=[0.9, 5.3, 5.9], rowh=0.53, bodysz=9.5)
footnote(s, "任一条可证伪判据不满足，项目就只能靠财政兜底维持。【研判推断】")
notes(s, "观察清单，是交给听众的工具：七项指标按口径盯。重点讲第一项——要官方或决算口径，"
         "不要报道口径。三条可证伪判据任一条不满足，项目就只能靠财政兜底。")

# ---- 22 三情景 ----
s = sld(); y = head(s, "第五章 ／ 收尾", "未来12个月三情景与先行指标",
                    "基准情景最可能；乐观与风险均为条件情景")
y = table(s, ["情景", "触发条件", "结果特征", "性质"],
          [["基准（最可能）", "用途继续扩围，采购仍逐单推进", "高校宿舍与医疗养老维持点状，收储对年度销售贡献有限", "研判推断"],
           ["乐观", "出现首个把需求清单与采购合约同时公开的城市", "准入标准可复制，收储进入常规年度安排", "研判推断"],
           ["风险", "地方财力约束下补贴难进预算科目", "部分项目从收购退回代管，第三方付费空间被压扁", "研判推断"]],
          y, colw=[1.9, 4.2, 4.6, 1.4], rowh=0.80)
tf = tb(s, M, y + 0.12, W - 2 * M, 0.75)
para(tf, "先行指标五项：地方年度住房计划中的收储量表述是否由「推动」变为「采购＋套数」；专项债与再贷款投放"
         "是否对应具体房源清单；项目空置率是否下降；收储两本账是否公开；改造结算单价与运营费率是否形成可查口径。"
         "五项中出现三项以上给出明确口径，第二档判断即应重估。【研判推断】", size=10.5, color=INK2, first=True,
     space_after=0, line=1.45)
notes(s, "三情景。基准最可能，乐观的前提是出现第一个把需求清单和采购合约同时公开的城市——这是制度成型的"
         "最小可观测标志。先行指标五项是给听众的盯盘清单，三项以上明确口径就该重估判断。")

# ---- 23 不确定性 ----
s = sld(); y = head(s, "第五章 ／ 收尾", "不确定性：三处不透明决定判断精度")
cards = [("用途比例来源层级不足", "据此推导的规模测算只能视为方向性判断。"),
         ("实物规模不透明", "2026 年实际收购的决算规模与套数是否可查，是判断制度是否成立的硬证据；"
                            "口径不公开时，任何年度化判断都只能停留在推测。"),
         ("付费空间不确定", "地方国企有能力自建团队，第三方平台能否获得足够空间，取决于能否提供内部无法形成的"
                            "审计独立性；若收储退化为纯财政补贴维持的安置行为，平台服务市场会明显小于预期。")]
cw = (W - 2 * M - 0.24 * 2) / 3
for i, (t, d) in enumerate(cards):
    l = M + i * (cw + 0.24)
    rect(s, l, y, cw, 2.1, CARD, line=RGBColor(0xD8, 0xD2, 0xC6))
    tf = tb(s, l + 0.2, y + 0.18, cw - 0.4, 0.6)
    para(tf, t, size=13.5, color=INK1, bold=True, font=SERIF, first=True, space_after=0, line=1.3)
    tf = tb(s, l + 0.2, y + 0.84, cw - 0.4, 1.15)
    para(tf, d, size=10.5, color=INK2, first=True, space_after=0, line=1.5)
tf = tb(s, M, y + 2.36, W - 2 * M, 0.95)
para(tf, "改造结算单价、运营费率、空置率、租金水平、各城市收储落地套数等绝对值，公开渠道口径不一，"
         "具体数字需核实；郑州、杭州、武汉的分城市用途构成与收购决算数据暂缺——本稿不以推测替代证据。",
     size=11.5, color=INK2, first=True, space_after=0, line=1.5)
notes(s, "不确定性。三处不透明直接决定判断精度，尤其第二处——实物规模不透明是最大的未知。"
         "收尾一句要说得硬：本稿不以推测替代证据。")

# ---- 24 来源与口径 ----
s = sld(); y = head(s, "附录 ／ 数据来源与口径", "来源披露与口径提示")
table(s, ["来源", "日期", "在稿中的用途"],
      [["中房网", "2026-05-20", "收购用途比例的公开案例归纳（非统一统计）"],
       ["吴晓波频道／新浪财经", "2026-08-20", "收储「两本账」、上海以旧换新与用途改造案例"],
       ["腾讯新闻", "2026-09-09", "深圳大学拟购楼作宿舍（金额口径）"],
       ["中国政府网", "2026-03-05", "政府工作报告「盘活存量商品房」方向"],
       ["深圳市住建局", "2026-04-30", "2026 住房发展年度计划"],
       ["中国人民银行", "2025-01-02", "保障性住房再贷款支持比例调整（具体比例待补）"],
       ["新浪财经", "2026-05-26", "一线城市二手房收储案例与政策梳理"]],
      y, colw=[2.6, 1.7, 7.8], rowh=0.50, bodysz=9.5)
tf = tb(s, M, y + 0.08, W - 2 * M, 0.8)
para(tf, "口径提示：50%／20%／5% 为公开案例归纳，非统一统计，不可加总或推算全国规模；"
         "深圳大学 5.336 亿元为披露金额口径，床位与单套折算待补；单床 35.6 万元、单位面积 0.24 万元／平方米为测算。",
     size=10.5, color=INK2, first=True, space_after=0, line=1.45)
notes(s, "来源与口径页。快速过，但两个免责要说清楚：一是比例数字非统计口径，二是测算项不是官方数据。")

# ---- 25 ending ----
s = sld(PEACOCK_D)
tf = tb(s, M, 2.5, W - 2 * M, 2.2, align=PP_ALIGN.CENTER)
para(tf, "平台交付可审计的判据", size=34, color=ON_P, bold=True, font=SERIF, first=True,
     space_after=8, line=1.15, align=PP_ALIGN.CENTER)
para(tf, "政府与国企承担资产与预算", size=34, color=RGBColor(0xEF, 0xC9, 0x8A), bold=True,
     font=SERIF, space_after=0, line=1.15, align=PP_ALIGN.CENTER)
tf = tb(s, M, 5.0, W - 2 * M, 0.8, align=PP_ALIGN.CENTER)
para(tf, "收储用途扩围与平台机会 · 正式稿", size=13, color=RGBColor(0xC9, 0xE1, 0xDB),
     first=True, space_after=4, align=PP_ALIGN.CENTER)
para(tf, "98wiki ｜ 智见 / 行业研究报告 · 行业研究，不构成投资建议", size=11,
     color=RGBColor(0xA9, 0xCF, 0xC8), space_after=0, align=PP_ALIGN.CENTER)
notes(s, "收尾。全篇收束在一句话上：平台交付可审计的判据，政府与国企承担资产与预算。"
         "这也回答了开篇的问题——平台的机会不在替政府持有资产。")

print("slides:", len(prs.slides))
OUT.parent.mkdir(parents=True, exist_ok=True)
prs.save(OUT)
print("wrote", OUT, OUT.stat().st_size, "B")
