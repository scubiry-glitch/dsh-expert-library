import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertContract, assertTransition, TRANSITIONS, validateCatalogRelease,
  validateReleaseManifest, validateSubmission, validateReport, validateOperation,
  validateDistributionScope, validatePrincipal,
} from '../index.mjs'
import { dependency, digest, manifest, snapshot, submission, report, operation, valid, invalid, errorCode } from './fixtures.mjs'

test('release schemas retain exact identity, fixed dependencies and complete digest metadata', () => {
  const value = manifest({ dependencyLock: [dependency()], builtinDependencies: [{ packId: 'builtin', minVersion: '2.0.0', maxVersionExclusive: '3.0.0' }] })
  valid(validateReleaseManifest, value)
  valid(validateCatalogRelease, value)
  assert.strictEqual(assertContract('release', value), value)
  valid(validateReleaseManifest, manifest({ sourceCommit: 'a'.repeat(64) }))
  valid(validateReleaseManifest, manifest({ requiresPlugin: { minVersion: '1.0.0' } }))
})

test('every release field is required and unknown fields are rejected at every nesting boundary', () => {
  for (const field of Object.keys(manifest())) {
    const value = manifest(); delete value[field]
    invalid(validateReleaseManifest, value, `$.${field}`)
  }
  invalid(validateReleaseManifest, manifest({ unsignedOverride: true }), '$.unsignedOverride')
  invalid(validateReleaseManifest, manifest({ requiresPlugin: { minVersion: '1.0.0', optional: true } }), '$.requiresPlugin.optional')
  invalid(validateReleaseManifest, manifest({ dependencyLock: [{ ...dependency(), optional: true }] }), '$.dependencyLock[0].optional')
  invalid(validateReleaseManifest, manifest({ builtinDependencies: [{ packId: 'builtin', minVersion: '1.0.0', extra: true }] }), '$.builtinDependencies[0].extra')
  for (const value of [null, [], 'release', 1, new Date()]) invalid(validateReleaseManifest, value)
})

test('schema discriminators distinguish unsupported versions from malformed values', () => {
  for (const [field, unknown, code] of [
    ['schemaVersion', 2, 'UNSUPPORTED_PROTOCOL'], ['protocolVersion', 2, 'UNSUPPORTED_PROTOCOL'],
    ['normalizationVersion', 2, 'UNSUPPORTED_ALGORITHM'], ['digestAlgorithmVersion', 2, 'UNSUPPORTED_ALGORITHM'],
    ['packSchemaVersion', 3, 'UNSUPPORTED_PROTOCOL'], ['signatureAlgorithm', 'Ed448', 'UNSUPPORTED_ALGORITHM'],
    ['archiveFormat', 'zip', 'UNSUPPORTED_ALGORITHM'],
  ]) {
    invalid(validateReleaseManifest, manifest({ [field]: unknown }), `$.${field}`, code)
    valid(validateCatalogRelease, manifest({ [field]: unknown }))
    for (const malformed of [null, undefined, [], {}, '', false, -1, 0, 1.5]) {
      invalid(validateCatalogRelease, manifest({ [field]: malformed }), `$.${field}`, 'INVALID_CONTRACT')
    }
  }
})

test('IDs, digests, commits, versions and safe counters fail closed without coercion', () => {
  for (const field of ['artifactSha256', 'contentTreeSha256', 'reportSha256']) {
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), `${digest}\n`, 123]) invalid(validateReleaseManifest, manifest({ [field]: bad }), `$.${field}`)
  }
  for (const id of ['', '../escape', 'a/b', 'a'.repeat(65), 'org\n', '\ud800']) invalid(validateReleaseManifest, manifest({ packId: id }), '$.packId')
  for (const id of ['org.demo', '组织.示例', 'a'.repeat(64)]) valid(validateReleaseManifest, manifest({ packId: id }))
  for (const bad of ['a'.repeat(39), 'A'.repeat(40), 'x'.repeat(40), `${'a'.repeat(40)}\n`]) invalid(validateReleaseManifest, manifest({ sourceCommit: bad }), '$.sourceCommit')
  for (const field of ['sizeBytes', 'fileCount']) {
    for (const bad of [-1, -0, 1.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) invalid(validateReleaseManifest, manifest({ [field]: bad }), `$.${field}`)
    valid(validateReleaseManifest, manifest({ [field]: 0 }))
  }
  invalid(validateReleaseManifest, manifest({ version: 'v1.0.0' }), '$.version', 'INVALID_VERSION')
  invalid(validateReleaseManifest, manifest({ validatorVersion: '1.0' }), '$.validatorVersion', 'INVALID_VERSION')
})

test('dependency locks reject self references, duplicate packs and empty version intervals', () => {
  invalid(validateReleaseManifest, manifest({ dependencyLock: [{ ...dependency(), packId: 'org.demo' }] }), '$.dependencyLock')
  invalid(validateReleaseManifest, manifest({ dependencyLock: [dependency(), dependency()] }), '$.dependencyLock')
  invalid(validateReleaseManifest, manifest({ dependencyLock: [dependency()], builtinDependencies: [{ packId: 'org.shared', minVersion: '1.0.0' }] }), '$.dependencyLock')
  invalid(validateReleaseManifest, manifest({ dependencyLock: [{ ...dependency(), artifactSha256: 'wrong' }] }), '$.dependencyLock[0].artifactSha256')
  for (const maxVersionExclusive of ['1.0.0', '0.9.0', '1.0.0+build']) invalid(validateReleaseManifest, manifest({ requiresPlugin: { minVersion: '1.0.0', maxVersionExclusive } }), '$.requiresPlugin')
  invalid(validateReleaseManifest, manifest({ builtinDependencies: [{ packId: 'builtin', minVersion: '2.0.0', maxVersionExclusive: '1.0.0' }] }), '$.builtinDependencies[0]')
})

test('submission validation requires a fixed snapshot from validated through terminal review states', () => {
  for (const status of ['draft', 'validating', 'validation_failed']) valid(validateSubmission, submission({ status }))
  for (const status of ['validated', 'pending_review', 'approved', 'changes_requested', 'rejected', 'withdrawn']) {
    invalid(validateSubmission, submission({ status }), '$.snapshot')
    valid(validateSubmission, submission({ status, snapshot: snapshot() }))
  }
  valid(validateSubmission, submission({ previousSubmissionId: 'sub-previous', snapshot: snapshot() }))
  invalid(validateSubmission, submission({ stateVersion: -1 }), '$.stateVersion')
  invalid(validateSubmission, submission({ snapshot: { ...snapshot(), reportSha256: 'wrong' } }), '$.snapshot.reportSha256')
  invalid(validateSubmission, submission({ snapshot: { ...snapshot(), mutable: true } }), '$.snapshot.mutable')
  invalid(validateSubmission, submission({ approvedBy: 'author' }), '$.approvedBy')
  for (const url of ['http://example.invalid/demo', 'file:///tmp/pack', 'git@example.invalid:pack', 'https://user:secret@example.invalid/pack', 'https://example.invalid/pack#tag']) invalid(validateSubmission, submission({ source: { url, ref: 'HEAD' } }), '$.source.url')
  invalid(validateSubmission, submission({ source: { url: 'https://example.invalid/pack', ref: '' } }), '$.source.ref')
})

test('distribution scope is explicit and selected recipients are nonempty and unique', () => {
  for (const scope of [{ kind: 'organization' }, { kind: 'authenticated' }, { kind: 'selected', organizationIds: ['org-a'], deploymentIds: [] }, { kind: 'selected', organizationIds: [], deploymentIds: ['site-b'] }]) valid(validateDistributionScope, scope)
  for (const scope of [null, { kind: 'anonymous' }, { kind: 'organization', organizationIds: ['other'] }, { kind: 'authenticated', token: 'spoof' }, { kind: 'selected', organizationIds: [], deploymentIds: [] }, { kind: 'selected', organizationIds: ['org', 'org'], deploymentIds: [] }, { kind: 'selected', organizationIds: [], deploymentIds: ['../bad'] }]) invalid(validateDistributionScope, scope)
})

test('human and machine principal contracts prevent mixing administrator roles and download scopes', () => {
  const human = { kind: 'human', userId: 'user', organizationId: 'org', roles: ['developer', 'reviewer'] }
  const machine = { kind: 'deployment', deploymentId: 'site-a', organizationId: 'org', scopes: ['catalog:read', 'release:download'] }
  valid(validatePrincipal, human); valid(validatePrincipal, machine)
  for (const value of [
    { ...human, roles: [] }, { ...human, roles: ['developer', 'developer'] }, { ...human, roles: ['superuser'] },
    { ...human, scopes: ['catalog:read'] }, { ...machine, roles: ['admin'] }, { ...machine, scopes: ['review:write'] },
    { ...machine, scopes: [] }, { ...machine, scopes: ['catalog:read', 'catalog:read'] },
    { ...machine, organizationId: '../../other' }, { ...human, userId: undefined },
  ]) invalid(validatePrincipal, value)
})

test('validation reports cannot claim success alongside errors and script paths are content declarations', () => {
  valid(validateReport, report())
  const diagnostic = { severity: 'error', code: 'MISSING_EXPERT', message: 'Expert missing', path: 'scenarios/demo.json' }
  valid(validateReport, report({ valid: false, diagnostics: [diagnostic] }))
  invalid(validateReport, report({ diagnostics: [diagnostic] }), '$.valid')
  valid(validateReport, report({ diagnostics: [{ ...diagnostic, severity: 'warning' }], permissions: { execScripts: ['scripts/check.sh'], internalOnly: true } }))
  invalid(validateReport, report({ diagnostics: [{ ...diagnostic, severity: 'fatal' }] }), '$.diagnostics[0].severity')
  invalid(validateReport, report({ entityCounts: { experts: -1 } }), '$.entityCounts.experts')
  invalid(validateReport, report({ permissions: { execScripts: ['../run.sh'], internalOnly: false } }), '$.permissions.execScripts[0]')
  invalid(validateReport, report({ permissions: { execScripts: [], internalOnly: 'false' } }), '$.permissions.internalOnly')
})

test('operations retain fixed targets, result generations and stable failure codes', () => {
  for (const kind of ['install', 'enable', 'update', 'update_enable', 'rollback']) {
    valid(validateOperation, operation({ kind }))
    const withoutTarget = operation({ kind }); delete withoutTarget.target
    invalid(validateOperation, withoutTarget, '$.target')
  }
  for (const kind of ['disable', 'uninstall']) { const value = operation({ kind }); delete value.target; valid(validateOperation, value) }
  valid(validateOperation, operation({ status: 'succeeded', expectedGeneration: 2, resultGeneration: 3 }))
  valid(validateOperation, operation({ status: 'failed', error: { code: 'STATE_CONFLICT', message: 'Generation changed' } }))
  invalid(validateOperation, operation({ status: 'failed' }), '$.error')
  invalid(validateOperation, operation({ status: 'succeeded' }), '$.resultGeneration')
  invalid(validateOperation, operation({ status: 'succeeded', expectedGeneration: 3, resultGeneration: 2 }), '$.resultGeneration')
  invalid(validateOperation, operation({ resultGeneration: 2 }), '$.resultGeneration')
  invalid(validateOperation, operation({ error: { code: 'INTERNAL_ERROR', message: 'failed' } }), '$.error')
  invalid(validateOperation, operation({ status: 'failed', error: { code: 'arbitrary', message: 'failed' } }), '$.error.code')
})

test('contracts reject sparse arrays, non-JSON keys and custom object prototypes', () => {
  invalid(validateReleaseManifest, manifest({ dependencyLock: Array(1) }), '$.dependencyLock')
  invalid(validateReport, report({ diagnostics: Array(1) }), '$.diagnostics')
  invalid(validatePrincipal, { kind: 'human', userId: 'user', organizationId: 'org', roles: Array(1) }, '$.roles')
  const decorated = []; decorated[Symbol('hidden')] = 'ignored'
  invalid(validateReleaseManifest, manifest({ dependencyLock: decorated }), '$.dependencyLock')
  const hidden = manifest(); Object.defineProperty(hidden, 'unsigned', { value: true })
  invalid(validateReleaseManifest, hidden, '$')
  const custom = Object.assign(Object.create({ inherited: true }), manifest())
  invalid(validateReleaseManifest, custom, '$')
  invalid(validateReport, report({ entityCounts: { experts: 1, [Symbol('ignored')]: 999 } }), '$.entityCounts')
})

test('assertContract preserves structured errors and rejects unsupported contract kinds', () => {
  assert.throws(() => assertContract('release', manifest({ protocolVersion: 9 })), error => errorCode('UNSUPPORTED_PROTOCOL')(error) && error.details[0].path === '$.protocolVersion')
  assert.throws(() => assertContract('arbitrary', {}), errorCode('INVALID_CONTRACT'))
  assert.throws(() => assertContract('toString', {}), errorCode('INVALID_CONTRACT'))
})

test('state transitions permit only the audited lifecycle and frozen transition data cannot be expanded', () => {
  const expected = {
    submission: [['draft', 'validating'], ['validating', 'validation_failed'], ['validating', 'validated'], ['validated', 'pending_review'], ['pending_review', 'approved'], ['pending_review', 'changes_requested'], ['pending_review', 'rejected'], ['pending_review', 'withdrawn']],
    release: [['publishing', 'published'], ['publishing', 'publish_failed'], ['publish_failed', 'publishing'], ['published', 'yanked']],
    operation: [['queued', 'running'], ['queued', 'failed'], ['running', 'succeeded'], ['running', 'failed']],
  }
  for (const [kind, pairs] of Object.entries(expected)) {
    const states = [...new Set(pairs.flat())]
    for (const from of states) for (const to of states) {
      if (pairs.some(edge => edge[0] === from && edge[1] === to)) assert.doesNotThrow(() => assertTransition(kind, from, to))
      else assert.throws(() => assertTransition(kind, from, to), errorCode('INVALID_TRANSITION'))
    }
  }
  assert.throws(() => assertTransition('arbitrary', 'draft', 'approved'), errorCode('INVALID_TRANSITION'))
  assert.throws(() => assertTransition('submission', 'toString', 'approved'), errorCode('INVALID_TRANSITION'))
  assert.throws(() => TRANSITIONS.submission.draft.push('approved'), TypeError)
  assert.throws(() => { TRANSITIONS.submission.draft = ['approved'] }, TypeError)
})
