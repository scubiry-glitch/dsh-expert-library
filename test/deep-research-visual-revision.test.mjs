import test from 'node:test'
import assert from 'node:assert/strict'
import { visualRevisionSources } from '../lib/deep-research-visual-revision.js'

const task = (logicalId, id, assignee, status, dependencies = []) => ({
  id, assignee, status, dependencies, planTask: { logicalId },
  ...(logicalId === 'renderer' ? {
    reportBundle: { md: 'report.md', html: 'report.html', pdf: 'report.pdf' },
    frozenSkillCraftContract: { digest: 'craft' }, skillBindings: [], promptBinding: {},
    frozenTaskMaterialContract: { digest: 'materials' }, inputArtifacts: [], inputArtifactManifest: [],
  } : logicalId === 'visual_review' ? { skillBindings: [], promptBinding: {}, frozenTaskMaterialContract: { digest: 'review-materials' } } : {}),
})
function fixture() {
  const inputs = ['writer', 'content_review', 'point_figures', 'outline_final'].map((id, index) => task(id, `t${index + 1}`, 'researcher', 'completed'))
  const renderer = task('renderer', 't5', 'designer', 'completed', inputs.map(item => item.id))
  const review = task('visual_review', 't6', 'critic', 'in_progress', [renderer.id])
  const finalqa = task('finalqa', 't7', 'researcher', 'pending', [renderer.id, review.id])
  const team = { planRef: { scenarioId: '98wiki-deep-research', templateVersion: '3.0.0' },
    tasks: [...inputs, renderer, review, finalqa], qualityRuns: {
      [renderer.id]: { status: 'integrated' },
      [review.id]: { status: 'blocked', lastVerdict: 'reject', findings: [{ severity: 'hard', code: 'VISUAL', message: 'unreadable' }] },
      [finalqa.id]: { status: 'pending' },
    } }
  return team
}

test('one bounded revision requires integrated renderer, hard critic rejection and untouched finalqa', () => {
  const team = fixture()
  const sources = visualRevisionSources(team)
  assert.equal(sources.renderer.id, 't5')
  assert.equal(sources.rejectedReview.id, 't6')
  assert.equal(sources.renderDependencies.length, 4)
  team.tasks.push(task('render_revision_1', 't8', 'designer', 'pending'))
  assert.throws(() => visualRevisionSources(team), /already exists/)
})

test('nonvisual rejection, unreviewed renderer and claimed finalqa cannot open a revision', () => {
  const nonvisual = fixture(); nonvisual.qualityRuns.t6.findings = [{ severity: 'soft', code: 'STYLE', message: 'minor' }]
  assert.throws(() => visualRevisionSources(nonvisual), /hard blocker/)
  const unreviewed = fixture(); unreviewed.qualityRuns.t5.status = 'passed'
  assert.throws(() => visualRevisionSources(unreviewed), /integrated reviewed/)
  const claimed = fixture(); claimed.tasks.find(item => item.id === 't7').status = 'claimed'
  assert.throws(() => visualRevisionSources(claimed), /unclaimed and unreviewed/)
})
