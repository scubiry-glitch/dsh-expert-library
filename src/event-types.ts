/**
 * Expert Teams session event types — pure types only, zero imports.
 *
 * This file intentionally imports nothing: both the host program (the
 * emitter in `events.ts`) and the browser program (the Conversation Node
 * definition) must be able to load these types and the `SessionEventMap`
 * declaration merge without pulling in host-side `Context` augmentations
 * (dsh-session's index declares `Context.sessions: SessionStore`, which
 * collides with the browser runtime's `ISessions` under the same name).
 * @module dsh-expert-library/event-types
 */

/** Opens one team record: the captain created the team. */
export interface ExpertTeamsTeamCreatedData {
  readonly teamId: string
  /** The captain session that owns this team (UI follows it). */
  readonly captainSessionId: string
  readonly name: string
  readonly description?: string
}

/** Records one member after its continuable subagent is spawned. */
export interface ExpertTeamsMemberAddedData {
  readonly teamId: string
  readonly memberId: string
  readonly name: string
  readonly role?: string
}

/** Marks one member removed. */
export interface ExpertTeamsMemberRemovedData {
  readonly teamId: string
  readonly memberId: string
}

/** Records one task in the team's task list. */
export interface ExpertTeamsTaskCreatedData {
  readonly teamId: string
  readonly taskId: string
  readonly subject: string
  readonly dependencies: readonly string[]
  readonly assignee?: string
}

/** Records one task status/assignee/output transition. */
export interface ExpertTeamsTaskUpdatedData {
  readonly teamId: string
  readonly taskId: string
  readonly status: string
  readonly assignee?: string
  readonly output?: string
  readonly attempt?: number
  readonly attemptId?: string
  /** Quality-gate warnings attached at completion (soft gates / budget-exhausted). */
  readonly gateWarnings?: readonly string[]
}

/** Closes one team record: the team was deleted. */
export interface ExpertTeamsTeamDeletedData {
  readonly teamId: string
}

/** Records one `expert_provider_call` invocation (success or failure). */
export interface ExpertTeamsProviderCalledData {
  readonly agentId: string
  readonly detail: {
    readonly capability: string
    readonly provider?: string
    readonly operation?: string
    readonly transportId?: string
    readonly ok: boolean
    readonly code?: string
    readonly correction?: string
    readonly retry?: string
  }
}

/** Records one mailbox message sent between team agents. */
export interface ExpertTeamsMessageSentData {
  readonly teamId: string
  readonly messageId: string
  /** `captain` or a member name. */
  readonly from: string
  /** `captain` or a member name. */
  readonly to: string
  readonly content: string
  readonly ts: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens one team record.
     * @param data - stable team identity and display name.
     */
    'expert-teams/team-created': ExpertTeamsTeamCreatedData
    /**
     * Records one team member.
     * @param data - team identity, member child session, and display identity.
     */
    'expert-teams/member-added': ExpertTeamsMemberAddedData
    /**
     * Records one member removal.
     * @param data - team identity and the member's child session id.
     */
    'expert-teams/member-removed': ExpertTeamsMemberRemovedData
    /**
     * Records one task creation.
     * @param data - team identity, task id, subject, dependencies, assignee.
     */
    'expert-teams/task-created': ExpertTeamsTaskCreatedData
    /**
     * Records one task transition.
     * @param data - team identity, task id, and the new status/assignee/output.
     */
    'expert-teams/task-updated': ExpertTeamsTaskUpdatedData
    /**
     * Records one mailbox message.
     * @param data - team identity, sender, recipient, and content.
     */
    'expert-teams/message-sent': ExpertTeamsMessageSentData
    /**
     * Closes one team record after deletion.
     * @param data - stable team identity.
     */
    'expert-teams/team-deleted': ExpertTeamsTeamDeletedData
    /**
     * Records one `expert_provider_call` invocation (success or failure).
     * @param data - agent, capability, provider, operation, ok flag, and
     * failure code/correction when present.
     */
    'expert-teams/provider-called': ExpertTeamsProviderCalledData
  }
}

/** The full set of `expert-teams/*` event names. */
export type ExpertTeamsEventType =
  | 'expert-teams/team-created'
  | 'expert-teams/member-added'
  | 'expert-teams/member-removed'
  | 'expert-teams/task-created'
  | 'expert-teams/task-updated'
  | 'expert-teams/message-sent'
  | 'expert-teams/team-deleted'
  | 'expert-teams/provider-called'
