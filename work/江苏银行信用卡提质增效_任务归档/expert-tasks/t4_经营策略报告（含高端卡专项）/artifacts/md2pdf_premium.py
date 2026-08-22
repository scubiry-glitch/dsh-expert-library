#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按附件《四大卡组织境外能力对比_竖版A4_高级版》样式，重排策略报告浓缩高级版 PDF。
配色/版式完全复刻附件：深墨绿 #213a33、暖棕 #9b4c38、灰绿底 #dee2db、浅卡 #edefe8。
"""
from weasyprint import HTML

PDF_PATH = "04_江苏银行信用卡提质增效经营策略报告_高级版.pdf"

html = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>江苏银行信用卡提质增效经营策略 · 高级版</title>
<style>
@page { size: A4; margin: 0; }
* { margin:0; padding:0; box-sizing:border-box; }
:root {
  --ink:#213a33; --ink2:#253c34; --line:#cccfc6; --bg:#dee2db; --bg2:#f6f5f0;
  --card:#edefe8; --card2:#d8ddd6; --paper:#fffff9; --accent:#9b4c38; --muted:#5f6d68;
}
body { font-family:"Noto Sans CJK SC","WenQuanYi Micro Hei","PingFang SC",sans-serif;
  background:#e2e4de; color:#1f2a26; font-size:10pt; line-height:1.62; }
.page { width:210mm; min-height:297mm; padding:16mm 15mm 20mm; margin:0 auto 6mm; background:var(--bg2); position:relative; page-break-after:always; }
.page:last-child { page-break-after:auto; }

/* ===== 页眉 ===== */
.brand { display:flex; justify-content:space-between; align-items:baseline; border-bottom:3px solid var(--ink); padding-bottom:6px; margin-bottom:14px; }
.brand .en { font-family:"Liberation Sans","Arial",sans-serif; font-size:8.5pt; letter-spacing:3px; color:var(--ink); font-weight:700; }
.brand .cn { font-size:10.5pt; font-weight:700; color:var(--ink); }
.brand .meta { font-size:7.5pt; color:var(--muted); text-align:right; }

/* ===== 头部主张 ===== */
.lead { background:var(--ink); color:#f2f5ef; border-radius:6px; padding:12px 16px; margin-bottom:12px; }
.lead .kicker { font-size:8pt; letter-spacing:3px; color:#b9c9bd; margin-bottom:5px; }
.lead p { font-size:11.5pt; font-weight:700; line-height:1.7; }
.lead p .hl { color:#e8c9a0; }

/* ===== 大数字卡 1+2+1 ===== */
.sumcard { display:flex; gap:10px; margin:10px 0 14px; }
.sc { flex:1; background:var(--card); border:1px solid var(--line); border-top:4px solid var(--ink); border-radius:6px; padding:10px 12px; }
.sc .n { font-family:"Liberation Sans","Arial",sans-serif; font-size:20pt; font-weight:800; color:var(--accent); line-height:1.1; }
.sc .t { font-size:9pt; font-weight:700; color:var(--ink); margin:3px 0 2px; }
.sc .d { font-size:7.8pt; color:var(--muted); line-height:1.5; }

/* ===== 分区标题 ===== */
.sec { display:flex; align-items:center; gap:10px; margin:18px 0 8px; }
.sec .zh { font-size:13pt; font-weight:800; color:var(--ink); letter-spacing:1px; }
.sec .en { font-family:"Liberation Sans","Arial",sans-serif; font-size:7.5pt; letter-spacing:2px; color:var(--accent); font-weight:700; }
.sec .bar { flex:1; height:2px; background:var(--line); }

/* ===== 双栏 ===== */
.cols { display:flex; gap:10px; }
.col { flex:1; }
.card { background:var(--card); border:1px solid var(--line); border-radius:6px; padding:10px 12px; margin-bottom:10px; }
.card.dark { background:var(--ink); color:#eef2ec; }
.card.dark .t { color:#e8c9a0; }
.card .t { font-size:9pt; font-weight:800; color:var(--ink); margin-bottom:5px; }
.card .v { font-family:"Liberation Sans","Arial",sans-serif; font-size:17pt; font-weight:800; color:var(--accent); }
.card .v small { font-size:8pt; color:var(--muted); font-weight:500; }
.card ul { padding-left:14px; }
.card li { font-size:8.6pt; margin-bottom:3px; line-height:1.55; }
.card p { font-size:8.6pt; line-height:1.6; }
.card .src { font-size:7pt; color:var(--muted); margin-top:4px; }

/* ===== 表格（六维风）===== */
table { width:100%; border-collapse:collapse; margin:6px 0 10px; font-size:8.2pt; }
th { background:var(--ink); color:#f2f5ef; padding:5px 7px; text-align:left; font-weight:700; }
td { border:1px solid var(--line); padding:4.5px 7px; vertical-align:top; background:#fffdf8; }
tr:nth-child(even) td { background:var(--bg2); }
td.good { color:#2c6b4f; font-weight:700; }
td.bad { color:var(--accent); }

/* ===== 步骤 ===== */
.steps { display:flex; gap:10px; margin:8px 0 12px; }
.step { flex:1; background:var(--paper); border:1px solid var(--line); border-radius:6px; padding:10px 12px; }
.step .no { font-family:"Liberation Sans","Arial",sans-serif; font-size:13pt; font-weight:800; color:var(--accent); }
.step .tt { font-size:9pt; font-weight:800; color:var(--ink); margin:3px 0 3px; }
.step p { font-size:7.9pt; color:var(--muted); line-height:1.55; }

/* ===== 监测触发 ===== */
.trigger { display:flex; gap:8px; margin:8px 0 10px; flex-wrap:wrap; }
.tr { flex:1 1 22%; min-width:38mm; background:#fffdf8; border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:4px; padding:7px 9px; }
.tr .k { font-size:8.5pt; font-weight:800; color:var(--ink); }
.tr .v2 { font-size:7.8pt; color:var(--muted); margin-top:2px; line-height:1.5; }

/* ===== 结尾 ===== */
.closing { background:var(--card); border:1px solid var(--line); border-radius:6px; padding:11px 14px; margin-top:10px; }
.closing .t { font-size:9.5pt; font-weight:800; color:var(--ink); margin-bottom:5px; }
.closing p { font-size:8.8pt; color:#33413c; line-height:1.65; }
.footnote { font-size:7pt; color:var(--muted); margin-top:10px; line-height:1.6; border-top:1px solid var(--line); padding-top:5px; }

.watermark { position:absolute; bottom:12mm; right:15mm; font-family:"Liberation Sans",sans-serif;
  font-size:6.5pt; letter-spacing:2px; color:#9aa49d; }
.wm-big { position:absolute; top:45%; right:-8mm; transform:rotate(-90deg); font-family:"Liberation Sans",sans-serif;
  font-size:28pt; letter-spacing:10px; color:rgba(33,58,51,0.06); font-weight:800; white-space:nowrap; }
</style>
</head>
<body>

<!-- ================= 第 1 页 ================= -->
<div class="page">
  <div class="wm-big">PREMIUM CARD STRATEGY</div>
  <div class="brand">
    <div><div class="en">JIANGSU BANK · CREDIT CARD STRATEGY</div>
    <div class="cn">江苏银行信用卡提质增效经营策略</div></div>
    <div class="meta">2026.08 · DISCUSSION DRAFT<br>V1.1 高级版（浓缩）</div>
  </div>

  <div class="lead">
    <div class="kicker">ONE-SENTENCE STRATEGY</div>
    <p>收缩风险敞口 → 盘活归并低效卡量 → 预算绑定<span class="hl">增量活跃/消费/分期</span>与优质客群 → 以监测触发器兜底；
    并行推进高端卡<span class="hl">「银联底座 + V/M 补位 + 运通蓝盒子旗舰试点」</span>，以客户综合贡献口径重估 CAC 边界。</p>
  </div>

  <div class="sumcard">
    <div class="sc"><div class="n">1</div><div class="t">先收缩风险</div><div class="d">E融卡 26.06% 不良专项处置；分期卡 11.27% 限额；协商还款类 21.44% 出清</div></div>
    <div class="sc"><div class="n">2</div><div class="t">再归并低效</div><div class="d">联名卡 39.3% 卡量仅 7.7% 收入降权益/盘活；金卡 A/B、无界家族≈82 万张并表</div></div>
    <div class="sc"><div class="n">3</div><div class="t">预算绑定增量</div><div class="d">CAC 分层上限 + 补贴绑定增量（对照组验证），不以发卡量考核</div></div>
    <div class="sc"><div class="n">4</div><div class="t">高端卡引擎</div><div class="d">银联规模化 + V/M 套卡补位 + 运通蓝盒子 1,200–2,000 张旗舰试点</div></div>
  </div>

  <div class="sec"><span class="zh">现状诊断</span><span class="en">CURRENT STATE</span><span class="bar"></span></div>
  <div class="cols">
    <div class="col">
      <div class="card"><div class="t">存量整体亏损，缺口扩大（E2 可复算）</div>
        <div class="v">-153<span style="font-size:9pt"> 元/有效卡/年</span></div>
        <p>2026H1 年化；营业净收入 2024→2026H1 累计 -57.28%（年化）；EVA 收益率 2026H1 -2.85%</p>
        <div class="src">来源：内部复盘0814 + 银联月报</div>
      </div>
      <div class="card"><div class="t">存量失活 &gt; 新增不足</div>
        <div class="v">26.1%<small> 30 天活跃率</small></div>
        <p>激活率 60.39%（低区域行 15.1pp）；90 天睡眠率 69.95%；540 天睡眠率 55.62%</p>
      </div>
    </div>
    <div class="col">
      <div class="card"><div class="t">收入结构单一</div>
        <div class="v">65.7%<small> 收入来自分期息费</small></div>
        <p>利息 28.5% / 分期息费 65.7% / 佣金仅 1.85%（区域行 9.06%）；卡均收入 61.49 元/月（-13.73% 同比）</p>
      </div>
      <div class="card"><div class="t">风险上行</div>
        <div class="v">3.41%<small> 不良率（仅本金）</small></div>
        <p>较年初 +1.25pp；损失率 2.56%；透支余额 186.88 亿（-36.14% 同比）</p>
      </div>
    </div>
  </div>

  <div class="sec"><span class="zh">四指标杠杆排序</span><span class="en">LEVERAGE RANKING</span><span class="bar"></span></div>
  <table>
    <tr><th style="width:16%">变量</th><th>弹性（±方向，E4 情景）</th><th style="width:30%">杠杆定位</th></tr>
    <tr><td><b>CAC</b></td><td>CAC +100 元 → UE -100 元/卡</td><td class="bad">第一杠杆：盈亏平衡 CAC ≈24 元/卡（现行获客成本远超）</td></tr>
    <tr><td><b>坏账率</b></td><td>+1pp → -33~-55 元/卡</td><td class="bad">第二杠杆：≈消费提升收益的 10 倍；上限 ≈4.15%（距当前 0.74pp）</td></tr>
    <tr><td><b>分期率</b></td><td>+10pp → +19.5（+9.8~+39.0）元/卡</td><td>第三杠杆：须用交易口径，禁止用银联渗透率替代</td></tr>
    <tr><td><b>单卡消费</b></td><td>+100 元/月 → +1.2~+7.3 元/卡</td><td>第四杠杆：增量消费净贡献率仅 ≈0.31%，不是主引擎</td></tr>
  </table>
  <div class="footnote">全部敏感性为 E4 参数区间（锚定 E2 实际值），非利润预测；P0 数据补齐后必须重算。</div>
</div>

<!-- ================= 第 2 页 ================= -->
<div class="page">
  <div class="wm-big">PRODUCT PORTFOLIO</div>
  <div class="brand">
    <div><div class="en">JIANGSU BANK · CREDIT CARD STRATEGY</div>
    <div class="cn">产品组合与高端卡专项</div></div>
    <div class="meta">2026.08 · DISCUSSION DRAFT<br>PAGE 2/3</div>
  </div>

  <div class="sec"><span class="zh">产品组合：增 / 并 / 退</span><span class="en">PORTFOLIO ACTIONS</span><span class="bar"></span></div>
  <div class="cols">
    <div class="col">
      <div class="card" style="border-top:4px solid #2c6b4f;"><div class="t">增 · 加投（引擎与入口）</div>
        <ul>
          <li><b>主题卡</b>：收入引擎（透支 77% / 收入 76%），强化支付黏性</li>
          <li><b>单位卡</b>：低成本对公/代发入口（活跃 41.9%、不良 0.70% 最优）</li>
          <li><b>标准卡</b>：风控筛选后稳健放量</li>
        </ul>
      </div>
      <div class="card" style="border-top:4px solid var(--ink);"><div class="t">并 · 归并整合（去重复补贴）</div>
        <ul>
          <li>金卡 A/B、无界家族（≈82 万张）、电商双联名并表核算</li>
          <li>识别 6 项重复补贴/内部替代（E4 待核）</li>
        </ul>
      </div>
    </div>
    <div class="col">
      <div class="card" style="border-top:4px solid var(--accent);"><div class="t">退 · 限额与专项处置（风险）</div>
        <ul>
          <li><b>E融卡</b>（不良 26.06%）：专项处置/停止新发</li>
          <li><b>分期卡类</b>（不良 11.27%）：限额重构</li>
          <li><b>联名卡</b>（39.3% 卡量 7.7% 收入）：降权益/盘活，不与高端卡抢客群</li>
        </ul>
      </div>
      <div class="card dark"><div class="t">边界纪律</div>
        <ul>
          <li>组合结论基于银联横截面快照，禁止推导客户级结论（Q07）</li>
          <li>卡户比 1.07，产品大类不得简单相加推客户规模</li>
        </ul>
      </div>
    </div>
  </div>

  <div class="sec"><span class="zh">高端卡专项：1 + 2 + 1</span><span class="en">PREMIUM CARD STRATEGY</span><span class="bar"></span></div>
  <div class="sumcard">
    <div class="sc"><div class="n">1</div><div class="t">境内底座 · 银联</div><div class="d">承接境内与亚太消费；零增量成本规模化（2026Q3 起）；境外占近八成</div></div>
    <div class="sc"><div class="n">2</div><div class="t">境外通用 · VISA / 万事达</div><div class="d">VISA 套卡补位（财私/留学/商旅，2026Q4–27Q1）；万事达 AI 卡探索（NUCC 已持牌）</div></div>
    <div class="sc"><div class="n">1</div><div class="t">高端旗舰 · 运通蓝盒子</div><div class="d">试点 1,200–2,000 张、3,600 元档；银数通道；2026 年内签约（首年减免窗口）</div></div>
  </div>

  <div class="sec"><span class="zh">高端卡商业测算（r3 修正后，可复算）</span><span class="en">MODEL OUTPUT</span><span class="bar"></span></div>
  <table>
    <tr><th>指标</th><th>数值</th><th>说明</th></tr>
    <tr><td>3 年回本阈值</td><td><b>≥635 张</b>（2 年 ≥1,212 张）</td><td>S1/3,600 档/银数·蓝盒子/活卡 60%/留存 60%</td></tr>
    <tr><td>回本周期（500→2,000 张）</td><td>3.69 → 1.63 年</td><td>1,000/1,200/1,500/2,000 = 2.21/2.01/1.82/1.63 年</td></tr>
    <tr><td>单卡现金流（3,600 档）</td><td>首年 -198 → 次年 +1,478 元</td><td>含资金成本 -445 / +1,231 元</td></tr>
    <tr><td>单卡 LTV（折现 8%）</td><td>3/5/7 年 = 1,564/2,936/3,889 元</td><td>不含固定成本</td></tr>
    <tr><td>综合 NPV3（基准）</td><td>1,200 张 +21 万 / 2,000 张 +146 万</td><td>悲观 2,000 张 -107 万（不作回本依据）</td></tr>
    <tr><td>第一敏感变量</td><td><b>年费留存率</b>（40%→80%：924→483 张）</td><td>&gt; 蓝盒子授权费 &gt; 权益成本 &gt; 活卡率</td></tr>
  </table>
  <div class="footnote">决策底线：蓝盒子正式报价、S3 客户/卡明细、试点对照组补齐前，旧回本/阈值/NPV 不作投资决策输入（r3）。</div>
</div>

<!-- ================= 第 3 页 ================= -->
<div class="page">
  <div class="wm-big">FINANCIAL DECISIONS</div>
  <div class="brand">
    <div><div class="en">JIANGSU BANK · CREDIT CARD STRATEGY</div>
    <div class="cn">财务决策 · 试点落地 · 监测兜底</div></div>
    <div class="meta">2026.08 · DISCUSSION DRAFT<br>PAGE 3/3</div>
  </div>

  <div class="sec"><span class="zh">财务决策：CAC 与消费补贴</span><span class="en">CAC &amp; SUBSIDY RULES</span><span class="bar"></span></div>
  <div class="cols">
    <div class="col">
      <div class="card"><div class="t">CAC 分层上限（E4 方向性）</div>
        <ul>
          <li><b>存量普通卡</b>：≤24 元/卡（盈亏平衡）</li>
          <li><b>优质客群</b>：&lt;70 元/卡（LTV 约束）</li>
          <li><b>高端卡</b>：综合贡献口径 —— ≤ 单卡 LTV + 客户综合贡献现值 − 权益/风险成本现值（VISA 境外客群人均 EVA 3,207 元/年、AUM 6.76 万）</li>
          <li>渠道 CAC 待补（P0-3），补齐前不做全网统一投放</li>
        </ul>
      </div>
    </div>
    <div class="col">
      <div class="card"><div class="t">补贴 5 规则（R1–R5）</div>
        <ul>
          <li>R1 补贴只绑定<b>增量</b>活跃/消费/分期，不绑发卡量</li>
          <li>R2 对照组+反事实基线验证，无增量即停发</li>
          <li>R3 单卡补贴设上限（高端卡=年费留存 ≥60% 兑付）</li>
          <li>R4 睡眠卡不补贴；R5 权益预算年度总闸</li>
        </ul>
      </div>
    </div>
  </div>

  <div class="sec"><span class="zh">试点与落地（三步推进）</span><span class="en">PILOT ROADMAP</span><span class="bar"></span></div>
  <div class="steps">
    <div class="step"><div class="no">01</div><div class="tt">先做可规模化双网络</div><p>银联 + VISA/万事达；完成权益、费率、成本与收益测算；场景分期（汽车/家装）试点承接贴息政策</p></div>
    <div class="step"><div class="no">02</div><div class="tt">再做小样本旗舰试点</div><p>财私+留学生+VISA 高价值定向邀约，运通蓝盒子 1,200–2,000 张，验证真实使用率与年费留存</p></div>
    <div class="step"><div class="no">03</div><div class="tt">最后按风险收益扩围</div><p>以客户贡献、活跃、境外交易及风险调整后收益决定放量；P0 数据到位后重算全部阈值</p></div>
  </div>

  <div class="sec"><span class="zh">监测触发器</span><span class="en">MONITORING TRIGGERS</span><span class="bar"></span></div>
  <div class="trigger">
    <div class="tr"><div class="k">T1 · CAC &gt;100 元</div><div class="v2">暂停获客投放，回溯归因（无综合贡献证据时）</div></div>
    <div class="tr"><div class="k">T2 · 坏账率 &gt;4.15%</div><div class="v2">收紧授信、暂停高风险产品新发、加速出清</div></div>
    <div class="tr"><div class="k">T3 · 分期率连续 2 季 &lt;20%</div><div class="v2">检查转化漏斗与贴息落地；客群恶化则回滚促销</div></div>
    <div class="tr"><div class="k">T4 · 活跃率 &lt;26% 或消费降幅 &gt;10%</div><div class="v2">权益/场景复盘；实验组无增量即停发补贴</div></div>
    <div class="tr"><div class="k">T5 · 高端卡（专项）</div><div class="v2">活卡率/年费留存 &lt;60%、发卡 &lt;500 张 → 复盘客群定位；悲观阈值触发不启动</div></div>
  </div>

  <div class="closing">
    <div class="t">对江苏银行的意义</div>
    <p>用「收缩风险 → 归并低效 → 预算绑定增量 → 高端卡引擎」的组合，同时改善存量亏损、活跃率、收入结构与风险敞口；
    高端卡以卡组织分工（银联底座 + V/M 通用 + 运通旗舰）提升高端客户获取与跨境消费活跃，避免权益与系统成本失控。
    最终决策还需补充：CAC 归因、权益核销、切片明细、财务口径确认（Q02）及高端卡合作报价/客户规模数据。</p>
  </div>

  <div class="footnote">
    证据等级：E0 内部明细 / E1 年报公告 / E2 访谈复盘 / E3 可靠二手 / E4 假设——本页关键数字标注于正文各表。
    数据来源：知识库 99wiki《江苏银行信用卡提质增效研究》、内部复盘 2024–2026H1、银联数据月报 2026-07（不得转载，仅限行内）、用户对标表（8 家行 2016–2018）、高端卡战略 r3 测算（model_b/model_c 可复算）。
    全部 UE/敏感性数值为 E4 情景（锚定 E2 实际值），非利润预测；待补数据一律写"待补"，不当作 0。
  </div>
  <div class="watermark">FOR DISCUSSION ONLY · 江苏银行零售金融</div>
</div>

</body>
</html>
"""

HTML(string=html).write_pdf(PDF_PATH)
print("PDF generated:", PDF_PATH)
