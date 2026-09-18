# BK 素材交叉核对报告（P0.3）

> 生成：scripts/verify-bk-sources.mjs · 2026-08-22

- 基线：包内 raw-profiles 33 份（BK-002~034）
- 政研通 zip 对比：0 identical / 31 field-diff / 0 external-only
- feishu 散件对比：0 identical / 16 field-diff / 0 external-only

> 结论：identical 无需处理；field-diff 的人工裁决（以包内 raw 为准，差异记录在案）；external-only 记录待 P3 线上同步。

## M-02 政研通 zip（/root/.openclaw/workspace/98wiki/feishu/20260810_政研通专家Profile_BK1-31.zip）

| BK | 结果 | 差异字段 | 说明 |
|---|---|---|---|
| BK-024 | field-diff | classification, emm, initials | 定力董座/定力董座_专家Profile_BK-024.json |
| BK-003 | field-diff | classification, initials | 老规划/老规划_专家Profile_BK-003.json |
| BK-008 | field-diff | classification, initials | 分化哨兵/分化哨兵_专家Profile_BK-008.json |
| BK-005 | field-diff | classification, initials | 长牛博士/长牛博士_专家Profile_BK-005.json |
| BK-029 | field-diff | classification, emm, initials | 利率司南/利率司南_专家Profile_BK-029.json |
| BK-027 | field-diff | classification, emm, initials | 稳心会长/稳心会长_专家Profile_BK-027.json |
| BK-013 | field-diff | classification, initials | 批判教授/批判教授_专家Profile_BK-013.json |
| BK-026 | field-diff | classification, emm, initials | 新范式园丁/新范式园丁_专家Profile_BK-026.json |
| BK-012 | field-diff | classification, initials | 政策翻译官/政策翻译官_专家Profile_BK-012.json |
| BK-011 | field-diff | classification, initials | 转轨师傅/转轨师傅_专家Profile_BK-011.json |
| BK-010 | field-diff | classification, initials | 能级参谋/能级参谋_专家Profile_BK-010.json |
| BK-002 | field-diff | classification, initials | 制度君/制度君_专家Profile_BK-002.json |
| BK-007 | field-diff | classification, initials | 张明/张明_专家Profile_BK-007.json |
| BK-019 | field-diff | classification, initials | 海外瞭望员/海外瞭望员_专家Profile_BK-019.json |
| BK-006 | field-diff | classification, initials | 存量猎手/存量猎手_专家Profile_BK-006.json |
| BK-030 | field-diff | classification, emm, initials | 拓界理事/拓界理事_专家Profile_BK-030.json |
| BK-018 | field-diff | classification, initials | 统筹会长/统筹会长_专家Profile_BK-018.json |
| BK-032 | field-diff | classification, initials | 财政掌柜/财政掌柜_专家Profile_BK-032.json |
| BK-014 | field-diff | classification, initials | 数据司长/数据司长_专家Profile_BK-014.json |
| BK-021 | field-diff | classification, initials | 运营管家/运营管家_专家Profile_BK-021.json |
| BK-009 | field-diff | classification, initials | 土地账房/土地账房_专家Profile_BK-009.json |
| BK-028 | field-diff | classification, emm, initials | 好房子工匠/好房子工匠_专家Profile_BK-028.json |
| BK-023 | field-diff | classification, initials | 保价局长/保价局长_专家Profile_BK-023.json |
| BK-004 | field-diff | classification, initials | 周期班长/周期班长_专家Profile_BK-004.json |
| BK-017 | field-diff | classification, initials | 错配外科/错配外科_专家Profile_BK-017.json |
| BK-020 | field-diff | classification, initials | 均衡教头/均衡教头_专家Profile_BK-020.json |
| BK-031 | field-diff | achievements, classification, emm, initials | 挂牌哨探/挂牌哨探_专家Profile_BK-031.json |
| BK-022 | field-diff | classification, initials | 慢牛主席/慢牛主席_专家Profile_BK-022.json |
| BK-015 | field-diff | classification, initials | 喇叭博士/喇叭博士_专家Profile_BK-015.json |
| BK-016 | field-diff | classification, initials | 结构老市长/结构老市长_专家Profile_BK-016.json |
| BK-025 | field-diff | classification, emm, initials | 百城台长/百城台长_专家Profile_BK-025.json |

## M-03 feishu 散件（/root/.openclaw/workspace/98wiki/feishu）

| BK | 结果 | 差异字段 | 说明 |
|---|---|---|---|
| BK-002 | field-diff | classification, initials, persona | 20260804_专家Profile_BK-002_制度派.json |
| BK-003 | field-diff | classification, initials, persona | 20260804_专家Profile_BK-003_规划政策派.json |
| BK-004 | field-diff | classification, initials, persona | 20260804_专家Profile_BK-004_宏观周期派.json |
| BK-005 | field-diff | classification, initials, persona | 20260804_专家Profile_BK-005_长周期派.json |
| BK-006 | field-diff | classification, initials, persona | 20260804_专家Profile_BK-006_存量循环派.json |
| BK-007 | field-diff | classification, initials, persona | 20260804_专家Profile_BK-007_债务金融派.json |
| BK-008 | field-diff | classification, initials, persona | 20260804_专家Profile_BK-008_人口分化派.json |
| BK-009 | field-diff | classification, initials, persona | 20260804_专家Profile_BK-009_财政土地派.json |
| BK-010 | field-diff | classification, initials, persona | 20260804_专家Profile_BK-010_城市能级派.json |
| BK-011 | field-diff | classification, initials, persona | 20260804_专家Profile_BK-011_存量转型派.json |
| BK-012 | field-diff | classification, initials, persona | 20260804_专家Profile_BK-012_政策解读派.json |
| BK-013 | field-diff | classification, initials, persona | 20260804_专家Profile_BK-013_学术批判派.json |
| BK-014 | field-diff | classification, initials, persona | 20260804_专家Profile_BK-014_金融数据派.json |
| BK-015 | field-diff | classification, initials, persona | 20260804_专家Profile_BK-015_底部分化派.json |
| BK-016 | field-diff | classification, initials, persona | 20260804_专家Profile_BK-016_制度设计派.json |
| BK-017 | field-diff | classification, initials, persona | 20260804_专家Profile_BK-017_空间错配派.json |
