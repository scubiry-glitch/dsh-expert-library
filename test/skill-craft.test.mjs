import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, open } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createInstalledSkillCraftPack, resealInstalledSkillCraftPack } from './support/skill-craft-fixture.mjs'
import { hashContentDirectory } from '../packages/pack-contract/index.mjs'
const source = process.env.SKILL_CRAFT_TEST_SOURCE === '1'
const { isSkillCraftSelection, isFrozenSkillCraftContract, resolveSelectedSkillContract, resolveSelectedSkillMaterials, verifyFrozenSkillCraftContract, listScopedSkillCraftCatalog } = await import(source ? '../src/skill-craft.ts' : '../lib/skill-craft.js')
const { canonicalJson } = await import(source ? '../src/v2/pack-loader.ts' : '../lib/v2/pack-loader.js')
const { validateDomainPack } = await import(source ? '../src/v2/validate.ts' : '../lib/v2/validate.js')
const hash = x => createHash('sha256').update(x).digest('hex')
const cfg = { packsDir: 'domain-packs' }
// Any accidental session/workspace/global-registry scan makes the test fail.
const ctx = { get() { throw new Error('global registry must not be read') } }
async function fixture(t, options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'scoped-skill-craft-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const root = join(workspace, 'domain-packs', options.packId ?? 'synthetic-craft')
  const built = await createInstalledSkillCraftPack(root, options)
  return { workspace, ...built, resolve: selections => resolveSelectedSkillContract(ctx, cfg, workspace, selections ?? built.selections) }
}
const modifyJson = async (path, fn) => { const v = JSON.parse(await readFile(path, 'utf8')); fn(v); await writeFile(path, JSON.stringify(v)) }

test('AI selection schema never accepts caller-provided paths, hashes, defaults or empty reasons', () => {
  const valid = { packId: 'pack', skillId: 'compose', reason: 'Needed for this report' }
  assert.equal(isSkillCraftSelection(valid), true)
  for (const value of [null, {}, { ...valid, root: '/tmp' }, { ...valid, digest: 'a'.repeat(64) }, { ...valid, skillId: '../escape' }, { ...valid, reason: '' }, { ...valid, variant: '' }]) assert.equal(isSkillCraftSelection(value), false)
})
test('optional craft declaration is strict, safe and leaves legacy manifests valid', async t => {
  const f = await fixture(t)
  assert.equal(validateDomainPack(f.pack).ok, true)
  for (const craft of [{ path: '/etc/passwd' }, { path: '../outside.json' }, { path: 'a\\b.json' }, { path: 'craft/a.json', extra: true }, {}]) {
    const p = structuredClone(f.pack); p.skillPackages[0].craft = craft
    assert.equal(validateDomainPack(p).ok, false, JSON.stringify(craft))
  }
  const p = structuredClone(f.pack); delete p.skillPackages[0].craft; assert.equal(validateDomainPack(p).ok, true)
})
test('only current-workspace enabled roots form the metadata catalog; global trees are never scanned', async t => {
  const f = await fixture(t, { packId: 'allowed', skills: [{ id: 'compose', body: 'BODY-MUST-NOT-BE-IN-CATALOG' }] })
  const foreign = await fixture(t, { packId: 'foreign' })
  await createInstalledSkillCraftPack(join(f.workspace, 'domain-packs', 'disabled'), { packId: 'disabled' })
  const catalog = await listScopedSkillCraftCatalog(ctx, { ...cfg, enabledPacks: ['allowed'] }, f.workspace)
  assert.deepEqual(catalog.map(c => c.packId), ['allowed']); assert.equal(catalog[0].path, join(f.root, 'skills/compose/SKILL.md'))
  assert.doesNotMatch(JSON.stringify(catalog), /BODY-MUST-NOT-BE-IN-CATALOG/)
  await assert.rejects(f.resolve(foreign.selections), /UNAVAILABLE/)
  await assert.rejects(resolveSelectedSkillContract(ctx, { ...cfg, enabledPacks: ['disabled'] }, f.workspace, f.selections), /UNAVAILABLE/)
})
test('two differently named domain packages and skills resolve reproducibly without domain constants', async t => {
  const f = await fixture(t, { packId: 'arbitrary-domain', skills: [{ id: 'local-writing' }] })
  const other = await createInstalledSkillCraftPack(join(f.workspace, 'domain-packs', 'another-domain'), { packId: 'another-domain', skills: [{ id: 'layout' }] })
  const selected = [...f.selections, ...other.selections]
  const a = await f.resolve(selected), b = await f.resolve(selected)
  assert.equal(a.digest, b.digest); assert.equal(isFrozenSkillCraftContract(a), true); assert.equal(Object.isFrozen(a), true)
  assert.equal(a.packs.length, 2); assert.equal(a.checks.length, 2)
  for (const role of ['writer', 'renderer', 'reviewer']) {
    const packet = resolveSelectedSkillMaterials(a, role)
    assert.equal(packet.selectionDigest, a.digest); assert.equal(packet.bytes, Buffer.byteLength(packet.content))
    assert.ok(packet.bytes <= 24576)
    for (const e of packet.entries) { assert.equal(isAbsolute(e.path), true); assert.ok(packet.content.includes(e.content)); assert.equal(hash(await readFile(e.path)), e.sha256) }
  }
  const changed = selected.map(s => ({ ...s, reason: s.reason + ' changed' }))
  assert.notEqual((await f.resolve(changed)).digest, a.digest)
})
test('dependencies and variants must be selected explicitly, never auto-added or guessed', async t => {
  const f = await fixture(t, { skills: [{ id: 'compose' }, { id: 'layout', requires: ['compose'], variants: { paper: { description: 'Paper reading' }, compact: { description: 'Compact reading' } }, variant: 'paper' }] })
  await assert.rejects(f.resolve([f.selections[1]]), /DEPENDENCY.*explicit AI selection/)
  const { variant, ...missingVariant } = f.selections[1]
  await assert.rejects(f.resolve([f.selections[0], missingVariant]), /VARIANT/)
  await assert.rejects(f.resolve([f.selections[0], { ...f.selections[1], variant: 'invented' }]), /VARIANT/)
  const c = await f.resolve(); assert.deepEqual(c.selections.map(s => s.skillId), ['compose', 'layout'])
  const catalog = await listScopedSkillCraftCatalog(ctx, cfg, f.workspace)
  assert.deepEqual(catalog.find(s => s.skillId === 'layout').requires, ['compose'])
})
test('conflicting selected skills and duplicate selections are rejected', async t => {
  const f = await fixture(t, { skills: [{ id: 'compose', conflicts: ['layout'] }, { id: 'layout' }] })
  await assert.rejects(f.resolve(), /CONFLICT/)
  await assert.rejects(f.resolve([f.selections[0], f.selections[0]]), /duplicate selected skill/)
})
test('check/result IDs remain unique across the entire selected contract', async t => {
  const f = await fixture(t, { skills: [{ id: 'one', resultIds: ['same'] }, { id: 'two', resultIds: ['same'] }] })
  await assert.rejects(f.resolve(), /CONFLICT.*duplicate check or result/)
})
test('artifact coverage is explicit, composed by union, and never defaulted to all output formats', async t => {
  const f = await fixture(t, { skills: [{ id: 'writing', artifactRoles: ['md', 'evidence'] }, { id: 'layout', artifactRoles: ['html', 'pdf'], requires: ['writing'] }] })
  const writing = await f.resolve([f.selections[0]])
  assert.deepEqual(writing.artifactRoles, ['md', 'evidence'])
  const both = await f.resolve(); assert.deepEqual(both.artifactRoles, ['md', 'html', 'pdf', 'evidence'])
  const catalog = await listScopedSkillCraftCatalog(ctx, cfg, f.workspace)
  assert.deepEqual(catalog.find(s => s.skillId === 'layout').artifactRoles, ['html', 'pdf'])
  await modifyJson(join(f.root, 'craft/writing.json'), d => { delete d.artifactRoles })
  await assert.rejects(f.resolve([f.selections[0]]), /DECLARATION/)
})
test('declared entrypoint without a Node module suffix is not admitted as an arbitrary command', async t => {
  const f = await fixture(t)
  await modifyJson(join(f.root, 'craft/compose.json'), d => { d.checks[0].entrypoint = 'skills/compose/scripts/run.sh' })
  await assert.rejects(f.resolve(), /DECLARATION/)
})
test('captured enabled selection stays stable if Host settings mutate during snapshot await', async t => {
  const f = await fixture(t), config = { packsDir: 'domain-packs', enabledPacks: [f.packId] }
  config.getPackCenterSnapshot = async () => { config.enabledPacks = ['other']; config.packsDir = 'unrelated'; return { generation: 1, packs: [], suppressedLegacyPaths: [] } }
  const c = await resolveSelectedSkillContract(ctx, config, f.workspace, f.selections)
  assert.equal(c.packs[0].packId, f.packId)
})
test('runner must be explicitly permitted by the owning skill and inside that skill root', async t => {
  const f = await fixture(t, { skills: [{ id: 'compose', execScripts: [] }] })
  await assert.rejects(f.resolve(), /RUNNER_PERMISSION/)
  await assert.rejects(listScopedSkillCraftCatalog(ctx, cfg, f.workspace), /RUNNER_PERMISSION/)
})
test('unchosen variants are not injected but remain protected by the complete pack digest', async t => {
  const f = await fixture(t, { skills: [{ id: 'compose', variants: { a: { description: 'A' }, b: { description: 'B' } }, variant: 'a', materials: [{ id: 'a', path: 'references/compose.md', roles: ['writer'], variants: ['a'] }, { id: 'b', path: 'references/other.md', roles: ['writer'], variants: ['b'] }] }] })
  await writeFile(join(f.root, 'references/other.md'), 'UNSELECTED_VARIANT_BODY')
  const c = await f.resolve(); const packet = resolveSelectedSkillMaterials(c, 'writer')
  assert.doesNotMatch(packet.content, /UNSELECTED_VARIANT_BODY/)
  await writeFile(join(f.root, 'references/other.md'), 'changed optional body')
  assert.throws(() => verifyFrozenSkillCraftContract(c), /PACK_DRIFT/)
})
test('shared pack-relative material bytes appear exactly once without dropping either selection', async t => {
  const f = await fixture(t, { skills: [{ id: 'one' }, { id: 'two', materials: [{ id: 'shared', path: 'references/one.md', roles: ['writer', 'renderer', 'reviewer'] }] }] })
  const c = await f.resolve(); const packet = resolveSelectedSkillMaterials(c, 'renderer')
  assert.equal(c.selections.length, 2); assert.equal(c.materials.length, 2); assert.equal(packet.entries.length, 1)
  assert.equal(packet.content.split(packet.entries[0].content).length - 1, 1)
})
test('material overflow fails closed with complete-body semantics, never truncates', async t => {
  const f = await fixture(t, { skills: [{ id: 'compose', body: 'x'.repeat(24577) }] })
  await assert.rejects(f.resolve(), /BUDGET/)
})
test('missing declared material and pack-relative escapes never fall back to global copies', async t => {
  const f = await fixture(t)
  await mkdir(join(f.workspace, 'knowledge/skills/compose'), { recursive: true })
  await writeFile(join(f.workspace, 'knowledge/skills/compose/SKILL.md'), 'wrong global fallback')
  await rm(join(f.root, 'references/compose.md')); await assert.rejects(f.resolve(), /MISSING/)
  await modifyJson(join(f.root, 'craft/compose.json'), d => { d.materials[0].path = '../../etc/passwd' })
  await assert.rejects(f.resolve(), /DECLARATION/)
})
test('symlinked pack resources are rejected before reading their external contents', async t => {
  const f = await fixture(t); await rm(join(f.root, 'references/compose.md'))
  await symlink('/etc/passwd', join(f.root, 'references/compose.md'))
  await assert.rejects(f.resolve(), /PATH.*symlink/)
})
test('skill source digest includes content and manifest permissions, not just availability identity', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'skills/compose/SKILL.md'), 'changed skill content')
  await assert.rejects(f.resolve(), /SKILL_DRIFT/)
  await resealInstalledSkillCraftPack(f.root); assert.equal(isFrozenSkillCraftContract(await f.resolve()), true)
})
test('cold verification refuses optional-pack drift, while historical schema remains readable without disk', async t => {
  const f = await fixture(t); const c = await f.resolve()
  await writeFile(join(f.root, 'new-optional-reference.md'), 'not selected, but protected by whole-tree identity')
  assert.equal(isFrozenSkillCraftContract(c), true); assert.throws(() => verifyFrozenSkillCraftContract(c), /PACK_DRIFT/)
  await rm(f.root, { recursive: true })
  assert.equal(isFrozenSkillCraftContract(c), true); assert.throws(() => verifyFrozenSkillCraftContract(c))
})
test('rehashed forged file binding passes neither live declaration verification nor source reconstruction', async t => {
  const f = await fixture(t); const original = await f.resolve(), c = structuredClone(original)
  c.materials[0].sha256 = 'a'.repeat(64); delete c.digest; c.digest = hash(canonicalJson(c))
  assert.equal(isFrozenSkillCraftContract(c), true)
  assert.throws(() => verifyFrozenSkillCraftContract(c), /CONTRACT_DRIFT/)
  const wrongDigest = { ...original, digest: 'a'.repeat(64) }; assert.equal(isFrozenSkillCraftContract(wrongDigest), false)
})
test('active center snapshot admits its exact fixed release outside workspace; other roots remain invisible', async t => {
  const f = await fixture(t), center = await fixture(t, { packId: 'managed', skills: [{ id: 'center-writing' }] })
  const rootHash = await hashContentDirectory(center.root)
  const managedConfig = { ...cfg, enabledPacks: ['not-the-local-pack'], getPackCenterSnapshot: async () => ({ generation: 4, packs: [{ packId: 'managed', releaseId: 'release-1', root: center.root, contentTreeSha256: rootHash.contentTreeSha256 }], suppressedLegacyPaths: [] }) }
  const c = await resolveSelectedSkillContract(ctx, managedConfig, f.workspace, center.selections)
  assert.equal(c.packs[0].releaseId, 'release-1'); assert.equal(c.packs[0].root, center.root)
  await writeFile(join(center.root, 'references/center-writing.md'), 'tampered')
  await assert.rejects(resolveSelectedSkillContract(ctx, managedConfig, f.workspace, center.selections), /PACK_DRIFT/)
})
test('duplicate active owner identities conflict instead of choosing a registry winner', async t => {
  const f = await fixture(t), duplicate = await fixture(t)
  const h = await hashContentDirectory(duplicate.root)
  await assert.rejects(listScopedSkillCraftCatalog(ctx, { ...cfg, getPackCenterSnapshot: async () => ({ generation: 1, packs: [{ packId: duplicate.packId, releaseId: 'release-2', root: duplicate.root, contentTreeSha256: h.contentTreeSha256 }], suppressedLegacyPaths: [] }) }, f.workspace), /AMBIGUOUS_PACK/)
})
test('large unrelated non-craft assets do not break a scoped craft catalog', async t => {
  const f = await fixture(t), large = await createInstalledSkillCraftPack(join(f.workspace, 'domain-packs', 'unrelated'), { packId: 'unrelated' })
  await modifyJson(join(large.root, 'pack.json'), p => { p.skillPackages = [] })
  const handle = await open(join(large.root, 'huge.bin'), 'w'); try { await handle.truncate(129 * 1024 * 1024) } finally { await handle.close() }
  const catalog = await listScopedSkillCraftCatalog(ctx, cfg, f.workspace)
  assert.deepEqual(catalog.map(s => s.packId), [f.packId])
})
test('workspace traversal and symlink pack roots are rejected', async t => {
  const f = await fixture(t), other = await fixture(t, { packId: 'elsewhere' })
  await assert.rejects(listScopedSkillCraftCatalog(ctx, { packsDir: '../domain-packs' }, f.workspace), /SCOPE/)
  await symlink(other.root, join(f.workspace, 'domain-packs', 'link'))
  await assert.rejects(listScopedSkillCraftCatalog(ctx, cfg, f.workspace), /SCOPE.*symlink/)
})
