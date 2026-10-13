/** Read-only runtime capability/idle probe. Owns no agents and sends no messages. */
import { writeFileSync } from 'node:fs'
export const name = 'compact-v4-runtime-probe'
export const inject = ['agents','tools']
export function apply(ctx) {
  const activity = new Map()
  ctx.on('session/event', (session, event) => {
    activity.set(session.id, { ...(activity.get(session.id) ?? {}), lastEvent: event.type, lastEventAt: event.time })
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent) activity.set(exec.agent.id, { ...(activity.get(exec.agent.id) ?? {}), activeTool: exec.name, toolStartedAt: Date.now() })
    try { return await next() } finally {
      if (exec.agent) activity.set(exec.agent.id, { ...(activity.get(exec.agent.id) ?? {}), activeTool: null, toolFinishedAt: Date.now() })
    }
  })
  const sample = () => {
    const agents = ctx.agents.list().map(a => ({ id:a.id,status:a.status, pendingNextStep:a.inbox?.nextStep?.length ?? 0, pendingNextTurn:a.inbox?.nextTurn?.length ?? 0, activity:activity.get(a.id) }))
    const fields = name => Object.keys(ctx.tools.get(name)?.parameters?.properties ?? {})
    writeFileSync('/tmp/compact-v4-runtime-probe.json',JSON.stringify({ at:new Date().toISOString(), pid:process.pid, agents,
      researchFlows:ctx.tools.get('expert_teams_plan_stage')?.parameters?.properties?.research_flow?.enum,stageFields:fields('expert_teams_plan_stage'),submitFields:fields('expert_teams_update_task'),reviewFields:fields('expert_teams_quality_review'),revisionFields:fields('expert_teams_revise_inputs') },null,2),{mode:0o600})
  }
  const timer=setInterval(sample,3000); sample();ctx.effect(()=>()=>clearInterval(timer))
}
