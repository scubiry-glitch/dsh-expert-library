import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { presetToolsConfig } from '../lib/preset-settings.js'
import { freezePlanModelRoutes, validateFrozenPlanModelRoutes } from '../lib/plan-models.js'
import { profileToExecutionPlan } from '../lib/profiles.js'

const legacy = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' }
const kimi = { provider: 'kimi-coding', model: 'kimi-for-coding' }

function fixture(entry = {}) {
  let service, section
  const calls = []
  const ctx = {
    get(name) { assert.equal(name, 'settings'); return service },
    logger: { warn() {} },
    llm: {
      async resolveCallConfig(route) {
        calls.push({ ...route })
        if (route.provider === 'kimi-coding') assert.notEqual(route.reasoningEffort, 'max', 'old adapter effort must not leak')
        return route
      },
    },
  }
  const config = presetToolsConfig(ctx, entry)
  return {
    ctx, config, calls,
    attach() {
      service = {
        get(ns) { assert.equal(ns, 'expert-library'); return section },
        register() { assert.fail('preset must not register the Host namespace') },
        installSection() { assert.fail('preset must not install another namespace owner') },
      }
    },
    set(value) { section = value },
    detach() { service = undefined },
  }
}

test('standalone preset preserves entry fallback, including an empty modern route over a usable legacy route', () => {
  const f = fixture({ memberModel: legacy, defaultModel: {}, memberMaxDepth: 0, maxActiveMembers: 3,
    expertModelOverrides: { researcher: kimi }, packsDir: 'local-packs', enabledPacks: ['local'], toolExecution: { zyt: { mode: 'cli' } } })
  assert.deepEqual(f.config.memberModel, legacy)
  assert.equal(f.config.memberMaxDepth, 0)
  assert.equal(f.config.maxActiveMembers, 3)
  assert.equal(f.config.packsDir, 'local-packs')
  assert.deepEqual(f.config.enabledPacks, ['local'])
  assert.deepEqual(f.config.expertModelOverrides, { researcher: kimi })
  assert.equal(f.config.toolExecution.zyt.mode, 'cli')
  assert.equal(f.config.getPackCenterSnapshot, undefined, 'reading settings must not invent an internal pack snapshot')
  assert.equal(fixture().config.memberMaxDepth, 1)
  assert.equal(fixture().config.maxActiveMembers, 2)
})

test('late namespace registration and service replacement are read live without retaining stale defaults', () => {
  const f = fixture({ memberModel: legacy, maxMembers: 7, maxActiveMembers: 3,
    enabledPacks: ['entry-pack'], packPriority: ['entry-pack'] })
  f.attach()
  assert.deepEqual(f.config.memberModel, legacy, 'settings service may precede namespace registration')
  const overrides = Object.fromEntries(Array.from({ length: 208 }, (_, i) => [`expert-${i}`, { ...kimi }]))
  f.set({ defaultModel: kimi, expertModelOverrides: overrides, maxActiveMembers: 2, memberMaxDepth: 0,
    enabledPacks: [], packPriority: [], packsDir: 'host-packs', vendorPacksDir: '/isolated/vendor-packs',
    packCenterOrigin: 'https://example.invalid', packCenterDir: '/isolated/center', packSourceAllowlist: [],
    toolExecution: { zyt: { mode: 'api', readOnly: true } } })
  assert.deepEqual(f.config.memberModel, kimi)
  assert.deepEqual(f.config.expertModelOverrides, overrides)
  assert.equal(Object.keys(f.config.expertModelOverrides).length, 208)
  assert.equal(f.config.maxMembers, 7)
  assert.equal(f.config.maxActiveMembers, 2)
  assert.equal(f.config.memberMaxDepth, 0)
  assert.deepEqual(f.config.enabledPacks, [], 'Host empty selection must not resurrect preset selections')
  assert.deepEqual(f.config.packPriority, [])
  assert.equal(f.config.packsDir, 'host-packs')
  assert.equal(f.config.vendorPacksDir, '/isolated/vendor-packs')
  assert.equal(f.config.packCenterDir, '/isolated/center')
  assert.equal(f.config.toolExecution.zyt.mode, 'api')
  f.set({ defaultModel: { ...kimi, model: 'updated-model' }, expertModelOverrides: {}, maxActiveMembers: 1 })
  assert.equal(f.config.memberModel.model, 'updated-model')
  assert.deepEqual(f.config.expertModelOverrides, {})
  assert.equal(f.config.maxActiveMembers, 1)
  f.detach()
  assert.deepEqual(f.config.memberModel, legacy)
  assert.equal(f.config.maxActiveMembers, 3)
})

test('Host overrides reach expert and reviewer plan selection; hot updates do not rewrite an approved frozen route', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'preset-settings-plan-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const f = fixture({ memberModel: legacy })
  const captain = { options: legacy, session: { header: { cwd: workspace }, requestHeader: () => ({ config: legacy }) } }
  const profile = {
    schemaVersion: 1, id: 'preset-settings-check', version: '1', description: 'Synthetic settings check', protocol: [], taskPlanning: 'captain',
    members: [{ id: 'writer', name: 'Writer', expert: 'researcher' }, { id: 'reviewer', name: 'Reviewer', expert: 'security-reviewer' },
      { id: 'custom', name: 'Custom member' }],
  }
  f.attach()
  f.set({ defaultModel: kimi, expertModelOverrides: { researcher: kimi, 'security-reviewer': kimi } })
  const initial = await freezePlanModelRoutes(f.ctx, f.config, captain, profileToExecutionPlan(profile))
  for (const member of initial.roster) {
    assert.deepEqual(member.modelPolicy, { ...kimi, reasoningEffort: 'default' })
    assert.equal(member.modelRouteFrozen, true)
  }
  assert.deepEqual(initial.roster.map(member => member.modelRouteSource), ['expert-override', 'expert-override', 'plugin-default'])
  assert.ok(f.calls.every(call => call.provider === kimi.provider && call.model === kimi.model && call.reasoningEffort === undefined))

  const nextRoute = { ...kimi, model: 'updated-model' }
  f.set({ defaultModel: nextRoute, expertModelOverrides: { researcher: nextRoute, 'security-reviewer': nextRoute } })
  const updated = await freezePlanModelRoutes(f.ctx, f.config, captain, profileToExecutionPlan(profile))
  assert.ok(updated.roster.every(member => member.modelPolicy.model === 'updated-model'))
  assert.notEqual(updated.digest, initial.digest)
  f.calls.length = 0
  await validateFrozenPlanModelRoutes(f.ctx, captain, initial)
  assert.ok(f.calls.every(call => call.model === kimi.model), 'approved plans use their exact prior selection')

  const explicitlySelected = profileToExecutionPlan({ ...profile, route: legacy })
  const explicit = await freezePlanModelRoutes(f.ctx, f.config, captain, explicitlySelected)
  assert.ok(explicit.roster.every(member => member.modelPolicy.model === legacy.model), 'explicit profile routes keep their established priority')
})
