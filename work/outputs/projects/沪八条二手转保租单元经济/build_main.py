# -*- coding: utf-8 -*-
"""Build final main text: expert body + cover."""
import re, io

BASE = "/root/zhijian/dsh-expert-library/work/98wiki/projects/沪八条二手转保租单元经济/"

body = io.open(BASE + "专家版_主文.md", encoding="utf-8").read()

cover = '''<div class="cover">

<p class="kicker">98WIKI ｜ 贝壳域 · 深度研究</p>

<h1 class="title">沪八条把「收购二手住房」绑上保租房<br>中心城区二手房 → 保租房的资产转换单元经济</h1>

<p class="subtitle">收购定价 · 改造 CAPEX · 政策租金 · 出租运营 —— 四段资金平衡的条件边界与验证协议</p>

<hr class="rule">

<div class="meta" markdown="0">

<strong>研究类型</strong>：政策机制研究（当期高热选题 · PART_A_PASS · 选题门控 24/24）
<strong>数据基准</strong>：2026-08-22 ｜ 沪八条（2026-08-20 发布 / 08-21 施行）
<strong>研究口径</strong>：上海中心城区（含浦东外环内）二手住宅 → 保障性租赁住房
<strong>内部底座</strong>：收储三线估值 · 国企收购交易漏斗（8/19）· 收存转保现金流闭环（8/15）· 更新转租资金闭环（8/20）
<strong>外部来源</strong>：近一年 7 源（新华网/人民网/新浪财经×2/凤凰人民财讯/搜狐/上海市房管局），外部新增知识 12 条
<strong>参与研讨</strong>：政策制度·C（均衡发展派）· 政策制度·Q（存量运营派）· 政策制度·K（学术批判派）｜ 智见圆桌 2026-08-22

</div>

<div class="kpi-grid">

<div class="kpi-card"><div class="k">KPI-1 · 成立三条件</div><div class="v">7–8折 + 成本≤2% + 出租率≥90%</div><div class="s">三条件同时满足则单元经济成立；任一缺失退化为财政支撑的账面循环（可证伪）</div></div>

<div class="kpi-card"><div class="k">KPI-2 · 收益资金缺口</div><div class="v">r 1.4%–1.8% vs c ≥1.75%</div><div class="s">9折租金后回报率 1.4%–1.8%（2024 机构口径）低于再贷款 1.75%/市场化 2.5%+，负剪刀差靠折扣+低成本资金对冲</div></div>

<div class="kpi-card"><div class="k">KPI-3 · 运营硬约束</div><div class="v">出租率 ≥90%</div><div class="s">收储占比走高而出租率<85% 时，结构调节退化为价格托底，须调整收购节奏</div></div>

<div class="kpi-card"><div class="k">KPI-4 · 两季度裁决</div><div class="v">4 指标</div><div class="s">折扣率 · 改造周期 · 首次出租率 · 租金实现率；两季度窗口验证「成立/条件可行/降级」</div></div>

</div>

</div>

'''

lines = body.split("\n")
while lines and (not lines[0].strip() or lines[0].startswith("#")):
    lines.pop(0)
body2 = "\n".join(lines)
out = cover + body2
with io.open(BASE + "主文_沪八条二手转保租单元经济.md", "w", encoding="utf-8") as f:
    f.write(out)
cn = len(re.findall(r"[\u4e00-\u9fff]", out))
print("中文字符(含封面):", cn)
print("WROTE", BASE + "主文_沪八条二手转保租单元经济.md")
