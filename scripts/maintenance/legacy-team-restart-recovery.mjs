/** Notify the original captain once per Host process about interrupted native work.
 * No agent ownership, state mutation, automatic review, or automatic block release. */
import {readFileSync,writeFileSync,existsSync,appendFileSync} from 'node:fs';
import {createUserMessage} from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
export const name='legacy-team-restart-recovery';
export const inject=['agents'];
const teamPath='/root/.openclaw/workspace/98wiki/expert-teams/98wiki-上海与一线租赁市场见底研判-v3-1-材料绑定修正版/team.json';
const receipt='/tmp/legacy-team-restart-recovery-20261006.json';
const audit='/tmp/legacy-team-restart-recovery-20261006.jsonl';
export function apply(ctx){
 const timer=setTimeout(()=>{
  if(existsSync(receipt)&&JSON.parse(readFileSync(receipt,'utf8')).pid===process.pid)return;
  const result={at:new Date().toISOString(),pid:process.pid};
  try{
   const team=JSON.parse(readFileSync(teamPath,'utf8'));
   const pending=team.tasks.filter(t=>!['completed','failed','cancelled'].includes(t.status));
   if(team.halted||!pending.length)return;
   const cold=team.members.filter(m=>m.status!=='removed'&&!ctx.agents.get(m.id)
     &&(m.activation||m.runtimeBlock?.code==='HOST_RESTART_UNCONFIRMED'));
   if(!cold.length)return;
   const captain=ctx.agents.get(team.captainSessionId);if(!captain)throw Error('Original captain not live; no replacement created');
   const detail=cold.map(m=>({member:m.name,activationId:m.activation?.id,blockId:m.runtimeBlock?.id}));
   const tasks=pending.map(t=>({id:t.id,status:t.status,executionState:t.executionState,attempt:t.attempt,assignee:t.assignee}));
   const text='用户已明确要求继续修复完成。本次宿主重启后，发现原团队仍有未完成工作，但以下成员的已接受执行保留在 durable activation 中而当前没有 live agent：'+JSON.stringify(detail)+'。当前任务：'+JSON.stringify(tasks)+'。请作为原队长核对真实任务产物、评审状态和重启时间，然后通过 expert_teams_resume_member 对这些原成员精确续做（如出现 HOST_RESTART_UNCONFIRMED，带完整当前 expected_block_id）；不要重建任务、重置 attempt 或直接编辑 team.json，不释放其他 provider/额度 blocker。T16 若已 awaiting_review，应恢复 design-critic 毒舌·尖尖的既有独立评审；不要叫作者重复提交，也不要改派普通研究专家，不能把自动检查通过当独立 pass。正式评审集成后按原 DAG 推进 T17/T18。这个通知仅每个 Host 进程一次，没有自动代审/自动放行。';
   captain.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'plugin',plugin:name}}));
   result.accepted=true;result.coldMembers=detail;result.tasks=tasks;
  }catch(e){result.error=String(e)}
  writeFileSync(receipt,JSON.stringify(result,null,2),{mode:0o600});
  appendFileSync(audit,JSON.stringify(result)+'\n',{mode:0o600});
 },20000);ctx.effect(()=>()=>clearTimeout(timer));
}
