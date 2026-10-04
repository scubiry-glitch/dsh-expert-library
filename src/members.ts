/**
 * Member subagent lifecycle: spawn a continuable child per member, deliver
 * messages into its FIFO inbox, and observe its activity.
 *
 * Members are durable continuable subagents of the captain, so a member keeps
 * its conversation across turns and across harness restarts: the captain
 * wakes it with {@link ctx.subagents.followup}, it works through its turn
 * (updating team state through the `expert_teams_*` tools), and becomes idle
 * again. Its final assistant message is not readable programmatically, so the
 * member persists its report into the captain's mailbox and the task records,
 * which the captain reads through `expert_teams_status`.
 * @module dsh-expert-library/members
 */

import { memberGoalRules } from './goal-prompts.ts'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
// Declaration merge only: makes ctx.subagents visible.
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { guardSubagentDelivery, installContinuableMemberSetup, installIdleMemberBootstrap, installMemberToolBoundary, memberBootstrapPrompt, memberContinuableDescriptor, queueMemberPrompt, sessionOwnEvents } from './harness-compat.ts'
import { readRetiredMemberIds, readTeamSync } from './state.ts'
import type { Expert, ExpertModelRoute } from './expert-library/types.ts'
import type { TeamMember, TeamMessage, TeamState } from './types.ts'
import { bootstrapCapabilityScope } from './capability-scope.ts'
import { renderSharedTaskContext } from './shared-task-context.ts'

/** Captain-only Expert Teams tools hidden from newly spawned members. */
const MEMBER_DENIED_TOOLS = [
  'expert_teams_create',
  'expert_teams_add_member',
  'expert_teams_remove_member',
  'expert_teams_reassign_task',
  'expert_teams_create_task',
  'expert_teams_delete',
  'expert_teams_plan_preview',
  'expert_teams_plan_stage',
  'expert_teams_plan_edit',
  'expert_teams_plan_approve',
  'expert_teams_plan_discard',
  'expert_teams_scenario_apply',
  'expert_teams_quality_repair',
  'expert_teams_quality_reopen',
  'expert_teams_quality_integrate',
  'expert_teams_resume_task',
  'expert_teams_resume_member',
  'expert_teams_halt',
  'expert_teams_resume',
  'expert_teams_chat',
] as const

/** Worker tools required to claim/update/report tasks. Captain-only tools are
 * always excluded. A scope may add host tool ids (for example
 * `expert_provider_call`) to this baseline. */
const MEMBER_WORKER_TOOLS = [
  'expert_teams_claim_task',
  'expert_teams_update_task',
  'expert_teams_publish_artifact',
  'expert_teams_read_artifact',
  'expert_teams_send_message',
  'expert_teams_status',
  'expert_teams_wait',
  // A reviewer must submit the structured review from its own member
  // session. The tool enforces that the caller identity matches `reviewer`;
  // keeping it in the member allowlist prevents the captain from fabricating
  // an independent reviewer by passing a display-name string.
  'expert_teams_quality_review',
] as const

export function memberToolFilter(scope: TeamMember['capabilityScope']): { allow?: readonly string[]; deny: readonly string[] } {
  const deny = [...MEMBER_DENIED_TOOLS]
  // A durable A5 scope is an explicit tool boundary: an empty allowlist means
  // no extra host tools, while legacy members without a scope retain the old
  // host-default filter for compatibility.
  if (scope === undefined) return { deny }
  const denied = new Set<string>(deny)
  const allow = [...new Set([...MEMBER_WORKER_TOOLS, ...scope.allowedTools])].filter(tool =>
    !denied.has(tool) && !(scope.maxDepth === 0 && (tool === 'subagent' || tool === 'list_subagent_models')),
  )
  return { allow, deny }
}

/** Translate the member-relative recursion budget to DSH's absolute cap. */
export function absoluteMemberMaxDepth(captainDepth: number, relativeCap: number | undefined, fallbackCap = 0): number {
  const budget = relativeCap ?? fallbackCap
  if (!Number.isSafeInteger(captainDepth) || captainDepth < 0 || !Number.isSafeInteger(budget) || budget < 0) {
    throw new TypeError('member delegation depths must be non-negative safe integers')
  }
  return captainDepth + 1 + budget
}

/**
 * Restore the SessionId brand on a value that round-tripped through the
 * durable team file. The brand is erased by JSON serialization; the value
 * originated from `startContinuable`/`agent.id`, so this cast is the boundary
 * restoration, not a new assertion.
 */
function brandedSessionId(value: string): SessionId {
  return value as SessionId
}

/** Runtime knobs for member spawning, resolved from plugin config. */
export interface MemberRuntimeConfig {
  /** Registered `ctx.subagents` provider name (must support continuable + persona). */
  provider: string
  /** Child delegation depth cap (0 forbids delegation entirely). */
  maxDepth?: number
}

/** Durable provider/model/reasoning snapshot for one member. */
export interface MemberLlmSelection {
  /** Registered LLM provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, absent when the target has no explicit/default effort. */
  reasoningEffort?: string
}

/** Optional member-level route requested by the captain. */
export interface MemberLlmSelectionRequest {
  /** Explicit LLM provider route; requires an explicit model. */
  provider?: string
  /** Explicit model id; otherwise the plugin default or captain model is used. */
  model?: string
  /** Plugin-level member model default. */
  defaultModel?: string
  /** Explicit reasoning effort; "default" selects the target model's default effort. */
  reasoningEffort?: string
  /** Ordered fallback routes tried when the selected route is unavailable. */
  fallback?: readonly MemberRouteFallback[]
}

export interface MemberRouteFallback {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface MemberProvisioningIdentity {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly label: string
}

/** Upper bound for an admitted child whose scoped setup never mounts. */
export const MEMBER_PENDING_SETUP_TIMEOUT_MS = 30_000

/** Process-local bridge between spawn admission and asynchronous child setup. */
export interface MemberSelectionRuntime {
  /** Retain one identity-bound snapshot until actual setup consumes it. */
  withPending<T>(
    identity: MemberProvisioningIdentity,
    selection: MemberLlmSelection,
    operation: () => Promise<T>,
    scope?: TeamMember['capabilityScope'],
    signal?: AbortSignal,
  ): Promise<T>
}

/** Model-route inputs of one add-member call (explicit tool arguments only). */
export interface MemberRouteArgs {
  /** Explicit provider requested by the caller. */
  readonly provider?: string
  /** Explicit model requested by the caller. */
  readonly model?: string
  /** Explicit reasoning effort requested by the caller. */
  readonly reasoning_effort?: string
}

/**
 * Build the member LLM selection request, applying the A5 route precedence:
 * member-explicit route > expert/profile route > plugin memberModel default >
 * captain's current route. A lone explicit reasoning effort rides on the
 * route selected by that precedence.
 *
 * A lone explicit `reasoning_effort` rides on top of whichever provider/model
 * won — when only an effort was given and the plugin default route exists,
 * the request combines the default provider/model with the explicit effort
 * (overriding the default effort) instead of silently dropping it.
 * Exported for unit testing at the pure boundary.
 */
export function memberRouteRequest(
  args: MemberRouteArgs,
  expertModel: ExpertModelRoute | undefined,
  memberModel: ExpertModelRoute | undefined,
): MemberLlmSelectionRequest {
  const explicitRoute = args.provider !== undefined || args.model !== undefined
  if (explicitRoute) {
    return {
      provider: args.provider,
      model: args.model,
      defaultModel: memberModel?.model,
      ...args.reasoning_effort !== undefined ? { reasoningEffort: args.reasoning_effort } : {},
    }
  }
  if (expertModel !== undefined) {
    const reasoningEffort = args.reasoning_effort ?? expertModel.reasoningEffort
    return {
      provider: expertModel.provider,
      model: expertModel.model,
      ...(typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { reasoningEffort } : {}),
    }
  }
  if (memberModel !== undefined) {
    const reasoningEffort = args.reasoning_effort !== undefined
      ? args.reasoning_effort
      : memberModel.reasoningEffort
    return {
      provider: memberModel.provider,
      model: memberModel.model,
      ...(typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { reasoningEffort } : {}),
    }
  }
  // Only reachable when no explicit provider/model was given, so the keys
  // are emitted only when present — a lone effort never carries undefined
  // provider/model placeholders. The caller applies the captain's route.
  return {
    ...args.provider !== undefined ? { provider: args.provider } : {},
    ...args.model !== undefined ? { model: args.model } : {},
    ...args.reasoning_effort !== undefined ? { reasoningEffort: args.reasoning_effort } : {},
  }
}

const MEMBER_LABEL_PREFIX = 'expert-teams:'

function selectionFromMember(member: TeamMember | undefined): MemberLlmSelection | undefined {
  if (member?.provider === undefined || member.model === undefined) return undefined
  const provider = member.provider.trim()
  const model = member.model.trim()
  if (provider === '' || model === '') return undefined
  const reasoningEffort = member.reasoningEffort?.trim()
  return {
    provider,
    model,
    ...reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort },
  }
}

function modelSelection(selection: MemberLlmSelection): ModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
  }
}

/**
 * Resolve one member's complete model selection. Ordinary members snapshot the
 * captain's current request route and reasoning effort. When provider or model
 * changes, effort is intentionally omitted so the target model materializes
 * its own default instead of receiving an adapter-owned id from another route.
 * An explicit effort overrides either policy; the sentinel "default" also
 * selects the target model's default. The final effort is validated against
 * the target model before a child is created.
 */
export async function resolveMemberLlmSelection(
  ctx: Context,
  captain: Agent,
  request: MemberLlmSelectionRequest,
  signal?: AbortSignal,
): Promise<MemberLlmSelection> {
  const explicitProvider = request.provider?.trim()
  const explicitModel = request.model?.trim()
  const defaultModel = request.defaultModel?.trim()
  const explicitEffort = request.reasoningEffort?.trim()
  if (request.provider !== undefined && explicitProvider === '') {
    throw new Error('member LLM provider must not be empty')
  }
  if (request.model !== undefined && explicitModel === '') {
    throw new Error('member model must not be empty')
  }
  if (request.defaultModel !== undefined && defaultModel === '') {
    throw new Error('configured memberModel must not be empty')
  }
  if (request.reasoningEffort !== undefined && explicitEffort === '') {
    throw new Error('member reasoning effort must not be empty')
  }
  if (explicitProvider !== undefined && explicitModel === undefined) {
    throw new Error('an explicit member LLM provider requires an explicit member model')
  }

  const current = captain.session.requestHeader()?.config
  const currentProvider = current?.provider ?? captain.options.provider
  const currentModel = current?.model ?? captain.options.model
  const provider = explicitProvider ?? currentProvider
  const model = explicitModel ?? defaultModel ?? currentModel
  if (provider === undefined || model === undefined) {
    throw new Error('cannot resolve the member LLM route from the current captain session')
  }

  // Effort ids belong to one exact provider/model capability. Preserve the
  // captain's effort only on the same route; a changed route must resolve its
  // own default. Explicit effort still wins, while "default" forces that
  // target-default behavior even when the route did not change.
  const sameRoute = provider === currentProvider && model === currentModel
  const reasoningEffort = explicitEffort === undefined
    ? sameRoute
      ? current?.reasoningEffort
      : undefined
    : explicitEffort === 'default'
      ? undefined
      : ReasoningEffortId(explicitEffort)
  const candidates: Array<{ provider: string; model: string; reasoningEffort?: string }> = [{
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }, ...(request.fallback ?? []).map(route => ({
    provider: route.provider.trim(),
    model: route.model.trim(),
    ...(route.reasoningEffort === undefined || route.reasoningEffort.trim() === '' || route.reasoningEffort === 'default'
      ? {}
      : { reasoningEffort: route.reasoningEffort.trim() }),
  }))]
  const failures: string[] = []
  for (const candidate of candidates) {
    if (candidate.provider === '' || candidate.model === '') {
      failures.push('provider and model are required')
      continue
    }
    try {
      const resolved = await ctx.llm.resolveCallConfig({
        provider: candidate.provider,
        model: candidate.model,
        ...(candidate.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(candidate.reasoningEffort) }),
      }, signal)
      return {
        provider: resolved.provider,
        model: resolved.model,
        ...resolved.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: String(resolved.reasoningEffort) },
      }
    } catch (error: unknown) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`cannot resolve a usable member LLM route${failures.length === 0 ? '' : `: ${failures.join(' | ')}`}`)
}

const MEMBER_RUNTIME_COORDINATOR = Symbol.for('dsh-expert-library.member-runtime-coordinator.v1')
interface MemberRuntimeCoordinator {
  readonly version: 1
  acquire(ownerCtx: Context, stateDir: string): MemberSelectionRuntime
}

/**
 * Host index and agent presets share one application-root coordinator. Their
 * tools have separate effect owners, but session-start must install exactly
 * one member boundary, using the admission owned by the spawning tool.
 * Symbol.for also joins separately imported copies within this application;
 * unrelated Cordis roots never share admissions or setup hooks.
 */
export function installMemberSelectionRuntime(ctx: Context, stateDir: string): MemberSelectionRuntime {
  const root = (ctx.root ?? ctx) as Context & { [MEMBER_RUNTIME_COORDINATOR]?: MemberRuntimeCoordinator }
  let coordinator = root[MEMBER_RUNTIME_COORDINATOR]
  if (coordinator === undefined) {
    const created = createMemberRuntimeCoordinator(root, () => {
      if (root[MEMBER_RUNTIME_COORDINATOR] === created) delete root[MEMBER_RUNTIME_COORDINATOR]
    })
    Object.defineProperty(root, MEMBER_RUNTIME_COORDINATOR, { value: created, configurable: true })
    coordinator = created
  }
  if (coordinator.version !== 1) throw new Error('expert-teams: incompatible application member runtime coordinator')
  return coordinator.acquire(ctx, stateDir)
}

function createMemberRuntimeCoordinator(ctx: Context, releaseRoot: () => void): MemberRuntimeCoordinator {
  interface PendingMember {
    readonly owner: object
    readonly identity: MemberProvisioningIdentity
    readonly selection: MemberLlmSelection
    readonly scope: TeamMember['capabilityScope']
    release(): void
  }
  const pending = new Map<string, PendingMember>()
  const owners = new Set<object>()
  const stateDirs = new Map<string, number>()
  let disposed = false
  // Current Harness closes an idle activation and wakes its parent with a
  // settlement notice. An empty provisioning turn is not business progress.
  // Suppress only that child's no-work notice; any real inbox input revokes
  // this marker before the child's task/review turn can settle.
  const idleBoots = new Map<string, string>()
  const stopBootNotices = ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const bootNotices = new Set(messages.filter(message => {
      const source = message.source as { kind?: string; senderSessionId?: string } | undefined
      return source?.kind === 'subagent-settled' && source.senderSessionId !== undefined
        && idleBoots.get(source.senderSessionId) === agent.id
    }))
    if (bootNotices.size === 0) return next()
    for (const message of bootNotices) {
      const source = message.source as { senderSessionId: string }
      idleBoots.delete(source.senderSessionId)
    }
    if (bootNotices.size === messages.length) return { kind: 'enter', messages: [] }
    const decision = await next()
    return decision.kind === 'reject' ? decision : { ...decision, messages: decision.messages.filter(message => !bootNotices.has(message)) }
  })
  let stopSetups: () => void
  try {
    stopSetups = installContinuableMemberSetup(ctx, (childCtx) => {
      const child = childCtx.agent
      if (child === undefined) return () => undefined
      const suffix = sessionOwnEvents(child.session)
      const descriptor = memberContinuableDescriptor(suffix, MEMBER_LABEL_PREFIX)
      if (descriptor === undefined) {
        return () => undefined
      }

      const parentSessionId = child.session.header.parentSession
      if (parentSessionId === undefined) throw new Error('expert-teams: member has no durable captain identity')
      const provisioning = pending.get(child.id)
      if (provisioning !== undefined && (provisioning.identity.parentSessionId !== parentSessionId
        || provisioning.identity.label !== descriptor.label)) {
        // Another child/parent/descriptor may never borrow or consume this
        // admission, even during the window before team.json is written.
        throw new Error('expert-teams: pending member provisioning identity mismatch')
      }
      let selection = provisioning?.selection
      let scope = provisioning?.scope
      const disposers: Array<() => void> = []
      try {
        if (provisioning === undefined) {
          const identity = descriptor.label.slice(MEMBER_LABEL_PREFIX.length)
          const separator = identity.indexOf(':')
          if (separator < 1 || separator === identity.length - 1) throw new Error('expert-teams: malformed durable member identity')
          const teamId = identity.slice(0, separator)
          const memberName = identity.slice(separator + 1)
          const workspace = child.session.header.cwd ?? process.cwd()
          const matches: TeamMember[] = []
          // Different presets may intentionally register different state
          // roots. A cold child must match its complete durable identity in
          // exactly one registered root; name alone never chooses a scope.
          for (const stateRoot of new Set([...stateDirs.keys()].map(dir => join(workspace, dir)))) {
            const team = readTeamSync(stateRoot, teamId)
            const member = team?.members.find(member => member.name === memberName && member.id === child.id)
            if (team?.captainSessionId === parentSessionId && member !== undefined && member.status !== 'removed') matches.push(member)
          }
          if (matches.length === 0) {
            throw new Error('expert-teams: cannot restore the durable member capability boundary')
          }
          if (matches.length !== 1) throw new Error('expert-teams: ambiguous durable member capability boundary across registered state roots')
          const member = matches[0]!
          scope = member.capabilityScope
          selection = selectionFromMember(member)
        }
        // Check fresh admissions as well as durable recovery. No missing or
        // mismatched state may select a default model or a broader tool scope.
        if (selection !== undefined && (descriptor.agentProvider !== selection.provider || descriptor.agentModel !== selection.model)) {
          throw new Error(
            `expert-teams: saved model route for member "${descriptor.label}" does not match its subagent descriptor`,
          )
        }
        disposers.push(installMemberToolBoundary(childCtx, memberToolFilter(scope), (scope?.maxDepth ?? 0) === 0))
        disposers.push(installIdleMemberBootstrap(childCtx, child.id, {
          idle: () => { idleBoots.set(child.id, parentSessionId) },
          working: () => { idleBoots.delete(child.id) },
        }))
        if (selection !== undefined) disposers.push(installModelSelection(childCtx, {
          current: modelSelection(selection),
          assembled: undefined,
        }))
        return () => { for (const dispose of disposers.reverse()) dispose() }
      } catch (error) {
        for (const dispose of disposers.reverse()) dispose()
        throw error
      } finally {
        // startContinuable returning means inbox admission, not scoped setup.
        // Only this exact child's completed setup attempt consumes the bridge.
        provisioning?.release()
      }
    })
  } catch (error) {
    stopBootNotices()
    throw error
  }

  return {
    version: 1,
    acquire(ownerCtx: Context, stateDir: string): MemberSelectionRuntime {
      if (disposed) throw new Error('expert-teams: member provisioning runtime was disposed')
      const owner = {}
      let ownerDisposed = false
      owners.add(owner)
      stateDirs.set(stateDir, (stateDirs.get(stateDir) ?? 0) + 1)
      const disposeOwner = (): void => {
        if (ownerDisposed) return
        ownerDisposed = true
        owners.delete(owner)
        for (const entry of pending.values()) if (entry.owner === owner) entry.release()
        const remaining = (stateDirs.get(stateDir) ?? 1) - 1
        if (remaining === 0) stateDirs.delete(stateDir)
        else stateDirs.set(stateDir, remaining)
        if (owners.size !== 0) return
        disposed = true
        idleBoots.clear()
        stopBootNotices()
        stopSetups()
        releaseRoot()
      }
      try {
        ownerCtx.effect(() => disposeOwner, 'expert-teams: member runtime owner')
      } catch (error) {
        disposeOwner()
        throw error
      }
      return {
        async withPending<T>(
          identity: MemberProvisioningIdentity,
          selection: MemberLlmSelection,
          operation: () => Promise<T>,
          scope?: TeamMember['capabilityScope'],
          signal?: AbortSignal,
        ): Promise<T> {
          if (disposed || ownerDisposed) throw new Error('expert-teams: member provisioning runtime was disposed')
          signal?.throwIfAborted()
          const key = identity.childSessionId
          if (!key || !identity.parentSessionId || !identity.label.startsWith(MEMBER_LABEL_PREFIX)) {
            throw new Error('expert-teams: invalid pending member provisioning identity')
          }
          if (pending.has(key)) {
            throw new Error(`member model selection is already pending for child "${key}"`)
          }
          const entry: PendingMember = {
            owner,
            identity: { ...identity },
            selection: { ...selection },
            scope: scope === undefined ? undefined : structuredClone(scope),
            release() {
              clearTimeout(timer)
              signal?.removeEventListener('abort', entry.release)
              if (pending.get(key) === entry) pending.delete(key)
            },
          }
          const timer = setTimeout(() => entry.release(), MEMBER_PENDING_SETUP_TIMEOUT_MS)
          timer.unref()
          pending.set(key, entry)
          signal?.addEventListener('abort', entry.release, { once: true })
          try {
            const result = await operation()
            signal?.throwIfAborted()
            if (disposed || ownerDisposed) throw new Error('expert-teams: member provisioning runtime was disposed')
            return result
          } catch (error) {
            entry.release()
            throw error
          }
        },
      }
    },
  }
}

/**
 * The member's system prompt (persona), shadowing the deployment persona for
 * that child. Self-contained: it replaces the whole persona section.
 * @param team - the team the member joined.
 * @param member - the member record (name/role are read before spawning).
 * @param stateDir - configured state directory, so the member can locate the
 *   team files with its own file tools.
 */
export function memberPersona(team: TeamState, member: TeamMember, stateDir: string): string {
  return `You are ${member.name}, a member of the multi-agent team "${team.name}" running inside DeepSeek Harness Expert Teams. The captain leads the team; you are a worker member${member.role ? ` with the role: ${member.role}` : ''}.

Team context:
- Team id: ${team.id}
- Team goal: ${team.description?.trim() || '(the captain will define the goal before assigning work)'}
- Your name inside the team (use it as \`from\`/identity): ${member.name}
- The team state lives under ${stateDir}/${team.id}/ (team.json and inbox/*.jsonl). You may inspect these files read-only for diagnostics, but never edit them directly; use the expert_teams_* tools so JSON escaping and concurrent updates stay safe.
- The captain and your teammates reach you through messages. Use each message to steer the current task; continue executable work and report progress before yielding for review, external input or a new assignment.

${memberGoalRules()}`
}

/**
 * The expert member's system prompt (persona) — the Expert Library extension
 * of {@link memberPersona}. Builds on the shared worker contract and adds the
 * expert's professional identity, working principles, deliverables, and the
 * read-only knowledge pack guide for its role.
 * @param team - the team the member joined.
 * @param member - the member record (name/role are read before spawning).
 * @param stateDir - configured state directory, so the member can locate the
 *   team files with its own file tools.
 * @param expert - the preset expert profile this member was spawned from.
 * @param knowledgeGuideText - the resolved knowledge pack guide (may be empty).
 * @param scenarioName - the scenario that assembled this team, when any.
 */
export function expertMemberPersona(
  team: TeamState,
  member: TeamMember,
  stateDir: string,
  expert: Expert,
  knowledgeGuideText: string,
  scenarioName?: string,
): string {
  const scenarioLine = scenarioName === undefined
    ? ''
    : `\n- Scenario: this team was assembled for "${scenarioName}".`
  const knowledgeLine = knowledgeGuideText === ''
    ? ''
    : `\n${knowledgeGuideText}`
  return `You are ${member.name}, an expert ${expert.role} on the multi-agent team "${team.name}" running inside DeepSeek Harness Expert Library. The captain leads the team; you are a worker member.${scenarioLine}

Expert profile:
- Professional background: ${expert.background}
- Working principles:
${expert.principles.map((principle) => `  ${principle}`).join('\n')}
- Your deliverables: ${expert.deliverables.join('; ') || 'as requested by the task'}
${knowledgeLine}
Team context:
- Team id: ${team.id}
- Team goal: ${team.description?.trim() || '(the captain will define the goal before assigning work)'}
- Your name inside the team (use it as \`from\`/identity): ${member.name}
- The team state lives under ${stateDir}/${team.id}/ (team.json and inbox/*.jsonl). You may inspect these files read-only for diagnostics, but never edit them directly; use the expert_teams_* tools so JSON escaping and concurrent updates stay safe.
- The captain and your teammates reach you through messages. Use each message to steer the current task; continue executable work and report progress before yielding for review, external input or a new assignment.

${memberGoalRules()}`
}

/**
 * The initial user message delivered when the member is created.
 * @param team - the team the member joined.
 */
export function memberWelcome(team: TeamState): string {
  return `You have joined the team "${team.name}" as a member. Work in goal mode: the team goal is ${team.description?.trim() || 'not yet stated'}. Wait for assignment; then inspect its current state, dependencies and acceptance checks, claim it with expert_teams_claim_task, and continue until verified completion or a concrete blocker. Save evidence through expert_teams_update_task; a task with a structured quality run stays in_progress until the captain integrates its review. Persist execution_state=awaiting_review before yielding for review, or blocked_external with a concrete wait_reason before yielding for missing external input. A repeated assignment or ordinary message does not clear either waiting state. Follow your working rules for current attempt_id, reporting and halt/cancellation. Current durable task count: ${team.tasks.length}.`
}

/**
 * Spawn one member as a durable continuable subagent of the captain and fill
 * `member.id` with its child session id. On failure nothing is persisted.
 * @param ctx - the plugin context (injects `subagents`).
 * @param config - member runtime knobs.
 * @param selections - fresh/cold child model-selection bridge.
 * @param llmSelection - resolved provider/model/reasoning snapshot.
 * @param captain - the exact live captain agent (the calling agent).
 * @param team - the team record (read-only here).
 * @param member - the member draft whose `id` is filled on success.
 * @param stateDir - configured state directory (for the persona).
 * @param signal - caller cancellation, forwarded to the start.
 * @param personaOverride - optional custom persona (e.g. an expert persona);
 *   defaults to the shared worker {@link memberPersona}.
 */
export async function spawnMember(
  ctx: Context,
  config: MemberRuntimeConfig,
  selections: MemberSelectionRuntime,
  llmSelection: MemberLlmSelection,
  captain: Agent,
  team: TeamState,
  member: TeamMember,
  stateDir: string,
  signal: AbortSignal,
  personaOverride?: string,
): Promise<void> {
  // Fail loud at the first use: provider registration is a sibling plugin's
  // effect and may settle after this plugin mounts. Capability checks here
  // mirror what startContinuable would reject, with an actionable error.
  const provider = ctx.subagents.getProvider(config.provider)
  if (provider === undefined) {
    throw new Error(
      `expert-teams: no subagent provider "${config.provider}" is registered (available: ${ctx.subagents.list().join(', ') || 'none'}) — `
      + 'check that the subagent provider row (e.g. subagent-spawn) is mounted in the composition',
    )
  }
  if (provider.prepareContinuable === undefined) {
    throw new Error(`expert-teams: provider "${config.provider}" does not support continuable members`)
  }
  if (!provider.capabilities.persona) {
    throw new Error(`expert-teams: provider "${config.provider}" cannot apply a member persona`)
  }
  if (!provider.capabilities.toolFilter) {
    throw new Error(`expert-teams: provider "${config.provider}" cannot restrict captain-only tools for members`)
  }
  if (member.capabilityScope !== undefined) {
    // The host exposes only the capability facts it actually knows. Missing
    // catalogues are handled as an explicit lenient filter by the pure seam;
    // a non-continuable provider is a hard stop before a child is materialized.
    const bootstrap = bootstrapCapabilityScope(member.capabilityScope, {
      continuable: provider.prepareContinuable !== undefined,
    })
    member.capabilityScope = bootstrap.scope
    if (bootstrap.stopping) {
      const detail = bootstrap.spawnError?.message ?? 'host capability admission stopped member spawn'
      throw new Error(`expert-teams: capability scope admission failed for ${member.name}: ${detail}`)
    }
  }
  const label = `${MEMBER_LABEL_PREFIX}${team.id}:${member.name}`
  const childId = brandedSessionId(randomUUID())
  const start = await selections.withPending({ parentSessionId: captain.id, childSessionId: childId, label }, llmSelection, async () => {
    const receipt = await ctx.subagents.startContinuable({
      provider: config.provider,
      label,
      childId,
      request: {
        prompt: [{ type: 'text', text: memberBootstrapPrompt(childId) }],
        parent: captain,
        persona: `${personaOverride ?? memberPersona(team, member, stateDir)}\n\n${renderSharedTaskContext(team.sharedTaskContext, team.taskProtocol)}`,
        toolFilter: memberToolFilter(member.capabilityScope),
        agentOptions: {
          provider: llmSelection.provider,
          model: llmSelection.model,
        },
        // The durable scope is authoritative on cold recovery; config is only
        // a compatibility fallback for legacy members without A5 state.
        // DSH's maxDepth is an absolute root-relative cap, whereas the
        // persisted capability scope is a member-relative delegation budget.
        // A zero budget must still permit the captain's first child at
        // `captainDepth + 1`; it only forbids that child from delegating
        // further. Translate the two coordinate systems at this boundary.
        maxDepth: absoluteMemberMaxDepth(delegationDepthOf(captain), member.capabilityScope?.maxDepth, config.maxDepth),
      },
      signal,
    })
    if (receipt.childId !== childId) throw new Error('expert-teams: Harness returned a different member provisioning identity')
    return receipt
  }, member.capabilityScope, signal)
  member.id = start.childId
}

/**
 * Deliver one message to a member as its next FIFO turn. Best effort: a
 * failure (member gone or not continuable) is logged and reported as `false`
 * so the caller can decide (mailbox delivery still happened).
 *
 * Any team sender can route through this helper: the captain is the direct
 * parent of every member, and the caller passes the captain's live Agent
 * (its own when the captain calls, the registry-resolved one when a member
 * sends) — mirroring the Claude Code mailbox model where the writer writes
 * the target's inbox and the target picks it up on its own.
 * @param ctx - the plugin context (injects `subagents`).
 * @param captain - the exact live captain agent (the member's direct parent).
 * @param childId - the member's durable child session id.
 * @param text - the message content.
 * @param signal - caller cancellation, forwarded to the delivery.
 * @returns whether the member inbox accepted the message.
 */
export const MEMBER_DELIVERY_TIMEOUT_MS = 10_000

export async function deliverToMember(
  ctx: Context,
  captain: Agent,
  childId: string,
  text: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false
  const controller = new AbortController()
  let rejectAbort!: (error: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const abort = (reason: unknown): void => {
    controller.abort(reason)
    rejectAbort(reason)
  }
  const onCallerAbort = (): void => abort(signal.reason ?? new Error('member delivery aborted'))
  signal.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(() => abort(new Error('member delivery timed out')), MEMBER_DELIVERY_TIMEOUT_MS)
  timer.unref?.()
  try {
    await Promise.race([
      queueMemberPrompt(ctx.subagents, captain, brandedSessionId(childId), [{ type: 'text', text }], controller.signal),
      aborted,
    ])
    return true
  } catch (error: unknown) {
    ctx.logger.warn(`expert-teams: followup to member ${childId} failed: ${String(error)}`)
    return false
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onCallerAbort)
  }
}

/** Replay a durable captain report only if it is neither pending nor consumed.
 * The mailbox identity travels in the message itself, so a process restart or
 * a failed mailbox acknowledgement cannot turn an accepted report into a new
 * report. A canceled, unconsumed inbox item may be delivered again.
 */
export function deliverCaptainMailbox(captain: Agent, message: Pick<TeamMessage, 'id' | 'from' | 'content'>): boolean {
  const text = `Expert Teams mailbox message ${message.id}:\nFrom ${message.from}\n\n${message.content}`
  const matches = (value: unknown): boolean => {
    const candidate = value as { source?: { kind?: string; plugin?: string }; content?: { type?: string; text?: string }[] } | undefined
    return candidate?.source?.kind === 'plugin' && candidate.source.plugin === 'dsh-expert-library'
      && Array.isArray(candidate.content) && candidate.content.some(block => block.type === 'text' && block.text === text)
  }
  try {
    if ([...(captain.inbox?.nextTurn ?? []), ...(captain.inbox?.nextStep ?? [])].some(matches)) return true
    for (const value of sessionOwnEvents(captain.session)) {
      const event = value as { type?: string; data?: unknown }
      if (event.type === 'user/message' && matches(event.data)) return true
    }
    captain.steer(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-expert-library' },
    }))
    return true
  } catch {
    return false
  }
}

/**
 * Request cancellation of one live member's current turn. Best effort, fire
 * and return; the target may keep running until it observes the signal.
 * @param ctx - the plugin context (injects `subagents`).
 * @param captain - the exact live captain agent (the member's parent).
 * @param childId - the member's durable child session id.
 */
export function interruptMember(ctx: Context, captain: Agent, childId: string): void {
  try {
    ctx.subagents.interrupt(brandedSessionId(childId), { kind: 'ancestor', agent: captain })
  } catch (error: unknown) {
    ctx.logger.warn(`expert-teams: interrupt of member ${childId} failed: ${String(error)}`)
  }
}

/** Resolve one live parent's workspace-scoped retirement index. */
async function retiredForParent(ctx: Context, parentId: SessionId, stateDir: string): Promise<Set<string>> {
  const parent = ctx.agents.get(parentId)
  return parent === undefined
    ? new Set()
    : readRetiredMemberIds(join(parent.session.header.cwd ?? process.cwd(), stateDir))
}

/**
 * Install the missing per-child retirement boundary above Harness rc.6.
 *
 * Upstream `interrupt()` deliberately preserves continuable sessions and the
 * upstream seam exposes no targeted forget/retire method. The durable
 * Expert Teams index therefore guards every public continuation boundary:
 * retired rows disappear from `list_agents` (children and descendants), and
 * direct delivery (`followup`, the internal deliverPrompt protocol, or
 * `sendMessage`) is rejected before it can cold-resume the member. Exact
 * ids keep unrelated subagents untouched; transcripts remain in persistence
 * for archived-team review.
 */
export function installRetiredMemberGuard(ctx: Context, stateDir: string): void {
  const runtime = ctx.subagents
  ctx.effect(() => {
    const listChildren = runtime.listChildren
    const listDescendants = runtime.listDescendants

    const guardedChildren: typeof runtime.listChildren = async (parentId, signal) => {
      const [entries, retired] = await Promise.all([
        listChildren.call(runtime, parentId, signal),
        retiredForParent(ctx, parentId, stateDir),
      ])
      return entries.filter(entry => !retired.has(entry.id))
    }
    const guardedDescendants: typeof runtime.listDescendants = async (rootId, signal) => {
      const [entries, retired] = await Promise.all([
        listDescendants.call(runtime, rootId, signal),
        retiredForParent(ctx, rootId, stateDir),
      ])
      return entries.filter(entry => !retired.has(entry.id))
    }

    runtime.listChildren = guardedChildren
    runtime.listDescendants = guardedDescendants
    const restoreDelivery = guardSubagentDelivery(runtime, async (sender, childId) => {
      const cwd = (sender as Agent | undefined)?.session?.header?.cwd ?? process.cwd()
      return (await readRetiredMemberIds(join(cwd, stateDir))).has(childId)
    })
    return () => {
      if (runtime.listChildren === guardedChildren) runtime.listChildren = listChildren
      if (runtime.listDescendants === guardedDescendants) runtime.listDescendants = listDescendants
      restoreDelivery()
    }
  }, 'expert-teams: retired member guard')
}

/**
 * Snapshot each direct continuable child's real driver activity under the
 * captain's session. `listChildren().activity` is only session residency, so
 * live children are refined through the Agent registry exactly like Harness's
 * shipped `list_agents` tool.
 * @param ctx - the plugin context (injects `subagents`).
 * @param captainSessionId - the captain's session id.
 * @returns child id → activity, missing entries are unknown children.
 */
export async function memberActivity(
  ctx: Context,
  captainSessionId: string,
): Promise<Map<string, 'running' | 'idle' | 'ready'>> {
  const entries = await ctx.subagents.listChildren(brandedSessionId(captainSessionId))
  const activity = new Map<string, 'running' | 'idle' | 'ready'>()
  for (const entry of entries) {
    if (entry.kind !== 'child') continue
    const live = ctx.agents.get(entry.id)
    activity.set(entry.id, live === undefined ? 'ready' : live.status)
  }
  return activity
}
