/**
 * Expert Teams core operations — the transactional assembly primitives shared
 * by every team-building entry (`expert_teams_*`, collab modes, Zhijian
 * review, and the V2 `applyExecutionPlan` bridge).
 *
 * Extracted from `tools.ts` so the V2 apply module (`src/apply.ts`) can reuse
 * the exact same create/add/task/rollback logic (locks, validation, events,
 * spawning) without an import cycle between the tool layer and the apply
 * bridge. `tools.ts` re-exports everything here, so downstream tool families
 * (collab, Zhijian) keep their existing imports.
 * @module dsh-expert-library/team-core
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { appendTeamEvent, captainSessionOf } from './events.ts'
import {
  archiveTeamDir,
  createTeamDir,
  createTaskProject,
  findTeamByCaptain,
  findTeamByParticipant,
  invalidateTaskAttempt,
  recordRetiredMemberIds,
  readTeam,
  sanitizeKey,
  writeTeam,
  withTeamLock,
  CAPTAIN_KEY,
} from './state.ts'
import {
  expertMemberPersona,
  interruptMember,
  memberRouteRequest,
  resolveMemberLlmSelection,
  spawnMember,
  type MemberRuntimeConfig,
  type MemberSelectionRuntime,
} from './members.ts'
import type { TeamMember, TeamState, TeamTask } from './types.ts'
import type { TeamScheduler } from './scheduler.ts'
import { resolveLibrary } from './expert-library/registry.ts'
import type { Expert, ExpertModelRoute } from './expert-library/types.ts'
import { knowledgeGuide } from './knowledge.ts'
import { skillsGuideSection } from './skills-discovery.ts'
import { zhijianExpertPersona } from './zhijian/persona.ts'
import { feedbackGuideSection } from './zhijian/evaluations.ts'
import { isZhijianExpertId, zhijianMetaById } from './zhijian/registry.ts'
import { scenarioById } from './zhijian/routing.ts'
import { expertMemoryGuideSection } from './zhijian/expert-memory.ts'
import type { ToolExecutionConfig, ToolExecutionMode } from './settings.ts'

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
  /** Domain pack directory name under each workspace root (read-only preview surface). */
  packsDir: string
  /** Workspace domain pack ids enabled for runtime compile; absent/empty = every valid workspace pack. */
  enabledPacks?: readonly string[]
  /** Workspace domain pack id order (first = highest precedence); absent = discovery order. */
  packPriority?: readonly string[]
  /** Per-expert model route override (expert id → route); wins over the preset expert route. */
  expertModelOverrides?: Readonly<Record<string, ExpertModelRoute>>
  /** Per-tool execution policy (API vs CLI vs auto) for external capabilities. */
  toolExecution?: Record<string, ToolExecutionConfig>
}

/** The captain's workspace directory (team state root parent). */
export function workspaceOf(agent: Agent): string {
  return agent.session.header.cwd ?? process.cwd()
}

/** Resolved absolute state root. */
export function stateRootOf(workspace: string, config: ToolsConfig): string {
  return join(workspace, config.stateDir)
}

/** Process-local lock key scoped by workspace state root and team id. */
export function teamLockKey(stateRoot: string, teamId: string): string {
  return `team:${stateRoot}:${teamId}`
}

/** Process-local lock key enforcing one active team per captain session. */
export function captainLockKey(stateRoot: string, captainId: string): string {
  return `captain:${stateRoot}:${captainId}`
}

/** The team this captain currently leads, or a loud failure. */
export async function requireCaptainTeam(workspace: string, config: ToolsConfig, captain: Agent): Promise<TeamState> {
  const team = await findTeamByCaptain(stateRootOf(workspace, config), captain.id)
  if (team === undefined) {
    throw new Error('you are not leading any team yet — call expert_teams_create first')
  }
  return team
}

/** Fresh state for a team that still exists; never falls back to stale lookup data. */
export async function requireFreshTeam(stateRoot: string, teamId: string): Promise<TeamState> {
  const fresh = await readTeam(stateRoot, teamId)
  if (fresh === undefined) throw new Error(`team "${teamId}" is no longer active`)
  return fresh
}

/** Fresh state with captain authorization rechecked inside the lock. */
export async function requireFreshCaptainTeam(
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

/** Look up one live (non-removed) member by display name. */
export function requireMember(team: TeamState, name: string): TeamMember {
  const member = team.members.find((candidate) => candidate.name === name && candidate.status !== 'removed')
  if (member === undefined) {
    throw new Error(`no active member named "${name}" in team "${team.name}"`)
  }
  return member
}

/** Look up one task by id. */
export function requireTask(team: TeamState, taskId: string): TeamTask {
  const task = team.tasks.find((candidate) => candidate.id === taskId)
  if (task === undefined) {
    throw new Error(`no task "${taskId}" in team "${team.name}" — use expert_teams_status to list tasks`)
  }
  return task
}

/** Wait for a live member subagent to quiesce (abort-aware). */
export async function waitForMemberIdle(ctx: Context, member: TeamMember, signal: AbortSignal): Promise<void> {
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

/** Build the `memberRuntime` config handed to member helpers. */
export function memberRuntime(config: ToolsConfig): MemberRuntimeConfig {
  return {
    provider: config.memberProvider,
    maxDepth: config.memberMaxDepth,
  }
}

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
    // plugin memberModel default > captain's current route (see
    // memberRouteRequest — a lone explicit reasoning_effort rides on top of
    // whichever provider/model won instead of being dropped). A settings
    // `expertModelOverrides` entry (if any) replaces the preset expert route,
    // so the user-configured override wins over the pack-baked route.
    const expertRoute = config.expertModelOverrides?.[expertId ?? '']
    const selection = await resolveMemberLlmSelection(
      ctx,
      captain,
      memberRouteRequest(args, expertRoute ?? expert?.model, config.memberModel),
      signal,
    )

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
    // experts get their Profile JSON baked into the persona instead. The
    // available-skills inventory rides on the same guide (via the shared
    // skills index), so members always see what local skills exist instead of
    // only learning about one when a task names it.
    let personaOverride: string | undefined
    if (expert !== undefined) {
      const scenario = fresh.scenarioId === undefined ? undefined : (library?.scenarios.get(fresh.scenarioId))
      const guide = await knowledgeGuide(workspace, config.knowledgeDir, expert.id, fresh.scenarioId)
      // zhijian.expert-memory serving (pack-first): a member of a zhijian plan
      // team whose scenario requires the memory base gets a guide section
      // pointing at the entity records; generic teams get none; a missing pack
      // file degrades to a warning note — never a team-creation failure.
      const memorySection = await expertMemoryGuideSection({ workspace, packsDir: config.packsDir, scenarioId: fresh.scenarioId })
      const guideWithMemory = memorySection === ''
        ? guide
        : guide === ''
          ? memorySection
          : `${guide}\n\n${memorySection}`
      const skillsSection = skillsGuideSection(ctx, workspace, config.knowledgeDir)
      const guideWithSkills = skillsSection === ''
        ? guideWithMemory
        : guideWithMemory === ''
          ? skillsSection
          : `${guideWithMemory}\n\n${skillsSection}`
      // P2.2: 既往反馈摘要注入（expert_review_feedback 回写的 evaluations.jsonl；
      // 无反馈时为空串，不产生噪音）。
      const feedbackSection = await feedbackGuideSection(workspace, config.knowledgeDir, expert.id)
      const guideWithFeedback = feedbackSection === ''
        ? guideWithSkills
        : guideWithSkills === ''
          ? feedbackSection
          : `${guideWithSkills}\n\n${feedbackSection}`
      if (isZhijianExpertId(expert.id)) {
        const meta = zhijianMetaById(expert.id)
        if (meta !== undefined) {
          const framework = fresh.scenarioId === undefined
            ? undefined
            : scenarioById(fresh.scenarioId)?.framework
          personaOverride = zhijianExpertPersona(fresh, member, config.stateDir, meta, framework, guideWithFeedback)
        }
      }
      if (personaOverride === undefined) {
        personaOverride = expertMemberPersona(fresh, member, config.stateDir, expert, guideWithFeedback, scenario?.name)
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
