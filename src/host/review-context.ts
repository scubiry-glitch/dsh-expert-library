import { readTeam,readArchivedTeam } from '../state.ts'
import { readStagedPlan } from '../staged-plan.ts'
import { normalizeReviewUi } from '../review-ui.ts'
import type { TeamRouteTarget } from './team-routes.ts'
import type { StagedPlan,TeamState } from '../types.ts'
export interface ReviewContext { team?:TeamState; plan?:StagedPlan; ui?:import('../review-ui.ts').ReviewUi; deliverables:import('../v2/compiler.ts').CompiledDeliverable[]; research:boolean; issues:string[] }
export async function readReviewContext(target:TeamRouteTarget):Promise<ReviewContext> {
  const team=target.teamId?await (target.archived?readArchivedTeam:readTeam)(target.stateRoot,target.teamId):undefined
  if(target.teamId&&(!team||team.captainSessionId!==target.captainSessionId))throw Error('DOCUMENT_UNAVAILABLE')
  const planId=target.planId??team?.planRef?.planId
  const plan=planId?await readStagedPlan(target.stateRoot,planId).catch(()=>undefined):undefined
  if(plan&&plan.createdBy!==target.captainSessionId)throw Error('DOCUMENT_UNAVAILABLE')
  const safePlan=plan&&(!team||(!plan.appliedTeamId||plan.appliedTeamId===team.id)&&(!team.planRef||team.planRef.planId===planId&&team.planRef.digest===plan.plan.digest))?plan:undefined
  const {value:ui,issues}=normalizeReviewUi(team?.reviewSnapshot?team.reviewSnapshot.ui:safePlan?.plan.reviewUi)
  const research=team?.planRef?.scenarioId==='98wiki-deep-research'||safePlan?.plan.scenario?.id==='98wiki-deep-research'
    ||!!team?.tasks.some(t=>t.planTask?.logicalId==='outline_final')||!!safePlan?.plan.reportOutline?.chapters?.length
  return {team,plan:safePlan,ui,issues,deliverables:[...(team?.reviewSnapshot?.deliverables??safePlan?.plan.deliverables??[])],research}
}
export function physicalTasks(context:ReviewContext,ids:readonly string[]) {
  return (context.team?.tasks??[]).filter(t=>ids.includes(t.planTask?.logicalId??t.id))
}
export function tasksComplete(context:ReviewContext,ids:readonly string[]):boolean {
  return ids.length>0&&ids.every(id=>{const tasks=physicalTasks(context,[id]);return tasks.length>0&&tasks.every(t=>t.status==='completed')})
}
