# -*- coding: utf-8 -*-
"""
渲染岗构建脚本（UE 专题 v3 · 客群×产品框架）：冻结 md → 单文件 HTML（finesse-ui · policy-print register）
铁律：不改 md 任何文字/数字；正文由 markdown 库自动转换，仅注入视觉结构；
点睛图内出现的数字全部可在 md 中找到（chart-number fidelity）。
复用 v2 工程（render_ue/build/），v3 增量：
  ① 卷首：总判断金句块 + UE 恒等式总表 + 全文结论表（章|一句话结论|关键数字|点睛图）；
  ② 四章均为「金句引用块首行 → 编号论证链 → 点睛图」，点睛图共 5 张：
     ①恒等式瀑布 ②六行不良率×余额降幅发散条 ③mix-shift 情景对比（1.52 过线虚线）
     ④四抓手卡阵+弹性对比条（2 倍徽章）⑤四杠杆优先级阶梯图（价值比例 2:1:1:0 视觉化，
     比例仅用于高度，不作为数字标注出现——数字标注全部 md 在案）；
  ③ 封面：副标题行「客群×产品框架 · UE 方法论内嵌」/ 版本行 v3 / 四格数字条 / 勿外发角标；
  ④ 封底：第四章金句收束 + 版本块（t12+t12 复验 PASS）+ 免责行。
"""
import re, hashlib, pathlib

BASE = pathlib.Path("/root/zhijian/dsh-expert-library/work/expert-teams/信用卡对标研报")
SRC = BASE / "UE视角分析_信用卡_20260830.md"
OUT = BASE / "render_ue" / "UE视角分析_信用卡_20260830.html"

MD5 = "d2411929ec89f32713c7ba7f6ce74823"
md_text = SRC.read_text(encoding="utf-8")
md5_before = hashlib.md5(SRC.read_bytes()).hexdigest()
assert md5_before == MD5, f"md5 变动！{md5_before}"

# ---------- 1) 预处理：四级标注 token 化；转义裸 "<"（md 无合法 HTML） ----------
LV = {"测算": "lv1", "估算": "lv2", "研判推断": "lv3", "待补": "lv4"}
md_pre = re.sub(r"`(测算|估算|研判推断|待补)`", lambda m: "{{%s}}" % m.group(1), md_text)
assert md_pre.count("`") == 0, "存在未识别的反引号"
md_pre = md_pre.replace("<", "&lt;")

import markdown
body_html = markdown.markdown(md_pre, extensions=["tables"])
body_html = re.sub(r"\{\{(测算|估算|研判推断|待补)\}\}",
                   lambda m: '<span class="lv %s">%s</span>' % (LV[m.group(1)], m.group(1)),
                   body_html)

# ---------- 2) 摘出 h1 与顶部引言（数据期/本文件定位）→ 卷首 meta ----------
body_html = re.sub(r"<h1>.*?</h1>\s*", "", body_html, count=1, flags=re.S)
m_top = re.search(r"<blockquote>\s*<p>(.*?)</p>\s*</blockquote>", body_html, re.S)
meta_line = m_top.group(1)
body_html = body_html[:m_top.start()] + body_html[m_top.end():]

# ---------- 3) 按 <h2> 切节：卷首 + 四章 + 局限与待补 + 来源披露 ----------
parts = re.split(r"<h2>(.*?)</h2>", body_html)
parts[0] = re.sub(r"^\s*(<hr\s*/?>\s*)+", "", parts[0])
assert parts[0].strip() == "", "h2 前有残余内容：" + parts[0][:120]
titles = [t.strip() for t in parts[1::2]]
sects = parts[2::2]
assert len(titles) == 7, titles
assert titles == ["卷首", "第一章 现状诊断：亏在风险端", "第二章 客群端：客群结构是风险成本的配方",
                  "第三章 产品端：先过线，再放量", "第四章 行动：四杠杆节奏",
                  "局限与待补", "来源披露（一段）"], titles

RUN = ["卷首", "第一章 · 现状诊断", "第二章 · 客群端", "第三章 · 产品端",
       "第四章 · 行动", "局限与待补", "来源披露"]

# ---------- 4) 点睛图（CSS-only；数字全部 md 在案） ----------
def T(tpl, **kw):
    for k, v in kw.items():
        tpl = tpl.replace("@" + k + "@", str(v))
    assert "@" not in tpl, "未替换占位符：" + tpl[tpl.find("@"):tpl.find("@") + 40]
    return tpl

def L(lv):
    return '<span class="lv %s">%s</span>' % (LV[lv], lv)

def chart_waterfall():
    # 点睛图① 第一章 UE 恒等式瀑布：range[-3.4, 5.6]，pos(v)=(v+3.4)/9；列心 9.5+i*20.25%
    P = lambda v: (v + 3.4) / 9.0 * 100
    cols = [
        ("客户收益率", 0.0, 4.90, "4.90%", "base"),
        ("资金+运营", 4.90, 2.60, "-2.30", "dec"),
        ("风险成本", 2.60, -1.77, "-4.37", "dec risk"),
        ("资本成本", -1.77, -2.85, "-1.08", "dec"),
        ("EVA", 0.0, -2.85, "-2.85%", "total"),
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
        '点睛图① · UE 恒等式分解瀑布（每 1 亿余额·年化，%）</figcaption>'
        '<div class="wfbody"><span class="wfzero" style="bottom:@z@%"><i>0</i></span>@conns@@cells@</div>'
        '<div class="wfnames">@names@</div>'
        '<figcaption class="chart-cap">7 行验算全部自洽（@l1@）：'
        '毛利 +2.60% 为正，被风险成本 4.37% 吃穿（吃掉毛利的 168%）——'
        '信用卡的亏损 100% 来自风险成本项，每 1 亿余额年亏 285 万。</figcaption></figure>',
        z="%.2f" % P(0), conns="".join(conns), cells="".join(cells), names=names, l1=L("测算"))

def chart_divbar():
    # 点睛图② 第一章：六行不良率 × 余额降幅发散条（x=降幅、y=名义不良率升序，零轴=持平）
    # 量程：|降幅| 最大 21.09%（本行，官方口径在案）→ 条长 = |v|/21.09*100；
    # 邮储/浦发余额降幅未在案 → 不标数字，仅`待补`占位（数字标注全部 md 在案）。
    SCALE = 21.09
    rows = [  # (行名, 名义不良率, 降幅 or None, 本行?)
        ("邮储", "1.45%", None, False),
        ("招行", "1.90%", -5.13, False),
        ("浦发", "2.01%", None, False),
        ("农行", "2.05%", -4.03, False),
        ("平安", "2.23%", -0.70, False),
        ("民生", "4.22%", -6.01, False),
        ("本行（还原口径）", "4.37%", -21.09, True),
    ]
    out = []
    for name, npl, dec, own in rows:
        if dec is None:
            bar = '<span class="fbar miss"></span>'
            val = L("待补")
            vcls = "na"
        else:
            w = abs(dec) / SCALE * 100
            bar = T('<span class="fbar@own@" style="width:@w@%"></span>',
                    own=" jr" if own else "", w="%.2f" % w)
            val = "%+.2f%%" % dec
            vcls = "own" if own else "neg"
        out.append(T(
            '<div class="fdiv-row@hl@"><span class="fdiv-label">@name@ · @npl@</span>'
            '<span class="fdiv-zone">@bar@</span>'
            '<span class="fdiv-val @vcls@">@val@</span></div>',
            name=name, npl=npl, bar=bar, val=val, vcls=vcls,
            hl=" hl" if own else ""))
    return T(
        '<figure class="chart fig-div" id="fig-div"><figcaption class="chart-title">'
        '点睛图② · 六行不良率 × 余额降幅发散条（2026H1，零轴 = 持平）</figcaption>'
        '<div class="fdiv-head"><span>y：名义不良率（自上而下升序）</span>'
        '<span>← x：余额降幅（压缩更深）</span><span>0 ＝ 持平</span></div>'
        '@out@'
        '<figcaption class="chart-cap">条长 = 余额降幅：招行 -5.13%、农行 -4.03%、民生 -6.01%、'
        '平安 -0.70%（微缩），本行官方口径 -60.58 亿（-21.09%）压缩最深；'
        '行序按名义不良率升序（1.45%→4.22%），头部带 1.90%-2.23% 以浅缩守住低位不良'
        '（@l3@）；本行为还原口径 4.37%（含核销出表），与六行名义口径不同维，不作直接对比；'
        '邮储、浦发余额降幅未在案（@l4@）。</figcaption></figure>',
        out="".join(out), l3=L("研判推断"), l4=L("待补"))

def chart_mix():
    # 点睛图③ 第二章：mix-shift 情景对比；量程 4.6%，过线虚线 1.52%
    # 段宽 = 加权贡献（口袋 7.61%×w + 正常客群×(1-w)），数字全部 md 在案
    W = lambda v: v / 4.6 * 100
    rows = [  # (档位, 口袋贡献, 正常贡献, 构成标注, 加权结果, EVA 标注, tone)
        ("当前", 7.61 * 0.23, 3.4 * 0.77, "口袋 7.61%×23% ＋ 正常客群 3.4%×77%", "≈4.37%", "-2.85%", "warn"),
        ("减亏档（口袋 23%→10%）", 7.61 * 0.10, 1.9 * 0.90, "口袋 7.61%×10% ＋ 正常客群 1.9%×90%", "≈2.47%", "≈-0.95%", "warn"),
        ("重启档（口袋→3%）", 7.61 * 0.03, 1.34 * 0.97, "口袋 7.61%×3% ＋ 正常客群 1.34%", "≈1.53%", "≈-0.01%≈0 · 过线", "pass"),
    ]
    out = []
    for name, pk, nm, compo, total, eva, tone in rows:
        out.append(T(
            '<div class="mrow"><div class="mhead"><b>@name@</b>'
            '<span class="mtag@tone@">加权 @total@｜EVA @eva@</span></div>'
            '<div class="mtrack"><span class="mbar" style="width:@w@%">'
            '<span class="mseg mseg-a" style="width:@a@%"></span>'
            '<span class="mseg mseg-b" style="width:@b@%"></span></span></div>'
            '<div class="mcap">构成：@compo@</div></div>',
            name=name, tone=(" " + tone) if tone else "", total=total, eva=eva,
            w="%.2f" % W(pk + nm), a="%.2f" % (pk / (pk + nm) * 100),
            b="%.2f" % (nm / (pk + nm) * 100), compo=compo))
    return T(
        '<figure class="chart" id="fig-mix"><figcaption class="chart-title">'
        '点睛图③ · mix-shift 情景对比：风险成本加权（每 1 亿余额·年化，%）</figcaption>'
        '<div class="legend"><span><i class="sw mseg-a"></i>高风险口袋 7.61%（卡部随e贷级）</span>'
        '<span><i class="sw mseg-b"></i>正常客群</span></div>'
        '<div class="mbody"><span class="mline" style="left:@l@%"><i>过线 1.52%（EVA≈0）</i></span>@out@</div>'
        '<figcaption class="chart-cap">图注「情景测算」（@l1@）：减亏档减亏达成未过线，'
        '重启档过线——两档之差在客群上移的彻底程度（1.9%→1.34%），不在压降力度；'
        '情景测算非预测，29 亿压降按官方 226.6 亿基数推演，回收须按 Vintage 分层，防误伤口袋内优质尾部。</figcaption></figure>',
        l="%.2f" % W(1.52), out="".join(out), l1=L("测算"))

def chart_grip():
    # 点睛图④ 第三章：四抓手卡阵（2×2）+ 弹性对比条（2 倍徽章）——同一 figure，数字全部 md 在案
    cards = [
        ("① 汽车分期", "1", [
            ("达标判定", "高档返佣+场景降险至 1% 可达标（+0.32%）；低档不过线"),
            ("规模弹性", "11.3/18.1 亿（226.6 亿×5%/8%）"),
            ("同业验证", "浦发新能源车分期 297.97 亿=其卡余额 7.87% 居中验证；比亚迪「5免2」差异化获客；建行返佣 7% 价格战边界警示"),
            ("风险边界", "返佣 2.1%-2.7% 须按单车盈亏平衡测算，不做价格战跟随"),
        ]),
        ("② 年费卡中收", "2", [
            ("达标判定", "零风险敞口直接加 EVA 分子（+0.5pct≈1.13 亿/年）"),
            ("规模弹性", "0.5pct≈1.13 亿/年"),
            ("同业验证", "本行手续费 0.35 亿（-35.2%）vs 中信信用卡非息净收入 50.12 亿——量级差距即空间"),
            ("风险边界", "年费卡不得强制搭售；权益成本与年费精算匹配（合规闸门）"),
        ]),
        ("③ 贴息账单分期", "3", [
            ("达标判定", "UE&lt;0 放量=放大亏损（每 100 亿余额年亏 2.85 亿）；先降险（&lt;1.52%）后放量"),
            ("规模弹性", "渗透率驱动，弹性大"),
            ("同业验证", "邮储账单分期 +10.93% 为「以规模摊薄负 UE」风险样本，不可照抄；本行融合易贷贴息 1%（单笔封顶 3,000 元）已跑通，复制改造量小"),
            ("风险边界", "窗口至 2026 年底：先降险、后放量；到期预案转自有权益承接，防渗透率断崖"),
        ]),
        ("④ 交易经营", "4", [
            ("达标判定", "不占信贷敞口只加分子；本行数据缺失，先建交易监测仪表盘"),
            ("规模弹性", "数据基建到位后见效"),
            ("同业验证", "民生交易 +18.40%、笔均约 447 元；邮储场景营销 5,700 万人次带动 500 亿、人均约 877 元"),
            ("风险边界", "活动补贴须测算获客成本与留存，不做纯烧钱补贴"),
        ]),
    ]
    cards_html = []
    for name, pri, kvs in cards:
        rows = "".join(T('<div class="grow"><span class="gk">@k@</span><span class="gv">@v@</span></div>',
                         k=k, v=v) for k, v in kvs)
        cards_html.append(T(
            '<div class="gcard"><div class="ghead"><b>@name@</b>'
            '<span class="gpri">优先级 @pri@</span></div>@rows@</div>',
            name=name, pri=pri, rows=rows))
    # 2×2 卡阵：两行 .grow-row（每行两张卡），weasyprint 下比 flex-wrap 稳
    grip_rows = ('<div class="grow-row">%s%s</div><div class="grow-row">%s%s</div>'
                 % tuple(cards_html))
    # 弹性对比条：降险 2.27 亿（2 倍）vs 提价/中收 1.13 亿（1 倍）
    erows = [
        ("降险", "风险成本 -1pct", 2.27, "约 2.27 亿", "2 倍", True),
        ("提价", "收益率 +0.5pct", 1.13, "约 1.13 亿", "1 倍", False),
        ("中收", "中收率 +0.5pct", 1.13, "约 1.13 亿", "1 倍", False),
    ]
    eout = []
    for name, sub, v, amt, badge, top in erows:
        eout.append(T(
            '<div class="erow"><span class="elab">@name@<i>@sub@</i></span>'
            '<span class="ezone"><span class="ebar@topcls@" style="width:@w@%"></span></span>'
            '<span class="eval">@amt@</span><span class="ebadge@flat@">@badge@</span></div>',
            name=name, sub=sub, topcls=" top" if top else "",
            w="%.2f" % (v / 2.27 * 72.0), amt=amt, badge=badge,
            flat="" if top else " flat"))
    return T(
        '<figure class="chart fig-grip" id="fig-grip"><figcaption class="chart-title">'
        '点睛图④ · 四抓手卡阵 ＋ 弹性对比条（2 倍徽章）</figcaption>'
        '<div class="gwrap">@grip_rows@</div>'
        '<div class="esub">弹性对比条（年化价值，余额按官方口径 226.6 亿）</div>'
        '@erows@'
        '<figcaption class="chart-cap">四抓手 UE 排序同第三章收口表（@l3@，供议事排序而非精确打分）；'
        '降险 -1pct≈2.27 亿 = 提价/中收 +0.5pct≈1.13 亿的 2 倍（@l1@：1.0pct/0.5pct）——'
        '先过线，再放量：全量铺开即亏损，只做能过线的组合。</figcaption></figure>',
        grip_rows=grip_rows, erows="".join(eout), l1=L("测算"), l3=L("研判推断"))

def chart_stairs():
    # 点睛图⑤ 第四章：四杠杆优先级阶梯（四级阶梯，自上而下）；
    # 阶梯高度按杠杆价值比例视觉化（2:1:1:0 仅用于高度，不作为数字标注），数字标注全部 md 在案。
    steps = [  # (级, 杠杆, 高度px, 面上标注, 观察指标, kind)
        ("1", "降险", 158, "2 倍 ≈2.27 亿", "红线 4.0%", "s1"),
        ("2", "中收", 79, "1 倍 ≈1.13 亿", "手续费同比转正", "s2"),
        ("3", "提价", 79, "1 倍 守成", "守 4.90%/S4 剪刀差", "s3"),
        ("4", "规模", 14, "", "三条件解锁（S1+S2+S3）", "s4"),
    ]
    cols, foots = [], []
    for no, name, hgt, val, obs, kind in steps:
        inner = (T('<span class="sval">@val@</span>', val=val) if val
                 else '<span class="sfrozen">冻结 · UE&lt;0 放量=放大亏损</span>')
        cols.append(T('<div class="stepcol"><div class="stepblk @kind@" style="height:@h@px">@inner@</div></div>',
                      kind=kind, h=hgt, inner=inner))
        foots.append(T('<div class="sfcol"><span class="sno">@no@</span>'
                       '<div class="sname">@name@</div><div class="sobs">@obs@</div></div>',
                       no=no, name=name, obs=obs))
    return T(
        '<figure class="chart fig-stairs" id="fig-stairs"><figcaption class="chart-title">'
        '点睛图⑤ · 四杠杆优先级阶梯（自上而下）</figcaption>'
        '<div class="stairs">@cols@</div><div class="stair-foot">@foots@</div>'
        '<figcaption class="chart-cap">图注：优先级为@l3@；阶梯高度按四杠杆价值比例视觉化'
        '（降险 -1pct≈2.27 亿、中收 +0.5pct≈1.13 亿、提价 1 倍守成、规模冻结）——'
        '先过线，再放量；四杠杆的次序，就是资源配置的次序。</figcaption></figure>',
        cols="".join(cols), foots="".join(foots), l3=L("研判推断"))

# ---------- 5) 章节内结构变换 ----------
def add_table_class(sec, cls, nth=1):
    """给第 nth 个 <table> 加 class（逐个定位，不改表格内容）"""
    pos = 0
    for _ in range(nth):
        i = sec.find("<table>", pos)
        assert i != -1, "表格不足 %d 个" % nth
        sec = sec[:i] + '<table class="%s">' % cls + sec[i + len("<table>"):]
        pos = i + len('<table class="%s">' % cls)
    return sec

def bold_lead_class(sec, lead, cls):
    """给『**引导语**』开头的段落加版式类（文本零改动；引导语内可含标注 span）"""
    pat = re.compile(r"<p><strong>(" + re.escape(lead) + r")")
    sec2, n = pat.subn(r'<p class="%s"><strong>\1' % cls, sec)
    assert n == 1, "引导语段落定位失败：%s（%d）" % (lead, n)
    return sec2

m_grand = re.compile(r"<p><strong>一句话总判断：(.*?)</strong></p>", re.S)
final_secs = []
for i, (title, sec) in enumerate(zip(titles, sects)):
    sec = re.sub(r"<hr\s*/?>\s*$", "", sec.strip())  # 章节分隔线交给版式
    # 表格分类
    if i == 0:
        sec = add_table_class(sec, "eva-table", 1)
        sec = add_table_class(sec, "concl-table", 1)
    if i == 1:
        sec = add_table_class(sec, "ue-decomp", 1)
    if i == 3:
        sec = add_table_class(sec, "grip-table", 1)
    if i == 4:
        sec = add_table_class(sec, "ladder-table", 1)
    # 卷首：总判断 → 金句块；meta 行置顶；表标签/读表指引版式化
    if i == 0:
        sec, n_g = m_grand.subn(
            r'<blockquote class="grand"><p><strong>一句话总判断：\1</strong></p></blockquote>', sec)
        assert n_g == 1, "一句话总判断包裹失败 %d" % n_g
        sec = '<p class="meta-line">%s</p>\n' % meta_line + sec
        sec = bold_lead_class(sec, "UE 恒等式总表（每 1 亿余额·年化；EVA = 客户收益率 - 资金运营 - 风险成本 - 资本成本）", "blk-label")
        sec = bold_lead_class(sec, "怎么读这张表（三行）", "facts")
        sec = bold_lead_class(sec, "全文结论表", "blk-label")
    # 各章引导语版式化
    if i == 1:
        sec = bold_lead_class(sec, "论证链（证据编号，全部数字带口径）", "blk-label")
        sec = bold_lead_class(sec, "诊断收口：为什么不动资金运营项", "facts")
    if i == 2:
        sec = bold_lead_class(sec, "论证链（证据编号）", "blk-label")
        sec = bold_lead_class(sec, "责任主体与观察指标（写入考核）", "facts")
    if i == 3:
        sec = bold_lead_class(sec, "论证链（证据编号，逐条回到 UE 门槛判定）", "blk-label")
        sec = bold_lead_class(sec, "收口：四抓手 UE 排序表", "blk-label")
    if i == 5:
        sec = sec.replace("<p>①同业收益率", '<p class="panel limits">①同业收益率', 1)
    # 点睛图追加在章末（金句引用块首行 → 编号论证链 → 点睛图）
    if i == 1:
        sec += chart_waterfall() + chart_divbar()
    if i == 2:
        sec += chart_mix()
    if i == 3:
        sec += chart_grip()
    if i == 4:
        sec += chart_stairs()
    # h2 版式化 + bookmark-label 保留原文
    m = re.match(r"^第([一二三四])章\s*(.*)$", title)
    if m:
        no, rest = m.group(1), m.group(2)
        h2 = ('<h2 class="sheet-title" id="s%d" data-run="%s" data-full="%s">'
              '<span class="ch-no">第%s章</span><span class="ch-title">%s</span></h2>'
              % (i, RUN[i], title, no, rest))
    else:
        h2 = ('<h2 class="sheet-title" id="s%d" data-run="%s" data-full="%s">'
              '<span class="ch-title">%s</span></h2>'
              % (i, RUN[i], title, title))
    final_secs.append(h2 + "\n" + sec)

content_html = "\n".join(final_secs)
for fid in ("fig-ue", "fig-div", "fig-mix", "fig-grip", "fig-stairs"):
    assert fid in content_html, fid + " 缺失"
assert "一句话总判断" in content_html and "局限与待补" in content_html
assert content_html.count('class="gcard"') == 4, "四抓手卡应为 4 张"
assert content_html.count('class="stepcol"') == 4, "阶梯应为 4 级"
assert "2:1:1:0" not in content_html, "价值比不得作为数字标注出现"

# ---------- 6) 封面 / 封底 / 左轨 ----------
COVER = '''
<section class="cover" id="cover">
  <div class="cv-top">
    <span class="brand">99wiki ｜ 智见点评 · 行业研究</span>
    <span class="stamp">行内材料 · 勿外发</span>
  </div>
  <div class="cv-band"></div>
  <p class="cv-title">UE 视角分析：江苏银行信用卡</p>
  <p class="cv-sub">钱亏在哪一项，哪个杠杆最值钱（2026 中报季）</p>
  <p class="cv-frame">客群×产品框架 · UE 方法论内嵌</p>
  <p class="cv-ver"><span>UE 专题 v3 · 客群×产品框架 · 2026-08-30</span></p>
  <div class="cv-quote">客群端与产品端的全部动作，都围绕「把风险成本压下来」这一件事。</div>
  <div class="numstrip">
    <div class="numcell"><div class="num">-2.85%</div><div class="nl">EVA · 每 1 亿余额·年化</div><div class="nn">EVA = 4.90 - 2.30 - 4.37 - 1.08（<span class="lv lv1">测算</span>）</div></div>
    <div class="numcell"><div class="num">4.37%</div><div class="nl">风险成本 · 还原口径</div><div class="nn">吃掉毛利 2.60pct 的 168%（<span class="lv lv1">测算</span>）</div></div>
    <div class="numcell"><div class="num">1.52pct</div><div class="nl">转线门槛 · 风险成本</div><div class="nn">降至 1.52% 则 EVA≈0（重启门槛；1.9% 时 EVA -0.38%）</div></div>
    <div class="numcell"><div class="num">2 倍</div><div class="nl">降险杠杆价值</div><div class="nn">降险 -1pct≈2.27 亿 vs 提价/中收 +0.5pct≈1.13 亿（年化）</div></div>
  </div>
  <div class="cv-nav">
    <span>卷首</span><span>一 现状诊断</span><span>二 客群端</span><span>三 产品端</span><span>四 行动</span><span>局限与待补</span><span>来源披露</span>
  </div>
</section>'''

BACK = '''
<section class="backcover" id="backcover">
  <div class="bk-inner">
    <p class="bk-label">收束金句</p>
    <p class="bk-quote">先过线，再放量——降险开路，中收跟进，提价守成，规模殿后。</p>
    <div class="bk-block">
      <div class="bkrow"><span class="bk">版本</span><span>UE 专题 v3 · 客群×产品框架</span></div>
      <div class="bkrow"><span class="bk">日期</span><span>2026-08-30</span></div>
      <div class="bkrow"><span class="bk">数据期</span><span>2026-06-30（EVA 表）/ 2026H1（半年报）/ 2026-08-13（内部周报）</span></div>
      <div class="bkrow"><span class="bk">主线</span><span>UE 恒等式：EVA = 客户收益率 - 资金运营 - 风险成本 - 资本成本</span></div>
      <div class="bkrow"><span class="bk">质量门禁</span><span>G3 渲染自检 · t12+t12 复验 PASS</span></div>
    </div>
    <p class="bk-disclaim">内部经营分析，不构成投资建议；测算/估算/研判推断非官方统计</p>
    <p class="bk-brand">99wiki ｜ 智见点评 · 行业研究</p>
  </div>
</section>'''

RAIL = '''
<nav class="rail" aria-hidden="true">
  <div class="rail-brand">99wiki</div>
  <div class="rail-sub">智见点评 · 行业研究</div>
  <span class="rail-stamp">行内材料 · 勿外发</span>
  <ol class="rail-nav">
    <li><a href="#s0"><i>00</i>卷首</a></li>
    <li><a href="#s1"><i>01</i>一 现状诊断</a></li>
    <li><a href="#s2"><i>02</i>二 客群端</a></li>
    <li><a href="#s3"><i>03</i>三 产品端</a></li>
    <li><a href="#s4"><i>04</i>四 行动</a></li>
    <li><a href="#s5"><i>05</i>局限与待补</a></li>
    <li><a href="#s6"><i>06</i>来源披露</a></li>
  </ol>
  <div class="rail-foot">UE 专题 v3 · 客群×产品框架 · 2026-08-30</div>
</nav>'''

CSS = (BASE / "render_ue" / "build" / "style.css").read_text(encoding="utf-8")

html = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>UE 视角分析：江苏银行信用卡（2026 中报季）</title>
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
print("HTML written:", OUT, OUT.stat().st_size, "bytes; md5:", md5_before)
