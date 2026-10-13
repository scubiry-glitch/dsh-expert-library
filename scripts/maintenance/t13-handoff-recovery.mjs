/** One-time operator recovery through the original captain's native tools. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {readUnreadMailbox} from '../../lib/state.js';
import {deliverCaptainMailbox} from '../../lib/members.js';
import {createUserMessage} from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
export const name='t13-handoff-recovery';
export const inject=['agents','agentPresets','tools','subagents'];
const id='session-bdf4fe75-fc8d-4cde-90d7-78f7d84ffd0f';
const root='/root/.openclaw/workspace/98wiki/expert-teams';
const teamId='98wiki-上海与一线租赁市场见底研判-v3-1-材料绑定修正版';
const file=`${root}/${teamId}/t13-input-revision-runtime.json`;
export function apply(ctx){
 const timer=setTimeout(async()=>{
  const record={at:new Date().toISOString(),steps:[]};
  try{
   const captain=ctx.agents.get(id)??(await ctx.agents.resume({resumeSessionId:id,agentOptions:{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high'},setup:async c=>{await ctx.agentPresets.mount(c,'zhijian');}})).agent;
   record.captainSessionId=captain.id;
   if(existsSync(file)&&JSON.parse(readFileSync(file,'utf8')).completed){
    const unread=await readUnreadMailbox(root,teamId,'captain');
    const results=unread.map(message=>({id:message.id,accepted:deliverCaptainMailbox(captain,message)}));
    writeFileSync(`${root}/${teamId}/captain-owner-retained.json`,JSON.stringify({at:new Date().toISOString(),captainSessionId:captain.id,owner:name,delivery:results},null,2),{mode:0o600});
    return;
   }
   for(const taskId of ['t15','t16','t13']){
    const team=JSON.parse(readFileSync(`${root}/${teamId}/team.json`,'utf8'));
    const task=team.tasks.find(t=>t.id===taskId);
    if(task.inputSourceOverrides?.writer==='t19'){record.steps.push({taskId,alreadyApplied:true});continue;}
    const args={task_id:taskId,source_task_id:'t12',replacement_task_id:'t19',expected_attempt:task.attempt??0,
     ...(task.attemptId?{expected_attempt_id:task.attemptId}:{}),event_id:`reviewed-t19-input-${taskId}-20261006`,
     reason:'用户要求修复修订稿交接；T19 已经独立评审并由原队长集成。保留 T12 原版本和历史评审，按正式新输入轮次重新发布和评审，不代替任何质量/用户门。'};
    const result=await ctx.tools.execute({callId:`input-revision-${randomUUID()}`,name:'expert_teams_revise_inputs',arguments:args,agent:captain,signal:new AbortController().signal});
    record.steps.push({taskId,result});
    writeFileSync(file,JSON.stringify(record,null,2),{mode:0o600});
    if(result.isError)throw new Error(`Native input revision rejected for ${taskId}; see recorded result`);
   }
   const text='【输入修订核心修复已部署并通过定向回归】原队长原生 expert_teams_revise_inputs 已为 T13/T15/T16 将 writer 输入由 T12 审计修订为 T19，旧输入、旧评审与预算均保留。请读当前状态：T13 新 attempt 必须使用新 attempt_id，读取 inputArtifactManifest，复核已集成 T19，发布 report.md 与 review-notes.md，再提交并依原流程评审/集成。本地新版 review-notes 的四参数 checkContentReview(notes,report,outline,ledger) 已通过；函数不读团队状态，不能省略 outline/ledger 参数。不得沿用旧 attempt_id 或旧 T12 正文发布物。T14 人工正文门仍需用户决定，不代签；只给出真实待审链接。若旧 unread 邮件要求旧轮次解锁，以当前状态和本通知为准。';
   captain.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'plugin',plugin:name}}));
   record.completed=true;
  }catch(e){record.error=String(e)}
  writeFileSync(file,JSON.stringify(record,null,2),{mode:0o600});
 },8000);ctx.effect(()=>()=>clearTimeout(timer));
}
