import { REVIEW_PORTRAITS } from '../review-ui.ts'
import { expertPortraitId, sharedPortraitId, sharedPortraitRole } from '../review-portraits.ts'
import { tasksComplete } from './review-context.ts'
import type { ReviewContext } from './review-context.ts'
import type { TeamWireResponse } from '../team-wire.ts'
export function portraitFallback(key:string,role:string):typeof REVIEW_PORTRAITS[number] {
  return sharedPortraitRole(key,role)
}
export function reviewPresentation(context:ReviewContext,wire:TeamWireResponse,docs:readonly {id:string;formal?:boolean;resultKey?:string}[]) {
  const {team,plan,ui,research}=context,tasks=team?.tasks??[],roster=team?.reviewSnapshot?.roster??plan?.plan.roster??[]
  const labels={plan:research?'研究计划':'任务计划',outline:research?'研究大纲':'待确认',activity:'团队进展',results:research?'研究成果':'交付成果',...ui?.labels}
  const gates=tasks.filter(t=>t.humanChoice),outlineGates=gates.filter(t=>/outline|大纲/i.test(t.humanChoice!.artifact))
  const hasOutlineFinal=tasks.some(t=>t.planTask?.logicalId==='outline_final')||!!plan?.plan.tasks.some(t=>t.id==='outline_final')
  const hasOutlineChoice=tasks.some(t=>t.planTask?.logicalId==='outline_choice')||!!plan?.plan.tasks.some(t=>t.id==='outline_choice')
  const outlineIds=ui?.outlineTasks??(research?hasOutlineFinal?['outline_final']:hasOutlineChoice?['outline_choice']:[]:[])
  const planOutline=!!plan?.plan.reportOutline?.chapters?.length
  const planOutlineApproved=planOutline&&!!(team?.planRef||plan?.approval||plan?.appliedTeamId)
  const relevantGates=research?outlineGates:gates
  const outlineApplicable=outlineIds.length>0||relevantGates.length>0||planOutline
  const outlineDone=outlineIds.length?tasksComplete(context,outlineIds)&&outlineGates.every(t=>t.status==='completed')
    :planOutline?planOutlineApproved&&outlineGates.every(t=>t.status==='completed')
    :relevantGates.length>0&&relevantGates.every(t=>t.status==='completed')
  const finalKeys=ui?.artifacts?.filter(a=>a.kind==='final').map(a=>a.key)??[]
  const resultsDone=finalKeys.length?finalKeys.every(key=>docs.some(d=>d.formal&&d.resultKey===key)):docs.some(d=>d.formal)
  const stages={plan:team?.planRef?'done':plan?(plan.approval||!!plan.appliedTeamId?'done':'pending'):'na',outline:outlineApplicable?(outlineDone?'done':'pending'):'na',activity:tasks.length&&tasks.every(t=>t.status==='completed')?'done':'pending',results:resultsDone?'done':'pending'}
  const experts:Record<string,{key:string;label:string;role:string;portrait?:string;fallback:string}>={}
  for(const member of wire.team?.members??[]){
    const compiled=roster.find(r=>[r.expertId,r.sourceExpertId].includes(member.expertId??''))
    const key=compiled?.sourceExpertId||member.expertId||compiled?.expertId||member.id||member.name
    const cfg=ui?.experts?.[key]??ui?.experts?.[compiled?.expertId??'']??ui?.experts?.[compiled?.slotId??'']
    const named=expertPortraitId({...member,sourceExpertId:compiled?.sourceExpertId})
    const portrait=cfg?.portrait||`asset:${named||sharedPortraitId(key,cfg?.role||member.role,cfg?.fallback)}`
    const entry={key,label:cfg?.label||member.name,role:cfg?.role||member.role,...(portrait?{portrait}:{}),fallback:cfg?.fallback||portraitFallback(key,cfg?.role||member.role)}
    for(const id of [key,member.id,member.name,compiled?.sourceExpertId,compiled?.expertId,compiled?.slotId])if(id)experts[id]=entry
  }
  for(const member of roster){
    const key=member.sourceExpertId||member.expertId,cfg=ui?.experts?.[key]??ui?.experts?.[member.expertId]??ui?.experts?.[member.slotId]
    const frozen=plan?.runtime.expertDisplay?.[key]
    const named=expertPortraitId(member),portrait=cfg?.portrait||`asset:${named||sharedPortraitId(key,cfg?.role||member.role||frozen?.field||'',cfg?.fallback)}`
    const entry=experts[key]??{key,label:cfg?.label||frozen?.name||member.displayName||member.role||'领域专家',role:cfg?.role||member.role||frozen?.field||'领域研究',...(portrait?{portrait}:{}),fallback:cfg?.fallback||portraitFallback(key,member.role||frozen?.field||'')}
    for(const id of [key,member.expertId,member.slotId])experts[id]=entry
  }
  return {version:1,mode:research?'research':'generic',labels,stages,experts,issues:context.issues}
}
