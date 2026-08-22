/**
 * zhijian-realestate domain pack migration tests (Phase 1 §7.3).
 *
 * Covers the entity Domain Pack at `domain-packs/zhijian-realestate`:
 * - the layout is accepted by `loadPackFromDir` with zero diagnostics and the
 *   loaded pack deep-equals the in-memory V2 projection (round-trip);
 * - the pack pins the 2026-08-19 zip baseline: exactly 32 experts
 *   (bk-002..bk-033) and BK-034 recorded as a deferred 1.1.0 upgrade — never
 *   silently merged;
 * - the original Profile JSONs are lossless (sha-256 against
 *   SOURCE-MANIFEST.json);
 * - fidelity: pack entities mirror the runtime metas, the frozen V1 golden
 *   (`generated/v1/`) matches the live registry, the routing overlay matches
 *   the in-repo routing tables, and no legacy markers / fabricated fields
 *   exist;
 * - determinism: the generator re-emits a byte-identical tree — both without
 *   a source (entities only) and from the embedded source (full tree);
 * - compiler golden: the round-tripped pack compiles framework templates to
 *   the same ExecutionPlan digest as the in-memory pack.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildZhijianDomainPack,
  loadPackFromDir,
  canonicalJson,
  hashPackageTree,
  compileExecutionPlan,
} from '../lib/v2/index.js'
import { ZHIJIAN_EXPERTS } from '../lib/zhijian/data/experts.generated.js'
import { ZHIJIAN_EXPERT_BY_ID, ZHIJIAN_ROUTE } from '../lib/zhijian/registry.js'
import { ROUTE_TOPICS, STANCE_TABLE, SPECIAL_ROUTING, ROUTING_CONSTRAINTS } from '../lib/zhijian/routing.js'
import { BUILTIN_SCENARIOS } from '../lib/expert-library/builtin-scenarios.js'
import { emitPack, compareTrees, PACK_BASELINE, PACK_DEFERRED_UPGRADES } from '../scripts/build-zhijian-pack.mjs'

/** Absolute path of the committed domain pack. */
const PACK_DIR = new URL('../domain-packs/zhijian-realestate', import.meta.url).pathname
/** Absolute path of the pack's embedded source (docs/ + raw-profiles/). */
const PACK_SOURCE_DIR = join(PACK_DIR, 'source')

/** Build the same projection the generator uses. */
function build() {
  return buildZhijianDomainPack({ modelPolicy: ZHIJIAN_ROUTE })
}

/**
 * Canonical pack view for round-trip comparison: collection ARRAY ORDER is
 * not a pack contract — the loader emits files in lexical name order while
 * the projection emits in semantic order (scenarios follow the routing
 * table, method packs lead with the review protocol). Content per id is the
 * contract, so every collection is sorted by id before deep comparison.
 */
function canonicalPack(pack) {
  const sortedById = collection => [...collection].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    ...pack,
    experts: sortedById(pack.experts),
    scenarios: sortedById(pack.scenarios),
    teamTemplates: sortedById(pack.teamTemplates),
    outputTemplates: sortedById(pack.outputTemplates),
    qualityPolicies: sortedById(pack.qualityPolicies),
    toolProviders: sortedById(pack.toolProviders),
    knowledgeProviders: sortedById(pack.knowledgeProviders),
    domainKnowledge: sortedById(pack.domainKnowledge),
    methodPacks: sortedById(pack.methodPacks),
    skillPackages: sortedById(pack.skillPackages),
  }
}

/** Recursively check that no field carries the legacy adapter marker. */
function hasLegacyMarker(value, key = '') {
  if (Array.isArray(value)) return value.some(item => hasLegacyMarker(item, key))
  if (typeof value === 'object' && value !== null) {
    if ('legacySource' in value) return true
    return Object.entries(value).some(([k, v]) => hasLegacyMarker(v, k))
  }
  return false
}

/** Load the committed pack once (shared by several tests). */
async function loadCommittedPack() {
  return loadPackFromDir(PACK_DIR)
}

// ── 1. layout acceptance + round-trip ───────────────────────────────────────

test('domain-packs/zhijian-realestate loads with zero diagnostics', async () => {
  const loaded = await loadCommittedPack()
  assert.equal(loaded.ok, true)
  assert.equal(loaded.diagnostics.filter(d => d.severity === 'error').length, 0, JSON.stringify(loaded.diagnostics))
  assert.equal(loaded.diagnostics.filter(d => d.severity === 'warning').length, 0, JSON.stringify(loaded.diagnostics))
  assert.ok(loaded.pack !== undefined)
})

test('round-trip: loaded pack equals the in-memory V2 projection (content per id)', async () => {
  const loaded = await loadCommittedPack()
  assert.deepEqual(canonicalPack(loaded.pack), canonicalPack(build()))
})

test('pack.json is metadata-only; entity sections live in directories', async () => {
  const packJson = JSON.parse(await readFile(join(PACK_DIR, 'pack.json'), 'utf8'))
  assert.equal(packJson.id, 'zhijian-realestate')
  assert.equal(packJson.version, '1.0.0')
  assert.equal(packJson.schemaVersion, 2)
  for (const key of ['experts', 'scenarios', 'teamTemplates', 'outputTemplates', 'qualityPolicies', 'methodPacks']) {
    assert.ok(!(key in packJson), `pack.json must stay metadata-only (no ${key} inline)`)
  }
})

// ── 2. baseline pinning: 32 experts, BK-034 deferred ────────────────────────

test('exactly 32 experts, ids bk-002..bk-033, no bk-034 (deferred, not merged)', async () => {
  const loaded = await loadCommittedPack()
  const ids = loaded.pack.experts.map(e => e.id)
  assert.equal(ids.length, 32)
  assert.deepEqual(ids, Array.from({ length: 32 }, (_, i) => `bk-${String(i + 2).padStart(3, '0')}`))
  assert.ok(!ids.includes('bk-034'), 'BK-034 must not be silently merged into the 1.0.0 pack')
  // every expert id has a matching raw profile below
  const manifest = JSON.parse(await readFile(join(PACK_DIR, 'source', 'SOURCE-MANIFEST.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.rawProfiles.files).sort(), ids.map(id => {
    const meta = ZHIJIAN_EXPERTS.find(m => m.id === id)
    return `${meta.name}_专家Profile_${meta.bk}.json`
  }).sort())
})

test('SOURCE-MANIFEST records the 2026-08-19 baseline and defers bk-034 to 1.1.0', async () => {
  const manifest = JSON.parse(await readFile(join(PACK_DIR, 'source', 'SOURCE-MANIFEST.json'), 'utf8'))
  assert.equal(manifest.packId, 'zhijian-realestate')
  assert.equal(manifest.packVersion, '1.0.0')
  assert.equal(manifest.baseline.source, PACK_BASELINE.source)
  assert.equal(manifest.baseline.date, PACK_BASELINE.date)
  assert.equal(manifest.baseline.expertCount, 32)
  assert.equal(manifest.rawProfiles.count, 32)
  const deferred = manifest.deferredUpgrades
  assert.equal(deferred.length, 1)
  assert.equal(deferred[0].version, '1.1.0')
  assert.deepEqual(deferred[0].adds, ['bk-034 陈杰'])
  // the exported constant is what the generator writes (no drift between code and manifest)
  assert.deepEqual(deferred, PACK_DEFERRED_UPGRADES)
})

// ── 3. lossless original Profile JSONs ──────────────────────────────────────

test('raw profiles are lossless: every file matches its sha-256 in the manifest', async () => {
  const manifest = JSON.parse(await readFile(join(PACK_DIR, 'source', 'SOURCE-MANIFEST.json'), 'utf8'))
  const entries = Object.entries(manifest.rawProfiles.files)
  assert.equal(entries.length, 32)
  for (const [name, expected] of entries) {
    const actual = createHash('sha256').update(await readFile(join(PACK_DIR, 'source', 'raw-profiles', name))).digest('hex')
    assert.equal(actual, expected, `sha-256 mismatch for ${name}`)
  }
  // docs and library are hashed too
  for (const [group, dir] of [['docs', 'docs'], ['library', 'library']]) {
    for (const [name, expected] of Object.entries(manifest[group].files)) {
      const actual = createHash('sha256').update(await readFile(join(PACK_DIR, 'source', dir, name))).digest('hex')
      assert.equal(actual, expected, `sha-256 mismatch for ${dir}/${name}`)
    }
  }
  assert.equal(Object.keys(manifest.docs.files).length, 6)
  assert.equal(Object.keys(manifest.library.files).length, 32)
})

test('raw profile persona fields survive verbatim (no fabrication, spot checks)', async () => {
  const manifest = JSON.parse(await readFile(join(PACK_DIR, 'source', 'SOURCE-MANIFEST.json'), 'utf8'))
  const bk004 = Object.entries(manifest.rawProfiles.files).find(([name]) => name.includes('BK-004'))[0]
  const raw = JSON.parse(await readFile(join(PACK_DIR, 'source', 'raw-profiles', bk004), 'utf8'))
  assert.equal(raw.expert_id, 'BK-004')
  assert.equal(raw.name, '宏观周期派 X 首席')
  assert.ok(Array.isArray(raw.persona.bias) && raw.persona.bias.length > 0, 'persona.bias must be present in the raw profile')
  assert.ok(Array.isArray(raw.persona.cognition.mentalModels) && raw.persona.cognition.mentalModels.length > 0)
  assert.equal(typeof raw.persona.cognition.mentalModels[0].summary, 'string')
})

// ── 4. fidelity: no fabrication, no legacy markers ──────────────────────────

test('pack contains no legacySource markers and no fabricated proficiency', async () => {
  const loaded = await loadCommittedPack()
  assert.equal(hasLegacyMarker(loaded.pack), false, 'pack-projected objects must not be legacy-flagged')
  for (const expert of loaded.pack.experts) {
    assert.notEqual(expert.display.initials, 'legacy')
    assert.ok(expert.capabilities.length > 0)
    for (const claim of expert.capabilities) {
      assert.equal(claim.proficiency, 1, 'metas assert membership, not level — floor 1 only')
      assert.deepEqual(claim.evidenceRefs, ['zhijian:roster'])
    }
    // mental-model summaries stay '' — the metas carry names only; nothing is invented
    for (const model of expert.persona.mentalModels ?? []) {
      assert.equal(model.summary, '')
    }
  }
})

test('fidelity: pack experts mirror the runtime metas verbatim', async () => {
  const loaded = await loadCommittedPack()
  for (const expert of loaded.pack.experts) {
    const meta = ZHIJIAN_EXPERTS.find(item => item.id === expert.id)
    assert.ok(meta !== undefined, `missing meta ${expert.id}`)
    assert.equal(expert.display.internalName, meta.name)
    assert.equal(expert.display.publicLabel, meta.personaName)
    assert.equal(expert.display.initials, meta.initials)
    assert.notEqual(expert.display.publicLabel, expert.display.internalName)
    assert.deepEqual(expert.persona.style, [...meta.style])
    assert.deepEqual(expert.persona.signaturePhrases, [...meta.signaturePhrases])
    assert.deepEqual(expert.persona.antiPatterns, [...meta.antiPatterns])
    assert.deepEqual((expert.persona.mentalModels ?? []).map(m => m.name), meta.mentalModels)
    assert.deepEqual(expert.modelPolicy, ZHIJIAN_ROUTE)
  }
})

test('fidelity: generated/v1/experts.json matches the live V1 registry (frozen golden)', async () => {
  const golden = JSON.parse(await readFile(join(PACK_DIR, 'generated', 'v1', 'experts.json'), 'utf8'))
  assert.equal(canonicalJson(golden), canonicalJson([...ZHIJIAN_EXPERT_BY_ID.values()]))
  assert.equal(golden.length, 32)
})

test('fidelity: generated/v1/scenarios.json matches the bk-* builtin scenarios', async () => {
  const golden = JSON.parse(await readFile(join(PACK_DIR, 'generated', 'v1', 'scenarios.json'), 'utf8'))
  const expected = BUILTIN_SCENARIOS.filter(s => s.experts.some(id => id.startsWith('bk-')))
  assert.equal(canonicalJson(golden), canonicalJson(expected))
  assert.ok(golden.length >= 4)
})

test('fidelity: routing overlay matches the in-repo routing tables', async () => {
  const overlay = JSON.parse(await readFile(join(PACK_DIR, 'routing', 'routing.json'), 'utf8'))
  assert.equal(canonicalJson(overlay.topics), canonicalJson(ROUTE_TOPICS))
  assert.equal(canonicalJson(overlay.stancePairs), canonicalJson(STANCE_TABLE))
  assert.equal(canonicalJson(overlay.specialRouting), canonicalJson(SPECIAL_ROUTING))
  assert.equal(canonicalJson(overlay.constraints), canonicalJson(ROUTING_CONSTRAINTS))
})

// ── 5. quality policy survives the round-trip ───────────────────────────────

test('quality policy intact after round-trip (5 gates, repair cap 2)', async () => {
  const loaded = await loadCommittedPack()
  const policy = loaded.pack.qualityPolicies[0]
  assert.equal(policy.id, 'zhijian.quality')
  assert.equal(policy.maxRepairRounds, 2)
  const gateIds = policy.gates.map(g => g.id)
  for (const expected of ['schema-structure', 'data-citation', 'compliance-anonymization', 'style-lint', 'semantic-fusion']) {
    assert.ok(gateIds.includes(expected), `missing gate ${expected}`)
  }
  assert.ok(policy.gates.some(g => g.kind === 'semantic'))
  assert.ok(policy.gates.some(g => g.severity === 'soft'))
})

// ── 6. determinism of the generator ─────────────────────────────────────────

test('generator determinism: two fresh emits (no source) are byte-identical', async () => {
  const a = await mkdtemp(join(tmpdir(), 'zj-pack-a-'))
  const b = await mkdtemp(join(tmpdir(), 'zj-pack-b-'))
  try {
    const [ra, rb] = await Promise.all([emitPack(a), emitPack(b)])
    assert.deepEqual(await compareTrees(a, b), [])
    assert.equal(ra.hash, rb.hash)
  } finally {
    await rm(a, { recursive: true, force: true })
    await rm(b, { recursive: true, force: true })
  }
})

test('generator determinism: full regeneration from the embedded source reproduces the committed pack', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'zj-pack-src-'))
  try {
    const result = await emitPack(tmp, { srcDir: PACK_SOURCE_DIR, writeSrc: false })
    assert.equal(result.ok, true)
    const diffs = await compareTrees(PACK_DIR, tmp)
    assert.deepEqual(diffs, [], `re-emission from the embedded source must reproduce the committed pack: ${diffs.join(' | ')}`)
    // the regenerated tree hash matches the committed one
    const committedHash = (await readFile(join(PACK_DIR, 'generated', 'pack.sha256'), 'utf8')).trim()
    assert.equal(result.hash, committedHash)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('pack tree hash is deterministic and self-excluding (pack.sha256 not part of itself)', async () => {
  const files = [
    'generated/v1/experts.json', 'generated/v1/scenarios.json', 'generated/roster.md',
    'generated/verify.json', 'generated/pack.sha256',
  ]
  const hash = await hashPackageTree(PACK_DIR, { exclude: files })
  const committed = (await readFile(join(PACK_DIR, 'generated', 'pack.sha256'), 'utf8')).trim()
  assert.equal(hash, committed)
})

// ── 7. compiler golden: loaded pack ⇒ same plan as in-memory pack ───────────

test('compiler golden: loaded-pack templates compile to the same ExecutionPlan digest', async () => {
  const loaded = await loadCommittedPack()
  const inMemory = build()
  const params = {
    selectedExpertIds: ['bk-024', 'bk-004'],
    data: '上海 2026-07 二手住宅市场月度数据（口径见任务说明）',
    outputForm: 'discussion',
  }
  // A and B are referenced by scenarios (zhijian-monthly / zhijian-policy)
  // whose toolPolicy.allowed is empty — capability-first, no provider needed.
  // C and D have no scenario entity (topic-driven frameworks); without a
  // scenario the compiler tool-binds task allowedCapabilities, so both sides
  // fail identically with `binding/unbound-capability` — the round-trip
  // contract still holds: the loaded pack compiles EXACTLY like the
  // in-memory projection, success or failure.
  const cases = [
    ['zhijian.team.A', 'zhijian-monthly'],
    ['zhijian.team.B', 'zhijian-policy'],
    ['zhijian.team.C', undefined],
    ['zhijian.team.D', undefined],
  ]
  for (const [templateId, scenarioId] of cases) {
    const input = {
      pack: undefined,
      templateId,
      ...(scenarioId !== undefined ? { scenarioId } : {}),
      params,
    }
    const fromDisk = compileExecutionPlan({ ...input, pack: loaded.pack })
    const fromMemory = compileExecutionPlan({ ...input, pack: inMemory })
    assert.equal(fromDisk.ok, fromMemory.ok, `${templateId}: ok must match`)
    if (fromDisk.ok) {
      assert.equal(fromDisk.plan.digest, fromMemory.plan.digest, `${templateId}: digest must be identical`)
      assert.deepEqual(fromDisk.plan.tasks.map(t => t.id), ['t1', 't2'])
      assert.deepEqual(fromDisk.plan.roster.filter(m => m.slotId === 'role.reviewer').map(m => m.expertId), ['bk-024', 'bk-004'])
    } else {
      assert.equal(fromDisk.errorKind, fromMemory.errorKind, `${templateId}: errorKind must match`)
      assert.deepEqual(fromDisk.errors, fromMemory.errors, `${templateId}: errors must match`)
    }
  }
})
