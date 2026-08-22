# V2 Expert Library — Architecture Gap Audit (read-only)

Repo: `/root/zhijian/dsh-expert-library` (main). Date: 2026 (audit). No source files were modified.

Verdicts: **OK** = works end-to-end · **partial** = mechanism exists but is not enforced/surfaced · **missing** = declared but not implemented.

---

## 1. Quality gates — are V2 quality phases enforced at task completion?

**Verdict: missing (library-only).**

- `runQualityChain()` exists and is fully implemented (`src/v2/quality.ts:418`), with deterministic gate ordering, hard-fail delivery block, and ≤2-round targeted repair. Builtin evaluators exist (`src/v2/builtin-gates.ts:323`: `schema-structure` / `data-citation` / `compliance-anonymization` / `style-lint`).
- **Nothing calls them.** A repo-wide grep for `runQualityChain|createBuiltinGateEvaluators` finds only their definitions, one doc reference in `src/v2/types.ts:668`, and unit tests (`test/v2-quality.test.mjs`, `test/v2-builtin-gates.test.mjs`). No runtime import.
- `expert_teams_update_task` (`src/tools.ts:763`+, execute body ~`:791–857`) does attempt validation, transition checks, compensating commit — and **zero gate evaluation**. `status=completed` is accepted with any `output`.
- The header of `src/v2/types.ts:11` says it plainly: *"Nothing here is wired into the Host registration or the UI yet."*
- Consequence: the Zhijian compliance/anonymization promises (blocked identities, null≠0, citation-required, word limit) are currently enforced only by prompt text in member personas, and the "匿名渲染" step is a *member task* in the framework DAG, not a deterministic check. A member can complete the render task with real names leaked and nothing stops it.

**Fix (one line):** wire `runQualityChain` with `createBuiltinGateEvaluators` into the `completed` transition of `expert_teams_update_task` (artifact = task output; on hard-fail reject the completion or auto-open a repair reassign).

## 2. Capability scoping — does expert_provider_call enforce allowedCapabilities?

**Verdict: missing.**

- `executeProviderCall` (`src/host/provider-tool.ts:186–194`) resolves with `constraints: { availableCredentials, readOnly: false }` only. There is no member/task/plan identity in the constraint set; `CapabilityResolver` constraints (`src/v2/provider-runtime.ts:962`) support only credential/readOnly gating.
- `allowedCapabilities` exists on the V2 task template (`src/v2/types.ts:557`) and is checked **at compile time** for tool-input refs (`src/v2/compiler.ts:693–694`), but every shipped template sets it to `[]` (`src/v2/zhijian-pack.ts:385,400`; `src/collab/templates.ts:49`; `src/v2/compat.ts:190`) and the compiled plan's capability list is **never consulted at call time**.
- The tool knows which agent is calling (`exec.agent` → `findTeamByParticipant`, used at `provider-tool.ts:238` for the audit event), so the lookup plumbing already exists — it just isn't used for authorization.
- Net effect: any member of any team (or the captain) can call any registered capability, including write capabilities (gated only by approval, not by role/task scope). `toolPolicy: { allowed: [] }` in scenarios (`zhijian-pack.ts:535`) is decorative.

**Fix:** in `executeProviderCall`, resolve caller → team → task → plan `allowedCapabilities` and reject with a never-retry `CAPABILITY_NOT_ALLOWED` before binding.

## 3. Knowledge providers — served at runtime or declarative-only?

**Verdict: partial.**

- Pack declares both (`src/v2/zhijian-pack.ts:541–561`): `local-knowledge` (kind `files`) and `zhijian-expert-memory` (kind `database`, capabilities `search/read/cite/history`, `freshness: monthly`).
- `local-knowledge` **is effectively served**: `knowledgeGuide()` (`src/knowledge.ts:104`) builds a directory listing injected into member personas at spawn (`src/team-core.ts:294`); members read files with their own tools. But note it is served *by workspace convention* (`config.knowledgeDir`), not by resolving the plan's knowledge bindings — the compiled `knowledgeBindings` are not consumed by the apply path at all.
- `zhijian-expert-memory` **is declarative-only**: there is no database, no search tool, no runtime query path. Its content (expert profiles) reaches members only because personas are baked from `ZHIJIAN_EXPERTS` at build time — the "monthly deltas" provider advertised in the manifest has no serving mechanism, and scenario `knowledgePolicy.required: ['zhijian-expert-memory']` (`zhijian-pack.ts:533`) cannot actually be satisfied by anything.

**Fix:** either ship a minimal read/search seam for expert-memory (e.g. a host-side query over the generated experts JSON exposed as a member tool) or downgrade the manifest to reflect persona-baked delivery.

## 4. Provider failure observability — Web UI or audit log only?

**Verdict: partial (the intended event path is dead; no audit read path).**

- The tool emits an `expert-teams/provider-called` team event with code/correction/retry (`src/host/provider-tool.ts:206–249`) — good design. **But** `appendTeamEvent` silently drops any event type the running harness doesn't recognize (`src/events.ts:44–53`): the installed `dsh-session` `KNOWN_SESSION_EVENT_TYPES` contains no `expert-teams/*` types, so these events are omitted with a one-time debug log. They never reach the session log, the card fold, or the panel.
- The client surfaces nothing provider-related: `agent-teams-card-definition.ts` folds only `expert_teams_create` tool call/result pairs; the activity panel polls `/plugins/dsh-expert-library/state` (`src/index.ts:459–477`), whose snapshot (`src/snapshot.ts:83–93`) has no provider/error fields.
- The registry keeps a solid in-memory audit log with per-invoke ok/fail entries (`src/v2/provider-runtime.ts:562–573, 787–789`, recorded at `:845` and `:895`), and `ProviderTransportService.audit()` exposes it (`src/host/provider-service.ts:514–516`) — **but nothing calls `.audit()`** anywhere outside its own definition. No route, no UI, no persistence (in-memory only, lost on restart).
- Today a `WIND_ERROR` / beike block / `APPROVAL_REJECTED` is visible only inside the calling member's own tool result.

**Fix:** add `GET /plugins/dsh-expert-library/audit` reading `service.audit()` (bounded tail), and persist invoke records; revisit the session-event path once the harness exposes the `ignorable` writer surface.

## 5. ExecutionPlan observability — planRef/planProvenance displayed anywhere?

**Verdict: partial.**

- Persisted correctly: `applyExecutionPlan` stamps `planRef` (planId/digest/template/version/scenarioId) and `planProvenance` (params + compiler provenance) onto the durable team record (`src/apply.ts:331–332`; fields at `src/types.ts:150,158`), and returns `plan` in the apply tool result (`src/apply.ts:343`) — so the captain's conversation shows it once.
- Not displayed: `TeamActivitySnapshot` (`src/snapshot.ts:83–93`) carries workspace/teamId/name/members/tasks/messages only — no planRef. The state route and activity panel therefore never show which plan/digest a team runs; the per-task `planTask` logical-id mapping is likewise invisible.
- Per-task `planTask` (logicalId/fanOutIndex) is persisted (`apply.ts:327–329`) but also not projected into `TeamActivityTask` (`snapshot.ts:66–75`).

**Fix:** project `planRef` (+ per-task `logicalId`) into the activity snapshot and render a badge in the panel.

## 6. Pack ops — rescan after dropping a new pack dir, or restart required?

**Verdict: partial.**

- Preview side is fine: `discoverPackDirs` does a fresh `readdir` on every request (`src/v2/preview.ts:251–262`; the module doc explicitly says "no caches"), so `GET /plugins/dsh-expert-library/packs` (`src/index.ts:702–734`) picks up new pack dirs immediately. The health route's 30s single-flight cache is bounded and acceptable.
- Runtime side is the gap: **workspace packs are never consumed by the compile path at all.** Zhijian apply compiles `buildZhijianDomainPack()` fresh per call from compiled-in TS data (`src/zhijian/tools.ts:259–260`); collab apply uses `builtinLegacyPack()` — a **process-wide lazy cache that is never invalidated** (`src/v2/compat.ts:571–576`). So: dropping a new pack into `domain-packs/` makes it visible in the settings preview but it can never drive a team; editing `domain-packs/builtin-library/` requires a process restart to take effect; and no rescan/invalidate route or API exists.

**Fix:** decide whether workspace packs may drive runtime (loader → compile input with cache keyed by tree digest — the digest module already exists), and at minimum add a cache-invalidation on settings change or a rescan route.

## 7. Multi-captain / multi-session concurrency safety

**Verdict: partial (safe in-process, racy cross-process).**

- In-process: solid. All team mutations serialize through a per-team promise-chain lock (`src/state.ts:31–48`, `withTeamLock`), keys are scoped by stateRoot+teamId (`src/team-core.ts:82`), one-active-team-per-captain is a process-local lock (`team-core.ts:87`), and `team.json` writes go through `atomicWriteText` (temp-file + same-dir rename with Windows EPERM fallback, `src/state.ts:749–810`). `update_task` even does a compensating commit with snapshot rollback (`src/tools.ts:~820–840`).
- Cross-process: **not safe for team.json.** The mailboxes got a real cross-process O_EXCL lock file with stale-lock takeover (`src/state.ts:494–541`), but `team.json`/`project.json` read-modify-write cycles have no file lock — two DSH processes sharing one workspace (two captains, e.g. desktop + CLI on the same project) can interleave read→modify→write and last-writer-wins. Same-team concurrency across processes is plausible exactly because teams are discoverable by scanning workspace state dirs (`findTeamByParticipant`).
- Two teams in one workspace are fine (disjoint directories); the hazard is same-team or same-mailbox-adjacent mutation from two processes.

**Fix:** extend the existing O_EXCL mailbox lock pattern to `team.json` mutations (lock file per team dir).

## 8. Approval UX — pre-grant for trusted automation?

**Verdict: missing (fail-closed by design; no escape hatch).**

- Write ops require `approved: true`; with the Cordis approval service present, `invoke` asks and only `'allowed-once'` passes (`src/host/provider-service.ts:480–508`); without it, the registry blocks with `write-requires-approval` (`src/v2/provider-runtime.ts:859–863`). `ApprovalLike` is injectable in `ProviderServiceOptions` (`provider-service.ts:89`) but `resolveProviderServiceOptions` (`:144–165`) never wires it from config — tests can fake it, users cannot set it.
- Settings expose no pre-grant knob (`src/settings.ts:79–106`): `toolExecution` supports mode/api/cli/readOnly, but nothing like `preApprovedCapabilities` or `trustedWrite: true`. In a headless/automation session every write capability is dead weight.
- **Should there be?** Yes, but narrowly: a per-capability-id allowlist in settings (never per-provider blanket grants), still recorded in the audit log as `approved-by: config`. The current 'allowed-once'-only design makes scheduled/autonomous workflows (e.g. nightly report with a calendar write) impossible without a human in the loop — which may be intended, but then write capabilities should be clearly documented as interactive-only.

**Fix:** add `toolExecution.<id>.preApprove: string[]` (exact capability ids), surfaced in the audit entry; default empty.

## 9. Error taxonomy consistency

**Verdict: partial.**

- Provider layer: **consistent and good.** One closed vocabulary — `retry: 'never' | 'correct-input' | 'backoff'` (`src/v2/provider-runtime.ts:56`) plus `code`/`correction`/`details`, applied uniformly by wind/zyt/beike normalizers (Wind's own `retry.allowed/mode` is mapped into the union at `:212–250`; beike deliberately invents nothing, `:36` note). Registry-level failures use the same envelope (`:844`).
- Team/member tools: **different world.** `expert_teams_*` and `expert_review_*` throw plain `Error` strings (`src/tools.ts` throughout; `src/zhijian/tools.ts:221–230`) — no `code`, no `correction`, no retry directive. A member hitting "stale attempt" vs "terminal task immutable" vs "blocked by dependencies" gets prose it must parse. Some messages do embed actionable guidance ("call expert_teams_reassign_task …"), so it's halfway there, but there is no shared correction/never-retry vocabulary across the provider boundary — a member cannot handle a provider failure and a team failure with one strategy.

**Fix:** define a shared `{code, correction, retry}` shape for member-facing tool errors (reusing `RetryDirective`) and map the top ~10 team-tool failures onto it.

## 10. Other genuine gaps

- **Dead settings knob:** `preferredRoles` is declared in the settings schema (`src/settings.ts:75`, mirrored in `src/index.ts:244`) and documented ("Member roles allowed to invoke the tool") but **consumed nowhere** — grep finds only the two schema declarations. Either implement it (it would be a natural input to gap #2) or remove it.
- **Stale/aspirational doc claim:** `README.md:143` presents `runQualityChain()` as the quality-gate story of the product ("质量门控：runQualityChain() 执行固定门控链…") with no hint that it is not wired into any runtime path — reads as a shipped feature (see gap #1).
- **skillPackages declared, never used:** loader/validator fully support the collection (`src/v2/pack-loader.ts:448`, `src/v2/validate.ts:757,900–903`), yet both shipped packs declare `skillPackages: []` (`src/v2/zhijian-pack.ts:651`; `compat.ts:298`) and no runtime code outside `v2/` references it. The actual local skills (`knowledge/skills/finesse-ui`, `gsap-*`, `video-shotcraft`) are wired through a parallel mechanism (`src/skills.ts` + scenario `skill` overrides), so the pack-level skill-package concept is dead weight or unfinished — pick one.
- **Output schemas unvalidated:** `OutputTemplate`/`outputSchema` ids flow through compile into the plan, but `update_task` accepts any string output — the declared deliverable schema is never checked (subset of gap #1, but worth noting as its own acceptance hole for the "融合合成" render task).
- **Audit log is memory-only:** even where invoke auditing works (`provider-runtime.ts:895`), entries die with the process; combined with the dead event path (gap #4), there is currently **no durable record of any provider call**.

---

## Prioritized top-5 gaps

| # | Gap | Why first | Effort |
|---|-----|-----------|--------|
| 1 | **Quality gates not enforced at completion** (Q1) | The central V2 promise (hard-fail delivery block, compliance/anonymization) is currently prompt-only; gates + evaluators + tests already exist and just need a call site in `update_task`. | **M** |
| 2 | **Provider failure observability dead end** (Q4 + memory-only audit in Q10) | The audit event is silently dropped and `.audit()` has no reader; a read route over the existing registry log is cheap and immediately actionable. | **S** (route) + S (persist tail) |
| 3 | **No capability scoping on expert_provider_call** (Q2) | Any member can invoke any capability incl. writes; the plan already carries `allowedCapabilities` and the caller→team lookup already exists in the tool. | **M** |
| 4 | **Workspace packs never reach runtime; builtin pack cache never invalidated** (Q6) | The pack-dir workflow advertised by the preview UI is a dead end for execution; needs a runtime load path (or an honest "preview-only" label) plus cache invalidation. | **M** (L if workspace packs become authoritative) |
| 5 | **zhijian-expert-memory provider is declarative-only** (Q3) | A `required` knowledge policy that nothing can satisfy undermines the knowledge-binding contract; either serve it or stop declaring it. | **S** to drop/correct the declaration, **L** to actually serve a searchable expert memory |

Also cheap and worth doing alongside: delete or implement `preferredRoles` (S), correct the README quality-gate claim (S), extend the mailbox lock-file pattern to `team.json` for cross-process safety (S–M), unify member-facing error taxonomy (M), and add a `planRef` badge to the activity snapshot (S).
