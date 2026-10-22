# bank-finance（银行金融领域包）v1.2.0

## v1.2.0 银行房产价值咨询报告

新增 `bank-property-value` 场景与 `skills/bank-property-value/SKILL.md`。使用用户提供的 Word 原文件作为不可变模板，`runtime/generate_bank_property_report.py` 查询贝壳小区/同小区在售房源与政研通 `SH_PRICE`，保留原 DOCX 的段落、表格和样式并输出 `.evidence.json`。城市、小区、建筑面积必填；银行、支行和评估公司可留空。当前账号 C 的贝壳成交记录接口不可用，政研通碧兴园小区序列为空，因此实测 Word 的数值仅是挂牌样本中位数形成的内部初步参考，不是正式抵押估价。

运行环境需 Python 3 与 `lxml`（见 `runtime/requirements.txt`），以及独立授权的 `beike` 与 `zyt` CLI。包内不含凭据。生成器只负责原生 DOCX 与证据回执；可点击下载链接由安装宿主的附件服务提供，需另行完成宿主接入。

6 位银行金融领域专家基线（BANK-09，零售金融/银行经营），由
`scripts/build-bank-pack.mjs` 确定性生成（复用 zhijian-realestate 的发射器与
模板/质量/方法构建器，仅数据不同）。

- `pack.json` + 各实体目录：`loadPackFromDir` 可装载的 DomainPackV2 布局。
- `source/raw-profiles/`：原始 Profile JSON，逐字节保留（sha-256 见
  `source/SOURCE-MANIFEST.json`）。
- `quality-policies/bank.quality.json`：硬门 `pii-redaction`（手机号/
  身份证/银行卡号/账号 脱敏）+ `quote-verbatim`（直引句逐字回验）+
  `historical-timestamp`（历史样本须带原时点）。
- `method-packs/`：retail-ops 操盘协议、framework-B 四段式，及 2026-09
  信用卡方法论提取任务沉淀的六个：threshold-calc 阈值测算、caliber-restore
  口径还原与对标、customer-tiering 客群分层工具箱、work-chains 六条成品
  工作链、incentive-governance 渠道与考核治理、partnership-diligence 外部
  合作尽调、tiered-pnl 三层损益、attribution 经营归因。
- `output-templates/`：framework-B 四段模板 + method-record 方法论七字段
  记录模板 + caliber-table 口径对照表模板。
- `output-templates/`：framework-B 四段模板 + method-record 方法论七字段
  记录模板。
- `skills/`：捆绑技能含 `bank-retail-finance-analysis`（五层分析）与
  `bank-activity-eval`（活动效果评估闭环）。
- 重建：`pnpm build && node scripts/build-bank-pack.mjs`；
  漂移检查：`node scripts/build-bank-pack.mjs --check`。
