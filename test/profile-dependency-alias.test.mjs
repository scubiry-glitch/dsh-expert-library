import test from 'node:test'
import assert from 'node:assert/strict'
import { validateArgs } from '@deepseek-ai/dsh-tools'
import { parseProfile, profileToExecutionPlan, validateProfile } from '../lib/profiles.js'
import { PROFILE_SCHEMA, PROFILE_TASKS_SCHEMA } from '../lib/profile-schema.js'

const profile = tasks => ({ schemaVersion: 1, id: 'dependency-alias', version: '1',
  description: 'Preserve explicitly declared dependency edges', protocol: [],
  members: [{ id: 'worker', name: 'Worker' }], taskPlanning: 'seed', tasks })
const graph = () => [
  { id: 't1-trend', subject: 'Trend' },
  { id: 't2-pricing', subject: 'Pricing' },
  { id: 't3-finance', subject: 'Finance' },
  { id: 't4-compose', subject: 'Compose', dependencies: ['t1-trend', 't2-pricing', 't3-finance'] },
  { id: 't5-render', subject: 'Render', dependencies: ['t4-compose'] },
  { id: 't6-review', subject: 'Review', dependencies: ['t5-render'] },
]
const expected = [[], [], [], ['t1-trend', 't2-pricing', 't3-finance'], ['t4-compose'], ['t5-render']]

test('actual six-task alias graph passes nested wire validation and compiles to canonical edges', () => {
  const tasks = graph()
  assert.deepEqual(validateArgs({ profile: PROFILE_SCHEMA, tasks: PROFILE_TASKS_SCHEMA }, { profile: profile(tasks), tasks }), [])
  const parsed = parseProfile(profile(tasks))
  assert.deepEqual(parsed.tasks.map(task => task.dependsOn), expected)
  assert.ok(parsed.tasks.every(task => !Object.hasOwn(task, 'dependencies')))
  const canonical = parseProfile(profile(tasks.map(({ dependencies, ...task }) => ({ ...task, dependsOn: dependencies ?? [] }))))
  assert.equal(profileToExecutionPlan(parsed).digest, profileToExecutionPlan(canonical).digest)
})

test('both spellings accept the same dependency set and retain canonical field ordering', () => {
  const tasks = [{ id: 'a', subject: 'A' }, { id: 'b', subject: 'B' },
    { id: 'c', subject: 'C', dependsOn: ['b', 'a'], dependencies: [' a ', 'b', 'a'] }]
  assert.deepEqual(parseProfile(profile(tasks)).tasks[2].dependsOn, ['b', 'a'])
})

test('conflicting spellings including explicit empty versus nonempty never choose a winner', () => {
  for (const [dependsOn, dependencies] of [[[], ['a']], [['a'], []], [['a'], ['b']]]) {
    const result = validateProfile(profile([{ id: 'a', subject: 'A' }, { id: 'b', subject: 'B' },
      { id: 'c', subject: 'C', dependsOn, dependencies }]))
    assert.equal(result.ok, false)
    assert.ok(result.issues.some(issue => issue.code === 'invalid-value' && /dependsOn.*dependencies.*conflict/i.test(issue.message)), JSON.stringify(result))
  }
})

test('both supplied fields are validated independently even when the other is valid', () => {
  for (const bad of [null, 'a', [1], ['']]) {
    for (const field of ['dependsOn', 'dependencies']) {
      const other = field === 'dependsOn' ? 'dependencies' : 'dependsOn'
      const result = validateProfile(profile([{ id: 'a', subject: 'A' }, { id: 'b', subject: 'B', [field]: bad, [other]: ['a'] }]))
      assert.equal(result.ok, false)
      assert.ok(result.issues.some(issue => issue.path.startsWith(`tasks[1].${field}`) && ['invalid-type', 'invalid-value'].includes(issue.code)), JSON.stringify(result))
    }
  }
})

test('aliases retain unknown-target and cycle rejection', () => {
  const unknown = validateProfile(profile([{ id: 'a', subject: 'A', dependencies: ['missing'] }]))
  assert.equal(unknown.ok, false)
  assert.ok(unknown.issues.some(issue => issue.code === 'unknown-dependency'))
  const cycle = validateProfile(profile([{ id: 'a', subject: 'A', dependencies: ['b'] }, { id: 'b', subject: 'B', dependsOn: ['a'] }]))
  assert.equal(cycle.ok, false)
  assert.ok(cycle.issues.some(issue => issue.code === 'dependency-cycle'))
})

test('v1 omitted graph fields and explicit empty lists remain valid independent tasks', () => {
  assert.deepEqual(parseProfile(profile([{ id: 'a', subject: 'A' }, { id: 'b', subject: 'B', dependsOn: [] }])).tasks.map(task => task.dependsOn), [[], []])
})

test('alias support does not weaken required metadata or introduce unrelated field aliases', () => {
  const invalid = profile(graph()); delete invalid.schemaVersion
  assert.ok(validateArgs({ profile: PROFILE_SCHEMA }, { profile: invalid }).some(issue => issue.includes('schemaVersion')))
  for (const extra of [{ assignee: 'worker' }, { depends_on: [] }, { dependency: [] }]) {
    const result = validateProfile(profile([{ id: 'a', subject: 'A', ...extra }]))
    assert.equal(result.ok, false)
    assert.ok(result.issues.some(issue => issue.code === 'unknown-key'))
  }
})
