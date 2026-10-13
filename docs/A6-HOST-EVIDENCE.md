# A6 DSH Host/Web 证据

本证据来自隔离 profile，未修改生产 `web` profile，也未把任何凭据写入仓库。

## Web Host smoke

隔离 Web Host 使用 `/tmp/a6-dsh`、本地插件 symlink，端口 `127.0.0.1:3192`。同一 profile/端口重启前后，用同一浏览器 cookie 检查结果：

| 请求 | 结果 |
| --- | --- |
| `/` | `200`（cookie-backed browser session） |
| `/plugins/dsh-expert-library/skills` | `200` |
| `/plugins/dsh-expert-library/state` | `200` |
| `/plugins/dsh-expert-library/teams?captainSessionId=missing` | `404`（定域失败） |
| POST `/plugins/dsh-expert-library/teams` with foreign Origin | `403`（CSRF fence） |

重启前后 `/state` 都是 `200` 且返回空的 `teams/plans`。证据 receipt 见 [`evidence/A6-WEB-RESTART.json`](evidence/A6-WEB-RESTART.json)。这证明插件在真实 DSH Web Host 中加载，静态资源、活动状态和 wire route 均注册；未知会话不会被解析成团队。该 smoke 没有活动 plan/team，因此不等同于同一活动任务续跑。

## Headless end-to-end

历史一次真实 DSH headless 运行在 `/tmp/expert-teams` 完成了 plan stage、CAS approve、真实成员 spawn、质量事件写入和归档。原始 receipt 见 [`evidence/A6-REAL-HOST-QUALITY-CHAIN.json`](evidence/A6-REAL-HOST-QUALITY-CHAIN.json)，但该 receipt 已在 reviewer 身份审计后标为 `INVALIDATED_AFTER_ADMISSION_AUDIT`，不能作为当前通过证据。计划为 `plan-ep-063fe9f3913f6de6`，队伍为 `a6-host-short`，归档目录为 `/tmp/expert-teams/archive/a6-host-short`。

这次链路的质量事件可逐项核验：t1 的 `review-t1-1 → integrate-t1-1`；t2 首轮 `review-t2-1` 以 `needs_revision` 拒绝并记录 hard finding `missing-runtime-proof`，随后 `repair-t2-1 → review-t2-2 → integrate-t2-1`；依赖 t1/t2 的 t3 完成 `review-t3-1 → integrate-t3-1`。但运行时当时只接受了 captain 传入的 reviewer 字符串，未绑定真实 reviewer session；同时 captain takeover 后 task attempt 与 quality attempt 发生偏离，旧实现未拒绝该情况。事件可作为缺陷复现材料，不能作为独立审核通过。

第一次真实并行运行 `/tmp/a6-parallel-run-20260927b` 仍保留为独立并发证据：它记录了 `worker-a` 与 `worker-b` 对无依赖 t1/t2 的重叠 attempt（`d36ac947-eef0-45d0-b4a8-beeb3c69c9bd`、`643c6a89-8da2-489f-934b-239153004c85`），但质量阶段超时，明确标为 PARTIAL，不能单独当作完整闭环。

完整链路的历史运行在同一 captain session resume 后需要宿主接管；该运行只保留为缺陷复现。第二次隔离 profile `a6-host-fixed` 运行已验证真实 reviewer 和 attempt admission，但因 review snapshot 与最终 task output 不一致已标为 `INVALIDATED_AFTER_OUTPUT_BINDING_AUDIT`，保留为缺陷复现。随后在 output-binding 修复后的构建上完成新的真实链路，独立通过 receipt 为 [`evidence/A6-REAL-HOST-QUALITY-CHAIN-FIXED-OUTPUT-BOUND.json`](evidence/A6-REAL-HOST-QUALITY-CHAIN-FIXED-OUTPUT-BOUND.json)。

运行中发现并修复了 repair re-review 的 attempt 传递缺陷、reviewer 身份和 task/quality attempt 未绑定，以及 review 后最终 output 可被静默替换的问题；修复位于 `src/quality-runtime.ts`、`src/tools.ts`、`src/state.ts` 与 `src/types.ts`，并有 `quality-runtime`、`a6-quality-admission`、`a6-message-finalization` 回归测试。Headless 临时 profile 首次缺少 provider 凭据时按预期 fail-closed；随后通过宿主凭据服务的已配置引用运行。证据文件不记录 token 或 key。当前并行运行的可复核摘要见 [`evidence/A6-REAL-HOST-PARALLEL.json`](evidence/A6-REAL-HOST-PARALLEL.json)，它只证明重叠 attempt；新的 output-bound Host receipt 已归档并通过最终一致性核对。

## 最终运行时生效

最终构建后已通过受管 `dsh-web.service` 重启生产 DSH `web` Host；复核时只有一个 `127.0.0.1:3080` managed listener，未授权 `/` 与 `/plugins/dsh-expert-library/state` 均返回 `401`。生产 profile 配置未被临时测试覆盖，浏览器现在可以刷新加载新 client bundle。
