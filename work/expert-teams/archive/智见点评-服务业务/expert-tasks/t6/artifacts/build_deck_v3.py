#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
智见点评 · 服务业务 ｜ t6 第 3 步：可编辑 PPTX（汇报版 v3 · 墨钴蓝＋印刷金 账册版）
单源：expert-tasks/t5/artifacts/融合正式稿_v3.md（唯一权威源；本脚本不改写任何数字，只做版面组织）

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
OUT = HERE / "AI无佣与人机协同_汇报版_v3.pptx"

# ---- theme tokens（与 HTML/PDF 同一套） ----
INK1 = RGBColor(0x0F, 0x1A, 0x2E)
INK2 = RGBColor(0x33, 0x41, 0x5C)
INK3 = RGBColor(0x5A, 0x68, 0x80)
ACCENT = RGBColor(0x1B, 0x3A, 0x6B)
ACCENT_MID = RGBColor(0x2D, 0x5B, 0xD8)
GOLD = RGBColor(0xA9, 0x74, 0x1F)
GOLD_INK = RGBColor(0x8A, 0x5E, 0x12)
PAGE = RGBColor(0xEC, 0xEF, 0xF5)
BG = RGBColor(0xFB, 0xFC, 0xFE)
PANEL2 = RGBColor(0xF2, 0xF5, 0xFA)
PANEL3 = RGBColor(0xE7, 0xEC, 0xF4)
HAIR = RGBColor(0xD6, 0xDC, 0xE8)
ON_DARK = RGBColor(0xEE, 0xF2, 0xF9)
ON_DARK_DIM = RGBColor(0xB9, 0xC4, 0xD6)
WARN = RGBColor(0x9C, 0x4A, 0x38)

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
    fills = {"plain": BG, "soft": PANEL2, "accent": PANEL3, "moat": PANEL3}
    lines_map = {"plain": HAIR, "soft": HAIR, "accent": HAIR, "moat": ACCENT_MID}
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


# ============================ 幻灯片（渲染源 v3） ============================
def build():
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(SLIDE_W), Inches(SLIDE_H)
    W = SLIDE_W - 2 * M

    # --- 01 封面 ---
    s = blank(prs)
    rect(s, 0, 0, SLIDE_W, SLIDE_H, fill=PAGE, line=None, radius=False)
    rect(s, 0, 0, SLIDE_W, 2.62, fill=ACCENT, line=None, radius=False)
    _, tf = textbox(s, M, 0.44, W, 0.48)
    para(tf, True, "98wiki ｜ 智见点评 · 行业研究", LABEL, color=ON_DARK_DIM, line=1.2)
    para(tf, False, "居住服务 ｜ 正式稿 v3", LABEL, color=ON_DARK_DIM, line=1.2)
    _, tf = textbox(s, M, 1.02, W, 0.78)
    para(tf, True, "AI 无佣与人机协同：成本承担权之争", HERO - 10, bold=True, color=ON_DARK, line=1.0)
    _, tf = textbox(s, M, 1.84, W, 0.38)
    para(tf, True, "三笔账记在谁的资产负债表上，决定这个业态的最终形状", SUB, color=ON_DARK_DIM, line=1.0)
    _, tf = textbox(s, M, 2.16, W, 0.50)
    para(tf, True, "框架：通用四段式　｜　口径：全国（易居、贝壳业务口径）", LABEL,
         color=ON_DARK_DIM, line=1.2)
    para(tf, False, "时段：2025-09 — 2026-09　｜　2026-09-16", LABEL,
         color=ON_DARK_DIM, line=1.2)

    rect(s, M, 2.86, W, 0.86, fill=PANEL2, line=HAIR)
    rect(s, M, 2.86, 0.05, 0.86, fill=GOLD, line=None, radius=False)
    _, tf = textbox(s, M + 0.22, 2.98, W - 0.44, 0.64)
    rich(tf, True, [("「每一分收入由谁承担，错一单由谁负责。」", True, INK1),
                    ("模型是外生的、人人可得；三笔账是内生的、谁也无法白拿。", False, INK2)], SUB, line=1.3)

    cells = [
        ("245 亿元", "二季度净收入", "引用｜2026-08-21 业绩披露"),
        ("14.6%", "经调整经营利润率，同比 +8.5 个百分点", "引用｜利润 35.9 亿元"),
        ("9338 亿元", "二季度总成交额，同比增长 6.3%", "引用｜二手单量同比 +25%"),
        ("2.26 亿套", "楼盘字典覆盖（挑战方自述口径）", "引用｜2026-05-28 同源声明"),
    ]
    cw, gap = (W - 3 * 0.14) / 4, 0.14
    for i, (big, lbl, src) in enumerate(cells):
        x = M + i * (cw + gap)
        rect(s, x, 3.92, cw, 1.62, fill=BG, line=HAIR)
        _, tf = textbox(s, x + 0.16, 4.06, cw - 0.32, 0.40)
        para(tf, True, big, PAGE_T, bold=True, color=INK1, line=1.0)
        _, tf = textbox(s, x + 0.16, 4.50, cw - 0.32, 0.62)
        para(tf, True, lbl, LABEL, color=INK2, line=1.3)
        _, tf = textbox(s, x + 0.16, 5.14, cw - 0.32, 0.28)
        para(tf, True, src, CAPTION, color=INK3, line=1.2)
    footer(s, "数据来源：12 家公开报道（详见报告来源页）",
           "标注口径：【引用】／【测算】／【研判推断】／【待补】")
    s.notes_slide.notes_text_frame.text = (
        "【来源全表】新浪财经、中房网、钛媒体、证券时报、人民网、新华社、澎湃新闻、21 财经、北京商报、"
        "36 氪、虎嗅、亿欧（2025-09—2026-09 公开报道）；海外制度描述为公开报道口径、未经独立核验。"
        "封面。开场只给一句主基调：这是成本承担权之争。四格数字全部来自二季度披露与同源声明，"
        "口径已在每格下方标注。提醒听众：一边有利润表，一边有说明书，两者当前不可比。")

    # --- 02 卷首速览：五条判断 ---
    s = blank(prs)
    y = header(s, "五条判断：性质、因果、缺口、结构、趋同", kicker="卷首速览",
               sub="一页读完：主基调与当前最大的验证缺口。")
    rows = [
        ("性质", "两条路线不对称：零佣＋按项收费是进攻型重构；武装经纪人是防守型提效。一个在存量佣金池里提效，一个在攻击佣金池本身【研判推断】。"),
        ("因果", "责任划分不清不是「零佣」未获验证的原因，而是它尚未签约的症状：不想承担履约责任，所以只能不收佣金。"),
        ("缺口", "三件可查实物均为【待补】：按项价目与验收标准、履约主体资质与独立性、运营数据（成本／完成率／纠纷率／退费率）。缺的不是责任共识，是责任合同。"),
        ("结构", "渠道会变重，不是变轻；服务者向权属风险、复杂谈判、家庭共同决策三段上移，而非被替代。"),
        ("趋同", "「趋同」是边界条件，不是主基调；以「零佣方是否公布按项收费价目表与验收条款」为标志，并需四项制度前置条件。"),
    ]
    yy = y
    for t, b in rows:
        rect(s, M, yy, W, 0.86, fill=BG, line=HAIR)
        rect(s, M, yy, 0.04, 0.86, fill=GOLD, line=None, radius=False)
        _, tf = textbox(s, M + 0.20, yy + 0.14, 1.05, 0.30)
        para(tf, True, t, MINOR, bold=True, color=INK1, line=1.0)
        _, tf = textbox(s, M + 1.36, yy + 0.12, W - 1.56, 0.64)
        para(tf, True, b, BODY, color=INK2, line=1.45)
        yy += 0.94
    footer(s, "来源：本报告关键性结论（渲染源 v3）", "本页含【研判推断】与【待补】标注")
    s.notes_slide.notes_text_frame.text = "五条判断按「性质—因果—缺口—结构—趋同」排。第三条是全场最该记住的：缺的不是责任共识，是责任合同。"

    # --- 03 关键性结论 ---
    s = blank(prs)
    y = header(s, "关键性结论：成本承担权之争", kicker="01",
               sub="分水岭只有一句：每一分收入由谁承担，错一单由谁负责。")
    card(s, M, y, (W - 0.22) / 2, 2.30, "主基调",
         ["错误建议的责任、线下履约的成本、冷启动的补贴，三笔账记在谁的资产负债表上，决定这个业态的最终形状。",
          "模型是外生的、人人可得；三笔账是内生的、谁也无法白拿。"], tone="soft")
    card(s, M + (W - 0.22) / 2 + 0.22, y, (W - 0.22) / 2, 2.30, "两条路线不对称",
         ["「零佣＋按项收费」：入口定价权的进攻型重构，赌注在按项收费能否覆盖核验与履约成本【研判推断】。",
          "「武装经纪人」：单件履约成本的防守型提效，收益落在经纪人留存与股东利润率上【研判推断】。"], tone="plain")
    card(s, M, y + 2.52, (W - 0.22) / 2, 1.90, "因果顺序必须摆正",
         ["纯居间模式下责任恰恰是清晰的：报告机会、不担结果，履约责任清晰地留在平台之外。",
          "把因果倒过来，会以为补一份责任清单就能验证零佣。"], tone="plain")
    card(s, M + (W - 0.22) / 2 + 0.22, y + 2.52, (W - 0.22) / 2, 1.90, "渠道与趋同",
         ["渠道会变重，不是变轻；服务者向权属风险、复杂谈判、家庭共同决策三段上移。",
          "「趋同」是边界条件，需四项制度前置条件同时具备【研判推断】。"], tone="soft")
    footer(s, "来源：本报告关键性结论", "观点标注【研判推断】")
    s.notes_slide.notes_text_frame.text = "结论页。四格：主基调、性质不对称、因果摆正、渠道与趋同。因果那格是本稿相对旧版的最大修订。"

    # --- 04 关键事实 ---
    s = blank(prs)
    y = header(s, "关键事实：一边抽走脑力环节，一边改写履约成本", kicker="02",
               sub="两家方向相反且互不冲突。")
    card(s, M, y, (W - 0.22) / 2, 2.60, "挑战方：易居·小新",
         ["2026-05-27/28 提出「AI 做居间，成交无佣；服务凭专业，按劳计费」。",
          "楼盘字典超 2.26 亿套【引用】；同源明确「运营数据不足」【引用】。",
          "2026-06-16 钛媒体列五项落地难关；2026-09-08 珠海启动买卖双方公测【引用】。",
          "被抽走的恰是四项无法律责任的脑力环节，核验与签约留在体系外。"], tone="soft", body_line=1.4)
    card(s, M + (W - 0.22) / 2 + 0.22, y, (W - 0.22) / 2, 2.60, "在位方：贝壳",
         ["2026-03-29 撤南北大区，改设十大直属区域，3000 名干部下一线【引用】。",
          "2026-05-08 重仓服务者，52 万经纪人改称「社区客户经理」【引用】。",
          "2026-08-17 线上服务助手成交效率提升 6 倍（北京单城、2026-03 试点、近 10 万人次、AI＋人工）【引用】。",
          "2026-08-21 二季度量、利润、人效同向。"], tone="plain", body_line=1.4)
    rect(s, M, y + 2.82, W, 0.92, fill=PANEL2, line=HAIR)
    _, tf = textbox(s, M + 0.22, y + 2.96, W - 0.44, 0.70)
    rich(tf, True, [("时间轴关键点：", True, INK1),
                    ("03-29 组织先动 → 05-08 身份改写 → 05-27/28 挑战方入场 → 06-16 落地难关 → 08-17 效率指标 → 08-21 利润表 → 09-08 进入公测。",
                     False, INK2)], BODY, line=1.45)
    footer(s, "来源：21 财经、36 氪、虎嗅；新浪财经",
           "人民网 08-24 的 Q2 数值未下发，不补数【待补】")
    s.notes_slide.notes_text_frame.text = "事实页。只放可核验的公开节点；人民网 8-24 的 Q2 数值未下发，明确标【待补】不补数。"

    # --- 05 图 1（原生图表） ---
    s = blank(prs)
    y = header(s, "二季度经营质量：利润率对比条与自洽校验", kicker="图 1",
               sub="纵轴为经调整经营利润率（%），零轴起算，条高 = 数值 ÷ 坐标域上限 15%。")
    cd = CategoryChartData()
    cd.categories = ["上年同期（测算）", "本期（引用）"]
    cd.add_series("经调整经营利润率", (6.1, 14.6))
    ch = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(M), Inches(y + 0.06),
                            Inches(6.2), Inches(3.30), cd).chart
    ch.has_legend = False
    ch.has_title = False
    pl = ch.plots[0]
    pl.gap_width = 120
    pl.has_data_labels = True
    dl = pl.data_labels
    dl.show_value = True
    dl.number_format = '0.0"%"'
    dl.number_format_is_linked = False
    dl.position = XL_LABEL_POSITION.OUTSIDE_END
    dl.font.size = Pt(BODY)
    dl.font.bold = True
    ch.value_axis.minimum_scale, ch.value_axis.maximum_scale = 0, 15
    ch.value_axis.has_major_gridlines = True
    ch.value_axis.major_gridlines.format.line.color.rgb = HAIR
    ch.value_axis.tick_labels.font.size = Pt(CAPTION)
    ch.category_axis.tick_labels.font.size = Pt(CAPTION)
    ch.category_axis.tick_labels.font.name = EA
    ch.category_axis.major_tick_mark = XL_TICK_MARK.NONE
    rx, rw = M + 6.42, W - 6.42
    card(s, rx, y + 0.06, rw, 1.44, "同比差额 +8.5 个百分点",
         ["14.6% − 8.5 个百分点 = 6.1%【测算】。", "改善是量、利润、人效同向出现的，不是单点指标。"], tone="soft")
    card(s, rx, y + 1.64, rw, 1.72, "自洽校验【测算】",
         ["经调整经营利润 35.9 ÷ 净收入 245 ≈ 14.7%（保留一位小数），与披露 14.6% 一致，差异属舍入。",
          "两项均为正文引用数字的算术派生，见文末附图数据说明。"], tone="soft", body_line=1.4)
    footer(s, "来源：二季度业绩披露 2026-08-21（公开报道口径，非审计口径）",
           "本页不含新造数字；派生项标注【测算】")
    s.notes_slide.notes_text_frame.text = "证据页。左边是原生可编辑图表，轴上限 15%，两条绘图高度分别是 40.7% 与 97.3%，几何来自数据本身。"

    # --- 06 3.1 成本树 ---
    s = blank(prs)
    y = header(s, "全流程成本树：AI 只压一段，不压全链", kicker="3.1",
               sub="八段；可压缩性与刚性与否为定性判断【研判推断】，不赋权重、不编数值。")
    rows = [
        ["环节", "主要成本项", "AI 可压缩性", "成本承担方", "刚性／错配"],
        ["获客", "流量采买、线索分发、门店转化", "高（可变成本）", "平台／门店", "非刚性"],
        ["核验", "产权、查封、共有、欠费、学位占用", "低（仅做预检）", "须具名持牌人签字", "刚性；错配最典型"],
        ["匹配", "楼盘字典、推荐、带看路径规划", "高（边际最低）", "平台／算法", "非刚性"],
        ["谈判", "价格与条款博弈、情绪管理", "低（责任关系密集）", "服务者", "刚性"],
        ["带看", "现场时间、交通、钥匙门禁", "低—中", "门店／服务者", "刚性"],
        ["按揭", "资质预审、银行对接、材料合规", "中", "平台＋金融机构", "半刚性"],
        ["过户", "网签、税费、登记、资金监管", "中（流程化不可容错）", "居间机构", "刚性"],
        ["售后", "交房、维修、纠纷兜底", "低", "品牌方／机构", "刚性"],
    ]
    table(s, M, y, W, rows, [0.9, 3.6, 2.1, 2.2, 2.2], row_h=0.40)
    yy = y + 0.40 * len(rows) + 0.12
    rect(s, M, yy, W, 0.72, fill=PANEL3, line=HAIR)
    _, tf = textbox(s, M + 0.22, yy + 0.12, W - 0.44, 0.52)
    rich(tf, True, [("结构判断：", True, ACCENT),
                    ("AI 压缩集中在前四段的可变成本；核验签字、带看、售后三段是刚性成本，只改变由谁承担，不因模型变强而消失【研判推断】。",
                     False, INK2)], BODY, line=1.35)
    footer(s, "来源：本报告 3.1", "核验分项数额无公开数据【待补】；定性判断不赋权重")
    s.notes_slide.notes_text_frame.text = "成本树是全文骨架。核验一格的错配最典型：AI 可以给结论，赔偿责任落不到算法头上。"

    # --- 07 3.2 三重剥离 ---
    s = blank(prs)
    y = header(s, "「6 倍效率」的三重剥离", kicker="3.2",
               sub="三重混淆未剥离，该数字仅作节点效率指标。")
    strips = [
        ("1", "分母口径限定", "分母为「经线上服务助手深度沟通后流转至经纪人的客户」，非全部客源，存在选择偏差；服务本身是「AI＋人工」，名义倍数已混入人工贡献【引用】。"),
        ("2", "同期三项变动叠加", "2026-03-29 组织调整压缩管理层级；二季度二手房单量同比增长 25% 的分母效应；企业自述、无第三方复核。"),
    ]
    yy = y
    for no, t, b in strips:
        rect(s, M, yy, W, 1.10, fill=PANEL2, line=HAIR)
        _, tf = textbox(s, M + 0.20, yy + 0.16, 0.34, 0.30)
        para(tf, True, no, MINOR, bold=True, color=GOLD_INK, line=1.0)
        _, tf = textbox(s, M + 0.62, yy + 0.12, W - 0.84, 0.90)
        para(tf, True, t, MINOR, bold=True, color=INK1, line=1.0, space_after=2)
        para(tf, False, b, BODY, color=INK2, line=1.4)
        yy += 1.20
    rect(s, M, yy, W, 1.00, fill=PANEL3, line=HAIR)
    _, tf = textbox(s, M + 0.22, yy + 0.14, W - 0.44, 0.74)
    rich(tf, True, [("剥离后的用法：", True, ACCENT),
                    ("不可归因 AI，不可外推全链条成本；在补出「未使用 AI 服务者人效」对照组之前，只作方向性证据【研判推断】。",
                     False, INK2)], BODY, line=1.45)
    footer(s, "来源：证券时报、人民网；新浪财经", "结论为【研判推断】")
    s.notes_slide.notes_text_frame.text = "方法论页。剥离之后不给倍数结论，只给用法：方向性证据，不作估值输入，不外推行业。"

    # --- 08 3.3 证据分级 ---
    s = blank(prs)
    y = header(s, "挑战方证据分级与重估阈值", kicker="3.3",
               sub="三者混为「已验证模式」属引用越界。")
    tiers = [
        ("2.26 亿套楼盘字典", "事实 · 成本结构证据", "房源数据结构化已接近完成，搜寻环节的信息成本会持续下降。"),
        ("「成交无佣」", "定位 · 定价策略", "不是已验证的经济模型；可以今天宣布，代价必须明天兑付。"),
        ("「运营数据不足」", "自陈的模型缺口 · 最弱", "按现证据判定：「零佣」是产品定位而非已验证经济模型【研判推断】。"),
    ]
    yy = y
    for t, lv, b in tiers:
        rect(s, M, yy, W, 0.94, fill=BG, line=HAIR)
        _, tf = textbox(s, M + 0.22, yy + 0.14, 3.9, 0.32)
        para(tf, True, t, MINOR, bold=True, color=INK1, line=1.0)
        _, tf = textbox(s, M + 0.22, yy + 0.50, 3.9, 0.28)
        para(tf, True, lv, LABEL, color=GOLD_INK, line=1.0)
        _, tf = textbox(s, M + 4.30, yy + 0.20, W - 4.52, 0.60)
        para(tf, True, b, BODY, color=INK2, line=1.45)
        yy += 1.04
    rect(s, M, yy + 0.04, W, 0.88, fill=PANEL2, line=HAIR)
    _, tf = textbox(s, M + 0.22, yy + 0.18, W - 0.44, 0.62)
    rich(tf, True, [("重估阈值：", True, INK1),
                    ("连续 2 个季度不披露可核验的成交／运营数据，即判定为营销定位。", False, INK2)], BODY, line=1.45)
    footer(s, "来源：中房网、钛媒体、证券时报", "分级为【研判推断】")
    s.notes_slide.notes_text_frame.text = "对称性检查：上一页剥离在位方的 6 倍，这一页剥离挑战方的三项证据；分级只用文字，不给权重百分比。"

    # --- 09 3.4 责任边界矩阵 ---
    s = blank(prs)
    y = header(s, "责任边界矩阵：纵轴定生死", kicker="3.4",
               sub="横轴＝谁给出建议；纵轴＝谁承担履约结果。判断一个模式能否成立只看纵轴。")
    rect(s, M, y, W, 0.62, fill=PANEL3, line=HAIR)
    _, tf = textbox(s, M + 0.20, y + 0.12, W - 0.40, 0.42)
    rich(tf, True, [("读法：", True, ACCENT),
                    ("横轴换多少次模型，都不改变纵轴上的责任落点。", False, INK1)], BODY, line=1.35)
    rows = [
        ["建议责任＼履约责任", "平台承担", "持牌履约方承担", "服务者个人承担"],
        ["纯 AI 建议（无人工复核）", "会计上成立、法律上高风险：须同时具备履约资质与赔付能力（挑战方当前形态）", "须逐项签署委托与验收条款；平台沦为引流方", "不成立：责任链断裂处即纠纷起点"],
        ["AI 建议＋持牌经纪人复核", "人机协同最可能的稳态：平台担算法与数据责任（在位方路线方向）", "合同层须明确「谁签字谁担责」", "须配套建议日志与执业保险"],
        ["纯人工建议", "平台仅提供信息基础设施", "传统居间形态，责任清晰但成本不摊薄", "传统形态，个人信用即风险敞口"],
    ]
    table(s, M, y + 0.76, W, rows, [2.6, 3.8, 3.4, 3.2], row_h=0.78)
    footer(s, "来源：本报告 3.4", "矩阵判断均为【研判推断】")
    s.notes_slide.notes_text_frame.text = "责任矩阵（3×4，第四列第三方机构承担见 PDF 全文）。纵轴定生死：责任落点比模型能力强弱重要得多。"

    # --- 10 3.4 责任链条三处断点 ---
    s = blank(prs)
    y = header(s, "责任链条的三处断点", kicker="3.4",
               sub="最需要盯的三处，也是纠纷的起点。")
    nrows = [
        ("①", "建议与签字分离", "AI 给建议、人签字，若建议日志不可追溯，签字的持牌人承担了非自己生成的判断，责任与权力不匹配。"),
        ("②", "按项收费无验收标准", "按项收费在法律上是把一份佣金拆成 N 份服务合同，每份都需要验收标准、失败退费与赔付上限，否则退化为「收费按项、责任不按项」【研判推断】。"),
        ("③", "资金安全", "若按揭材料、监管资金与过户材料经第三方之手而平台掌握信息流，平台获得资金池影响力却无持牌责任，这一项比佣金高低严重得多。"),
    ]
    yy = y
    for no, t, b in nrows:
        rect(s, M, yy, W, 1.16, fill=BG, line=HAIR)
        _, tf = textbox(s, M + 0.22, yy + 0.16, 0.40, 0.30)
        para(tf, True, no, MINOR, bold=True, color=GOLD_INK, line=1.0)
        _, tf = textbox(s, M + 0.72, yy + 0.14, W - 0.94, 0.94)
        para(tf, True, t, MINOR, bold=True, color=INK1, line=1.0, space_after=2)
        para(tf, False, b, BODY, color=INK2, line=1.4)
        yy += 1.26
    footer(s, "来源：本报告 3.4（责任链条断点）", "第②条为【研判推断】")
    s.notes_slide.notes_text_frame.text = "三处断点里，第三处（资金安全）比佣金高低严重得多：掌握信息流却不承担持牌责任。"

    # --- 11 3.5 制度钥匙 ---
    s = blank(prs)
    y = header(s, "制度钥匙：居间与委托分开谈", kicker="3.5",
               sub="费用没有消失，只是换了主体承担。")
    card(s, M, y, (W - 0.22) / 2, 2.36, "第一把钥匙：居间 vs 委托",
         ["居间只报告机会、不承担结果责任；委托代理才对结果负责。",
          "纯居间模式下「零佣」在会计上成立，原因不是「责任不清」，而是责任清晰地留在平台之外，平台同时放弃了履约报酬。",
          "一旦要为核验、过户、纠纷兜底，费用必然回来。"], tone="soft", body_line=1.4)
    card(s, M + (W - 0.22) / 2 + 0.22, y, (W - 0.22) / 2, 2.36, "第二把钥匙：基础设施",
         ["中国缺少独权代理与跨市场数据共享（MLS）这一层基础设施。",
          "没有它，所有「去佣金」尝试都会退化为费率战——费率之争的底层是责任之争【研判推断】。",
          "落点：建议责任与履约责任分证管理。"], tone="plain", body_line=1.4)
    rect(s, M, y + 2.58, W, 0.92, fill=PANEL2, line=HAIR)
    _, tf = textbox(s, M + 0.22, y + 2.72, W - 0.44, 0.70)
    rich(tf, True, [("操作落点：", True, INK1),
                    ("AI 仅限信息核验与标准化咨询；权属、按揭、签约须由具名持牌人签署并强制投保。", False, INK2)], BODY, line=1.45)
    footer(s, "来源：本报告 3.5", "海外对标为公开报道口径、未经独立核验，仅作方向性对比，不落数字")
    s.notes_slide.notes_text_frame.text = "制度钥匙两把：居间与委托分开谈；独权代理与数据共享的基础设施。收尾落在建议责任与履约责任分证管理。"

    # --- 12 3.6 场景选择器 ---
    s = blank(prs)
    y = header(s, "三类交易场景路线选择器", kicker="3.6",
               sub="同一套技术在三种责任结构下的不同结论。")
    rows = [
        ["场景", "特征", "路线"],
        ["租赁", "标准化最高、单笔金额小、重复率高、纠纷集中于押金与维修", "纯 AI 可先跑通"],
        ["普通二手", "含核验、赎楼、按揭三项持牌环节", "人机混合是唯一稳态"],
        ["高复杂", "继承析产、共有产权、法拍、家庭决策分歧", "人主导；AI 的价值是把信息整理到家庭能吵得下去，不是替家庭决策"],
    ]
    table(s, M, y, W, rows, [1.6, 5.0, 5.4], row_h=0.72)
    footer(s, "来源：本报告 3.6", "场景归类为【研判推断】")
    s.notes_slide.notes_text_frame.text = "把结论落到场景：租赁做纯 AI、普通二手人机混合、高复杂由人主导。"

    # --- 13 3.7 合规风险三题 ---
    s = blank(prs)
    y = header(s, "合规风险三题", kicker="3.7",
               sub="把「中立」从形容词变成规则条款与披露义务，它才是资产。")
    nrows = [
        ("一", "「算法中立」宣传的合规风险", "至少要拆成三份可验证承诺：算法规则可审计、利益关系披露、数据来源可追溯（2.26 亿套是覆盖广度，覆盖广度不等于准确性）【研判推断】。"),
        ("二", "第三方履约的合规风险", "责任切割（「系统说的」不能成为免责事由）、验收与失败退还、资金与个人信息合规；若履约方与平台关联，按项收费实质是集团内利润转移，会同时触发关联交易披露与「中立」自相矛盾。"),
        ("三", "数据偏差风险", "偏差不在覆盖量，而在四类系统性偏差：时效偏差、口径偏差、样本偏差、激励偏差；能被技术缓解，不能被「零佣」消灭【研判推断】。"),
    ]
    yy = y
    for no, t, b in nrows:
        rect(s, M, yy, W, 1.16, fill=BG, line=HAIR)
        _, tf = textbox(s, M + 0.22, yy + 0.16, 0.42, 0.30)
        para(tf, True, no, MINOR, bold=True, color=GOLD_INK, line=1.0)
        _, tf = textbox(s, M + 0.74, yy + 0.14, W - 0.96, 0.94)
        para(tf, True, t, MINOR, bold=True, color=INK1, line=1.0, space_after=2)
        para(tf, False, b, BODY, color=INK2, line=1.4)
        yy += 1.26
    footer(s, "来源：本报告 3.7", "判断为【研判推断】")
    s.notes_slide.notes_text_frame.text = "合规三题：中立宣传、第三方履约、数据偏差。第二题里关联交易是「中立智能体」叙事最脆弱的一环。"

    # --- 14 3.8 趋同四项前置条件 ---
    s = blank(prs)
    y = header(s, "趋同的四项制度前置条件", kicker="3.8",
               sub="趋同不是模型问题，是责任可分配性问题，四项缺一不可【研判推断】。")
    conds = [
        ("1", "建议可追溯", "每条 AI 建议挂责任主体、数据依据与时效，把「双责任主体」从模糊变可追责。"),
        ("2", "价目与验收条款公开", "公开价目、验收标准、失败退费与赔付上限，这也是 Q1 的观测点。"),
        ("3", "履约主体独立且有资质", "履约方须持对应资质并披露与平台的利益关系；平台不宜既是规则制定者又是履约者。"),
        ("4", "数据质量强制标准", "去重规则、时效上限、来源标注、纠错机制可审计：闭环的真实性纪律靠自律，公共的真实性纪律靠制度。"),
    ]
    cw = (W - 3 * 0.16) / 4
    for i, (no, t, b) in enumerate(conds):
        x = M + i * (cw + 0.16)
        rect(s, x, y, cw, 2.40, fill=BG, line=HAIR)
        _, tf = textbox(s, x + 0.18, y + 0.16, cw - 0.36, 0.30)
        para(tf, True, no, MINOR, bold=True, color=GOLD_INK, line=1.0)
        _, tf = textbox(s, x + 0.18, y + 0.52, cw - 0.36, 0.50)
        para(tf, True, t, BODY, bold=True, color=INK1, line=1.3)
        _, tf = textbox(s, x + 0.18, y + 1.10, cw - 0.36, 1.20)
        para(tf, True, b, BODY, color=INK2, line=1.45)
    rect(s, M, y + 2.62, W, 0.90, fill=PANEL2, line=HAIR)
    _, tf = textbox(s, M + 0.22, y + 2.74, W - 0.44, 0.68)
    rich(tf, True, [("另有一项行业基础设施条件：", True, INK1),
                    ("独家委托合同（独权代理）采用率。若仍接近零，趋同只能以费率战的方式完成——这是「趋同」的最坏路径【研判推断】。",
                     False, INK2)], BODY, line=1.45)
    footer(s, "来源：本报告 3.8", "条件与判断为【研判推断】")
    s.notes_slide.notes_text_frame.text = "四项前置条件+一项基础设施条件。这一页也是「趋同」为什么只能算边界条件的原因。"

    # --- 15 3.9 可证伪预言 ---
    s = blank(prs)
    y = header(s, "Q1—Q5 可证伪预言", kicker="3.9",
               sub="把判断写成可被反证的形式。")
    rows = [
        ["编号", "预言内容", "观测点", "判定"],
        ["Q1", "零佣方合同出现按项收费价目与验收退费条款", "合同与官网，12 个月", "未出现→支持营销定位；出现且能覆盖履约成本→本判断被反证"],
        ["Q2", "「中立」转为可审计排序规则与利益披露", "平台规则页，半年", "无→「中立」是合规敞口"],
        ["Q3", "履约主体取得资质且独立于平台", "资质公示，事件驱动", "无→按项收费合法性弱于吸引力"],
        ["Q4", "保险公司对「AI 居间建议」承保并定价", "保险产品，事件驱动", "可保性是当代最重要的制度信号"],
        ["Q5", "独家委托合同采用率仍接近零", "行业协会或抽样", "接近零→成本重组无从谈起"],
    ]
    table(s, M, y, W, rows, [0.9, 4.4, 2.6, 4.4], row_h=0.68)
    footer(s, "来源：本报告 3.9", "判定列为【研判推断】；Q1 覆盖率口径为【测算】")
    s.notes_slide.notes_text_frame.text = "可证伪预言是这份研究最有价值的部分：它把「谁对谁错」变成未来 12 个月可查的观测点。"

    # --- 16 4 收尾 ---
    s = blank(prs)
    y = header(s, "收尾：三条洞察、不确定性、两条边界条件", kicker="04",
               sub="责任机制重构；挤出不是提效；规模不带来摊销。")
    insights = [
        ("洞察 一", "责任机制重构", "行业要从关系型撮合转向可追溯的履约，「谁签字、谁赔付」必须从业务话术变成合同条款。"),
        ("洞察 二", "挤出不是提效", "若经纪人净流出而人均人效上升，那是挤出，不是提效。"),
        ("洞察 三", "规模不带来摊销", "核验、带看、过户是随单量线性增长的人力成本，这是纯 AI 路线的天花板所在。"),
    ]
    yy = y
    for t, k, b in insights:
        rect(s, M, yy, W, 0.86, fill=BG, line=HAIR)
        _, tf = textbox(s, M + 0.22, yy + 0.14, 1.30, 0.28)
        para(tf, True, t, LABEL, bold=True, color=GOLD_INK, line=1.0)
        _, tf = textbox(s, M + 1.60, yy + 0.12, 2.6, 0.30)
        para(tf, True, k, MINOR, bold=True, color=INK1, line=1.0)
        _, tf = textbox(s, M + 4.30, yy + 0.12, W - 4.52, 0.62)
        para(tf, True, b, BODY, color=INK2, line=1.4)
        yy += 0.94
    for t, b in [
        ("边界① 零佣方不公开按项履约价目、不软化「无佣」", "则 4—6 个季度内「趋同」不再成立。"),
        ("边界② 监管按「流程合规」而非「资格资质」确权", "则居间责任分类价值下降；「2026—2027 年内无可承保零佣模型」需同步下修（以强制执业责任保险落地为条件）。"),
    ]:
        rect(s, M, yy + 0.06, W, 0.78, fill=PANEL2, line=HAIR)
        _, tf = textbox(s, M + 0.22, yy + 0.16, W - 0.44, 0.60)
        para(tf, True, t, LABEL, bold=True, color=WARN, line=1.2, space_after=2)
        para(tf, False, b, BODY, color=INK2, line=1.35)
        yy += 0.88
    footer(s, "来源：本报告收尾", "挑战方运营与赔付数据无公开来源【待补】；6 倍不可外推")
    s.notes_slide.notes_text_frame.text = "收尾。边界条件写成可证伪形式：如果零佣方公布完整价目与运营数据，本稿的核心因果判断需重估。"

    # --- 17 观察面板（十项） ---
    s = blank(prs)
    y = header(s, "4—6 季度观察面板（十项）", kicker="4.2",
               sub="观察期设定为【研判推断】；重估阈值为定性判读，未披露指标不新造数值。")
    rows = [
        ["维度", "指标", "口径／频次", "重估阈值"],
        ["定价", "按项收费价目表与验收标准是否公布", "官方发布，季度", "公布→收敛启动；连续 2 季度不披露→判营销定位"],
        ["效率", "人机交接率（AI 可端到端完成占比）", "企业或第三方，季度", "交接率升而返工率同升→人机混岗"],
        ["成本", "单均全链条成本", "分母＝完整成交单", "只披露节点倍数→视为营销口径"],
        ["人效", "人均成交套数与服务者净留存率", "财报／调研，季度", "净流出＋人效升→挤出而非提效"],
        ["渗透", "AI 使用服务者覆盖率", "企业口径，季／半年", "≥50%，须区分强制与自愿使用"],
        ["风险", "核验纠纷率、赔付金额、返工率", "诉讼与投诉抽样", "搜寻成本降而返工率升→履约成本转移"],
        ["制度", "居间责任分类与强制 E&O／保证金规则", "监管文件，事件驱动", "出台→责任分证管理落地"],
        ["制度", "AI 建议责任归属的处罚或判例", "监管／司法，事件驱动", "出现判例→定价权重估"],
        ["制度", "「AI 居间建议」可保性与承保定价", "保险产品，事件驱动", "不可承保→履约承诺无兜底（Q4）"],
        ["结构", "独家委托合同采用率", "行业协会或抽样", "接近零→MLS 式成本重组无从谈起（Q5）"],
    ]
    table(s, M, y, W, rows, [1.0, 3.9, 2.6, 5.5], row_h=0.40)
    footer(s, "来源：本报告 4.2（十项观察面板）", "含新增项：可保性、独家委托采用率")
    s.notes_slide.notes_text_frame.text = "观察面板是下一次复核清单，共十项，其中制度类三项、结构类一项。刻意不设数值阈值。"

    # --- 18 来源与留痕 ---
    s = blank(prs)
    y = header(s, "来源、标注口径与未采用数字留痕", kicker="来源与留痕",
               sub="未采用数字留痕随稿保留。")
    card(s, M, y, (W - 0.22) / 2, 2.20, "标注口径",
         ["【引用】公开报道；【测算】模型推算；【研判推断】分析性判断；【待补】数据不可得、进观察面板不补编。",
          "图 1 两项条高与自洽校验均为正文引用数字的算术派生，标注【测算】。"], tone="soft", body_line=1.45)
    card(s, M + (W - 0.22) / 2 + 0.22, y, (W - 0.22) / 2, 2.20, "数据来源",
         ["新浪财经、中房网、钛媒体、证券时报、人民网、新华社、澎湃新闻、21 财经、北京商报、36 氪、虎嗅、亿欧（2025-09—2026-09 公开报道）。",
          "海外制度描述为公开报道口径、未经独立核验。"], tone="plain", body_line=1.45)
    rect(s, M, y + 2.42, W, 1.86, fill=PANEL2, line=HAIR)
    _, tf = textbox(s, M + 0.22, y + 2.56, W - 0.44, 1.60)
    para(tf, True, "未采用数字留痕（防编造）", MINOR, bold=True, color=INK1, line=1.0, space_after=4)
    para(tf, False, "①「存量住房资产 250 万亿元」未核到可靠来源（可核第三方为 2021 年口径约 418 万亿元，时点差异大），正文改用「存量流通」表述；",
         BODY, color=INK2, line=1.4, space_after=2)
    para(tf, False, "②「核验约 40 项」无公开权威清单，改为定性列举；",
         BODY, color=INK2, line=1.4, space_after=2)
    para(tf, False, "③人均年成交 2—3 单、套均 400 万元、费率 2.5—3%、单位可变成本降 10—20% 均系量级估算，正式稿不引用具体数值，仅保留方法框架。",
         BODY, color=INK2, line=1.4)
    footer(s, "免责：行业研究，不构成投资建议；测算／研判推断非官方统计", "本报告未新造数字")
    s.notes_slide.notes_text_frame.text = (
        "留痕页。未采用数字留痕是防编造声明，必须随稿保留：四个未核实或量级估算的数值全部列出并说明为何不引用。")
    return prs


def main():
    prs = build()
    prs.save(OUT)
    print(json.dumps({"out": str(OUT), "slides": len(prs.slides._sldIdLst),
                      "sha256": hashlib.sha256(OUT.read_bytes()).hexdigest()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
