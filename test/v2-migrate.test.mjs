/**
 * Phase 1 version-migrator tests: `migrateDomainPack` dispatch, the legacy
 * registry path through `buildLegacyDomainPack`, and the never-throw
 * contract for unknown/future schema versions. Runs against the built `lib/`
 * output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { migrateDomainPack, validateDomainPack, buildZhijianDomainPack } from '../lib/v2/index.js'

/** Minimal V1 Expert fixture. */
function expert(id, overrides = {}) {
  return {
    id,
    name: `Expert ${id}`,
    role: '行业研究',
    background: '背景',
    principles: ['结论先行'],
    deliverables: ['研判稿'],
    ...overrides,
  }
}

/** Minimal V1 Scenario fixture (task dependency indexes stay < own index). */
function scenario(id, overrides = {}) {
  return {
    id,
    name: `Scenario ${id}`,
    description: '描述',
    experts: ['bk-004'],
    tasks: [
      { subject: '界定问题', expert: 'bk-004' },
      { subject: '分析', dependsOn: [0] },
    ],
    deliverable: '报告',
    ...overrides,
  }
}

function legacyRegistry(overrides = {}) {
  return {
    schemaVersion: 1,
    experts: [expert('bk-004'), expert('researcher', { model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })],
    scenarios: [scenario('market-research')],
    ...overrides,
  }
}

const hasCode = (result, code) => result.diagnostics.some(diag => diag.code === code)

// ── 1. V2 packs: validate and return idempotently ────────────────────────────

test('REGRESSION: a real valid V2 pack (no root schemaVersion) migrates idempotently', () => {
  // DomainPackV2 carries schemaVersion on pack.pack, never at the document
  // root — a valid pack must NOT be misrouted to schema-version-missing.
  const pack = buildZhijianDomainPack()
  assert.equal(pack.schemaVersion, undefined, 'valid packs have no root schemaVersion')
  assert.equal(pack.pack.schemaVersion, 2)
  const result = migrateDomainPack(pack)
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
  assert.equal(result.migrated, false)
  assert.equal(result.sourceVersion, 2)
  assert.ok(!hasCode(result, 'schema-version-missing'), 'valid pack must not report schema-version-missing')
  assert.deepEqual(result.value, pack)
  assert.deepEqual(result.diagnostics.filter(diag => diag.severity === 'error'), [])
})

test('an invalid V2 pack returns validator diagnostics without throwing', () => {
  const pack = buildZhijianDomainPack()
  pack.experts.push({ ...pack.experts[0] }) // duplicate expert id
  const result = migrateDomainPack(pack)
  assert.equal(result.ok, false)
  assert.equal(result.migrated, false)
  assert.equal(result.value, undefined)
  assert.ok(hasCode(result, 'duplicate-id'))
})

// ── 2. Legacy registry path ──────────────────────────────────────────────────

test('a legacy registry (schemaVersion 1) migrates via buildLegacyDomainPack', () => {
  const result = migrateDomainPack(legacyRegistry())
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
  assert.equal(result.migrated, true)
  assert.equal(result.sourceVersion, 1)
  assert.ok(result.value !== undefined)
  assert.equal(result.value.experts.length, 2)
  assert.equal(result.value.scenarios.length, 1)
  // Conservative adapters are untouched: legacy markers and placeholders.
  assert.equal(result.value.experts[0].legacySource, 'v1')
  assert.equal(result.value.experts[0].display.initials, 'legacy')
  assert.equal(result.value.experts[0].capabilities[0].legacySource, 'v1')
  // The projected pack itself validates clean.
  const revalidated = validateDomainPack(result.value)
  assert.equal(revalidated.ok, true)
})

test('a legacy registry without schemaVersion is treated as version 1', () => {
  const { schemaVersion, ...registry } = legacyRegistry()
  assert.equal(schemaVersion, 1)
  const result = migrateDomainPack(registry)
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
  assert.equal(result.migrated, true)
  assert.equal(result.sourceVersion, 1)
})

test('legacy packName is honored on the projected pack', () => {
  const result = migrateDomainPack(legacyRegistry({ packName: 'My Legacy Pack' }))
  assert.equal(result.ok, true)
  assert.equal(result.value?.pack.name, 'My Legacy Pack')
})

test('a legacy projection that fails validation still reports migrated=true with diagnostics', () => {
  const registry = legacyRegistry({ experts: [expert('broken', { name: undefined })] })
  const result = migrateDomainPack(registry)
  assert.equal(result.ok, false)
  assert.equal(result.migrated, true, 'the legacy path was taken even though the projection is invalid')
  assert.ok(hasCode(result, 'invalid-field'))
})

test('non-object legacy entries are rejected up front (never throw)', () => {
  for (const junk of [null, 'x', 42]) {
    const result = migrateDomainPack(legacyRegistry({ experts: [junk] }))
    assert.equal(result.ok, false, `experts: [${String(junk)}] must fail`)
    assert.equal(result.migrated, false)
    assert.ok(hasCode(result, 'invalid-legacy-item'))
  }
  const badScenario = migrateDomainPack(legacyRegistry({ scenarios: [null] }))
  assert.equal(badScenario.ok, false)
  assert.ok(hasCode(badScenario, 'invalid-legacy-item'))
  assert.match(badScenario.diagnostics[0].path, /scenarios\[0\]/)
})

test('a legacy-shaped input without both arrays is rejected', () => {
  const missingScenarios = migrateDomainPack({ schemaVersion: 1, experts: [expert('bk-004')] })
  assert.equal(missingScenarios.ok, false)
  assert.equal(missingScenarios.migrated, false)
  assert.ok(hasCode(missingScenarios, 'invalid-legacy-input'))
  const missingExperts = migrateDomainPack({ schemaVersion: 1, scenarios: [] })
  assert.equal(missingExperts.ok, false)
  assert.ok(hasCode(missingExperts, 'invalid-legacy-input'))
})

test('an empty legacy registry migrates to an empty but valid pack', () => {
  const result = migrateDomainPack({ schemaVersion: 1, experts: [], scenarios: [] })
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
  assert.equal(result.migrated, true)
  assert.equal(result.value?.experts.length, 0)
  assert.equal(result.value?.scenarios.length, 0)
})

// ── 3. Unknown / future schema versions: diagnostics, never throw ────────────

test('unknown or future schema versions return diagnostics and never throw', () => {
  for (const badVersion of [0, -1, 3, 99, '2', 'v2', null]) {
    const result = migrateDomainPack({ schemaVersion: badVersion, experts: [], scenarios: [] })
    assert.equal(result.ok, false, `schemaVersion ${String(badVersion)} must fail`)
    assert.equal(result.migrated, false)
    assert.equal(result.value, undefined)
    assert.ok(hasCode(result, 'unsupported-schema-version'), `schemaVersion ${String(badVersion)} must report unsupported-schema-version`)
  }
})

test('a V2-shaped document without pack.schemaVersion 2 is rejected at the nested path', () => {
  const pack = buildZhijianDomainPack()
  assert.equal(pack.pack.schemaVersion, 2)
  const withoutVersion = { ...pack, pack: { ...pack.pack, schemaVersion: undefined } }
  const missing = migrateDomainPack(withoutVersion)
  assert.equal(missing.ok, false)
  assert.equal(missing.migrated, false)
  assert.ok(hasCode(missing, 'schema-version-missing'))
  assert.equal(missing.diagnostics.find(diag => diag.code === 'schema-version-missing')?.path, 'pack.schemaVersion')
  const version1 = migrateDomainPack({ ...pack, pack: { ...pack.pack, schemaVersion: 1 } })
  assert.equal(version1.ok, false)
  assert.ok(hasCode(version1, 'schema-version-missing'))
  assert.equal(version1.diagnostics.find(diag => diag.code === 'schema-version-missing')?.path, 'pack.schemaVersion')
})

test('pack presence wins over a root schemaVersion: root 1 + pack record reports the nested path', () => {
  const pack = buildZhijianDomainPack()
  const hybrid = { schemaVersion: 1, ...pack, pack: { ...pack.pack, schemaVersion: undefined } }
  const result = migrateDomainPack(hybrid)
  assert.equal(result.ok, false)
  assert.equal(result.migrated, false)
  assert.ok(hasCode(result, 'schema-version-missing'))
  assert.equal(result.diagnostics.find(diag => diag.code === 'schema-version-missing')?.path, 'pack.schemaVersion')
})

test('a root schemaVersion 2 without a pack record is NOT treated as V2 (root is legacy-only)', () => {
  const result = migrateDomainPack({ schemaVersion: 2, experts: [], scenarios: [] })
  assert.equal(result.ok, false)
  assert.equal(result.migrated, false)
  assert.ok(hasCode(result, 'unsupported-schema-version'))
  assert.equal(result.diagnostics.find(diag => diag.code === 'unsupported-schema-version')?.path, 'schemaVersion')
})

// ── 4. Robustness / round trip ───────────────────────────────────────────────

test('non-record input returns invalid-shape diagnostics and never throws', () => {
  for (const junk of [null, undefined, 42, 'x', [], true]) {
    const result = migrateDomainPack(junk)
    assert.equal(result.ok, false, `input ${String(junk)} must fail`)
    assert.equal(result.migrated, false)
    assert.ok(hasCode(result, 'invalid-shape'))
  }
})

test('a migrated legacy pack round-trips as a V2 pack on a second call', () => {
  const first = migrateDomainPack(legacyRegistry())
  assert.equal(first.ok, true)
  const second = migrateDomainPack(first.value)
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics))
  assert.equal(second.migrated, false, 'the migrated value is now a plain V2 pack')
  assert.equal(second.sourceVersion, 2)
  assert.deepEqual(second.value, first.value)
})

test('migrateDomainPack never throws across the whole dispatch matrix', () => {
  const cases = [
    undefined, null, [], {}, { schemaVersion: 2 }, { schemaVersion: 1 },
    legacyRegistry(), legacyRegistry({ experts: [] }), buildZhijianDomainPack(),
    { schemaVersion: 99 }, { pack: { id: 'x' } }, { experts: [{}], scenarios: [{}] },
  ]
  for (const input of cases) {
    let result
    assert.doesNotThrow(() => { result = migrateDomainPack(input) }, `input ${JSON.stringify(input)?.slice(0, 40)} threw`)
    assert.ok(typeof result?.ok === 'boolean')
    assert.ok(Array.isArray(result?.diagnostics))
    assert.ok(typeof result?.migrated === 'boolean')
  }
})
