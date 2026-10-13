/** Resolve model settings once, before the research plan's approval digest. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveLibrary } from './expert-library/registry.ts'
import { activatedExpert } from './active-experts.ts'
import { memberRouteRequest, resolveMemberLlmSelection } from './members.ts'
import type { ToolsConfig } from './team-core.ts'
import { workspaceOf } from './team-core.ts'
import type { ExecutionPlan, CompiledMember } from './v2/compiler.ts'
import { canonicalDigest } from './v2/digest.ts'
import { sessionOwnEvents } from './harness-compat.ts'
import type { PlanModelRoute } from './plan-review.ts'

/** Native selectors record a next-request selection before any new request.
 * Read only the captain's own durable events, never assistant/tool text. */
function pendingCaptainModel(captain: Agent): PlanModelRoute | undefined {
  let pending: PlanModelRoute | undefined
  for (const item of sessionOwnEvents(captain.session)) {
    const event = item as { type?: string; data?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown; header?: { config?: PlanModelRoute } } }
    if (event.type === 'model/selection' && typeof event.data?.provider === 'string' && typeof event.data.model === 'string') {
      pending = { provider: event.data.provider, model: event.data.model,
        ...(typeof event.data.reasoningEffort === 'string' ? { reasoningEffort: event.data.reasoningEffort } : {}) }
    } else if (event.type === 'request/header' && pending !== undefined) {
      const used = event.data?.header?.config
      if (used?.provider === pending.provider && used.model === pending.model && (used.reasoningEffort ?? 'default') === (pending.reasoningEffort ?? 'default')) pending = undefined
    }
  }
  return pending
}

export async function freezePlanModelRoutes(ctx: Context, config: ToolsConfig, captain: Agent, plan: ExecutionPlan): Promise<ExecutionPlan> {
  const library = await resolveLibrary(ctx, workspaceOf(captain), config.knowledgeDir)
  const roster: CompiledMember[] = []
  for (const member of plan.roster) {
    const expertId = member.sourceExpertId ?? (member.profileId === undefined ? member.expertId : undefined)
    const explicit = member.modelRouteSource === 'profile-member' || member.modelRouteSource === 'profile-default'
    const override = expertId === undefined ? undefined : config.expertModelOverrides?.[expertId]
    const preset = member.profileId === undefined ? member.modelPolicy : expertId === undefined || explicit ? undefined
      : (config.getPackCenterSnapshot === undefined && library.experts.has(expertId) ? undefined : (await activatedExpert(ctx, config, expertId))?.model)
        ?? library.experts.get(expertId)?.model
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

/** Per-plan choices never write global defaults, and never select a fallback. */
export async function applyPlanReview(ctx: Context, captain: Agent, input: ExecutionPlan,
  outlineInput?: unknown, modelsInput?: unknown): Promise<ExecutionPlan> {
  const { parseReportOutline, parsePlanModels } = await import('./plan-review.ts')
  const choices = modelsInput === undefined ? {} : parsePlanModels(modelsInput, ['captain', ...input.roster.map(m => m.expertId)])
  const roster: CompiledMember[] = []
  for (const member of input.roster) {
    const choice = choices[member.expertId]
    if (choice === undefined) { roster.push(member); continue }
    const selection = await resolveMemberLlmSelection(ctx, captain, choice)
    const { modelRouteFallbackIndex: _fallback, ...rest } = member
    roster.push({ ...rest, modelPolicy: { ...selection, reasoningEffort: selection.reasoningEffort ?? 'default' }, modelRouteSource: 'plan-edit', modelRouteFrozen: true })
  }
  const selectedCaptain = choices.captain ?? input.captainModel ?? await resolveMemberLlmSelection(ctx, captain, {})
  const resolvedCaptain = await resolveMemberLlmSelection(ctx, captain, selectedCaptain)
  const captainModel = { ...resolvedCaptain, reasoningEffort: resolvedCaptain.reasoningEffort ?? 'default' }
  const reportOutline = outlineInput === undefined ? input.reportOutline : parseReportOutline(outlineInput, input)
  const draft = { ...input, roster, captainModel, ...(reportOutline === undefined ? {} : { reportOutline }) }
  const digest = canonicalDigest({ compilerDigest: input.digest, roster, captainModel, reportOutline })
  return { ...draft, digest, planId: `ep-${digest.slice(0, 16)}` }
}

/** Switching the current turn under its tools is unsafe. A changed captain
 * route must be applied through the native session selector before approval. */
export async function validateCaptainPlanModel(ctx: Context, captain: Agent, plan: ExecutionPlan, signal?: AbortSignal): Promise<void> {
  if (plan.captainModel === undefined) return
  const live = await resolveMemberLlmSelection(ctx, captain, pendingCaptainModel(captain) ?? {}, signal)
  if (live.provider !== plan.captainModel.provider || live.model !== plan.captainModel.model
    || (live.reasoningEffort ?? 'default') !== (plan.captainModel.reasoningEffort ?? 'default')) {
    throw new Error(`PLAN_CAPTAIN_MODEL_SWITCH_REQUIRED: use the native session model selector to set ${plan.captainModel.provider}/${plan.captainModel.model} (${plan.captainModel.reasoningEffort ?? 'default'}), then confirm this plan. No team was started and global defaults were not changed.`)
  }
}
