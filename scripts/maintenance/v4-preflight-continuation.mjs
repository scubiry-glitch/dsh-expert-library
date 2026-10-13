/** User-authorized continuation via the original captain's native tool. Never writes team state or verdicts. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createUserMessage} from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
export const name='v4-preflight-continuation';export const inject=['agents','agentPresets','tools'];
const id='session-74cd0a6e-271b-4426-8e13-9251fb198390',root='/root/.openclaw/workspace/98wiki/expert-teams/v4试跑-上海租赁证据复核-01';
const control='/tmp/v4-preflight-deploy-control.json',receipt='/tmp/v4-preflight-continuation.json';
export function apply(ctx){let busy=false;const timer=setInterval(async()=>{
 if(busy||!existsSync(control))return;const c=JSON.parse(readFileSync(control,'utf8'));if(!c.verified||c.beforePid===process.pid||!ctx.tools.get('expert_teams_quality_continue'))return;
 let record=existsSync(receipt)?JSON.parse(readFileSync(receipt,'utf8')):{steps:[]};if(record.complete){
  if(!ctx.agents.get(id)){busy=true;try{await ctx.agents.resume({resumeSessionId:id,agentOptions:JSON.parse(readFileSync('/root/.openclaw/workspace/98wiki/expert-teams/plans/plan-e3d2736b7e8fb5692538f17b7c89e333.json','utf8')).plan.captainModel,setup:async x=>{await ctx.agentPresets.mount(x,'zhijian')}})}finally{busy=false}}
  clearInterval(timer);return
 }busy=true;
 const save=()=>writeFileSync(receipt,JSON.stringify(record,null,2),{mode:0o600});
 try{
  const captain=ctx.agents.get(id)??(await ctx.agents.resume({resumeSessionId:id,agentOptions:JSON.parse(readFileSync('/root/.openclaw/workspace/98wiki/expert-teams/plans/plan-e3d2736b7e8fb5692538f17b7c89e333.json','utf8')).plan.captainModel,setup:async x=>{await ctx.agentPresets.mount(x,'zhijian')}})).agent;
  if(captain.status!=='idle'||captain.inbox?.hasPending)return;
  let team=JSON.parse(readFileSync(root+'/team.json','utf8'));if(team.captainSessionId!==captain.id)throw Error('Captain mismatch');
  const reason='用户已授权先修复并继续原会话。提交预检/回执来源校验/总论副标题兼容已修复；冻结 attempt-3 保留。作者从 artifacts/technical-recovery-20261007 三件候选文件继续（正文目前逐字不变），补齐 Host 预检发现的第四章 32.31% 引文台账及所有后续预检漏项，核对真实来源、单位与算术。不要修改 attempt-* 冻结目录。evidence-merge.inputs 恰为 research_main/research_counter；provider_receipt 使用团队相对 response/call 路径及哈希。evidence 改动必须同步 ledger.evidenceSha256。提交新 attempt 三件套后由原独立评审重新 prepare 并按真实结果评审；技术错误用 wait_external，不伪造内容失败。T6 仍由用户确认正文。';
  const args={task_id:'t5',expected_run_id:c.expectedRunId,event_id:'v4-t5-user-continuation-20261007',reason,user_decision:'按照你的想法先修复一下，然后继续推进这个会话进展。',additional_repair_rounds:2};
  const result=await ctx.tools.execute({callId:randomUUID(),name:'expert_teams_quality_continue',arguments:args,agent:captain,signal:new AbortController().signal});record.steps.push({at:new Date().toISOString(),pid:process.pid,name:'expert_teams_quality_continue',args,result});save();if(result.isError)throw Error('Native continuation rejected');
  captain.followup(createUserMessage({source:{kind:'plugin',plugin:name},content:[{type:'text',text:'用户要求修复并继续，本次 Host 修复已部署并通过回归，已通过你的原生工具对 T5 完成有审计记录的续跑授权，旧三轮/关闭记录均保存，没有代审。请查看当前任务，让作者完成三件套提交预检及独立评审；若遇 HOST_RESTART_UNCONFIRMED 按状态里的精确 block id 恢复对应成员。不要重建团队/重新取数/修改冻结件。'+reason}]}));
  delete record.error;record.complete=true;record.pid=process.pid;record.at=new Date().toISOString();save();clearInterval(timer);
 }catch(e){record.error=String(e);save();clearInterval(timer)}finally{busy=false}
 },3000);ctx.effect(()=>()=>clearInterval(timer));}
