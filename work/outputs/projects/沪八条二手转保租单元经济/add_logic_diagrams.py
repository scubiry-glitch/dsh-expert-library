# -*- coding: utf-8 -*-
"""Add 12 logic diagrams (SVG) to Part C annex."""
import io

BASE = "/root/zhijian/dsh-expert-library/work/98wiki/projects/沪八条二手转保租单元经济/"
p = BASE + "专家版_partC.md"
text = io.open(p, encoding="utf-8").read()

BOX = 'rect x="%d" y="%d" width="%d" height="%d" rx="6"'
def fig(title, svg_body, w=700, h=150):
    return ('<div class="svg-wrap">\n<svg width="%d" height="%d" viewBox="0 0 %d %d" xmlns="http://www.w3.org/2000/svg" font-family="Noto Sans CJK SC">\n'
            % (w, h, w, h)) + svg_body + ('\n</svg>\n<div class="figure-cap">%s</div>\n</div>\n' % title)

def flow(items, ys=30, bw=150, bh=56, gap=36, x0=20, fs=12, color="#14304f", cap=None):
    s = []
    n = len(items)
    total = n * bw + (n - 1) * gap
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
svg_blocks.append(fig("逻辑图 L1｜政策锚点链：沪八条 → 收改租 → 细则缺口",
    flow([("沪八条", "08-20发布/08-21施行"), ("空间限定", "中心城区+浦东外环内"), ("收改租链条", "收购→改造→出租"), ("六部门分工", "多头管理"), ("定价细则缺口", "待公布")])))

# L2 收购定价机制
svg_blocks.append(fig("逻辑图 L2｜收购定价机制链",
    flow([("周边成交价带", "锚定基准"), ("第三方评估", "独立定价"), ("折价 7-8 折", "可行域"), ("资本化率抬升", "2.2%-2.8%"), ("缺口 g 收窄", "≤1pp 贴息")])))

# L3 折价纪律边界（三带）
l3 = ('<rect x="30" y="40" width="170" height="60" rx="6" fill="#a33"/>\n'
      '<text x="115" y="66" fill="#fff" font-size="12" text-anchor="middle">＜7 折</text>\n'
      '<text x="115" y="86" fill="#f6d6d6" font-size="10" text-anchor="middle">伤卖家出清</text>\n'
      '<rect x="265" y="40" width="170" height="60" rx="6" fill="#1d6f42"/>\n'
      '<text x="350" y="66" fill="#fff" font-size="12" text-anchor="middle">7-8 折 可行域</text>\n'
      '<text x="350" y="86" fill="#d6ecd6" font-size="10" text-anchor="middle">资本化率 2.2%-2.8%</text>\n'
      '<rect x="500" y="40" width="170" height="60" rx="6" fill="#8a6d1a"/>\n'
      '<text x="585" y="66" fill="#fff" font-size="12" text-anchor="middle">＞8 折</text>\n'
      '<text x="585" y="86" fill="#f3e7c9" font-size="10" text-anchor="middle">接盘风险区</text>\n'
      '<text x="350" y="125" fill="#5b6570" font-size="10" text-anchor="middle">纪律三件套：第三方评估 + 公开遴选 + 收购量锚定保租房任务</text>')
svg_blocks.append(fig("逻辑图 L3｜折价纪律三带边界", l3, h=140))

# L4 CAPEX 双口径
l4 = ('<rect x="60" y="40" width="240" height="60" rx="6" fill="#23486e"/>\n'
      '<text x="180" y="66" fill="#fff" font-size="12" text-anchor="middle">口径 A：单套 8-15 万元</text>\n'
      '<text x="180" y="86" fill="#cfe0f2" font-size="10" text-anchor="middle">实测评估口径（C）</text>\n'
      '<rect x="400" y="40" width="240" height="60" rx="6" fill="#23486e"/>\n'
      '<text x="520" y="66" fill="#fff" font-size="12" text-anchor="middle">口径 B：单方 1000-3000 元/㎡</text>\n'
      '<text x="520" y="86" fill="#cfe0f2" font-size="10" text-anchor="middle">行业经验口径（K）</text>\n'
      '<text x="350" y="125" fill="#5b6570" font-size="10" text-anchor="middle">双口径并存 → 待实测校准；CAPEX 沉没进资产，不可逆</text>')
svg_blocks.append(fig("逻辑图 L4｜改造 CAPEX 双口径", l4, h=140))

# L5 政策租金锁定
svg_blocks.append(fig("逻辑图 L5｜政策租金锁定：收益端封顶",
    flow([("同地段市场租金", "锚定基准"), ("制度上限 9 折", "不高于市场价"), ("建议带 85%-90%", "C 建议"), ("收益端锁定", "分子端刚性")])))

# L6 负剪刀差
l6 = ('<rect x="40" y="45" width="270" height="70" rx="6" fill="#8a6d1a"/>\n'
      '<text x="175" y="72" fill="#fff" font-size="12" text-anchor="middle">收益率 r：1.5%-2%（机构口径）</text>\n'
      '<text x="175" y="94" fill="#f3e7c9" font-size="10" text-anchor="middle">9 折后 1.4%-1.8%</text>\n'
      '<rect x="390" y="45" width="270" height="70" rx="6" fill="#a33"/>\n'
      '<text x="525" y="72" fill="#fff" font-size="12" text-anchor="middle">资金成本 c：≥1.75%</text>\n'
      '<text x="525" y="94" fill="#f6d6d6" font-size="10" text-anchor="middle">再贷款 1.75% / 市场化 2.5%+</text>\n'
      '<text x="350" y="140" fill="#5b6570" font-size="11" text-anchor="middle">负剪刀差 g = c − r → 靠 7-8 折 + 低成本资金对冲</text>')
svg_blocks.append(fig("逻辑图 L6｜收益率 vs 资金成本：负剪刀差", l6, h=155))

# L7 可行性不等式三条件交集
l7 = ('<ellipse cx="300" cy="85" rx="150" ry="60" fill="#eef4fb" stroke="#14304f" stroke-width="1.5"/>\n'
      '<ellipse cx="400" cy="85" rx="150" ry="60" fill="#eef4fb" stroke="#14304f" stroke-width="1.5"/>\n'
      '<ellipse cx="350" cy="130" rx="150" ry="60" fill="#eef4fb" stroke="#14304f" stroke-width="1.5"/>\n'
      '<text x="205" y="60" fill="#14304f" font-size="11" text-anchor="middle">收购折扣 ≤8 折</text>\n'
      '<text x="500" y="60" fill="#14304f" font-size="11" text-anchor="middle">资金成本 ≤2%</text>\n'
      '<text x="350" y="185" fill="#14304f" font-size="11" text-anchor="middle">出租率 ≥90%</text>\n'
      '<text x="350" y="105" fill="#1d6f42" font-size="11" font-weight="bold" text-anchor="middle">可行域</text>\n'
      '<text x="350" y="122" fill="#1d6f42" font-size="9" text-anchor="middle">三条件交集</text>')
svg_blocks.append(fig("逻辑图 L7｜可行性三条件交集", l7, h=210))

# L8 出租率分级
l8 = ('<rect x="40" y="45" width="170" height="60" rx="6" fill="#a33"/>\n'
      '<text x="125" y="71" fill="#fff" font-size="12" text-anchor="middle">＜85%</text>\n'
      '<text x="125" y="90" fill="#f6d6d6" font-size="10" text-anchor="middle">托底预警区</text>\n'
      '<rect x="265" y="45" width="170" height="60" rx="6" fill="#8a6d1a"/>\n'
      '<text x="350" y="71" fill="#fff" font-size="12" text-anchor="middle">85%-90%</text>\n'
      '<text x="350" y="90" fill="#f3e7c9" font-size="10" text-anchor="middle">观察/爬坡区</text>\n'
      '<rect x="490" y="45" width="170" height="60" rx="6" fill="#1d6f42"/>\n'
      '<text x="575" y="71" fill="#fff" font-size="12" text-anchor="middle">≥90%</text>\n'
      '<text x="575" y="90" fill="#d6ecd6" font-size="10" text-anchor="middle">闭环成立线</text>')
svg_blocks.append(fig("逻辑图 L8｜出租率三级判定", l8, h=130))

# L9 散楼 vs 园区成本分解
l9 = ('<rect x="40" y="30" width="260" height="100" rx="6" fill="#eef4fb" stroke="#14304f"/>\n'
      '<text x="170" y="52" fill="#14304f" font-size="12" text-anchor="middle">园区式（集中社区）</text>\n'
      '<text x="170" y="74" fill="#5b6570" font-size="10" text-anchor="middle">前台/维修/安保/收缴 批量化</text>\n'
      '<text x="170" y="92" fill="#5b6570" font-size="10" text-anchor="middle">人均管理间数高</text>\n'
      '<text x="170" y="112" fill="#5b6570" font-size="10" text-anchor="middle">成本基准 1.0×</text>\n'
      '<rect x="400" y="30" width="260" height="100" rx="6" fill="#fdf1f1" stroke="#a33"/>\n'
      '<text x="530" y="52" fill="#a33" font-size="12" text-anchor="middle">中心城区散楼</text>\n'
      '<text x="530" y="74" fill="#5b6570" font-size="10" text-anchor="middle">逐户对接 · 空驶维修 · 消防分散</text>\n'
      '<text x="530" y="92" fill="#5b6570" font-size="10" text-anchor="middle">人均管理间数 1/3-1/2</text>\n'
      '<text x="530" y="112" fill="#a33" font-size="10" text-anchor="middle">成本可能 ≥1.5×</text>')
svg_blocks.append(fig("逻辑图 L9｜散楼 vs 园区式成本结构", l9, h=150))

# L10 滚动现金流转
svg_blocks.append(fig("逻辑图 L10｜再收购滚动现金流环",
    flow([("收购", "7-8 折"), ("改造", "CAPEX 沉没"), ("出租", "NOI 流入"), ("资金衔接", "政策资金/REIT"), ("再收购滚动", "若 NOI 覆盖融资")], ys=40)))

# L11 三情景概率
l11 = ('<rect x="270" y="20" width="160" height="40" rx="6" fill="#14304f"/>\n'
       '<text x="350" y="45" fill="#fff" font-size="12" text-anchor="middle">情景判定</text>\n'
       '<line x1="330" y1="60" x2="180" y2="85" stroke="#8a8f99"/>\n'
       '<line x1="370" y1="60" x2="370" y2="85" stroke="#8a8f99"/>\n'
       '<line x1="400" y1="60" x2="540" y2="85" stroke="#8a8f99"/>\n'
       '<rect x="60" y="85" width="240" height="55" rx="6" fill="#23486e"/>\n'
       '<text x="180" y="110" fill="#fff" font-size="12" text-anchor="middle">基准 ≈50%（条件式）</text>\n'
       '<text x="180" y="128" fill="#cfe0f2" font-size="10" text-anchor="middle">细则温和 · 8 折 · 千套级</text>\n'
       '<rect x="250" y="85" width="240" height="55" rx="6" fill="#1d6f42"/>\n'
       '<text x="370" y="110" fill="#fff" font-size="12" text-anchor="middle">乐观 ≈25%</text>\n'
       '<text x="370" y="128" fill="#d6ecd6" font-size="10" text-anchor="middle">整栋收购 · 中央资金 · REITs 提前</text>\n'
       '<rect x="440" y="85" width="240" height="55" rx="6" fill="#a33"/>\n'
       '<text x="560" y="110" fill="#fff" font-size="12" text-anchor="middle">悲观 ≈25%</text>\n'
       '<text x="560" y="128" fill="#f6d6d6" font-size="10" text-anchor="middle">折扣>85 折 · 资金缺位 · 托市定价</text>')
svg_blocks.append(fig("逻辑图 L11｜三情景分支（基准/乐观/悲观）", l11, h=160))

# L12 验证裁决流程
svg_blocks.append(fig("逻辑图 L12｜两季度验证裁决流程",
    flow([("首批项目", "2 季度跟踪"), ("四指标", "折扣/周期/出租/实现"), ("数据达标?", "三条件齐备"), ("裁决", "成立/条件可行/降级")])))

insert_marker = "## 五、Key Takeaways（≤8 条）"
annex_section = ("## 四·补 逻辑图集（12 张）\n\n"
                 "逻辑图与详细逻辑卡 D1-D15 对应，供快速浏览机制链条。\n\n"
                 + "\n\n".join(svg_blocks)
                 + "\n\n---\n\n")
assert insert_marker in text
text = text.replace(insert_marker, annex_section + insert_marker, 1)
io.open(p, "w", encoding="utf-8").write(text)
print("svg blocks inserted:", len(svg_blocks))
