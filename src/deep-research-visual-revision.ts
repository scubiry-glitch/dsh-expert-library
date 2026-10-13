/** Admission and rewiring contract for one post-integration visual repair. */
import type { TeamState, TeamTask } from './types.ts'

function fail(detail: string): never { throw new Error(`DEEP_RESEARCH_VISUAL_REVISION_INVALID: ${detail}`) }

export interface VisualRevisionSources {
  readonly renderer: TeamTask
  readonly rejectedReview: TeamTask
  readonly finalqa: TeamTask
  readonly renderDependencies: readonly TeamTask[]
}

export function visualRevisionSources(team: TeamState): VisualRevisionSources {
  if (team.planRef?.scenarioId !== '98wiki-deep-research' || !/^3\./u.test(team.planRef.templateVersion))
    fail('only an approved v3 research team can open this branch')
  const logical = (id: string) => team.tasks.filter(task => task.planTask?.logicalId === id)
  const sole = (id: string): TeamTask => {
    const found = logical(id)
    return found.length === 1 ? found[0]! : fail(`expected one ${id} task`)
  }
  if (logical('render_revision_1').length || logical('visual_review_1').length)
    fail('the one allowed visual revision branch already exists')
  const renderer = sole('renderer'), rejectedReview = sole('visual_review'), finalqa = sole('finalqa')
  const rendererRun = team.qualityRuns?.[renderer.id]
  const reviewRun = team.qualityRuns?.[rejectedReview.id]
  const finalRun = team.qualityRuns?.[finalqa.id]
  if (renderer.status !== 'completed' || rendererRun?.status !== 'integrated')
    fail('renderer must already have an integrated reviewed version')
  if (!['blocked', 'escalated'].includes(reviewRun?.status ?? '') || !['reject', 'needs_revision'].includes(reviewRun?.lastVerdict ?? '')
    || !reviewRun?.findings.some(finding => finding.severity === 'hard'))
    fail('an independent visual review with a hard blocker is required')
  if (rejectedReview.status === 'completed' || rejectedReview.status === 'failed' || rejectedReview.status === 'cancelled')
    fail('the rejected visual review is already terminal')
  if (finalqa.status !== 'pending' || finalqa.attemptId !== undefined || finalqa.dispatch !== undefined
    || finalRun?.status !== 'pending') fail('finalqa must still be unclaimed and unreviewed')
  if (renderer.assignee === undefined || rejectedReview.assignee === undefined
    || renderer.assignee === rejectedReview.assignee || finalqa.dependencies.includes(rejectedReview.id) === false
    || finalqa.dependencies.includes(renderer.id) === false) fail('renderer, independent critic and finalqa edges must be intact')
  if (renderer.reportBundle === undefined || renderer.frozenSkillCraftContract === undefined
    || renderer.skillBindings === undefined || renderer.promptBinding === undefined
    || renderer.frozenTaskMaterialContract === undefined || rejectedReview.skillBindings === undefined
    || rejectedReview.promptBinding === undefined || rejectedReview.frozenTaskMaterialContract === undefined)
    fail('approved craft and fixed task materials are required')
  const inputs = ['writer', 'content_review', 'point_figures', 'outline_final'].map(sole)
  if (inputs.some(task => task.status !== 'completed' || !renderer.dependencies.includes(task.id)))
    fail('all original render inputs must remain integrated')
  if (renderer.inputArtifacts === undefined || renderer.inputArtifactManifest === undefined)
    fail('original renderer inputs must be pinned before revision')
  return { renderer, rejectedReview, finalqa, renderDependencies: inputs }
}
