# -*- coding: utf-8 -*-
"""
build_brief.py — 由 methodology-records.json / verification-items.json 重新生成精简版 HTML。
版式沿用原精简版；修复三处缺陷：出处截断（source_short+title 全名）、「—」条目悬停初判、新增待验证 12 项小节。可重跑。
"""
import json, os, html

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "信用卡方法论提取-精简版.html")

data = json.load(open(os.path.join(BASE, "methodology-records.json"), encoding="utf-8"))
vdata = json.load(open(os.path.join(BASE, "verification-items.json"), encoding="utf-8"))
meta, layers = data["meta"], data["layers"]
vitems = vdata["items"]

comp = meta["comprehensive"]  # 综合可迁移性（完整版 6.4 为准）
comp_map = {i: g for g, ids in comp.items() for i in ids}

def esc(t):
    return html.escape(str(t), quote=True)

# ---------- 高迁移 17 条精选卡（文案与原精简版一致，经完整版核对） ----------
CARDS = {
"A01-03": ("全量活动没有对照组时，用 PSM-DID 匹配对照组，或以「活动前自然表现＋全量时间效应」构造平行世界；渗透率、增量金额、ROI 三条口径须写进分析模板。","外部冲击对活动组与全量影响不同质时简化法会失真；人群未拉齐则规模不可比。","把渗透率、增量金额、ROI 三条口径写进活动分析模板。"),
"A01-04": ("活动分品牌/促活/拉交易/拉分期四类，定位决定主指标：促活看实动率、拉交易看增量金额。用副指标给活动邀功（如品牌活动拿实动率）属口径错配。","立项时定位不清，任何指标都「看起来有提升」。","立项先填「定位→主指标→口径」三栏，低成本防自欺。"),
"A06-01": ("随机分组、单变量改动；判读必须双指标并读——相对提升看「对哪层更有效」，分布占比看「哪层更偏好」。","分层会稀释样本，不足须标注不置信；两指标可能反向，单看一个会得出相反结论。","分层后样本量不足时须标注不置信。"),
"A17-01": ("以「自然激活意愿×营销响应度」划四象限：摇摆户加投资源，无意愿户停止打扰；把「减少打扰」写进考核才能落地。","分类是建模输出，需防模型漂移；对不营销象限须确认合规与客诉影响。","把「减少打扰」写入考核，否则执行不下去。"),
"B-05-12": ("先建「会计科目↔经济实质」映射表，把分期手续费还原为利息，再谈收入结构比较；还原后实际利息占比约 70%。","不做映射直接比「利息占比」，同一实质算成两类收入、结论会反向；口径切换年份前后不可比。","跨行比较前先统一科目口径，建复算表。"),
"B-05-13": ("由期初金额、每期还款额、期数解出每期实际利率×12：名义 0.7%×12=8.4% 的分期，实际年化 14.26%。","含服务费/权益费必须全计入现金流；数值须按我方产品重算，不得直接引用算例。","建复算表，含服务费/权益费；14.26% 仅为算例。"),
"B-05-15": ("人均持有量的分母从全国人口换成 20–59 岁城镇居民：0.39 张变 0.95 张，差 2.4 倍。","换分母必须明示，否则同一事实可得出「渗透率极低」或「接近饱和」两种结论。","报人均必报分母；分母变更须显式说明。"),
"B-06-01": ("结果指标定分期余额，核心过程指标定成交金额，再拆渗透率×户均金额，两端加留存率修正。","余额是慢变量、成交额是快变量；只考核成交额会掩盖提前还款与留存恶化。","结果指标与过程指标一起考核，统一口径即可落 KPI。"),
"B-06-04": ("首分/复分切客群，先 4 周小范围差异化定价实测，读渗透率、金额、收入四件套，有效再固化为常规策略。","结论依赖测试期与客群结构，跨品种不可直接搬用；须先定最低定价与最低差额。","先定最低定价与最低差额，再开 4 周实测。"),
"B-07-01": ("按放款后 mob3/6/12 固定窗口分层统计早偿率，逐月看趋势拐点，分年度口径对比。","新放款表现期不足，不能与成熟样本比大小，须诚实标注——该材料自己点出了这个坑。","固定观察窗口＋分年度口径，直接套模板。"),
"B-01-01": ("早偿率分级管控：≤5% 继续合作、5–10% 换签协议、&gt;10% 清退；阈值写进协议、挂月度通报。","清退须配可替换商户清单；阈值按品种重估（汽车与装修分期早偿规律不同）。","发文＋台账＋月度通报，配可替换商户清单；先解队伍意愿抵触。"),
"B-01-02": ("返佣合计封顶（≤14%）＋对客费率与返佣差额底线（≥10%），两条一起下。","只压返佣不设底线，分行会用降价绕开，规模与利润两头落空。","封顶与差额底线两条一起下，防止降价绕开。"),
"B-07-02": ("佣金当月计提、按期数等额摊销；提前还款当期一次性摊销把损失显性化，追回三条款写进协议并系统留痕。","依赖协议换签进度，换签不到位即空转。","依赖协议换签进度；换签不到位即空转。"),
"B-01-03": ("追回率挂绩效负分，个人与机构双挂；与正分同表（当期/半年各计 50%）。","只挂负分不给收益机制，队伍会整体退出该品种——已有前车之鉴。","正负分同表（当期/半年各 50%），否则队伍退出该品种。"),
"B-02-01": ("沿催收链条设入催/逾期/不良三段降损目标，每段配「目标＋手段＋测算」三件套。","协商还款放宽须同时设再逾期监测与回收上限，否则只是把风险后移。","必须配再逾期监测与回收上限。"),
"B-08-19": ("信用卡是发展零售与消费金融的必由之路；但区域银行无品牌沉淀、缺持续客户经营，默认结局是沦为资金通道。","判断出自招商方立场（落点是「与我合作」）；如何避免通道化须行内自答。","与「规则留行内」绑定使用，作对外汇报的位置陈述框架。"),
"B-08-25": ("对记账类 APP 的七条调研小结，反过来就是量合作方的尺：逐项要求对方给出可验证的资源投入承诺。","清单针对工具型伙伴，不覆盖持牌机构；为 2018 年观察，个案须更新。","逐项要求可验证投入承诺，反向用作谈判条款。"),
}

LAYER_LEAD = {
    1: "本层回答「别人是怎么分析的」：阿蒙森给客户级操作方法（实验、分层、模型、复盘），B05 给行业级推导与口径纪律。",
    2: "本层是行内打法的机制设计：指标分解、定价实测、返佣与清退、催收拆解、费用与消保——多为「发文＋台账」即可落地的动作。",
    3: "本层是外部视角的评价框架与校准：B05 行业推导（1–11）＋B08 平台视角（12–38）；B-08-27 为立场自证元规则。",
}
LAYER_TITLE = {
    1: ("第一层｜材料自带的分析方法论（阿蒙森 A 系列＋天风 B05 研究方法）", "25 条"),
    2: ("第二层｜业务打法方法论（行方材料）", "18 条"),
    3: ("第三层｜外部视角评价框架（B05 行业研究＋B08 彭千）", "38 条"),
}

def badge(rid, rec):
    g = comp_map.get(rid)
    if g == "高":
        return '<span class="bdg hi">高</span>'
    if g == "中":
        return '<span class="bdg md">中</span>'
    if g == "低":
        return '<span class="bdg lo">低</span>'
    return f'<span class="bdg na" title="{esc(rec["transfer_detail"])}">—</span>'

def table(lay):
    rows = []
    for r in lay["records"]:
        rows.append(
            f'<tr><td class="c-id">{r["id"]}</td>'
            f'<td class="c-name" title="{esc(r["name"])}">{esc(r["name"])}</td>'
            f'<td class="c-sum" title="条目级初判：{esc(r["transfer_detail"])}">{esc(r["summary"])}</td>'
            f'<td class="c-src" title="{esc(r["source_full"])}">{esc(r["source_short"])}</td>'
            f'<td class="c-mig">{badge(r["id"], r)}</td></tr>'
        )
    tt, cnt = LAYER_TITLE[lay["layer"]]
    return (f'<p class="tnote">{LAYER_LEAD[lay["layer"]]}</p><h3>{tt}<span class="cnt">{cnt}</span></h3>\n'
            f'<div class="twrap"><table><thead><tr><th class="c-id">编号</th><th>方法名</th><th>一句话要点</th>'
            f'<th class="c-src">出处</th><th class="c-mig">迁移性</th></tr></thead><tbody>\n'
            + "\n".join(rows) + "\n</tbody></table></div>")

# ---------- 待验证 12 项 ----------
VBADGE = {"已闭环": "vb-done", "部分闭环": "vb-part", "需外部材料": "vb-ext"}
vrows = []
for v in vitems:
    vrows.append(
        f'<tr><td class="c-id">{v["id"]}</td>'
        f'<td class="c-sum" title="{esc(v["reason"] + "｜" + v["local_check"])}">{esc(v["desc"])}</td>'
        f'<td class="c-mig"><span class="bdg {VBADGE[v["status"]]}" title="{esc(v["local_check"])}">{v["status"]}</span></td></tr>'
    )
vstat = {}
for v in vitems:
    vstat[v["status"]] = vstat.get(v["status"], 0) + 1

verify_section = f'''<section id="verify">
<h2>待验证 12 项<span class="en">V-01～V-12 · 完整版 6.6 · 不臆造、不补数</span></h2>
<p class="tnote">已闭环 {vstat.get("已闭环",0)} 项（text/ 逐页检索＋原件 OOXML 解包逐项复核）；部分闭环 {vstat.get("部分闭环",0)} 项（关键结论已核、残留口径需外部）；需外部材料 {vstat.get("需外部材料",0)} 项。悬停可看一句话核实结论（源自 verification-results.md）。</p>
<div class="twrap"><table><thead><tr><th class="c-id">编号</th><th>待验证内容</th><th class="c-mig">状态</th></tr></thead><tbody>
{chr(10).join(vrows)}
</tbody></table></div>
<p class="tnote">文件指引：逐字引文与质检明细见《信用卡方法论提取-专家分析报告》（完整版）；面向业务同事的口语化版本见《信用卡方法论提取-通俗版》。</p>
</section>
'''

# ---------- 高迁移卡片 ----------
cards_html = []
for lay in layers:
    for r in lay["records"]:
        rid = r["id"]
        if rid in CARDS:
            cd, bd, pre = CARDS[rid]
            cards_html.append(
                f'<div class="card"><div class="card-h"><span class="cid">{rid}</span><span class="cname">{esc(r["name"])}</span></div>\n'
                f'<div class="cmeta" title="{esc(r["source_full"])}">{esc(r["source_short"])}</div>\n'
                f'<p class="cd">{cd}</p><p class="cb">边界：{bd}</p><p class="cb">落地前提：{pre}</p></div>'
            )
assert len(cards_html) == 17, f"高迁移卡应有 17 条，实得 {len(cards_html)}"

html_doc = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>信用卡方法论提取 · 精简版</title>
<style>
:root{{--ink:#1a1a1a;--sub:#5c6470;--line:#e6e8ec;--green:#0d7a3f;--greenbg:#e6f4eb;--amber:#9a6700;--amberbg:#fdf3d8;--gray:#6b7280;--graybg:#eef0f3;--accent:#1a4f8b;--blue:#1a5fb4;--bluebg:#e3edf9;}}
*{{margin:0;padding:0;box-sizing:border-box;}}
body{{font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;color:var(--ink);background:#fff;font-size:15px;line-height:1.7;}}
main{{max-width:860px;margin:0 auto;padding:0 28px 80px;}}
.hero{{padding:56px 0 8px;}}
.kicker{{font-size:12px;letter-spacing:.2em;color:var(--accent);font-weight:600;margin-bottom:10px;}}
h1{{font-size:28px;line-height:1.35;font-weight:700;margin-bottom:12px;}}
.nature{{font-size:15px;color:var(--sub);margin-bottom:18px;}}
.nature strong{{color:var(--ink);}}
.scope{{font-size:13.5px;color:var(--sub);border-left:3px solid var(--line);padding-left:12px;margin-bottom:24px;}}
.stats{{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:10px;}}
.stat{{flex:1 1 150px;border:1px solid var(--line);border-radius:10px;padding:14px 16px;}}
.stat .n{{font-size:26px;font-weight:700;line-height:1.2;}}
.stat .n em{{font-style:normal;font-size:14px;font-weight:600;}}
.stat .l{{font-size:12.5px;color:var(--sub);margin-top:2px;}}
.warnline{{font-size:13px;color:var(--sub);margin:14px 0 0;}}
.warnline b{{color:#8a4b00;}}
section{{margin-top:56px;}}
h2{{font-size:20px;font-weight:700;padding-bottom:8px;border-bottom:2px solid var(--ink);margin-bottom:18px;}}
h2 .en{{font-size:12px;color:var(--sub);font-weight:400;margin-left:8px;}}
h3{{font-size:16px;font-weight:700;margin:26px 0 10px;}}
h3 .cnt{{font-size:12px;color:var(--sub);font-weight:400;margin-left:8px;}}
p{{margin-bottom:10px;}}
.lead{{color:var(--sub);}}
.blk{{margin-bottom:22px;}}
.blk>h3{{margin-top:0;}}
.item{{display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);}}
.item:last-child{{border-bottom:none;}}
.item .no{{flex:0 0 26px;font-weight:700;color:var(--accent);font-size:13.5px;padding-top:1px;}}
.item .tx{{flex:1;}}
.item .tx b{{font-weight:600;}}
.item .tx .ref{{color:var(--sub);font-size:12.5px;}}
.twrap{{overflow-x:auto;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;}}
table{{border-collapse:collapse;width:100%;font-size:13.5px;}}
thead th{{position:sticky;top:0;background:#f7f8fa;text-align:left;font-weight:600;padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap;z-index:2;}}
tbody td{{padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top;}}
tbody tr:last-child td{{border-bottom:none;}}
tbody tr:hover{{background:#f4f7fb;}}
.c-id{{white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--accent);font-weight:600;}}
th.c-id{{width:74px;}}
th.c-src{{width:120px;}}
th.c-mig{{width:88px;}}
.c-src{{color:var(--sub);font-size:12.5px;white-space:nowrap;cursor:help;}}
.c-name{{font-weight:500;min-width:170px;}}
.c-sum{{color:#333;min-width:230px;}}
.bdg{{display:inline-block;font-size:12px;font-weight:600;padding:1px 9px;border-radius:999px;line-height:1.6;cursor:help;}}
.bdg.hi{{color:var(--green);background:var(--greenbg);}}
.bdg.md{{color:var(--amber);background:var(--amberbg);}}
.bdg.lo{{color:var(--gray);background:var(--graybg);}}
.bdg.na{{color:#b6bcc6;background:#f5f6f8;}}
.bdg.vb-part{{color:var(--amber);background:var(--amberbg);}}
.bdg.vb-ext{{color:var(--gray);background:var(--graybg);}}
.bdg.vb-done{{color:var(--green);background:var(--greenbg);}}
.tnote{{font-size:12.5px;color:var(--sub);margin:-4px 0 10px;}}
.grid{{display:grid;grid-template-columns:1fr 1fr;gap:14px;}}
@media(max-width:680px){{.grid{{grid-template-columns:1fr;}}}}
.card{{border:1px solid var(--line);border-radius:12px;padding:16px 18px;break-inside:avoid;}}
.card:hover{{border-color:#c9d6e6;}}
.card-h{{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:2px;}}
.cid{{font-weight:700;color:var(--accent);font-size:13.5px;}}
.cname{{font-weight:600;font-size:14.5px;}}
.cmeta{{font-size:12px;color:var(--sub);margin-bottom:8px;cursor:help;}}
.cd{{font-size:13.5px;margin-bottom:6px;}}
.cb{{font-size:12.5px;color:var(--sub);}}
.caliber table{{font-size:13px;}}
.caliber td:first-child{{white-space:nowrap;font-weight:600;}}
.notice{{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;background:#fafbfc;padding:14px 16px;font-size:13.5px;color:#333;margin-top:20px;}}
footer{{margin-top:56px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--sub);}}
@media print{{thead th{{position:static;}} }}
</style>
</head>
<body>
<main>
<div class="hero">
  <div class="kicker">研报精简版 · 5–10 分钟读核心，需要时查条目</div>
  <h1>信用卡方法论提取 · 精简版</h1>
  <p class="nature">报告性质：<strong>方法论提取与融合，不是经营结论</strong>——凡涉及当期经营判断，只给口径、方法与动作，不给数字结论。</p>
  <p class="scope">材料范围：25 份 = 行方业务资料 6 份（B01–B04、B06、B07）＋ 天风证券 B05 ＋ 彭千 B08 ＋ 阿蒙森洞察 17 期（A01–A17，2022 年第 6 期缺）。</p>
  <div class="stats">
    <div class="stat"><div class="n">{meta["total_records"]}<em> 条</em></div><div class="l">方法论记录，统一编号</div></div>
    <div class="stat"><div class="n">高 {meta["transfer_comprehensive"]["高"]} / 中 {meta["transfer_comprehensive"]["中"]} / 低 {meta["transfer_comprehensive"]["低"]}</div><div class="l">综合可迁移性分级</div></div>
    <div class="stat"><div class="n">0 <em>处</em></div><div class="l">引文回验失配</div></div>
  </div>
  <p class="warnline"><b>来源分层警示：</b>行方材料（内部复盘）／券商研究（B05，含荐股立场）／平台商务材料（B08，含合作诉求）／美团经营口径（阿蒙森，平台视角）——四类不得混用、不得合并为同一结论。</p>
</div>
<p class="scope" style="margin-top:18px">本页用法：先读「核心结论」（约 5 分钟）；要查具体条目，用「速查表」按编号检索；只想知道最值得做的 {meta["transfer_comprehensive"]["高"]} 件事，直接看「精选卡」。完整版含全部原文引句与质检记录。</p>

<section id="core">
<h2>核心结论<span class="en">跨层观察精编</span></h2>

<div class="blk">
<h3>① 两套互补范式：操作级 vs 行业级</h3>
<p>阿蒙森（A 系列）提供「怎么做」的<b>操作级</b>方法——实验、分层、模型、月度/账龄粒度，产出可执行动作；天风 B05 提供「为什么值得做」的<b>行业级</b>推导与口径还原纪律——收入结构解构、比率横比、国际对标，产出方向判断。二者是任务类型不同，不是谁更好；选用前先确认要解决什么问题。</p>
<p>两套范式反复出现的三条元规则，也是贯穿 {meta["total_records"]} 条记录的公共纪律：<b>口径先统一</b>（B-05-12 科目还原、B-05-15 分母修正）；<b>无对照不做因果</b>（A01-03 平行世界、A06-01 实验）；<b>缺数据显式标注、不补数</b>（示意数据只认排序）。
</div>

<div class="blk">
<h3>② 最值得带走的 4 件可迁移工具</h3>
<div class="item"><div class="no">1</div><div class="tx"><b>三类损益框架</b>（B-08-12）：获客层亏损、交易层保本、资产层盈利——判断任一产品线能否赚钱，先问「资产层能否覆盖获客层」。</div></div>
<div class="item"><div class="no">2</div><div class="tx"><b>玩家分层坐标系</b>（B-08-14/18）：按牌照×客群×资金量级排五类玩家，再对国有/股份制/区域银行做优劣势并排——竞品地图与自我定位一把尺。</div></div>
<div class="item"><div class="no">3</div><div class="tx"><b>OTT／管道化判定规则</b>（B-08-22）：互联网只挑战「简单标准化业务」；被管道化的判据是业务是否标准化——据此决定哪些能力必须自建。</div></div>
<div class="item"><div class="no">4</div><div class="tx"><b>两把量化尺</b>：分期实际年化测算法（B-05-13，名义费率仅为实际约 6 成，须重算不得引用）＋ 分母修正法（B-05-15，报人均必报分母，换分母差 2.4 倍）。</div></div>
</div>

<div class="blk">
<h3>③ 六组张力与裁定建议</h3>
<div class="item"><div class="no">1</div><div class="tx"><b>规模 vs 风险考核</b>：杠杆量化只用于排序，不作单独加压依据；以正负分同表为默认——只发文件不给收益＝机制空转。</div></div>
<div class="item"><div class="no">2</div><div class="tx"><b>低线放量 vs 风险前置</b>：低线城市放量必须以风险识别能力为前置条件，并在再逾期监测口径下执行。</div></div>
<div class="item"><div class="no">3</div><div class="tx"><b>费用压降 vs 前置投入</b>：压降必须与调优准入策略配对；节省额度优先投向高杠杆前置动作（促激活、促绑卡）。</div></div>
<div class="item"><div class="no">4</div><div class="tx"><b>平台「赋能」叙事 vs 行内自主</b>（最直接的矛盾）：以行内为主权方——可让渡流量与场景，不让渡客户、数据、定价规则与账期节奏。</div></div>
<div class="item"><div class="no">5</div><div class="tx"><b>转化优化 vs 消保/反欺诈</b>：转化优化与消保动作同批下发，话术培训与考核绑定，沿用「严禁承诺免违约金」红线。</div></div>
<div class="item"><div class="no">6</div><div class="tx"><b>模型确定性 vs 样本可信度</b>：阿蒙森部分期次自陈「示意数据」，凡图表绝对值一律不得引用，只引用排序与结构。</div></div>
</div>

<div class="blk">
<h3>③′ 六条可组装的「工作链」</h3>
<p class="lead">三层单独看都成立，合起来能组装出六条成品工作链（完整版 6.1，组件归属与本页速查表 chain_refs 一致）：</p>
<div class="item"><div class="no">1</div><div class="tx"><b>年度经营计划模板（指标树＋杠杆排序＋正负分同表）</b>：A10-01 三因素分解×覆盖面 ＋ B-06-01 分期指标树 ＋ B-01-03 负分考核（外部校准：B-08-12 三类损益）</div></div>
<div class="item"><div class="no">2</div><div class="tx"><b>活动与定价测试标准流程（立项即填五栏）</b>：A01-03 平行世界 ＋ A01-04 定位定指标 ＋ A06-01 双指标判读 ＋ B-06-04 定价实测 ＋ B-05-13 年化复算</div></div>
<div class="item"><div class="no">3</div><div class="tx"><b>口径对照表（任何比较先过表）</b>：B-05-12 科目还原 ＋ B-05-15 分母修正 ＋ A04-01 归属口径 ＋ B-06-01 统一口径 ＋ B-06-02 标杆标来源</div></div>
<div class="item"><div class="no">4</div><div class="tx"><b>阈值与定价验算规程（先算后定）</b>：B-05-13 实际年化 ＋ B-05-14 盈亏门槛 ＋ B-01-01 早偿临界 ＋ B-01-02 返佣封顶与底线（外部校准：B-08-13/12）</div></div>
<div class="item"><div class="no">5</div><div class="tx"><b>客群工程全链（分层→标签→投放→定价）</b>：A01-01 五阶段八层 ＋ A16-01 切分点＋交叉聚类 ＋ A17-01 四象限 ＋ A03-01 双模型 ＋ B-06-06 四层标签 ＋ B-06-03 补缺（收口：B-08-11 矩阵）</div></div>
<div class="item"><div class="no">6</div><div class="tx"><b>线上转化＋消保一体化（转化与消保同批下发）</b>：A02-01 转化节点（阈值须重测）＋ B-03-02 前十大来电回溯＋未激活不付 CPS（外部校准：B-08-23）</div></div>
</div>

<div class="blk">
<h3>③″ 四类口径陷阱（任何比较先过这张表）</h3>
<div class="item"><div class="no">1</div><div class="tx"><b>分期手续费＝利息</b>：还原后「实际利息收入占比约 70%」，「非息收入占比高」类叙事须复核。</div></div>
<div class="item"><div class="no">2</div><div class="tx"><b>发卡量 ≠ 流通卡 ≠ 流通户 ≠ 活卡</b>：四种口径混用会让同一判断差出数倍。</div></div>
<div class="item"><div class="no">3</div><div class="tx"><b>人均分母</b>：全国口径 0.39 张 vs 20–59 岁城镇 0.95 张，换分母必须明示。</div></div>
<div class="item"><div class="no">4</div><div class="tx"><b>「实动卡均交易」无公开定义</b>：引用外部数据前先核对口径与时点。</div></div>
</div>

<div class="blk">
<h3>④ 证据独立性警示（引用前必读）</h3>
<div class="item"><div class="no">1</div><div class="tx"><b>B05 同源</b>：B05 被第一、三层各提取一次，同一引文不得计为两条独立证据。</div></div>
<div class="item"><div class="no">2</div><div class="tx"><b>「中美对标」D1 同源</b>：B05 与 B08 立场相反却同用「对标美国→还有 N 倍空间」，只说明该推论工具好用，不构成独立验证；并列引用应删除。</div></div>
<div class="item"><div class="no">3</div><div class="tx"><b>阿蒙森是平台口径</b>：美团侧经营数据与行内自营口径不可直接换算，引用须带「平台视角」标注。</div></div>
<div class="item"><div class="no">4</div><div class="tx"><b>B08 是商务材料</b>：其对区域银行劣势的描述，可信度高于其对平台自身优势的描述（含 2018-05 合作诉求）。</div></div>
</div>

<div class="blk">
<h3>⑤ 四条采信建议（bank-09 提出，报告全部采纳）</h3>
<div class="item"><div class="no">1</div><div class="tx"><b>意愿抵触是真问题</b>——直销队伍已基本放弃分期营销；只发文件不给收益＝空转，机制上配正负分同表。</div></div>
<div class="item"><div class="no">2</div><div class="tx"><b>必须加再逾期监测</b>——协商还款再逾期已超首次进入不良金额；放宽政策须同时设监测与回收上限。</div></div>
<div class="item"><div class="no">3</div><div class="tx"><b>用外部流量，不用外部规则</b>——客户、数据、账户、定价规则留在行内，写进合作管理办法。</div></div>
<div class="item"><div class="no">4</div><div class="tx"><b>员工违规是外部风险的放大器</b>——话术培训与考核同批下发，绑定违约金承诺红线。</div></div>
</div>
</section>

<section id="tables">
<h2>{meta["total_records"]} 条方法论速查表<span class="en">按层分表 · 表头吸顶 · 迁移性＝综合排序（完整版 6.4）</span></h2>
{table(layers[0])}
{table(layers[1])}
{table(layers[2])}
<p class="tnote">「—」＝该条未进入全篇综合可迁移性排序；<b>悬停查看条目级初判；综合排序标准见完整版 6.4</b>。出处列为短标，悬停可看完整文件名与页码。</p>
</section>

<section id="cards">
<h2>高迁移性 {meta["transfer_comprehensive"]["高"]} 条精选<span class="en">本月可动：只需发文＋台账模板＋月度通报</span></h2>
<div class="grid">
{chr(10).join(cards_html)}
</div>
</section>

{verify_section}

<section id="caliber" class="caliber">
<h2>口径纪律<span class="en">四类来源</span></h2>
<h3>材料 ID 图例</h3><div class="twrap"><table><tbody><tr><td class="c-name">A01–A17</td><td class="c-sum">阿蒙森洞察 2021–2022 年 17 期（2022 年第 6 期缺；A01–A07 为 2022 年样本，A08–A17 为 2021 年样本）</td></tr><tr><td class="c-name">B01–B04</td><td class="c-sum">行方业务资料：商户返佣与早偿管控／不良催收复盘／经营分析（B03）／年度计划推断稿（B04，文内未标日期）</td></tr><tr><td class="c-name">B05</td><td class="c-sum">天风证券行业研究《信用卡大有可为，渐成零售业务主力》（2018-06-03）</td></tr><tr><td class="c-name">B06–B07</td><td class="c-sum">行方分期业务规划（B06，2021-08）／汽车分期经营分析会（B07，2024-07）</td></tr><tr><td class="c-name">B08</td><td class="c-sum">彭千（美团金融总裁）历史分享（2018-05-12，平台商务材料）</td></tr></tbody></table></div>
<div class="twrap"><table>
<thead><tr><th>来源类别</th><th>材料</th><th>立场与口径特征</th></tr></thead>
<tbody>
<tr><td>行方材料</td><td>B01–B04、B06、B07</td><td>内部复盘/规划底稿，服务于行内决策；不等于已发生事实全貌</td></tr>
<tr><td>外部券商研究</td><td>B05 天风（2018-06）</td><td>卖方立场：含行业评级「强于大市」与荐股，评级窗口 6 个月</td></tr>
<tr><td>外部历史分享</td><td>B08 彭千（2018-05）</td><td>平台商务材料：末页直接请求 Fintech 合作机会，含合作诉求</td></tr>
<tr><td>美团经营分析</td><td>A01–A17 阿蒙森（2021–22）</td><td>平台方经营口径，基于各行美团卡业务；与行内自营口径不可直接换算</td></tr>
</tbody></table></div>
<div class="notice">本页为精简版：<b>完整 {meta["total_records"]} 条含原文关键句逐字引文、方法拆解全文、质检记录（Q-01～Q-13）、编号映射与去重对照、附录 A–D</b>，请查阅《信用卡方法论提取-专家分析报告》完整版。</div>
</section>

<footer>本页由 methodology-records.json 生成（build_brief.py），完整版为准。依据《信用卡方法论提取-专家分析报告》（25 份材料、{meta["total_records"]} 条记录、引文回验 0 失配）编成；逐字引文与质检明细见完整版，口语化版见《信用卡方法论提取-通俗版》。待验证项状态已按 verification-results.md 核实结论更新（V-09 改判 2026 年度等），完整版报告原文未改动。全部数值为 2018–2026 各材料基准时点的历史样本，不得当作现行经营事实引用。环境路径变更声明见完整版 1.1 节。</footer>
</main>
</body>
</html>
'''

with open(OUT, "w", encoding="utf-8") as fp:
    fp.write(html_doc)

# ---------- 校验 ----------
import re as _re
size = os.path.getsize(OUT)
counts = [len(lay["records"]) for lay in layers]
over = [(r["id"], r["source_short"]) for lay in layers for r in lay["records"] if len(r["source_short"]) > 16]
n_dash = html_doc.count('class="bdg na"')
print(f"HTML 大小：{size} bytes（{size/1024:.1f} KB）")
print(f"三表行数：{counts}（应为 [25, 18, 38]）")
print(f"source_short 超 16 字符：{over if over else '无'}")
print(f"「—」徽章数：{n_dash}（应为 33）")
print(f"待验证行数：{len(vrows)}（应为 12）；高迁移卡：{len(cards_html)}（应为 17）")
assert counts == [25, 18, 38] and not over and n_dash == 33 and len(vrows) == 12 and len(cards_html) == 17
assert 60 * 1024 <= size <= 120 * 1024, "文件大小超出 60–120KB"
print("校验全部通过 ✔")
