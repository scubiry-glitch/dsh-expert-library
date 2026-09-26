import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ProfileValidationError,
  parseProfile,
  resolveProfile,
  validateProfile,
} from '../lib/profiles.js'

const base = {
  schemaVersion: 1,
  id: 'research-seed',
  version: '1.0.0',
  description: '固定研究协作模板',
  protocol: '先核验事实，再给结论',
  members: [
    { name: 'researcher', expert: 'researcher', role: 'research' },
    { name: 'writer', expert: 'docs-coordinator', role: 'writer', provider: 'deepseek', model: 'deepseek-v4' },
  ],
  route: { provider: 'deepseek', model: 'deepseek-v4' },
  fallback: [{ provider: 'deepseek', model: 'deepseek-v3', reason: 'primary unavailable' }],
  taskPlanning: 'seed',
  templateId: 'collab.research-report',
  review: { required: true, maxRepairRounds: 2, hardGateIds: ['facts'] },
}

test('seed profile parses into a normalized, explicit fixed-plan contract', () => {
  const result = validateProfile({
    ...base,
    tasks: [
      { id: 'research', subject: '梳理资料', owner: 'researcher' },
      { id: 'write', subject: '融合成文', owner: 'writer', dependsOn: ['research'], acceptance: ['包含口径'] },
    ],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.profile.protocol, ['先核验事实，再给结论'])
  assert.equal(result.profile.members[1].route?.model, 'deepseek-v4')
  assert.deepEqual(result.profile.tasks?.[1].dependsOn, ['research'])
})

test('captain profile carries roster and policy but never a fixed DAG', () => {
  const profile = parseProfile({
    ...base,
    id: 'captain-research',
    taskPlanning: 'captain',
    templateId: undefined,
    tasks: undefined,
  })
  assert.equal(profile.taskPlanning, 'captain')
  assert.equal(profile.templateId, undefined)
  assert.equal(profile.tasks, undefined)
})

test('captain fixed DAG and seed without template/tasks are rejected', () => {
  const captain = validateProfile({ ...base, taskPlanning: 'captain', templateId: undefined, tasks: [{ id: 't1', subject: '固定任务' }] })
  assert.equal(captain.ok, false)
  if (!captain.ok) assert.ok(captain.issues.some(issue => issue.code === 'captain-dag'))

  const seed = validateProfile({ ...base, taskPlanning: 'seed', templateId: undefined, tasks: undefined })
  assert.equal(seed.ok, false)
  if (!seed.ok) assert.ok(seed.issues.some(issue => issue.code === 'seed-dag'))
})

test('profile validation rejects unknown fields, duplicate members, cycles and bad routes', () => {
  const result = validateProfile({
    ...base,
    unexpected: true,
    members: [{ name: 'same' }, { name: 'same' }],
    route: { provider: 'deepseek', model: 'v4', secret: 'must not be accepted' },
    tasks: [
      { id: 'a', subject: 'A', dependsOn: ['b'] },
      { id: 'b', subject: 'B', dependsOn: ['a'] },
    ],
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.issues.some(issue => issue.code === 'unknown-key'))
    assert.ok(result.issues.some(issue => issue.code === 'duplicate-member'))
    assert.ok(result.issues.some(issue => issue.code === 'dependency-cycle'))
  }
})

test('resolveProfile requires an exact explicit id and never fuzzy matches a goal', () => {
  const profile = parseProfile({ ...base, tasks: [{ id: 't1', subject: '梳理资料' }] })
  const catalog = new Map([[profile.id, profile]])
  assert.equal(resolveProfile(catalog, profile.id).id, profile.id)
  assert.throws(() => resolveProfile(catalog, 'research-seed please plan a report'), ProfileValidationError)
  assert.throws(() => resolveProfile(catalog, 'research'), ProfileValidationError)
})

