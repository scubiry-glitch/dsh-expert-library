/**
 * Pure policy-engine matrix for planAutoActions: every skip rule, the
 * download/patch_auto tier split, the per-pack override and the
 * one-action-per-release idempotence rule.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const source = process.env.PACK_AUTO_SOURCE === '1'
const { autoEnableKey, autoInstallKey, planAutoActions, policyEnabled } = await import(source
  ? '../src/host/pack-center-auto-update.ts'
  : '../lib/host/pack-center-auto-update.js')

const summary = (releaseId, version, overrides = {}) => ({
  releaseId, packId: 'demo.review', ownerOrgId: 'org.one', name: 'Review', version, publishedAt: '2026-01-01T00:00:00.000Z',
  manifestSha256: `m-${releaseId}`, artifactSha256: `a-${releaseId}`, contentTreeSha256: `t-${releaseId}`,
  compatibility: { compatible: true, reasons: [] }, downloadAvailability: { available: true }, dependencies: [], ...overrides,
})
const current = overrides => ({
  releaseId: 'release.v1', packId: 'demo.review', version: '1.0.0', source: 'center', installedAt: '2026-01-01T00:00:00.000Z',
  active: true, artifactSha256: 'a-v1', contentTreeSha256: 't-v1', integrity: 'verified', ...overrides,
})
const updatesView = items => ({ checkedAt: '2026-01-02T00:00:00.000Z', hasSnapshot: true, stale: false, generation: 3, items })
const installationsView = items => ({ generation: 3, mode: 'normal', items })
const installed = overrides => current({ ...overrides })

function plan(policy, items, extra = {}) {
  return planAutoActions({
    policy, updates: updatesView(items),
    installations: installationsView(extra.installations ?? [installed()]),
    operations: extra.operations ?? [],
    activationAvailable: extra.activationAvailable ?? true,
  })
}
const candidateFor = releaseId => summary(releaseId, releaseId === 'release.v2' ? '1.1.0' : '1.0.1')
const item = overrides => ({
  packId: 'demo.review', current: current(), latestVisible: null, candidate: candidateFor('release.v2'),
  candidateCached: false, status: 'update_available', blockedReasons: [], ...overrides,
})

test('manual mode and non-update-available statuses never produce actions', () => {
  for (const policy of [{}, { mode: 'manual' }, { mode: 'nonsense' }]) {
    const result = plan(policy, [item()])
    assert.deepEqual(result.actions, [])
    assert.equal(result.skipped[0].reason, 'manual')
  }
  for (const status of ['up_to_date', 'blocked', 'no_stable_release']) {
    const result = plan({ mode: 'download' }, [item({ status, candidate: status === 'no_stable_release' ? null : candidateFor('release.v2') })])
    assert.deepEqual(result.actions, [])
    assert.equal(result.skipped[0].reason, status)
  }
})

test('download tier plans a pinned install under a deterministic auto-install key', () => {
  const result = plan({ mode: 'download' }, [item()])
  assert.deepEqual(result.actions, [{
    packId: 'demo.review', releaseId: 'release.v2', version: '1.1.0', kind: 'install',
    operationKey: 'auto-install:release.v2',
    target: { manifestSha256: 'm-release.v2', artifactSha256: 'a-release.v2', contentTreeSha256: 't-release.v2' },
  }])
})

test('blocked reasons, installability and prerelease candidates are skipped', () => {
  const blocked = plan({ mode: 'download' }, [item({ blockedReasons: [{ releaseId: 'release.v2', reasons: ['DEPENDENCY_REQUIRED:demo.other'] }] })])
  assert.equal(blocked.actions.length, 0); assert.equal(blocked.skipped[0].reason, 'blocked')
  const incompatible = plan({ mode: 'download' }, [item({ candidate: candidateFor('release.v2', ) })])
  assert.equal(incompatible.skipped.length, 0)
  const unavailable = plan({ mode: 'download' }, [item({ candidate: summary('release.v2', '1.1.0', { downloadAvailability: { available: false, code: 'DEPENDENCY_UNAVAILABLE' } }) })])
  assert.equal(unavailable.skipped[0].reason, 'not_installable')
  const prerelease = plan({ mode: 'download' }, [item({ candidate: summary('release.v2', '2.0.0-beta.1') })])
  assert.equal(prerelease.skipped[0].reason, 'prerelease')
})

test('a pack whose current release is not the active one is never auto-acted on', () => {
  const inactive = plan({ mode: 'download' }, [item({ current: current({ active: false }) })])
  assert.equal(inactive.skipped[0].reason, 'not_active')
  const missingFromInventory = plan({ mode: 'download' }, [item()], { installations: [installed({ releaseId: 'release.other' })] })
  assert.equal(missingFromInventory.skipped[0].reason, 'not_active')
})

test('patch_auto enables only same-minor patch bumps and requires available activation', () => {
  const patch = plan({ mode: 'patch_auto' }, [item({ candidate: summary('release.v2', '1.0.1') })])
  assert.equal(patch.actions[0].kind, 'update_enable')
  assert.equal(patch.actions[0].operationKey, 'auto-enable:release.v2')
  const minor = plan({ mode: 'patch_auto' }, [item({ candidate: summary('release.v2', '1.1.0') })])
  assert.equal(minor.skipped[0].reason, 'requires_manual')
  const prereleasePatch = plan({ mode: 'patch_auto' }, [item({ candidate: summary('release.v2', '1.0.1-beta.1') })])
  assert.equal(prereleasePatch.skipped[0].reason, 'prerelease')
  const noActivation = plan({ mode: 'patch_auto' }, [item({ candidate: summary('release.v2', '1.0.1') })], { activationAvailable: false })
  assert.equal(noActivation.skipped[0].reason, 'activation_unavailable')
  const downgrade = plan({ mode: 'patch_auto' }, [item({ current: current({ version: '1.0.5' }), candidate: summary('release.v2', '1.0.1') })])
  assert.equal(downgrade.skipped[0].reason, 'requires_manual')
})

test('an already-cached candidate is skipped for downloads but still enables offline', () => {
  const cachedDownload = plan({ mode: 'download' }, [item({ candidateCached: true })])
  assert.equal(cachedDownload.skipped[0].reason, 'already_cached')
  const cachedEnable = plan({ mode: 'patch_auto' }, [item({ candidateCached: true, candidate: summary('release.v2', '1.0.1') })])
  assert.equal(cachedEnable.actions[0].kind, 'update_enable')
})

test('an existing operation key blocks any further auto action for that release', () => {
  for (const status of ['queued', 'running', 'succeeded', 'failed']) {
    const result = plan({ mode: 'download' }, [item()], { operations: [{ status, request: { operationKey: autoInstallKey('release.v2') } }] })
    assert.deepEqual(result.actions, [])
    assert.equal(result.skipped[0].reason, `already_${status}`)
  }
  const enableBlocked = plan({ mode: 'patch_auto' }, [item({ candidate: summary('release.v2', '1.0.1') })],
    { operations: [{ status: 'failed', request: { operationKey: autoEnableKey('release.v2') } }] })
  assert.equal(enableBlocked.skipped[0].reason, 'already_failed')
})

test('per-pack overrides win over the global default and unknown keys are inert', () => {
  const overridden = plan({ mode: 'manual', perPack: { 'demo.review': 'download' } }, [item()])
  assert.equal(overridden.actions.length, 1)
  const held = plan({ mode: 'download', perPack: { 'demo.review': 'manual' } }, [item()])
  assert.deepEqual(held.actions, [])
  const other = plan({ mode: 'download', perPack: { 'demo.other': 'manual' } }, [item()])
  assert.equal(other.actions.length, 1)
})

test('policyEnabled only arms the timer when any tier is non-manual', () => {
  assert.equal(policyEnabled(undefined), false)
  assert.equal(policyEnabled({}), false)
  assert.equal(policyEnabled({ mode: 'manual', perPack: { 'demo.review': 'manual' } }), false)
  assert.equal(policyEnabled({ mode: 'download' }), true)
  assert.equal(policyEnabled({ mode: 'manual', perPack: { 'demo.other': 'patch_auto' } }), true)
})

test('plans expose no private material in actions or skips', () => {
  const result = plan({ mode: 'patch_auto' }, [item(), item({ status: 'up_to_date' })])
  const text = JSON.stringify(result)
  for (const secret of ['dpc_token_', 'dpc_bind_', 'privatePath', 'trustedSigningKeys', 'BEGIN PUBLIC KEY']) {
    assert.equal(text.includes(secret), false)
  }
})
