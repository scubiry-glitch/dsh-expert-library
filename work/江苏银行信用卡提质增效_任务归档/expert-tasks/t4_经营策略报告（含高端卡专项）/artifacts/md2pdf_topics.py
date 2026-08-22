#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""高级版系列页 V2：一个命题一页，内容充实版。
样式复刻附件《四大卡组织境外能力对比_竖版A4_高级版》。数据全部来自 01-05 交付物（标注证据等级），禁止编造。
"""
from weasyprint import HTML

PDF_PATH = "江苏银行信用卡提质增效_命题一页_高级版.pdf"

CSS = """
@page { size: A4; margin: 0; }
* { margin:0; padding:0; box-sizing:border-box; }
:root {
  --ink:#213a33; --line:#cccfc6; --bg2:#f6f5f0;
  --card:#edefe8; --paper:#fffff9; --accent:#9b4c38; --muted:#5f6d68; --good:#2c6b4f;
}
body { font-family:"Noto Sans CJK SC","WenQuanYi Micro Hei","PingFang SC",sans-serif;
  background:#e2e4de; color:#1f2a26; font-size:10pt; line-height:1.58; }
.page { width:210mm; min-height:297mm; padding:13mm 14mm 16mm; margin:0 auto 6mm; background:var(--bg2); position:relative; page-break-after:always; }
.page:last-child { page-break-after:auto; }
.brand { display:flex; justify-content:space-between; align-items:baseline; border-bottom:3px solid var(--ink); padding-bottom:5px; margin-bottom:10px; }
.brand .en { font-family:"Liberation Sans","Arial",sans-serif; font-size:8pt; letter-spacing:3px; color:var(--ink); font-weight:700; }
.brand .cn { font-size:10pt; font-weight:700; color:var(--ink); }
.brand .meta { font-size:7.2pt; color:var(--muted); text-align:right; line-height:1.5; }
.lead { background:var(--ink); color:#f2f5ef; border-radius:6px; padding:9px 13px; margin-bottom:9px; }
.lead .kicker { font-size:7pt; letter-spacing:3px; color:#b9c9bd; margin-bottom:3px; }
.lead p { font-size:10.5pt; font-weight:700; line-height:1.6; }
.lead p .hl { color:#e8c9a0; }
.sumcard { display:flex; gap:7px; margin:7px 0 10px; }
.sc { flex:1; background:var(--card); border:1px solid var(--line); border-top:4px solid var(--ink); border-radius:6px; padding:7px 9px; }
.sc .n { font-family:"Liberation Sans","Arial",sans-serif; font-size:15pt; font-weight:800; color:var(--accent); line-height:1.1; }
.sc .n small { font-size:7pt; color:var(--muted); font-weight:500; }
.sc .t { font-size:8.3pt; font-weight:700; color:var(--ink); margin:2px 0 1px; }
.sc .d { font-size:7pt; color:var(--muted); line-height:1.42; }
.sec { display:flex; align-items:center; gap:8px; margin:11px 0 5px; }
.sec .zh { font-size:11pt; font-weight:800; color:var(--ink); letter-spacing:1px; }
.sec .en { font-family:"Liberation Sans","Arial",sans-serif; font-size:6.6pt; letter-spacing:2px; color:var(--accent); font-weight:700; }
.sec .bar { flex:1; height:2px; background:var(--line); }
.cols { display:flex; gap:8px; }
.col { flex:1; }
.card { background:var(--card); border:1px solid var(--line); border-radius:6px; padding:7px 9px; margin-bottom:7px; }
.card.dark { background:var(--ink); color:#eef2ec; }
.card.dark .t { color:#e8c9a0; }
.card.dark li { color:#eef2ec; }
.card .t { font-size:8.4pt; font-weight:800; color:var(--ink); margin-bottom:3px; }
.card .v { font-family:"Liberation Sans","Arial",sans-serif; font-size:14pt; font-weight:800; color:var(--accent); }
.card .v small { font-size:7pt; color:var(--muted); font-weight:500; }
.card ul { padding-left:12px; }
.card li { font-size:7.7pt; margin-bottom:2px; line-height:1.48; }
.card p { font-size:7.7pt; line-height:1.5; }
.card .src { font-size:6.6pt; color:var(--muted); margin-top:2px; }
table { width:100%; border-collapse:collapse; margin:4px 0 7px; font-size:7.3pt; }
th { background:var(--ink); color:#f2f5ef; padding:3.6px 5px; text-align:left; font-weight:700; }
td { border:1px solid var(--line); padding:3.4px 5px; vertical-align:top; background:#fffdf8; }
tr:nth-child(even) td { background:var(--bg2); }
td.good { color:var(--good); font-weight:700; }
td.bad { color:var(--accent); }
.steps { display:flex; gap:7px; margin:5px 0 8px; }
.step { flex:1; background:var(--paper); border:1px solid var(--line); border-radius:6px; padding:7px 9px; }
.step .no { font-family:"Liberation Sans","Arial",sans-serif; font-size:11pt; font-weight:800; color:var(--accent); }
.step .tt { font-size:8.2pt; font-weight:800; color:var(--ink); margin:2px 0 2px; }
.step p { font-size:7.1pt; color:var(--muted); line-height:1.48; }
.trigger { display:flex; gap:5px; margin:5px 0 7px; flex-wrap:wrap; }
.tr { flex:1 1 18%; min-width:33mm; background:#fffdf8; border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:4px; padding:5px 7px; }
.tr .k { font-size:7.6pt; font-weight:800; color:var(--ink); }
.tr .v2 { font-size:6.8pt; color:var(--muted); margin-top:1px; line-height:1.42; }
.warn { background:#fff5f0; border:1px solid #f0cfc0; border-radius:6px; padding:7px 10px; margin:6px 0; }
.warn .t { font-size:8.2pt; font-weight:800; color:#b3421f; margin-bottom:2px; }
.warn p, .warn li { font-size:7.2pt; color:#6a3a28; line-height:1.5; }
.warn ul { padding-left:12px; }
.footnote { font-size:6.6pt; color:var(--muted); margin-top:7px; line-height:1.5; border-top:1px solid var(--line); padding-top:3px; }
.watermark { position:absolute; bottom:8mm; right:14mm; font-family:"Liberation Sans",sans-serif; font-size:6pt; letter-spacing:2px; color:#9aa49d; }
.wm-big { position:absolute; top:44%; right:-8mm; transform:rotate(-90deg); font-family:"Liberation Sans",sans-serif; font-size:24pt; letter-spacing:10px; color:rgba(33,58,51,0.05); font-weight:800; white-space:nowrap; }
"""

def page(no, total, cn, en_title, wm, lead_kicker, lead_text, body_html, footnote):
    return f"""
<div class="page">
  <div class="wm-big">{wm}</div>
  <div class="brand">
    <div><div class="en">JIANGSU BANK · CREDIT CARD STRATEGY</div>
    <div class="cn">{cn}</div></div>
    <div class="meta">2026.08 · DISCUSSION DRAFT<br>{en_title}<br>PAGE {no}/{total}</div>
  </div>
  <div class="lead"><div class="kicker">{lead_kicker}</div><p>{lead_text}</p></div>
  {body_html}
  <div class="footnote">{footnote}</div>
  <div class="watermark">FOR DISCUSSION ONLY · 江苏银行零售金融</div>
</div>"""

TOTAL = 7

# ============ P1 现状诊断（充实） ============
p1_body = f"""
<div class="sumcard">
  <div class="sc"><div class="n">-153<small> 元/卡/年</small></div><div class="t">存量每有效卡净亏损（2026H1 年化）</div><div class="d">每激活卡 -254 元；净收入 2024→2026H1 累计 -57.28%</div></div>
  <div class="sc"><div class="n">330<small> 万张</small></div><div class="t">有效卡（-6.69%）</div><div class="d">累计卡 590.12 万但有效仅 330 万；30 天活跃率 26.1%</div></div>
  <div class="sc"><div class="n">65.7%<small> 收入占比</small></div><div class="t">依赖分期息费</div><div class="d">利息 28.5%；佣金仅 1.85%（区域行 9.06%）</div></div>
  <div class="sc"><div class="n">3.41%<small> 不良率</small></div><div class="t">风险上行</div><div class="d">较年初 +1.25pp；损失率 2.56%；EVA 收益率 -2.85%</div></div>
</div>
<div class="sec"><span class="zh">四维诊断</span><span class="en">CURRENT STATE</span><span class="bar"></span></div>
<table>
  <tr><th style="width:13%">维度</th><th>关键事实</th><th style="width:20%">证据</th></tr>
  <tr><td><b>规模与交易</b></td><td>累计卡 590.12 万 vs 有效卡 330.05 万（-6.69%）、有效主卡持卡人 308.63 万（-6.66%）、卡户比 1.07；单月交易 19.68 亿（-27.04%）、笔数 678.79 万（-20.48%）；银数托管行比较交易降超 40%（行业 10-15%）</td><td>E1/E2（167）；E2（231）</td></tr>
  <tr><td><b>活跃与激活</b></td><td>激活率 60.39%（低区域行 15.1pp）、30 天活跃率 26.1%（低 18.8pp）、90 天睡眠率 69.95%、540 天睡眠率 55.62%（+12.86pp）、本月新增 0.34 万张（-11.19%）</td><td>E1/E2（167）</td></tr>
  <tr><td><b>收入与收益</b></td><td>月收入合计 20,293 万；卡均收入 61.49 元/月（-13.73%）；对客收益率 4.90%（2026H1）；FTP 2.30%；佣金缺口静态 ≈1.76 亿/年（vs 区域行 9.06%）</td><td>E1/E2；E0/E2</td></tr>
  <tr><td><b>资产与风险</b></td><td>总授信 817.01 亿、透支余额 186.88 亿（-36.14%）、户均透支 5,739 元；核销还原不良生成 21.52/13.59/5.32 亿（24/25/H1）；三业务切片：线下分期 0.67% / 循环+线上 3.26% / 协商还款类 21.44%</td><td>E1/E2；E0/E2</td></tr>
</table>
<div class="warn"><div class="t">口径警示（Q01-Q06）</div><ul>
<li>2026H1 与全年不可直接比较（率值已×2 年化）；营业净收入是否已扣 FTP 待确认（Q02）；三套收入口径分列（Q03）</li>
<li>分期渗透率 39.68% ≠ 交易/余额分期率（Q04）；有效卡/激活卡/活跃卡三分母（Q05）；坏账率 3.41% 同比 vs 较年初不同基期（Q06）</li></ul></div>
"""
p1_foot = "数据来源：内部复盘0814（E0/E2）、银联数据月报2026-07 p6-7/45-54（E1/E2，商业信息不得转载）、jsbank_internal.db（E0）、个贷周报（E0）。详见 01/02 交付物。"

# ============ P2 客户群分层（充实） ============
p2_body = f"""
<div class="sumcard">
  <div class="sc"><div class="n">7.6<small> 万户</small></div><div class="t">境外消费客群</div><div class="d">72 万笔 / 4.6 亿元（2025-07~2026-06）</div></div>
  <div class="sc"><div class="n">1.85×<small> 频次 / 2.71× EVA</small></div><div class="t">境外 vs 仅境内</div><div class="d">户均消费 259 次 vs 140 次；EVA 945 元 vs 349 元</div></div>
  <div class="sc"><div class="n">6.76<small> 万 AUM</small></div><div class="t">VISA 境外客群人均</div><div class="d">人均 EVA 3,207 元（银联境外 818 元，≈6 倍）</div></div>
  <div class="sc"><div class="n">1.6-2.6%<small> 渗透率</small></div><div class="t">高端卡试点占境外客群</div><div class="d">财私+留学生+VISA 高价值名单交叉邀约</div></div>
</div>
<div class="sec"><span class="zh">五类客群分层经营</span><span class="en">CUSTOMER SEGMENTS</span><span class="bar"></span></div>
<table>
  <tr><th style="width:12%">客群</th><th>画像依据（事实）</th><th style="width:19%">对应产品线</th><th style="width:18%">准入/邀约</th></tr>
  <tr><td><b>财私/企业高管</b></td><td>VISA 客群 AUM 6.76 万、EVA 3,207 元；本科 46%、30-49 岁；境外回佣高</td><td>VISA 套卡 + 运通蓝盒子</td><td>存款 800-1,000 万满 3 个月（浦发口径）</td></tr>
  <tr><td><b>留学生家庭</b></td><td>VISA 教育/休闲/医疗场景占比 19% 领先；主卡+附卡一站式</td><td>VISA 留学套卡</td><td>父母主卡 + 子女附卡（免年费/500 元档）</td></tr>
  <tr><td><b>商旅客群</b></td><td>还款来源稳定、风险低于资金周转类；浦发额度 30 万起</td><td>VISA 商旅套卡、银联钻石</td><td>出境≥2 次或境外消费≥5,000 元（建议值）</td></tr>
  <tr><td><b>高净值旗舰</b></td><td>欧美长线出行+高消费+权益敏感；美国人数第3/金额第2</td><td>运通蓝盒子→百夫长</td><td>财私+留学生+VISA 高价值名单交叉</td></tr>
  <tr><td><b>AI 主题客群</b></td><td>农行 AI 卡 880 元 2026-07 上市（Token 券/MiniMax）</td><td>万事达 AI 卡</td><td>全量申请+消费达标开卡礼（效果待核实⑤）</td></tr>
</table>
<div class="sec"><span class="zh">邀约名单三步分层 + 绑定机制</span><span class="en">TARGETING &amp; ENGAGEMENT</span><span class="bar"></span></div>
<div class="steps">
  <div class="step"><div class="no">01</div><div class="tt">卡组织子集</div><p>银联客群（近八成消费额）vs VISA 客群（20.6% 消费额）</p></div>
  <div class="step"><div class="no">02</div><div class="tt">价值子集</div><p>取 EVA 分位前 20% VISA 客群（高 AUM/EVA）</p></div>
  <div class="step"><div class="no">03</div><div class="tt">场景子集</div><p>欧美长线+高消费+教育/医疗场景（美国金额第2）</p></div>
</div>
<div class="card"><div class="t">消费绑定机制（浦发模式，可迁移）</div>
<ul><li><b>年费筛选</b>：首年免年费 + 20 万积分抵扣（不足扣现金、不支持差额）→ 筛选真实消费客户</li>
<li><b>消费达标</b>：月消费 18,888 元→次月 6-8 张观影票 → 月稳定消费近 2 万、年积分覆盖年费抵扣（3,600 档达标线；2,000/880 档等比 12,000/6,000 元）</li>
<li><b>积分放大</b>：6 倍积分活动 + 家庭合并口径，降低抵扣门槛、强化消费引导</li></ul></div>
"""
p2_foot = "数据来源：境外消费分析报告 230/234、浦发纪要 236、卡组织方材料 226/227。财私名单/留学生户数/欧美长线子集规模待核实⑥。"

# ============ P3 同业对标（充实） ============
p3_body = f"""
<div class="sumcard">
  <div class="sc"><div class="n">50,445<small> 元/卡/年</small></div><div class="t">同业单卡年消费均值（2018）</div><div class="d">区间 [32,004, 74,400]，8 家行</div></div>
  <div class="sc"><div class="n">19.6%<small> 分期率代理均值</small></div><div class="t">同业（2018）</div><div class="d">区间 [15.2%, 24.0%]（卡均贷款/卡年交易额）</div></div>
  <div class="sc"><div class="n">1.54%<small> 不良率均值</small></div><div class="t">同业（2018）</div><div class="d">区间 [0.98%, 2.15%]（工行/光大未披露）</div></div>
  <div class="sc"><div class="n">573<small> 元/月/卡</small></div><div class="t">江苏卡均消费（2026-07）</div><div class="d">≈同业月均交易额 1/5~1/9（不可比，仅方向）</div></div>
</div>
<div class="sec"><span class="zh">8 家行特征（2018，E1 用户表）</span><span class="en">PEER BENCHMARK</span><span class="bar"></span></div>
<table>
  <tr><th style="width:8%">银行</th><th>特征</th><th style="width:13%">单卡年消费</th><th style="width:10%">分期率</th><th style="width:9%">不良率</th><th style="width:12%">卡均贷款</th></tr>
  <tr><td><b>招行</b></td><td>收入质量与消费活跃双高、低不良</td><td>45,000</td><td>15.2%</td><td>1.11%</td><td>6,825</td></tr>
  <tr><td><b>建行</b></td><td>规模大、不良最低</td><td>41,088</td><td>21.8%</td><td class="good">0.98%</td><td>8,943</td></tr>
  <tr><td><b>工行</b></td><td>规模大、消费强度偏低</td><td>32,004</td><td>21.6%</td><td>未披露</td><td>6,915</td></tr>
  <tr><td><b>中信</b></td><td>收入与信贷深度并重</td><td>46,992</td><td>21.2%</td><td>1.85%</td><td>10,987</td></tr>
  <tr><td><b>平安</b></td><td>消费活跃较强、风险中低</td><td>52,884</td><td>17.4%</td><td>1.32%</td><td>9,187</td></tr>
  <tr><td><b>浦发</b></td><td>信贷/分期深度高但波动大</td><td>48,168</td><td class="bad">24.0%</td><td>1.81%</td><td>11,554</td></tr>
  <tr><td><b>民生</b></td><td>高消费高信贷伴随较高风险</td><td class="bad">74,400</td><td>17.8%</td><td class="bad">2.15%</td><td>13,228</td></tr>
  <tr><td><b>光大</b></td><td>消费收入中等、风险数据不完整</td><td>63,024</td><td>17.5%</td><td>未披露</td><td>11,054</td></tr>
</table>
<div class="sec"><span class="zh">2025 同业主线与江苏定位</span><span class="en">2025 PEERS vs JSBANK</span><span class="bar"></span></div>
<div class="cols">
  <div class="col"><div class="card"><div class="t">同业 2025 主线（E3）</div>
  <ul><li>场景分期：交行汽车分期 +23.19%、浦发新能源 +181.73 亿；上海银行汽车分期 +57.64%</li>
  <li>双卡联动+优质客群筛选：中信新发卡优质客群 59.21%（+8.23pp）；招行双卡客户占比 68.37%</li>
  <li>行业：卡量 6.96 亿张（较峰值 -1.11 亿）、额度使用率约 34%、资产收益率 8%-10%、批量不良转让 &gt;1,000 亿+ABS &gt;2,200 亿</li></ul></div></div>
  <div class="col"><div class="card dark"><div class="t">江苏反向信号（E0）</div>
  <ul><li>2026H1 透支较年初 -55.7 亿（约 -15%）；区域行（徽商 +21%/南京 +40%/齐鲁 +30%）正向</li>
  <li>额度使用率 22.87%（低行业均值约 11pp）；对客收益率 4.90% vs 行业 8%-10%（口径待核）</li>
  <li>协商还款类 21.44% 高风险点；差距在贷前客群选择与场景承接</li></ul></div></div>
</div>
"""
p3_foot = "数据来源：用户表（E1，t1 核验 0 差异）、2025 年报专题解读（E3）、个贷周报（E0）。期间错配（2016-2018 vs 2026）+口径差异，全部横向结论仅参照方向。完整矩阵见 03 交付物。"

# ============ P4 UE 模型与转正测算（充实） ============
p4_body = f"""
<div class="sumcard">
  <div class="sc"><div class="n">-153<small> 元/卡/年</small></div><div class="t">存量 UE（E2 校验）</div><div class="d">191.5 收入 - 322.4 核销还原不良 - 22.4 直接费用（2026H1 年化）</div></div>
  <div class="sc"><div class="n">≈24<small> 元/卡</small></div><div class="t">盈亏平衡 CAC（基准）</div><div class="d">全区间 [-89, +138]；任何现实 CAC（200+）均超——粗放新增无正 UE</div></div>
  <div class="sc"><div class="n">0.199%<small> 有效交换率</small></div><div class="t">收入结构性短板</div><div class="d">回佣 13.68 元/年 ÷ 消费 6,876 元；线上支付为主所致</div></div>
  <div class="sc"><div class="n">-198→+1,478<small> 元/卡</small></div><div class="t">高端卡首年→次年（3,600 档）</div><div class="d">3 年回本 ≥635 张；LTV3/5/7 = 1,564/2,936/3,889 元（r3）</div></div>
</div>
<div class="sec"><span class="zh">UE 公式与收入结构（可复算）</span><span class="en">UE FORMULA</span><span class="bar"></span></div>
<div class="cols">
  <div class="col"><div class="card"><div class="t">公式（研究计划 6.1）</div>
  <p style="font-size:7.2pt;">UE_preCAC = 交换收入 + 分期净贡献 + 年费其他 − 奖励/权益 − 资金 − ECL − 服务 − 欺诈 + 回收<br>UE_afterCAC = UE_preCAC − CAC；ECL = Σ PD×LGD×EAD×DF（本版用核销还原流量代理 E2）</p></div>
  <div class="card"><div class="t">卡均收入结构（2026-07，元/卡/月 = 61.49）</div>
  <ul><li>利息 17.50（28.5%）+ 分期息费 40.42（<b>65.7%</b>）+ 回佣 1.14（1.9%）+ 年费/其他 2.43（4.0%）</li>
  <li>回佣中收 2024 1.5 亿 → 2025 0.88 亿（线上循环回佣走弱，E0/E2）</li></ul></div></div>
  <div class="col"><div class="card dark"><div class="t">四指标杠杆排序（E4 标准化弹性）</div>
  <ul><li><b>CAC 管控</b> &gt; <b>客群风险（坏账/m1）</b> &gt; <b>分期深度</b> &gt; <b>单卡消费量</b></li>
  <li>CAC +100 → −100；坏账 +1pp → −33~−55（≈消费提升的 10 倍）；分期 +10pp → +9.8~+39.0；消费 +100 元/月 → +1.2~+7.3（净贡献率仅 0.31%）</li>
  <li>m1 0.3→0.2 → +37.4 元/卡（客群质量改善直接收益）</li></ul></div></div>
</div>
<div class="sec"><span class="zh">转正路径：情景测算（首年 afterCAC，元/激活卡）</span><span class="en">BREAKEVEN SCENARIOS</span><span class="bar"></span></div>
<table>
  <tr><th>情景</th><th>CAC</th><th>分期率</th><th>消费</th><th>坏账(m1)</th><th>UE_afterCAC</th><th>LTV1-3y after</th></tr>
  <tr><td>基准（现状）</td><td>500</td><td>30%</td><td>664</td><td>3.41%(0.3)</td><td class="bad">-475.6</td><td>-578.9</td></tr>
  <tr><td>改善A（经营）</td><td>300</td><td>40%</td><td>730</td><td>3.41%</td><td class="bad">-251.7</td><td>-329.2</td></tr>
  <tr><td>改善B（客群）</td><td>300</td><td>30%</td><td>664</td><td>m1=0.2</td><td class="bad">-238.2</td><td>-230.6</td></tr>
  <tr><td><b>改善A+B</b></td><td>300</td><td>40%</td><td>730</td><td>m1=0.2</td><td class="bad">-210.6</td><td>-166.1</td></tr>
  <tr><td>承压</td><td>800</td><td>20%</td><td>570</td><td>5.0%</td><td class="bad">-840.7</td><td>-1,090.8</td></tr>
  <tr><td>压力</td><td>1,000</td><td>15%</td><td>400</td><td>7.42%</td><td class="bad">-1,082.3</td><td>-1,380.0</td></tr>
</table>
<div class="warn"><div class="t">转正结论（事实 vs 假设分离）</div><ul>
<li><b>事实（E2）</b>：存量每卡年亏 ≈153 元；收入 65.7% 依赖分期；有效交换率 ≈0.2%；对客收益率 4.90% 低于同业 8-10%</li>
<li><b>假设（E4）</b>："改善A+B"（CAC300+分期40%+消费+10%+优质客群）首年仍 -210.6 元/卡——<b>必须叠加收入结构转型（场景分期/年费/综合经营）或成本重构，或 CAC 压至 &lt;100 元</b>；高端卡转正引擎见 P5/P6</li></ul></div>
"""
p4_foot = "模型：t2 参数表（30 项带证据等级），情景与网格见 03 交付物；全部敏感性为 E4 参数区间（锚定 E2 实际值），非利润预测；P0 数据补齐后重算。"

# ============ P5 卡组织组合（充实） ============
p5_body = f"""
<div class="sumcard">
  <div class="sc"><div class="n">1</div><div class="t">一张境内底座 · 银联</div><div class="d">境外占近八成（信用卡 59.4%+借记 20.0%）；零增量成本规模化（2026Q3 起）</div></div>
  <div class="sc"><div class="n">2</div><div class="t">两张境外通用 · VISA/万事达</div><div class="d">VISA 套卡补位（2026Q4-27Q1）；万事达 AI 卡（NUCC 已持牌，2023-11）</div></div>
  <div class="sc"><div class="n">1</div><div class="t">一个高端旗舰 · 运通</div><div class="d">蓝盒子试点 1,200-2,000 张、3,600 元档、银数通道（≈115 万）；2026 年内签约（首年减免窗口）</div></div>
</div>
<div class="sec"><span class="zh">四大卡组织 · 一眼看懂</span><span class="en">NETWORK POSITIONING</span><span class="bar"></span></div>
<table>
  <tr><th style="width:10%">维度</th><th>银联</th><th>万事达</th><th>VISA</th><th>运通</th></tr>
  <tr><td><b>全球通用性</b></td><td>亚太优势明显；184 国</td><td>欧美长线强</td><td>受理最广；200+ 国</td><td>高端商户强，长尾弱</td></tr>
  <tr><td><b>汇率体验</b></td><td class="good">刷卡日汇率，人民币直转（1 次换汇）</td><td>入账日汇率，约 3 天波动（2 次换汇）</td><td>入账日汇率，约 3 天波动（2 次换汇）</td><td class="good">刷卡日汇率，人民币直转（1 次换汇）</td></tr>
  <tr><td><b>高端权益</b></td><td>境内生态、本地优惠</td><td>旅行权益灵活可定制</td><td>取决于发卡行经营</td><td class="good">礼宾与身份感最强（FHR/THC 2,200+ 高奢酒店）</td></tr>
  <tr><td><b>回佣（发卡行）</b></td><td>境内约 2‰；境外约 1.4‰</td><td>境外约 1.4‰</td><td>境外约 1.4‰</td><td>境外平均约 1%（商户费率 2-3%）</td></tr>
  <tr><td><b>主要短板</b></td><td>欧美高端服务相对弱</td><td>国内品牌认知偏弱</td><td>境内需双标/套卡（清算落地待确认③）</td><td>接入成本较高（银数通道≈115 万 vs 直连 400 万）</td></tr>
</table>
<div class="sec"><span class="zh">推进节奏与测算（r3 修正后）</span><span class="en">PHASED ROADMAP</span><span class="bar"></span></div>
<div class="steps">
  <div class="step"><div class="no">01</div><div class="tt">先做可规模化双网络</div><p>银联 + VISA/万事达；完成权益、费率、成本与收益测算（M1 2026Q3 / M2 2026Q4-27Q1）</p></div>
  <div class="step"><div class="no">02</div><div class="tt">再做小样本旗舰试点</div><p>运通蓝盒子 1,200-2,000 张定向邀约；银数通道约 115 万+20 万/年；3 年回本 ≥635 张（M3 2027H1 发卡）</p></div>
  <div class="step"><div class="no">03</div><div class="tt">最后按风险收益扩围</div><p>发卡 ≥2,800 张后再评估百夫长（M4）；万事达 AI 卡 2027H1 前决策（M5，先取报价与农行效果数据）</p></div>
</div>
<div class="warn"><div class="t">不建议的做法 &amp; 决策底线</div><ul>
<li>不做全客群强制双卡，不以"卡组织越多越高级"为目标；以出境频次/目的地/消费场景/年费意愿触发配置</li>
<li>运通 98% 留存为 2023 美国口径不可外推；蓝盒子授权费待核实②不得默认免费（r3）；悲观情景阈值 3,519 张、NPV3 盈亏平衡 5,580 张</li></ul></div>
"""
p5_foot = "数据来源：卡组织方材料 226/227/233、境外消费分析 230/234、银数纪要 231、浦发纪要 236、内部上会 235。测算见 05 交付物与 model_b/model_c（r3 修正后可复算）。"

# ============ P6 产品组合（充实） ============
p6_body = f"""
<div class="cols">
  <div class="col">
    <div class="card" style="border-top:4px solid var(--good);"><div class="t">增 · 加投（引擎与入口）</div>
      <ul>
        <li><b>主题卡</b>：收入引擎（透支 77%/收入 76%）；爱车卡卡均收入 177 元/月、不良仅 1.86%</li>
        <li><b>单位卡</b>：低成本对公/代发入口（活跃 41.9%、不良 0.70% 最优、卡均消费 2,947 元）</li>
        <li><b>标准卡</b>：消费/活跃双高（卡均消费 1,157 元、活跃 35.6%）但不良 5.62% → 风控+差异化定价</li>
        <li><b>高端卡四线</b>：银联白金/钻石 + VISA 套卡 + 万事达 AI + 运通蓝盒子（见 P5）</li>
      </ul>
    </div>
  </div>
  <div class="col">
    <div class="card" style="border-top:4px solid var(--ink);"><div class="t">并 · 归并整合（去重复补贴）</div>
      <ul>
        <li>标准卡金卡 A/B（卡均收入 91.38 vs 49.20 元/月、不良 6.57% vs 7.49%）同质 → 合并或差异化定价</li>
        <li>"无界"家族三产品（数字+移动+京东 ≈82 万张）评估归并</li>
        <li>电商双联名（蚂蚁宝藏 ≈99 万张 + 京东 ≈24 万张）并表核算补贴</li>
        <li>留学生卡并入 VISA 套卡线；Token 卡作积分/权益底座</li>
      </ul>
    </div>
  </div>
  <div class="col">
    <div class="card" style="border-top:4px solid var(--accent);"><div class="t">退 · 限额与专项处置（风险）</div>
      <ul>
        <li><b>E融卡</b>（不良 26.06%/损失率 22.03%）：专项处置/停止新发</li>
        <li><b>分期卡类</b>（不良 11.27%、活跃率仅 5.25%）：限额重构，转场景化（与现金分期 6.66% 内部替代）</li>
        <li><b>联名卡</b>（39.3% 卡量仅 7.7% 收入、激活率 40.7% 最低）：降权益/盘活，不与高端卡抢客群</li>
        <li>绿色低碳卡（不良 5.17%）收入高但风险偏高 → 客群筛选</li>
      </ul>
    </div>
  </div>
</div>
<div class="sec"><span class="zh">六类产品贡献矩阵（银联 2026-07 横截面，E1/E2；派生 E4）</span><span class="en">PRODUCT CONTRIBUTION</span><span class="bar"></span></div>
<table>
  <tr><th style="width:11%">产品</th><th>卡量</th><th>卡量占比</th><th>收入占比</th><th>卡均收入</th><th>活跃率</th><th>不良率</th><th style="width:14%">定位</th></tr>
  <tr><td><b>主题卡</b></td><td>126.5 万</td><td>38.3%</td><td class="good">75.7%</td><td>121.47 元/月</td><td>32.1%</td><td>3.13%</td><td>高价值引擎</td></tr>
  <tr><td><b>联名卡</b></td><td>129.8 万</td><td class="bad">39.3%</td><td class="bad">7.7%</td><td>11.97 元/月</td><td>20.4%</td><td>2.33%</td><td>低效沉睡</td></tr>
  <tr><td><b>标准卡</b></td><td>38.9 万</td><td>11.8%</td><td>11.2%</td><td>58.66 元/月</td><td class="good">35.6%</td><td class="bad">5.62%</td><td>潜力（风控）</td></tr>
  <tr><td><b>单位卡</b></td><td>8.21 万</td><td>2.5%</td><td>0.7%</td><td>16.64 元/月</td><td class="good">41.9%</td><td class="good">0.70%</td><td>入口（非利润中心）</td></tr>
  <tr><td><b>分期卡</b></td><td>25.0 万</td><td>7.6%</td><td>4.5%</td><td>36.76 元/月</td><td class="bad">5.25%</td><td class="bad">11.27%</td><td>风险（限额）</td></tr>
  <tr><td><b>其他（含E融卡）</b></td><td>1.69 万</td><td>0.5%</td><td>0.2%</td><td>21.42 元/月</td><td>32.8%</td><td class="bad">26.06%</td><td>专项处置</td></tr>
</table>
<div class="warn"><div class="t">边界纪律（Q07）</div><ul>
<li>组合结论基于银联横截面快照，禁止推导客户级结论；卡户比 1.07，产品大类不得简单相加推客户规模</li>
<li>6 项重复补贴/内部替代风险（电商双联名、无界家族、金卡双产品、分期卡 vs 现金分期、单位/公务卡重复发卡等，E4 待核）；透支口径差（199.68 vs 186.88 亿）待核</li></ul></div>
"""
p6_foot = "数据来源：银联数据月报 2026-07 产品大类 p88-94、t2 产品组合矩阵。UE初判未扣权益/服务/欺诈及应计-实收差（待补），仅排序参考。详见 02 交付物。"

# ============ P7 试点与监测（充实） ============
p7_body = f"""
<div class="sec"><span class="zh">财务决策：CAC 与补贴</span><span class="en">CAC &amp; SUBSIDY RULES</span><span class="bar"></span></div>
<div class="cols">
  <div class="col">
    <div class="card"><div class="t">CAC 分层上限（E4 方向性）</div>
      <ul>
        <li>存量普通卡：<b>≤24 元</b>/卡（盈亏平衡；全区间 [-89, +138]）</li>
        <li>优质客群：<b>&lt;70 元</b>/卡（LTV 1-3y 盈亏平衡约束）</li>
        <li>高端卡：综合贡献口径 ≤ 单卡 LTV + 客户综合贡献现值 − 权益/风险现值（VISA 客群 EVA 3,207 元/年、AUM 6.76 万；2,000 户纯新增 EVA≈641 万/年，仅纯新增上限）</li>
        <li>渠道 CAC 待补（P0-3），补齐前不做全网统一投放；<b>存量升级须对照组测增量，不得把存量 AUM/EVA 全计为新增</b></li>
      </ul>
    </div>
  </div>
  <div class="col">
    <div class="card"><div class="t">补贴 5 规则（R1-R5）</div>
      <ul>
        <li>R1 只绑定<b>增量</b>活跃/消费/分期，不绑发卡量（反事实基线）</li>
        <li>R2 对照组验证，无增量即停发</li>
        <li>R3 单卡补贴设上限（高端卡=年费留存 ≥60% 兑付）</li>
        <li>R4 睡眠卡不补贴（睡眠卡 84.6 万张占有效卡 65%）</li>
        <li>R5 权益预算年度总闸（优先复用银联返还品牌费与卡组织平台资源）</li>
      </ul>
    </div>
  </div>
</div>
<div class="sec"><span class="zh">试点三步推进 + 高端卡敏感性</span><span class="en">PILOT ROADMAP</span><span class="bar"></span></div>
<div class="steps">
  <div class="step"><div class="no">01</div><div class="tt">存量优化试点</div><p>单位卡入口+标准卡风控放量+场景分期（汽车/家装）承接贴息政策（覆盖 4 亿持卡人、拉动约 20% 新分期转化，E3）</p></div>
  <div class="step"><div class="no">02</div><div class="tt">高端卡旗舰试点</div><p>蓝盒子 1,200-2,000 张定向邀约；KPI=活卡率 ≥60%（近一年交易口径）+年费留存 ≥60%；3 年回本 ≥635 张</p></div>
  <div class="step"><div class="no">03</div><div class="tt">扩围决策</div><p>以风险调整后贡献决定放量；悲观阈值 3,519 张触发"不启动/缩量"；P0 数据到位后重算全部阈值</p></div>
</div>
<div class="card"><div class="t">高端卡敏感性（r3，第一敏感变量=年费留存率）</div>
<ul><li>年费留存 40%→80%：阈值 924→483 张（±46%）；活卡率 26%→60%：1,018→635 张；蓝盒子授权费 0→100 万/年：635→1,723 张（+114%）；权益成本 800→500 元：-16%；损失率 1.28%→2.56%：762 张</li></ul></div>
<div class="sec"><span class="zh">监测触发器（停止/回滚兜底）</span><span class="en">MONITORING TRIGGERS</span><span class="bar"></span></div>
<div class="trigger">
  <div class="tr"><div class="k">T1 · CAC &gt;100 元</div><div class="v2">暂停获客投放，回溯归因（无综合贡献证据时）</div></div>
  <div class="tr"><div class="k">T2 · 坏账率 &gt;4.15%</div><div class="v2">收紧授信、暂停高风险产品新发、加速出清（批量转让/ABS）</div></div>
  <div class="tr"><div class="k">T3 · 分期率连 2 季 &lt;20%</div><div class="v2">检查转化漏斗与贴息落地；客群恶化则回滚促销</div></div>
  <div class="tr"><div class="k">T4 · 活跃率 &lt;26% 或消费降幅 &gt;10%</div><div class="v2">权益/场景复盘；实验组无增量即停发补贴</div></div>
  <div class="tr"><div class="k">T5 · 高端卡专项</div><div class="v2">活卡率/年费留存 &lt;60%、发卡 &lt;500 张 → 复盘客群定位；场景分期 2 季负 UE → 收缩</div></div>
</div>
<div class="warn"><div class="t">决策底线</div><ul>
<li>7 项 P0 数据（CAC/权益核销/切片明细/运营分摊/回收/FTP 口径/飞书对标表）补齐前，所有阈值为 E4 情景，不得作正式政策承诺</li>
<li>高端卡旧回本/阈值/NPV 在蓝盒子报价与试点对照组补齐前不作投资决策输入（r3）；2026 年内完成银数续约+运通签约（首年减免窗口）</li></ul></div>
"""
p7_foot = "证据等级：E0 内部明细 / E1 年报公告 / E2 访谈复盘 / E3 可靠二手 / E4 假设。全部数字可追溯至 01-05 交付物及原资料（99wiki、银联月报 2026-07、内部复盘 2024-2026H1、用户对标表、高端卡战略 r3 测算）。"

pages = [
    ("P1/7 现状诊断", "CURRENT STATE DIAGNOSIS", "CURRENT STATE", "存量亏损、活跃失活、收入单一、风险上行", p1_body, p1_foot),
    ("P2/7 客户群分层", "CUSTOMER SEGMENTS", "CUSTOMER SEGMENTS", "高价值客群集中在境外/VISA，分层经营、定向邀约、消费绑定", p2_body, p2_foot),
    ("P3/7 同业对标", "PEER BENCHMARK", "PEER BENCHMARK", "同业消费/分期上行、江苏方向相反（仅参照方向）", p3_body, p3_foot),
    ("P4/7 UE 模型与转正测算", "UE MODEL & BREAKEVEN", "UE & BREAKEVEN", "存量 UE 为负、粗放新增不成立；转正=存量优化+高端卡引擎", p4_body, p4_foot),
    ("P5/7 卡组织组合", "CARD NETWORK STRATEGY", "NETWORK POSITIONING", "银联底座 + V/M 境外补位 + 运通旗舰：场景分工而非全能卡", p5_body, p5_foot),
    ("P6/7 产品组合", "PRODUCT PORTFOLIO", "PORTFOLIO ACTIONS", "增引擎、并重复、退风险：产品组合增/并/退", p6_body, p6_foot),
    ("P7/7 试点与监测", "PILOT & MONITORING", "PILOT & MONITORING", "CAC/补贴规则 + 三步试点 + 监测触发器兜底", p7_body, p7_foot),
]

html = "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='UTF-8'><title>江苏银行信用卡提质增效 · 命题一页（完善版）</title><style>" + CSS + "</style></head><body>"
for i, (cn, en, wm, lead, body, foot) in enumerate(pages, 1):
    html += page(i, TOTAL, cn, en, wm, "ONE TOPIC · ONE PAGE", lead, body, foot)
html += "</body></html>"

HTML(string=html).write_pdf(PDF_PATH)
print("PDF generated:", PDF_PATH)
