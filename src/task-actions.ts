import { isV5WorkingTask, isCompactResearch, compactReviewer } from './research-release.ts'
import { requiresDesignCritic, boundDesignCritic } from './research-reviewer.ts'
/** Role-specific current actions, derived from authenticated durable identity. */
import type { TeamState, TeamTask } from './types.ts'
export function currentTaskAction(team: TeamState, task: TeamTask, viewer: string) {
  if (task.humanChoice !== undefined) return { kind: 'wait', reason: 'Await authenticated user choice in the Host panel.' }
  const run = team.qualityRuns?.[task.id] ?? (team.qualityRun?.contract.taskId === task.id ? team.qualityRun : undefined)
  const published = new Set((task.publishedArtifacts ?? []).filter(a => a.attempt === task.attempt).map(a => a.reviewId))
  const missing = (run?.contract.deliverables ?? []).filter(id => id.startsWith('published:') && !published.has(id))
  const base = { task_id: task.id, attempt: task.attempt ?? 0, attempt_id: task.attemptId ?? null, assignee: task.assignee ?? null, missing_publications: missing }
  const wait = (reason: string) => ({...base,kind:'wait',tool:'expert_teams_wait',arguments:{},required_fields:[],reason})
  if (isCompactResearch(team) && run?.status === 'escalated' && viewer === 'captain') return {...base,kind:'policy_decision',tool:'expert_teams_quality_continue',arguments:{task_id:task.id,expected_run_id:run.runId},required_fields:['event_id','reason','user_decision','additional_repair_rounds'],reason:'Content repair threshold reached. Obtain an explicit user continuation decision; preserve old evidence and open the next attempt on this task. If the user stops, record quality_closeout. Never self-authorize more rounds.'}
  if (['completed','failed','cancelled'].includes(task.status)) return {...base,kind:'terminal',tool:null,arguments:{},required_fields:[],reason:'This attempt is terminal; no duplicate submission or review.'}
  if (run?.status === 'escalated') return viewer === 'captain'
    ? {...base,kind:'closeout',tool:'expert_teams_quality_closeout',arguments:{task_id:task.id},required_fields:['event_id','reason'],reason:'The repair budget is exhausted. Record an audited failed closeout; revised report source or craft contract requires a new confirmed staged plan.'}
    : wait('Repair budget exhausted; only the captain can record the failed closeout.')
  if (team.halted || task.reassigning || task.runtimeBlock || task.executionState === 'blocked_external') return wait(task.waitReason ?? 'Resolve the recorded halt, external blocker or handoff; do not bypass it through reassignment.')
  if (run?.status === 'blocked') return viewer === 'captain'
    ? {...base,kind:'request_repair',tool:'expert_teams_quality_repair',arguments:{task_id:task.id,actor:'captain'},required_fields:['event_id'],reason:'Preserve the failed review findings and open the supported repair path.'}
    : wait('The captain must open a repair for the rejected review before the owner changes the submission.')
  if (run?.status === 'passed') return viewer === 'captain'
    ? {...base,kind:'integrate',tool:'expert_teams_quality_integrate',arguments:{task_id:task.id,actor:'captain',complete_task:true},required_fields:['event_id'],reason:'Integrate this independently reviewed attempt; reuse the event_id only for an exact retry.'}
    : wait('Independent review passed; the captain integrates this existing attempt.')
  if (task.executionState === 'awaiting_review' && requiresDesignCritic(team, task)) {
    const reviewer = boundDesignCritic(team, task)
    if (viewer !== reviewer) return {...wait(reviewer
      ? `Only the bound design critic ${reviewer} may review this renderer submission; route the review to this member.`
      : 'No eligible bound design critic is available; the captain must resolve the reviewer roster before review.'), reviewer: reviewer ?? null}
  }
  if (isCompactResearch(team) && task.executionState === 'awaiting_review' && viewer !== compactReviewer(team,task)) return wait('Waiting for the designated independent reviewer; Host advances a true pass automatically.')
  if (task.executionState === 'awaiting_review') return viewer === task.assignee || viewer === 'captain'
    ? wait('The independent reviewer must inspect this exact submission. Authors cannot self-review; captains cannot proxy review.')
    : {...base,kind:task.reportBundle?.craft || task.frozenTaskMaterialContract ? 'prepare_review':'review',tool:'expert_teams_quality_review',arguments:{task_id:task.id,...(task.reportBundle?.craft || task.frozenTaskMaterialContract ? {prepare_only:true}:{})},required_fields:task.reportBundle?.craft || task.frozenTaskMaterialContract?[]:['event_id','verdict','acceptance_results'],acceptance:run?.contract.acceptance??[],reason:'Your reviewer identity and published artifact bindings are resolved by the Host. Record truthful results for every acceptance id.'}
  if (viewer !== task.assignee) return wait('Only the current task owner may submit this attempt.')
  if (task.dependencies.some(id => team.tasks.find(t => t.id === id)?.status !== 'completed')) return wait('Required upstream evidence has not completed independent review and integration.')
  if (task.status === 'pending' || task.attemptId === undefined) return {...base,kind:'claim',tool:'expert_teams_claim_task',arguments:{task_id:task.id},required_fields:[],reason:'Claim this task to receive its current attempt and complete execution materials.'}
  if (isV5WorkingTask(team,task)) return {...base,kind:'submit',tool:'expert_teams_update_task',arguments:{task_id:task.id,attempt_id:task.attemptId,status:'in_progress',execution_state:'awaiting_review'},required_fields:['submission_id','publications','output'],reason:'V5 internal material: submit all declared files atomically. Host checks completeness and freezes the version, then completes and advances automatically. This is not an independent content review.'}
  if (run === undefined) return {...base,kind:'complete',tool:'expert_teams_update_task',arguments:{task_id:task.id,attempt_id:task.attemptId,status:'completed'},required_fields:['output'],reason:'This ordinary task has no structured review contract. Submit the completed result with the current attempt; do not invent a report review.'}
  if (isCompactResearch(team)) return {...base,kind:'submit',tool:'expert_teams_update_task',arguments:{task_id:task.id,attempt_id:task.attemptId,status:'in_progress',execution_state:'awaiting_review'},required_fields:['submission_id','publications','output'],reason:'Submit all declared files from this project together. Host atomically publishes and submits this revision, then dispatches its independent reviewer. Use the same submission_id only for an exact retry.'}
  if (missing.length) return {...base,kind:'publish',tool:'expert_teams_publish_artifact',arguments:{task_id:task.id,attempt_id:task.attemptId},required_fields:['source_path','name'],reason:'Publish all missing filenames from this task project, then read back current state before submitting. Do not duplicate an existing unchanged publication.'}
  return {...base,kind:'submit',tool:'expert_teams_update_task',arguments:{task_id:task.id,attempt_id:task.attemptId,status:'in_progress',execution_state:'awaiting_review'},required_fields:['output'],reason:'Submit a nonempty result summary with this attempt_id. The Host checks all required current publications and material receipts before review.'}
}
