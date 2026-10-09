/**
 * Explicit cross-pack compatibility declarations for the three Zhijian
 * reviewers that are also eligible for the pipeline-general review lane.
 *
 * These are not claims extracted from a historical profile or roster row.
 * Keeping them in a separate, reviewable source makes the distinction
 * auditable: `zhijian.review` and field/tag capabilities remain roster
 * projections, while these two pipeline capabilities are a deliberate
 * compatibility overlay consumed by the V2 projector.
 */

export const ZHIJIAN_PIPELINE_COMPATIBILITY_EVIDENCE = 'zhijian:compatibility/pipeline-review' as const

export const ZHIJIAN_PIPELINE_REVIEW_CAPABILITIES = [
  'pipeline-general.review',
  'pipeline.general.review',
] as const

export type ZhijianPipelineCompatibility = Readonly<{
  capabilities: readonly string[]
  coverage: 'high' | 'medium' | 'low'
  evidenceRefs: readonly string[]
}>

/** Narrow by design: adding an expert requires an explicit reviewed entry. */
export const ZHIJIAN_PIPELINE_COMPATIBILITY: Readonly<Record<string, ZhijianPipelineCompatibility>> = Object.freeze({
  'bk-011': Object.freeze({
    capabilities: ZHIJIAN_PIPELINE_REVIEW_CAPABILITIES,
    coverage: 'high',
    evidenceRefs: [ZHIJIAN_PIPELINE_COMPATIBILITY_EVIDENCE],
  }),
  'bk-024': Object.freeze({
    capabilities: ZHIJIAN_PIPELINE_REVIEW_CAPABILITIES,
    coverage: 'high',
    evidenceRefs: [ZHIJIAN_PIPELINE_COMPATIBILITY_EVIDENCE],
  }),
  'bk-025': Object.freeze({
    capabilities: ZHIJIAN_PIPELINE_REVIEW_CAPABILITIES,
    coverage: 'high',
    evidenceRefs: [ZHIJIAN_PIPELINE_COMPATIBILITY_EVIDENCE],
  }),
})
