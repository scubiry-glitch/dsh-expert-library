import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseProfile, profileToExecutionPlan } from '../lib/profiles.js'
import { validateDeepResearchPlan } from '../lib/deep-research-plan.js'
import { resolveLibrary } from '../lib/expert-library/registry.js'

const source = '/root/.openclaw/workspace/98wiki/projects/供平过租见底路径/深度研究团队DAG-v2.json'
const draft = async () => JSON.parse(await readFile(source, 'utf8'))

test('v2 freezes routed expert selection and analysis framework before the outline gate', async () => {
  const input = await draft()
  const profile = parseProfile(input.profile)
  validateDeepResearchPlan(profile)
  const plan = profileToExecutionPlan(profile)
  assert.deepEqual(plan.params.expertSelection.selectedIds, ['bk-024', 'bk-031', 'bk-010'])
  assert.equal(plan.params.expertSelection.routeFramework, 'A')
  assert.equal(plan.params.analysisFramework.id, 'supply-rent-bottom-path')
  const task = id => plan.tasks.find(item => item.id === id)
  assert.deepEqual(task('expert_brief_market').dependsOn, [])
  assert.deepEqual(task('expert_brief_counter').dependsOn, [])
  assert.deepEqual(task('expert_brief_city').dependsOn, [])
  assert.ok(task('outline_candidates').dependsOn.includes('expert_brief_counter'))
  assert.ok(task('outline_candidates').dependsOn.includes('expert_brief_city'))
  assert.ok(task('research_main').dependsOn.includes('outline_final'))
  assert.ok(task('research_counter').dependsOn.includes('outline_final'))
  assert.ok(task('research_main').dependsOn.includes('data_preflight'))
  assert.ok(task('research_counter').dependsOn.includes('data_preflight'))
  assert.ok(task('research_view_city').dependsOn.includes('data_preflight'))
  assert.ok(task('evidence_merge').dependsOn.includes('research_view_city'))
  assert.ok(task('renderer').dependsOn.includes('point_figures'))
  assert.ok(task('visual_review').dependsOn.includes('renderer'))
})

test('v2 rejects a forged route choice or missing independent expert brief', async () => {
  const input = await draft()
  delete input.profile.expertSelection
  assert.throws(() => validateDeepResearchPlan(parseProfile(input.profile)), /DEEP_RESEARCH_PLAN_INVALID.*expertSelection/)
  input.profile.expertSelection = (await draft()).profile.expertSelection
  input.profile.expertSelection.selectedIds = ['bk-024', 'bk-025']
  assert.throws(() => validateDeepResearchPlan(parseProfile(input.profile)), /DEEP_RESEARCH_PLAN_INVALID.*expertSelection/)
  input.profile.expertSelection.selectedIds = ['bk-024', 'bk-031', 'bk-010']
  input.profile.tasks.find(task => task.id === 'outline_candidates').artifactInputs.pop()
  assert.throws(() => validateDeepResearchPlan(parseProfile(input.profile)), /PLAN_DEPENDENCY_UNJUSTIFIED.*expert_brief_city/)
})

test('question-routed roster can include another independently researching expert', async () => {
  const input = await draft()
  const profile = input.profile
  profile.expertSelection.selectedIds.push('bk-025')
  profile.members.splice(3, 0, { id: 'index', name: '百城台长·数据对照', expert: 'bk-025', role: '跨城市数据对照' })
  const copy = (id, nextId) => JSON.parse(JSON.stringify(profile.tasks.find(task => task.id === id)).replaceAll('city', 'index').replaceAll(id, nextId))
  profile.tasks.push(copy('expert_brief_city', 'expert_brief_index'))
  profile.tasks.push(copy('research_view_city', 'research_view_index'))
  const outline = profile.tasks.find(task => task.id === 'outline_candidates')
  outline.dependsOn.push('expert_brief_index')
  outline.artifactInputs.push({ fromTask: 'expert_brief_index', artifact: 'expert_brief_index.md', phase: 'work', purpose: 'Independent index brief' })
  const merge = profile.tasks.find(task => task.id === 'evidence_merge')
  merge.dependsOn.push('research_view_index')
  merge.artifactInputs.push({ fromTask: 'research_view_index', artifact: 'research_view_index.md', phase: 'work', purpose: 'Independent index evidence' })
  validateDeepResearchPlan(parseProfile(profile))
})

test('the design maker and independent critic resolve in an empty captain workspace', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'deep-research-experts-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const library = await resolveLibrary({ logger: { warn() {} } }, workspace, 'knowledge')
  assert.equal(library.experts.get('designer-craft')?.name, '巧手·阿妙')
  assert.equal(library.experts.get('design-critic')?.name, '毒舌·尖尖')
})
