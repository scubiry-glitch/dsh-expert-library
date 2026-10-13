# T16 Host 机检通道修复（2026-10-07）

## 根因与复现

冻结发布包 `skills/*/scripts/check.mjs` 使用 `for await (const part of process.stdin) raw += part`，每块 Buffer 独立 UTF-8 解码。中文跨块边界被替换字符损坏，输入 JSON 仍可能合法，但内容哈希不再匹配。直接 import runSelectedChecks 绕过 stdin，所以不能覆盖这个缺陷。

真实 T16 attempt 2 已发布物：旧完整 Host 子进程通道 8/8 failed，统一报 `V2 input invalid: artifact bytes/hash mismatch`；修复后同一通道 8/8 passed。冻结包、产物、SHA256 未修改。证据见 `evidence/t16-transport-before-after-20261007.json`。

## 修复

- Host 验证原始 artifact bytes 后统一用协议已有的 base64 编码传输，SHA256 不变。
- JSON 元数据转为标准 ASCII Unicode 转义，避免中文 ID、原因、路径、emoji 的分块问题。
- 保留包、脚本、输入哈希与资源上限校验，未跳过机检。
- 队长新增 `expert_teams_quality_host_recheck`：仅接受当前 blocked 的已审轮次，旧失败必须全部是上述已诊断的传输错误，且无其他实质 hard finding；当前文件、合同、评审域原文都不变，全套 Host 机检重新通过后才进入 reviewing。
- 不变更 attempt、修复预算、产物，不覆盖失败评审、不伪造 pass。重新评审仍由绑定设计评审者执行，完成后原队长才能集成。
- 复验事件幂等，保留完整新机检回执及旧失败事件引用。无关报告缺陷、文件变化、仍失败的检查均拒绝恢复。

## 验证

- 包含单字节拆分中文/emoji/CRLF 的真实子进程回归。
- 传输与质量状态机源代码回归：55/55 passed。
- 真实 collectTaskEvidence 完整 Host 链路预演：8/8 passed，attempt 2、repairRounds 0，旧评审未变。证据见 `evidence/t16-host-collector-recheck-20261007.json`。
- 完整 pnpm build 通过；构建产物的传输/状态机/注册工具/旧修复流程 72/72 回归通过。
- 线上恢复结果仍待原队长调用正式复验接口，预演不等于独立评审通过。

## 线上正式恢复

00:17 原队长成功调用 expert_teams_quality_host_recheck，Host 8/8 passed。T16 从 blocked 进入 reviewing，attempt 2、repairRounds 0；原 needs_revision、false acceptance 与 hard finding 全部保留，等待绑定设计评审者的新真实判定。正式回执见 evidence/t16-host-recheck-live-20261007.json。

00:22 线上最终核验：原 design-critic 提交新 pass 评审，原队长正式 quality_integrate，T16 已 completed / integrated；reviewRounds 2、repairRounds 0，原失败评审与 Host 复验回执完整保留。该结论仅覆盖 T16 通道恢复，T17/T18 仍按原 DAG 继续。

00:23 后续调度核验：T17 已 claimed / active、attempt 1，绑定设计评审成员 running；T18 仍 pending。真实视觉覆盖保留待验收。
