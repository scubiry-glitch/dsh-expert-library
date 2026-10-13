import test from 'node:test'
import assert from 'node:assert/strict'
import { activatedExpert, domainExpertForTeam, requirePlanExpertAvailability } from '../lib/active-experts.js'

const ctx = { get: () => undefined, logger: { warn() {}, info() {}, debug() {}, error() {} } }
const config = { knowledgeDir: 'knowledge' }

test('V2 expert profile carries its persona and model into team assembly', () => {
  const expert = domainExpertForTeam({
    id: 'domain-expert', display: { internalName: 'Domain Expert', publicLabel: 'Specialist' },
    domains: ['research'], persona: { style: ['cite evidence'], tone: 'careful' },
    methods: [], knowledgeBindings: [], constraints: {}, outputSchema: {}, compliance: {},
    modelPolicy: { provider: 'test', model: 'research-model' },
  })
  assert.equal(expert.id, 'domain-expert')
  assert.match(expert.background, /cite evidence/)
  assert.deepEqual(expert.principles, ['cite evidence', 'careful'])
  assert.equal(expert.model.model, 'research-model')
})

test('planned expert preflight rejects a missing source before approval', async () => {
  const plan = { roster: [{ expertId: 'alias', sourceExpertId: 'not-an-installed-expert', profileId: 'profile' }] }
  await assert.rejects(requirePlanExpertAvailability(ctx, config, process.cwd(), plan), /PLAN_EXPERT_UNAVAILABLE/)
})

test('activated V2 expert takes precedence over the legacy view', async () => {
  const expert = await activatedExpert(ctx, config, 'bk-029')
  assert.equal(expert?.id, 'bk-029')
  assert.ok(expert?.background.includes('persona'))
})
