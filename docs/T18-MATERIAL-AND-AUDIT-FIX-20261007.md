# T18 材料回执与审计链修复 · 2026-10-07

## 根因

T18 attempt 2 已有真实 producer 材料回执 a9af8beb-b030-4d2b-83b5-7ac1c5d19daa，sessionId 为原 captain，accepted=true。quality_review 入口却只查 team.members 找作者，captain 不在该表中，实际传空 sessionId，误报 TASK_BINDING_DELIVERY_REQUIRED。更换或补造回执不会解决身份查找错误。

## 实现与验证

src/tools.ts 的冻结任务材料校验使用 captainSessionId 处理 captain 作者，与现有 craft 作者校验保持一致。普通成员仍按真实成员 sessionId 校验，没有放宽材料、轮次、摘要或独立性约束。

11/11 定向回归与完整构建通过。新增测试覆盖有效 captain 回执、缺失回执、错误会话、旧轮次，以及作者禁止自评。日志位于 work/t18-closeout-20261007/{tests,build}.log。

## 清单更正

从 T1/T2/T3 已入账 review/integration 事件获取六个 ID；评审人段逐节点生成，避免把 T10/T13 等节点按作者或旧分组误认成评审人。t5/t14 单列为用户门。修正仅作用于新的 delivery-check.md 发布版本，原报告和历史发布字节保持可追溯。

初始差异见 work/t18-closeout-20261007/correction-evidence.json。正式发布使用原队长的 quality_reopen（撤回未审提交）、publish_artifact、update_task 与 send_message 工具；维护插件不提交评审 verdict、不直接写 team.json。后续仍由原非作者独立评审。

## 验收

2026-10-07 01:55:54 部署至 PID 1685105。原队长原生 resume、quality_reopen、publish_artifact、update_task、send_message 五步均返回成功。正式发布件 a8a5dc5b-aa2c-4bd3-9978-60b13f06807e，SHA256 3504d6547b058bdf3239e62dd31a2a175924e634b0da98ff2524e7d09344ff6c（14,511B），逐字节重算通过。T1–T3 六个事件 ID 和 17 个已评审节点的评审人均与 Host 记录一致。attempt 2 与 attempt_id 保持，repairRounds=0；旧发布件保留。证据见 published-verification.json、native-repair-receipt.json。

原非作者能级参谋已于 02:01:20 成功执行线上 prepare_only，生成当前第 2 轮的新 reviewer 回执 c23ec224-e866-4c75-8811-df30f6221215（accepted=true，绑定当前材料摘要与产物摘要）；时间晚于新发布件，原错误已解除。见 live-verification.json。两项修复完成；独立评审结论与最终集成仍需正式流程，不将准备成功当作评审通过。图像审美与实印仍待验收。
