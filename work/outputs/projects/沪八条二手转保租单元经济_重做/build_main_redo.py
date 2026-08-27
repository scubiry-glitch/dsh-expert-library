# -*- coding: utf-8 -*-
"""Build final Part B main text: t4 report body + HTML cover + SVG diagrams.
Replaces ASCII code-fence diagrams (机制链/决策树) with inline SVGs so the
Part B acceptor (svgs>=4, quant model, decision tree) passes.
"""
import re, io, hashlib

BASE = "/root/zhijian/dsh-expert-library/work/98wiki/projects/沪八条二手转保租单元经济_重做/"
SRC = "/root/zhijian/dsh-expert-library/work/研报_沪八条二手转保租单元经济_重做.md"

body = io.open(SRC, encoding="utf-8").read()

# ---- 1. extract body from 摘要 onward (drop the t4 markdown cover) ----
idx = body.find("## 摘要")
assert idx > 0, "摘要 not found"
body = body[idx:]

# ---- 2. SVG diagrams ----

def svg_fig(svg_body, cap, w=700, h=150):
    return ('<div class="svg-wrap">\n<svg width="%d" height="%d" viewBox="0 0 %d %d" xmlns="http://www.w3.org/2000/svg" font-family="Noto Sans CJK SC">\n'
            % (w, h, w, h)) + svg_body + ('\n</svg>\n<div class="figure-cap">%s</div>\n</div>\n' % cap)

def box(x, y, w, h, color="#14304f"):
    return '<rect x="%d" y="%d" width="%d" height="%d" rx="6" fill="%s"/>' % (x, y, w, h, color)

def txt(x, y, s, fill="#fff", fs=11, anchor="middle", sub=None):
    t = '<text x="%d" y="%d" fill="%s" font-size="%d" text-anchor="%s">%s</text>' % (x, y, fill, fs, anchor, s)
    if sub:
        t += '\n<text x="%d" y="%d" fill="#cfe0f2" font-size="9.5" text-anchor="%s">%s</text>' % (x, y + 16, anchor, sub)
    return t

def arrow(x1, y1, x2, y2=None, color="#c9a96e"):
    # 兼容 4 参调用：arrow(x1, y1, x2, color)
    if y2 is None or isinstance(y2, str):
        color = y2 or color
        y2 = y1
    return ('<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="%s" stroke-width="1.6"/>'
            '<polygon points="%d,%d %d,%d %d,%d" fill="%s"/>' % (x1, y1, x2, y2, color, x2, y2, x2 - 8, y2 - 5, x2 - 8, y2 + 5, color))

# ---- SVG-1 机制链（替代 3.1 的 ASCII）----
s1 = []
items = [("存量二手住房", "中心城区标的"), ("区属国企收购", "业主获专项房票"), ("房票直购新房", "卖旧买新闭环"), ("改造为保租房", "加快改造出租"), ("纳管出租运营", "租金≤市场九折"), ("剪刀差判定", "r vs c")]
x = 10; w = 112; gap = 12; y = 44; bh = 64
for i, (t, sub) in enumerate(items):
    s1.append(box(x, y, w, bh))
    s1.append(txt(x + w/2, y + 28, t, fs=10.5))
    s1.append(txt(x + w/2, y + 46, sub, fs=8.5))
    if i < len(items) - 1:
        s1.append(arrow(x + w, y + 32, x + w + gap, "#c9a96e"))
    x += w + gap
s1_svg = svg_fig("\n".join(s1),
    "机制图 1｜资产转换机制链：收购→房票置换→改造纳管→运营→剪刀差判定（沪八条第 5 条）", w=730, h=150)

# ---- SVG-2 剪刀差三组合（3.3 锚点 D）----
s2 = []
combo = [("组合①", "8折+1.75%+90%", "r 2.2%-2.6% > c 1.75%", "勉强成立", "#1d6f42"),
         ("组合②", "9折+3.0%+85%", "r 1.4%-1.6% < c 3.0%", "缺口1.4-1.6pp", "#a33"),
         ("组合③", "7.5折+2.0%+92%", "r 2.5%-2.9% > c 2.0%", "成立·依赖纪律", "#8a6d1a")]
x = 24
for i, (k, params, cmp, verdict, color) in enumerate(combo):
    s2.append(box(x, 30, 212, 96, color))
    s2.append(txt(x + 106, 52, k, fs=12))
    s2.append(txt(x + 106, 74, params, fs=9.5))
    s2.append(txt(x + 106, 94, cmp, fs=9.5, fill="#f0f4f9"))
    s2.append(txt(x + 106, 112, verdict, fs=10, fill="#ffffff"))
    x += 232
s2_svg = svg_fig("\n".join(s2),
    "机制图 2｜单元经济剪刀差三组合判定（条件式测算【推断】）", w=730, h=145)

# ---- SVG-3 敏感性可行域（3.4 敏感性表热力示意）----
s3 = []
cells = [("7.5折", "成立", "成立", "临界·缺口0.6-1.0pp"),
         ("8折", "勉强成立", "临界·缺口≈0.3pp", "缺口1.0-1.4pp"),
         ("8.5折", "临界·缺口≈0.3pp", "缺口0.5-0.9pp", "缺口1.4-1.6pp"),
         ("9折", "缺口≈0.2pp", "缺口0.9-1.1pp", "缺口1.4-1.6pp")]
cols = ["1.75% 再贷款", "2.5% 综合", "3.5% 市场化"]
s3.append(txt(100, 22, "收购折扣 \\ 资金成本", fs=10, fill="#14304f"))
cx = 200
for c in cols:
    s3.append(txt(cx + 80, 22, c, fs=10, fill="#14304f"))
    cx += 170
y = 38
for row in cells:
    s3.append(txt(100, y + 14, row[0], fs=10, fill="#14304f"))
    cx = 200
    for j, v in enumerate(row[1:]):
        color = "#1d6f42" if ("成立" in v and "临界" not in v and "缺口" not in v) else ("#8a6d1a" if "临界" in v else "#a33")
        s3.append(box(cx, y, 160, 26, color))
        s3.append(txt(cx + 80, y + 17, v, fs=8.5, fill="#fff"))
        cx += 170
    y += 34
s3_svg = svg_fig("\n".join(s3),
    "机制图 3｜敏感性可行域热力示意：折扣×资金成本（出租率90%、租金九折为基准【推断】）", w=730, h=180)

# ---- SVG-4 决策树（替代 6.2 的 ASCII）----
s4 = []
s4.append(box(280, 16, 150, 34, "#14304f"))
s4.append(txt(355, 38, "收购折扣率（裁决性）", fs=10.5))
s4.append(arrow(300, 50, 240, 60, "#c9a96e"))
s4.append(arrow(410, 50, 470, 60, "#c9a96e"))
s4.append(box(90, 64, 200, 40, "#a33"))
s4.append(txt(190, 84, "≥9 折：官方高价锚", fs=10))
s4.append(txt(190, 99, "缺口 1.4-1.6pp → 否决/贴息", fs=8.5, fill="#f6d6d6"))
s4.append(box(500, 64, 210, 40, "#1d6f42"))
s4.append(txt(605, 84, "≤8.5 折：看资金成本", fs=10))
s4.append(arrow(605, 104, 560, 120, "#c9a96e"))
s4.append(arrow(650, 104, 700, 120, "#c9a96e"))
s4.append(box(380, 124, 200, 40, "#1d6f42"))
s4.append(txt(480, 144, "≤2% 再贷款为主", fs=10))
s4.append(arrow(430, 164, 350, 180, "#c9a96e"))
s4.append(box(160, 184, 220, 46, "#1d6f42"))
s4.append(txt(270, 205, "出租率≥90% → 成立", fs=10))
s4.append(txt(270, 222, "r 2.2%-2.6% > c → 放量+REITs", fs=8.5, fill="#d6ecd6"))
s4.append(box(560, 124, 220, 40, "#8a6d1a"))
s4.append(txt(670, 144, ">3% 市场化为主", fs=10))
s4.append(arrow(700, 164, 700, 180, "#c9a96e"))
s4.append(box(590, 184, 220, 46, "#8a6d1a"))
s4.append(txt(700, 205, "出租率≥90% → 勉强成立", fs=9.5))
s4.append(txt(700, 222, "需贴息≤1.5pp；<85% → 暂停扩量", fs=8.5, fill="#f3e7c9"))
s4_svg = svg_fig("\n".join(s4),
    "决策树｜单元经济裁决路径（条件式【推断】）", w=730, h=250)

# ---- 3. replace ASCII fences with SVGs ----
# 3.1 机制链 fence
pat_chain = re.compile(r"```\n中心城区存量二手住房.*?剪刀差判定：租金收益率 r vs 资金成本 c[\s\S]*?```", re.S)
body, n1 = pat_chain.subn(lambda m: s1_svg.rstrip("\n"), body, count=1)
print("replaced chain fence:", n1)

# 6.2 决策树 fence
pat_tree = re.compile(r"```\n\s*收购折扣率（裁决性，现未披露）[\s\S]*?```", re.S)
body, n2 = pat_tree.subn(lambda m: s4_svg.rstrip("\n"), body, count=1)
print("replaced tree fence:", n2)

# insert SVG-2 after 锚点D table (before "### 3.4")
anchor2 = "### 3.4 敏感性分析"
assert anchor2 in body
body = body.replace(anchor2, s2_svg + "\n" + anchor2, 1)

# insert SVG-3 after 3.4 读表结论 paragraph (before "### 3.5")
anchor3 = "### 3.5 CAPEX 与空置期的影响"
assert anchor3 in body
body = body.replace(anchor3, s3_svg + "\n" + anchor3, 1)

# ---- 4. HTML cover ----
cover = '''<div class="cover">

<p class="kicker">98WIKI ｜ 贝壳域 · 深度研究（重做版）</p>

<h1 class="title">沪八条把「收购二手住房」绑上保租房<br>中心城区二手房 → 保租房的资产转换单元经济</h1>

<p class="subtitle">收购对价 · 政策租金 · 资金成本 · 出租运营 —— 基于首批试点实测锚点的单元经济重估</p>

<hr class="rule">

<div class="meta" markdown="0">

<strong>研究类型</strong>：政策机制研究（98wiki 选题 1 重做 · research-report 全流程 · GATE 双 PASS）
<strong>数据基准</strong>：2026-08-22 ｜ 沪八条（2026-08-20 发布 / 08-21 施行）
<strong>研究口径</strong>：上海中心城区（含浦东外环内）二手住宅 → 保障性租赁住房
<strong>实测锚点</strong>：试点三区 551 套（2026-07-30 官方）· 静安首例 40㎡→220 万房票（≈5.5 万/㎡）
<strong>外部来源</strong>：40+ 来源 URL（政策/市场/资金/案例，均带口径与日期）
<strong>参与研判</strong>：Researcher（t1 资料）· 宏观周期派（t2 宏观研判）· 债务金融派（t3 风险债务）｜ Docs Coordinator（t4/t5 成文渲染）

</div>

<div class="kpi-grid">

<div class="kpi-card"><div class="k">KPI-1 · 试点扩围</div><div class="v">551 套 → 全部中心城区</div><div class="s">2026-07-30 官方口径（三区）→ 沪八条 08-21 施行制度化扩围（含浦东外环内）</div></div>

<div class="kpi-card"><div class="k">KPI-2 · 首例收购对价</div><div class="v">≈5.5 万/㎡</div><div class="s">静安首例 40㎡ 老房 → 220 万专项房票（2026-04 官方披露）；反推约 8-9 折【推断】</div></div>

<div class="kpi-card"><div class="k">KPI-3 · 单元经济剪刀差</div><div class="v">r 2.2%-2.6% vs c 1.75%</div><div class="s">组合①（8折+1.75%+90%出租率）勉强成立；组合②（9折+3.0%+85%）缺口 1.4-1.6pp【推断】</div></div>

<div class="kpi-card"><div class="k">KPI-4 · 放量资金情景</div><div class="v">≈360 亿 / ≈2240 亿</div><div class="s">情景 A 收购 1.6 万套（8.5 折）；情景 B 收购 10 万套（约年成交 40%）【推断】</div></div>

</div>

</div>

'''

out = cover + body
with io.open(BASE + "主文_沪八条二手转保租单元经济_重做.md", "w", encoding="utf-8") as f:
    f.write(out)

import re as _re
cn = len(_re.findall(r"[\u4e00-\u9fff]", out))
body_cn = len(_re.findall(r"[\u4e00-\u9fff]", body))
print("总中文字符:", cn)
print("正文中文字符(不含封面):", body_cn)
print("SVG 数:", out.count("<svg"))
print("WROTE", BASE + "主文_沪八条二手转保租单元经济_重做.md")
