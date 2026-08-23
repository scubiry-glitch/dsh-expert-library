# 专家库扩容与 pipeline 对齐方案（100+ 专家）

> 状态：**Design Proposal** · 2026-08
> 定位：把 `@zhijian/dsh-expert-library` 从「33 位房地产专家」扩为「**100+ 跨领域专家 + pipeline 级交互特性**」的实施路线图。
> 依据：内容生产流水线 PRD §6.5 / API 文档 §11（专家库已上线）、政研通专家 Profile 素材、本仓库 V2 基座（`src/v2/`）源码、`NEXT-GENERATION-ARCHITECTURE.md`。
> 原则：**先数据后特性、先验证后放量**；所有阶段复用现有 V2 组件（`validateDomainPack` / `loadPackFromDir` / `mergePackLayers` / `compileExecutionPlan` / `runQualityChain`），不另起炉灶。

---

## 0. TL;DR

- **现状**：本插件 33 位房地产专家（BK-002~034）+ 8 位通用；pipeline 线上专家库 100+ 专家且特性更全（匹配/连续对话/辩论评分/反馈闭环/心智模型/人物转专家）。
- **核心思路**：把「专家库」当作**数据流水线**——本地散落的素材（政研通 31 份、feishu 27 份、BANK-09 银行专家）先收编成可校验的领域包；再把 pipeline 的交互特性按「匹配 → 对话 → 反馈 → 飞轮」顺序补进运行时。
- **节奏**：P0 收编（1 周内可交付）→ P1 能力索引（扩容后路由不劣化）→ P2 对话与反馈闭环 → P3 全特性对齐。
- **关键风险**：素材散乱/缺字段、命名空间冲突、对话通道改变团队生命周期——均有预案（§7）。

---

## 1. 背景与目标

### 1.1 背景

pipeline（内容生产流水线）的专家库模块已上线（PRD §6.5 标记 P1），线上为 **100+ 专家**、双编号体系（BK-xxx 房地产/宏观、BANK-xxx 银行金融等），并已具备：按主题匹配（`POST /match`）、结构化调用（`/invoke`）、连续对话（`/chat` + `/chat/stream` SSE）、多专家辩论与观点评分（`/debate` + `/rate`）、专家反馈（`/feedback`）、专家知识挂载（`/experts/{id}/knowledge`）、心智模型目录（`/mental-models`）、热点解读、素材可信度评估、专家版本与调用上下文追溯、会议纪要「人物转专家」。

本仓库已迁入其房地产切片（BK-002~034，33 位，含立场/金句/禁区/分析步骤烘焙），并自建了 V2 基座（领域包装载/校验、Provider 运行时、模板编译、质量门控）。**下一步的增量空间 = pipeline 的「其余 70+ 专家」+「缺失的交互特性」**。

### 1.2 目标（成功标准，可量化）

| # | 目标 | 量化标准 |
|---|---|---|
| G1 | 专家规模过百 | 插件内可路由专家 ≥ 100 位，跨 ≥ 3 个领域包（房地产 / 银行金融 / 政策宏观等） |
| G2 | 扩容不劣化路由 | 100+ 专家下，`match` 候选召回 ≤ 5 位、主责领域命中率 ≥ 90%（回归测试固化） |
| G3 | 特性对齐 pipeline 核心集 | 具备：能力匹配、连续追问、反馈评分回写、心智模型反查、人物转专家（半自动） |
| G4 | 全程可追溯 | 每位专家带 `version` + 来源 manifest；每次输出带「专家版本 + 调用上下文」 |
| G5 | 质量不滑坡 | 新包通过 `validateDomainPack()` 零错误；新专家经质量门控链入库，风格/禁区/口径校验同 BK 基线 |

---

## 2. 现状基线

### 2.1 pipeline 专家库特性清单（对齐基准）

| 能力 | pipeline 接口/模块 | 本仓库现状 | 差距 |
|---|---|---|---|
| 专家管理 | `GET /experts`、`GET /experts/{id}` | 注册表 + 领域包 | 基本具备 |
| 主题匹配 | `POST /match` | 原生 `ROUTE_TOPICS`（11 话题，仅房地产） | **缺跨领域匹配与能力索引** |
| 结构化调用 | `POST /invoke` | 任务 DAG（一次性） | 具备（形态不同） |
| 连续对话 | `POST /chat`、`POST /chat/stream`（SSE） | **无** | **缺** |
| 辩论评分 | `/debate`、`PATCH /debates/{id}/rate` | debate/roundtable 已有，无评分 | 缺评分回写 |
| 专家反馈 | `POST /feedback` | **无** | **缺** |
| 专家知识 | `GET/POST /experts/{id}/knowledge` | `knowledge/experts/<id>/` 目录 | 缺版本/检索语义 |
| 心智模型 | `GET /mental-models`、`/catalog` | meta 含 `mentalModels[]`（无目录视图） | 缺注册表/反查 |
| 热点解读 | `/quality/hot-topics` | 无 | 缺 |
| 素材可信度评估 | 专家对素材打分 | 无 | 缺 |
| 人物转专家 | 会议纪要模块 | 无 | 缺 |
| 追溯 | 专家版本/调用上下文/反馈 | V2 provenance/qualityScore 已有 | 缺专家版本号 |

### 2.2 本仓库可复用基座（P0–P3 全部建立在其上）

- `scripts/build-zhijian-data.mjs` + `zhijian-source.mjs`：Profile JSON + 总表 → 原生数据，**解析硬核校验**（总表/Profile 不一致即失败）；
- `scripts/build-zhijian-pack.mjs`：确定性生成领域包 + `SOURCE-MANIFEST.json`（sha-256）+ 漂移检查 `--check`；
- `src/v2/pack-loader.ts`：`loadPackFromDir` / `mergePackLayers`（builtin < pack < workspace < request，含 id/版本冲突诊断）；
- `src/v2/validate.ts`：`validateDomainPack()` 结构/交叉引用校验；
- `src/v2/compiler.ts` + `zhijian-pack.ts`：`compileExecutionPlan`（roster + DAG + 输入/gate/deliverable + digest）；
- `src/v2/quality.ts` + `builtin-gates.ts`：质量门控链（结构/数据引用/合规匿名/格式/风格/语义/修复 ≤2 轮）；
- `src/v2/provider-runtime.ts`：ProviderRegistry / CapabilityResolver / ProviderInvoker 接口（Wind/zyt/beike 三个 provider 已有 live-smoke 脚本）。

### 2.3 本地可复用素材盘点（P0 输入）

| 素材 | 位置 | 规模 | 落位建议 |
|---|---|---|---|
| 房地产专家 Profile | `domain-packs/zhijian-realestate/source/raw-profiles/` | 33 位（BK-002~034，已在包内） | 基线，不动 |
| 政研通专家 Profile | `/root/.openclaw/workspace/98wiki/feishu/20260810_政研通专家Profile_BK1-31.zip` | 31 位（BK-002~032 同名集，含 md 版） | 作为 BK 集**差异核对源**（补 md/原始材料） |
| BK Profile 散件 | `/root/.openclaw/workspace/98wiki/feishu/*专家Profile_BK-*.json` | 27 份 | 同上，交叉验证字段完整性 |
| 银行专家 | `/root/.openclaw/workspace/skills/bank-99/`、`BANK-09 王一帆`（专家体系） | 1+ 位 + skill | **新建 bank-99 领域包**（BANK 命名空间） |
| 专家体系文档 | `/root/.openclaw/workspace/99wiki/projects/专家体系/`（BANK-99 调用说明、王一帆画像） | 文档 | 包文档与调用说明 |
| 会议纪要/逐字稿 | `98wiki/feishu/*智能纪要/逐字稿*`、`meeting-notes/` | 多份 | P2「人物转专家」素材源 |
| 原始材料（文章/访谈/研报） | `专家材料/`（skill 素材） | 部分 | 挂 `knowledge/experts/<id>/` |

> 结论：**P0 不需要从线上拉数**——本地素材足以支撑「BK 集补全 + BANK-09 首发银行包」两个交付；「其余 100+」的剩余部分在线上 api 库，P0/P1 阶段通过 manifest 预留接入位（§3.2），P3 可接同步脚本。

---

## 3. 总体设计

### 3.1 数据流水线：Source → Normalize → Validate → Emit → Pack

把 `build-zhijian-data.mjs`（单一领域、单一来源）泛化为**多源多包**通用管线：

```text
Source（散落素材：Profile JSON/docx、总表、skill zip、BANK 画像、逐字稿）
  → normalize（统一 ExpertRecord schema：bk/bank 双命名空间、字段缺省补齐、口径声明）
  → validate（复用 parseZhijianSource 的硬校验 + validateDomainPack 交叉引用）
  → emit（生成 <pack>/experts/*.json + 编译原生 TS 数据）
  → pack（build-zhijian-pack.mjs 现有流程：manifest/sha-256/漂移检查）
```

关键设计：

1. **统一 ExpertRecord 中间态**（§5），各来源 adapter 只做「来源 → 中间态」映射，后续 emit 只认中间态——新增来源（线上 API、逐字稿、人物转专家）只加 adapter，不动 emit；
2. **双命名空间**：BK-xxx（房地产/宏观/政策，沿用现有 `bk-` 前缀）+ BANK-xxx（银行金融，`bank-` 前缀）；id 生成规则与冲突诊断复用 `mergePackLayers` 既有逻辑；
3. **素材漂移检测**：同一专家多份来源（feishu json vs 政研通 zip vs 包内 raw）以 sha-256 比对，字段级 diff 报告差异而不是静默覆盖；
4. **缺字段降级策略**：Profile 缺 md/原始材料不阻断入库（现有 14 位只有 json 的先例），但 manifest 记录 `material: {md:false,raw:false}`，供知识包补齐队列使用。

### 3.2 领域包布局扩展

```text
domain-packs/
├── zhijian-realestate/   # 已有（BK-002~034，33 位）——P0 仅做补全与核对
└── bank-finance/         # 新建（BANK 命名空间；首发 BANK-09 王一帆 + bank-99 skill 引用）
    ├── pack.json         # id: bank-finance, schemaVersion: 2
    ├── experts/          # bank-09.json …
    ├── scenarios/        # bank-review / credit-card-analysis（对应江苏银行归档任务）
    ├── routing/          # 跨领域路由片段（涉房金融 → 房地产包 + 银行包 联合）
    ├── method-packs/     # 银行零售/对公/风控方法包
    ├── knowledge-providers/  # 复用 zyt/beike provider 声明（若适用）
    ├── quality-policies/     # BANK 输出风格/匿名化策略
    ├── source/           # 原始画像 + SOURCE-MANIFEST.json
    └── generated/        # 派生视图（可重建）
```

多包装载语义不变：`mergePackLayers(builtin < zhijian-realestate < bank-finance < workspace < request)`，id 冲突即诊断。

### 3.3 能力索引与匹配（capability-first，G2 的关键）

现有 `ROUTE_TOPICS` 是「话题 → 框架 → 领域 → 候选专家」的**单领域**表；100+ 专家后升级为三维能力索引：

```text
专家能力签名 = { domain: 领域包, field: 主责领域, tags: 能力标签(研判/数据/解读/理论/实操),
                 stance: 立场, mentalModels[], languages[], caliber 偏好 }
话题解析 = 话题 → { 需要的能力标签集, 主责领域, 立场偏好(乐观/风险/中立), 跨领域标记 }
匹配 = 能力签名 × 话题解析 → 候选 ≤5 位（按标签命中数排序，同分按立场互补性）
```

- **新增 `expert_teams_match`（或 `expert_review_route` 扩展）**：输入话题/数据，输出候选专家 + 匹配理由（命中了哪些标签），保持「候选匿名呈现 → 用户拍板」的智见点评既有交互；
- **跨领域组队**：涉房金融类话题自动拉「房地产包（行业派/挂牌派）+ 银行包（零售/风控）」，产出 `ROUTE_TOPICS` 的 `crossDomain: true` 标记；
- **立场对照一等公民**：把 `专家总表.md` 的立场对照表从文档升级为结构化数据（`routing/stance-pairs.json`），debate/roundtable 自动配对立场对立专家；
- **心智模型注册表**：汇总各专家 `mentalModels[]` 建 `mental-models/catalog.json`（name → 专家 id 列表），支持「按心智模型反查专家」与「组队时检查观点互补」。

### 3.4 交互特性补全（对齐 pipeline §11）

| 特性 | 实现思路（复用现有成员/调度/质量机制） |
|---|---|
| **连续追问 /chat/stream** | 不开新团队：对已完成/进行中团队，向指定成员 `send_message` 追加「追问回合」，SSE 语义收敛为事件（`meta/reasoning/content/done`）；回合结果写回任务 `output` 增量 |
| **反馈评分回写 /feedback、/rate** | 新 `expert_review_feedback` 工具：对某专家输出打分（采纳率/相关性/口径合规），回写 `experts/<id>/evaluations.jsonl`（pipeline Expert 对象的「评价记录」），下次烘焙 persona 时注入「既往反馈摘要」 |
| **专家知识版本化** | `knowledge/experts/<id>/` 加 `version` + 索引（`knowledge/README.md` 约定扩展），persona 知识指引标注「知识版本」 |
| **热点解读** | 新场景 `hot-topic-interpretation`：话题 → 立场对照自动选 1 乐观 + 1 风险 → 并行解读 → 融合稿（复用 roundtable DAG + 质量门控） |
| **素材可信度评估** | 新模式 `material-credibility`：素材/数据 → 匹配专家逐个打分（口径/来源/时效）→ 汇总表（复用 report DAG） |
| **人物转专家** | `scripts/import-persons.mjs` 半自动：逐字稿/会议纪要 → 识别人物与观点立场 → 生成画像草稿 JSON（复用 ExpertRecord schema）→ 人工确认 → 进 `workspace/knowledge/experts/<id>/` 或新领域包 |

### 3.5 治理与追溯

- ExpertRecord 增加 `version`（`1.0.0` 起，Profile 内容变化 +0.1）；
- 输出 provenance 增加 `expertVersion` 与 `callContext`（话题/口径/数据快照 id）；
- 质量门控链对 BANK 包复用 `runQualityChain`，新增 BANK 匿名化规则（银行数据脱敏：账号/余额/客户粒度）作为 `compliance-anonymization` 的策略变体。

---

## 4. 分阶段实施

### P0 — 素材收编与泛化导入（快赢，≈1 周）

**目标**：交付 G1 的第一块——「BK 集补全核对 + BANK-09 首发银行包」，管线可重复运行。

| # | 任务 | 交付物 | 验收 |
|---|---|---|---|
| P0.1 | 盘点所有本地专家素材，输出素材清单 | `domain-packs/MATERIAL-INVENTORY.md` | 清单覆盖 §2.3 全部条目，标注去重关系 |
| P0.2 | 泛化 `build-zhijian-data.mjs` → 通用 `build-packs.mjs`（多源 adapter + 双命名空间 + 字段 diff） | `scripts/build-packs.mjs` + `scripts/pack-sources/*.mjs` | BK 基线重建后产物与现有 `experts.generated.ts` 逐字节一致（golden 对比） |
| P0.3 | 政研通 zip + feishu 27 份与包内 raw 交叉核对 | 字段级 diff 报告；补 md/原始材料到 `source/` | 33 位 BK 全字段齐备；差异清单 ≤ 阈值并注明原因 |
| P0.4 | 新建 `bank-finance` 领域包（BANK-09 王一帆 + bank-99 skill 引用 + 江苏银行归档任务 → 场景） | `domain-packs/bank-finance/` | `validateDomainPack` 零错误；`build-zhijian-pack.mjs` 可重建；`pnpm test` 全绿 |
| P0.5 | BANK 质量策略（脱敏规则）接入质量链 | `quality-policies/bank.json` + gate 测试 | 含手机号/账号样例的测试通过脱敏 gate |
| P0.6 | 打包发布 | 新版本插件 | Web UI 专家卡片可见 bank-09；`expert_teams_add_member(expert='bank-09')` 可建队 |

### P1 — 能力索引 + 跨领域路由 + 心智模型 + 专家版本（≈1–2 周）

**目标**：100+ 规模下路由不劣化（G2），立场对照与心智模型成为一等公民。

| # | 任务 | 交付物 | 验收 |
|---|---|---|---|
| P1.1 | 三维能力索引数据结构与匹配器 | `src/zhijian/capability.ts` + 单元测试 | 黄金样本：11 个既有话题匹配结果与现路由一致 |
| P1.2 | `expert_teams_match` 工具（候选匿名呈现 + 匹配理由） | 新工具 | 候选 ≤5、理由含命中标签；回归测试覆盖跨领域话题 |
| P1.3 | 立场对照结构化 | `routing/stance-pairs.json` + debate/roundtable 自动配对 | 现有 `cross-debate` 场景改为读结构数据后行为不变 |
| P1.4 | 心智模型注册表 + 反查 | `mental-models/catalog.json` + 查询接口 | 「债务-通缩循环 → BK-007」类反查通过 |
| P1.5 | ExpertRecord 加 `version` + provenance 扩展 | schema + 回归测试 | 输出含专家版本与调用上下文 |

### P2 — 对话/反馈闭环 + 人物转专家（≈1–2 周）

**目标**：补齐 pipeline 最实用的缺失交互（G3）。

| # | 任务 | 交付物 | 验收 |
|---|---|---|---|
| P2.1 | 成员追问通道（`send_message` 追加回合，事件收敛） | `src/members.ts` 扩展 + `expert_teams_chat` 工具 | 同一团队内追问 2 轮不重建团队；回合可追溯 |
| P2.2 | 反馈评分回写 | `expert_review_feedback` + `evaluations.jsonl` + persona 注入既往反馈 | 评分后可再调用，persona 含反馈摘要 |
| P2.3 | 人物转专家半自动管线 | `scripts/import-persons.mjs` | 用 1 份逐字稿端到端产出可入库画像草稿 |
| P2.4 | 知识版本化 | `knowledge/README.md` 扩展 + persona 指引 | 知识包版本可见、可漂移检测 |

### P3 — pipeline 全特性对齐（按需，≈2 周）

| # | 任务 | 验收 |
|---|---|---|
| P3.1 | 热点解读场景 | 话题 → 自动双立场解读 → 融合稿，质量门控通过 |
| P3.2 | 素材可信度评估模式 | 素材 → 多专家评分 → 汇总表（口径/来源/时效维度） |
| P3.3 | 线上 100+ 专家同步脚本（manifest 预留位启用） | 拉取 → normalize → validate → emit 全链路 dry-run 通过 |
| P3.4 | 特性总表回归：§2.1 差距列清零 | 对照表逐项勾验 |

---

## 5. 数据 Schema 扩展

统一 ExpertRecord（normalize 输出）在现有 `ZhijianExpertMeta` 之上新增：

```ts
interface ExpertRecordV2 {
  id: string                    // bk-xxx | bank-xxx
  namespace: 'bk' | 'bank'
  version: string               // 1.0.0 起，内容变化 +0.1
  source: {                     // 来源 manifest（复用 SOURCE-MANIFEST 语义）
    origin: string              // 素材路径/线上 id
    sha256?: string
    material: { md?: boolean; raw?: boolean; knowledge?: boolean }
  }
  // —— 现有 ZhijianExpertMeta 字段全部保留（field/stance/tags/mentalModels/…）——
  evaluations?: EvaluationRecord[]   // P2：feedback 回写（不烘焙进 persona，只注入摘要）
}

interface EvaluationRecord {
  at: string                    // ISO 时间
  taskId?: string
  score: number                 // 0–100
  dimensions: { 采纳率: number; 相关性: number; 口径合规: number }
  note?: string
}
```

兼容策略：`ExpertRecordV2` 为增量（`version`/`source`/`evaluations` 可缺省）；旧数据经 `migrateDomainPack()` 升版，`legacySource: 'v1'` 标注，运行时行为不变。

---

## 6. 文件与接口变更汇总

```text
新增：
  scripts/build-packs.mjs                # 泛化导入管线（P0）
  scripts/pack-sources/                  # 各来源 adapter（feishu/zip/bank/persons）
  scripts/import-persons.mjs             # 人物转专家（P2）
  domain-packs/bank-finance/             # 银行领域包（P0）
  domain-packs/MATERIAL-INVENTORY.md     # 素材清单（P0）
  src/zhijian/capability.ts              # 能力索引与匹配（P1）
  src/zhijian/mental-models.ts           # 心智模型注册表（P1）
  src/zhijian/evaluations.ts             # 反馈记录读写（P2）
  src/zhijian/tools-match.ts / tools-chat.ts / tools-feedback.ts
  knowledge/mental-models/catalog.json

修改：
  src/zhijian/types.ts                   # ExpertRecordV2 增量字段
  src/zhijian/routing.ts                 # 跨领域标记 + 能力签名
  src/v2/zhijian-pack.ts                 # BANK 包模板投影
  src/members.ts                         # 追问通道（P2）
  src/zhijian/tools.ts                   # review_route 内部改用能力匹配（P1，行为兼容）
  knowledge/README.md                    # 知识版本约定
  domain-packs/zhijian-realestate/       # P0 核对补全
```

工具面新增：`expert_teams_match`（P1）、`expert_teams_chat`（P2）、`expert_review_feedback`（P2）；场景新增：`hot-topic-interpretation`（P3）、`material-credibility`（P3）、`bank-review`（P0）。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 素材散乱、同一专家多份来源字段冲突 | P0 阻塞 | 以包内 raw 为基线、sha-256 比对、字段级 diff 报告，绝不静默覆盖；差异全部落清单人工裁决 |
| 双命名空间 id 冲突（未来 BK 与 BANK 编号重叠） | 路由错配 | `mergePackLayers` 冲突诊断 + 构建期 id 全局唯一校验（复用现有校验逻辑） |
| 100+ 后路由退化（候选过多/命中漂移） | G2 不达标 | 能力索引 + 黄金样本回归：11 个既有话题匹配结果固化对比 |
| 对话通道改变团队生命周期（团队迟迟不终态） | 状态泄漏 | 追问回合限定次数与超时；回合结束仍走原终态流程；状态机不加新态 |
| 反馈回写污染 persona | 风格漂移 | evaluations 不直接烘焙，仅注入「既往反馈摘要」；支持一键清空 |
| 银行数据脱敏不到位 | 合规 | BANK 包强制 `compliance-anonymization` 变体 gate（手机号/账号/客户粒度），样例测试 |
| 线上 100+ 同步接口未定（P3 依赖外部） | P3 延期 | manifest 预留接入位；P0–P2 不依赖线上数据，可独立交付 |

---

## 8. 里程碑与依赖

```text
M1 (P0 完成)  专家 34+1、bank-finance 包上线、管线可重复跑
  ↑ 依赖：素材盘点 → 泛化脚本 golden 对齐 → BANK 包
M2 (P1 完成)  能力匹配 + 心智模型 + 立场结构化 + 版本号，路由回归全绿
M3 (P2 完成)  追问/反馈闭环/人物转专家 可用
M4 (P3 完成)  pipeline §2.1 差距列清零（可选，依赖线上接口）
```

**建议起点**：P0.1 + P0.2（素材清单 + 泛化脚本）可以立即开工，且与现有代码零冲突（纯脚本 + 数据目录新增）。需要我先把 P0.1 的素材清单盘点出来，还是直接开始写 `build-packs.mjs`？

---

## 9. 执行状态（P0–P2 已完成，2026-08-23）

| 阶段 | 状态 | 关键交付 | 验证 |
|---|---|---|---|
| P0 | ✅ | `domain-packs/MATERIAL-INVENTORY.md`、`MATERIAL-CROSSCHECK.md`、`pack-common.mjs` 共享发射器、`build-packs.mjs` 多包驱动、`bank-finance` 领域包（BANK-09 + bank-retail/bank-credit-card 场景）、`pii-redaction` 脱敏硬门 | zhijian/bank 包 `--check` 双绿；`test/bank-pack.test.mjs` 9 例 |
| P1 | ✅ | `capability.ts`（三维能力索引/匹配 + 心智模型注册表 + 反查）、`stancePairForTopic` + debate 自动配对、`expert_review_route` 输出增强（能力分/标签/版本/命名空间）、meta 统一打戳 `stampExperts`（namespace/version/source） | `test/capability.test.mjs` 11 例；路由回归全绿 |
| P2 | ✅ | `expert_teams_chat` 追问通道（chatRounds 累计 + chat-round 事件）、`expert_review_feedback` + `evaluations.jsonl` + persona 既往反馈摘要注入、`import-persons.mjs` 人物转专家（飞书逐字稿双格式解析）、knowledge `VERSION` 版本锚点 | `test/p2-feedback-knowledge.test.mjs` 6 例 + `test/import-persons.test.mjs` 4 例；全量 **590/590** |

**整合原则落地**：单一注册表（bk+bank 合并）、单一路由表（含银行话题）、单一发射器（pack-common）、扩展既有工具而非新增平行体系；P3（热点解读/素材可信度评估/线上 100+ 同步）预留 manifest 接入位。

| P3.1 | ✅（2026-08-23） | `sync-pipeline-experts.mjs`（线上 184 位盘点：`PIPELINE-REMAINING-EXPERTS.md` + `work/pipeline-experts-184.json`；E01/E08/E13 首批 22 位已同步入库，S/XHS 命名空间脚本已支持按批收）、`build-pipeline-data.mjs`（e01/e08/e13 命名空间）、`pipeline-domains` 领域包（3 场景 + pii 硬门）、路由表 + 注册表并入 | `test/pipeline-sync` 5 例 + `test/pipeline-pack` 6 例；全量 **601/601**；三包 `--check` 全绿 |
