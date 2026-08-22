# -*- coding: utf-8 -*-
"""Add 12 logic diagrams (SVG, L1-L12) to Part C annex (重做版)."""
import io

BASE = "/root/zhijian/dsh-expert-library/work/98wiki/projects/沪八条二手转保租单元经济_重做/"
p = BASE + "专家版_partC.md"
text = io.open(p, encoding="utf-8").read()

def fig(title, svg_body, w=700, h=150):
    return ('<div class="svg-wrap">\n<svg width="%d" height="%d" viewBox="0 0 %d %d" xmlns="http://www.w3.org/2000/svg" font-family="Noto Sans CJK SC">\n'
            % (w, h, w, h)) + svg_body + ('\n</svg>\n<div class="figure-cap">%s</div>\n</div>\n' % title)

def flow(items, ys=30, bw=150, bh=56, gap=36, x0=20, fs=12, color="#14304f"):
    s = []
    n = len(items)
    x = x0
    for i, (t, sub) in enumerate(items):
        cx = x + bw / 2
        s.append('<rect x="%d" y="%d" width="%d" height="%d" rx="6" fill="%s"/>' % (x, ys, bw, bh, color))
        s.append('<text x="%d" y="%d" fill="#fff" font-size="%d" text-anchor="middle">%s</text>' % (cx, ys + 24, fs, t))
        if sub:
            s.append('<text x="%d" y="%d" fill="#cfe0f2" font-size="10" text-anchor="middle">%s</text>' % (cx, ys + 42, sub))
        if i < n - 1:
            ax = x + bw
            s.append('<polygon points="%d,%d %d,%d %d,%d %d,%d %d,%d %d,%d" fill="#c9a96e"/>' % (ax, ys + 28, ax + gap - 4, ys + 28, ax + gap - 12, ys + 20, ax + gap + 6, ys + 28, ax + gap - 12, ys + 36, ax + gap - 4, ys + 28))
        x += bw + gap
    return "\n".join(s)

svg_blocks = []

# L1 政策锚点链
svg_blocks.append(fig("逻辑图 L1｜政策锚点链：沪八条 → 制度化收购 → 细则缺口",
    flow([("沪八条", "08-20发布/08-21施行"), ("第5条核心", "收购+十五五绑定"), ("中心城区", "含浦东外环内"), ("六部门分工", "跨条线协同"), ("定价细则缺口", "待公布")])))

# L2 试点扩围路径
svg_blocks.append(fig("逻辑图 L2｜试点扩围路径：523 → 551 → 全部中心城区",
    flow([("2026-02 启动", "沪七条·三区试点"), ("2026-05 扩围", "523 套·8 区"), ("2026-07-30", "551 套·三区口径"), ("2026-08-20 制度化", "全部中心城区"), ("信号规模", "占比<0.2%【推断】")])))

# L3 首例对价锚
l3 = ('<rect x="30" y="40" width="170" height="60" rx="6" fill="#23486e"/>\n'
      '<text x="115" y="66" fill="#fff" font-size="12" text-anchor="middle">40㎡ 老房</text>\n'
      '<text x="115" y="86" fill="#cfe0f2" font-size="10" text-anchor="middle">挂牌一年多未卖出</text>\n'
      '<rect x="265" y="40" width="170" height="60" rx="6" fill="#23486e"/>\n'
      '<text x="350" y="66" fill="#fff" font-size="12" text-anchor="middle">220 万房票</text>\n'
      '<text x="350" y="86" fill="#cfe0f2" font-size="10" text-anchor="middle">≈5.5 万/㎡（实测锚）</text>\n'
      '<rect x="500" y="40" width="170" height="60" rx="6" fill="#8a6d1a"/>\n'
      '<text x="585" y="66" fill="#fff" font-size="12" text-anchor="middle">反推 8-9 折</text>\n'
      '<text x="585" y="86" fill="#f3e7c9" font-size="10" text-anchor="middle">对 6.2-6.9 万/㎡ 行情带【推断】</text>\n'
      '<text x="350" y="125" fill="#5b6570" font-size="10" text-anchor="middle">首例的示范意义大于财务意义</text>')
svg_blocks.append(fig("逻辑图 L3｜首例收购对价锚：40㎡ → 220 万 → 8-9 折", l3, h=140))

# L4 市场双口径
l4 = ('<rect x="40" y="45" width="270" height="70" rx="6" fill="#23486e"/>\n'
      '<text x="175" y="72" fill="#fff" font-size="12" text-anchor="middle">口径 A：3.07 万/㎡</text>\n'
      '<text x="175" y="94" fill="#cfe0f2" font-size="10" text-anchor="middle">2026-08-07 日度·含远郊</text>\n'
      '<rect x="390" y="45" width="270" height="70" rx="6" fill="#23486e"/>\n'
      '<text x="525" y="72" fill="#fff" font-size="12" text-anchor="middle">口径 B：5.13 万/㎡</text>\n'
      '<text x="525" y="94" fill="#cfe0f2" font-size="10" text-anchor="middle">2026-03 月度·环比 -0.47%</text>\n'
      '<text x="350" y="140" fill="#5b6570" font-size="11" text-anchor="middle">核心区 10 万+/㎡（黄浦/徐汇）——两口径相差近 40%，K 型分化</text>')
svg_blocks.append(fig("逻辑图 L4｜市场双口径与核心区分化", l4, h=155))

# L5 量价租三锚
svg_blocks.append(fig("逻辑图 L5｜量价租三锚：止跌回稳的证据链",
    flow([("量：年内 17.46 万套", "7月约2.3万套·5年同期新高"), ("价：3月终结33个月下跌", "核心区10万+/㎡先行"), ("租：一线连涨5个月", "50城7月环比+0.13%"), ("判定：量先价稳", "L型磨底期")])))

# L6 制度上限
svg_blocks.append(fig("逻辑图 L6｜制度上限：租金九折锁死收益端",
    flow([("市场租金", "同地段锚定"), ("保租房租金≤九折", "2022年制度规则"), ("收益端封顶", "分子端刚性"), ("成本端找补", "折扣+资金成本"), ("制度单利", "非市场化生意")])))

# L7 资金成本结构
l7 = ('<rect x="30" y="40" width="200" height="70" rx="6" fill="#1d6f42"/>\n'
      '<text x="130" y="66" fill="#fff" font-size="12" text-anchor="middle">再贷款 1.75%</text>\n'
      '<text x="130" y="88" fill="#d6ecd6" font-size="10" text-anchor="middle">3000亿/21行/可展期4次</text>\n'
      '<rect x="260" y="40" width="200" height="70" rx="6" fill="#8a6d1a"/>\n'
      '<text x="360" y="66" fill="#fff" font-size="12" text-anchor="middle">综合 2.0%-3.0%</text>\n'
      '<text x="360" y="88" fill="#f3e7c9" font-size="10" text-anchor="middle">再贷款+区财政+国企自筹【推断】</text>\n'
      '<rect x="490" y="40" width="200" height="70" rx="6" fill="#a33"/>\n'
      '<text x="590" y="66" fill="#fff" font-size="12" text-anchor="middle">5Y LPR 3.5%</text>\n'
      '<text x="590" y="88" fill="#f6d6d6" font-size="10" text-anchor="middle">连续15个月不变</text>\n'
      '<text x="350" y="135" fill="#5b6570" font-size="11" text-anchor="middle">175bp 政策红利 = 单元经济氧气</text>')
svg_blocks.append(fig("逻辑图 L7｜资金成本三档：1.75% / 2.0-3.0% / 3.5%", l7, h=150))

# L8 三组合剪刀差
l8 = ('<rect x="24" y="40" width="212" height="90" rx="6" fill="#1d6f42"/>\n'
      '<text x="130" y="66" fill="#fff" font-size="12" text-anchor="middle">组合① 8折+1.75%+90%</text>\n'
      '<text x="130" y="88" fill="#d6ecd6" font-size="10" text-anchor="middle">r 2.2%-2.6% > c 1.75%</text>\n'
      '<text x="130" y="108" fill="#fff" font-size="10" text-anchor="middle">勉强成立</text>\n'
      '<rect x="256" y="40" width="212" height="90" rx="6" fill="#a33"/>\n'
      '<text x="362" y="66" fill="#fff" font-size="12" text-anchor="middle">组合② 9折+3.0%+85%</text>\n'
      '<text x="362" y="88" fill="#f6d6d6" font-size="10" text-anchor="middle">r 1.4%-1.6% < c 3.0%</text>\n'
      '<text x="362" y="108" fill="#fff" font-size="10" text-anchor="middle">缺口 1.4-1.6pp 不成立</text>\n'
      '<rect x="488" y="40" width="212" height="90" rx="6" fill="#8a6d1a"/>\n'
      '<text x="594" y="66" fill="#fff" font-size="12" text-anchor="middle">组合③ 7.5折+2.0%+92%</text>\n'
      '<text x="594" y="88" fill="#f3e7c9" font-size="10" text-anchor="middle">r 2.5%-2.9% > c 2.0%</text>\n'
      '<text x="594" y="108" fill="#fff" font-size="10" text-anchor="middle">成立·依赖折扣纪律</text>\n'
      '<text x="350" y="150" fill="#5b6570" font-size="10" text-anchor="middle">全部条件式【推断】</text>')
svg_blocks.append(fig("逻辑图 L8｜三组合剪刀差判定", l8, h=160))

# L9 CAPEX+空置
l9 = ('<rect x="60" y="40" width="250" height="60" rx="6" fill="#8a6d1a"/>\n'
      '<text x="185" y="66" fill="#fff" font-size="12" text-anchor="middle">CAPEX 摊销 0.18%-0.34%</text>\n'
      '<text x="185" y="86" fill="#f3e7c9" font-size="10" text-anchor="middle">单套8-15万/单方1000-3000元【推断】</text>\n'
      '<rect x="390" y="40" width="250" height="60" rx="6" fill="#a33"/>\n'
      '<text x="515" y="66" fill="#fff" font-size="12" text-anchor="middle">空置期损失 0.5%-1.2%</text>\n'
      '<text x="515" y="86" fill="#f6d6d6" font-size="10" text-anchor="middle">改造期 3-6 个月【推断】</text>\n'
      '<text x="350" y="130" fill="#5b6570" font-size="11" text-anchor="middle">合计 0.8-1.7pp → 足以翻转"勉强成立"（全报告最脆弱处）</text>')
svg_blocks.append(fig("逻辑图 L9｜CAPEX 与空置期：隐性成本合计", l9, h=145))

# L10 资金量情景
l10 = ('<rect x="40" y="45" width="290" height="70" rx="6" fill="#1d6f42"/>\n'
      '<text x="185" y="72" fill="#fff" font-size="12" text-anchor="middle">情景 A：1.6 万套 ≈360 亿</text>\n'
      '<text x="185" y="94" fill="#d6ecd6" font-size="10" text-anchor="middle">约挂牌5%·8.5折·预算占比≈4.5%【推断】</text>\n'
      '<rect x="380" y="45" width="290" height="70" rx="6" fill="#8a6d1a"/>\n'
      '<text x="525" y="72" fill="#fff" font-size="12" text-anchor="middle">情景 B：10 万套 ≈2240 亿</text>\n'
      '<text x="525" y="94" fill="#f3e7c9" font-size="10" text-anchor="middle">约年成交40%·依赖再贷款扩额+REITs【推断】</text>\n'
      '<text x="350" y="140" fill="#5b6570" font-size="11" text-anchor="middle">制度化与放量之间隔着千亿级资金</text>')
svg_blocks.append(fig("逻辑图 L10｜放量资金情景：360 亿 vs 2240 亿", l10, h=155))

# L11 REITs 闭环
svg_blocks.append(fig("逻辑图 L11｜REITs 闭环：投融建管退",
    flow([("低成本资金沉淀", "再贷款1.75%"), ("收储资产包", "出租率/收缴率达标"), ("REITs 发行/扩募", "城投宽庭参照"), ("回收资金", "年化约1.27亿【推断】"), ("再收购滚动", "自我循环")])))

# L12 验证裁决路径
svg_blocks.append(fig("逻辑图 L12｜两季度验证与裁决路径",
    flow([("四指标采集", "折扣/出租/实现率/资金"), ("代入判定式", "r vs c 剪刀差"), ("情景判定", "基准/乐观/悲观"), ("止损执行", "暂停扩量/重查选址"), ("终局裁决", "成立/存疑/象征")])))

marker = "（逻辑图 L1-L12 由 add_logic_diagrams_redo.py 注入）"
assert marker in text, "marker not found"
text = text.replace(marker, "\n\n".join(svg_blocks), 1)

with io.open(p, "w", encoding="utf-8") as f:
    f.write(text)

import re
print("SVG 数:", text.count("<svg"))
print("逻辑图数:", len(re.findall(r"逻辑图 L\d+", text)))
print("WROTE", p)
