import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const SCHEMA_VERSION = 1
export const PROTOCOL_VERSION = 1
export const ERROR_CODES = Object.freeze([
  'INVALID_CONTRACT', 'UNSUPPORTED_PROTOCOL', 'UNSUPPORTED_ALGORITHM', 'INVALID_VERSION',
  'INVALID_TRANSITION', 'FORBIDDEN', 'SELF_REVIEW', 'NOT_FOUND', 'STATE_CONFLICT',
  'IMMUTABLE_VERSION_CONFLICT', 'INTEGRITY_MISMATCH', 'SIGNATURE_INVALID', 'UNKNOWN_SIGNING_KEY',
  'INVALID_PATH', 'UNSUPPORTED_FILE', 'INCOMPATIBLE', 'DEPENDENCY_MISSING', 'REVERSE_DEPENDENCY',
  'RELEASE_YANKED', 'UNAUTHORIZED', 'CENTER_UNAVAILABLE', 'LIMIT_EXCEEDED', 'STATE_CORRUPT',
  'IDEMPOTENCY_CONFLICT', 'VALIDATION_FAILED', 'SOURCE_FAILED', 'INTERNAL_ERROR',
])

export class ContractError extends Error {
  constructor(code, message, details = []) {
    super(message)
    this.name = 'ContractError'
    this.code = code
    this.details = details
  }
}

const isRecord = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const own = (value, key) => Object.hasOwn(value, key)
const utf8Order = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const safeId = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u
const digest = /^[a-f0-9]{64}$/
const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** Numeric components remain strings; comparison is exact beyond Number.MAX_SAFE_INTEGER. */
export function parseSemVer(value) {
  const match = typeof value === 'string' && semver.exec(value)
  if (!match || match[0] !== value) throw new ContractError('INVALID_VERSION', `Invalid strict SemVer: ${String(value)}`)
  return { major: match[1], minor: match[2], patch: match[3], prerelease: match[4]?.split('.') ?? [], build: match[5]?.split('.') ?? [] }
}

const compareNumeric = (a, b) => a.length === b.length ? (a === b ? 0 : a < b ? -1 : 1) : a.length < b.length ? -1 : 1
export function compareSemVer(a, b) {
  const left = parseSemVer(a)
  const right = parseSemVer(b)
  for (const key of ['major', 'minor', 'patch']) {
    const difference = compareNumeric(left[key], right[key])
    if (difference !== 0) return difference
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1
  }
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const x = left.prerelease[i]
    const y = right.prerelease[i]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    return xn && yn ? compareNumeric(x, y) : xn !== yn ? (xn ? -1 : 1) : x < y ? -1 : 1
  }
  return 0
}

function checker() {
  const issues = []
  const add = (path, message, code = 'INVALID_CONTRACT') => issues.push({ path, code, message })
  const object = (value, path, required, optional = []) => {
    if (!isRecord(value)) { add(path, 'Expected an object'); return false }
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) add(path, 'Non-JSON object keys')
    for (const key of required) if (!own(value, key)) add(`${path}.${key}`, 'Required field')
    for (const key of Object.keys(value)) if (![...required, ...optional].includes(key)) add(`${path}.${key}`, 'Unknown field')
    return true
  }
  const text = (value, path, pattern) => {
    if (typeof value !== 'string' || !value.length || !value.isWellFormed() || (pattern && pattern.exec(value)?.[0] !== value)) add(path, 'Invalid string')
  }
  const number = (value, path) => { if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) add(path, 'Expected a nonnegative safe integer') }
  const version = (value, path) => { try { parseSemVer(value) } catch { add(path, 'Expected strict SemVer', 'INVALID_VERSION') } }
  const enumeration = (value, path, values) => { if (!values.includes(value)) add(path, `Expected one of ${values.join(', ')}`) }
  const literal = (value, path, expected, code = 'UNSUPPORTED_PROTOCOL') => {
    if (typeof value !== typeof expected || (typeof expected === 'number' && (!Number.isSafeInteger(value) || value < 1)) || (typeof expected === 'string' && (!value.length || !value.isWellFormed()))) add(path, 'Invalid protocol discriminator')
    else if (value !== expected) add(path, `Only ${String(expected)} is supported`, code)
  }
  const array = (value, path, visit) => {
    if (!Array.isArray(value)) { add(path, 'Expected an array'); return }
    if (Object.keys(value).length !== value.length || Reflect.ownKeys(value).length !== value.length + 1) add(path, 'Sparse or decorated array')
    value.forEach((item, index) => visit(item, `${path}[${index}]`))
  }
  const id = (value, path) => text(value, path, safeId)
  const ids = (value, path) => {
    array(value, path, id)
    if (Array.isArray(value) && new Set(value).size !== value.length) add(path, 'Duplicate identifiers')
  }
  return { issues, add, object, text, number, version, enumeration, literal, array, id, ids }
}
const result = c => ({ ok: c.issues.length === 0, issues: c.issues })

function scope(c, value, path) {
  if (!isRecord(value)) { c.add(path, 'Expected a distribution scope'); return }
  if (value.kind === 'organization' || value.kind === 'authenticated') c.object(value, path, ['kind'])
  else if (value.kind === 'selected') {
    c.object(value, path, ['kind', 'organizationIds', 'deploymentIds'])
    c.ids(value.organizationIds, `${path}.organizationIds`)
    c.ids(value.deploymentIds, `${path}.deploymentIds`)
    if (Array.isArray(value.organizationIds) && Array.isArray(value.deploymentIds) && !value.organizationIds.length && !value.deploymentIds.length) c.add(path, 'Selected scope needs at least one recipient')
  } else c.add(`${path}.kind`, 'Unknown distribution scope')
}
export function validateDistributionScope(value) { const c = checker(); scope(c, value, '$'); return result(c) }

export function validatePrincipal(value) {
  const c = checker()
  if (!isRecord(value)) c.add('$', 'Expected a principal')
  else if (value.kind === 'human') {
    c.object(value, '$', ['kind', 'userId', 'organizationId', 'roles'])
    c.id(value.userId, '$.userId'); c.id(value.organizationId, '$.organizationId')
    c.array(value.roles, '$.roles', (v, p) => c.enumeration(v, p, ['developer', 'reviewer', 'admin']))
    if (Array.isArray(value.roles) && (!value.roles.length || new Set(value.roles).size !== value.roles.length)) c.add('$.roles', 'Roles must be nonempty and unique')
  } else if (value.kind === 'deployment') {
    c.object(value, '$', ['kind', 'deploymentId', 'organizationId', 'scopes'])
    c.id(value.deploymentId, '$.deploymentId'); c.id(value.organizationId, '$.organizationId')
    c.array(value.scopes, '$.scopes', (v, p) => c.enumeration(v, p, ['catalog:read', 'release:download']))
    if (Array.isArray(value.scopes) && (!value.scopes.length || new Set(value.scopes).size !== value.scopes.length)) c.add('$.scopes', 'Scopes must be nonempty and unique')
  } else c.add('$.kind', 'Unknown principal kind')
  return result(c)
}

function pluginRequirement(c, value, path) {
  if (!c.object(value, path, ['minVersion'], ['maxVersionExclusive'])) return
  c.version(value.minVersion, `${path}.minVersion`)
  if (own(value, 'maxVersionExclusive')) {
    c.version(value.maxVersionExclusive, `${path}.maxVersionExclusive`)
    try { if (compareSemVer(value.minVersion, value.maxVersionExclusive) >= 0) c.add(path, 'Empty plugin version interval') } catch { /* Individual fields already reported. */ }
  }
}

export function validateReleaseManifest(value) {
  const c = checker()
  const keys = ['schemaVersion', 'protocolVersion', 'normalizationVersion', 'digestAlgorithmVersion', 'signatureAlgorithm', 'archiveFormat', 'centerId', 'releaseId', 'packId', 'ownerOrgId', 'version', 'sourceCommit', 'artifactSha256', 'contentTreeSha256', 'reportSha256', 'validatorVersion', 'packSchemaVersion', 'requiresPlugin', 'dependencyLock', 'builtinDependencies', 'sizeBytes', 'fileCount', 'approvedSubmissionId', 'signingKeyId']
  if (!c.object(value, '$', keys)) return result(c)
  for (const key of ['schemaVersion', 'protocolVersion', 'normalizationVersion', 'digestAlgorithmVersion']) c.literal(value[key], `$.${key}`, 1, key.includes('Algorithm') || key === 'normalizationVersion' ? 'UNSUPPORTED_ALGORITHM' : 'UNSUPPORTED_PROTOCOL')
  c.literal(value.signatureAlgorithm, '$.signatureAlgorithm', 'Ed25519', 'UNSUPPORTED_ALGORITHM')
  c.literal(value.archiveFormat, '$.archiveFormat', 'tar', 'UNSUPPORTED_ALGORITHM')
  c.literal(value.packSchemaVersion, '$.packSchemaVersion', 2)
  for (const key of ['centerId', 'releaseId', 'packId', 'ownerOrgId', 'approvedSubmissionId', 'signingKeyId']) c.id(value[key], `$.${key}`)
  for (const key of ['artifactSha256', 'contentTreeSha256', 'reportSha256']) c.text(value[key], `$.${key}`, digest)
  c.text(value.sourceCommit, '$.sourceCommit', commit)
  c.version(value.version, '$.version'); c.version(value.validatorVersion, '$.validatorVersion')
  c.number(value.sizeBytes, '$.sizeBytes'); c.number(value.fileCount, '$.fileCount')
  pluginRequirement(c, value.requiresPlugin, '$.requiresPlugin')
  c.array(value.dependencyLock, '$.dependencyLock', (item, path) => {
    if (!c.object(item, path, ['packId', 'ownerOrgId', 'releaseId', 'version', 'artifactSha256', 'contentTreeSha256'])) return
    for (const key of ['packId', 'ownerOrgId', 'releaseId']) c.id(item[key], `${path}.${key}`)
    c.version(item.version, `${path}.version`)
    for (const key of ['artifactSha256', 'contentTreeSha256']) c.text(item[key], `${path}.${key}`, digest)
  })
  c.array(value.builtinDependencies, '$.builtinDependencies', (item, path) => {
    if (!c.object(item, path, ['packId', 'minVersion'], ['maxVersionExclusive'])) return
    c.id(item.packId, `${path}.packId`)
    pluginRequirement(c, { minVersion: item.minVersion, ...(own(item, 'maxVersionExclusive') ? { maxVersionExclusive: item.maxVersionExclusive } : {}) }, path)
  })
  const dependencies = [...(Array.isArray(value.dependencyLock) ? value.dependencyLock : []), ...(Array.isArray(value.builtinDependencies) ? value.builtinDependencies : [])].filter(isRecord).map(item => item.packId)
  if (dependencies.includes(value.packId) || new Set(dependencies).size !== dependencies.length) c.add('$.dependencyLock', 'Self or duplicate dependency')
  return result(c)
}

/** A v1 catalog may describe unsupported future pack/algorithm versions without permitting installation. */
export function validateCatalogRelease(value) {
  const checked = validateReleaseManifest(value)
  const issues = checked.issues.filter(issue => !['UNSUPPORTED_PROTOCOL', 'UNSUPPORTED_ALGORITHM'].includes(issue.code))
  return { ok: issues.length === 0, issues }
}

const freezeTransitions = edges => Object.freeze(Object.fromEntries(Object.entries(edges).map(([state, next]) => [state, Object.freeze(next)])))
export const TRANSITIONS = Object.freeze({
  submission: freezeTransitions({ draft: ['validating'], validating: ['validation_failed', 'validated'], validation_failed: [], validated: ['pending_review'], pending_review: ['approved', 'changes_requested', 'rejected', 'withdrawn'], approved: [], changes_requested: [], rejected: [], withdrawn: [] }),
  release: freezeTransitions({ publishing: ['published', 'publish_failed'], publish_failed: ['publishing'], published: ['yanked'], yanked: [] }),
  operation: freezeTransitions({ queued: ['running', 'failed'], running: ['succeeded', 'failed'], succeeded: [], failed: [] }),
})
export function assertTransition(kind, from, to) {
  if (!own(TRANSITIONS, kind) || !own(TRANSITIONS[kind], from) || !TRANSITIONS[kind][from].includes(to)) throw new ContractError('INVALID_TRANSITION', `Invalid ${kind} transition: ${from} -> ${to}`)
}

export function validateSubmission(value) {
  const c = checker()
  if (!c.object(value, '$', ['schemaVersion', 'submissionId', 'ownerOrgId', 'authorId', 'packId', 'version', 'stateVersion', 'status', 'source', 'distribution'], ['snapshot', 'previousSubmissionId'])) return result(c)
  c.literal(value.schemaVersion, '$.schemaVersion', 1)
  for (const key of ['submissionId', 'ownerOrgId', 'authorId', 'packId']) c.id(value[key], `$.${key}`)
  if (own(value, 'previousSubmissionId')) c.id(value.previousSubmissionId, '$.previousSubmissionId')
  c.version(value.version, '$.version'); c.number(value.stateVersion, '$.stateVersion')
  c.enumeration(value.status, '$.status', Object.keys(TRANSITIONS.submission))
  if (c.object(value.source, '$.source', ['url', 'ref'])) {
    c.text(value.source.ref, '$.source.ref')
    try {
      const parsed = new URL(value.source.url)
      if (typeof value.source.url !== 'string' || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('Invalid')
    } catch { c.add('$.source.url', 'Expected an HTTPS URL without credentials or fragment') }
  }
  scope(c, value.distribution, '$.distribution')
  if (own(value, 'snapshot')) {
    const snapshot = value.snapshot
    if (c.object(snapshot, '$.snapshot', ['sourceCommit', 'artifactSha256', 'contentTreeSha256', 'reportSha256', 'validatorVersion', 'sizeBytes', 'fileCount'])) {
      c.text(snapshot.sourceCommit, '$.snapshot.sourceCommit', commit)
      for (const key of ['artifactSha256', 'contentTreeSha256', 'reportSha256']) c.text(snapshot[key], `$.snapshot.${key}`, digest)
      c.version(snapshot.validatorVersion, '$.snapshot.validatorVersion')
      c.number(snapshot.sizeBytes, '$.snapshot.sizeBytes'); c.number(snapshot.fileCount, '$.snapshot.fileCount')
    }
  } else if (['validated', 'pending_review', 'approved', 'changes_requested', 'rejected', 'withdrawn'].includes(value.status)) c.add('$.snapshot', 'This state requires an immutable validation snapshot')
  return result(c)
}

export function validateReport(value) {
  const c = checker()
  if (!c.object(value, '$', ['schemaVersion', 'validatorVersion', 'packSchemaVersion', 'valid', 'diagnostics', 'entityCounts'], ['permissions'])) return result(c)
  c.literal(value.schemaVersion, '$.schemaVersion', 1); c.literal(value.packSchemaVersion, '$.packSchemaVersion', 2)
  c.version(value.validatorVersion, '$.validatorVersion')
  if (typeof value.valid !== 'boolean') c.add('$.valid', 'Expected a boolean')
  c.array(value.diagnostics, '$.diagnostics', (item, path) => {
    if (!c.object(item, path, ['severity', 'code', 'message'], ['path'])) return
    c.enumeration(item.severity, `${path}.severity`, ['error', 'warning', 'info'])
    c.text(item.code, `${path}.code`); c.text(item.message, `${path}.message`)
    if (own(item, 'path')) c.text(item.path, `${path}.path`)
  })
  if (!isRecord(value.entityCounts)) c.add('$.entityCounts', 'Expected counts object')
  else {
    if (Reflect.ownKeys(value.entityCounts).length !== Object.keys(value.entityCounts).length) c.add('$.entityCounts', 'Non-JSON object keys')
    for (const [key, count] of Object.entries(value.entityCounts)) { c.id(key, `$.entityCounts.${key}`); c.number(count, `$.entityCounts.${key}`) }
  }
  if (value.valid === true && Array.isArray(value.diagnostics) && value.diagnostics.some(item => isRecord(item) && item.severity === 'error')) c.add('$.valid', 'An error diagnostic cannot accompany valid:true')
  if (own(value, 'permissions') && c.object(value.permissions, '$.permissions', ['execScripts', 'internalOnly'])) {
    c.array(value.permissions.execScripts, '$.permissions.execScripts', (v, p) => { try { assertSafePath(v) } catch { c.add(p, 'Expected a safe relative script path') } })
    if (typeof value.permissions.internalOnly !== 'boolean') c.add('$.permissions.internalOnly', 'Expected a boolean')
  }
  return result(c)
}

export function validateOperation(value) {
  const c = checker()
  if (!c.object(value, '$', ['schemaVersion', 'operationId', 'kind', 'status', 'packId', 'idempotencyKey', 'expectedGeneration'], ['target', 'resultGeneration', 'error'])) return result(c)
  c.literal(value.schemaVersion, '$.schemaVersion', 1)
  for (const key of ['operationId', 'packId', 'idempotencyKey']) c.id(value[key], `$.${key}`)
  c.enumeration(value.kind, '$.kind', ['install', 'enable', 'disable', 'update', 'update_enable', 'rollback', 'uninstall'])
  c.enumeration(value.status, '$.status', Object.keys(TRANSITIONS.operation))
  c.number(value.expectedGeneration, '$.expectedGeneration')
  if (own(value, 'target')) {
    if (c.object(value.target, '$.target', ['releaseId', 'artifactSha256', 'contentTreeSha256'])) {
      c.id(value.target.releaseId, '$.target.releaseId')
      c.text(value.target.artifactSha256, '$.target.artifactSha256', digest)
      c.text(value.target.contentTreeSha256, '$.target.contentTreeSha256', digest)
    }
  } else if (['install', 'enable', 'update', 'update_enable', 'rollback'].includes(value.kind)) c.add('$.target', 'A fixed release target is required')
  if (own(value, 'resultGeneration')) c.number(value.resultGeneration, '$.resultGeneration')
  if (value.status === 'succeeded' && !own(value, 'resultGeneration')) c.add('$.resultGeneration', 'Successful operations need the committed generation')
  if (value.status === 'succeeded' && value.resultGeneration < value.expectedGeneration) c.add('$.resultGeneration', 'Generation cannot move backward')
  if (value.status !== 'succeeded' && own(value, 'resultGeneration')) c.add('$.resultGeneration', 'Only successful operations carry a committed generation')
  if (own(value, 'error') && c.object(value.error, '$.error', ['code', 'message'])) {
    c.enumeration(value.error.code, '$.error.code', ERROR_CODES); c.text(value.error.message, '$.error.message')
  }
  if (value.status === 'failed' && !own(value, 'error')) c.add('$.error', 'Failed operations need an error')
  if (value.status !== 'failed' && own(value, 'error')) c.add('$.error', 'Only failed operations carry an error')
  return result(c)
}

const validators = { release: validateReleaseManifest, submission: validateSubmission, report: validateReport, operation: validateOperation, scope: validateDistributionScope, principal: validatePrincipal }
export function assertContract(kind, value) {
  if (!own(validators, kind)) throw new ContractError('INVALID_CONTRACT', `Unknown contract ${kind}`)
  const checked = validators[kind](value)
  if (!checked.ok) throw new ContractError(checked.issues[0].code, `Invalid ${kind} contract`, checked.issues)
  return value
}

/** Canonical JSON v1: UTF-8 byte-order keys, ordered arrays, finite safe integers only. */
export function canonicalJson(value) {
  const seen = new Set()
  const encode = item => {
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'string') {
      if (!item.isWellFormed()) throw new ContractError('INVALID_CONTRACT', 'Unpaired Unicode surrogate')
      return JSON.stringify(item)
    }
    if (typeof item === 'number' && Number.isSafeInteger(item) && !Object.is(item, -0)) return String(item)
    if (typeof item !== 'object' || item === null || seen.has(item)) throw new ContractError('INVALID_CONTRACT', 'Canonical JSON requires acyclic JSON with safe integer numbers')
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new ContractError('INVALID_CONTRACT', 'Canonical JSON requires plain objects')
    seen.add(item)
    let encoded
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length || Reflect.ownKeys(item).length !== item.length + 1) throw new ContractError('INVALID_CONTRACT', 'Sparse or decorated array')
      encoded = `[${Array.from(item, encode).join(',')}]`
    } else {
      if (Reflect.ownKeys(item).length !== Object.keys(item).length) throw new ContractError('INVALID_CONTRACT', 'Non-JSON object keys')
      encoded = `{${Object.keys(item).sort(utf8Order).map(key => `${encode(key)}:${encode(item[key])}`).join(',')}}`
    }
    seen.delete(item)
    return encoded
  }
  return encode(value)
}
export const canonicalBytes = value => Buffer.from(canonicalJson(value), 'utf8')
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export function assertSafePath(path) {
  if (typeof path !== 'string' || !path.length || !path.isWellFormed() || path !== path.normalize('NFC') || /[\\\x00-\x1f\x7f:]/u.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new ContractError('INVALID_PATH', `Invalid normalized relative path: ${String(path)}`)
  return path
}

/** Empty directories and mode/mtime are excluded; every regular file including generated is covered. */
export function hashContentTree(entries) {
  const paths = new Set()
  const files = entries.map(({ path, bytes }) => {
    assertSafePath(path)
    if (paths.has(path)) throw new ContractError('INVALID_PATH', `Duplicate path: ${path}`)
    paths.add(path)
    if (!(bytes instanceof Uint8Array)) throw new ContractError('INVALID_CONTRACT', `Expected bytes for ${path}`)
    return { path, sizeBytes: bytes.byteLength, sha256: sha256(bytes) }
  }).sort((a, b) => utf8Order(a.path, b.path))
  for (const path of paths) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) throw new ContractError('INVALID_PATH', `File/directory collision: ${path}`)
  }
  return { contentTreeSha256: sha256(Buffer.concat([Buffer.from('dsh-pack-tree-v1\0', 'utf8'), canonicalBytes({ schemaVersion: 1, files })])), fileCount: files.length, sizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0), files }
}

/** Caller supplies an isolated normalized tree. This helper neither filters nor modifies it. */
export async function hashContentDirectory(root) {
  if (!(await lstat(root)).isDirectory()) throw new ContractError('UNSUPPORTED_FILE', 'Tree root must be a real directory')
  const entries = []
  async function walk(relative) {
    const dir = relative ? join(root, relative) : root
    for (const name of await readdir(dir)) {
      const path = relative ? `${relative}/${name}` : name
      assertSafePath(path)
      const absolute = join(root, path)
      const info = await lstat(absolute)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1)) throw new ContractError('UNSUPPORTED_FILE', `Only regular independent files and directories are allowed: ${path}`)
      if (info.isDirectory()) await walk(path)
      else entries.push({ path, bytes: await readFile(absolute) })
    }
  }
  await walk('')
  return hashContentTree(entries)
}

export function manifestSigningBytes(manifest) { assertContract('release', manifest); return canonicalBytes(manifest) }
export function signReleaseManifest(manifest, privateKey) {
  const bytes = manifestSigningBytes(manifest)
  const key = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey)
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new ContractError('UNSUPPORTED_ALGORITHM', 'Signing requires an Ed25519 private key')
  return { manifest, signature: sign(null, bytes, key).toString('base64') }
}
export function verifyReleaseManifest(envelope, trustedKeys) {
  if (!isRecord(envelope) || Object.keys(envelope).length !== 2 || Reflect.ownKeys(envelope).length !== 2 || !own(envelope, 'manifest') || !own(envelope, 'signature')) throw new ContractError('INVALID_CONTRACT', 'Expected a signed manifest envelope')
  const bytes = manifestSigningBytes(envelope.manifest)
  const keyId = envelope.manifest.signingKeyId
  const inputKey = trustedKeys instanceof Map ? trustedKeys.get(keyId) : trustedKeys && own(trustedKeys, keyId) ? trustedKeys[keyId] : undefined
  if (inputKey === undefined) throw new ContractError('UNKNOWN_SIGNING_KEY', `Unknown signing key ${keyId}`)
  const key = inputKey instanceof KeyObject ? inputKey : createPublicKey(inputKey)
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw new ContractError('UNSUPPORTED_ALGORITHM', 'Verification requires a trusted Ed25519 public key')
  if (typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) throw new ContractError('SIGNATURE_INVALID', 'Invalid Ed25519 signature encoding')
  const signature = Buffer.from(envelope.signature, 'base64')
  if (signature.toString('base64') !== envelope.signature || !verify(null, bytes, key, signature)) throw new ContractError('SIGNATURE_INVALID', 'Manifest signature verification failed')
  return envelope.manifest
}

export function checkCompatibility(manifest, capabilities) {
  const catalog = validateCatalogRelease(manifest)
  if (!catalog.ok) throw new ContractError(catalog.issues[0].code, 'Invalid catalog release', catalog.issues)
  parseSemVer(capabilities.pluginVersion)
  const reasons = validateReleaseManifest(manifest).issues.map(issue => ({
    '$.schemaVersion': 'unsupported_schema', '$.protocolVersion': 'unsupported_protocol',
    '$.normalizationVersion': 'unsupported_normalization', '$.digestAlgorithmVersion': 'unsupported_digest_algorithm',
    '$.signatureAlgorithm': 'unsupported_signature_algorithm', '$.archiveFormat': 'unsupported_archive_format',
    '$.packSchemaVersion': 'unsupported_pack_schema',
  })[issue.path])
  if (!(capabilities.packSchemaVersions ?? [2]).includes(manifest.packSchemaVersion) && !reasons.includes('unsupported_pack_schema')) reasons.push('unsupported_pack_schema')
  if (compareSemVer(capabilities.pluginVersion, manifest.requiresPlugin.minVersion) < 0 || (manifest.requiresPlugin.maxVersionExclusive !== undefined && compareSemVer(capabilities.pluginVersion, manifest.requiresPlugin.maxVersionExclusive) >= 0)) reasons.push('plugin_version')
  return { compatible: reasons.length === 0, reasons }
}

/** Pure metadata selection. Callers must supply a successful, authorized, published release list. */
export function selectUpdateCandidate({ current, releases, capabilities, cachedReleaseIds = [] }) {
  assertContract('release', current)
  parseSemVer(capabilities.pluginVersion)
  const sameIdentity = manifest => ['centerId', 'ownerOrgId', 'packId'].every(key => manifest[key] === current[key])
  const byVersion = new Map()
  const byReleaseId = new Map()
  for (const release of [current, ...releases]) {
    const checked = validateCatalogRelease(release)
    if (!checked.ok) throw new ContractError(checked.issues[0].code, 'Invalid catalog release', checked.issues)
    if (!sameIdentity(release)) throw new ContractError('INVALID_CONTRACT', 'Update list mixed center, owner or pack identity')
    for (const previous of [byVersion.get(release.version), byReleaseId.get(release.releaseId)]) {
      if (previous && canonicalJson(previous) !== canonicalJson(release)) throw new ContractError('IMMUTABLE_VERSION_CONFLICT', `Different manifest for immutable version or release ${release.version}`)
    }
    byVersion.set(release.version, release)
    byReleaseId.set(release.releaseId, release)
  }
  const stable = releases.filter(release => parseSemVer(release.version).prerelease.length === 0).sort((a, b) => compareSemVer(b.version, a.version) || utf8Order(a.releaseId, b.releaseId))
  const latestVisible = stable[0] ?? null
  const newer = stable.filter(release => compareSemVer(release.version, current.version) > 0)
  const candidate = newer.find(release => checkCompatibility(release, capabilities).compatible) ?? null
  const blockedReasons = newer.filter(release => !checkCompatibility(release, capabilities).compatible).map(release => ({ releaseId: release.releaseId, reasons: checkCompatibility(release, capabilities).reasons }))
  return { current, latestVisible, candidate, blockedReasons, candidateCached: candidate !== null && cachedReleaseIds.includes(candidate.releaseId), status: candidate ? 'update_available' : newer.length ? 'blocked' : latestVisible === null ? 'no_stable_release' : 'up_to_date' }
}
