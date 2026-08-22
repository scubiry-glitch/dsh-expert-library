/**
 * ExecutionPlan → TeamRuntime apply bridge.
 *
 * The single execution path for every compiled team plan
 * (NEXT-GENERATION-ARCHITECTURE.md §3.5 "编译器产物只有一个执行路径"): a V2
 * {@link ExecutionPlan} produced by `compileExecutionPlan` is expanded into a
 * concrete physical team — one member per distinct rostered expert, one
 * physical task per `expertIds` entry of every logical task, dependencies
 * remapped to ALL physical ids of the upstream logical tasks, and logical
 * tasks with zero experts kept unassigned (shared pool) — then materialized
 * through the exact same transactional cores the imperative assemblers used
 * (`createTeamCore` / `addMemberCore` / `createTaskCore` /
 * `rollbackTeamAssembly`).
 *
 * Guarantees (contract, golden-tested in `test/v2-apply-golden.test.mjs`):
 * - physical task ids follow the runtime `t1..tN` convention in
 *   `executionOrder` (creation order isomorphic to the V1 imperative DAGs);
 * - a logical task with N `expertIds` fans out to N physical tasks in roster
 *   order (fanOutIndex 0..N-1); a task with zero experts stays a single
 *   unassigned physical task (shared pool);
 * - a physical task's `dependsOn` lists every physical id of every upstream
 *   logical task, in creation order;
 * - subject/description are interpolated from `plan.params` +
 *   `opts.interpolations` + per-expert derived keys (`{expertId}`,
 *   `{expertName}`, `{expertField}`, `{expertInitials}`) + `{dependencies}`;
 *   unknown `{key}` tokens are left verbatim;
 * - members are added with `{ expert }` only — the plan's `modelPolicy` is
 *   advisory (recorded, never passed as route args), so the documented route
 *   precedence (preset expert route > explicit > memberModel > captain) is
 *   untouched;
 * - every assembly step (create / members / tasks / kick / provenance write)
 *   sits inside one try block: any failure rolls the team back via
 *   `rollbackTeamAssembly`, so a half-built team can never wedge the
 *   captain's one-team slot;
 * - `planRef` (planId/digest/template/templateVersion/scenarioId) and the
 *   optional `planProvenance` snapshot (normalized params + compiler decision
 *   trail) are persisted on the durable TeamState; each physical task records
 *   its `planTask` (logicalId + fanOutIndex).
 *
 * `expandExecutionPlan` is pure (no ctx, no I/O) and is the golden-testable
 * core; `applyExecutionPlan` is the runtime composition of the existing cores.
 * @module dsh-expert-library/apply
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { readTeam, withTeamLock, writeTeam } from './state.ts'
import {
  addMemberCore,
  createTaskCore,
  createTeamCore,
  rollbackTeamAssembly,
  stateRootOf,
  teamLockKey,
  workspaceOf,
  type ExpertToolsCore,
  type ToolsConfig,
} from './team-core.ts'
import type { CompileFailure, ExecutionPlan } from './v2/compiler.ts'
import type { ModelPolicy } from './v2/types.ts'

/** Runtime assembly metadata supplied by the thin adapters. */
export interface ApplyPlanOptions {
  /** TeamState.name; sanitizeKey → team id (unchanged semantics). */
  teamName: string
  /** TeamState.description — already fully composed by the adapter (incl. skill blocks). */
  description: string
  /** Runtime-derived interpolation values merged over plan.params (string values only). */
  interpolations?: Readonly<Record<string, string>>
  /** Strict member-add order (expert ids). Defaults to roster order; must cover every roster expert. */
  memberOrder?: readonly string[]
  /** Per-expert display extras for fan-out naming ({expertName}/{expertField}/{expertInitials}). */
  expertDisplay?: ReadonlyMap<string, { name: string; field?: string; initials?: string }>
  /** Physical taskId → text appended to the interpolated description (skill blocks). */
  taskSuffixes?: Readonly<Record<string, string>>
  /** Kick once after the full DAG is seeded (default true). */
  kick?: boolean
}

/** One physical task of the expanded team DAG. */
export interface PhysicalTask {
  /** Runtime task id (`t1..tN` in creation order). */
  readonly id: string
  /** CompiledTask id it derives from. */
  readonly logicalId: string
  /** Position among the logical task's expertIds (fan-out), when expanded. */
  readonly fanOutIndex?: number
  /** Interpolated subject. */
  readonly subject: string
  /** Interpolated description (+ taskSuffix), when the logical task had one. */
  readonly description?: string
  /** Physical ids of every upstream logical task, in creation order. */
  readonly dependsOn: readonly string[]
  /** Expert owning this physical task; undefined ⇒ shared pool (unassigned). */
  readonly assigneeExpertId?: string
}

/** Compiled-plan identity persisted on TeamState for traceability. */
export interface PlanRef {
  readonly planId: string
  readonly digest: string
  readonly templateId: string
  readonly templateVersion: string
  readonly scenarioId?: string
}

/** Pure expansion: plan → roster members + physical tasks + plan ref. */
export interface ExpandedPlan {
  readonly members: readonly { slotId: string; expertId: string; modelPolicy?: ModelPolicy }[]
  readonly tasks: readonly PhysicalTask[]
  readonly planRef: PlanRef
}

/** Result of a successful plan application (tool output shapes preserved). */
export interface ApplyPlanResult {
  team_id: string
  team_name: string
  members: { expert_id: string; member_name: string; model: string }[]
  tasks: { task_id: string; subject: string; assignee?: string }[]
  plan: PlanRef
}

/** Convert a failed CompileResult into a loud, structured Error. */
export function compileErrorOf(result: CompileFailure): Error {
  const lines = result.errors.map(error =>
    `${error.kind}:${error.code}${error.path === undefined ? '' : ` @${error.path}`} — ${error.message}`)
  return new Error(`编译团队方案失败（${result.errorKind}）：\n${lines.join('\n')}`)
}

/** Replace `{key}` placeholders present in `values`; unknown tokens stay verbatim. */
function interpolate(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => values[key] ?? match)
}

/** Interpolation values for one physical task: params + opts + derived keys. */
function taskValues(
  plan: ExecutionPlan,
  opts: ApplyPlanOptions,
  expertId: string | undefined,
  dependencies: readonly string[],
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(plan.params)) {
    if (typeof value === 'string') values[key] = value
  }
  if (opts.interpolations !== undefined) {
    for (const [key, value] of Object.entries(opts.interpolations)) {
      if (typeof value === 'string') values[key] = value
    }
  }
  values['dependencies'] = dependencies.join(', ')
  if (expertId !== undefined) {
    values['expertId'] = expertId
    const display = opts.expertDisplay?.get(expertId)
    values['expertName'] = display?.name ?? expertId
    if (display?.field !== undefined) values['expertField'] = display.field
    if (display?.initials !== undefined) values['expertInitials'] = display.initials
  }
  return values
}

/** Interpolate a logical description and append the task suffix (if any). */
function buildDescription(
  description: string | undefined,
  values: Readonly<Record<string, string>>,
  suffix: string | undefined,
): { description: string } | Record<string, never> {
  if (description === undefined) {
    // No description: the suffix (e.g. a skill block) becomes the description.
    return suffix === undefined || suffix === '' ? {} : { description: suffix }
  }
  const base = interpolate(description, values)
  return suffix === undefined || suffix === '' ? { description: base } : { description: base + suffix }
}

/**
 * Pure: expand one compiled ExecutionPlan into the physical team shape the
 * runtime cores consume. Deterministic — the same plan + opts always produces
 * the same `ExpandedPlan` (golden property).
 */
export function expandExecutionPlan(plan: ExecutionPlan, opts: ApplyPlanOptions): ExpandedPlan {
  // 1. Roster → members, deduped by expertId (first occurrence wins).
  const seen = new Set<string>()
  const rosterMembers: { slotId: string; expertId: string; modelPolicy?: ModelPolicy }[] = []
  for (const member of plan.roster) {
    if (seen.has(member.expertId)) continue
    seen.add(member.expertId)
    rosterMembers.push({
      slotId: member.slotId,
      expertId: member.expertId,
      ...(member.modelPolicy === undefined ? {} : { modelPolicy: { ...member.modelPolicy } }),
    })
  }
  let members = rosterMembers
  if (opts.memberOrder !== undefined) {
    const order = [...opts.memberOrder]
    if (new Set(order).size !== order.length) {
      throw new Error('apply: memberOrder must not contain duplicates')
    }
    const covered = new Set(order)
    for (const member of rosterMembers) {
      if (!covered.has(member.expertId)) {
        throw new Error(`apply: memberOrder is missing roster expert "${member.expertId}"`)
      }
    }
    const byId = new Map(rosterMembers.map(member => [member.expertId, member]))
    members = order.map((expertId) => {
      const found = byId.get(expertId)
      if (found === undefined) throw new Error(`apply: memberOrder references unknown expert "${expertId}"`)
      return found
    })
  }

  // 2. Logical tasks → physical tasks, in executionOrder (creation order).
  const byId = new Map(plan.tasks.map(task => [task.id, task]))
  const logicalToPhysical = new Map<string, string[]>()
  const tasks: PhysicalTask[] = []
  let seq = 0
  for (const logicalId of plan.executionOrder) {
    const logical = byId.get(logicalId)
    if (logical === undefined) continue // compile-time validated; defensive
    const deps = logical.dependsOn.flatMap(depId => logicalToPhysical.get(depId) ?? [])
    const physicalIds: string[] = []
    if (logical.expertIds.length === 0) {
      // No-expert task: one unassigned physical task (shared pool).
      seq += 1
      const id = `t${seq}`
      physicalIds.push(id)
      const values = taskValues(plan, opts, undefined, deps)
      tasks.push({
        id,
        logicalId: logical.id,
        subject: interpolate(logical.subject ?? '', values),
        ...buildDescription(logical.description, values, opts.taskSuffixes?.[id]),
        dependsOn: [...deps],
      })
    } else {
      // Fan-out: one physical task per rostered expert id, in roster order.
      logical.expertIds.forEach((expertId, index) => {
        seq += 1
        const id = `t${seq}`
        physicalIds.push(id)
        const values = taskValues(plan, opts, expertId, deps)
        tasks.push({
          id,
          logicalId: logical.id,
          fanOutIndex: index,
          subject: interpolate(logical.subject ?? '', values),
          ...buildDescription(logical.description, values, opts.taskSuffixes?.[id]),
          dependsOn: [...deps],
          assigneeExpertId: expertId,
        })
      })
    }
    logicalToPhysical.set(logical.id, physicalIds)
  }

  const planRef: PlanRef = {
    planId: plan.planId,
    digest: plan.digest,
    templateId: plan.template.id,
    templateVersion: plan.template.version,
    ...(plan.scenario?.id === undefined ? {} : { scenarioId: plan.scenario.id }),
  }
  return { members, tasks, planRef }
}

/**
 * Runtime: materialize a compiled plan into a live team through the exact
 * same transactional cores the imperative assemblers used, then kick the
 * team once. Every step (create / members / tasks / provenance write / kick)
 * is inside one try block — any failure rolls the team back via
 * `rollbackTeamAssembly` before the error surfaces.
 */
export async function applyExecutionPlan(
  ctx: Context,
  config: ToolsConfig,
  captain: Agent,
  plan: ExecutionPlan,
  opts: ApplyPlanOptions,
  signal: AbortSignal,
  core: ExpertToolsCore,
): Promise<ApplyPlanResult> {
  const workspace = workspaceOf(captain)
  const expanded = expandExecutionPlan(plan, opts)
  const team = await createTeamCore(ctx, config, captain, {
    name: opts.teamName,
    description: opts.description,
    ...(plan.scenario?.id === undefined ? {} : { scenarioId: plan.scenario.id }),
  }, signal)

  try {
    // Members: one per distinct rostered expert, route resolved by the live
    // library (preset expert route wins) — the plan's modelPolicy is never
    // passed as a route override.
    const memberNameByExpert = new Map<string, string>()
    const members: ApplyPlanResult['members'] = []
    for (const member of expanded.members) {
      const added = await addMemberCore(ctx, config, captain, { expert: member.expertId }, signal, core.memberSelections)
      memberNameByExpert.set(member.expertId, added.member_name)
      members.push({
        expert_id: member.expertId,
        member_name: added.member_name,
        model: `${added.provider}/${added.model}`,
      })
    }

    // Tasks: physical DAG in creation order; assignee by member name.
    const tasks: ApplyPlanResult['tasks'] = []
    for (const task of expanded.tasks) {
      const assignee = task.assigneeExpertId === undefined ? undefined : memberNameByExpert.get(task.assigneeExpertId)
      const created = await createTaskCore(ctx, config, captain, {
        subject: task.subject,
        ...task.description === undefined ? {} : { description: task.description },
        ...task.dependsOn.length > 0 ? { dependencies: [...task.dependsOn] } : {},
        ...assignee === undefined ? {} : { assignee },
      }, signal)
      tasks.push({ task_id: created.task_id, subject: created.subject, ...assignee === undefined ? {} : { assignee } })
    }

    // Persist plan provenance on the durable team record (inside the try
    // block, so a failure here also rolls the team back).
    const stateRoot = stateRootOf(workspace, config)
    const taskPlanMap = new Map(expanded.tasks.map(task => [task.id, {
      logicalId: task.logicalId,
      ...(task.fanOutIndex === undefined ? {} : { fanOutIndex: task.fanOutIndex }),
    }]))
    await withTeamLock(teamLockKey(stateRoot, team.team_id), async () => {
      const fresh = await readTeam(stateRoot, team.team_id)
      if (fresh === undefined) return
      fresh.planRef = expanded.planRef
      fresh.planProvenance = { params: { ...plan.params }, compile: plan.provenance }
      for (const task of fresh.tasks) {
        const planTask = taskPlanMap.get(task.id)
        if (planTask !== undefined) task.planTask = planTask
      }
      await writeTeam(stateRoot, fresh)
    })

    if (opts.kick !== false) {
      await core.scheduler.kickTeam(workspace, team.team_id, captain)
    }
    return { team_id: team.team_id, team_name: team.team_name, members, tasks, plan: expanded.planRef }
  } catch (error) {
    await rollbackTeamAssembly(ctx, config, captain, team.team_id, signal)
    throw error
  }
}
