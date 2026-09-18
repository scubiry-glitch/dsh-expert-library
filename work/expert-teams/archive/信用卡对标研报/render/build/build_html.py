# -*- coding: utf-8 -*-
"""
渲染岗构建脚本：冻结 md → 单文件 HTML（finesse-ui · policy-print register）
铁律：不改 md 任何文字/数字；正文由 markdown 库自动转换，仅注入视觉结构。
"""
import re, hashlib, pathlib

BASE = pathlib.Path("/root/zhijian/dsh-expert-library/work/expert-teams/信用卡对标研报")
SRC = BASE / "研报主文_信用卡对标_20260830.md"
OUT = BASE / "render" / "研报主文_信用卡对标_20260830.html"

md_text = SRC.read_text(encoding="utf-8")
md5_before = hashlib.md5(SRC.read_bytes()).hexdigest()
assert md5_before == "8dd471a098b4a3fa5cacca8f94af11c3", f"md5 变动！{md5_before}"

# ---------- 1) 预处理：四级标注 token 化；转义裸 "<"（md 无合法 HTML） ----------
LV = {"测算": "lv1", "估算": "lv2", "研判推断": "lv3", "待补": "lv4"}
n_lv = 0
def _lv(m):
    global n_lv; n_lv += 1
    return "{{%s}}" % m.group(1)
md_pre = re.sub(r"`(测算|估算|研判推断|待补)`", _lv, md_text)
assert md_pre.count("`") == 0, "存在未识别的反引号"
md_pre = md_pre.replace("<", "&lt;")

import markdown
body_html = markdown.markdown(md_pre, extensions=["tables"])
body_html = re.sub(r"\{\{(测算|估算|研判推断|待补)\}\}",
                   lambda m: '<span class="lv %s">%s</span>' % (LV[m.group(1)], m.group(1)),
                   body_html)

# ---------- 2) 摘出 h1 与顶部引言（主线/数据期/口径）→ 封面/卷首 meta ----------
body_html = re.sub(r"<h1>.*?</h1>\s*", "", body_html, count=1, flags=re.S)
m_top = re.search(r"<blockquote>\s*<p>(.*?)</p>\s*</blockquote>", body_html, re.S)
meta_line = m_top.group(1)
body_html = body_html[:m_top.start()] + body_html[m_top.end():]

# ---------- 3) 按 <h2> 切节 ----------
parts = re.split(r"<h2>(.*?)</h2>", body_html)
parts[0] = re.sub(r"^\s*(<hr\s*/?>\s*)+", "", parts[0])
assert parts[0].strip() == "", "h2 前有残余内容：" + parts[0][:120]
titles = [t.strip() for t in parts[1::2]]
sects = parts[2::2]
assert len(titles) == 9, titles

RUN = ["卷首速览", "总论", "第一章 · 单位经济对标", "第二章 · 产品要素对标",
       "第三章 · 风险生成对标", "第四章 · 客群端破局", "第五章 · 产品端破局",
       "总结", "来源披露"]

# ---------- 4) 点睛图（CSS-only；数字全部 md 在案） ----------
def T(tpl, **kw):
    for k, v in kw.items():
        tpl = tpl.replace("@" + k + "@", str(v))
    assert "@" not in tpl, "未替换占位符：" + tpl[tpl.find("@"):tpl.find("@") + 40]
    return tpl

def chart_city():
    # 总论 城商行 YTD（亿元）：scale 86%/70亿，零轴 87%（左负右正）
    rows = [("江苏银行", -70, True), ("宁波银行", -31, False), ("北京银行", -23, False),
            ("南京银行", -15, False), ("上海银行", 8, False)]
    out = []
    for name, v, hl in rows:
        w = abs(v) * 86.0 / 70.0
        wz = w / 87.0 * 100 if v < 0 else w / 13.0 * 100
        side = "neg" if v < 0 else "pos"
        bar = T('<span class="dbar @cls@@hl@" style="width:@wz@%"></span>',
                cls="dn" if side == "neg" else "dp", hl=" hl" if hl else "", wz="%.2f" % wz)
        val = ("+" if v > 0 else "") + str(v) + " 亿"
        out.append(T(
            '<div class="drow@rhl@"><span class="dlabel">@name@</span>'
            '<span class="dzone dz-neg">@bneg@</span><span class="dzone dz-pos">@bpos@</span>'
            '<span class="dval @vc@">@val@</span></div>',
            rhl=" hl" if hl else "", name=name,
            bneg=bar if side == "neg" else "", bpos=bar if side == "pos" else "",
            vc="neg" if v < 0 else "pos", val=val))
    return T(
        '<figure class="chart" id="fig-city"><figcaption class="chart-title">'
        '点睛图 · 五家城商行信用卡余额 YTD 变动（7/31 口径，亿元）</figcaption>'
        '@out@'
        '<figcaption class="chart-cap">江苏 -70 亿最深，上海银行 +8 亿（7 月单月 +4 亿率先转正）'
        '——先出清者先企稳（<span class="lv lv3">研判推断</span>，上海银行为单一样本，参照不等于结论）。</figcaption></figure>',
        out="".join(out))

def chart_eva():
    # 第一章 EVA 零轴发散条：scale 24%/1pct，零轴 75%（左负右正）
    rows = [("网贷", 0.91), ("个贷合计", 0.19), ("经营贷", -0.04), ("房贷", -0.08),
            ("消费贷", -0.60), ("信用卡", -2.85), ("卡部随e贷", -2.93)]
    out = []
    for name, v in rows:
        w = abs(v) * 24.0
        wz = w / 74.0 * 100 if v < 0 else w / 25.0 * 100
        side = "neg" if v < 0 else "pos"
        hl = " hl" if name == "信用卡" else ""
        bar = T('<span class="dbar @cls@@hl@" style="width:@wz@%"></span>',
                cls="dn" if side == "neg" else "dp", hl=hl, wz="%.2f" % wz)
        val = ("+" if v > 0 else "") + "%.2f" % v + "%"
        out.append(T(
            '<div class="drow@rhl@"><span class="dlabel">@name@</span>'
            '<span class="dzone dz-neg">@bneg@</span><span class="dzone dz-pos">@bpos@</span>'
            '<span class="dval @vc@">@val@</span></div>',
            rhl=hl, name=name,
            bneg=bar if side == "neg" else "", bpos=bar if side == "pos" else "",
            vc="neg" if v < 0 else "pos", val=val))
    return T(
        '<figure class="chart" id="fig-ch1"><figcaption class="chart-title">'
        '点睛图 · 个贷各产品综合净收益率 EVA（2026-06-30 计财部分产品 EVA，内部披露）</figcaption>'
        '<div class="dhead"><span class="dlabel"></span>'
        '<span class="dzone dz-neg dhead-cell">EVA＜0</span>'
        '<span class="dzone dz-pos dhead-cell">EVA＞0</span>'
        '<span class="dval"></span></div>'
        '@out@'
        '<figcaption class="chart-cap">EVA -2.85% 为个贷最差之一，仅优于卡部随e贷（-2.93%），'
        '低于个贷合计 +0.19% 达 3.04pct（<span class="lv lv1">测算</span>）；'
        '深色条为本行信用卡。</figcaption></figure>',
        out="".join(out))

def chart_balance():
    # 第二章 余额同比（%）：全负，零轴 92%，scale 90%/22pct
    rows = [("浦发", -2.77), ("民生", -6.01), ("邮储", -9.55), ("江苏（官方口径）", -21.09)]
    out = []
    for name, v in rows:
        wz = abs(v) * 90.0 / 22.0 / 92.0 * 100
        hl = " rowhl" if name.startswith("江苏") else ""
        out.append(T(
            '<div class="drow@rhl@"><span class="dlabel dlabel-w">@name@</span>'
            '<span class="dzone dz-full"><span class="dbar dn@hl@" style="width:@wz@%"></span></span>'
            '<span class="dval neg">@vv@%</span></div>',
            rhl=" hl" if hl else "", name=name, hl=hl, wz="%.2f" % wz, vv="%.2f" % v))
    return T(
        '<figure class="chart" id="fig-ch2"><figcaption class="chart-title">'
        '点睛图 · 2026H1 信用卡余额同比变动（%，<span class="lv lv1">测算</span>）</figcaption>'
        '@out@'
        '<figcaption class="chart-cap">三家披露行 2026H1 余额全收缩、幅度分化；江苏官方口径上半年 '
        '-60.58 亿（-21.09%），五家城商行中收缩最深；周报趋势线 220.4 亿（2026-08-13）。</figcaption></figure>',
        out="".join(out))

def chart_risk():
    # 第三章 存量 vs 流量：scale 4.5%
    W = lambda v: v / 4.5 * 100
    rows = [
        ("邮储银行", (1.45, "1.45%"), (3.68, "生成率 3.68%")),
        ("浦发银行", (2.01, "2.01%"), None),
        ("民生银行", (4.22, "4.22%"), None),
        ("江苏银行", None, (4.37, "还原 4.37%")),
    ]
    out = []
    for name, a, b in rows:
        cells = []
        for item, kind in ((a, "r1"), (b, "r2")):
            if item is None:
                cells.append(T('<span class="pz"><span class="pbar-miss"></span>'
                               '<span class="pmiss">@lab@</span></span>',
                               lab="未单独披露" if kind == "r1" else "未披露"))
            else:
                v, lab = item
                wp = W(v)
                pos = "right:6px" if wp > 86 else "left:%.2f%%" % (wp + 1.2)
                cells.append(T(
                    '<span class="pz"><span class="pbar @kind@" style="width:@wp@%"></span>'
                    '<span class="pval@pv@" style="@pos@">@lab@</span></span>',
                    kind=kind, wp="%.2f" % wp,
                    pv=" pvin" if wp > 86 else "", pos=pos, lab=lab))
        out.append(T('<div class="prow"><span class="dlabel dlabel-w">@name@</span>'
                     '<span class="pstack">@cells@</span></div>',
                     name=name, cells="".join(cells)))
    legend = ('<div class="legend"><span><i class="sw r1"></i>名义不良率（时点存量）</span>'
              '<span><i class="sw r2"></i>不良生成率 / 还原损失率（流量，年化）</span></div>')
    return T(
        '<figure class="chart" id="fig-ch3"><figcaption class="chart-title">'
        '点睛图 · 不良率是后视镜，生成率才是仪表盘（2026H1，%）</figcaption>'
        '@out@@legend@'
        '<figcaption class="chart-cap">同业不良率=名义口径，江苏 4.37%=还原口径（含核销出表损失），'
        '口径不同只做量级对照，不做伪精确排名；邮储生成率 3.68%（+0.62pct）为个贷各类升幅最大。</figcaption></figure>',
        out="".join(out), legend=legend)

def chart_waterfall():
    # 第四章 UE 分解瀑布：range[-3.4, 5.6]，pos(v)=(v+3.4)/9；列心 9.5+i*20.25%
    P = lambda v: (v + 3.4) / 9.0 * 100
    cols = [
        ("客户收益率", 0.0, 4.90, "4.90%", "base"),
        ("资金+运营成本", 4.90, 2.60, "-2.30", "dec"),
        ("风险成本", 2.60, -1.77, "-4.37", "dec risk"),
        ("资本成本", -1.77, -2.85, "-1.08", "dec"),
        ("综合净收益率 EVA", 0.0, -2.85, "-2.85%", "total"),
    ]
    cells, conns = [], []
    for idx, (name, start, end, lab, kind) in enumerate(cols):
        lo, hi = min(start, end), max(start, end)
        bot, h = P(lo), P(hi) - P(lo)
        lbot = min(P(hi) + 2.2, 96)
        cells.append(T(
            '<span class="wfcol"><span class="wfbar @kind@" style="bottom:@bot@%;height:@h@%"></span>'
            '<span class="wflab" style="bottom:@lbot@%">@lab@</span></span>',
            kind=kind, bot="%.2f" % bot, h="%.2f" % h, lbot="%.2f" % lbot, lab=lab))
        if idx < 4:
            conns.append(T('<span class="wfconn" style="bottom:@b@%;left:@l@%"></span>',
                           b="%.2f" % P(end), l="%.2f" % (9.5 + idx * 20.25)))
    names = "".join("<span>%s</span>" % c[0] for c in cols)
    return T(
        '<figure class="chart" id="fig-ue"><figcaption class="chart-title">'
        '点睛图 · UE 恒等式分解瀑布（每 1 亿余额·年化，%）</figcaption>'
        '<div class="wfbody"><span class="wfzero" style="bottom:@z@%"><i>0</i></span>@conns@@cells@</div>'
        '<div class="wfnames">@names@</div>'
        '<figcaption class="chart-cap">验算 4.90−2.30−4.37−1.08=−2.85（UE 表披露/<span class="lv lv1">测算</span>）；'
        '变量集中在风险成本：客户收益率 4.90%（-0.20pct）仍居个贷第二高，风险成本 4.37%（+0.25pct）上行。</figcaption></figure>',
        z="%.2f" % P(0), conns="".join(conns), cells="".join(cells), names=names)

def chart_mixshift():
    # 第四章 mix-shift 情景对比：scale 4.6%，过线 1.52%
    W = lambda v: v / 4.6 * 100
    rows = [
        ("当前", "风险成本 4.37%", 4.37, 40.1,
         "高风险口袋 w=23% × 7.61% ＋ 其他客群 (1−w) × 3.4% → 4.37%", ""),
        ("减亏情景", "加权 2.47%（未过线）", 2.47, 30.8,
         "口袋 23%→10%（≈29 亿）× 7.61% ＋ 正常客群 3.4%→1.9% → 2.47%", "warn"),
        ("重启情景", "加权约 1.53%（过线）", 1.53, 14.9,
         "口袋→3%（≈6.8 亿）× 7.61% ＋ 正常客群 →1.34% → 1.53%", "pass"),
    ]
    out = []
    for name, head, total, share, cap, tone in rows:
        out.append(T(
            '<div class="mrow"><div class="mhead"><b>@name@</b><span class="mtag@tone@">@head@</span></div>'
            '<div class="mtrack"><span class="mbar" style="width:@w@%">'
            '<span class="mseg mseg-a" style="width:@s@%"></span>'
            '<span class="mseg mseg-b"></span></span></div>'
            '<div class="mcap">@cap@</div></div>',
            name=name, tone=(" " + tone) if tone else "", head=head,
            w="%.2f" % W(total), s="%.2f" % share, cap=cap))
    return T(
        '<figure class="chart" id="fig-mix"><figcaption class="chart-title">'
        '点睛图 · mix-shift 双杠杆情景对比（风险成本加权，%）</figcaption>'
        '<div class="legend"><span><i class="sw mseg-a"></i>高风险口袋贡献 w×7.61%（卡部随e贷级）</span>'
        '<span><i class="sw mseg-b"></i>正常客群贡献</span></div>'
        '<div class="mbody"><span class="mline" style="left:@l@%"><i>过线 ≤1.52pct（无中收）</i></span>@out@</div>'
        '<figcaption class="chart-cap">图注：情景测算，非预测；29 亿压降按官方 226.6 亿基数推演，'
        '回收须按 Vintage 分层，防误伤口袋内优质尾部。</figcaption></figure>',
        l="%.2f" % W(1.52), out="".join(out))

def chart_grips():
    grips = [
        ("①汽车分期", "1", "综合收益 4.1%-4.7%（客户实付+返佣），高档返佣+场景降险至 1% 可达标（EVA≈+0.32%）；低档不过线",
         "11.3/18.1 亿（226.6 亿×5%/8%）"),
        ("②年费卡中收", "2", "零风险敞口、直接加 EVA 分子（中收率+0.5pct=EVA+0.5pct）；规模受客群质量约束",
         "0.5pct≈1.13 亿/年"),
        ("③贴息账单分期", "3", "前置条件：UE&lt;0 时放规模=放大亏损，须先降险（&lt;1.52%）后放量",
         "渗透率驱动，弹性大"),
        ("④交易经营", "4", "不占信贷敞口、只加分子；本行数据缺失，先建仪表盘",
         "数据基建到位后见效"),
    ]
    def card(g):
        name, pri, ue, elas = g
        return T('<div class="gcard"><div class="ghead"><b>@name@</b>'
                 '<span class="gpri">优先级 @pri@</span></div>'
                 '<div class="grow"><span class="gk">UE 达标判定</span><span class="gv">@ue@</span></div>'
                 '<div class="grow"><span class="gk">规模弹性</span><span class="gv">@elas@</span></div></div>',
                 name=name, pri=pri, ue=ue, elas=elas)
    rows = ('<div class="grow-row">%s</div><div class="grow-row">%s</div>'
            % (card(grips[0]) + card(grips[1]), card(grips[2]) + card(grips[3])))
    return T(
        '<figure class="chart" id="fig-grips"><figcaption class="chart-title">'
        '点睛图 · 四抓手 UE 排序卡阵（<span class="lv lv3">研判推断</span>，供议事排序而非精确打分）</figcaption>'
        '@rows@'
        '<figcaption class="chart-cap">收口仍为「先过线，再放量」；过线=综合收益 ≥ 风险成本+3.38pct（见第四章演绎一）。</figcaption></figure>',
        rows=rows)

CHARTS = {1: [chart_city()], 2: [chart_eva()], 3: [chart_balance()],
          4: [chart_risk()], 5: [chart_waterfall(), chart_mixshift()], 6: [chart_grips()]}

# ---------- 5) 章节内结构变换 ----------
def build_capsules(html):
    """**机会与风险**：机会——X；风险——Y。 → 虚线胶囊（字符全保留）"""
    pat = re.compile(r"<p><strong>机会与风险</strong>：(机会——)(.*?)(；)(风险——)(.*?)</p>", re.S)
    def rep(m):
        return ('<div class="or-wrap"><span class="or-label">机会与风险：</span>'
                '<span class="cap cap-opp"><b>%s</b>%s</span>%s'
                '<span class="cap cap-risk"><b>%s</b>%s</span></div>'
                % (m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)))
    html, n = pat.subn(rep, html)
    return html, n

CHIP = re.compile(r"<strong>(推论 \d+b?|归纳[一二三]|演绎[一二三四五六])")
capsule_count = 0
final_secs = []
for i, (title, sec) in enumerate(zip(titles, sects)):
    sec = re.sub(r"<p><strong>点睛图建议</strong>：.*?</p>", "", sec, flags=re.S)  # 已实现为点睛图
    sec = re.sub(r"<hr\s*/?>\s*$", "", sec.strip())  # 章节分隔线交给版式
    # 表格分类
    if i == 0:
        sec = sec.replace("<table>", '<table class="ov-table">', 1)
    if 2 <= i <= 6:
        sec = re.sub(r"<p><strong>角色对照卡</strong></p>(\s*)<table>",
                     r'<p class="blk-label"><strong>角色对照卡</strong></p>\1<table class="role-table">', sec)
        sec = re.sub(r"<p><strong>事实依据", '<p class="facts"><strong>事实依据', sec)
        sec = re.sub(r"<p><strong>UE 判定框", '<p class="blk-label"><strong>UE 判定框', sec)
        m = re.search(r"<p><strong>推论与数据</strong>(?:（[^<]*）)?</p>\s*<ul>", sec)
        if m:
            sec = sec[:m.end()] + '<ul class="inferences">' + sec[m.end():]
    if i == 5:
        sec = sec.replace("<table>", '<table class="ue-table">', 1)   # UE 判定框
        sec = sec.replace("<table>", '<table class="ue-table">', 1)   # UE 恒等式分解表
    if i == 6:
        sec = sec.replace("<table>", '<table class="grip-table">', 1)  # 四抓手排序表
    if i == 0:
        sec = re.sub(r"<p><strong>风险一览</strong>", '<p class="risk-strip"><strong>风险一览</strong>', sec)
        m = re.search(r"<p><strong>核心判断（3 行）</strong></p>\s*<ol>", sec)
        if m:
            sec = sec[:m.end()] + '<ol class="core-list">' + sec[m.end():]
    if i == 4:
        sec = re.sub(r"<p><strong>止损/重启信号体系", '<p class="panel signals"><strong>止损/重启信号体系', sec)
    if i == 5:
        sec = re.sub(r"<p><strong>责任主体与观察指标", '<p class="panel gov"><strong>责任主体与观察指标', sec)
    if i == 7:
        sec = re.sub(r"<p><strong>边界与前提</strong>", '<p class="panel bounds"><strong>边界与前提</strong>', sec)
    if i == 8:
        sec = sec.replace("<ul>", '<ul class="sources">', 1)
    # 推论编号 chip / 边界句 / 机会风险胶囊
    sec = CHIP.sub(r'<span class="chip">\1</span>', sec)
    sec = sec.replace("<strong>边界句：", '<strong class="edge">边界句：')
    sec, n_cap = build_capsules(sec)
    capsule_count += n_cap
    # 插入点睛图（机会与风险胶囊之后；总论无胶囊则附节尾）
    if i in CHARTS:
        charts = "\n".join(CHARTS[i])
        if 'or-wrap' in sec:
            j = sec.rfind('</div>\n<div class="or-wrap">')
            k = sec.find("</div>", sec.find('<div class="or-wrap">'))
            # 找 or-wrap 的收口：从 or-wrap 起第一个 "</div>\n" 之后
            start = sec.find('<div class="or-wrap">')
            k = sec.find("</div>", start) + len("</div>")
            sec = sec[:k] + charts + sec[k:]
        else:
            sec = sec + charts
    if i == 0:
        sec = '<p class="meta-line">%s</p>\n' % meta_line + sec
    # 重建 h2（版式化 + bookmark-label 保留原文）
    t = title
    m = re.match(r"^(第[一二三四五]章)\s*(.+)$", t)
    if m:
        no, rest = m.group(1), m.group(2)
    elif i in (1, 7) and "：" in t:
        no, rest = t.split("：", 1)
    else:
        no, rest = t, ""
    if i in (0, 8):
        h2 = ('<h2 class="sheet-title" id="s%d" data-run="%s" data-full="%s">'
              '<span class="ch-no">%s</span></h2>' % (i, RUN[i], t, t))
    else:
        h2 = ('<h2 class="sheet-title" id="s%d" data-run="%s" data-full="%s">'
              '<span class="ch-no">%s</span><span class="ch-title">%s</span></h2>'
              % (i, RUN[i], t, no, rest))
    final_secs.append(h2 + "\n" + sec)

assert capsule_count == 5, f"机会与风险胶囊应为 5 处，实为 {capsule_count}"
content_html = "\n".join(final_secs)

# ---------- 6) 封面 / 封底 / 左轨 ----------
COVER = '''
<section class="cover" id="cover">
  <div class="cv-top">
    <span class="brand">99wiki ｜ 智见点评 · 行业研究</span>
    <span class="stamp">行内材料 · 勿外发</span>
  </div>
  <div class="cv-band"></div>
  <p class="cv-title">江苏银行信用卡业务对标研报</p>
  <p class="cv-sub">2026 中报季 · 产品对标 × 单位经济 × 风险生成 × 客群/产品破局</p>
  <p class="cv-ver"><span>完整报告 v1 · 2026-08-30</span></p>
  <div class="cv-quote">余额的收缩是全行业的，风险成本的收缩才是自己的。</div>
  <div class="numstrip">
    <div class="numcell"><div class="num">-2.85%</div><div class="nl">EVA · 综合净收益率</div><div class="nn">2026-06-30 产品 EVA 表（-0.27pct）</div></div>
    <div class="numcell"><div class="num">-21.09%</div><div class="nl">信用卡余额 · 上半年</div><div class="nn">官方口径 -60.58 亿（约 287.2→226.6 亿）</div></div>
    <div class="numcell"><div class="num">3.68%</div><div class="nl">不良生成率 · 邮储</div><div class="nn">年化，+0.62pct，个贷各类升幅最大</div></div>
    <div class="numcell"><div class="num">1.52%</div><div class="nl">无中收过线阈值</div><div class="nn">无中收时风险成本须 ≤1.52pct（<span class="lv lv1">测算</span>）</div></div>
  </div>
  <div class="cv-nav">
    <span>卷首速览</span><span>总论</span><span>第一章 单位经济对标</span><span>第二章 产品要素对标</span><span>第三章 风险生成对标</span><span>第四章 客群端破局</span><span>第五章 产品端破局</span><span>总结</span><span>来源披露</span>
  </div>
</section>'''

BACK = '''
<section class="backcover" id="backcover">
  <div class="bk-inner">
    <p class="bk-label">收束金句</p>
    <p class="bk-quote">余额的收缩是全行业的，风险成本的收缩才是自己的——把风险成本收到 2.5% 以内是减亏，收到 1.5% 是重启，中间隔着的不是规模，是客群与模型。</p>
    <div class="bk-block">
      <div class="bkrow"><span class="bk">版本</span><span>完整报告 v1</span></div>
      <div class="bkrow"><span class="bk">日期</span><span>2026-08-30</span></div>
      <div class="bkrow"><span class="bk">数据期</span><span>2026H1（半年报）+ 2026-08-13（内部周报）</span></div>
      <div class="bkrow"><span class="bk">口径</span><span>信用卡及透支（各行披露口径，差异处已注明）</span></div>
      <div class="bkrow"><span class="bk">质量门禁</span><span>G1 · G2 Final v2 PASS</span></div>
    </div>
    <p class="bk-disclaim">行业研究，不构成投资建议；测算/估算/研判推断非官方统计</p>
    <p class="bk-brand">99wiki ｜ 智见点评 · 行业研究</p>
  </div>
</section>'''

RAIL = '''
<nav class="rail" aria-hidden="true">
  <div class="rail-brand">99wiki</div>
  <div class="rail-sub">智见点评 · 行业研究</div>
  <span class="rail-stamp">行内材料 · 勿外发</span>
  <ol class="rail-nav">
    <li><a href="#s0"><i>00</i>卷首速览</a></li>
    <li><a href="#s1"><i>01</i>总论</a></li>
    <li><a href="#s2"><i>02</i>第一章 单位经济对标</a></li>
    <li><a href="#s3"><i>03</i>第二章 产品要素对标</a></li>
    <li><a href="#s4"><i>04</i>第三章 风险生成对标</a></li>
    <li><a href="#s5"><i>05</i>第四章 客群端破局</a></li>
    <li><a href="#s6"><i>06</i>第五章 产品端破局</a></li>
    <li><a href="#s7"><i>07</i>总结</a></li>
    <li><a href="#s8"><i>08</i>来源披露</a></li>
  </ol>
  <div class="rail-foot">完整报告 v1 · 2026-08-30</div>
</nav>'''

CSS = (BASE / "render" / "build" / "style.css").read_text(encoding="utf-8")

html = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>江苏银行信用卡业务对标研报（2026 中报季）</title>
<style>
{CSS}
</style>
</head>
<body>
{RAIL}
{COVER}
<main class="doc">
{content_html}
</main>
{BACK}
</body>
</html>'''

OUT.write_text(html, encoding="utf-8")
print("HTML written:", OUT, len(html), "bytes; lv tags:", n_lv, "; capsules:", capsule_count)
