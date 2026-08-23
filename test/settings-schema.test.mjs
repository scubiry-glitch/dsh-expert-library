/**
 * Settings schema regression tests for the Phase-3 settings additions:
 * memberMaxDepth / toolExecution / enabledPacks / packPriority /
 * expertModelOverrides all round-trip through the ExpertLibrarySettings
 * schema, and the runtime normalizers keep their semantics.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ExpertLibrarySettingsSchema,
  normalizeToolMode,
  toolExecutionOf,
} from '../lib/settings.js'

test('schema accepts every new field (memberMaxDepth/toolExecution/enabledPacks/packPriority/expertModelOverrides)', () => {
  const parsed = ExpertLibrarySettingsSchema({
    stateDir: 'expert-teams',
    memberProvider: 'spawn',
    maxMembers: 8,
    memberMaxDepth: 2,
    knowledgeDir: 'knowledge',
    packsDir: 'domain-packs',
    promptSectionOrder: 117,
    announceToAgent: true,
    toolExecution: {
      zyt: { mode: 'cli', readOnly: true },
      beike: { mode: 'api' },
    },
    enabledPacks: ['bank-finance', 'beike'],
    packPriority: ['beike', 'bank-finance'],
    expertModelOverrides: {
      'bk-002': { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
    },
    defaultModel: { provider: 'p', model: 'm', reasoningEffort: 'low' },
    providers: {
      wind: { cliPath: '/x/cli.mjs' },
    },
  })
  assert.equal(parsed.memberMaxDepth, 2)
  assert.equal(parsed.toolExecution.zyt.mode, 'cli')
  assert.equal(parsed.toolExecution.zyt.readOnly, true)
  assert.deepEqual(parsed.enabledPacks, ['bank-finance', 'beike'])
  assert.deepEqual(parsed.packPriority, ['beike', 'bank-finance'])
  assert.equal(parsed.expertModelOverrides['bk-002'].provider, 'deepseek-official')
})

test('schema tolerates a partial section (every field optional)', () => {
  const parsed = ExpertLibrarySettingsSchema({ maxMembers: 4 })
  assert.equal(parsed.maxMembers, 4)
  assert.equal(parsed.memberMaxDepth, undefined)
  // Schemastery array defaults are [] — the runtime treats empty as "all
  // valid packs enabled", identical to undefined.
  assert.deepEqual(parsed.enabledPacks, [])
  assert.deepEqual(parsed.packPriority, [])
  assert.equal(parsed.expertModelOverrides, undefined)
  assert.equal(parsed.toolExecution, undefined)
})

test('normalizeToolMode: unknown/empty modes fall back to auto', () => {
  assert.equal(normalizeToolMode('api'), 'api')
  assert.equal(normalizeToolMode('cli'), 'cli')
  assert.equal(normalizeToolMode('auto'), 'auto')
  assert.equal(normalizeToolMode(undefined), 'auto')
  assert.equal(normalizeToolMode('weird'), 'auto')
  assert.equal(normalizeToolMode(''), 'auto')
})

test('toolExecutionOf reads the per-tool policy and tolerates absence', () => {
  assert.equal(toolExecutionOf(undefined, 'zyt'), undefined)
  assert.equal(toolExecutionOf({}, 'zyt'), undefined)
  const policy = toolExecutionOf(
    { toolExecution: { zyt: { mode: 'cli' } } },
    'zyt',
  )
  assert.equal(policy.mode, 'cli')
  assert.equal(toolExecutionOf({ toolExecution: { zyt: { mode: 'cli' } } }, 'beike'), undefined)
})
