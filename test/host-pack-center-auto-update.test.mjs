/**
 * Real signed fixture + injected clock: the update-policy scheduler plans from
 * live manager state, auto-downloads without activation, enables patches only,
 * never retried a terminal failure, never runs while manual, and leaks no
 * secrets through its status view.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { managerFixture } from './support/pack-center-manager-fixture.mjs'

const source = process.env.PACK_AUTO_SOURCE === '1'
const { AUTO_CHECK_BASE_MS, createPackCenterAutoUpdate } = await import(source
  ? '../src/host/pack-center-auto-update.ts'
  : '../lib/host/pack-center-auto-update.js')

async function waitFor(predicate, message = 'condition', milliseconds = 15_000) {
  const end = Date.now() + milliseconds
  while (Date.now() < end) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${message}`)
}
async function terminal(manager, id) {
  return waitFor(async () => { const job = await manager.operation(id); return ['succeeded', 'failed', 'interrupted'].includes(job.status) && job })
}
async function activeBaseline(f) {
  const v1 = await f.addRelease({ releaseId: 'release.v1', version: '1.0.0' })
  await f.bind()
  const cached = await f.current.enqueue({ operationKey: 'cache-v1', kind: 'install', expectedGeneration: 0,
    releaseId: 'release.v1', connectionRevision: (await f.current.connection()).revision, target: f.target(v1) })
  assert.equal((await terminal(f.current, cached.operationId)).status, 'succeeded')
  const enabled = await f.current.enqueue({ operationKey: 'enable-v1', kind: 'enable', expectedGeneration: 1, releaseId: 'release.v1' })
  assert.equal((await terminal(f.current, enabled.operationId)).status, 'succeeded')
  return v1
}
function clock() {
  const timers = []
  return {
    timers,
    schedule: (callback, ms) => { const entry = { callback, ms }; timers.push(entry); return () => { entry.fired = true } },
    fire: async () => { const entry = timers.at(-1); entry.callback(); await new Promise(resolve => setTimeout(resolve, 0)) },
  }
}
function controller(f, policyRef, options = {}) {
  const timer = clock()
  const value = createPackCenterAutoUpdate({ service: f.current, policy: () => policyRef.current,
    originConfigured: () => true, schedule: timer.schedule, baseIntervalMs: 1000, maxIntervalMs: 8000, ...options })
  return { value, timer }
}

test('download tier auto-caches an update without activating it and journals under an auto- key', async t => {
  const f = await managerFixture(t)
  await activeBaseline(f)
  await f.addRelease({ releaseId: 'release.v2', version: '1.1.0' })
  const policyRef = { current: { mode: 'download' } }
  const { value, timer } = controller(f, policyRef)
  t.after(() => value.close())
  const before = f.wire.paths.filter(path => path.endsWith('/download-grants') || path.endsWith('/artifact')).length
  await value.runOnce()
  const job = (await f.current.operations()).find(entry => entry.request.operationKey === 'auto-install:release.v2')
  assert.equal(job.status, 'succeeded')
  const installations = await f.current.installations()
  const cached = installations.items.find(entry => entry.releaseId === 'release.v2')
  assert.equal(cached.active, false, 'download never activates')
  const after = f.wire.paths.filter(path => path.endsWith('/download-grants') || path.endsWith('/artifact')).length
  assert.equal(after, before + 2, 'grant and artifact were fetched exactly once')
  assert.equal(value.status().lastApplyAt !== null, true)
})

test('patch_auto enables a same-minor patch and holds minor bumps for a human', async t => {
  const f = await managerFixture(t)
  await activeBaseline(f)
  await f.addRelease({ releaseId: 'release.patch', version: '1.0.1' })
  const policyRef = { current: { mode: 'patch_auto' } }
  const { value } = controller(f, policyRef)
  t.after(() => value.close())
  await value.runOnce()
  const enabledJob = (await f.current.operations()).find(entry => entry.request.operationKey === 'auto-enable:release.patch')
  assert.equal(enabledJob.status, 'succeeded')
  assert.equal((await f.current.installations()).items.find(entry => entry.releaseId === 'release.patch').active, true)

  // A minor bump is never auto-enabled: no new auto operation, active unchanged.
  await f.addRelease({ releaseId: 'release.minor', version: '1.1.0' })
  const before = (await f.current.operations()).length
  await value.runOnce()
  assert.equal((await f.current.operations()).length, before)
  assert.equal((await f.current.installations()).items.find(entry => entry.releaseId === 'release.patch').active, true)
})

test('a candidate cached under the download tier enables offline after the policy rises to patch_auto', async t => {
  const f = await managerFixture(t)
  await activeBaseline(f)
  await f.addRelease({ releaseId: 'release.patch', version: '1.0.1' })
  const policyRef = { current: { mode: 'download' } }
  const { value } = controller(f, policyRef)
  t.after(() => value.close())
  await value.runOnce()
  const cached = (await f.current.installations()).items.find(entry => entry.releaseId === 'release.patch')
  assert.equal(cached.active, false, 'download tier caches only')
  policyRef.current = { mode: 'patch_auto' }
  const downloads = () => f.wire.paths.filter(path => path.endsWith('/download-grants') || path.endsWith('/artifact')).length
  const frozen = downloads()
  await value.runOnce()
  const offlineJob = (await f.current.operations()).find(entry => entry.request.operationKey === 'auto-enable:release.patch')
  assert.equal(offlineJob.status, 'succeeded')
  assert.equal((await f.current.installations()).items.find(entry => entry.releaseId === 'release.patch').active, true)
  assert.equal(downloads(), frozen, 'the cached candidate enabled through the offline local path')
})

test('a non-active pack, an unbound host and manual policy all produce zero network actions', async t => {
  const f = await managerFixture(t)
  await activeBaseline(f)
  const disabled = await f.current.enqueue({ operationKey: 'disable-1', kind: 'disable', expectedGeneration: 2, packId: 'demo.review' })
  assert.equal((await terminal(f.current, disabled.operationId)).status, 'succeeded')
  await f.addRelease({ releaseId: 'release.v2', version: '1.1.0' })
  const policyRef = { current: { mode: 'download' } }
  const { value } = controller(f, policyRef)
  t.after(() => value.close())
  await value.runOnce()
  assert.equal((await f.current.operations()).some(entry => entry.request.operationKey.startsWith('auto-')), false,
    'a non-active current release is never auto-acted on')

  const bare = await managerFixture(t)
  const bareRef = { current: { mode: 'download' } }
  const bareController = controller(bare, bareRef)
  await bareController.value.runOnce()
  assert.equal(bare.wire.paths.length, 0, 'unbound hosts never touch the wire')
  assert.equal(bareController.value.status().lastCheckErrorCode, 'CENTER_NOT_BOUND')
  await bareController.value.close()

  const quietRef = { current: { mode: 'manual' } }
  const quiet = controller(f, quietRef)
  quiet.value.sync()
  assert.equal(quiet.value.status().timerRunning, false)
  assert.equal(quiet.value.status().enabled, false)
  await quiet.value.runOnce()
  assert.equal((await f.current.operations()).some(entry => entry.request.operationKey.startsWith('auto-')), false)
  await quiet.value.close()
})

test('the timer arms only when the policy is non-manual, backs off on check failures and resets on success', async t => {
  const f = await managerFixture(t)
  await activeBaseline(f)
  await f.addRelease({ releaseId: 'release.v2', version: '1.1.0' })
  const policyRef = { current: { mode: 'download' } }
  const { value, timer } = controller(f, policyRef)
  t.after(() => value.close())
  value.sync()
  assert.equal(value.status().timerRunning, true)
  const armed = timer.timers.at(-1)
  assert.equal(armed.ms > 850 && armed.ms < 1150, true, `first delay ≈ base ±15%, got ${armed.ms}`)
  f.wire.catalogError = 'RATE_LIMITED'
  await timer.fire()
  await waitFor(async () => value.status().tickInFlight === false, 'tick completion')
  assert.equal(value.status().intervalMs, 2000, 'transport-class failures double the interval')
  assert.equal(value.status().lastCheckErrorCode, 'RATE_LIMITED')
  const backedOff = timer.timers.at(-1)
  assert.equal(backedOff.ms > 1700 && backedOff.ms < 2300, true, `backed-off delay ≈ 2× ±15%, got ${backedOff.ms}`)
  f.wire.catalogError = null
  await timer.fire()
  await waitFor(async () => value.status().tickInFlight === false, 'recovery tick')
  assert.equal(value.status().intervalMs, 1000, 'success resets the interval')
  assert.equal(value.status().lastCheckErrorCode, undefined)
})

test('a benign local-state conflict during the check does not back off', async t => {
  const f = await managerFixture(t)
  await activeBaseline(f)
  await f.addRelease({ releaseId: 'release.v2', version: '1.1.0' })
  const policyRef = { current: { mode: 'download' } }
  const { value, timer } = controller(f, policyRef)
  t.after(() => value.close())
  value.sync()
  // A stale expectedGeneration fails closed at the enqueue fence (thrown
  // synchronously, not journaled). That is a local-state race, not a center
  // problem: the check interval must not grow because of it.
  await assert.rejects(f.current.enqueue({ operationKey: 'stale-generation', kind: 'enable',
    expectedGeneration: 99, releaseId: 'release.v1' }), error => error.code === 'GENERATION_CONFLICT')
  await timer.fire()
  await waitFor(async () => value.status().tickInFlight === false, 'tick completion')
  assert.equal(value.status().intervalMs, 1000, 'the interval only grows on transport-class failures')
})

test('runOnce is idempotent and a terminal failure is never retried by the scheduler', async t => {
  // The activation gate passes the manual baseline and fails the auto enable.
  let blocked = false
  const f = await managerFixture(t, { validateActivation: () => {
    if (blocked) throw Object.assign(new Error('blocked'), { code: 'ACTIVATION_PREFLIGHT_FAILED' })
  } })
  await activeBaseline(f)
  await f.addRelease({ releaseId: 'release.patch', version: '1.0.1' })
  const policyRef = { current: { mode: 'patch_auto' } }
  const { value } = controller(f, policyRef)
  t.after(() => value.close())
  blocked = true
  await value.runOnce()
  const failed = (await f.current.operations()).find(entry => entry.request.operationKey === 'auto-enable:release.patch')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.result.outcome, 'installed_not_enabled', 'activation preflight downgrades to cached-not-enabled')
  const count = (await f.current.operations()).length
  await value.runOnce()
  await value.runOnce()
  assert.equal((await f.current.operations()).length, count, 'the existing key blocks any further auto action')
  const recent = value.status().recent
  assert.equal(recent.some(entry => entry.operationKey === 'auto-enable:release.patch' && entry.outcome === 'failed'), true)
})

test('scheduler status exposes no secrets or filesystem paths', async t => {
  const f = await managerFixture(t)
  await activeBaseline(f)
  await f.addRelease({ releaseId: 'release.v2', version: '1.1.0' })
  const policyRef = { current: { mode: 'download' } }
  const { value } = controller(f, policyRef)
  t.after(() => value.close())
  await value.runOnce()
  value.sync()
  const text = JSON.stringify(value.status())
  for (const secret of [f.root, f.directory, f.wire.token, f.wire.bindingCode, 'credentialToken', 'trustedSigningKeys', 'BEGIN PUBLIC KEY', 'packPath', 'manifestPath']) {
    assert.equal(text.includes(secret), false)
  }
  assert.equal(AUTO_CHECK_BASE_MS, 6 * 60 * 60 * 1000)
})
