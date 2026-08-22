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
  /** Teammates only; the captain is implicit (the owning session). */
  members: TeamMember[]
  tasks: TeamTask[]
  /** Monotonic task id counter. */
  taskSeq: number
  /** Set after the scheduler emits the one-time all-tasks-terminal notice. */
  completionNotifiedAt?: number
}
