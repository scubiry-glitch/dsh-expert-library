/** Declared artifact prerequisites participate in planning, including acceptance. */
import type { ExecutionPlan } from './v2/compiler.ts'
export interface PlannedArtifactInput { readonly fromTask: string; readonly artifact: string; readonly purpose: string; readonly phase: 'work' | 'acceptance' }
interface FlowTask { readonly id: string; readonly dependsOn: readonly string[]; readonly produces?: readonly string[]; readonly artifactInputs?: readonly PlannedArtifactInput[]; readonly reportBundle?: { readonly md: string; readonly html: string; readonly pdf: string; readonly craft?: { readonly evidence: string } } }
export function parseArtifactInputs(value: unknown): PlannedArtifactInput[] {
  if (!Array.isArray(value) || value.length > 80) throw new Error('PLAN_ARTIFACT_INPUTS_INVALID: expected at most 80 inputs')
  return value.map(v => {
    if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.keys(v).some(k => !['fromTask','artifact','purpose','phase'].includes(k))
      || ['fromTask','artifact','purpose'].some(k => typeof v[k] !== 'string' || !v[k].trim() || v[k].length > 2000)
      || !['work','acceptance'].includes(v.phase)) throw new Error('PLAN_ARTIFACT_INPUTS_INVALID: each input needs fromTask, artifact, purpose and phase=work|acceptance')
    return { fromTask: v.fromTask.trim(), artifact: v.artifact.trim(), purpose: v.purpose.trim(), phase: v.phase }
  })
}
export function validatePlanArtifactFlow(tasks: readonly FlowTask[]): void {
  const byId = new Map(tasks.map(t => [t.id,t]))
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string, trail: string[]) => {
    if (visiting.has(id)) throw new Error(`PLAN_ARTIFACT_CYCLE: ${[...trail,id].join(' -> ')}; a required artifact cannot be produced only after its consumer completes`)
    if (visited.has(id)) return
    const task = byId.get(id)
    if (task === undefined) throw new Error(`PLAN_ARTIFACT_SOURCE_UNKNOWN: ${id}`)
    visiting.add(id)
    for (const upstream of new Set([...task.dependsOn, ...(task.artifactInputs ?? []).map(i => i.fromTask)])) visit(upstream,[...trail,id])
    visiting.delete(id);visited.add(id)
  }
  for (const task of tasks) visit(task.id,[])
  for (const task of tasks) {
    if (task.artifactInputs === undefined) continue // Legacy DAGs retain their declared ordering.
    for (const input of task.artifactInputs) {
      const source = byId.get(input.fromTask)!
      const bundle = source.reportBundle
      const outputs = ['task-output', ...(source.produces ?? []), ...(bundle === undefined ? [] : [bundle.md,bundle.html,bundle.pdf,...(bundle.craft === undefined ? [] : [bundle.craft.evidence])])]
      if (!outputs.includes(input.artifact)) throw new Error(`PLAN_ARTIFACT_OUTPUT_UNDECLARED: ${task.id} needs ${input.fromTask}/${input.artifact}`)
      if (!task.dependsOn.includes(input.fromTask)) throw new Error(`PLAN_ARTIFACT_DEPENDENCY_MISSING: ${task.id} must depend on ${input.fromTask} for ${input.phase} input ${input.artifact}`)
    }
    for (const dependency of task.dependsOn) if (!task.artifactInputs.some(input => input.fromTask === dependency)) throw new Error(`PLAN_DEPENDENCY_UNJUSTIFIED: ${task.id} -> ${dependency}; declare its required input and purpose or remove this ordering`)
  }
}

/** Fixed report presets explicitly exchange complete reviewed stage documents.
 * Custom profiles must declare their own flow; this is never inferred from prose. */
export function presetReportArtifactFlow(plan: ExecutionPlan): ExecutionPlan {
  const tasks = plan.tasks.map(task => ({ ...task,
    produces: task.reportBundle === undefined ? [`${task.id}-evidence.md`] : [],
    artifactInputs: task.dependsOn.map(fromTask => ({ fromTask, artifact: `${fromTask}-evidence.md`,
      purpose: `Use the complete reviewed stage document from ${fromTask}, including facts, source details and conclusions.`, phase: 'work' as const })),
  }))
  validatePlanArtifactFlow(tasks)
  return { ...plan, tasks }
}
