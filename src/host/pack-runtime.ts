/**
 * Host bridge from deployment-local state to the pure runtime resolver.
 * Providers read already-verified local inventory; no remote access belongs here.
 * A call captures its selection/base/provider before awaiting the local snapshot.
 */
import type { Context } from '@deepseek-ai/cordis'
import { deepFreeze } from '../v2/digest.ts'
import {
  resolveRuntimePack, RuntimeCenterPackError,
  type RuntimeCenterSnapshot, type RuntimePackResult, type RuntimePackSelection,
} from '../v2/runtime-pack.ts'
import type { DomainPackV2 } from '../v2/types.ts'
import { canonicalStateJson, validatePackCenterState, type PackCenterState } from './pack-center-state.ts'

export interface ManagedRuntimePackSelection extends RuntimePackSelection {
  /** Internal host wiring only, never a serialized/user-editable setting. */
  readonly getPackCenterSnapshot?: () => Promise<RuntimeCenterSnapshot>
}

function captureSelection(selection: RuntimePackSelection): RuntimePackSelection {
  return deepFreeze({
    packsDir: selection.packsDir,
    ...(selection.vendorPacksDir === undefined ? {} : { vendorPacksDir: selection.vendorPacksDir }),
    ...(selection.enabledPacks === undefined ? {} : { enabledPacks: [...selection.enabledPacks] }),
    ...(selection.packPriority === undefined ? {} : { packPriority: [...selection.packPriority] }),
  })
}

/** Detach before handing untrusted/caller-owned objects to the pure resolver. */
function captureSnapshot(snapshot: RuntimeCenterSnapshot): RuntimeCenterSnapshot {
  try { return deepFreeze(JSON.parse(canonicalStateJson(snapshot)) as RuntimeCenterSnapshot) } catch {
    throw new RuntimeCenterPackError('CENTER_SNAPSHOT_INVALID', 'Local pack-center provider returned a non-JSON snapshot')
  }
}

/** Every call refreshes local state; failure never falls back to another version. */
export async function resolveManagedRuntimePack(
  ctx: Context,
  selection: ManagedRuntimePackSelection,
  base: DomainPackV2,
): Promise<RuntimePackResult> {
  const provider = selection.getPackCenterSnapshot
  if (provider === undefined) return resolveRuntimePack(ctx, selection, base)
  const selected = captureSelection(selection)
  const baseCopy = deepFreeze(structuredClone(base))
  const snapshot = captureSnapshot(await provider())
  return resolveRuntimePack(ctx, { ...selected, centerSnapshot: snapshot, rejectCenterConflicts: true }, baseCopy)
}

/** Convert a verified pending transaction into the same local runtime snapshot. */
function pendingSnapshot(input: Readonly<PackCenterState> | RuntimeCenterSnapshot): RuntimeCenterSnapshot {
  const captured = JSON.parse(canonicalStateJson(input)) as Readonly<PackCenterState> | RuntimeCenterSnapshot
  if ('active' in captured) {
    validatePackCenterState(captured)
    return deepFreeze({
      generation: captured.generation,
      packs: Object.entries(captured.active).map(([packId, releaseId]) => ({
        packId, releaseId,
        root: captured.installed[releaseId]!.packPath,
        contentTreeSha256: captured.installed[releaseId]!.contentTreeSha256,
        source: captured.installed[releaseId]!.source,
      })),
      suppressedLegacyPaths: Object.keys(captured.legacySuppressions),
    })
  }
  return captureSnapshot(captured)
}

/**
 * Preflight all real host base packs before an activation transaction commits.
 * The resolver checks exact loaded builtin/workspace/center inputs synchronously
 * and performs the real validated merge. Only exact vendor-path takeover removes
 * a legacy collision; there is no pack-ID-wide or arbitrary override whitelist.
 */
export async function preflightManagedActivation(
  ctx: Context,
  selection: RuntimePackSelection,
  bases: readonly DomainPackV2[],
  stateSnapshot: Readonly<PackCenterState> | RuntimeCenterSnapshot,
): Promise<void> {
  const selected = captureSelection(selection)
  const baseCopies = deepFreeze(structuredClone(bases))
  const snapshot = pendingSnapshot(stateSnapshot)
  if (baseCopies.length === 0) throw new RuntimeCenterPackError('CENTER_BASES_REQUIRED', 'Activation requires the actual host base packs')
  for (const base of baseCopies) {
    await resolveRuntimePack(ctx, { ...selected, centerSnapshot: snapshot, rejectCenterConflicts: true }, base)
  }
}
