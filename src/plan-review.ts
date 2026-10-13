import { canonicalDigest } from './v2/digest.ts'
/** Structured report intent is frozen with the executable plan, not UI-only text. */
import type { ExecutionPlan } from './v2/compiler.ts'

export interface ReportOutline {
  readonly chapters: readonly {
    readonly id: string
    readonly title: string
    readonly questions: readonly string[]
    readonly evidence: readonly string[]
    readonly taskIds: readonly string[]
  }[]
  readonly attachments: readonly string[]
}
export interface PlanModelRoute { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
function strings(v: unknown, label: string, min = 1): string[] {
  if (!Array.isArray(v) || v.length < min || v.length > 40 || v.some(s => typeof s !== 'string' || !s.trim() || s.length > 2000)) throw new Error(`PLAN_REVIEW_INVALID: ${label} must contain ${min}..40 nonempty strings`)
  return v.map(s => s.trim()) as string[]
}
export function parseReportOutline(value: unknown, plan: Pick<ExecutionPlan, 'tasks'>): ReportOutline {
  if (!object(value) || Object.keys(value).some(k => !['chapters', 'attachments'].includes(k)) || !Array.isArray(value.chapters) || !value.chapters.length || value.chapters.length > 40) throw new Error('PLAN_OUTLINE_INVALID: provide 1..40 chapters and attachments')
  const ids = new Set<string>(), taskIds = new Set(plan.tasks.map(t => t.id))
  const chapters = value.chapters.map((c, i) => {
    if (!object(c) || Object.keys(c).some(k => !['id', 'title', 'questions', 'evidence', 'taskIds'].includes(k)) || typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(c.id) || ids.has(c.id)
      || typeof c.title !== 'string' || !c.title.trim() || c.title.length > 200) throw new Error(`PLAN_OUTLINE_INVALID: chapter ${i + 1} needs a unique id and title`)
    ids.add(c.id)
    const tasks = strings(c.taskIds, `${c.id}.taskIds`)
    if (new Set(tasks).size !== tasks.length || tasks.some(id => !taskIds.has(id))) throw new Error(`PLAN_OUTLINE_UNKNOWN_TASK: ${c.id}`)
    return { id: c.id, title: c.title.trim(), questions: strings(c.questions, `${c.id}.questions`), evidence: strings(c.evidence, `${c.id}.evidence`), taskIds: tasks }
  })
  return { chapters, attachments: strings(value.attachments, 'attachments', 0) }
}
export function parsePlanModels(value: unknown, ids: readonly string[]): Record<string, PlanModelRoute> {
  if (!object(value) || Object.keys(value).length > 100) throw new Error('PLAN_MODELS_INVALID: expected routes keyed by role id')
  const routes: Record<string, PlanModelRoute> = {}
  for (const [id, route] of Object.entries(value)) {
    if (!ids.includes(id) || !object(route) || Object.keys(route).some(k => !['provider', 'model', 'reasoningEffort'].includes(k))
      || typeof route.provider !== 'string' || !route.provider.trim() || route.provider.length > 200
      || typeof route.model !== 'string' || !route.model.trim() || route.model.length > 200
      || route.reasoningEffort !== undefined && (typeof route.reasoningEffort !== 'string' || !route.reasoningEffort.trim() || route.reasoningEffort.length > 100)) throw new Error(`PLAN_MODELS_INVALID: ${id}`)
    routes[id] = { provider: route.provider.trim(), model: route.model.trim(), ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort as string }) }
  }
  return routes
}
function hasReviewedOutlineBeforeReport(plan: ExecutionPlan): boolean {
  const tasks = new Map(plan.tasks.map(task => [task.id, task]))
  const gates = plan.tasks.filter(task => {
    const choice = task.humanChoice
    if (choice === undefined || choice.artifact.toLowerCase() !== 'outline.md') return false
    const source = tasks.get(choice.sourceTaskId)
    return source?.produces?.includes(choice.artifact) === true && task.dependsOn.includes(source.id)
  })
  const dependsOn = (taskId: string, ancestorId: string, visited = new Set<string>()): boolean => {
    if (visited.has(taskId)) return false
    visited.add(taskId)
    return tasks.get(taskId)?.dependsOn.some(id => id === ancestorId || dependsOn(id, ancestorId, visited)) === true
  }
  return gates.length > 0 && plan.tasks.filter(task => task.reportBundle !== undefined)
    .every(task => gates.some(gate => dependsOn(task.id, gate.id)))
}
function promisedChapterCount(plan: ExecutionPlan): number | undefined {
  const chinese = '一二三四五六七八九十'
  for (const task of plan.tasks.filter(candidate => candidate.reportBundle !== undefined)) {
    const text = `${task.subject} ${task.description ?? ''}`
    const match = /(?<![第\d一二三四五六七八九十])(\d{1,2}|[一二三四五六七八九十]{1,3})章(?:大纲|目录|结构|框架)/u.exec(text)
    if (!match) continue
    const numeral = match[1]!
    if (/^\d+$/u.test(numeral)) return Number(numeral)
    if (numeral === '十') return 10
    const parts = numeral.split('十')
    const tens = parts.length > 1 ? (parts[0] ? chinese.indexOf(parts[0]) + 1 : 1) * 10 : 0
    const ones = parts.length > 1 ? (parts[1] ? chinese.indexOf(parts[1]) + 1 : 0) : chinese.indexOf(numeral) + 1
    const count = tens + ones
    if (count >= 1 && count <= 40) return count
  }
  return undefined
}
/** A report plan must reach the user with its proposed chapters already attached. */
export function requireStagedReportOutline(plan: ExecutionPlan): void {
  if (plan.template.version === '5.0.0' && plan.scenario?.id === '98wiki-deep-research') return // Viewpoint choice precedes the evidence-led outline.
  if (plan.tasks.some(t => t.reportBundle !== undefined)) {
    const deferred = hasReviewedOutlineBeforeReport(plan)
    if (plan.reportOutline === undefined && !deferred) throw new Error('PLAN_OUTLINE_REQUIRED: generate the complete structured report_outline in the plan_preview/plan_stage call, with every promised chapter, its questions, evidence and report-producing taskIds. Do not leave chapter creation to the user. An upstream outline.md human review gate is allowed when the outline is intentionally produced during execution.')
    if (plan.reportOutline !== undefined) {
      const outline = parseReportOutline(plan.reportOutline, plan)
      const promised = deferred ? undefined : promisedChapterCount(plan)
      if (promised !== undefined && outline.chapters.length !== promised) throw new Error(`PLAN_OUTLINE_INVALID: report task promises ${promised} chapters but report_outline contains ${outline.chapters.length}; generate every chapter before staging`)
      const unmapped = plan.tasks.filter(t => t.reportBundle !== undefined
        && !outline.chapters.some(c => c.taskIds.includes(t.id))).map(t => t.id)
      if (unmapped.length) throw new Error(`PLAN_OUTLINE_UNMAPPED_PRODUCER: ${unmapped.join(', ')}. These report-producing tasks are missing from report_outline.chapters[].taskIds. Call expert_teams_plan_edit with the current plan_id, expected_digest and expected_revision and a corrected report_outline; include each producer in its relevant chapter taskIds, preserving the other chapters and attachments. Resending unchanged tasks or reportBundle does not repair the outline. Then approve the returned digest/revision.`)
    }
  }
}
export function requireReportOutline(plan: ExecutionPlan): void {
  requireStagedReportOutline(plan)
  if (plan.template.version === '5.0.0' && plan.scenario?.id === '98wiki-deep-research') return
  if (plan.tasks.some(t => t.reportBundle !== undefined)) {
    for (const task of plan.tasks) if (task.artifactInputs === undefined) throw new Error(`PLAN_ARTIFACT_INPUTS_REQUIRED: ${task.id} must declare artifactInputs (use [] for independent work), including artifacts needed for acceptance. Declare upstream produces and the purpose of each dependency before confirmation.`)
  }
}
export function outlineTaskGuidance(plan: ExecutionPlan, taskId: string): string {
  const chapters = plan.reportOutline?.chapters.filter(c => c.taskIds.includes(taskId)) ?? []
  const task = plan.tasks.find(t => t.id === taskId)
  const flow = task?.artifactInputs === undefined && task?.produces === undefined ? '' : '\n\nApproved artifact flow: ' + JSON.stringify({ requiredInputs: task?.artifactInputs ?? [], requiredPublications: task?.produces ?? [] })
  if (plan.template.version === '5.0.0' && plan.scenario?.id === '98wiki-deep-research') return flow + '\nV5: follow the selected viewpoint; reorganize the outline as evidence develops. Record refuted claims and uncertainty. No fixed chapter shell.'
  if (plan.tasks.some(candidate => candidate.humanChoice !== undefined)) {
    return flow + (chapters.length ? '\n\nThe plan report_outline is provisional. Follow the user-selected, reviewed OUTLINE.md artifact for final chapters and order.' : '')
  }
  if (!chapters.length) return flow
  return flow + '\n\nApproved report outline (preserve order, address all questions and evidence requirements):\n'
    + JSON.stringify({ chapters, attachments: plan.reportOutline!.attachments })
}

/** The compiler id may be replaced by its staged id; all executable content is pinned. */
export function executionPlanDigest(plan: ExecutionPlan): string {
  const { planId: _id, ...content } = plan
  return canonicalDigest(content)
}
