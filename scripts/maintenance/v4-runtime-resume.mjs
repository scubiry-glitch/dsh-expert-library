import {compactReviewer} from '../../lib/research-release.js';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createUserMessage} from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
export const name='v4-runtime-resume';export const inject=['agents','tools'];
const root='/root/.openclaw/workspace/98wiki/expert-teams',teamId='v4试跑-上海租赁证据复核-01',receipt=`/tmp/v4-runtime-resume-${process.pid}.json`;
export function apply(ctx){let busy=false;const timer=setInterval(async()=>{
 if(busy||existsSync(receipt))return;const team=JSON.parse(readFileSync(`${root}/${teamId}/team.json`,'utf8'));
 const captain=ctx.agents.get(team.captainSessionId);if(!captain||captain.status!=='idle')return;busy=true;
 const record={at:new Date().toISOString(),steps:[]};const save=()=>writeFileSync(receipt,JSON.stringify(record,null,2),{mode:0o600});
 try{
  const plan=JSON.parse(readFileSync(`${root}/plans/${team.planRef.planId}.json`,'utf8'));const route=plan.plan.captainModel;
  if(!route?.model||!route.provider)throw Error('Missing approved captain route');
  record.beforeOptions={provider:captain.options.provider,model:captain.options.model,reasoningEffort:captain.options.reasoningEffort};
  if(!captain.options.model)Object.assign(captain.options,route);
  if(captain.options.model!==route.model||captain.options.provider!==route.provider)throw Error('Live route differs from approved plan; no replacement');
  record.restoredRoute=route;save();
  const call=async(name,args)=>{const result=await ctx.tools.execute({callId:randomUUID(),name,arguments:args,agent:captain,signal:new AbortController().signal});record.steps.push({name,args,result});save();if(result.isError)throw Error(name+' rejected')};
  if(team.captainRuntimeBlock?.code==='UNKNOWN'&&team.captainRuntimeBlock.message.includes('{{model}}'))await call('expert_teams_resume_member',{member:'captain',expected_block_id:team.captainRuntimeBlock.id,reason:'Restored missing captain runtime model options from this user-approved plan.captainModel; no model migration.'});
  const fresh=JSON.parse(readFileSync(`${root}/${teamId}/team.json`,'utf8'));
  for(const m of fresh.members){if(m.runtimeBlock?.code==='HOST_RESTART_UNCONFIRMED'||(!m.runtimeBlock&&!ctx.agents.get(m.id)&&fresh.tasks.some(t=>t.assignee===m.name&&['claimed','in_progress'].includes(t.status))))await call('expert_teams_resume_member',{member:m.name,...(m.runtimeBlock?{expected_block_id:m.runtimeBlock.id}:{}),reason:'Verified deployment restart and current task T5 attempt 4. Restore original member and same attempt; preserve frozen inputs and all previous evidence.'})}
  const reviewedTeam=JSON.parse(readFileSync(`${root}/${teamId}/team.json`,'utf8'));
  for(const task of reviewedTeam.tasks){
   if(task.executionState!=='awaiting_review')continue;
   const reviewer=compactReviewer(reviewedTeam,task);
   if(reviewer)await call('expert_teams_send_message',{to:reviewer,idempotency_key:`v4-restart-review:${process.pid}:${task.id}:${task.attempt}`,content:`本次维护重载已恢复，${task.id} attempt ${task.attempt} 已冻结提交，仍待你独立复核。请读取当前正式发布三件套，重新 prepare_only 取得材料回执，再按真实结果评审；不要另开任务或消耗作者修订次数来解锁。技术异常用 wait_external。原作者与用户正文确认边界保留。`});
  }
  captain.followup(createUserMessage({source:{kind:'plugin',plugin:name},content:[{type:'text',text:'已从本计划批准的 captainModel 恢复冷启动缺失的模型变量，原队长身份和路由不变；已按真实重启 blocker 原生恢复成员。T5 已通过用户明确授权续跑到 attempt 4，作者需要补足台账后提交三件套；原副本与修复候选在其 artifacts/technical-recovery-20261007。请继续原团队，必要时确认原作者状态并安排原非作者独立评审；T6 仍待用户确认。不要再次重建计划、改派或重置预算。'}]}));
  record.complete=true;save();clearInterval(timer);
 }catch(e){record.error=String(e);save();clearInterval(timer)}finally{busy=false}
 },3000);ctx.effect(()=>()=>clearInterval(timer));}
