import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseSemVer, compareSemVer, canonicalJson, validateReleaseManifest,
  checkCompatibility, selectUpdateCandidate,
} from '../index.mjs'
import { manifest, dependency, errorCode } from './fixtures.mjs'

const capabilities = { pluginVersion: '1.5.0' }
const release = (version, overrides = {}) => manifest({ version, releaseId: `rel-${version}`, approvedSubmissionId: `sub-${version}`, ...overrides })

test('strict SemVer accepts legal prerelease/build fields and rejects loose or coerced versions', () => {
  assert.deepEqual(parseSemVer('12.34.56-rc.9+build.001'), { major: '12', minor: '34', patch: '56', prerelease: ['rc', '9'], build: ['build', '001'] })
  assert.deepEqual(parseSemVer('0.0.0'), { major: '0', minor: '0', patch: '0', prerelease: [], build: [] })
  assert.doesNotThrow(() => parseSemVer('1.2.3-0.a-1.01a+000'))
  for (const bad of ['', 'v1.0.0', '1.0', '1', '1.0.0 ', ' 1.0.0', '1.0.0\n', '01.0.0', '1.01.0', '1.0.01', '1.0.0-01', '1.0.0-a.01', '1.0.0-', '1.0.0+a..b', '1.0.0-中', null, 1, {}]) assert.throws(() => parseSemVer(bad), errorCode('INVALID_VERSION'), String(bad))
})

test('SemVer precedence handles 1.9/1.10, prereleases, build metadata and unbounded numeric fields exactly', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.9.0', '1.10.0', '2.0.0']
  for (let index = 0; index < ordered.length - 1; index++) {
    assert.equal(compareSemVer(ordered[index], ordered[index + 1]), -1)
    assert.equal(compareSemVer(ordered[index + 1], ordered[index]), 1)
  }
  assert.equal(compareSemVer('1.0.0+build.1', '1.0.0+build.999'), 0)
  assert.equal(compareSemVer('1.0.0-rc.1+build', '1.0.0-rc.1'), 0)
  assert.equal(compareSemVer('9007199254740992.0.0', '9007199254740993.0.0'), -1)
  assert.equal(compareSemVer('1.0.0-9007199254740992', '1.0.0-9007199254740993'), -1)
  assert.equal(compareSemVer('99999999999999999999.0.0', '100000000000000000000.0.0'), -1)
})

test('compatibility checks both plugin interval endpoints and supported pack schemas', () => {
  const value = manifest({ requiresPlugin: { minVersion: '1.5.0', maxVersionExclusive: '2.0.0' } })
  assert.deepEqual(checkCompatibility(value, { pluginVersion: '1.5.0' }), { compatible: true, reasons: [] })
  assert.deepEqual(checkCompatibility(value, { pluginVersion: '1.4.9' }), { compatible: false, reasons: ['plugin_version'] })
  assert.deepEqual(checkCompatibility(value, { pluginVersion: '2.0.0' }), { compatible: false, reasons: ['plugin_version'] })
  assert.deepEqual(checkCompatibility(value, { pluginVersion: '1.6.0', packSchemaVersions: [] }), { compatible: false, reasons: ['unsupported_pack_schema'] })
  assert.throws(() => checkCompatibility(value, { pluginVersion: 'v1.0.0' }), errorCode('INVALID_VERSION'))
})

test('update selection preserves current state, reports latest visible separately and finds compatible cached candidate', () => {
  const current = release('1.9.0')
  const candidate = release('1.10.0')
  const latest = release('2.0.0', { requiresPlugin: { minVersion: '3.0.0' } })
  const releases = [candidate, release('1.8.0'), latest, release('3.0.0-rc.1')]
  const before = canonicalJson({ current, releases })
  const selected = selectUpdateCandidate({ current, releases, capabilities, cachedReleaseIds: [candidate.releaseId] })
  assert.equal(selected.status, 'update_available')
  assert.strictEqual(selected.current, current)
  assert.strictEqual(selected.latestVisible, latest)
  assert.strictEqual(selected.candidate, candidate)
  assert.equal(selected.candidateCached, true)
  assert.deepEqual(selected.blockedReasons, [{ releaseId: latest.releaseId, reasons: ['plugin_version'] }])
  assert.equal(canonicalJson({ current, releases }), before, 'Metadata selection must not mutate caller state or reorder entries')
})

test('unsupported future protocol/schema/algorithm versions remain visible but cannot become install candidates', () => {
  const fields = [
    ['schemaVersion', 2, 'unsupported_schema'], ['protocolVersion', 2, 'unsupported_protocol'],
    ['normalizationVersion', 2, 'unsupported_normalization'], ['digestAlgorithmVersion', 2, 'unsupported_digest_algorithm'],
    ['signatureAlgorithm', 'Ed448', 'unsupported_signature_algorithm'], ['archiveFormat', 'zip', 'unsupported_archive_format'],
    ['packSchemaVersion', 3, 'unsupported_pack_schema'],
  ]
  for (const [field, value, reason] of fields) {
    const future = release('3.0.0', { [field]: value })
    const older = release('2.0.0')
    const selected = selectUpdateCandidate({ current: release('1.0.0'), releases: [future, older], capabilities })
    assert.strictEqual(selected.latestVisible, future)
    assert.strictEqual(selected.candidate, older)
    assert.deepEqual(selected.blockedReasons, [{ releaseId: future.releaseId, reasons: [reason] }])
    assert.equal(validateReleaseManifest(future).ok, false, 'Installer contract still rejects future manifest')
  }
})

test('selection rejects malformed future metadata rather than treating it as a harmless incompatible version', () => {
  const current = release('1.0.0')
  for (const bad of [
    release('3.0.0', { protocolVersion: '2' }), release('3.0.0', { signatureAlgorithm: '' }),
    release('3.0.0', { schemaVersion: 2, artifactSha256: 'wrong' }), release('3.0.0', { packSchemaVersion: 3, newUnrecognizedField: true }),
  ]) assert.throws(() => selectUpdateCandidate({ current, releases: [bad, release('2.0.0')], capabilities }), errorCode('INVALID_CONTRACT'))
})

test('same release ID or exact version forbids any canonical manifest change, not just artifact digest changes', () => {
  const current = release('1.0.0')
  const changes = {
    sourceCommit: 'f'.repeat(40), artifactSha256: 'f'.repeat(64), contentTreeSha256: 'f'.repeat(64), reportSha256: 'f'.repeat(64),
    signingKeyId: 'key-2', approvedSubmissionId: 'other-review', requiresPlugin: { minVersion: '2.0.0' },
    dependencyLock: [dependency()], builtinDependencies: [{ packId: 'builtin', minVersion: '1.0.0' }],
    validatorVersion: '2.0.0', sizeBytes: 2049, fileCount: 2, packSchemaVersion: 3, schemaVersion: 2,
  }
  for (const [field, value] of Object.entries(changes)) {
    assert.throws(() => selectUpdateCandidate({ current, releases: [{ ...current, [field]: value }], capabilities }), errorCode('IMMUTABLE_VERSION_CONFLICT'), field)
  }
  assert.throws(() => selectUpdateCandidate({ current, releases: [{ ...current, releaseId: 'other-release' }], capabilities }), errorCode('IMMUTABLE_VERSION_CONFLICT'))
  assert.throws(() => selectUpdateCandidate({ current, releases: [{ ...current, version: '1.0.1' }], capabilities }), errorCode('IMMUTABLE_VERSION_CONFLICT'))
  const next = release('2.0.0')
  assert.throws(() => selectUpdateCandidate({ current, releases: [next, { ...next, signingKeyId: 'new-key' }], capabilities }), errorCode('IMMUTABLE_VERSION_CONFLICT'))
  const duplicate = Object.fromEntries(Object.entries(current).reverse())
  assert.equal(selectUpdateCandidate({ current, releases: [duplicate], capabilities }).status, 'up_to_date')
})

test('mixed center, owning organization or pack IDs cannot be compared as an update', () => {
  for (const overrides of [{ centerId: 'other' }, { ownerOrgId: 'other' }, { packId: 'org.other' }]) {
    assert.throws(() => selectUpdateCandidate({ current: release('1.0.0'), releases: [release('2.0.0', overrides)], capabilities }), errorCode('INVALID_CONTRACT'))
  }
})

test('empty/prerelease catalogs, lower compatible versions and build metadata never manufacture updates', () => {
  const current = release('2.0.0')
  for (const releases of [[], [release('3.0.0-rc.1')]]) {
    assert.deepEqual(selectUpdateCandidate({ current, releases, capabilities }), { current, latestVisible: null, candidate: null, blockedReasons: [], candidateCached: false, status: 'no_stable_release' })
  }
  const lower = selectUpdateCandidate({ current, releases: [release('1.9.0')], capabilities })
  assert.equal(lower.status, 'up_to_date'); assert.equal(lower.candidate, null)
  const buildOnly = selectUpdateCandidate({ current, releases: [release('2.0.0+build.9', { releaseId: 'rel-build', approvedSubmissionId: 'sub-build' })], capabilities })
  assert.equal(buildOnly.status, 'up_to_date'); assert.equal(buildOnly.candidate, null)
  const blocked = selectUpdateCandidate({ current, releases: [release('3.0.0', { requiresPlugin: { minVersion: '4.0.0' } }), release('1.0.0')], capabilities })
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.candidate, null)
})

test('equal SemVer precedence has deterministic release ID ordering without using input order', () => {
  const a = release('2.0.0+aaa', { releaseId: 'a-release', approvedSubmissionId: 'sub-a' })
  const b = release('2.0.0+bbb', { releaseId: 'b-release', approvedSubmissionId: 'sub-b' })
  for (const releases of [[a, b], [b, a]]) {
    const selected = selectUpdateCandidate({ current: release('1.0.0'), releases, capabilities })
    assert.strictEqual(selected.candidate, a)
    assert.strictEqual(selected.latestVisible, a)
  }
})
