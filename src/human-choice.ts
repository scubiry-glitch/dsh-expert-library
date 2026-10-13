import { isResearchV5, isV5WorkingTask, isCompactResearch, assertResearchRelease } from './research-release.ts'
/** Host-owned mid-run task choice. All callers must hold the team lock. */
import type { TeamState, TeamTask, TaskArtifact } from './types.ts'
import { commitTaskUpdate, readAllowedTaskArtifact } from './state.ts'

function currentSource(team: TeamState, task: TeamTask): { source: TeamTask; artifact: TaskArtifact } {
  const gate = task.humanChoice
  if (gate === undefined) throw new Error('HUMAN_CHOICE_NOT_A_GATE')
  if (!task.dependencies.includes(gate.sourceTaskId)) throw new Error('HUMAN_CHOICE_SOURCE_NOT_DEPENDENCY')
  const source = team.tasks.find(candidate => candidate.id === gate.sourceTaskId)
  if (source?.status !== 'completed') throw new Error('HUMAN_CHOICE_SOURCE_NOT_READY')
  if (isCompactResearch(team)) assertResearchRelease(team, source)
  const versions = (source.publishedArtifacts ?? []).filter(item => item.attempt === source.attempt && item.reviewId === `published:${gate.artifact}`)
  if (versions.length === 0) throw new Error('HUMAN_CHOICE_SOURCE_MISSING')
  const artifact = versions.at(-1)!
  const review = team.qualityRuns?.[source.id]
  if (!isV5WorkingTask(team,source) && team.structuredQualityPolicy?.required !== false && (review?.status !== 'integrated' || review.attempt !== source.attempt)) {
    throw new Error('HUMAN_CHOICE_SOURCE_NOT_REVIEWED')
  }
  if (!isV5WorkingTask(team,source) && team.structuredQualityPolicy?.required !== false && !review?.latestEvidence?.artifacts.some(evidence =>
    evidence.id === artifact.reviewId && evidence.sha256 === artifact.sha256
    && evidence.path === `${team.id}/${source.project?.artifactsPath}/${artifact.relativePath}`.replaceAll('\\', '/'))) {
    throw new Error('HUMAN_CHOICE_SOURCE_NOT_REVIEWED')
  }
  return { source, artifact }
}

export async function readHumanChoice(stateRoot: string, team: TeamState, task: TeamTask) {
  const { source, artifact } = currentSource(team, task)
  if (artifact.sizeBytes > 128 * 1024) throw new Error('HUMAN_CHOICE_SOURCE_TOO_LARGE')
  const selected = await readAllowedTaskArtifact(stateRoot, team, { ...task, inputArtifacts: [{ sourceTaskId: source.id, artifactId: artifact.id }] }, { sourceTaskId: source.id, artifactId: artifact.id })
  if (selected.encoding !== undefined) throw new Error('HUMAN_CHOICE_SOURCE_NOT_TEXT')
  return { ...(isCompactResearch(team) ? { sourceReleaseDigest: source.researchRelease!.digest } : {}), sourceTaskId: source.id, artifactId: artifact.id, sha256: artifact.sha256, attempt: artifact.attempt, content: selected.content, options: isResearchV5(team) && task.planTask?.logicalId === 'outline_choice' ? viewpointOptions(selected.content) : [...task.humanChoice!.options] }
}

export async function completeHumanChoice(stateRoot: string, team: TeamState, task: TeamTask, selection: string | readonly string[], expectedSha256: string, actor: 'authenticated-host-user' | 'scoped-review-token' = 'authenticated-host-user', reviewTokenId?: string): Promise<void> {
  if (task.humanChoice === undefined || task.status !== 'pending' || task.humanChoiceReceipt !== undefined) throw new Error('HUMAN_CHOICE_ALREADY_DECIDED')
  const source = await readHumanChoice(stateRoot, team, task)
  const choices = typeof selection === 'string' ? [selection] : [...selection]
  const multiViewpoint = isResearchV5(team) && task.planTask?.logicalId === 'outline_choice'
  if (choices.length === 0 || choices.length > source.options.length || (!multiViewpoint && choices.length !== 1)
    || new Set(choices).size !== choices.length || choices.some(choice => !source.options.includes(choice))) throw new Error('HUMAN_CHOICE_INVALID_OPTION')
  if (expectedSha256 !== source.sha256) throw new Error('HUMAN_CHOICE_STALE_SOURCE')
  const snapshot = { ...task }
  if(multiViewpoint) task.humanChoice={...task.humanChoice,options:[...source.options]}
  const approvedAt = Date.now()
  const choice = choices.length === 1 ? choices[0]! : `主观点：${choices[0]}；补充观点：${choices.slice(1).join('；')}`
  task.humanChoiceReceipt = { ...(source.sourceReleaseDigest ? { sourceReleaseDigest: source.sourceReleaseDigest } : {}), choice, ...(multiViewpoint ? { choices } : {}), sourceArtifactId: source.artifactId, sourceSha256: source.sha256, sourceAttempt: source.attempt, approvedAt, actor, ...(actor === 'scoped-review-token' && reviewTokenId !== undefined ? { reviewTokenId } : {}) }
  task.output = JSON.stringify(task.humanChoiceReceipt)
  task.status = 'completed'
  task.attempt = 1
  task.updatedAt = approvedAt
  await commitTaskUpdate(stateRoot, team, task, snapshot)
}

/** Candidate labels are authored after the evidence scan, bound to the chosen source hash. */
export function viewpointOptions(content: string): string[] {
  const block = /```viewpoint-options\s*\n([\s\S]*?)```/u.exec(content)
  let rows: unknown
  try { rows=JSON.parse(block?.[1]??'null') } catch { throw new Error('V5_VIEWPOINT_OPTIONS_INVALID') }
  if(!Array.isArray(rows)||rows.length<1||rows.length>8||rows.some(s=>typeof s!=='string'||!s.trim()||s.length>200)||new Set(rows).size!==rows.length) throw new Error('V5_VIEWPOINT_OPTIONS_INVALID: include a viewpoint-options JSON string array of distinct actual candidate labels')
  return rows
}
