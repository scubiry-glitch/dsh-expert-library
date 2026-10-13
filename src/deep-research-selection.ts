/** Registered, bounded graph variants for the 98wiki research profile. */
import type { ExpertTeamProfile, ProfileSeedTask } from './profiles.ts'
import { parseProfile } from './profiles.ts'
import { validateDeepResearchPlan } from './deep-research-plan.ts'
import { TASK_MATERIAL_PACK } from './task-material-binding.ts'
import { zhijianMetaById } from './zhijian/registry.ts'

export const DEEP_RESEARCH_SUBDAGS = [2, 3, 4, 5].map(count => ({
  id: `research-${count}`,
  version: '1',
  expertCount: count,
  description: `${count} 位问题路由专家并行简报与证据视角，之后进入选纲、正文、图文和终检门`,
})) as readonly { id: string; version: string; expertCount: number; description: string }[]

export interface DeepResearchSelection {
  readonly subDagId: string
  readonly expertIds: readonly string[]
}

export const DEEP_RESEARCH_MATERIAL_CHOICES = ['research_main', 'research_counter', 'evidence_merge', 'writer'] as const
export type DeepResearchMaterialTask = typeof DEEP_RESEARCH_MATERIAL_CHOICES[number]
export type DeepResearchMaterialRecipe = 'core' | 'strategy'

export function selectDeepResearchMaterials(input: ExpertTeamProfile, value: unknown): ExpertTeamProfile {
  if (input.id !== '98wiki-deep-research' || !/^3\./u.test(input.version) || input.taskPlanning !== 'seed' || !Array.isArray(value)
    || value.length < 1 || value.length > DEEP_RESEARCH_MATERIAL_CHOICES.length) fail('material edits require a staged v3 research profile')
  const seen = new Set<string>()
  const choices = new Map<string, DeepResearchMaterialRecipe>()
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) fail('invalid material choice')
    const row = item as Record<string, unknown>
    if (Object.keys(row).some(key => !['taskId', 'recipeId'].includes(key))
      || !DEEP_RESEARCH_MATERIAL_CHOICES.includes(row.taskId as DeepResearchMaterialTask)
      || row.recipeId !== 'core' && row.recipeId !== 'strategy' || seen.has(row.taskId as string)) fail('unknown or duplicate material choice')
    seen.add(row.taskId as string)
    choices.set(row.taskId as string, row.recipeId as DeepResearchMaterialRecipe)
  }
  const tasks = input.tasks!.map(task => {
    const recipe = choices.get(task.id)
    if (recipe === undefined) return task
    if (task.skillBindings === undefined || task.promptBinding === undefined) fail(`${task.id} lacks a frozen material recipe`)
    const base = task.skillBindings.filter(skill => !(skill.packId === TASK_MATERIAL_PACK && skill.skillId === 'strategy-consulting'))
    if (base.length !== 2) fail(`${task.id} has an unexpected base recipe`)
    return { ...task, skillBindings: recipe === 'core' ? base : [...base, {
      packId: TASK_MATERIAL_PACK, skillId: 'strategy-consulting', materialRole: 'producer' as const, required: true as const,
      reason: '本题需要把证据与反方条件转成可证伪的决策判断',
    }] }
  })
  const result = parseProfile({ ...input, tasks })
  validateDeepResearchPlan(result)
  return result
}

function fail(message: string): never { throw new Error(`DEEP_RESEARCH_SELECTION_INVALID: ${message}`) }

export function parseDeepResearchSelection(value: unknown): DeepResearchSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('expected registered sub-DAG and expert IDs')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['subDagId', 'expertIds'].includes(key)) || typeof row.subDagId !== 'string'
    || !Array.isArray(row.expertIds) || row.expertIds.some(id => typeof id !== 'string')) fail('invalid selection fields')
  const graph = DEEP_RESEARCH_SUBDAGS.find(item => item.id === row.subDagId)
  if (graph === undefined || row.expertIds.length !== graph.expertCount
    || new Set(row.expertIds).size !== row.expertIds.length) fail('expert count must match one registered graph')
  return { subDagId: graph.id, expertIds: [...row.expertIds] as string[] }
}

/** Rebuild the changing fan-out on the Host; callers never supply task JSON. */
export function selectDeepResearchSubDag(input: ExpertTeamProfile, choice: DeepResearchSelection): ExpertTeamProfile {
  const selection = parseDeepResearchSelection(choice)
  if (input.id !== '98wiki-deep-research' || !/^3\./u.test(input.version) || input.taskPlanning !== 'seed'
    || input.expertSelection === undefined || input.tasks === undefined) fail('only a staged v3 research profile can be reconfigured')
  const route = input.expertSelection
  if (selection.expertIds.some(id => !route.candidateIds.includes(id) || zhijianMetaById(id) === undefined || id === 'bk-022'))
    fail('expert must belong to the current question route and be eligible for live research')
  const oldResearch = input.members.filter(member => /^bk-\d{3}$/u.test(member.expert ?? ''))
  if (oldResearch.length < 2) fail('source profile needs two existing research slots')
  const byId = new Map(input.tasks.map(task => [task.id, task]))
  const requireTask = (id: string): ProfileSeedTask => byId.get(id) ?? fail(`missing source template ${id}`)
  const lead = oldResearch[0]!, counter = oldResearch[1]!
  const members = selection.expertIds.map((expert, index) => {
    const meta = zhijianMetaById(expert)!
    const source = oldResearch.find(member => member.expert === expert) ?? (index === 0 ? lead : index === 1 ? counter : oldResearch[2] ?? counter)
    return { ...source, id: `research_${index + 1}`, name: meta.personaName,
      role: index === 0 ? '大纲主责、主证据与正文' : index === 1 ? '反方证据与独立内容审阅' : `独立证据视角 ${index + 1}`,
      expert }
  })
  const keepMembers = input.members.filter(member => !oldResearch.includes(member))
  const briefs = members.map((member, index) => {
    const id = `expert_brief_${member.id}`
    return { ...requireTask(index === 0 ? `expert_brief_${lead.id}` : `expert_brief_${counter.id}`), id,
      owner: member.id, subject: `${member.name}·独立选纲视角`,
      description: '按本题分析框架独立提出机制、章节主线、待核证据、最强反方和可证伪条件；只做一页内简报，不开展完整取数、不造数字。',
      dependsOn: [], produces: [`${id}.md`], artifactInputs: [] } satisfies ProfileSeedTask
  })
  const views = members.slice(2).map(member => {
    const id = `research_view_${member.id}`
    const priorView = oldResearch[2] === undefined ? undefined : byId.get(`research_view_${oldResearch[2].id}`)
    const main = requireTask('research_main')
    const template = priorView ?? { ...main,
      promptBinding: { ...main.promptBinding!, templateId: '98wiki-research-view-v1' },
      skillBindings: main.skillBindings!.filter(skill => !(skill.packId === TASK_MATERIAL_PACK && skill.skillId === 'strategy-consulting')),
      acceptance: ['独立证据视角可回溯来源、时点、单位与口径。'] }
    return { ...template, id, owner: member.id, subject: `${member.name}·独立证据核查`,
      description: '按本题问题和选定大纲独立核查一个有别于主证据、反方证据的视角；数值标明来源、统计期、单位和口径。',
      produces: [`${id}.md`] } satisfies ProfileSeedTask
  })
  const briefInput = briefs.map(task => ({ fromTask: task.id, artifact: `${task.id}.md`, phase: 'work' as const, purpose: '已审专家独立选纲视角' }))
  const viewInput = views.map(task => ({ fromTask: task.id, artifact: `${task.id}.md`, phase: 'work' as const, purpose: '独立证据与来源限制' }))
  const changing = new Set(input.tasks.filter(task => task.id.startsWith('expert_brief_') || task.id.startsWith('research_view_')).map(task => task.id))
  const tasks = [...briefs, ...input.tasks.filter(task => !changing.has(task.id)).map(task => {
    const owner = task.owner === lead.id ? members[0]!.id : task.owner === counter.id ? members[1]!.id : task.owner
    if (task.id === 'outline_candidates') return { ...task, owner, dependsOn: briefs.map(item => item.id), artifactInputs: briefInput,
      description: '汇合所有已审独立简报与获确认分析框架，提出结构明显不同的 A/B/C 三版大纲。每版说明章节、素材锚点、图表位、页数、采用理由和来源；列出所有固定材料的 ID 与当前 SHA256，不补造数字。' }
    if (task.id === 'evidence_merge') return { ...task, owner, dependsOn: ['research_main', 'research_counter', ...views.map(item => item.id)],
      artifactInputs: [...(task.artifactInputs ?? []).filter(item => !item.fromTask.startsWith('research_view_')), ...viewInput] }
    return { ...task, ...(owner === undefined ? {} : { owner }) }
  }), ...views]
  const result = parseProfile({ ...input, members: [...members, ...keepMembers], tasks,
    expertSelection: { ...route, selectedIds: [...selection.expertIds] } })
  validateDeepResearchPlan(result)
  return result
}
