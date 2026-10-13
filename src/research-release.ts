/** Versioned reviewed bundles. Only the compact v4 profile opts into Host advancement. */
import { canonicalDigest } from './v2/digest.ts'
import type { TeamState, TeamTask, TaskInputManifest } from './types.ts'
import type { QualityRun } from './quality-run.ts'

export const COMPACT_RESEARCH_VERSION = '4.0.0'
export function isCompactResearch(team: TeamState): boolean {
  return team.planRef?.scenarioId === '98wiki-deep-research' && [COMPACT_RESEARCH_VERSION, '5.0.0'].includes(team.planRef.templateVersion)
}
export function isResearchV5(team: TeamState): boolean { return team.planRef?.scenarioId === '98wiki-deep-research' && team.planRef.templateVersion === '5.0.0' }
export function isV5WorkingTask(team: TeamState, task: TeamTask): boolean {
  return isResearchV5(team) && task.humanChoice === undefined && /^(expert_view_.+|research_.+|viewpoints|expression)$/u.test(task.planTask?.logicalId ?? '')
}
export interface WorkingRelease {
  schemaVersion: 2; kind: 'working-material'; taskId: string; attempt: number;
  artifacts: { id: string; reviewId: string; sha256: string; relativePath: string }[];
  inputs: TaskInputManifest[]; digest: string;
}
export type ResearchRelease = ReviewedRelease | WorkingRelease
export function workingRelease(task: TeamTask): WorkingRelease {
  const required = task.declaredPublications?.map(name => `published:${name}`) ?? []
  const latest = new Map((task.publishedArtifacts ?? []).filter(a => a.attempt === task.attempt).map(a => [a.reviewId!, a]))
  if (!required.length || required.some(id => !latest.has(id))) throw new Error('WORKING_RELEASE_INCOMPLETE')
  // Only the declared deliverables form the release. Independently published
  // calculation logs and other supporting files remain available for audit,
  // but cannot silently expand or invalidate the frozen working contract.
  const artifacts = required.map(id => latest.get(id)!)
    .map(a => ({ id: a.id, reviewId: a.reviewId!, sha256: a.sha256, relativePath: a.relativePath }))
    .sort((a, b) => a.reviewId.localeCompare(b.reviewId))
  const body = {schemaVersion:2 as const,kind:'working-material' as const,taskId:task.id,attempt:task.attempt!,artifacts,inputs:structuredClone(task.inputArtifactManifest??[])}
  return {...body,digest:canonicalDigest(body)}
}
export interface ReviewedRelease {
  schemaVersion: 1
  taskId: string
  attempt: number
  runId: string
  reviewEventId: string
  reviewer: string
  auditDigest: string
  integrationEventId: string
  artifacts: { id: string; reviewId: string; sha256: string; relativePath: string }[]
  inputs: TaskInputManifest[]
  digest: string
}
export function reviewedRelease(task: TeamTask, run: QualityRun): ResearchRelease {
  if (run.status !== 'integrated' || task.attempt !== run.attempt || run.contract.taskId !== task.id) throw new Error('RESEARCH_RELEASE_NOT_INTEGRATED')
  const review = run.events.slice().reverse().find(e => e.type === 'review')
  const integration = run.events.slice().reverse().find(e => e.type === 'integration')
  if (!review || !integration) throw new Error('RESEARCH_RELEASE_RECEIPT_MISSING')
  const latest = new Map((task.publishedArtifacts ?? []).filter(a => a.attempt === task.attempt).map(a => [a.reviewId!, a]))
  const artifacts = [...latest.values()].map(a => {
    const evidence = run.latestEvidence?.artifacts.find(e => e.id === a.reviewId)
    if (!evidence || evidence.sha256 !== a.sha256 || evidence.attempt !== task.attempt || evidence.taskId !== task.id) throw new Error('RESEARCH_RELEASE_EVIDENCE_CHANGED')
    return { id: a.id, reviewId: a.reviewId!, sha256: a.sha256, relativePath: a.relativePath }
  }).sort((a, b) => a.reviewId.localeCompare(b.reviewId))
  if (!artifacts.length) throw new Error('RESEARCH_RELEASE_EMPTY')
  const body = { schemaVersion: 1 as const, taskId: task.id, attempt: task.attempt!, runId: run.runId,
    reviewEventId: review.id, reviewer: review.actor, auditDigest: canonicalDigest(task.researchReviewAudits?.[review.id] ?? ''), integrationEventId: integration.id,
    artifacts, inputs: structuredClone(task.inputArtifactManifest ?? []) }
  return { ...body, digest: canonicalDigest(body) }
}
export function assertResearchRelease(team: TeamState, task: TeamTask): ResearchRelease {
  if (isV5WorkingTask(team,task)) {
    const expected=workingRelease(task)
    if(task.status!=='completed'||canonicalDigest(expected)!==canonicalDigest(task.researchRelease)) throw new Error('WORKING_RELEASE_CHANGED')
    return expected
  }
  const run = team.qualityRuns?.[task.id] ?? team.qualityRun
  if (!run || !task.researchRelease || task.status !== 'completed') throw new Error('RESEARCH_RELEASE_MISSING')
  const expected = reviewedRelease(task, run)
  if (canonicalDigest(expected) !== canonicalDigest(task.researchRelease)) throw new Error('RESEARCH_RELEASE_CHANGED')
  return expected
}
/** Bound at dispatch; a repair of the writer never requires replacing its task ID. */
export function pinResearchReleases(team: TeamState, task: TeamTask): void {
  if (!isCompactResearch(team)) return
  for (const id of task.dependencies) {
    const gate = team.tasks.find(t => t.id === id)
    if (!gate?.humanChoice) continue
    const source = team.tasks.find(t => t.id === gate.humanChoice!.sourceTaskId)
    if (!source || gate.humanChoiceReceipt?.sourceReleaseDigest !== assertResearchRelease(team, source).digest) throw new Error('RESEARCH_USER_APPROVAL_STALE')
  }
  const pins = Object.fromEntries(task.dependencies.map(id => team.tasks.find(t => t.id === id)!)
    .filter(t => t?.humanChoice === undefined).map(t => [t.id, assertResearchRelease(team, t).digest]))
  if (task.researchInputReleases && canonicalDigest(pins) !== canonicalDigest(task.researchInputReleases)) throw new Error('RESEARCH_INPUT_RELEASE_CHANGED')
  task.researchInputReleases = pins
}
/** Pick only independent routed reviewers; the renderer requires the design critic. */
export function compactReviewer(team: TeamState, task: TeamTask): string | undefined {
  if (!isCompactResearch(team)) return undefined
  const candidates = team.members.filter(m => m.status !== 'removed' && m.name !== task.assignee)
  return (task.planTask?.logicalId === 'renderer'
    ? candidates.find(m => m.capabilityScope?.expertId === 'design-critic')
    : candidates.find(m => /^bk-\d{3}$/u.test(m.capabilityScope?.expertId ?? '')))?.name
}

export function isResearchRelease(value: unknown): value is ResearchRelease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as ResearchRelease
  const sha = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/u.test(x)
  if (v.schemaVersion === 2) {
    const {digest,...body}=v
    return v.kind==='working-material' && typeof v.taskId==='string' && Number.isSafeInteger(v.attempt) && v.attempt>0 && Array.isArray(v.inputs) && Array.isArray(v.artifacts) && v.artifacts.length>0 && v.artifacts.every(a=>a && typeof a.id==='string' && typeof a.reviewId==='string' && sha(a.sha256) && typeof a.relativePath==='string') && sha(digest) && canonicalDigest(body)===digest
  }
  if (v.schemaVersion !== 1 || !Number.isSafeInteger(v.attempt) || v.attempt < 1
    || !['taskId','runId','reviewEventId','reviewer','integrationEventId'].every(k => typeof (v as unknown as Record<string,unknown>)[k] === 'string')
    || !sha(v.auditDigest) || !sha(v.digest) || !Array.isArray(v.artifacts) || !v.artifacts.length || !Array.isArray(v.inputs)
    || v.artifacts.some(a => !a || typeof a.id !== 'string' || typeof a.reviewId !== 'string' || !sha(a.sha256) || typeof a.relativePath !== 'string')) return false
  const { digest, ...body } = v
  return canonicalDigest(body) === digest
}
