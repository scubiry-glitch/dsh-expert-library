# 98wiki t7 目录查询与中断恢复

## 范围和授权

- 用户在当前 Codex/Lark 会话明确要求修复指定团队的 t7。
- 队长：`session-bdf4fe75-fc8d-4cde-90d7-78f7d84ffd0f`。
- 成员：`aa995166-37ad-4ea2-bcbe-52f16b608804`。
- 原 attempt：`f9d5668d-f528-4d2c-98af-1113e555535d`。
- 仅授权 `realestate.indicators.catalog`；不扩展其他数据能力，不代替质量评审。

## 定位

1. 原成员日志在 17:23:28 的 step/start 中断，之前的工具调用均已返回。
2. 团队权限已补齐，但旧子会话的不可变 descriptor 仍缺 `expert_provider_call`。
3. 在恢复后接收评审邮件时，成员再次留下 `taskAttempts: []` 的 activation。原恢复工具只清除任务 dispatch，无法释放这种冷成员的邮件占位，导致工具返回成功但没有新派发。

## 修复

- `scripts/maintenance/t7-catalog-recovery.mjs` 是限定队长、成员、任务及现存授权回执的本地运维修复插件，无 HTTP 入口。
- 用宿主的成员初始化接口注册已授权的 provider 工具；保留成员最终执行守卫、任务 capability 和 provider 审批限制。未修改历史会话日志或原批准计划。
- 用 `expert_teams_resume_task` 恢复；旧文档仍引用“未暴露工具”时，通过原队长正常 quality reopen 退回补证。
- `resumeRuntimeMember` 增加经调用方确认的冷成员分支；`resume_task` / `resume_member` 仅在宿主不存在对应活动 Agent 时启用，释放孤立 activation。陈旧 blocker ID 仍拒绝且不修改状态；活动成员占位保持原行为。

## 验证与回执

- 成员权限和 profile 原有定向回归：28/28 通过。
- 新增调度回归：冷成员邮件占位须显式恢复、同一 attempt 重新派发、活动成员不释放、陈旧 blocker ID 不改状态。
- 构建通过；调度与成员权限回归合计 35/35 通过（`/tmp/dsh-t7-regression.tap`）。
- 运行时回执位于目标团队目录的 `catalog-runtime-recovery.jsonl`、`catalog-runtime-resume.json`、`catalog-runtime-guidance.json`。
- 18:58 已出现真实新 turn 和包含 provider 工具的请求 header；这不等同于目录调用成功。
- 实际目录回执及最终评审状态以成员日志和发布产物为准，未完成的验证不得标通过。
- 19:07:36–19:07:40（UTC+8），原成员 turn 9 的 seq 615/616 完成真实 `expert_provider_call` 调用，返回 `zyt::zyt.indicators.catalog 成功`。仍为原 attempt 1。
- 实际返回保留 `provenance.unit.missing`；单位尚待确认。工具展示文本有长度限制，不能当作完整指标目录或四城时序。
- 已从真实日志提取独立证据 `catalog-recovery-evidence.json`（目标团队目录），含调用参数、事件序号、实际时刻、返回文本及 SHA256。运行恢复和调用验证已通过；修订预检的最终质量验收仍由原队长流程负责。

## 生命周期

运行时 profile 的 `cordis.patch.yml` 含 `t7-catalog-recovery` 条目；原配置已另存备份。任务关闭后该插件不再恢复或给成员补挂工具，可在下次计划维护时移除此条目。不要为移除空闲插件而打断正在运行的其他任务。

## 继续推进：评审恢复与研究授权

用户确认继续推进后，运行时条目已由 `rent-research-recovery` 替换，源码为 `scripts/maintenance/rent-research-recovery.mjs`；旧插件不再同时加载。

- t7 修订版：`e2f6072c-0330-48ef-98e5-cb8c7f12f9d6`，SHA256 `e934815e069785038117004457556bf4539b1f444a5f1a673859cf379dbcf6b3`。
- 19:16，正式 `expert_teams_resume_member` 返回评审者恢复成功；原评审成员出现新的工具调用，读取契约及回执，待其真实 verdict。
- t9：catalog、indicators.timeseries、rent.search。
- t8：catalog、indicators.timeseries、rent.search、policy.search。
- t10：catalog、indicators.timeseries、city.compare。
- 能力均为已注册的只读取数能力。额外的当前任务检查确保 t7 在下游授权后仍仅能调用 catalog，pending 研究任务不得提前调用。6 项针对性断言通过。
- 授权变更记录：团队目录 `research-capability-amendment.json`；备份 `team.json.before-research-grants-*.bak`；实际恢复记录 `research-runtime-recovery.jsonl`。
- 原队长已收到执行顺序：先正常审核和集成 t7，再由 t9 进行一次上海 rent_index 时序校验，确认单位/统计期/成交口径后再扩展四城；复用旧探针，不重放相同失败。
- 本次运维修复没有更改任何质量 verdict 或人工门控结果。
- 19:17，独立评审完成，由原队长调用 `expert_teams_quality_integrate`（event `integrate-t7-a1-captain-v31-006`）正式集成；t7 已 completed / quality integrated。
- t8、t9 已领取研究任务；19:19 t8 已提交待审，t9 正在执行，t10 等待调度名额。
- t9 实际时序调用：上海 `rent_index` 空序列；上海 `ke_rent_index` 返回 24 期，2024-08 至 2026-07，仍有 `provenance.unit.missing`，不得当作已确认单位或已覆盖 2026-09。
- 另发现 `realestate.rent.market` 合同字段 `city/period` 与底层 `beike.rent_house_search` 的 `city_name/query` 不匹配；记录为参数适配问题，不解释成数据缺失。本轮已将研究推进到可用指标时序路线，适配问题尚未修复。
- 实际调用序号、返回摘要、哈希及状态快照存于团队目录 `research-recovery-evidence.json`。

## t11：下游验收误选同轮旧发布（2026-10-06）

- t11 attempt 3 已正确冻结 t8 的第二个同轮发布 `1df0d1db-7ef1-4604-ac4b-c5f60cfa00c8`（`ee698483…`）。Host 的 `inputText` / `inputBytes` 却先按 attempt + reviewId 执行 `find`，选到第一个旧发布，报 `DEEP_RESEARCH_INPUT_NOT_PINNED`，导致独立评审无法入账。
- 通用修复：两条读取路径共用 `pinnedInput`，按唯一上游逻辑任务、下游显式 artifactId 及发布名解析；多重绑定拒绝。之后仍由 `readAllowedTaskArtifact` 校验依赖、发布身份、冻结 manifest、路径边界和实际字节。锁定的输入不因出现更新发布而漂移。
- 新回归覆盖同一 attempt 三个版本锁定中间版本，以及缺失绑定、重复绑定、多版本同时绑定、非依赖、manifest 变更、上游逻辑身份冲突、文件篡改。构建通过；deep-research-gates + dependency-inputs 合计 20/20 通过，见 `/tmp/t11-pinned-tests.tap`。
- 对真实团队只读执行完整 `checkDeepResearchPass`：PASS。t11 仍为 attempt 3，artifact `7d477e93-f9a1-4496-a34a-2f2d5f4979ce`，SHA256 `e3e3e922c96309bcecaacb32e830c24e7a5fe92475bd816e83d8eeb06bd84480`。回执在团队目录 `t11-pinned-input-host-check.json`。这是 Host 校验，不是质量审批。
- 运维插件增加一次性恢复通知，请原独立评审者核对字节后重试其原失败事件，再由队长正式集成。通知回执为 `t11-pinned-input-recovery.json`；未新增绕行任务、未增加修复预算、未改动产物或质量结论。
- 全局尚未完全收口：旧会话缺 provider 工具的恢复仍依靠本团队运维插件；贝壳租赁/政策参数适配问题仍待修复。不能将 t11 版本解析修复称作全部问题根治。
- 20:52–20:53（UTC+8），原能级参谋核验实际字节后，以原失败 event `review-t11-repair-a3-indep-tier-20261006` 成功提交 PASS；原队长随后正式集成。t11 已 `completed / quality=integrated`，仍为 attempt 3；t12 已 `claimed / active`、attempt 1。质量事件及状态快照见团队目录 `t11-pinned-input-recovery-evidence.json`。

## 通用收口：旧会话权限、冷评审唤醒和贝壳参数（2026-10-06）

- `members.ts` 的统一生命周期现在按完整 durable 身份恢复旧成员的 `expert_provider_call`：只在 durable scope 明确授权、历史 descriptor 的 allow 列表遗漏该工具、且没有显式 deny 时，将原队长的受控定义注册到子会话。保留历史 descriptor；父队长、模型和根目录身份校验继续有效；缺工具则失败，不静默启动残缺成员。此逻辑没有团队/会话 ID 特判。
- `provider-tool.ts` 每次调用重新核验 durable tool 授权，计划能力只从 claimed/in_progress 的已分配任务取并集，pending/completed 任务不再借出能力；原 provider、task 和写操作审批守卫保留。
- `resume_member` 对仅有孤立 activation、没有 runtimeBlock 的冷成员，显式恢复时也补发幂等恢复通知，解决“释放占位但邮件已读，无新消息可唤醒”的尾部问题。活跃进程仍不会被擅自释放，陈旧 blocker ID 继续拒绝。
- 贝壳线上 `tools/list` 核实租赁与政策工具使用 `city_name/query`；`beikeMCPCallParams` 将 dataset 的 city/topic 转换为原生字段，保留自然语言条件及租赁 business_types，冲突城市、错误类型和未知结构化条件在网络请求前拒绝为 `INPUT_INVALID / retry:never`。
- 租赁 period 仅作研究参考期，不伪装成历史过滤。返回 caliber 明示“当前在租挂牌房源检索；非成交租金统计、非历史快照”，并保留 unit 缺失警告；dataset 描述同步说明能力边界。
- 完整构建通过；8 个定向套件共 137/137 通过（`/tmp/provider-systemic-final-tests.tap`），含冻结输入版本、冷成员、权限撤销、调度、真实工具执行路径、参数适配与错误零网络请求检查。
- 构建后的完整 provider 工具 + dataset gate + transport 路径，真实调用 `realestate.rent.market` 与 `realestate.policy` 均 ok=true；原始回执存团队目录 `systemic-provider-live.json`（只读诊断取数，不自动晋升为已审报告证据）。租赁仍有挂牌/历史边界和单位缺失警告；这些数据限制没有被删掉。
- t12 没有运行故障：独立评审发现 numericClaims 漏 7 项及三透彻 51.1% 缺可复算分母，正式退回 attempt 2；作者补稿后独立复审通过，由原队长集成，t12 completed/integrated，t13 已开始。状态证据在团队目录 `systemic-fix-validation.json`。
- 团队运维脚本中的 `installContinuableMemberSetup` 与 provider 注入已删除；接下来的一次服务重载只做核心恢复验证及原团队工作续接。部署后验证以 `systemic-runtime-recovery.json` 为准。
- 21:12（UTC+8）`dsh-web.service` 重载成功，PID 1349998。核心恢复后旧作者会话实际 `request/header`（seq 1697）包含 `expert_provider_call`；`systemic-runtime-recovery.json` 记录 `toolVisible=true, maintenanceToolInjection=false`。转轨师傅的重载中断也经原 `resume_member` 恢复，同一 t13 attempt 1 续接。
- 验证后已从运行 profile 的 `cordis.patch.yml` 移除一次性 `rent-research-recovery` 条目（原配置有本地备份）。无需再重启正在继续工作的团队；下次启动只使用核心恢复逻辑，不加载团队特判注入。
- t13 内容复核后，原队长正常创建 t19 正文补充任务；t12 仍 completed/integrated，没有倒退或被 Codex 改写。t14 人工正文门保持未批准。

## T13/T19：正式修订输入交接（2026-10-06 晚间）

- T19 已发布的 report.md `5f7f8765…` 和 ledger `3d6f4364…` 经独立评审 PASS；T13 本地 review-notes `c4e56dcc…` 也确为 PASS。以四个完整参数执行 `checkContentReview(notes, report, outline, ledger)` 通过；该纯函数不读取 task 状态，不应将省略参数造成的错误归因于 awaiting_review。
- 阻塞包括两个独立条件：T13 的 awaiting_review 禁止补发布；它的固定输入仍为已集成 T12 旧稿。quality_reopen 只能处理待审状态，不能更换输入来源；resume_task 明确拒绝待审任务。旧稿、新稿不能只按文件名替换。
- 原队长已通过原生 resume 恢复，队长信箱投递真实返回 accepted；随后由原队长正式集成 T19（completed/integrated）。mailbox-recovery-exhausted 表示重试耗尽，不单凭此事件断言网络掉线。本次恢复不改变 captainSessionId。
- 新增 captain-only `expert_teams_revise_inputs`。要求替代源有明确修订依赖且当前轮次 completed/integrated；消费者未结束、未触碰人工节点、当前质量轮次未评审，持有 expected attempt/capability，成员无活动 turn/activation。校验在克隆状态执行，失败无部分写入。
- 操作保留原计划、T12 产物、旧输入 manifest、旧评审与修复预算，以审计回执记录逻辑角色到替代物理任务的映射。已启动的消费者撤销旧 attempt_id，为下一 attempt 冻结新输入；未启动的消费者先锁替代来源，其他依赖仍按原门控等待。源字节、审核证据、依赖关系、路径和摘要仍逐项验证。
- 深度研究读入通过已审计的 logical-role override 查找固定发布，拒绝无回执、摘要漂移或隐式“最新稿”。并非修改 t12 的发布物或伪造 t13 verdict。T15/T16 也必须绑定新正文，避免 t13 修好后下游再次退回旧稿。
- 构建通过，相关5套回归61/61通过（`/tmp/input-revision-regression.tap`），涵盖正常新轮次、旧能力失效、幂等、活动成员、未集成源、无修订关系、循环、终态、显式选择、字节篡改、成员越权、人工门保留及深度研究输入锁定。
- 真实团队只读 admission 检查：T13 下一轮=2，锁定 T19 report+ledger、T6 OUTLINE、T11 evidence；T15/T16 下一轮=1，锁定 T19 report。部署服务 PID1398226，21:55:14（UTC+8）。原生工具执行回执以团队目录 `t13-input-revision-runtime.json` 为准；发布与评审结果另核验，不把工具放行当作内容验收。
- 三项原生输入修订实际执行成功：t13 已进入 attempt 2，t15/t16 保持未启动；t14 未批准。T13 attempt 2 正文发布 `88a68f70…` / `5f7f8765…`，评审笔记发布 `46210fcb…` / `58d6ef33…`。笔记仅将旧轮次/输入描述更新为新 attempt 与确切 artifact ID，实质复核结论未变。完整 Host 只读校验 PASS，回执 `t13-input-revision-host-check.json`。
- **队长生命周期根因补充**：原生 `agents.resume` 的 ownerCtx 持有其完整 live lifecycle；卸载运维插件会释放该插件恢复的顶层队长。此前“验证后移除恢复插件、不用重启”的做法对该队长并不安全。21:57 后成员新回报留在未读信箱；22:01:30，在同一服务 PID1398226 下以保留的 owner 插件恢复原队长，两封邮件投递 accepted 并启动原队长 turn83、进而启动独立评审。
- 当前 profile 保留 `t13-captain-recovery`（`scripts/maintenance/t13-captain-recovery.mjs`）作为该原队长的运行时 owner；**团队运行期间不卸载它**。启动时恢复同一 session；既有 completed 回执会跳过三项输入修订，仅补投未读邮件，不重复改轮次、不接管身份、不改质量。后续若迁移到原生常驻配置，必须先完成生命周期交接，不能直接删 owner。`captain-owner-retained.json` 为真实投递记录。
- 最终实测闭环：T13 attempt2 独立评审事件 `review-t13-a2-indep-tier-20261006`（能级参谋·城市分化），原队长集成事件 `integrate-t13-a2-captain-v31-013`；T13/T19 均 completed/integrated。T14 保持 pending、无 humanChoiceReceipt，待用户选择“进入点睛图”；T15/T16 仍 pending。最终状态与摘要快照：`t13-t19-recovery-validation.json`。
