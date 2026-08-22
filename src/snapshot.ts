/**
 * Team activity snapshot assembly for the activity panel.
 *
 * Server-side assembly mirrors the Claude Code desktop teamWatcher: read the
 * durable team files (the truth source) and enrich with live subagent
 * activity, so the panel always reflects the on-disk state even when a model
 * skipped a tool "ritual" (e.g. not calling update_task on completion).
 * @module dsh-expert-library/snapshot
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CAPTAIN_KEY, listArchivedTeamIds, readArchivedTeam, readUnreadMailbox, readTeam,
  taskDepthsById, taskVisualState,
} from './state.ts'
import type { MemberStatus, TeamState, TeamTask } from './types.ts'

/** Visual task state for the activity panel. */
export type VisualTaskState = 'blocked' | 'open' | 'running' | 'completed'

/**
 * One output document of an expert member: either the task deliverable record
 * (`output/result.json`) or a published artifact file the member produced.
 * `url` points at the plugin's project route, which serves the file from the
 * team's isolated task project directory.
 */
export interface MemberDocument {
  /** Which task produced the document. */
  readonly taskId: string
  /** Human title of the producing task. */
  readonly taskSubject: string
  /** `output` = the task deliverable record; `artifact` = a published file. */
  readonly kind: 'output' | 'artifact'
  /** File name as stored inside the task project. */
  readonly name: string
  /** Absolute URL the panel can open in a new tab. */
  readonly url: string
  /** First characters of the deliverable text (`kind: 'output'` only). */
  readonly preview?: string
  /** Artifact byte size (`kind: 'artifact'` only). */
  readonly sizeBytes?: number
  /** Artifact publication time (`kind: 'artifact'` only). */
  readonly updatedAt?: number
}

/** One member row of the activity snapshot. */
export interface TeamActivityMember {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly status: MemberStatus
  readonly activity: 'working' | 'idle' | 'unknown'
  readonly progress: number
  readonly done: number
  readonly total: number
  readonly currentTask: string
  readonly unread: number
  /** Output documents this member produced (task outputs + published artifacts). */
  readonly documents: readonly MemberDocument[]
}

/** One task row of the activity snapshot. */
export interface TeamActivityTask {
  readonly id: string
  readonly subject: string
  readonly status: string
  readonly state: VisualTaskState
  readonly assignee: string
  readonly dependencies: readonly string[]
  readonly depth: number
}

/** One captain-inbox preview row. */
export interface TeamActivityMessage {
  readonly from: string
  readonly content: string
}

/** The full panel payload for one team. */
export interface TeamActivitySnapshot {
  readonly workspace: string
  readonly teamId: string
  readonly name: string
  readonly description?: string
  readonly captainSessionId: string
  readonly members: readonly TeamActivityMember[]
  readonly tasks: readonly TeamActivityTask[]
  readonly messageCount: number
  readonly captainInbox: readonly TeamActivityMessage[]
}

/** Snapshot projection switches for live and archived teams. */
export interface TeamSnapshotOptions {
  /** Historic review must retain members that were marked removed at shutdown. */
  readonly includeRemoved?: boolean
  /** Archived teams have no meaningful live activity after their sessions stop. */
  readonly historic?: boolean
}

/** The current task of a member: its first unfinished owned task. */
function currentTaskOf(memberName: string, tasks: readonly TeamTask[]): string {
  for (const task of tasks) {
    if (task.status === 'in_progress' && task.assignee === memberName) return task.id
  }
  return ''
}

/** Base path of the plugin's task-project file route. */
const PROJECT_ROUTE = '/plugins/dsh-expert-library/project'

/** Short readable preview of a task deliverable (kept tiny for the 1s poll). */
const DOC_PREVIEW_MAX = 180

function documentPreview(output: string | undefined): string | undefined {
  if (output === undefined) return undefined
  const cleaned = output.replace(/\s+/gu, ' ').trim()
  if (cleaned === '') return undefined
  return cleaned.length > DOC_PREVIEW_MAX ? `${cleaned.slice(0, DOC_PREVIEW_MAX)}…` : cleaned
}

/**
 * Project the output documents one member produced onto the activity panel.
 *
 * Everything is derived from the already-loaded team record (task projects,
 * `output` texts, published artifact manifests), so the 1s poll adds no
 * filesystem reads. Only finished deliverables count: a task must be
 * `completed` and carry a project; artifacts come from the task's published
 * manifest.
 */
function memberDocuments(memberName: string, tasks: readonly TeamTask[], teamId: string): MemberDocument[] {
  const documents: MemberDocument[] = []
  for (const task of tasks) {
    if (task.assignee !== memberName || task.status !== 'completed') continue
    if (task.project === undefined) continue
    const taskRef = `team=${encodeURIComponent(teamId)}&task=${encodeURIComponent(task.id)}`
    documents.push({
      taskId: task.id,
      taskSubject: task.subject,
      kind: 'output',
      name: 'result.json',
      url: `${PROJECT_ROUTE}?${taskRef}&dir=output&file=result.json`,
      ...(documentPreview(task.output) === undefined ? {} : { preview: documentPreview(task.output) }),
    })
    for (const artifact of task.publishedArtifacts ?? []) {
      const safeName = artifact.relativePath.split('/').pop() ?? artifact.relativePath
      if (safeName === '') continue
      documents.push({
        taskId: task.id,
        taskSubject: task.subject,
        kind: 'artifact',
        name: safeName,
        url: `${PROJECT_ROUTE}?${taskRef}&dir=artifacts&file=${encodeURIComponent(safeName)}`,
        sizeBytes: artifact.sizeBytes,
        updatedAt: artifact.createdAt,
      })
    }
  }
  return documents
}

/**
 * Assemble one team snapshot from its durable files plus live activity.
 * @param ctx - the plugin context (injects `subagents`, used for activity).
 * @param stateRoot - resolved absolute state root of the owning workspace.
 * @param workspace - display name of the owning workspace.
 * @param state - the durable team record.
 * @returns the panel snapshot.
 */
export async function assembleTeamSnapshot(
  ctx: Context,
  stateRoot: string,
  workspace: string,
  state: TeamState,
  options: TeamSnapshotOptions = {},
): Promise<TeamActivitySnapshot> {
  const tasks = state.tasks
  const depths = taskDepthsById(tasks)
  const roster = options.includeRemoved === true
    ? state.members
    : state.members.filter((member) => member.status !== 'removed')
  const activity = new Map<string, 'running' | 'idle' | 'ready'>()
  if (options.historic !== true) {
    try {
      const children = await ctx.subagents.listChildren(state.captainSessionId as SessionId)
      for (const entry of children) {
        if (entry.kind === 'child') {
          const live = ctx.agents.get(entry.id)
          activity.set(entry.id, live === undefined ? 'ready' : live.status)
        }
      }
    } catch (error: unknown) {
      ctx.logger.warn(`expert-teams: activity listing failed for ${state.name}: ${String(error)}`)
    }
  }
  const unreadByMember = new Map<string, number>()
  for (const member of roster) {
    try {
      unreadByMember.set(member.name, (await readUnreadMailbox(stateRoot, state.id, member.name)).length)
    } catch (error: unknown) {
      ctx.logger.warn(`expert-teams: mailbox read failed for ${member.name}: ${String(error)}`)
      unreadByMember.set(member.name, 0)
    }
  }
  const members: TeamActivityMember[] = roster.map((member) => {
    const owned = tasks.filter((task) => task.assignee === member.name)
    const done = owned.filter((task) => task.status === 'completed').length
    return {
      id: member.id,
      name: member.name,
      role: member.role ?? '',
      status: member.status,
      activity: options.historic === true
        ? 'idle'
        : member.id !== ''
          ? (activity.get(member.id) === 'running'
              ? 'working'
              : activity.get(member.id) === 'idle' || activity.get(member.id) === 'ready'
                ? 'idle'
                : 'unknown')
          : 'unknown',
      progress: owned.length === 0 ? 0 : Math.round((done / owned.length) * 100),
      done,
      total: owned.length,
      currentTask: currentTaskOf(member.name, tasks),
      unread: unreadByMember.get(member.name) ?? 0,
      documents: memberDocuments(member.name, tasks, state.id),
    }
  })
  const captainInbox = await readUnreadMailbox(stateRoot, state.id, CAPTAIN_KEY)
  return {
    workspace,
    teamId: state.id,
    name: state.name,
    ...state.description !== undefined ? { description: state.description } : {},
    captainSessionId: state.captainSessionId,
    members,
    tasks: tasks.map((task) => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      state: taskVisualState(task.status, task.dependencies, tasks),
      assignee: task.assignee ?? '',
      dependencies: task.dependencies,
      depth: depths.get(task.id) ?? 0,
    })),
    messageCount: captainInbox.length
      + members.reduce((count, member) => count + member.unread, 0),
    captainInbox: captainInbox.slice(-5).map((message) => ({
      from: message.from,
      content: message.content,
    })),
  }
}

/**
 * Collect every team under the given workspace state roots.
 * @param ctx - the plugin context.
 * @param roots - `{ workspace, stateRoot }` pairs (resolved absolute roots).
 * @returns the snapshots in stable order (workspace, then team id).
 */
export async function collectTeamsActivity(
  ctx: Context,
  roots: readonly { workspace: string; stateRoot: string }[],
): Promise<TeamActivitySnapshot[]> {
  const snapshots: TeamActivitySnapshot[] = []
  for (const root of roots) {
    let entries
    try {
      entries = await readdir(root.stateRoot, { withFileTypes: true })
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const state = await readTeam(root.stateRoot, entry.name)
        if (state === undefined) continue
        snapshots.push(await assembleTeamSnapshot(ctx, root.stateRoot, root.workspace, state))
      } catch {
        ctx.logger.warn(`expert-teams: skipped unreadable team state "${entry.name}" in workspace "${root.workspace}"`)
      }
    }
  }
  return snapshots
}

/**
 * Collect every archived team under the given workspace state roots (the
 * `archive/` subdirectory of each state root). Used by the historic panel
 * path to restore full team detail after deletion.
 * @param ctx - the plugin context.
 * @param roots - `{ workspace, stateRoot }` pairs.
 * @returns the archived snapshots in stable order.
 */
export async function collectArchivedTeamsActivity(
  ctx: Context,
  roots: readonly { workspace: string; stateRoot: string }[],
): Promise<TeamActivitySnapshot[]> {
  const snapshots: TeamActivitySnapshot[] = []
  for (const root of roots) {
    for (const teamId of await listArchivedTeamIds(root.stateRoot)) {
      try {
        const state = await readArchivedTeam(root.stateRoot, teamId)
        if (state === undefined) continue
        snapshots.push(await assembleTeamSnapshot(
          ctx,
          join(root.stateRoot, 'archive'),
          root.workspace,
          state,
          { includeRemoved: true, historic: true },
        ))
      } catch {
        ctx.logger.warn(`expert-teams: skipped unreadable archived team "${teamId}" in workspace "${root.workspace}"`)
      }
    }
  }
  return snapshots
}
