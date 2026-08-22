/**
 * Fixed gate-chain phase semantics shared by the compiler (Phase 3) and the
 * quality runtime (Phase 4).
 *
 * The architecture fixes one chain order (§3.6): Schema/Structure → Data &
 * Citation → Compliance/Anonymization → Format/DOM/Visual → Style Lint →
 * Semantic Review → Repair(≤2) → Final Gate. Gates declare their position via
 * `phase`; when a gate does not declare one, the compiler derives a
 * deterministic phase from its kind so ordering never depends on map
 * iteration or declaration accidents.
 * @module dsh-expert-library/v2/phases
 */

import type { GateKind, GatePhase } from './types.ts'

/** The fixed chain order of §3.6, earliest first. */
export const GATE_PHASE_ORDER: readonly GatePhase[] = [
  'structure',
  'data',
  'compliance',
  'format',
  'style',
  'semantic',
  'final',
]

/** Rank of a phase in the fixed chain; unknown phases sort last. */
export function phaseRank(phase: GatePhase): number {
  const index = GATE_PHASE_ORDER.indexOf(phase)
  return index === -1 ? GATE_PHASE_ORDER.length : index
}

/** Deterministic fallback phase per gate kind, used when `phase` is absent. */
export function defaultPhaseForKind(kind: GateKind): GatePhase {
  switch (kind) {
    case 'deterministic':
      return 'structure'
    case 'visual':
      return 'format'
    case 'semantic':
      return 'semantic'
  }
}

/** Effective phase of a gate spec: declared `phase`, else the kind default. */
export function gatePhase(spec: { readonly kind: GateKind; readonly phase?: GatePhase }): GatePhase {
  return spec.phase ?? defaultPhaseForKind(spec.kind)
}
