/**
 * The `expert_teams_*` model-facing tools.
 *
 * The captain (the agent that created the team) orchestrates: members are
 * continuable subagents it spawns and wakes. Members share the same tools and
 * drive their own task state, mirroring the Claude Code Expert Teams flow:
 * create team → add members → create tasks with dependencies → claim/assign →
 * work → report → status → delete.
 * @module dsh-expert-library/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { appendTeamEvent, captainSessionOf } from './events.ts'
import {
  acknowledgeMailbox,
  appendMailbox,
  archiveTeamDir,
  beginTaskAttempt,
  CAPTAIN_KEY,
  createMessage,
  createTaskProject,
  createTeamDir,
  findTeamByCaptain,
  findTeamByParticipant,
  invalidateTaskAttempt,
  readUnreadMailbox,
  recordRetiredMemberIds,
  releaseMailboxDelivery,
  publishTaskArtifact,
  readAllowedTaskArtifact,
  readTeam,
  sanitizeKey,
  transitionError,
  unsatisfiedDependencies,
  writeTaskProjectOutput,
  withTeamLock,
  writeTeam,
} from './state.ts'
import {
  deliverToMember,
  expertMemberPersona,
  installRetiredMemberGuard,
  installMemberSelectionRuntime,
  interruptMember,
  memberActivity,
  resolveMemberLlmSelection,
  spawnMember,
  type MemberRuntimeConfig,
  type MemberSelectionRuntime,
} from './members.ts'
import { TERMINAL_TASK_STATUSES, type TeamMember, type TeamState, type TeamTask } from './types.ts'
import { installTeamScheduler, type TeamScheduler } from './scheduler.ts'
import { resolveLibrary } from './expert-library/registry.ts'
import type { Expert, ExpertModelRoute } from './expert-library/types.ts'
import { knowledgeGuide } from './knowledge.ts'
import { resolveSkill, skillDescriptionBlock } from './skills.ts'
import { zhijianExpertPersona } from './zhijian/persona.ts'
import { isZhijianExpertId, zhijianMetaById } from './zhijian/registry.ts'
import { scenarioById } from './zhijian/routing.ts'
import { normalizeToolMode, toolExecutionOf, type ToolExecutionConfig, type ToolExecutionMode } from './settings.ts'

/** Resolved plugin config consumed by the tools. */
export interface ToolsConfig {
  /** State directory name under the captain's workspace. */
  stateDir: string
  /** Member subagent provider name. */
  memberProvider: string
  /** Optional default AI model route applied to every member without a preset route. */
  memberModel?: ExpertModelRoute
  /** Member delegation depth cap. */
  memberMaxDepth?: number
  /** Team size cap (members). */
  maxMembers: number
  /** Knowledge pack directory name under the captain's workspace. */
  knowledgeDir: string
  /** Per-tool execution policy (API vs CLI vs auto) for external capabilities. */
  toolExecution?: Record<string, ToolExecutionConfig>
}

/** The caller agent, or a loud failure for non-agent callers. */
function requireCaptain(exec: ToolRunContext): Agent {
  if (!exec.agent) {
    throw new Error('agent_teams tools require a calling agent (exec.agent was undefined)')
  }
  return exec.agent
}

/** The captain's workspace directory (team state root parent). */
function workspaceOf(agent: Agent): string {
  return agent.session.header.cwd ?? process.cwd()
}

/** Resolved absolute state root. */
function stateRootOf(workspace: string, config: ToolsConfig): string {
  return join(workspace, config.stateDir)
}

/** Replace scenario task placeholders without exposing credentials or mutable state. */
function interpolateScenarioTemplate(template: string, values: Record<string, string | undefined>): string {
  return template.replace(/\{(goal|team_name|scenario|data|city|period)\}/g, (_match, key: string) => values[key] ?? '')
}

/**
 * Resolve how one external tool id (e.g. `zyt`) should execute under the
 * current config: the settings/entry `toolExecution` policy, normalized to a
 * concrete mode (`api`/`cli`/`auto`). Unknown tool ids and unknown modes fall
 * back to `auto` (probe the API first, then the CLI).
 * @param config - the runtime tool config.
 * @param toolId - external tool id, e.g. `zyt`.
 * @returns the effective execution mode.
 */
export function toolExecutionModeOf(config: ToolsConfig, toolId: string): ToolExecutionMode {
  const policy = toolExecutionOf(config.toolExecution, toolId)
  return normalizeToolMode(policy?.mode)
}

/** Read the full execution policy for one external tool id, or undefined when unconfigured. */
export function toolPolicyOf(config: ToolsConfig, toolId: string): ToolExecutionConfig | undefined {
  return toolExecutionOf(config.toolExecution, toolId)
}

/** Process-local lock key scoped by workspace state root and team id. */
function teamLockKey(stateRoot: string, teamId: string): string {
  return `team:${stateRoot}:${teamId}`
}

/** Process-local lock key enforcing one active team per captain session. */
function captainLockKey(stateRoot: string, captainId: string): string {
  return `captain:${stateRoot}:${captainId}`
}

/** The team this captain currently leads, or a loud failure. */
async function requireCaptainTeam(workspace: string, config: ToolsConfig, captain: Agent): Promise<TeamState> {
  const team = await findTeamByCaptain(stateRootOf(workspace, config), captain.id)
  if (team === undefined) {
    throw new Error('you are not leading any team yet — call expert_teams_create first')
  }
  return team
}

/** The team this captain or active member currently participates in. */
async function requireParticipantTeam(workspace: string, config: ToolsConfig, caller: Agent): Promise<TeamState> {
  const team = await findTeamByParticipant(stateRootOf(workspace, config), caller.id)
  if (team === undefined) {
    throw new Error('you do not lead or belong to any active team yet')
  }
  return team
}

type ParticipantIdentity =
  | { kind: 'captain'; name: typeof CAPTAIN_KEY }
  | { kind: 'member'; name: string }

/** Re-derive a caller's role from fresh state while holding the team lock. */
function participantIdentityOf(team: TeamState, agentId: string): ParticipantIdentity | undefined {
  if (team.captainSessionId === agentId) return { kind: 'captain', name: CAPTAIN_KEY }
  const member = team.members.find((candidate) => candidate.id === agentId && candidate.status !== 'removed')
  return member === undefined ? undefined : { kind: 'member', name: member.name }
}

/** Fresh state for a team that still exists; never falls back to stale lookup data. */
async function requireFreshTeam(stateRoot: string, teamId: string): Promise<TeamState> {
  const fresh = await readTeam(stateRoot, teamId)
  if (fresh === undefined) throw new Error(`team "${teamId}" is no longer active`)
  return fresh
}

/** Fresh state with captain authorization rechecked inside the lock. */
async function requireFreshCaptainTeam(
  stateRoot: string,
  teamId: string,
  captainId: string,
): Promise<TeamState> {
  const fresh = await requireFreshTeam(stateRoot, teamId)
  if (fresh.captainSessionId !== captainId) {
    throw new Error(`only the captain of team "${fresh.name}" may perform this operation`)
  }
  return fresh
}

/** Fresh state and caller identity rechecked inside the lock. */
async function requireFreshParticipant(
  stateRoot: string,
  teamId: string,
  callerId: string,
): Promise<{ team: TeamState; identity: ParticipantIdentity }> {
  const fresh = await requireFreshTeam(stateRoot, teamId)
  const identity = participantIdentityOf(fresh, callerId)
  if (identity === undefined) throw new Error(`you are no longer an active participant in team "${fresh.name}"`)
  return { team: fresh, identity }
}

/** Look up one live (non-removed) member by display name. */
function requireMember(team: TeamState, name: string): TeamMember {
  const member = team.members.find((candidate) => candidate.name === name && candidate.status !== 'removed')
  if (member === undefined) {
    throw new Error(`no active member named "${name}" in team "${team.name}"`)
  }
  return member
}

/** Look up one task by id. */
function requireTask(team: TeamState, taskId: string): TeamTask {
  const task = team.tasks.find((candidate) => candidate.id === taskId)
  if (task === undefined) {
    throw new Error(`no task "${taskId}" in team "${team.name}" — use expert_teams_status to list tasks`)
  }
  return task
}

function memberOpenTask(team: TeamState, memberName: string, exceptTaskId?: string): TeamTask | undefined {
  return team.tasks.find(task => task.id !== exceptTaskId
    && task.assignee === memberName
    && (task.status === 'claimed' || task.status === 'in_progress'))
}

async function waitForMemberIdle(ctx: Context, member: TeamMember, signal: AbortSignal): Promise<void> {
  if (member.id === '') return
  const live = ctx.agents.get(member.id as SessionId)
  if (live === undefined) return
  if (signal.aborted) throw signal.reason
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('task reassignment was cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([live.whenIdle(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Deliver a durable member report at the captain's nearest model boundary.
 *
 * `Agent.steer()` targets the next step while the captain is running, wakes a
 * new turn when it is idle, and lets the Agent runtime reclassify an aborted
 * activity to `next-turn`. This prevents reports from waiting behind the
 * captain's entire orchestration turn.
 */
export function steerCaptainReport(captain: Pick<Agent, 'steer'>, from: string, content: string): boolean {
  try {
    captain.steer(createUserMessage({
      content: [{ type: 'text', text: `Expert Teams message from member ${from}:\n\n${content}` }],
      source: { kind: 'plugin', plugin: 'dsh-expert-library' },
    }))
    return true
  } catch {
    // The plugin mailbox was persisted before this best-effort live delivery.
    return false
  }
}

// ── Expert Library core operations ─────────────────────────────────────────
// The tool registrations below are thin wrappers over these cores, so
// `expert_teams_scenario_apply` can reuse exactly the same create/add/task
// logic (locks, validation, events, spawning) without duplicating it.

/** Core of `expert_teams_create`, reusable by the scenario assembler. */
export async function createTeamCore(
  ctx: Context,
  config: ToolsConfig,
  captain: Agent,
  args: { name: string; description?: string; scenarioId?: string },
  _signal: AbortSignal,
): Promise<{ team_id: string; team_name: string; state_dir: string }> {
  const workspace = workspaceOf(captain)
  const stateRoot = stateRootOf(workspace, config)
  const teamName = args.name.trim()
  if (teamName === '') throw new Error('team name must not be empty')
  const teamId = sanitizeKey(teamName)
  return withTeamLock(captainLockKey(stateRoot, captain.id), async () => {
    const current = await findTeamByParticipant(stateRoot, captain.id)
    if (current !== undefined) {
      const relationship = current.captainSessionId === captain.id ? 'lead' : 'belong to'
      throw new Error(`you already ${relationship} team "${current.name}" — end or leave it before creating another`)
    }
    return withTeamLock(teamLockKey(stateRoot, teamId), async () => {
      const existing = await readTeam(stateRoot, teamId)
      if (existing !== undefined) {
        throw new Error(`team id "${teamId}" is taken by another captain — pick a different team name`)
      }
      const state: TeamState = {
        name: teamName,
        id: teamId,
        description: args.description,
        captainSessionId: captain.id,
        createdAt: Date.now(),
        ...args.scenarioId !== undefined ? { scenarioId: args.scenarioId } : {},
        members: [],
        tasks: [],
        taskSeq: 0,
      }
      await createTeamDir(stateRoot, state)
      appendTeamEvent(ctx, captain.session, 'expert-teams/team-created', {
        teamId: state.id,
        captainSessionId: captain.id,
        name: state.name,
        ...state.description !== undefined ? { description: state.description } : {},
      })
      return { team_id: state.id, team_name: state.name, state_dir: join(stateRoot, state.id) }
    })
  })
}

/** Core of `expert_teams_add_member`, extended with the Expert Library. */
export async function addMemberCore(
  ctx: Context,
  config: ToolsConfig,
  captain: Agent,
  args: {
    name?: string
    role?: string
    provider?: string
    model?: string
    reasoning_effort?: string
    expert?: string
  },
  signal: AbortSignal,
  memberSelections: MemberSelectionRuntime,
): Promise<{
  member_name: string
  member_id: string
  provider: string
  model: string
  reasoning_effort?: string
  status: string
  expert_id?: string
}> {
  const workspace = workspaceOf(captain)
  const stateRoot = stateRootOf(workspace, config)
  const team = await requireCaptainTeam(workspace, config, captain)

  // Expert Library: resolve the preset expert profile and its AI model route.
  const expertId = args.expert?.trim()
  let expert: Expert | undefined
  let library = undefined
  if (expertId !== undefined && expertId !== '') {
    library = await resolveLibrary(ctx, workspace, config.knowledgeDir)
    expert = library.experts.get(expertId)
    if (expert === undefined) {
      throw new Error(`unknown expert "${expertId}" — available: ${[...library.experts.keys()].join(', ')}`)
    }
  }

  const created = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
    const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
    const memberName = (args.name ?? expert?.name ?? '').trim()
    if (memberName === '') throw new Error('member name must not be empty')
    const memberKey = sanitizeKey(memberName)
    if (memberKey === CAPTAIN_KEY) {
      throw new Error(`member name "${memberName}" is reserved for the captain`)
    }
    if (fresh.members.some((candidate) => sanitizeKey(candidate.name) === memberKey)) {
      throw new Error(`member name "${memberName}" has already been used in team "${fresh.name}"`)
    }
    if (fresh.members.filter((candidate) => candidate.status !== 'removed').length >= config.maxMembers) {
      throw new Error(`team "${fresh.name}" is at its member cap (${config.maxMembers})`)
    }

    // Model route precedence: preset expert route > explicit arguments >
    // plugin memberModel default > captain's current route.
    const hasExplicitRoute = args.provider !== undefined || args.model !== undefined
    const selection = await resolveMemberLlmSelection(ctx, captain, expert?.model !== undefined
      ? {
          provider: expert.model.provider,
          model: expert.model.model,
          ...expert.model.reasoningEffort !== undefined ? { reasoningEffort: expert.model.reasoningEffort } : {},
        }
      : hasExplicitRoute
        ? {
            provider: args.provider,
            model: args.model,
            defaultModel: config.memberModel?.model,
            ...args.reasoning_effort !== undefined ? { reasoningEffort: args.reasoning_effort } : {},
          }
        : config.memberModel !== undefined
          ? {
              provider: config.memberModel.provider,
              model: config.memberModel.model,
              ...config.memberModel.reasoningEffort !== undefined ? { reasoningEffort: config.memberModel.reasoningEffort } : {},
            }
          : {
              provider: args.provider,
              model: args.model,
              ...args.reasoning_effort !== undefined ? { reasoningEffort: args.reasoning_effort } : {},
            },
    signal)

    const member: TeamMember = {
      id: '',
      name: memberName,
      role: args.role ?? expert?.role,
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      joinedAt: Date.now(),
      status: 'idle',
    }

    // Expert persona with the role's knowledge pack guide. Zhijian (bk-*)
    // experts get their Profile JSON baked into the persona instead.
    let personaOverride: string | undefined
    if (expert !== undefined) {
      const scenario = fresh.scenarioId === undefined ? undefined : (library?.scenarios.get(fresh.scenarioId))
      const guide = await knowledgeGuide(workspace, config.knowledgeDir, expert.id, fresh.scenarioId)
      if (isZhijianExpertId(expert.id)) {
        const meta = zhijianMetaById(expert.id)
        if (meta !== undefined) {
          const framework = fresh.scenarioId === undefined
            ? undefined
            : scenarioById(fresh.scenarioId)?.framework
          personaOverride = zhijianExpertPersona(fresh, member, config.stateDir, meta, framework, guide)
        }
      }
      if (personaOverride === undefined) {
        personaOverride = expertMemberPersona(fresh, member, config.stateDir, expert, guide, scenario?.name)
      }
    }

    await spawnMember(
      ctx,
      memberRuntime(config),
      memberSelections,
      selection,
      captain,
      fresh,
      member,
      config.stateDir,
      signal,
      personaOverride,
    )
    fresh.members.push(member)
    try {
      await writeTeam(stateRoot, fresh)
    } catch (error: unknown) {
      // The continuable child is already live, but the durable team record
      // never saw it. Retire the orphan so it disappears from subagent
      // listings and cannot be resumed, then surface the write failure.
      if (member.id !== '') {
        await recordRetiredMemberIds(stateRoot, [member.id]).catch(() => undefined)
        interruptMember(ctx, captain, member.id)
      }
      throw error
    }
    appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'expert-teams/member-added', {
      teamId: fresh.id,
      memberId: member.id,
      name: member.name,
      ...member.role !== undefined ? { role: member.role } : {},
    })
    return {
      member_name: member.name,
      member_id: member.id,
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: selection.reasoningEffort },
      status: member.status,
      ...expertId !== undefined ? { expert_id: expertId } : {},
    }
  })
  return created
}

/** Core of `expert_teams_create_task`, reusable by the scenario assembler. */
export async function createTaskCore(
  ctx: Context,
  config: ToolsConfig,
  captain: Agent,
  args: { subject: string; description?: string; dependencies?: string[]; assignee?: string },
  _signal: AbortSignal,
): Promise<{ task_id: string; subject: string; status: string; assignee?: string }> {
  const workspace = workspaceOf(captain)
  const stateRoot = stateRootOf(workspace, config)
  const team = await requireCaptainTeam(workspace, config, captain)
  const created = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
    const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
    const subject = args.subject.trim()
    if (subject === '') throw new Error('task subject must not be empty')
    // Dependencies: reject duplicates loudly (deduped list is stored, so a
    // caller can never create an ambiguous DAG).
    const rawDependencies = args.dependencies ?? []
    const dependencies: string[] = []
    const seen = new Set<string>()
    for (const dependency of rawDependencies) {
      if (seen.has(dependency)) {
        throw new Error(`duplicate dependency "${dependency}" in task "${subject}" — dependencies must be unique`)
      }
      seen.add(dependency)
      dependencies.push(dependency)
    }
    for (const dependency of dependencies) {
      if (!fresh.tasks.some((task) => task.id === dependency)) {
        throw new Error(`dependency "${dependency}" does not exist in team "${fresh.name}"`)
      }
    }
    if (args.assignee !== undefined) requireMember(fresh, args.assignee)
    const task: TeamTask = {
      id: `t${fresh.taskSeq + 1}`,
      subject,
      description: args.description,
      status: 'pending',
      assignee: args.assignee,
      dependencies,
      attempt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    fresh.taskSeq += 1
    task.project = await createTaskProject(stateRoot, fresh.id, task)
    fresh.tasks.push(task)
    await writeTeam(stateRoot, fresh)
    appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'expert-teams/task-created', {
      teamId: fresh.id,
      taskId: task.id,
      subject: task.subject,
      dependencies: task.dependencies,
      ...task.assignee !== undefined ? { assignee: task.assignee } : {},
    })
    return {
      task_id: task.id,
      subject: task.subject,
      status: task.status,
      ...task.assignee !== undefined ? { assignee: task.assignee } : {},
    }
  })
  return created
}

/** Core of `expert_teams_scenario_apply`: assemble a team from a scenario.
 *
 * Transactional: every expert reference is validated before the team is
 * created, and any failure during member/task assembly rolls the team back
 * (members retired + interrupted, state archived) before the error surfaces,
 * so a half-built team can never wedge the captain's one-team slot.
 */
export async function scenarioApplyCore(
  ctx: Context,
  config: ToolsConfig,
  captain: Agent,
  args: { scenario: string; team_name?: string; goal?: string; data?: string; city?: string; period?: string },
  signal: AbortSignal,
  memberSelections: MemberSelectionRuntime,
): Promise<{
  scenario_id: string
  team_id: string
  team_name: string
  members: { expert_id: string; member_name: string; model: string }[]
  tasks: { task_id: string; subject: string; assignee?: string }[]
  deliverable: string
}> {
  const workspace = workspaceOf(captain)
  const library = await resolveLibrary(ctx, workspace, config.knowledgeDir)
  const scenarioId = args.scenario.trim()
  const scenario = library.scenarios.get(scenarioId)
  if (scenario === undefined) {
    throw new Error(`unknown scenario "${scenarioId}" — available: ${[...library.scenarios.keys()].join(', ')}`)
  }

  // 0. Validate the full roster up front, before any durable state exists.
  const expertIds: string[] = []
  for (const id of [...scenario.experts, ...scenario.tasks.map(task => task.expert).filter((id): id is string => id !== undefined)]) {
    if (library.experts.get(id) === undefined) {
      throw new Error(`scenario "${scenario.id}" references unknown expert "${id}"`)
    }
    if (!expertIds.includes(id)) expertIds.push(id)
  }

  // 1. Create the team (recorded with its scenario id). When the scenario
  // binds an external skill, resolve it and add it to the team description
  // so every member knows where the reference material lives.
  const teamName = args.team_name?.trim() || scenario.name
  const templateValues = {
    goal: args.goal?.trim() || scenario.description,
    team_name: teamName,
    scenario: scenario.id,
    data: args.data,
    city: args.city,
    period: args.period,
  }
  let skillBlock = ''
  if (scenario.skill !== undefined) {
    const resolved = await resolveSkill(ctx, workspace, config.knowledgeDir, scenario.skill.repo, scenario.skill.name)
    skillBlock = `\n\n${skillDescriptionBlock(resolved, scenario.skill.purpose)}`
  }
  const team = await createTeamCore(ctx, config, captain, {
    name: teamName,
    description: `${interpolateScenarioTemplate(templateValues.goal, templateValues)}${skillBlock}`,
    scenarioId: scenario.id,
  }, signal)

  try {
    // 2. Assemble every expert the scenario needs (scenario roster + task owners).
    const memberNameByExpert = new Map<string, string>()
    const members: { expert_id: string; member_name: string; model: string }[] = []
    for (const expertId of expertIds) {
      const added = await addMemberCore(ctx, config, captain, { expert: expertId }, signal, memberSelections)
      memberNameByExpert.set(expertId, added.member_name)
      members.push({
        expert_id: expertId,
        member_name: added.member_name,
        model: `${added.provider}/${added.model}`,
      })
    }

    // 3. Seed the preset task DAG (dependencies by array index → task ids).
    const tasks: { task_id: string; subject: string; assignee?: string }[] = []
    for (const [index, template] of scenario.tasks.entries()) {
      const dependencies = (template.dependsOn ?? []).map(depIndex => `t${depIndex + 1}`)
      const assignee = template.expert === undefined
        ? undefined
        : memberNameByExpert.get(template.expert)
      const skillTaskIndex = scenario.skill?.appliesToTaskIndex ?? (scenario.tasks.length - 1)
      const taskSkillBlock = scenario.skill !== undefined && skillTaskIndex === index ? `\n\n${skillBlock.trim()}` : ''
      const taskDescription = template.description === undefined
        ? taskSkillBlock === '' ? undefined : taskSkillBlock.trim()
        : `${interpolateScenarioTemplate(template.description, templateValues)}${taskSkillBlock}`
      const created = await createTaskCore(ctx, config, captain, {
        subject: interpolateScenarioTemplate(template.subject, templateValues),
        ...taskDescription !== undefined ? { description: taskDescription } : {},
        ...dependencies.length > 0 ? { dependencies } : {},
        ...assignee !== undefined ? { assignee } : {},
      }, signal)
      tasks.push({ task_id: created.task_id, subject: created.subject, ...assignee !== undefined ? { assignee } : {} })
    }

    return {
      scenario_id: scenario.id,
      team_id: team.team_id,
      team_name: team.team_name,
      members,
      tasks,
      deliverable: scenario.deliverable,
    }
  } catch (error) {
    await rollbackTeamAssembly(ctx, config, captain, team.team_id, signal)
    throw error
  }
}

/**
 * Best-effort compensating rollback for a failed team assembly: mark every
 * member removed, retire their durable ids, interrupt the live subagents,
 * wait for quiescence, and archive the half-built state directory. Mirrors
 * the `expert_teams_delete` flow but never throws — the caller surfaces the
 * original assembly error.
 */
export async function rollbackTeamAssembly(
  ctx: Context,
  config: ToolsConfig,
  captain: Agent,
  teamId: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    const workspace = workspaceOf(captain)
    const stateRoot = stateRootOf(workspace, config)
    const members = await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
      const fresh = await readTeam(stateRoot, teamId)
      if (fresh === undefined) return []
      const roster = fresh.members.map(member => ({ ...member }))
      for (const member of fresh.members) {
        if (member.status === 'removed') continue
        member.status = 'removed'
        for (const task of fresh.tasks) {
          if (task.assignee === member.name && task.status !== 'completed') invalidateTaskAttempt(task)
        }
      }
      await writeTeam(stateRoot, fresh)
      return roster
    })
    await recordRetiredMemberIds(stateRoot, members.map(member => member.id))
    for (const member of members) {
      if (member.id === '') continue
      interruptMember(ctx, captain, member.id)
    }
    const quiescence = await Promise.allSettled(members.map(member => waitForMemberIdle(ctx, member, signal)))
    for (const result of quiescence) {
      if (result.status === 'rejected') {
        ctx.logger.warn(`expert-teams: member did not quiesce during assembly rollback: ${String(result.reason)}`)
      }
    }
    await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
      const fresh = await readTeam(stateRoot, teamId)
      if (fresh !== undefined) {
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'expert-teams/team-deleted', {
          teamId: fresh.id,
        })
      }
      await archiveTeamDir(stateRoot, teamId)
    })
  } catch (error) {
    ctx.logger.warn(`expert-teams: assembly rollback for team "${teamId}" failed (manual expert_teams_delete may be needed): ${String(error)}`)
  }
}

/**
 * Core operations shared by the base tools and the Zhijian review tools.
 */
export interface ExpertToolsCore {
  /** Runtime dependency: the member model-selection bridge. */
  readonly memberSelections: MemberSelectionRuntime
  /** Runtime dependency: the shared task scheduler. */
  readonly scheduler: TeamScheduler
}

/**
 * Register every `expert_teams_*` tool into the shared tools registry.
 * @param ctx - the plugin context (injects `tools`).
 * @param config - resolved tool config.
 * @returns the core dependencies for downstream tool families (Zhijian).
 */
export function registerExpertTeamsTools(ctx: Context, config: ToolsConfig): ExpertToolsCore {
  installRetiredMemberGuard(ctx, config.stateDir)
  const memberSelections = installMemberSelectionRuntime(ctx, config.stateDir)
  const scheduler = installTeamScheduler(ctx, { stateDir: config.stateDir })

  ctx.tools.register(defineTool({
    name: 'expert_teams_create',
    description: 'Create a new Expert Teams team: you (the calling agent) become the captain. A captain leads one team at a time; create tasks and members afterwards with expert_teams_add_member and expert_teams_create_task.',
    parameters: {
      name: { type: 'string', required: true, description: 'Name for the new team (used as its stable id).' },
      description: { type: 'string', description: 'Team purpose / the goal the team will work on.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
          team_name: { type: 'string', required: true },
          state_dir: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Team "${value.team_name}" created (id ${value.team_id}) under ${value.state_dir}. You are the captain.`,
      }],
    },
    async execute(args, exec) {
      return createTeamCore(ctx, config, requireCaptain(exec), {
        name: args.name,
        ...args.description !== undefined ? { description: args.description } : {},
      }, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_scenario_apply',
    description: 'Assemble a full team from an Expert Library scenario in one call: creates the team, adds every preset expert as a member (each with its preset AI model route and expert persona), and seeds the scenario\'s task DAG with dependencies. The team records its scenario id, so later expert members receive the scenario knowledge guide too. Afterwards lead as usual with expert_teams_status / expert_teams_reassign_task / expert_teams_delete.',
    parameters: {
      scenario: { type: 'string', required: true, description: 'Scenario id to apply (e.g. code-review, market-research, product-design, fullstack-build, security-audit, documentation).' },
      team_name: { type: 'string', description: 'Team name; defaults to the scenario name.' },
      goal: { type: 'string', description: 'Team goal/description; defaults to the scenario description. Use this to pass the concrete target (e.g. the commit range to review).' },
      data: { type: 'string', description: 'Optional data/material context available to task placeholders.' },
      city: { type: 'string', description: 'Optional city or region for task placeholders.' },
      period: { type: 'string', description: 'Optional period for task placeholders.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scenario_id: { type: 'string', required: true },
          team_id: { type: 'string', required: true },
          team_name: { type: 'string', required: true },
          members: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                expert_id: { type: 'string', required: true },
                member_name: { type: 'string', required: true },
                model: { type: 'string', required: true },
              },
            },
            required: true,
          },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                task_id: { type: 'string', required: true },
                subject: { type: 'string', required: true },
                assignee: { type: 'string' },
              },
            },
            required: true,
          },
          deliverable: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [
          `Scenario "${value.scenario_id}" applied → team "${value.team_name}" (${value.team_id}).`,
          `Members (${value.members.length}): ${value.members.map(member => `${member.member_name} [${member.expert_id}] @ ${member.model}`).join(', ')}`,
          `Tasks (${value.tasks.length}): ${value.tasks.map(task => `${task.task_id}${task.assignee ? ` (${task.assignee})` : ''} ${task.subject}`).join('; ')}`,
          `Deliverable: ${value.deliverable}`,
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const created = await scenarioApplyCore(ctx, config, captain, {
        scenario: args.scenario,
        ...args.team_name !== undefined ? { team_name: args.team_name } : {},
        ...args.goal !== undefined ? { goal: args.goal } : {},
        ...args.data !== undefined ? { data: args.data } : {},
        ...args.city !== undefined ? { city: args.city } : {},
        ...args.period !== undefined ? { period: args.period } : {},
      }, exec.signal, memberSelections)
      // One final kick so every idle member picks up ready work now that the
      // full DAG is seeded (earlier per-task kicks already covered the rest).
      await scheduler.kickTeam(workspaceOf(captain), created.team_id, captain)
      return created
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_add_member',
    description: 'Add a durable continuable member. By default it snapshots the captain\'s current LLM route and effort. Supply provider/model only for an explicitly requested role-specific route; a changed provider or model automatically uses the target model\'s default effort. Set reasoning_effort only to request one of the target model\'s supported ids explicitly (or "default" to force its default). When `expert` is set, the member is spawned from the Expert Library: it receives the expert\'s persona, its preset AI model route (provider/model/reasoning effort), and the knowledge pack guide for that role; `name`/`role`/`provider`/`model` then default to the expert profile. The member waits for messages, works on assigned tasks, and can message the team.',
    parameters: {
      name: { type: 'string', description: 'Unique member name inside the team (defaults to the expert\'s name when `expert` is set).' },
      role: { type: 'string', description: 'Role of the member (e.g. researcher, engineer, reviewer); defaults to the expert\'s role.' },
      expert: { type: 'string', description: 'Expert Library profile id to spawn this member from (e.g. security-reviewer); presets persona, model route, and knowledge guide.' },
      provider: { type: 'string', description: 'Optional LLM provider route. Use only when the user explicitly requests a different provider; requires model.' },
      model: { type: 'string', description: 'Optional model override. Omit for the captain\'s current model (or the expert/configured memberModel default).' },
      reasoning_effort: { type: 'string', description: 'Optional reasoning effort override: one of the target model\'s supported effort ids, or "default" to force its default. When omitted, the captain\'s effort is inherited only for the same provider/model; a changed route uses the target default.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          member_name: { type: 'string', required: true },
          member_id: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          reasoning_effort: { type: 'string' },
          status: { type: 'string', required: true },
          expert_id: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Member "${value.member_name}" added (subagent id ${value.member_id}, ${value.provider}/${value.model}${value.reasoning_effort === undefined ? '' : `, reasoning ${value.reasoning_effort}`}, status ${value.status}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const team = await requireCaptainTeam(workspace, config, captain)
      const created = await addMemberCore(ctx, config, captain, {
        ...args.name !== undefined ? { name: args.name } : {},
        ...args.role !== undefined ? { role: args.role } : {},
        ...args.expert !== undefined ? { expert: args.expert } : {},
        ...args.provider !== undefined ? { provider: args.provider } : {},
        ...args.model !== undefined ? { model: args.model } : {},
        ...args.reasoning_effort !== undefined ? { reasoning_effort: args.reasoning_effort } : {},
      }, exec.signal, memberSelections)
      await scheduler.kickMember(workspace, team.id, created.member_name, captain)
      return created
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_remove_member',
    description: 'Remove a member safely: revoke its current attempts, return all unfinished owned tasks to the shared pending pool, interrupt its live turn, and mark it removed.',
    parameters: {
      name: { type: 'string', required: true, description: 'Name of the member to remove.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          member_name: { type: 'string', required: true },
          status: { type: 'string', required: true },
          requeued_tasks: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Member "${value.member_name}" removed (status ${value.status}); requeued tasks: ${value.requeued_tasks.join(', ') || 'none'}.`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      const revoked = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const member = requireMember(fresh, args.name)
        const requeued: string[] = []
        for (const task of fresh.tasks) {
          if (task.assignee !== member.name || task.status === 'completed') continue
          invalidateTaskAttempt(task)
          task.reassigning = false
          requeued.push(task.id)
        }
        member.status = 'removed'
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'expert-teams/member-removed', {
          teamId: fresh.id,
          memberId: member.id,
        })
        return { member: { ...member }, requeued }
      })
      if (revoked.member.id !== '') {
        await recordRetiredMemberIds(stateRoot, [revoked.member.id])
        interruptMember(ctx, captain, revoked.member.id)
        await waitForMemberIdle(ctx, revoked.member, exec.signal)
      }
      await scheduler.kickTeam(workspace, team.id, captain)
      return {
        member_name: revoked.member.name,
        status: revoked.member.status,
        requeued_tasks: revoked.requeued,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_create_task',
    description: 'Create a task in your team\'s task list. Tasks can depend on other tasks (dependencies): a task is only claimable once every dependency is completed. Optionally assign it to a member, who still claims it before working.',
    parameters: {
      subject: { type: 'string', required: true, description: 'Brief title for the task.' },
      description: { type: 'string', description: 'What needs to be done, in detail.' },
      dependencies: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task ids this task depends on (must be completed before this task can be claimed).',
      },
      assignee: { type: 'string', description: 'Optional member name this task is intended for.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          status: { type: 'string', required: true },
          assignee: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Task "${value.subject}" created as ${value.task_id} (status ${value.status}${value.assignee ? `, assigned to ${value.assignee}` : ''}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const team = await requireCaptainTeam(workspace, config, captain)
      const created = await createTaskCore(ctx, config, captain, {
        subject: args.subject,
        ...args.description !== undefined ? { description: args.description } : {},
        ...args.dependencies !== undefined ? { dependencies: args.dependencies } : {},
        ...args.assignee !== undefined ? { assignee: args.assignee } : {},
      }, exec.signal)
      await scheduler.kickTeam(workspace, team.id, captain)
      return created
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_reassign_task',
    description: 'Atomically retry, reassign, or let the captain take over any unfinished/failed task. The old attempt is revoked before its member is interrupted, so late updates cannot overwrite the new owner. Use assignee="captain" for captain takeover.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task to retry/reassign.' },
      assignee: { type: 'string', required: true, description: 'Active member name, or "captain" for captain takeover.' },
      reason: { type: 'string', description: 'Why the task is being retried or reassigned.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          previous_assignee: { type: 'string', required: true },
          assignee: { type: 'string', required: true },
          status: { type: 'string', required: true },
          attempt: { type: 'number', required: true },
          attempt_id: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} reassigned ${value.previous_assignee || 'unassigned'} → ${value.assignee} (attempt ${value.attempt}, status ${value.status}${value.attempt_id ? `, attempt_id ${value.attempt_id}` : ''}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      const target = args.assignee.trim()
      if (target === '') throw new Error('reassignment assignee must not be empty')

      const revoked = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const task = requireTask(fresh, args.task_id)
        if (task.status === 'completed') throw new Error(`completed task ${task.id} is immutable and cannot be reassigned`)
        if (task.reassigning === true) throw new Error(`task ${task.id} is already being reassigned`)
        const targetMember = target === CAPTAIN_KEY ? undefined : requireMember(fresh, target)
        if (targetMember !== undefined) {
          const busy = memberOpenTask(fresh, targetMember.name, task.id)
          if (busy !== undefined) {
            throw new Error(`member "${targetMember.name}" is busy with ${busy.id}; finish or reassign it first`)
          }
        }
        const previousAssignee = task.assignee ?? ''
        const previousMember = (task.status !== 'claimed' && task.status !== 'in_progress')
          || task.assignee === undefined || task.assignee === CAPTAIN_KEY
          ? undefined
          : fresh.members.find(member => member.name === task.assignee && member.status !== 'removed')
        invalidateTaskAttempt(task, target, true)
        await writeTeam(stateRoot, fresh)
        return {
          previousAssignee,
          previousMember: previousMember === undefined ? undefined : { ...previousMember },
          handoffId: task.handoffId,
        }
      })

      let quiescenceError: unknown
      if (revoked.previousMember !== undefined) {
        interruptMember(ctx, captain, revoked.previousMember.id)
        try {
          await waitForMemberIdle(ctx, revoked.previousMember, exec.signal)
        } catch (error: unknown) {
          quiescenceError = error
        }
      }

      await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const task = requireTask(fresh, args.task_id)
        if (task.handoffId !== revoked.handoffId || task.assignee !== target || task.reassigning !== true) {
          throw new Error(`task ${task.id} changed during reassignment; refusing to overwrite the newer state`)
        }
        task.reassigning = false
        if (quiescenceError === undefined && target === CAPTAIN_KEY) beginTaskAttempt(task, CAPTAIN_KEY)
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captain.session, 'expert-teams/task-updated', {
          teamId: fresh.id,
          taskId: task.id,
          status: task.status,
          assignee: task.assignee,
          ...args.reason === undefined ? {} : { output: `Reassigned: ${args.reason}` },
        })
      })
      if (quiescenceError !== undefined) throw quiescenceError
      if (target !== CAPTAIN_KEY) await scheduler.kickMember(workspace, team.id, target, captain)
      const current = await readTeam(stateRoot, team.id)
      const task = current === undefined ? undefined : requireTask(current, args.task_id)
      if (task === undefined) throw new Error(`team "${team.name}" ended during reassignment`)
      return {
        task_id: task.id,
        previous_assignee: revoked.previousAssignee,
        assignee: task.assignee ?? '',
        status: task.status,
        attempt: task.attempt ?? 0,
        ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_claim_task',
    description: 'Claim one ready task for a member (or yourself). A member cannot own a second unfinished task. The returned attempt_id is required for that member\'s updates and becomes stale after retry/reassignment.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The task id to claim.' },
      assignee: { type: 'string', description: 'Member to claim for (captain only; defaults to the task\'s assignee).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          assignee: { type: 'string', required: true },
          attempt: { type: 'number', required: true },
          attempt_id: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} claimed by ${value.assignee} (attempt ${value.attempt}${value.attempt_id ? `, attempt_id ${value.attempt_id}` : ''}, status ${value.status}).`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireParticipantTeam(workspace, config, caller)
      return withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, caller.id)
        const task = requireTask(fresh, args.task_id)
        if (task.reassigning === true) {
          throw new Error(`task ${task.id} is being reassigned; wait for the handoff to finish`)
        }
        let assignee = task.assignee
        if (identity.kind === 'captain') {
          if (args.assignee !== undefined) {
            requireMember(fresh, args.assignee)
            assignee = args.assignee
          }
        } else {
          if (args.assignee !== undefined) {
            throw new Error('members cannot set assignee when claiming a task')
          }
          if (assignee !== undefined && assignee !== identity.name) {
            throw new Error(`task ${task.id} is assigned to "${assignee}", not you`)
          }
          assignee = identity.name
        }
        // Authorization must happen before the idempotent return: another
        // member must not receive a false success for somebody else's task.
        if (task.status === 'claimed' || task.status === 'in_progress') {
          if (assignee === undefined || task.assignee !== assignee) {
            throw new Error(`task ${task.id} is already claimed by "${task.assignee ?? 'nobody'}"`)
          }
          return {
            task_id: task.id,
            status: task.status,
            assignee,
            attempt: task.attempt ?? 0,
            ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
          }
        }
        const pending = unsatisfiedDependencies(fresh.tasks, task.dependencies)
        if (pending.length > 0) {
          throw new Error(`task ${task.id} is blocked by unfinished dependencies: ${pending.join(', ')} — complete them first`)
        }
        const transition = transitionError(task.status, 'claimed')
        if (transition !== undefined) throw new Error(transition)
        if (assignee === undefined) {
          throw new Error('claiming an unassigned task needs an assignee (claim on behalf of a member)')
        }
        const busy = memberOpenTask(fresh, assignee, task.id)
        if (busy !== undefined) {
          throw new Error(`member "${assignee}" is busy with ${busy.id}; finish or reassign it first`)
        }
        const attemptId = beginTaskAttempt(task, assignee)
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'expert-teams/task-updated', {
          teamId: fresh.id,
          taskId: task.id,
          status: task.status,
          assignee: task.assignee,
        })
        return {
          task_id: task.id,
          status: task.status,
          assignee: task.assignee ?? '',
          attempt: task.attempt ?? 0,
          attempt_id: attemptId,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_update_task',
    description: 'Update a task status/output. Members must supply the current attempt_id returned by claim_task; stale attempts are rejected after takeover/reassignment. Terminal results are immutable. A captain must use reassign_task(assignee="captain") before updating member-owned work.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The task id to update.' },
      status: {
        type: 'string',
        enum: ['in_progress', 'completed', 'failed', 'cancelled'],
        description: 'New status (in_progress, completed, failed, cancelled).',
      },
      output: { type: 'string', description: 'Result summary; set when completing or failing.' },
      attempt_id: { type: 'string', description: 'Current execution capability returned by claim_task (required for members when present on the task).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          output: { type: 'string' },
          attempt: { type: 'number', required: true },
          attempt_id: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} attempt ${value.attempt} → ${value.status}${value.output !== undefined ? `\nOutput: ${value.output}` : ''}`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireParticipantTeam(workspace, config, caller)
      const updated = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, caller.id)
        const task = requireTask(fresh, args.task_id)
        if (identity.kind === 'captain'
          && task.assignee !== undefined
          && task.assignee !== CAPTAIN_KEY) {
          throw new Error(`task ${task.id} is owned by member "${task.assignee}"; call expert_teams_reassign_task with assignee="captain" before takeover`)
        }
        if (identity.kind === 'member') {
          if (task.assignee !== identity.name) {
            throw new Error(`task ${task.id} is assigned to "${task.assignee ?? 'nobody'}", not you`)
          }
          if (task.attemptId !== undefined && args.attempt_id !== task.attemptId) {
            throw new Error(`stale attempt for task ${task.id}: expected the current attempt_id; stop work and request fresh assignment`)
          }
        }
        if (TERMINAL_TASK_STATUSES.includes(task.status)) {
          const sameStatus = args.status === undefined || args.status === task.status
          const sameOutput = args.output === undefined || args.output === task.output
          if (!sameStatus || !sameOutput) {
            throw new Error(`terminal task ${task.id} is immutable; use expert_teams_reassign_task to retry failed/cancelled work`)
          }
          return {
            task_id: task.id,
            status: task.status,
            attempt: task.attempt ?? 0,
            ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
            ...task.output !== undefined ? { output: task.output } : {},
          }
        }
        if (args.status !== undefined) {
          const transition = transitionError(task.status, args.status)
          if (transition !== undefined) throw new Error(transition)
          task.status = args.status
        }
        if (args.output !== undefined) task.output = args.output
        task.updatedAt = Date.now()
        await writeTeam(stateRoot, fresh)
        await writeTaskProjectOutput(stateRoot, fresh.id, task)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'expert-teams/task-updated', {
          teamId: fresh.id,
          taskId: task.id,
          status: task.status,
          ...task.assignee !== undefined ? { assignee: task.assignee } : {},
          ...task.output !== undefined ? { output: task.output } : {},
        })
        return {
          task_id: task.id,
          status: task.status,
          attempt: task.attempt ?? 0,
          ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
          ...task.output !== undefined ? { output: task.output } : {},
        }
      })
      await scheduler.kickTeam(workspace, team.id, team.captainSessionId === caller.id ? caller : undefined)
      return updated
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_send_message',
    description: 'Send a message to the captain or to a teammate. Messages go straight into the recipient\'s mailbox; when the captain agent is online the plugin also schedules live delivery (member recipients get the message as their next turn; a running captain sees it at the nearest model step). No relay is involved: teammates talk to each other directly, exactly like the Claude Code Expert Teams mailbox model.',
    parameters: {
      to: { type: 'string', required: true, description: 'Recipient: "captain" or a member name.' },
      content: { type: 'string', required: true, description: 'The message text.' },
      from: { type: 'string', description: 'Sender (defaults to the caller: the captain, or the calling member).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message_id: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          delivered: { type: 'string', required: true, description: 'live (accepted by the live captain), wake (member recipient woken), or mailbox (durable inbox only).' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Message ${value.message_id} ${value.from} → ${value.to} delivered via ${value.delivered}.`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireParticipantTeam(workspace, config, caller)
      const to = args.to.trim()
      const prepared = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, caller.id)
        const from = identity.name
        // `from` may only be the caller's own identity: impersonating another
        // member (or the captain) would poison the mailbox and event records.
        if (args.from !== undefined && args.from !== from) {
          throw new Error(`expert_teams_send_message: "from" must be your own identity ("${from}"), not "${args.from}"`)
        }
        if (to === CAPTAIN_KEY) {
          const message = { ...createMessage(from, CAPTAIN_KEY, args.content), deliveryClaimedAt: Date.now() }
          await appendMailbox(stateRoot, fresh.id, CAPTAIN_KEY, message)
          appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'expert-teams/message-sent', {
            teamId: fresh.id,
            messageId: message.id,
            from,
            to: CAPTAIN_KEY,
            content: args.content,
            ts: message.ts,
          })
          return { kind: 'captain' as const, fresh, identity, message, from }
        }
        const recipient = requireMember(fresh, to)
        const message = { ...createMessage(from, recipient.name, args.content), deliveryClaimedAt: Date.now() }
        await appendMailbox(stateRoot, fresh.id, recipient.name, message)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'expert-teams/message-sent', {
          teamId: fresh.id,
          messageId: message.id,
          from,
          to: recipient.name,
          content: args.content,
          ts: message.ts,
        })
        return { kind: 'member' as const, fresh, identity, message, from, recipient }
      })

      // Resolve the exact live captain only after releasing the state lock.
      // The plugin mailbox is already durable if live delivery cannot proceed.
      const captain = ctx.agents.get(prepared.fresh.captainSessionId as SessionId)
      if (prepared.kind === 'captain') {
        let delivered: 'live' | 'mailbox' = 'mailbox'
        if (captain !== undefined && prepared.identity.kind === 'member') {
          delivered = steerCaptainReport(captain, prepared.from, args.content) ? 'live' : 'mailbox'
        }
        if (delivered === 'live') {
          await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
            acknowledgeMailbox(stateRoot, prepared.fresh.id, CAPTAIN_KEY, [prepared.message.id])
          ))
        } else {
          await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
            releaseMailboxDelivery(stateRoot, prepared.fresh.id, CAPTAIN_KEY, [prepared.message.id])
          ))
        }
        return { message_id: prepared.message.id, from: prepared.from, to: CAPTAIN_KEY, delivered }
      }
      let delivered: 'wake' | 'mailbox' = 'mailbox'
      if (captain !== undefined && prepared.recipient.id !== '') {
        const senderText = prepared.from === CAPTAIN_KEY
          ? args.content
          : `Message from team member ${prepared.from}:\n\n${args.content}`
        const text = `Expert Teams state policy: inspect ${config.stateDir}/${prepared.fresh.id}/ read-only; never edit team.json or inbox files directly. Use expert_teams_* tools for team state.\n\n${senderText}`
        const accepted = await deliverToMember(ctx, captain, prepared.recipient.id, text, exec.signal)
        delivered = accepted ? 'wake' : 'mailbox'
        if (accepted) {
          await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
            acknowledgeMailbox(stateRoot, prepared.fresh.id, prepared.recipient.name, [prepared.message.id])
          ))
        }
      }
      if (delivered === 'mailbox') {
        await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
          releaseMailboxDelivery(stateRoot, prepared.fresh.id, prepared.recipient.name, [prepared.message.id])
        ))
      }
      return {
        message_id: prepared.message.id,
        from: prepared.from,
        to: prepared.recipient.name,
        delivered,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_status',
    description: 'Team snapshot: members with live activity and tasks with status/assignee/dependencies/output. Captains also see every team mailbox; members see only their own inbox. Poll this to watch progress.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    async execute(_args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const located = await requireParticipantTeam(workspace, config, caller)
      if (located.captainSessionId === caller.id) {
        await scheduler.kickTeam(workspace, located.id, caller)
      }
      const { team, identity } = await withTeamLock(
        teamLockKey(stateRoot, located.id),
        () => requireFreshParticipant(stateRoot, located.id, caller.id),
      )
      const activity = await memberActivity(ctx, team.captainSessionId)
      const members = team.members
        .filter((member) => member.status !== 'removed')
        .map((member) => ({
          name: member.name,
          role: member.role ?? '',
          provider: member.provider ?? '',
          model: member.model ?? '',
          reasoning_effort: member.reasoningEffort ?? '',
          status: member.status,
          activity: member.id !== '' ? (activity.get(member.id) ?? 'unknown') : 'unspawned',
        }))
      const tasks = team.tasks.map((task) => ({
        id: task.id,
        subject: task.subject,
        status: task.status,
        assignee: task.assignee ?? '',
        dependencies: task.dependencies,
        attempt: task.attempt ?? 0,
        attempt_id: task.attemptId ?? '',
        reassigning: task.reassigning === true,
        ...task.output !== undefined ? { output: task.output } : {},
      }))
      const mailboxWarnings: string[] = []
      let mailboxWarningCount = 0
      const reportMalformed = (agentKey: string) => (lineNumber: number): void => {
        mailboxWarningCount += 1
        if (mailboxWarnings.length < 10) {
          mailboxWarnings.push(`${agentKey} mailbox line ${lineNumber}`)
        }
      }
      const captainInbox = identity.kind === 'captain'
        ? await readUnreadMailbox(stateRoot, team.id, CAPTAIN_KEY, reportMalformed(CAPTAIN_KEY))
        : []
      const memberInboxes: Record<string, { count: number; latest: string }> = {}
      const visibleMembers = identity.kind === 'captain'
        ? members
        : members.filter((member) => member.name === identity.name)
      for (const member of visibleMembers) {
        const messages = await readUnreadMailbox(
          stateRoot,
          team.id,
          member.name,
          reportMalformed(member.name),
        )
        if (messages.length > 0) {
          memberInboxes[member.name] = {
            count: messages.length,
            latest: messages[messages.length - 1]?.content.slice(0, 200) ?? '',
          }
        }
      }
      const result = {
        team_id: team.id,
        team_name: team.name,
        description: team.description ?? '',
        viewer: identity.name,
        members,
        tasks,
        captain_inbox: captainInbox.slice(-10).map((message) => ({
          from: message.from,
          content: message.content,
          ts: message.ts,
        })),
        member_inboxes: memberInboxes,
        mailbox_warnings: mailboxWarnings,
        mailbox_warning_count: mailboxWarningCount,
      }
      const acknowledged = identity.kind === 'captain'
        ? captainInbox.map(message => message.id)
        : await readUnreadMailbox(stateRoot, team.id, identity.name).then(messages => messages.map(message => message.id))
      if (acknowledged.length > 0) {
        await withTeamLock(teamLockKey(stateRoot, team.id), () => (
          acknowledgeMailbox(stateRoot, team.id, identity.kind === 'captain' ? CAPTAIN_KEY : identity.name, acknowledged)
        ))
      }
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'expert_teams_delete',
    description: 'End your team: interrupts all members (best effort) and deletes the team\'s state directory (team file, tasks, mailboxes). Use when the team\'s work is done or abandoned.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'boolean', required: true },
          team_name: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Team "${value.team_name}" deleted.`,
      }],
    },
    async execute(_args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      const members = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        // Include previously removed members so deleting a pre-fix team also
        // retires durable catalog entries left behind by remove_member.
        const roster = fresh.members.map(member => ({ ...member }))
        for (const member of fresh.members) {
          if (member.status === 'removed') continue
          member.status = 'removed'
          for (const task of fresh.tasks) {
            if (task.assignee === member.name && task.status !== 'completed') invalidateTaskAttempt(task)
          }
        }
        await writeTeam(stateRoot, fresh)
        return roster
      })
      await recordRetiredMemberIds(stateRoot, members.map(member => member.id))
      for (const member of members) {
        if (member.id === '') continue
        interruptMember(ctx, captain, member.id)
      }
      const quiescence = await Promise.allSettled(members.map(member => waitForMemberIdle(ctx, member, exec.signal)))
      for (const result of quiescence) {
        if (result.status === 'rejected') {
          ctx.logger.warn(`expert-teams: member did not quiesce cleanly before team archive: ${String(result.reason)}`)
        }
      }
      await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'expert-teams/team-deleted', {
          teamId: fresh.id,
        })
        // Archive, not delete: tasks (with their dependency graph) and the
        // mailboxes stay on disk for later review and dependency rebuilds.
        await archiveTeamDir(stateRoot, fresh.id)
      })
      return { deleted: true, team_name: team.name }
    },
  }))

  return { memberSelections, scheduler }
}

/** Build the `memberRuntime` config handed to member helpers. */
function memberRuntime(config: ToolsConfig): MemberRuntimeConfig {
  return {
    provider: config.memberProvider,
    maxDepth: config.memberMaxDepth,
  }
}

/** Render the status snapshot as compact text for the model. */
function renderStatus(value: JsonValue): string {
  const team = value as {
    team_name: string
    description?: string
    viewer: string
    members: {
      name: string
      role: string
      provider: string
      model: string
      reasoning_effort: string
      status: string
      activity: string
    }[]
    tasks: { id: string; subject: string; status: string; assignee: string; dependencies: string[]; attempt: number; attempt_id: string; reassigning: boolean; output?: string }[]
    captain_inbox: { from: string; content: string }[]
    member_inboxes: Record<string, { count: number; latest: string }>
    mailbox_warnings: string[]
    mailbox_warning_count: number
  }
  const lines: string[] = [
    `Team "${team.team_name}"${team.description ? ` — ${team.description}` : ''}`,
    `Viewing as: ${team.viewer}`,
    `Members (${team.members.length}):`,
    ...team.members.map((member) => {
      const route = member.provider && member.model ? ` · ${member.provider}/${member.model}` : ''
      const effort = member.reasoning_effort ? ` · reasoning ${member.reasoning_effort}` : ''
      return `  - ${member.name} [${member.role}] ${member.status}/${member.activity}${route}${effort}`
    }),
    `Tasks (${team.tasks.length}):`,
    ...team.tasks.map((task) => {
      const deps = task.dependencies.length > 0 ? ` (deps: ${task.dependencies.join(',')})` : ''
      const output = task.output !== undefined ? `\n      output: ${task.output.slice(0, 300)}` : ''
      const handoff = task.reassigning ? ' (reassigning)' : ''
      return `  - ${task.id} [${task.status}] attempt ${task.attempt}${handoff} ${task.subject} → ${task.assignee || 'unassigned'}${deps}${output}`
    }),
    `Captain inbox (${team.captain_inbox.length}):`,
    ...team.captain_inbox.map((message) => `  - [${message.from}] ${message.content.slice(0, 200)}`),
  ]
  for (const [name, inbox] of Object.entries(team.member_inboxes)) {
    lines.push(`Member inbox ${name} (${inbox.count}): latest — ${inbox.latest.slice(0, 120)}`)
  }
  if (team.mailbox_warning_count > 0) {
    lines.push(
      `Mailbox warnings (${team.mailbox_warning_count}; malformed lines were skipped; showing up to 10):`,
      ...team.mailbox_warnings.map((warning) => `  - ${warning}`),
    )
  }
  return lines.join('\n')
}
