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
 * the base pack id + the settings signature (`enabledPacks`/`packPriority`)
 * + a per-dir mtime fingerprint of each participating pack dir, and
 * {@link invalidateRuntimePack} drops the cache eagerly — the settings
 * onChange path in `src/index.ts` calls it so pack edits take effect without
 * a restart.
 *
 * Selection is by **pack id** (`pack.json` `pack.pack.id`), the same id the
 * settings pack list exposes: `enabledPacks` absent/empty means every valid
 * workspace pack participates, and `packPriority` (first = highest
 * precedence) orders the workspace layers.
 *
 * The base pack is never mutated: `mergePackLayers` produces a fresh merged
 * value, and the compile path treats it as read-only.
 *
 * @module dsh-expert-library/v2/runtime-pack
 */

import type { Context } from '@deepseek-ai/cordis'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from './digest.ts'
import { loadPackFromDir, mergePackLayers, type LoadedPack } from './pack-loader.ts'
import { discoverPackDirs, type PackDir } from './preview.ts'
import type { DomainPackV2, PackDiagnostic } from './types.ts'

/** Runtime pack selection knobs (a subset of ToolsConfig). */
export interface RuntimePackSelection {
  /** Domain pack directory name under each workspace root (default `domain-packs`). */
  readonly packsDir: string
  /** Workspace pack ids enabled for runtime compile; absent/empty = every valid workspace pack. */
  readonly enabledPacks?: readonly string[]
  /** Workspace pack id order (first = highest precedence); absent = discovery order. */
  readonly packPriority?: readonly string[]
}

/** Result of resolving the runtime pack. */
export interface RuntimePackResult {
  /** The merged, validated pack (base + enabled workspace overlays). */
  readonly pack: DomainPackV2
  /** Every workspace pack that participated, in merge order (highest last). */
  readonly layers: readonly PackDir[]
  /** Diagnostics from loading/merging workspace packs (failures degrade, never fatal). */
  readonly diagnostics: readonly PackDiagnostic[]
}

/** One process-wide cache entry. */
interface RuntimePackCacheEntry {
  /** Base pack id this entry was built over. */
  readonly baseId: string
  /** Settings signature (enabled/priority) at build time. */
  readonly selectionKey: string
  /** Per-dir mtime fingerprint of every participating pack dir. */
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
    enabled: selection.enabledPacks === undefined ? null : [...selection.enabledPacks].sort(),
    priority: selection.packPriority === undefined ? null : [...selection.packPriority],
  })
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

/**
 * Resolve the runtime pack for one compile: the base pack (caller-owned,
 * typically the builtin zhijian or collab pack) merged with every enabled
 * workspace pack, cached by base id + selection + dir fingerprint.
 *
 * A workspace pack whose id is not in `enabledPacks` (when the list is
 * non-empty) is skipped; a pack that fails to load or validate is skipped
 * with its diagnostics folded into the result (never fatal — the base pack
 * alone remains valid). `packPriority` orders the workspace layers (first =
 * highest precedence; among workspace layers the highest-precedence pack wins
 * per entity id).
 */
export async function resolveRuntimePack(
  ctx: Context,
  selection: RuntimePackSelection,
  base: DomainPackV2,
): Promise<RuntimePackResult> {
  const selectionKey = selectionKeyOf(selection)
  const cacheKey = `${base.pack.id}\u0000${selectionKey}`

  const dirs = await discoverPackDirs(ctx, selection.packsDir)
  const enabled = selection.enabledPacks === undefined
    ? undefined
    : new Set(selection.enabledPacks.filter(id => id !== ''))

  // Load every discovered workspace pack (parallel), then select by pack id.
  const loadedAll: LoadedPack[] = []
  const diagnostics: PackDiagnostic[] = []
  await Promise.all(dirs.map(async (dir) => {
    const item = await loadPackFromDir(dir.dir, { layer: 'workspace', label: dir.label })
    if (item.ok && item.pack !== undefined) {
      loadedAll.push(item)
    } else {
      for (const diagnostic of item.diagnostics) {
        diagnostics.push({
          ...diagnostic,
          path: `overlay.${dir.label}.${diagnostic.path}`,
        })
      }
    }
  }))

  const ordered = orderLoadedPacks(loadedAll, selection.packPriority)
    .filter(item => enabled === undefined || enabled.size === 0 || enabled.has(item.pack!.pack.id))
  const fingerprint = ordered.map(item => packDirFingerprint(item.source.root ?? item.source.label) ?? 'changed').join('|')

  const cached = runtimePackCache.get(cacheKey)
  if (cached !== undefined && cached.baseId === base.pack.id
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
    { pack: base, layer: 'builtin', label: base.pack.id },
    ...ordered.map(item => ({ pack: item.pack!, layer: 'workspace' as const, label: item.source.label })),
  ], { reportReplaces: false })
  diagnostics.push(...merged.diagnostics.filter(d => d.severity !== 'info'))

  const mergedPack = merged.pack === undefined ? undefined : { ...merged.pack, pack: base.pack }
  const result: RuntimePackResult = {
    pack: mergedPack ?? base,
    layers: ordered.map(item => ({ dir: item.source.root ?? item.source.label, label: item.source.label })),
    diagnostics,
  }
  runtimePackCache.set(cacheKey, { baseId: base.pack.id, selectionKey, fingerprint, result })
  return result
}
