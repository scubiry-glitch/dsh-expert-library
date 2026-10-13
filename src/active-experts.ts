/** Resolve planned members against the same activated inventory used by the V2 compiler. */
import type { Context } from '@deepseek-ai/cordis'
import type { ExecutionPlan } from './v2/compiler.ts'
import type { Expert } from './expert-library/types.ts'
import type { ExpertV2 } from './v2/types.ts'
import type { ToolsConfig } from './team-core.ts'
import { resolveLibrary } from './expert-library/registry.ts'
import { buildZhijianDomainPack } from './v2/zhijian-pack.ts'
import { resolveManagedRuntimePack } from './host/pack-runtime.ts'

/** Keep the pack's professional identity and methods when a V2 expert joins a V1 team. */
export function domainExpertForTeam(value: ExpertV2): Expert {
  return {
    id: value.id,
    name: value.display.internalName,
    role: value.display.publicLabel,
    background: JSON.stringify({ domains: value.domains, persona: value.persona,
      methods: value.methods, methodProfile: value.methodProfile,
      knowledgeBindings: value.knowledgeBindings, constraints: value.constraints,
      outputSchema: value.outputSchema, compliance: value.compliance }),
    principles: [...(value.persona.style ?? []), ...(value.persona.tone === undefined ? [] : [value.persona.tone])],
    deliverables: [],
    ...(value.modelPolicy === undefined ? {} : { model: { ...value.modelPolicy } }),
  }
}

export async function activatedExpert(ctx: Context, config: ToolsConfig, expertId: string): Promise<Expert | undefined> {
  const pack = (await resolveManagedRuntimePack(ctx, config, buildZhijianDomainPack())).pack
  const found = pack.experts.find(expert => expert.id === expertId && expert.legacySource === undefined)
  return found === undefined ? undefined : domainExpertForTeam(found)
}

/** Approval must find every declared expert before writing an approval receipt. */
export async function requirePlanExpertAvailability(ctx: Context, config: ToolsConfig, workspace: string, plan: ExecutionPlan): Promise<void> {
  const ids = [...new Set(plan.roster.map(member => member.sourceExpertId ?? (member.profileId === undefined ? member.expertId : undefined)).filter((id): id is string => id !== undefined))]
  if (ids.length === 0) return
  const library = await resolveLibrary(ctx, workspace, config.knowledgeDir)
  const unknown = ids.filter(id => !library.experts.has(id))
  if (unknown.length === 0) return
  const pack = (await resolveManagedRuntimePack(ctx, config, buildZhijianDomainPack())).pack
  const available = new Set(pack.experts.map(expert => expert.id))
  const missing = unknown.filter(id => !available.has(id))
  if (missing.length > 0) throw new Error(`PLAN_EXPERT_UNAVAILABLE: ${missing.join(', ')}. Activate the domain pack containing these experts before staging or approving the plan.`)
}
