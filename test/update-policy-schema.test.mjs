/**
 * Update-policy settings regression tests: the loose storage schema accepts
 * and round-trips `packCenterUpdatePolicy`, and the runtime normalizers keep
 * manual as the safe downgrade for every unknown value while rejecting
 * prototype-chain and credential-shaped perPack keys.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ExpertLibrarySettingsSchema,
  isValidPolicyPackKey,
  normalizeUpdateMode,
  normalizeUpdatePolicy,
  resolveUpdateMode,
} from '../lib/settings.js'

test('normalizeUpdateMode falls back to manual for unknown, empty and mis-cased values', () => {
  for (const value of [undefined, '', 'DOWNLOAD', 'patch-auto', 'manual ', null, 3, true]) {
    assert.equal(normalizeUpdateMode(value), 'manual', String(value))
  }
  assert.equal(normalizeUpdateMode('download'), 'download')
  assert.equal(normalizeUpdateMode('patch_auto'), 'patch_auto')
  assert.equal(normalizeUpdateMode('manual'), 'manual')
})

test('isValidPolicyPackKey accepts pack-id shapes and rejects prototype and credential hazards', () => {
  for (const value of ['demo.review', 'a', 'A0._-x', 'legacy-pack-id']) {
    assert.equal(isValidPolicyPackKey(value), true, String(value))
  }
  for (const value of ['__proto__', 'constructor', 'prototype', 'dpc_token_abc', 'dpc_bind_abc', 'a..b', '', '.lead', '-lead', `${'a'.repeat(65)}`, 7, null, undefined]) {
    assert.equal(isValidPolicyPackKey(value), false, String(value))
  }
})

test('normalizeUpdatePolicy rebuilds the object, dropping invalid keys and unknown modes without mutating input', () => {
  const input = Object.freeze({
    mode: 'patch_auto',
    perPack: Object.freeze({ 'demo.good': 'download', __proto__: 'patch_auto', 'demo.bad key': 'download', 'dpc_token_x': 'download', 'demo.legacy': 'nonsense' }),
  })
  const output = normalizeUpdatePolicy(input)
  assert.deepEqual(output, { mode: 'patch_auto', perPack: { 'demo.good': 'download', 'demo.legacy': 'manual' } })
  assert.equal('perPack' in output, true)
  assert.deepEqual(Object.keys(output.perPack).sort(), ['demo.good', 'demo.legacy'])
  for (const value of [undefined, null, 'x', 5, [], { perPack: 'x' }, { perPack: [] }]) {
    assert.deepEqual(normalizeUpdatePolicy(value), {}, JSON.stringify(value))
  }
  assert.deepEqual(normalizeUpdatePolicy({ mode: 'manual', perPack: {} }), { mode: 'manual' }, 'empty perPack is dropped')
})

test('resolveUpdateMode lets a per-pack override win and guards prototype chains', () => {
  const policy = { mode: 'download', perPack: { 'demo.review': 'patch_auto' } }
  assert.equal(resolveUpdateMode(policy, 'demo.review'), 'patch_auto')
  assert.equal(resolveUpdateMode(policy, 'demo.other'), 'download')
  assert.equal(resolveUpdateMode(undefined, 'demo.review'), 'manual')
  assert.equal(resolveUpdateMode({}, 'demo.review'), 'manual')
  assert.equal(resolveUpdateMode({ perPack: { __proto__: 'patch_auto' } }, '__proto__'), 'manual', 'own-property guard')
})

test('packCenterUpdatePolicy round-trips through the ExpertLibrarySettings schema', () => {
  const parsed = ExpertLibrarySettingsSchema({
    stateDir: 'expert-teams',
    packCenterOrigin: 'https://packs.meizu.life',
    packCenterUpdatePolicy: { mode: 'download', perPack: { 'demo.review': 'manual' } },
  })
  assert.deepEqual(parsed.packCenterUpdatePolicy, { mode: 'download', perPack: { 'demo.review': 'manual' } })
})
