# A6 验收证据

A6 将离线安全性、状态恢复和发布回滚证据与真实 DSH Host/Web 证据分开。离线脚本只使用 `mkdtemp` 生成的 `/tmp` 目录，绝不读取凭据，也不写入 `~/.dsh/profiles/web`。

当前 A6 的实现和离线门禁已有证据；历史 Host 质量链因 reviewer 身份、task/quality attempt 和最终 output binding 审计降级，新的 output-bound 完整链路已在修复后的构建上通过。Host/Web 事实与限制见 [`A6-HOST-EVIDENCE.md`](A6-HOST-EVIDENCE.md)。旧摘要 [`evidence/A6-REAL-HOST-CHAIN.json`](evidence/A6-REAL-HOST-CHAIN.json) 保留为历史未核验；被审计的旧质量链见 [`evidence/A6-REAL-HOST-QUALITY-CHAIN.json`](evidence/A6-REAL-HOST-QUALITY-CHAIN.json)；第二次 fixed 运行见 [`evidence/A6-REAL-HOST-QUALITY-CHAIN-FIXED.json`](evidence/A6-REAL-HOST-QUALITY-CHAIN-FIXED.json)，但已标为 output-binding 审计失效；独立并发重叠的部分运行见 [`evidence/A6-REAL-HOST-PARALLEL.json`](evidence/A6-REAL-HOST-PARALLEL.json)；最终 output-bound Host receipt 见 [`evidence/A6-REAL-HOST-QUALITY-CHAIN-FIXED-OUTPUT-BOUND.json`](evidence/A6-REAL-HOST-QUALITY-CHAIN-FIXED-OUTPUT-BOUND.json)。

## 离线门禁

在仓库根目录运行：

```sh
pnpm build
node scripts/qa/a6-fault-matrix.mjs
node scripts/qa/a6-security-compat.mjs
node scripts/qa/a6-release-rollback.mjs
node --test test/a6-fault-matrix.test.mjs test/a6-security-compat.test.mjs test/a6-release-rollback.test.mjs
```

故障和安全 runner 输出 `schemaVersion: 1`、`kind`、`cases[]`、`passed` 和 `generatedAt`；发布 runner 输出 `schemaVersion: 2`，额外带真实 `.tgz` digest、隔离 `DSH_HOME`、`hostInstall` 和 `hostWeb` 状态。安全输出中的 `secretsUsed: false` 只表示没有读取真实凭据，同时 `sentinelInputsUsed: true` 明确测试使用了哨兵值。runner 失败时返回非零退出码；不能把跳过或缺少宿主的情况伪装成通过。

故障矩阵覆盖：

- staged plan approval 的 digest/revision CAS 冲突；
- 多短进程并发 claim/commit 的文件锁；
- 旧 attempt 消息拒绝；
- 损坏 JSONL mailbox 的跳过与继续追加；
- orphan running plan 的 kill/restart 恢复；
- halt/resume 的持久化守卫；
- QualityRun review 失败、repair 次数上限、重复 event 幂等和禁止提前 integration；
- 完整 team 目录归档；
- `shell: false` 的短生命周期命令注入检查。

安全与兼容矩阵覆盖：

- loopback、token、forwarded header 的授权边界；
- fake HTTP route 的 Origin/CSRF 校验；
- webless capability route 的 provider/model 可用性、fallback 和 namespace 约束；
- 缺少 A5 字段的旧 capability scope 迁移，默认 `maxDepth: 0` 且不扩大权限；
- 错误响应只返回白名单错误码，不回显 token、路径或 PEM。

发布脚本覆盖（真实包产物，隔离 profile）：

- 从当前 checkout 执行 `pnpm pack` 生成真实 `.tgz`，并计算整个 tarball SHA-256；
- 从该 tarball 重新打包一个带不同版本号的旧候选，避免用合成 manifest 冒充旧版本；
- 使用 `DSH_HOME=/tmp/... dsh plugin --profile a6-rollback add <tgz>` 安装到隔离 profile，读取实际 `node_modules` 版本；
- 篡改 tarball 后在调用 DSH 前由 digest preflight 拒绝，原已安装候选保持不变；
- 重新安装旧 `.tgz`，验证真正的 package-manager rollback，并恢复隔离 activation state 备份；
- 明确断言所有 profile、package、state 路径都在 `/tmp`，不访问 `~/.dsh/profiles/web`。

当前发布 runner 的 `hostInstall` 为 `PASS`，表示隔离 profile 的真实安装/回滚通过；`hostWeb` 保持 `BLOCKED`，因为发布 runner 本身不启动监听器。生产 `dsh-web.service` 已独立重启并复核单一 listener 与未授权响应；这不伪装成候选包启动前后回滚证据。另有独立的隔离 Web 同身份重启 smoke：见 [`evidence/A6-WEB-RESTART.json`](evidence/A6-WEB-RESTART.json)，它证明 cookie-backed Web 身份在同一 profile/端口重启后仍可访问 `/state`，但没有活动 plan/team，不能代替完整任务续跑。

## 真实 DSH Host/Web 链路

真实宿主运行必须由主 Agent 在明确选择的测试 profile 中执行，不得把生产 profile 当作临时目录。建议为每次运行建立唯一 `runId`，并保存以下证据目录（目录路径由主 Agent 注入，不由插件自行猜测）：

```text
a6-host-web/<runId>/
  manifest.json          # runId、hostVersion、pluginDigest、profile、startedAt
  commands.jsonl         # command、argv（脱敏）、exitCode、durationMs
  state-before.json      # .expert-teams 与 staged plans 摘要（脱敏）
  state-after.json
  events.jsonl           # plan/task/quality/halt/archive 事件
  host-log.txt           # 脱敏后的 DSH 日志
  web/                   # UI/API 响应或截图；没有浏览器时写 BLOCKED.json
  BLOCKED.json           # 仅在缺少真实 host/browser/provider 时使用
```

最小可复现链路：

1. `pnpm build`，记录构建产物 digest。
2. 在隔离 profile 安装本 checkout：`dsh plugin --profile <a6-test-profile> add .`。
3. 重启 DSH，确认插件 manifest、提示词版本和 `/plugins/dsh-expert-library/*` 路由可见。
4. 通过 Web 或 Host RPC 执行：preview → stage → edit → approve → dispatch 两个真正并发的任务 → review → repair → re-review → integrate → archive。两个任务必须有不同 owner/attempt 或可观测的并行时间区间；同一 lead 顺序调用不计入并发证据。
5. 在每个步骤记录 HTTP 状态、工具返回、`team.json`、staged plan journal、QualityRun event 和 artifact digest；重启一次后继续同一 plan，证明冷恢复没有重复 spawn。
6. 注入一次失败：让 review 返回 `needs_revision`，确认任务仍为 `in_progress`/QualityRun `blocked`，repair 后才允许下一轮；测试 halt/resume 与旧 attempt 消息。
7. 使用错误 Origin、forwarded header、错误 token 和不兼容 provider 做写路由探测，确认白名单错误码和无敏感信息泄漏。
8. 安装候选版本并故意篡改 staging digest，确认启动 preflight 失败并回滚到上一个 manifest/state；刷新 Web UI 后核对 active pointer、任务和审计事件。

若测试环境没有可控的 DSH Host、浏览器或真实 provider，必须生成类似下面的 `BLOCKED.json`，并把缺失条件和实际命令写清楚：

```json
{
  "schemaVersion": 1,
  "kind": "a6-host-web",
  "status": "BLOCKED",
  "reason": "no isolated DSH host/profile or browser was supplied",
  "required": ["isolated host profile", "restart permission", "browser or HTTP client"],
  "suggestedCommand": "pnpm build && dsh plugin --profile <a6-test-profile> add . && restart dsh"
}
```

`BLOCKED` 不计入离线矩阵的通过数；它表示对应的 runner 子项没有启动宿主监听器，而不是把其他真实 Host 证据伪装成通过。当前明确保留的限制是冷恢复后由原 worker 写入终态的证据；GUI 活动计划同身份重启续跑、output-bound Host chain，以及候选包 Host 启动/回滚均已有独立 PASS receipt。真正并发 DAG 的重叠 attempt 仍见 PARTIAL receipt。旧质量链事件不能与新的 fixed receipt 混用。

## 历史现场核对（legacy，不作为当前出口判定）

以下内容保留 2026-09-27 的只读现场核对，帮助解释早期摘要为何被降级；它不覆盖当前的 `A6-REAL-HOST-QUALITY-CHAIN.json`、`A6-HOST-EVIDENCE.md` 或当前 Goal 判定，也不构成当前 A6 的阻塞条件。

当时文档同时提到隔离端口 `127.0.0.1:3180` 和现有 DSH Web Host `127.0.0.1:3080`。后者不是隔离 profile 的证据；当时尚未提供 GUI 刷新、同身份 session/plan 续跑或独立成员并发时间线，因此旧摘要不能单独作为出口证据。后续真实 Host quality chain 和活动 Web/GUI 同身份重启 receipt 已分别补充；该段只描述当时的历史现场，不改变当前证据。

## 2026-09-27 只读现场核对（历史记录）

本次核对没有启动、停止或重启任何 DSH 进程，也没有访问生产 profile。`ss -ltnp` 当时只观察到 `127.0.0.1:3080`（`--profile web`）和 `127.0.0.1:3082`，未观察到 `127.0.0.1:3180` 或 `127.0.0.1:3181`；对 `3181` 的 HTTP 探测失败，`3080` 返回未授权响应。`/tmp/a6-web-private-20260927-*.log` 中的 `3181` URL 因此只能视为历史启动日志，不能作为当前 listener 或 GUI 证据。

同一只读核对还发现 `/tmp/a6-host-chain/expert-teams/a6-real-host-chain/team.json` 仍是 `t1=completed`、`t2=in_progress`、`t3=pending`，且 t1/t2 都由 `lead` 负责；`a6-real-host-chain-v2/team.json` 仍是 `t1=in_progress`、`t2=pending`、`t3=pending`。静态 [`evidence/A6-REAL-HOST-CHAIN.json`](evidence/A6-REAL-HOST-CHAIN.json) 当时缺少 owner、时间区间和事件日志，故已标记为 `UNVERIFIED_LEGACY_SUMMARY`；该历史差异不否定后续 receipt，也不把旧摘要升级为当前 Host/Web 证据。
