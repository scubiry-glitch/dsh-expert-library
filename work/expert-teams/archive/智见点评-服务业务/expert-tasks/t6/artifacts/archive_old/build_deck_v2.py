#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
智见点评 · 服务业务 ｜ t6 第 3 步：可编辑 PPTX（研报汇报版 v2 · 审计账本式纸墨系统）
单源：AI无佣与人机协同_正式稿_v1.md（本脚本不改写任何数字，只做版面组织）

工具说明：任务指定的 pptfast 未安装（技能目录以 GET /plugins/dsh-expert-library/skills 为准，无 pptfast；
        本机亦无 LibreOffice / PowerPoint，无法导出 PPTX 预览图）。改用
        ppt-polished-deck-collab 的 editable_pptx 路线（python-pptx 原生对象，非截图拼图）。

排版纪律（该 skill 的 cn_song_times 默认 token 表，逐项绑定，不手填档位）：
        hero 40 / section 30 / page_title 24 / subtitle 16 / minor_title 14 / body 12 /
        label 10.5 / caption 9 / table 10.5（表格五号、单倍行距、无缩进、数值右对齐）
数字纪律：每个数字带口径或来源；预测性判断标注「研判推断」；派生数字标注「派生」。
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_TICK_MARK
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

HERE = Path(__file__).resolve().parent
OUT = HERE / "AI无佣与人机协同_汇报版_v2.pptx"

# ---- theme tokens（与 HTML/PDF 同一套） ----
INK1 = RGBColor(0x1F, 0x1B, 0x14)   # 暖墨
INK2 = RGBColor(0x4A, 0x43, 0x35)
INK3 = RGBColor(0x6B, 0x63, 0x55)
ACCENT = RGBColor(0x10, 0x60, 0x5A)   # 孔雀青（主）
ACCENT_MID = RGBColor(0x1C, 0x7F, 0x76)
GOLD = RGBColor(0x9A, 0x6B, 0x22)     # 古金（章线 / 条款 tag）
GOLD_INK = RGBColor(0x7E, 0x54, 0x16)
PAGE = RGBColor(0xF1, 0xEE, 0xE7)     # 暖纸
BG = RGBColor(0xFD, 0xFC, 0xF9)       # 近白卡
PANEL2 = RGBColor(0xF5, 0xF2, 0xEC)
PANEL3 = RGBColor(0xE9, 0xE4, 0xD9)
HAIR = RGBColor(0xDC, 0xD5, 0xC6)     # 发丝线（暖）
ON_DARK = RGBColor(0xF2, 0xEF, 0xE7)
ON_DARK_DIM = RGBColor(0xC7, 0xD6, 0xD1)
WARN = RGBColor(0xA2, 0x51, 0x2F)

EA = "宋体"                      # 中文（skill 默认 east_asia_font_name）
LATIN = "Times New Roman"       # 西文（skill 默认 latin_font_name）

# 字号 token（只允许这一组档位）
HERO, SECT, PAGE_T, SUB, MINOR, BODY, LABEL, CAPTION, TABLE = 40, 30, 24, 16, 14, 12, 10.5, 9, 10.5

SLIDE_W, SLIDE_H = 13.333, 7.5
M = 0.62
PAGE_NO = {"n": 0}


def font(run, size, bold=False, color=INK2, ea=EA, latin=LATIN, italic=False):
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    run.font.color.rgb = color
    run.font.name = latin
    rPr = run._r.get_or_add_rPr()
    for tag in ("a:ea", "a:cs"):
        el = rPr.makeelement(
            "{http://schemas.openxmlformats.org/drawingml/2006/main}" + tag.split(":")[1], {}
        )
        el.set("typeface", ea)
        rPr.append(el)


def textbox(slide, x, y, w, h, anchor=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Emu(0)
    tf.margin_top = tf.margin_bottom = Emu(0)
    return tb, tf


def para(tf, first, text, size, bold=False, color=INK2, line=1.0, space_after=0.0,
         align=PP_ALIGN.LEFT, indent_first=False):
    p = tf.paragraphs[0] if first else tf.add_paragraph()
    p.alignment = align
    p.line_spacing = line
    p.space_after = Pt(space_after)
    if indent_first:
        p.paragraph_format.first_line_indent = Pt(size * 2)
    r = p.add_run()
    r.text = text
    font(r, size, bold=bold, color=color)
    return p


def rich(tf, first, segments, size, line=1.0, space_after=0.0, align=PP_ALIGN.LEFT):
    """segments: list of (text, bold, color)"""
    p = tf.paragraphs[0] if first else tf.add_paragraph()
    p.alignment = align
    p.line_spacing = line
    p.space_after = Pt(space_after)
    for t, b, c in segments:
        r = p.add_run()
        r.text = t
        font(r, size, bold=b, color=c)
    return p


def rect(slide, x, y, w, h, fill=BG, line=HAIR, radius=True):
    from pptx.enum.shapes import MSO_SHAPE

    shape = slide.shapes.add_shape(
        MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE,
        Inches(x), Inches(y), Inches(w), Inches(h),
    )
    if radius:
        shape.adjustments[0] = 0.06
    if fill is None:
        shape.fill.background()
    else:
        shape.fill.solid()
        shape.fill.fore_color.rgb = fill
    if line is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = line
        shape.line.width = Pt(0.75)
    shape.shadow.inherit = False
    return shape


def blank(prs):
    return prs.slides.add_slide(prs.slide_layouts[6])


def header(slide, title, kicker=None, sub=None):
    """标题区：左上角留给标题/眉标；弱信息进页脚。"""
    rect(slide, 0, 0, SLIDE_W, SLIDE_H, fill=PAGE, line=None, radius=False)
    y = M - 0.06
    if kicker:
        _, tf = textbox(slide, M, y, SLIDE_W - 2 * M, 0.26)
        para(tf, True, kicker, LABEL, color=GOLD_INK)
        y += 0.28
    _, tf = textbox(slide, M, y, SLIDE_W - 2 * M, 0.46)
    para(tf, True, title, PAGE_T, bold=True, color=ACCENT, line=1.0)
    y += 0.50
    rect(slide, M, y, SLIDE_W - 2 * M, 0.022, fill=GOLD, line=None, radius=False)
    y += 0.14
    if sub:
        _, tf = textbox(slide, M, y, SLIDE_W - 2 * M, 0.30)
        para(tf, True, sub, SUB, color=INK3, line=1.0)
        y += 0.36
    return y + 0.10


def footer(slide, source, note=""):
    PAGE_NO["n"] += 1
    _, tf = textbox(slide, M, SLIDE_H - 0.52, SLIDE_W - 2 * M, 0.22)
    p = tf.paragraphs[0]
    p.line_spacing = 1.0
    r = p.add_run()
    r.text = source
    font(r, CAPTION, color=INK3)
    _, tf2 = textbox(slide, SLIDE_W - M - 1.6, SLIDE_H - 0.52, 1.6, 0.22)
    para(tf2, True, f"智见点评 · 服务业务　{PAGE_NO['n']:02d}", CAPTION,
         color=INK3, align=PP_ALIGN.RIGHT)
    if note:
        _, tf3 = textbox(slide, M, SLIDE_H - 0.80, SLIDE_W - 2 * M, 0.24)
        para(tf3, True, note, CAPTION, color=GOLD_INK)


def card(slide, x, y, w, h, title, lines, tone="plain", title_size=MINOR, body_size=BODY,
         body_line=1.5):
    fills = {"plain": BG, "soft": PANEL2, "accent": PANEL3, "moat": PANEL2}
    lines_map = {"plain": HAIR, "soft": HAIR, "accent": HAIR, "moat": ACCENT}
    rect(slide, x, y, w, h, fill=fills[tone], line=lines_map[tone])
    pad = 0.20
    _, tf = textbox(slide, x + pad, y + pad - 0.04, w - 2 * pad, h - 2 * pad,
                    anchor=MSO_ANCHOR.TOP)
    para(tf, True, title, title_size, bold=True,
         color=ACCENT if tone == "moat" else INK1, line=1.0, space_after=4)
    for ln in lines:
        para(tf, False, ln, body_size, color=INK2, line=body_line, space_after=2)
    return tf


def table(slide, x, y, w, rows, col_w, header_row=True, row_h=0.34, font_size=TABLE,
          first_col_bold=True):
    """rows: list[list[str]]；表格五号、单倍行距、无缩进、上下居中。"""
    nrows, ncols = len(rows), len(rows[0])
    shape = slide.shapes.add_table(nrows, ncols, Inches(x), Inches(y), Inches(w),
                                   Inches(row_h * nrows))
    tbl = shape.table
    tbl.first_row = header_row
    total = sum(col_w)
    for i, cw in enumerate(col_w):
        tbl.columns[i].width = Emu(int(Inches(w) * cw / total))
    for r in range(nrows):
        tbl.rows[r].height = Inches(row_h)
        for c in range(ncols):
            cell = tbl.cell(r, c)
            cell.text = ""
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            cell.margin_left = Inches(0.08)
            cell.margin_right = Inches(0.08)
            cell.margin_top = Inches(0.02)
            cell.margin_bottom = Inches(0.02)
            cell.fill.solid()
            if header_row and r == 0:
                cell.fill.fore_color.rgb = PANEL2
            else:
                cell.fill.fore_color.rgb = BG
            tf = cell.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            p.line_spacing = 1.0
            p.alignment = PP_ALIGN.RIGHT if (c == ncols - 1 and r > 0 and _numeric(rows[r][c])) else PP_ALIGN.LEFT
            run = p.add_run()
            run.text = rows[r][c]
            font(run, font_size,
                 bold=(header_row and r == 0) or (first_col_bold and c == 0),
                 color=INK1 if (r == 0 or c == 0) else INK2)
    return tbl


def _numeric(s):
    s = s.strip()
    return bool(s) and all(ch.isdigit() or ch in ".%+-,，亿元个百分点 " for ch in s)


# ============================ 幻灯片 ============================
def build():
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(SLIDE_W), Inches(SLIDE_H)

    # --- 01 封面（hero-statement） ---
    s = blank(prs)
    rect(s, 0, 0, SLIDE_W, SLIDE_H, fill=PAGE, line=None, radius=False)
    rect(s, 0, 0, SLIDE_W, 2.62, fill=ACCENT, line=None, radius=False)
    _, tf = textbox(s, M, 0.46, SLIDE_W - 2 * M, 0.46)
    para(tf, True, "98wiki ｜ 智见点评 · 行业研究", LABEL, color=ON_DARK_DIM, line=1.2)
    para(tf, False, "居住服务 ｜ 正式稿 v1 · 渲染 v2（审计账本纸墨）", LABEL,
         color=ON_DARK_DIM, line=1.2)
    _, tf = textbox(s, M, 0.82, SLIDE_W - 2 * M, 0.72)
    para(tf, True, "AI 无佣与人机协同", HERO, bold=True, color=ON_DARK, line=1.0)
    _, tf = textbox(s, M, 1.66, SLIDE_W - 2 * M, 0.40)
    para(tf, True, "成本结构在重定价，物理成本没消失", SUB, color=ON_DARK_DIM, line=1.0)
    _, tf = textbox(s, M, 2.06, SLIDE_W - 2 * M, 0.52)
    para(tf, True, "框架：通用四段式　｜　口径：全国（易居·小新、贝壳业务口径）", LABEL,
         color=ON_DARK_DIM, line=1.2)
    para(tf, False, "证据窗：2025-09 — 2026-09　｜　2026-09-16", LABEL,
         color=ON_DARK_DIM, line=1.2)

    rect(s, M, 2.86, SLIDE_W - 2 * M, 0.86, fill=PANEL2, line=HAIR)
    rect(s, M, 2.86, 0.05, 0.86, fill=GOLD, line=None, radius=False)
    _, tf = textbox(s, M + 0.22, 3.00, SLIDE_W - 2 * M - 0.44, 0.60)
    rich(tf, True, [("「零佣」与「按项收费」并非同一种承诺。前者是定价策略，后者是成本结构主张；",
                     False, INK1),
                    ("前者可以今天宣布，后者必须明天兑付。", True, GOLD_INK)], SUB, line=1.3)

    cells = [
        ("245 亿元", "二季度净收入", "引用｜2026-08-21 二季度披露"),
        ("14.6%", "经调整经营利润率，同比 +8.5 个百分点", "引用｜差额为派生"),
        ("25%", "二手房成交单量同比增长", "引用｜同上"),
        ("2.26 亿套", "楼盘字典覆盖（挑战方自述口径）", "引用｜2026-05-28 同源声明"),
    ]
    cw, gap = 3.02, 0.14
    for i, (big, lbl, src) in enumerate(cells):
        x = M + i * (cw + gap)
        rect(s, x, 3.92, cw, 1.62, fill=BG, line=HAIR)
        _, tf = textbox(s, x + 0.18, 4.06, cw - 0.36, 0.42)
        para(tf, True, big, PAGE_T, bold=True, color=INK1, line=1.0)
        _, tf = textbox(s, x + 0.18, 4.52, cw - 0.36, 0.60)
        para(tf, True, lbl, LABEL, color=INK2, line=1.3)
        _, tf = textbox(s, x + 0.18, 5.16, cw - 0.36, 0.28)
        para(tf, True, src, CAPTION, color=INK3, line=1.2)
    footer(s, "数据来源：12 家公开报道（新浪财经、中房网、钛媒体等）",
           "数字四级标注：【引用】／【派生】／【研判推断】／【待补】")
    s.notes_slide.notes_text_frame.text = (
        "【来源全表】新浪财经、中房网、钛媒体、证券时报、人民网、新华社、澎湃新闻、21 财经、"
        "北京商报、36 氪、虎嗅、亿欧（2025-09—2026-09 公开报道）。"
        "【标注说明】引用=公开报道原值；派生=引用数字的算术派生；研判推断=分析性判断；待补=公开来源不可得。"
        "封面。开场只用一句话定调：这场争论重定价的是成本结构，不是消灭成本。"
        "四格数字全部来自二季度披露与同源声明，口径已在每格右下标注；"
        "提醒听众：一边有利润表，一边有说明书，两者当前不可比。")

    # --- 02 三条判断（board-memo） ---
    s = blank(prs)
    y = header(s, "三条判断：供给侧、责任侧、定价侧",
               kicker="管理层摘要", sub="主基调由数据事实判定；四个季度里「量、利润、人效同向」是唯一确定的东西。")
    items = [
        ("供给侧", ["房源数据结构化已接近完成（楼盘字典 2.26 亿套，引用口径）。",
                    "搜寻环节的信息成本会持续下降，这是不可逆的。"]),
        ("责任侧", ["核验、签字、过户、纠纷兜底这四类动作必须有人在现场并且能签字。",
                    "成本性质是随单量线性增长的人力，规模不带来摊销。"]),
        ("定价侧", ["缺少的从来不是降费的勇气，是独权代理与跨机构数据共享这套基础设施。",
                    "没有它，所有「去佣金」尝试都会退化为费率战。"]),
    ]
    cw = (SLIDE_W - 2 * M - 2 * 0.22) / 3
    for i, (t, lines) in enumerate(items):
        card(s, M + i * (cw + 0.22), y, cw, 2.02, t, lines)
    rect(s, M, y + 2.24, SLIDE_W - 2 * M, 0.94, fill=PANEL2, line=HAIR)
    _, tf = textbox(s, M + 0.22, y + 2.38, SLIDE_W - 2 * M - 0.44, 0.70)
    rich(tf, True, [("当前最大的变量：", True, INK1),
                    ("「零佣」与「按项收费」之间隔着的是履约价目表——这份价目表目前不存在。"
                     "一边有利润表，一边有说明书，两者当前不可比。", False, INK2)], BODY, line=1.5)
    footer(s, "来源：中房网 2026-05-28；二季度披露 2026-08-21", "本页无预测性数字")
    s.notes_slide.notes_text_frame.text = (
        "三条判断对应三条成本线：搜寻成本下降（供给侧）、履约成本刚性（责任侧）、"
        "基础设施缺失导致费率战（定价侧）。收尾落在「履约价目表不存在」这个可观测变量上。")

    # --- 03 关键事实对照（research-note） ---
    s = blank(prs)
    y = header(s, "关键事实：两家走的是相反方向",
               kicker="事实及其变化",
               sub="一家把成本挪到「责任谁承担」这个未定价项上，另一家把管理成本改成履约成本。")
    rows = [
        ["时间", "挑战方：易居·小新", "在位方：贝壳"],
        ["2026-03-29", "—", "撤销南北大区，改设十大直属区域；同期 3000 名干部下一线、北京链家设三位首席客户官"],
        ["2026-05-08", "—", "重仓服务者，52 万经纪人改称「社区客户经理」"],
        ["2026-05-27/28", "提出「AI 做居间，成交无佣；服务凭专业，按劳计费」；同源明确「运营数据不足」", "—"],
        ["2026-06-16", "媒体列五项落地难关，核验、权属、履约责任在列", "—"],
        ["2026-08-17", "—", "线上服务助手成交效率提升 6 倍（北京试点、3 月启动、近 10 万人次、AI+人工）"],
        ["2026-08-21", "—", "二季度：总交易额 9338 亿元、同比 +6.3%；存量房 6299 亿元；二手房单量同比 +25%"],
        ["2026-09-08", "珠海启动房源端与买卖双方公测", "—"],
    ]
    table(s, M, y, SLIDE_W - 2 * M, rows, [1.5, 4.6, 5.6], row_h=0.44)
    _, tf = textbox(s, M, y + 0.44 * len(rows) + 0.10, SLIDE_W - 2 * M, 0.34)
    para(tf, True, "变化方向：竞争语言从交易规模转向人效、服务者渗透率与客户经理制。",
         BODY, bold=True, color=INK1, line=1.3)
    footer(s, "来源：21 财经、北京商报、36 氪、虎嗅；新浪财经",
           "全部为公开报道原值【引用】，本页无派生数字")
    s.notes_slide.notes_text_frame.text = (
        "时间轴刻意只放可核验的公开节点。注意 6 倍指标的口径限定：分母是「经线上服务助手深度沟通后"
        "流转至经纪人的客户」，不是全部客源，后面第 5 页专门讲剥离。")

    # --- 04 二季度经营质量（chart-spotlight，原生 Office 图表） ---
    s = blank(prs)
    y = header(s, "二季度经营质量：利润率对比条与派生校验",
               kicker="图 1", sub="纵轴为经调整经营利润率（%），零轴起算，条高 = 数值 ÷ 坐标域上限 15%。")
    cd = CategoryChartData()
    cd.categories = ["上年同期（派生）", "本期（引用）"]
    cd.add_series("经调整经营利润率", (6.1, 14.6))
    gf = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(M), Inches(y + 0.06),
                            Inches(6.4), Inches(3.30), cd)
    ch = gf.chart
    ch.has_legend = False
    ch.has_title = False
    plot = ch.plots[0]
    plot.gap_width = 120
    plot.has_data_labels = True
    dl = plot.data_labels
    dl.show_value = True
    dl.number_format = '0.0"%"'
    dl.number_format_is_linked = False
    dl.position = XL_LABEL_POSITION.OUTSIDE_END
    dl.font.size = Pt(BODY)
    dl.font.name = LATIN
    dl.font.bold = True
    ch.value_axis.minimum_scale, ch.value_axis.maximum_scale = 0, 15
    ch.value_axis.has_major_gridlines = True
    ch.value_axis.major_gridlines.format.line.color.rgb = HAIR
    ch.value_axis.tick_labels.font.size = Pt(CAPTION)
    ch.value_axis.tick_labels.font.name = LATIN
    ch.category_axis.tick_labels.font.size = Pt(CAPTION)
    ch.category_axis.tick_labels.font.name = EA
    ch.category_axis.major_tick_mark = XL_TICK_MARK.NONE

    rx = M + 6.62
    rw = SLIDE_W - M - rx
    card(s, rx, y + 0.06, rw, 1.42, "同比差额　+8.5 个百分点（派生）",
         ["14.6% − 8.5 个百分点 = 6.1%。", "改善是量、利润、人效同向出现的，不是单点指标。"],
         tone="soft")
    card(s, rx, y + 1.62, rw, 1.74, "自洽校验（派生）",
         ["经调整经营利润 35.9 ÷ 净收入 245 ≈ 14.7%（保留一位小数），"
          "与披露的 14.6% 一致，差异属舍入。",
          "存量房交易额占比 = 6299 ÷ 9338 ≈ 67.5%。"], tone="soft")
    footer(s, "来源：二季度披露 2026-08-21；两项为【引用】，其余为【派生】",
           "本页不含新造数字；派生口径见文末附图数据说明")
    s.notes_slide.notes_text_frame.text = (
        "证据页。左边是原生可编辑图表，轴上限 15%，所以两条分别是 40.7% 与 97.3% 的绘图高度，"
        "几何来自数据本身。右边两个派生校验是引用数字的算术派生，不引入新数据；"
        "强调自洽：利润÷收入与披露利润率只差舍入。")

    # --- 05 「6 倍」三重剥离（process-flow） ---
    s = blank(prs)
    y = header(s, "「6 倍」的三重剥离", kicker="图 2",
               sub="这是本轮最需要克制的地方：三重叠加后，AI 可归因份额应显著低于名义倍数。")
    strips = [
        ("1", "口径限定", "该指标的分母是「经线上服务助手深度沟通后流转至经纪人的客户」，不是全部客源，"
                          "存在明显选择偏差；服务本身是「AI+人工」，名义倍数里已混入人工贡献。"),
        ("2", "组织与市场同期变动", "2026-03-29 的组织调整把管理层级压掉、干部下沉一线，二季度二手房单量"
                                     "同比增长 25%，分母效应与决策链变短都在同一时间窗口内起作用。"),
        ("3", "可验证性", "企业自述指标，无第三方复核。"),
    ]
    yy = y
    for no, t, body in strips:
        rect(s, M, yy, SLIDE_W - 2 * M, 0.90, fill=PANEL2, line=HAIR)
        _, tf = textbox(s, M + 0.20, yy + 0.16, 0.34, 0.30)
        para(tf, True, no, MINOR, bold=True, color=GOLD_INK, line=1.0)
        _, tf = textbox(s, M + 0.62, yy + 0.12, SLIDE_W - 2 * M - 0.84, 0.70)
        para(tf, True, t, MINOR, bold=True, color=INK1, line=1.0, space_after=2)
        para(tf, False, body, BODY, color=INK2, line=1.4)
        yy += 1.00
    rect(s, M, yy, SLIDE_W - 2 * M, 0.86, fill=PANEL3, line=HAIR)
    _, tf = textbox(s, M + 0.22, yy + 0.14, SLIDE_W - 2 * M - 0.44, 0.62)
    rich(tf, True, [("剥离后的用法：", True, ACCENT),
                    ("在补出「未使用 AI 服务者人效」对照组之前，这个数字只作方向性证据，"
                     "不能作为估值输入，更不可外推行业。", False, INK2)], BODY, line=1.45)
    footer(s, "来源：证券时报 08-17；新浪财经 03-29",
           "本页为【研判推断】：剥离比例不作数值假设")
    s.notes_slide.notes_text_frame.text = (
        "方法论页，也是全篇最需要克制的地方。三重剥离之后不下结论倍数，只给用法："
        "作方向性证据，不作估值输入，不外推行业。这里明确标注「研判推断」，不给剥离系数的假设值。")

    # --- 06 证据效力分级（research-note） ---
    s = blank(prs)
    y = header(s, "挑战方一侧同样需要剥离，方向相反",
               kicker="证据效力分级",
               sub="把三件事混为「已验证模式」属引用越界；缺少的不是模型，是真实履约数据。")
    tiers = [
        ("2.26 亿套楼盘字典", "事实 · 证据强度最强", "成本结构证据：房源数据结构化已接近完成，搜寻环节的信息成本会持续下降。"),
        ("「成交无佣」", "定位 · 证据强度次之", "定价策略，不是已验证的经济模型；可以今天宣布，代价必须明天兑付。"),
        ("「运营数据不足」", "自陈的模型缺口 · 证据强度最弱", "冷启动成本无法用模型替代；这不是模型能力问题，是履约数据问题。"),
    ]
    yy = y
    for t, lv, body in tiers:
        rect(s, M, yy, SLIDE_W - 2 * M, 0.98, fill=BG, line=HAIR)
        _, tf = textbox(s, M + 0.22, yy + 0.16, 3.9, 0.34)
        para(tf, True, t, MINOR, bold=True, color=INK1, line=1.0)
        _, tf = textbox(s, M + 0.22, yy + 0.54, 3.9, 0.30)
        para(tf, True, lv, LABEL, color=GOLD_INK, line=1.0)
        _, tf = textbox(s, M + 4.30, yy + 0.20, SLIDE_W - 2 * M - 4.52, 0.62)
        para(tf, True, body, BODY, color=INK2, line=1.45)
        yy += 1.08
    rect(s, M, yy + 0.06, SLIDE_W - 2 * M, 0.78, fill=PANEL2, line=HAIR)
    _, tf = textbox(s, M + 0.22, yy + 0.20, SLIDE_W - 2 * M - 0.44, 0.54)
    rich(tf, True, [("对照口径：", True, INK1),
                    ("在位方的 6 倍是单城同期、同源自述指标；挑战方的三项证据强度依次递减。"
                     "两边都不能当作已验证的经济模型。", False, INK2)], BODY, line=1.45)
    footer(s, "来源：中房网 05-28；钛媒体 06-16；证券时报 08-17",
           "分级为【研判推断】，不赋权重、不编数值")
    s.notes_slide.notes_text_frame.text = (
        "对称性检查：上一页剥离在位方的 6 倍，这一页剥离挑战方的三项证据。"
        "分级只用文字（事实／定位／自陈缺口），不给权重百分比——那是编数字。")

    # --- 07 全流程成本树（appendix-dense） ---
    s = blank(prs)
    y = header(s, "全流程成本树：AI 只压一段，不压全链", kicker="表 1",
               sub="「可压缩性」为定性判断，不赋权重、不编数值。")
    rows = [
        ["环节", "AI 可压缩性", "可承担的部分", "必须留在人侧"],
        ["获客", "高", "信息密度高、反馈闭环短的可变成本", "—"],
        ["核验", "低", "产权、查封、共有、欠费、学位占用的资料预检", "按现行规则必须由持牌人签字确认"],
        ["匹配", "高", "信息密度高、反馈闭环短的可变成本", "—"],
        ["谈判", "低", "—", "依赖现场与关系"],
        ["带看", "低", "—", "依赖现场与关系"],
        ["按揭", "中", "材料与流程的规整", "线性增长且不可容错"],
        ["过户", "中", "材料与流程的规整", "线性增长且不可容错"],
        ["售后", "低", "—", "售后与赔付只能由机构兜底"],
    ]
    table(s, M, y, SLIDE_W - 2 * M, rows, [1.2, 1.5, 4.4, 4.6], row_h=0.42)
    _, tf = textbox(s, M, y + 0.42 * len(rows) + 0.10, SLIDE_W - 2 * M, 0.34)
    rich(tf, True, [("因此「成交效率提升 6 倍」", False, INK2),
                    ("不能外推为全链条成本降 6 倍", True, GOLD_INK),
                    ("——分母里含大量不可自动化作业。", False, INK2)], BODY, line=1.3)
    footer(s, "来源：本报告归因分析（按八段成本性质归类）",
           "可压缩性为定性判断【研判推断】，与正文表 1 一致")
    s.notes_slide.notes_text_frame.text = (
        "成本树是全文的分析骨架。讲清两点：AI 的压缩集中在获客与匹配（信息密度高、反馈闭环短），"
        "核验段必须持牌人签字，按揭与过户线性且不可容错，售后只能机构兜底——这些不会因为模型变强而消失。")

    # --- 08 责任四格（comparison-matrix） ---
    s = blank(prs)
    y = header(s, "建议责任 × 履约责任：四格与护城河落点", kicker="图 3",
               sub="横轴为履约由谁完成，纵轴为建议由谁给出；高亮格为护城河所在。")
    quads = [
        ("AI 建议 ＋ AI 履约", "仅在标准化场景成立，责任主体虚化、纠纷难定责。", "plain"),
        ("AI 建议 ＋ 人工履约", "分工成立，但责任可互相推诿，须在合同里先定兜底方。", "plain"),
        ("人工建议 ＋ AI 履约", "最稳健，AI 执行错误仍由居间机构承担。", "moat"),
        ("人工建议 ＋ 人工履约", "传统模式成本最高、责任最清晰。", "moat"),
    ]
    qw = (SLIDE_W - 2 * M - 0.22) / 2
    for i, (t, body, tone) in enumerate(quads):
        x = M + (i % 2) * (qw + 0.22)
        yy = y + (i // 2) * 1.42
        card(s, x, yy, qw, 1.28, t, [body], tone=tone)
    rect(s, M, y + 2.94, SLIDE_W - 2 * M, 0.94, fill=PANEL2, line=HAIR)
    _, tf = textbox(s, M + 0.22, y + 3.06, SLIDE_W - 2 * M - 0.44, 0.72)
    rich(tf, True, [("护城河落在第三、四格的履约能力，不在模型评测分数。", True, INK1),
                    ("「成交无佣」若成立，必须回答「建议错了谁赔」——证据链里没有公开答案。",
                     False, INK2)], BODY, line=1.45)
    footer(s, "来源：本报告归因分析（建议责任与履约责任两栏）", "四格为【研判推断】")
    s.notes_slide.notes_text_frame.text = (
        "把「谁签建议错误」变成可选格。护城河不在模型分数，在第三、第四格的履约能力。"
        "这句话是本篇的责任定价版本：费率之争的底层是责任之争。")

    # --- 09 攻防不对称（comparison-matrix） ---
    s = blank(prs)
    y = header(s, "两路线竞争的真实形态：防守与进攻的不对称", kicker="对照",
               sub="一个在存量佣金池里提效，一个在攻击佣金池本身。")
    card(s, M, y, (SLIDE_W - 2 * M - 0.24) / 2, 2.20, "武装经纪人　｜　防守型提效",
         ["费率不动，靠组织与工具把单件履约成本压下来。",
          "收益落在经纪人留存与股东利润率上，代价是组织重构。"], tone="plain")
    card(s, M + (SLIDE_W - 2 * M - 0.24) / 2 + 0.24, y, (SLIDE_W - 2 * M - 0.24) / 2, 2.20,
         "零佣与按项收费　｜　进攻型重构",
         ["让出佣金以争夺入口定价权。",
          "赌注在于按项收费能否覆盖核验与履约成本，且必须依靠交易量摊薄。"], tone="soft")
    rect(s, M, y + 2.42, SLIDE_W - 2 * M, 0.86, fill=PANEL3, line=HAIR)
    _, tf = textbox(s, M + 0.22, y + 2.54, SLIDE_W - 2 * M - 0.44, 0.62)
    rich(tf, True, [("费率之争的底层是责任之争：", True, ACCENT),
                    ("谁签「建议错误」的赔付条款，谁就握着定价权。", False, INK2)], BODY, line=1.45)
    footer(s, "来源：本报告归因分析（防守与进攻的不对称）", "结论为【研判推断】")
    s.notes_slide.notes_text_frame.text = (
        "把两条路线还原成两种商业动作：防守方在存量佣金池里提效，进攻方攻击佣金池本身。"
        "它们不是同一种生意的两种做法，所以要分开评估。")

    # --- 10 观察面板（comparison-matrix / appendix） ---
    s = blank(prs)
    y = header(s, "观察窗口：4—6 个季度（观察期设定为研判推断）", kicker="表 2",
               sub="判读方向为定性；未设数值阈值，避免为未披露指标新造阈值。")
    rows = [
        ["观察项", "判读方向", "为何重要"],
        ["按项收费价目表", "是否公开", "一旦公开，收敛启动，二元对立失去研究价值"],
        ["AI 使用服务者覆盖率", "是否过 50%，区分强制与自愿使用", "强制渗透不等于自愿采用，对人效含义相反"],
        ["服务者净留存率与人均成交套数", "两者是否同向", "若净流出而人均上行，是挤出而非提效"],
        ["核验纠纷率与返工率", "是否人机混岗征兆", "成本是否真消失，看返工而不是看效率倍数"],
        ["居间责任分类与强制执业保险", "规则是否出台、有无判例", "决定责任能否定价，进而决定费率结构"],
    ]
    table(s, M, y, SLIDE_W - 2 * M, rows, [3.4, 3.6, 4.6], row_h=0.56)
    footer(s, "来源：本报告收尾（观察窗口）", "「是否过 50%」为正文原有口径，其余为定性判读")
    s.notes_slide.notes_text_frame.text = (
        "观察面板是这份研究的下一次复核清单。刻意不设数值阈值——未披露的指标不该由我们编一个阈值出来。"
        "如果 4—6 个季度后价目表仍未公开，收敛判断需要修正，这写在下一屏的边界条件里。")

    # --- 11 三类场景（comparison-matrix） ---
    s = blank(prs)
    y = header(s, "三类场景的路线选择器", kicker="落点",
               sub="租赁、普通二手、高复杂交易对应三种不同的责任结构。")
    scenes = [
        ("租赁", "纯 AI 加线上签约最可能先跑通",
         "标准化最高、单笔金额小、重复率高。", "单笔可承受零佣或按项收费，事故损失有限"),
        ("普通二手", "人机混合是唯一稳态",
         "含核验、赎楼、按揭三项持牌环节，必须有人在关键节点签字。", "核验成本刚性，谈判断点由人承担"),
        ("高复杂交易", "由人主导，AI 只辅助",
         "继承析产、共有产权、法拍、家庭决策分歧。AI 的价值是把信息整理到家庭能吵得下去。",
         "单位经济依赖服务者专业能力，不宜用 AI 压价"),
    ]
    cw = (SLIDE_W - 2 * M - 2 * 0.22) / 3
    for i, (t, verdict, body, foot) in enumerate(scenes):
        x = M + i * (cw + 0.22)
        rect(s, x, y, cw, 2.70, fill=BG, line=HAIR)
        _, tf = textbox(s, x + 0.20, y + 0.18, cw - 0.40, 0.34)
        para(tf, True, t, MINOR, bold=True, color=INK1, line=1.0)
        _, tf = textbox(s, x + 0.20, y + 0.58, cw - 0.40, 0.46)
        para(tf, True, verdict, BODY, bold=True, color=ACCENT, line=1.35)
        _, tf = textbox(s, x + 0.20, y + 1.12, cw - 0.40, 1.00)
        para(tf, True, body, BODY, color=INK2, line=1.45)
        rect(s, x + 0.20, y + 2.22, cw - 0.40, 0.02, fill=HAIR, line=None, radius=False)
        _, tf = textbox(s, x + 0.20, y + 2.30, cw - 0.40, 0.34)
        para(tf, True, foot, CAPTION, color=INK3, line=1.3)
    footer(s, "来源：本报告收尾（三类场景选择器）", "场景归类为【研判推断】")
    s.notes_slide.notes_text_frame.text = (
        "把结论落到可操作的场景：租赁做纯 AI，普通二手做人机混合，高复杂交易由人主导。"
        "AI 在复杂交易里的价值不是替家庭决策，而是把信息整理到家庭能吵得下去。")

    # --- 12 三条洞察（decision-logic） ---
    s = blank(prs)
    y = header(s, "三条洞察", kicker="收尾",
               sub="这一轮不是工具升级，是责任机制重构。")
    insights = [
        ("洞察 一", "责任机制重构", "行业要完成的是从关系型撮合转向可追溯的履约，「谁签字、谁赔付」必须从业务话术变成合同条款；只谈大模型能力，会把组织与制度这两条真实变量看漏。"),
        ("洞察 二", "服务者向上迁移", "标准化咨询段交给 AI，人向权属风险、复杂谈判、家庭共同决策三段集中；若经纪人净流出而人均人效上升，那是挤出，不是提效。"),
        ("洞察 三", "渠道变重不变轻", "买方市场深度里，进攻方定义费率基准，防守方定义服务下限，前台让利战与后台成本战会并行。"),
    ]
    yy = y
    for t, k, body in insights:
        rect(s, M, yy, SLIDE_W - 2 * M, 1.24, fill=BG, line=HAIR)
        _, tf = textbox(s, M + 0.22, yy + 0.18, 1.30, 0.30)
        para(tf, True, t, LABEL, bold=True, color=GOLD_INK, line=1.0)
        _, tf = textbox(s, M + 0.22, yy + 0.52, 1.90, 0.34)
        para(tf, True, k, MINOR, bold=True, color=INK1, line=1.0)
        _, tf = textbox(s, M + 2.30, yy + 0.22, SLIDE_W - 2 * M - 2.52, 0.90)
        para(tf, True, body, BODY, color=INK2, line=1.5)
        yy += 1.34
    footer(s, "来源：本报告收尾（三条洞察）", "包含【研判推断】判断")
    s.notes_slide.notes_text_frame.text = (
        "收尾三句话：责任机制重构、服务者向上迁移、渠道变重。第二句给了一个反向指标——"
        "净流出而人均上行是挤出，可以用来识别伪提效。")

    # --- 13 落地与边界（closing） ---
    s = blank(prs)
    y = header(s, "落地三条腿与两条边界条件", kicker="结语",
               sub="责任不落地，AI 居间的信任溢价无从定价。")
    legs = [
        ("01　财税腿", "把按项收费做成可分项计价、可开票、可审计的口径，让费率结构进制度而不是留在营销词里。"),
        ("02　数据腿", "把核验项与权属链做成可共享的基础设施，统一楼盘字典与核验清单口径。"),
        ("03　合同腿", "用产品化合同先定「建议责任—履约责任」两栏，由平台与金融机构共担按揭与资金监管环节的自动化责任。"),
    ]
    cw = (SLIDE_W - 2 * M - 2 * 0.22) / 3
    for i, (t, body) in enumerate(legs):
        card(s, M + i * (cw + 0.22), y, cw, 1.62, t, [body], tone="soft", body_line=1.45)
    yy = y + 1.86
    for t, body in [
        ("边界 ① 零佣方不公开按项履约价目、不软化「无佣」",
         "则 4—6 个季度内收敛判断需修正，二元对立将持续更久；本稿把「趋同」锚在价目表是否公开，不锚在时间上。"),
        ("边界 ② 监管按「流程合规」而非「资格资质」确权",
         "则居间责任分类的价值下降；海外监管口径提出的「2026—2027 年内无可承保零佣模型」判断以强制执业保险落地为条件，条件不成立时需同步下修。"),
    ]:
        rect(s, M, yy, SLIDE_W - 2 * M, 0.74, fill=BG, line=HAIR)
        _, tf = textbox(s, M + 0.22, yy + 0.12, SLIDE_W - 2 * M - 0.44, 0.56)
        para(tf, True, t, LABEL, bold=True, color=WARN, line=1.2, space_after=2)
        para(tf, False, body, BODY, color=INK2, line=1.35)
        yy += 0.84
    _, tf = textbox(s, M, yy + 0.04, SLIDE_W - 2 * M, 0.30)
    para(tf, True, "行业研究，不构成投资建议；研判推断非官方统计。", CAPTION,
         color=INK3, line=1.35)
    footer(s, "来源：本报告收尾（不确定性、三条腿）", "边界条件为条件性风险提示，非并行观点")
    s.notes_slide.notes_text_frame.text = (
        "【免责全句】行业研究，不构成投资建议；测算／估算／研判推断非官方统计。"
        "易居运营与赔付数据均无公开来源，零佣能否覆盖履约成本无法判断，严按未验证处理；"
        "6 倍为单城同期、同源自述指标，不可外推。"
        "收尾页。三条腿是能给到从业者的可操作抓手；两条边界条件说明这份判断在什么条件下需要修正——"
        "把判断写成可证伪的形式，比给出一个更肯定的结论更有价值。免责按研报纪律保留。")

    return prs


def main():
    prs = build()
    prs.save(OUT)
    core = OUT.with_suffix(".pptx.core.xml")
    digest = hashlib.sha256(OUT.read_bytes()).hexdigest()
    print(json.dumps({"out": str(OUT), "slides": len(prs.slides.__iter__.__self__._sldIdLst),
                      "sha256": digest}, ensure_ascii=False))


if __name__ == "__main__":
    main()
