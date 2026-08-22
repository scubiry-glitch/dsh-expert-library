/**
 * Public surface of the V2 foundation: Phase 1 `schema-v2` (types, pure pack
 * validator, V1 compatibility adapters, the Zhijian `zhijian-realestate`
 * domain-pack projection), Phase 2 `provider-runtime` (ProviderRegistry,
 * CapabilityResolver, ProviderEnvelope, Wind/zyt normalization), Phase 3
 * `template-compiler` (immutable ExecutionPlan + digest) and Phase 4
 * `quality-runtime` (deterministic gate chain, hard-fail block, targeted
 * repair ≤2 rounds, artifact hashes).
 *
 * Exported through the package `exports` map as
 * `@zhijian/dsh-expert-library/v2` (`./lib/v2/index.js`, types
 * `./lib/types/v2/index.d.ts`). Most modules are not yet wired into Host
 * registration or the UI — internal modules first, per the phased migration
 * plan in NEXT-GENERATION-ARCHITECTURE.md §11; the single exception is the
 * read-only `preview` surface (Phase 1 「设置页只读预览校验」), which backs
 * `GET /plugins/dsh-expert-library/packs`.
 * @module dsh-expert-library/v2
 */

export * from './types.ts'
export { validateDomainPack } from './validate.ts'
export { adaptV1Expert, adaptV1Scenario, adaptV1ScenarioTeamTemplate, buildLegacyDomainPack, migrateDomainPack, compileV1ScenarioExecutionPlan, builtinLegacyPack, invalidateBuiltinLegacyPack, loadBuiltinLegacyPack, mergeCachedExperts } from './compat.ts'
export type { MigrationResult } from './compat.ts'
export * from './provider-runtime.ts'
export * from './providers/wind.ts'
export * from './providers/zyt.ts'
export * from './providers/beike.ts'
export {
  buildZhijianDomainPack,
  zhijianMetaToExpertV2,
  ZHIJIAN_PACK_ID,
  ZHIJIAN_PACK_VERSION,
  ZHIJIAN_PACK_SNAPSHOT,
  ZHIJIAN_BASELINE_DATE,
  REVIEW_CAPABILITY,
  FIELD_DOMAINS,
  TAG_CAPABILITIES,
} from './zhijian-pack.ts'
export type { BuildZhijianPackOptions } from './zhijian-pack.ts'
export * from './digest.ts'
export * from './phases.ts'
export * from './compiler.ts'
export * from './quality.ts'
export * from './builtin-gates.ts'
export * from './pack-loader.ts'
export * from './preview.ts'
