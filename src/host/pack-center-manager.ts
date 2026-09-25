/** Deployment-local management service; network is only used by explicit admin actions. */
import { readdir } from 'node:fs/promises'
import { isAbsolute, join, parse, resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  canonicalBytes, checkCompatibility, compareSemVer, parseSemVer, selectUpdateCandidate, sha256,
  type Capabilities, type CatalogRelease, type ReleaseManifest,
} from '#pack-contract'
import type {
  CenterManageService, CenterConnectionView, CenterCatalogView, CenterReleaseSummary, CenterReleaseDetail,
  CenterInstallationsView, CenterInstalledRelease, CenterUpdatesView, CenterOperationInput,
} from '../pack-center-wire.ts'
import { createPackCenterClient, PackCenterClientError, type PackCenterClient, type PackCenterClientOptions } from './pack-center-client.ts'
import { createPackCenterConnectionStore, publicView } from './pack-center-connection.ts'
import { normalizePackCenterOrigin } from './pack-center-transport.ts'
import { fingerprintStateRequest, type PackCenterState, type StateTransactionResult, type StateJson } from './pack-center-state.ts'
import {
  createPackOperationQueue, validatePackOperationRequest, sanitizePackOperationError,
  type PackOperationRequest, type PackOperationResult,
} from './pack-center-operations.ts'
import type { LocalActiveSnapshot } from './pack-store.ts'

export interface PackCenterManagerOptions {
  root: string
  origin?: string
  capabilities: Capabilities
  builtinVersions?: PackCenterClientOptions['builtinVersions']
  validateActivation?: PackCenterClientOptions['validateActivation']
  /** Explicit fixture controls; never accepted from an HTTP request. */
  allowLoopbackHttp?: boolean; testCa?: string; timeoutMs?: number
}
function fail(code: string): never { throw new PackCenterClientError(code) }
const clone = <T>(value: T): T => structuredClone(value)
const now = () => new Date().toISOString()
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const code = (error: unknown) => sanitizePackOperationError(error)
const emptyCatalog = (): CenterCatalogView => ({ items: [], nextCursor: null, checkedAt: null, hasSnapshot: false, stale: true })
const emptyUpdates = (generation = 0): CenterUpdatesView => ({ items: [], generation, checkedAt: null, hasSnapshot: false, stale: true })

export function createPackCenterManager(options: PackCenterManagerOptions): CenterManageService & { activeSnapshot(): Promise<LocalActiveSnapshot> } {
  if (!isAbsolute(options.root) || resolve(options.root) !== options.root || options.root === parse(options.root).root
    || options.root === homedir()) fail('CENTER_INVALID_STORAGE')
  const root = options.root, connectionRoot = join(root, 'private'), inventoryRoot = join(root, 'inventory')
  const capabilities = clone(options.capabilities), builtinVersions = clone(options.builtinVersions ?? {})
  const activationAvailable = options.validateActivation !== undefined
  const configuredOrigin = options.origin?.trim() ? normalizePackCenterOrigin(options.origin.trim(), options.allowLoopbackHttp) : null
  const connections = createPackCenterConnectionStore(connectionRoot, { allowLoopbackHttp: options.allowLoopbackHttp })
  const catalogCache = new Map<string, { revision: number; value: CenterCatalogView }>()
  let updateCache: { revision: number; value: CenterUpdatesView } | undefined
  let startupError: string | undefined
  let closed = false
  const clearCache = () => { catalogCache.clear(); updateCache = undefined }

  async function client(): Promise<PackCenterClient> {
    const snapshot = await connections.read()
    const origin = configuredOrigin ?? snapshot.connection?.origin
    if (!origin) fail('CENTER_NOT_CONFIGURED')
    return createPackCenterClient({
      origin, connectionRoot, inventoryRoot, capabilities, builtinVersions, validateActivation: options.validateActivation,
      allowLoopbackHttp: options.allowLoopbackHttp, testCa: options.testCa, timeoutMs: options.timeoutMs,
    })
  }
  function requireRemote() { if (!configuredOrigin) fail('CENTER_DISABLED') }
  async function connection(): Promise<CenterConnectionView> {
    return { ...publicView(await connections.read()), configured: configuredOrigin !== null,
      configuredOrigin, activationAvailable, ...(startupError ? { errorCode: startupError } : {}) }
  }
  async function state() {
    const snapshot = await connections.read()
    if (!snapshot.connection) {
      try {
        if ((await readdir(inventoryRoot)).length) fail('CENTER_INVENTORY_NOT_EMPTY')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      return undefined
    }
    return (await client()).localState()
  }
  function summary(row: Awaited<ReturnType<PackCenterClient['listReleases']>>['items'][number]): CenterReleaseSummary {
    return {
      releaseId: row.releaseId, packId: row.packId, version: row.version, ownerOrgId: row.ownerOrgId,
      name: row.name, publishedAt: row.publishedAt, manifestSha256: sha256(canonicalBytes(row.manifest)),
      artifactSha256: row.manifest.artifactSha256, contentTreeSha256: row.manifest.contentTreeSha256,
      compatibility: clone(row.compatibility), downloadAvailability: clone(row.downloadAvailability),
      dependencies: row.manifest.dependencyLock.map(item => ({ packId: item.packId, releaseId: item.releaseId, version: item.version })),
    }
  }
  async function catalog(input: { packId?: string; limit?: number; beforeId?: string } = {}): Promise<CenterCatalogView> {
    const captured = clone(input), revision = (await connections.read()).revision
    const cacheKey = JSON.stringify([captured.packId ?? null, captured.limit ?? 50, captured.beforeId ?? null])
    try {
      requireRemote()
      const reply = await (await client()).listReleases(captured)
      if ((await connections.read()).revision !== revision) fail('REVISION_CONFLICT')
      const value: CenterCatalogView = { items: reply.items.map(summary), nextCursor: reply.nextCursor,
        checkedAt: now(), hasSnapshot: true, stale: false }
      if (catalogCache.size >= 32 && !catalogCache.has(cacheKey)) catalogCache.delete(catalogCache.keys().next().value!)
      catalogCache.set(cacheKey, { revision, value })
      return clone(value)
    } catch (error) {
      const current = await connections.read(), cached = catalogCache.get(cacheKey)
      const prior = current.revision === revision && cached?.revision === revision ? clone(cached.value) : emptyCatalog()
      return { ...prior, stale: true, errorCode: code(error) }
    }
  }
  async function release(id: string): Promise<CenterReleaseDetail> {
    requireRemote()
    const row = await (await client()).getRelease(id)
    const diff = object(row.diff), files = object(diff.files), permissions = object(diff.permissions)
    const count = (value: unknown) => Array.isArray(value) ? value.length : 0
    const diffText = !row.diffAvailability.available ? '历史基线当前不可访问，不能判断为没有变化。'
      : row.diff === null ? '本版本没有可比较的历史基线。'
        : `文件：新增 ${count(files.added)}，修改 ${count(files.changed)}，删除 ${count(files.removed)}。` +
          `脚本声明：${count(object(permissions.before).execScripts)} → ${count(object(permissions.after).execScripts)}。`
    return { ...summary(row), sourceCommit: row.manifest.sourceCommit, notes: row.notes, license: row.license,
      validation: { valid: row.validationReport.valid, diagnostics: row.validationReport.diagnostics.map(item => ({
        severity: item.severity, code: item.code, message: item.code,
      })) }, diff: { available: row.diffAvailability.available,
        ...('code' in row.diffAvailability ? { code: row.diffAvailability.code } : {}), text: diffText } }
  }
  async function installations(): Promise<CenterInstallationsView> {
    const read = await state()
    if (!read) return { generation: 0, mode: 'normal', items: [] }
    const sdk = await client(), items: CenterInstalledRelease[] = []
    for (const record of Object.values(read.state.installed)) {
      const item: CenterInstalledRelease = {
        releaseId: record.releaseId, packId: record.packId, version: record.version, source: record.source,
        ...(record.centerId ? { centerId: record.centerId } : {}), ...(record.ownerOrgId ? { ownerOrgId: record.ownerOrgId } : {}),
        installedAt: record.installedAt, active: read.state.active[record.packId] === record.releaseId,
        ...(record.previousReleaseId ? { previousReleaseId: record.previousReleaseId } : {}),
        artifactSha256: record.artifactSha256, contentTreeSha256: record.contentTreeSha256, integrity: 'unavailable',
      }
      try {
        if (record.source === 'center') {
          const local = await sdk.localRelease(record.releaseId)
          item.manifestSha256 = sha256(canonicalBytes(local.manifest)); item.integrity = 'verified'
        } else {
          // Legacy management stays in its existing surface. Do not mislabel
          // a local legacy receipt as a center signature.
          item.errorCode = 'LEGACY_VERIFIER_REQUIRED'
        }
      } catch (error) { item.errorCode = code(error) }
      items.push(item)
    }
    return { generation: read.state.generation, mode: read.mode, items,
      ...(read.warning ? { warningCode: read.warning.code } : {}) }
  }
  function dependencyReasons(candidate: CatalogRelease, current: Readonly<PackCenterState>, activeManifests: ReleaseManifest[]) {
    const reasons: string[] = []
    for (const dependency of candidate.dependencyLock) {
      const installed = current.installed[dependency.releaseId]
      if (current.active[dependency.packId] !== dependency.releaseId || !installed
        || installed.artifactSha256 !== dependency.artifactSha256 || installed.contentTreeSha256 !== dependency.contentTreeSha256
        || installed.ownerOrgId !== dependency.ownerOrgId || installed.version !== dependency.version) reasons.push(`DEPENDENCY_REQUIRED:${dependency.packId}@${dependency.version}`)
    }
    for (const dependency of candidate.builtinDependencies) {
      const version = builtinVersions[dependency.packId]
      if (!version || compareSemVer(version, dependency.minVersion) < 0
        || dependency.maxVersionExclusive && compareSemVer(version, dependency.maxVersionExclusive) >= 0) reasons.push(`BUILTIN_DEPENDENCY_BLOCKED:${dependency.packId}`)
    }
    for (const active of activeManifests) {
      if (active.packId === candidate.packId) continue
      const lock = active.dependencyLock.find(item => item.packId === candidate.packId)
      if (lock && (lock.releaseId !== candidate.releaseId || lock.artifactSha256 !== candidate.artifactSha256
        || lock.contentTreeSha256 !== candidate.contentTreeSha256)) reasons.push(`REVERSE_DEPENDENCY_BLOCKED:${active.packId}`)
    }
    return reasons
  }
  async function updates(): Promise<CenterUpdatesView> {
    const revision = (await connections.read()).revision, read = await state()
    if ((await connections.read()).revision !== revision) return { ...emptyUpdates(read?.state.generation ?? 0), errorCode: 'REVISION_CONFLICT' }
    if (updateCache?.revision !== revision) return emptyUpdates(read?.state.generation ?? 0)
    const view = clone(updateCache.value)
    if (view.generation !== (read?.state.generation ?? 0)) return { ...view, stale: true, errorCode: 'GENERATION_CONFLICT' }
    return view
  }
  async function checkUpdates(): Promise<CenterUpdatesView> {
    const revision = (await connections.read()).revision
    let currentGeneration = 0
    try {
      requireRemote()
      const read = await state(), sdk = await client(), installed = await installations()
      currentGeneration = read?.state.generation ?? 0
      // A check still probes the center when nothing is installed: it must not
      // turn an outage or revoked credential into a successful empty result.
      if (!read || !installed.items.some(item => item.source === 'center')) await sdk.listReleases({ limit: 1 })
      const localManifests = new Map<string, ReleaseManifest>()
      for (const item of installed.items.filter(item => item.source === 'center')) {
        localManifests.set(item.releaseId, (await sdk.localRelease(item.releaseId)).manifest)
      }
      const activeManifests = [...localManifests.values()].filter(item => read?.state.active[item.packId] === item.releaseId)
      const currentByPack = new Map<string, CenterInstalledRelease>()
      for (const item of installed.items.filter(item => item.source === 'center')) {
        const previous = currentByPack.get(item.packId)
        if (!previous || item.active || !previous.active && compareSemVer(item.version, previous.version) > 0) currentByPack.set(item.packId, item)
      }
      const items: CenterUpdatesView['items'] = []
      for (const [packId, current] of currentByPack) {
        const rows: Awaited<ReturnType<PackCenterClient['listReleases']>>['items'] = []
        let beforeId: string | undefined
        const seen = new Set<string>()
        for (let page = 0; ; page++) {
          if (page >= 20) fail('CENTER_PAGE_LIMIT')
          const result = await sdk.listReleases({ packId, limit: 100, ...(beforeId ? { beforeId } : {}) })
          rows.push(...result.items)
          if (result.nextCursor === null) break
          if (seen.has(result.nextCursor)) fail('CENTER_PAGE_LIMIT')
          seen.add(result.nextCursor); beforeId = result.nextCursor
        }
        const baseline = localManifests.get(current.releaseId)!
        const selection = selectUpdateCandidate({ current: baseline, releases: rows.map(item => item.manifest), capabilities,
          cachedReleaseIds: [...localManifests.keys()] })
        for (const row of rows) {
          const cached = localManifests.get(row.releaseId)
          if (cached && sha256(canonicalBytes(cached)) !== sha256(canonicalBytes(row.manifest))) fail('IMMUTABLE_RELEASE_CONFLICT')
        }
        const newer = rows.filter(item => parseSemVer(item.version).prerelease.length === 0 && compareSemVer(item.version, current.version) > 0)
          .sort((a, b) => compareSemVer(b.version, a.version))
        const blockedReasons: Array<{ releaseId: string; reasons: string[] }> = []
        let candidate: typeof newer[number] | undefined
        for (const row of newer) {
          const reasons = [...checkCompatibility(row.manifest, capabilities).reasons,
            ...dependencyReasons(row.manifest, read!.state, activeManifests)]
          if (!row.downloadAvailability.available && !localManifests.has(row.releaseId)) reasons.push(row.downloadAvailability.code ?? 'DEPENDENCY_UNAVAILABLE')
          if (reasons.length) blockedReasons.push({ releaseId: row.releaseId, reasons })
          else candidate ??= row
        }
        const latest = rows.find(row => row.releaseId === selection.latestVisible?.releaseId)
        items.push({ packId, current, latestVisible: latest ? summary(latest) : null, candidate: candidate ? summary(candidate) : null,
          candidateCached: candidate ? localManifests.has(candidate.releaseId) : false,
          status: candidate ? 'update_available' : newer.length ? 'blocked' : selection.status, blockedReasons })
      }
      const latest = await state()
      if ((await connections.read()).revision !== revision) fail('REVISION_CONFLICT')
      if ((latest?.state.generation ?? 0) !== currentGeneration) fail('GENERATION_CONFLICT')
      const view: CenterUpdatesView = { items, generation: currentGeneration, checkedAt: now(), hasSnapshot: true, stale: false }
      updateCache = { revision, value: view }
      return clone(view)
    } catch (error) {
      // One final revision fence, with no further await between checking it
      // and projecting/cache-writing. A rebind must not return old remote data.
      if ((await connections.read()).revision !== revision) return { ...emptyUpdates(currentGeneration), errorCode: 'REVISION_CONFLICT' }
      const same = updateCache?.revision === revision
      const view = { ...(same ? clone(updateCache!.value) : emptyUpdates(currentGeneration)), stale: true, errorCode: code(error) }
      updateCache = { revision, value: view }
      return view
    }
  }
  function receiptRequest(request: PackOperationRequest): StateJson {
    if (request.kind === 'install' || request.kind === 'update_enable') return { kind: request.kind, manifestSha256: request.target!.manifestSha256 }
    if (request.kind === 'disable') return { kind: request.kind, packId: request.packId! }
    if (request.kind === 'rollback') return { kind: request.kind, packId: request.packId!, releaseId: request.releaseId! }
    return { kind: request.kind, releaseId: request.releaseId! }
  }
  function resultOf(result: StateTransactionResult): PackOperationResult {
    const value = object(result.operation.result)
    const partial = value.status === 'installed_not_enabled'
    return { generation: result.operation.committedGeneration, outcome: partial ? 'installed_not_enabled' : 'succeeded',
      ...(typeof value.releaseId === 'string' ? { releaseId: value.releaseId } : {}),
      ...(typeof value.packId === 'string' ? { packId: value.packId } : {}),
      ...(typeof value.activated === 'boolean' ? { activated: value.activated } : {}),
      ...(partial ? { errorCode: code({ code: object(value.activationError).code }) } : {}) }
  }
  const queue = createPackOperationQueue({ root: join(root, 'operations'),
    async recover(request) {
      const read = await state()
      if (!read) return null
      if (read.mode !== 'normal') fail('STATE_READ_ONLY')
      const operation = read.state.operations[request.operationKey]
      if (!operation) return null
      if (operation.requestFingerprint !== fingerprintStateRequest(receiptRequest(request), request.expectedGeneration)) fail('IDEMPOTENCY_CONFLICT')
      if (request.kind === 'install' || request.kind === 'update_enable') {
        const receipt = await (await client()).replayInstall({ operationKey: request.operationKey, expectedGeneration: request.expectedGeneration,
          releaseId: request.releaseId!, target: request.target!, connectionRevision: request.connectionRevision! }, request.kind === 'update_enable')
        if (!receipt) return null
        return resultOf(receipt)
      }
      return resultOf({ state: read.state, operation, replayed: true })
    },
    async execute(request, report) {
      const sdk = await client(), common = { operationKey: request.operationKey, expectedGeneration: request.expectedGeneration }
      let result: StateTransactionResult
      if (request.kind === 'install' || request.kind === 'update_enable') {
        const local = (await sdk.localState()).state.installed[request.releaseId!]
        if (!local) requireRemote()
        result = await sdk[request.kind === 'install' ? 'install' : 'updateEnable']({ ...common,
          releaseId: request.releaseId!, target: request.target!, connectionRevision: request.connectionRevision! }, report)
      } else {
        await report(request.kind === 'enable' || request.kind === 'rollback' ? 'activating' : 'committing')
        if (request.kind === 'disable') result = await sdk.disable({ ...common, packId: request.packId! })
        else if (request.kind === 'rollback') result = await sdk.rollback({ ...common, packId: request.packId!, releaseId: request.releaseId! })
        else result = await sdk[request.kind]({ ...common, releaseId: request.releaseId! })
      }
      return resultOf(result)
    },
  })
  async function start() {
    if (closed) fail('OPERATION_CLOSED')
    try {
      if (configuredOrigin || (await connections.read()).connection) await queue.start()
      startupError = undefined
    } catch (error) { startupError = code(error); throw error }
  }
  async function enqueue(input: CenterOperationInput) {
    if (closed) fail('OPERATION_CLOSED')
    const request = validatePackOperationRequest(input)
    const read = await state(), snapshot = await connections.read()
    // A repeated request must be returned even when its original generation
    // is stale now; the queue checks exact immutable equality.
    const existing = (await queue.list()).find(item => item.request.operationKey === request.operationKey)
    if (!existing) {
      if (!snapshot.connection) fail('CENTER_NOT_CONFIGURED')
      if (read?.mode === 'recovered-read-only') fail('STATE_READ_ONLY')
      if ((read?.state.generation ?? 0) !== request.expectedGeneration) fail('GENERATION_CONFLICT')
      if (request.connectionRevision !== undefined && request.connectionRevision !== snapshot.revision) fail('REVISION_CONFLICT')
      if (['enable', 'disable', 'rollback', 'update_enable'].includes(request.kind) && !activationAvailable) fail('CENTER_ACTIVATION_UNAVAILABLE')
      if ((request.kind === 'install' || request.kind === 'update_enable') && !read?.state.installed[request.releaseId!]) requireRemote()
    }
    const job = await queue.enqueue(request)
    await start()
    return job
  }
  return {
    connection, catalog, release, installations, updates, checkUpdates, enqueue, start,
    async bind(input) {
      requireRemote()
      const value = await (await client()).bind(input)
      clearCache()
      // The one-time binding has already committed. A damaged operation queue
      // cannot turn that success into a false "binding failed" response.
      try { await start() } catch { /* connection + operations expose the fixed queue error */ }
      return { ...value, configured: true, configuredOrigin, activationAvailable,
        ...(startupError ? { errorCode: startupError } : {}) }
    },
    async unbind(input) { const value = await (await client()).unbind(input); clearCache(); return { ...value, configured: configuredOrigin !== null, configuredOrigin, activationAvailable } },
    operations: () => queue.list(), async operation(id) { const job = await queue.get(id); if (!job) fail('OPERATION_NOT_FOUND'); return job },
    async retry(id) { const job = await queue.retry(id); await start(); return job },
    async close() { closed = true; await queue.close(); clearCache() },
    async activeSnapshot() {
      if (!await state()) return { generation: 0, mode: 'normal', packs: [], suppressedLegacyPaths: [] }
      return (await client()).activeSnapshot()
    },
  }
}
