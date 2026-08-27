/**
 * Task-completion quality gates — the runtime wiring that closes the gap
 * between the V2 `quality-runtime` (a pure chain with zero callers) and the
 * Expert Teams task lifecycle.
 *
 * `expert_teams_update_task` evaluates the applicable quality chain whenever
 * a task transitions to `completed`:
 *
 * - **Plan quality policy first** — a team assembled through the V2 apply
 *   bridge carries the compiled plan's gate chain stamped on its durable
 *   record (`TeamState.qualityPlan`, see {@link stampQualityPlan}), so
 *   completion evaluates exactly the gates the plan bound, without
 *   re-reading the pack or recompiling.
 * - **Legacy policy fallback** — a team without a stamp (created before the
 *   stamp existed, or assembled imperatively with a scenario id) resolves the
 *   pack's legacy quality policy for its scenario. Today those policies carry
 *   no executable gates, which means "nothing to run" — completion behavior
 *   is unchanged (no regression for ad-hoc teams).
 * - **Hard-gate semantics** — a failing hard gate **blocks** the completion
 *   with a structured error (gate id, reason, correction guidance); the
 *   member fixes the output and retries. The task stays claimed/in_progress.
 * - **Repair budget (≤2 rounds)** — each block is recorded on the task
 *   (`TeamTask.gateFailCount`). Once the plan policy's `maxRepairRounds`
 *   (design cap `MAX_REPAIR_ROUNDS = 2`) is spent, the next completion may
 *   proceed with a recorded warning instead of blocking forever.
 * - **Soft gates** — warnings are attached to the task result
 *   (`TeamTask.gateWarnings`) and returned to the caller.
 * - **Aggregate score + subject marker** — every gated run derives a
 *   transparent 0–100 score (`deriveQualityScore`: hard gates all pass = base
 *   80 + soft-gate pass-ratio ×20; a failing hard gate = low band 0–59 by
 *   pass ratio) and stamps it idempotently into
 *   the task title as 「质 NN」(or 「质 NN·硬门未过」 when a hard gate blocks),
 *   so the activity panel shows the latest quality verdict on the task.
 * - **Output-schema enforcement** — when the bound quality policy declares a
 *   `schema-structure` gate and the task's output binds a resolvable
 *   output-template contract (stamped from the plan's `outputTemplates`), a
 *   contract-driven schema-structure gate is injected into the chain at
 *   completion: the submitted output must satisfy the plan's declared output
 *   schema (JSON templates must parse; every required section marker must
 *   appear), with corrections naming the missing pieces. Legacy/collab and
 *   ad-hoc teams are untouched (their policies declare no such gate).
 * - **Anonymization compliance** — the builtin evaluators receive the zhijian
 *   expert identities (real names, deceased experts) as compliance terms, so
 *   the 已故专家 (bk-022) / 领域·首字母 rules run through the same chain.
 *
 * Pure module (no I/O, no ctx): every function is synchronous and
 * deterministic given its inputs, so the tool wiring and the tests share one
 * code path.
 * @module dsh-expert-library/task-gates
 */

import type { ExecutionPlan } from './v2/compiler.ts'
import type { DomainPackV2, GateIssue, OutputTemplate, QualityGateSpec, QualityPolicy } from './v2/types.ts'
import { builtinLegacyPack } from './v2/compat.ts'
import { buildZhijianDomainPack } from './v2/zhijian-pack.ts'
import {
  MAX_REPAIR_ROUNDS,
  runQualityChain,
  type GateArtifact,
  type GateEvaluatorMap,
  type GateOutputTemplate,
  type QualityChainResult,
} from './v2/quality.ts'
import { createBuiltinGateEvaluators, type BuiltinComplianceTerms } from './v2/builtin-gates.ts'
import type { StampedGate, StampedOutputTemplate, StampedQualityPlan, TeamState, TeamTask } from './types.ts'
import { ZHIJIAN_EXPERTS } from './zhijian/data/experts.generated.ts'

/* ------------------------------------------------------------------ */
/* Apply-time stamp                                                    */
/* ------------------------------------------------------------------ */

/** Design cap on the stamped repair budget, mirroring `runQualityChain`. */
const BUDGET_CAP = MAX_REPAIR_ROUNDS

/** Lazily-built zhijian pack, reused across applies (pure in-memory builder). */
let zhijianPackCache: DomainPackV2 | undefined

/**
 * Resolve one bound policy entity from the resolvable packs (builtin legacy
 * pack first — already cached by the compile path — then the zhijian
 * builder). Deterministic for a given id/version.
 */
function resolvedPolicy(id: string, version: string): QualityPolicy | undefined {
  const builtin = builtinLegacyPack()
  let found = builtin.qualityPolicies.find(policy => policy.id === id && policy.version === version)
  if (found === undefined) {
    if (zhijianPackCache === undefined) zhijianPackCache = buildZhijianDomainPack()
    found = zhijianPackCache.qualityPolicies.find(policy => policy.id === id && policy.version === version)
  }
  return found
}

/**
 * Resolve one bound output template entity from the resolvable packs. The
 * collab output template lives in the collab module (not in either pack), so
 * collab plans resolve to `undefined` — schema-structure contract validation
 * simply does not apply to them (they declare no schema-structure gate either).
 */
function resolveOutputTemplate(id: string, version: string): OutputTemplate | undefined {
  const builtin = builtinLegacyPack()
  let found = builtin.outputTemplates.find(template => template.id === id && template.version === version)
  if (found === undefined) {
    if (zhijianPackCache === undefined) zhijianPackCache = buildZhijianDomainPack()
    found = zhijianPackCache.outputTemplates.find(template => template.id === id && template.version === version)
  }
  return found
}

/**
 * Resolve the bound policy's declared `maxRepairRounds` from the resolvable
 * packs. Deterministic for a given id/version; defaults to the design cap (2)
 * when no policy is resolvable or it declares none.
 */
function policyMaxRepairRounds(policies: readonly { readonly id: string; readonly version: string }[]): number {
  const ref = policies[0]
  if (ref !== undefined) {
    const found = resolvedPolicy(ref.id, ref.version)
    if (found !== undefined) {
      return Math.min(found.maxRepairRounds ?? BUDGET_CAP, BUDGET_CAP)
    }
  }
  return BUDGET_CAP
}

/**
 * Copy a compiled `ExecutionPlan`'s quality surface onto the durable team
 * record as a JSON-safe {@link StampedQualityPlan}. Called once per team
 * apply, inside the same transactional lock that persists `planRef`.
 */
export function stampQualityPlan(plan: ExecutionPlan): StampedQualityPlan {
  const gates: StampedGate[] = plan.gates.map(gate => ({
    id: gate.id,
    policyId: gate.policyId,
    ...(gate.policyVersion === undefined ? {} : { policyVersion: gate.policyVersion }),
    gateId: gate.gateId,
    kind: gate.kind,
    phase: gate.phase,
    severity: gate.severity,
    appliesTo: [...gate.appliesTo],
    chainOrder: gate.chainOrder,
    ...(gate.implementation === undefined ? {} : { implementation: gate.implementation }),
    ...(gate.config === undefined ? {} : { config: { ...gate.config } }),
  }))
  // Output-schema contracts of the bound templates + per-logical-task binding
  // (from `CompiledTask.outputSchema`), so completion can validate the
  // submitted output against the plan's declared schema without re-reading
  // the pack.
  const outputTemplates: StampedOutputTemplate[] = []
  for (const ref of plan.bindings.outputTemplates) {
    const found = resolveOutputTemplate(ref.id, ref.version)
    if (found !== undefined) {
      outputTemplates.push({
        id: found.id,
        media: [...found.media],
        sections: found.sections.map(section => ({ id: section.id, required: section.required })),
      })
    }
  }
  const taskOutputSchemas: Record<string, string> = {}
  for (const task of plan.tasks) taskOutputSchemas[task.id] = task.outputSchema
  // The bound policy's schema-structure gate instance: when declared, plan
  // teams get the contract-driven structure gate injected at completion.
  let schemaStructure: StampedQualityPlan['schemaStructure']
  for (const ref of plan.bindings.qualityPolicies) {
    const policy = resolvedPolicy(ref.id, ref.version)
    const gate = policy?.gates.find(candidate => candidate.id === 'schema-structure')
    if (gate !== undefined) {
      schemaStructure = {
        policyId: ref.id,
        severity: gate.severity,
        ...(gate.config === undefined ? {} : { config: { ...gate.config } }),
      }
      break
    }
  }
  return {
    planId: plan.planId,
    policies: plan.bindings.qualityPolicies.map(policy => ({ id: policy.id, version: policy.version })),
    gates,
    deliverables: plan.deliverables.map(deliverable => ({ id: deliverable.id, fromTasks: [...deliverable.fromTasks] })),
    maxRepairRounds: policyMaxRepairRounds(plan.bindings.qualityPolicies),
    outputTemplates,
    taskOutputSchemas,
    ...(schemaStructure === undefined ? {} : { schemaStructure }),
  }
}

/* ------------------------------------------------------------------ */
/* Compliance terms (anonymization runs through the same chain)        */
/* ------------------------------------------------------------------ */

/** Static zhijian compliance terms: real names + deceased experts. */
let zhijianComplianceCache: BuiltinComplianceTerms | undefined

/**
 * The anonymization terms the zhijian policy's `compliance-anonymization`
 * gate enforces: every zhijian expert's real name is blocked from external
 * deliverables (对外只列「领域·首字母」), and the names of deceased experts
 * (已故专家, e.g. bk-022 顾云昌) are only allowed in explicitly historical
 * citations (handled by the gate's historical markers).
 */
export function zhijianComplianceTerms(): BuiltinComplianceTerms {
  if (zhijianComplianceCache !== undefined) return zhijianComplianceCache
  const blockedTerms: string[] = []
  const deceasedTerms: string[] = []
  for (const meta of ZHIJIAN_EXPERTS) {
    blockedTerms.push(meta.name)
    if (meta.deceased === true) deceasedTerms.push(meta.name)
  }
  zhijianComplianceCache = { blockedTerms, deceasedTerms }
  return zhijianComplianceCache
}

/** Shared evaluator map: builtin deterministic gates + zhijian compliance terms. */
let evaluatorCache: GateEvaluatorMap | undefined

function builtinEvaluators(): GateEvaluatorMap {
  if (evaluatorCache === undefined) {
    evaluatorCache = createBuiltinGateEvaluators({ compliance: zhijianComplianceTerms() })
  }
  return evaluatorCache
}

/* ------------------------------------------------------------------ */
/* Plan resolution                                                     */
/* ------------------------------------------------------------------ */

/** Gates selected for one completing task, ready for `runQualityChain`. */
interface ResolvedTaskGates {
  readonly planId?: string
  /** Compiled (stamped) gates or raw policy specs, already task-relevant. */
  readonly gates: readonly StampedGate[] | readonly QualityGateSpec[]
  /** Repair budget honored across completion attempts (0..2). */
  readonly maxRepairRounds: number
  /** Deliverables compose-able now (all source tasks completed). */
  readonly compose: ReadonlyArray<{ readonly id: string; readonly fromTasks: readonly string[] }>
  /** The bound policy's schema-structure gate instance (injection source). */
  readonly schemaStructure?: { readonly policyId: string; readonly severity: 'hard' | 'soft'; readonly config?: Readonly<Record<string, unknown>> }
  /** This task's bound output-template contract (schema validation), when resolvable. */
  readonly outputContract?: StampedOutputTemplate
}

/**
 * Select the stamped gates that apply to this task: task-targeted gates whose
 * `appliesTo` names the physical task id or its logical plan id, plus
 * deliverable-targeted gates for every deliverable whose sources are all
 * complete (the completing task included).
 *
 * Compiled plans name **logical** task ids (e.g. the fusion task `t2`). After
 * reviewer fan-out the completing task carries a physical id (e.g. `t6` with
 * `planTask.logicalId === 't2'`), so every selected gate's `appliesTo` is
 * rebound onto the physical ids and every deliverable's logical `fromTasks`
 * is expanded to its physical realizations — otherwise the quality runtime
 * cannot bind an artifact and fails the gate with `gate-artifact-missing`.
 */
/** Every physical team task id that realizes a (possibly logical) source id. */
function physicalTaskIdsFor(team: TeamState, sourceId: string): string[] {
  const ids = team.tasks
    .filter(candidate => candidate.id === sourceId || candidate.planTask?.logicalId === sourceId)
    .map(candidate => candidate.id)
  return ids.length > 0 ? ids : [sourceId]
}

function selectStampedGates(
  plan: StampedQualityPlan,
  team: TeamState,
  task: TeamTask,
): { gates: readonly StampedGate[]; compose: ReadonlyArray<{ readonly id: string; readonly fromTasks: readonly string[] }> } {
  const logicalId = task.planTask?.logicalId
  const compose: Array<{ id: string; fromTasks: readonly string[] }> = []
  const gates: StampedGate[] = []
  for (const gate of plan.gates) {
    const taskTargets = gate.appliesTo.filter(target => target !== 'deliverable')
    const taskHit = taskTargets.some(target =>
      target === task.id || target === logicalId
      || (target !== logicalId && physicalTaskIdsFor(team, target).includes(task.id)))
    let composed = false
    if (gate.appliesTo.includes('deliverable')) {
      for (const deliverable of plan.deliverables) {
        // Logical source ids → physical task ids (deduped, input order kept).
        const physicalSources = [...new Set(
          deliverable.fromTasks.flatMap(sourceId => physicalTaskIdsFor(team, sourceId)),
        )]
        if (!physicalSources.includes(task.id)) continue
        const allComplete = physicalSources.every(sourceId =>
          sourceId === task.id || team.tasks.some(candidate => candidate.id === sourceId && candidate.status === 'completed'))
        if (allComplete && !compose.some(candidate => candidate.id === deliverable.id)) {
          compose.push({ id: deliverable.id, fromTasks: physicalSources })
        }
        composed = composed || allComplete
      }
    }
    if (!taskHit && !composed) continue
    // Rebind logical targets the completing task realizes to its physical id,
    // and any other logical target to the physical id that realizes it, so
    // the runtime can resolve an artifact for every named target.
    const appliesTo = gate.appliesTo.map(target => {
      if (target === 'deliverable' || target === task.id) return target
      if (target === logicalId) return task.id
      const physical = physicalTaskIdsFor(team, target)
      return physical.includes(task.id) ? task.id : target
    })
    gates.push({ ...gate, appliesTo })
  }
  return { gates, compose }
}

/**
 * Legacy-policy fallback: resolve the pack's legacy quality policy for the
 * team's scenario. Legacy policies carry no executable gates today — this
 * resolves to `undefined` (behave exactly as before) unless a resolvable
 * policy actually binds task-targeted gates, which then run through the same
 * chain with raw specs.
 */
function resolveFallbackGates(team: TeamState, task: TeamTask): ResolvedTaskGates | undefined {
  const scenarioId = team.planRef?.scenarioId ?? team.scenarioId
  if (scenarioId === undefined) return undefined
  const pack = builtinLegacyPack()
  const scenario = pack.scenarios.find(candidate => candidate.id === scenarioId)
  const policyId = scenario?.qualityPolicy
  if (policyId === undefined) return undefined
  const policy = pack.qualityPolicies.find(candidate => candidate.id === policyId)
  if (policy === undefined || policy.gates.length === 0) return undefined
  const taskTargets = new Set(
    [task.id, task.planTask?.logicalId].filter((id): id is string => id !== undefined),
  )
  const gates = policy.gates.filter(gate =>
    gate.appliesTo.some(target => target !== 'deliverable' && taskTargets.has(target)))
  if (gates.length === 0) return undefined
  return {
    gates,
    maxRepairRounds: Math.min(policy.maxRepairRounds ?? BUDGET_CAP, BUDGET_CAP),
    compose: [],
  }
}

/** Resolve the plan quality surface for one completing task, or undefined. */
function resolveTaskQualityPlan(team: TeamState, task: TeamTask): ResolvedTaskGates | undefined {
  const stamped = team.qualityPlan
  if (stamped !== undefined) {
    const { gates, compose } = selectStampedGates(stamped, team, task)
    // Resolve this task's bound output-template contract (logical plan task →
    // outputSchema → contract), used by the injected schema-structure gate.
    // Defensive: stamps created before the contract fields existed (or
    // synthetic fixtures) simply have no contract — no schema injection.
    const logicalId = task.planTask?.logicalId ?? task.id
    const templateId = (stamped.taskOutputSchemas ?? {})[logicalId]
    const outputContract = templateId === undefined
      ? undefined
      : (stamped.outputTemplates ?? []).find(template => template.id === templateId)
    return {
      planId: stamped.planId,
      gates,
      maxRepairRounds: stamped.maxRepairRounds,
      compose,
      ...(stamped.schemaStructure === undefined ? {} : { schemaStructure: stamped.schemaStructure }),
      ...(outputContract === undefined ? {} : { outputContract }),
    }
  }
  return resolveFallbackGates(team, task)
}

/* ------------------------------------------------------------------ */
/* Outcomes                                                            */
/* ------------------------------------------------------------------ */

/** A hard-gate block: what the member must fix, and where the budget stands. */
export interface TaskGateBlock {
  /** Task being completed. */
  readonly taskId: string
  /** First hard-failing gate in chain order (headline). */
  readonly gateId: string
  /** Human-readable reason: every hard issue (code/location/evidence). */
  readonly reason: string
  /** Unique correction hints from the hard issues. */
  readonly corrections: readonly string[]
  /** Budget counter value after this block (attempts used so far). */
  readonly budgetUsed: number
  /** Plan policy budget (0..2); 0 means no repair rounds are granted. */
  readonly budgetTotal: number
  /** Derived 0–100 aggregate score of this (failing) run. */
  readonly score: number
}

/** Result of evaluating the quality chain for one completion attempt. */
export interface TaskGateResult {
  /** Present when a hard gate failed and the repair budget is not yet spent. */
  readonly blocked?: TaskGateBlock
  /** Soft-gate warnings, or hard failures waived by budget exhaustion. */
  readonly warnings: readonly string[]
  /** True when hard failures were waived because the budget ran out. */
  readonly budgetExhausted: boolean
  /** Derived 0–100 aggregate score of the final round. */
  readonly score: number
  /** The underlying chain result (final round, hashes, summary). */
  readonly result: QualityChainResult
}

/** Hard failures of the final round, in chain order. */
function hardFailures(result: QualityChainResult): ReadonlyArray<{ gateId: string; issues: readonly GateIssue[] }> {
  const last = result.rounds[result.rounds.length - 1]
  return (last?.failures ?? []).filter(failure => failure.severity === 'hard')
}

/** Soft-gate issues of the final round, formatted as warning lines. */
function collectWarnings(result: QualityChainResult): string[] {
  const last = result.rounds[result.rounds.length - 1]
  const out: string[] = []
  for (const gateResult of last?.results ?? []) {
    if (gateResult.status !== 'warn') continue
    for (const issue of gateResult.issues) {
      const location = issue.location === undefined ? '' : ` @${issue.location}`
      out.push(
        `${gateResult.gateId} [${issue.code}]${location}: ${issue.evidence ?? ''}`
        + (issue.correction === undefined ? '' : `（${issue.correction}）`),
      )
    }
  }
  return out
}

/** Headline + reason + corrections from every hard failure of the final round. */
function buildBlock(taskId: string, result: QualityChainResult): { gateId: string; reason: string; corrections: readonly string[] } {
  const failures = hardFailures(result)
  const gateId = failures[0]?.gateId ?? 'unknown-gate'
  const reasonLines: string[] = []
  const corrections: string[] = []
  for (const failure of failures) {
    for (const issue of failure.issues) {
      const location = issue.location === undefined ? '' : ` @${issue.location}`
      reasonLines.push(`- ${failure.gateId} [${issue.code}]${location}: ${issue.evidence ?? 'no evidence'}`)
      if (issue.correction !== undefined && !corrections.includes(issue.correction)) {
        corrections.push(issue.correction)
      }
    }
  }
  return { gateId, reason: reasonLines.join('\n'), corrections }
}

/* ------------------------------------------------------------------ */
/* Aggregate score + subject marker                                    */
/* ------------------------------------------------------------------ */

/** Base score when every hard gate passes (hard gates all pass = the base). */
export const QUALITY_BASE_SCORE = 80
/** Soft-gate pass-ratio weight on top of the base (soft all pass ⇒ 100). */
export const QUALITY_SOFT_WEIGHT = 20
/** Ceiling for a run with a failing hard gate (low band 0–59 by pass ratio). */
export const QUALITY_HARD_FAIL_MAX = 59

/**
 * Derived 0–100 aggregate quality score for one gate-chain run.
 *
 * `GateResult.score` (an optional 1–5 rubric field in `src/v2/types.ts`) has
 * no aggregation semantics in `runQualityChain`, and the builtin deterministic
 * evaluators (`createBuiltinGateEvaluators`) only produce pass/warn/fail
 * verdicts — so no evaluator-provided score exists to consume. Until an
 * evaluator starts emitting rubric scores (the documented extension point),
 * the aggregate is derived transparently from the final round's verdicts:
 *
 * - **hard gates all pass ⇒ `80 + 20 × softPassRatio`** — the base is 80
 *   (hard gates all pass), the remaining 20 points are weighted by the
 *   proportion of soft gates that pass (`softPassRatio` = passed soft gates /
 *   total soft gates; **no soft gates ⇒ ratio 1 ⇒ 100**). A soft gate with
 *   warn issues counts as not fully passed.
 * - **a failing hard gate ⇒ low band `0–59` by overall pass ratio**
 *   (`passRatio` = passed gates / total gates); delivery is blocked and the
 *   subject marker carries 硬门未过.
 * - clamped to the band (80–100 / 0–59) and rounded to an integer.
 *
 * `severityById` maps gate id → severity so pass/warn gates can be told apart
 * (a failing gate's severity also lives in its failure record). Deterministic
 * for a fixed chain result; the rule is intentionally simple so the marker
 * (「质 NN」) can be audited back to the verdicts.
 */
export function deriveQualityScore(
  result: QualityChainResult,
  severityById: ReadonlyMap<string, 'hard' | 'soft'> = new Map(),
): number {
  const last = result.rounds[result.rounds.length - 1]
  const gates = last?.results ?? []
  if (gates.length === 0) return 0
  const isHard = (gateId: string): boolean => {
    const known = severityById.get(gateId)
    if (known !== undefined) return known === 'hard'
    // No severity map supplied: a failing gate's severity is carried by its
    // failure record; a pass/warn gate is treated as soft.
    const failure = last?.failures.find(candidate => candidate.gateId === gateId)
    return failure?.severity === 'hard'
  }
  const hardFail = gates.some(gate => gate.status === 'fail' && isHard(gate.gateId))
  if (hardFail) {
    const passCount = gates.filter(gate => gate.status === 'pass').length
    const score = Math.round(QUALITY_HARD_FAIL_MAX * passCount / gates.length)
    return Math.max(0, Math.min(QUALITY_HARD_FAIL_MAX, score))
  }
  const softGates = gates.filter(gate => !isHard(gate.gateId))
  const softPassRatio = softGates.length === 0
    ? 1
    : softGates.filter(gate => gate.status === 'pass').length / softGates.length
  const score = Math.round(QUALITY_BASE_SCORE + QUALITY_SOFT_WEIGHT * softPassRatio)
  return Math.max(QUALITY_BASE_SCORE, Math.min(QUALITY_BASE_SCORE + QUALITY_SOFT_WEIGHT, score))
}

/**
 * The idempotent subject marker: 「质 NN」 or 「质 NN·硬门未过」 (blocked).
 * Replaces any existing marker instead of stacking, so repeated evaluations
 * (e.g. retry after a hard-gate block) rewrite the marker in place.
 */
const QUALITY_MARK_RE = /〔质\s*\d+(?:·[^〕]*)?〕/u

export function subjectWithQualityMark(subject: string, score: number, blocked: boolean): string {
  const base = subject.replace(QUALITY_MARK_RE, '').trimEnd()
  const marker = blocked ? `〔质 ${score}·硬门未过〕` : `〔质 ${score}〕`
  return `${base} ${marker}`
}

/**
 * Evaluate the applicable quality chain for a task completion attempt.
 *
 * Returns `undefined` when no gate applies (ad-hoc team, no resolvable
 * policy, or no gate targets this task) — the caller then behaves exactly as
 * before. Otherwise:
 *
 * - `blocked` — a hard gate failed and the repair budget is not spent; the
 *   caller must persist `budgetUsed` as the task's `gateFailCount`, then
 *   reject the completion with `taskGateBlockedError`.
 * - allowed with `budgetExhausted` — hard gates still fail but the policy's
 *   repair budget (≤2 rounds) is spent; the completion may proceed with a
 *   recorded warning.
 * - allowed otherwise — pass (with soft-gate `warnings` when any).
 */
export function evaluateTaskCompletionGates(
  team: TeamState,
  task: TeamTask,
  output: string | undefined,
): TaskGateResult | undefined {
  const plan = resolveTaskQualityPlan(team, task)
  if (plan === undefined) return undefined

  // Inject the contract-driven schema-structure gate: when the bound quality
  // policy declares `schema-structure` AND this task's output binds a
  // resolvable output-template contract, the declared output schema must be
  // enforced at completion. Unless the template already bound a
  // schema-structure gate to this task, one is injected at the head of the
  // chain (structure phase) with the policy's severity (zhijian: hard).
  let gates: ResolvedTaskGates['gates'] = plan.gates
  let taskOutputTemplates: Record<string, GateOutputTemplate> | undefined
  if (plan.schemaStructure !== undefined && plan.outputContract !== undefined) {
    const logicalId = task.planTask?.logicalId
    const alreadyBound = gates.some(gate => {
      const gateId = 'gateId' in gate ? gate.gateId : gate.id
      return gateId === 'schema-structure'
        && gate.appliesTo.some(target => target !== 'deliverable' && (target === task.id || target === logicalId))
    })
    if (!alreadyBound) {
      const injected: StampedGate = {
        id: `${plan.schemaStructure.policyId}/schema-structure`,
        policyId: plan.schemaStructure.policyId,
        gateId: 'schema-structure',
        kind: 'deterministic',
        phase: 'structure',
        severity: plan.schemaStructure.severity,
        appliesTo: [task.id],
        chainOrder: 0,
        ...(plan.schemaStructure.config === undefined ? {} : { config: { ...plan.schemaStructure.config } }),
      }
      gates = [injected, ...gates]
    }
    taskOutputTemplates = {
      [task.id]: {
        id: plan.outputContract.id,
        media: [...plan.outputContract.media],
        sections: plan.outputContract.sections.map(section => ({ id: section.id, required: section.required })),
      },
    }
  }
  if (gates.length === 0) return undefined

  const artifacts: Record<string, GateArtifact> = { [task.id]: { content: output ?? '' } }
  const deliverableSources: Record<string, readonly string[]> = {}
  for (const deliverable of plan.compose) {
    deliverableSources[deliverable.id] = deliverable.fromTasks
    for (const sourceId of deliverable.fromTasks) {
      if (artifacts[sourceId] !== undefined) continue
      const source = team.tasks.find(candidate => candidate.id === sourceId)
      if (source?.output !== undefined) artifacts[sourceId] = { content: source.output }
    }
  }

  const budget = plan.maxRepairRounds
  const result = runQualityChain({
    gates,
    evaluators: builtinEvaluators(),
    artifacts,
    ...(Object.keys(deliverableSources).length > 0 ? { deliverableSources } : {}),
    maxRepairRounds: budget,
    ...(plan.planId === undefined ? {} : { planId: plan.planId }),
    ...(taskOutputTemplates === undefined ? {} : { taskOutputTemplates }),
  })

  // Gate severity by id (from the compiled/stamped gates) so the aggregate
  // score can weight soft-gate pass ratio vs hard-gate failures correctly.
  const severityById = new Map<string, 'hard' | 'soft'>()
  for (const gate of gates) {
    severityById.set('gateId' in gate ? gate.gateId : gate.id, gate.severity)
  }

  if (result.deliverableAllowed) {
    return {
      warnings: collectWarnings(result),
      budgetExhausted: false,
      score: deriveQualityScore(result, severityById),
      result,
    }
  }

  const { gateId, reason, corrections } = buildBlock(task.id, result)
  const used = task.gateFailCount ?? 0
  const score = deriveQualityScore(result, severityById)
  if (budget === 0 || used < budget) {
    // Hard gate failed and the repair budget still has room (or the policy
    // grants no repair rounds at all): block the completion.
    return {
      blocked: { taskId: task.id, gateId, reason, corrections, budgetUsed: used + 1, budgetTotal: budget, score },
      warnings: [],
      budgetExhausted: false,
      score,
      result,
    }
  }
  // Budget spent: the completion may proceed, with a recorded warning.
  return {
    warnings: [
      ...collectWarnings(result),
      `${gateId}: hard gate still failing after ${budget} blocked attempt(s) — repair budget exhausted, completion proceeds with this warning\n${reason}`,
    ],
    budgetExhausted: true,
    score,
    result,
  }
}

/**
 * The structured error a blocked completion throws: gate id, reason, every
 * correction hint, and the retry contract. The message carries the correction
 * text verbatim so the member (and tests) can act on it directly.
 */
export function taskGateBlockedError(block: TaskGateBlock): Error {
  const relief = block.budgetTotal > 0
    ? `Fix the output and retry expert_teams_update_task with the corrected output; after ${block.budgetTotal} blocked attempt(s) the next completion may proceed with a recorded warning.`
    : `This policy grants no repair rounds; fix the output and retry expert_teams_update_task with the corrected output.`
  const lines = [
    `task ${block.taskId} completion blocked by quality gate "${block.gateId}" (hard, attempt ${block.budgetUsed}/${block.budgetTotal})`,
    `reason:\n${block.reason}`,
    ...block.corrections.map(correction => `correction: ${correction}`),
    relief,
  ]
  return new Error(lines.join('\n'))
}
