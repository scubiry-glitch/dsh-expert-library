# ExecutionPlan → TeamRuntime Apply Migration — Smallest Safe Design

> Design document (no code changed). Scope: make `expert_teams_scenario_apply`, the four
> collab modes (`expert_teams_debate/roundtable/ppt/report`), and `expert_review_apply`
> thin adapters over `compileExecutionPlan` (src/v2/compiler.ts), while preserving the
> current team assembly / rollback / member / task behavior of the imperative assemblers
> in `src/tools.ts` (`scenarioApplyCore`), `src/collab/tools.ts` (`buildCollabTeam`) and
> `src/zhijian/tools.ts` (`expert_review_apply`).
>
> This is the Phase-3 target of NEXT-GENERATION-ARCHITECTURE.md §3.5/§9.1/§11
> ("旧工具变参数适配器；同模板三入口产出同构 DAG") — implemented as the *smallest*
> step: one new runtime apply module + declarative template data + three adapter rewrites,
> with the existing cores (`createTeamCore`/`addMemberCore`/`createTaskCore`/
> `rollbackTeamAssembly`/`scheduler`) untouched.

---

## 1. Current state (verified against source)

Three parallel imperative assemblers, all built on the same four cores:

| Entry | File | Team creation | Members | Tasks | Rollback | Kick |
|---|---|---|---|---|---|---|
| `scenario_apply` | `tools.ts` `scenarioApplyCore` (L529) | `createTeamCore` + `scenarioId` | `addMemberCore({expert})`, order = `scenario.experts` + task owners | `createTaskCore` from V1 `scenario.tasks` (`dependsOn` indexes → `t{n+1}`), interpolates `{goal\|team_name\|scenario\|data\|city\|period}` | `rollbackTeamAssembly` on any failure (L627) | outside core, after return |
| collab ×4 | `collab/tools.ts` `buildCollabTeam` (L58) | `createTeamCore` + `scenarioId` ('cross-debate' etc.) | `addMemberCore({expert})`, roster = dedup'd caller selection | imperative per-mode DAG (`CollabTaskDraft[]`), subjects embed expert ids | `rollbackTeamAssembly` (L115) incl. kick failure | inside try (kick failure rolls back) |
| `expert_review_apply` | `zhijian/tools.ts` L212 | `createTeamCore` + `scenarioId` when a route scenario matched | `addMemberCore({expert})`, selected bk-* metas | framework steps/constraints inlined into N review tasks + 1 unassigned fusion task | **none today** (mid-assembly failure wedges the captain's slot) | after tasks, then `steerCaptainReport` |

The V2 compiler (`src/v2/compiler.ts`) already produces everything structural the runtime
needs: an immutable `ExecutionPlan` with `roster` (expert ids + slot + modelPolicy +
approval), `tasks` (logical nodes with `expertIds`, `dependsOn`, subject/description
carried verbatim), `executionOrder` (deterministic topo order), `scenario`, `params`
(normalized, defaults folded), `template` ref, `planId`, `digest`, `provenance`.
`src/v2/compat.ts` already bridges V1 scenarios via `compileV1ScenarioExecutionPlan`
(golden-tested in `test/v2-v1-bridge.test.mjs`), and `src/v2/zhijian-pack.ts` already
ships TeamTemplates for frameworks A–D.

**What is missing** is the bridge from a compiled plan to the live team runtime: member
add order, logical-task → physical-task expansion (fan-out), interpolation of
subject/description placeholders, the final kick, and provenance recording.

---

## 2. Target architecture

```
compileExecutionPlan(pack, templateId, scenarioId, params, binding)
        │  CompileResult (ok / structured errors)
        ▼
applyExecutionPlan(plan, opts, core)          ← NEW src/apply.ts (runtime bridge)
        │  expandExecutionPlan(plan, opts)    ← pure, golden-testable
        │    roster → members (dedup, memberOrder)
        │    logical tasks → physical tasks (fan-out per expertIds, id t1..tN,
        │      deps remapped, subject/description interpolated)
        ▼
createTeamCore → addMemberCore ×N → createTaskCore ×N → scheduler.kickTeam
        │  any failure → rollbackTeamAssembly (all three families, incl. review)
        ▼
{ team_id, team_name, members, tasks }  (tool output schemas unchanged)
```

The three entry families become parameter adapters:
1. **`scenario_apply`** — resolve V1 scenario + skill (unchanged I/O) →
   `compileV1ScenarioExecutionPlan(experts, scenario)` →
   `applyExecutionPlan(plan, {teamName, description, interpolations, memberOrder, taskSuffixes})`.
2. **collab modes** — validate roster/counts (unchanged messages) → compile a
   declarative collab TeamTemplate with `params` (topic/data/audience/… ) +
   `binding.assignments` (explicit roster) → `applyExecutionPlan`.
3. **`expert_review_apply`** — framework/scenario/selected validation (unchanged) →
   compile `zhijian.team.<framework>` with `params.selectedExpertIds` (the compiler's
   H2(a) user-sign-off flow) + runtime-shape params → `applyExecutionPlan` → steer.

The imperative DAG construction (which tasks, which deps, which expert owns what) moves
into declarative template data; the adapters keep only input validation, I/O (library,
skill, knowledge), text composition, and param assembly.

---

## 3. Module layout (no import cycles)

- **`src/team-core.ts` (new)** — mechanical extraction of the four cores + their helpers
  from `tools.ts`: `createTeamCore`, `addMemberCore`, `createTaskCore`,
  `rollbackTeamAssembly`, `ExpertToolsCore`, `workspaceOf`, `stateRootOf`,
  `requireCaptainTeam`, `requireMember`, `requireTask`, `teamLockKey`,
  `memberRuntime`. `tools.ts` re-exports them (collab/zhijian imports unchanged).
  *Rationale:* `apply.ts` must import the cores, and the tool execute bodies must import
  `applyExecutionPlan`; without this split `tools.ts` ↔ `apply.ts` would form an import
  cycle. Purely mechanical; the full test suite must stay green after this step alone.
  *(Fallback if an extraction is deemed too risky: put `applyExecutionPlan` inside
  `tools.ts` itself — no new module, slightly larger file. Same behavior.)*
- **`src/apply.ts` (new)** — `expandExecutionPlan` (pure) + `applyExecutionPlan`
  (runtime). Imports only `team-core.ts` + `./v2/compiler.ts` + `./v2/types.ts`; exports
  both. No `tools.ts` import → no cycle.
- **`src/collab/templates.ts` (new)** — static collab `TeamTemplate`s
  (`collab.cross-debate`, `collab.roundtable`, `collab.ppt-gen`,
  `collab.research-report`, `collab.research-report-single`), the shared
  `collab.output` OutputTemplate, `collab.quality` QualityPolicy, four minimal
  `ScenarioV2`s (ids `cross-debate`/`roundtable`/`ppt-gen`/`research-report` →
  `teamTemplate` = the collab template), and `buildCollabDomainPack(experts)` that
  projects the resolved V1 library experts (`buildLegacyDomainPack`) and attaches the
  collab templates. Pure data + one pure builder.
- **`src/v2/zhijian-pack.ts` (edit)** — `frameworkTeamTemplate` gains the runtime-shape
  params and placeholder subjects/descriptions; `role.fusion` cardinality becomes
  `{min: 0, max: 1}` (see §7.3 delta D4).
- **Adapters** — `scenarioApplyCore` (tools.ts), `buildCollabTeam` (collab/tools.ts),
  `expert_review_apply` (zhijian/tools.ts) rewritten to compile + apply (§7).
- **`src/types.ts` (edit, additive-optional only)** — TeamState/TeamTask provenance
  fields (§5). The `isTeamState`/`isTeamTask`/`isTeamMember` validators in `state.ts`
  check only required fields and ignore unknown keys, so **no `state.ts` change is
  needed** (verified: they never reject extra fields; a round-trip test is specified).

---

## 4. The apply module contract

```ts
// src/apply.ts
export interface ApplyPlanOptions {
  /** TeamState.name (sanitizeKey → team id, unchanged). */
  teamName: string
  /** TeamState.description — already fully composed by the adapter (incl. skill blocks). */
  description: string
  /** Runtime-derived interpolation values merged over plan.params (V1 keys: goal/team_name/scenario/data/city/period; mode keys: topic/dataLine/skillBlock/…). String values only. */
  interpolations?: Readonly<Record<string, string>>
  /** Strict member-add order (expert ids). Defaults to roster order. Must cover every roster expert. */
  memberOrder?: readonly string[]
  /** Per-expert display extras for fan-out naming: {expertName}/{expertField}/{expertInitials}. */
  expertDisplay?: ReadonlyMap<string, { name: string; field?: string; initials?: string }>
  /** taskId → text appended to the interpolated description (skill blocks). Empty-interpolated description ⇒ suffix becomes the description. */
  taskSuffixes?: Readonly<Record<string, string>>
  /** Kick once after the full DAG is seeded (default true). */
  kick?: boolean
}

export interface PhysicalTask {
  id: string                     // t1..tN in creation order (runtime taskSeq convention)
  logicalId: string              // CompiledTask.id it derives from
  fanOutIndex?: number           // position among the logical task's expertIds
  subject: string                // interpolated
  description?: string           // interpolated + suffix
  dependsOn: readonly string[]   // physical ids
  assigneeExpertId?: string      // undefined ⇒ unassigned (shared pool)
}

export interface ExpandedPlan {
  members: { slotId: string; expertId: string; modelPolicy?: ModelPolicy }[]  // dedup'd
  tasks: PhysicalTask[]
  planRef: { planId: string; digest: string; templateId: string; templateVersion: string; scenarioId?: string }
}

/** Pure: plan → physical DAG. No ctx, no I/O — the golden-testable core. */
export function expandExecutionPlan(plan: ExecutionPlan, opts: ApplyPlanOptions): ExpandedPlan

/** Runtime: createTeamCore → addMemberCore (dedup/memberOrder) → createTaskCore → kick; rollbackTeamAssembly on any failure (incl. kick). */
export async function applyExecutionPlan(
  ctx: Context, config: ToolsConfig, captain: Agent,
  plan: ExecutionPlan, opts: ApplyPlanOptions, signal: AbortSignal,
  core: ExpertToolsCore,
): Promise<{
  team_id: string; team_name: string
  members: { expert_id: string; member_name: string; model: string }[]   // scenario_apply shape
  tasks: { task_id: string; subject: string; assignee?: string }[]
  plan: ExpandedPlan['planRef']
}>
```

### 4.1 Expansion algorithm (the only new logic)

```
1. members  = plan.roster, dedup by expertId (first occurrence wins), in memberOrder
   (default: roster order). Matches today's rosters exactly:
   debate   [moderator, pro, con];  roundtable [speakers…, noteTaker?];
   ppt      [docs-coordinator, content…];  report [experts[0], experts[1..], writer]
   (first-occurrence dedup makes writer∈experts and pro==moderator collapse identically).

2. physical tasks: iterate plan.executionOrder (topo order — equals creation order
   today: V1 array order, collab/review logical order). For each logical CompiledTask:
     ids = task.expertIds
     ids.length === 0 → one physical task, assigneeExpertId undefined (shared pool)
     ids.length === N → N physical tasks, one per id in roster order,
                        fanOutIndex 0..N-1
   deps(physical) = every physical id of the logical dependsOn tasks, in creation order.
   next id = `t${++seq}` (identical to the runtime taskSeq convention).

3. interpolation per physical task:
   values = { …plan.params (string-valued only), …opts.interpolations,
              per-expert: { expertId, expertName, expertField, expertInitials } from
                opts.expertDisplay ?? { expertName: pack expert display.internalName },
              dependencies: comma-joined physical dep ids }
   subject   = interpolate(logical.subject,   values)      // unknown {key} left verbatim
   description = interpolate(logical.description, values)  // same
                 + (opts.taskSuffixes[id] ?? '')           // suffix-as-description when none

4. planRef = { planId, digest, templateId: plan.template.id,
               templateVersion: plan.template.version, scenarioId: plan.scenario?.id }
```

Physical task ids/deps/assignees are **isomorphic to the imperative DAGs by
construction** (creation order = executionOrder; fan-out order = roster order;
dependency fan-out covers all upstream physical tasks). This is the property the golden
tests (§9) lock down.

### 4.2 applyExecutionPlan

Runs exactly the current sequence: `createTeamCore({name, description, scenarioId:
plan.scenario?.id})` → for each member `addMemberCore({expert: expertId})` (**no
provider/model/reasoning_effort args** — see §6.1) → for each physical task
`createTaskCore({subject, description?, dependencies, assignee: memberNameByExpert.get(assigneeExpertId)})`
→ `scheduler.kickTeam` (when `opts.kick !== false`) → return. The whole body sits in the
same try/catch as today's scenario/collab paths: any failure (member spawn, task write,
kick) → `rollbackTeamAssembly` → rethrow. `expert_review_apply` therefore **gains** the
rollback it lacked (delta D1).

---

## 5. Required provenance fields (ExecutionPlan → TeamRuntime / state)

### 5.1 ExecutionPlan fields the apply module reads (all exist — none new)

| Plan field | Runtime use | Notes |
|---|---|---|
| `roster[].expertId` | `addMemberCore({expert})` | the only route input (see 6.1) |
| `roster[].modelPolicy` | **advisory only** — recorded, never passed as route args | keeps `memberRouteRequest` precedence: preset expert route > explicit > memberModel > captain |
| `roster[].approval` | not consumed (sign-off already happened adapter-side) | recorded in planRef chain for audit |
| `tasks[].id/role/expertIds/dependsOn/subject/description` | physical expansion + interpolation | subject/description carry placeholders verbatim |
| `executionOrder` | creation order → physical `t1..tN` | topo order = array order for all current DAGs |
| `scenario?.id` | `TeamState.scenarioId` (persona guides, zhijian framework bake) | undefined ⇒ team has no scenarioId (review "no scenario" note) |
| `params` | interpolation source (normalized, defaults folded) | non-string values skipped |
| `template.{id,version}`, `planId`, `digest` | `planRef` provenance | |

### 5.2 TeamState / TeamTask provenance (new, additive-optional — `src/types.ts` only)

```ts
// TeamState
planRef?: {                       // audit anchor: this team was assembled from plan X
  planId: string
  digest: string
  templateId: string
  templateVersion: string
  scenarioId?: string
}
planProvenance?: {                // optional audit: normalized params + compiler decision trail
  params: Record<string, unknown>
  compile: readonly { step: string; detail: string }[]
}

// TeamTask
planTask?: { logicalId: string; fanOutIndex?: number }   // physical ← CompiledTask link
```

- Written by `applyExecutionPlan` inside the same try block (rolled back with the team on
  failure). `planProvenance`/`planTask` are recommended; `planRef` is the migration
  contract (enables "same template + same binding ⇒ isomorphic DAG" verification and gate
  `appliesTo` mapping from logical to physical tasks).
- `state.ts` validators (`isTeamState`/`isTeamTask`/`isTeamMember`, verified at
  state.ts L817–919) check required fields only and **ignore unknown keys**, so old teams
  read back and new fields persist with **zero validator changes** (round-trip test F).

---

## 6. Behavior-preservation decisions

### 6.1 Member model route — plan modelPolicy is advisory, never an override
`addMemberCore` already resolves the route with the documented precedence
(`memberRouteRequest`, members.ts L108: preset expert route wins over everything). The
V1 bridge's `modelPolicy` copies `Expert.model` and the zhijian pack's `modelPolicy` is
the plugin route — both equal what `addMemberCore` resolves from the **live library**
today. Passing explicit route args from the plan would change precedence semantics
(explicit args override `memberModel` default for experts without a preset route).
**Decision: `applyExecutionPlan` passes only `{expert: id}`; plan `modelPolicy` is
recorded in `planRef`/`planProvenance` for cross-check/audit.** Route behavior is
byte-identical to today.

### 6.2 Member add order
Collab/review roster order equals today's by construction (§4.1 table). The V1
scenario path differs: `adaptV1ScenarioTeamTemplate` declares slots **sorted
alphabetically** (compat.ts L150), so the compiled roster is
`[data-analyst, designer, researcher]` while `scenarioApplyCore` adds
`[researcher, data-analyst, designer]` (scenario.experts order). **Decision: the V1
adapter passes `opts.memberOrder = expertIds`** (its existing pre-computed list, tools.ts
L553–559) — exact add-order preservation; the knob is optional elsewhere.

### 6.3 Kick and rollback semantics
- Kick once after the full DAG — inside `applyExecutionPlan`'s try block. Today's
  collab path already rolls back on kick failure; scenario/review do not (kick sits
  outside their try). **Unified: kick failure now rolls back for all three** (delta D2 —
  strictly safer, collab already behaved this way).
- `expert_review_apply`'s `steerCaptainReport` stays adapter-side, after apply returns.

### 6.4 Interpolation
Reuses the exact V1 semantics (`interpolateScenarioTemplate`, tools.ts L106: replace
`{goal|team_name|scenario|data|city|period}`, leave unknown tokens) as a **superset**:
any `{key}` present in `plan.params` (mode params) or `opts.interpolations` or the
per-expert/`{dependencies}` derived keys. Non-string param values are skipped. V1 task
subjects AND descriptions are interpolated (as today).

### 6.5 Skill blocks
Stays adapter-side I/O: `resolveSkill` → `skillBlock`. Team description composed by the
adapter (unchanged). Per-task skill block (V1 `scenario.skill.appliesToTaskIndex`,
default last task) via `opts.taskSuffixes[t{index+1}]` = `'\n\n' + block.trim()` for
described tasks, `block.trim()` for description-less tasks — reproducing tools.ts
L605–609 exactly.

---

## 7. Adapter rewrites

### 7.1 `scenarioApplyCore` (tools.ts)
Keep: library resolve, scenario lookup, roster validation (exact error message),
teamName/templateValues, skill resolve. Replace the member/task loops with:
```
compileV1ScenarioExecutionPlan(experts, scenario)   // !ok ⇒ throw composed CompileError
applyExecutionPlan(plan, {
  teamName, description: `${interpolateScenarioTemplate(goal, values)}${skillBlock}`,
  interpolations: { goal, team_name, scenario: scenario.id, data, city, period },
  memberOrder: expertIds, taskSuffixes: skillTaskId → skillBlock,
}, signal, core)
```
Output mapping unchanged (`scenario_id`, `members` with model, `tasks`, `deliverable`).

### 7.2 Collab modes (collab/tools.ts `buildCollabTeam`)
Keep: `requireCaptain`, `resolveExpertNames` (validation + names), per-mode roster/count
validation (2–5 roundtable, ≤3 ppt, ≤4 report, pro≠con, dedup), dataBlock/audienceLine/
pagesLine/skillBlock composition. Replace the create/add/task loops with:
```
const pack = buildCollabDomainPack([...library.experts.values()])
const result = compileExecutionPlan({ pack, templateId: COLLAB_TEMPLATE[mode],
  scenarioId: mode, params: modeParams, binding: { assignments } })
applyExecutionPlan(result.plan, { teamName, description, interpolations: { skillBlock } }, …)
```
New static data (see §4 of this doc for exact template texts):

- **`collab.cross-debate`** — params `{topic(required), data?, pro(required), con(required),
  moderator(default 'team-lead')}`; slots `role.moderator/pro/con` `{cap:[], min1 max1}`;
  tasks `t1..t5` (moderator/pro/con/pro/moderator), deps chain `t1→t2→t3→t4→t5`,
  subjects `辩题与规则确认` / `正方立论（{expertId}）` / `反方反驳（{expertId}）` /
  `正方回应（{expertId}）` / `裁判总结`; descriptions verbatim from collab/tools.ts L183–186.
- **`collab.roundtable`** — params `{topic(required), data?, noteTaker?}`; slots
  `role.speaker {min2 max5}`, `role.note-taker {min0 max1}`; tasks `t1` speaker
  (`专家发言（{expertId}）`, deps []) + `t2` note-taker (`圆桌纪要整理`, deps [t1]);
  assignments `{'role.speaker': speakers, 'role.note-taker': noteTaker? [noteTaker] : []}`.
  No noteTaker ⇒ slot optional ⇒ zero experts ⇒ unassigned task (exactly today).
- **`collab.ppt-gen`** — params `{topic(required), audience(default '缺省由你判断'),
  pageCountText?, data?, skillBlock?}`; slots `role.architect {min1 max1}`,
  `role.content {min1 max3}`, `role.writer {min1 max1}`; tasks `t1` architect →
  `t2` content (fan-out per content expert, deps [t1]) → `t3` writer (deps [t1, t2]);
  assignments `{'role.architect':['docs-coordinator'], 'role.content': contentExperts,
  'role.writer':['docs-coordinator']}`. `pageCountText = String(args.page_count ?? '10-15')`
  (keeps number|string display; pageCount is numeric in the tool schema).
- **`collab.research-report`** (≥2 experts) / **`collab.research-report-single`**
  (1 expert — the analyst task must not exist at all when there is no analyst; the
  compiler cannot drop tasks, so a variant is required): multi slots
  `role.researcher {min1 max1}` (assignee `experts[0]`), `role.analyst {min0 max3}`
  (`experts.slice(1)`), `role.writer {min1 max1}` (`writer`); tasks `t1` 资料梳理 →
  `t2` 专家研判（{expertId}）(deps [t1]) → `t3` 融合成文 (deps [t1, t2]);
  single variant = t1 researcher + t2 writer. Params `{topic(required), data?, dataLine?,
  writer(default 'docs-coordinator')}`.

Each template: `gates: []`, `deliverables: [{id:'d1', outputTemplate:'collab.output',
fromTasks: […all]}]`, task `outputSchema: 'collab.output'`, slots `capabilities: []`
(any library expert qualifies). `collab.quality` = `{gates: [], maxRepairRounds: 0}`;
`collab.output` = `{media:['markdown'], sections:[{id:'deliverable', required:true}],
renderModes:{final:{anonymize:false}}}`. The four `ScenarioV2`s (id = the V1 scenario id,
`teamTemplate` = collab template id) keep `plan.scenario.id` = `cross-debate` etc. so
`TeamState.scenarioId` and the persona knowledge guides are unchanged.

### 7.3 `expert_review_apply` (zhijian/tools.ts)
Keep: framework lookup, selected validation (dedup, 1–5, unknown ids — exact messages),
route/scenario resolution, dataContext/outputForm composition, teamName, `note` for
unmatched scenario, `steerCaptainReport`. Replace the create/add/task loops with:
```
const pack = buildZhijianDomainPack()
const result = compileExecutionPlan({
  pack, templateId: `zhijian.team.${frameworkId}`,
  scenarioId: scenario?.id,                      // undefined ⇒ plan.scenario undefined ⇒ note
  params: { selectedExpertIds: selected, data: args.data,
            outputForm: args.output_form ?? 'discussion',
            dataContext, frameworkName: framework.name,
            frameworkSteps, frameworkConstraints, frameworkWordLimit, wordLimitLine,
            outputFormText, fusionExtraRules },
})
applyExecutionPlan(result.plan, { teamName, description }, …)   // then steer
```

`src/v2/zhijian-pack.ts` `frameworkTeamTemplate` changes (pack data, exact strings from
zhijian/tools.ts L267–288):
- params add: `dataContext`, `frameworkName`, `frameworkSteps`, `frameworkConstraints`,
  `frameworkWordLimit`, `wordLimitLine` (`` wordLimit ? `\n字数约束：${wordLimit}` : '' ``),
  `outputFormText`, `fusionExtraRules`
  (`GLOBAL_OUTPUT_RULES.filter(数字|文风).map(r => '5. ' + r).join('\n')` — reproduces the
  current literal `5. ` numbering).
- `t1` subject → `专家研判：{expertName}（{expertField}·{expertInitials}）`; `t1`
  description → `以专家「{expertName}」身份独立研判，输出框架 {frameworkName}。\n\n{dataContext}\n\n{frameworkSteps}{wordLimitLine}\n约束：{frameworkConstraints}\n匿名标注：文内身份只标「{expertField}·{expertInitials}」。完成后提交完整点评文本到 output。`
- `t2` description → `综合以下专家研判任务：{dependencies}（用 expert_teams_status 读取各任务 output）。\n框架：{frameworkName}{frameworkWordLimit}\n输出形态：{outputFormText}。\n融合规则（主基调为锚）：\n1. …\n2. …\n3. …\n4. …\n{fusionExtraRules}\n完成后把全文写入 output。`
  (`{dependencies}` is the apply-derived comma-joined physical review ids — identical to
  today's `reviewTaskIds.join(', ')`; `frameworkWordLimit` here is `（约 500 字 ±10%…）` or '').
- **`role.fusion` cardinality → `{min: 0, max: 1}`** (delta D4). Today the fusion task is
  created unassigned; the current template's `min:1` auto-fills the top-ranked reviewer
  into the roster (extra member) and assigns the fusion task to it. `min:0` keeps the
  slot optional ⇒ zero experts ⇒ fusion task unassigned (shared pool) — exactly today.

---

## 8. Behavior-preservation matrix and documented deltas

**Preserved (identical, golden-tested):** team id/name/description/scenarioId; member
names, model routes (preset-expert-wins), dedup, add order; task ids `t1..tN`, subjects,
descriptions, dependencies, assignees; one-team-per-captain lock, member cap, duplicate/
dangling dependency rejection; rollback on mid-assembly failure; tool output schemas and
renders; final kick; review steer.

**Intentional deltas (each with a test):**
- **D1** `expert_review_apply` now rolls back on mid-assembly failure (today it leaves a
  half-built team wedging the captain's slot). Safety fix; collab/scenario unchanged.
- **D2** Kick failure now triggers rollback for scenario/review too (collab already did).
- **D3** Compiler enforcement rejects inputs the imperative code accepted — all aligned
  with 路由规则/框架约束, surfaced as structured CompileErrors:
  - deceased expert in `selected_experts` (`roster.deceased-expert`, e.g. bk-022);
  - framework D selection covering <2 fields (`diversity-fields-unsatisfied`);
  - scenario-bound review lacking the primary-field expert
    (`required-capability-unsatisfied`, e.g. zhijian-monthly without an
    `realestate.research.review` claimer).
  The adapter keeps its own pre-validation for the common cases (counts, unknown ids) so
  the familiar Chinese messages still win; the compiler checks are backstops.
- **D4** `role.fusion` becomes optional so the fusion task stays unassigned; requires the
  pack template change and one `v2-compiler.test.mjs` assertion update (see §9).
- **D5** V1 scenario member add order restored to `scenario.experts` order via
  `memberOrder` (compiled roster is alphabetically slot-sorted; without the knob the only
  observable difference would be the members array order — cosmetic).
- **D6** Compile-failure text is new (English CompileError summary) but unreachable for
  validator-valid V1 input (the V1 parse boundary already rejects malformed DAGs); only
  the D3 enforcement cases can newly fail.

---

## 9. Exact tests

Run against `lib/` (built), node:test + assert/strict, following `test/*.test.mjs`
conventions. New files:

### A. `test/v2-apply-expand.test.mjs` — pure expansion boundary
1. single-expert logical tasks expand 1:1, ids sequential in `executionOrder`, deps remapped.
2. N-expert logical task fans out to N physical tasks in roster order, `fanOutIndex` 0..N-1.
3. zero-expert logical task → one unassigned physical task (shared pool).
4. dependency fan-out: physical deps = all physical ids of upstream logical deps (creation order).
5. interpolation: `plan.params` strings + `opts.interpolations` override; per-expert keys
   `{expertId}/{expertName}/{expertField}/{expertInitials}`; `{dependencies}`; unknown
   tokens left verbatim; non-string params skipped.
6. member dedup by expertId (first occurrence wins); `memberOrder` honored; unknown
   memberOrder id throws.
7. `planRef` shape `{planId, digest, templateId, templateVersion, scenarioId?}`; scenarioId
   absent when the plan has no scenario.
8. determinism: same plan → byte-identical `ExpandedPlan` (two calls).
9. `taskSuffixes`: appended after interpolation; becomes the description when the
   interpolated description is empty.

### B. `test/v2-collab-templates.test.mjs` — template data + compile
1. `buildCollabDomainPack` is `validateDomainPack`-clean.
2. debate golden: compile `{topic, pro:'bk-024', con:'bk-008', moderator:'team-lead'}` →
   tasks `t1..t5`, deps chain, roster `[team-lead, bk-024, bk-008]`; physical expansion
   (via `expandExecutionPlan`) = today's DAG: subjects
   `辩题与规则确认`/`正方立论（bk-024）`/`反方反驳（bk-008）`/`正方回应（bk-024）`/`裁判总结`,
   assignees `[team-lead, bk-024, bk-008, bk-024, team-lead]`.
3. debate pro==moderator → roster dedup to 2 members; task DAG unchanged.
4. roundtable 3 speakers + noteTaker → physical `t1..t4`; note task deps `[t1,t2,t3]`;
   assignees speakers + noteTaker.
5. roundtable without noteTaker → note task unassigned; roster = speakers only.
6. roundtable 1 speaker → compiler `assignment-count` roster error (adapter keeps the
   Chinese 至少 2 位 message at its own boundary).
7. ppt 2 content experts → `t1..t3`; writer deps `[t1, t2, t3]`; roster dedup
   docs-coordinator (2 members).
8. ppt 4 content experts → `assignment-count` roster error.
9. report multi (3 experts) → `t1..t4` golden (subjects/assignees/deps); report single
   (1 expert) → `collab.research-report-single` → `t1..t2` (no analyst task).
10. report writer∈experts → roster dedup preserves experts order.
11. all four compile with `scenarioId` → `plan.scenario.id` = mode id, no
    `scenario-template-mismatch` warning.

### C. `test/v2-review-apply-compile.test.mjs` — review compile (runtime-shaped params)
1. framework A with `{selectedExpertIds: ['bk-024','bk-025'], data, dataContext,
   frameworkName, frameworkSteps, frameworkConstraints, wordLimitLine, outputFormText,
   fusionExtraRules}` → ok; roster `[bk-024, bk-025]`; `t1.expertIds` = selected;
   **`t2.expertIds` = `[]`** (fusion unassigned, after D4).
2. expansion golden: 2 physical reviews (`专家研判：丁祖昱（行业研究·…）` via
   `opts.expertDisplay` from ZHIJIAN_EXPERTS metas) + 1 unassigned fusion with deps
   `[t1,t2]`; fusion description contains `综合以下专家研判任务：t1, t2（…）`.
3. 1 selected expert → 1 review + fusion; 5 selected → 5 reviews + fusion.
4. deceased bk-022 → `roster.deceased-expert` error.
5. framework D same-field selection → `diversity-fields-unsatisfied`; 2-field selection → ok.
6. zhijian-monthly without an `realestate.research.review` claimer →
   `required-capability-unsatisfied`; with bk-024 → ok.
7. compile without scenarioId (no ROUTE_SCENARIOS match) → ok, `plan.scenario` undefined
   (the adapter's `note` branch).
8. unknown expert id → `roster.unknown-expert`; empty `selectedExpertIds` →
   `params-required-missing`.

### D. `test/v2-apply-golden.test.mjs` — full-DAG golden contracts per family
1. V1 scenario golden (market-research-style fixture): `compileV1ScenarioExecutionPlan`
   → `expandExecutionPlan` (memberOrder = `scenario.experts` order) → physical DAG
   EXACTLY equals today's `scenarioApplyCore` output: tasks `t1..t4` with verbatim
   subjects, deps `[]/[t1]/[t2]/[t3]`, assignees
   `[researcher, data-analyst, data-analyst, unassigned]`, members
   `[researcher, data-analyst, designer]`, shared task unassigned.
2. Collab golden DAGs (debate/roundtable/ppt/report multi+single) with interpolated
   descriptions asserted string-for-string against the current imperative texts.
3. Review golden DAG (framework A) with interpolated descriptions asserted
   string-for-string (incl. numbered steps/constraints/`5. ` fusion rules).
4. Determinism: expand twice → identical; planRef/digest stable.

### E. Updated existing tests
- `test/v2-compiler.test.mjs` (line ~565): `t2.expertIds` `['bk-002']` → `[]` with
  comment "runtime-facing template keeps fusion in the shared pool (unassigned)" — the
  one assertion that pins D4.
- `test/v2-zhijian-pack.test.mjs`: add assertions — `role.fusion` cardinality
  `{min:0,max:1}`; `t1.subject` uses `{expertName}` placeholder; template `parameters`
  include the runtime-shape params. Existing assertions (ids/roles/deps/cardinality/
  approval/deliverables/gates) unchanged.
- `test/v2-v1-bridge.test.mjs`, `test/phase0-regressions.test.mjs`,
  `test/state-integrity.test.mjs`: unchanged (compile + cores untouched).

### F. State provenance round-trip (append to `test/state-integrity.test.mjs`)
A TeamState carrying `planRef`/`planProvenance` and a TeamTask carrying `planTask`
round-trips through `writeTeam`/`readTeam` (additive-optional fields tolerated by the
existing validators), and an old team without them reads back unchanged.

---

## 10. Rollout order and risks

Implemented in this order (per the migration directive "scenario_apply + expert_review_apply first"):

1. `src/team-core.ts` extraction (4 cores + helpers + `ToolsConfig`/`ExpertToolsCore`) — full suite green (no behavior change).
2. `src/apply.ts` (`expandExecutionPlan` pure + `applyExecutionPlan` with rollback + planRef persistence) + provenance fields in `src/types.ts` + tests A/F.
3. `scenarioApplyCore` → `compileV1ScenarioExecutionPlan` + `applyExecutionPlan` (memberOrder = scenario.experts order; taskSuffixes for skill blocks).
4. `src/v2/zhijian-pack.ts` template changes (`role.fusion` min:0, runtime-shape params, placeholder copy, `allowedCapabilities: []` — see note below) + `expert_review_apply` → compile `zhijian.team.<framework>` + apply.
5. `src/collab/templates.ts` (5 declarative TeamTemplates + `buildCollabDomainPack`) + collab modes → compile + apply.
6. Tests (A–F) + updated assertions; full `pnpm build` + `pnpm test` + `pnpm typecheck` green (374/374).

**Implementation discoveries (beyond the design):**
- `frameworkTeamTemplate` tasks must declare `allowedCapabilities: []`: the compiler treats a scenario-less compile's task capabilities as tool-allowed and would demand a tool provider for `zhijian.review` (no-scenario compiles are the review adapter's "未匹配到标准场景" note branch). The review capability stays a roster requirement via the scenario's `requiredCapabilities`.
- The collab `role.note-taker` slot gets an explicit `[]` assignment when no note_taker is given, so the 纪要 task stays deterministically unassigned.
- The single-expert report path uses the `collab.research-report-single` variant (the compiler cannot drop the analyst task).

**Risks and mitigations:** import cycle (mitigated by the team-core split); template-text drift (golden tests D lock every string); D3 rejections (adapter pre-validation keeps familiar messages; deltas documented and tested); D4 (one-line assertion update, atomic with the template change); `state.ts` validators tolerate additive fields (test F).

**Out of scope (deliberately):** replacing the model-visible tool surface
(`expert_template_apply` unification, §9.1), MethodPack progressive loading into task
copy (the method packs already exist in the zhijian pack but are not spliced — a later
phase can switch without DAG changes), provider/gate execution, and any change to the
pure V2 surface other than the two zhijian-pack template edits.

---

## 11. V1 retirement (dual-track consolidation)

The apply migration still depends on the V1 runtime data (`Expert`/`Scenario`
registries in `src/expert-library/*` and `src/zhijian/*`) through the
`adaptV1*` compatibility views. Retiring them is a three-step track:

**Step 1 — DONE (this round): stop re-projecting the builtin library per call.**
- `src/v2/compat.ts` now holds a process-wide lazy singleton
  `builtinLegacyPack()`: the full builtin library (8 通用 + 33 智见 bk-* experts,
  all 10 builtin scenarios) is projected via `buildLegacyDomainPack` once and
  never invalidated during the process (inputs are static generated code).
- `compileV1ScenarioExecutionPlan` reuses that cache: for a builtin scenario
  (reference- or content-identical) its legacy TeamTemplate is looked up
  directly — zero per-call projection; for caller-provided variants (user-pack
  scenarios, fixtures) the legacy template + scenario view are derived from the
  passed object and spliced into the cached pack, byte-identical to the old
  per-call `buildLegacyDomainPack`. Only experts the cache does not cover
  (user overrides / fixtures) are re-adapted, so preset model routes and user
  content stay authoritative. Export signature and V1 roster-assignment
  semantics unchanged — golden bridge tests stay green byte-for-byte
  (digest-equality locked by `test/v2-v1-consolidation.test.mjs`).
- `buildCollabDomainPack` (collab projection) reuses the cached expert
  entities by reference instead of a second `buildLegacyDomainPack` call.

**Step 2 — DONE (this round): the generic builtin library has a static V2 pack home
and the runtime is pack-first.**
- `scripts/build-builtin-pack.mjs` (mirrors `build-zhijian-pack.mjs` conventions:
  deterministic, fatal-on-mismatch self-check through the real loader,
  `--check` drift guard; `pnpm build:builtin` / `pnpm check:builtin`) projects
  the **generic builtin library only** — 8 generic experts + all 10 builtin
  scenarios; the 33 zhijian bk-* experts are NOT included (zhijian already has
  its own pack, `domain-packs/zhijian-realestate/`) — into
  `domain-packs/builtin-library/` (pack.json, `experts/*.json`,
  `team-templates/*.json` via `adaptV1ScenarioTeamTemplate`, plus
  scenarios/output/quality/knowledge-provider dirs and
  `generated/verify.json` + `generated/pack.sha256`). The entities are the
  **byte-exact** `buildLegacyDomainPack` projection — the same adaptation
  functions the runtime fallback uses, imported from `lib/` at generation
  time, never forked — so the scenario → TeamTemplate mapping is identical to
  `compileV1ScenarioExecutionPlan`'s legacy semantics and compiled plans are
  digest-identical on both paths.
- Runtime cutover in `compat.ts`: `builtinLegacyPack()` now loads
  `domain-packs/builtin-library/` pack-first via the new sync loader
  `loadPackFromDirSync` (a pack-loader twin for trusted static roots with the
  same layout/validation semantics), appends the zhijian bk-* experts from the
  V1 registry (the generated pack is generic-only, but the builtin scenarios
  reference bk-* experts), and falls back to the direct adaptV1 projection
  ONLY when the pack directory is absent (e.g. a published package without
  domain-packs); a present-but-invalid pack is a loud failure, never a silent
  fallback. `loadBuiltinLegacyPack(packDir?)` is exported for the fallback
  test (injectable path).
- Golden contract `test/v2-builtin-pack.test.mjs`: generator `--check` clean;
  pack round-trips validator-clean; per-scenario digest equality pack-path vs
  adapt-path for **all 10** builtin scenarios; fallback works with an injected
  bad path and compiles digest-identically; runtime cache is pack-first (the
  generic experts are the loaded objects, not re-adapted).

**Step 3 — FUTURE WORK (not done): full deletion of the `adaptV1*` runtime paths.**
The V1 TypeScript (`BUILTIN_EXPERT_BY_ID` / `BUILTIN_SCENARIO_BY_ID` /
`ZHIJIAN_EXPERT_BY_ID`) is now retained **solely as the authored generator
input** (the same pattern as the zhijian source): the runtime no longer
re-projects the builtin library per call, and the projection only exists as a
fallback when the pack dir is absent. Deleting the V1 registries and the
runtime `adaptV1*` bridge entirely still needs a consumer-by-consumer cutover
of `resolveLibrary` (the V1 Expert/Scenario maps that personas, scenario
validation and collab roster validation still read) — future work.
