/** One bounded model call proposes registered research choices for Host review. */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { DEEP_RESEARCH_MATERIAL_CHOICES, DEEP_RESEARCH_SUBDAGS, parseDeepResearchSelection, type DeepResearchMaterialRecipe } from './deep-research-selection.ts'
import type { PlanModelRoute } from './plan-review.ts'
import type { PlanWire } from './team-wire.ts'

export interface ResearchModelOption extends PlanModelRoute { readonly name: string }
export interface ResearchRecommendation {
  readonly subDagId: string
  readonly expertIds: readonly string[]
  readonly materials: readonly { readonly taskId: string; readonly recipeId: DeepResearchMaterialRecipe }[]
  readonly memberModel: PlanModelRoute
  readonly reason: string
  readonly modelCallTokens?: { readonly input: number; readonly output: number }
}

function fail(code: string): never { throw new Error(`RESEARCH_RECOMMENDATION_${code}`) }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

export function parseResearchRecommendation(text: string, plan: PlanWire, models: readonly ResearchModelOption[]): ResearchRecommendation {
  if (text.length > 12_000) fail('OUTPUT_TOO_LARGE')
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  let raw: unknown
  try { raw = JSON.parse(trimmed) } catch { fail('INVALID_JSON') }
  if (!record(raw) || Object.keys(raw).some(key => !['subDagId', 'expertIds', 'materialRecipes', 'modelChoice', 'reason'].includes(key))) fail('INVALID_FIELDS')
  const selected = parseDeepResearchSelection({ subDagId: raw.subDagId, expertIds: raw.expertIds })
  const candidates = new Set(plan.preview.expertSelection?.candidates.map(item => item.id) ?? [])
  if (selected.expertIds.some(id => !candidates.has(id))) fail('EXPERT_NOT_ROUTED')
  if (!record(raw.materialRecipes) || Object.keys(raw.materialRecipes).length !== DEEP_RESEARCH_MATERIAL_CHOICES.length) fail('MATERIALS_INCOMPLETE')
  const recipes = raw.materialRecipes as Record<string, unknown>
  const materials = DEEP_RESEARCH_MATERIAL_CHOICES.map(taskId => {
    const recipeId = recipes[taskId]
    if (recipeId !== 'core' && recipeId !== 'strategy') fail('MATERIAL_INVALID')
    return { taskId, recipeId: recipeId as DeepResearchMaterialRecipe }
  })
  if (typeof raw.modelChoice !== 'string' || !/^m\d{1,3}$/u.test(raw.modelChoice)) fail('MODEL_INVALID')
  const model = models[Number(raw.modelChoice.slice(1))]
  if (model === undefined) fail('MODEL_UNAVAILABLE')
  if (typeof raw.reason !== 'string' || raw.reason.trim().length < 12 || raw.reason.length > 1200) fail('REASON_INVALID')
  return { ...selected, materials, memberModel: { provider: model.provider, model: model.model,
    ...(model.reasoningEffort === undefined || model.reasoningEffort === 'default' ? {} : { reasoningEffort: model.reasoningEffort }) }, reason: raw.reason.trim() }
}

/** Keep the captain on the current authenticated session model. Members can
 * share one recommended registered route; the final compiler still resolves
 * and freezes every member separately before the user confirms the plan. */
export async function recommendResearchChoices(ctx: Context, plan: PlanWire,
  models: readonly ResearchModelOption[]): Promise<ResearchRecommendation> {
  const selection = plan.preview.expertSelection
  const captainModel = plan.preview.captainModel
  if (plan.status !== 'staged' || selection === undefined || captainModel === undefined || plan.preview.subDags === undefined) fail('PLAN_UNAVAILABLE')
  if (models.length === 0 || models.length > 200) fail('MODEL_CATALOG_UNAVAILABLE')
  const catalog = models.map((model, index) => ({ id: `m${index}`, provider: model.provider, model: model.model,
    name: model.name, reasoningEffort: model.reasoningEffort ?? 'default' }))
  const prompt = JSON.stringify({ instructions: 'STAGE4_RECOMMEND: Return one JSON object only. Select only listed IDs. Keys: subDagId, expertIds, materialRecipes (all four task IDs, core or strategy), modelChoice (m index), reason (Chinese, explain fit and limits). No markdown, no tools, no invented data.',
    question: selection.question, topic: selection.topic,
    analysisFramework: plan.preview.analysisFramework,
    candidates: selection.candidates.map(item => ({ id: item.id, field: item.field, stance: item.stance, summary: item.summary })),
    subDags: DEEP_RESEARCH_SUBDAGS.filter(item => item.expertCount <= selection.candidates.length),
    materialChoices: DEEP_RESEARCH_MATERIAL_CHOICES.map(taskId => ({ taskId, choices: ['core', 'strategy'] })), models: catalog })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('recommendation timeout')), 30_000)
  let output = ''
  let completed = false
  let usage: { input: number; output: number } | undefined
  try {
    for await (const chunk of ctx.llm.stream({ provider: captainModel.provider, model: captainModel.model,
      ...(captainModel.reasoningEffort === undefined || captainModel.reasoningEffort === 'default' ? {} : { reasoningEffort: captainModel.reasoningEffort as ReasoningEffortId }),
      signal: controller.signal,
      maxTokens: 900, temperature: 0,
      messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })] })) {
      if (chunk.type === 'text-delta') { output += chunk.text; if (output.length > 12_000) fail('OUTPUT_TOO_LARGE') }
      if (chunk.type === 'usage') usage = { input: chunk.usage.inputTokens, output: chunk.usage.outputTokens }
      if (chunk.type === 'finish') {
        if (chunk.reason.kind !== 'stop') {
          const failureCode = chunk.reason.kind === 'error' ? chunk.reason.failure.code : chunk.reason.kind
          throw new Error(`RESEARCH_RECOMMENDATION_MODEL_CALL_FAILED:${failureCode}`)
        }
        completed = true
      }
    }
  } finally { clearTimeout(timer) }
  if (!completed) fail('MODEL_CALL_INCOMPLETE')
  const recommendation = parseResearchRecommendation(output, plan, models)
  return { ...recommendation, ...(usage === undefined ? {} : { modelCallTokens: usage }) }
}
