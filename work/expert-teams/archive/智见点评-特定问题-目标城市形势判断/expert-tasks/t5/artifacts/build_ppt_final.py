# -*- coding: utf-8 -*-
"""成都二手房形势研判（2025-09~2026-08）正式稿 · 可编辑 PPTX 生成脚本
配色与 HTML5 视觉稿同源（贝壳蓝 #2D5BD8 + 金 #B07A17 / 深蓝墨 #141D31）。
数字均带口径；预测类表述标注「研判推断」/「估算」。
运行：python3 build_ppt.py
"""
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn

# ---------- palette ----------
NAVY  = RGBColor(0x0B, 0x21, 0x49)
NAVY2 = RGBColor(0x16, 0x35, 0x6E)
BLUE  = RGBColor(0x2D, 0x5B, 0xD8)
BLUED = RGBColor(0x1E, 0x46, 0xB8)
BLUES = RGBColor(0xE9, 0xEF, 0xFA)
GOLD  = RGBColor(0xB0, 0x7A, 0x17)
GOLDL = RGBColor(0xE8, 0xC4, 0x7C)
INK   = RGBColor(0x14, 0x1D, 0x31)
INK2  = RGBColor(0x3A, 0x46, 0x5C)
INK3  = RGBColor(0x66, 0x73, 0x8C)
PANEL = RGBColor(0xF2, 0xF5, 0xFA)
LINE  = RGBColor(0xD7, 0xDE, 0xEA)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
RED   = RGBColor(0xA3, 0x3D, 0x2F)
REDS  = RGBColor(0xFB, 0xEF, 0xEC)
GREEN = RGBColor(0x2E, 0x7A, 0x55)
GREENS= RGBColor(0xEC, 0xF5, 0xF0)
GOLDS = RGBColor(0xFA, 0xF3, 0xE3)
FONT  = "微软雅黑"

prs = Presentation()
prs.slide_width  = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]
SW, SH = 13.333, 7.5

def set_run(r, text, size, color=INK, bold=False, italic=False):
    r.text = text
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.italic = italic
    r.font.color.rgb = color
    r.font.name = FONT
    rPr = r._r.get_or_add_rPr()
    ea = rPr.find(qn('a:ea'))
    if ea is None:
        ea = rPr.makeelement(qn('a:ea'), {})
        rPr.append(ea)
    ea.set('typeface', FONT)

def txbox(slide, x, y, w, h):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    return tb, tf

def para(tf, first=False):
    return tf.paragraphs[0] if first and not tf.paragraphs[0].runs else tf.add_paragraph()

def add_text(slide, x, y, w, h, lines, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, sp_after=4, line_sp=1.12):
    """lines: list of (text_or_runs, size, color, bold) where text_or_runs may be list of (txt,color,bold)"""
    tb, tf = txbox(slide, x, y, w, h)
    tf.vertical_anchor = anchor
    first = True
    for ln in lines:
        txt, size, color, bold = ln[0], ln[1], ln[2], ln[3]
        p = para(tf, first); first = False
        p.alignment = align
        p.space_after = Pt(sp_after)
        try:
            p.line_spacing = line_sp
        except Exception:
            pass
        if isinstance(txt, str):
            set_run(p.add_run(), txt, size, color, bold)
        else:
            for item in txt:
                if len(item) == 4:
                    t2, s2, c2, b2 = item
                    set_run(p.add_run(), t2, s2, c2, b2)
                else:
                    t2, c2, b2 = item
                    set_run(p.add_run(), t2, size, c2, b2)
    return tb

def rect(slide, x, y, w, h, fill=None, line=None, line_w=0.75, shape=MSO_SHAPE.RECTANGLE, radius=None, shadow_off=True):
    sp = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    if fill is None:
        sp.fill.background()
    else:
        sp.fill.solid(); sp.fill.fore_color.rgb = fill
    if line is None:
        sp.line.fill.background()
    else:
        sp.line.color.rgb = line; sp.line.width = Pt(line_w)
    if radius is not None and shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        try: sp.adjustments[0] = radius
        except Exception: pass
    if shadow_off:
        sp.shadow.inherit = False
    sp.text_frame.word_wrap = True
    return sp

def put_text_in_shape(sp, lines, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE, sp_after=2, line_sp=1.1):
    tf = sp.text_frame
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Inches(0.08)
    tf.margin_top = tf.margin_bottom = Inches(0.03)
    first = True
    for ln in lines:
        txt, size, color, bold = ln[0], ln[1], ln[2], ln[3]
        p = para(tf, first); first = False
        p.alignment = align
        p.space_after = Pt(sp_after)
        try: p.line_spacing = line_sp
        except Exception: pass
        if isinstance(txt, str):
            set_run(p.add_run(), txt, size, color, bold)
        else:
            for item in txt:
                if len(item) == 4:
                    t2, s2, c2, b2 = item
                    set_run(p.add_run(), t2, s2, c2, b2)
                else:
                    t2, c2, b2 = item
                    set_run(p.add_run(), t2, size, c2, b2)

PAGE = [0]
def hdr(slide, kicker, title, note=""):
    PAGE[0] += 1
    rect(slide, 0, 0, SW, 0.02, fill=GOLD)  # 顶金线
    add_text(slide, 0.55, 0.34, 9.5, 0.3, [(kicker.upper(), 11, BLUE, True)], sp_after=0)
    add_text(slide, 0.55, 0.60, 11.6, 0.62, [(title, 25, INK, True)], sp_after=0)
    rect(slide, 0.58, 1.24, 0.85, 0.035, fill=GOLD)
    if note:
        add_text(slide, 0.55, 1.34, 12.2, 0.3, [(note, 10.5, INK3, False)], sp_after=0)
    add_text(slide, 12.1, 0.42, 0.7, 0.3, [("0%d" % PAGE[0], 10, INK3, False)], align=PP_ALIGN.RIGHT, sp_after=0)
    # 页脚
    add_text(slide, 0.55, 7.12, 9.5, 0.25, [("98wiki ｜ 智见 / 行业研究报告 · 成都二手房形势研判（正式稿 · 2026-09-05）", 8, INK3, False)], sp_after=0)
    return 1.55

def notes(slide, text):
    slide.notes_slide.notes_text_frame.text = text

# ============ S1 封面 ============
s = prs.slides.add_slide(BLANK)
rect(s, 0, 0, SW, SH, fill=NAVY)
rect(s, 0, 0, SW, 0.06, fill=GOLD)
rect(s, 0, SH-0.06, SW, 0.06, fill=GOLDL)
add_text(s, 0.9, 0.55, 11.5, 0.3, [("98wiki ｜ 智见 · 行业研究报告　|　智见点评 · 特定问题 / 目标城市形势判断", 12, RGBColor(0xA9,0xC1,0xEC), False)], sp_after=0)
add_text(s, 0.9, 0.9, 11.5, 0.3, [("正式稿 FINAL　·　数据截至 2026-08（8 月疑似未完月）", 11, GOLDL, False)], sp_after=0)
add_text(s, 0.9, 1.75, 11.6, 1.9, [("成都二手房：已入", 40, WHITE, True)], sp_after=2)
add_text(s, 0.9, 2.45, 11.6, 1.9, [([("“底部区域”", 40, GOLDL, True), ("，", 40, WHITE, True)], 40, WHITE, True)], sp_after=2)
add_text(s, 0.9, 3.35, 11.6, 0.7, [("底部尚未确认成立：距离“确认见底”还差一步，这一步是量能止跌", 17, RGBColor(0xC6,0xD6,0xF2), False)], sp_after=0)
add_text(s, 0.9, 4.05, 11.8, 0.9, [([("主基调 KEYNOTE：", 12.5, GOLDL, True), ("价格端证据过半，量能端证据为零；判定交给量价连续三个月的交叉验证。", 12.5, RGBColor(0xDF,0xE8,0xF9), False)], 12.5, RGBColor(0xDF,0xE8,0xF9), False)], sp_after=0)
kpis = [("11,756 元/㎡", "2026-08 二手成交均价（贝壳交付·城市级）"), ("-9.2%", "12 个月累计跌幅（2025-09→2026-08）"), ("-9.4%", "2026-08 同比（2025-12 曾 -19.7%）"), ("81.1", "贝壳指数 2026-07（2018-11=100，较基期 -19%）")]
x = 0.9
for v, l in kpis:
    card = rect(s, x, 5.15, 2.78, 1.35, fill=NAVY2, line=RGBColor(0x3A,0x5F,0xA8), line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.09)
    put_text_in_shape(card, [(v, 20, WHITE, True)], align=PP_ALIGN.CENTER, sp_after=1)
    tf = card.text_frame; p = tf.add_paragraph(); p.alignment = PP_ALIGN.CENTER; p.space_before = Pt(2)
    set_run(p.add_run(), l, 8.5, RGBColor(0xB9,0xCD,0xEF), False)
    x += 2.93
add_text(s, 0.9, 6.72, 11.6, 0.4, [("口径：成交价=政研通贝壳交付（城市级均价，非挂牌价）；指数=贝壳官方房价指数（重复交易法，2018-11=100）；预测类表述为研判推断/估算", 9.5, RGBColor(0x8F,0xA9,0xD6), False)], sp_after=0)
notes(s, "开场说明数据口径与正式稿性质：本页为封面。核心信息：成都二手房进入底部区域但未确认；判定交给量价连续三个月交叉验证。数据时段 2025-09 至 2026-08，城市级二手房，成交价为贝壳交付口径而非挂牌价；8 月疑似未完月。")

# ============ S2 卷首速览 ============
s = prs.slides.add_slide(BLANK)
y = hdr(s, "30 秒读完 · 卷首速览", "一句话：接近见底，未到确认", "四组关键数字 + 三个记忆点")
cards = [
    ("价格端", "同比跌幅收窄过半", "-19.7% → -9.4%（2025-12 → 2026-08）", BLUE, BLUES),
    ("量能端", "证据为零，先行指标仍弱", "带看同比 -27%；8 月成交 4,507 套（-41%，未完月）", GOLD, GOLDS),
    ("结构端", "高端补跌未完", "降价榜清一色 500 万以上，4-6 月集中上架", RED, REDS),
    ("节奏", "L 型磨底，非 V 型", "基准：Q4 月成交 6,000~9,000 套（估算）；2027H1 或见右侧", GREEN, GREENS),
]
x = 0.55
for t, s1, s2, cc, cb in cards:
    rect(s, x, y, 2.98, 1.92, fill=cb, line=LINE, line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.07)
    add_text(s, x+0.16, y+0.12, 2.7, 0.3, [(t, 12, cc, True)], sp_after=0)
    add_text(s, x+0.16, y+0.44, 2.7, 0.7, [(s1, 13.5, INK, True)], sp_after=0)
    add_text(s, x+0.16, y+0.95, 2.7, 0.9, [(s2, 9.8, INK2, False)], sp_after=0)
    x += 3.06
rect(s, 0.55, y+2.1, 12.23, 0.5, fill=PANEL, line=LINE, line_w=0.5)
add_text(s, 0.75, y+2.18, 11.9, 0.36, [([("多视角研判收敛：", 12, BLUED, True), ("成都二手处于跌幅收窄的减速下行段；底部区域成立、右侧信号未现。", 12, INK2, False)], 12, INK2, False)], sp_after=0)
mem = [("跌速砍半 ≠ 下跌结束", "拐点要连续三个月交叉验证，单月不作数（3 月 12,849 套的“回暖”已被连降证伪）"),
       ("均价会骗人，同质口径的指数更可信", "均价 -9.2% 含低价段占比上升的结构扰动；1-4 月百万以内占比过半（53.9% / 52.4%）"),
       ("降价榜是探针，不是警报", "挂牌向成交收敛未走完=下跌未尽；跟踪：500 万以上大调价新案例是否连 2 个月消失")]
yy = y+2.85
for i, (t1, t2) in enumerate(mem):
    rect(s, 0.55, yy, 12.23, 0.86, fill=WHITE, line=LINE, line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.10)
    add_text(s, 0.8, yy+0.13, 2.6, 0.6, [("记忆点 %d" % (i+1), 11, GOLD, True)], sp_after=0)
    add_text(s, 3.4, yy+0.10, 9.2, 0.7, [([(t1 + "：", 12.5, INK, True), (t2, 11.5, INK2, False)], 11.5, INK2, False)], sp_after=0)
    yy += 0.97
notes(s, "卷首速览页：四象限（价格/量能/结构/节奏）+ 三个记忆点。强调两处口径提醒：带看与成交量的“量能端证据为零”；8 月为疑似未完月，只作方向参考。")

# ============ S3 一句话结论 ============
s = prs.slides.add_slide(BLANK)
y = hdr(s, "问题① · 是否接近见底", "结论：接近见底，距离确认还差“量能止跌”一步", "支持与反对的依据同栏并列，都来自同一套数据")
rect(s, 0.55, y, 12.23, 0.92, fill=BLUES, line=RGBColor(0xB9,0xCB,0xEF), line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.10)
put_text_in_shape(s.shapes[-1], [([("成都二手房价接近见底。", 15, BLUED, True), ("已过急跌段、右侧未到：处于跌幅收窄的减速下行段——底部区域成立、右侧信号未现，", 13.5, INK, False), ("确认需等量能止跌。", 13.5, BLUED, True)], 13.5, INK, False)], align=PP_ALIGN.LEFT, sp_after=0)
col_y = y + 1.15
add_text(s, 0.55, col_y, 6.1, 0.3, [("支持接近底部的依据（价格端过半）", 13, BLUED, True)], sp_after=0)
add_text(s, 7.05, col_y, 5.7, 0.3, [("反对确认的依据（量能端）", 13, RED, True)], sp_after=0)
sup = ["成交价同比由 2025-12 的 -19.7% 收窄至 2026-08 的 -9.4%；12 个月累计 -9.2%（12,943→11,756 元/㎡）",
       "贝壳指数月环比 3-6 月收窄至 -0.4%~+0.1%，4 月一度转正",
       "新增挂牌同比自 4 月转负、7 月 -14.8%：供给先于价格出清",
       "降价榜集中在 500 万以上高端盘，低总价刚需段未现大规模调价"]
ct = ["7 月指数环比 -1.1%、8 月成交价环比 -1.7%：6-7 月的企稳被打破",
      "带看自 3 月 27.6 万连降至 7 月 17.2 万、同比 -27%（先行指标）",
      "8 月成交 4,507 套、同比 -41%（未完月，仅方向参考）",
      "量在价先：量未企稳，“见底”只是价格侧推测，不是双侧确认"]
rect(s, 0.55, col_y+0.35, 6.0, 3.15, fill=WHITE, line=LINE, line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.06)
rect(s, 7.05, col_y+0.35, 5.73, 3.15, fill=WHITE, line=LINE, line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.06)
add_text(s, 0.8, col_y+0.5, 5.5, 2.9, [("· " + t, 10.6, INK2, False) for t in sup], sp_after=5, line_sp=1.08)
add_text(s, 7.3, col_y+0.5, 5.25, 2.9, [("· " + t, 10.6, INK2, False) for t in ct], sp_after=5, line_sp=1.08)
add_text(s, 0.55, col_y+3.72, 12.2, 0.75, [([("边界：", 11, GOLD, True), ("8 月为疑似未完月（目录更新 2026-07-11），不能单月定生死；城市均价不代表具体小区/房源。", 11, INK3, False)], 11, INK3, False)], sp_after=0)
notes(s, "双侧证据并置是本篇方法：价格端跌幅收窄（-19.7%→-9.4%）说明最陡一段已过；但量能端（带看 -27%、8 月疑似腰斩）尚未企稳。结论：底部区域成立、右侧未确认。")

# ============ S4 节奏 ============
s = prs.slides.add_slide(BLANK)
y = hdr(s, "问题② · 未来 6-12 个月", "低位磨底：L 型而非 V 型", "三种情形的触发条件与验证时点 · 区间为估算（研判推断）")
scn = [
    ("基准情形", "低位磨底", BLUE, BLUES,
     ["2026Q4 月成交在 6,000~9,000 套区间波动（估算，7 月 7,764 套为参考）",
      "贝壳指数围绕 80 点窄幅震荡",
      "高端盘零星补跌、幅度收窄"]),
    ("上行确认情形", "2027H1 或见右侧", GREEN, GREENS,
     ["9-10 月旺季月成交回到万套上方",
      "新增挂牌同比续负",
      "最早确认窗口：2027-03 小阳春（对照基数最有利）"]),
    ("下修情形", "底部后移 1-2 个季度", RED, REDS,
     ["月成交跌破 6,000 套，或带看深跌不止",
      "底部后移至 2027 年下半年",
      "量能止缩后需再观察一个季度"]),
]
x = 0.55
for tag, t, cc, cb, items in scn:
    rect(s, x, y, 3.96, 3.55, fill=cb, line=LINE, line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.055)
    add_text(s, x+0.2, y+0.16, 3.6, 0.32, [(tag + " · 研判推断", 11, cc, True)], sp_after=0)
    add_text(s, x+0.2, y+0.5, 3.6, 0.55, [(t, 19, INK, True)], sp_after=0)
    add_text(s, x+0.2, y+1.05, 3.6, 2.4, [("· " + i, 10.3, INK2, False) for i in items], sp_after=6, line_sp=1.1)
    x += 4.14
rect(s, 0.55, y+3.8, 12.23, 0.95, fill=PANEL, line=LINE, line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.10)
put_text_in_shape(s.shapes[-1], [([("政策只造 1-2 个月脉冲：", 12, GOLD, True), ("4 月指数环比转正被 7 月 -1.1% 证伪即为实例。政策落地不是确认信号——效力以落地后 2-3 个月的量能持续性检验。", 12, INK2, False)], 12, INK2, False)], align=PP_ALIGN.LEFT, sp_after=0)
notes(s, "节奏判断：基准情形为 L 型低位磨底。三个情形都给了可证伪的触发条件：上行要 9-10 月旺季站回万套；下修触发线是 6,000 套或带看深跌。强调政策脉冲只持续 1-2 个月，不能当作见底信号。")

# ============ S5 数据侧写·价格 ============
s = prs.slides.add_slide(BLANK)
y = hdr(s, "数据侧写 A · 价格", "跌幅收窄一半，磨底未完成", "两个同质口径锚点（贝壳交付·成交价，同比）；中间月份未逐月披露，仅连锚点")
# 双横条对比
rect(s, 0.55, y, 12.23, 2.6, fill=WHITE, line=LINE, line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.05)
add_text(s, 0.85, y+0.16, 6, 0.3, [("同比降幅：2025-12 最深 → 2026-08 收窄约一半", 13, INK, True)], sp_after=0)
tracks = [("2025-12 同比", 100, "-19.7%", RGBColor(0x7E,0x97,0xD8)), ("2026-08 同比", 47.7, "-9.4%", GOLD)]
ty = y+0.62
for lb, wpct, val, cc in tracks:
    add_text(s, 0.85, ty, 1.9, 0.35, [(lb, 11.5, INK2, False)], sp_after=0)
    rect(s, 2.9, ty+0.03, 7.4, 0.42, fill=RGBColor(0xEC,0xEF,0xF5), shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.5)
    rect(s, 2.9, ty+0.03, 7.4*wpct/100.0, 0.42, fill=cc, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.5)
    add_text(s, 10.45, ty-0.03, 2.2, 0.45, [(val, 16, INK, True)], sp_after=0)
    ty += 0.78
add_text(s, 0.85, ty+0.02, 11.6, 0.55, [([("12 个月累计 -9.2%（12,943 → 11,756 元/㎡）；近三月环比：2026-06 -2.4%、07 +0.1%、08 -1.7%。", 10.5, INK2, False), ("8 月疑似未完月。", 10.5, RED, True)], 10.5, INK2, False)], sp_after=0)
add_text(s, 0.85, ty+0.42, 11.6, 0.3, [("口径：城市级均价（贝壳交付），不代表具体小区/房源；图注：柱长按 -19.7% 满刻度绘制。", 9, INK3, False)], sp_after=0)
# 右侧卡：指数
add_text(s, 0.55, y+2.85, 7, 0.3, [("贝壳官方房价指数（重复交易法，2018-11=100）", 13, INK, True)], sp_after=0)
idx = [("2026-07 点位", "81.1", "较基期累计 -19%"), ("同比（较一年前）", "-10.3%", "7 月环比 -1.1%"), ("3-6 月环比", "-0.4% ~ +0.1%", "4 月一度转正（后被证伪）")]
x = 0.55
for lb, v, sub in idx:
    rect(s, x, y+3.2, 3.95, 1.25, fill=PANEL, line=LINE, line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.08)
    add_text(s, x+0.18, y+3.32, 3.6, 0.3, [(lb, 10.5, INK3, False)], sp_after=0)
    add_text(s, x+0.18, y+3.6, 3.6, 0.5, [(v, 20, BLUED, True)], sp_after=0)
    add_text(s, x+0.18, y+4.08, 3.6, 0.3, [(sub, 9, INK3, False)], sp_after=0)
    x += 4.14
add_text(s, 0.55, y+4.72, 12.2, 0.4, [([("判断：", 11.5, GOLD, True), ("跌速砍半 ≠ 下跌结束；7 月 -1.1% 说明磨底未完成。量价打架时以同质口径指数为准。", 11.5, INK2, False)], 11.5, INK2, False)], sp_after=0)
notes(s, "价格侧：同比降幅从 -19.7% 收窄到 -9.4% 是最大正面证据；但 7 月指数环比 -1.1%、8 月价格环比 -1.7% 打破 6-7 月企稳。本图只展示两个同质口径锚点，中间月份未披露，柱长按满刻度 -19.7% 绘制。")

# ============ S6 数据侧写·量能 ============
s = prs.slides.add_slide(BLANK)
y = hdr(s, "数据侧写 B · 量能", "小阳春脉冲被证伪：量能连降四个月", "3 月峰值 → 7 月回落 → 8 月疑似腰斩（未完月，虚线示意）")
bars = [("2026-03", "12,849 套", 100, "同比 +7.8%（小阳春峰值）", BLUE),
        ("2026-07", "7,764 套", 60.4, "同比 -2.8%", RGBColor(0x7F,0x9A,0xE6)),
        ("2026-08*", "4,507 套", 35.1, "同比 -41%（疑似未完月）", GOLD)]
rect(s, 0.55, y, 12.23, 3.5, fill=WHITE, line=LINE, line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.05)
chart_bot = y + 2.9
grid = [(y+0.75, "12k"), (y+1.47, "8k"), (y+2.19, "4k"), (y+2.90, "0")]
for gy, gl in grid:
    rect(s, 2.4, gy-0.02, 9.6, 0.012, fill=LINE)
    add_text(s, 0.8, gy-0.12, 1.3, 0.3, [(gl, 9, INK3, False)], sp_after=0)
x = 1.1
for lb, v, hpct, note, cc in bars:
    bh = 2.15*hpct/100.0
    rect(s, x, chart_bot-bh, 1.5, bh, fill=cc, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.18)
    add_text(s, x-0.55, chart_bot-bh-0.34, 2.6, 0.3, [(v, 12, INK, True)], align=PP_ALIGN.CENTER, sp_after=0)
    add_text(s, x-0.55, chart_bot+0.08, 2.6, 0.55, [(lb, 11, INK2, True)], align=PP_ALIGN.CENTER, sp_after=0)
    add_text(s, x-0.55, chart_bot+0.4, 2.6, 0.55, [(note, 8.5, INK3, False)], align=PP_ALIGN.CENTER, sp_after=0)
    x += 3.9
rect(s, 0.55, y+3.72, 12.23, 1.28, fill=PANEL, line=LINE, line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.09)
add_text(s, 0.85, y+3.85, 11.7, 0.3, [("带看量（先行指标）同向走弱：2026-03 27.6 万客户 → 07 17.2 万，连降 4 个月，7 月同比 -27%", 12, INK2, False)], sp_after=0)
add_text(s, 0.85, y+4.25, 11.7, 0.65, [([("量在价先：", 11.5, BLUED, True), ("量能未企稳则“见底”只是价格侧推测。8 月目录更新于 2026-07-11，疑似未完月、仅方向参考，先等终值再判断是否击穿 7,000 套警戒（待补）。", 11.5, INK2, False)], 11.5, INK2, False)], sp_after=0)
notes(s, "量能侧是本篇最弱的一环：3 月 12,849 套的回暖被随后四个月连降证伪；8 月 4,507 套疑似腰斩但属未完月，不能单月定生死。带看同比 -27% 说明需求端仍在收缩。量在价先，量能止跌是确认底部的前提。")

# ============ S7 供给与结构信号 ============
s = prs.slides.add_slide(BLANK)
y = hdr(s, "数据侧写 C · 供给与高端降价", "供给先出清；高端补跌未完", "新增挂牌转负是价格先行的供给信号；降价榜是下跌探针")
tiles = [("新增挂牌（7 月）", "45,733 → 32,268 套", "3 月峰值 → 7 月；同比自 4 月起转负，7 月 -14.8%"),
         ("平台在售存量", "≈24.2 万套", "月成交约 8 千套 → 供需流量比约 4:1"),
         ("去化周期（2026-07）", "6.8 个月", "去年同月 6.1；分档：<6 偏热 / 6-12 中性偏冷 / 12-24 冷 / >24 极冷"),
         ("百万以内成交占比", "过半（1-4 月）", "贝壳西南 53.9% / 中指 52.4%；2025 全年 48.16%（刚需=市场主力）")]
x = 0.55
for t, v, sub in tiles:
    rect(s, x, y, 3.0, 1.78, fill=PANEL, line=LINE, line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.08)
    add_text(s, x+0.17, y+0.13, 2.7, 0.3, [(t, 10.5, INK3, False)], sp_after=0)
    add_text(s, x+0.17, y+0.4, 2.7, 0.55, [(v, 14.5, INK, True)], sp_after=0)
    add_text(s, x+0.17, y+0.92, 2.7, 0.85, [(sub, 8.8, INK2, False)], sp_after=0)
    x += 3.08
add_text(s, 0.55, y+1.98, 12.2, 0.32, [([("口径提示（重要）：", 11, RED, True), ("去化 6.8 个月与「24.2 万套 ÷ 月成交约 8 千套 ≈ 30 个月」差约五倍，差在僵尸挂牌剔除规则：6.8 月取乐观边界、30 月取悲观边界；分母定义明确前不作确认信号（研判推断）。", 11, INK3, False)], 11, INK3, False)], sp_after=0)
rect(s, 0.55, y+2.45, 12.23, 0.42, fill=NAVY, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.5)
add_text(s, 0.85, y+2.53, 11.8, 0.3, [("高端盘降价榜（挂牌价口径 · 贝壳平台）：下跌的探针，不是警报", 12.5, WHITE, True)], sp_after=0)
cases = [("银泰中心·某房源", "累计 -1,700 万", "约 -24%"), ("建发浅水湾", "累计 -1,680 万", "约 -43%"), ("金林半岛", "-700 万", "数百万级"), ("中航云岭二期", "-500 万", "数百万级")]
x = 0.55
for nm, v, pct in cases:
    rect(s, x, y+3.05, 3.0, 0.78, fill=WHITE, line=LINE, line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.10)
    add_text(s, x+0.15, y+3.13, 2.75, 0.3, [(nm, 10.5, INK, True)], sp_after=0)
    add_text(s, x+0.15, y+3.42, 2.75, 0.35, [([(v, 12, RED, True), ("　" + pct, 9.5, INK3, False)], 12, RED, True)], sp_after=0)
    x += 3.08
add_text(s, 0.55, y+4.05, 12.2, 0.75, [([("判读：", 11, GOLD, True), ("挂牌降幅远超成交均价累计跌幅，是挂牌向成交收敛（收敛未完=下跌未尽）；但高端补跌也常是“最后一跌”形态。跟踪法：500 万以上累计降幅超 15% 的新案例是否连续 2 个月消失。", 11, INK2, False)], 11, INK2, False)], sp_after=0)
add_text(s, 0.55, y+4.85, 12.2, 0.3, [("样本结构：清一色总价 500 万以上改善/高端盘，上架集中于 2026 年 4-6 月；个案不等于城市信号。", 9, INK3, False)], sp_after=0)
notes(s, "供给侧出现正面信号：新增挂牌同比转负意味着业主惜售、供给先出清。去化周期存在 6.8 与 30 个月两个口径，差在僵尸挂牌剔除规则，引用时必须说明取哪个边界。降价榜集中在 500 万以上高端盘，是“挂牌向成交收敛”的过程，跟踪指标是大额调价案例是否连续两个月消失。")

# ============ S8 条件清单 ============
s = prs.slides.add_slide(BLANK)
y = hdr(s, "把“感觉见底”换成可验证阈值", "底部确认 = 以下五项信号齐备", "全部阈值可检验 · 预测标注研判推断")
rows = [
    ("① 量能企稳", "政研通（贝壳交付·城市级）月成交", "连续 3 个月 ≥ 8,000 套且不创新低", "验证 3 个月；8 月先等终值"),
    ("② 价格右侧", "贝壳指数（重复交易法）月环比", "连续 3 个月 ≥ -0.2% ~ -0.3% 且不创新低", "最早 2026-11 判定"),
    ("③ 高端退潮", "贝壳降价榜（挂牌价口径）500 万以上", "累计降幅 > 15% 新案例连续 2 个月消失", "2-3 个月"),
    ("④ 带看回暖", "贝壳带看（先行指标）同比", "回到 -10% 以内或转正（当前 -27%）", "2 个月"),
    ("⑤ 去化回落", "去化周期（口径修复前置）", "回到 6.5 个月以内", "季度观察"),
]
ty = y + 0.1
for c1, c2, c3, c4 in rows:
    rect(s, 0.55, ty, 12.23, 0.72, fill=WHITE, line=LINE, line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.10)
    add_text(s, 0.8, ty+0.2, 1.9, 0.4, [(c1, 12, BLUED, True)], sp_after=0)
    add_text(s, 2.7, ty+0.08, 3.6, 0.6, [(c2, 9.8, INK3, False)], sp_after=0)
    add_text(s, 6.35, ty+0.14, 4.0, 0.55, [(c3, 10.3, INK2, False)], sp_after=0)
    add_text(s, 10.4, ty+0.2, 2.3, 0.4, [(c4, 9.5, GOLD, True)], sp_after=0)
    ty += 0.84
add_text(s, 0.55, ty+0.1, 12.2, 0.65, [([("反例提醒：", 11, RED, True), ("7 月指数环比 -1.1% 是②的直接反例；去化项在口径修复（僵尸挂牌剔除规则）前不作确认信号。", 11, INK2, False)], 11, INK2, False)], sp_after=0)
notes(s, "五项确认条件全部量化：量能 8,000 套/月×3 个月、指数环比止稳、高端大降价案例消失、带看同比回 -10% 内、去化回落 6.5 个月内。说明 7 月 -1.1% 是价格条件的最新反例；去化项需要先修复口径（6.8 个月 vs 30 个月的分母定义）。")

# ============ S9 三类决策 ============
s = prs.slides.add_slide(BLANK)
y = hdr(s, "问题③ · 三类决策落点", "刚需：可以开始看，不必抢跑", "每类都给出定价锚与边界条件（正式稿）")
dec = [
    ("刚需买入", BLUE, ["急跌段已过，余下是阴跌而非暴跌风险", "百万以内占比过半：刚需正是市场主力，议价空间仍在", "定价锚=目标小区近三个月真实成交价，不是城市均价", "等 9-10 月量能验证后定签约节奏"],
     "边界：城市均价企稳 ≠ 目标房源同步企稳"),
    ("业主卖出", GOLD, ["不在带看 -27% 的时点恐慌砸盘，也不高挂慢降", "约 4:1 流量比下，流动性比挂牌价重要", "定价锚=近三个月同小区成交价，不是买入价", "一次到位、诚实定价是最快卖出策略；500 万以上正视补跌缩量双压"],
     "边界：挂牌大降价≠崩盘，是挂牌向成交收敛"),
    ("置换（结构最优）", GREEN, ["买卖两端过去 12 个月同跌约 9%：价差成本收窄、摩擦成本低位", "先卖后买：旧房按成交价而非预期价定价", "买入端盯“好地段+好产品”；高端盘大幅调价正是谈判窗口"],
     "前置约束：旧房流动性 + 新标的品质鉴别"),
]
x = 0.55
for t, cc, items, foot in dec:
    rect(s, x, y, 3.96, 4.75, fill=WHITE, line=LINE, line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.05)
    rect(s, x, y, 3.96, 0.62, fill=cc, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.05)
    add_text(s, x+0.2, y+0.13, 3.6, 0.4, [(t, 15.5, WHITE, True)], sp_after=0)
    add_text(s, x+0.2, y+0.8, 3.6, 3.15, [("· " + i, 10.3, INK2, False) for i in items], sp_after=7, line_sp=1.12)
    rect(s, x+0.16, y+4.12, 3.64, 0.5, fill=PANEL, line=LINE, line_w=0.5)
    add_text(s, x+0.28, y+4.17, 3.4, 0.45, [(foot, 8.8, INK3, False)], sp_after=0)
    x += 4.14
notes(s, "三类决策按风险结构给建议：刚需开始看但不必抢跑、以小区真实成交价为锚；业主不在带看 -27% 时点砸盘、一次定价到位，500 万以上正视双压；置换结构最优，先卖后买，高端大调价是谈判窗口。所有建议都以“近三个月同小区成交价”为锚，而非城市均价。")

# ============ S10 防误导 ============
s = prs.slides.add_slide(BLANK)
y = hdr(s, "读数据前先看这里", "防误导清单：五条铁律", "防止把个案当城市、把口径混着比")
g = [("单月不等于拐点", "3 月 12,849 套（+7.8%）被随后四个月连降证伪；8 月未完月同样不能单月定生死"),
     ("个案不等于城市", "银泰中心式个案不构成城市信号；核心矛盾是约 24.2 万套在售存量与约 4:1 供需流量比"),
     ("口径不能混用", "公开报道 4 月成都二手网签 24,498 套、二手市占率约 80%，量级约为题供贝壳口径春季峰值的两倍；全网签 vs 平台活跃成交不可跨口径比绝对量，趋势只用同比/环比"),
     ("政策不等于见底", "效力以落地后 2-3 个月量能持续性检验；4 月指数转正被 7 月 -1.1% 证伪即为实例"),
     ("挂牌大降价不等于崩盘", "是挂牌向成交的收敛；收敛未完恰是下跌未尽的证据，见底反而要等它走完")]
yy = y
for i, (t, d) in enumerate(g):
    rect(s, 0.55, yy, 12.23, 0.95, fill=WHITE, line=LINE, line_w=0.75, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.09)
    rect(s, 0.55, yy, 0.09, 0.95, fill=GOLD)
    add_text(s, 0.85, yy+0.13, 2.35, 0.7, [("防误导 %d" % (i+1), 10.5, GOLD, True), (t, 13, INK, True)], sp_after=3)
    add_text(s, 3.35, yy+0.16, 9.25, 0.75, [(d, 10.8, INK2, False)], sp_after=0)
    yy += 1.07
notes(s, "五条防误导清单防止误读：单月不作数、个案不等于城市、两套成交口径不可跨比、政策脉冲不等于见底、挂牌降价是收敛而非崩盘。对外沟通时优先引用这五条，避免以偏概全。")

# ============ S11 元信息与免责 ============
s = prs.slides.add_slide(BLANK)
y = hdr(s, "来源披露 · 补数路径 · 免责", "口径与后续观察项", "正式稿 · 仅留数据来源；预测为研判推断 / 估算")
add_text(s, 0.55, y, 12.2, 1.55, [
    ([("数据口径：", 11.5, INK, True), ("成交价=政研通·贝壳交付数据（城市级均价，非挂牌价，2025-09~2026-08）；指数=贝壳官方房价指数（重复交易法，2018-11=100）；在售存量/新增挂牌/带看/降价榜=贝壳平台检索（挂牌价口径）。", 10.8, INK2, False)], 10.8, INK2, False),
    ([("2026-08 疑似未完月", 10.8, RED, True), ("（目录更新于 2026-07-11），仅方向参考。外部交叉来源（仅量级/结构背景，与题供口径分列未混用）：新浪财经转载《成都房产发布》（2026-05-12）。", 10.8, INK2, False)], 10.8, INK2, False),
], sp_after=7)
add_text(s, 0.55, y+1.75, 12.2, 0.35, [("补数路径（后续观察项）", 12.5, INK, True)], sp_after=0)
chips = ["① 分总价段量价时序：检验“跌幅收窄=低价段占比上升”结构假象",
         "② 8 月全月终值：是否击穿 7,000 套量能警戒（待补）",
         "③ 去化周期分母定义：活跃挂牌剔除规则（待补）",
         "④ 高端盘逐案核对：挂牌虚高回落 vs 真实下修",
         "⑤ 新房对照系：二手底部依赖新房停止以价换量",
         "⑥ 转化与折扣指标：抗季节干扰"]
x, yy = 0.55, y+2.2
for i, c in enumerate(chips):
    cx = x + (i % 2) * 6.18
    cy = yy + (i // 2) * 0.62
    rect(s, cx, cy, 6.05, 0.5, fill=PANEL, line=LINE, line_w=0.5, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.16)
    add_text(s, cx+0.16, cy+0.1, 5.8, 0.36, [(c, 9.3, INK2, False)], sp_after=0)
rect(s, 0.55, y+4.25, 12.23, 1.0, fill=NAVY, shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.08)
add_text(s, 0.85, y+4.42, 11.7, 0.7, [("行业研究，不构成投资建议；测算/估算/研判推断非官方统计。数字为城市级口径，不代表具体小区或房源。", 11, WHITE, True),
                                     ("框架：用户视角五层（结论→记忆点→条件清单→补数→防误导→决策落点）；主基调为“底部区域、未确认”，分歧仅在确认节奏与信号标准，偏离观点降级为边界条件/风险提示。", 8.5, RGBColor(0xB9,0xCD,0xEF), False)], sp_after=3)
notes(s, "收尾页：统一披露口径与来源；六个补数观察项需要后续数据（8 月终值、去化分母定义、分总价段时序等）；免责声明：行业研究不构成投资建议，所有预测为研判推断。")

prs.save('chengdu-resale-2026-08-final.pptx')
print('saved pptx, slides =', len(prs.slides._sldIdLst))
