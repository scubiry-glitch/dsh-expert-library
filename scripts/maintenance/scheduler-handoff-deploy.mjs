/** Operator-controlled quiescence/recovery using native tools on the original owner.
 * No task-state edits, replacement captain, review verdicts or gate overrides. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createUserMessage} from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
export const name='scheduler-handoff-deploy';
export const inject=['agents','tools'];
const control='/tmp/scheduler-handoff-control-20261007.json';
const receipt='/tmp/scheduler-handoff-deploy-20261007.json';
const path='/root/.openclaw/workspace/98wiki/expert-teams/98wiki-上海与一线租赁市场见底研判-v3-1-材料绑定修正版/team.json';
const haltReason='scheduler-handoff-20261007: 用户要求先修复调度机制，再恢复原任务；部署前保存当前执行。';
export function apply(ctx){
 let busy=false;
 const timer=setInterval(async()=>{
  if(busy||!existsSync(control))return;busy=true;
  let record=existsSync(receipt)?JSON.parse(readFileSync(receipt,'utf8')):{steps:[]};
  const save=()=>writeFileSync(receipt,JSON.stringify(record,null,2),{mode:0o600});
  try{
   const config=JSON.parse(readFileSync(control,'utf8'));
   if(!['quiesce','recover'].includes(config.phase))return;
   let team=JSON.parse(readFileSync(path,'utf8'));const captain=ctx.agents.get(team.captainSessionId);
   if(!captain||!ctx.tools.get('expert_teams_halt'))return;
   const call=async(name,args)=>{const result=await ctx.tools.execute({callId:`handoff-${randomUUID()}`,name,arguments:args,agent:captain,signal:new AbortController().signal});record.steps.push({at:new Date().toISOString(),pid:process.pid,name,args,result});save();if(result.isError)throw Error(`${name} rejected`);return result};
   if(config.phase==='quiesce'&&!record.quiesced){
    if(team.halted&&team.haltReason!==haltReason)throw Error('Another halt owns the team; preserve it');
    if(!team.halted)await call('expert_teams_halt',{reason:haltReason});
    captain.steer(createUserMessage({source:{kind:'plugin',plugin:name},content:[{type:'text',text:'用户要求先修复调度机制，再恢复当前任务。新调度代码已通过 78/78 定向回归与完整构建，现在部署前团队已通过正式 halt 暂停新派发。请保存当前进展并结束本轮，等待部署完成通知；不要自行 resume、重启服务、改写团队状态或重新创建任务。当前 T18 的 attempt 与全部评审产物保留。'}]}));
    record.quiesced=true;record.quiescedPid=process.pid;record.at=new Date().toISOString();save();
   }
   if(config.phase==='recover'&&!record.recovered){
    if(config.verified!==true||config.beforePid===process.pid)throw Error('Verified deployment/new process required before recovery');
    if(team.halted){if(team.haltReason!==haltReason)throw Error('Unrelated halt retained');await call('expert_teams_resume',{reason:'调度修复已构建并通过 78/78 定向回归；恢复原团队原任务轮次，保留质量与用户门。'});}
    team=JSON.parse(readFileSync(path,'utf8'));
    const task=team.tasks.find(t=>t.id==='t18');
    const member=team.members.find(m=>m.name===task?.assignee&&m.status!=='removed');
    if(task&&!['completed','failed','cancelled'].includes(task.status)&&member){
     if(member.runtimeBlock&&member.runtimeBlock.code!=='HOST_RESTART_UNCONFIRMED')throw Error('Unrelated member blocker retained');
     if(!ctx.agents.get(member.id)&&(member.activation||member.runtimeBlock))await call('expert_teams_resume_member',{member:member.name,reason:'调度修复部署完成；已核对 T16/T17 集成、T18 原 attempt 与重启中断，续接当前终检，不创建新轮次。',...(member.runtimeBlock?{expected_block_id:member.runtimeBlock.id}:{})});
     await call('expert_teams_send_message',{to:member.name,idempotency_key:'handoff-fix-t18-20261007',content:'用户要求先根治调度再恢复任务：修复已部署并通过定向回归。请读取当前 T18 状态：已有 attempt 时用原 attempt_id 继续终检；尚 pending 才正式 claim。T16/T17 已集成，落实 T17 页码文字更正与原始探针证据问题，发布 delivery-check.md 后 awaiting_review。视觉审美/实印仍待验收，不能代用户签字。不要重启服务、重复开轮次或改写 team.json。'});
    }
    captain.steer(createUserMessage({source:{kind:'plugin',plugin:name},content:[{type:'text',text:'调度修复已部署并验证；团队通过原生工具恢复，原 T18 的 attempt 保留。请根据实际 T18 提交安排非作者独立评审并集成，完成交付；所有视觉/实印未验收项如实登记。不要自行重启宿主。'}]}));
    record.recovered=true;record.recoveredPid=process.pid;record.at=new Date().toISOString();save();clearInterval(timer);
   }
  }catch(e){record.error=String(e);record.errorAt=new Date().toISOString();save();}
  finally{busy=false}
 },3000);ctx.effect(()=>()=>clearInterval(timer));
}
