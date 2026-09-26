import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CapabilityScopeError,
  admitCapability,
  bootstrapCapabilityScope,
  createCapabilityScope,
  resolveCapabilityRoute,
  restoreCapabilityScopeWithReport,
  snapshotCapabilityScope,
} from '../lib/capability-scope.js'

function scope(overrides = {}) {
  return createCapabilityScope({
    expertId: 'expert-a',
    role: 'researcher',
    allowedProviders: ['p1'],
    allowedTools: ['search'],
    allowedKnowledge: ['kb.research'],
    allowedTasks: ['task-1'],
    ...overrides,
  })
}

test('scope defaults maxDepth to zero and admits only explicit allowlists', () => {
  const value = scope()
  assert.equal(value.maxDepth, 0)
  assert.equal(admitCapability(value, { provider: 'p1', tool: 'search', task: 'task-1' }).ok, true)
  const denied = admitCapability(value, { provider: 'p2', tool: 'write', delegationDepth: 1 })
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.deepEqual(denied.denied.map(item => item.code), ['scope-denied', 'scope-denied', 'depth-denied'])
})

test('scope rejects malformed input and never widens an empty allowlist', () => {
  assert.throws(() => createCapabilityScope({ expertId: 'x', role: 'r', allowedTools: /** @type {any} */ ('search') }), CapabilityScopeError)
  const empty = createCapabilityScope({ expertId: 'x', role: 'r' })
  assert.equal(admitCapability(empty, { tool: 'search' }).ok, false)
  assert.equal(admitCapability(empty, { delegationDepth: 0 }).ok, true)
})

test('route precedence is explicit, then profile, expert, default, captain', () => {
  const result = resolveCapabilityRoute({
    explicit: { provider: 'p-explicit', model: 'm' },
    profile: { provider: 'p-profile', model: 'm' },
    expert: { provider: 'p-expert', model: 'm' },
    default: { provider: 'p-default', model: 'm' },
    captain: { provider: 'p-captain', model: 'm' },
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.source, 'explicit')
    assert.equal(result.route.provider, 'p-explicit')
  }
})

test('route effort and provider compatibility use fallback without accepting an incompatible primary', () => {
  const result = resolveCapabilityRoute({
    profile: { provider: 'p1', model: 'm1', reasoningEffort: 'ultra' },
    fallback: [{ provider: 'p2', model: 'm2', reasoningEffort: 'high', reason: 'alternate route' }],
    available: [
      { provider: 'p1', model: 'm1', supportedEfforts: ['default', 'medium'] },
      { provider: 'p2', model: 'm2', supportedEfforts: ['high'] },
    ],
    allowedProviders: ['p1', 'p2'],
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.source, 'fallback')
    assert.equal(result.fallbackUsed, true)
    assert.equal(result.route.reasoningEffort, 'high')
    assert.equal(result.attempts[0].accepted, false)
  }
})

test('bootstrap filters host capabilities, records lenient fallback and stops on non-continuable host', () => {
  const result = bootstrapCapabilityScope(scope({ allowedProviders: ['p1', 'p2'], allowedTools: ['search', 'write'] }), {
    providers: ['p1'],
    tools: ['search'],
    knowledge: ['kb.research'],
    continuable: true,
  })
  assert.deepEqual(result.filtered.providers, ['p2'])
  assert.deepEqual(result.filtered.tools, ['write'])
  assert.equal(result.scope.allowedProviders.join(','), 'p1')
  assert.equal(result.scope.allowedTools.join(','), 'search')
  assert.equal(result.stopping, false)

  const stopping = bootstrapCapabilityScope(scope(), { continuable: false })
  assert.equal(stopping.stopping, true)
  assert.equal(stopping.spawnError?.code, 'host-not-continuable')
  assert.equal(stopping.fallback?.kind, 'lenient-filter')
})

test('scope snapshots restore legacy missing fields fail-closed and report migration', () => {
  const original = scope({ maxDepth: 2, profileId: 'p' })
  const snapshot = snapshotCapabilityScope(original)
  assert.deepEqual(snapshot, original)
  const restored = restoreCapabilityScopeWithReport({ expertId: 'expert-a', role: 'researcher' })
  assert.equal(restored.migrated, true)
  assert.equal(restored.scope.maxDepth, 0)
  assert.deepEqual(restored.scope.allowedTools, [])
  assert.ok(restored.warnings.length > 0)
  assert.equal(restoreCapabilityScopeWithReport(snapshot).migrated, false)
})
