/// <reference types="node" />
/** Versioned Expert Teams wire client.
 *
 * The activity panel deliberately keeps this transport separate from its view
 * model: snapshots can be stale or incomplete while a host restarts, whereas
 * plan mutations must carry the exact plan digest/revision observed by the
 * user. Every mutation therefore uses a fresh GET immediately before POST and
 * surfaces CAS/permission errors without optimistic state changes.
 */

export const TEAM_API_URL = '/plugins/dsh-expert-library/teams'

import type {
  PlanWire,
  TeamWire as SharedTeamWire,
  TeamWireFinding as SharedTeamWireFinding,
  TeamWireMember as SharedTeamWireMember,
  TeamWireQualityRun as SharedTeamWireQualityRun,
  TeamWireTask as SharedTeamWireTask,
  TeamWireResponse as SharedTeamWireResponse,
  TeamAction,
} from '../team-wire.ts'
import { manageHeaders } from './manage-client.ts'

export const TEAM_WIRE_VERSION: typeof import('../team-wire.ts').TEAM_WIRE_VERSION = 1

export type TeamWireTaskStatus = SharedTeamWireTask['status']
export type TeamWireAcceptance = NonNullable<SharedTeamWireTask['acceptance']>[number]
export type TeamWireMember = SharedTeamWireMember & { readonly attemptId?: string }
export type TeamWireTask = Omit<SharedTeamWireTask, 'acceptance'> & { readonly acceptance?: readonly (NonNullable<SharedTeamWireTask['acceptance']>[number] & { readonly passed?: boolean })[] }
export type TeamWireFinding = SharedTeamWireFinding
export type TeamWireEvidence = SharedTeamWireQualityRun['evidence']
export type TeamWireQualityRun = SharedTeamWireQualityRun
export type TeamWire = Omit<SharedTeamWire, 'members' | 'tasks'> & { readonly members: readonly TeamWireMember[]; readonly tasks: readonly TeamWireTask[] }
/** PlanWire is the canonical host/client contract. UI helpers below adapt its
 * JSON-safe request record into fields suitable for form controls. */
export type TeamPlanWire = PlanWire
export type TeamModelOption = { readonly provider: string; readonly model: string; readonly name: string; readonly reasoningEffort?: string }

/** Values returned by `planToWire` are JSON-safe and may carry arrays encoded
 * by legacy staged plans as strings. The parser below is intentionally narrow;
 * malformed legacy data stays visible as an empty review instead of becoming
 * an executable client-side object. */
export type TeamPlanMember = {
  readonly id?: string
  readonly name?: string
  readonly role?: string
  readonly provider?: string
  readonly model?: string
  readonly routeSource?: string
  readonly routeFallbackIndex?: number
}

export type TeamPlanTask = {
  readonly produces?: readonly string[]
  readonly humanChoice?: PlanWire['preview']['tasks'][number]['humanChoice']
  readonly artifactInputs?: readonly import('../plan-artifact-flow.ts').PlannedArtifactInput[]
  readonly id?: string
  readonly subject?: string
  readonly description?: string
  readonly assignee?: string
  readonly sourceExpertIds?: readonly string[]
  readonly dependencies?: readonly string[]
  readonly acceptance?: readonly TeamWireAcceptance[]
  readonly reportCraft?: PlanWire['preview']['tasks'][number]['reportCraft']
  readonly taskMaterials?: PlanWire['preview']['tasks'][number]['taskMaterials']
  readonly materialRecipe?: PlanWire['preview']['tasks'][number]['materialRecipe']
}

export interface TeamPlanRequest {
  readonly team_name?: string
  readonly goal?: string
  readonly data?: string
  readonly city?: string
  readonly period?: string
  readonly profile?: string
  readonly tasks?: readonly TeamPlanTask[]
}

export interface TeamPlanRuntime {
  readonly teamName: string
  readonly description?: string
}

export type TeamWireEnvelope = SharedTeamWireResponse & { readonly plan?: TeamPlanWire | null }

export interface TeamWireError {
  readonly code: string
  readonly message: string
}

export interface TeamWireMutationResponse {
  readonly version: typeof TEAM_WIRE_VERSION
  readonly ok: boolean
  readonly team?: TeamWire | null
  readonly plan?: TeamPlanWire | null
  readonly archived?: boolean
  readonly receipt?: unknown
  readonly error?: TeamWireError
}

export interface TeamWireQuery {
  readonly captainSessionId: string
  readonly teamId?: string
  readonly planId?: string
  readonly archived?: boolean
  readonly signal?: AbortSignal
}

export interface TeamWireMutation {
  readonly action: TeamAction
  readonly captainSessionId: string
  readonly teamId?: string
  readonly planId?: string
  readonly expectedDigest?: string
  readonly expectedRevision?: number
  readonly patch?: Record<string, unknown>
  readonly reason?: string
  readonly taskId?: string
  readonly choice?: string
  readonly expectedSha256?: string
  readonly signal?: AbortSignal
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEncoded(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 256 * 1024) return value
  try { return JSON.parse(value) as unknown } catch { return value }
}

export function planRequest(plan: TeamPlanWire | null | undefined): TeamPlanRequest {
  const raw = record(plan?.request) ? plan?.request as Record<string, unknown> : {}
  const tasks = parseEncoded(raw.tasks)
  return {
    ...(typeof raw.team_name === 'string' ? { team_name: raw.team_name } : {}),
    ...(typeof raw.goal === 'string' ? { goal: raw.goal } : {}),
    ...(typeof raw.data === 'string' ? { data: raw.data } : {}),
    ...(typeof raw.city === 'string' ? { city: raw.city } : {}),
    ...(typeof raw.period === 'string' ? { period: raw.period } : {}),
    ...(typeof raw.profile === 'string' ? { profile: raw.profile } : {}),
    ...(Array.isArray(tasks) ? { tasks: tasks as readonly TeamPlanTask[] } : {}),
  }
}

export function normalizePlan(plan: TeamPlanWire): TeamPlanWire {
  const request = planRequest(plan)
  // Keep every canonical request key (including future keys), while replacing
  // the legacy JSON-string task field with its parsed array when safe.
  const rawRequest = record(plan.request) ? plan.request : {}
  return { ...plan, request: { ...rawRequest, ...(request.tasks === undefined ? {} : { tasks: request.tasks }) } as PlanWire['request'] }
}

export function planTaskPreview(plan: TeamPlanWire | null | undefined): readonly TeamPlanTask[] {
  if (plan === null || plan === undefined) return []
  const expertBySlot = new Map((plan.preview?.members ?? []).map(member => [member.slotId, member.sourceExpertId ?? member.expertId]))
  if (plan.preview?.tasks !== undefined && plan.preview.tasks.length > 0) return plan.preview.tasks.map((task) => ({
    id: task.id, subject: task.subject, description: task.description,
    assignee: task.expertIds.length > 0 ? task.expertIds.join('、') : task.role === 'captain' ? '队长' : undefined,
    sourceExpertIds: task.expertIds.map(id => expertBySlot.get(id) ?? id),
    dependencies: task.dependsOn, acceptance: task.acceptance, reportCraft: task.reportCraft, taskMaterials: task.taskMaterials, materialRecipe: task.materialRecipe, produces: task.produces, artifactInputs: task.artifactInputs, humanChoice: task.humanChoice,
  }))
  return planRequest(plan).tasks ?? []
}

export function planMemberPreview(plan: TeamPlanWire | null | undefined): readonly TeamPlanMember[] {
  if (plan?.preview?.members !== undefined && plan.preview.members.length > 0) return plan.preview.members.map((member) => ({
    id: member.slotId, name: member.sourceExpertId ?? member.expertId, role: member.role,
    provider: member.route?.provider, model: member.route?.model, routeSource: member.routeSource, routeFallbackIndex: member.routeFallbackIndex,
  }))
  const tasks = planTaskPreview(plan)
  const byName = new Map<string, TeamPlanMember>()
  for (const task of tasks) if (task.assignee !== undefined && task.assignee !== '') byName.set(task.assignee, { name: task.assignee })
  return [...byName.values()]
}

async function parseJson<T>(response: Response): Promise<T | undefined> {
  try { return await response.json() as T } catch { return undefined }
}

function queryString(query: TeamWireQuery): string {
  const params = new URLSearchParams({ captainSessionId: query.captainSessionId })
  if (query.teamId !== undefined && query.teamId !== '') params.set('teamId', query.teamId)
  if (query.planId !== undefined && query.planId !== '') params.set('planId', query.planId)
  if (query.archived === true) params.set('archived', '1')
  return params.toString()
}

export async function fetchTeamWire(query: TeamWireQuery): Promise<TeamWireEnvelope> {
  const response = await fetch(`${TEAM_API_URL}?${queryString(query)}`, {
    cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
    referrerPolicy: 'same-origin', headers: manageHeaders({ accept: 'application/json' }), signal: query.signal,
  })
  const body = await parseJson<Partial<TeamWireEnvelope> & { error?: TeamWireError }>(response)
  if (!response.ok) {
    throw new TeamWireRequestError(body?.error?.code ?? `HTTP_${response.status}`, body?.error?.message ?? `团队状态读取失败（${response.status}）`, response.status)
  }
  if (body?.version !== TEAM_WIRE_VERSION || !('team' in (body ?? {}))) {
    throw new TeamWireRequestError('TEAM_WIRE_INVALID', '团队状态协议版本不兼容', response.status)
  }
  const envelope = body as TeamWireEnvelope
  return envelope.plan === undefined || envelope.plan === null ? envelope : { ...envelope, plan: normalizePlan(envelope.plan) }
}

export async function fetchTeamModelCatalog(captainSessionId: string, planId: string, signal?: AbortSignal): Promise<readonly TeamModelOption[]> {
  const params = new URLSearchParams({ captainSessionId, planId, models: '1' })
  const response = await fetch(`${TEAM_API_URL}?${params}`, {
    cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
    referrerPolicy: 'same-origin', headers: manageHeaders({ accept: 'application/json' }), signal,
  })
  const body = await parseJson<{ version?: number; models?: TeamModelOption[]; error?: TeamWireError }>(response)
  if (!response.ok || body?.version !== TEAM_WIRE_VERSION || !Array.isArray(body.models)) {
    throw new TeamWireRequestError(body?.error?.code ?? `HTTP_${response.status}`, '模型目录读取失败', response.status)
  }
  return body.models
}

export async function mutateTeam(request: TeamWireMutation): Promise<TeamWireMutationResponse> {
  const body: Record<string, unknown> = {
    action: request.action,
    captainSessionId: request.captainSessionId,
  }
  for (const key of ['teamId', 'planId', 'expectedDigest', 'expectedRevision', 'patch', 'reason', 'taskId', 'choice', 'expectedSha256'] as const) {
    const value = request[key]
    if (value !== undefined) body[key] = value
  }
  const response = await fetch(TEAM_API_URL, {
    method: 'POST',
    cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', referrerPolicy: 'same-origin',
    headers: manageHeaders({ accept: 'application/json', 'content-type': 'application/json' }),
    body: JSON.stringify(body),
    signal: request.signal,
  })
  const parsed = await parseJson<TeamWireMutationResponse>(response)
  if (parsed?.version !== TEAM_WIRE_VERSION || parsed.ok !== true) {
    const error = parsed?.error
    throw new TeamWireRequestError(error?.code ?? `HTTP_${response.status}`, error?.message ?? '团队操作失败', response.status)
  }
  return parsed?.plan === undefined || parsed.plan === null ? parsed : { ...parsed, plan: normalizePlan(parsed.plan) }
}

export class TeamWireRequestError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 0) {
    const help: Record<string, string> = {
      PLAN_CAPTAIN_MODEL_SWITCH_REQUIRED: '队长实际模型与计划不同。请在会话模型选择器切换后刷新，再确认本计划。',
      PLAN_MODEL_UNAVAILABLE: '所选模型或推理强度不可用。请修改配置并重新保存。',
      PLAN_MODELS_INVALID: '模型配置不完整。请填写提供方、模型和有效的推理强度。',
      PLAN_ARTIFACT_INPUTS_REQUIRED: '报告任务需要声明输入。请在任务配置中填写 artifactInputs；独立任务填写空数组，并为依赖注明所需产物和用途。',
      PLAN_ARTIFACT_CYCLE: '产物或验收条件形成循环依赖。请调整交付归属和依赖顺序后再保存。',
      PLAN_DEPENDENCY_UNJUSTIFIED: '任务依赖缺少所需产物及用途。请补齐输入声明，或移除不必要的依赖。',
      TEAM_CAS_CONFLICT: '计划已被更新。请刷新并审阅最新版本后再操作。',
    }
    super(help[code] ?? (code.startsWith('PLAN_OUTLINE_') || code === 'PLAN_REVIEW_INVALID' ? '大纲不完整。每章需要标题、核心问题、所需证据和负责的任务；报告生成任务也必须关联章节。' : message))
    this.name = 'TeamWireRequestError'
    this.code = code
    this.status = status
  }
}
