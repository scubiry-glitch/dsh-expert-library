/**
 * Host-only center client. No browser credentials and no runtime network hook.
 * This module is not an HTTP handler: localState / operation results contain
 * host filesystem paths and must never be serialized directly into browser RPC.
 * Remote install only caches; activation requires the real host's preflight.
 */
import { createPublicKey } from 'node:crypto'
import { lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import {
  assertContract, canonicalBytes, canonicalJson, checkCompatibility, ContractError,
  sha256, validateCatalogRelease, verifyReleaseManifest,
  type Capabilities, type CatalogRelease, type ReleaseManifest, type SignedReleaseManifest,
} from '#pack-contract'
import {
  createPackCenterConnectionStore, PackCenterConnectionError, publicView, signingKeyFingerprints,
  type PackCenterConnectionSnapshot, type StoredPackCenterConnection,
} from './pack-center-connection.ts'
import {
  createPackCenterTransport, normalizePackCenterOrigin, PackCenterTransportError,
  type PackCenterTransportOptions,
} from './pack-center-transport.ts'
import { createPackStore, PackStoreError, type PackOperationInput, type PackStoreOptions } from './pack-store.ts'
import { canonicalStateJson, PackCenterStateError } from './pack-center-state.ts'

export interface PackCenterClientOptions {
  /** Explicit operator configuration, never an arbitrary browser-supplied URL. */
  origin: string
  /** Fixed deployment-local pair: <deploymentRoot>/private and /inventory.
   * Arbitrary independent roots are deliberately refused: otherwise two
   * credential stores could race to claim the same initially empty inventory.
   */
  connectionRoot: string
  inventoryRoot: string
  capabilities: Capabilities
  builtinVersions?: PackStoreOptions['builtinVersions']
  validateActivation?: PackStoreOptions['validateActivation']
  lockTimeoutMs?: number
  timeoutMs?: number
  maxJsonBytes?: number
  maxArchiveBytes?: number
  /** Fixture-only controls. Do not expose through settings or HTTP input. */
  allowLoopbackHttp?: boolean
  testCa?: string
}

export interface BindPackCenterInput {
  bindingCode: string
  expectedRevision: number
  expectedCenterId: string
  /** Obtained independently, BEFORE exchanging the one-use code. */
  trustedSigningKeys: Record<string, string>
}
export interface PackCenterListInput { packId?: string; beforeId?: string; limit?: number; signal?: AbortSignal }
export interface RemotePackInstallInput extends PackOperationInput {
  releaseId: string; signal?: AbortSignal
  target?: { manifestSha256: string; artifactSha256: string; contentTreeSha256: string }
  connectionRevision?: number
}
export type PackInstallPhase = 'authorizing' | 'downloading' | 'verifying' | 'installing' | 'activating'

/** Fixed messages only; raw filesystem paths, HTTP bodies and secrets never escape. */
export class PackCenterClientError extends Error {
  readonly code: string
  readonly reason?: string
  readonly status?: number
  constructor(code: string, options: { reason?: string; status?: number } = {}) {
    super(code === 'CENTER_BIND_UNCONFIRMED'
      ? 'Binding may have consumed its one-use code. Read local revision and inspect/revoke center credentials before requesting a new code.'
      : code)
    this.name = 'PackCenterClientError'
    this.code = code
    if (options.reason !== undefined) this.reason = options.reason
    if (options.status !== undefined) this.status = options.status
  }
}

function fail(code: string): never { throw new PackCenterClientError(code) }
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) fail('CENTER_RESPONSE_INVALID')
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
    || value.includes('..') || ['__proto__', 'constructor', 'prototype'].includes(value)) fail('CENTER_INVALID_INPUT')
  return value
}
function generation(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('CENTER_INVALID_INPUT')
  return value
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) fail('CENTER_RESPONSE_INVALID')
  return value
}
function date(value: unknown): string {
  const result = text(value, 24)
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result)
    || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) fail('CENTER_RESPONSE_INVALID')
  return result
}
function capture<T>(value: T): T {
  try {
    const json = canonicalStateJson(value)
    if (Buffer.byteLength(json) > 64 * 1024) fail('CENTER_INVALID_INPUT')
    return JSON.parse(json) as T
  } catch { return fail('CENTER_INVALID_INPUT') }
}
function keysExactly(value: object, required: string[], optional: string[] = []): void {
  if (required.some(key => !own(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('CENTER_INVALID_INPUT')
}
function safe(error: unknown): PackCenterClientError {
  if (error instanceof PackCenterClientError) return error
  if (error instanceof PackCenterTransportError || error instanceof PackCenterConnectionError
    || error instanceof PackCenterStateError || error instanceof PackStoreError || error instanceof ContractError) {
    return new PackCenterClientError(/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'CENTER_REQUEST_FAILED',
      error instanceof PackCenterTransportError && error.status !== undefined ? { status: error.status } : {})
  }
  return new PackCenterClientError('CENTER_REQUEST_FAILED')
}
async function guarded<T>(action: () => Promise<T>): Promise<T> {
  try { return await action() } catch (error) { throw safe(error) }
}
function aborted(signal?: AbortSignal): void { if (signal?.aborted) fail('CENTER_CANCELLED') }

export function createPackCenterClient(options: PackCenterClientOptions) {
  const origin = normalizePackCenterOrigin(options.origin, options.allowLoopbackHttp)
  const connectionRoot = options.connectionRoot, inventoryRoot = options.inventoryRoot
  for (const root of [connectionRoot, inventoryRoot]) {
    if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root
      || root === parse(root).root || root === homedir()) fail('CENTER_INVALID_STORAGE')
  }
  if (connectionRoot === inventoryRoot || connectionRoot.startsWith(`${inventoryRoot}${sep}`)
    || inventoryRoot.startsWith(`${connectionRoot}${sep}`)) fail('CENTER_INVALID_STORAGE')
  if (connectionRoot !== join(dirname(inventoryRoot), 'private')
    || inventoryRoot !== join(dirname(connectionRoot), 'inventory')) fail('CENTER_INVALID_STORAGE')
  const maxArchiveBytes = options.maxArchiveBytes ?? 64 * 1024 * 1024
  if (!Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes < 1 || maxArchiveBytes > 1024 * 1024 * 1024) fail('CENTER_INVALID_INPUT')
  const capabilities = capture(options.capabilities)
  const builtinVersions = options.builtinVersions === undefined ? undefined : capture(options.builtinVersions)
  const validateActivation = options.validateActivation
  const connectionStore = createPackCenterConnectionStore(connectionRoot, {
    lockTimeoutMs: options.lockTimeoutMs, allowLoopbackHttp: options.allowLoopbackHttp,
  })
  const transportOptions: PackCenterTransportOptions = {
    origin, allowLoopbackHttp: options.allowLoopbackHttp, timeoutMs: options.timeoutMs,
    maxJsonBytes: options.maxJsonBytes, testCa: options.testCa,
  }
  const transport = createPackCenterTransport(transportOptions)
  const lockTimeoutMs = options.lockTimeoutMs

  function localStore(snapshot: PackCenterConnectionSnapshot) {
    const connection = snapshot.connection
    if (!connection) return fail('CENTER_NOT_CONFIGURED')
    return createPackStore(inventoryRoot, {
      centerId: connection.centerId, trustedKeys: { ...connection.trustedSigningKeys }, capabilities,
      builtinVersions, validateActivation, lockTimeoutMs,
    })
  }
  async function remote() {
    const snapshot = await connectionStore.read(), connection = snapshot.connection
    if (!connection?.credentialToken) fail('CENTER_NOT_BOUND')
    if (connection.origin !== origin) fail('CENTER_ORIGIN_CHANGED')
    if (Date.parse(connection.credentialExpiresAt) <= Date.now()) fail('CENTER_CREDENTIAL_EXPIRED')
    return { snapshot, connection, token: connection.credentialToken }
  }
  async function unchanged(revision: number) {
    if ((await connectionStore.read()).revision !== revision) fail('REVISION_CONFLICT')
  }
  function verified(envelope: unknown, connection: StoredPackCenterConnection, releaseId: string) {
    const manifest = verifyReleaseManifest(envelope, connection.trustedSigningKeys)
    if (manifest.centerId !== connection.centerId || manifest.releaseId !== releaseId) fail('CENTER_RELEASE_MISMATCH')
    return manifest
  }
  function availability(value: unknown, code: 'DEPENDENCY_UNAVAILABLE' | 'BASELINE_UNAVAILABLE') {
    const source = record(value)
    if (source.available === true && source.code === undefined) return { available: true as const }
    if (source.available === false && source.code === code) return { available: false as const, code }
    return fail('CENTER_RESPONSE_INVALID')
  }
  function releaseView(value: unknown, centerId: string) {
    const row = record(value)
    if (!validateCatalogRelease(row.manifest).ok) fail('CENTER_RESPONSE_INVALID')
    const manifest = row.manifest as CatalogRelease
    if (manifest.centerId !== centerId || row.releaseId !== manifest.releaseId || row.packId !== manifest.packId
      || row.ownerOrgId !== manifest.ownerOrgId || row.version !== manifest.version) fail('CENTER_RELEASE_MISMATCH')
    return {
      releaseId: manifest.releaseId, packId: manifest.packId, ownerOrgId: manifest.ownerOrgId,
      version: manifest.version, name: text(row.name, 1000), publishedAt: date(row.publishedAt), manifest,
      distribution: assertContract('scope', row.distribution),
      downloadAvailability: availability(row.downloadAvailability, 'DEPENDENCY_UNAVAILABLE'),
      compatibility: checkCompatibility(manifest, capabilities),
    }
  }
  function localOperation<T extends PackOperationInput>(input: T, fields: string[]) {
    const request = capture(input)
    keysExactly(request, ['operationKey', 'expectedGeneration', ...fields])
    // The remote API uses a stricter, bounded subset of durable operation keys.
    if (typeof request.operationKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.operationKey)
      || ['__proto__', 'prototype', 'constructor'].includes(request.operationKey)) fail('CENTER_INVALID_INPUT')
    generation(request.expectedGeneration)
    for (const field of fields) id((request as Record<string, unknown>)[field])
    return request
  }

  function pinned(manifest: ReleaseManifest, target: RemotePackInstallInput['target']) {
    if (target && (target.manifestSha256 !== sha256(canonicalBytes(manifest))
      || target.artifactSha256 !== manifest.artifactSha256 || target.contentTreeSha256 !== manifest.contentTreeSha256)) fail('CENTER_TARGET_CHANGED')
  }
  function installRequest(input: RemotePackInstallInput) {
    const { signal, target: rawTarget, connectionRevision: rawRevision, ...fields } = input
    const request = localOperation(fields, ['releaseId'])
    const target = rawTarget === undefined ? undefined : capture(rawTarget)
    if (target !== undefined) {
      if (target === null || typeof target !== 'object' || Array.isArray(target)) fail('CENTER_INVALID_INPUT')
      keysExactly(target, ['manifestSha256', 'artifactSha256', 'contentTreeSha256'])
      if (Object.values(target).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) fail('CENTER_INVALID_INPUT')
    }
    const connectionRevision = rawRevision === undefined ? undefined : generation(rawRevision)
    return { signal, target, connectionRevision, request }
  }
  async function replayLocalInstall(input: RemotePackInstallInput, activate: boolean) {
    const { signal, target, request } = installRequest(input)
    if (typeof activate !== 'boolean') fail('CENTER_INVALID_INPUT')
    aborted(signal)
    const snapshot = await connectionStore.read()
    if (!snapshot.connection) return undefined
    // A historical receipt remains valid after unbind, credential expiry or
    // origin migration. It proves an already-committed action, not new consent.
    return localStore(snapshot).replayInstall({ ...request, activate, ...(target ? { target } : {}) })
  }
  async function installRemote(input: RemotePackInstallInput, activate: boolean, report: (phase: PackInstallPhase) => Promise<void>) {
    const { signal, target, connectionRevision, request } = installRequest(input)
    aborted(signal)
    const before = await connectionStore.read()
    if (before.connection) {
      const store = localStore(before), current = await store.readState()
      const receipt = current.state.acceptedReleases[request.releaseId]
      if (target && receipt && receipt.manifestSha256 !== target.manifestSha256) fail('CENTER_TARGET_CHANGED')
      const replay = await store.replayInstall({ ...request, activate, ...(target ? { target } : {}) })
      if (replay) return replay
      if (connectionRevision !== undefined && before.revision !== connectionRevision) fail('REVISION_CONFLICT')
      if (activate && !validateActivation) fail('CENTER_ACTIVATION_UNAVAILABLE')
      if (current.state.installed[request.releaseId]) {
        const local = await store.localRelease(request.releaseId)
        pinned(local.manifest, target)
        return connectionStore.withRevision(before.revision, async () => {
          aborted(signal); await report(activate ? 'activating' : 'installing')
          return store.install({ ...request, envelope: local.envelope, archiveFile: '', activate })
        })
      }
    }
    if (activate && !validateActivation) fail('CENTER_ACTIVATION_UNAVAILABLE')
    const { snapshot, connection, token } = await remote(), store = localStore(snapshot)
    if (connectionRevision !== undefined && snapshot.revision !== connectionRevision) fail('REVISION_CONFLICT')
    const current = await store.readState()
    if (current.mode !== 'normal') fail('STATE_READ_ONLY')
    if (current.state.generation !== request.expectedGeneration) fail('GENERATION_CONFLICT')
    await report('authorizing')
    const reply = record(await transport.json(`/api/v1/releases/${request.releaseId}/download-grants`, {
      method: 'POST', credentialToken: token, body: {}, signal,
    }))
    if (reply.schemaVersion !== 1 || reply.centerId !== connection.centerId || reply.releaseId !== request.releaseId
      || reply.artifactPath !== `/api/v1/releases/${request.releaseId}/artifact`
      || typeof reply.grantToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(reply.grantToken)) fail('CENTER_RESPONSE_INVALID')
    if (Date.parse(date(reply.expiresAt)) <= Date.now()) fail('CENTER_GRANT_EXPIRED')
    const manifest = verified(reply.signedManifest, connection, request.releaseId)
    pinned(manifest, target)
    if (!checkCompatibility(manifest, capabilities).compatible) fail('INCOMPATIBLE_RELEASE')
    if (manifest.sizeBytes < 1 || manifest.sizeBytes > maxArchiveBytes) fail('CENTER_ARTIFACT_TOO_LARGE')
    await unchanged(snapshot.revision); aborted(signal)
    const temporary = await mkdtemp(join(connectionRoot, '.download-'))
    try {
      const archiveFile = join(temporary, 'release.tar')
      await report('downloading')
      await transport.download(reply.artifactPath as string, archiveFile, {
        credentialToken: token, downloadGrant: reply.grantToken, expectedSha256: manifest.artifactSha256,
        expectedBytes: manifest.sizeBytes, maxBytes: maxArchiveBytes, signal,
      })
      await report('verifying')
      return await connectionStore.withRevision(snapshot.revision, async () => {
        aborted(signal)
        await store.initialize()
        await report('installing')
        return store.install({ ...request, envelope: reply.signedManifest as SignedReleaseManifest, archiveFile, activate })
      })
    } finally { await rm(temporary, { recursive: true, force: true }).catch(() => {}) }
  }

  return {
    getConnection: () => guarded(async () => publicView(await connectionStore.read())),

    async bind(input: BindPackCenterInput) {
      return guarded(async () => {
        // Snapshot and validate every user input before consuming a one-use code.
        const request = capture(input)
        keysExactly(request, ['bindingCode', 'expectedRevision', 'expectedCenterId', 'trustedSigningKeys'])
        generation(request.expectedRevision); id(request.expectedCenterId)
        if (typeof request.bindingCode !== 'string' || !/^dpc_bind_[A-Za-z0-9_-]{43}$/.test(request.bindingCode)) fail('CENTER_INVALID_INPUT')
        const fingerprints = signingKeyFingerprints(request.trustedSigningKeys)
        const before = await connectionStore.read()
        if (before.revision !== request.expectedRevision) fail('REVISION_CONFLICT')
        // A private inventory is permanently namespaced to one center. A new
        // center uses fresh directories, never silently replaces offline trust.
        if (before.connection && before.connection.centerId !== request.expectedCenterId) fail('CENTER_ID_LOCKED')
        if (!before.connection) {
          // A lost/moved private binding must not be recreated around somebody
          // else's existing inventory (including orphaned releases or receipts).
          try {
            const info = await lstat(inventoryRoot)
            if (!info.isDirectory() || info.isSymbolicLink() || await realpath(inventoryRoot) !== inventoryRoot) fail('CENTER_INVALID_STORAGE')
            if ((await readdir(inventoryRoot)).length !== 0) fail('CENTER_INVENTORY_NOT_EMPTY')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        const trustedSigningKeys = { ...before.connection?.trustedSigningKeys }
        const previous = before.connection ? signingKeyFingerprints(before.connection.trustedSigningKeys) : {}
        for (const [keyId, fingerprint] of Object.entries(fingerprints)) {
          if (previous[keyId] !== undefined && previous[keyId] !== fingerprint) fail('CENTER_KEY_REASSIGNMENT')
          trustedSigningKeys[keyId] = createPublicKey(request.trustedSigningKeys[keyId]!).export({ type: 'spki', format: 'pem' }).toString()
        }
        signingKeyFingerprints(trustedSigningKeys) // bounded retained historical key set
        try {
          const reply = record(await transport.json('/api/v1/deployment-bindings/exchange', {
            method: 'POST', body: { bindingCode: request.bindingCode },
          }))
          const deployment = record(reply.deployment), credential = record(reply.credential), trust = record(reply.trustInfo)
          if (reply.centerId !== request.expectedCenterId || trust.centerId !== request.expectedCenterId
            || trust.schemaVersion !== 1 || !Array.isArray(trust.signingKeys) || trust.signingKeys.length < 1
            || trust.signingKeys.length > 16 || deployment.status !== 'active') fail('CENTER_TRUST_MISMATCH')
          const advertised: Record<string, string> = {}
          for (const item of trust.signingKeys) {
            const key = record(item), keyId = id(key.keyId)
            if (own(advertised, keyId)) fail('CENTER_TRUST_MISMATCH')
            advertised[keyId] = text(key.publicKeyPem, 2048)
            if (signingKeyFingerprints({ [keyId]: advertised[keyId]! })[keyId] !== key.fingerprintSha256) fail('CENTER_TRUST_MISMATCH')
          }
          const advertisedFingerprints = signingKeyFingerprints(advertised)
          for (const [keyId, fingerprint] of Object.entries(fingerprints)) {
            if (advertisedFingerprints[keyId] !== fingerprint) fail('CENTER_TRUST_MISMATCH')
          }
          if (!Array.isArray(credential.scopes) || credential.scopes.length !== 2
            || !credential.scopes.includes('catalog:read') || !credential.scopes.includes('release:download')) fail('CENTER_RESPONSE_INVALID')
          if (typeof reply.credentialToken !== 'string' || !/^dpc_token_[A-Za-z0-9_-]{43}$/.test(reply.credentialToken)) fail('CENTER_RESPONSE_INVALID')
          const credentialExpiresAt = date(credential.expiresAt), boundAt = new Date().toISOString()
          if (credentialExpiresAt <= boundAt) fail('CENTER_CREDENTIAL_EXPIRED')
          const next: StoredPackCenterConnection = {
            origin, centerId: request.expectedCenterId, organizationId: id(deployment.organizationId), deploymentId: id(deployment.id),
            credentialId: id(credential.id), credentialToken: reply.credentialToken, credentialExpiresAt, boundAt, trustedSigningKeys,
          }
          return publicView(await connectionStore.write(next, before.revision))
        } catch (error) {
          // No compensating remote call or retry: it could consume another code
          // or revoke the wrong credential after an ambiguous transport/commit.
          throw new PackCenterClientError('CENTER_BIND_UNCONFIRMED', { reason: safe(error).code })
        }
      })
    },

    async unbind(input: { expectedRevision: number }) {
      return guarded(async () => {
        const request = capture(input); keysExactly(request, ['expectedRevision']); generation(request.expectedRevision)
        const before = await connectionStore.read()
        if (before.revision !== request.expectedRevision) fail('REVISION_CONFLICT')
        // Local unbind is NOT center-side credential revocation.
        return publicView(await connectionStore.write(before.connection ? { ...before.connection, credentialToken: null } : null, before.revision))
      })
    },

    async listReleases(input: PackCenterListInput = {}) {
      return guarded(async () => {
        const { signal, ...fields } = input, request = capture(fields)
        keysExactly(request, [], ['packId', 'beforeId', 'limit'])
        const query = new URLSearchParams()
        if (request.packId !== undefined) query.set('packId', id(request.packId))
        if (request.beforeId !== undefined) query.set('beforeId', id(request.beforeId))
        if (request.limit !== undefined) {
          if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) fail('CENTER_INVALID_INPUT')
          query.set('limit', String(request.limit))
        }
        aborted(signal)
        const { snapshot, connection, token } = await remote()
        const suffix = query.size ? `?${query}` : ''
        const reply = record(await transport.json(`/api/v1/releases${suffix}`, { credentialToken: token, signal }))
        if (reply.schemaVersion !== 1 || reply.centerId !== connection.centerId || !Array.isArray(reply.items)
          || reply.items.length > (request.limit ?? 50)) fail('CENTER_RESPONSE_INVALID')
        const items = reply.items.map(item => releaseView(item, connection.centerId))
        if (new Set(items.map(item => item.releaseId)).size !== items.length
          || items.some(item => request.packId !== undefined && item.packId !== request.packId)) fail('CENTER_RESPONSE_INVALID')
        const nextCursor = reply.nextCursor === null ? null : id(reply.nextCursor)
        if (nextCursor !== null && (nextCursor !== items.at(-1)?.releaseId || nextCursor === request.beforeId)) fail('CENTER_RESPONSE_INVALID')
        await unchanged(snapshot.revision)
        return { schemaVersion: 1 as const, centerId: connection.centerId, items, nextCursor }
      })
    },

    async getRelease(releaseId: string, input: { signal?: AbortSignal } = {}) {
      return guarded(async () => {
        id(releaseId); const signal = input.signal; aborted(signal)
        const { snapshot, connection, token } = await remote()
        const reply = record(await transport.json(`/api/v1/releases/${releaseId}`, { credentialToken: token, signal }))
        const view = releaseView(reply, connection.centerId)
        const manifest = verified(reply.signedManifest, connection, releaseId)
        if (canonicalJson(manifest) !== canonicalJson(view.manifest)) fail('CENTER_RELEASE_MISMATCH')
        const validationReport = assertContract('report', reply.validationReport)
        if (!validationReport.valid || sha256(canonicalBytes(validationReport)) !== manifest.reportSha256) fail('CENTER_REPORT_MISMATCH')
        const diffAvailability = availability(reply.diffAvailability, 'BASELINE_UNAVAILABLE')
        if (!diffAvailability.available && reply.diff !== null) fail('CENTER_RESPONSE_INVALID')
        if (reply.diff !== null && (typeof reply.diff !== 'object' || Array.isArray(reply.diff))) fail('CENTER_RESPONSE_INVALID')
        await unchanged(snapshot.revision)
        // Diff and prose are informational, never inputs to signature trust or installation.
        return { ...view, signedManifest: reply.signedManifest as SignedReleaseManifest, validationReport,
          diff: reply.diff as Record<string, unknown> | null, diffAvailability,
          notes: text(reply.notes, 20000), license: text(reply.license, 1000) }
      })
    },

    install: (input: RemotePackInstallInput, report: (phase: PackInstallPhase) => Promise<void> = async () => {}) => guarded(() => installRemote(input, false, report)),
    updateEnable: (input: RemotePackInstallInput, report: (phase: PackInstallPhase) => Promise<void> = async () => {}) => guarded(() => installRemote(input, true, report)),
    /** Pure local receipt query; undefined means no committed install receipt. */
    replayInstall: (input: RemotePackInstallInput, activate = false) => guarded(() => replayLocalInstall(input, activate)),
    localRelease: (releaseId: string) => guarded(async () => { id(releaseId); return localStore(await connectionStore.read()).localRelease(releaseId) }),

    localState: () => guarded(async () => localStore(await connectionStore.read()).readState()),
    activeSnapshot: () => guarded(async () => localStore(await connectionStore.read()).activeSnapshot()),
    async enable(input: PackOperationInput & { releaseId: string }) {
      return guarded(async () => {
        const request = localOperation(input, ['releaseId'])
        if (!validateActivation) fail('CENTER_ACTIVATION_UNAVAILABLE')
        return localStore(await connectionStore.read()).enable(request)
      })
    },
    async disable(input: PackOperationInput & { packId: string }) {
      return guarded(async () => {
        const request = localOperation(input, ['packId'])
        if (!validateActivation) fail('CENTER_ACTIVATION_UNAVAILABLE')
        return localStore(await connectionStore.read()).disable(request)
      })
    },
    async rollback(input: PackOperationInput & { packId: string; releaseId: string }) {
      return guarded(async () => {
        const request = localOperation(input, ['packId', 'releaseId'])
        if (!validateActivation) fail('CENTER_ACTIVATION_UNAVAILABLE')
        return localStore(await connectionStore.read()).rollback(request)
      })
    },
    async uninstall(input: PackOperationInput & { releaseId: string }) {
      return guarded(async () => {
        const request = localOperation(input, ['releaseId'])
        return localStore(await connectionStore.read()).uninstall(request)
      })
    },
  }
}

export type PackCenterClient = ReturnType<typeof createPackCenterClient>
