/** Resolver component tests: no host state writes, server, network or complete task-lifetime claim. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashContentDirectory } from '../packages/pack-contract/index.mjs'

// The default full regression uses built modules. Targeted source runs do not overwrite lib/.
const sourceMode = process.env.PACK_CENTER_TEST_SOURCE === '1'
const moduleUrl = name => new URL(`../${sourceMode ? 'src' : 'lib'}/v2/${name}.${sourceMode ? 'ts' : 'js'}`, import.meta.url)
const { resolveRuntimePack, invalidateRuntimePack, RuntimeCenterPackError } = await import(moduleUrl('runtime-pack'))
const { compileExecutionPlan } = await import(moduleUrl('compiler'))
const { validateDomainPack } = await import(moduleUrl('validate'))

const fixture = name => fileURLToPath(new URL(`../examples/pack-center/${name}`, import.meta.url))
const sample = JSON.parse(await readFile(join(fixture('demo-v1'), 'pack.json'), 'utf8'))
const v1Label = '样例 V1'
const v2Label = '样例 V2'

function basePack() {
  const value = structuredClone(sample)
  value.pack = { id: 'builtin', version: '1.0.0', schemaVersion: 2, name: 'Builtin' }
  for (const key of Object.keys(value)) if (Array.isArray(value[key])) value[key] = []
  return value
}
function ctx(roots = []) {
  return { get(key) { return key === 'workspaceRegistry' ? { list: () => roots.map(path => ({ path })) } : undefined } }
}
async function temporary(t) {
  invalidateRuntimePack()
  const root = await mkdtemp(join(tmpdir(), 'center-runtime-'))
  t.after(async () => { invalidateRuntimePack(); await rm(root, { recursive: true, force: true }) })
  return root
}
async function packAt(root, { packId = 'demo.review', label = 'Local', version = '1.0.0' } = {}) {
  const value = structuredClone(sample)
  value.pack.id = packId; value.pack.version = version
  value.experts[0].display.publicLabel = label
  await mkdir(root, { recursive: true }); await writeFile(join(root, 'pack.json'), JSON.stringify(value))
  return root
}
async function active(root, releaseId = 'release-v1', packId = 'demo.review') {
  return { releaseId, packId, root, contentTreeSha256: (await hashContentDirectory(root)).contentTreeSha256 }
}
const selection = (packs, generation = 1, extra = {}) => ({
  packsDir: 'domain-packs', centerSnapshot: { generation, packs, suppressedLegacyPaths: [] }, ...extra,
})
function centerError(code) {
  return error => { assert.ok(error instanceof RuntimeCenterPackError); assert.equal(error.code, code); return true }
}
function label(result) { return result.pack.experts.find(expert => expert.id === 'demo.review.expert')?.display.publicLabel }
function compile(result) {
  return compileExecutionPlan({ pack: result.pack, templateId: 'demo.review.team', scenarioId: 'demo.review.scenario' })
}

test('only explicit center activation reaches the compiler; v2 selection leaves v1 result and plan intact', async t => {
  const root = await temporary(t)
  const v1 = join(root, 'inventory', 'v1'); const v2 = join(root, 'inventory', 'v2')
  await cp(fixture('demo-v1'), v1, { recursive: true }); await cp(fixture('demo-v2'), v2, { recursive: true })
  // Equal metadata mtimes cannot hide a fixed release/root/generation switch.
  for (const dir of [v1, v2]) await utimes(join(dir, 'pack.json'), new Date(0), new Date(0))
  const base = basePack()
  const inactive = await resolveRuntimePack(ctx([root]), selection([]), base)
  assert.equal(inactive.layers.length, 0)
  assert.equal(compile(inactive).ok, false)
  const first = await resolveRuntimePack(ctx([root]), selection([await active(v1)], 2), base)
  const oldPlan = compile(first)
  assert.equal(oldPlan.ok, true, JSON.stringify(oldPlan))
  assert.equal(oldPlan.plan.template.version, '1.0.0')
  assert.equal(label(first), v1Label)
  const next = await resolveRuntimePack(ctx([root]), selection([await active(v2, 'release-v2')], 3), base)
  const newPlan = compile(next)
  assert.equal(newPlan.ok, true, JSON.stringify(newPlan))
  assert.equal(label(next), v2Label)
  assert.equal(newPlan.plan.template.version, '1.1.0')
  assert.notEqual(newPlan.plan.digest, oldPlan.plan.digest)
  assert.equal(label(first), v1Label)
  assert.equal(oldPlan.plan.template.version, '1.0.0')
  assert.equal(first.centerSnapshot.packs[0].root, v1)
  assert.equal(next.centerSnapshot.packs[0].root, v2)
  assert.equal((await readFile(join(v1, 'pack.json'), 'utf8')).includes(v1Label), true)
  assert.equal(base.experts.length, 0)
})

test('empty snapshot disables all center packs even when files remain, and no snapshot auto-discovers no inventory', async t => {
  const root = await temporary(t)
  const dir = await packAt(join(root, 'inventory', 'v1'))
  const installed = await active(dir)
  const base = basePack()
  assert.equal((await resolveRuntimePack(ctx([root]), selection([installed], 1), base)).layers.length, 1)
  const disabled = await resolveRuntimePack(ctx([root]), selection([], 2), base)
  assert.deepEqual(disabled.centerSnapshot.packs, [])
  assert.deepEqual(disabled.layers, [])
  assert.equal(compile(disabled).ok, false)
  const noHostSnapshot = await resolveRuntimePack(ctx([root]), { packsDir: 'domain-packs' }, base)
  assert.equal(noHostSnapshot.centerSnapshot, undefined)
  assert.deepEqual(noHostSnapshot.layers, [])
})

test('legacy enabledPacks empty/absent means all while nonempty filters legacy only', async t => {
  const root = await temporary(t)
  await packAt(join(root, 'domain-packs', 'local'), { packId: 'local.pack', label: 'Workspace' })
  const centerDir = await packAt(join(root, 'inventory', 'center'), { label: 'Center' })
  const center = await active(centerDir)
  const base = basePack()
  for (const enabledPacks of [undefined, []]) {
    const result = await resolveRuntimePack(ctx([root]), selection([center], 1, { enabledPacks }), base)
    assert.equal(result.layers.length, 2)
    assert.equal(label(result), 'Workspace', 'Existing workspace overlay priority is retained')
  }
  const result = await resolveRuntimePack(ctx([root]), selection([center], 1, { enabledPacks: ['unrelated'] }), base)
  assert.equal(result.layers.length, 1)
  assert.equal(label(result), 'Center', 'Center activation does not use legacy enabledPacks')
})

test('suppression matches only exact real vendor paths, preserving same-ID workspace, sibling and builtin', async t => {
  const root = await temporary(t)
  const vendor = join(root, 'vendor')
  const replaced = await packAt(join(vendor, 'replaced'), { label: 'Replaced' })
  const sibling = await packAt(join(vendor, 'sibling'), { label: 'Sibling' })
  const workspace = await packAt(join(root, 'domain-packs', 'same-id'), { label: 'Workspace' })
  const alias = join(root, 'vendor-alias'); await symlink(vendor, alias)
  const base = basePack()
  base.pack.id = 'demo.review'
  base.experts = [{ ...structuredClone(sample.experts[0]), id: 'builtin.expert' }]
  const result = await resolveRuntimePack(ctx([root]), selection([], 1, {
    vendorPacksDir: alias,
    centerSnapshot: { generation: 1, packs: [], suppressedLegacyPaths: [join(alias, 'replaced'), workspace] },
  }), base)
  assert.deepEqual(result.layers.map(layer => layer.dir).sort(), [sibling, workspace].sort())
  assert.ok(!result.layers.some(layer => layer.dir === replaced))
  assert.ok(result.pack.experts.some(expert => expert.id === 'builtin.expert'))
  assert.equal(base.pack.id, 'demo.review')
  // Stopping center packs must not silently re-enable the suppressed legacy copy.
  assert.equal(result.centerSnapshot.packs.length, 0)
  assert.equal(result.centerSnapshot.suppressedLegacyPaths.length, 2)
})

test('cache identity includes vendor roots and discovered workspaces even with equal file mtimes', async t => {
  const root = await temporary(t)
  const workspaceA = join(root, 'workspace-a'); const workspaceB = join(root, 'workspace-b')
  const packA = await packAt(join(workspaceA, 'domain-packs', 'same'), { label: 'Workspace A' })
  const packB = await packAt(join(workspaceB, 'domain-packs', 'same'), { label: 'Workspace B' })
  const vendorA = join(root, 'vendor-a'); const vendorB = join(root, 'vendor-b')
  const vendoredA = await packAt(join(vendorA, 'same'), { label: 'Vendor A' })
  const vendoredB = await packAt(join(vendorB, 'same'), { label: 'Vendor B' })
  for (const dir of [packA, packB, vendoredA, vendoredB]) await utimes(join(dir, 'pack.json'), new Date(0), new Date(0))
  const base = basePack()
  const a = await resolveRuntimePack(ctx([workspaceA]), { packsDir: 'domain-packs' }, base)
  const b = await resolveRuntimePack(ctx([workspaceB]), { packsDir: 'domain-packs' }, base)
  assert.equal(label(a), 'Workspace A'); assert.equal(label(b), 'Workspace B')
  const va = await resolveRuntimePack(ctx(), { packsDir: 'domain-packs', vendorPacksDir: vendorA }, base)
  const vb = await resolveRuntimePack(ctx(), { packsDir: 'domain-packs', vendorPacksDir: vendorB }, base)
  assert.equal(label(va), 'Vendor A'); assert.equal(label(vb), 'Vendor B')
})

test('cached center results reverify tree integrity and never hide tampering behind unchanged mtimes', async t => {
  const root = await temporary(t)
  const dir = await packAt(join(root, 'center'), { label: 'Original' })
  const center = await active(dir)
  const config = selection([center])
  const base = basePack()
  const first = await resolveRuntimePack(ctx(), config, base)
  assert.strictEqual(await resolveRuntimePack(ctx(), config, base), first)
  const file = join(dir, 'pack.json'); const original = await readFile(file)
  await writeFile(file, Buffer.concat([original, Buffer.from('\n')]))
  await utimes(file, new Date(0), new Date(0))
  await assert.rejects(resolveRuntimePack(ctx(), config, base), centerError('CENTER_INTEGRITY_MISMATCH'))
  assert.equal(label(first), 'Original')
  await writeFile(file, original)
  assert.strictEqual(await resolveRuntimePack(ctx(), config, base), first)
})

test('result snapshots are deeply frozen and detached without freezing or rewriting caller base or selection', async t => {
  const root = await temporary(t)
  const dir = await packAt(join(root, 'center'))
  const config = selection([await active(dir)])
  const base = basePack()
  const originalBase = structuredClone(base)
  const result = await resolveRuntimePack(ctx(), config, base)
  assert.ok(Object.isFrozen(result))
  assert.ok(Object.isFrozen(result.pack.experts[0].display))
  assert.ok(Object.isFrozen(result.centerSnapshot.packs[0]))
  assert.ok(Object.isFrozen(result.layers))
  assert.deepEqual(base, originalBase)
  assert.equal(Object.isFrozen(base), false)
  assert.equal(Object.isFrozen(base.pack), false)
  assert.equal(Object.isFrozen(config.centerSnapshot.packs[0]), false)
  assert.throws(() => { result.pack.experts[0].display.publicLabel = 'Changed' }, TypeError)
  assert.throws(() => { result.centerSnapshot.packs[0].root = '/other' }, TypeError)
  base.pack.name = 'Changed caller base'
  config.centerSnapshot.packs[0].releaseId = 'caller-changed'
  assert.equal(result.pack.pack.name, 'Builtin')
  assert.equal(result.centerSnapshot.packs[0].releaseId, 'release-v1')
  const after = await resolveRuntimePack(ctx(), config, base)
  assert.equal(after.pack.pack.name, 'Changed caller base')
  assert.equal(after.centerSnapshot.packs[0].releaseId, 'caller-changed')
  assert.notStrictEqual(after, result)
})

test('center generation, release digest and roots each participate in cache selection', async t => {
  const root = await temporary(t)
  const dirA = await packAt(join(root, 'a'), { label: 'One' })
  const dirB = await packAt(join(root, 'b'), { label: 'One' })
  const a = await active(dirA)
  const base = basePack()
  const first = await resolveRuntimePack(ctx(), selection([a], 1), base)
  const nextGeneration = await resolveRuntimePack(ctx(), selection([a], 2), base)
  assert.notStrictEqual(first, nextGeneration)
  const nextPath = await resolveRuntimePack(ctx(), selection([{ ...a, root: dirB }], 1), base)
  assert.notStrictEqual(first, nextPath)
  assert.equal(nextPath.layers[0].dir, dirB)
  await packAt(dirA, { label: 'Two' })
  const changed = await active(dirA)
  const nextDigest = await resolveRuntimePack(ctx(), selection([changed], 1), base)
  assert.notStrictEqual(first, nextDigest)
  assert.equal(label(nextDigest), 'Two')
  assert.equal(label(first), 'One')
})

test('invalid center schema, mismatched identity and unsafe or missing roots are explicit failures', async t => {
  const root = await temporary(t)
  const good = await packAt(join(root, 'good'))
  const entry = await active(good)
  const base = basePack()
  await assert.rejects(resolveRuntimePack(ctx(), selection([{ ...entry, packId: 'other.pack' }]), base), centerError('CENTER_PACK_ID_MISMATCH'))
  const invalid = join(root, 'invalid'); await cp(fixture('invalid'), invalid, { recursive: true })
  await assert.rejects(resolveRuntimePack(ctx(), selection([await active(invalid)]), base), centerError('CENTER_PACK_INVALID'))
  await assert.rejects(resolveRuntimePack(ctx(), selection([{ ...entry, root: join(root, 'missing') }]), base), centerError('CENTER_PACK_UNAVAILABLE'))
  const linked = join(root, 'linked'); await symlink(good, linked)
  await assert.rejects(resolveRuntimePack(ctx(), selection([{ ...entry, root: linked }]), base), centerError('CENTER_PACK_UNAVAILABLE'))
})

test('malformed center snapshots and duplicate activations cannot be interpreted as an empty selection', async t => {
  const root = await temporary(t)
  const entry = await active(await packAt(join(root, 'center')))
  const base = basePack()
  for (const snapshot of [
    null, {}, { generation: -1, packs: [], suppressedLegacyPaths: [] },
    { generation: 1, packs: null, suppressedLegacyPaths: [] },
    { generation: 1, packs: [entry, entry], suppressedLegacyPaths: [] },
    { generation: 1, packs: [{ ...entry, root: './relative' }], suppressedLegacyPaths: [] },
    { generation: 1, packs: [{ ...entry, contentTreeSha256: 'wrong' }], suppressedLegacyPaths: [] },
    { generation: 1, packs: [], suppressedLegacyPaths: ['../vendor'] },
  ]) await assert.rejects(resolveRuntimePack(ctx(), { packsDir: 'domain-packs', centerSnapshot: snapshot }, base), centerError('CENTER_SNAPSHOT_INVALID'))
})

test('center merge order is stable by pack identity independent of input order and asynchronous loading', async t => {
  const root = await temporary(t)
  const a = await active(await packAt(join(root, 'a'), { packId: 'a.pack', label: 'A' }), 'release-a', 'a.pack')
  const z = await active(await packAt(join(root, 'z'), { packId: 'z.pack', label: 'Z' }), 'release-z', 'z.pack')
  const base = basePack()
  const first = await resolveRuntimePack(ctx(), selection([z, a]), base)
  const second = await resolveRuntimePack(ctx(), selection([a, z]), base)
  assert.equal(label(first), 'Z')
  assert.strictEqual(first, second)
  assert.deepEqual(first.centerSnapshot.packs.map(pack => pack.packId), ['a.pack', 'z.pack'])
  assert.equal(validateDomainPack(first.pack).ok, true)
})

test('individually valid center and workspace packs that invalidate the merged graph fail closed', async t => {
  const root = await temporary(t)
  const centerDir = join(root, 'center')
  const centerPack = structuredClone(sample)
  centerPack.teamTemplates[0].gates = [{ policy: 'demo.review.quality', gate: 'schema' }]
  assert.equal(validateDomainPack(centerPack).ok, true)
  await mkdir(centerDir, { recursive: true })
  await writeFile(join(centerDir, 'pack.json'), JSON.stringify(centerPack))
  const entry = await active(centerDir)
  const base = basePack()
  const validResult = await resolveRuntimePack(ctx([root]), selection([entry]), base)
  assert.equal(label(validResult), v1Label)

  const localPack = basePack()
  localPack.pack.id = 'local.policy'
  localPack.qualityPolicies = structuredClone(sample.qualityPolicies)
  localPack.qualityPolicies[0].gates[0].id = 'replacement-gate'
  assert.equal(validateDomainPack(localPack).ok, true)
  const localDir = join(root, 'domain-packs', 'policy')
  await mkdir(localDir, { recursive: true })
  await writeFile(join(localDir, 'pack.json'), JSON.stringify(localPack))
  await assert.rejects(resolveRuntimePack(ctx([root]), selection([entry]), base), error => {
    assert.equal(centerError('CENTER_MERGE_INVALID')(error), true)
    assert.ok(error.diagnostics.some(item => item.code === 'dangling-reference' && item.path.endsWith('.gate')))
    return true
  })
  assert.equal(label(validResult), v1Label, 'A failed new resolve does not rewrite the previous snapshot')
  const disabledLocal = await resolveRuntimePack(ctx([root]), selection([entry], 2, { enabledPacks: ['another'] }), base)
  assert.equal(label(disabledLocal), v1Label)
})

test('caller changes while resolving cannot rewrite the captured base, activation or legacy selection', async t => {
  const root = await temporary(t)
  const centerDir = await packAt(join(root, 'center'), { label: 'Captured center' })
  await packAt(join(root, 'domain-packs', 'local'), { packId: 'local.pack', label: 'Local' })
  const base = basePack()
  const config = selection([await active(centerDir)], 7, { enabledPacks: ['another'], packPriority: ['local.pack'] })
  const pending = resolveRuntimePack(ctx([root]), config, base)
  base.pack.name = 'Later base'
  config.centerSnapshot.generation = 8
  config.centerSnapshot.packs[0].root = join(root, 'not-present')
  config.enabledPacks.push('local.pack')
  config.packPriority.push('other.pack')
  const result = await pending
  assert.equal(result.pack.pack.name, 'Builtin')
  assert.equal(result.centerSnapshot.generation, 7)
  assert.equal(result.centerSnapshot.packs[0].root, centerDir)
  assert.equal(label(result), 'Captured center')
  assert.equal(result.layers.length, 1)
})

test('legacy invalid packs still return diagnostics, cache invalidation still works and center resolver stays local', async t => {
  const root = await temporary(t)
  const broken = join(root, 'domain-packs', 'broken')
  await mkdir(broken, { recursive: true }); await writeFile(join(broken, 'pack.json'), '{"id":"broken"}')
  const first = await resolveRuntimePack(ctx([root]), { packsDir: 'domain-packs' }, basePack())
  assert.equal(first.pack.pack.id, 'builtin')
  assert.ok(first.diagnostics.some(diagnostic => diagnostic.severity === 'error'))
  invalidateRuntimePack()
  const second = await resolveRuntimePack(ctx([root]), { packsDir: 'domain-packs' }, basePack())
  assert.notStrictEqual(first, second)
  const source = await readFile(new URL('../src/v2/runtime-pack.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\bfetch\s*\(|node:(?:https?|net|dns|tls|http2)\b|from\s+['"][^'"]*\/host\//)
  assert.doesNotMatch(source, /\b(?:writeFile|rename|unlink|rm)\s*\(/)
})
