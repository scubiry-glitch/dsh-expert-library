/** Request a safe deployment boundary through the original captain; no interrupts. */
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createUserMessage} from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import {deliverToMember} from '../../lib/members.js';
export const name='t18-material-quiesce';export const inject=['agents','tools','subagents'];
const file='/tmp/t18-material-quiesce-20261007.json';
const path='/root/.openclaw/workspace/98wiki/expert-teams/98wiki-上海与一线租赁市场见底研判-v3-1-材料绑定修正版/team.json';
export const reason='t18-material-fix-20261007: verified producer identity fix; pause new work for safe deployment';
export function apply(ctx){let busy=false;const timer=setInterval(async()=>{
 if(busy)return;if(existsSync(file)&&JSON.parse(readFileSync(file,'utf8')).accepted){clearInterval(timer);return;}
 const team=JSON.parse(readFileSync(path,'utf8')),captain=ctx.agents.get(team.captainSessionId);if(!captain||!ctx.tools.get('expert_teams_halt'))return;busy=true;
 const record={at:new Date().toISOString(),pid:process.pid};try{
  if(team.halted&&team.haltReason!==reason)throw Error('Another halt retained');
  if(!team.halted){record.halt=await ctx.tools.execute({callId:randomUUID(),name:'expert_teams_halt',arguments:{reason},agent:captain,signal:new AbortController().signal});if(record.halt.isError)throw Error('halt rejected');}
  const text='用户已要求做完 T18 两项修复。Host 已确认真实根因是 quality_review 将 captain 作者查成空 sessionId，原材料回执有效；代码修正已通过 11 项定向回归及完整构建。现在请求安全部署窗口：团队已正式暂停新派发，请保存已完成的工作并结束本轮，不再循环 prepare_only/补回执/重启服务。部署后会通过原工具恢复同一轮次并通知。不要自行 resume，等待部署完成通知。';
  captain.steer(createUserMessage({source:{kind:'plugin',plugin:name},content:[{type:'text',text}]}));
  for(const member of team.members){const live=ctx.agents.get(member.id);if(live&&(live.status==='running'||live.inbox?.hasPending))await deliverToMember(ctx,captain,member.id,text,new AbortController().signal,'steer');}
  record.accepted=true;
 }catch(e){record.error=String(e)}finally{writeFileSync(file,JSON.stringify(record,null,2),{mode:0o600});busy=false;}
 },3000);ctx.effect(()=>()=>clearInterval(timer));}
