import { validateViewpointResearchPlan } from './viewpoint-research-plan.ts'
import { validateCompactResearchPlan } from './compact-research-plan.ts'
/** Host-side structural admission for the 98wiki deep-research v2 profile. */
import type { ExpertTeamProfile, ProfileSeedTask } from './profiles.ts'
import { scenarioForTopic, topicRouteFor } from './zhijian/routing.ts'
import { isTaskMaterialSelection, TASK_MATERIAL_PACK, DOMAIN_MATERIAL_PACK } from './task-material-binding.ts'

function fail(message: string): never { throw new Error(`DEEP_RESEARCH_PLAN_INVALID: ${message}`) }

export function validateDeepResearchPlan(profile: ExpertTeamProfile): void {
  validateCompactResearchPlan(profile)
  validateViewpointResearchPlan(profile)
  if (profile.id !== '98wiki-deep-research' || !/^[23]\./u.test(profile.version)) return
  const v3 = /^3\./u.test(profile.version)
  const framework = profile.analysisFramework
  if (framework === undefined || framework.axes.length < 2 || framework.hypotheses.length < 2 || framework.falsifiers.length < 1)
    fail('select a structured analysisFramework before staging the team')
  if (profile.fallback?.length) fail('automatic model fallback is disabled for this cost-bounded profile')
  const selected = profile.members.filter(member => /^bk-\d{3}$/u.test(member.expert ?? ''))
  if (selected.length < 2 || selected.length > 5 || new Set(selected.map(member => member.expert)).size !== selected.length)
    fail('bind 2..5 distinct question-routed real-estate expert IDs in profile.members[].expert')
  const routeReceipt = profile.expertSelection
  const route = routeReceipt === undefined ? undefined : topicRouteFor(routeReceipt.topic, routeReceipt.question)
  const scenario = route === undefined ? undefined : scenarioForTopic(routeReceipt!.topic, route.framework, routeReceipt!.question)
  if (routeReceipt === undefined || route === undefined || scenario === undefined
    || routeReceipt.routeFramework !== route.framework
    || JSON.stringify(routeReceipt.candidateIds) !== JSON.stringify(scenario.candidates)
    || JSON.stringify(routeReceipt.selectedIds) !== JSON.stringify(selected.map(member => member.expert))
    || routeReceipt.selectedIds.some(id => !scenario.candidates.includes(id)))
    fail('expertSelection must bind the current routed shortlist, selected IDs and member experts before Host approval')
  const designer = profile.members.find(member => member.expert === 'designer-craft')
  const critic = profile.members.find(member => member.expert === 'design-critic')
  if (designer === undefined || critic === undefined) fail('bind the figure/renderer expert and independent visual critic')
  const byId = new Map((profile.tasks ?? []).map(task => [task.id, task]))
  const task = (id: string): ProfileSeedTask => byId.get(id) ?? fail(`missing task ${id}`)
  const needs = (id: string, ...dependencies: string[]): void => {
    const found = task(id)
    for (const dependency of dependencies) if (!found.dependsOn.includes(dependency)) fail(`${id} must depend on ${dependency}`)
  }
  const input = (id: string, fromTask: string, artifact: string): void => {
    if (!task(id).artifactInputs?.some(item => item.fromTask === fromTask && item.artifact === artifact))
      fail(`${id} must pin ${fromTask}/${artifact}`)
  }
  const briefIds = selected.map(member => `expert_brief_${member.id}`)
  const binding = (id: string, promptId: string, requiredSkills: readonly string[]): void => {
    const found = task(id)
    const actualSkills = found.skillBindings?.map(item => `${item.packId}/${item.skillId}`).sort()
    const strategySkill = `${TASK_MATERIAL_PACK}/strategy-consulting`
    const allowedSkills = [requiredSkills]
    if (['research_main', 'research_counter', 'evidence_merge', 'writer'].includes(id))
      allowedSkills.push([...requiredSkills, strategySkill])
    if (!isTaskMaterialSelection(found.skillBindings, found.promptBinding)
      || found.promptBinding?.packId !== TASK_MATERIAL_PACK || found.promptBinding.templateId !== promptId
      || !allowedSkills.some(skills => JSON.stringify(actualSkills) === JSON.stringify([...skills].sort())))
      fail(`${id} requires registered Skill bindings and fixed prompt ${promptId}`)
  }
  for (const member of selected) {
    const id = `expert_brief_${member.id}`
    const brief = task(id)
    if (brief.owner !== member.id || brief.dependsOn.length !== 0 || !brief.produces?.includes(`${id}.md`))
      fail(`${id} must be an independent, published task owned by selected expert ${member.id}`)
    needs('outline_candidates', id)
    input('outline_candidates', id, `${id}.md`)
    if (v3) binding(id, '98wiki-expert-brief-v1', [`${TASK_MATERIAL_PACK}/strategy-consulting`])
  }
  if (v3) {
    binding('outline_candidates', '98wiki-outline-candidates-v1', [`${TASK_MATERIAL_PACK}/98wiki-five-articles-gated-research`, `${TASK_MATERIAL_PACK}/strategy-consulting`])
    binding('outline_final', '98wiki-outline-final-v1', [`${TASK_MATERIAL_PACK}/98wiki-five-articles-gated-research`, `${TASK_MATERIAL_PACK}/strategy-consulting`])
    binding('data_preflight', '98wiki-data-preflight-v1', [`${TASK_MATERIAL_PACK}/98wiki-data-channels`])
    binding('research_main', '98wiki-research-main-v1', [`${TASK_MATERIAL_PACK}/98wiki-data-channels`, `${DOMAIN_MATERIAL_PACK}/zhijian-report-craft`])
    binding('research_counter', '98wiki-research-counter-v1', [`${TASK_MATERIAL_PACK}/98wiki-data-channels`, `${DOMAIN_MATERIAL_PACK}/zhijian-report-craft`])
    binding('evidence_merge', '98wiki-evidence-merge-v1', [`${DOMAIN_MATERIAL_PACK}/zhijian-report-craft`, `${TASK_MATERIAL_PACK}/98wiki-five-articles-gated-research`])
    binding('writer', '98wiki-report-writer-v1', [`${DOMAIN_MATERIAL_PACK}/zhijian-report-craft`, `${TASK_MATERIAL_PACK}/98wiki-five-articles-gated-research`])
    binding('content_review', '98wiki-content-review-v1', [`${DOMAIN_MATERIAL_PACK}/zhijian-report-craft`, `${TASK_MATERIAL_PACK}/98wiki-five-articles-gated-research`])
  }
  if (task('outline_candidates').owner !== selected[0]!.id || !task('outline_candidates').produces?.includes('outline-candidates.md'))
    fail('outline_candidates must publish reviewed A/B/C candidates under the lead expert')
  const choice = task('outline_choice')
  if (choice.owner !== 'captain' || choice.humanChoice?.sourceTaskId !== 'outline_candidates'
    || choice.humanChoice.artifact !== 'outline-candidates.md' || !choice.dependsOn.includes('outline_candidates'))
    fail('outline_choice must be the authenticated Host user gate over the candidate artifact')
  needs('outline_final', 'outline_candidates', 'outline_choice')
  input('outline_final', 'outline_choice', 'task-output')
  needs('data_preflight', 'outline_final')
  if (!task('data_preflight').produces?.includes('data-channel-status.md')) fail('data_preflight must publish a reusable channel probe')
  if (/^3\.1(?:\.|$)/u.test(profile.version)) {
    const catalog = 'realestate.indicators.catalog'
    if (!task('data_preflight').allowedCapabilities?.includes(catalog))
      fail('data_preflight must grant the catalog provider capability used by its dataset probe')
    const researchIds = ['research_main', 'research_counter', ...selected.slice(2).map(member => `research_view_${member.id}`)]
    for (const id of researchIds) {
      if (!task(id).allowedCapabilities?.includes(catalog)
        || !task(id).allowedCapabilities?.includes('realestate.indicators.timeseries'))
        fail(`${id} must grant catalog and timeseries provider capabilities for its research data calls`)
    }
  }
  needs('research_main', 'outline_final', 'data_preflight')
  needs('research_counter', 'outline_final', 'data_preflight')
  input('research_main', 'data_preflight', 'data-channel-status.md')
  input('research_counter', 'data_preflight', 'data-channel-status.md')
  if (task('research_main').owner !== selected[0]!.id || task('research_counter').owner !== selected[1]!.id)
    fail('main and contrary research must run under two distinct selected experts')
  needs('evidence_merge', 'research_main', 'research_counter')
  for (const member of selected.slice(2)) {
    const id = `research_view_${member.id}`
    if (task(id).owner !== member.id || !task(id).produces?.includes(`${id}.md`))
      fail(`${id} must publish independent evidence under the selected expert`)
    needs(id, 'outline_final', 'data_preflight')
    input(id, 'outline_final', 'OUTLINE.md')
    input(id, 'data_preflight', 'data-channel-status.md')
    if (v3) binding(id, '98wiki-research-view-v1', [`${TASK_MATERIAL_PACK}/98wiki-data-channels`, `${DOMAIN_MATERIAL_PACK}/zhijian-report-craft`])
    needs('evidence_merge', id)
    input('evidence_merge', id, `${id}.md`)
  }
  needs('writer', 'evidence_merge', 'outline_final')
  if (v3) {
    input('writer', 'evidence_merge', 'research-evidence.md')
    input('writer', 'outline_final', 'OUTLINE.md')
    if (!task('writer').produces?.includes('report-source-ledger.json')) fail('writer must publish a source ledger before downstream work')
  }
  if (task('writer').owner !== selected[0]!.id || task('content_review').owner === task('writer').owner)
    fail('the report writer and independent content reviewer must be different members')
  needs('content_review', 'writer')
  if (v3) {
    needs('content_review', 'outline_final', 'evidence_merge')
    input('content_review', 'writer', 'report.md')
    input('content_review', 'writer', 'report-source-ledger.json')
    input('content_review', 'outline_final', 'OUTLINE.md')
    input('content_review', 'evidence_merge', 'research-evidence.md')
    if (!task('content_review').produces?.includes('report.md'))
      fail('content_review must publish the exact reviewed report for the Host user gate')
    const release = task('report_release')
    needs('report_release', 'content_review')
    input('report_release', 'content_review', 'report.md')
    if (release.owner !== 'captain' || release.humanChoice?.sourceTaskId !== 'content_review'
      || release.humanChoice.artifact !== 'report.md' || !release.humanChoice.options.includes('进入点睛图'))
      fail('report_release must be a Host-authenticated gate over the reviewed report')
    needs('point_figures', 'report_release')
    input('point_figures', 'report_release', 'task-output')
    binding('point_figures', '98wiki-point-figures-v1', [`${DOMAIN_MATERIAL_PACK}/zhijian-designer-render`, `${TASK_MATERIAL_PACK}/98wiki-finesse-report`])
    binding('renderer', '98wiki-renderer-v1', [`${DOMAIN_MATERIAL_PACK}/zhijian-report-craft`, `${DOMAIN_MATERIAL_PACK}/zhijian-designer-render`, `${TASK_MATERIAL_PACK}/98wiki-finesse-report`])
    binding('visual_review', '98wiki-visual-review-v1', [`${DOMAIN_MATERIAL_PACK}/zhijian-report-craft`, `${TASK_MATERIAL_PACK}/98wiki-finesse-report`])
    binding('finalqa', '98wiki-finalqa-v1', [`${DOMAIN_MATERIAL_PACK}/zhijian-report-craft`, `${TASK_MATERIAL_PACK}/98wiki-five-articles-gated-research`, `${TASK_MATERIAL_PACK}/98wiki-finesse-report`])
    input('point_figures', 'writer', 'report.md')
    input('point_figures', 'outline_final', 'OUTLINE.md')
    input('renderer', 'point_figures', 'figure-spec.md')
    input('renderer', 'point_figures', 'figure-fragments.html')
    input('visual_review', 'renderer', 'report.html')
    input('visual_review', 'renderer', 'report.pdf')
    input('finalqa', 'visual_review', 'visual-review.md')
  }
  needs('point_figures', 'content_review', 'writer', 'outline_final')
  if (task('point_figures').owner !== designer.id || task('renderer').owner !== designer.id)
    fail('figures and renderer must be assigned to the bound design expert')
  needs('renderer', 'point_figures', 'content_review', 'writer')
  const reportBundle = task('renderer').reportBundle
  const craft = reportBundle?.craft
  if (craft?.version !== 3 || !['zhijian-report-craft', 'zhijian-designer-render'].every(skillId =>
    craft.selections.some(selection => selection.packId === 'zhijian-realestate' && selection.skillId === skillId)))
    fail('renderer must freeze both report and Designer craft selections')
  needs('visual_review', 'renderer')
  if (task('visual_review').owner !== critic.id) fail('visual_review must be assigned to the independent critic')
  needs('finalqa', 'visual_review')
  if (task('finalqa').owner === designer.id) fail('finalqa cannot be owned by the renderer')
  for (const id of briefIds) if (task(id).description?.includes('完整正文')) fail(`${id} must stay a lightweight outline-stage brief`)
}
