# -*- coding: utf-8 -*-
"""
任务E：议题4 商业测算与投产模型（03_商业测算与投产模型.md 的复算脚本）
========================================================================
扩展自 output/model_b.py（单卡收益模型），新增：
  a) 三层面价值模型：财务（单卡盈亏/回本周期）、客群（AUM/EVA 带动）、品牌（获客成本节约代理）
  b) 全生命周期 LTV（3/5/7 年，年费留存衰减曲线，折现）
  c) 六维敏感性矩阵：年费留存率 × 活卡率 × 境外占比 × 权益成本 × 蓝盒子授权费 × 银数运维费
  d) 盈亏平衡图数据：发卡量 × 三通道回本周期
  e) 资本与合规成本：拨备（损失率 1.28%-2.56%）、资金成本（免息期 50 天 [A]）、风险成本
  f) 存量升级 vs 纯新增：增量口径（避免重复计算 AUM/EVA）
  g) 情景分析：基准/乐观/悲观 3 年 NPV（折现率 [A] 区间）与决策阈值（悲观 3,215 张触发线）

口径：元/卡/年；2026 年时点；三态标注 [F]=事实 [A]=假设 [I]=推断
复算路径：python3 output/model_c.py   （模型参数与 model_b.py 同源）
"""
import json

# =========================================================================
# 一、参数表（与 model_b.py 同源；新增参数单独标注 [A]）
# =========================================================================
FACT = {
    # ---- 167 银联数据月报（2026-07）----
    'card_income_month': 61.49,      # 卡均收入 元/月/卡 [F]
    'installment_share': 0.6574,     # 分期息费收入占比 [F]
    'fee_retail_dom': 0.002,         # 境内回佣（发卡行）约 2‰ [F,231]
    'fee_retail_os': 0.01,           # 运通境外回佣约 1% [F,236]；V/M 1.4% [F,231]
    'dom_spend_per_card_month': 573, # 卡均消费 元/月（全卡）[F]
    'loss_rate': 0.0256,             # 行内损失率（仅本金）[F]
    'npl': 0.0341,                   # 行内不良率 [F]
    'active_rate_bank': 0.261,       # 行内活跃率（30天）[F]
    'active_rate_pufa': 0.60,        # 浦发运通白金活卡率（近一年有交易）[F,236]
    'pufa_monthly_spend': 20000,     # 浦发卡均月消费约 2 万 [F,236]
    'os_share_pufa_plat': 0.08,      # 浦发白金境外消费占比 8% [F,236]
    'os_share_pufa_super': 0.26,     # 浦发超白金境外占比 26% [F,236]（材料前后口径矛盾，两档均测）
    # ---- 230/234 境外消费分析报告 ----
    'visa_aum': 67586.13,            # VISA 境外客群人均 AUM 提升 元 [F]
    'visa_eva': 3206.57,             # VISA 境外客群人均 EVA 贡献 元 [F]
    'cup_aum': 11117.69,             # 银联境外客群人均 AUM 提升 元 [F]
    'cup_eva': 818.04,               # 银联境外客群人均 EVA 贡献 元 [F]
    'all_aum': 7168.08,              # 全量有消费客群人均 AUM 提升 元 [F]
    'all_eva': 32.16,                # 全量有消费客群人均 EVA 元 [F]
    'os_hh': 76243,                  # 境外消费客户 户 [F]
    'os_eva': 945.36,                # 有境外消费客户人均 EVA 元 [F]
    'os_spend_total': 4.6e8,         # 全行境外消费 4.6 亿元/年 [F] → 户均 6,033 [I]
}

# 接入成本三通道（与 model_b.py 一致；单位：元）
CHANNELS = {
    # 蓝盒子授权费材料未披露；0 仅为显式基准假设，不代表免费，也不继承百夫长条款。
    'A_银数_蓝盒子': {'fix0': 115e4, 'ops_y': 20e4, 'license_y': 0,   'license_y1': 0, 'license_status': 'AS-08-蓝盒子授权费=0基准/0-100万敏感性'},
    'B_银数_百夫长': {'fix0': 115e4, 'ops_y': 20e4, 'license_y': 300e4, 'license_y1': 0},  # 2026 首年减免 [F,236/235]
    'C_直连':       {'fix0': 400e4, 'ops_y': 30e4, 'license_y': 0,   'license_y1': 0},
}

ASSUME = {
    # ---- model_b.py 原有假设 ----
    'fee_tiers': [3600, 2000, 880],                    # 年费三档 [A]
    'fee_retention': 0.6,       # 年费留存率基准 60%（区间 40%-80%）[A]
    'active_rate': 0.6,         # 活卡率基准 60%（浦发口径；区间 26%-60%）[A]
    'benefit_cost_active': {3600: 800, 2000: 500, 880: 200},  # 权益成本 元/活卡/年（区间 500-1,500）[A]
    'card_produce': 80,         # 制卡 元/卡 一次性（区间 50-200）[A]
    'acq_cost': 300,            # 获客 元/卡 一次性（区间 100-600）[A]
    'ops_card_year': 50,        # 运营 元/卡/年（区间 30-100）[A]
    'avg_balance_high': 20000,  # 高端卡户均透支余额 元（浦发额度 30 万起×使用率~7%）[A]
    'high_loss_rate': 0.0128,   # 高端卡损失率（行内 2.56% 减半；区间 1.28%-2.56%）[A]
    'installment_mult': 1.0,    # 分期倍数（区间 0.75-1.5）[A]
    'dom_retail_mix': 0.002,    # 境内回佣率基准 2‰ [F,231]
    'os_retail_amex': 0.01,     # 运通境外回佣 1% [F,236]
    # ---- 任务E 新增假设（均给区间）----
    'interest_free_days': 50,   # 免息期 50 天 [A]（任务指定；区间 45-55）
    'float_factor': 0.5,        # 账单周期内平均垫资系数（0~月消费的均值）[A]
    'fund_rate': 0.025,         # 资金成本率（行内资金成本假设）[A]（区间 2.0%-3.0%）
    'decay': 0.90,              # 年费留存年衰减系数（区间 0.85-0.95）[A]
    'disc_rate': 0.08,          # 折现率（银行项目资本成本假设）[A]（区间 6%-10%）
    'theta_upgrade': 0.10,      # 存量 VISA 客群升级的增量系数（区间 5%-20%）[A]
    'acq_cost_retail': 1000,    # 行外高净值客群零售渠道获客成本 元/户（区间 500-2,000）[A]
    'license_bluebox': 0,       # 蓝盒子授权费 万/年 基准 0（区间 0-100）[A]
    'ops_yinshu': 20,           # 银数运维费 万/年 基准 20（区间 10-30）[A]
}

# 消费场景（与 model_b.py 一致）
SCEN = {
    'S1_浦发白金_境外8%':   dict(os_share=0.08, os_spend=20000*12*0.08, dom_spend=20000*12*0.92),
    'S2_浦发超白金_境外26%': dict(os_share=0.26, os_spend=20000*12*0.26, dom_spend=20000*12*0.74),
    # FIX(r3): 573 元/月是全卡总消费，不是境内消费；S3 统一采用单卡口径且不再叠加户均境外消费。
    # 6876 元/卡/年取 FB-BUS-0011×12；保守按境内回佣计，目标卡境内外拆分仍待客户/卡明细核实。
    'S3_我行保守_卡均':     dict(os_share=0.0, os_spend=0.0, dom_spend=573*12),
}

# 情景定义（g）：与任务B/01报告三情景同参数集（权益800/损失1.28%/授权0/运维20万为三情景公共基准；
# 权益1,500、损失2.56%、授权费100万等极端值由敏感性矩阵（c）单独覆盖）
SCENARIOS = {
    '基准': dict(scen='S1_浦发白金_境外8%', a=0.6, r=0.6, m=1.0, benefit=800, loss=0.0128,
                 license=0.0, ops=20.0, desc='S1 白金/活卡60%/留存60%/分期1.0（任务B同参数）'),
    '乐观': dict(scen='S2_浦发超白金_境外26%', a=0.6, r=0.8, m=1.5, benefit=800, loss=0.0128,
                 license=0.0, ops=20.0, desc='S2 超白金/活卡60%/留存80%/分期1.5（任务B同参数）'),
    '悲观': dict(scen='S3_我行保守_卡均', a=0.26, r=0.4, m=0.75, benefit=800, loss=0.0128,
                 license=0.0, ops=20.0, desc='S3 卡均总消费6876元/活卡26%(行内)/留存40%/分期0.75（r3修正后）'),
}

def inst_yearly(m_inst=1.0):
    """卡均分期息费 元/年 [I] 61.49×12×65.74%"""
    return FACT['card_income_month'] * 12 * FACT['installment_share'] * m_inst

def rc_annual(scen, os_rate=None):
    """单卡（活卡）年回佣（毛额，未乘活卡率）"""
    os_rate = os_rate or ASSUME['os_retail_amex']
    return scen['os_spend'] * os_rate + scen['dom_spend'] * ASSUME['dom_retail_mix']

def funding_per_card(scen, a, fund_rate=None, days=None):
    """资金成本 元/卡/年 = 年消费 × 免息期天数/365 × 垫资系数 × 资金成本率 × 活卡率 [A]"""
    fund_rate = ASSUME['fund_rate'] if fund_rate is None else fund_rate
    days = ASSUME['interest_free_days'] if days is None else days
    spend = scen['os_spend'] + scen['dom_spend']
    return spend * (days / 365.0) * ASSUME['float_factor'] * fund_rate * a

def card_cf(fee, a, r, scen, m_inst=1.0, benefit=None, loss_rate=None, with_fund=False, fund_rate=None):
    """单卡年现金流（与 model_b.card_cf 同构；可加资金成本与参数覆盖）
    返回 (cf1, cft)：首年（免年费、含一次性成本）与稳态年
    """
    benefit = ASSUME['benefit_cost_active'][fee] if benefit is None else benefit
    loss_rate = ASSUME['high_loss_rate'] if loss_rate is None else loss_rate
    rc = rc_annual(scen)
    inst = inst_yearly(m_inst)
    benefit_c = benefit * a
    bad = ASSUME['avg_balance_high'] * loss_rate * a          # 风险成本（拨备口径）
    fund = funding_per_card(scen, a, fund_rate) if with_fund else 0.0
    ops = ASSUME['ops_card_year']
    oneoff = ASSUME['card_produce'] + ASSUME['acq_cost']
    y1 = rc * a + inst - (benefit_c + ops + bad + fund) - oneoff
    yt = fee * a * r + rc * a + inst - (benefit_c + ops + bad + fund)
    return y1, yt

def cum_fixed_c(ch=None, T=3, license=None, ops=None):
    """T 年累计固定成本（元）；支持蓝盒子授权费/银数运维费覆盖
    口径：初始 + T×运维 + (T-1)×授权费——授权费沿用任务B口径（2026 首年减免 [A]，第 2 年起计费）"""
    if ch is None:
        fix0 = CHANNELS['A_银数_蓝盒子']['fix0']
        lic = (license if license is not None else ASSUME['license_bluebox']) * 1e4
        op = (ops if ops is not None else ASSUME['ops_yinshu']) * 1e4
        # FIX(r3): 蓝盒子非零覆盖值不得继承百夫长首年减免，按首年起计费。
        return fix0 + T * op + T * lic
    c = CHANNELS[ch]
    total = c['fix0']
    for t in range(1, T + 1):
        lic = c['license_y1'] if t == 1 else c['license_y']
        total += c['ops_y'] + lic
    return total

def breakeven_N(fee, a, r, scen, T=3, m_inst=1.0, benefit=None, loss_rate=None,
                with_fund=False, ch=None, license=None, ops=None):
    """3 年回本阈值（张）= 固定成本 / 单卡3年累计现金流（与 model_b.breakeven_N 同构）"""
    cf1, cft = card_cf(fee, a, r, scen, m_inst, benefit, loss_rate, with_fund)
    cum_cf = cf1 + cft * (T - 1)
    fc = cum_fixed_c(ch, T, license, ops)
    return fc / cum_cf, cum_cf

def payback(fee, a, r, scen, N, m_inst=1.0, benefit=None, loss_rate=None, with_fund=False,
            ch='A_银数_蓝盒子', license=None, ops=None):
    """回本周期（年）：对给定发卡量 N 逐年累计，线性插值
    license 覆盖值代表蓝盒子敏感性，首年即计费，不继承百夫长减免；
    未覆盖时按通道自身授权费安排"""
    cf1, cft = card_cf(fee, a, r, scen, m_inst, benefit, loss_rate, with_fund)
    c = CHANNELS[ch]
    fix0 = c['fix0']
    op = (ops * 1e4) if ops is not None else c['ops_y']   # 运维覆盖值单位：万 → 元；通道值本身为元
    lic_override = license is not None
    lic_y = (license * 1e4) if lic_override else c['license_y']     # 授权费覆盖值单位：万 → 元；通道值本身为元
    # FIX(r3): 非零覆盖值视为蓝盒子报价，首年即计费；百夫长仅走通道默认减免。
    lic_y1 = lic_y if lic_override else c['license_y1']
    cum = -fix0
    for t in range(1, 12):
        lic_t = lic_y1 if t == 1 else lic_y
        flow = N * (cf1 if t == 1 else cft) - (op + lic_t)
        cum += flow
        if cum >= 0:
            # FIX(r3): 线性插值应使用本年末累计值 cum；旧式多算约1年。
            return t - cum / flow
    return None

# ---------- LTV（b）：年费留存衰减曲线 + 折现 ----------
def retention_curve(r_base, decay, T):
    """年费留存衰减曲线：第1年=1（首年免年费）；第t年(t≥2)=r_base×decay^(t-2) [A]"""
    return [1.0 if t == 1 else r_base * decay ** (t - 2) for t in range(1, T + 1)]

def ltv(fee, a, r_base, scen, T, m_inst=1.0, benefit=None, loss_rate=None, with_fund=False,
        decay=None, d=None):
    """单卡全生命周期 LTV（元/卡）：留存曲线 × 稳态年现金流（留存即视为继续产生全部收入与成本）
    CF_1 = 首年现金流（含一次性）；CF_t = s_t × yt_full（yt_full 为 r=1 的稳态年现金流）
    LTV = Σ CF_t/(1+d)^t
    """
    decay = ASSUME['decay'] if decay is None else decay
    d = ASSUME['disc_rate'] if d is None else d
    cf1, _ = card_cf(fee, a, r_base, scen, m_inst, benefit, loss_rate, with_fund)
    _, yt_full = card_cf(fee, a, 1.0, scen, m_inst, benefit, loss_rate, with_fund)
    s = retention_curve(r_base, decay, T)
    cf = [cf1] + [s[t] * yt_full for t in range(1, T)]
    npv = sum(cf[t] / (1 + d) ** (t + 1) for t in range(T))
    return npv, cf, s

def portfolio_npv3(N, fee, a, r_base, scen, m_inst=1.0, benefit=None, loss_rate=None,
                   with_fund=True, decay=None, d=None, license=None, ops=None, ch='A_银数_蓝盒子'):
    """组合 3 年 NPV（元）：-初始 + Σ(N×CF_t − 运维 − 授权费)/(1+d)^t
    CF 采用 LTV 同口径（含留存衰减、资金成本、折现）"""
    decay = ASSUME['decay'] if decay is None else decay
    d = ASSUME['disc_rate'] if d is None else d
    c = CHANNELS[ch]
    op = (ops if ops is not None else ASSUME['ops_yinshu']) * 1e4
    lic_y = (license if license is not None else ASSUME['license_bluebox']) * 1e4
    _, cf, _ = ltv(fee, a, r_base, scen, 3, m_inst, benefit, loss_rate, with_fund, decay, d)
    npv = -c['fix0']
    for t in range(3):
        # FIX(r3): 蓝盒子覆盖值首年即计费；不得自动继承百夫长首年减免条款。
        npv += (N * cf[t] - op - lic_y) / (1 + d) ** (t + 1)
    return npv

# =========================================================================
# 输出
# =========================================================================
OUT = []
def p(s=''):
    OUT.append(s)

def fmt(x, nd=0):
    return f'{x:,.{nd}f}'

p('=' * 108)
p('任务E · 议题4 商业测算与投产模型（model_c.py 输出）')
p('口径：元/卡/年，2026 年时点；[F]=事实 [A]=假设 [I]=推断；复算：python3 output/model_c.py')
p('=' * 108)

# ---------------- (a) 财务层：单卡三源收入与盈亏 ----------------
p()
p('### 表A-1 单卡盈亏（财务层）：三源收入与成本分解（活卡率60%、留存60%、首年免年费、含资金成本）')
p()
p('| 场景 | 年费档 | 年费收入 | 回佣(活卡) | 分期 | 权益成本 | 运营 | 坏账(拨备) | 资金成本 | 一次性 | 首年净现金流 | 稳态年净现金流 |')
p('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
for scen_name in ['S1_浦发白金_境外8%', 'S2_浦发超白金_境外26%', 'S3_我行保守_卡均']:
    scen = SCEN[scen_name]
    for fee in ASSUME['fee_tiers']:
        a, r = 0.6, 0.6
        y1, yt = card_cf(fee, a, r, scen, with_fund=True)
        fee_inc = fee * a * r
        rc = rc_annual(scen) * a
        inst = inst_yearly()
        ben = ASSUME['benefit_cost_active'][fee] * a
        ops = ASSUME['ops_card_year']
        bad = ASSUME['avg_balance_high'] * ASSUME['high_loss_rate'] * a
        fund = funding_per_card(scen, a)
        oneoff = ASSUME['card_produce'] + ASSUME['acq_cost']
        p(f'| {scen_name} | {fee} | {fee_inc:.0f} | {rc:.0f} | {inst:.0f} | {ben:.0f} | {ops:.0f} | {bad:.0f} | {fund:.0f} | {oneoff:.0f} | **{y1:,.0f}** | **{yt:,.0f}** |')

# ---------------- (a) 客群层：AUM/EVA 带动 ----------------
p()
p('### 表A-2 客群层：境外客群 AUM/EVA 价值（230/234）与带动规模')
p()
p('| 客群 | 人均AUM提升(元) | 人均EVA(元) | 2,000户带动AUM(万元) | 2,000户带动EVA(万元/年) |')
p('|---:|---:|---:|---:|---:|')
rows = [
    ('有境外消费VISA信用卡客户[F]', FACT['visa_aum'], FACT['visa_eva']),
    ('有境外消费银联卡客户[F]', FACT['cup_aum'], FACT['cup_eva']),
    ('有境外消费客户(全卡组织)[F]', 0, FACT['os_eva']),
    ('有消费全量银行卡客户[F]', FACT['all_aum'], FACT['all_eva']),
]
for name, aum, eva in rows:
    if aum > 0:
        p(f'| {name} | {aum:,.0f} | {eva:,.0f} | {aum*2000/1e4:,.0f} | {eva*2000/1e4:,.0f} |')
    else:
        p(f'| {name} | — | {eva:,.0f} | — | {eva*2000/1e4:,.0f} |')

# ---------------- (a) 品牌层：浦发口径 + 获客节约代理 ----------------
p()
p('### 表A-3 品牌层：浦发「单卡亏损但综合价值」口径（236）与量化代理')
p()
p('| 项目 | 内容 | 口径/来源 |')
p('|---|---|---|')
p('| 定性（浦发口径） | 浦发运通高端卡「发行一张亏损一张」，价值在客群获取、客户关系沉淀、品牌影响力；汇报需从收入/客群/品牌三层面阐述 | [F] 236 |')
p('| 获客成本节约代理 | 定向邀约获客 300 元/卡 [A] vs 行外高净值零售渠道获客 1,000 元/户 [A]，每户节约约 700 元；2,000 张 ≈ 140 万 | [I] model_c 假设 |')
p('| 权益心智参照 | 运通年费卡留存 98%（2023 美国口径，不可外推）、J.D. Power 连续五年第一 | [F] 227/235，口径注明 |')
p('| 营销资源 | 银联可返还品牌费专项营销（境外推广） | [F] 230/234 |')

# ---------------- (b) LTV ----------------
p()
p('### 表B-1 年费留存衰减曲线（基准 r=60%，decay=0.90）[A]')
p()
p('| 年份 | 第1年 | 第2年 | 第3年 | 第4年 | 第5年 | 第6年 | 第7年 |')
p('|---:|---:|---:|---:|---:|---:|---:|---:|')
s7 = retention_curve(0.6, 0.90, 7)
p('| 留存率 | ' + ' | '.join(f'{x*100:.0f}%' for x in s7) + ' |')
p()
p('*口径：首年免年费且全部在册；第 2 年留存 = 年费留存率 60%（续卡且实收，含积分抵扣折算）；此后每年按衰减系数 0.90 递减（区间 0.85-0.95）[A]。留存即视为继续产生全部收入与成本；未留存部分不再贡献。*')
p()
p('### 表B-2 单卡 LTV（元/卡，折现率 8% [A]；含资金成本；不含通道固定成本）')
p()
p('| 场景 | 年费档 | LTV 3年 | LTV 5年 | LTV 7年 | 7年净现金流(未折现) |')
p('|---:|---:|---:|---:|---:|---:|')
for scen_name in ['S1_浦发白金_境外8%', 'S2_浦发超白金_境外26%', 'S3_我行保守_卡均']:
    scen = SCEN[scen_name]
    for fee in ASSUME['fee_tiers']:
        l3, cf3, _ = ltv(fee, 0.6, 0.6, scen, 3, with_fund=True)
        l5, cf5, _ = ltv(fee, 0.6, 0.6, scen, 5, with_fund=True)
        l7, cf7, _ = ltv(fee, 0.6, 0.6, scen, 7, with_fund=True)
        p(f'| {scen_name} | {fee} | {l3:,.0f} | {l5:,.0f} | {l7:,.0f} | {sum(cf7):,.0f} |')
p()
p('### 表B-3 LTV 敏感性（S1 白金、年费 3,600）')
p()
p('| 参数 | 取值 | LTV3年 | LTV5年 | LTV7年 |')
p('|---|---:|---:|---:|---:|')
scen_s1 = SCEN['S1_浦发白金_境外8%']
lv = lambda T, **kw: ltv(3600, 0.6, 0.6, scen_s1, T, with_fund=True, **kw)[0]
p(f'| 基准(留存60%/衰减0.90/折现8%) | — | {lv(3):,.0f} | {lv(5):,.0f} | {lv(7):,.0f} |')
for dec in [0.85, 0.95]:
    p(f'| 衰减系数 {dec} [A] | — | {lv(3, decay=dec):,.0f} | {lv(5, decay=dec):,.0f} | {lv(7, decay=dec):,.0f} |')
for d in [0.06, 0.10]:
    p(f'| 折现率 {d:.0%} [A] | — | {lv(3, d=d):,.0f} | {lv(5, d=d):,.0f} | {lv(7, d=d):,.0f} |')

# ---------------- (c) 敏感性矩阵 ----------------
p()
p('### 表C-1 单变量敏感性（龙卷风图数据）：3 年回本阈值与回本周期（口径A银数·蓝盒子，年费3,600，基准 S1/活卡60%/留存60%/权益800/损失1.28%/授权0/运维20万）')
p()
p('*FIX(r3)：蓝盒子授权费未知 [AS-COST-0003/待核实②]；非零敏感性按首年起计费，不继承百夫长减免。*')
p()
p('| 变量 | 低值 | 高值 | 阈值@低(张) | 阈值@高(张) | 回本@2000张低/高(年) |')
p('|---|---:|---:|---:|---:|---:|')
base_N, _ = breakeven_N(3600, 0.6, 0.6, SCEN['S1_浦发白金_境外8%'], T=3)
base_pb = payback(3600, 0.6, 0.6, SCEN['S1_浦发白金_境外8%'], 2000)
tornado = [
    ('年费留存率 r [A]', 0.4, 0.8, lambda v: breakeven_N(3600, 0.6, v, SCEN['S1_浦发白金_境外8%'], T=3)[0],
     lambda v: payback(3600, 0.6, v, SCEN['S1_浦发白金_境外8%'], 2000)),
    ('活卡率 a [A]', 0.26, 0.60, lambda v: breakeven_N(3600, v, 0.6, SCEN['S1_浦发白金_境外8%'], T=3)[0],
     lambda v: payback(3600, v, 0.6, SCEN['S1_浦发白金_境外8%'], 2000)),
    ('境外消费占比 [A]', 0.08, 0.26, lambda v: breakeven_N(3600, 0.6, 0.6, SCEN['S2_浦发超白金_境外26%'] if v > 0.1 else SCEN['S1_浦发白金_境外8%'], T=3)[0],
     lambda v: payback(3600, 0.6, 0.6, SCEN['S2_浦发超白金_境外26%'] if v > 0.1 else SCEN['S1_浦发白金_境外8%'], 2000)),
    ('权益成本 元/活卡 [A]', 500, 1500, lambda v: breakeven_N(3600, 0.6, 0.6, SCEN['S1_浦发白金_境外8%'], T=3, benefit=v)[0],
     lambda v: payback(3600, 0.6, 0.6, SCEN['S1_浦发白金_境外8%'], 2000, benefit=v)),
    ('蓝盒子授权费 万/年 [A]', 0, 100, lambda v: breakeven_N(3600, 0.6, 0.6, SCEN['S1_浦发白金_境外8%'], T=3, license=v)[0],
     lambda v: payback(3600, 0.6, 0.6, SCEN['S1_浦发白金_境外8%'], 2000, license=v)),
    ('银数运维费 万/年 [A]', 10, 30, lambda v: breakeven_N(3600, 0.6, 0.6, SCEN['S1_浦发白金_境外8%'], T=3, ops=v)[0],
     lambda v: payback(3600, 0.6, 0.6, SCEN['S1_浦发白金_境外8%'], 2000, ops=v)),
    ('高端卡损失率 [A]', 0.0128, 0.0256, lambda v: breakeven_N(3600, 0.6, 0.6, SCEN['S1_浦发白金_境外8%'], T=3, loss_rate=v)[0],
     lambda v: payback(3600, 0.6, 0.6, SCEN['S1_浦发白金_境外8%'], 2000, loss_rate=v)),
]
p(f'| 基准 | — | — | {base_N:,.0f} | {base_N:,.0f} | {base_pb:.2f} 年 |')
for name, lo, hi, fnN, fnPb in tornado:
    nlo, nhi = fnN(lo), fnN(hi)
    plo, phi = fnPb(lo), fnPb(hi)
    plo_s = f'{plo:.2f}' if plo else '>10'
    phi_s = f'{phi:.2f}' if phi else '>10'
    p(f'| {name} | {lo} | {hi} | {nlo:,.0f} | {nhi:,.0f} | {plo_s} / {phi_s} |')

# 双变量热力表（显式写法，参数名与 breakeven_N/payback 一一对应，避免歧义）
def heat_cell(n, pb):
    """热力着色：🟢≤800张 🟡800-1,500 🟠1,500-3,000 🔴>3,000"""
    mark = '🟢' if n <= 800 else ('🟡' if n <= 1500 else ('🟠' if n <= 3000 else '🔴'))
    pbs = f'{pb:.1f}' if pb else '>10'
    return f'{mark} {n:,.0f}张/{pbs}年'

p()
p('### 表C-2 热力表：年费留存率 × 活卡率（3年回本阈值/2000张回本周期；其余基准 S1/权益800/授权0/运维20万）')
p()
p('| 活卡率 \\ 留存率 | 40% | 50% | 60% | 70% | 80% |')
p('|---:|---:|---:|---:|---:|---:|')
for a in [0.26, 0.40, 0.60]:
    cells = []
    for r in [0.4, 0.5, 0.6, 0.7, 0.8]:
        n, _ = breakeven_N(3600, a, r, SCEN['S1_浦发白金_境外8%'], T=3)
        pb = payback(3600, a, r, SCEN['S1_浦发白金_境外8%'], 2000)
        cells.append(heat_cell(n, pb))
    p(f'| {a*100:.0f}% | ' + ' | '.join(cells) + ' |')

p()
p('### 表C-3 热力表：蓝盒子授权费 × 银数运维费（3年回本阈值/2000张回本周期；S1/活卡60%/留存60%/权益800）')
p()
p('| 运维费 \\ 授权费 | 0万 | 50万 | 100万 |')
p('|---:|---:|---:|---:|')
for op in [10, 20, 30]:
    cells = []
    for lic in [0, 50, 100]:
        n, _ = breakeven_N(3600, 0.6, 0.6, SCEN['S1_浦发白金_境外8%'], T=3, license=lic, ops=op)
        pb = payback(3600, 0.6, 0.6, SCEN['S1_浦发白金_境外8%'], 2000, license=lic, ops=op)
        cells.append(heat_cell(n, pb))
    p(f'| {op}万 | ' + ' | '.join(cells) + ' |')

p()
p('### 表C-4 热力表：权益成本 × 境外消费占比（3年回本阈值/2000张回本周期；活卡60%留存60%）')
p()
p('| 权益成本 \\ 境外占比 | 8% (S1白金) | 26% (S2超白金) |')
p('|---:|---:|---:|')
for ben in [500, 800, 1500]:
    cells = []
    for sname in ['S1_浦发白金_境外8%', 'S2_浦发超白金_境外26%']:
        n, _ = breakeven_N(3600, 0.6, 0.6, SCEN[sname], T=3, benefit=ben)
        pb = payback(3600, 0.6, 0.6, SCEN[sname], 2000, benefit=ben)
        cells.append(heat_cell(n, pb))
    p(f'| {ben} 元/活卡 | ' + ' | '.join(cells) + ' |')
p()
p('*热力图例：🟢 3年回本阈值≤800张（强可行）｜🟡 800-1,500张（可行）｜🟠 1,500-3,000张（临界）｜🔴 >3,000张（不具试点意义）。单元格=3年回本阈值/2,000张回本周期。*')

# 全网格统计（6 维 3×2×2×3×3×3 = 324 组合）
p()
p('### 表C-5 六维全网格（324 组合）3 年回本阈值分布（口径A、年费3,600）')
grid_N = []
for r in [0.4, 0.6, 0.8]:
    for a in [0.26, 0.60]:
        for sname in ['S1_浦发白金_境外8%', 'S2_浦发超白金_境外26%']:
            for ben in [500, 800, 1500]:
                for lic in [0, 50, 100]:
                    for op in [10, 20, 30]:
                        n, _ = breakeven_N(3600, a, r, SCEN[sname], T=3, benefit=ben, license=lic, ops=op)
                        grid_N.append(n)
grid_N.sort()
import statistics
p(f'| 统计量 | 值 |')
p('|---:|---:|')
p(f'| 组合数 | {len(grid_N)} |')
p(f'| 最小值 | {grid_N[0]:,.0f} 张 |')
p(f'| P25 | {grid_N[len(grid_N)//4]:,.0f} 张 |')
p(f'| 中位数 | {grid_N[len(grid_N)//2]:,.0f} 张 |')
p(f'| P75 | {grid_N[3*len(grid_N)//4]:,.0f} 张 |')
p(f'| 最大值 | {grid_N[-1]:,.0f} 张 |')
p(f'| 阈值≤1,000张 的组合占比 | {sum(1 for x in grid_N if x<=1000)/len(grid_N)*100:.0f}% |')
p(f'| 阈值≤2,000张 的组合占比 | {sum(1 for x in grid_N if x<=2000)/len(grid_N)*100:.0f}% |')
p(f'| 阈值≤3,215张 的组合占比 | {sum(1 for x in grid_N if x<=3215)/len(grid_N)*100:.0f}% |')

# ---------------- (d) 盈亏平衡图数据 ----------------
p()
p('### 表D-1 回本周期（年）：发卡量 × 三通道（S1 白金、活卡率60%、年费留存60%、年费3,600）')
p()
p('| 发卡量(张) | A 银数·蓝盒子 | B 银数·百夫长 | C 直连 |')
p('|---:|---:|---:|---:|')
for N in [500, 1000, 1200, 1500, 2000, 2800, 3215]:
    cells = []
    for ch in ['A_银数_蓝盒子', 'B_银数_百夫长', 'C_直连']:
        pb = payback(3600, 0.6, 0.6, SCEN['S1_浦发白金_境外8%'], N, ch=ch)
        cells.append(f'{pb:.2f}' if pb else '>10 年')
    p(f'| {N} | ' + ' | '.join(cells) + ' |')

# ---------------- (e) 资本与合规成本 ----------------
p()
p('### 表E-1 资本与合规成本（新增项，均给区间）')
p()
p('| 成本项 | 公式/口径 | 基准值 | 区间 | 单卡年成本(基准,S1活卡) | 来源 |')
p('|---|---|---:|---:|---:|---|')
spend_s1 = SCEN['S1_浦发白金_境外8%']['os_spend'] + SCEN['S1_浦发白金_境外8%']['dom_spend']
fund_base = funding_per_card(SCEN['S1_浦发白金_境外8%'], 0.6)
p(f'| 资金成本 | 年消费×免息期50天/365×垫资系数0.5×资金成本率×活卡率 | {ASSUME["fund_rate"]:.1%} | 2.0%-3.0% | {fund_base:,.0f} 元/卡 | [A] 新增假设 |')
bad_base = 20000 * 0.0128 * 0.6
bad_hi = 20000 * 0.0256 * 0.6
p(f'| 拨备/风险成本 | 损失率×户均透支余额×活卡率（拨备与风险成本合一，避免重复计提） | 1.28% | 1.28%-2.56% | {bad_base:,.0f} 元/卡（2.56%时 {bad_hi:,.0f}） | [F]167 损失率2.56%，高端减半[A] |')
cap_cost = 20000 * 0.75 * 0.11 * 0.15
p(f'| 资本占用成本(信息项) | 平均透支余额×风险权重75%×资本充足率11%×资本回报率15% | — | 权重60%-100% | {cap_cost:,.0f} 元/卡 | [A] 简化估算，未计入现金流 |')
p('| 合规一次性 | 运通测试费约 15 万已含于初始 115 万；另假设合规/法务一次性 10 万 | 10 万 | 0-30 万 | — | [A] |')
p()
p('*资金成本计算：S1 年消费 24 万 × 50/365 × 0.5 × 2.5% × 0.6 ≈ {0:,} 元/卡；免息期 50 天为任务指定假设 [A]，垫资系数 0.5 假设账单周期内平均垫付月消费的一半 [A]。*'.format(round(fund_base)))
p()
p('### 表E-2 资金成本与拨备对 3 年回本阈值的影响（口径A、年费3,600、S1）')
p()
p('| 口径组合 | 首年现金流 | 稳态年现金流 | 3年回本阈值(张) |')
p('|---:|---:|---:|---:|')
for label, fund, loss in [('基准(不含资金成本)', False, 0.0128),
                           ('+资金成本(50天/2.5%)', True, 0.0128),
                           ('+资金成本+损失率2.56%(行内)', True, 0.0256)]:
    y1, yt = card_cf(3600, 0.6, 0.6, SCEN['S1_浦发白金_境外8%'], with_fund=fund, loss_rate=loss)
    n, _ = breakeven_N(3600, 0.6, 0.6, SCEN['S1_浦发白金_境外8%'], T=3, with_fund=fund, loss_rate=loss)
    p(f'| {label} | {y1:,.0f} | {yt:,.0f} | {n:,.0f} |')

# ---------------- (f) 存量升级 vs 纯新增 ----------------
p()
p('### 表F-1 存量升级 vs 纯新增：增量贡献（避免重复计算 AUM/EVA 的增量口径）')
p()
p('*增量口径：纯新增（行外新客）按 100% 计入客群价值；存量 VISA 客群升级按增量系数 θ=10%（区间5%-20%）[A] 计入——其 AUM/EVA 已体现在行内基线，只计因高端卡权益绑定带来的提升部分。基线需试点前客户行为摸底（待核实⑥）。*')
p()
p('| 口径 | 每户增量AUM(元) | 每户增量EVA(元/年) | 2,000户增量AUM(万元) | 2,000户增量EVA(万元/年) |')
p('|---:|---:|---:|---:|---:|')
for name, theta in [('纯新增(θ=100%)', 1.0), ('存量VISA升级(θ=10%[A])', 0.10), ('存量VISA升级上限(θ=20%[A])', 0.20)]:
    ia = FACT['visa_aum'] * theta
    ie = FACT['visa_eva'] * theta
    p(f'| {name} | {ia:,.0f} | {ie:,.0f} | {ia*2000/1e4:,.0f} | {ie*2000/1e4:,.0f} |')
p()
p('### 表F-2 不同发卡量的增量 EVA 与 AUM（纯新增口径，VISA 客群价值）')
p()
p('| 发卡量(张) | 增量EVA(万元/年) | 增量AUM(万元) | 全行境外客群口径EVA(万元/年, 945元/户) |')
p('|---:|---:|---:|---:|')
for N in [500, 1000, 1200, 1500, 2000, 2800, 3215]:
    p(f'| {N} | {FACT["visa_eva"]*N/1e4:,.0f} | {FACT["visa_aum"]*N/1e4:,.0f} | {FACT["os_eva"]*N/1e4:,.0f} |')

# ---------------- (g) 情景分析 ----------------
p()
p('### 表G-1 三情景 3 年 NPV（万元；综合口径：含留存衰减/资金成本/折现 8%；通道A 银数·蓝盒子；年费3,600）')
p()
p('| 发卡量(张) | 基准 NPV3(万元) | 乐观 NPV3(万元) | 悲观 NPV3(万元) |')
p('|---:|---:|---:|---:|')
for N in [500, 1000, 1200, 1500, 2000, 2800, 3215]:
    cells = []
    for sname in ['基准', '乐观', '悲观']:
        s = SCENARIOS[sname]
        npv = portfolio_npv3(N, 3600, s['a'], s['r'], SCEN[s['scen']], m_inst=s['m'],
                             benefit=s['benefit'], loss_rate=s['loss'], license=s['license'], ops=s['ops'])
        cells.append(f'{npv/1e4:,.0f}')
    p(f'| {N} | ' + ' | '.join(cells) + ' |')
p()
p('### 表G-2 折现率敏感性：3 年 NPV（万元，2,000 张）')
p()
p('| 折现率[A] | 基准 | 乐观 | 悲观 |')
p('|---:|---:|---:|---:|')
for d in [0.06, 0.08, 0.10]:
    cells = []
    for sname in ['基准', '乐观', '悲观']:
        s = SCENARIOS[sname]
        npv = portfolio_npv3(2000, 3600, s['a'], s['r'], SCEN[s['scen']], m_inst=s['m'],
                             benefit=s['benefit'], loss_rate=s['loss'], license=s['license'], ops=s['ops'], d=d)
        cells.append(f'{npv/1e4:,.0f}')
    p(f'| {d:.0%} | ' + ' | '.join(cells) + ' |')
p()
p('### 表G-3 决策阈值（3 年回本口径，与任务B/01 报告一致；另列综合口径 NPV3 盈亏平衡发卡量）')
p()
p('| 情景 | 3年回本阈值(张) | 2年回本阈值(张) | 综合口径NPV3盈亏平衡(张) | 决策含义 |')
p('|---:|---:|---:|---:|---|')

def npv_cross(sname):
    """综合口径（含资金成本/留存衰减/折现8%）3年NPV 盈亏平衡发卡量（线性插值）"""
    s = SCENARIOS[sname]
    lo, hi = 100, 8000
    nv_lo = portfolio_npv3(lo, 3600, s['a'], s['r'], SCEN[s['scen']], m_inst=s['m'],
                           benefit=s['benefit'], loss_rate=s['loss'], license=s['license'], ops=s['ops'])
    nv_hi = portfolio_npv3(hi, 3600, s['a'], s['r'], SCEN[s['scen']], m_inst=s['m'],
                           benefit=s['benefit'], loss_rate=s['loss'], license=s['license'], ops=s['ops'])
    if nv_lo >= 0:
        return lo
    if nv_hi <= 0:
        return None
    for _ in range(60):  # 二分
        mid = (lo + hi) / 2
        nv_mid = portfolio_npv3(mid, 3600, s['a'], s['r'], SCEN[s['scen']], m_inst=s['m'],
                                benefit=s['benefit'], loss_rate=s['loss'], license=s['license'], ops=s['ops'])
        if nv_mid >= 0:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2

for sname in ['基准', '乐观', '悲观']:
    s = SCENARIOS[sname]
    n3, _ = breakeven_N(3600, s['a'], s['r'], SCEN[s['scen']], T=3, m_inst=s['m'],
                        benefit=s['benefit'], loss_rate=s['loss'], license=s['license'], ops=s['ops'])
    n2, _ = breakeven_N(3600, s['a'], s['r'], SCEN[s['scen']], T=2, m_inst=s['m'],
                        benefit=s['benefit'], loss_rate=s['loss'], license=s['license'], ops=s['ops'])
    nx = npv_cross(sname)
    nx_s = f'{nx:,.0f}' if nx else '>8,000'
    note = {'基准': '发卡≥635张可3年回本；试点目标1,200-2,000张；综合口径NPV3盈亏平衡约1,065张',
            '乐观': '≥352张即可3年回本；2,000张回本约2.2年；综合口径NPV3盈亏平衡约520张',
            '悲观': '≥3,215张方可3年回本（简单口径）→ 低于该线触发「不启动/缩量」；综合口径（含资金成本/留存衰减/折现）下3,215张3年NPV≈-64万，仍为负 → 悲观即不启动'}[sname]
    p(f'| {sname} | {n3:,.0f} | {n2:,.0f} | {nx_s} | {note} |')

# ================= JSON 汇总（供文档引用核对） =================
res = {
    'base_N3': base_N,
    'base_payback_2000': base_pb,
    'ltv_S1_3600': {'L3': ltv(3600,0.6,0.6,SCEN['S1_浦发白金_境外8%'],3,with_fund=True)[0],
                    'L5': ltv(3600,0.6,0.6,SCEN['S1_浦发白金_境外8%'],5,with_fund=True)[0],
                    'L7': ltv(3600,0.6,0.6,SCEN['S1_浦发白金_境外8%'],7,with_fund=True)[0]},
    'scenario_npv3_2000': {s: portfolio_npv3(2000,3600,SCENARIOS[s]['a'],SCENARIOS[s]['r'],SCEN[SCENARIOS[s]['scen']],
        m_inst=SCENARIOS[s]['m'],benefit=SCENARIOS[s]['benefit'],loss_rate=SCENARIOS[s]['loss'],
        license=SCENARIOS[s]['license'],ops=SCENARIOS[s]['ops'])/1e4 for s in ['基准','乐观','悲观']},
    'scenario_threshold3': {s: breakeven_N(3600,SCENARIOS[s]['a'],SCENARIOS[s]['r'],SCEN[SCENARIOS[s]['scen']],
        T=3,m_inst=SCENARIOS[s]['m'],benefit=SCENARIOS[s]['benefit'],loss_rate=SCENARIOS[s]['loss'],
        license=SCENARIOS[s]['license'],ops=SCENARIOS[s]['ops'])[0] for s in ['基准','乐观','悲观']},
    'grid': {'n': len(grid_N), 'min': grid_N[0], 'median': grid_N[len(grid_N)//2], 'max': grid_N[-1],
             'pct_le1000': sum(1 for x in grid_N if x<=1000)/len(grid_N)*100,
             'pct_le2000': sum(1 for x in grid_N if x<=2000)/len(grid_N)*100},
}
with open('output/model_c_results.json', 'w', encoding='utf-8') as f:
    json.dump(res, f, ensure_ascii=False, indent=2)

print('\n'.join(OUT))
print()
print('JSON 汇总已写入 output/model_c_results.json')
