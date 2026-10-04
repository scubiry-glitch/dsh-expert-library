/** Versioned, JSON-safe wire contract for the Expert Teams web surface. */
import type { StagedPlan, TeamState } from './types.ts'
import type { QualityRun, TaskEvidence } from './quality-run.ts'

export const TEAM_WIRE_VERSION = 1 as const
export type JsonScalar = string | number | boolean | null
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue }

export interface TeamWireMember {
  readonly id: string; readonly name: string; readonly role: string; readonly status: string; readonly attemptId?: string
  readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string
}
export interface TeamWireTask {
  readonly id: string; readonly subject: string; readonly description?: string; readonly status: string
  readonly assignee?: string; readonly dependencies: readonly string[]; readonly attempt?: number
  readonly attemptId?: string; readonly qualityScore?: number | null; readonly repairCount?: number
  readonly acceptance?: readonly { readonly id: string; readonly statement: string; readonly passed?: boolean }[]
}
export interface TeamWireFinding {
  readonly id: string; readonly code: string; readonly severity: string; readonly message: string
  readonly taskId: string; readonly attempt: number; readonly path?: string
}
export interface TeamWireQualityRun {
  readonly taskId: string; readonly runId: string; readonly status: string; readonly attempt: number
  readonly reviewRounds: number; readonly repairRounds: number; readonly lastVerdict?: string
  readonly findings: readonly TeamWireFinding[]
  readonly evidence: { readonly artifactCount: number; readonly acceptanceCount: number; readonly commandCount: number; readonly changedPaths: readonly string[] }
}
export interface TeamWire {
  readonly id: string; readonly name: string; readonly description?: string; readonly captainSessionId: string
  readonly halted: boolean; readonly haltReason?: string; readonly members: readonly TeamWireMember[]
  readonly tasks: readonly TeamWireTask[]; readonly qualityRuns: readonly TeamWireQualityRun[]
  readonly archive: { readonly archived: boolean; readonly archivedAt?: number }
}
export interface PlanWire {
  readonly planId: string; readonly digest: string; readonly revision: number; readonly status: string
  readonly createdAt: number; readonly updatedAt: number; readonly expiresAt: number
  readonly request: Readonly<Record<string, JsonValue | undefined>>
  readonly runtime: { readonly teamName: string; readonly description: string }
  /** Parsed compiler preview; retained alongside request for UI review. */
  readonly preview: {
    readonly members: readonly {
      readonly slotId: string; readonly expertId: string; readonly sourceExpertId?: string
      readonly profileId?: string; readonly role?: string; readonly routeSource?: string; readonly routeFallbackIndex?: number; readonly route?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
    }[]
    readonly tasks: readonly {
      readonly id: string; readonly role: string; readonly expertIds: readonly string[]; readonly dependsOn: readonly string[]
      readonly subject?: string; readonly description?: string
      readonly reportCraft?: {
        readonly selections: readonly { readonly packId: string; readonly skillId: string; readonly variant?: string; readonly reason: string }[]
        readonly artifactRoles: readonly string[]
        readonly reviewAreas: readonly { readonly id: string; readonly description: string }[]
      }
      readonly acceptance: readonly { readonly id: string; readonly statement: string }[]
    }[]
    readonly executionOrder: readonly string[]
  }
  readonly waitingFor?: string
  readonly approval?: NonNullable<StagedPlan['approval']>
  readonly appliedTeamId?: string; readonly failureReason?: string
}
export interface TeamWireResponse { readonly version: 1; readonly team: TeamWire | null; readonly plan?: PlanWire | null; readonly archived: boolean }
export type TeamAction = 'edit' | 'approve' | 'discard' | 'halt' | 'resume' | 'archive'

function json(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > 5 || value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) return value.slice(0, 200).map(item => json(item, depth + 1)).filter((item): item is JsonValue => item !== undefined)
  if (typeof value === 'object') {
    const output: { [key: string]: JsonValue } = {}
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      const safe = json(item, depth + 1); if (safe !== undefined) output[key] = safe
    }
    return output
  }
  return undefined
}

function evidenceSummary(evidence: TaskEvidence | undefined) {
  return { artifactCount: evidence?.artifacts.length ?? 0, acceptanceCount: evidence?.acceptanceResults.length ?? 0, commandCount: evidence?.commandsRun.length ?? 0, changedPaths: [...(evidence?.changedPaths ?? [])].slice(0, 100) }
}

function qualityWire(run: QualityRun, taskId: string): TeamWireQualityRun {
  return { taskId, runId: run.runId, status: run.status, attempt: run.attempt, reviewRounds: run.reviewRounds, repairRounds: run.repairRounds, ...(run.lastVerdict === undefined ? {} : { lastVerdict: run.lastVerdict }), findings: run.findings.map(f => ({ id: f.id, code: f.code, severity: f.severity, message: f.message, taskId: f.taskId, attempt: f.attempt, ...(f.path === undefined ? {} : { path: f.path }) })), evidence: evidenceSummary(run.latestEvidence) }
}

export function teamToWire(team: TeamState, archived = false, archivedAt?: number): TeamWire {
  const qualityRuns = Object.entries(team.qualityRuns ?? (team.qualityRun === undefined ? {} : { [team.qualityRun.contract.taskId]: team.qualityRun }))
    .map(([taskId, run]) => qualityWire(run, taskId))
  return { id: team.id, name: team.name, ...(team.description === undefined ? {} : { description: team.description }), captainSessionId: team.captainSessionId, halted: team.halted === true, ...(team.haltReason === undefined ? {} : { haltReason: team.haltReason }), members: team.members.map(m => { const activeTask = team.tasks.find(task => task.assignee === m.name && task.attemptId !== undefined && task.status === 'in_progress'); return { id: m.id, name: m.name, role: m.role ?? '', status: m.status, ...(activeTask?.attemptId === undefined ? {} : { attemptId: activeTask.attemptId }), ...(m.provider === undefined ? {} : { provider: m.provider }), ...(m.model === undefined ? {} : { model: m.model }), ...(m.reasoningEffort === undefined ? {} : { reasoningEffort: m.reasoningEffort }) } }), tasks: team.tasks.map(t => { const run = team.qualityRuns?.[t.id] ?? (team.qualityRun?.contract.taskId === t.id ? team.qualityRun : undefined); const results = new Map((run?.latestEvidence?.acceptanceResults ?? []).map(item => [item.id, item.passed])); return { id: t.id, subject: t.subject, ...(t.description === undefined ? {} : { description: t.description }), status: t.status, ...(t.assignee === undefined ? {} : { assignee: t.assignee }), dependencies: [...t.dependencies], ...(t.attempt === undefined ? {} : { attempt: t.attempt }), ...(t.attemptId === undefined ? {} : { attemptId: t.attemptId }), ...(t.qualityScore === undefined ? {} : { qualityScore: t.qualityScore }), ...(t.repairCount === undefined ? {} : { repairCount: t.repairCount }), ...(run === undefined ? {} : { acceptance: run.contract.acceptance.map(item => ({ id: item.id, statement: item.statement, ...(results.has(item.id) ? { passed: results.get(item.id) } : {}) })) }) } }), qualityRuns, archive: { archived, ...(archivedAt === undefined ? {} : { archivedAt }) } }
}

const EDITABLE = new Set(['team_name', 'goal', 'data', 'city', 'period', 'profile', 'tasks', 'report_bundle', 'compiled_source'])
export function planToWire(plan: StagedPlan): PlanWire {
  const request: Record<string, JsonValue | undefined> = {}
  for (const [key, value] of Object.entries(plan.request)) if (EDITABLE.has(key)) request[key] = json(value)
  const gates = plan.plan.gates
  const acceptanceFor = (taskId: string) => gates.filter(gate => gate.appliesTo.includes(taskId)).map(gate => ({ id: gate.id, statement: gate.implementation ?? gate.gateId }))
  return {
    planId: plan.planId, digest: plan.digest, revision: plan.revision, status: plan.status,
    createdAt: plan.createdAt, updatedAt: plan.updatedAt, expiresAt: plan.expiresAt, request,
    runtime: { teamName: plan.runtime.teamName, description: plan.runtime.description },
    preview: {
      members: plan.plan.roster.map(member => ({
        slotId: member.slotId, expertId: member.expertId,
        ...(member.sourceExpertId === undefined ? {} : { sourceExpertId: member.sourceExpertId }),
        ...(member.profileId === undefined ? {} : { profileId: member.profileId }),
        ...(member.role === undefined ? {} : { role: member.role }),
        ...(member.modelPolicy === undefined ? {} : { route: { ...member.modelPolicy } }),
        ...(member.modelRouteSource === undefined ? {} : { routeSource: member.modelRouteSource }),
        ...(member.modelRouteFallbackIndex === undefined ? {} : { routeFallbackIndex: member.modelRouteFallbackIndex }),
      })),
      tasks: plan.plan.tasks.map(task => ({
        id: task.id, role: task.role, expertIds: [...task.expertIds], dependsOn: [...task.dependsOn],
        ...(task.subject === undefined ? {} : { subject: task.subject }),
        ...(task.description === undefined ? {} : { description: task.description }),
        ...(task.frozenSkillCraftContract === undefined ? {} : { reportCraft: {
          selections: task.frozenSkillCraftContract.selections.map(({ packId, skillId, variant, reason }) => ({ packId, skillId, ...(variant === undefined ? {} : { variant }), reason })),
          artifactRoles: [...task.frozenSkillCraftContract.artifactRoles],
          reviewAreas: task.frozenSkillCraftContract.reviewAreas.map(area => ({ ...area })),
        } }),
        acceptance: [...acceptanceFor(task.id), ...(task.acceptance ?? []).map((statement, index) => ({ id: `profile-acceptance-${index + 1}`, statement }))],
      })),
      executionOrder: [...plan.plan.executionOrder],
    },
    ...(plan.waitingFor === undefined ? {} : { waitingFor: plan.waitingFor }),
    ...(plan.approval === undefined ? {} : { approval: { ...plan.approval } }),
    ...(plan.appliedTeamId === undefined ? {} : { appliedTeamId: plan.appliedTeamId }),
    ...(plan.failureReason === undefined ? {} : { failureReason: plan.failureReason }),
  }
}
