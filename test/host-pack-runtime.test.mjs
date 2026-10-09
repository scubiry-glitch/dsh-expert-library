import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashContentDirectory } from '../packages/pack-contract/index.mjs'

const source = process.env.PACK_RUNTIME_SOURCE === '1'
const { resolveManagedRuntimePack, preflightManagedActivation } = await import(source ? '../src/host/pack-runtime.ts' : '../lib/host/pack-runtime.js')
const { resolveRuntimePack } = await import(source ? '../src/v2/runtime-pack.ts' : '../lib/v2/runtime-pack.js')
const { emptyPackCenterState } = await import(source ? '../src/host/pack-center-state.ts' : '../lib/host/pack-center-state.js')
const fixtureV1 = resolve(fileURLToPath(new URL('../examples/pack-center/demo-v1/', import.meta.url)))
const fixtureV2 = resolve(fileURLToPath(new URL('../examples/pack-center/demo-v2/', import.meta.url)))

const readPack = async root => JSON.parse(await readFile(join(root, 'pack.json'), 'utf8'))
const namespace = (pack, name) => JSON.parse(JSON.stringify(pack).replaceAll('demo.review', name))
async function basePack(name = 'builtin.base') { return namespace(await readPack(fixtureV1), name) }
function fakeCtx(roots = []) {
  return { get(key) {
    if (key === 'workspaceRegistry' || key === 'workspace') return { list: () => roots.map(path => ({ path })) }
    if (key === 'sessions') return { list: () => [] }
    return undefined
  } }
}
async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'pack-runtime-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function writePack(root, pack) {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'pack.json'), JSON.stringify(pack))
  return root
}
async function snapshot(root = fixtureV1, generation = 1, extra = {}) {
  return { generation, packs: [{ releaseId: `release-${generation}`, packId: (await readPack(root)).pack.id, root,
    contentTreeSha256: (await hashContentDirectory(root)).contentTreeSha256 }], suppressedLegacyPaths: [], ...extra }
}
const selected = { packsDir: 'domain-packs' }
const rejectsCode = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code); return true })

test('without a provider the bridge preserves legacy overlay behavior', async t => {
  const root = await scratch(t)
  const base = await basePack()
  const overlay = namespace(await readPack(fixtureV2), 'builtin.base')
  await writePack(join(root, 'domain-packs', 'override'), overlay)
  const ctx = fakeCtx([root])
  const direct = await resolveRuntimePack(ctx, selected, base)
  const bridged = await resolveManagedRuntimePack(ctx, selected, base)
  assert.deepEqual(bridged, direct)
  assert.equal(bridged.pack.experts[0].display.publicLabel, '样例 V2')
})

test('each managed call reads local state and retains a frozen old result after generation change', async () => {
  let current = await snapshot()
  let calls = 0
  const config = { ...selected, getPackCenterSnapshot: async () => { calls++; return current } }
  const first = await resolveManagedRuntimePack(fakeCtx(), config, await basePack())
  assert.equal(first.pack.experts.find(item => item.id === 'demo.review.expert').display.publicLabel, '样例 V1')
  current = await snapshot(fixtureV2, 2)
  const second = await resolveManagedRuntimePack(fakeCtx(), config, await basePack())
  assert.equal(calls, 2)
  assert.equal(second.pack.experts.find(item => item.id === 'demo.review.expert').display.publicLabel, '样例 V2')
  assert.equal(first.centerSnapshot.generation, 1)
  assert.equal(second.centerSnapshot.generation, 2)
  assert.equal(first.pack.experts.find(item => item.id === 'demo.review.expert').display.publicLabel, '样例 V1')
  assert.ok(Object.isFrozen(first.pack.experts[0].display))
  assert.throws(() => { first.centerSnapshot.packs[0].root = '/changed' }, TypeError)
  current.packs[0].root = '/caller-mutated-after-return'
  assert.equal(second.centerSnapshot.packs[0].root, fixtureV2)
})

test('empty active state does not discover installed candidates and provider errors are not hidden', async () => {
  const empty = { generation: 9, packs: [], suppressedLegacyPaths: [] }
  const result = await resolveManagedRuntimePack(fakeCtx(), { ...selected, getPackCenterSnapshot: async () => empty }, await basePack())
  assert.deepEqual(result.layers, [])
  assert.equal(result.pack.experts.some(item => item.id === 'demo.review.expert'), false)
  const failure = Object.assign(new Error('local state unreadable'), { code: 'STATE_CORRUPT' })
  await assert.rejects(resolveManagedRuntimePack(fakeCtx(), { ...selected, getPackCenterSnapshot: async () => { throw failure } }, await basePack()), error => error === failure)
})

test('selection, base, and provider are captured before awaiting the state read', async t => {
  const root = await scratch(t)
  await writePack(join(root, 'domain-packs', 'local'), await basePack('workspace.local'))
  const current = await snapshot()
  let deliver
  const gate = new Promise(resolve => { deliver = resolve })
  const config = { ...selected, enabledPacks: ['workspace.local'], getPackCenterSnapshot: () => gate }
  const base = await basePack()
  const pending = resolveManagedRuntimePack(fakeCtx([root]), config, base)
  config.enabledPacks[0] = 'not-enabled'
  config.packsDir = 'different-directory'
  config.getPackCenterSnapshot = async () => { throw new Error('must not use replacement provider') }
  base.experts[0].display.publicLabel = 'changed-after-call'
  deliver(current)
  const result = await pending
  assert.ok(result.pack.experts.some(item => item.id === 'workspace.local.expert'))
  assert.equal(result.pack.experts.find(item => item.id === 'builtin.base.expert').display.publicLabel, '样例 V1')
  assert.equal(Object.isFrozen(base), false)
})

test('managed snapshots reject non-JSON accessors without executing them', async () => {
  let called = 0
  const invalid = { get generation() { called++; return 1 }, packs: [], suppressedLegacyPaths: [] }
  await rejectsCode(resolveManagedRuntimePack(fakeCtx(), { ...selected, getPackCenterSnapshot: async () => invalid }, await basePack()), 'CENTER_SNAPSHOT_INVALID')
  assert.equal(called, 0)
})

test('builtin pack identities and entity ids cannot be overwritten by a center pack', async () => {
  const state = await snapshot()
  const config = { ...selected, getPackCenterSnapshot: async () => state }
  const packIdConflict = await basePack()
  packIdConflict.pack.id = 'demo.review'
  await rejectsCode(resolveManagedRuntimePack(fakeCtx(), config, packIdConflict), 'CENTER_PACK_ID_CONFLICT')
  const entityConflict = await basePack()
  entityConflict.experts[0].id = 'demo.review.expert'
  await rejectsCode(resolveManagedRuntimePack(fakeCtx(), config, entityConflict), 'CENTER_ENTITY_CONFLICT')
})

test('workspace conflicts across roots and post-activation edits are checked on every call', async t => {
  const root = await scratch(t)
  const firstRoot = join(root, 'one'), secondRoot = join(root, 'two')
  const localPath = await writePack(join(secondRoot, 'domain-packs', 'local'), await basePack('workspace.safe'))
  const state = await snapshot()
  const config = { ...selected, getPackCenterSnapshot: async () => state }
  const ctx = fakeCtx([firstRoot, secondRoot])
  const first = await resolveManagedRuntimePack(ctx, config, await basePack())
  assert.ok(first.pack.experts.some(item => item.id === 'workspace.safe.expert'))
  const conflict = await readPack(localPath)
  // Retain pack identity but collide in one section; this is a valid full pack.
  conflict.experts.push(structuredClone((await readPack(fixtureV2)).experts[0]))
  await writePack(localPath, conflict)
  await rejectsCode(resolveManagedRuntimePack(ctx, config, await basePack()), 'CENTER_ENTITY_CONFLICT')
  assert.equal(first.pack.experts.find(item => item.id === 'demo.review.expert').display.publicLabel, '样例 V1')
  // Explicitly disabled legacy packs do not participate in the active merge.
  const disabled = await resolveManagedRuntimePack(ctx, { ...config, enabledPacks: ['some-other-pack'] }, await basePack())
  assert.equal(disabled.layers.length, 1)
})

test('center packs cannot collide with one another even with distinct pack ids', async t => {
  const root = await scratch(t)
  const other = await basePack('org.other')
  other.experts.push(structuredClone((await readPack(fixtureV1)).experts[0]))
  const otherRoot = await writePack(join(root, 'other'), other)
  const a = await snapshot(), b = await snapshot(otherRoot, 2)
  a.packs.push(...b.packs)
  await rejectsCode(preflightManagedActivation(fakeCtx(), selected, [await basePack()], a), 'CENTER_ENTITY_CONFLICT')
})

test('preflight checks all actual bases and executes the real merge validator', async () => {
  const state = await snapshot()
  await preflightManagedActivation(fakeCtx(), selected, [await basePack('builtin.one'), await basePack('builtin.two')], state)
  const conflict = await readPack(fixtureV1)
  await rejectsCode(preflightManagedActivation(fakeCtx(), selected, [await basePack(), conflict], state), 'CENTER_PACK_ID_CONFLICT')
  await rejectsCode(preflightManagedActivation(fakeCtx(), selected, [], state), 'CENTER_BASES_REQUIRED')
  const invalidBase = await basePack()
  invalidBase.scenarios[0].teamTemplate = 'absent.team'
  await rejectsCode(preflightManagedActivation(fakeCtx(), selected, [invalidBase], state), 'CENTER_MERGE_INVALID')
})

test('only the exact taken-over vendor path is suppressed; local legacy origin remains visible', async t => {
  const root = await scratch(t)
  const vendorRoot = join(root, 'vendor')
  const vendorPath = await writePack(join(vendorRoot, 'old'), await readPack(fixtureV1))
  const candidate = await snapshot(fixtureV2, 2, { suppressedLegacyPaths: [vendorPath] })
  candidate.packs[0].source = 'legacy'
  const config = { ...selected, vendorPacksDir: vendorRoot, getPackCenterSnapshot: async () => candidate }
  const result = await resolveManagedRuntimePack(fakeCtx(), config, await basePack())
  assert.equal(result.layers.length, 1)
  assert.match(result.layers[0].label, /^managed-legacy\//)
  assert.equal(result.centerSnapshot.packs[0].source, 'legacy')
  const workspaceRoot = join(root, 'workspace')
  const workspacePath = await writePack(join(workspaceRoot, 'domain-packs', 'same-id'), await readPack(fixtureV1))
  candidate.suppressedLegacyPaths.push(workspacePath)
  await rejectsCode(resolveManagedRuntimePack(fakeCtx([workspaceRoot]), config, await basePack()), 'CENTER_PACK_ID_CONFLICT')
  await writePack(join(vendorRoot, 'another-copy'), await readPack(fixtureV1))
  await rejectsCode(resolveManagedRuntimePack(fakeCtx(), config, await basePack()), 'CENTER_PACK_ID_CONFLICT')
})

test('preflight accepts a pending state transaction without mutating it or consulting provider', async () => {
  const local = await snapshot()
  const item = local.packs[0]
  const state = emptyPackCenterState()
  state.installed[item.releaseId] = { releaseId: item.releaseId, packId: item.packId, version: '1.0.0',
    artifactSha256: 'a'.repeat(64), contentTreeSha256: item.contentTreeSha256, packPath: item.root,
    installedAt: '2026-09-19T00:00:00.000Z', source: 'legacy' }
  state.active[item.packId] = item.releaseId
  const before = structuredClone(state)
  await preflightManagedActivation(fakeCtx(), { ...selected, getPackCenterSnapshot: () => { throw new Error('not a state read') } }, [await basePack()], state)
  assert.deepEqual(state, before)
  assert.equal(Object.isFrozen(state), false)
})

test('pure v2 runtime dependency graph never imports the host bridge', async () => {
  const text = await readFile(new URL('../src/v2/runtime-pack.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(text, /from\s+['"][^'"]*host\//)
})
