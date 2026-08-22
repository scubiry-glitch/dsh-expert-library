/**
 * pack-loader regression tests: local Domain Pack loading (JSON file /
 * directory layout), deterministic overlay merging (builtin < domain-pack <
 * workspace < request), and local SkillPackage loading (digest re-verification,
 * lazy media integrity, script declarations, no-license default).
 *
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  packFromJson,
  loadPackFromDir,
  loadPackFromFile,
  mergePackLayers,
  loadSkillPackageFromDir,
  hashPackageTree,
  canonicalSkillDigest,
  canonicalManifestDigest,
  canonicalJson,
  sha256Of,
  compareVersions,
  isSafeRelativePath,
  sortLayersByPrecedence,
  OVERLAY_LAYER_ORDER,
} from '../lib/v2/index.js'
import { validateDomainPack } from '../lib/v2/index.js'

/** A minimal, fully validator-clean pack used as the merge/fixture base. */
function validPack(overrides = {}) {
  return {
    pack: { id: 'demo', version: '1.0.0', schemaVersion: 2, name: 'Demo' },
    experts: [
      expert('ex-a', '1.0.0'),
      expert('ex-b', '1.0.0'),
    ],
    teamTemplates: [
      {
        id: 'tpl-1', version: '1.0.0', schemaVersion: 2,
        slots: [{ id: 'role.a', capabilities: ['demo.cap'], cardinality: { min: 1, max: 1 } }],
        tasks: [{ id: 't1', role: 'role.a', dependsOn: [], inputs: [], allowedCapabilities: [], outputSchema: 'out-1', retryPolicy: 'never' }],
        gates: [],
        deliverables: [{ id: 'd1', outputTemplate: 'out-1', fromTasks: ['t1'] }],
      },
    ],
    outputTemplates: [
      { id: 'out-1', version: '1.0.0', schemaVersion: 2, media: ['markdown'], sections: [{ id: 's1', required: true }], renderModes: { final: { anonymize: false } } },
    ],
    qualityPolicies: [
      { id: 'q-1', version: '1.0.0', schemaVersion: 2, gates: [{ id: 'schema', kind: 'deterministic', appliesTo: ['s1'], severity: 'hard' }], maxRepairRounds: 2 },
    ],
    scenarios: [
      {
        id: 'scn-1', version: '1.0.0', schemaVersion: 2, domain: 'demo', intents: ['x'],
        requiredCapabilities: [], routingPolicy: { candidateHints: ['ex-a'] },
        teamTemplate: 'tpl-1', outputTemplate: 'out-1', qualityPolicy: 'q-1',
        knowledgePolicy: { required: [] }, toolPolicy: { allowed: [] },
      },
    ],
    toolProviders: [],
    knowledgeProviders: [],
    domainKnowledge: [],
    methodPacks: [],
    skillPackages: [],
    ...overrides,
  }
}

function expert(id, version, displayName = id.toUpperCase()) {
  return {
    id, version, schemaVersion: 2,
    display: { internalName: displayName, publicLabel: `P${displayName}`, initials: displayName.slice(0, 1) },
    domains: ['demo'],
    capabilities: [{ capability: 'demo.cap', proficiency: 3, coverage: 'medium' }],
    persona: {}, methods: [], knowledgeBindings: [], toolAffinities: [], compliance: {},
  }
}

/** Temp-dir helper that always cleans up. */
async function withTmp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'pack-loader-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Write a skill package fixture under `root` and return its directory. */
async function writeSkillFixture(root, name = 'skill', { license = 'MIT', lazyMedia = true, scripts = ['scripts/check.mjs'], kind = 'workspace', sourceRoot = 'skills/demo-skill', content = 'line one\nline two\n' } = {}) {
  const skillDir = join(root, name)
  await mkdir(join(skillDir, 'references'), { recursive: true })
  await mkdir(join(skillDir, 'scripts'), { recursive: true })
  await mkdir(join(skillDir, 'media'), { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), '# Demo skill\n' + content, 'utf8')
  await writeFile(join(skillDir, 'references', 'guide.md'), '## Guide\n' + content, 'utf8')
  await writeFile(join(skillDir, 'scripts', 'check.mjs'), 'export const check = () => true\n', 'utf8')
  const mediaPath = join(skillDir, 'media', 'clip.mp4')
  await writeFile(mediaPath, Buffer.from('fake-mp4-bytes-' + content))
  const mediaBytes = (await stat(mediaPath)).size
  const mediaHash = sha256Of(await readFile(mediaPath))
  // The canonical package digest covers the tree (except skill.json) PLUS the
  // canonicalized manifest (source.digest omitted, keys sorted), so manifest
  // tampering is detected too. Built from the manifest without a digest.
  const manifestBase = {
    schemaVersion: 2,
    id: 'demo-skill',
    version: '1.0.0',
    source: { kind, root: sourceRoot, ...(license === null ? {} : { license }) },
    contributions: { methodPacks: [] },
    ...(lazyMedia ? { lazyMedia: [{ path: 'media/clip.mp4', bytes: mediaBytes, sha256: mediaHash }] } : {}),
    permissions: { execScripts: scripts },
  }
  const digest = await canonicalSkillDigest(skillDir, manifestBase, { manifestName: 'skill.json' })
  const manifest = { ...manifestBase, source: { ...manifestBase.source, digest } }
  await writeFile(join(skillDir, 'skill.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return { skillDir, manifest, mediaBytes, mediaHash }
}

// --- packFromJson (pure) -----------------------------------------------------

test('packFromJson accepts a complete pack and records the source', () => {
  const result = packFromJson(validPack(), { layer: 'builtin', label: 'builtin-demo' })
  assert.equal(result.ok, true)
  assert.equal(result.pack?.experts.length, 2)
  assert.equal(result.source.layer, 'builtin')
  assert.equal(result.source.label, 'builtin-demo')
  assert.equal(result.diagnostics.filter(d => d.severity === 'error').length, 0)
})

test('packFromJson rejects an invalid pack with validator diagnostics', () => {
  const pack = validPack()
  pack.experts.push(pack.experts[0]) // duplicate id
  const result = packFromJson(pack, { layer: 'request', label: 'bad' })
  assert.equal(result.ok, false)
  assert.equal(result.pack, undefined)
  assert.ok(result.diagnostics.some(d => d.code === 'duplicate-id'))
})

// --- Directory layout --------------------------------------------------------

test('loadPackFromDir assembles sections from per-entity files (kebab dirs)', async () => {
  await withTmp(async root => {
    await writeFile(join(root, 'pack.json'), JSON.stringify({ id: 'dir-pack', version: '1.0.0', schemaVersion: 2, name: 'Dir' }), 'utf8')
    await mkdir(join(root, 'experts'))
    await writeFile(join(root, 'experts', 'ex-a.json'), JSON.stringify(expert('ex-a', '1.0.0')), 'utf8')
    await mkdir(join(root, 'team-templates'))
    await writeFile(join(root, 'team-templates', 'tpl-1.json'), JSON.stringify(validPack().teamTemplates[0]), 'utf8')
    await mkdir(join(root, 'output-templates'))
    await writeFile(join(root, 'output-templates', 'out-1.json'), JSON.stringify(validPack().outputTemplates[0]), 'utf8')
    await mkdir(join(root, 'quality-policies'))
    await writeFile(join(root, 'quality-policies', 'q-1.json'), JSON.stringify(validPack().qualityPolicies[0]), 'utf8')
    await mkdir(join(root, 'scenarios'))
    await writeFile(join(root, 'scenarios', 'scn-1.json'), JSON.stringify(validPack().scenarios[0]), 'utf8')
    const result = await loadPackFromDir(root, { layer: 'domain-pack', label: 'dir-pack' })
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
    assert.equal(result.pack?.experts[0].id, 'ex-a')
    assert.equal(result.pack?.teamTemplates[0].id, 'tpl-1')
    assert.equal(result.pack?.scenarios[0].teamTemplate, 'tpl-1')
    assert.equal(result.source.root, await (await import('node:fs/promises')).realpath(root))
  })
})

test('loadPackFromDir supports index.json array sections and warns on filename/id mismatch', async () => {
  await withTmp(async root => {
    await writeFile(join(root, 'pack.json'), JSON.stringify({ id: 'dir-pack', version: '1.0.0', schemaVersion: 2, name: 'Dir' }), 'utf8')
    // per-entity section WITHOUT index.json — file name says ex-b but the entity id is ex-c
    await mkdir(join(root, 'experts'))
    await writeFile(join(root, 'experts', 'ex-a.json'), JSON.stringify(expert('ex-a', '1.0.0')), 'utf8')
    await writeFile(join(root, 'experts', 'ex-b.json'), JSON.stringify(expert('ex-c', '1.0.0', 'C')), 'utf8')
    // index.json array section
    await mkdir(join(root, 'scenarios'))
    await writeFile(join(root, 'scenarios', 'index.json'), JSON.stringify([validPack().scenarios[0]]), 'utf8')
    // camelCase section dir with per-entity files
    await mkdir(join(root, 'teamTemplates'))
    await writeFile(join(root, 'teamTemplates', 'tpl-1.json'), JSON.stringify(validPack().teamTemplates[0]), 'utf8')
    await mkdir(join(root, 'outputTemplates'))
    await writeFile(join(root, 'outputTemplates', 'out-1.json'), JSON.stringify(validPack().outputTemplates[0]), 'utf8')
    await mkdir(join(root, 'qualityPolicies'))
    await writeFile(join(root, 'qualityPolicies', 'q-1.json'), JSON.stringify(validPack().qualityPolicies[0]), 'utf8')
    const result = await loadPackFromDir(root)
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
    // per-entity files: entity id wins over the file stem
    assert.deepEqual(result.pack?.experts.map(e => e.id).sort(), ['ex-a', 'ex-c'])
    assert.ok(result.diagnostics.some(d => d.code === 'filename-id-mismatch' && d.severity === 'warning'))
    // index.json array section loaded
    assert.equal(result.pack?.scenarios[0].id, 'scn-1')
    assert.equal(result.pack?.teamTemplates[0].id, 'tpl-1')
  })
})

test('loadPackFromDir accepts the full-pack pack.json form', async () => {
  await withTmp(async root => {
    await writeFile(join(root, 'pack.json'), JSON.stringify(validPack(), null, 2), 'utf8')
    const result = await loadPackFromDir(root, { layer: 'workspace', label: 'full' })
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
    assert.equal(result.pack?.experts.length, 2)
  })
})

test('loadPackFromFile reads a complete pack from disk', async () => {
  await withTmp(async root => {
    const file = join(root, 'pack.json')
    await writeFile(file, JSON.stringify(validPack()), 'utf8')
    const result = await loadPackFromFile(file)
    assert.equal(result.ok, true)
    assert.equal(result.pack?.pack.id, 'demo')
  })
})

// --- Symlink containment (M6) ------------------------------------------------

test('loadPackFromDir rejects a symlinked section directory escaping the pack root', async () => {
  await withTmp(async root => {
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'ex-a.json'), JSON.stringify(expert('ex-a', '1.0.0')), 'utf8')
    const packRoot = join(root, 'pack')
    await mkdir(packRoot)
    await writeFile(join(packRoot, 'pack.json'), JSON.stringify({ id: 'p', version: '1.0.0', schemaVersion: 2, name: 'P' }), 'utf8')
    await symlink(outside, join(packRoot, 'experts'))
    const result = await loadPackFromDir(packRoot)
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(d => d.code === 'symlink-escape' && d.path === 'pack.experts'))
  })
})

test('loadPackFromDir rejects a symlinked entity file escaping the pack root', async () => {
  await withTmp(async root => {
    const outside = join(root, 'outside.json')
    await writeFile(outside, JSON.stringify(expert('ex-evil', '1.0.0', 'EVIL')), 'utf8')
    const packRoot = join(root, 'pack')
    await mkdir(join(packRoot, 'experts'), { recursive: true })
    await writeFile(join(packRoot, 'pack.json'), JSON.stringify({ id: 'p', version: '1.0.0', schemaVersion: 2, name: 'P' }), 'utf8')
    await writeFile(join(packRoot, 'experts', 'ex-a.json'), JSON.stringify(expert('ex-a', '1.0.0')), 'utf8')
    await symlink(outside, join(packRoot, 'experts', 'ex-evil.json'))
    const result = await loadPackFromDir(packRoot)
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(d => d.code === 'symlink-escape' && d.path === 'pack.experts.ex-evil'))
  })
})

test('loadPackFromDir rejects a symlinked pack.json escaping the pack root', async () => {
  await withTmp(async root => {
    const outside = join(root, 'outside-pack.json')
    await writeFile(outside, JSON.stringify({ id: 'p', version: '1.0.0', schemaVersion: 2, name: 'P' }), 'utf8')
    const packRoot = join(root, 'pack')
    await mkdir(packRoot)
    await symlink(outside, join(packRoot, 'pack.json'))
    const result = await loadPackFromDir(packRoot)
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(d => d.code === 'symlink-escape' && d.path === 'pack.pack'))
  })
})

test('loadPackFromFile enforces optional allowedRoot containment', async () => {
  await withTmp(async root => {
    const allowed = join(root, 'allowed')
    await mkdir(allowed)
    const inside = join(allowed, 'pack.json')
    await writeFile(inside, JSON.stringify(validPack()), 'utf8')
    // a file inside the allowed root loads fine
    let result = await loadPackFromFile(inside, { layer: 'workspace', label: 'in' }, { allowedRoot: allowed })
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
    // a file outside the allowed root is rejected
    const outside = join(root, 'outside.json')
    await writeFile(outside, JSON.stringify(validPack()), 'utf8')
    result = await loadPackFromFile(outside, undefined, { allowedRoot: allowed })
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(d => d.code === 'file-escape'))
    // a symlinked file resolving outside the allowed root is rejected
    await symlink(outside, join(allowed, 'link.json'))
    result = await loadPackFromFile(join(allowed, 'link.json'), undefined, { allowedRoot: allowed })
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(d => d.code === 'file-escape'))
  })
})

// --- Overlay merge -----------------------------------------------------------

test('mergePackLayers applies builtin < domain-pack < workspace < request', () => {
  const builtin = validPack()
  const domainPack = validPack({
    pack: { id: 'dp', version: '1.0.0', schemaVersion: 2, name: 'DP' },
    experts: [expert('ex-a', '1.5.0')],
  })
  const workspace = validPack({
    pack: { id: 'ws', version: '1.0.0', schemaVersion: 2, name: 'WS' },
    experts: [expert('ex-a', '0.9.0'), expert('ex-b', '2.0.0')],
  })
  const request = validPack({
    pack: { id: 'req', version: '1.0.0', schemaVersion: 2, name: 'Req' },
    experts: [expert('ex-c', '1.0.0', 'C')],
  })
  const result = mergePackLayers([
    { pack: workspace, layer: 'workspace' },
    { pack: request, layer: 'request' },
    { pack: builtin, layer: 'builtin' },
    { pack: domainPack, layer: 'domain-pack' },
  ])
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
  const byId = new Map(result.pack.experts.map(e => [e.id, e.version]))
  assert.equal(byId.get('ex-a'), '0.9.0')  // workspace wins over domain-pack
  assert.equal(byId.get('ex-b'), '2.0.0')  // workspace wins over builtin
  assert.equal(byId.get('ex-c'), '1.0.0')  // request adds
  // First-appearance order preserved: ex-a, ex-b (builtin positions), ex-c appended.
  assert.deepEqual(result.pack.experts.map(e => e.id), ['ex-a', 'ex-b', 'ex-c'])
  // Replacements recorded once per id; downgrade flagged for ex-a.
  assert.ok(result.replacements.includes('experts:ex-a'))
  assert.ok(result.replacements.includes('experts:ex-b'))
  assert.ok(result.diagnostics.some(d => d.code === 'overlay-replace'))
  assert.ok(result.diagnostics.some(d => d.code === 'overlay-downgrade' && d.path.includes('ex-a')))
  // The merged pack still validates as a whole (cross-layer refs resolve).
  assert.equal(validateDomainPack(result.pack).ok, true)
})

test('mergePackLayers is deterministic and independent of input order', () => {
  const layers = [
    { pack: validPack(), layer: 'builtin' },
    { pack: validPack({ pack: { id: 'dp', version: '1.0.0', schemaVersion: 2, name: 'DP' }, experts: [expert('ex-a', '1.5.0')] }), layer: 'domain-pack' },
    { pack: validPack({ pack: { id: 'ws', version: '1.0.0', schemaVersion: 2, name: 'WS' }, experts: [expert('ex-b', '2.0.0')] }), layer: 'workspace' },
  ]
  const forward = mergePackLayers(layers)
  const shuffled = mergePackLayers([layers[2], layers[0], layers[1]])
  assert.deepEqual(shuffled.pack, forward.pack)
  assert.deepEqual(shuffled.diagnostics, forward.diagnostics)
  assert.deepEqual(shuffled.replacements, forward.replacements)
  // Idempotent: merging the merged pack again with itself is stable.
  const again = mergePackLayers([{ pack: forward.pack, layer: 'request' }])
  assert.deepEqual(again.pack, forward.pack)
})

test('mergePackLayers skips failed layers with a diagnostic', () => {
  const failed = { pack: undefined, source: { layer: 'workspace', label: 'broken' }, diagnostics: [], ok: false }
  const result = mergePackLayers([failed, { pack: validPack(), layer: 'builtin' }])
  assert.equal(result.ok, true)
  assert.equal(result.pack?.experts.length, 2)
  assert.ok(result.diagnostics.some(d => d.code === 'overlay-layer-skip' && d.severity === 'warning'))
})

test('sortLayersByPrecedence orders canonically and is stable', () => {
  const layers = [
    { layer: 'workspace', label: 'w' },
    { layer: 'builtin', label: 'b1' },
    { layer: 'request', label: 'r' },
    { layer: 'domain-pack', label: 'd' },
    { layer: 'builtin', label: 'b2' },
  ]
  assert.deepEqual(sortLayersByPrecedence(layers).map(l => l.label), ['b1', 'b2', 'd', 'w', 'r'])
  assert.deepEqual(OVERLAY_LAYER_ORDER, ['builtin', 'domain-pack', 'workspace', 'request'])
})

test('compareVersions compares numeric semver parts and is undefined for non-semver', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.2.3', '1.10.0'), -1)
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1) // rc < stable
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1) // stable > rc
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0) // build metadata ignored
  assert.equal(compareVersions('not-a-version', '1.0.0'), undefined)
})

test('compareVersions orders prereleases per semver (numeric, numeric < nonnumeric, list length)', () => {
  // numeric identifiers compare numerically (2 < 10), not lexically
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1)
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1)
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1)
  // numeric < alphanumeric
  assert.equal(compareVersions('1.0.0-2', '1.0.0-alpha'), -1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-2'), 1)
  // alphanumeric in ASCII order
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1)
  // longer list > shorter when prefixes are equal
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compareVersions('1.0.0-rc.1.1', '1.0.0-rc.1'), 1)
  // identical prereleases are equal
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.1'), 0)
})

test('overlay merge flags an rc as a downgrade of a stable release', () => {
  const builtin = validPack() // ex-a at 1.0.0
  const workspace = validPack({
    pack: { id: 'ws', version: '1.0.0', schemaVersion: 2, name: 'WS' },
    experts: [expert('ex-a', '1.0.0-rc.1')],
  })
  const result = mergePackLayers([
    { pack: builtin, layer: 'builtin' },
    { pack: workspace, layer: 'workspace' },
  ])
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
  assert.equal(result.pack?.experts[0].version, '1.0.0-rc.1')
  assert.ok(result.diagnostics.some(d => d.code === 'overlay-downgrade' && d.path.includes('ex-a')))
})

test('isSafeRelativePath rejects escapes and accepts local relative paths', () => {
  for (const safe of ['skills/demo', 'a/b-c.d', 'x', 'dir/sub/file.mjs']) {
    assert.equal(isSafeRelativePath(safe), true, safe)
  }
  for (const unsafe of ['../x', '/abs', 'C:\\x', '', 'a/../b', 'a//b', 'skills/./x', 'a b']) {
    assert.equal(isSafeRelativePath(unsafe), false, unsafe)
  }
})

// --- SkillPackage loading ----------------------------------------------------

test('loadSkillPackageFromDir verifies digest, lazy media and surfaces scripts', async () => {
  await withTmp(async root => {
    const { skillDir } = await writeSkillFixture(root)
    const result = await loadSkillPackageFromDir(skillDir)
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
    assert.equal(result.manifest?.source.kind, 'workspace')
    assert.equal(result.manifest?.source.license, 'MIT')
    assert.equal(result.resolvedScripts.length, 1)
    assert.equal(result.resolvedScripts[0].path, 'scripts/check.mjs')
    assert.equal(result.resolvedScripts[0].exists, true)
    assert.ok(typeof result.resolvedScripts[0].sha256 === 'string')
    // Lazy media was size/hash-validated; the digest was re-verified.
    assert.ok(!result.diagnostics.some(d => d.code.startsWith('digest') || d.code.startsWith('lazy-media')))
  })
})

test('loadSkillPackageFromDir rejects digest tampering', async () => {
  await withTmp(async root => {
    const { skillDir } = await writeSkillFixture(root)
    await writeFile(join(skillDir, 'references', 'guide.md'), '## Guide\nTAMPERED\n', 'utf8')
    const result = await loadSkillPackageFromDir(skillDir)
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(d => d.code === 'digest-mismatch'))
  })
})

test('loadSkillPackageFromDir rejects manifest tampering (contributions / execScripts)', async () => {
  await withTmp(async root => {
    const { skillDir } = await writeSkillFixture(root)
    // contributions changed only — content files untouched
    let manifest = JSON.parse(await readFile(join(skillDir, 'skill.json'), 'utf8'))
    manifest.contributions = { methodPacks: ['method-404'] }
    await writeFile(join(skillDir, 'skill.json'), JSON.stringify(manifest), 'utf8')
    let result = await loadSkillPackageFromDir(skillDir)
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(d => d.code === 'digest-mismatch'))
    // permissions.execScripts changed only
    manifest = JSON.parse(await readFile(join(skillDir, 'skill.json'), 'utf8'))
    manifest.permissions.execScripts = ['scripts/check.mjs', 'scripts/extra.mjs']
    await writeFile(join(skillDir, 'skill.json'), JSON.stringify(manifest), 'utf8')
    result = await loadSkillPackageFromDir(skillDir)
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(d => d.code === 'digest-mismatch'))
  })
})

test('loadSkillPackageFromDir verifies despite manifest key order (canonicalized)', async () => {
  await withTmp(async root => {
    const { skillDir } = await writeSkillFixture(root)
    // rewrite skill.json with shuffled top-level key order, same content
    const raw = JSON.parse(await readFile(join(skillDir, 'skill.json'), 'utf8'))
    const shuffled = {
      permissions: raw.permissions,
      source: raw.source,
      contributions: raw.contributions,
      version: raw.version,
      id: raw.id,
      schemaVersion: raw.schemaVersion,
      ...(raw.lazyMedia === undefined ? {} : { lazyMedia: raw.lazyMedia }),
    }
    await writeFile(join(skillDir, 'skill.json'), JSON.stringify(shuffled, null, 2), 'utf8')
    const result = await loadSkillPackageFromDir(skillDir)
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
  })
})

test('canonicalJson / canonicalManifestDigest are deterministic and key-order-insensitive', () => {
  const a = { b: 1, a: [2, { y: 1, x: 2 }], s: 'z' }
  const b = { s: 'z', a: [2, { x: 2, y: 1 }], b: 1 }
  assert.equal(canonicalJson(a), canonicalJson(b))
  assert.equal(canonicalManifestDigest(a), canonicalManifestDigest(b))
  // source.digest is omitted from the manifest digest (not circular)
  const withDigest = { ...a, source: { digest: 'd'.repeat(64), root: 'skills/demo' } }
  const withoutDigest = { ...a, source: { root: 'skills/demo' } }
  assert.equal(canonicalManifestDigest(withDigest), canonicalManifestDigest(withoutDigest))
  // digest changes when manifest content changes
  assert.notEqual(canonicalManifestDigest(a), canonicalManifestDigest({ ...a, b: 2 }))
})

test('loadSkillPackageFromDir forces internalOnly when license is missing', async () => {
  await withTmp(async root => {
    const { skillDir } = await writeSkillFixture(root, 'skill', { license: null })
    const result = await loadSkillPackageFromDir(skillDir)
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
    assert.equal(result.manifest?.permissions.internalOnly, true)
    assert.ok(result.diagnostics.some(d => d.code === 'unlicensed-internal-only-default' && d.severity === 'warning'))
    // The normalized manifest must pass the strict validator when embedded.
    const pack = validPack({ skillPackages: [result.manifest] })
    assert.equal(validateDomainPack(pack).ok, true)
  })
})

test('loadSkillPackageFromDir validates lazy media size and hash', async () => {
  await withTmp(async root => {
    const { skillDir, mediaBytes, mediaHash } = await writeSkillFixture(root)
    // wrong size
    let manifest = JSON.parse(await readFile(join(skillDir, 'skill.json'), 'utf8'))
    manifest.lazyMedia[0].bytes = mediaBytes + 1
    await writeFile(join(skillDir, 'skill.json'), JSON.stringify(manifest), 'utf8')
    let result = await loadSkillPackageFromDir(skillDir)
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(d => d.code === 'lazy-media-size-mismatch'))
    // wrong hash
    manifest = JSON.parse(await readFile(join(skillDir, 'skill.json'), 'utf8'))
    manifest.lazyMedia[0].bytes = mediaBytes
    manifest.lazyMedia[0].sha256 = 'f'.repeat(64)
    await writeFile(join(skillDir, 'skill.json'), JSON.stringify(manifest), 'utf8')
    result = await loadSkillPackageFromDir(skillDir)
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(d => d.code === 'lazy-media-hash-mismatch'))
    // missing file
    manifest = JSON.parse(await readFile(join(skillDir, 'skill.json'), 'utf8'))
    manifest.lazyMedia[0].sha256 = mediaHash
    manifest.lazyMedia[0].path = 'media/gone.mp4'
    await writeFile(join(skillDir, 'skill.json'), JSON.stringify(manifest), 'utf8')
    result = await loadSkillPackageFromDir(skillDir)
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(d => d.code === 'lazy-media-missing'))
  })
})

test('loadSkillPackageFromDir reports missing exec scripts as declarations', async () => {
  await withTmp(async root => {
    const { skillDir } = await writeSkillFixture(root, 'skill', { scripts: ['scripts/check.mjs', 'scripts/gone.mjs'] })
    const result = await loadSkillPackageFromDir(skillDir)
    assert.equal(result.ok, true) // warnings do not fail the load
    assert.equal(result.resolvedScripts.length, 2)
    assert.equal(result.resolvedScripts[1].path, 'scripts/gone.mjs')
    assert.equal(result.resolvedScripts[1].exists, false)
    assert.ok(result.diagnostics.some(d => d.code === 'exec-script-missing' && d.severity === 'warning'))
  })
})

test('loadSkillPackageFromDir rejects remote kinds and unsafe roots', async () => {
  await withTmp(async root => {
    const { skillDir } = await writeSkillFixture(root, 'skill', { kind: 'git' })
    let result = await loadSkillPackageFromDir(skillDir)
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(d => d.code === 'remote-source'))
    const { skillDir: dir2 } = await writeSkillFixture(root, 'skill2', { sourceRoot: '../escape' })
    result = await loadSkillPackageFromDir(dir2)
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(d => d.code === 'unsafe-root'))
  })
})

test('loadSkillPackageFromDir enforces declared root consistency with rootBase', async () => {
  await withTmp(async root => {
    const base = join(root, 'knowledge')
    const { skillDir } = await writeSkillFixture(join(base, 'skills'), 'demo-skill', { sourceRoot: 'skills/demo-skill' })
    // correct base: declared root resolves to the loaded directory
    let result = await loadSkillPackageFromDir(skillDir, { rootBase: base })
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
    // wrong base: declared root no longer matches
    result = await loadSkillPackageFromDir(skillDir, { rootBase: root })
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(d => d.code === 'root-mismatch'))
  })
})

test('loadSkillPackageFromDir rejects a lazy media symlink escaping the root', async () => {
  await withTmp(async root => {
    const outside = join(root, 'outside.mp4')
    await writeFile(outside, Buffer.from('secret'), 'utf8')
    const { skillDir } = await writeSkillFixture(root, 'skill', { lazyMedia: false })
    const manifest = JSON.parse(await readFile(join(skillDir, 'skill.json'), 'utf8'))
    manifest.lazyMedia = [{ path: 'media/link.mp4', bytes: 6, sha256: sha256Of(Buffer.from('secret')) }]
    await writeFile(join(skillDir, 'skill.json'), JSON.stringify(manifest), 'utf8')
    await symlink(outside, join(skillDir, 'media', 'link.mp4'))
    const result = await loadSkillPackageFromDir(skillDir)
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(d => d.code === 'lazy-media-unsafe' || d.code === 'lazy-media-hash-mismatch' || d.code === 'lazy-media-size-mismatch'))
  })
})

test('skill contributions are cross-validated when embedded in a pack', async () => {
  await withTmp(async root => {
    const { skillDir, manifest } = await writeSkillFixture(root)
    // dangling contribution: method-404 does not exist in the pack
    const dangling = { ...manifest, contributions: { methodPacks: ['method-404'] } }
    const pack = validPack({ skillPackages: [dangling] })
    let result = validateDomainPack(pack)
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(d => d.code === 'dangling-reference' && d.path.includes('contributions.methodPacks')))
    // resolving contribution passes
    const resolved = validPack({
      methodPacks: [{ id: 'method-1', version: '1.0.0', schemaVersion: 2, name: 'M', mediaType: 'agent-instructions', load: 'progressive', body: '步骤' }],
      skillPackages: [{ ...manifest, contributions: { methodPacks: ['method-1'] } }],
    })
    assert.equal(validateDomainPack(resolved).ok, true)
  })
})

test('hashPackageTree is deterministic and content-sensitive', async () => {
  await withTmp(async root => {
    await mkdir(join(root, 'd'))
    await writeFile(join(root, 'a.txt'), 'aaa', 'utf8')
    await writeFile(join(root, 'd', 'b.txt'), 'bbb', 'utf8')
    const first = await hashPackageTree(root)
    const second = await hashPackageTree(root)
    assert.equal(first, second)
    await writeFile(join(root, 'a.txt'), 'aaa-changed', 'utf8')
    assert.notEqual(await hashPackageTree(root), first)
  })
})
