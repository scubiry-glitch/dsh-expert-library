---
name: 98wiki-data-channels
description: 98wiki 研究取数三通道预检、错误分流、降级与来源纪律的冻结任务材料。
---

# 三数据通道使用 Playbook（Wind / 贝壳 / 证研通 dataset 网关）

本文件是 Host 任务材料快照。执行时以 Host 注入的 SHA256 版本为准；下方历史案例仅说明调用方法，不是本轮课题的事实或数字。探针脚本用于实际通道测试，运行记录须写入 `data-channel-status.md`。不要用历史成功记录冒充本轮探针结果。

> 沉淀自《上海住房租赁市场分析报告》v1—v4 全流程（2026-09-27/28）。
> 用途：任何 98wiki 研报取数前，先跑 §0 探针，再按 §1—§3 对应通道取数；引用与错误处理纪律见 §4。
> 关联 skill：`zhijian-report-craft`（§2.7 三通道引用约定）、`wind-mcp-skill`、`beike-market`。

## §0 通道探针（每次取数前先跑，一次全通）

```bash
# ① Wind CLI 探针：EDB 搜索一次（确认 key 与路由）
cd /root/.agents/skills/wind-mcp-skill && \
node scripts/cli.mjs call economic_data search_economic_indicator '{"question":"上海CPI"}'

# ② 贝壳 CLI 探针：版本 + 凭据 + 工具面
command -v beike && beike --version && beike doctor

# ③ 证研通 dataset 层探针：catalog（覆盖目录，最小返回）
# expert_provider_call(dataset="realestate.indicators.catalog", input={"city":"上海"})
```

探针判读：
- Wind 返回 `metrics[]` = 通；`AUTH_ERROR` = key 未配，实跑确认后按信封指引处理。
- beike doctor 全绿 = 通；注意 `doctor` 显示的工具数 ≠ 行情工具可用（见 §3 工具降级链）。
- dataset 层 `CALIBER_MISSING` = **通道健康**（只是缺口径参数）；`invalid output: value is not lossless JSON` = **宿主序列化边界故障**（见 §1.4），短期绕行走原生 CLI。

## §1 证研通 dataset 层（expert_provider_call）

### 1.1 正确入口
- **只从 `dataset` 参数进**（自动映射版本钉扎 capability + 校验必填口径）；capability 仅兼容老调用，禁止猜未注册的 capability key。
- 数据集：`realestate.indicators.catalog`（探路石）/ `realestate.city.market` / `realestate.city.compare` / `realestate.listing.search` / `realestate.policy` / `realestate.rent.market`；金融侧 `financial.stock.quote` / `financial.macro`。
- 任何取数前先打 catalog 看该城市×指标覆盖。

### 1.2 必填口径速查（CALIBER_MISSING 时按此补）
| dataset | 必填 |
|---|---|
| realestate.city.market | `city` + `code` |
| realestate.policy | `city` + `period` + `topic` |
| financial.macro | `metric` + 时段 |
| realestate.rent.market | `city`（建议带 `period`/`metric` 收窄返回体） |

### 1.3 错误四态（结构化报错自带修正指令，retry:never = 改参数重试而非原样重发）
| code | 含义 | 动作 |
|---|---|---|
| DATASET_UNKNOWN | 数据集 id 拼错 | 用 §1.1 列表里的 id，不猜 |
| CALIBER_MISSING | 缺必填口径 | 按 message 字段名补参 |
| CREDENTIAL_MISSING | 凭据未配 | 配凭据，禁止重装 skill/provider |
| INPUT_INVALID | 参数类型/取值错 | 按 message 修类型 |

### 1.4 已知坑：invalid output: value is not lossless JSON
- **现象**：口径校验通过、provider 成功返回后，宿主拒收工具输出（本次 2026-09-27 全部 realestate 数据集复现）。
- **根因**：宿主对工具返回值做 lossless-JSON 快照校验（拒绝非有限数/-0/非 plain 原型）；插件源码 `lib/host/provider-tool.js` 的防御性归一化（`JSON.parse(JSON.stringify(result))`）存在于新代码，但 dsh 运行时加载的是旧构建。
- **修复**：`cd /root/zhijian/dsh-expert-library && pnpm build` 重编译 + 重启 dsh（坑位：lib/*.js 才是运行时实际加载；进程内补丁需重启）。
- **短期绕行**：直接走 §2 Wind CLI / §3 贝壳 CLI 原生通道。

### 1.5 引用铁律
- 成功返回必须带 provenance（source/caliber/unit 三件套）；`DATA_QUALITY_INVALID` 的结果一个数字不得进报告。
- 空 series = 「该城市×指标未交付」，标待补，不当 0。
- 写操作（realestate.rent.appoint / sell.list / agent.contact）必须 allowed-once 审批；审批不可用即失败关闭，无绕行。

## §2 Wind CLI（wind-mcp-skill · 主定量源）

### 2.1 四步纪律
定路由（按 server_type 只读对应契约 references/*.md）→ 发命令 `node scripts/cli.mjs call <server_type> <tool> '<params_json>'`（在 skill 目录执行）→ 读回执（数据在 `content[0].text`）→ 收口（成功必附「数据来源于万得 Wind 金融数据服务」）。

### 2.2 EDB 正确两步（宏观/行业/汇率指标）
1. `search_economic_indicator {"question":"<自然语言>"}` 拿指标 code + 单位/来源/频率——**优先自然语言，勿直填代码**（代码直查可能错配）。
2. `query_economic_indicator_data {"question":"<code>","beginDate":"yyyy-MM-dd","endDate":"yyyy-MM-dd"}`——**必带**日期对或 `observation`（互斥）；日期绝不写进 question。
- 回执元数据优先：单位看 `meta.unit` / `meta.magnitude`，未给则保留原值注明单位未知，不自行换算。

### 2.3 错误码分流
| code | 动作 |
|---|---|
| PARAM_VALIDATION_ERROR | 按 message 修字段重试（唯一允许改业务参数的情形） |
| ROUTE_ERROR | 工具名不属于该 server_type → 换工具不换通道 |
| AUTH_ERROR / BLOCKED_KEY / RATE_LIMIT / NETWORK / backend_error | 如实报告，不重试，**禁止**切 analytics_data 伪装 |
| INVALID_PARAMS_JSON | 修引号/JSON 转义 |

### 2.4 引用格式
正文：`（Wind EDB，<发布机构>，截至 <年-月>）`；指标代码进文末来源披露。

## §3 贝壳 CLI（beike · 微观供给/房源合作源）

### 3.1 预检三连
`command -v beike` → `beike --version` 对 manifest（落后则跑官方 install.sh）→ `beike doctor`（Key 在 `~/.beike/BEIKE_MCP_API_KEY`）。

### 3.2 工具降级链（Key 工具面 ≠ 全量）
- `Unknown tool: *_market_search / market_trend_search` = 行情工具服务端未对该 Key 开放 → **检索端点等效替代**：
  - 供给量：`beike rent search -c <城> -q "<城区>在租房源"` 的「总召回结果数」
  - 板块分布：`beike rent plate -c <城> -q "<城区>租赁板块"` 的「满足条件房源的供给情况」
  - 租金水位：展示样本的 `月租金X元/月` 均值——**必须标「估算·小样本」**
- 检索规则：查询必须落到具体城区/板块（全市泛查询召回 0）；实体 ID 只用上游返回的真实 ID；用户给的时段原样透传。

### 3.3 引用格式
`（贝壳租赁检索，省心租+普租，截至 YYYY-MM-DD）`；绝不与统计局口径混用、不冒充其他来源。

## §4 三通道通用纪律

1. **探针先行**：每通道先发一次最小调用再批量；一次报错即停该批次，不扩散。
2. **失败三态**：报错 = 如实说通道失败；成功无值 = 待补；空序列 = 该城市未交付。**编数字比不回答更严重。**
3. **两源冲突不静默择优**：来源披露写明差异与取舍。
4. **每次调用带 `context`**（任务/报告 id）留痕可审计。
5. **来源披露逐通道一行**：已透出数值（本轮采用）/ 仅趋势性结论 / 待补 / 未配置。
6. **主次分工**：Wind = 主定量源；贝壳/证研通 = 趋势性/补充性引用；统计局口径独立，不混用。

## §5 本次实战案例（2026-09-27 上海租赁报告）

| 需求 | 实际命中通道 | 结果 |
|---|---|---|
| 租金指数 2024—2026 月度 | Wind CLI EDB S0143689 | 全序列 32 个月 ✅ |
| 常住人口 / 可支配收入 | Wind CLI EDB M0014952 / M5541333+M5540819 | 年度+季度 ✅ |
| 四区/板块在租供给、板块租金样本 | 贝壳 CLI rent search/plate（行情工具降级） | 4 区 + 15 板块 ✅ |
| 保租房政策口径 | 政研通 dataset 层 | ❌ 序列化故障 → 公开政策事实 + 待补 |
| REITs 价格 | Wind CLI EDB | 无在更指标 → 如实标「缺估值锚」 |

## §1.4b 修复落地记录（2026-09-28）
- 根因升级发现：归一化热修原先只打在 `lib/host/provider-tool.js` 编译产物上，`pnpm build` 会用 src 覆盖导致修复丢失（坑位 #2 的变体：热修必须回填源码）。
- 已回填 `src/host/provider-tool.ts`（return result 前加 JSON round-trip try/catch）并重建，`lib/` 中已含该逻辑（grep 验证 = 1）。
- **生效条件：重启 dsh**（运行中进程仍持旧模块）。重启后 expert_provider_call dataset 层应恢复正常。

## §1.5 工具层硬保证（2026-09-28 二次加固，均在插件代码内，不依赖会话记忆）
1. **lossless 归一化**：`expert_provider_call` 返回前强制 JSON round-trip（src/host/provider-tool.ts），宿主拒收类故障从源头消除。
2. **工具描述内置分流**：TOOL_DESCRIPTION 每次调用都注入错误分流表 + 降级路由（模型在调用点必然看到，不依赖 AGENTS.md 被读到）。
3. **传输失败信封内置降级链**：PROVIDER_CALL_ERROR 的 details.fallback 直接给出 Wind/贝壳原生 CLI 等效路径。
以上均已回填 src 并重建（lib 验证通过）；生效条件=重启 dsh。

## §1.6 贝壳 provider 通道修复实录（2026-09-29，全部回填插件源码并重启生效）
四层问题逐一定位修复（每层都有独立报错，逐层剥开）：
1. **凭据**：systemd 拉起的 dsh-web 不继承 shell 环境变量 → `ZYT_API_KEY`/`BEIKE_MCP_API_KEY` 写入 `/etc/systemd/system/dsh-web.service.d/zyt-env.conf`（chmod 600）+ daemon-reload + restart。
2. **cli transport 绑定错误**：能力表工具名（rent_house_search 等）是 MCP 服务端工具名不是 CLI 子命令，cli 绑定全局 `--json` 必被拒 → `buildBeikeManifest` readBind 固定 `'mcp-http'`（src/v2/providers/beike.ts）。
3. **CLI 版本门禁**：服务端按 initialize.clientInfo + `X-Beike-Cli-Version` 头识别版本（缺失/过低即 CLI_UPGRADE_REQUIRED，连 tools/list 都拒）→ 修复三处：manifest version 默认 0.2.24→0.2.26；mcp-http transports 附 `clientInfo={name:'beike-mcp-proxy',version:'0.2.26'}`；invoker 注入 `X-Beike-Cli-Version` 头。
4. **MCP 会话回显**：streamable-HTTP initialize 响应的 `Mcp-Session-Id` 必须在后续调用回显（原实现丢弃）→ runMcpHttp 捕获并回显；FetchResult 增补 responseHeaders。
**调用契约（实测）**：`realestate.rent.search` 必填 `query`（检索问句）+ `city_name`（城市）；全市泛 query 召回 0，须落城区/板块（如 query="闵行区在租房源租金价格" → 3182 套 ✅）。
**教训**：报错每变一次形态 = 剥开一层；curl 差分实验是最快定位手段（用真实服务端差分 headers/参数，比读代码猜快得多）。

## §1.7 Wind 路由修复（2026-09-29）
- `financial.macro.query` 原映射 `natural_language_get_edb_data`（不属于 economic_data server_type，ROUTE_ERROR）→ 已改 `query_economic_indicator_data`（必填 beginDate/endDate 或 observation）并实测返回数据 ✅
- 插件侧 «协作层» 加固：GLOBAL_OUTPUT_RULES 增「硬门兼容」规则（正文连续段+文末「结构标注（非正文）」块映射章节标记），apply 下发的任务约束自带解法，专家不再消耗修复轮次
