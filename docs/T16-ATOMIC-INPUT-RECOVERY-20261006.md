# T16 输入换绑与阻塞恢复（2026-10-06）

## 根因

T16 外部阻塞等待 T15→T20 图卡换绑，旧 revise_inputs 拒绝 blocked_external，而 resume_task 清除阻塞后立即派发旧图卡，形成恢复与换绑竞态。

## 实现

- 原队长的 expert_teams_revise_inputs 增加 expected_wait_reason，必须精确匹配当前外部等待原因。
- 在团队锁内克隆状态，校验原 attempt、成员空闲、修订谱系、两版已集成评审、冻结工艺完整性及新输入真实字节；全部通过才写入同一次团队状态。
- 历史输入、评审、修复预算保留；新输入进入下一 attempt。成员 runtime block、人工门及质量门不能由此绕过。
- 失败不改变原阻塞和输入。精确事件重试幂等；重试同时修复任务输入投影，处理主状态写入成功但投影同步中断的情况。
- 旧 DAG 与新 compact v4 均保留；本次只恢复原团队 T16。

## 验证

- TypeScript 编译通过。
- 定向回归 39/39：input-revision、dependency-inputs、quality-resubmission-recovery。
- 真实团队只读预演通过：下一轮 attempt 2；输入为 T19 正文、T13 审核意见、T20 图卡/规范、T6 提纲。
- 正文 SHA256 5f7f87652cbbe092414b226f53b4a24ec1681c85c1ad0b25f9177e8c3a008ea5。
- T20 图卡 SHA256 93482973bce16d6490209a66bc61a4d019669ca3490eaee24d58e41d4064ed8a。
- T20 规范 SHA256 2bec9601702314f8a83125ddc93e08eab2dc030fa1f3446e837c213c6ee044ea。
- 上线验收：23:30 原队长成功调用原子换绑；T16 第 2 轮进入 active，阿妙原成员会话 running；真实 manifest 已绑定 T20 两份新图卡材料。正式产物、评审与 T17/T18 完成仍待后续实际运行。

## 评审角色提示修复

线上恢复后发现旧流程状态操作把渲染评审提示给普通研究专家，实际门禁却只接受绑定的 design-critic。已将 v2/v3/v4 渲染任务的操作提示与门禁共用角色判定；非设计评审者只看到指定评审者的等待提示，旧版仍由队长集成。相关 37 项回归通过。该附加提示改动已构建，并随 23:43:38 的外部服务重启加载（PID 1524961）；当前评审已由队长正式改派到 design-critic。

## 真实推进证据

23:35 T16 attempt 2 五件套全部正式发布，逐件实际字节 SHA256 与发布记录一致。正文 5f7f8765…、HTML 35097216…、PDF 266ef5ab…、craft-evidence 3ffdb52c…、reference-map b3eacdec…。包内三项检查与八项预检通过。23:37 正确绑定的 design-critic 已开始独立评审，T17/T18 仍按依赖等待。不能把自动检查通过当独立评审通过。

## 重启造成的第二类停滞

23:31:44 与 23:43:38 均发生本次恢复操作之外的服务重启，先后中断作者提交和设计评审。第一次已由原队长通过正式 resume_member 续做并完成五件套发布。第二次增加当前旧团队启动恢复通知（legacy-team-restart-recovery）：每个 PID 最多一次，只识别有 activation / HOST_RESTART_UNCONFIRMED 且无 live agent 的原成员，只通知原队长核对后正式恢复；不持有 agent、不改任务状态、不自动放行。23:46:42 实际识别毒舌·尖尖中断 activation 并通知原队长，保留 T16 attempt 2 与所有已发布文件。该插件仍需保留到原团队完成，之后可以移除；t13-captain-recovery 持有原队长，不能直接移除。
