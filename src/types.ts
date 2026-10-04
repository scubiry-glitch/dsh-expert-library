/**
 * Durable Expert Teams state types.
 *
 * A team is one directory under the state root holding `team.json` plus an
 * `inbox/` of per-agent JSONL mailboxes. Members are continuable subagents
 * whose durable child session ids are recorded in the team file, so a team
 * survives harness restarts.
 * @module dsh-expert-library/types
 */

import type { ExecutionPlan } from './v2/compiler.ts'
import type { CapabilityScope } from './capability-scope.ts'
import type { QualityRun } from './quality-run.ts'

/** Exact, bounded direct-user input admitted by this captain's own session.
 * This is task context, not a grant of filesystem/tool permissions. */
export interface SharedTaskContext {
  readonly schemaVersion: 1
  readonly status: 'captured' | 'unavailable'
  readonly captainSessionId: string
  readonly messages: readonly { readonly id: string; readonly seq: number; readonly text: string }[]
  readonly sha256: string
  readonly unavailableReason?: string
}

/** Lifecycle of a persisted, human-reviewable execution plan. */
export type StagedPlanStatus =
  | 'staged'
  | 'approved'
  | 'running'
  | 'completed'
  | 'failed'
  | 'discarded'
  | 'expired'

/** Runtime values needed to apply a compiled plan after a restart. */
export interface StagedPlanRuntime {
  readonly teamName: string
  readonly description: string
  readonly interpolations?: Readonly<Record<string, string>>
  readonly memberOrder?: readonly string[]
  readonly taskSuffixes?: Readonly<Record<string, string>>
  readonly sharedTaskContext?: SharedTaskContext
  readonly expertDisplay?: Readonly<Record<string, { name: string; field?: string; initials?: string }>>
}

/** One append-only edit entry for a staged plan. */
export interface StagedPlanEdit {
  readonly revision: number
  readonly at: number
  readonly by: string
  readonly parentDigest: string
  readonly digest: string
  readonly fields: readonly string[]
}

/** Durable plan record; the compiled plan is immutable between revisions. */
export interface StagedPlan {
  /** Durable staged-plan record schema. */
  readonly schemaVersion: 1
  readonly planId: string
  readonly digest: string
  readonly revision: number
  readonly status: StagedPlanStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt: number
  readonly createdBy: string
  readonly sessionId?: string
  readonly request: Readonly<Record<string, string | undefined>>
  readonly runtime: StagedPlanRuntime
  readonly plan: ExecutionPlan
  readonly editLog: readonly StagedPlanEdit[]
  readonly waitingFor?: 'user-confirmation'
  readonly goalWait?: { readonly goalId: string; readonly pausedRevision: number; readonly createdAt: number; readonly sourcePlanId?: string }
  /** Durable approval receipt. Kept when the plan advances to running so a
   * restart can prove who approved the exact CAS revision. */
  readonly approval?: {
    readonly digest: string
    readonly revision: number
    readonly approvedAt: number
    readonly approvedBy: string
    readonly source?: 'authenticated-host-user' | 'delegated-host-authorization'
    readonly authorizationRequestId?: string
    readonly contextSha256?: string
  }
  readonly approvedAt?: number
  readonly approvedBy?: string
  readonly appliedTeamId?: string
  readonly failureReason?: string
}

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
  /** Stable logical deliverable identity across immutable published versions. */
  readonly reviewId?: string
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

export interface TaskInputManifest {
  readonly sourceTaskId: string
  readonly artifactId: string
  readonly reviewArtifactId?: string
  readonly attempt: number
  readonly sha256: string
  readonly versionPath: string
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
   * {@link MAX_REPAIR_ROUNDS} = 2): after this many hard-gate blocks the failure
   * requires escalation; budget exhaustion never authorizes completion. Resolved from the bound
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
  /** Explicit report workflow; ordinary tasks omit this field. */
  reportBundle?: import('./report-bundle.ts').ReportBundle
  frozenSkillCraftContract?: import('./skill-craft-types.ts').FrozenSkillCraftContract
  craftDeliveries?: import('./report-craft-delivery.ts').CraftDeliveryReceipt[]
  craftReviewPreparations?: import('./report-craft-delivery.ts').CraftReviewPreparation[]
  /** A new task revising an integrated source; source remains immutable. */
  revisesTaskId?: string
  status: TaskStatus
  /** Durable execution intent. Waiting is not a lost turn and must not be redispatched. */
  executionState?: 'active' | 'awaiting_review' | 'blocked_external' | 'interrupted'
  /** Concrete review/external condition that must change before work resumes. */
  waitReason?: string
  /** Terminal Host failure bound to this exact session, turn and attempt. */
  runtimeBlock?: RuntimeBlock
  /** Last dispatch intent, persisted before delivery and confirmed with the same identity. */
  dispatch?: { attemptId: string; id: string; dispatchedAt: number; acceptedAt?: number; failureCount?: number; nextRetryAt?: number }
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
  /** Omission selects reviewed dependency publications; explicit [] selects none.
   * An automatic selection may change only for an explicit new consumer attempt. */
  inputArtifactBinding?: { mode: 'dependency-default'; consumerAttempt: number; legacyUnpinnedSources?: string[]; reviewDisabled?: true }
  /** Verified immutable input identities, persisted for cold/retry consistency. */
  inputArtifactManifest?: TaskInputManifest[]
  /** Monotonic execution generation. Reassignment/retry invalidates every older attempt. */
  attempt?: number
  /** Capability for the current claimed/in-progress attempt. Members must present it when updating. */
  attemptId?: string
  /** Capability id retired when the task became terminal; retained so a completion message
   * emitted just before finalization can still be admitted without reviving the task. */
  finalizedAttemptId?: string
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
   * `maxRepairRounds`, unresolved hard failures require escalation.
   * Absent on tasks that never hit a hard gate.
   */
  gateFailCount?: number
  /**
   * Non-blocking quality-gate warnings attached when the task completed.
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

export interface RuntimeBlock {
  id: string
  sessionId: string
  turn: number
  code: string
  status?: number
  message: string
  at: number
  attemptId?: string
}

export interface MemberActivation {
  id: string
  sessionId: string
  reservedAt: number
  acceptedAt?: number
  turn?: number
  taskAttempts: { taskId: string; attemptId: string }[]
}

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
  /** Ordered fallback routes declared by the member/profile; actual route is provider/model above. */
  fallbackRoutes?: readonly { provider: string; model: string; reasoningEffort?: string }[]
  /** Durable A5 capability boundary used at spawn/provider admission. */
  capabilityScope?: CapabilityScope
  joinedAt: number
  status: MemberStatus
  /** A durable concurrency reservation covering assignment and mailbox turns. */
  activation?: MemberActivation
  /** Last observed Host turn; excludes stale terminal events after resume. */
  runtimeTurn?: { turn: number; taskAttempts: { taskId: string; attemptId: string }[] }
  runtimeBlock?: RuntimeBlock
  runtimeResumedAt?: number
  runtimeResolvedThroughTurn?: number
  runtimeResumeReason?: string
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
  /** Task that produced this message, when the sender was executing one. */
  sourceTaskId?: string
  /** Execution generation that produced this message. */
  sourceAttemptId?: string
  /** Task status observed by the sender when the message was emitted. */
  sourceTaskStatus?: TaskStatus
  /** Monotonic sequence allocated per sender mailbox stream. */
  sequence?: number
  /** Caller supplied deduplication key; repeated sends are accepted once. */
  idempotencyKey?: string
  /** Durable delivery lease; prevents fallback and direct delivery racing across processes. */
  deliveryClaimedAt?: number
  /** Set after the durable message was accepted by the recipient's live Harness inbox. */
  deliveredAt?: number
  /** Set once the recipient has consumed or been shown the durable fallback. */
  readAt?: number
  /** Set once the recipient consumer has revalidated provenance and consumed the message. */
  consumedAt?: number
  /** Set when admission rejects a stale/duplicate message. */
  discardedAt?: number
  /** Machine-readable reason for a discarded message. */
  discardReason?: string
}

/** The full durable team record. */
export interface TeamState {
  /** Original team name. */
  name: string
  /** Sanitized directory id; the team's stable identity. */
  id: string
  /** Team purpose/goal. */
  description?: string
  /** Immutable source-bound user context; missing only on legacy records. */
  sharedTaskContext?: SharedTaskContext
  /** Captain-authored protocol, subordinate to the original user request. */
  taskProtocol?: readonly string[]
  /** Session id of the captain agent that owns this team. */
  captainSessionId: string
  captainRuntimeBlock?: RuntimeBlock
  captainRuntimeResolvedThroughTurn?: number
  /** Hard scheduler cap shared by ordinary work and independent review turns. */
  maxActiveMembers?: number
  /** Explicit event waits; ordinary idle recovery must not wake these sessions. */
  runtimeWaits?: Record<string, { reason: string; taskIds: string[]; since: number }>
  /** Exact goal pauses owned by event waiting, separate from scheduler wait cleanup. */
  goalWaits?: Record<string, { goalId: string; pausedRevision: number; createdAt: number }>
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
  /** Optional structured A4 review/repair/integration state for staged/profile teams. */
  qualityRun?: QualityRun
  /** Per-task structured quality runs. `qualityRun` remains the root-run alias for compatibility. */
  qualityRuns?: Record<string, QualityRun>
  /** Superseded review versions; preserved when a task is revised or reassigned. */
  qualityRunHistory?: Record<string, QualityRun[]>
  /** Profile review requirement/budget used for dynamically added tasks. */
  structuredQualityPolicy?: { required: boolean; maxRepairRounds: number }
  /** Teammates only; the captain is implicit (the owning session). */
  members: TeamMember[]
  tasks: TeamTask[]
  /** Monotonic task id counter. */
  taskSeq: number
  /** Set after the scheduler emits the one-time all-tasks-terminal notice. */
  completionNotifiedAt?: number
  /** Explicit operator pause. Ordinary scheduling and task creation must preserve this state. */
  halted?: boolean
  /** Human/machine-readable reason for an explicit halt. */
  haltReason?: string
  haltedAt?: number
  resumedAt?: number
  resumeReason?: string
}
