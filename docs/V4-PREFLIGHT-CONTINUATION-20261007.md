# V4 提交预检、来源回执和续跑修复

## 已实现

- writer 原子提交发布文件之前，调用与评审通过入口相同的证据声明、回执完整性、正文结构和台账检查。预检错误不冻结提交、不入账评审、不消耗内容修订次数。
- evidence-merge 精确列出两项并行研究输入；异常同时报告输入集与来源字段错误。
- 新来源类型 provider_receipt 保存 provider、团队相对响应/调用记录路径及各自 SHA256。Host 校验路径边界（含符号链接）、文件大小、哈希、调用时间、成功退出码及可用的 stdoutBytes。字节一致不是真实性证明：独立评审仍需核验来源、单位、口径及结论。
- 总论/卷首速览允许合法副标题；来源披露和收束句允许 Markdown 加粗，接受明确标识的小样本/快照状态；仍要求实质内容与来源状态。
- wait_external 是技术等待，不再入账 needs_revision；保留原因、调用指纹和评审身份，精确重试幂等。恢复原因变化后由队长续接，不能借此完成任务。
- 内容修订默认阈值仍为 2，允许在计划内配置 0–20。达到阈值须明确用户决策。
- 新 captain-only quality_continue 入口仅对 V4 已 escalated 任务生效，校验预期 run、占用、显式用户决定、有限追加轮数；保留旧 run、旧 closeout、旧输出与全部发布件，原任务开启下一 attempt。它不产生 pass，不放行人工门。
- 旧 writer prompt 原字节保留（a00c1f53…）；新计划绑定独立的 writer-v4-preflight prompt，避免造成存量冻结材料漂移。

## 回归

全量构建通过。本轮定向测试 65/65，覆盖新回执/越界/字节漂移、技术等待不扣预算、续跑权限/历史/重试/过期状态、V3 兼容、V4 原子提交/评审、quality 状态机与 profile。

## 真实试跑

团队 v4试跑-上海租赁证据复核-01，原队长 session-74cd0a6e-271b-4426-8e13-9251fb198390。
原 attempt-3 冻结三件哈希一致。生成独立技术修复候选目录 artifacts/technical-recovery-20261007：正文原字节保留，只修证据声明和台账 evidenceSha256；预检进一步发现正文第四章 32.31% 引文漏登记，需作者补齐后独立复核。未将内容视为通过，未改冻结件。

恢复由 scripts/maintenance/v4-preflight-continuation.mjs 通过原队长原生工具执行；回执 /tmp/v4-preflight-continuation.json。T6 保留人工确认，T7 保留独立交付评审。构建和测试日志位于 work/v4-preflight-fix-20261007/。
