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
  /** Workspace pack ids enabled for runtime compile; absent = every valid workspace pack. */
  readonly enabledPacks?: readonly string[]
  /** Workspace pack id order (first = highest precedence); absent = discovery order. */
  readonly packPriority?: readonly string[]
}

/** Result of resolving the runtime pack. */
export interface RuntimePackResult {
  /** The merged, validated pack (base + enabled workspace overlays). */
  readonly pack: DomainPackV2
  /** Every workspace pack dir that participated, in merge order (highest last). */
  readonly layers: readonly PackDir[]
  /** Diagnostics from loading/merging workspace packs (errors degrade to warnings). */
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
 * Order workspace pack dirs by the packPriority setting (first = highest
 * precedence); packs not listed keep their discovery order after the listed
 * ones. Equal/unknown ranks preserve discovery order (stable).
 */
function orderPackDirs(dirs: readonly PackDir[], priority: readonly string[] | undefined): PackDir[] {
  if (priority === undefined || priority.length === 0) return [...dirs]
  const rank = new Map(priority.map((id, index) => [id, index]))
  return [...dirs].sort((a, b) => {
    const ra = rank.get(a.dir.split('/').pop() ?? a.dir) ?? Number.MAX_SAFE_INTEGER
    const rb = rank.get(b.dir.split('/').pop() ?? b.dir) ?? Number.MAX_SAFE_INTEGER
    return ra - rb
  })
}

/**
 * Resolve the runtime pack for one compile: the base pack (caller-owned,
 * typically the builtin zhijian or collab pack) merged with every enabled
 * workspace pack, cached by base id + selection + dir fingerprint.
 *
 * A workspace pack whose id is not in `enabledPacks` is skipped; a pack that
 * fails to load or validate is skipped with its diagnostics folded into the
 * result (never fatal — the base pack alone remains valid). `packPriority`
 * orders the workspace layers (first = highest precedence; the merge keeps
 * the canonical `builtin < workspace` ordering, so among workspace layers
 * the highest-precedence pack wins per entity id).
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
    : new Set(selection.enabledPacks)
  // A missing/empty enabled list means "all valid workspace packs" — the same
  // semantics as undefined.
  const filter = enabled !== undefined && enabled.size > 0 ? enabled : undefined

  const ordered = orderPackDirs(dirs, selection.packPriority)
    .filter(dir => filter === undefined || filter.has(dir.dir.split('/').pop() ?? dir.dir))
  const fingerprint = ordered.map(dir => packDirFingerprint(dir.dir) ?? 'changed').join('|')

  const cached = runtimePackCache.get(cacheKey)
  if (cached !== undefined && cached.baseId === base.pack.id
    && cached.selectionKey === selectionKey && cached.fingerprint === fingerprint) {
    return cached.result
  }

  // Load every enabled workspace pack (parallel). Failed loads contribute
  // diagnostics but never block the base pack.
  const loaded: LoadedPack[] = []
  const diagnostics: PackDiagnostic[] = []
  await Promise.all(ordered.map(async (dir) => {
    const item = await loadPackFromDir(dir.dir, { layer: 'workspace', label: dir.label })
    if (item.ok && item.pack !== undefined) {
      loaded.push(item)
    } else {
      for (const diagnostic of item.diagnostics) {
        diagnostics.push({
          ...diagnostic,
          path: `overlay.${dir.label}.${diagnostic.path}`,
        })
      }
    }
  }))

  // Merge: base (builtin) + workspace layers in ascending precedence so the
  // highest-precedence workspace pack wins per id. mergePackLayers revalidates
  // the whole merged pack; on any error we fall back to the base pack with the
  // diagnostics (the base is always validator-clean).
  const merged = mergePackLayers([
    { pack: base, layer: 'builtin', label: base.pack.id },
    ...loaded.map(item => ({ pack: item.pack!, layer: 'workspace' as const, label: item.source.label })),
  ], { reportReplaces: false })
  diagnostics.push(...merged.diagnostics.filter(d => d.severity !== 'info'))

  const result: RuntimePackResult = {
    pack: merged.pack ?? base,
    layers: ordered,
    diagnostics,
  }
  runtimePackCache.set(cacheKey, { baseId: base.pack.id, selectionKey, fingerprint, result })
  return result
}
