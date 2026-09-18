# 交付 INDEX · 房地产信贷新政对江苏银行零售信贷部的影响分析（99wiki 研究包）

> ## ⭐ 当前版本：v2 终版（2026-08-30，双 gate PASS + 队长独立复核通过）
>
> 版本目录：`研报交付_20260829_苏银零售新政影响/v2/`（partB + partC 同目录）
>
> | 项 | 路径 | sha256 | Gate |
> |---|---|---|---|
> | Part B 主文 HTML | `v2/partB/主文.html` | `c2527e84539df8b89e8f2ff2b27f866a34d4127ee168c188bcf23aff117b77e0` | PASS 14/14 |
> | Part B 主文 PDF | `v2/partB/主文.pdf` | `05a0d53061f45c38b5d2761ac7b64aecb92835933dd7e9e7a3836a122d011fa4` | 14 页 A4 · 正文 13,815 字 · 图表 1-28（P09=信用卡专项与周度轨迹专属页） |
> | Part C 附件 HTML | `v2/partC/逻辑附件.html` | `aaccaa1a5a81ff9daaed6091675f83b2bddad061b150c82ead845ac9ff80eaa1` | PASS 17/17 |
> | Part C 附件 PDF | `v2/partC/逻辑附件.pdf` | `2f596d3889ea2d2028f7f29a1441b507dc52cb12ec9315e7cf25dd37d5a82fe2` | 19 页 A4 · 15 卡=15 图 |
> | 内容底稿 v2 | `内容底稿_苏银零售新政影响_v2.md` | — | 唯一内容源 |
>
> **v2 实质修订**：①部门正名**零售信贷部**；②双口径纪律（对外消费贷含网贷不作观点；管理口径房贷 45.1% 自营第一、网贷 42.3% 净收入占比 79%）；③期间统一 2026Q2（消费贷对外 3,261.14 亿、经营贷 545.41 亿）；④双记账（真实 EVA 仅网贷 +0.91% 为正，房贷 -0.08%、信用卡 -2.85%）；⑤信用卡专项（YTD -66.9 亿、还原不良 4.37% 上行、定位切换）；⑥周度轨迹（消费贷 7 月回吐 -82.7 亿、房贷 8 月自报预测 0）；⑦目标情景（中性 700 亿需 H2 +262 亿）；⑧政研通·贝壳量价证据。
>
> **数据边界**：内部驾驶舱/计财 EVA/情景/周度数据标注"99wiki 内部资料·敏感数据不外发"；**v2 已按用户拍板以内部版直接替换外链（2026-08-30），链接受众限行内/授权人员**：
>
> ⚠️ 下方 v1 记录中"消费贷是第一大盘"的结构观点已作废；v1 外链仍指向旧口径内容，待处置。

---

# 以下为 v1 交付记录（已被 v2 取代）

**版本目录**：`/root/zhijian/dsh-expert-library/work/研报交付_20260829_苏银零售新政影响/`
**投递状态**：**PASS**（Part B 与 Part C 双 gate 通过，构成完整研究包）
**成稿时间**：2026-08-29 ｜ 页脚署名：98wiki ｜ 智见 / 行业研究报告

## 交付清单（文件选择硬门）

| 项 | 路径 | sha256 | 状态 |
|---|---|---|---|
| Part B 主文 HTML | `partB/主文.html` | `d79ccbcb58ebb63d1a04287a1ac79016255ec66fe342aa628edc17abc34c8240` | gate PASS（13/13） |
| Part B 主文 PDF | `partB/主文.pdf` | `7765a056e4691cba4b86aa4d5cbed41322ac33fcc5adeb57de5b894b83e5cb80` | 12 页 A4，weasyprint 69.0 @ 2026-08-29T21:36:40 |
| Part B gate | `partB/gate_partB.json` | — | PASS（正文 10,736 字；21 视觉对象；nested_p=0） |
| Part B 验收器（可复跑） | `partB/gate_partB.py` | — | 重渲染→重截图→重算哈希→DOM 检查 |
| Part C 附件 HTML | `partC/逻辑附件.html` | `79a20cc4ff10216a22affe226273f19d95d103459e36b1abb6cbb94885772fa7` | gate PASS（16/16） |
| Part C 附件 PDF | `partC/逻辑附件.pdf` | `915d101b35f0cde2edd0f6794a05dfb28dc9fab7b190353651dbb238aadb0bcd` | 16 页 A4 |
| Part C gate | `partC/gate_partC.json` | — | PASS（logic-annex-v2；速览卡15=详细卡15=SVG图15=白话15） |
| Part C 验收器（可复跑） | `partC/gate_partC.py` | — | 改造自 gate_partB.py |
| 内容底稿 | `内容底稿_苏银零售新政影响_v1.md` | — | 唯一内容源（两 Part 均由此渲染） |
| 截图存档 | `partB/shots/`、`partC/shots/` | — | 宽屏+A4 首/中/末页 |

同版本目录：partB/ 与 partC/ 均位于 `研报交付_20260829_苏银零售新政影响/` 下 ✓

## 外网阅读（render_publish）

- Part B 主文：https://yy.meizu.life/render/苏银零售新政影响/suyinlingshou-partb-main-20260829.html
- Part C 逻辑附件：https://yy.meizu.life/render/苏银零售新政影响/suyinlingshou-partc-logic-20260829.html

## 数据与方法披露

- 银行数据：Wind（600919.SH），2026Q2 / 2025FY / 2026H1；零售贷款 1.0034 万亿、占比 36.22%、按揭 2,462.43 亿（约 8.9%，计算值）、净息差 1.64%、不良 0.81%、2026H1 营收 247.71 亿（+9.80%）/ 归母 112.94 亿（+7.99%）。
- 政策条款：以《意见》原文为准（央行、金监总局，2026-08-28）。
- 宏观与城市：Wind EDB（央行/国家统计局/南京市统计局，截至 2026-07）；南京新房 -1.8%、二手 -5.4%；全国按揭余额 36.29 万亿（-4.2%）、新发放利率 3.06%、销售 -11.8%、投资 -19.2%。
- 补数协议：个贷不良率、按揭不良率、零售 AUM、南京销售面积口径更新（Wind 未披露项，见 Part C 协议区块）。
- 方法：银行零售金融五层框架（战略/客群/产品/资产/风险）× 政策传导链；"测算/推断/计算值"徽标全稿保留，未虚构任何数字。
- 目检替代说明：渲染环境无图像输入通道，两 Part 均以 DOM 几何审计 + 截图存档替代人工目检（gate JSON `method_note` 已注明）。

## 附：政研通（zyt）通道补数核查记录（2026-08-29）

针对"能否用政研通 CLI 补齐补数协议缺口"的三路实查：

| 路径 | 结果 |
|---|---|
| ① 独立 zyt CLI（对照 wind-mcp-skill 的 CLI） | **不存在**：全盘检索 /usr/lib/node_modules、/usr/local、npm 全局包、~/.agents 等均无 zyt CLI；政研通仅经 provider 能力层（expert_provider_call）访问 |
| ② `realestate.market.trend`（城市行情能力） | **CAPABILITY_UNBOUND**：能力注册表存在但本部署无候选 provider 绑定 |
| ③ `realestate.indicators.batch`（{"city":"南京","queries":["SH_PRICE","SH_DEAL","HG_PRICE"]}） | 调用成功（zyt.indicators.batch-series）但**信封仍无数值 payload**——与本次点评全程 20+ 次调用（队长/5 专家/渲染代理）行为一致：通道通、数据体为空，审计日志 provider-audit.jsonl 50 条可查 |

**结论**：政研通本部署无法补充任何数值项。且补数协议 4 项缺口中，个贷不良率/按揭不良率/零售 AUM 属银行经营披露数据，本就不在政研通（房地产政策与城市指标库）覆盖范围内，正确补数源为 Wind 财务明细/公司中报/行内数据；政研通唯一可能覆盖的南京销售面积，待其数据体接通或南京市统计局口径更新后按协议触发。
