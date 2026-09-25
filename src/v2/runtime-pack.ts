/**
 * Runtime Domain Pack resolver — the missing runtime half of the pack
 * lifecycle (audit gap #6 fix): workspace `domain-packs/` packs now drive the
 * compile path, not just the settings preview.
 *
 * {@link resolveRuntimePack} merges every *enabled* workspace pack over a
 * caller-supplied base pack (the builtin zhijian/collab pack) with the
 * canonical overlay precedence `builtin < workspace` (a workspace pack may
 * override experts/scenarios/templates by id; the builtin pack always
 * survives as the base layer). The result is cached process-wide, keyed by
 * base content, settings, discovery/vendor roots, local center version
 * snapshot and participating legacy pack fingerprints, and
 * {@link invalidateRuntimePack} drops the cache eagerly — the settings
 * onChange path in `src/index.ts` calls it so pack edits take effect without
 * a restart.
 *
 * Selection is by **pack id** (`pack.json` `pack.pack.id`), the same id the
 * settings pack list exposes: `enabledPacks` absent/empty means every valid
 * workspace pack participates, and `packPriority` (first = highest
 * precedence) orders the workspace layers.
 *
 * Center-managed packs participate only through a caller-supplied local
 * snapshot. The resolver does not discover an inventory, contact a center,
 * or change activation state. Every snapshot tree is checked before cache
 * reuse; an invalid center pack is an explicit error, never a base fallback.
 * Returned values are detached from caller data and deeply frozen.
 *
 * @module dsh-expert-library/v2/runtime-pack
 */

import type { Context } from '@deepseek-ai/cordis'
import { statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { hashContentDirectory } from '../../packages/pack-contract/index.mjs'
import { isSafeKnowledgeId } from '../knowledge.ts'
import { canonicalDigest, canonicalize, deepFreeze } from './digest.ts'
import { loadPackFromDir, mergePackLayers, type LoadedPack } from './pack-loader.ts'
import { discoverPackDirs, workspaceRootsOf, type PackDir } from './preview.ts'
import type { DomainPackV2, PackDiagnostic } from './types.ts'

/** Pure local data supplied by the host after state, signature and dependency checks. */
export interface RuntimeCenterSnapshot {
  readonly generation: number
  readonly packs: ReadonlyArray<{
    readonly releaseId: string
    readonly packId: string
    readonly root: string
    readonly contentTreeSha256: string
    /** Legacy takeover remains visibly local, never advertised as a signed center release. */
    readonly source?: 'center' | 'legacy'
  }>
  readonly suppressedLegacyPaths: readonly string[]
}

/** Center errors cannot silently degrade to a different runtime package. */
export class RuntimeCenterPackError extends Error {
  readonly code: string
  readonly diagnostics: readonly PackDiagnostic[]
  constructor(code: string, message: string, diagnostics: readonly PackDiagnostic[] = []) {
    super(message)
    this.name = 'RuntimeCenterPackError'
    this.code = code
    this.diagnostics = diagnostics
  }
}

/** Runtime pack selection knobs (a subset of ToolsConfig). */
export interface RuntimePackSelection {
  /** Domain pack directory name under each workspace root (default `domain-packs`). */
  readonly packsDir: string
  /** Workspace pack ids enabled for runtime compile; absent/empty = every valid workspace pack. */
  readonly enabledPacks?: readonly string[]
  /** Workspace pack id order (first = highest precedence); absent = discovery order. */
  readonly packPriority?: readonly string[]
  /** Absolute directory of packs vendored from external sources; empty = none. */
  readonly vendorPacksDir?: string
  /** Only these fixed local versions participate; an empty packs list means none. */
  readonly centerSnapshot?: RuntimeCenterSnapshot
  /** Internal host gate; managed center packs must not override any local identity. */
  readonly rejectCenterConflicts?: boolean
}

/** Result of resolving the runtime pack. */
export interface RuntimePackResult {
  /** The merged, validated pack (base + enabled workspace overlays). */
  readonly pack: DomainPackV2
  /** Every center/workspace pack that participated, in merge order (highest last). */
  readonly layers: readonly PackDir[]
  /** Workspace failures degrade; invalid center snapshots throw before returning a result. */
  readonly diagnostics: readonly PackDiagnostic[]
  /** Detached local version/root snapshot retained by this result, when supplied. */
  readonly centerSnapshot?: RuntimeCenterSnapshot
}

/** One process-wide cache entry. */
interface RuntimePackCacheEntry {
  /** Base pack id this entry was built over (the map key also includes its content). */
  readonly baseId: string
  /** Settings signature (enabled/priority) at build time. */
  readonly selectionKey: string
  /** Local center identity plus legacy root/content/mtime fingerprint and diagnostics. */
  readonly fingerprint: string
  readonly result: RuntimePackResult
}

const runtimePackCache = new Map<string, RuntimePackCacheEntry>()

/**
 * Drop the whole runtime pack cache. Called from the settings onChange path
 * so pack selection edits (`enabledPacks`/`packPriority`) take effect
 * immediately; the next resolve rebuilds lazily.
 */
export function invalidateRuntimePack(): void {
  runtimePackCache.clear()
}

/** Settings signature: canonicalized enabled/priority selection. */
function selectionKeyOf(selection: RuntimePackSelection): string {
  return canonicalize({
    packsDir: selection.packsDir,
    vendorRoot: selection.vendorPacksDir ?? '',
    enabled: selection.enabledPacks === undefined ? null : [...selection.enabledPacks].sort(),
    priority: selection.packPriority === undefined ? null : [...selection.packPriority],
    center: selection.centerSnapshot ?? null,
    rejectCenterConflicts: selection.rejectCenterConflicts === true,
  })
}

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b))
const normalizedAbsolute = (path: unknown): path is string => typeof path === 'string' && isAbsolute(path) && resolve(path) === path

/** Capture the caller's selection before any asynchronous work. No host types/imports. */
function copyCenterSnapshot(value: RuntimeCenterSnapshot | undefined): RuntimeCenterSnapshot | undefined {
  if (value === undefined) return undefined
  if (!value || !Number.isSafeInteger(value.generation) || value.generation < 0 || Object.is(value.generation, -0)
    || !Array.isArray(value.packs) || !Array.isArray(value.suppressedLegacyPaths)) {
    throw new RuntimeCenterPackError('CENTER_SNAPSHOT_INVALID', 'Invalid local center snapshot')
  }
  const packIds = new Set<string>()
  const releaseIds = new Set<string>()
  const roots = new Set<string>()
  const packs: RuntimeCenterSnapshot['packs'][number][] = []
  for (const item of value.packs) {
    if (!item || typeof item.packId !== 'string' || !isSafeKnowledgeId(item.packId)
      || typeof item.releaseId !== 'string' || !isSafeKnowledgeId(item.releaseId)
      || !normalizedAbsolute(item.root) || typeof item.contentTreeSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(item.contentTreeSha256) || item.contentTreeSha256.length !== 64
      || (item.source !== undefined && item.source !== 'center' && item.source !== 'legacy')
      || packIds.has(item.packId) || releaseIds.has(item.releaseId) || roots.has(item.root)) {
      throw new RuntimeCenterPackError('CENTER_SNAPSHOT_INVALID', 'Local center snapshot has an invalid or duplicate pack')
    }
    packIds.add(item.packId); releaseIds.add(item.releaseId); roots.add(item.root)
    packs.push({ packId: item.packId, releaseId: item.releaseId, root: item.root, contentTreeSha256: item.contentTreeSha256, ...(item.source === undefined ? {} : { source: item.source }) })
  }
  for (const path of value.suppressedLegacyPaths) {
    if (!normalizedAbsolute(path)) throw new RuntimeCenterPackError('CENTER_SNAPSHOT_INVALID', 'Legacy suppression paths must be absolute and normalized')
  }
  packs.sort((a, b) => byteOrder(a.packId, b.packId) || byteOrder(a.releaseId, b.releaseId) || byteOrder(a.root, b.root))
  return { generation: value.generation, packs, suppressedLegacyPaths: [...new Set(value.suppressedLegacyPaths)].sort(byteOrder) }
}

async function optionalRealpath(path: string): Promise<string | undefined> {
  try { return await realpath(path) } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Only exact physical vendor child directories may be suppressed, never an ID. */
async function selectLegacyDirs(
  dirs: readonly PackDir[], vendorRoot: string, suppressedPaths: readonly string[],
): Promise<readonly PackDir[]> {
  if (vendorRoot.trim() === '' || suppressedPaths.length === 0) return dirs
  const vendorReal = await optionalRealpath(vendorRoot)
  if (vendorReal === undefined) return dirs
  const suppressed = new Set(await Promise.all(suppressedPaths.map(async path => await optionalRealpath(path) ?? path)))
  const selected = await Promise.all(dirs.map(async item => {
    const physical = await optionalRealpath(item.dir)
    return physical !== undefined && dirname(physical) === vendorReal && suppressed.has(physical) ? undefined : item
  }))
  return selected.filter((item): item is PackDir => item !== undefined)
}

async function loadCenterPack(item: RuntimeCenterSnapshot['packs'][number]): Promise<LoadedPack> {
  try {
    // Verify before and after loading so observed changes cannot populate/reuse the cache.
    const before = await hashContentDirectory(item.root)
    if (before.contentTreeSha256 !== item.contentTreeSha256) {
      throw new RuntimeCenterPackError('CENTER_INTEGRITY_MISMATCH', `Center release ${item.releaseId} content has changed`)
    }
    const loaded = await loadPackFromDir(item.root, { layer: 'domain-pack', label: `${item.source === 'legacy' ? 'managed-legacy' : 'center'}/${item.packId}/${item.releaseId}` })
    if (!loaded.ok || loaded.pack === undefined) {
      throw new RuntimeCenterPackError('CENTER_PACK_INVALID', `Center release ${item.releaseId} failed local validation`, loaded.diagnostics)
    }
    if (loaded.pack.pack.id !== item.packId) {
      throw new RuntimeCenterPackError('CENTER_PACK_ID_MISMATCH', `Center release ${item.releaseId} has a different pack identity`)
    }
    if ((await hashContentDirectory(item.root)).contentTreeSha256 !== item.contentTreeSha256) {
      throw new RuntimeCenterPackError('CENTER_INTEGRITY_MISMATCH', `Center release ${item.releaseId} changed while loading`)
    }
    return loaded
  } catch (error: unknown) {
    if (error instanceof RuntimeCenterPackError) throw error
    throw new RuntimeCenterPackError('CENTER_PACK_UNAVAILABLE', `Center release ${item.releaseId} cannot be read safely: ${String(error)}`)
  }
}

/**
 * Cheap per-dir fingerprint: the newest `mtimeMs` of `pack.json` and
 * `generated/pack.sha256` (the two files that change when a pack is
 * regenerated), or the dir's own mtime when neither exists. `undefined` when
 * the dir cannot be statted — treated as "changed" so the next resolve
 * reloads.
 */
function packDirFingerprint(dir: string): string | undefined {
  let newest = -1
  for (const file of [join(dir, 'pack.json'), join(dir, 'generated', 'pack.sha256')]) {
    try {
      const info = statSync(file)
      if (info.mtimeMs > newest) newest = info.mtimeMs
    } catch {
      // missing file — keep probing the other candidate
    }
  }
  if (newest >= 0) return String(newest)
  try {
    return String(statSync(dir).mtimeMs)
  } catch {
    return undefined
  }
}

/**
 * Order loaded workspace packs by the packPriority setting (first = highest
 * precedence); packs not listed keep their discovery order after the listed
 * ones. Equal/unknown ranks preserve discovery order (stable). Packs whose
 * id does not match any priority entry sort last, in discovery order.
 */
function orderLoadedPacks(
  loaded: readonly LoadedPack[],
  priority: readonly string[] | undefined,
): LoadedPack[] {
  if (priority === undefined || priority.length === 0) return [...loaded]
  const rank = new Map(priority.map((id, index) => [id, index]))
  return [...loaded].sort((a, b) => {
    const ra = rank.get(a.pack!.pack.id) ?? Number.MAX_SAFE_INTEGER
    const rb = rank.get(b.pack!.pack.id) ?? Number.MAX_SAFE_INTEGER
    return ra - rb
  })
}

/** Inspect the exact loaded inputs used by this resolve, before any cache return. */
function rejectCenterConflicts(base: DomainPackV2, legacy: readonly LoadedPack[], center: readonly LoadedPack[]): void {
  const sections = ['experts', 'teamTemplates', 'outputTemplates', 'qualityPolicies', 'scenarios', 'toolProviders', 'knowledgeProviders', 'domainKnowledge', 'methodPacks', 'skillPackages'] as const
  const packOwners = new Map<string, string>()
  const entityOwners = new Map<string, string>()
  function add(pack: DomainPackV2, label: string, enforce: boolean) {
    // A center release may take over the builtin base of the same id (覆盖式升级);
    // conflicts against workspace/legacy copies remain hard errors. The V1
    // projection view (`legacy-v1-view`) is the same builtin family as the
    // zhijian base — a center release upgrading it is the designed takeover.
    const isBaseLabel = (candidate: string) =>
      candidate === `builtin/${pack.pack.id}` || candidate === 'builtin/legacy-v1-view'
    const existingPack = packOwners.get(pack.pack.id)
    if (enforce && existingPack !== undefined && !isBaseLabel(existingPack)) {
      throw new RuntimeCenterPackError('CENTER_PACK_ID_CONFLICT', `Center pack ${pack.pack.id} conflicts with ${existingPack}`)
    }
    packOwners.set(pack.pack.id, label)
    for (const section of sections) {
      for (const entity of pack[section]) {
        const key = `${section}:${entity.id}`
        const existing = entityOwners.get(key)
        if (enforce && existing !== undefined && !isBaseLabel(existing)) {
          throw new RuntimeCenterPackError('CENTER_ENTITY_CONFLICT', `Center entity ${key} conflicts with ${existing}`)
        }
        entityOwners.set(key, label)
      }
    }
  }
  // Preserve existing legacy-on-builtin and legacy-on-legacy overlay semantics.
  add(base, `builtin/${base.pack.id}`, false)
  for (const item of legacy) add(item.pack!, item.source.label, false)
  for (const item of center) add(item.pack!, item.source.label, true)
}

/**
 * Resolve the runtime pack for one compile: the base pack (caller-owned,
 * typically the builtin zhijian or collab pack) merged with every enabled
 * workspace pack and explicitly activated center snapshot. Cache reuse
 * requires current center tree verification and unchanged local selection.
 *
 * A workspace pack whose id is not in `enabledPacks` (when the list is
 * non-empty) is skipped; a pack that fails to load or validate is skipped
 * with its diagnostics folded into the result (never fatal — the base pack
 * alone remains valid). `packPriority` orders the workspace layers (first =
 * highest precedence; among workspace layers the highest-precedence pack wins
 * per entity id). Center failures throw; workspace-only failures retain the
 * legacy diagnostic fallback. The returned center snapshot retains roots for
 * later task/resource binding; this component does not manage task lifetimes.
 */
export async function resolveRuntimePack(
  ctx: Context,
  selection: RuntimePackSelection,
  base: DomainPackV2,
): Promise<RuntimePackResult> {
  const centerSnapshot = copyCenterSnapshot(selection.centerSnapshot)
  const selected: RuntimePackSelection = {
    ...selection,
    enabledPacks: selection.enabledPacks === undefined ? undefined : [...selection.enabledPacks],
    packPriority: selection.packPriority === undefined ? undefined : [...selection.packPriority],
    centerSnapshot,
  }
  // mergePackLayers may retain nested references. Clone before freezing any result.
  const baseCopy = structuredClone(base)
  const selectionKey = selectionKeyOf(selected)
  const groups = new Map<string, PackDir[]>()
  for (const item of await discoverPackDirs(ctx, selected.packsDir, selected.vendorPacksDir ?? '')) {
    const parent = dirname(item.dir)
    const group = groups.get(parent) ?? []
    group.push(item); groups.set(parent, group)
  }
  // Preserve workspace/root precedence while normalizing each filesystem enumeration.
  const discovered = [...groups.values()].flatMap(group => group.sort((a, b) => byteOrder(a.dir, b.dir)))
  const dirs = await selectLegacyDirs(discovered, selected.vendorPacksDir ?? '', centerSnapshot?.suppressedLegacyPaths ?? [])
  const cacheKey = canonicalize({ base: canonicalDigest(baseCopy), selectionKey, discoveryRoots: workspaceRootsOf(ctx), discovered })

  const enabled = selected.enabledPacks === undefined
    ? undefined
    : new Set(selected.enabledPacks.filter(id => id !== ''))

  // Promise.all retains discovery order; completion timing must not choose an overlay winner.
  const loadedAll: LoadedPack[] = []
  const diagnostics: PackDiagnostic[] = []
  const legacyLoaded = await Promise.all(dirs.map(dir => loadPackFromDir(dir.dir, { layer: 'workspace', label: dir.label })))
  for (const [index, item] of legacyLoaded.entries()) {
    if (item.ok && item.pack !== undefined) {
      loadedAll.push(item)
    } else {
      for (const diagnostic of item.diagnostics) {
        diagnostics.push({
          ...diagnostic,
          path: `overlay.${dirs[index]!.label}.${diagnostic.path}`,
        })
      }
    }
  }
  const centerLoaded = await Promise.all((centerSnapshot?.packs ?? []).map(loadCenterPack))
  for (const item of centerLoaded) diagnostics.push(...item.diagnostics.filter(diagnostic => diagnostic.severity !== 'info'))

  const ordered = orderLoadedPacks(loadedAll, selected.packPriority)
    .filter(item => enabled === undefined || enabled.size === 0 || enabled.has(item.pack!.pack.id))
  if (selected.rejectCenterConflicts === true) rejectCenterConflicts(baseCopy, ordered, centerLoaded)
  const fingerprint = canonicalize({
    legacy: ordered.map(item => ({
      root: item.source.root ?? item.source.label,
      mtime: packDirFingerprint(item.source.root ?? item.source.label) ?? 'changed',
      content: canonicalDigest(item.pack),
    })),
    center: centerSnapshot ?? null,
    diagnostics,
  })

  const cached = runtimePackCache.get(cacheKey)
  if (cached !== undefined && cached.baseId === baseCopy.pack.id
    && cached.selectionKey === selectionKey && cached.fingerprint === fingerprint) {
    return cached.result
  }

  // Merge: base (builtin) + workspace layers in ascending precedence so the
  // highest-precedence workspace pack wins per id. mergePackLayers revalidates
  // the whole merged pack; on any error we fall back to the base pack with the
  // diagnostics (the base is always validator-clean). The merged pack's
  // metadata stays the BASE pack's — overlay packs contribute entities by id,
  // never the pack identity (the caller's base defines the domain).
  const merged = mergePackLayers([
    { pack: baseCopy, layer: 'builtin', label: baseCopy.pack.id },
    ...centerLoaded.map(item => ({ pack: item.pack!, layer: 'domain-pack' as const, label: item.source.label })),
    ...ordered.map(item => ({ pack: item.pack!, layer: 'workspace' as const, label: item.source.label })),
  ], { reportReplaces: false })
  diagnostics.push(...merged.diagnostics.filter(d => d.severity !== 'info'))
  if (centerLoaded.length > 0 && (!merged.ok || merged.pack === undefined)) {
    throw new RuntimeCenterPackError('CENTER_MERGE_INVALID', 'Active center snapshot cannot be merged with local packs', diagnostics)
  }

  const mergedPack = merged.pack === undefined ? undefined : { ...merged.pack, pack: baseCopy.pack }
  const result: RuntimePackResult = deepFreeze({
    pack: mergedPack ?? baseCopy,
    layers: [...centerLoaded, ...ordered].map(item => ({ dir: item.source.root ?? item.source.label, label: item.source.label })),
    diagnostics,
    ...(centerSnapshot === undefined ? {} : { centerSnapshot }),
  })
  runtimePackCache.set(cacheKey, { baseId: baseCopy.pack.id, selectionKey, fingerprint, result })
  return result
}
