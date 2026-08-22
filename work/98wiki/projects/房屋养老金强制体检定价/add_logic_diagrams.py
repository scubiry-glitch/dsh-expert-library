# -*- coding: utf-8 -*-
"""Add 12 logic diagrams (SVG) to topic-2 Part C annex."""
import io

BASE = "/root/zhijian/dsh-expert-library/work/98wiki/projects/房屋养老金强制体检定价/"
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

# L1 三项制度框架
svg_blocks.append(fig("逻辑图 L1｜三项制度框架：体检→养老金→保险→全生命周期管理",
    flow([("房屋体检", "定期安全检测"), ("房屋养老金", "资金池·两账户"), ("房屋保险", "风险分散"), ("全生命周期管理", "长效机制")])))

# L2 试点→常态化路径
svg_blocks.append(fig("逻辑图 L2｜三阶段政策路径：试点→制度化→常态化",
    flow([("2024 试点", "22 城"), ("2025 强制体检", "郑州/南通·政府买单"), ("2026 制度化", "郑州意见+北海核验码"), ("2028 常态化", "全国统一标准")])))

# L3 周期定位
l3 = ('<rect x="40" y="40" width="230" height="60" rx="6" fill="#a33"/>\n'
      '<text x="155" y="66" fill="#fff" font-size="12" text-anchor="middle">2021 峰值 17.9 亿㎡</text>\n'
      '<text x="155" y="86" fill="#f6d6d6" font-size="10" text-anchor="middle">【已核实·统计局】</text>\n'
      '<rect x="430" y="40" width="230" height="60" rx="6" fill="#1d6f42"/>\n'
      '<text x="545" y="66" fill="#fff" font-size="12" text-anchor="middle">2025 销售 8.81 亿㎡（-51%）</text>\n'
      '<text x="545" y="86" fill="#d6ecd6" font-size="10" text-anchor="middle">L 型磨底 · 2027 拐点窗口</text>\n'
      '<text x="350" y="125" fill="#5b6570" font-size="10" text-anchor="middle">主跌段结束 → 存量时代 → 制度补课</text>')
svg_blocks.append(fig("逻辑图 L3｜周期定位：主跌段结束进入 L 型磨底", l3, h=140))

# L4 持有成本资本化
svg_blocks.append(fig("逻辑图 L4｜价格冲击模型：持有成本→4%折现→折价→1%-3%冲击",
    flow([("年持有成本↑", "10-30 元/㎡【测算】"), ("4% 折现 30 年", "永续年金近似"), ("资本化折价", "200-600 元/㎡"), ("静态冲击", "1%-3%")])))

# L5 体检成本 vs 改造资金
l5 = ('<rect x="40" y="40" width="270" height="70" rx="6" fill="#1d6f42"/>\n'
      '<text x="175" y="68" fill="#fff" font-size="12" text-anchor="middle">体检全覆盖：100-250 亿</text>\n'
      '<text x="175" y="90" fill="#d6ecd6" font-size="10" text-anchor="middle">年均 20-50 亿 · 财政可承受【测算】</text>\n'
      '<rect x="390" y="40" width="270" height="70" rx="6" fill="#a33"/>\n'
      '<text x="525" y="68" fill="#fff" font-size="12" text-anchor="middle">维修改造：1-3 万亿【测算】</text>\n'
      '<text x="525" y="90" fill="#f6d6d6" font-size="10" text-anchor="middle">资金大头 · 需多元分担</text>\n'
      '<text x="350" y="135" fill="#5b6570" font-size="10" text-anchor="middle">体检环节不缺钱，缺的是制度与定价</text>')
svg_blocks.append(fig("逻辑图 L5｜量级对比：体检可控 vs 改造是大头", l5, h=150))

# L6 土地出让约束
svg_blocks.append(fig("逻辑图 L6｜公共账户约束：土地出让 -44% 与资金来源",
    flow([("2021 土地出让 8.7 万亿", "【已核实】"), ("2024 降至 4.87 万亿", "-44%"), ("公共账户承压", "不向居民收费"), ("多元分担", "财政+维修+保险")])))

# L7 六渠道定价传导
l7 = ('<rect x="20" y="20" width="180" height="44" rx="6" fill="#14304f"/>\n'
      '<text x="110" y="47" fill="#fff" font-size="11" text-anchor="middle">强制体检常态化</text>\n'
      '<line x1="110" y1="64" x2="110" y2="80" stroke="#8a8f99"/>\n'
      '<rect x="20" y="80" width="180" height="40" rx="6" fill="#23486e"/>\n'
      '<text x="110" y="103" fill="#fff" font-size="10" text-anchor="middle">① 交易门槛（北海核验码）</text>\n'
      '<rect x="20" y="124" width="180" height="40" rx="6" fill="#23486e"/>\n'
      '<text x="110" y="147" fill="#fff" font-size="10" text-anchor="middle">② 成本资本化</text>\n'
      '<rect x="20" y="168" width="180" height="40" rx="6" fill="#23486e"/>\n'
      '<text x="110" y="191" fill="#fff" font-size="10" text-anchor="middle">③ 质量信号（同房龄分化）</text>\n'
      '<rect x="260" y="80" width="180" height="40" rx="6" fill="#23486e"/>\n'
      '<text x="350" y="103" fill="#fff" font-size="10" text-anchor="middle">④ 更新改造对冲</text>\n'
      '<rect x="260" y="124" width="180" height="40" rx="6" fill="#23486e"/>\n'
      '<text x="350" y="147" fill="#fff" font-size="10" text-anchor="middle">⑤ 预期心理</text>\n'
      '<rect x="260" y="168" width="180" height="40" rx="6" fill="#23486e"/>\n'
      '<text x="350" y="191" fill="#fff" font-size="10" text-anchor="middle">⑥ 评估定价</text>\n'
      '<line x1="200" y1="100" x2="260" y2="100" stroke="#c9a96e" stroke-width="2"/>\n'
      '<line x1="200" y1="144" x2="260" y2="144" stroke="#c9a96e" stroke-width="2"/>\n'
      '<line x1="200" y1="188" x2="260" y2="188" stroke="#c9a96e" stroke-width="2"/>\n'
      '<rect x="500" y="100" width="180" height="70" rx="6" fill="#8a6d1a"/>\n'
      '<text x="590" y="128" fill="#fff" font-size="11" text-anchor="middle">净冲击 1%-3%</text>\n'
      '<text x="590" y="148" fill="#f3e7c9" font-size="9" text-anchor="middle">K 型分化大于总量冲击</text>\n'
      '<line x1="440" y1="135" x2="500" y2="135" stroke="#c9a96e" stroke-width="2"/>')
svg_blocks.append(fig("逻辑图 L7｜六渠道定价传导 → 净冲击", l7, h=230))

# L8 三大风险通道
l8 = ('<rect x="250" y="20" width="200" height="40" rx="6" fill="#14304f"/>\n'
      '<text x="350" y="45" fill="#fff" font-size="11" text-anchor="middle">三大风险通道【t3】</text>\n'
      '<line x1="300" y1="60" x2="140" y2="85" stroke="#8a8f99"/>\n'
      '<line x1="370" y1="60" x2="370" y2="85" stroke="#8a8f99"/>\n'
      '<line x1="420" y1="60" x2="570" y2="85" stroke="#8a8f99"/>\n'
      '<rect x="30" y="85" width="220" height="55" rx="6" fill="#a33"/>\n'
      '<text x="140" y="108" fill="#fff" font-size="10" text-anchor="middle">① 成本归宿：整改转嫁业主</text>\n'
      '<text x="140" y="126" fill="#f6d6d6" font-size="9" text-anchor="middle">债务-通缩触发端</text>\n'
      '<rect x="260" y="85" width="220" height="55" rx="6" fill="#a33"/>\n'
      '<text x="370" y="108" fill="#fff" font-size="10" text-anchor="middle">② 资金来源：土地出让下行</text>\n'
      '<text x="370" y="126" fill="#f6d6d6" font-size="9" text-anchor="middle">续筹→舆情重演</text>\n'
      '<rect x="490" y="85" width="220" height="55" rx="6" fill="#a33"/>\n'
      '<text x="600" y="108" fill="#fff" font-size="10" text-anchor="middle">③ 交易挂钩：抵押评估下调</text>\n'
      '<text x="600" y="126" fill="#f6d6d6" font-size="9" text-anchor="middle">流动性局部冻结</text>\n'
      '<text x="350" y="165" fill="#8a6d1a" font-size="10" text-anchor="middle">→ 化险/刺激分池纪律</text>')
svg_blocks.append(fig("逻辑图 L8｜三大风险通道与分池纪律", l8, h=180))

# L9 化险/刺激分池
l9 = ('<rect x="40" y="40" width="270" height="70" rx="6" fill="#1d6f42"/>\n'
      '<text x="175" y="68" fill="#fff" font-size="12" text-anchor="middle">房屋安全池（化险）</text>\n'
      '<text x="175" y="90" fill="#d6ecd6" font-size="10" text-anchor="middle">特别国债/专项债·与出让金脱钩【t3】</text>\n'
      '<rect x="390" y="40" width="270" height="70" rx="6" fill="#8a6d1a"/>\n'
      '<text x="525" y="68" fill="#fff" font-size="12" text-anchor="middle">收储池（刺激）</text>\n'
      '<text x="525" y="90" fill="#f3e7c9" font-size="10" text-anchor="middle">3000 亿再贷款【已核实】</text>\n'
      '<text x="350" y="135" fill="#5b6570" font-size="10" text-anchor="middle">必须分池 · 禁止混用 → 制度信誉</text>')
svg_blocks.append(fig("逻辑图 L9｜化险/刺激分池纪律", l9, h=150))

# L10 政策协同
svg_blocks.append(fig("逻辑图 L10｜政策协同：体检结果嵌入收储/抵押/更新",
    flow([("体检结果", "结论分级"), ("收储定价", "3000 亿再贷款"), ("抵押评估", "银行联动"), ("城市更新", "无体检不更新")])))

# L11 三情景
l11 = ('<rect x="270" y="20" width="160" height="40" rx="6" fill="#14304f"/>\n'
       '<text x="350" y="45" fill="#fff" font-size="11" text-anchor="middle">情景判定</text>\n'
       '<line x1="330" y1="60" x2="180" y2="85" stroke="#8a8f99"/>\n'
       '<line x1="370" y1="60" x2="370" y2="85" stroke="#8a8f99"/>\n'
       '<line x1="400" y1="60" x2="540" y2="85" stroke="#8a8f99"/>\n'
       '<rect x="60" y="85" width="240" height="55" rx="6" fill="#23486e"/>\n'
       '<text x="180" y="108" fill="#fff" font-size="10" text-anchor="middle">基准 ≈50%【测算】</text>\n'
       '<text x="180" y="126" fill="#cfe0f2" font-size="9" text-anchor="middle">2026-2028 制度化·政府买单主流</text>\n'
       '<rect x="250" y="85" width="240" height="55" rx="6" fill="#1d6f42"/>\n'
       '<text x="370" y="108" fill="#fff" font-size="10" text-anchor="middle">乐观 ≈25%</text>\n'
       '<text x="370" y="126" fill="#d6ecd6" font-size="9" text-anchor="middle">安全公共账户·改造对冲</text>\n'
       '<rect x="440" y="85" width="240" height="55" rx="6" fill="#a33"/>\n'
       '<text x="560" y="108" fill="#fff" font-size="10" text-anchor="middle">悲观 ≈25%</text>\n'
       '<text x="560" y="126" fill="#f6d6d6" font-size="9" text-anchor="middle">出让金↓·续筹·舆情重演</text>')
svg_blocks.append(fig("逻辑图 L11｜三情景分支", l11, h=160))

# L12 验证裁决流程
svg_blocks.append(fig("逻辑图 L12｜郑州 2 批次验证裁决流程",
    flow([("郑州 2 批次体检", "覆盖率/不合格率"), ("30年+ 房源观察", "折价+挂牌周期"), ("显著变化?", "折价/挂牌分化"), ("裁决", "定价变量成立/降级")])))

insert_marker = "## 五、Key Takeaways（≤8 条）"
annex_section = ("## 四·补 逻辑图集（12 张）\n\n"
                 "逻辑图与详细逻辑卡 D1-D15 对应，供快速浏览机制链条。\n\n"
                 + "\n\n".join(svg_blocks)
                 + "\n\n---\n\n")
assert insert_marker in text
text = text.replace(insert_marker, annex_section + insert_marker, 1)
io.open(p, "w", encoding="utf-8").write(text)
print("svg blocks inserted:", len(svg_blocks))
