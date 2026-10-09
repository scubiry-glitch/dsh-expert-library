/** Private host API. Harness browser authentication does not protect plugin routes. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  CenterBindInput, CenterManageService, CenterOperationInput,
} from '../pack-center-wire.ts'
import { authorizeManageRequest } from './auth.ts'

const prefix = '/plugins/dsh-expert-library/manage/center'
const maximumBody = 64 * 1024
const safeCodes = new Set([
  'MANAGE_UNAUTHORIZED', 'CENTER_UI_REQUIRED', 'CENTER_CSRF_REJECTED', 'CENTER_INVALID_INPUT',
  'CENTER_INVALID_REQUEST', 'CENTER_METHOD_NOT_ALLOWED', 'CENTER_ROUTE_NOT_FOUND',
  'CENTER_BODY_TOO_LARGE', 'CENTER_BODY_TIMEOUT', 'CENTER_RESPONSE_INVALID', 'CENTER_REQUEST_FAILED',
  'CENTER_DISABLED', 'CENTER_NOT_CONFIGURED', 'CENTER_NOT_BOUND', 'CENTER_ORIGIN_CHANGED', 'CENTER_RESTART_REQUIRED', 'CENTER_BASES_REQUIRED',
  'CENTER_CREDENTIAL_EXPIRED', 'CENTER_TARGET_CHANGED', 'CENTER_ACTIVATION_UNAVAILABLE',
  'CENTER_BIND_UNCONFIRMED', 'CENTER_PAGE_LIMIT', 'CENTER_INVALID_ORIGIN', 'CENTER_INVALID_STORAGE',
  'CENTER_INVENTORY_NOT_EMPTY', 'CENTER_ID_LOCKED', 'CENTER_KEY_REASSIGNMENT', 'CENTER_TRUST_MISMATCH',
  'CENTER_RELEASE_MISMATCH', 'CENTER_REPORT_MISMATCH', 'CENTER_GRANT_EXPIRED', 'CENTER_ARTIFACT_TOO_LARGE',
  'CENTER_CANCELLED', 'CENTER_TIMEOUT', 'CENTER_NETWORK_ERROR', 'CENTER_REDIRECT_DENIED', 'CENTER_HTTP_ERROR',
  'CENTER_RESPONSE_TOO_LARGE', 'CENTER_DOWNLOAD_IO', 'CENTER_DOWNLOAD_TARGET_EXISTS', 'CENTER_DOWNLOAD_INVALID',
  'CENTER_CONNECTION_CHANGED', 'CENTER_BINDING_CHANGED', 'TARGET_CHANGED',
  'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'INVALID_INPUT', 'BINDING_CODE_INVALID',
  'DEPLOYMENT_DISABLED', 'DOWNLOAD_GRANT_INVALID', 'DOWNLOAD_GRANT_REQUIRED', 'RELEASE_YANKED',
  'RELEASE_INTEGRITY', 'DEPENDENCY_UNAVAILABLE', 'BASELINE_UNAVAILABLE', 'RATE_LIMITED',
  'CONNECTION_INVALID', 'CONNECTION_UNSAFE_PATH', 'CONNECTION_CORRUPT', 'CONNECTION_READ_FAILED',
  'CONNECTION_WRITE_FAILED', 'CONNECTION_COMMIT_UNCERTAIN', 'REVISION_CONFLICT',
  'GENERATION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'INVALID_REQUEST', 'LOCK_UNAVAILABLE', 'LOCK_TIMEOUT', 'LOCK_LOST',
  'STATE_CORRUPT', 'STATE_MISSING', 'STATE_UNSUPPORTED_VERSION', 'STATE_READ_FAILED', 'STATE_READ_ONLY',
  'STATE_RECOVERY_INVALID', 'STATE_WRITE_FAILED', 'STATE_COMMIT_UNCERTAIN', 'STATE_INVALID',
  'ACTIVATION_PREFLIGHT_FAILED', 'BUILTIN_DEPENDENCY_BLOCKED', 'CENTER_ENTITY_CONFLICT', 'CENTER_MERGE_INVALID',
  'CENTER_MISMATCH', 'CENTER_PACK_ID_CONFLICT', 'CONTENT_DIGEST_MISMATCH', 'DEPENDENCY_BLOCKED', 'DEPENDENCY_CYCLE',
  'DEPENDENCY_MANIFEST_MISMATCH', 'ENTITY_CONFLICT', 'IMMUTABLE_RELEASE_CONFLICT', 'IMMUTABLE_VERSION_CONFLICT',
  'INCOMPATIBLE_RELEASE', 'INVALID_ROLLBACK_TARGET', 'INVALID_ROOT', 'INVENTORY_IDENTITY_MISMATCH',
  'INVENTORY_MISSING', 'INVENTORY_PATH_MISMATCH', 'INVENTORY_UNSAFE', 'LEGACY_ALREADY_MANAGED',
  'LEGACY_NOT_MANAGED', 'LEGACY_RESTORE_REQUIRED', 'LEGACY_SOURCE_CHANGED', 'LEGACY_VERIFIER_REQUIRED',
  'OPERATION_DISAPPEARED', 'OPERATION_NOT_FOUND', 'OPERATION_INVALID', 'OPERATION_CONFLICT',
  'OPERATION_QUEUE_FULL', 'OPERATION_QUEUE_CLOSED', 'OPERATION_IN_PROGRESS', 'OPERATION_NOT_RETRYABLE',
  'OPERATION_INTERRUPTED', 'OPERATION_READ_FAILED', 'OPERATION_WRITE_FAILED', 'OPERATION_CORRUPT',
  'OPERATION_UNSAFE_PATH', 'OPERATION_COMMIT_UNCERTAIN', 'PACK_IDENTITY_MISMATCH', 'PACK_INVALID',
  'OPERATION_INVALID_RESULT', 'OPERATION_FAILED', 'OPERATION_LIMIT', 'OPERATION_CLOSED',
  'OPERATION_STORAGE_UNSAFE', 'OPERATION_STORAGE_CORRUPT',
  'PACK_NOT_ACTIVE', 'PACK_OWNER_CONFLICT', 'RELEASE_ACTIVE', 'RELEASE_NOT_INSTALLED',
])
const sensitiveHeaders = new Set([
  'host', 'origin', 'authorization', 'cookie', 'x-expert-library-manage-token', 'x-pack-center-ui',
  'content-type', 'content-length', 'content-encoding', 'transfer-encoding', 'expect',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip',
])
function forwardingHeader(name: string): boolean {
  return name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip'
    || name === 'cf-connecting-ip' || name === 'via'
}
class RouteError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}
function fail(code = 'CENTER_INVALID_INPUT', status = 400): never { throw new RouteError(code, status) }
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return fail()
  return value as Record<string, unknown>
}
function exact(value: unknown, required: string[], optional: string[] = []) {
  const row = record(value)
  if (required.some(key => !Object.hasOwn(row, key))
    || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) fail()
  return row
}
function id(value: unknown, operation = false): string {
  const pattern = operation ? /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ : /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
  if (typeof value !== 'string' || !pattern.test(value) || value.includes('..')
    || /dpc_(?:token|bind)_/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) return fail()
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail()
  return value
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return fail()
  return value
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') return fail(); return value }
function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return fail()
  return value as T
}
/** Text is never HTML; discard objects and scrub credential/PEM/host-path accidents. */
function plainText(value: unknown, maximum = 16_384): string {
  if (typeof value !== 'string' || value.length > maximum) return fail()
  return value.replace(/-----BEGIN [^-\r\n]+-----(?:[\s\S]*?-----END [^-\r\n]+-----|[\s\S]*$)/g, '[redacted]')
    .replace(/dpc_(?:token|bind)_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/(?<![A-Za-z0-9/])(?:[A-Za-z]:[\\/]|\/(?!\/))[^\s"'<>]+/g, '[redacted-path]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}
function list(value: unknown, maximum = 1000): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return fail()
  return value
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return fail()
  return value
}
function origin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\%]/.test(value)) return fail()
  let parsed: URL
  try { parsed = new URL(value) } catch { return fail() }
  if (!['http:', 'https:'].includes(parsed.protocol) || value !== parsed.origin
    || parsed.username || parsed.password || parsed.hostname.endsWith('.') || parsed.hostname.includes('..')) return fail()
  return value
}
function errorCode(value: unknown): string {
  return typeof value === 'string' && safeCodes.has(value) ? value : 'CENTER_REQUEST_FAILED'
}
function optionalError(row: Record<string, unknown>, key = 'errorCode') {
  return row[key] === undefined ? {} : { [key]: errorCode(row[key]) }
}
function installed(value: unknown) {
  const row = record(value)
  const source = enumeration(row.source, ['center', 'legacy'])
  const releaseId = (value: unknown) => {
    if (source !== 'legacy') return id(value)
    if (typeof value !== 'string' || !/^legacy\.[a-f0-9]{64}$/.test(value)) return fail()
    return value
  }
  return {
    releaseId: releaseId(row.releaseId), packId: id(row.packId), version: plainText(row.version, 128),
    source, installedAt: date(row.installedAt), active: bool(row.active),
    ...(row.centerId === undefined ? {} : { centerId: id(row.centerId) }),
    ...(row.ownerOrgId === undefined ? {} : { ownerOrgId: id(row.ownerOrgId) }),
    ...(row.previousReleaseId === undefined ? {} : { previousReleaseId: releaseId(row.previousReleaseId) }),
    artifactSha256: digest(row.artifactSha256), contentTreeSha256: digest(row.contentTreeSha256),
    ...(row.manifestSha256 === undefined ? {} : { manifestSha256: digest(row.manifestSha256) }),
    integrity: enumeration(row.integrity, ['verified', 'unavailable']), ...optionalError(row),
  }
}
function release(value: unknown, detail = false): Record<string, unknown> {
  const row = record(value), compatibility = record(row.compatibility), availability = record(row.downloadAvailability)
  const output: Record<string, unknown> = {
    releaseId: id(row.releaseId), packId: id(row.packId), version: plainText(row.version, 128),
    ownerOrgId: id(row.ownerOrgId), name: plainText(row.name, 512), publishedAt: date(row.publishedAt),
    manifestSha256: digest(row.manifestSha256), artifactSha256: digest(row.artifactSha256), contentTreeSha256: digest(row.contentTreeSha256),
    compatibility: { compatible: bool(compatibility.compatible), reasons: list(compatibility.reasons, 100).map(reason => plainText(reason, 2048)) },
    downloadAvailability: { available: bool(availability.available), ...optionalError(availability, 'code') },
    dependencies: list(row.dependencies, 1000).map(value => {
      const dependency = record(value)
      return { packId: id(dependency.packId), releaseId: id(dependency.releaseId), version: plainText(dependency.version, 128) }
    }),
  }
  if (detail) {
    const validation = record(row.validation), diff = record(row.diff)
    if (typeof row.sourceCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(row.sourceCommit)) fail()
    Object.assign(output, {
      sourceCommit: row.sourceCommit, notes: plainText(row.notes, 65_536), license: plainText(row.license, 2048),
      validation: { valid: bool(validation.valid), diagnostics: list(validation.diagnostics, 1000).map(value => {
        const diagnostic = record(value)
        return { severity: plainText(diagnostic.severity, 32), code: plainText(diagnostic.code, 128), message: plainText(diagnostic.message, 8192) }
      }) },
      diff: { available: bool(diff.available), ...optionalError(diff, 'code'), text: plainText(diff.text, 262_144) },
    })
  }
  return output
}
function freshness(row: Record<string, unknown>) {
  return { checkedAt: row.checkedAt === null ? null : date(row.checkedAt), hasSnapshot: bool(row.hasSnapshot), stale: bool(row.stale), ...optionalError(row) }
}
function connection(value: unknown) {
  const row = record(value)
  const output = { configured: bool(row.configured), configuredOrigin: row.configuredOrigin === null ? null : origin(row.configuredOrigin),
    activationAvailable: bool(row.activationAvailable), revision: integer(row.revision), connection: null as unknown, ...optionalError(row) }
  if (row.connection !== null) {
    const inner = record(row.connection), fingerprints = record(inner.signingKeyFingerprints)
    const keys: Record<string, string> = Object.create(null)
    if (Object.keys(fingerprints).length > 16) fail()
    for (const [key, value] of Object.entries(fingerprints)) keys[id(key)] = digest(value)
    output.connection = {
      origin: origin(inner.origin), centerId: id(inner.centerId), organizationId: id(inner.organizationId), deploymentId: id(inner.deploymentId),
      credentialId: id(inner.credentialId), credentialExpiresAt: date(inner.credentialExpiresAt), boundAt: date(inner.boundAt),
      bound: bool(inner.bound), signingKeyFingerprints: keys,
    }
  }
  return output
}
function catalog(value: unknown) {
  const row = record(value)
  return { items: list(row.items, 100).map(value => release(value)), nextCursor: row.nextCursor === null ? null : id(row.nextCursor), ...freshness(row) }
}
function installations(value: unknown) {
  const row = record(value)
  return { generation: integer(row.generation), mode: enumeration(row.mode, ['normal', 'recovered-read-only']),
    items: list(row.items).map(installed), ...optionalError(row, 'warningCode') }
}
function updates(value: unknown) {
  const row = record(value)
  return { ...freshness(row), generation: integer(row.generation), items: list(row.items).map(value => {
    const item = record(value)
    return { packId: id(item.packId), current: installed(item.current), latestVisible: item.latestVisible === null ? null : release(item.latestVisible),
      candidate: item.candidate === null ? null : release(item.candidate), candidateCached: bool(item.candidateCached),
      status: enumeration(item.status, ['update_available', 'blocked', 'no_stable_release', 'up_to_date']),
      blockedReasons: list(item.blockedReasons, 1000).map(value => {
        const blocked = record(value)
        return { releaseId: id(blocked.releaseId), reasons: list(blocked.reasons, 100).map(reason => plainText(reason, 2048)) }
      }) }
  }) }
}
function operationInput(value: unknown, strict = true): CenterOperationInput {
  const row = record(value)
  const kind = enumeration(row.kind, ['install', 'update_enable', 'enable', 'disable', 'rollback', 'uninstall'])
  const fields = kind === 'install' || kind === 'update_enable' ? ['releaseId', 'connectionRevision', 'target']
    : kind === 'rollback' ? ['releaseId', 'packId'] : kind === 'disable' ? ['packId'] : ['releaseId']
  if (strict) exact(row, ['operationKey', 'kind', 'expectedGeneration', ...fields])
  const result: CenterOperationInput = { operationKey: id(row.operationKey, true), kind, expectedGeneration: integer(row.expectedGeneration) }
  if (fields.includes('packId')) result.packId = id(row.packId)
  if (fields.includes('releaseId')) result.releaseId = id(row.releaseId)
  if (fields.includes('target')) {
    const target = strict ? exact(row.target, ['manifestSha256', 'artifactSha256', 'contentTreeSha256']) : record(row.target)
    result.connectionRevision = integer(row.connectionRevision)
    result.target = { manifestSha256: digest(target.manifestSha256), artifactSha256: digest(target.artifactSha256), contentTreeSha256: digest(target.contentTreeSha256) }
  }
  return result
}
function operation(value: unknown) {
  const row = record(value)
  const output: Record<string, unknown> = {
    operationId: id(row.operationId, true), request: operationInput(row.request, false),
    status: enumeration(row.status, ['queued', 'running', 'succeeded', 'failed', 'interrupted']),
    phase: enumeration(row.phase, ['queued', 'preparing', 'authorizing', 'downloading', 'verifying', 'installing',
      'activating', 'committing', 'recovering', 'completed', 'failed', 'interrupted']),
    createdAt: date(row.createdAt), updatedAt: date(row.updatedAt), ...optionalError(row),
  }
  if (row.result !== undefined) {
    const result = record(row.result)
    output.result = { generation: integer(result.generation), outcome: enumeration(result.outcome, ['succeeded', 'installed_not_enabled']),
      ...(result.releaseId === undefined ? {} : { releaseId: id(result.releaseId) }),
      ...(result.packId === undefined ? {} : { packId: id(result.packId) }),
      ...(result.activated === undefined ? {} : { activated: bool(result.activated) }), ...optionalError(result) }
  }
  return output
}
function bindInput(value: unknown): CenterBindInput {
  const row = exact(value, ['bindingCode', 'expectedRevision', 'expectedCenterId', 'trustedSigningKeys'])
  if (typeof row.bindingCode !== 'string' || !/^dpc_bind_[A-Za-z0-9_-]{43}$/.test(row.bindingCode)) fail()
  const keys = record(row.trustedSigningKeys), trustedSigningKeys: Record<string, string> = Object.create(null)
  if (!Object.keys(keys).length || Object.keys(keys).length > 16) fail()
  for (const [key, value] of Object.entries(keys)) {
    if (typeof value !== 'string' || value.length > 4096
      || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\r?\n?$/.test(value)) fail()
    trustedSigningKeys[id(key)] = value
  }
  return { bindingCode: row.bindingCode as string, expectedRevision: integer(row.expectedRevision), expectedCenterId: id(row.expectedCenterId), trustedSigningKeys }
}

function fence(req: IncomingMessage, token: string | undefined) {
  const seen = new Set<string>()
  let forwarded = Object.keys(req.headers).some(name => forwardingHeader(name.toLowerCase()))
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]!.toLowerCase()
    const intermediary = forwardingHeader(name)
    if (intermediary) forwarded = true
    if (!sensitiveHeaders.has(name) && !name.startsWith('sec-fetch-') && !intermediary) continue
    if (seen.has(name)) fail('CENTER_INVALID_REQUEST')
    seen.add(name)
  }
  const authority = req.headers.host
  if (typeof authority !== 'string' || !authority || /[\s\\/%@?#]/.test(authority)) fail('CENTER_CSRF_REJECTED', 403)
  // A canonical raw authority rejects numeric aliases (127.1), trailing dots, and parser repairs.
  let parsed: URL
  try { parsed = new URL(`http://${authority}`) } catch { return fail('CENTER_CSRF_REJECTED', 403) }
  if (parsed.host !== authority || parsed.hostname.endsWith('.') || parsed.hostname.includes('..')) fail('CENTER_CSRF_REJECTED', 403)
  // Proxies may rewrite Host to loopback and send only Via/X-Forwarded-Proto.
  // Any intermediary header, even an empty one, removes the local exemption;
  // a valid management token can still authorize the request independently.
  if (!authorizeManageRequest({ headers: req.headers, remoteAddress: forwarded ? undefined : req.socket.remoteAddress }, token).ok) fail('MANAGE_UNAUTHORIZED', 403)
  if (req.headers['x-pack-center-ui'] !== '1') fail('CENTER_UI_REQUIRED', 403)
  const source = req.headers.origin
  if (source !== undefined) {
    // A reverse proxy that rewrites Host to loopback forwards the external
    // authority in X-Pack-Center-External-Host (a dedicated header, so the
    // loopback manage exemption is unaffected); the browser's Origin refers
    // to that public authority, not to the rewritten loopback Host.
    // X-Forwarded-Host is honored as a fallback for token-authenticated calls.
    const candidates = [req.headers['x-pack-center-external-host'], req.headers['x-forwarded-host']]
    const forwarded = candidates.find((value): value is string => typeof value === 'string' && value.trim() !== '')
    const externalAuthority = forwarded !== undefined ? forwarded.split(',')[0]!.trim() : authority
    try {
      const safeOrigin = origin(source)
      const external = new URL(`http://${externalAuthority}`)
      if (external.host !== externalAuthority || external.hostname.endsWith('.') || external.hostname.includes('..')) {
        fail('CENTER_CSRF_REJECTED', 403)
      }
      if (new URL(safeOrigin).host !== externalAuthority) fail('CENTER_CSRF_REJECTED', 403)
    } catch { fail('CENTER_CSRF_REJECTED', 403) }
  }
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') fail('CENTER_CSRF_REJECTED', 403)
}
async function body(req: IncomingMessage, timeoutMs: number): Promise<unknown> {
  if (req.headers['content-encoding'] !== undefined
    || typeof req.headers['content-type'] !== 'string'
    || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(req.headers['content-type'])) fail()
  const rawLength = req.headers['content-length']
  if (rawLength !== undefined && (typeof rawLength !== 'string' || !/^(0|[1-9][0-9]*)$/.test(rawLength))) fail()
  if (Number(rawLength ?? 0) > maximumBody) fail('CENTER_BODY_TOO_LARGE', 413)
  return new Promise((resolve, reject) => {
    let size = 0, finished = false
    const chunks: Buffer[] = []
    const finish = (error?: RouteError) => {
      if (finished) return
      finished = true; clearTimeout(timer)
      req.off('data', data); req.off('end', end); req.off('aborted', aborted); req.off('error', aborted)
      if (error) { req.pause(); chunks.length = 0; reject(error) }
    }
    const data = (chunk: Buffer) => {
      size += chunk.length
      if (size > maximumBody) finish(new RouteError('CENTER_BODY_TOO_LARGE', 413))
      else chunks.push(chunk)
    }
    const end = () => {
      if (!req.complete || (rawLength !== undefined && Number(rawLength) !== size)) return finish(new RouteError('CENTER_INVALID_INPUT', 400))
      let parsed: unknown
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) }
      catch { return finish(new RouteError('CENTER_INVALID_INPUT', 400)) }
      finish(); chunks.length = 0; resolve(parsed)
    }
    const aborted = () => finish(new RouteError('CENTER_INVALID_INPUT', 400))
    const timer = setTimeout(() => finish(new RouteError('CENTER_BODY_TIMEOUT', 408)), timeoutMs)
    timer.unref()
    req.on('data', data); req.once('end', end); req.once('aborted', aborted); req.once('error', aborted)
  })
}
function respond(res: ServerResponse, status: number, payload: unknown) {
  if (res.destroyed || res.writableEnded) return
  const bytes = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer', ...(status === 413 || status === 408 ? { Connection: 'close' } : {}),
  })
  res.end(bytes)
}
function statusFor(code: string): number {
  if (code === 'CENTER_DISABLED' || code === 'CENTER_NOT_CONFIGURED' || code === 'OPERATION_CLOSED') return 503
  if (code === 'OPERATION_NOT_FOUND' || code === 'NOT_FOUND') return 404
  if (['UNAUTHENTICATED', 'FORBIDDEN', 'DEPLOYMENT_DISABLED'].includes(code)) return 403
  if (['CENTER_INVALID_INPUT', 'INVALID_INPUT', 'INVALID_REQUEST', 'CONNECTION_INVALID', 'BINDING_CODE_INVALID'].includes(code)) return 400
  if (code === 'RATE_LIMITED' || code === 'OPERATION_QUEUE_FULL' || code === 'OPERATION_LIMIT') return 429
  if (['REVISION_CONFLICT', 'GENERATION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'CENTER_TARGET_CHANGED', 'STATE_READ_ONLY',
    'CENTER_NOT_BOUND', 'CENTER_CREDENTIAL_EXPIRED', 'CENTER_ORIGIN_CHANGED', 'CENTER_RESTART_REQUIRED', 'CENTER_ACTIVATION_UNAVAILABLE',
    'OPERATION_NOT_RETRYABLE', 'OPERATION_CONFLICT', 'CENTER_BIND_UNCONFIRMED'].includes(code)) return 409
  return 502
}

export function createPackCenterRouteHandler(options: {
  service: CenterManageService; getManageToken: () => string | undefined
  /** Bounded body deadline; overriding it is useful for HTTP timeout tests. */
  bodyTimeoutMs?: number
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const timeoutMs = options.bodyTimeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid body deadline')
  const service = options.service
  return async (req, res) => {
    const raw = req.url ?? ''
    if (!(raw === prefix || raw.startsWith(`${prefix}/`) || raw.startsWith(`${prefix}?`)
      || raw.startsWith(`${prefix}%`) || raw.startsWith(`${prefix}\\`))) return false
    try {
      fence(req, options.getManageToken())
      if (raw.length > 2048 || /[\\#\s\u0000-\u001f\u007f]/.test(raw)) fail('CENTER_INVALID_REQUEST')
      const [path, query, ...extra] = raw.slice(prefix.length).split('?')
      if (!path || extra.length || path.includes('%') || path.includes('//') || path.includes('..')) fail('CENTER_INVALID_REQUEST')
      const method = req.method
      if (method !== 'GET' && method !== 'POST') fail('CENTER_METHOD_NOT_ALLOWED', 405)
      let action: (() => Promise<unknown>) | undefined
      let project: (value: unknown) => unknown = value => value
      let status = 200
      if (method === 'GET') {
        if (req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) !== 0) fail()
        if (query !== undefined && path !== '/catalog') fail()
        if (path === '/connection') { action = () => service.connection(); project = connection }
        else if (path === '/catalog') {
          const input: { packId?: string; limit?: number; beforeId?: string } = {}
          if (query !== undefined) {
            if (!query || /%(?![a-f0-9]{2})/i.test(query)) fail()
            const parameters = new URLSearchParams(query)
            for (const [key, value] of parameters) {
              if (!['packId', 'limit', 'beforeId'].includes(key) || parameters.getAll(key).length !== 1) fail()
              if (key === 'limit') {
                if (!/^(?:[1-9][0-9]?|100)$/.test(value)) fail()
                input.limit = Number(value)
              } else input[key as 'packId' | 'beforeId'] = id(value)
            }
          }
          action = () => service.catalog(input); project = catalog
        } else if (path === '/installations') { action = () => service.installations(); project = installations }
        else if (path === '/updates') { action = () => service.updates(); project = updates }
        else if (path === '/operations') { action = () => service.operations(); project = value => list(value).map(operation) }
        else {
          const match = /^\/(releases|operations)\/([^/]+)$/.exec(path)
          if (match) {
            const identifier = id(match[2], match[1] === 'operations')
            if (match[1] === 'releases') { action = () => service.release(identifier); project = value => release(value, true) }
            else { action = () => service.operation(identifier); project = operation }
          }
        }
      } else {
        if (query !== undefined) fail()
        const retry = /^\/operations\/([^/]+)\/retry$/.exec(path)
        if (!['/bind', '/unbind', '/check-updates', '/operations'].includes(path) && !retry) fail('CENTER_ROUTE_NOT_FOUND', 404)
        const input = await body(req, timeoutMs)
        if (path === '/bind') { const validated = bindInput(input); action = () => service.bind(validated); project = connection }
        else if (path === '/unbind') { const row = exact(input, ['expectedRevision']); const expectedRevision = integer(row.expectedRevision); action = () => service.unbind({ expectedRevision }); project = connection }
        else if (path === '/check-updates') { exact(input, []); action = () => service.checkUpdates(); project = updates }
        else if (path === '/operations') { const validated = operationInput(input); action = () => service.enqueue(validated); project = operation; status = 202 }
        else if (retry) { exact(input, []); const identifier = id(retry[1], true); action = () => service.retry(identifier); project = operation; status = 202 }
      }
      if (!action) fail('CENTER_ROUTE_NOT_FOUND', 404)
      const result = await action()
      let projected: unknown
      try { projected = project(result) } catch { fail('CENTER_RESPONSE_INVALID', 502) }
      respond(res, status, { ok: true, data: projected })
    } catch (error) {
      const row = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {}
      const code = errorCode(row.code)
      const reason = code === 'CENTER_BIND_UNCONFIRMED' && typeof row.reason === 'string' && safeCodes.has(row.reason) ? row.reason : undefined
      respond(res, error instanceof RouteError ? error.status : statusFor(code), { ok: false, error: { code, ...(reason ? { reason } : {}) } })
    }
    return true
  }
}
