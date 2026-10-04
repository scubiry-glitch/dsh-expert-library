/** Explicit report-task opt-in. Domain/skill choice comes from AI selections, never free text inference. */
import type { ArtifactCheckSpec } from './quality-run.ts'
import { REPORT_CRAFT_PACK_ID, REPORT_CRAFT_MATERIAL_DIGEST } from './report-craft-materials.ts'
import { isSkillCraftSelection, isFrozenSkillCraftContract, resolveSelectedSkillContract, verifyFrozenSkillCraftContract } from './skill-craft.ts'
import type { FrozenSkillCraftContract, SkillCraftSelection } from './skill-craft-types.ts'
import { canonicalDigest } from './v2/digest.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolsConfig } from './team-core.ts'

export interface ReportBundle {
  readonly md: string
  readonly html: string
  readonly pdf: string
  readonly craft?:
    | { readonly version: 2; readonly style: 'credit-policy' | 'designer-paper'; readonly evidence: string }
    | { readonly version: 3; readonly selections: readonly SkillCraftSelection[]; readonly evidence: string }
}

export function isReportBundle(value: unknown): value is ReportBundle {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['md', 'html', 'pdf', 'craft'].includes(key))) return false
  if (row.craft !== undefined) {
    if (row.craft === null || typeof row.craft !== 'object' || Array.isArray(row.craft)) return false
    const craft = row.craft as Record<string, unknown>
    if (typeof craft.evidence !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$/.test(craft.evidence) || craft.evidence.includes('..')) return false
    if (craft.version === 2) {
      if (Object.keys(craft).length !== 3 || Object.keys(craft).some(key => !['version', 'style', 'evidence'].includes(key))
        || !['credit-policy', 'designer-paper'].includes(String(craft.style))) return false
    } else if (craft.version === 3) {
      if (Object.keys(craft).length !== 3 || Object.keys(craft).some(key => !['version', 'selections', 'evidence'].includes(key))
        || !Array.isArray(craft.selections) || craft.selections.length === 0 || craft.selections.length > 8
        || !craft.selections.every(isSkillCraftSelection)
        || new Set(craft.selections.map(selection => `${selection.packId}\0${selection.skillId}`)).size !== craft.selections.length) return false
    } else return false
  }
  return (['md', 'html', 'pdf'] as const).every(ext => typeof row[ext] === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/.test(row[ext] as string)
    && !(row[ext] as string).includes('..') && (row[ext] as string).endsWith(`.${ext}`))
}

export function selectedCraftRequests(contract: FrozenSkillCraftContract): SkillCraftSelection[] {
  return contract.selections.map(({ packId, skillId, variant, reason }) => ({ packId, skillId, ...(variant === undefined ? {} : { variant }), reason }))
}

/** New workflow admission is separate from historical parsing and explicit legacy revisions. */
export function requireNewReportCraftSelection(bundle: ReportBundle | undefined): void {
  if (bundle !== undefined && bundle.craft?.version !== 3) throw new Error('REPORT_SKILL_SELECTION_REQUIRED: new report tasks must explicitly select currently enabled domain-pack skills with craft:{version:3,selections:[{packId,skillId,variant?,reason}],evidence:"craft-evidence.json"}. v1/v2 are retained only for historical tasks and explicit revises_task_id inheritance; they cannot bypass skill selection for a new report.')
}

/** Shape/binding only, suitable for cold reads without accessing mutable pack files. */
export function isReportCraftBinding(bundle: ReportBundle | undefined, frozen: unknown): boolean {
  if (bundle?.craft?.version !== 3) return frozen === undefined
  return isFrozenSkillCraftContract(frozen) && ['md', 'html', 'pdf', 'evidence'].every(role => frozen.artifactRoles.includes(role as 'md' | 'html' | 'pdf' | 'evidence'))
    && (['writer', 'renderer', 'reviewer'] as const).every(role => frozen.materials.some(material => material.bytes > 0 && material.roles.includes(role))) && canonicalDigest(bundle.craft.selections) === canonicalDigest(selectedCraftRequests(frozen))
}

export function reportArtifactCheck(bundle: ReportBundle, frozen?: FrozenSkillCraftContract): ArtifactCheckSpec {
  if (!isReportBundle(bundle)) throw new Error('REPORT_BUNDLE_INVALID: supply safe exact publication filenames and an explicit supported craft selection')
  const artifacts = { md: `published:${bundle.md}`, html: `published:${bundle.html}`, pdf: `published:${bundle.pdf}` }
  if (bundle.craft?.version === 3) {
    if (isFrozenSkillCraftContract(frozen)) {
      const missing = (['md', 'html', 'pdf', 'evidence'] as const).filter(role => !frozen.artifactRoles.includes(role))
      if (missing.length > 0) throw new Error(`SKILL_CRAFT_OUTPUT_COVERAGE: selected skills do not declare coverage for ${missing.join(', ')}. Explicitly select applicable additional skills from the enabled catalog; the Host will not add them automatically.`)
      const missingMaterials = (['writer', 'renderer', 'reviewer'] as const).filter(role => !frozen.materials.some(material => material.bytes > 0 && material.roles.includes(role)))
      if (missingMaterials.length > 0) throw new Error(`SKILL_CRAFT_MATERIAL_COVERAGE: the selected four-file report contract declares no nonempty mandatory material for ${missingMaterials.join(', ')}. Choose a compatible skill that supplies this role, or correct the owning pack declaration; the Host will not invent material or select skills automatically.`)
    }
    if (!isReportCraftBinding(bundle, frozen)) throw new Error('SKILL_CRAFT_CONTRACT_REQUIRED: v3 selections require the matching Host-resolved frozen skill contract')
    return { id: 'selected-skill-craft-v1', ...artifacts, craftEvidence: `published:${bundle.craft.evidence}`, selection: structuredClone(frozen!) }
  }
  if (bundle.craft?.version === 2) return { id: 'zhijian-report-craft-core-v2', ...artifacts,
    craftEvidence: `published:${bundle.craft.evidence}`, materialPackId: REPORT_CRAFT_PACK_ID,
    materialDigest: REPORT_CRAFT_MATERIAL_DIGEST, style: bundle.craft.style }
  return { id: 'zhijian-report-craft-core-v1', ...artifacts }
}

/** Admission re-resolves enabled source identities; cold parsing alone must not
 * silently replace a staged selection with a newer or disabled package. */
export async function requireCurrentSkillCraftSelection(ctx: Context, config: ToolsConfig, workspace: string,
  bundle: ReportBundle | undefined, frozen: FrozenSkillCraftContract | undefined): Promise<void> {
  if (bundle?.craft?.version === 3) reportArtifactCheck(bundle, frozen)
  if (!isReportCraftBinding(bundle, frozen)) throw new Error('SKILL_CRAFT_CONTRACT_MISMATCH: selected skills require their exact Host-frozen contract')
  if (bundle?.craft?.version !== 3) return
  const current = await resolveSelectedSkillContract(ctx, config, workspace, bundle.craft.selections)
  if (current.digest !== frozen!.digest) throw new Error('SKILL_CRAFT_CONTRACT_CHANGED: enabled pack/skill content or selection changed; edit and review the plan before approval, or create a separately reviewed task. Frozen selections cannot silently upgrade.')
  verifyFrozenSkillCraftContract(frozen!)
}

export function reportCheckDeliverables(check: ArtifactCheckSpec): string[] {
  return [check.md, check.html, check.pdf, ...(check.id === 'zhijian-report-craft-core-v1' ? [] : [check.craftEvidence])]
}

export function reportBundleFromChecks(checks: readonly ArtifactCheckSpec[] | undefined): ReportBundle | undefined {
  const check = checks?.find(item => ['zhijian-report-craft-core-v1', 'zhijian-report-craft-core-v2', 'selected-skill-craft-v1'].includes(item.id))
  if (check === undefined) return undefined
  if (!reportCheckDeliverables(check).every(id => id.startsWith('published:'))) throw new Error('REPORT_BUNDLE_INVALID: report revisions require published artifact bindings')
  if (check.id === 'zhijian-report-craft-core-v2' && (check.materialPackId !== REPORT_CRAFT_PACK_ID || check.materialDigest !== REPORT_CRAFT_MATERIAL_DIGEST)) throw new Error('REPORT_MATERIAL_VERSION_CHANGED: revisions cannot silently upgrade the frozen material pack')
  const bundle: ReportBundle = { md: check.md.slice(10), html: check.html.slice(10), pdf: check.pdf.slice(10),
    ...(check.id === 'zhijian-report-craft-core-v2' ? { craft: { version: 2 as const, style: check.style, evidence: check.craftEvidence.slice(10) } }
      : check.id === 'selected-skill-craft-v1' ? { craft: { version: 3 as const, selections: selectedCraftRequests(check.selection), evidence: check.craftEvidence.slice(10) } } : {}) }
  if (!isReportBundle(bundle)) throw new Error('REPORT_BUNDLE_INVALID: stored report publication names are invalid')
  return bundle
}

export const REPORT_BUNDLE_GUIDANCE = 'For a new report workflow, inspect enabled domain-pack skill choices and explicitly select one skill or a compatible combination. Declare reportBundle with exact MD/HTML/PDF publication names and craft:{version:3,selections:[{packId,skillId,variant?,reason}],evidence:"craft-evidence.json"}. The selected combination must explicitly cover md, html, pdf and evidence output roles. Select applicable skills yourself; do not invent pack/skill IDs or depend on a hidden default. The Host freezes the selected domain-owned materials and check policies, supplies complete required role materials, and checks current immutable bytes. Publish the internal evidence ledger as well as the requested formats. An independent reviewer must first call quality_review with prepare_only:true, inspect its materials/current files/checks, then submit material_receipt and every selected review area with located evidence. Old v1/v2 contracts retain their original interpretation. Omit reportBundle for non-report tasks. Declared check coverage and located independent observations do not prove every business fact or aesthetic judgment.'
