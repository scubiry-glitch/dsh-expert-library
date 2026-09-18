# -*- coding: utf-8 -*-
"""生成《信用卡方法论落地台账模板.xlsx》——高迁移性 17 条的可填报落地模板包。"""
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter

OUT = "/root/zhijian/dsh-expert-library/jswork/expert-teams/archive/信用卡方法论提取/落地模板包/信用卡方法论落地台账模板.xlsx"

TITLE_FILL = PatternFill("solid", fgColor="1F4E79")
SRC_FILL = PatternFill("solid", fgColor="DDEBF7")
BOUND_FILL = PatternFill("solid", fgColor="FFF2CC")
HEAD_FILL = PatternFill("solid", fgColor="8EA9DB")
EX_FILL = PatternFill("solid", fgColor="D9D9D9")
THIN = Side(style="thin", color="999999")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical="top")
CENTER = Alignment(wrap_text=True, vertical="center", horizontal="center")
RED = Font(color="C00000", size=9)
NOTE_FONT = Font(size=9, color="7F7F7F")

wb = Workbook()

def init_sheet(ws, title, src, boundary, headers, widths, nrows=25):
    """首行标题 + 出处行 + 边界行 + 表头。返回数据起始行号(4)。"""
    ws.sheet_view.showGridLines = False
    ncol = len(headers)
    last = get_column_letter(ncol)
    ws.merge_cells(f"A1:{last}1")
    c = ws["A1"]; c.value = title
    c.font = Font(bold=True, size=14, color="FFFFFF"); c.fill = TITLE_FILL; c.alignment = CENTER
    ws.row_dimensions[1].height = 26
    ws.merge_cells(f"A2:{last}2")
    c = ws["A2"]; c.value = "方法出处：" + src
    c.font = Font(size=10, bold=True); c.fill = SRC_FILL; c.alignment = WRAP
    ws.row_dimensions[2].height = 30
    ws.merge_cells(f"A3:{last}3")
    c = ws["A3"]; c.value = "边界提醒：" + boundary
    c.font = Font(size=10, color="9C6500"); c.fill = BOUND_FILL; c.alignment = WRAP
    ws.row_dimensions[3].height = 34
    for j, (h, w) in enumerate(zip(headers, widths), 1):
        c = ws.cell(row=4, column=j, value=h)
        c.font = Font(bold=True, size=10); c.fill = HEAD_FILL; c.alignment = CENTER; c.border = BORDER
        ws.column_dimensions[get_column_letter(j)].width = w
    ws.row_dimensions[4].height = 30
    ws.freeze_panes = "A5"
    return 5

def style_data(ws, r0, ncol, nrows):
    for r in range(r0, r0 + nrows):
        for j in range(1, ncol + 1):
            c = ws.cell(row=r, column=j)
            c.border = BORDER
            if c.alignment.wrap_text is not True:
                c.alignment = WRAP

def example_note(ws, row, col, text="历史样本示例，须按本行数据重算"):
    c = ws.cell(row=row, column=col, value=text)
    c.font = RED; c.alignment = WRAP

def add_dv(ws, options, col, r0, r1, title="选择"):
    dv = DataValidation(type="list", formula1='"' + ",".join(options) + '"', allow_blank=True, showDropDown=False)
    dv.error = "请从下拉列表中选择"; dv.errorTitle = title
    ws.add_data_validation(dv)
    L = get_column_letter(col)
    dv.add(f"{L}{r0}:{L}{r1}")
    return dv

# ============ 1 总览 ============
ws = wb.active; ws.title = "总览"
r0 = init_sheet(ws, "信用卡方法论落地台账模板 · 总览（高迁移性 17 条）",
    "《信用卡方法论提取-专家分析报告.md》§6.4「对江苏银行当前工作的综合可迁移性排序——高（本月可动）」17 条，报告基于 A01–A17 阿蒙森洞察（2021–2022 历史样本）、B01–B07 行方业务材料、B05/B08 外部材料。",
    "全部数值示例均为材料时点的历史样本（B01=2025-03、B02=2024-05、B05=2018-06 等），只说明方法设计，不得当作现行经营事实引用。",
    ["序号", "统一编号", "方法名", "出处（材料+页码）", "适用场景", "对应工作表"],
    [6, 12, 34, 34, 40, 22], nrows=20)
rows = [
    (1, "B-01-01", "早偿率阈值与商户清退分层法", "B01 幻灯片 3、6；B07 幻灯片 17", "有商户/渠道返佣的分期业务，早偿风险管控", "早偿监测台账"),
    (2, "B-01-02", "返佣封顶与差额底线法", "B01 幻灯片 3、5", "所有「返佣/贴息换业务」模式的收益底线管控", "返佣管控协议要点核查表"),
    (3, "B-01-03", "追回率挂绩效负分法（考核绑定）", "B01 幻灯片 4、7", "直销/外包队伍的损失内化考核", "返佣管控协议要点核查表"),
    (4, "B-07-01", "高返下的早偿监测（mob3/6/12）", "B07 幻灯片 9", "任何「前置返佣+后期分期」资产的批量监测", "早偿监测台账"),
    (5, "B-07-02", "返佣摊销与追回联动法", "B07 幻灯片 15；B01 幻灯片 6、7", "佣金前置、还款后置业务的损失当期显性化", "返佣管控协议要点核查表"),
    (6, "B-02-01", "追回目标三段拆解法", "B02 幻灯片 10、11、12", "不良稳定期存量资产的催收目标管理", "催收三段降损目标表"),
    (7, "B-05-12", "收入结构解构＋口径还原法", "B05（天风证券 2018-06）PDF页码 6–9", "跨机构/跨口径比较前的口径统一", "口径对照表"),
    (8, "B-06-01", "分期核心指标分解法", "B06 幻灯片（第二层）", "分期 KPI 模板：结果指标与过程指标一起考核", "（并入分期定价实测记录的读数口径）"),
    (9, "B-06-04", "差异化定价 A/B 实测与客群切分法", "B06 幻灯片 30（举措5）", "先测再推的定价标准动作（4 周测试期）", "分期定价实测记录"),
    (10, "A01-03", "无对照组活动增量评估（PSM-DID／简化平行世界）", "A01 阿蒙森洞察-2022年第1期 PDF页码 9–10", "全量投放、无随机对照的活动效果评估", "活动立项五栏表"),
    (11, "A01-04", "活动定位→评价指标匹配（活动四分类）", "A01 PDF页码 8–9；A05 PDF页码 7；A06 PDF页码 8；A12 PDF页码 9", "活动立项时锁定主指标、防口径错配", "活动立项五栏表"),
    (12, "A06-01", "AB 双指标判读（相对提升＋结构占比）", "A06 PDF页码 4–7；A02 PDF页码 8–11", "权益/头图/话术测试，防单一指标自证成功", "活动立项五栏表"),
    (13, "A17-01", "意愿×营销响应四象限资源分配法", "A17 阿蒙森洞察报告-2021年第9期 PDF页码 9–10", "电销/外呼资源有限时的投放取舍", "四象限资源分配表"),
    (14, "B-05-13", "分期实际年化利率现金流测算法", "B05 PDF页码 9", "分期定价、以量补价测算、竞对价格对标", "阈值验算表"),
    (15, "B-05-15", "人均指标分母修正法", "B05 PDF页码 12–17", "报人均指标必须同时报分母", "口径对照表"),
    (16, "B-08-19", "必由之路＋资金通道预警", "B08（平台商务材料 2018-05）", "外部平台合作的定位判断（与「规则留行内」绑定）", "（使用纪律见 README，无独立台账）"),
    (17, "B-08-25", "合作方尽调七条（反向用尺）", "B08", "把「合作方能投入的资源」变成条款要求", "（使用纪律见 README，无独立台账）"),
]
for i, row in enumerate(rows):
    for j, v in enumerate(row, 1):
        c = ws.cell(row=r0 + i, column=j, value=v)
style_data(ws, r0, 6, len(rows) + 3)
note_row = r0 + len(rows) + 1
ws.merge_cells(start_row=note_row, start_column=1, end_row=note_row, end_column=6)
c = ws.cell(row=note_row, column=1)
c.value = ("使用说明：① 每个工作表首两行为方法出处与边界提醒，填报前必读；② 灰色示例行均为历史样本，"
           "须按本行数据重算后另行填报；③ 下拉列点击单元格出现选项；④ 公式列（分级判定/象限判定/IRR）自动计算，请勿手工覆盖；"
           "⑤ 三条硬纪律详见 README.md：历史样本不当现行事实 / 阈值须本行重算 / 正负分同表。")
c.font = Font(size=10); c.alignment = WRAP
ws.row_dimensions[note_row].height = 46

# ============ 2 活动立项五栏表 ============
ws = wb.create_sheet("活动立项五栏表")
r0 = init_sheet(ws, "活动立项五栏表（立项即填，无栏不批）",
    "A01-03《阿蒙森洞察-2022年第1期》PDF页码 9–10；A01-04 同期 PDF页码 8–9（另见 A05 PDF页码7、A06 PDF页码8、A12 PDF页码9）。",
    "A01-03 边界：外部冲击对活动组与全量客户影响不同质时，简化平行世界法会高估/低估增量；人群未拉齐则规模不可比。A01-04 边界：定位不清时任何指标都「看起来有提升」，用副指标表扬活动属口径错配。",
    ["活动名称", "定位四分类（下拉）", "主指标（由定位决定）", "口径定义（渗透率/增量金额/ROI 三条必填）",
     "对照组构造方式（平行世界/随机分流，下拉）", "对照组说明", "迭代结论", "备注"],
    [20, 14, 18, 40, 20, 30, 26, 18], nrows=20)
hdr_map = {"品牌型": "活动渗透率＋增量交易金额", "促活型": "实动率", "拉交易型": "增量交易金额", "拉分期型": "分期渗透率＋分期交易额"}
ex = ["「618大促」历史样本示例，须按本行数据重算", "拉交易型", "增量交易金额",
      "渗透率=参与活动激活流通用户÷平均累计激活流通用户；增量交易金额=活动组大促期间交易金额−对照组同期（拉齐人数）；ROI=增量交易金额÷活动成本",
      "简化平行世界", "取参与客户活动前1个月自然表现＋全量客户两月户均差作为自然时间效应；对照组与活动组人数拉齐",
      "示例行：ROI=1 时成本:增量交易金额=1:43，活动可持续（历史样本）", ""]
for j, v in enumerate(ex, 1):
    c = ws.cell(row=r0, column=j, value=v)
    c.fill = EX_FILL
example_note(ws, r0, 7)
add_dv(ws, ["品牌型", "促活型", "拉交易型", "拉分期型"], 2, r0, r0 + 19, "定位四分类")
add_dv(ws, ["平行世界（简化法）", "随机分流（A/B）", "PSM-DID（科学版）"], 5, r0, r0 + 19, "对照组构造")
style_data(ws, r0, 8, 20)

# ============ 3 早偿监测台账 ============
ws = wb.create_sheet("早偿监测台账")
r0 = init_sheet(ws, "早偿监测台账（mob3/mob6/mob12 + 分级自动判定）",
    "B-07-01《汽车分期业务经营分析会》幻灯片 9；B-01-01 B01 幻灯片 3、6，B07 幻灯片 17。",
    "B-07-01 边界：新放款样本表现期不足，不能与成熟样本直接比大小，否则会低估真实早偿风险。B-01-01 边界：清退是硬动作，须配套「30 分钟内可替换的商户清单」；阈值需按品种重估（汽车/装修分期早偿规律不同）。",
    ["商户", "批次", "放款月", "mob3 早偿率", "mob6 早偿率", "mob12 早偿率", "分级判定（公式自动）", "本月动作", "备注"],
    [16, 12, 10, 11, 11, 11, 22, 26, 24], nrows=25)
D0 = r0 + 1  # first fillable row
ex = ["XX车商（历史样本示例，须按本行数据重算）", "2023H1", "2023-05", 0.061, 0.068, 0.0752, None, "换签新版协议（历史样本动作）", "历史样本示例，须本行重算"]
for j, v in enumerate(ex, 1):
    c = ws.cell(row=r0, column=j, value=v)
    c.fill = EX_FILL
example_note(ws, r0, 9)
for r in range(D0, r0 + 25):
    ws.cell(row=r, column=7).value = (
        f'=IF(F{r}="","",IF(F{r}<=0.05,"≤5% 继续合作",IF(F{r}<=0.1,"5%-10% 换签新版协议",">10% 清退")))')
add_dv(ws, ["继续合作", "换签新版协议", "暂停业务/清退", "列入替换清单"], 8, r0, r0 + 24, "本月动作")
for col in "DEF":
    for r in range(r0, r0 + 25):
        ws[f"{col}{r}"].number_format = "0.00%"
style_data(ws, r0, 9, 25)
nr = r0 + 26
ws.merge_cells(start_row=nr, start_column=1, end_row=nr, end_column=9)
c = ws.cell(row=nr, column=1)
c.value = ("判定规则（B-01-01）：mob12 早偿率 ≤5% 继续合作；(5%,10%] 换签新版协议；>10% 清退。"
           "阈值来源为财务测算（放款后一年早偿 11–12 笔/100 笔为净利润正负临界，再压一档得 6%），本行须重算，不得直接沿用 5%/10%。")
c.font = Font(size=10); c.alignment = WRAP; c.fill = BOUND_FILL

# ============ 4 返佣管控协议要点核查表 ============
ws = wb.create_sheet("返佣管控协议要点核查表")
r0 = init_sheet(ws, "返佣管控协议要点核查表（逐商户/逐协议核查）",
    "B-01-02 B01 幻灯片 3、5；B-07-02 B07 幻灯片 15，B01 幻灯片 6、7；B-01-03 B01 幻灯片 4、7。",
    "B-01-02 边界：只压返佣不动对客费率会丢规模，「封顶＋差额底线」两条必须一起下，否则分行会用降价绕开。B-07-02 边界：追回依赖协议换签进度，换签不到位则机制空转。B-01-03 边界：负分必须与正分同表同权重，只挂负分会让队伍退出该品种。",
    ["商户/渠道", "返佣合计封顶值", "对客费率−返佣差额底线值", "摊销方式",
     "追回三条款是否入协议（下拉）", "正负分同表是否配置（下拉）", "核查结论", "材料出处", "备注"],
    [16, 14, 18, 26, 20, 20, 14, 20, 24], nrows=25)
ex = ["XX经销商（历史样本示例，须按本行数据重算）", "≤14%（基础+阶梯+渠道合计）", "≥10%",
      "基础/阶梯佣金当月计提、按业务期数等额分摊；提前还款当月未分摊额度一次性摊销；渠道佣金不予计提摊销",
      "是", "是", "通过", "B01 幻3、5；B07 幻15", "历史样本示例，须本行重算"]
for j, v in enumerate(ex, 1):
    ws.cell(row=r0, column=j, value=v).fill = EX_FILL
example_note(ws, r0, 9)
add_dv(ws, ["是", "否", "部分（须补签）"], 5, r0, r0 + 24, "追回三条款")
add_dv(ws, ["是", "否"], 6, r0, r0 + 24, "正负分同表")
style_data(ws, r0, 9, 25)
nr = r0 + 26
ws.merge_cells(start_row=nr, start_column=1, end_row=nr, end_column=9)
c = ws.cell(row=nr, column=1)
c.value = ("核查要点：① 追回三条款＝结算前撤销/提前还款/客诉的业务不予支付佣金；已付佣金发生提前还款由商户退回或在下次结算抵扣；"
           "② 系统留痕：佣金抵扣功能须建立关联抵扣关系，追回记录有迹可查；③ 负分口径：追回比例≤50% 时按提前还款金额 -1分/万元，当期与半年各计50%；"
           "④ 正分对照须同表配置（如卡e贷新增 0.2分/万元/户等，历史样本，须本行重定）。封顶14%/差额10% 为 B01 历史样本值，本行须重算。")
c.font = Font(size=10); c.alignment = WRAP; c.fill = BOUND_FILL

# ============ 5 分期定价实测记录 ============
ws = wb.create_sheet("分期定价实测记录")
r0 = init_sheet(ws, "分期定价实测记录（4 周测试期 + 四件套周读数）",
    "B-06-04 B06 幻灯片 30（举措5）；读数口径对应 B-06-01 分期核心指标分解法。",
    "B-06-04 边界：结论依赖测试期与客群结构，跨品种不可直接搬用；「以价补量」有价格底线，须先定最低定价与最低差额（对应 B-01-02）。",
    ["客群切分", "最低定价", "最低差额（对客费率−返佣）", "测试期起止（4周）", "周次",
     "户渗透率", "分期交易额（环比）", "户均分期金额", "分期手续费收入（环比）", "固化结论", "备注"],
    [14, 10, 18, 18, 8, 11, 14, 13, 16, 24, 22], nrows=20)
ex = ["首分客户（历史样本示例，须按本行数据重算）", "按行内测算填列", "≥10%（历史样本口径）", "6.10–7.7（历史样本）",
      "W1", 0.0361, None, 2757, None, "", ""]
ex2 = ["复分客户（历史样本示例）", "", "", "", "W4", 0.0375, "+12.8%", 2948, "+7.3%", "固化为例行差异化定价活动（历史样本结论）", "历史样本示例，须本行重算"]
for j, v in enumerate(ex, 1):
    ws.cell(row=r0, column=j, value=v).fill = EX_FILL
for j, v in enumerate(ex2, 1):
    ws.cell(row=r0 + 1, column=j, value=v).fill = EX_FILL
example_note(ws, r0, 11); example_note(ws, r0 + 1, 11)
add_dv(ws, ["首分客户", "复分客户"], 1, r0, r0 + 19, "客群切分")
add_dv(ws, ["W1", "W2", "W3", "W4"], 5, r0, r0 + 19, "周次")
style_data(ws, r0, 11, 20)
ws["F" + str(r0)].number_format = "0.00%"
ws["F" + str(r0 + 1)].number_format = "0.00%"

# ============ 6 四象限资源分配表 ============
ws = wb.create_sheet("四象限资源分配表")
r0 = init_sheet(ws, "四象限资源分配表（自然激活意愿 × 营销响应）",
    "A17-01《阿蒙森洞察报告-2021年第9期》PDF页码 9–10。",
    "A17-01 边界：该分类是建模输出而非客户固有属性，模型漂移须重检；对①④象限「不做营销」是主动放弃触达，须确认合规与客户体验可接受；第③类「减少获客规模」冲击发卡量 KPI，需管理层级目标一致。前提是把「减少打扰」写入考核，否则执行不下去。",
    ["客群分层", "意愿分（自然激活）", "响应分（营销敏感）", "象限判定（公式自动）", "策略（下拉）", "合规确认（是/否）", "复核人", "备注"],
    [18, 12, 12, 26, 22, 14, 10, 24], nrows=25)
D0 = r0 + 1
ex = ["示例客群（历史样本示例，须按本行数据重算）", 0.75, 0.30, None, "维持观察", "是", "", ""]
for j, v in enumerate(ex, 1):
    ws.cell(row=r0, column=j, value=v).fill = EX_FILL
example_note(ws, r0, 8)
for r in range(D0, r0 + 25):
    ws.cell(row=r, column=4).value = (
        f'=IF(OR(B{r}="",C{r}=""),"",'
        f'IF(AND(B{r}>=0.5,C{r}>=0.5),"①优质用户（自然激活，勿扰）",'
        f'IF(AND(B{r}<0.5,C{r}>=0.5),"②摇摆用户（营销敏感，加投）",'
        f'IF(AND(B{r}>=0.5,C{r}<0.5),"④睡眠用户（对营销反感，停止打扰）","③无动于衷（获客资源降级）"))))')
add_dv(ws, ["加投（强坐席/提前介入）", "维持观察", "降级（减少获客投放）", "停止打扰"], 5, r0, r0 + 24, "策略")
add_dv(ws, ["是", "否"], 6, r0, r0 + 24, "合规确认")
style_data(ws, r0, 8, 25)
nr = r0 + 26
ws.merge_cells(start_row=nr, start_column=1, end_row=nr, end_column=8)
c = ws.cell(row=nr, column=1)
c.value = ("四象限规则（A17-01）：①优质用户—无论是否营销都自然激活，尽量不做促激活营销（降成本、降打扰）；②摇摆用户—有营销才激活，"
           "投入更多营销资源；③无动于衷—获客资源降级；④睡眠用户—对营销反感，停止打扰。象限判定阈值 0.5 仅为占位，本行须用模型分数分布重定。")
c.font = Font(size=10); c.alignment = WRAP; c.fill = BOUND_FILL

# ============ 7 催收三段降损目标表 ============
ws = wb.create_sheet("催收三段降损目标表")
r0 = init_sheet(ws, "催收三段降损目标表（入催→逾期→不良）",
    "B-02-01《2024年5月复盘》幻灯片 10、11、12。",
    "B-02-01 边界：协商还款政策放宽会形成「再逾期」（前期协商还款再逾期金额已超过首次进入不良金额），必须配套再逾期监测与回收上限，否则是把风险后移。",
    ["催收段位", "降损目标（金额）", "手段", "测算（变化率×剩余月份）",
     "再逾期监测口径", "回收上限", "备注"],
    [12, 18, 40, 30, 30, 14, 22], nrows=6)
ex_rows = [
    ["入催管理（历史样本示例，须按本行数据重算）", "降低进入逾期金额 1.6 亿元", "优化模型策略、M0 主动感知触达、智能外呼/人工回访/短信精细化",
     "月均入催额 5.7 亿降 0.2 亿 × 剩余 8 个月 = 1.6 亿", "（填本行口径）", "（填本行上限）", "历史样本示例，须本行重算"],
    ["逾期催收（历史样本示例）", "降低进入不良金额 1.6 亿元", "提高自催、协商还款政策放宽（本金分期）、分行属地化催收（高风险地区上门）",
     "月均回款 3.14 亿提 0.2 亿 × 8 个月 = 1.6 亿", "（填本行口径）", "（填本行上限）", "历史样本示例，须本行重算"],
    ["不良催收（历史样本示例）", "降低核销处置金额 0.93 亿元", "扩大诉调规模、丰富信息修复与资产信息采集；诉调/非诉调份额 25/75 → 75/25",
     "诉调回款 2,330 万提至 2.8 亿", "（填本行口径）", "（填本行上限）", "历史样本示例，须本行重算"],
]
for i, row in enumerate(ex_rows):
    for j, v in enumerate(row, 1):
        ws.cell(row=r0 + i, column=j, value=v).fill = EX_FILL
    example_note(ws, r0 + i, 7)
add_dv(ws, ["入催管理", "逾期催收", "不良催收"], 1, r0, r0 + 5, "催收段位")
style_data(ws, r0, 7, 6)
nr = r0 + 7
ws.merge_cells(start_row=nr, start_column=1, end_row=nr, end_column=7)
c = ws.cell(row=nr, column=1)
c.value = ("方法：用「变化率×剩余月份」把年度大目标拆成月度增降幅；目标层层串联（历史样本：22.22 亿 → 18.09 亿 → 15.09 亿）。"
           "协商还款放宽必须同时设再逾期监测与回收上限（bank-09 建议 2）。")
c.font = Font(size=10); c.alignment = WRAP; c.fill = BOUND_FILL

# ============ 8 口径对照表 ============
ws = wb.create_sheet("口径对照表")
r0 = init_sheet(ws, "口径对照表（任何比较先过此表）",
    "B-05-12 天风证券 B05 PDF页码 6–9（收入结构解构＋口径还原）；B-05-15 同材料 PDF页码 12–17（人均指标分母修正）。",
    "B-05-12 边界：不做科目-实质映射直接比「利息收入占比」，会把同一经济实质算成两类收入、结论反向；口径切换年份前后不可比（历史样本：招行 2015 断点）。B-05-15 边界：分母选择直接决定结论量级，换分母必须明示，否则同一事实可得出「渗透率极低」或「接近饱和」两种结论。",
    ["指标名", "会计科目", "经济实质", "本行口径", "外部口径", "差异说明", "分母口径（必填）"],
    [20, 18, 22, 26, 26, 30, 28], nrows=20)
ex = ["分期手续费收入占比（历史样本示例，须按本行数据重算）", "中间业务收入（手续费）", "利息收入（分期手续费实质是利息）",
      "（填本行报表科目）", "1H16 银联数据客户银行：分期手续费 28%，还原后实际利息收入占比约 70%",
      "科目归类不同导致占比差异；还原后才可与美国主要银行对照", "（报人均必报分母：如「20-59 岁城镇居民」而非全国人口，历史样本）"]
for j, v in enumerate(ex, 1):
    ws.cell(row=r0, column=j, value=v).fill = EX_FILL
example_note(ws, r0, 7)
style_data(ws, r0, 7, 20)
nr = r0 + 21
ws.merge_cells(start_row=nr, start_column=1, end_row=nr, end_column=7)
c = ws.cell(row=nr, column=1)
c.value = ("三步法（B-05-12）：① 建「会计科目↔经济实质」映射表（显性/隐性收入分列）→ ② 在披露口径上做还原调整 → ③ 用还原后口径对标。"
           "另注意：分期＝利息；发卡量≠流通卡≠流通户≠活卡；实动卡均交易无公开定义。跨行比较前必须统一机构范围与科目口径。")
c.font = Font(size=10); c.alignment = WRAP; c.fill = BOUND_FILL

# ============ 9 阈值验算表 ============
ws = wb.create_sheet("阈值验算表")
r0 = init_sheet(ws, "阈值验算表（名义费率 → 实际年化 IRR）",
    "B-05-13 天风证券 B05 PDF页码 9（「分期收入，筑梦新蓝海」节）。",
    "B-05-13 边界：一次性还本付息或先息后本产品不适用同一公式；含服务费/权益费须全部计入现金流否则低估；该测算给出的是产品定价口径，不能直接等同于客户实际承担的综合年化成本（还需计入逾期费用等）。14.26% 为历史样本，本行须重算。",
    ["行次", "本金（元）", "月费率（名义）", "期数（月）", "每期还款额（公式）", "每期手续费（公式）",
     "实际年化 IRR（公式）", "名义年化（公式）", "差额（实际−名义）", "安全边际取值", "备注"],
    [6, 12, 13, 11, 15, 15, 15, 13, 14, 14, 24], nrows=12)
heads = ["行次", "本金（元）", "月费率（名义）", "期数（月）", "每期还款额（公式）", "每期手续费（公式）",
         "实际年化 IRR（公式）", "名义年化（公式）", "差额（实际−名义）", "安全边际取值", "备注"]
# example row (pre-filled, gray)
er = r0
vals = ["示例", 6000, 0.007, 6]
for j, v in enumerate(vals, 2):
    ws.cell(row=er, column=j, value=v).fill = EX_FILL
for r in range(r0, r0 + 10):
    ws.cell(row=r, column=1, value=r - r0 + 1)
    ws.cell(row=r, column=5).value = f'=IF(OR(B{r}="",D{r}=""),"",B{r}/D{r}+B{r}*C{r})'
    ws.cell(row=r, column=6).value = f'=IF(B{r}="","",B{r}*C{r})'
    ws.cell(row=r, column=7).value = (
        f'=IF(OR(B{r}="",E{r}=""),"",IFERROR((RATE(D{r},E{r},-B{r})*12),"需检查输入"))')
    ws.cell(row=r, column=8).value = f'=IF(C{r}="","",C{r}*12)'
    ws.cell(row=r, column=9).value = f'=IF(OR(G{r}="",H{r}=""),"",G{r}-H{r})'
    ws.cell(row=r, column=10).value = "（填写本行要求的安全边际档位）"
    for col in (3, 7, 8, 9):
        ws.cell(row=r, column=col).number_format = "0.00%"
    ws.cell(row=r, column=10).font = NOTE_FONT
example_note(ws, er, 11)
style_data(ws, r0, 11, 10)
nr = r0 + 11
ws.merge_cells(start_row=nr, start_column=1, end_row=nr, end_column=11)
c = ws.cell(row=nr, column=1)
c.value = ("方法（B-05-13）：名义「每期费率」按分期总额收取，但本金逐期偿还，故名义费率严重低估真实资金成本。四要素 pv/pmt/r/t，解出每期利率 r 后 ×12 得实际年化。"
           "历史样本：6000 元 / 0.7%/期 / 6 期 → 实际年化 14.26%（示例行公式应复算出同值，可作模板自检）。安全边际取值须按本行资金成本、风险成本重定，不得沿用历史经验值。")
c.font = Font(size=10); c.alignment = WRAP; c.fill = BOUND_FILL

import os
os.makedirs(os.path.dirname(OUT), exist_ok=True)
wb.save(OUT)
print("saved:", OUT)
print("sheets:", wb.sheetnames)
