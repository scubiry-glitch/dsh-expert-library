/** Additive v4 template. Conversion returns a detached NEW profile; v2/v3 remain unchanged. */
import type { ExpertTeamProfile, ProfileSeedTask } from './profiles.ts'
import { TASK_MATERIAL_PACK, DOMAIN_MATERIAL_PACK } from './task-material-binding.ts'
import { COMPACT_RESEARCH_VERSION } from './research-release.ts'
import { scenarioForTopic, topicRouteFor } from './zhijian/routing.ts'
function fail(message: string): never { throw new Error(`COMPACT_RESEARCH_PLAN_INVALID: ${message}`) }
const skill = (skillId: string, domain = false): import('./task-material-binding.ts').TaskSkillBinding => ({ packId: domain ? DOMAIN_MATERIAL_PACK : TASK_MATERIAL_PACK, skillId, materialRole: 'producer' as const, required: true as const, reason: 'Version 4 producer and independent reviewer contract' })
export function compactResearchProfile(source: ExpertTeamProfile): ExpertTeamProfile {
  if (source.id !== '98wiki-deep-research') fail('select the 98wiki research profile')
  const experts = source.members.filter(m => /^bk-\d{3}$/u.test(m.expert ?? ''))
  const designer = source.members.find(m => m.expert === 'designer-craft')
  if (experts.length < 2 || !designer) fail('select at least two routed experts and the design expert')
  const sourceTasks = new Map(source.tasks?.map(t => [t.id, t]))
  const input = (fromTask: string, ...names: string[]) => names.map(artifact => ({ fromTask, artifact, purpose: 'Use exact reviewed input bundle', phase: 'work' as const }))
  const producer = (id: string, subject: string, owner: string, dependsOn: string[], produces: string[], artifactInputs: NonNullable<ProfileSeedTask['artifactInputs']>, skills: ReturnType<typeof skill>[], acceptance: string[]): ProfileSeedTask => ({
    id, subject, owner, dependsOn, produces, artifactInputs, acceptance: [...new Set([...acceptance, ...(sourceTasks.get(id)?.acceptance ?? []), ...(['writer'].includes(id) ? ['evidence_merge','content_review'] : id === 'renderer' ? ['point_figures','visual_review','finalqa'] : id === 'outline_final' ? ['outline_candidates','data_preflight'] : []).flatMap(key => sourceTasks.get(key)?.acceptance ?? [])])],
    description: `精简研究 v4：${subject}。在原任务内完成修订；独立评审直接审核本次不可变发布版本。原需求约束：${sourceTasks.get(id)?.description ?? source.description}`,
    skillBindings: skills, promptBinding: { packId: TASK_MATERIAL_PACK, templateId: id === 'writer' ? '98wiki-compact-writer-v4-preflight' : `98wiki-compact-${id}-v4`, required: true, variables: [] },
    allowedCapabilities: [...new Set([...(sourceTasks.get(id)?.allowedCapabilities ?? []), ...(['outline_final', 'research_main', 'research_counter'].includes(id) ? ['realestate.indicators.catalog', 'realestate.indicators.timeseries'] : [])])],
  })
  const tasks: ProfileSeedTask[] = [
    producer('outline_final', '研究设计', experts[0]!.id, [], ['OUTLINE.md', 'data-channel-status.md'], [], [skill('98wiki-five-articles-gated-research'), skill('strategy-consulting'), skill('98wiki-data-channels')], ['问题、主假设、反证、数据可得性和至少五章大纲；所有失败通道如实记录']),
    { id: 'outline_choice', subject: '确认研究设计', owner: 'captain', dependsOn: ['outline_final'], artifactInputs: input('outline_final','OUTLINE.md'), humanChoice: { sourceTaskId: 'outline_final', artifact: 'OUTLINE.md', options: ['确认提纲'] } },
    ...(['main','counter'] as const).map((kind, index) => producer(`research_${kind}`, kind === 'main' ? '主证据研究' : '反证研究', experts[index]!.id,
      ['outline_choice','outline_final'], [`research-${kind}.md`], [...input('outline_choice','task-output'), ...input('outline_final','OUTLINE.md','data-channel-status.md')], [skill('98wiki-data-channels'),skill('zhijian-report-craft',true)], ['逐章核验来源、单位、统计期、口径与反证；失败和空序列不作为数值'])),
    producer('writer', '正文编写与内容评审', experts[0]!.id, ['outline_final','research_main','research_counter'], ['research-evidence.md','report.md','report-source-ledger.json'],
      [...input('outline_final','OUTLINE.md'), ...input('research_main','research-main.md'), ...input('research_counter','research-counter.md')], [skill('zhijian-report-craft',true),skill('98wiki-five-articles-gated-research')],
      ['独立内容评审：逐章问题、论证与反证完整，三透彻正文至少一半', '来源证据至少十条外部增量，全部数字可追溯到真实回执并核验单位与算术', '独立审核正文与台账同一 SHA256，条件化红线不回退；未通过在本任务修订']),
    { id: 'report_release', subject: '确认已审正文', owner: 'captain', dependsOn: ['writer'], artifactInputs: input('writer','report.md'), humanChoice: { sourceTaskId: 'writer', artifact: 'report.md', options: ['进入成品制作'] } },
    { ...producer('renderer', '成品制作与交付评审', designer.id, ['report_release','writer','outline_final'],
      ['report.md','report.html','report.pdf','craft-evidence.json','reference-map.json','figure-spec.md','figure-fragments.html'],
      [...input('report_release','task-output'), ...input('writer','report.md','report-source-ledger.json','research-evidence.md'), ...input('outline_final','OUTLINE.md')],
      [skill('zhijian-report-craft',true),skill('zhijian-designer-render',true),skill('98wiki-finesse-report')], ['独立交付评审：正文未漂移，图表与引用无新增数值', '独立检查 DOM、宽窄视口、交互、可访问性和 PDF 首中末页；真实复核记录随 review_audit 提交']),
      reportBundle: structuredClone(sourceTasks.get('renderer')?.reportBundle) },
  ]
  const profile: ExpertTeamProfile = { ...structuredClone(source), version: COMPACT_RESEARCH_VERSION, templateId: '98wiki-compact-research-v4', description: `${source.description}（精简流程 v4）`, taskPlanning: 'seed',
    review: { ...source.review, required: true, maxRepairRounds: source.review?.maxRepairRounds ?? 2 }, tasks,
    protocol: [...source.protocol, 'v4：设计确认 → 主证据/反证 → 正文及独立评审 → 正文确认 → 成品及独立评审。提交后 Host 自动安排独立评审；通过后原子集成并冻结已审输入包。修订保留原任务 ID。'] }
  validateCompactResearchPlan(profile)
  return profile
}
export function validateCompactResearchPlan(profile: ExpertTeamProfile): void {
  if (profile.id !== '98wiki-deep-research' || !/^4\./u.test(profile.version)) return
  if (profile.version !== COMPACT_RESEARCH_VERSION || profile.templateId !== '98wiki-compact-research-v4') fail('unknown compact version')
  if (profile.review?.required !== true || profile.fallback?.length) fail('independent review required; no automatic model fallback')
  const framework = profile.analysisFramework
  if (!framework || framework.axes.length < 2 || framework.hypotheses.length < 2 || !framework.falsifiers.length) fail('structured framework required')
  const selected = profile.members.filter(m => /^bk-\d{3}$/u.test(m.expert ?? ''))
  const receipt = profile.expertSelection
  const route = receipt && topicRouteFor(receipt.topic, receipt.question)
  const scenario = route && scenarioForTopic(receipt!.topic, route.framework, receipt!.question)
  if (selected.length < 2 || selected.length > 5 || !receipt || !route || !scenario || receipt.routeFramework !== route.framework
    || JSON.stringify(receipt.candidateIds) !== JSON.stringify(scenario.candidates)
    || JSON.stringify(receipt.selectedIds) !== JSON.stringify(selected.map(m => m.expert))
    || new Set(receipt.selectedIds).size !== selected.length || receipt.selectedIds.some(id => !scenario.candidates.includes(id))) fail('routed expert selection required')
  const designer = profile.members.find(m => m.expert === 'designer-craft')
  const critic = profile.members.find(m => m.expert === 'design-critic')
  if (!designer || !critic || designer.id === critic.id) fail('independent design critic required')
  const byId = new Map(profile.tasks?.map(t => [t.id,t]))
  const expected: Record<string,string[]> = { outline_final: [], outline_choice:['outline_final'], research_main:['outline_final','outline_choice'], research_counter:['outline_final','outline_choice'], writer:['outline_final','research_main','research_counter'], report_release:['writer'], renderer:['report_release','writer','outline_final'] }
  if (byId.size !== 7) fail('exactly five producer tasks and two Host gates required')
  for (const [id, deps] of Object.entries(expected)) {
    const t = byId.get(id)
    if (!t || JSON.stringify([...t.dependsOn].sort()) !== JSON.stringify([...deps].sort())) fail(`${id}: unexpected dependencies`)
    if (!['outline_choice','report_release'].includes(id) && (![`98wiki-compact-${id}-v4`, ...(id === 'writer' ? ['98wiki-compact-writer-v4-preflight'] : [])].includes(t.promptBinding?.templateId ?? '') || !t.skillBindings?.length || !t.acceptance?.length)) fail(`${id}: frozen materials and acceptance required`)
  }
  for (const [id, source, artifact, option] of [['outline_choice','outline_final','OUTLINE.md','确认提纲'],['report_release','writer','report.md','进入成品制作']]) {
    const t = byId.get(id!)!
    if (t.owner !== 'captain' || t.humanChoice?.sourceTaskId !== source || t.humanChoice?.artifact !== artifact || JSON.stringify(t.humanChoice?.options) !== JSON.stringify([option])) fail(`${id}: authenticated Host gate required`)
  }
  for (const [id,owner] of [['outline_final',selected[0]!.id],['research_main',selected[0]!.id],['research_counter',selected[1]!.id],['writer',selected[0]!.id],['renderer',designer.id]]) if (byId.get(id!)?.owner !== owner) fail(`${id}: wrong owner`)
  const requiredOutputs: Record<string,string[]> = { outline_final:['OUTLINE.md','data-channel-status.md'], research_main:['research-main.md'], research_counter:['research-counter.md'], writer:['research-evidence.md','report.md','report-source-ledger.json'], renderer:['report.md','report.html','report.pdf','craft-evidence.json','reference-map.json','figure-spec.md','figure-fragments.html'] }
  for (const [id,outputs] of Object.entries(requiredOutputs)) for (const name of outputs) if (!byId.get(id)?.produces?.includes(name)) fail(`${id}: missing publication ${name}`)
  const inputs: Record<string, [string,string[]][]> = {
    outline_choice: [['outline_final',['OUTLINE.md']]],
    research_main: [['outline_final',['OUTLINE.md','data-channel-status.md']],['outline_choice',['task-output']]],
    research_counter: [['outline_final',['OUTLINE.md','data-channel-status.md']],['outline_choice',['task-output']]],
    writer: [['outline_final',['OUTLINE.md']],['research_main',['research-main.md']],['research_counter',['research-counter.md']]],
    report_release: [['writer',['report.md']]],
    renderer: [['writer',['report.md','report-source-ledger.json','research-evidence.md']],['outline_final',['OUTLINE.md']],['report_release',['task-output']]],
  }
  for (const [id,sources] of Object.entries(inputs)) for (const [fromTask,names] of sources) for (const name of names) if (!byId.get(id)?.artifactInputs?.some(i => i.fromTask === fromTask && i.artifact === name)) fail(`${id}: missing pinned input ${fromTask}/${name}`)
  const mandatorySkills: Record<string,string[]> = { outline_final:['98wiki-five-articles-gated-research','strategy-consulting','98wiki-data-channels'], research_main:['98wiki-data-channels','zhijian-report-craft'], research_counter:['98wiki-data-channels','zhijian-report-craft'], writer:['zhijian-report-craft','98wiki-five-articles-gated-research'], renderer:['zhijian-report-craft','zhijian-designer-render','98wiki-finesse-report'] }
  for (const [id,skills] of Object.entries(mandatorySkills)) for (const skillId of skills) if (!byId.get(id)?.skillBindings?.some(s => s.skillId === skillId && s.packId === (['zhijian-report-craft','zhijian-designer-render'].includes(skillId) ? DOMAIN_MATERIAL_PACK : TASK_MATERIAL_PACK))) fail(`${id}: missing frozen skill ${skillId}`)
  const craft = byId.get('renderer')?.reportBundle?.craft
  if (craft?.version !== 3 || !['zhijian-report-craft','zhijian-designer-render'].every(id => craft.selections.some(s => s.packId === DOMAIN_MATERIAL_PACK && s.skillId === id))) fail('renderer must retain selected report and design craft')
  for (const id of ['outline_final','research_main','research_counter']) for (const capability of ['realestate.indicators.catalog','realestate.indicators.timeseries']) if (!byId.get(id)?.allowedCapabilities?.includes(capability)) fail(`${id}: missing ${capability}`)
}
