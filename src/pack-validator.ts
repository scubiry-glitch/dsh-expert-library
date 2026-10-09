/**
 * Standalone, local-only validation entry for the pack center and tooling.
 * Importing this entry does not initialize the Harness plugin or import its
 * host/client runtime. Domain-pack validation remains owned by the existing
 * loader and validator; this module introduces no second rule implementation.
 *
 * This entry intentionally does not export the legacy tree-hashing helper.
 * Center artifacts use the versioned algorithm in @zhijian/pack-contract.
 */
export {
  loadPackFromDir,
  loadPackFromFile,
  loadSkillPackageFromDir,
  canonicalSkillDigest,
  mergePackLayers,
} from './v2/pack-loader.ts'
export { validateDomainPack } from './v2/validate.ts'
export type { LoadedPack, MergeResult } from './v2/pack-loader.ts'
export type { DomainPackV2, PackDiagnostic } from './v2/types.ts'
