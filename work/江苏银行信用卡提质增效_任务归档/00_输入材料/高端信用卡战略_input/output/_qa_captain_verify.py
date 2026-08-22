# -*- coding: utf-8 -*-
"""
队长质量闸·独立复算基准（用于交叉核验任务E交付）
基于 model_b.py 的参数口径，独立实现 6 维敏感性 / LTV / 盈亏平衡 / 三情景 NPV。
不与任务E脚本共享代码，保证交叉核验独立性。
"""
import itertools

# ---- 事实参数（材料）----
FEE = 3600                      # 旗舰档年费（元/年）
FACT_inst = 61.49*12*0.6574     # 卡均分期息费 485.1 元/年（167）
OS_RET = 0.01                   # 运通境外回佣约1%（236）
DOM_RET = 0.002                 # 境内回佣2‰（231）
CH = {
 '银数·蓝盒子': dict(fix0=115e4, ops=20e4, lic=0),
 '银数·百夫长': dict(fix0=115e4, ops=20e4, lic=300e4),
 '直连':       dict(fix0=400e4, ops=30e4, lic=0),
}

def card_cf(fee, a, r, os_share, spend_y=240000, lic_cost=800, m_inst=1.0,
            loss=0.0128, avg_bal=20000):
    """单卡年现金流 (首年免年费): 返回 (y1, yt)"""
    os_spend = spend_y*os_share
    dom_spend = spend_y*(1-os_share)
    rc = os_spend*OS_RET + dom_spend*DOM_RET
    inst = FACT_inst*m_inst
    benefit = lic_cost*a
    bad = avg_bal*loss*a
    ops = 50
    oneoff = 80+300
    y1 = rc*a + inst - (benefit+ops+bad) - oneoff
    yt = fee*a*r + rc*a + inst - (benefit+ops+bad)
    return y1, yt

def payback(ch, N, y1, yt, T=10):
    c = CH[ch]; cum = -c['fix0']
    for t in range(1, T+1):
        lic = c['lic'] if t>1 else 0
        cf = N*(y1 if t==1 else yt) - (c['ops']+lic)
        prev = cum
        cum += cf
        if cum >= 0:
            return t - prev/cf if cf else t
    return None

def threshold_3y(ch, y1, yt):
    """3年回本阈值（含固定成本）"""
    c = CH[ch]
    fc = c['fix0'] + 3*c['ops'] + c['lic']*2   # 首年授权费减免
    return fc/(y1+2*yt)

print("="*96)
print("【质量闸1】敏感性矩阵：3年回本阈值（张）基准=635；年费3600；S1浦发白金 8%境外")
print("="*96)
base = card_cf(3600, 0.60, 0.60, 0.08)
print(f"基准(活60%/留存60%/境外8%/权益800/蓝盒授权0/运维20万): ≥{threshold_3y('银数·蓝盒子',*base):.0f} 张")
for label, kw in [
    ('年费留存40%', dict(r=0.4)), ('年费留存80%', dict(r=0.8)),
    ('活卡率26%', dict(a=0.26)),
    ('境外26%', dict(os_share=0.26)),
    ('权益500', dict(lic_cost=500)), ('权益1500', dict(lic_cost=1500)),
    ('损失率2.56%', dict(loss=0.0256)),
    ('分期0.75x', dict(m_inst=0.75)), ('分期1.5x', dict(m_inst=1.5)),
]:
    y1, yt = card_cf(3600, kw.get('a',0.60), kw.get('r',0.60), kw.get('os_share',0.08),
                     lic_cost=kw.get('lic_cost',800), m_inst=kw.get('m_inst',1.0),
                     loss=kw.get('loss',0.0128))
    print(f"{label:16s}: ≥{threshold_3y('银数·蓝盒子', y1, yt):.0f} 张")
# 蓝盒子授权费 0/50/100
for lic in [0, 50e4, 100e4]:
    CH2 = dict(CH); CH2['银数·蓝盒子'] = dict(fix0=115e4, ops=20e4, lic=lic)
    old = CH['银数·蓝盒子']; CH['银数·蓝盒子'] = CH2['银数·蓝盒子']
    print(f"蓝盒子授权费 {lic/1e4:.0f}万/年: ≥{threshold_3y('银数·蓝盒子', *card_cf(3600,0.6,0.6,0.08)):.0f} 张")
    CH['银数·蓝盒子'] = old
# 银数运维费 10/30
for ops in [10e4, 30e4]:
    CH2 = dict(CH); CH2['银数·蓝盒子'] = dict(fix0=115e4, ops=ops, lic=0)
    old = CH['银数·蓝盒子']; CH['银数·蓝盒子'] = CH2['银数·蓝盒子']
    print(f"银数运维费 {ops/1e4:.0f}万/年: ≥{threshold_3y('银数·蓝盒子', *card_cf(3600,0.6,0.6,0.08)):.0f} 张")
    CH['银数·蓝盒子'] = old

print()
print("="*96)
print("【质量闸2】LTV：年费留存衰减 60%→(递减)，单卡累计净现金流（元；口径A·3600档·S1）")
print("="*96)
def ltv(y1, yt, r_curve, T):
    cum = 0; rows=[]
    for t in range(1, T+1):
        cf = y1 if t==1 else yt*r_curve[t-1]
        cum += cf
        rows.append((t, cf, cum))
    return rows
# 留存衰减曲线：t1=首年免年费按活卡, t2+ 年费留存逐年衰减 60%→55%→50%→45%→40%→35%（假设）
decay = {2:0.60, 3:0.55, 4:0.50, 5:0.45, 6:0.40, 7:0.35}
y1, yt = card_cf(3600, 0.6, 0.6, 0.08)  # yt 内含留存60%
base_yt_no_fee = yt - 3600*0.6*0.6  # 去掉年费收入部分，便于按衰减曲线重算
for T in [3,5,7]:
    cum=0; print(f"--- {T}年 LTV ---")
    for t in range(1, T+1):
        if t==1:
            cf = y1
        else:
            cf = yt - 3600*0.6*0.6 + 3600*0.6*decay[t]
        cum += cf
        print(f"  t={t}: 现金流 {cf:8.1f}  累计 {cum:8.1f}")
print(f"  3年LTV={sum([ (y1 if t==1 else yt-1296+3600*0.6*decay[t]) for t in range(1,4)]):.0f} 元")
print(f"  5年LTV={sum([ (y1 if t==1 else yt-1296+3600*0.6*decay[t]) for t in range(1,6)]):.0f} 元")
print(f"  7年LTV={sum([ (y1 if t==1 else yt-1296+3600*0.6*decay[t]) for t in range(1,8)]):.0f} 元")

print()
print("="*96)
print("【质量闸3】盈亏平衡：7档发卡量 × 3通道 回本周期（年）（S1·3600档·活60%·留存60%）")
print("="*96)
y1, yt = card_cf(3600, 0.6, 0.6, 0.08)
for N in [500, 1000, 1200, 1500, 2000, 2800, 3215]:
    row = []
    for ch in CH:
        pb = payback(ch, N, y1, yt)
        row.append(f"{ch}:{pb:.2f}" if pb else f"{ch}:>10")
    print(f"{N:5d} 张 | " + " | ".join(row))

print()
print("="*96)
print("【质量闸4】三情景 3年NPV（折现率5%假设；口径A·3600档；固定成本含蓝盒通道）")
print("="*96)
def npv3(fix0, flows, disc=0.05):
    return -fix0 + sum(f/(1+disc)**t for t,f in enumerate(flows, start=1))
scen = {
 '基准(S1·8%境外·留存60%·分期1.0)': dict(os=0.08, r=0.6, m=1.0, N=1200),
 '乐观(S2·26%境外·留存80%·分期1.5)': dict(os=0.26, r=0.8, m=1.5, N=2000),
 '悲观(S3·保守户均·留存40%·分期0.75)': dict(os=None, r=0.4, m=0.75, N=3215),
}
for name, s in scen.items():
    if s['os'] is None:  # S3 保守场景：户均境外6033+境内573*12
        os_spend=6033; dom_spend=573*12
        y1_, yt_ = card_cf(3600, 0.6, s['r'], 0.08, spend_y=os_spend+dom_spend, m_inst=s['m'])
        # 用实际境外占比重算回佣
        rc = os_spend*OS_RET + dom_spend*DOM_RET
        inst = FACT_inst*s['m']; benefit=800*0.6; bad=20000*0.0128*0.6; ops=50; oneoff=380
        y1_ = rc*0.6+inst-(benefit+ops+bad)-oneoff
        yt_ = 3600*0.6*s['r']+rc*0.6+inst-(benefit+ops+bad)
    else:
        y1_, yt_ = card_cf(3600, 0.6, s['r'], s['os'], m_inst=s['m'])
    N = s['N']
    c = CH['银数·蓝盒子']
    flows = [N*y1_ - c['ops'], N*yt_ - c['ops'], N*yt_ - c['ops']]
    npv = npv3(c['fix0'], flows)
    print(f"{name} (N={N}): 3年NPV = {npv/1e4:.0f} 万元  {'✔ 成立' if npv>0 else '✘ 不成立'}")
    # 无折现对比
    npv0 = -c['fix0'] + sum(flows)
    print(f"     (无折现 3年累计 = {npv0/1e4:.0f} 万元)")
