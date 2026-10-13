import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateDeepResearchPlan } from '../lib/deep-research-plan.js'
import { checkDeepResearchReviewer, checkRenderFigureLayer } from '../lib/deep-research-gates.js'

const source = '/root/.openclaw/workspace/98wiki/projects/供平过租见底路径/深度研究团队DAG-v3.json'
const profile = async () => (JSON.parse(await readFile(source, 'utf8'))).profile

test('phase 3 plan refuses a missing task Skill/Prompt or figure dependency', async () => {
  const plan = await profile()
  validateDeepResearchPlan(plan)
  const renderer = plan.tasks.find(task => task.id === 'renderer')
  renderer.skillBindings = renderer.skillBindings.filter(item => item.skillId !== '98wiki-finesse-report')
  assert.throws(() => validateDeepResearchPlan(plan), /requires registered Skill bindings/)
  renderer.skillBindings = (await profile()).tasks.find(task => task.id === 'renderer').skillBindings
  renderer.artifactInputs = renderer.artifactInputs.filter(item => item.artifact !== 'figure-fragments.html')
  assert.throws(() => validateDeepResearchPlan(plan), /must pin point_figures\/figure-fragments.html/)
})

test('v3.1 data probe cannot be approved without its dataset capabilities', async () => {
  const plan = await profile()
  plan.version = '3.1'
  assert.throws(() => validateDeepResearchPlan(plan), /data_preflight must grant the catalog/)
  for (const task of plan.tasks) {
    if (task.id === 'data_preflight') task.allowedCapabilities = ['realestate.indicators.catalog']
    if (task.id.startsWith('research_')) task.allowedCapabilities = ['realestate.indicators.catalog', 'realestate.indicators.timeseries']
  }
  assert.doesNotThrow(() => validateDeepResearchPlan(plan))
})

test('v3 renderer requires the bound independent critic', () => {
  const team = { planRef: { scenarioId: '98wiki-deep-research', templateVersion: '3.0.0' }, members: [
    { id: 'designer', capabilityScope: { expertId: 'designer-craft' } },
    { id: 'critic', capabilityScope: { expertId: 'design-critic' } },
  ] }
  const task = { planTask: { logicalId: 'renderer' } }
  assert.throws(() => checkDeepResearchReviewer(team, task, 'designer'), /DEEP_RESEARCH_RENDER_REVIEWER/)
  assert.doesNotThrow(() => checkDeepResearchReviewer(team, task, 'critic'))
})

test('renderer cannot claim a different figure layer in craft evidence', () => {
  const outline = '## 第一章\n## 第二章\n'
  const fragments = '<aside data-chapter="第一章">图卡</aside>'
  const craft = JSON.stringify({ schemaVersion: 3, figureLayer: { fragmentsHtml: fragments, sha256: '0'.repeat(64), chapters: ['第一章','第二章'] } })
  assert.throws(() => checkRenderFigureLayer(craft, fragments, outline), /DEEP_RESEARCH_FIGURE_LAYER/)
})
