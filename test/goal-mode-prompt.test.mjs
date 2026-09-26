import test from 'node:test'
import assert from 'node:assert/strict'

import { memberPersona, memberWelcome } from '../lib/members.js'
import { zhijianExpertPersona } from '../lib/zhijian/persona.js'

const team = {
  id: 'goal-team',
  name: 'Goal Team',
  description: 'produce a verified decision memo',
  captainSessionId: 'captain',
  createdAt: 1,
  members: [],
  tasks: [],
  taskSeq: 0,
}

const member = { id: '', name: 'researcher', role: 'researcher', joinedAt: 1, status: 'idle' }

test('generic member prompt advances a stated goal and asks for evidence', () => {
  const prompt = memberPersona(team, member, '.expert-teams')
  assert.match(prompt, /goal mode/i)
  assert.match(prompt, /produce a verified decision memo/)
  assert.match(prompt, /verifiable evidence/)
  assert.match(memberWelcome(team), /goal mode/i)
})

test('Zhijian member prompt carries goal-state reporting into the domain persona', () => {
  const prompt = zhijianExpertPersona(team, member, '.expert-teams', {
    id: 'bk-001', bk: 'bk-001', name: 'Analyst', personaName: 'Analyst', field: '市场',
    stance: 'neutral', summary: 'evidence first', style: [], mentalModels: [], signaturePhrases: [],
    antiPatterns: [], analysisSteps: [], deceased: false,
  })
  assert.match(prompt, /团队目标：produce a verified decision memo/)
  assert.match(prompt, /以团队目标推进/)
  assert.match(prompt, /证据、假设、风险与下一依赖/)
})
