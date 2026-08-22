/**
 * Durable Expert Teams state types.
 *
 * A team is one directory under the state root holding `team.json` plus an
 * `inbox/` of per-agent JSONL mailboxes. Members are continuable subagents
 * whose durable child session ids are recorded in the team file, so a team
 * survives harness restarts.
 * @module dsh-expert-library/types
 */

/** Task lifecycle statuses in progression order. */
export type TaskStatus =
  | 'pending'
  | 'claimed'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Statuses after which a task can no longer be claimed or worked on. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled']

/** Durable isolated project for one expert task. */
export interface TaskProject {
  /** Relative path from the team directory. */
  readonly path: string
  /** Relative input document path inside the project. */
  readonly inputPath: string
  /** Relative output document path inside the project. */
  readonly outputPath: string
  /** Relative artifact directory inside the project. */
  readonly artifactsPath: string
  /** Project schema version. */
  readonly version: 1
}

/** A published artifact owned by one task attempt. */
export interface TaskArtifact {
  readonly id: string
  readonly taskId: string
  readonly attempt: number
  /** Path relative to the task Project's artifacts directory. */
  readonly relativePath: string
  readonly mediaType?: string
  readonly description?: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly createdAt: number
}

/** Explicit reference granting a task access to one upstream artifact. */
export interface TaskArtifactRef {
  readonly artifactId: string
  readonly sourceTaskId: string
  readonly purpose?: string
}

/**
 * One compiled quality gate stamped onto the durable team record (a JSON-safe
 * copy of the V2 `CompiledGate` — the fields `runQualityChain` reads when a
 * gate list carries `chainOrder`). Stamped at apply time by
 * `applyExecutionPlan` so task completion can evaluate the plan's gate chain
 * without re-reading the pack or recompiling the plan.
 */
export interface StampedGate {
  /** Unique in the plan: `${policyId}/${gateId}`. */
  readonly id: string
  readonly policyId: string
  readonly policyVersion?: string
  /** Gate id inside the policy (the evaluator-map key). */
  readonly gateId: string
  readonly kind: 'deterministic' | 'semantic' | 'visual'
  readonly phase: 'structure' | 'data' | 'compliance' | 'format' | 'style' | 'semantic' | 'final'
  readonly severity: 'hard' | 'soft'
  /** Task ids (logical `t1..tn`) and/or `deliverable` this gate applies to. */
  readonly appliesTo: readonly string[]
  /** Deterministic 0-based position in the chain; the runtime executes in this order. */
  readonly chainOrder: number
  readonly implementation?: string
  readonly config?: Readonly<Record<string, unknown>>
}

/**
 * The compiled plan's quality surface, stamped onto the durable team record
 * by the V2 apply bridge (see `applyExecutionPlan`). This is the team's
 * "plan quality policy": task completion evaluates exactly these gates, so a
 * policy change between compile and run can never silently alter what a team
 * is held to.
 */
/**
 * JSON-safe subset of the V2 `OutputTemplate` stamped onto the team record so
 * the schema-structure gate can validate a task's submitted output against the
 * plan's declared output schema (required section markers for markdown
 * templates, JSON shape for JSON templates) without re-reading the pack.
 */
export interface StampedOutputTemplate {
  readonly id: string
  readonly media: readonly ('markdown' | 'html' | 'pdf' | 'pptx' | 'json')[]
  /** Section markers; `required: true` sections must appear in the output. */
  readonly sections: ReadonlyArray<{ readonly id: string; readonly required: boolean }>
}

export interface StampedQualityPlan {
  readonly planId: string
  /** Policy refs the compiled plan bound (`bindings.qualityPolicies`). */
  readonly policies: ReadonlyArray<{ readonly id: string; readonly version: string }>
  /** Gates in chain order (chainOrder 0..n). */
  readonly gates: readonly StampedGate[]
  /** Deliverable declarations (deliverable id → source task ids). */
  readonly deliverables: ReadonlyArray<{ readonly id: string; readonly fromTasks: readonly string[] }>
  /**
   * Repair-round budget honored across completion attempts (design cap
   * {@link MAX_REPAIR_ROUNDS} = 2): after this many hard-gate blocks the next
   * completion may proceed with a recorded warning. Resolved from the bound
   * policy's `maxRepairRounds` at apply time, defaulting to the design cap.
   */
  readonly maxRepairRounds: number
  /**
   * Output-schema contracts of the plan's bound output templates, resolved at
   * apply time (JSON-safe subset). Empty when the templates are not resolvable
   * from the builtin/zhijian packs (e.g. collab templates) — schema-structure
   * validation then falls back to gate config only.
   */
  readonly outputTemplates: readonly StampedOutputTemplate[]
  /** Logical task id → bound output template id (from `CompiledTask.outputSchema`). */
  readonly taskOutputSchemas: Readonly<Record<string, string>>
  /**
   * The `schema-structure` gate instance declared by the bound quality policy
   * (zhijian declares one, hard). When present, task completion injects a
   * contract-driven schema-structure gate into the chain (unless the template
   * already bound one to the task) so the plan's declared output schema is
   * actually enforced. Absent when no bound policy declares the gate.
   */
  readonly schemaStructure?: {
    readonly policyId: string
    readonly severity: 'hard' | 'soft'
    readonly config?: Readonly<Record<string, unknown>>
  }
}

/** One task of a team's task list. */
export interface TeamTask {
  /** Stable task id within the team (`t1`, `t2`, …). */
  id: string
  /** Brief title for the task. */
  subject: string
  /** What needs to be done. */
  description?: string
  status: TaskStatus
  /** Member name (or `captain`) the task is assigned to; unassigned tasks await a claim. */
  assignee?: string
  /** Task ids that must reach `completed` before this task can be claimed. */
  dependencies: string[]
  /** The worker's written result, set when the task completes or fails. */
  output?: string
  /** Isolated project metadata; optional for legacy tasks. */
  project?: TaskProject
  /** Artifacts this task explicitly publishes; optional for legacy tasks. */
  publishedArtifacts?: TaskArtifact[]
  /** Upstream artifacts this task is explicitly allowed to read. */
  inputArtifacts?: TaskArtifactRef[]
  /** Monotonic execution generation. Reassignment/retry invalidates every older attempt. */
  attempt?: number
  /** Capability for the current claimed/in-progress attempt. Members must present it when updating. */
  attemptId?: string
  /** Opaque generation for a revocation/handoff that has not started its next attempt yet. */
  handoffId?: string
  /** A handoff is quiescing the old owner; the scheduler must not dispatch it yet. */
  reassigning?: boolean
  /** Provenance: the compiled V2 plan task this physical task derives from (apply bridge). */
  planTask?: {
    /** Logical CompiledTask id inside the ExecutionPlan. */
    logicalId: string
    /** Position among the logical task's rostered expert ids (fan-out), when expanded. */
    fanOutIndex?: number
  }
  /**
   * Hard-gate blocks this task accumulated (repair-round budget accounting):
   * each blocked completion increments it; once it reaches the plan policy's
   * `maxRepairRounds` the next completion may proceed with a recorded warning.
   * Absent on tasks that never hit a hard gate.
   */
  gateFailCount?: number
  /**
   * Quality-gate warnings attached when the task completed: soft-gate issues,
   * or hard-gate failures waived because the repair budget ran out.
   */
  gateWarnings?: readonly string[]
  /**
   * Derived 0–100 quality score stamped at the last completion attempt; `null`
   * when the team has no resolvable quality policy. The key is ALWAYS written
   * to the task output record (`result.json`) and the tool result — "field
   * always present" is the forced-recovery contract, never left to the member.
   * Absent only on tasks that never completed through `expert_teams_update_task`.
   */
  qualityScore?: number | null
  /**
   * Repair rounds used (hard-gate blocks) at the last completion attempt:
   * each blocked completion increments it, so a retry that passes after N
   * blocks reports repairCount = N. 0 when no gate ever blocked the task.
   */
  repairCount?: number
  createdAt: number
  updatedAt: number
}

/** Member lifecycle status. */
export type MemberStatus = 'idle' | 'working' | 'removed'

/** One team member: a continuable subagent plus its team-side record. */
export interface TeamMember {
  /** Durable continuable subagent session id (empty until spawned). */
  id: string
  /** Unique display name inside the team. */
  name: string
  /** Role description, e.g. `researcher`, `engineer`, `reviewer`. */
  role?: string
  /** Resolved LLM provider route captured when this member was created. */
  provider?: string
  /** Resolved model captured when this member was created. */
  model?: string
  /** Resolved reasoning effort captured from the captain or target model default. */
  reasoningEffort?: string
  joinedAt: number
  status: MemberStatus
  /** P2.1: 追问回合计数（expert_teams_chat 累计，可追溯；无追问时缺省）。 */
  chatRounds?: number
}

/** One mailbox message. */
export interface TeamMessage {
  id: string
  /** `captain` or a member name. */
  from: string
  /** `captain` or a member name. */
  to: string
  content: string
  ts: number
  /** Process-local delivery lease; prevents fallback and direct delivery racing. */
  deliveryClaimedAt?: number
  /** Set after the durable message was accepted by the recipient's live Harness inbox. */
  deliveredAt?: number
  /** Set once the recipient has consumed or been shown the durable fallback. */
  readAt?: number
}

/** The full durable team record. */
export interface TeamState {
  /** Original team name. */
  name: string
  /** Sanitized directory id; the team's stable identity. */
  id: string
  /** Team purpose/goal. */
  description?: string
  /** Session id of the captain agent that owns this team. */
  captainSessionId: string
  createdAt: number
  /** Scenario id this team was assembled from (Expert Library), when any. */
  scenarioId?: string
  /** Provenance: the compiled ExecutionPlan this team was assembled from (apply bridge). */
  planRef?: {
    planId: string
    digest: string
    templateId: string
    templateVersion: string
    scenarioId?: string
  }
  /** Optional audit snapshot: normalized compile params + the compiler decision trail. */
  planProvenance?: {
    params: Record<string, unknown>
    compile: readonly { step: string; detail: string }[]
  }
  /**
   * Per-logical-plan-task capability allowlist, persisted at apply time:
   * logical CompiledTask id → that task's `allowedCapabilities`. Runtime
   * enforcement (`expert_provider_call` capability gate) resolves a member's
   * plan-linked tasks through `TeamTask.planTask.logicalId` into this map and
   * blocks unlisted capabilities. Absent on legacy/ad-hoc teams (and plan
   * teams created before this field existed) — the capability gate stays open
   * for them (no regression).
   */
  planTaskCapabilities?: Record<string, readonly string[]>
  /**
   * Compiled plan quality surface stamped at apply time (see
   * `StampedQualityPlan`): task completion evaluates this gate chain.
   * Absent on ad-hoc teams (and compiled-plan teams created before this
   * field existed — those fall back to the pack's legacy quality policy,
   * which has no executable gates, so completion behavior is unchanged).
   */
  qualityPlan?: StampedQualityPlan
  /** Teammates only; the captain is implicit (the owning session). */
  members: TeamMember[]
  tasks: TeamTask[]
  /** Monotonic task id counter. */
  taskSeq: number
  /** Set after the scheduler emits the one-time all-tasks-terminal notice. */
  completionNotifiedAt?: number
}
