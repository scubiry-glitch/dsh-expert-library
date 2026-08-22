/**
 * Phase 4 — Quality Gate Runtime (`quality-runtime`, §3.6/§8).
 *
 * A pure gate-chain orchestrator that consumes the gates of a compiled
 * ExecutionPlan (or raw policy specs) and produces a deterministic
 * {@link QualityChainResult}:
 *
 * - **Deterministic ordering** — gates execute in the plan's `chainOrder`
 *   (compiled from the fixed chain `structure → … → final`); `orderGates`
 *   provides the same ordering for raw specs without relying on map
 *   iteration.
 * - **Hard-fail delivery prevention** — a failed `hard` gate always leaves
 *   `deliverableAllowed: false` (outcome `failed`/`blocked`); soft failures
 *   only `warn`. Nothing is ever delivered past an unresolved hard fail.
 * - **Targeted repair, capped at 2 rounds** — when hard gates fail and a
 *   {@link RepairCallback} is provided, the runtime hands it *only the
 *   failing gates* (with location/evidence/correction and the affected
 *   artifact ids) so it repairs exactly those sections/tasks (§4.4), then
 *   re-runs the chain. A failure on a *composed deliverable* targets its
 *   **source task artifact ids** — the only ids `replacements` can update —
 *   never the bare deliverable id, so repairs are never silently ignored.
 *   At most `MAX_REPAIR_ROUNDS = 2` repair rounds; the caller-passed
 *   `maxRepairRounds` is capped at that constant, and the third failure
 *   round ends `blocked` — never an endless self-edit loop (§8.3).
 * - **Locations, evidence, artifact hashes** — every round records each
 *   gate result with its issues (location/evidence), and the final report
 *   carries SHA-256 hashes of every artifact plus the policy's
 *   `maxRepairRounds`. A gate whose targets cannot be resolved at all
 *   (unknown task id, `deliverable` without `deliverableSources`) fails with
 *   `gate-artifact-missing` — the runtime never concatenates unrelated
 *   artifacts. `deliverable` targets evaluate **every** deliverable (ids
 *   sorted, one result each). Caller-provided artifact hashes are preserved
 *   across repair rounds while content sha-256 is always recomputed.
 *
 * Pure module: no I/O; the only nondeterminism is the injected clock
 * (`now`, defaulting to the wall clock) and the injected evaluators.
 * @module dsh-expert-library/v2/quality
 */

import type { GateIssue, GateKind, GatePhase, GateResult, QualityGateSpec } from './types.ts'
import type { CompiledGate } from './compiler.ts'
import { deepFreeze, sha256Hex } from './digest.ts'
import { gatePhase, phaseRank } from './phases.ts'

/** Design cap for the repair loop (§8.3: 最多 2 轮). */
export const MAX_REPAIR_ROUNDS = 2

/* ------------------------------------------------------------------ */
/* Evaluators                                                          */
/* ------------------------------------------------------------------ */

/** What a gate evaluator receives: the target artifact plus context. */
export interface GateInput {
  /** The artifact text under evaluation (task output or composed deliverable). */
  readonly artifact: string
  /** Task id when the artifact is a single task output. */
  readonly taskId?: string
  /** Deliverable id when the artifact is a composed deliverable. */
  readonly deliverableId?: string
  /** Hashes of the artifact (sha256 of content + any caller-supplied hashes). */
  readonly artifactHashes?: Readonly<Record<string, string>>
  /** Provenance available to semantic gates (provider records, citations…). */
  readonly provenance?: Readonly<Record<string, unknown>>
  /**
   * The bound output template's schema contract (media + required section
   * markers), when the caller supplies it — the schema-structure gate
   * validates the artifact against it (JSON shape / required sections for
   * markdown templates) instead of (or on top of) its config.
   */
  readonly outputTemplate?: Readonly<{
    readonly id: string
    readonly media: readonly string[]
    readonly sections: ReadonlyArray<{ readonly id: string; readonly required: boolean }>
  }>
}

/** Context handed to every evaluator call. */
export interface GateEvaluationContext {
  /** The gate spec being evaluated (id/kind/severity/config). */
  readonly spec: QualityGateSpec
  /** Injected clock; deterministic when supplied by the caller. */
  readonly now: () => string
}

/** One gate evaluator: `(artifact, context) → GateResult`. */
export type GateEvaluator = (input: GateInput, context: GateEvaluationContext) => GateResult

/** Registry keyed by gate id (the id inside the policy; compiled ids also match). */
export type GateEvaluatorMap = Readonly<Record<string, GateEvaluator>>

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/** One artifact (task output or composed deliverable) under evaluation. */
export interface GateArtifact {
  readonly content: string
  /** Caller-verified extra hashes (e.g. rendered md/pdf hashes, §6). */
  readonly hashes?: Readonly<Record<string, string>>
}

/** Output-schema contract passed to gate evaluators (`GateInput.outputTemplate`). */
export type GateOutputTemplate = NonNullable<GateInput['outputTemplate']>

export interface QualityChainInput {
  /** Compiled gates (already chain-ordered) or raw policy specs. */
  readonly gates: readonly CompiledGate[] | readonly QualityGateSpec[]
  readonly evaluators: GateEvaluatorMap
  /** artifactId (task id / deliverable id) → artifact. */
  readonly artifacts: Readonly<Record<string, GateArtifact>>
  /** deliverableId → task ids whose contents compose it (for `deliverable` targets). */
  readonly deliverableSources?: Readonly<Record<string, readonly string[]>>
  /** Targeted repair callback; when absent, hard fails simply block delivery. */
  readonly repair?: RepairCallback
  /** Requested repair rounds; capped at {@link MAX_REPAIR_ROUNDS}. */
  readonly maxRepairRounds?: number
  /** Injected clock; defaults to the wall clock. */
  readonly now?: () => string
  /** ExecutionPlan id attached to the report, when known. */
  readonly planId?: string
  /**
   * taskId → the bound output template's schema contract; handed to the
   * schema-structure gate so it validates the submitted task output against
   * the plan's declared output schema (JSON shape / required section markers).
   */
  readonly taskOutputTemplates?: Readonly<Record<string, GateOutputTemplate>>
}

/* ------------------------------------------------------------------ */
/* Outputs                                                             */
/* ------------------------------------------------------------------ */

/** One failing gate, with the targeted repair surface. */
export interface GateFailure {
  readonly gateId: string
  readonly kind: GateKind
  readonly phase: GatePhase
  readonly severity: 'hard' | 'soft'
  /** Position in the chain (0-based), stable across runs. */
  readonly chainOrder: number
  /** Every issue the gate raised (location/evidence/correction). */
  readonly issues: readonly GateIssue[]
  readonly appliesTo: readonly string[]
  /** Artifact ids (task ids / deliverable id) this failure points at. */
  readonly affectedArtifacts: readonly string[]
}

/** One evaluation round (round 0 = initial; 1..n = after repairs). */
export interface GateRound {
  readonly round: number
  readonly status: 'pass' | 'warn' | 'fail'
  /** Results in chain order. */
  readonly results: readonly GateResult[]
  readonly failures: readonly GateFailure[]
}

/** What the repair callback may repair, and what it returns. */
export interface RepairRequest {
  /** Next round number (1-based). */
  readonly round: number
  readonly maxRounds: number
  /** Only the *hard* failing gates — targeted repair, never whole-chain. */
  readonly failures: readonly GateFailure[]
  /** Current artifact snapshot (sorted keys; hashes included). */
  readonly artifacts: Readonly<Record<string, GateArtifact>>
}

export type RepairAction =
  | { readonly repaired: true; readonly replacements: Readonly<Record<string, string>> }
  | { readonly repaired: false; readonly reason: string }

export type RepairCallback = (request: RepairRequest) => RepairAction

export type QualityOutcome = 'pass' | 'warn' | 'repaired-pass' | 'repaired-warn' | 'blocked' | 'failed'

export interface GateSummary {
  readonly totalGates: number
  readonly passed: number
  readonly warned: number
  readonly failed: number
  readonly repairRoundsUsed: number
  readonly maxRepairRounds: number
}

export interface QualityChainResult {
  readonly outcome: QualityOutcome
  /** False whenever any hard gate remains failed — hard-fail delivery is impossible. */
  readonly deliverableAllowed: boolean
  readonly rounds: readonly GateRound[]
  /** Final SHA-256 of every artifact (after the last repair round). */
  readonly artifactHashes: Readonly<Record<string, string>>
  readonly maxRepairRounds: number
  readonly repairRoundsUsed: number
  readonly summary: GateSummary
  readonly evaluatedAt: string
  readonly planId?: string
}

/* ------------------------------------------------------------------ */
/* Ordering helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Deterministic chain order for raw gate specs: phase rank (§3.6), then
 * declaration index, then gate id. Compiled gates are already ordered; this
 * is for policies evaluated without a compiled plan.
 */
export function orderGates(specs: readonly QualityGateSpec[]): readonly QualityGateSpec[] {
  return specs
    .map((spec, index) => ({ spec, index }))
    .sort((a, b) =>
      phaseRank(gatePhase(a.spec)) - phaseRank(gatePhase(b.spec))
      || a.index - b.index
      || (a.spec.id < b.spec.id ? -1 : a.spec.id > b.spec.id ? 1 : 0))
    .map(entry => entry.spec)
}

/** SHA-256 hex of an artifact's content. */
export function hashArtifact(content: string): string {
  return sha256Hex(content)
}

/* ------------------------------------------------------------------ */
/* Runtime                                                             */
/* ------------------------------------------------------------------ */

interface OrderedGate {
  readonly spec: QualityGateSpec
  readonly chainOrder: number
  readonly kind: GateKind
  readonly phase: GatePhase
  readonly severity: 'hard' | 'soft'
  readonly appliesTo: readonly string[]
  readonly compiledId: string
  readonly gateId: string
}

function orderGatesInput(gates: readonly CompiledGate[] | readonly QualityGateSpec[]): OrderedGate[] {
  const first = gates[0]
  if (first !== undefined && 'chainOrder' in first) {
    return [...(gates as readonly CompiledGate[])]
      .sort((a, b) => a.chainOrder - b.chainOrder)
      .map(gate => ({
        spec: {
          id: gate.gateId,
          kind: gate.kind,
          appliesTo: gate.appliesTo,
          severity: gate.severity,
          ...(gate.phase === undefined ? {} : { phase: gate.phase }),
          ...(gate.implementation === undefined ? {} : { implementation: gate.implementation }),
          ...(gate.config === undefined ? {} : { config: { ...gate.config } }),
        },
        chainOrder: gate.chainOrder,
        kind: gate.kind,
        phase: gate.phase,
        severity: gate.severity,
        appliesTo: gate.appliesTo,
        compiledId: gate.id,
        gateId: gate.gateId,
      }))
  }
  return orderGates(gates as readonly QualityGateSpec[]).map((spec, index) => ({
    spec,
    chainOrder: index,
    kind: spec.kind,
    phase: gatePhase(spec),
    severity: spec.severity,
    appliesTo: spec.appliesTo,
    compiledId: spec.id,
    gateId: spec.id,
  }))
}

interface TargetArtifact {
  readonly id: string
  readonly content: string
  readonly hashes?: Readonly<Record<string, string>>
  readonly isDeliverable: boolean
  /**
   * For composed deliverables: the source task artifact ids the content was
   * composed from. Repair failures target these ids, because replacements
   * are applied to task artifacts — a deliverable id itself is not a
   * replaceable artifact.
   */
  readonly sourceArtifactIds?: readonly string[]
}

/**
 * Resolve the deterministic target list for one gate. Task/section ids map to
 * their artifacts (in `appliesTo` order); `deliverable` expands to **every**
 * deliverable (ids sorted) composed from its source task artifacts. A target
 * that cannot be resolved contributes nothing — the runtime then evaluates
 * the gate with no artifact and fails it with `gate-artifact-missing`; it
 * never silently concatenates unrelated artifacts.
 */
function targetArtifactsFor(
  gate: OrderedGate,
  artifacts: Readonly<Record<string, GateArtifact>>,
  deliverableSources: Readonly<Record<string, readonly string[]>> | undefined,
): TargetArtifact[] {
  const out: TargetArtifact[] = []
  const seen = new Set<string>()
  const push = (target: TargetArtifact): void => {
    if (seen.has(target.id)) return
    seen.add(target.id)
    out.push(target)
  }
  for (const target of gate.appliesTo) {
    if (target === 'deliverable') {
      if (deliverableSources === undefined) continue // unresolvable → gate-artifact-missing
      for (const id of Object.keys(deliverableSources).sort()) {
        const parts: string[] = []
        const used: string[] = []
        for (const taskId of deliverableSources[id] ?? []) {
          const artifact = artifacts[taskId]
          if (artifact !== undefined) {
            parts.push(artifact.content)
            used.push(taskId)
          }
        }
        if (parts.length > 0) push({ id, content: parts.join('\n\n'), isDeliverable: true, sourceArtifactIds: used })
      }
      continue
    }
    const artifact = artifacts[target]
    if (artifact !== undefined) push({ id: target, content: artifact.content, hashes: artifact.hashes, isDeliverable: false })
  }
  return out
}

function evaluateGate(
  gate: OrderedGate,
  evaluators: GateEvaluatorMap,
  target: TargetArtifact | undefined,
  now: () => string,
  taskOutputTemplates: Readonly<Record<string, GateOutputTemplate>> | undefined,
): GateResult {
  const evaluator = evaluators[gate.gateId] ?? evaluators[gate.compiledId]
  if (evaluator === undefined) {
    return {
      gateId: gate.gateId,
      status: 'fail',
      issues: [{ code: 'gate-evaluator-missing', severity: 'error', evidence: `no evaluator registered for gate "${gate.gateId}"` }],
      evaluatedAt: now(),
    }
  }
  if (target === undefined) {
    // Report contract: even a structural failure carries location (the
    // gate's declared targets) and a correction for the targeted repair loop.
    const location = gate.appliesTo.length > 0 ? gate.appliesTo.join(', ') : gate.gateId
    return {
      gateId: gate.gateId,
      status: 'fail',
      issues: [{
        code: 'gate-artifact-missing',
        severity: 'error',
        location,
        evidence: 'no artifact is bound to this gate',
        correction: 'bind the task/deliverable/section artifact this gate applies to (an artifact id, or deliverableSources for a deliverable target)',
      }],
      evaluatedAt: now(),
    }
  }
  const input: GateInput = {
    artifact: target.content,
    ...(target.isDeliverable ? { deliverableId: target.id } : { taskId: target.id }),
    artifactHashes: { [target.id]: hashArtifact(target.content), ...target.hashes },
    // The completing task's bound output-template contract (schema-structure
    // validation); composed deliverables have no single task schema.
    ...(!target.isDeliverable
      && taskOutputTemplates !== undefined
      && taskOutputTemplates[target.id] !== undefined
      ? { outputTemplate: taskOutputTemplates[target.id] }
      : {}),
  }
  const raw = evaluator(input, { spec: gate.spec, now })
  // Guarantee the artifact hash is reported even when the evaluator omits it;
  // evaluator-provided extra hashes (rendered md/pdf…) are preserved.
  return { ...raw, artifactHashes: { [target.id]: hashArtifact(target.content), ...raw.artifactHashes } }
}

function buildFailures(
  evaluated: ReadonlyArray<{ gate: OrderedGate; result: GateResult; target?: TargetArtifact }>,
): GateFailure[] {
  const failures: GateFailure[] = []
  for (const { gate, result, target } of evaluated) {
    if (result.status !== 'fail') continue
    failures.push({
      gateId: gate.gateId,
      kind: gate.kind,
      phase: gate.phase,
      severity: gate.severity,
      chainOrder: gate.chainOrder,
      issues: result.issues,
      appliesTo: [...gate.appliesTo],
      // Composed deliverables target their source task artifacts, which is
      // what replacements can actually update (never a bare deliverable id).
      affectedArtifacts: target === undefined ? [] : (target.sourceArtifactIds ?? [target.id]),
    })
  }
  return failures
}

function snapshotArtifacts(artifacts: Readonly<Record<string, GateArtifact>>): Readonly<Record<string, GateArtifact>> {
  const out: Record<string, GateArtifact> = {}
  for (const key of Object.keys(artifacts).sort()) {
    const artifact = artifacts[key]
    if (artifact === undefined) continue
    out[key] = { content: artifact.content, ...(artifact.hashes === undefined ? {} : { hashes: { ...artifact.hashes } }) }
  }
  return out
}

function applyReplacements(
  artifacts: Readonly<Record<string, GateArtifact>>,
  replacements: Readonly<Record<string, string>>,
): Record<string, GateArtifact> {
  const out: Record<string, GateArtifact> = {}
  for (const key of Object.keys(artifacts)) {
    const artifact = artifacts[key]
    if (artifact === undefined) continue
    const replacement = replacements[key]
    // Keep the caller-provided extra hashes (rendered md/pdf…) on the
    // repaired artifact; the content sha256 is always recomputed downstream.
    out[key] = replacement === undefined
      ? artifact
      : { content: replacement, ...(artifact.hashes === undefined ? {} : { hashes: { ...artifact.hashes } }) }
  }
  return out
}

function hashArtifacts(artifacts: Readonly<Record<string, GateArtifact>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(artifacts).sort()) {
    const artifact = artifacts[key]
    if (artifact !== undefined) out[key] = hashArtifact(artifact.content)
  }
  return out
}

/**
 * Run the gate chain over the provided artifacts, with the repair loop
 * described in the module doc. Deterministic given deterministic evaluators
 * and a fixed clock.
 */
export function runQualityChain(input: QualityChainInput): QualityChainResult {
  const gates = orderGatesInput(input.gates)
  const maxRepairRounds = Math.min(input.maxRepairRounds ?? MAX_REPAIR_ROUNDS, MAX_REPAIR_ROUNDS)
  const now = input.now ?? ((): string => new Date().toISOString())
  const evaluatedAt = now()
  let artifacts: Record<string, GateArtifact> = { ...input.artifacts }
  const rounds: GateRound[] = []
  let repairRoundsUsed = 0
  let outcome: QualityOutcome = 'pass'
  let deliverableAllowed = true

  for (let round = 0; ; round++) {
    const evaluated: Array<{ gate: OrderedGate; result: GateResult; target?: TargetArtifact }> = []
    for (const gate of gates) {
      const targets = targetArtifactsFor(gate, artifacts, input.deliverableSources)
      // No resolvable target (missing artifact / missing deliverableSources)
      // ⇒ evaluate with no artifact so the gate fails with
      // `gate-artifact-missing` — never concatenate unrelated artifacts.
      const list = targets.length > 0 ? targets : [undefined]
      for (const target of list) {
        evaluated.push({ gate, result: evaluateGate(gate, input.evaluators, target, now, input.taskOutputTemplates), target })
      }
    }
    const failures = buildFailures(evaluated)
    const hardFails = failures.filter(failure => failure.severity === 'hard')
    const status: GateRound['status'] =
      failures.length > 0 ? 'fail' : evaluated.some(entry => entry.result.status === 'warn') ? 'warn' : 'pass'
    rounds.push({ round, status, results: evaluated.map(entry => entry.result), failures })

    if (hardFails.length === 0) {
      outcome = round === 0 ? (status === 'pass' ? 'pass' : 'warn') : (status === 'pass' ? 'repaired-pass' : 'repaired-warn')
      deliverableAllowed = true
      break
    }
    if (input.repair === undefined || round >= maxRepairRounds) {
      outcome = round === 0 ? 'failed' : 'blocked'
      deliverableAllowed = false
      break
    }
    const action = input.repair({ round: round + 1, maxRounds: maxRepairRounds, failures: hardFails, artifacts: snapshotArtifacts(artifacts) })
    if (!action.repaired) {
      outcome = round === 0 ? 'failed' : 'blocked'
      deliverableAllowed = false
      break
    }
    repairRoundsUsed = round + 1
    artifacts = applyReplacements(artifacts, action.replacements)
  }

  const finalRound = rounds[rounds.length - 1]
  const finalResults = finalRound === undefined ? [] : finalRound.results
  return {
    outcome,
    deliverableAllowed,
    rounds: deepFreeze(rounds),
    artifactHashes: hashArtifacts(artifacts),
    maxRepairRounds,
    repairRoundsUsed,
    summary: {
      totalGates: gates.length,
      passed: finalResults.filter(result => result.status === 'pass').length,
      warned: finalResults.filter(result => result.status === 'warn').length,
      failed: finalResults.filter(result => result.status === 'fail').length,
      repairRoundsUsed,
      maxRepairRounds,
    },
    evaluatedAt,
    ...(input.planId === undefined ? {} : { planId: input.planId }),
  }
}
