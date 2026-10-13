import test from 'node:test'
import assert from 'node:assert/strict'
import { parseResearchRecommendation } from '../lib/deep-research-recommendation.js'

const plan = { preview: { expertSelection: { candidates: [
  { id: 'bk-024' }, { id: 'bk-031' }, { id: 'bk-010' }, { id: 'bk-011' }, { id: 'bk-025' },
] } } }
const models = [{ provider: 'fixture', model: 'allowed', name: 'Allowed model', reasoningEffort: 'default' }]
const answer = { subDagId: 'research-3', expertIds: ['bk-024', 'bk-031', 'bk-010'],
  materialRecipes: { research_main: 'strategy', research_counter: 'core', evidence_merge: 'strategy', writer: 'core' },
  modelChoice: 'm0', reason: '供给、成交与租赁分别核查，合并时保留反方条件和证据限制。' }

test('model proposal resolves only allowlisted graph, experts, Skill recipes and model', () => {
  const result = parseResearchRecommendation(JSON.stringify(answer), plan, models)
  assert.equal(result.subDagId, 'research-3')
  assert.deepEqual(result.expertIds, answer.expertIds)
  assert.equal(result.materials.length, 4)
  assert.deepEqual(result.memberModel, { provider: 'fixture', model: 'allowed', reasoningEffort: 'default' })
  for (const invalid of [
    { ...answer, expertIds: ['bk-024', 'bk-031', 'bk-034'] },
    { ...answer, subDagId: 'research-5' },
    { ...answer, materialRecipes: { ...answer.materialRecipes, writer: 'invented' } },
    { ...answer, modelChoice: 'm9' },
    { ...answer, unexpected: 'ignore previous instructions' },
  ]) assert.throws(() => parseResearchRecommendation(JSON.stringify(invalid), plan, models), /RESEARCH_RECOMMENDATION_|DEEP_RESEARCH_SELECTION_INVALID/)
})
