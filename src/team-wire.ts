/** Versioned, JSON-safe wire contract for the Expert Teams web surface. */
import type { StagedPlan, TeamState } from './types.ts'
import type { QualityRun, TaskEvidence } from './quality-run.ts'
import { zhijianMetaById } from './zhijian/registry.ts'
import { matchExperts } from './zhijian/capability.ts'
import { DEEP_RESEARCH_SUBDAGS, DEEP_RESEARCH_MATERIAL_CHOICES } from './deep-research-selection.ts'

export const TEAM_WIRE_VERSION = 1 as const
export type JsonScalar = string | number | boolean | null
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue }

export interface TeamWireMember {
  readonly id: string; readonly name: string; readonly role: string; readonly status: string; readonly attemptId?: string
  readonly expertId?: string
  readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string
}
export interface TeamWireTask {
  readonly scheduling?: import('./types.ts').TeamTask['scheduling']
  readonly reviewedBundle?: import('./research-release.ts').ResearchRelease
  readonly executionState?: string
  readonly waitReason?: string

  readonly id: string; readonly subject: string; readonly description?: string; readonly status: string
  readonly assignee?: string; readonly dependencies: readonly string[]; readonly attempt?: number
  readonly attemptId?: string; readonly qualityScore?: number | null; readonly repairCount?: number
  readonly humanChoice?: { readonly options: readonly string[]; readonly artifact: string; readonly sourceTaskId: string; readonly multiple?: boolean; readonly sha256?: string; readonly content?: string; readonly blockedReason?: string; readonly receipt?: import('./types.ts').TeamTask['humanChoiceReceipt'] }
  readonly acceptance?: readonly { readonly id: string; readonly statement: string; readonly passed?: boolean }[]
  readonly taskMaterials?: { readonly skills: readonly { readonly packId: string; readonly skillId: string; readonly sha256: string; readonly packVersion?: string }[]; readonly prompt: { readonly templateId: string; readonly sha256: string }; readonly digest: string }
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
    readonly workflowVersion?: { readonly version: string; readonly label: string }

    readonly subDags?: readonly { readonly id: string; readonly version: string; readonly expertCount: number; readonly description: string; readonly selected: boolean }[]
    readonly expertSelection?: { readonly topic: string; readonly question: string; readonly routeFramework: string; readonly selectedIds: readonly string[]; readonly candidates: readonly { readonly id: string; readonly name: string; readonly field: string; readonly stance: string; readonly summary: string; readonly reason: string; readonly recommendedRole: string; readonly selected: boolean }[] }
    readonly analysisFramework?: { readonly id: string; readonly question: string; readonly axes: readonly string[]; readonly hypotheses: readonly string[]; readonly falsifiers: readonly string[] }
    readonly recommendation?: { readonly source: string; readonly reason: string; readonly model: string; readonly estimatedTaskStarts: number; readonly maxRepairRoundsPerTask: number; readonly modelCallTokens?: { readonly input: number; readonly output: number } }
    readonly reportOutline?: import('./plan-review.ts').ReportOutline
    readonly captainModel?: import('./plan-review.ts').PlanModelRoute
    readonly members: readonly {
      readonly slotId: string; readonly expertId: string; readonly sourceExpertId?: string
      readonly profileId?: string; readonly role?: string; readonly routeSource?: string; readonly routeFallbackIndex?: number; readonly route?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
    }[]
    readonly tasks: readonly {
      readonly id: string; readonly role: string; readonly expertIds: readonly string[]; readonly dependsOn: readonly string[]
      readonly subject?: string; readonly description?: string
      readonly produces?: readonly string[]
      readonly humanChoice?: { readonly sourceTaskId: string; readonly artifact: string; readonly options: readonly string[] }
      readonly artifactInputs?: readonly import('./plan-artifact-flow.ts').PlannedArtifactInput[]
      readonly reportCraft?: {
        readonly selections: readonly { readonly packId: string; readonly skillId: string; readonly variant?: string; readonly reason: string }[]
        readonly artifactRoles: readonly string[]
        readonly reviewAreas: readonly { readonly id: string; readonly description: string }[]
      }
      readonly taskMaterials?: { readonly skills: readonly { readonly packId: string; readonly skillId: string; readonly sha256: string; readonly packVersion?: string }[]; readonly prompt: { readonly templateId: string; readonly sha256: string }; readonly digest: string }
      readonly materialRecipe?: { readonly selected: 'core' | 'strategy'; readonly choices: readonly { readonly id: 'core' | 'strategy'; readonly label: string }[] }
      readonly acceptance: readonly { readonly id: string; readonly statement: string }[]
    }[]
    readonly executionOrder: readonly string[]
  }
  readonly waitingFor?: string
  readonly approval?: NonNullable<StagedPlan['approval']>
  readonly appliedTeamId?: string; readonly failureReason?: string
}
export interface TeamWireResponse { readonly version: 1; readonly team: TeamWire | null; readonly plan?: PlanWire | null; readonly archived: boolean }
export type TeamAction = 'edit' | 'recommend' | 'approve' | 'discard' | 'halt' | 'resume' | 'archive' | 'choose' | 'task-pause' | 'task-start' | 'task-recover'

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
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }

function evidenceSummary(evidence: TaskEvidence | undefined) {
  return { artifactCount: evidence?.artifacts.length ?? 0, acceptanceCount: evidence?.acceptanceResults.length ?? 0, commandCount: evidence?.commandsRun.length ?? 0, changedPaths: [...(evidence?.changedPaths ?? [])].slice(0, 100) }
}

function qualityWire(run: QualityRun, taskId: string): TeamWireQualityRun {
  return { taskId, runId: run.runId, status: run.status, attempt: run.attempt, reviewRounds: run.reviewRounds, repairRounds: run.repairRounds, ...(run.lastVerdict === undefined ? {} : { lastVerdict: run.lastVerdict }), findings: run.findings.map(f => ({ id: f.id, code: f.code, severity: f.severity, message: f.message, taskId: f.taskId, attempt: f.attempt, ...(f.path === undefined ? {} : { path: f.path }) })), evidence: evidenceSummary(run.latestEvidence) }
}

export function teamToWire(team: TeamState, archived = false, archivedAt?: number): TeamWire {
  const qualityRuns = Object.entries(team.qualityRuns ?? (team.qualityRun === undefined ? {} : { [team.qualityRun.contract.taskId]: team.qualityRun }))
    .map(([taskId, run]) => qualityWire(run, taskId))
  return { id: team.id, name: team.name, ...(team.description === undefined ? {} : { description: team.description }), captainSessionId: team.captainSessionId, halted: team.halted === true, ...(team.haltReason === undefined ? {} : { haltReason: team.haltReason }), members: team.members.map(m => { const activeTask = team.tasks.find(task => task.assignee === m.name && task.attemptId !== undefined && task.status === 'in_progress'); return { id: m.id, name: m.name, role: m.role ?? '', status: m.status, ...(m.capabilityScope?.expertId === undefined ? {} : { expertId: m.capabilityScope.expertId }), ...(activeTask?.attemptId === undefined ? {} : { attemptId: activeTask.attemptId }), ...(m.provider === undefined ? {} : { provider: m.provider }), ...(m.model === undefined ? {} : { model: m.model }), ...(m.reasoningEffort === undefined ? {} : { reasoningEffort: m.reasoningEffort }) } }), tasks: team.tasks.map(t => { const run = team.qualityRuns?.[t.id] ?? (team.qualityRun?.contract.taskId === t.id ? team.qualityRun : undefined); const results = new Map((run?.latestEvidence?.acceptanceResults ?? []).map(item => [item.id, item.passed])); return { ...(t.scheduling ? { scheduling: { ...t.scheduling } } : {}), ...(t.researchRelease ? { reviewedBundle: structuredClone(t.researchRelease) } : {}), ...(t.executionState ? { executionState: t.executionState } : {}), ...(t.waitReason ? { waitReason: t.waitReason } : {}), id: t.id, subject: t.subject, ...(t.description === undefined ? {} : { description: t.description }), status: t.status, ...(t.assignee === undefined ? {} : { assignee: t.assignee }), ...(t.frozenTaskMaterialContract === undefined ? {} : { taskMaterials: { skills: t.frozenTaskMaterialContract.skills.map(({ packId, skillId, sha256, packVersion }) => ({ packId, skillId, sha256, ...(packVersion === undefined ? {} : { packVersion }) })), prompt: { templateId: t.frozenTaskMaterialContract.prompt.templateId, sha256: t.frozenTaskMaterialContract.prompt.sha256 }, digest: t.frozenTaskMaterialContract.digest } }), dependencies: [...t.dependencies], ...(t.humanChoice === undefined ? {} : { humanChoice: { options: [...t.humanChoice.options], artifact: t.humanChoice.artifact, sourceTaskId: t.humanChoice.sourceTaskId, ...(t.humanChoiceReceipt === undefined ? {} : { receipt: { ...t.humanChoiceReceipt } }) } }), ...(t.attempt === undefined ? {} : { attempt: t.attempt }), ...(t.attemptId === undefined ? {} : { attemptId: t.attemptId }), ...(t.qualityScore === undefined ? {} : { qualityScore: t.qualityScore }), ...(t.repairCount === undefined ? {} : { repairCount: t.repairCount }), ...(run === undefined ? {} : { acceptance: run.contract.acceptance.map(item => ({ id: item.id, statement: item.statement, ...(results.has(item.id) ? { passed: results.get(item.id) } : {}) })) }) } }), qualityRuns, archive: { archived, ...(archivedAt === undefined ? {} : { archivedAt }) } }
}

const EDITABLE = new Set(['team_name', 'goal', 'data', 'city', 'period', 'profile', 'tasks', 'report_bundle', 'report_outline', 'plan_models', 'compiled_source'])
export function planToWire(plan: StagedPlan): PlanWire {
  const request: Record<string, JsonValue | undefined> = {}
  for (const [key, value] of Object.entries(plan.request)) if (EDITABLE.has(key)) request[key] = json(value)
  const gates = plan.plan.gates
  const acceptanceFor = (taskId: string) => gates.filter(gate => gate.appliesTo.includes(taskId)).map(gate => ({ id: gate.id, statement: gate.implementation ?? gate.gateId }))
  const routeInput = plan.plan.params['expertSelection']
  const selected = record(routeInput) && typeof routeInput.topic === 'string' && typeof routeInput.question === 'string'
    && typeof routeInput.routeFramework === 'string' && strings(routeInput.candidateIds) && strings(routeInput.selectedIds)
    ? routeInput as { topic: string; question: string; routeFramework: string; candidateIds: string[]; selectedIds: string[] } : undefined
  const frameworkInput = plan.plan.params['analysisFramework']
  const framework = record(frameworkInput) && typeof frameworkInput.id === 'string' && typeof frameworkInput.question === 'string'
    && strings(frameworkInput.axes) && strings(frameworkInput.hypotheses) && strings(frameworkInput.falsifiers)
    ? frameworkInput as unknown as PlanWire['preview']['analysisFramework'] : undefined
  const matches = selected === undefined ? [] : matchExperts(selected.topic, selected.question, { limit: 5 })
  let recommendation: PlanWire['preview']['recommendation']
  try {
    const raw: unknown = JSON.parse(plan.request.research_recommendation ?? 'null')
    if (record(raw) && raw.source === 'host-model-recommendation' && typeof raw.reason === 'string'
      && typeof raw.model === 'string' && Number.isSafeInteger(raw.estimatedTaskStarts)
      && Number.isSafeInteger(raw.maxRepairRoundsPerTask)) recommendation = raw as unknown as NonNullable<typeof recommendation>
  } catch { /* A missing historical recommendation is normal. */ }
  return {
    planId: plan.planId, digest: plan.digest, revision: plan.revision, status: plan.status,
    createdAt: plan.createdAt, updatedAt: plan.updatedAt, expiresAt: plan.expiresAt, request,
    runtime: { teamName: plan.runtime.teamName, description: plan.runtime.description },
    preview: {
      ...(plan.plan.scenario?.id === '98wiki-deep-research' ? { workflowVersion:{version:plan.plan.template.version,label:plan.plan.template.version === '5.0.0' ? '观点驱动研究 V5' : plan.plan.template.version === '4.0.0' ? '精简研究 v4（新版本）' : `原版研究 ${plan.plan.template.version}`} } : {}),
      ...(plan.plan.scenario?.id === '98wiki-deep-research' && /^3\./u.test(plan.plan.template.version) && selected !== undefined ? { subDags: DEEP_RESEARCH_SUBDAGS.map(item => ({ ...item, selected: item.expertCount === selected.selectedIds.length })) } : {}),
      ...(selected === undefined ? {} : { expertSelection: { topic: selected.topic, question: selected.question, routeFramework: selected.routeFramework, selectedIds: [...selected.selectedIds],
        candidates: selected.candidateIds.map(id => { const meta = zhijianMetaById(id); const candidate = matches.find(item => item.id === id); const member = plan.plan.roster.find(item => item.sourceExpertId === id); return { id, name: meta?.personaName ?? id,
          field: meta?.field ?? '', stance: meta?.stance ?? '', summary: meta?.summary ?? '',
          reason: candidate?.reason ?? meta?.summary ?? '', recommendedRole: member?.role ?? `${meta?.field ?? '领域'}候选视角`,
          selected: selected.selectedIds.includes(id) } }),
      } }),
      ...(framework === undefined ? {} : { analysisFramework: structuredClone(framework) }),
      ...(recommendation === undefined ? {} : { recommendation }),
      ...(plan.plan.reportOutline === undefined ? {} : { reportOutline: structuredClone(plan.plan.reportOutline) }),
      ...(plan.plan.captainModel === undefined ? {} : { captainModel: { ...plan.plan.captainModel } }),
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
        ...(task.produces === undefined ? {} : { produces: [...task.produces] }),
        ...(task.humanChoice === undefined ? {} : { humanChoice: structuredClone(task.humanChoice) }),
        ...(task.artifactInputs === undefined ? {} : { artifactInputs: structuredClone(task.artifactInputs) }),
        ...(task.frozenSkillCraftContract === undefined ? {} : { reportCraft: {
          selections: task.frozenSkillCraftContract.selections.map(({ packId, skillId, variant, reason }) => ({ packId, skillId, ...(variant === undefined ? {} : { variant }), reason })),
          artifactRoles: [...task.frozenSkillCraftContract.artifactRoles],
          reviewAreas: task.frozenSkillCraftContract.reviewAreas.map(area => ({ ...area })),
        } }),
        ...(task.frozenTaskMaterialContract === undefined ? {} : { taskMaterials: {
          skills: task.frozenTaskMaterialContract.skills.map(({ packId, skillId, sha256, packVersion }) => ({ packId, skillId, sha256, ...(packVersion === undefined ? {} : { packVersion }) })),
          prompt: { templateId: task.frozenTaskMaterialContract.prompt.templateId, sha256: task.frozenTaskMaterialContract.prompt.sha256 },
          digest: task.frozenTaskMaterialContract.digest,
        } }),
        ...(plan.plan.scenario?.id === '98wiki-deep-research' && /^3\./u.test(plan.plan.template.version) && DEEP_RESEARCH_MATERIAL_CHOICES.includes(task.id as typeof DEEP_RESEARCH_MATERIAL_CHOICES[number])
          ? { materialRecipe: { selected: task.frozenTaskMaterialContract?.skills.some(skill => skill.packId === 'dsh-expert-library' && skill.skillId === 'strategy-consulting') ? 'strategy' as const : 'core' as const,
            choices: [{ id: 'core' as const, label: '核心工艺（计划推荐）' }, { id: 'strategy' as const, label: '核心工艺 + 策略分析 Skill' }] } } : {}),
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
