/** Additive V5: viewpoint-led research; original profiles remain untouched. */
import type { ExpertTeamProfile, ProfileSeedTask } from './profiles.ts'
import { TASK_MATERIAL_PACK, DOMAIN_MATERIAL_PACK } from './task-material-binding.ts'
import { scenarioForTopic, topicRouteFor } from './zhijian/routing.ts'
export const VIEWPOINT_RESEARCH_VERSION = '5.0.0'
const fail = (s: string): never => { throw new Error(`VIEWPOINT_RESEARCH_PLAN_INVALID: ${s}`) }
export function viewpointResearchProfile(source: ExpertTeamProfile): ExpertTeamProfile {
  if (source.id !== '98wiki-deep-research') fail('select the 98wiki research profile')
  const experts = source.members.filter(m => /^bk-\d{3}$/u.test(m.expert ?? ''))
  const designer = source.members.find(m => m.expert === 'designer-craft')
  if (experts.length < 2 || !designer) fail('select research experts and designer')
  const input = (fromTask: string, ...names: string[]) => names.map(artifact => ({fromTask,artifact,purpose:'Use the pinned source version; distinguish working evidence from independently reviewed text',phase:'work' as const}))
  const work = (id: string, subject: string, owner: string, stage: string, deps: string[], produces: string[], inputs: NonNullable<ProfileSeedTask['artifactInputs']>): ProfileSeedTask => ({
    id, subject, owner, dependsOn:deps, produces, artifactInputs:inputs,
    description:`V5：${subject}。研究问题：${source.expertSelection?.question ?? source.description}。围绕读者决策组织观点，技术取证放入附件。按本阶段材料执行，不继承旧版章数或配额。`,
    acceptance: stage === 'writer' ? ['核心判断与真实来源、口径、单位、统计期对应；事实、推断和未决问题分明','独立复核关键计算、反证和论证；每个分析章有可视化关系与源句，附件不淹没正文'] : stage === 'renderer' ? ['保持已确认正文的事实与不确定性；两份设计参考的取舍有明确记录','每个分析章至少一张表达真实观点和核心关系的图；逐图核对来源、口径、视觉语义','真实宽窄屏与 A4 验证；可阅读、无裁切、无新增事实'] : ['所声明材料完整且可读；真实来源和未知项如实记录'],
    skillBindings:[{packId:TASK_MATERIAL_PACK,skillId:`research-v5-${stage}`,materialRole:'producer',required:true,reason:`V5 ${stage} stage only`}],
    promptBinding:{packId:TASK_MATERIAL_PACK,templateId:`research-v5-${stage}`,required:true,variables:[]},
    allowedCapabilities:['view','evidence'].includes(stage) ? ['realestate.indicators.catalog','realestate.indicators.timeseries'] : [],
  })
  const briefs = experts.map(m => work(`expert_view_${m.id}`,`${m.id}：候选观点与框架`,m.id,'view',[],['view.md'],[]))
  const studies = experts.map(m => work(`research_${m.id}`,`${m.id}：专题取证与反证`,m.id,'evidence',['outline_choice','viewpoints'],['evidence.md'],[...input('outline_choice','task-output'),...input('viewpoints','viewpoints.md')]))
  const expression = work('expression','表达策划与阅读逻辑',designer!.id,'expression',['outline_choice','viewpoints',...studies.map(t=>t.id)],['expression-brief.md'],[...input('outline_choice','task-output'),...input('viewpoints','viewpoints.md'),...studies.flatMap(t=>input(t.id,'evidence.md'))])
  const writer = work('writer','观点成文与独立内容评审',experts[0]!.id,'writer',['outline_choice','viewpoints','expression',...studies.map(t=>t.id)],['report.md','report-source-ledger.json','OUTLINE.md','figure-plan.json'],[...input('outline_choice','task-output'),...input('viewpoints','viewpoints.md'),...input('expression','expression-brief.md'),...studies.flatMap(t=>input(t.id,'evidence.md'))])
  const rendererBase = work('renderer','HTML/PDF 成品与独立视觉评审',designer!.id,'renderer',['report_release','writer','expression'],['report.md','report.html','report.pdf','craft-evidence.json'],[...input('report_release','task-output'),...input('writer','report.md','report-source-ledger.json','OUTLINE.md','figure-plan.json'),...input('expression','expression-brief.md')])
  const old = source.tasks?.find(t=>t.id==='renderer')?.reportBundle
  if (!old?.craft) fail('renderer report bundle and craft required')
  const existingCraft = old!.craft!
  const renderer: ProfileSeedTask = {...rendererBase,reportBundle:{...structuredClone(old!), craft:{version:3,evidence:existingCraft.evidence,selections:[{packId:DOMAIN_MATERIAL_PACK,skillId:'zhijian-research-craft-v5',variant:existingCraft.version===3 ? existingCraft.selections.find(s=>s.skillId==='zhijian-designer-render')?.variant ?? 'designer-paper' : 'designer-paper',reason:'V5 viewpoint-led writing and reference-driven responsive HTML/PDF'}]}}}
  const tasks: ProfileSeedTask[] = [...briefs,
    work('viewpoints','汇总候选观点，推荐研究方向',experts[0]!.id,'synthesis',briefs.map(t=>t.id),['viewpoints.md'],briefs.flatMap(t=>input(t.id,'view.md'))),
    {id:'outline_choice',subject:'选择观点方向',owner:'captain',dependsOn:['viewpoints'],artifactInputs:input('viewpoints','viewpoints.md'),humanChoice:{sourceTaskId:'viewpoints',artifact:'viewpoints.md',options:['选择材料中的观点']}},
    ...studies,expression,writer,
    {id:'report_release',subject:'确认已审正文',owner:'captain',dependsOn:['writer'],artifactInputs:input('writer','report.md'),humanChoice:{sourceTaskId:'writer',artifact:'report.md',options:['进入成品制作']}},renderer]
  const profile: ExpertTeamProfile = {...structuredClone(source),version:VIEWPOINT_RESEARCH_VERSION,templateId:'98wiki-viewpoint-research-v5',description:`${source.description}（观点驱动 V5）`,taskPlanning:'seed',tasks,
    review:{required:true,maxRepairRounds:source.review?.maxRepairRounds??2},
    protocol:['V5：专家与框架推荐 → 候选观点 → 用户选择方向 → 各专家取证 → 表达策划 → 正文独立评审 → 用户确认正文 → 成品独立评审。',
      '内部材料提交后由 Host 校验完整性并冻结版本自动流转，不伪称独立评审通过。正文与成品保留独立评审。',
      '大纲随观点和证据重组，无章数、字数、外部增量数或固定小节配额。每个分析章至少一张有证据支撑且表达核心关系的图，附件不计；缺证据则补证或重组，不造图。未知项如实保留，基础设施失败不消耗内容修订预算。']}
  validateViewpointResearchPlan(profile)
  return profile
}
export function validateViewpointResearchPlan(p: ExpertTeamProfile): void {
  if(p.id!=='98wiki-deep-research'||!/^5\./u.test(p.version)) return
  if(p.version!==VIEWPOINT_RESEARCH_VERSION||p.templateId!=='98wiki-viewpoint-research-v5'||p.review?.required!==true||p.fallback?.length) fail('unknown V5 version or missing independent review')
  const experts=p.members.filter(m=>/^bk-\d{3}$/u.test(m.expert??'')), receipt=p.expertSelection
  const route=receipt&&topicRouteFor(receipt.topic,receipt.question), scenario=route&&scenarioForTopic(receipt!.topic,route.framework,receipt!.question)
  if(experts.length<2||experts.length>5||!receipt||!scenario||receipt.routeFramework!==route!.framework||JSON.stringify(receipt.candidateIds)!==JSON.stringify(scenario.candidates)||JSON.stringify(receipt.selectedIds)!==JSON.stringify(experts.map(m=>m.expert))||receipt.selectedIds.some(id=>!scenario.candidates.includes(id))) fail('retain routed expert selection and rationale')
  if(!p.analysisFramework?.axes.length||!p.analysisFramework.hypotheses.length||!p.analysisFramework.falsifiers.length) fail('recommend a framework, propositions and falsifiers')
  const designer=p.members.find(m=>m.expert==='designer-craft'),critic=p.members.find(m=>m.expert==='design-critic')
  if(!designer||!critic||designer.id===critic.id) fail('independent design critic required')
  const tasks=p.tasks??[], byId=new Map(tasks.map(t=>[t.id,t]))
  const ids=[...experts.map(m=>`expert_view_${m.id}`),'viewpoints','outline_choice',...experts.map(m=>`research_${m.id}`),'expression','writer','report_release','renderer']
  if(tasks.length!==ids.length||ids.some(id=>!byId.has(id))) fail('every selected expert must contribute views and evidence')
  for(const t of tasks) if(!t.humanChoice&&(!t.produces?.length||!t.skillBindings?.some(s=>s.skillId.startsWith('research-v5-'))||!t.promptBinding?.templateId.startsWith('research-v5-'))) fail(`${t.id}: stage materials and publications required`)
  for(const m of experts) if(byId.get(`expert_view_${m.id}`)?.owner!==m.id||byId.get(`research_${m.id}`)?.owner!==m.id||!byId.get('writer')?.dependsOn.includes(`research_${m.id}`)) fail(`${m.id}: actual participation required`)
  if(byId.get('writer')?.owner!==experts[0]!.id||byId.get('renderer')?.owner!==designer?.id) fail('writer/render owners differ from selected roles')
  for(const [id,source,name] of [['outline_choice','viewpoints','viewpoints.md'],['report_release','writer','report.md']]) { const t=byId.get(id!)!; if(t.owner!=='captain'||t.humanChoice?.sourceTaskId!==source||t.humanChoice?.artifact!==name||!t.dependsOn.includes(source!)) fail('two authenticated decisions required') }
  const expected: Record<string,string[]> = {
    ...Object.fromEntries(experts.map(m=>[`expert_view_${m.id}`,[]])),
    viewpoints: experts.map(m=>`expert_view_${m.id}`), outline_choice:['viewpoints'],
    ...Object.fromEntries(experts.map(m=>[`research_${m.id}`,['outline_choice','viewpoints']])),
    expression:['outline_choice','viewpoints',...experts.map(m=>`research_${m.id}`)],
    writer:['outline_choice','viewpoints','expression',...experts.map(m=>`research_${m.id}`)],report_release:['writer'],renderer:['report_release','writer','expression'],
  }
  const outputs: Record<string,string[]> = {viewpoints:['viewpoints.md'],expression:['expression-brief.md'],writer:['report.md','report-source-ledger.json','OUTLINE.md','figure-plan.json'],renderer:['report.md','report.html','report.pdf','craft-evidence.json']}
  for(const m of experts){outputs[`expert_view_${m.id}`]=['view.md'];outputs[`research_${m.id}`]=['evidence.md']}
  for(const t of tasks){
    if(JSON.stringify([...t.dependsOn].sort())!==JSON.stringify([...expected[t.id]!].sort())) fail(`${t.id}: invalid phase dependencies`)
    if(!t.humanChoice && JSON.stringify([...(t.produces??[])].sort())!==JSON.stringify([...outputs[t.id]!].sort())) fail(`${t.id}: invalid declared publications`)
    for(const dep of t.dependsOn) {
      const names=t.humanChoice?[t.humanChoice.artifact]:byId.get(dep)?.humanChoice?['task-output']:outputs[dep]??[]
      for(const name of names) if(!t.artifactInputs?.some(i=>i.fromTask===dep&&i.artifact===name)) fail(`${t.id}: missing pinned input ${dep}/${name}`)
    }
  }
  const craft=byId.get('renderer')?.reportBundle?.craft
  if(craft?.version!==3||craft.selections.length!==1||craft.selections[0]?.skillId!=='zhijian-research-craft-v5'||craft.selections[0]?.packId!==DOMAIN_MATERIAL_PACK) fail('V5 isolated report craft required')
}
