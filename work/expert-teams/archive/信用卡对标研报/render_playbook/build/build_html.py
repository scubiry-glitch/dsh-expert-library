# -*- coding: utf-8 -*-
"""
渲染岗构建脚本（打法研究 v1 · 溯源-迁移框架）：冻结 md → 单文件 HTML（finesse-ui · policy-print register）
铁律：不改 md 任何文字/数字；正文由 markdown 库自动转换，仅注入视觉结构；
点睛图内出现的数字全部可在 md 中找到（chart-number fidelity）。
复用 render_ue/build 工程，v1（打法研究）增量：
  ① 卷首：总判断金句块 + 打法全景表（21 条按章分组）+ 防抄作业方法说明；
  ② 六章均为「金句引用块首行 → 打法三段式（溯源/机制/Fit）→ 点睛图」，点睛图共 6 张：
     ①获客漏斗对比条 ②贴息杠杆对比条 ③收入结构对比条 ④出清路径对比条
     ⑤组织机制时序条 ⑥21 条打法 Fit 泳道概览（矩阵表为主图、泳道为辅览）；
  ③ 第六章：迁移适配矩阵宽表（19 行×Fit×前提×优先级）+ 泳道概览 + 采纳路线图 panel；
  ④ 封面：标题/副标/版本行/四格数字条/勿外发角标；封底：总判断金句收束+版本块+免责行。
"""
import re, hashlib, pathlib

BASE = pathlib.Path("/root/zhijian/dsh-expert-library/work/expert-teams/信用卡对标研报")
SRC = BASE / "别人的打法_溯源与迁移_20260830.md"
OUT = BASE / "render_playbook" / "别人的打法_溯源与迁移_20260830.html"

MD5 = "a0a1f7bb06f6ee2178aa2fca327e69c1"
md_text = SRC.read_text(encoding="utf-8")
md5_before = hashlib.md5(SRC.read_bytes()).hexdigest()
assert md5_before == MD5, f"md5 变动！{md5_before}"

# ---------- 1) 预处理：五级标注 token 化；转义裸 "<"（md 无合法 HTML） ----------
LV = {"官方披露": "lv-off", "已核验": "lv-ok", "测算": "lv1", "估算": "lv2",
      "研判推断": "lv3", "待补": "lv4"}
md_pre = re.sub(r"`(官方披露|已核验|测算|估算|研判推断|待补)`",
                lambda m: "{{%s}}" % m.group(1), md_text)
assert md_pre.count("`") == 0, "存在未识别的反引号"
# md 中 **打法…** 行与「- 」清单之间无空行（lazy continuation 会吞掉列表）——
# 仅补空行（纯空白预处理，不改动任何文字/数字，磁盘 md 不动）
_lines = []
for _ln in md_pre.split("\n"):
    if _ln.startswith("- ") and _lines and _lines[-1].strip() != "" and not _lines[-1].startswith("- "):
        _lines.append("")
    _lines.append(_ln)
md_pre = "\n".join(_lines)
md_pre = md_pre.replace("<", "&lt;")

import markdown
body_html = markdown.markdown(md_pre, extensions=["tables"])
body_html = re.sub(r"\{\{(官方披露|已核验|测算|估算|研判推断|待补)\}\}",
                   lambda m: '<span class="lv %s">%s</span>' % (LV[m.group(1)], m.group(1)),
                   body_html)

# ---------- 2) 摘出 h1 与顶部引言（版本/数据期/方法）→ 卷首 meta ----------
body_html = re.sub(r"<h1>.*?</h1>\s*", "", body_html, count=1, flags=re.S)
m_top = re.search(r"<blockquote>\s*<p>(.*?)</p>\s*</blockquote>", body_html, re.S)
assert m_top and "打法研究 v1" in m_top.group(1), "顶部 meta 块定位失败"
meta_line = m_top.group(1)
body_html = body_html[:m_top.start()] + body_html[m_top.end():]

# ---------- 3) 按 <h2> 切节：卷首 + 六章 + 局限与待补 + 来源披露 ----------
parts = re.split(r"<h2>(.*?)</h2>", body_html)
parts[0] = re.sub(r"^\s*(<hr\s*/?>\s*)+", "", parts[0])
assert parts[0].strip() == "", "h2 前有残余内容：" + parts[0][:120]
titles = [t.strip() for t in parts[1::2]]
sects = parts[2::2]
assert len(titles) == 9, titles
assert titles == ["卷首", "第一章 获客与流量打法", "第二章 资产端打法",
                  "第三章 收入结构打法", "第四章 风险与出清打法",
                  "第五章 组织与机制打法", "第六章 迁移适配矩阵与采纳路线图",
                  "局限与待补", "来源披露（一段）"], titles

RUN = ["卷首", "一 · 获客流量", "二 · 资产端", "三 · 收入结构",
       "四 · 风险出清", "五 · 组织机制", "六 · 迁移矩阵", "局限与待补", "来源披露"]

# ---------- 4) 通用模板/工具 ----------
def T(tpl, **kw):
    for k, v in kw.items():
        tpl = tpl.replace("@" + k + "@", str(v))
    assert "@" not in tpl, "未替换占位符：" + tpl[tpl.find("@"):tpl.find("@") + 40]
    return tpl

def L(lv):
    return '<span class="lv %s">%s</span>' % (LV[lv], lv)

FIT_TOKENS = ["改造后采纳", "部分采纳", "方向采纳", "前瞻采纳", "采纳", "拒绝", "参照"]
FIT_CLS = {"采纳": "fit-ok", "改造后采纳": "fit-adapt", "部分采纳": "fit-part",
           "方向采纳": "fit-dir", "前瞻采纳": "fit-fwd", "拒绝": "fit-no", "参照": "fit-ref"}
m_fit = re.compile("|".join(FIT_TOKENS))  # 交替按最长优先命中，单趟替换不嵌套
def chip_fit(text):
    return m_fit.sub(lambda m: '<span class="fit %s">%s</span>' % (FIT_CLS[m.group(0)], m.group(0)), text)

def add_table_class(sec, cls):
    i = sec.find("<table>")
    assert i != -1, "表格缺失：" + cls
    return sec[:i] + '<table class="%s">' % cls + sec[i + len("<table>"):]

def bold_lead_class(sec, lead, cls):
    """给『**引导语**』开头的段落加版式类（文本零改动；引导语内可含标注 span）"""
    pat = re.compile(r"<p><strong>(" + re.escape(lead) + r")")
    sec2, n = pat.subn(r'<p class="%s"><strong>\1' % cls, sec)
    assert n == 1, "引导语段落定位失败：%s（%d）" % (lead, n)
    return sec2

def chip_fit_column(table_html, cell_idx, ncols):
    """给表格每行第 cell_idx 个 <td>（Fit 列）的文本套 Fit 徽章（只换皮不改字）"""
    rows = re.split(r"(<tr>.*?</tr>)", table_html, flags=re.S)
    out, in_head = [], True
    for seg in rows:
        if seg.startswith("<tr>"):
            cells = re.findall(r"<td>(.*?)</td>", seg, flags=re.S)
            if cells and len(cells) == ncols:
                cells[cell_idx] = chip_fit(cells[cell_idx])
                seg = "<tr>" + "".join("<td>%s</td>" % c for c in cells) + "</tr>"
        out.append(seg)
    return "".join(out)

# ---------- 5) 点睛图（CSS-only；数字全部 md 在案） ----------
def chart_funnel():
    # 点睛图① 第一章 获客漏斗对比条：兴业条按量程 0-20pct（17.27/20）；
    # 华夏条填充=MAU÷注册=13.4%（测算）；本行条待补虚位。
    rows = []
    rows.append(T(
        '<div class="fn-row"><div class="fn-head"><span class="fn-name">兴业 · 场景新户</span>'
        '<span class="fn-val">+17.27pct</span></div>'
        '<div class="fn-track"><span class="fn-bar" style="width:86.35%"></span>'
        '<span class="fn-scale">量程 0-20pct</span></div>'
        '<div class="fn-sub">「两卡」客户占有效信用卡客户比 +1.46pct ｜ 新增发卡 90.26 万张（@loff@）</div></div>',
        loff=L("官方披露")))
    rows.append(T(
        '<div class="fn-row"><div class="fn-head"><span class="fn-name">华夏 · APP 流量漏斗</span>'
        '<span class="fn-val amber">MAU 326.90 万</span></div>'
        '<div class="fn-track"><span class="fn-bar amberb" style="width:13.4%"></span>'
        '<span class="fn-reg">注册 2,442.61 万户（+1.80%）</span></div>'
        '<div class="fn-sub">注册/MAU 比率约 13.4%（@l1@）｜ 累计发卡 4,363 万张（+0.71%）（@loff@）</div></div>',
        l1=L("测算"), loff=L("官方披露")))
    rows.append(T(
        '<div class="fn-row"><div class="fn-head"><span class="fn-name">本行 · 场景新户占比</span>'
        '<span class="fn-val na">@l4@</span></div>'
        '<div class="fn-track"><span class="fn-bar miss"></span></div>'
        '<div class="fn-sub">前提：RFM 与场景获客漏斗数据可得（@l4@）</div></div>',
        l4=L("待补")))
    return T(
        '<figure class="chart" id="fig-funnel"><figcaption class="chart-title">'
        '点睛图① · 获客漏斗对比条（2026H1）</figcaption>'
        '@rows@'
        '<figcaption class="chart-cap">图注「本行待补」：兴业场景新户自带真实消费需求'
        '（支付场景→分期转化），两卡联动沉淀借记卡资金与交叉销售；'
        '华夏 MAU 是交易活跃的底座——流量集中→交易量→刷卡/分期/权益中收；'
        '本行新增新户须落在风险成本 &lt;1.52% 的客群（先过线再放量）。</figcaption></figure>',
        rows="".join(rows))

def chart_lever():
    # 点睛图② 第二章 贴息杠杆对比条：交行 463 亿/1.01 亿=458 倍（真实比例，1.01 亿细至 4px
    # 正是杠杆的直观）；本行迁移测算条长量程 0~-1.4 亿（1.5% 情景≈0、4.37% 情景满条）。
    return T(
        '<figure class="chart" id="fig-lever"><figcaption class="chart-title">'
        '点睛图② · 贴息杠杆对比条（交行 2026H1 × 本行迁移测算）</figcaption>'
        '<div class="lev-badge">贴息杠杆 <b>458 倍</b>（463÷1.01，@l1@）</div>'
        '<div class="lev-row"><span class="lev-lab">贴息分期交易额</span>'
        '<span class="lev-zone"><span class="lev-bar" style="width:100%"></span></span>'
        '<span class="lev-val">463 亿元</span></div>'
        '<div class="lev-row"><span class="lev-lab">贴息金额</span>'
        '<span class="lev-zone"><span class="lev-bar thin" style="width:0.22%"></span></span>'
        '<span class="lev-val">1.01 亿元</span></div>'
        '<div class="esub">本行迁移测算 · 放量 50 亿（@l1@；条长量程 0~-1.4 亿）</div>'
        '<div class="lev-row"><span class="lev-lab">风险成本 1.5%</span>'
        '<span class="lev-zone"><span class="lev-bar tealb" style="width:1.5%"></span></span>'
        '<span class="lev-val">边际 EVA≈0（不赚不亏）</span></div>'
        '<div class="lev-row"><span class="lev-lab">风险成本 4.37%</span>'
        '<span class="lev-zone"><span class="lev-bar warnb" style="width:100%"></span></span>'
        '<span class="lev-val">年亏约 1.4 亿（50 亿×2.85%）</span></div>'
        '<figcaption class="chart-cap">图注「测算」：贴息只改客户成本、不改银行 UE；'
        '迁移前置=①放量对象限定风险成本 &lt;1.52% 的白名单客群；'
        '②融合易贷贴息模式复用（贴息 1%、单笔封顶 3,000 元）；③政策窗口至 2026 年底；'
        '交行成立前提之一即卡 UE 接近平衡，本行 EVA -2.85% 下照抄=放大亏损，贴息明细拆解@l4@。</figcaption></figure>',
        l1=L("测算"), l4=L("待补"))

def chart_income():
    # 点睛图③ 第三章 收入结构对比条：中信条=非息占全行 16.85%（量程 0-20%）；
    # 招行双条=同比降幅（量程 0~-12.12%）；本行为手续费基数卡（不设误导条）。
    return T(
        '<figure class="chart" id="fig-income"><figcaption class="chart-title">'
        '点睛图③ · 收入结构对比条（2026H1）</figcaption>'
        '<div class="fn-row"><div class="fn-head"><span class="fn-name">中信 · 非息占全行非利息净收入</span>'
        '<span class="fn-val">16.85%</span></div>'
        '<div class="fn-track"><span class="fn-bar" style="width:84.25%"></span>'
        '<span class="fn-scale">量程 0-20%</span></div>'
        '<div class="fn-sub">信用卡非利息净收入 50.12 亿元 ｜ 交易量 10,318.75 亿元（@loff@+@lok@）</div></div>'
        '<div class="fn-row"><div class="fn-head"><span class="fn-name">招行 · 利息 vs 非息（同比）</span>'
        '<span class="fn-val amber">-12.12% / -6.64%</span></div>'
        '<div class="inc-mini"><span class="im-lab">利息 269.03 亿</span>'
        '<span class="im-zone"><span class="im-bar am" style="width:100%"></span></span>'
        '<span class="im-val">-12.12%</span></div>'
        '<div class="inc-mini"><span class="im-lab">非息 97.76 亿</span>'
        '<span class="im-zone"><span class="im-bar te" style="width:54.79%"></span></span>'
        '<span class="im-val te">-6.64%</span></div>'
        '<div class="fn-sub">条长量程 0~-12.12% ｜ 交易额 19,111.84 亿（-5.43%）（@loff@+@lok@）</div></div>'
        '<div class="fn-row"><div class="fn-head"><span class="fn-name">本行 · 银行卡手续费</span>'
        '<span class="fn-val na">-35.2%</span></div>'
        '<div class="inc-big">0.35 亿（-35.2%）<i>中收率第一阶段梯度 0.2%-0.5pct ≈ 1.13 亿/年'
        '（@l1@：226.6 亿×0.5%）</i></div></div>'
        '<figcaption class="chart-cap">招行 -12.12% 与 -6.64% 的差距就是缓冲的厚度；'
        '对标中信 16.85% 占比需头部产品力，本行不设远期目标、以 0.2%-0.5pct 梯度起步（@l1@）。</figcaption></figure>',
        loff=L("官方披露"), lok=L("已核验"), l1=L("测算"))

def chart_clear():
    # 点睛图④ 第四章 出清路径对比条：横轴=名义不良率 0→4.37%（量程上限=本行还原口径）；
    # 平安/中信为名义口径，本行还原口径不同维（不并排比大小，只标位置）。
    rows = [
        ("平安 <b>2.23%</b>", 51.03, "-0.01pct · 企稳", False,
         "余额 -0.70%（六行最浅）｜ 流通户 4,285.21 万户（-1.9%）"),
        ("中信 <b>2.57%</b>", 58.81, "-0.05pct · 双降", False,
         "不良余额 116.45 亿（-4.72 亿）"),
        ("本行（还原口径）<b>4.37%</b>", 100.0, "官方口径降幅 -21.09%", True,
         "名义不良率 vs 还原损失率：口径不同、结论相反"),
    ]
    out = []
    for name, w, val, own, sub in rows:
        dot_left = "calc(100% - 11px)" if w >= 99.5 else "calc(%.2f%% - 5px)" % w
        out.append(T(
            '<div class="clr-row"><span class="clr-label">@name@</span>'
            '<span class="clr-zone"><span class="clr-bar@ownb@" style="width:@w@%"></span>'
            '<span class="clr-dot" style="left:@dot@"></span></span>'
            '<span class="clr-val@ownv@">@val@</span></div>'
            '<div class="clr-sub">@sub@</div>',
            name=name, w="%.2f" % w, dot=dot_left, val=val, sub=sub,
            ownb=" ownb" if own else "", ownv=" ownv" if own else ""))
    return T(
        '<figure class="chart" id="fig-clear"><figcaption class="chart-title">'
        '点睛图④ · 出清路径对比条（2026H1，横轴 0→4.37%）</figcaption>'
        '@out@'
        '<div class="clr-axis"><span>0</span><span>名义不良率 →（量程上限 = 本行还原口径 4.37%）</span></div>'
        '<figcaption class="chart-cap">图注「名义 vs 还原口径差异」：招行名义 1.90% 低但新生成不良 '
        '236.98 亿（+39.29 亿）流量加速——生成率是仪表盘、不良率是后视镜；'
        '平安先出清先企稳（余额 -0.70% 但流通户仅 -1.9%，保住活跃客群）；'
        '中信存量出清+流量管控双降；本行 4.37% 为还原口径，与名义口径不同维。</figcaption></figure>',
        out="".join(out))

def chart_timeline():
    # 点睛图⑤ 第五章 组织机制时序条：定性示意（不设量程刻度）——
    # 上：邮储 APP 停更→停服收尾窗口（两端点标日期）；下：2026-08 两项协会规范 + 本行窗口。
    return T(
        '<figure class="chart" id="fig-timeline"><figcaption class="chart-title">'
        '点睛图⑤ · 组织机制时序条（定性示意）</figcaption>'
        '<div class="tl-span">'
        '<span class="tl-endpoint"><i>2026-08-24</i>停止更新</span>'
        '<span class="tl-bar"><b>邮储信用卡 APP · 服务收尾窗口</b></span>'
        '<span class="tl-endpoint right"><i>2026-11-25 24 时</i>停止全部服务</span>'
        '</div>'
        '<div class="tl-note">迁移至邮储银行 APP（@loff@，公告口径）</div>'
        '<div class="tl-cards">'
        '<div class="tl-card"><span class="tl-date">2026-08</span><b>互金协会 · 区隔展示新规</b>'
        '<span>收银台支付工具与贷款产品物理分区，不得默认勾选/诱导混淆（发布）</span></div>'
        '<div class="tl-card"><span class="tl-date">2026-08</span><b>支付清算协会 · 智能体公约</b>'
        '<span>授权四要素：限额/账户/有效期/意愿核实（印发）</span></div>'
        '<div class="tl-card own"><span class="tl-date">本行 Q3-Q4</span><b>落地窗口（@l3@）</b>'
        '<span>收银台/支付链路区隔展示改造；先数据基建、再评估渠道整合</span></div>'
        '</div>'
        '<figcaption class="chart-cap">图注「时序示意」：两项协会自律规范均 2026-08 发文；'
        '邮储 APP 自 2026-08-24 起停止更新、2026-11-25 24 时起停止全部服务；'
        '本行窗口为@l3@，先有数据、再动渠道。</figcaption></figure>',
        loff=L("官方披露"), l3=L("研判推断"))

LANE_DATA = [
    ("lane-ok", "采纳", "4 条", [
        ("兴业低风险分层（12）", "高"), ("招行生成监测（14）", "高"),
        ("平安出清节奏（15）", "高"), ("浦发新能源车分期（6）", "高")]),
    ("lane-adapt", "改造后采纳", "9 条", [
        ("中信中收转型（8）", "高"), ("互金协会区隔新规（18）", "高"),
        ("交行贴息放量（4）", "中（前置）"), ("邮储贴息自动化（5）", "中（前置）"),
        ("兴业场景新户（1）", "中"), ("兴业分期+线上化（10）", "中"),
        ("民生组织融合（16）", "中"), ("邮储 APP 整合（17）", "低"),
        ("华夏 APP 流量（2）", "低")]),
    ("lane-part", "部分采纳", "1 条", [("中信不良双降（13）", "中")]),
    ("lane-dir", "方向采纳", "1 条", [("招行非息韧性（9）", "低")]),
    ("lane-no", "拒绝", "3 条", [
        ("工行/建行规模底座（3/4/5）", "—"), ("建行返佣价格战（7）", "—")]),
    ("lane-x", "参照 / 前瞻", "1+1 条", [
        ("光大收入规模（11）· 参照", "—"), ("智能体支付公约（19）· 前瞻", "低")]),
]

def chart_lanes():
    # 点睛图⑥ 第六章 21 条打法 Fit 泳道概览：矩阵表为主图，此为辅览；
    # 五泳道（采纳/改造后采纳/部分采纳/方向采纳/拒绝）+ 参照/前瞻另列条。
    lanes = []
    for cls, name, cnt, items in LANE_DATA:
        chips = "".join(T('<span class="itm"><b>@n@</b><i>@p@</i></span>', n=n, p=p)
                        for n, p in items)
        lanes.append(T(
            '<div class="lane @cls@"><div class="lane-head"><b>@name@</b>'
            '<span class="lane-n">@cnt@</span></div>'
            '<div class="lane-items">@chips@</div></div>',
            cls=cls, name=name, cnt=cnt, chips=chips))
    return T(
        '<figure class="chart" id="fig-lanes"><figcaption class="chart-title">'
        '点睛图⑥ · 21 条打法 Fit 泳道概览（矩阵表为主图，此为辅览）</figcaption>'
        '@lanes@'
        '<figcaption class="chart-cap">计数口径引自收口段：15 条=直接采纳 4+改造后采纳 9+'
        '部分采纳 1+方向采纳 1；拒绝 3 条含建行返佣与工建规模底座；'
        '浦发国补、上海银行转正为嵌套引用不单列——'
        '没有一条绕过 UE 门槛，没有一条不需要前提。</figcaption></figure>',
        lanes="".join(lanes))

CHARTS = {1: chart_funnel, 2: chart_lever, 3: chart_income,
          4: chart_clear, 5: chart_timeline, 6: chart_lanes}

# ---------- 6) 章节内结构变换 ----------
final_secs = []
for i, (title, sec) in enumerate(zip(titles, sects)):
    sec = re.sub(r"<hr\s*/?>\s*$", "", sec.strip())  # 章节分隔线交给版式
    if i == 0:
        # 卷首：总判断 → 金句块；meta 行置顶；全景表/方法说明版式化
        sec, n_g = re.subn(
            r'<blockquote>\s*<p><strong>(总判断：.*?)</strong></p>\s*</blockquote>',
            r'<blockquote class="grand"><p><strong>\1</strong></p></blockquote>', sec, flags=re.S)
        assert n_g == 1, "总判断金句包裹失败 %d" % n_g
        sec = '<p class="meta-line">%s</p>\n' % meta_line + sec
        sec = bold_lead_class(sec, "打法全景表", "blk-label")
        sec = bold_lead_class(sec, "方法说明：溯源→机制→Fit 为什么能防抄作业。", "facts")
        sec = add_table_class(sec, "panorama-table")
        sec = chip_fit_column(sec, 3, 5)   # Fit 判定列（第 4 列）
    if 1 <= i <= 5:
        # 打法卡头 + 三段式 seg + 金句块 + 点睛图建议行
        sec, n_head = re.subn(r"<p><strong>(打法 )", r'<p class="play-head"><strong>\1', sec)
        n_li = 0
        for tag, cls in (("【溯源】", "seg-a"), ("【机制】", "seg-b"), ("【Fit】", "seg-c")):
            sec, n = re.subn(r"<li>(%s)" % re.escape(tag),
                             r'<li><span class="seg %s">\1</span>' % cls, sec)
            n_li += n
        assert n_head + n_li > 0, "章节结构定位失败：" + title
        sec = re.sub(r'<blockquote>\s*<p><strong>(金句：)',
                     r'<blockquote class="quote-ch"><p><strong>\1', sec, flags=re.S)
        sec = bold_lead_class(sec, "点睛图建议", "chart-suggest")
        # 打法头内的 Fit 判定词套徽章（strong 内文本零改动）
        sec = re.sub(r'(<p class="play-head"><strong>.*?</strong>)',
                     lambda m: chip_fit(m.group(1)), sec, flags=re.S)
    if i == 6:
        sec = add_table_class(sec, "matrix-table")
        sec = chip_fit_column(sec, 1, 4)   # Fit 判定列（第 2 列）
        sec = bold_lead_class(sec, "采纳路线图（挂本行四杠杆节奏", "roadmap")
    if i == 7:
        sec = sec.replace("<p>①本行客户级数据缺口", '<p class="panel limits">①本行客户级数据缺口', 1)
    if i == 8:
        sec = sec.replace("<p>本文件打法证据", '<p class="panel src">本文件打法证据', 1)
    # 点睛图追加：第 1-5 章在章末（建议行之后）；第 6 章插在路线图段之前（表格为主图、泳道为辅览）
    if i in CHARTS:
        fig = CHARTS[i]()
        if i == 6:
            assert '<p class="roadmap">' in sec
            sec = sec.replace('<p class="roadmap">', fig + '<p class="roadmap">', 1)
        else:
            sec += fig
    # h2 版式化 + bookmark-label 保留原文
    m = re.match(r"^第([一二三四五六])章\s*(.*)$", title)
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
for fid in ("fig-funnel", "fig-lever", "fig-income", "fig-clear", "fig-timeline", "fig-lanes"):
    assert fid in content_html, fid + " 缺失"
assert "总判断：" in content_html and "局限与待补" in content_html
assert content_html.count('class="play-head"') == 19, "打法卡头应为 19 条"
assert content_html.count(">【溯源】</span>") == 19
assert content_html.count(">【机制】</span>") == 19
assert content_html.count(">【Fit】</span>") == 19
assert content_html.count('class="chart-suggest"') == 5, "点睛图建议行应 5 处"
assert content_html.count('class="lane ') == 6, "泳道应 6 条（5+参照/前瞻）"

# ---------- 7) 封面 / 封底 / 左轨 ----------
COVER = '''
<section class="cover" id="cover">
  <div class="cv-top">
    <span class="brand">99wiki ｜ 智见点评 · 行业研究</span>
    <span class="stamp">行内材料 · 勿外发</span>
  </div>
  <div class="cv-band"></div>
  <p class="cv-title">别人的打法：溯源、机制与本行适配</p>
  <p class="cv-sub">研究学习同业打法 · 溯源-迁移框架（2026 中报季）</p>
  <p class="cv-frame">21 条打法 · 溯源 → 机制 → Fit</p>
  <p class="cv-ver"><span>打法研究 v1 · 2026-08-30</span></p>
  <div class="cv-quote">不能过线的打法，写得再漂亮也是别人的。</div>
  <div class="numstrip">
    <div class="numcell"><div class="num">21 条</div><div class="nl">同业打法 · 全景</div><div class="nn">引自打法素材库，零新数；按章分组溯源</div></div>
    <div class="numcell"><div class="num">15</div><div class="nl">采纳 ＋ 改造后采纳</div><div class="nn">直接采纳 4+改造后采纳 9+部分采纳 1+方向采纳 1</div></div>
    <div class="numcell"><div class="num">3</div><div class="nl">拒绝</div><div class="nn">含建行返佣与工建规模底座；参照 1、前瞻 1 另列</div></div>
    <div class="numcell"><div class="num">3.38pct</div><div class="nl">UE 门槛 · 风险成本加项</div><div class="nn">EVA≥0 ⇔ 收益率+中收率 ≥ 风险成本+3.38pct</div></div>
  </div>
  <div class="cv-nav">
    <span>卷首</span><span>一 获客流量</span><span>二 资产端</span><span>三 收入结构</span><span>四 风险出清</span><span>五 组织机制</span><span>六 迁移矩阵</span><span>局限与待补</span><span>来源披露</span>
  </div>
</section>'''

BACK = '''
<section class="backcover" id="backcover">
  <div class="bk-inner">
    <p class="bk-label">收束金句</p>
    <p class="bk-quote">打法没有好坏，只有恒等式适配与否——别人的打法，先问它动的是哪一项，再问我们过不过得了那条线。</p>
    <div class="bk-block">
      <div class="bkrow"><span class="bk">版本</span><span>打法研究 v1 · 溯源-迁移框架</span></div>
      <div class="bkrow"><span class="bk">日期</span><span>2026-08-30</span></div>
      <div class="bkrow"><span class="bk">数据期</span><span>2026H1（半年报）/ 2026-08（公告/监管发文）</span></div>
      <div class="bkrow"><span class="bk">门槛</span><span>UE：EVA≥0 ⇔ 收益率+中收率 ≥ 风险成本+3.38pct</span></div>
      <div class="bkrow"><span class="bk">质量门禁</span><span>G3 渲染自检 · t16 快检 PASS + 终修</span></div>
    </div>
    <p class="bk-disclaim">内部经营分析，不构成投资建议；测算/研判推断非官方统计</p>
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
    <li><a href="#s1"><i>01</i>一 获客流量</a></li>
    <li><a href="#s2"><i>02</i>二 资产端</a></li>
    <li><a href="#s3"><i>03</i>三 收入结构</a></li>
    <li><a href="#s4"><i>04</i>四 风险出清</a></li>
    <li><a href="#s5"><i>05</i>五 组织机制</a></li>
    <li><a href="#s6"><i>06</i>六 迁移矩阵</a></li>
    <li><a href="#s7"><i>07</i>局限与待补</a></li>
    <li><a href="#s8"><i>08</i>来源披露</a></li>
  </ol>
  <div class="rail-foot">打法研究 v1 · 溯源-迁移框架 · 2026-08-30</div>
</nav>'''

CSS = (BASE / "render_playbook" / "build" / "style.css").read_text(encoding="utf-8")

html = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>别人的打法：溯源、机制与本行适配（2026 中报季）</title>
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
