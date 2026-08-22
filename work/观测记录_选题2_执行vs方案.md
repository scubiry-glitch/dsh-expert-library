# 观测记录：选题 2 研报执行 vs 方案设计对照（2026-08-22）

> 任务：98wiki 选题 2「房屋养老金三项制度：30 年房龄强制体检如何重新给二手房定价」
> 入口：`expert_teams_scenario_apply(scenario=research-report)`
> 基线：`ARCHITECTURE-COMPARISON.md`（方案设计）

---

## 观测点 1：场景分配

| 项 | 方案设计（ARCHITECTURE-COMPARISON） | 实际执行 | 一致 |
|---|---|---|---|
| 入口 | 场景一键：建队+加专家+生成 DAG 一步完成 | `expert_teams_scenario_apply` 一次调用完成全部 | ✅ |
| 场景溯源 | TeamState 新增 `scenarioId` | team.json 写入 `scenarioId: research-report` | ✅ |
| 场景选择 | 10 个场景（6 通用 + 4 协作） | 实际存在 9 个场景 JSON（builtin-library/scenarios/：code-review、cross-debate、documentation、fullstack-build、market-research、ppt-gen、product-design、research-report、roundtable；security-audit 仅在 quality/output 有模板） | ⚠️ 场景 JSON 缺 security-audit（模板有，场景定义可能缺失） |
| 场景数据结构 | Scenario: id/experts/任务 DAG/deliverable/knowledge/skill 绑定 | 实际为 v2 schema：routingPolicy.candidateHints + teamTemplate + outputTemplate + qualityPolicy + knowledgePolicy + toolPolicy | ✅（v2 演进版） |

## 观测点 2：专家分配

| 项 | 方案设计 | 实际执行 | 一致 |
|---|---|---|---|
| 专家来源 | 40 位（8 通用 + 32 智见 bk-002~bk-033） | builtin-library/experts/ 8 个 JSON；zhijian-realestate/experts/ bk-*.json | ✅ |
| 分配机制 | 场景为主入口 + 专家为参数 + 路由收敛 | `routingPolicy.candidateHints: [researcher, bk-004, bk-007, docs-coordinator]` → 成员 4 位 | ✅ |
| 角色映射 | 专家 persona（role/background/原则/deliverables） | 邢自强 role=宏观经济·宏观周期派；张明 role=宏观经济·债务金融派；Researcher role=research analyst | ✅ |
| 模型路由 | 专家预置路由 > 显式参数 > memberModel > 队长路由 | 全部 deepseek-official/deepseek-v4-flash（专家预置） | ✅ |
| 成员记录 expert 字段 | —（架构文档未提） | team.json 成员记录 `expert` 字段为空 | ⚠️ 观察：场景成员未带 expert 档案 id，仅 role 区分；persona 是否注入专家档案待验证 |

## 观测点 3：知识库 / 领域包工具

| 项 | 方案设计 | 实际执行 | 一致 |
|---|---|---|---|
| 知识包目录 | <workspace>/knowledge/{experts,scenarios,shared}，惰性生效 | 工作区 knowledge/ 仅 README（无资料）；目录约定正确 | ✅ 结构正确，内容为空 |
| 领域包 | —（架构文档 3.6 节未展开领域包机制） | domain-packs/builtin-library + domain-packs/zhijian-realestate（pack.json + experts/scenarios/knowledge-providers/output-templates/quality-policies/team-templates） | ✅ 实际存在（架构文档未描述，属新发现） |
| 知识提供者 | knowledge.ts 知识包指引，persona 注入 | domain-packs/*/knowledge-providers/local-knowledge.json（scopes: experts/scenarios/shared）+ zhijian-expert-memory.json | ✅ |
| 知识指引注入 | 成员 persona 自动注入知识包目录与文件清单 | 成员启动消息确认团队状态，未见显式知识指引内容 | ⚠️ 待验证：需查成员 persona 是否含知识指引 |

## 观测点 4：任务 DAG 生成

| 项 | 方案设计 | 实际执行 | 一致 |
|---|---|---|---|
| DAG 来源 | 场景预设任务 DAG | team-template research-report.legacy-team.json 的 tasks[]（含 dependsOn） | ✅ |
| 实际 DAG | — | t1 资料梳理(Researcher) → t2 宏观研判(邢自强) + t3 风险债务(张明) 并行 → t4 融合成文(DocsCoordinator) | ✅ |
| 依赖写入 | task.dependencies | t2 deps:[t1]；t3 deps:[t1]；t4 deps:[t2,t3] | ✅ |
| 调度 | 事件驱动领取 + 冷恢复重试 | t1 被 Researcher 自动领取运行；t2 邢自强被唤醒准备（等待 t1） | ✅ |
| retryPolicy | — | 模板定义 retryPolicy: "never"（与调度器 shouldAutoRetryTask attempt 预算机制并存，方向相反需注意） | ⚠️ 模板 never 与调度器 auto-retry(attempt∈{1,2}) 语义需厘清 |

## 观测点 5：模板匹配

| 项 | 方案设计 | 实际执行 | 一致 |
|---|---|---|---|
| 模板选择 | 场景带 deliverable/knowledge/skill 绑定 | 场景 JSON 引用 teamTemplate/outputTemplate/qualityPolicy/knowledgePolicy/toolPolicy | ✅ |
| 输出模板 | — | output-templates/research-report.legacy-output.json（标题/摘要/正文/结论/风险/附录） | ✅（与工具描述 Deliverable 一致） |
| 质量策略 | — | quality-policies/research-report.legacy-quality.json | ✅ |
| 槽位模板 | — | team-template slots: role.bk-004/bk-007/docs-coordinator/researcher，cardinality min0 max1 | ✅ |

---

## 发现的偏差 / 风险（供复盘）

1. **知识指引未证实**：知识包「persona 注入文件清单」在启动消息中未见显式体现，需进一步验证 persona 实际内容。
2. ~~**security-audit 场景缺失**~~ → **已销项（误报）**：`ls` 未排序+head 截断导致漏看，实际 `scenarios/` 有 10 个 JSON（含 security-audit.json），与架构文档一致。
3. **retryPolicy 语义**：模板 `retryPolicy: "never"` vs 调度器 `shouldAutoRetryTask`（failed+attempt 1-2 自动回池）方向不一致，需确认实际生效哪层。
4. ~~**expert 字段为空**：persona 烘焙链路需验证~~ → **已销项**：`addMemberCore` 中 bk-* 走 `zhijianExpertPersona` Profile 烘焙确认走通（成员启动口吻验证），expert 字段为空是设计。
5. **领域包为架构文档未覆盖的新机制**：pack.json + knowledge-providers + team-templates 是 v2 schema 落地，架构文档（基于 v1）未同步。
6. **旧团队状态损坏教训**：直接改 team.json 清 attemptId 时写 null 导致 isTeamState 校验失败（isOptionalString 拒绝 null）——**不应手改状态文件**，应走工具或字段删除（undefined）。

---

## 观测点 6：知识指引注入（源码级验证）

- `knowledgeGuide(workspace, knowledgeDir, expertId, scenarioId)`：扫描 `<workspace>/knowledge/{experts/<id>,scenarios/<id>,shared}/`，**有文件才**生成指引行注入 persona（members.ts `expertMemberPersona`）。
- 实际执行：工作区 `knowledge/` 仅 README → 各子目录为空 → `knowledgeGuide` 返回空 → **persona 无知识指引行**（惰性生效的正确行为）。
- **偏差**：方案设计预期「知识包=工作区可插拔」，但选题资料实际只存在于插件打包的 `domain-packs/zhijian-realestate/`（专家 JSON 数据），**工作区知识包从未填充** → 成员实际拿不到领域资料指引，只能靠 persona 与自身知识。这解释了为什么「知识指引」在启动消息中不可见。
- 结论：知识包机制实现正确但**当前工作流未使用**——若要真正喂资料给成员，需把领域资料放入 `<workspace>/knowledge/{experts,scenarios,shared}/`。

## 观测点 7：persona 烘焙与 expert 字段

- `expertMemberPersona(expertId, expert, knowledgeGuideText)`：专家背景/原则/交付物 + 知识指引合并进成员 persona。
- team.json 成员记录 `expert` 字段为空：**设计如此**——`addMemberCore` 的 member 对象本就不含 expert 属性，专家档案经 `personaOverride`（bk-* 走 `zhijianExpertPersona` Profile 烘焙，其余走 `expertMemberPersona`）编译进系统提示，无需在记录里重复存 id。
- **已确认烘焙走通**：邢自强/张明启动消息自带「宏观周期派/债务金融派」口吻与研判框架（周期定位/债务-通缩/量化测算），与 bk-004/bk-007 档案一致。
- 偏差清单第 4 条据此**销项**（persona 烘焙链路确认走通，expert 字段为空是设计而非缺陷）。

---

*观测记录 v2 · 2026-08-22 · 随研报执行持续更新*


## 观测点 8：调度器执行（修复后验证）

- t1 完成 → 调度器**自动**将 t2/t3 派给邢自强/张明（DAG `deps:[t1]` 生效），t4 等待 t2+t3。
- **修复验证**：t1 仅 attempt 1 完成；Researcher 收到 t1「重复自动派发」消息后主动识别（claim 拒绝）并跳过——**无 attempt 膨胀、无风暴**，与修复提交 c4ebe67/0674088 预期一致。
- Researcher 产出含 40+ 来源、事实/口径/待核验三级标注、开放问题清单（北海核验码为关键案例）。

---

*观测记录 v3 · 2026-08-22 · t1→t2/t3 推进中*

## 观测点 9：状态感知机制缺陷（用户指出）

- **现象**：t2 于 22:14:16 完成（inbox 已有通知、活动面板实时显示），但我在写 Part C 期间未消费该通知，之后 status 轮询又恰好在 t2 完成前采样，导致长时间误判"t2 仍在进行"。
- **根因**：① 写文件期间未消费后台通知；② status 轮询是点采样，非事件流；③ 未同步检查 captain inbox 的成员完成消息。
- **改进**：成员消息/调度器通知到达 → 立即刷新 status；把"通知到达→状态同步"作为硬性行为；必要时检查 captain inbox。
