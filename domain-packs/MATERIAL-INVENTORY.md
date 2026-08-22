# 专家素材盘点（Material Inventory）

> 依据：PIPELINE-100PLUS-EXPANSION-PLAN.md §2.3（P0.1）
> 日期：2026-08-23 · 用途：P0 收编的输入清单；标记每条素材的去重关系与落位建议。

## 总览

| 编号 | 素材 | 规模 | 位置 | 状态 | 落位 |
|---|---|---|---|---|---|
| M-01 | 房地产专家 Profile（BK-002~034） | 33 位 | `domain-packs/zhijian-realestate/source/raw-profiles/` | ✅ 已在包内（基线） | 不动；作为交叉核对基准 |
| M-02 | 政研通专家 Profile 压缩包 | 31 位（BK-002~032，json+md） | `/root/.openclaw/workspace/98wiki/feishu/20260810_政研通专家Profile_BK1-31.zip` | 📦 散落 | BK 集差异核对源（补 md/原始材料） |
| M-03 | BK Profile 散件（feishu） | 27 份（json/docx） | `/root/.openclaw/workspace/98wiki/feishu/20260804_专家Profile_BK-*.json/docx` | 📦 散落 | 同上，字段完整性交叉验证 |
| M-04 | 江苏银行银行专家（BANK-09 王一帆 / BANK-99 99） | 1+ 位 | `/root/.openclaw/workspace/99wiki/projects/专家体系/`、`media/outbound/`、`/root/.openclaw/workspace/skills/bank-99/` | 📦 散落 | **新建 bank-finance 领域包**（BANK 命名空间） |
| M-05 | 专家体系文档（BANK-99 调用说明、王一帆画像） | 文档 | `99wiki/projects/专家体系/` | 📦 散落 | 包文档与调用说明 |
| M-06 | 江苏银行信用卡任务归档 | 1 个归档 | `work/江苏银行信用卡提质增效_任务归档/` | ✅ 归档 | bank-finance 场景素材（credit-card-analysis） |
| M-07 | 会议纪要/逐字稿 | 多份 | `98wiki/feishu/*智能纪要/逐字稿*`、`meeting-notes/` | 📦 散落 | P2「人物转专家」素材源 |
| M-08 | 原始材料（文章/访谈/研报） | 部分 | `专家材料/`（skill 素材） | 📦 散落 | 挂 `knowledge/experts/<id>/` |
| M-09 | 线上专家库（pipeline api） | 100+ | `paper.morning.rocks/api/v1/expert-library`（线上） | 🔌 远程 | P3 同步脚本接入位（manifest 预留） |

## 明细

### M-01 房地产专家 Profile（已在包内，33 位）

- 来源目录：`domain-packs/zhijian-realestate/source/raw-profiles/`
- 命名：`<姓名>_专家Profile_BK-NNN.json`；pack 源 manifest：`source/SOURCE-MANIFEST.json`（sha-256 逐文件记录）
- 五大领域分布：宏观经济 9 / 政策制度 8 / 行业研究 8 / 城市发展 3 / 居住服务 4（BK-034 陈杰 2026-08-20 加入）
- 覆盖缺口（专家总表.md 标注）：14 位只有 json 没 md；BK-003 仇保兴、BK-002 廖俊平缺原始材料；BK-031 陶琦额外有 4 份专题数据卡

### M-02 政研通专家 Profile 压缩包（31 位）

- `20260810_政研通专家Profile_BK1-31.zip`：BK-002~032 共 31 个专家目录，每个含 `<姓名>_专家Profile_BK-NNN.json`（大多）与 `.md`（部分）
- 与 M-01 的关系：**同一 BK 集的另一版本快照** → 用于 P0.3 字段级 diff（sha-256 + 关键字段比对），检出差异即人工裁决
- 落位：核对通过后 md 版补充进 `source/library/`（缺失的 14 位优先）

### M-03 BK Profile 散件（feishu，27 份）

- `20260804_专家Profile_BK-00X_*.json/docx`（BK-002~017 区间，json+docx 混排）
- 与 M-01/M-02 的关系：更早快照 → 只做完整性交叉验证，不覆盖包内 raw

### M-04 银行专家（BANK-09 / BANK-99）

- `BANK-09_调用说明.md`（media/outbound + 99wiki/projects/专家体系）：王一帆，江苏银行零售信贷部负责人，操盘手视角；判断框架（政治账+经济账双算 / 样板复制优先 / 考核绑定执行 / 自主可控）；禁区（分行大量定制开发、外部平台拿银行当渠道底座、分行一把手不表态）；输出结构（结论摘要/分行执行评估/可复制性判断/外部合作风险/推进路径建议）
- `bank-99/SKILL.md` + `references/profile.md`：BANK-99（99，同岗位视角）完整画像——定位/人设/心智模型（样板复制法、考核绑定法、政治账经济账双算、自主可控）/标准分析步骤/EMM 关键因子（分行执行意愿 30%、样板可复制性 25%、考核机制 20%、外部动机 15%、政治账 10%）/一票否决/盲点/标志性表达
- 组合调用示例：BANK-09 + BANK-01（涛动宏观）+ BANK-03（温彬，息差）零售落地圆桌；BANK-09 + BANK-07（罗志恒）外部合作风险评估
- 落位：BANK-09 为首发专家（`bank-09`），按 BK Profile schema 手写归一化画像（来源标注「作者整理自 BANK-09 调用说明 + bank-99 profile」），BANK-99 作为同档案别名记录

### M-05 专家体系文档

- `99wiki/projects/专家体系/BANK-99_调用说明.md`、`王一帆_专家画像_BANK-09.html/pdf`
- 落位：复制进 `domain-packs/bank-finance/source/docs/` 作源材料

### M-06 江苏银行信用卡任务归档

- `work/江苏银行信用卡提质增效_任务归档/`（含 `江苏银行信用卡分析.univer` 等产出）
- 落位：bank-finance 场景 `credit-card-analysis`（信用卡提质增效）的样例素材

### M-07 会议纪要/逐字稿（P2 素材源）

- `98wiki/feishu/20260729_*_智能纪要.md`、`20260730_租房平台产品及发展规划分享_逐字稿.md`、`20260804_*_逐字稿.md` 等
- 落位：`scripts/import-persons.mjs` 端到端验证输入（P2.3）

### M-08 原始材料（knowledge 包候选）

- 陶琦 BK-031 专题数据卡 4 份（公开课22期/政策时间轴/经纪赛道数据/8·7新政研判）
- 各专家访谈/研报（`专家材料/` 目录）
- 落位：`knowledge/experts/<id>/` 惰性挂载

### M-09 线上专家库（P3 接入位）

- `paper.morning.rocks/api/v1/expert-library`：`GET /experts`、`POST /match`、`POST /invoke`、`POST /chat/stream`、`POST /debate`、`POST /feedback`、`GET /mental-models` 等
- 落位：manifest 预留 `origin: 'pipeline-api'`；P3 写同步脚本

## 去重关系图

```text
M-01 (包内 raw, 33) ──基准──► 对齐 ── M-02 (政研通 31) / M-03 (feishu 27)
                                   │ 差异 → 人工裁决 → 补 md/原始材料
M-04 (BANK-09/99) ────────────────► 新建 bank-finance 包（P0.4）
M-06 (江苏银行归档) ────────────────► bank-finance 场景素材
M-07 (纪要/逐字稿) ────────────────► P2 import-persons 输入
M-09 (线上 100+) ─────────────────► P3 同步（manifest 预留）
```

## 收编结论（P0 范围）

1. M-01 不动；M-02/M-03 仅交叉核对（P0.3），产出 `MATERIAL-CROSSCHECK.md`；
2. M-04/M-05/M-06 → 新建 `domain-packs/bank-finance/`（P0.4）；
3. M-07 → P2.3 使用；M-09 → P3 预留；
4. 本清单作为 `build-packs.mjs --inventory` 的静态输入文档，新增素材时更新。
