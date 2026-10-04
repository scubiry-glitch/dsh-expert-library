/** Resolve model settings once, before the research plan's approval digest. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveLibrary } from './expert-library/registry.ts'
import { memberRouteRequest, resolveMemberLlmSelection } from './members.ts'
import type { ToolsConfig } from './team-core.ts'
import { workspaceOf } from './team-core.ts'
import type { ExecutionPlan, CompiledMember } from './v2/compiler.ts'
import { canonicalDigest } from './v2/digest.ts'

export async function freezePlanModelRoutes(ctx: Context, config: ToolsConfig, captain: Agent, plan: ExecutionPlan): Promise<ExecutionPlan> {
  const library = await resolveLibrary(ctx, workspaceOf(captain), config.knowledgeDir)
  const roster: CompiledMember[] = []
  for (const member of plan.roster) {
    const expertId = member.sourceExpertId ?? (member.profileId === undefined ? member.expertId : undefined)
    const explicit = member.modelRouteSource === 'profile-member' || member.modelRouteSource === 'profile-default'
    const override = expertId === undefined ? undefined : config.expertModelOverrides?.[expertId]
    const preset = member.profileId === undefined ? member.modelPolicy : expertId === undefined ? undefined : library.experts.get(expertId)?.model
    const source = explicit ? member.modelRouteSource! : override !== undefined ? 'expert-override'
      : preset !== undefined ? 'expert-preset' : config.memberModel !== undefined ? 'plugin-default' : 'captain'
    const requested = explicit ? member.modelPolicy : override ?? preset
    const selection = await resolveMemberLlmSelection(ctx, captain, {
      ...memberRouteRequest({}, requested, config.memberModel),
      ...(member.fallbackRoutes === undefined ? {} : { fallback: member.fallbackRoutes }),
    })
    const fallbackIndex = member.fallbackRoutes?.findIndex(route => route.provider === selection.provider && route.model === selection.model)
    roster.push({ ...member, modelPolicy: { ...selection, reasoningEffort: selection.reasoningEffort ?? 'default' },
      modelRouteSource: source, modelRouteFrozen: true,
      ...(fallbackIndex === undefined || fallbackIndex < 0 || (requested?.provider === selection.provider && requested?.model === selection.model)
        ? {} : { modelRouteFallbackIndex: fallbackIndex }),
    })
  }
  const digest = canonicalDigest({ compilerDigest: plan.digest, roster })
  return { ...plan, roster, digest, planId: `ep-${digest.slice(0, 16)}` }
}

/** Validate every frozen route before the first team/member write; never pick
 * another fallback or reread settings after the user approved the preview. */
export async function validateFrozenPlanModelRoutes(ctx: Context, captain: Agent, plan: ExecutionPlan, signal?: AbortSignal): Promise<void> {
  for (const member of plan.roster) {
    if (member.modelRouteFrozen !== true) continue
    const route = member.modelPolicy
    if (route === undefined) throw new Error(`PLAN_MODEL_UNAVAILABLE: ${member.expertId} has no frozen model`)
    try {
      const current = await resolveMemberLlmSelection(ctx, captain, route, signal)
      if (current.provider !== route.provider || current.model !== route.model
        || (current.reasoningEffort ?? 'default') !== (route.reasoningEffort ?? 'default')) throw new Error('resolved route differs from the approved snapshot')
    } catch (error) {
      throw new Error(`PLAN_MODEL_UNAVAILABLE: ${member.expertId} ${route.provider}/${route.model}: ${String(error)}. Edit/restage the plan; no team or member was created.`)
    }
  }
}
