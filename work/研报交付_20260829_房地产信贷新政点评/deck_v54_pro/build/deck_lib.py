#!/usr/bin/env python3
"""deck_lib.py — editorial_ink × financial_report_review 渲染助手库。

theme_tokens 锁定（deck_narrative.md frontmatter）：
  hero 40 / section 30 / page_title 24 / subtitle 16 / minor 14 / body 12 /
  label 10.5 / caption 9 / table 10.5；标题 1.0 倍行距+段前后 0.5 行；正文 1.5 倍行距。
  色板：ink_teal #0E6A55 / amber #A9741F / ink_deep #0A3D32 / text #1F2933 / muted #5B6B73。
直角为默认角语言；无阴影；文字一律写入承载 shape 的 text_frame。
"""
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.lang import MSO_LANGUAGE_ID
from pptx.oxml.ns import qn
import copy

# ---------- tokens ----------
INK_TEAL = RGBColor(0x0E, 0x6A, 0x55)
INK_DEEP = RGBColor(0x0A, 0x3D, 0x32)
AMBER = RGBColor(0xA9, 0x74, 0x1F)
TEXT = RGBColor(0x1F, 0x29, 0x33)
MUTED = RGBColor(0x5B, 0x6B, 0x73)
PAPER = RGBColor(0xFF, 0xFF, 0xFF)
PAPER_WARM = RGBColor(0xF7, 0xF5, 0xF0)
HAIR = RGBColor(0xC9, 0xD2, 0xCE)
RISK_RED = RGBColor(0x8C, 0x3A, 0x2B)   # 警示：仅用于"被切/出局"语义
LIGHT_ON_DARK = RGBColor(0xEF, 0xF4, 0xF1)
GHOST_ON_DARK = RGBColor(0x2A, 0x55, 0x49)

EA_FONT = "宋体"
LATIN_FONT = "Times New Roman"

PAGE_W = 13.333
PAGE_H = 7.5
MARGIN = 0.78
CW = PAGE_W - 2 * MARGIN  # 11.773 内容宽

HERO = 40
SECTION = 30
PAGE_TITLE = 24
SUBTITLE = 16
MINOR = 14
BODY = 12
LABEL = 10.5
CAPTION = 9
TABLE_PT = 10.5


# theme token 字号集（0.5pt 网格）：任何字号就近规范化，防碎片化
_THEME_SIZES = (40, 30, 24, 16, 14, 12, 10.5, 9)


def normalize_size(size):
    return min(_THEME_SIZES, key=lambda t: (abs(t - size), -t))


def _set_font(run, size=BODY, bold=False, color=TEXT, ea=EA_FONT, latin=LATIN_FONT,
              italic=False):
    f = run.font
    f.size = Pt(normalize_size(size))
    f.bold = bold
    f.italic = italic
    f.color.rgb = color
    f.name = latin
    # East Asian 槽位显式写入
    rPr = run._r.get_or_add_rPr()
    for tag in ("a:ea", "a:cs"):
        el = rPr.find(qn(tag))
        if el is None:
            el = rPr.makeelement(qn(tag), {})
            rPr.append(el)
        el.set("typeface", ea)
    try:
        run._r.get_or_add_rPr().set("lang", "zh-CN")
    except Exception:
        pass


def _para(tf, runs, align=PP_ALIGN.LEFT, line=None, before=None, after=None,
          first=False):
    p = tf.paragraphs[0] if first else tf.add_paragraph()
    p.alignment = align
    if line is not None:
        p.line_spacing = line
    if before is not None:
        p.space_before = Pt(before)
    if after is not None:
        p.space_after = Pt(after)
    if isinstance(runs, str):
        runs = [(runs, {})]
    for text, kw in runs:
        r = p.add_run()
        r.text = text
        _set_font(r, **kw)
    return p


def tb(slide, x, y, w, h, paras, anchor=MSO_ANCHOR.TOP, wrap=True):
    """添加文本框。paras: list of dict(runs=[(text,kw)|str], align, line, before, after)"""
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.word_wrap = wrap
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = 0
    tf.margin_top = tf.margin_bottom = 0
    for i, spec in enumerate(paras):
        _para(tf, spec.get("runs", ""), align=spec.get("align", PP_ALIGN.LEFT),
              line=spec.get("line"), before=spec.get("before"),
              after=spec.get("after"), first=(i == 0))
    return box


def rect(slide, x, y, w, h, fill=None, line_color=None, line_w=0.75, dash=None,
         shape=MSO_SHAPE.RECTANGLE):
    sp = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    sp.shadow.inherit = False
    if fill is None:
        sp.fill.background()
    else:
        sp.fill.solid()
        sp.fill.fore_color.rgb = fill
    if line_color is None:
        sp.line.fill.background()
    else:
        sp.line.color.rgb = line_color
        sp.line.width = Pt(line_w)
        if dash:
            ln = sp.line._get_or_add_ln()
            d = ln.find(qn("a:prstDash"))
            if d is None:
                d = ln.makeelement(qn("a:prstDash"), {})
                ln.append(d)
            d.set("val", dash)
    sp.text_frame.word_wrap = True
    sp.text_frame.margin_left = sp.text_frame.margin_right = Inches(0.08)
    sp.text_frame.margin_top = sp.text_frame.margin_bottom = Inches(0.04)
    return sp


def shape_text(sp, paras, anchor=MSO_ANCHOR.MIDDLE):
    """文字直接写入承载 shape（anti-slop：矩形文字不外挂文本框）。"""
    tf = sp.text_frame
    tf.vertical_anchor = anchor
    for i, spec in enumerate(paras):
        _para(tf, spec.get("runs", ""), align=spec.get("align", PP_ALIGN.LEFT),
              line=spec.get("line", 1.0), before=spec.get("before"),
              after=spec.get("after"), first=(i == 0))
    return sp


def hairline(slide, x, y, w, color=HAIR, weight=0.75):
    return rect(slide, x, y, w, 0.014, fill=color)


def vline(slide, x, y, h, color=HAIR, weight=0.75):
    return rect(slide, x, y, 0.014, h, fill=color)


def set_bg(slide, color):
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = color


def footer(slide, idx, total, dark=False, brand="98wiki ｜ 智见点评 · 行业研究"):
    c = MUTED if not dark else RGBColor(0x8F, 0xB5, 0xA8)
    hairline(slide, MARGIN, 7.06, CW, color=(HAIR if not dark else GHOST_ON_DARK))
    tb(slide, MARGIN, 7.12, 6.0, 0.3,
       [{"runs": [(brand, {"size": CAPTION, "color": c})]}])
    tb(slide, PAGE_W - MARGIN - 2.0, 7.12, 2.0, 0.3,
       [{"runs": [(f"{idx:02d} / {total}", {"size": CAPTION, "color": c})],
         "align": PP_ALIGN.RIGHT}])


def page_header(slide, eyebrow, title, dark=False):
    """稳定版心页眉：eyebrow(amber) + 24pt 标题 + hairline。标题像答案。"""
    tb(slide, MARGIN, 0.30, CW, 0.28,
       [{"runs": [(eyebrow, {"size": LABEL, "bold": True, "color": AMBER})]}])
    tb(slide, MARGIN, 0.56, CW, 0.5,
       [{"runs": [(title, {"size": PAGE_TITLE, "bold": True,
                           "color": (PAPER if dark else TEXT)})], "line": 1.0}])
    hairline(slide, MARGIN, 1.12, CW, color=(GHOST_ON_DARK if dark else HAIR))


def quote_block(slide, x, y, w, h, text, size=SUBTITLE, dark=False,
                bar=AMBER, bold=True):
    """金句引言块：4px 左边框 accent 条（编码「章眼」语义）+ 文字写入面板。"""
    rect(slide, x, y, 0.055, h, fill=bar)
    panel = rect(slide, x + 0.055, y, w - 0.055, h,
                 fill=(None if dark else PAPER_WARM))
    shape_text(panel, [{"runs": [(text, {"size": size, "bold": bold,
                                         "color": (LIGHT_ON_DARK if dark else INK_TEAL)})],
                        "line": 1.15}])
    return panel


def clause_tags(slide, x, y, w, items, gap=0.055, size=LABEL, row_h=None):
    """条款依据：琥珀 tag + 正文；items = [(tag, text)]，自动折行估算行高。"""
    cy = y
    for tag, text in items:
        # 估算行数：中文每行约 w/0.16 字（10.5pt）
        chars_per_line = max(8, int((w - 1.05) / 0.152))
        lines = max(1, -(-len(text) // chars_per_line))
        h = row_h or (0.24 * lines + 0.06)
        tg = rect(slide, x, cy, 1.18, 0.22, fill=None, line_color=AMBER, line_w=1.0)
        shape_text(tg, [{"runs": [(tag, {"size": 9, "bold": True, "color": AMBER})],
                         "align": PP_ALIGN.CENTER}], anchor=MSO_ANCHOR.MIDDLE)
        tb(slide, x + 1.28, cy - 0.015, w - 1.28, h,
           [{"runs": [(text, {"size": size, "color": TEXT})], "line": 1.12}])
        cy += h + gap
    return cy


def capsule(slide, x, y, w, h, runs_list, dark=False):
    """机会/风险虚线胶囊：单段落多 runs（避免多段落被估多行）。"""
    cp = rect(slide, x, y, w, h, fill=None,
              line_color=(GHOST_ON_DARK if dark else MUTED), line_w=1.0, dash="dash")
    runs = [(t, {"size": LABEL, "bold": b, "color": c}) for t, c, b in runs_list]
    shape_text(cp, [{"runs": runs, "line": 1.1}], anchor=MSO_ANCHOR.MIDDLE)
    return cp


def ghost(slide, x, y, w, h, text, size=90, color=None):
    """ghost 大字（中文序数/圈数字，避免新增数字 token）。"""
    tb(slide, x, y, w, h,
       [{"runs": [(text, {"size": size, "bold": True,
                          "color": (GHOST_ON_DARK if color is None else color)})],
         "align": PP_ALIGN.RIGHT, "line": 1.0}])


def source_note(slide, x, y, w, text, dark=False, size=CAPTION):
    tb(slide, x, y, w, 0.42,
       [{"runs": [(text, {"size": size, "color": (RGBColor(0x8F, 0xB5, 0xA8) if dark else MUTED)})],
         "line": 1.15}])


# ---------- 原生表格（表格语义） ----------
def native_table(slide, x, y, w, h, headers, rows, col_w, numeric_cols=(),
                 center_cols=(), font_pt=TABLE_PT, header_fill=INK_TEAL,
                 zebra=True, header_color=PAPER):
    n_rows = len(rows) + (1 if headers else 0)
    n_cols = len(col_w)
    gfx = slide.shapes.add_table(n_rows, n_cols, Inches(x), Inches(y),
                                 Inches(w), Inches(h))
    table = gfx.table
    table.first_row = bool(headers)
    table.horz_banding = False
    # 列宽
    total = sum(col_w)
    for i, cwv in enumerate(col_w):
        table.columns[i].width = Emu(int(Inches(w) * cwv / total))
    # 行高
    base_h = Emu(int(Inches(h) / n_rows))
    for r in range(n_rows):
        table.rows[r].height = base_h
    offset = 0
    if headers:
        offset = 1
        for c, htext in enumerate(headers):
            cell = table.cell(0, c)
            cell.fill.solid()
            cell.fill.fore_color.rgb = header_fill
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            cell.margin_left = cell.margin_right = Inches(0.06)
            cell.margin_top = cell.margin_bottom = Inches(0.02)
            tf = cell.text_frame
            tf.word_wrap = True
            _para(tf, [(htext, {"size": font_pt, "bold": True, "color": header_color})],
                  align=PP_ALIGN.CENTER, line=1.0, first=True)
    for r, row in enumerate(rows):
        for c, val in enumerate(row):
            cell = table.cell(r + offset, c)
            cell.fill.solid()
            if zebra and r % 2 == 1:
                cell.fill.fore_color.rgb = PAPER_WARM
            else:
                cell.fill.fore_color.rgb = PAPER
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            cell.margin_left = cell.margin_right = Inches(0.06)
            cell.margin_top = cell.margin_bottom = Inches(0.02)
            # 归零段落缩进（structure_precheck 纪律）
            tf = cell.text_frame
            tf.word_wrap = True
            if c in numeric_cols:
                align = PP_ALIGN.RIGHT
            elif c in center_cols:
                align = PP_ALIGN.CENTER
            else:
                align = PP_ALIGN.LEFT
            bold = (c == 0)
            _para(tf, [(str(val), {"size": font_pt, "bold": bold, "color": TEXT})],
                  align=align, line=1.0, first=True)
            pPr = tf.paragraphs[0]._p.get_or_add_pPr()
            for attr in ("marL", "marR", "indent"):
                pPr.set(attr, "0")
            try:
                tf.paragraphs[0].level = 0
            except Exception:
                pass
    return gfx


# ---------- 原生 chart ----------
def _style_chart_fonts(chart, size=LABEL):
    try:
        chart.font.size = Pt(size)
        chart.font.name = LATIN_FONT
        chart.font.color.rgb = TEXT
    except Exception:
        pass


def line_chart(slide, x, y, w, h, categories, values, series_name,
               color=INK_TEAL, number_format="0.00", label_pt=LABEL):
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION, XL_LABEL_POSITION
    cd = CategoryChartData()
    cd.categories = categories
    cd.add_series(series_name, values)
    gf = slide.shapes.add_chart(XL_CHART_TYPE.LINE_MARKERS, Inches(x), Inches(y),
                                Inches(w), Inches(h), cd)
    ch = gf.chart
    ch.has_legend = False
    _style_chart_fonts(ch)
    ser = ch.series[0]
    ser.format.line.color.rgb = color
    ser.format.line.width = Pt(2.25)
    ser.smooth = False
    plot = ch.plots[0]
    plot.has_data_labels = True
    dl = plot.data_labels
    dl.number_format = number_format
    dl.number_format_is_linked = False
    dl.font.size = Pt(label_pt)
    dl.font.color.rgb = TEXT
    try:
        dl.position = XL_LABEL_POSITION.ABOVE
    except Exception:
        pass
    va = ch.value_axis
    va.has_major_gridlines = True
    va.major_gridlines.format.line.color.rgb = RGBColor(0xE4, 0xE9, 0xE6)
    va.major_gridlines.format.line.width = Pt(0.5)
    va.format.line.color.rgb = HAIR
    va.tick_labels.font.size = Pt(CAPTION)
    ca = ch.category_axis
    ca.format.line.color.rgb = HAIR
    ca.tick_labels.font.size = Pt(LABEL)
    return gf


def bar_chart(slide, x, y, w, h, categories, series_list, colors,
              number_format="0.0", label_pt=LABEL, legend=True,
              gap=60, overlap=-20):
    """series_list = [(name, values)]；负值柱自然向下。"""
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
    cd = CategoryChartData()
    cd.categories = categories
    for name, vals in series_list:
        cd.add_series(name, vals)
    gf = slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(x),
                                Inches(y), Inches(w), Inches(h), cd)
    ch = gf.chart
    _style_chart_fonts(ch)
    ch.has_legend = legend
    if legend:
        ch.legend.position = XL_LEGEND_POSITION.TOP
        ch.legend.include_in_layout = False
        ch.legend.font.size = Pt(LABEL)
    plot = ch.plots[0]
    plot.gap_width = gap
    try:
        plot.overlap = overlap
    except Exception:
        pass
    plot.has_data_labels = True
    dl = plot.data_labels
    dl.number_format = number_format
    dl.number_format_is_linked = False
    dl.font.size = Pt(label_pt)
    dl.font.color.rgb = TEXT
    for i, ser in enumerate(ch.series):
        col = colors[i % len(colors)]
        ser.format.fill.solid()
        ser.format.fill.fore_color.rgb = col
        ser.format.line.fill.background()
    va = ch.value_axis
    va.has_major_gridlines = True
    va.major_gridlines.format.line.color.rgb = RGBColor(0xE4, 0xE9, 0xE6)
    va.major_gridlines.format.line.width = Pt(0.5)
    va.format.line.color.rgb = HAIR
    va.tick_labels.font.size = Pt(CAPTION)
    ca = ch.category_axis
    ca.format.line.color.rgb = HAIR
    ca.tick_labels.font.size = Pt(LABEL)
    return gf


# ---------- 组合件 ----------
def fig_caption(slide, x, y, w, fig_no, title, unit, source, dark=False):
    """研报读图结构：图号｜发现式图题 + 单位 + 来源。"""
    c = TEXT if not dark else LIGHT_ON_DARK
    m = MUTED if not dark else RGBColor(0x8F, 0xB5, 0xA8)
    tb(slide, x, y, w, 0.30,
       [{"runs": [(f"图{fig_no}｜", {"size": LABEL, "bold": True, "color": AMBER}),
                  (title, {"size": LABEL, "bold": True, "color": c})], "line": 1.1}])
    tb(slide, x, y + 0.26, w, 0.26,
       [{"runs": [(unit + "　" + source, {"size": CAPTION, "color": m})], "line": 1.1}])


def qualifier_mark(slide, x, y, text="定性示意"):
    """定性示意角标。"""
    tag = rect(slide, x, y, 0.92, 0.24, fill=PAPER_WARM, line_color=MUTED, line_w=0.75)
    shape_text(tag, [{"runs": [(text, {"size": 9, "color": MUTED})],
                      "align": PP_ALIGN.CENTER}], anchor=MSO_ANCHOR.MIDDLE)
    return tag


def arrow(slide, x, y, w, h, color=INK_TEAL):
    return rect(slide, x, y, w, h, fill=color, shape=MSO_SHAPE.RIGHT_ARROW)


def down_arrow(slide, x, y, w, h, color=INK_TEAL):
    return rect(slide, x, y, w, h, fill=color, shape=MSO_SHAPE.DOWN_ARROW)


def notes(slide, text):
    slide.notes_slide.notes_text_frame.text = text


# ---------- XML 级字体槽位修正（chart/表格/文本 ea 统一） ----------
def fix_ea_fonts(prs, ea=EA_FONT, latin=LATIN_FONT):
    """对全部 slide/chart 部件补写 ea 字体槽位。"""
    from pptx.opc.constants import RELATIONSHIP_TYPE as RT
    parts = [s.part for s in prs.slides]
    for s in prs.slides:
        for shp in s.shapes:
            if shp.has_chart:
                parts.append(shp.chart.part)
    seen = set()
    for part in parts:
        if id(part) in seen:
            continue
        seen.add(id(part))
        try:
            root = part._element
        except AttributeError:
            continue
        for rPr in root.iter():
            tag = rPr.tag
            if tag in (qn("a:rPr"), qn("a:defRPr"), qn("a:endParaRPr")):
                lat = rPr.find(qn("a:latin"))
                if lat is None:
                    continue
                eael = rPr.find(qn("a:ea"))
                if eael is None:
                    eael = rPr.makeelement(qn("a:ea"), {})
                    lat.addnext(eael)
                eael.set("typeface", ea)
