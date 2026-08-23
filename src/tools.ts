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
  commitTaskUpdate,
  createMessage,
  createTaskProject,
  createTeamDir,
  finalizeTerminalTask,
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
  memberRouteRequest,
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
import { applyExecutionPlan, compileErrorOf } from './apply.ts'
import { evaluateTaskCompletionGates, subjectWithQualityMark, taskGateBlockedError } from './task-gates.ts'
import { compileV1ScenarioExecutionPlan, builtinLegacyPack } from './v2/compat.ts'
import { resolveRuntimePack } from './v2/runtime-pack.ts'
import {
  addMemberCore,
  createTaskCore,
  createTeamCore,
  requireCaptainTeam,
  requireFreshCaptainTeam,
  requireFreshTeam,
  requireMember,
  requireTask,
  rollbackTeamAssembly,
  stateRootOf,
  teamLockKey,
  waitForMemberIdle,
  workspaceOf,
  type ExpertToolsCore,
  type ToolsConfig,
} from './team-core.ts'
export {
  addMemberCore,
  createTaskCore,
  createTeamCore,
  rollbackTeamAssembly,
  type ExpertToolsCore,
  type ToolsConfig,
} from './team-core.ts'

/** The caller agent, or a loud failure for non-agent callers. */
function requireCaptain(exec: ToolRunContext): Agent {
  if (!exec.agent) {
    throw new Error('agent_teams tools require a calling agent (exec.agent was undefined)')
  }
  return exec.agent
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

function memberOpenTask(team: TeamState, memberName: string, exceptTaskId?: string): TeamTask | undefined {
  return team.tasks.find(task => task.id !== exceptTaskId
    && task.assignee === memberName
    && (task.status === 'claimed' || task.status === 'in_progress'))
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
// The four transactional cores (createTeamCore / addMemberCore /
// createTaskCore / rollbackTeamAssembly) moved to `team-core.ts` so the V2
// apply bridge (`src/apply.ts`) can reuse them without an import cycle.
// `scenarioApplyCore` below compiles the V1 scenario through
// `compileV1ScenarioExecutionPlan` and applies the compiled plan.

/** Core of `expert_teams_scenario_apply`: assemble a team from a scenario.
 *
 * Thin adapter over the V2 compiler bridge: the V1 scenario is projected and
 * compiled by `compileV1ScenarioExecutionPlan` into an immutable ExecutionPlan
 * (roster + task DAG isomorphic to the V1 `t1..tn` convention), then applied
 * through `applyExecutionPlan`, which runs the same transactional
 * create/add/task/kick sequence as the previous imperative assembler and rolls
 * the team back (members retired + interrupted, state archived) on any
 * failure, so a half-built team can never wedge the captain's one-team slot.
 */
export async function scenarioApplyCore(
  ctx: Context,
  config: ToolsConfig,
  captain: Agent,
  args: { scenario: string; team_name?: string; goal?: string; data?: string; city?: string; period?: string },
  signal: AbortSignal,
  core: ExpertToolsCore,
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

  // 1. Team metadata + skill resolution (I/O stays in the adapter).
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
    const resolved = await resolveSkill(ctx, workspace, config.knowledgeDir, scenario.skill.id, scenario.skill.name)
    skillBlock = `\n\n${skillDescriptionBlock(resolved, scenario.skill.purpose)}`
  }

  // 2. Compile the V1 scenario through the V2 TeamTemplate compiler, with the
  //    workspace domain-pack overlay merged in (workspace experts override
  //    builtins by id; the base library survives as the builtin layer).
  const runtimePack = (await resolveRuntimePack(ctx, config, builtinLegacyPack())).pack
  const compiled = compileV1ScenarioExecutionPlan([...library.experts.values()], scenario, runtimePack)
  if (!compiled.ok) throw compileErrorOf(compiled)

  // Skill task suffix: reproduced exactly as the previous assembler appended
  // it (`\n\n` + trimmed block for described tasks; bare trimmed block when
  // the skill task had no description of its own).
  const taskSuffixes: Record<string, string> = {}
  if (scenario.skill !== undefined) {
    const skillTaskIndex = scenario.skill.appliesToTaskIndex ?? (scenario.tasks.length - 1)
    const block = skillBlock.trim()
    if (block !== '') {
      const template = scenario.tasks[skillTaskIndex]
      taskSuffixes[`t${skillTaskIndex + 1}`] = template?.description === undefined ? block : `\n\n${block}`
    }
  }

  // 3. Apply: create → members (scenario.experts order) → tasks → kick;
  //    `applyExecutionPlan` rolls the team back on any failure.
  const applied = await applyExecutionPlan(ctx, config, captain, compiled.plan, {
    teamName,
    description: `${interpolateScenarioTemplate(templateValues.goal, templateValues)}${skillBlock}`,
    // All six V1 placeholder keys are always present (missing → ''), exactly
    // like the previous `interpolateScenarioTemplate` semantics.
    interpolations: {
      goal: templateValues.goal,
      team_name: teamName,
      scenario: scenario.id,
      data: templateValues.data ?? '',
      city: templateValues.city ?? '',
      period: templateValues.period ?? '',
    },
    memberOrder: expertIds,
    taskSuffixes,
  }, signal, core)

  return {
    scenario_id: scenario.id,
    team_id: applied.team_id,
    team_name: applied.team_name,
    members: applied.members,
    tasks: applied.tasks,
    deliverable: scenario.deliverable,
  }
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
      }, exec.signal, { memberSelections, scheduler })
      // `applyExecutionPlan` already kicked the team once after the full DAG
      // was seeded (inside its transactional try block).
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
    description: 'Update a task status/output. Members must supply the current attempt_id returned by claim_task; stale attempts are rejected after takeover/reassignment. Terminal results are immutable. A captain must use reassign_task(assignee="captain") before updating member-owned work. Completing a task runs the team plan\'s quality gates: a failing hard gate blocks the completion with gate id, reason and correction guidance (fix the output and retry); soft-gate warnings are returned as gate_warnings; the derived 0-100 quality score is stamped into the task title as 「质 NN」(「质 NN·硬门未过」 when a hard gate blocks).',
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
          gate_warnings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Quality-gate warnings attached at completion (soft-gate issues, or hard-gate failures waived after the plan policy\'s repair budget ran out).',
          },
          quality_score: {
            oneOf: [{ type: 'number' }, { type: 'null' }],
            required: true,
            description: 'Forced-recovery field: derived 0-100 quality score of the last gated run (null when the team has no resolvable quality policy — the key is always present).',
          },
          repair_count: {
            type: 'number',
            required: true,
            description: 'Forced-recovery field: repair rounds used (hard-gate blocks) at the last completion attempt (0 when none).',
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} attempt ${value.attempt} → ${value.status}${value.output !== undefined ? `\nOutput: ${value.output}` : ''}\n质量分 ${value.quality_score ?? '—'} ｜ 修复 ${value.repair_count} 轮${value.gate_warnings !== undefined ? `\nQuality warnings:\n- ${value.gate_warnings.join('\n- ')}` : ''}`,
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
            ...task.gateWarnings !== undefined && task.gateWarnings.length > 0 ? { gate_warnings: [...task.gateWarnings] } : {},
            quality_score: task.qualityScore ?? null,
            repair_count: task.repairCount ?? 0,
          }
        }
        // Pre-update snapshot for the compensating commit below (project
        // files are restored from it when the team write fails).
        const snapshot: TeamTask = {
          ...task,
          ...task.project === undefined ? {} : { project: { ...task.project } },
        }
        // Quality gates on completion. The gate chain is evaluated BEFORE any
        // status/output mutation, so a block persists ONLY the repair-budget
        // counter, the quality-score subject marker and the forced
        // qualityScore/repairCount fields, and leaves the task
        // claimed/in_progress (status, output and attemptId untouched) — the
        // member fixes the output and retries with the same attempt. Soft-gate
        // warnings (and hard failures waived by budget exhaustion) are
        // attached to the task result; the derived score is stamped into the
        // task title as 「质 NN」(idempotent — repeated evaluations replace the
        // old marker). No resolvable policy ⇒ undefined ⇒ exactly today's
        // behavior (no marker), except the task still records
        // qualityScore: null / repairCount: 0 — the fields are ALWAYS present
        // (forced recovery, never left to the member's output).
        let gateWarnings: readonly string[] | undefined
        if (args.status === 'completed') {
          const transition = transitionError(task.status, 'completed')
          if (transition !== undefined) throw new Error(transition)
          const gateResult = evaluateTaskCompletionGates(fresh, task, args.output ?? task.output)
          if (gateResult !== undefined) {
            if (gateResult.blocked !== undefined) {
              task.gateFailCount = gateResult.blocked.budgetUsed
              task.subject = subjectWithQualityMark(task.subject, gateResult.blocked.score, true)
              task.qualityScore = gateResult.blocked.score
              task.repairCount = gateResult.blocked.budgetUsed
              task.updatedAt = Date.now()
              await writeTeam(stateRoot, fresh)
              throw taskGateBlockedError(gateResult.blocked)
            }
            task.subject = subjectWithQualityMark(task.subject, gateResult.score, false)
            task.qualityScore = gateResult.score
            task.repairCount = task.gateFailCount ?? 0
            if (gateResult.warnings.length > 0) {
              gateWarnings = gateResult.warnings
            }
          } else {
            // No resolvable quality policy: the fields still exist (null/0).
            task.qualityScore = null
            task.repairCount = 0
          }
        }
        if (args.status !== undefined) {
          const transition = transitionError(task.status, args.status)
          if (transition !== undefined) throw new Error(transition)
          task.status = args.status
        }
        if (args.output !== undefined) task.output = args.output
        if (gateWarnings !== undefined) task.gateWarnings = gateWarnings
        // Terminal work drops its live capability: stale-claim checks and
        // audit views must never see a lingering attemptId on dead work.
        finalizeTerminalTask(task)
        task.updatedAt = Date.now()
        // Compensating commit: project output first, team record second, with
        // a snapshot rollback when the team write fails (see commitTaskUpdate).
        await commitTaskUpdate(stateRoot, fresh, task, snapshot)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'expert-teams/task-updated', {
          teamId: fresh.id,
          taskId: task.id,
          status: task.status,
          ...task.assignee !== undefined ? { assignee: task.assignee } : {},
          ...task.output !== undefined ? { output: task.output } : {},
          ...task.gateWarnings !== undefined ? { gateWarnings: [...task.gateWarnings] } : {},
        })
        return {
          task_id: task.id,
          status: task.status,
          attempt: task.attempt ?? 0,
          ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
          ...task.output !== undefined ? { output: task.output } : {},
          ...task.gateWarnings !== undefined && task.gateWarnings.length > 0 ? { gate_warnings: [...task.gateWarnings] } : {},
          quality_score: task.qualityScore ?? null,
          repair_count: task.repairCount ?? 0,
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
    name: 'expert_teams_chat',
    description: '向团队内某位成员发起一轮追问（连续对话通道，P2.1）：不重建团队、不新建任务——消息进入成员 mailbox 并唤醒其新回合，回合计数累计在成员记录上（可追溯）。仅队长可用；用于对已完成/进行中的输出做澄清、口径修正或延伸追问。',
    parameters: {
      member: { type: 'string', required: true, description: '目标成员名（团队内 active 成员）。' },
      content: { type: 'string', required: true, description: '追问内容（澄清问题/口径修正/延伸要求）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          member: { type: 'string', required: true },
          round: { type: 'number', required: true, description: '该成员的累计追问回合数。' },
          message_id: { type: 'string', required: true },
          delivered: { type: 'string', required: true, description: 'wake（成员被唤醒）或 mailbox（仅入箱）。' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `追问已发出：${value.member} 第 ${value.round} 轮（message ${value.message_id}，${value.delivered === 'wake' ? '成员已唤醒' : '已入 mailbox'}）。`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireParticipantTeam(workspace, config, captain)
      const memberName = args.member.trim()
      const prepared = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, captain.id)
        if (identity.kind !== 'captain') {
          throw new Error('expert_teams_chat 仅队长可用；成员间的追问请用 expert_teams_send_message')
        }
        const recipient = requireMember(fresh, memberName)
        recipient.chatRounds = (recipient.chatRounds ?? 0) + 1
        const round = recipient.chatRounds
        const message = { ...createMessage(CAPTAIN_KEY, recipient.name, args.content), deliveryClaimedAt: Date.now() }
        await appendMailbox(stateRoot, fresh.id, recipient.name, message)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'expert-teams/chat-round', {
          teamId: fresh.id,
          messageId: message.id,
          member: recipient.name,
          round,
          content: args.content,
          ts: message.ts,
        })
        await writeTeam(stateRoot, fresh)
        return { fresh, recipient: { ...recipient }, message, round }
      })
      // Live delivery (same path as send_message → member): wake the member
      // with the follow-up as its next turn; mailbox fallback is durable.
      const liveCaptain = ctx.agents.get(prepared.fresh.captainSessionId as SessionId)
      let delivered: 'wake' | 'mailbox' = 'mailbox'
      if (liveCaptain !== undefined && prepared.recipient.id !== '') {
        const text = `Expert Teams state policy: inspect ${config.stateDir}/${prepared.fresh.id}/ read-only; never edit team.json or inbox files directly. Use expert_teams_* tools for team state.\n\n队长追问（第 ${prepared.round} 轮）：\n\n${args.content}`
        const accepted = await deliverToMember(ctx, liveCaptain, prepared.recipient.id, text, exec.signal)
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
        member: prepared.recipient.name,
        round: prepared.round,
        message_id: prepared.message.id,
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
        // Forced-recovery fields: always present in the report (null/0 when no
        // quality policy applies or the task was never gated).
        quality_score: task.qualityScore ?? null,
        repair_count: task.repairCount ?? 0,
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
    tasks: { id: string; subject: string; status: string; assignee: string; dependencies: string[]; attempt: number; attempt_id: string; reassigning: boolean; output?: string; quality_score: number | null; repair_count: number }[]
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
      const quality = task.status === 'completed'
        ? `\n      质量分 ${task.quality_score ?? '—'} ｜ 修复 ${task.repair_count} 轮`
        : ''
      return `  - ${task.id} [${task.status}] attempt ${task.attempt}${handoff} ${task.subject} → ${task.assignee || 'unassigned'}${deps}${quality}${output}`
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
