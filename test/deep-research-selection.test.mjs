import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseProfile } from '../lib/profiles.js'
import { parseDeepResearchSelection, selectDeepResearchSubDag, selectDeepResearchMaterials } from '../lib/deep-research-selection.js'
import { validateDeepResearchPlan } from '../lib/deep-research-plan.js'

const source = '/root/.openclaw/workspace/98wiki/projects/供平过租见底路径/深度研究团队DAG-v3.json'
const profile = async () => parseProfile(JSON.parse(await readFile(source, 'utf8')).profile)

test('registered 2/3/5 expert graphs rebuild both parallel fan-outs and keep review gates', async () => {
  const original = await profile()
  for (const ids of [
    ['bk-024', 'bk-031'],
    ['bk-025', 'bk-031', 'bk-010'],
    ['bk-024', 'bk-031', 'bk-010', 'bk-011', 'bk-025'],
  ]) {
    const graph = selectDeepResearchSubDag(original, { subDagId: `research-${ids.length}`, expertIds: ids })
    const byId = new Map(graph.tasks.map(task => [task.id, task]))
    const briefs = graph.tasks.filter(task => task.id.startsWith('expert_brief_'))
    const views = graph.tasks.filter(task => task.id.startsWith('research_view_'))
    assert.equal(briefs.length, ids.length)
    assert.equal(views.length, ids.length - 2)
    assert.deepEqual(byId.get('outline_candidates').dependsOn, briefs.map(task => task.id))
    assert.deepEqual(byId.get('evidence_merge').dependsOn, ['research_main', 'research_counter', ...views.map(task => task.id)])
    assert.ok(byId.get('outline_choice').humanChoice)
    assert.ok(byId.get('report_release').humanChoice)
    assert.equal(byId.get('content_review').owner, graph.members[1].id)
    assert.deepEqual(graph.expertSelection.selectedIds, ids)
  }
  const two = selectDeepResearchSubDag(original, { subDagId: 'research-2', expertIds: ['bk-024', 'bk-031'] })
  const five = selectDeepResearchSubDag(two, { subDagId: 'research-5', expertIds: ['bk-024', 'bk-031', 'bk-010', 'bk-011', 'bk-025'] })
  assert.equal(five.tasks.filter(task => task.id.startsWith('research_view_')).length, 3)
  validateDeepResearchPlan(five)
  const withStrategy = selectDeepResearchMaterials(two, [{ taskId: 'research_main', recipeId: 'strategy' }])
  const three = selectDeepResearchSubDag(withStrategy, { subDagId: 'research-3', expertIds: ['bk-024', 'bk-031', 'bk-010'] })
  validateDeepResearchPlan(three)
})

test('Host selection rejects unregistered graph, wrong count, duplicate, unrelated and historical-only experts', async () => {
  const original = await profile()
  for (const choice of [
    { subDagId: 'research-6', expertIds: ['bk-024', 'bk-031'] },
    { subDagId: 'research-3', expertIds: ['bk-024', 'bk-031'] },
    { subDagId: 'research-2', expertIds: ['bk-024', 'bk-024'] },
  ]) assert.throws(() => parseDeepResearchSelection(choice), /DEEP_RESEARCH_SELECTION_INVALID/)
  assert.throws(() => selectDeepResearchSubDag(original, { subDagId: 'research-2', expertIds: ['bk-024', 'bk-034'] }), /DEEP_RESEARCH_SELECTION_INVALID/)
  const policy = structuredClone(original)
  policy.expertSelection.candidateIds = ['bk-020', 'bk-022', ...policy.expertSelection.candidateIds.slice(2)]
  assert.throws(() => selectDeepResearchSubDag(policy, { subDagId: 'research-2', expertIds: ['bk-020', 'bk-022'] }), /DEEP_RESEARCH_SELECTION_INVALID/)
})

test('fixed task materials reject a valid but wrong extra Skill', async () => {
  const original = await profile()
  const changed = structuredClone(original)
  const renderer = changed.tasks.find(task => task.id === 'renderer')
  renderer.skillBindings.push({ packId: 'dsh-expert-library', skillId: 'strategy-consulting', materialRole: 'producer', required: true, reason: 'unrelated extra material' })
  assert.throws(() => validateDeepResearchPlan(changed), /DEEP_RESEARCH_PLAN_INVALID: renderer requires registered Skill bindings/)
})

test('Host permits only registered strategy recipe on research nodes and preserves fixed Prompt', async () => {
  const original = await profile()
  const changed = selectDeepResearchMaterials(original, [{ taskId: 'research_main', recipeId: 'strategy' }, { taskId: 'writer', recipeId: 'strategy' }])
  for (const id of ['research_main', 'writer']) {
    const before = original.tasks.find(task => task.id === id)
    const after = changed.tasks.find(task => task.id === id)
    assert.equal(after.promptBinding.templateId, before.promptBinding.templateId)
    assert.ok(after.skillBindings.some(skill => skill.skillId === 'strategy-consulting'))
  }
  const reset = selectDeepResearchMaterials(changed, [{ taskId: 'research_main', recipeId: 'core' }])
  assert.ok(!reset.tasks.find(task => task.id === 'research_main').skillBindings.some(skill => skill.skillId === 'strategy-consulting'))
  assert.throws(() => selectDeepResearchMaterials(original, [{ taskId: 'renderer', recipeId: 'strategy' }]), /DEEP_RESEARCH_SELECTION_INVALID/)
  assert.throws(() => selectDeepResearchMaterials(original, [{ taskId: 'writer', recipeId: 'invented' }]), /DEEP_RESEARCH_SELECTION_INVALID/)
  assert.throws(() => selectDeepResearchMaterials(original, [{ taskId: 'writer', recipeId: 'core' }, { taskId: 'writer', recipeId: 'strategy' }]), /DEEP_RESEARCH_SELECTION_INVALID/)
})
