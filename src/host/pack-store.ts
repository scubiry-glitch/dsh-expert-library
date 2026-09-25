/**
 * Immutable local release inventory. Network/download authorization belongs to
 * the caller; this module accepts only a local archive and a signed manifest.
 * Installing does not activate. One state rename commits every active switch.
 * Uninstall removes state references only: no inventory deletion can invalidate
 * a running task's captured paths. Offline garbage collection is not implemented.
 */
import type { KeyLike } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import {
  canonicalBytes, canonicalJson, checkCompatibility, compareSemVer,
  hashContentDirectory, sha256, verifyReleaseManifest,
  type Capabilities, type ReleaseManifest, type SignedReleaseManifest,
} from '#pack-contract'
import { extractArtifact } from '#pack-artifact'
import { loadPackFromDir, type DomainPackV2 } from '../pack-validator.ts'
import { prepareLegacySnapshot, verifyLegacyRecord, verifyLegacySuppression } from './pack-legacy.ts'
import {
  createPackCenterStateStore, type InstalledPackRecord, type PackCenterState,
  type PackCenterStateOptions, type StateTransactionRequest, type StateJson,
} from './pack-center-state.ts'

export class PackStoreError extends Error {
  readonly code: string
  readonly details: Readonly<Record<string, unknown>>
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'PackStoreError'
    this.code = code
    this.details = details
  }
}

export interface PackStoreOptions {
  centerId: string
  trustedKeys: ReadonlyMap<string, KeyLike> | Record<string, KeyLike>
  capabilities: Capabilities
  builtinVersions?: Readonly<Record<string, string>>
  /** Host must preflight its actual builtin/workspace merge before switching. No network. */
  validateActivation?: (state: Readonly<PackCenterState>) => Promise<void> | void
  lockTimeoutMs?: number
  /** Test-only injection. Inventory is durable before any state commit. */
  fault?: PackCenterStateOptions['fault']
}

export interface PackOperationInput { operationKey: string; expectedGeneration: number }
export interface PackReleaseTarget { manifestSha256: string; artifactSha256: string; contentTreeSha256: string }
export interface InstallReleaseInput extends PackOperationInput {
  envelope: SignedReleaseManifest
  archiveFile: string
  /** Explicit user choice only; omission/false means cache without activation. */
  activate?: boolean
}

export interface LocalActiveSnapshot {
  generation: number
  mode: 'normal' | 'recovered-read-only'
  warning?: { code: 'STATE_CORRUPT' | 'STATE_MISSING'; message: string }
  packs: ReadonlyArray<{
    releaseId: string; packId: string; root: string; contentTreeSha256: string
    source: 'center' | 'legacy'
  }>
  suppressedLegacyPaths: readonly string[]
}

function fail(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new PackStoreError(code, message, details)
}
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key)
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}
function sameIdentity(a: ReleaseManifest, b: ReleaseManifest): boolean {
  return a.centerId === b.centerId && a.ownerOrgId === b.ownerOrgId && a.packId === b.packId
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function syncTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await syncTree(path)
    else if (entry.isFile()) {
      const handle = await open(path, 'r')
      try { await handle.sync() } finally { await handle.close() }
    } else fail('INVENTORY_UNSAFE', 'Inventory may contain only regular files and directories')
  }
  await syncDirectory(root)
}

/** root must be a private deployment-local directory, never an auto-discovery vendor root. */
export function createPackStore(rootInput: string, options: PackStoreOptions) {
  if (!isAbsolute(rootInput) || resolve(rootInput) !== rootInput) fail('INVALID_ROOT', 'Pack store root must be an absolute normalized path')
  const root = rootInput
  const releasesRoot = join(root, 'releases')
  const incomingRoot = join(root, '.incoming')
  // Copy caller-owned capability configuration; changing it requires a new store.
  const centerId = options.centerId
  const capabilities: Capabilities = {
    pluginVersion: options.capabilities.pluginVersion,
    ...(options.capabilities.packSchemaVersions ? { packSchemaVersions: [...options.capabilities.packSchemaVersions] } : {}),
  }
  const builtins = { ...options.builtinVersions }

  function releasePath(manifest: Pick<ReleaseManifest, 'releaseId' | 'centerId'>): string {
    return join(releasesRoot, sha256(canonicalBytes({ centerId: manifest.centerId, releaseId: manifest.releaseId })))
  }
  async function assertPrivateDirectory(path: string): Promise<void> {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) {
      fail('INVENTORY_UNSAFE', 'Pack-store directories must be real, non-symlink directories', { path })
    }
  }
  async function ensureDirectories(): Promise<void> {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await assertPrivateDirectory(root)
    await mkdir(releasesRoot, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    await mkdir(incomingRoot, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    await assertPrivateDirectory(releasesRoot)
    await assertPrivateDirectory(incomingRoot)
  }
  function verify(envelope: unknown): ReleaseManifest {
    const manifest = verifyReleaseManifest(envelope, options.trustedKeys)
    if (manifest.centerId !== centerId) fail('CENTER_MISMATCH', 'Release is signed for a different center')
    return manifest
  }
  function assertCompatible(manifest: ReleaseManifest): void {
    const check = checkCompatibility(manifest, capabilities)
    if (!check.compatible) fail('INCOMPATIBLE_RELEASE', 'Release is incompatible with this deployment', { releaseId: manifest.releaseId, reasons: check.reasons })
  }
  async function verifyContent(packPath: string, manifest: ReleaseManifest): Promise<DomainPackV2> {
    const digest = await hashContentDirectory(packPath)
    if (digest.contentTreeSha256 !== manifest.contentTreeSha256 || digest.fileCount !== manifest.fileCount) {
      fail('CONTENT_DIGEST_MISMATCH', 'Installed release content does not match its signed manifest', { releaseId: manifest.releaseId })
    }
    const loaded = await loadPackFromDir(packPath)
    if (!loaded.ok || !loaded.pack) fail('PACK_INVALID', 'Release content failed the local V2 validator', { diagnostics: loaded.diagnostics })
    if (loaded.pack.pack.id !== manifest.packId || loaded.pack.pack.version !== manifest.version) {
      fail('PACK_IDENTITY_MISMATCH', 'Pack metadata differs from the approved release')
    }
    const locked = new Set([...manifest.dependencyLock, ...manifest.builtinDependencies].map(item => item.packId))
    for (const packId of loaded.pack.pack.dependsOn ?? []) {
      if (!locked.has(packId)) fail('DEPENDENCY_MANIFEST_MISMATCH', 'A declared pack dependency is absent from the signed release lock', { packId })
    }
    return loaded.pack
  }
  async function signedMetadata(directory: string): Promise<SignedReleaseManifest> {
    await assertPrivateDirectory(root)
    await assertPrivateDirectory(releasesRoot)
    await assertPrivateDirectory(directory)
    const manifestPath = join(directory, 'release.json')
    const stat = await lstat(manifestPath)
    const maximum = 1024 * 1024
    if (!stat.isFile() || stat.nlink !== 1 || stat.isSymbolicLink() || stat.size > maximum || stat.size < 1) {
      fail('INVENTORY_UNSAFE', 'Signed release metadata must be one bounded regular file')
    }
    const handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.nlink !== 1 || opened.size < 1 || opened.size > maximum
        || opened.dev !== stat.dev || opened.ino !== stat.ino) fail('INVENTORY_UNSAFE', 'Signed release metadata changed while opening')
      const bytes = Buffer.alloc(maximum + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      const after = await handle.stat(), named = await lstat(manifestPath)
      if (length !== opened.size || length > maximum || !after.isFile() || after.nlink !== 1
        || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.dev !== opened.dev || named.ino !== opened.ino) {
        fail('INVENTORY_UNSAFE', 'Signed release metadata changed while reading')
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as SignedReleaseManifest
    } finally { await handle.close() }
  }
  async function verifyDirectory(directory: string, expected?: ReleaseManifest): Promise<ReleaseManifest> {
    const manifest = verify(await signedMetadata(directory))
    if (releasePath(manifest) !== directory) fail('INVENTORY_IDENTITY_MISMATCH', 'Release is stored under an incorrect inventory address')
    if (expected && canonicalJson(manifest) !== canonicalJson(expected)) {
      fail('IMMUTABLE_RELEASE_CONFLICT', 'An existing release ID cannot be replaced by different signed metadata')
    }
    await verifyContent(join(directory, 'content'), manifest)
    return manifest
  }
  async function verifyRecord(record: InstalledPackRecord): Promise<ReleaseManifest> {
    if (record.source !== 'center') fail('LEGACY_VERIFIER_REQUIRED', 'Legacy inventory requires the explicit migration verifier')
    const directory = releasePath({ centerId: record.centerId!, releaseId: record.releaseId })
    if (record.packPath !== join(directory, 'content') || record.manifestPath !== join(directory, 'release.json')) {
      fail('INVENTORY_PATH_MISMATCH', 'State references a path outside the immutable release location')
    }
    const manifest = await verifyDirectory(directory)
    for (const key of ['releaseId', 'packId', 'version', 'artifactSha256', 'contentTreeSha256', 'centerId', 'ownerOrgId'] as const) {
      if (manifest[key] !== record[key]) fail('INVENTORY_IDENTITY_MISMATCH', `State and signed manifest disagree on ${key}`)
    }
    return manifest
  }
  async function verifyActiveGraph(state: Readonly<PackCenterState>): Promise<void> {
    const active = new Map<string, ReleaseManifest>()
    const legacy = new Map<string, DomainPackV2>()
    const entityOwners = new Map<string, string>()
    for (const [packId, releaseId] of Object.entries(state.active)) {
      const record = state.installed[releaseId]
      if (!record || record.packId !== packId) fail('INVENTORY_MISSING', 'Active release is not present in inventory')
      let pack: DomainPackV2
      if (record.source === 'legacy') {
        pack = await verifyLegacyRecord(root, record)
        if (!(capabilities.packSchemaVersions ?? [2]).includes(2)) fail('INCOMPATIBLE_RELEASE', 'Current plugin does not support this local V2 snapshot')
        legacy.set(packId, pack)
      } else {
        const manifest = await verifyRecord(record)
        assertCompatible(manifest)
        active.set(packId, manifest)
        const loaded = await loadPackFromDir(record.packPath)
        if (!loaded.ok || !loaded.pack) fail('PACK_INVALID', 'Active pack failed local validation')
        pack = loaded.pack
      }
      for (const [section, entities] of Object.entries(pack)) {
        if (!Array.isArray(entities)) continue
        for (const entity of entities) {
          const key = `${section}/${entity.id}`
          const owner = entityOwners.get(key)
          if (owner && owner !== packId) fail('ENTITY_CONFLICT', 'Center packs cannot silently replace another pack’s entities', { entity: key, packIds: [owner, packId] })
          entityOwners.set(key, packId)
        }
      }
    }
    for (const [packId, pack] of legacy) {
      for (const dependency of pack.pack.dependsOn ?? []) {
        if (!active.has(dependency) && !legacy.has(dependency) && !own(builtins, dependency)) {
          fail('DEPENDENCY_BLOCKED', 'Local legacy pack requires a missing active or built-in dependency', { affectedPackId: packId, dependencyPackId: dependency })
        }
      }
    }
    for (const [packId, manifest] of active) {
      for (const dependency of manifest.dependencyLock) {
        const target = active.get(dependency.packId)
        const matches = target && target.centerId === manifest.centerId &&
          (['ownerOrgId', 'releaseId', 'version', 'artifactSha256', 'contentTreeSha256'] as const)
            .every(key => target[key] === dependency[key])
        if (!matches) fail('DEPENDENCY_BLOCKED', 'Active pack requires a different exact dependency release', {
          affectedPackId: packId, dependencyPackId: dependency.packId, requiredReleaseId: dependency.releaseId,
          actualReleaseId: target?.releaseId ?? null,
        })
      }
      for (const dependency of manifest.builtinDependencies) {
        const version = own(builtins, dependency.packId) ? builtins[dependency.packId] : undefined
        if (!version || compareSemVer(version, dependency.minVersion) < 0 ||
          (dependency.maxVersionExclusive && compareSemVer(version, dependency.maxVersionExclusive) >= 0)) {
          fail('BUILTIN_DEPENDENCY_BLOCKED', 'Required built-in pack is absent or incompatible', { affectedPackId: packId, dependencyPackId: dependency.packId })
        }
      }
    }
    const visiting = new Set<string>()
    const visited = new Set<string>()
    function visit(packId: string): void {
      if (visiting.has(packId)) fail('DEPENDENCY_CYCLE', 'Active release dependencies contain a cycle')
      if (visited.has(packId)) return
      visiting.add(packId)
      const dependencies = active.get(packId)?.dependencyLock.map(item => item.packId) ?? legacy.get(packId)?.pack.dependsOn ?? []
      for (const dependency of dependencies) if (active.has(dependency) || legacy.has(dependency)) visit(dependency)
      visiting.delete(packId)
      visited.add(packId)
    }
    for (const packId of active.keys()) visit(packId)
    for (const packId of legacy.keys()) visit(packId)
  }
  const stateStore = createPackCenterStateStore(root, {
    lockTimeoutMs: options.lockTimeoutMs,
    fault: options.fault,
    validateSnapshot: async state => {
      for (const record of Object.values(state.installed)) {
        if (record.source === 'legacy') await verifyLegacyRecord(root, record)
        else await verifyRecord(record)
      }
      for (const [vendorPath, suppression] of Object.entries(state.legacySuppressions)) {
        await verifyLegacySuppression(root, vendorPath, suppression)
      }
      await verifyActiveGraph(state)
    },
  })

  async function replay(request: StateTransactionRequest) {
    const { state } = await stateStore.readState()
    if (!own(state.operations, request.operationKey)) return undefined
    return stateStore.transact(request, () => fail('OPERATION_DISAPPEARED', 'Previously committed operation is no longer available'))
  }
  function requireRecord(state: PackCenterState, releaseId: string): InstalledPackRecord {
    if (!own(state.installed, releaseId)) fail('RELEASE_NOT_INSTALLED', 'Requested release is not installed')
    return state.installed[releaseId]!
  }
  async function switchActive(state: PackCenterState, releaseId: string): Promise<void> {
    const record = requireRecord(state, releaseId)
    if (record.source === 'legacy') await verifyLegacyRecord(root, record)
    else assertCompatible(await verifyRecord(record))
    const previous = state.active[record.packId]
    if (previous && previous !== releaseId) record.previousReleaseId = previous
    state.active[record.packId] = releaseId
    await verifyActiveGraph(state)
    await options.validateActivation?.(frozen(structuredClone(state)))
  }

  return {
    async initialize() {
      // Initialize state BEFORE creating inventory directories: an interrupted
      // initialization must not make a populated but stateless store look empty.
      await mkdir(root, { recursive: true, mode: 0o700 })
      await assertPrivateDirectory(root)
      const state = await stateStore.initialize()
      await ensureDirectories()
      return state
    },
    readState: stateStore.readState,

    /** Host reconnect/retry can resolve a committed cache-only install offline.
     * The permanent accepted-release digest reconstructs the exact original
     * request; stateStore rechecks it under its process-safe transaction lock.
     * This is a receipt lookup, not authorization to install anything new.
     */
    async replayInstall(input: PackOperationInput & { releaseId: string; activate?: boolean; target?: PackReleaseTarget }) {
      const { releaseId, operationKey, expectedGeneration, activate } = input
      const target = input.target === undefined ? undefined : JSON.parse(canonicalJson(input.target)) as PackReleaseTarget
      if (target !== undefined && (target === null || typeof target !== 'object' || Array.isArray(target)
        || Object.keys(target).sort().join(',') !== 'artifactSha256,contentTreeSha256,manifestSha256'
        || Object.values(target).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))) {
        fail('INVALID_REQUEST', 'Release target must contain exactly three SHA-256 digests')
      }
      const { state } = await stateStore.readState()
      if (!own(state.operations, operationKey)) return undefined
      const receipt = own(state.acceptedReleases, releaseId) ? state.acceptedReleases[releaseId] : undefined
      if (!receipt || receipt.centerId !== centerId) fail('IDEMPOTENCY_CONFLICT', 'Operation key does not identify this center release')
      // Uninstall retains immutable release metadata. A receipt lookup verifies
      // that metadata but never reinstalls content or changes the active map.
      const manifest = verify(await signedMetadata(releasePath(receipt)))
      if (['releaseId', 'centerId', 'ownerOrgId', 'packId', 'version'].some(key => manifest[key as keyof ReleaseManifest] !== receipt[key as keyof typeof receipt])
        || sha256(canonicalBytes(manifest)) !== receipt.manifestSha256) {
        fail('IMMUTABLE_RELEASE_CONFLICT', 'Accepted release metadata does not match the permanent receipt')
      }
      if (target && (target.manifestSha256 !== receipt.manifestSha256 || target.artifactSha256 !== manifest.artifactSha256
        || target.contentTreeSha256 !== manifest.contentTreeSha256)) fail('CENTER_TARGET_CHANGED', 'Receipt does not match the requested release target')
      return replay({ operationKey, expectedGeneration, request: { kind: activate ? 'update_enable' : 'install', manifestSha256: receipt.manifestSha256 } })
    },

    /** Host-only read: verify even inactive inventory before using cached bytes. */
    async localRelease(releaseId: string) {
      const { state } = await stateStore.readState()
      const record = requireRecord(state, releaseId)
      const manifest = await verifyRecord(record)
      const envelope = await signedMetadata(releasePath(manifest))
      if (canonicalJson(verify(envelope)) !== canonicalJson(manifest)) fail('IMMUTABLE_RELEASE_CONFLICT', 'Local release changed while being read')
      return { record, manifest, envelope }
    },

    async install(input: InstallReleaseInput) {
      // Freeze the request before the first await, including flags that control
      // activation. Later caller mutation cannot change an idempotent operation.
      const envelope = JSON.parse(canonicalJson(input.envelope)) as SignedReleaseManifest
      const manifest = verify(envelope)
      const activate = input.activate === true
      const archiveFile = input.archiveFile
      assertCompatible(manifest)
      const request: StateTransactionRequest = {
        operationKey: input.operationKey, expectedGeneration: input.expectedGeneration,
        request: { kind: activate ? 'update_enable' : 'install', manifestSha256: sha256(canonicalBytes(manifest)) },
      }
      const previousResult = await replay(request)
      if (previousResult) return previousResult
      await ensureDirectories()
      const finalDirectory = releasePath(manifest)
      let exists = false
      try { await lstat(finalDirectory); exists = true } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (exists) await verifyDirectory(finalDirectory, manifest)
      else {
        const staging = await mkdtemp(join(incomingRoot, 'install-'))
        try {
          await extractArtifact(archiveFile, join(staging, 'content'), manifest)
          await verifyContent(join(staging, 'content'), manifest)
          const handle = await open(join(staging, 'release.json'), 'wx', 0o600)
          try { await handle.writeFile(canonicalBytes(envelope)); await handle.sync() } finally { await handle.close() }
          await syncTree(staging)
          try { await rename(staging, finalDirectory) } catch (error) {
            if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
            await verifyDirectory(finalDirectory, manifest)
          }
          await syncDirectory(releasesRoot)
          await syncDirectory(incomingRoot)
        } finally {
          // Only this invocation's freshly-created staging path can be removed.
          await rm(staging, { recursive: true, force: true })
        }
      }
      return stateStore.transact(request, async (state): Promise<StateJson> => {
        await verifyDirectory(finalDirectory, manifest)
        const manifestSha256 = sha256(canonicalBytes(manifest))
        for (const accepted of Object.values(state.acceptedReleases)) {
          if (accepted.releaseId === manifest.releaseId && accepted.manifestSha256 !== manifestSha256) {
            fail('IMMUTABLE_RELEASE_CONFLICT', 'Previously accepted release metadata cannot be replaced, even after uninstall')
          }
          if (accepted.packId !== manifest.packId) continue
          if (accepted.centerId !== manifest.centerId || accepted.ownerOrgId !== manifest.ownerOrgId) {
            fail('PACK_OWNER_CONFLICT', 'Pack ID was previously accepted from another owner or center')
          }
          if (accepted.version === manifest.version && accepted.releaseId !== manifest.releaseId) {
            fail('IMMUTABLE_VERSION_CONFLICT', 'Previously accepted package version remains immutable after uninstall')
          }
        }
        for (const record of Object.values(state.installed)) {
          if (record.packId !== manifest.packId) continue
          if (record.source !== 'center' || record.centerId !== manifest.centerId || record.ownerOrgId !== manifest.ownerOrgId) {
            fail('PACK_OWNER_CONFLICT', 'Pack ID is already owned by another source or organization')
          }
          if (record.version === manifest.version && record.releaseId !== manifest.releaseId) {
            fail('IMMUTABLE_VERSION_CONFLICT', 'An installed pack version cannot refer to a different release')
          }
        }
        if (own(state.installed, manifest.releaseId)) {
          const prior = await verifyRecord(state.installed[manifest.releaseId]!)
          if (!sameIdentity(prior, manifest) || canonicalJson(prior) !== canonicalJson(manifest)) {
            fail('IMMUTABLE_RELEASE_CONFLICT', 'Release metadata is immutable')
          }
        } else {
          state.installed[manifest.releaseId] = {
            releaseId: manifest.releaseId, packId: manifest.packId, version: manifest.version,
            artifactSha256: manifest.artifactSha256, contentTreeSha256: manifest.contentTreeSha256,
            packPath: join(finalDirectory, 'content'), manifestPath: join(finalDirectory, 'release.json'),
            installedAt: new Date().toISOString(), source: 'center', centerId: manifest.centerId, ownerOrgId: manifest.ownerOrgId,
          }
        }
        state.acceptedReleases[manifest.releaseId] = {
          releaseId: manifest.releaseId, packId: manifest.packId, version: manifest.version,
          centerId: manifest.centerId, ownerOrgId: manifest.ownerOrgId, manifestSha256,
        }
        if (activate) {
          const priorActive = { ...state.active }
          const previousReleaseId = state.installed[manifest.releaseId]!.previousReleaseId
          try { await switchActive(state, manifest.releaseId) } catch (error) {
            const code = error instanceof Error && 'code' in error ? String(error.code) : 'ACTIVATION_PREFLIGHT_FAILED'
            if (!['INCOMPATIBLE_RELEASE', 'DEPENDENCY_BLOCKED', 'BUILTIN_DEPENDENCY_BLOCKED', 'DEPENDENCY_CYCLE', 'ENTITY_CONFLICT', 'CENTER_PACK_ID_CONFLICT', 'CENTER_ENTITY_CONFLICT', 'CENTER_MERGE_INVALID', 'ACTIVATION_PREFLIGHT_FAILED'].includes(code)) throw error
            // The verified download is retained, but a failed activation never
            // changes the old active mapping or reports operation success.
            state.active = priorActive
            if (previousReleaseId === undefined) delete state.installed[manifest.releaseId]!.previousReleaseId
            else state.installed[manifest.releaseId]!.previousReleaseId = previousReleaseId
            return {
              status: 'installed_not_enabled', releaseId: manifest.releaseId, activated: false,
              previousActiveReleaseId: priorActive[manifest.packId] ?? null,
              activationError: {
                code,
                message: error instanceof Error ? error.message : 'Activation preflight failed',
              },
            }
          }
        }
        return { status: 'succeeded', releaseId: manifest.releaseId, activated: state.active[manifest.packId] === manifest.releaseId }
      })
    },

    async enable(input: PackOperationInput & { releaseId: string }) {
      const { releaseId, operationKey, expectedGeneration } = input
      return stateStore.transact({ operationKey, expectedGeneration, request: { kind: 'enable', releaseId } }, async state => {
        await switchActive(state, releaseId)
        return { releaseId, activated: true }
      })
    },

    async disable(input: PackOperationInput & { packId: string }) {
      const { packId, operationKey, expectedGeneration } = input
      return stateStore.transact({ operationKey, expectedGeneration, request: { kind: 'disable', packId } }, async state => {
        delete state.active[packId]
        await verifyActiveGraph(state)
        await options.validateActivation?.(frozen(structuredClone(state)))
        return { packId, activated: false }
      })
    },

    async rollback(input: PackOperationInput & { packId: string; releaseId: string }) {
      const { packId, releaseId, operationKey, expectedGeneration } = input
      return stateStore.transact({ operationKey, expectedGeneration, request: { kind: 'rollback', packId, releaseId } }, async state => {
        const currentId = state.active[packId]
        if (!currentId) fail('PACK_NOT_ACTIVE', 'Only an active pack can be rolled back')
        const currentRecord = requireRecord(state, currentId)
        const targetRecord = requireRecord(state, releaseId)
        if (currentRecord.source === 'legacy' || targetRecord.source === 'legacy') {
          if (currentRecord.source !== 'legacy' || targetRecord.source !== 'legacy' || targetRecord.packId !== packId ||
            currentRecord.previousReleaseId !== releaseId) {
            fail('INVALID_ROLLBACK_TARGET', 'Legacy rollback requires the explicitly recorded previous local snapshot, not a guessed version order')
          }
          await verifyLegacyRecord(root, currentRecord)
          await verifyLegacyRecord(root, targetRecord)
        } else {
          const current = await verifyRecord(currentRecord)
          const target = await verifyRecord(targetRecord)
          if (!sameIdentity(current, target) || target.packId !== packId || compareSemVer(target.version, current.version) >= 0) {
            fail('INVALID_ROLLBACK_TARGET', 'Rollback requires an older locally installed release of the same owned pack')
          }
        }
        await switchActive(state, releaseId)
        return { releaseId, previousReleaseId: currentId, activated: true }
      })
    },

    async uninstall(input: PackOperationInput & { releaseId: string }) {
      const { releaseId, operationKey, expectedGeneration } = input
      return stateStore.transact({ operationKey, expectedGeneration, request: { kind: 'uninstall', releaseId } }, async state => {
        const record = requireRecord(state, releaseId)
        if (state.active[record.packId] === releaseId) fail('RELEASE_ACTIVE', 'Disable the release before uninstalling it')
        if (Object.values(state.legacySuppressions).some(item => item.releaseId === releaseId)) {
          fail('LEGACY_RESTORE_REQUIRED', 'Restore the taken-over vendor path before uninstalling its managed release')
        }
        delete state.installed[releaseId]
        for (const installed of Object.values(state.installed)) {
          if (installed.previousReleaseId === releaseId) delete installed.previousReleaseId
        }
        await verifyActiveGraph(state)
        return { releaseId, retainedFiles: true }
      })
    },

    async takeOverLegacy(input: PackOperationInput & { vendorPath: string; expectedContentTreeSha256: string }) {
      const { vendorPath, expectedContentTreeSha256, operationKey, expectedGeneration } = input
      if (!/^[a-f0-9]{64}$/.test(expectedContentTreeSha256)) fail('INVALID_REQUEST', 'Takeover must confirm the previewed content digest')
      const request: StateTransactionRequest = {
        operationKey, expectedGeneration, request: { kind: 'legacy_takeover', vendorPath, expectedContentTreeSha256 },
      }
      const prior = await replay(request)
      if (prior) return prior
      const prepared = await prepareLegacySnapshot(root, vendorPath)
      if (prepared.record.contentTreeSha256 !== expectedContentTreeSha256) fail('LEGACY_SOURCE_CHANGED', 'Legacy source differs from the confirmed preview')
      return stateStore.transact(request, async state => {
        if (own(state.legacySuppressions, vendorPath)) fail('LEGACY_ALREADY_MANAGED', 'This exact vendor path is already managed')
        if (Object.values(state.installed).some(record => record.packId === prepared.record.packId && record.source !== 'legacy') ||
          Object.values(state.acceptedReleases).some(record => record.packId === prepared.record.packId)) {
          fail('PACK_OWNER_CONFLICT', 'A locally managed legacy pack cannot replace a center-owned pack identity')
        }
        await verifyLegacyRecord(root, prepared.record)
        await verifyLegacySuppression(root, vendorPath, prepared.suppression, { requireSourceUnchanged: true })
        if (!own(state.installed, prepared.record.releaseId)) state.installed[prepared.record.releaseId] = prepared.record
        state.legacySuppressions[vendorPath] = prepared.suppression
        await switchActive(state, prepared.record.releaseId)
        return { status: 'succeeded', releaseId: prepared.record.releaseId, source: 'legacy', activated: true, suppressedPath: vendorPath }
      })
    },

    async restoreLegacyManagement(input: PackOperationInput & { vendorPath: string }) {
      const { vendorPath, operationKey, expectedGeneration } = input
      return stateStore.transact({ operationKey, expectedGeneration, request: { kind: 'legacy_restore', vendorPath } }, async state => {
        if (!own(state.legacySuppressions, vendorPath)) fail('LEGACY_NOT_MANAGED', 'This vendor path has not been taken over')
        const suppression = state.legacySuppressions[vendorPath]!
        await verifyLegacySuppression(root, vendorPath, suppression, { requireSourceUnchanged: true })
        delete state.active[suppression.packId]
        delete state.legacySuppressions[vendorPath]
        await verifyActiveGraph(state)
        await options.validateActivation?.(frozen(structuredClone(state)))
        return { status: 'succeeded', packId: suppression.packId, restoredPath: vendorPath, retainedBackup: true }
      })
    },

    async activeSnapshot(): Promise<LocalActiveSnapshot> {
      const read = await stateStore.readState()
      await verifyActiveGraph(read.state)
      return frozen({
        generation: read.state.generation, mode: read.mode,
        ...(read.warning ? { warning: read.warning } : {}),
        packs: Object.entries(read.state.active).sort(([a], [b]) => a.localeCompare(b)).map(([packId, releaseId]) => ({
          packId, releaseId, root: read.state.installed[releaseId]!.packPath,
          contentTreeSha256: read.state.installed[releaseId]!.contentTreeSha256,
          source: read.state.installed[releaseId]!.source,
        })),
        suppressedLegacyPaths: Object.keys(read.state.legacySuppressions).sort(),
      })
    },
  }
}
