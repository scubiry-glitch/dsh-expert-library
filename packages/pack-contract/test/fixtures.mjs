import assert from 'node:assert/strict'
import { ContractError } from '../index.mjs'

export const digest = 'a'.repeat(64)
export const otherDigest = 'b'.repeat(64)
export const dependency = () => ({
  packId: 'org.shared', ownerOrgId: 'org', releaseId: 'rel-shared-v1', version: '1.0.0',
  artifactSha256: digest, contentTreeSha256: otherDigest,
})
export const manifest = (overrides = {}) => ({
  schemaVersion: 1, protocolVersion: 1, normalizationVersion: 1, digestAlgorithmVersion: 1,
  signatureAlgorithm: 'Ed25519', archiveFormat: 'tar', centerId: 'center',
  releaseId: 'rel-v1', packId: 'org.demo', ownerOrgId: 'org', version: '1.0.0',
  sourceCommit: 'c'.repeat(40), artifactSha256: digest, contentTreeSha256: otherDigest,
  reportSha256: 'd'.repeat(64), validatorVersion: '1.0.0', packSchemaVersion: 2,
  requiresPlugin: { minVersion: '1.0.0', maxVersionExclusive: '3.0.0' },
  dependencyLock: [], builtinDependencies: [], sizeBytes: 2048, fileCount: 1,
  approvedSubmissionId: 'sub-v1', signingKeyId: 'key-1', ...overrides,
})
export const snapshot = () => ({
  sourceCommit: 'c'.repeat(40), artifactSha256: digest, contentTreeSha256: otherDigest,
  reportSha256: 'd'.repeat(64), validatorVersion: '1.0.0', sizeBytes: 2048, fileCount: 1,
})
export const submission = (overrides = {}) => ({
  schemaVersion: 1, submissionId: 'sub-v1', ownerOrgId: 'org', authorId: 'author',
  packId: 'org.demo', version: '1.0.0', stateVersion: 0, status: 'draft',
  source: { url: 'https://example.invalid/org/demo.git', ref: 'HEAD' },
  distribution: { kind: 'organization' }, ...overrides,
})
export const report = (overrides = {}) => ({
  schemaVersion: 1, validatorVersion: '1.0.0', packSchemaVersion: 2, valid: true,
  diagnostics: [], entityCounts: { experts: 1, scenarios: 0, skills: 0 },
  permissions: { execScripts: [], internalOnly: false }, ...overrides,
})
export const operation = (overrides = {}) => ({
  schemaVersion: 1, operationId: 'op-1', kind: 'install', status: 'queued',
  packId: 'org.demo', idempotencyKey: 'request-1', expectedGeneration: 0,
  target: { releaseId: 'rel-v1', artifactSha256: digest, contentTreeSha256: otherDigest }, ...overrides,
})
export function valid(validate, value) {
  assert.deepEqual(validate(value), { ok: true, issues: [] })
}
export function invalid(validate, value, path, code) {
  const result = validate(value)
  assert.equal(result.ok, false, `Expected invalid contract at ${path ?? '$'}`)
  assert.ok(result.issues.some(issue => (!path || issue.path === path) && (!code || issue.code === code)), JSON.stringify(result.issues))
}
export function errorCode(code) {
  return error => {
    assert.ok(error instanceof ContractError, `${error?.constructor?.name}: ${error?.message}`)
    assert.equal(error.code, code)
    return true
  }
}
