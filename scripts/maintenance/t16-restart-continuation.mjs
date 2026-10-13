/** One-shot notice after independently observed Host restart. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createUserMessage} from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
export const name='t16-restart-continuation';
export const inject=['agents'];
const receipt='/tmp/t16-restart-continuation-20261006.json';
export function apply(ctx){
 const timer=setTimeout(()=>{
  if(existsSync(receipt))return;
  const result={at:new Date().toISOString(),pid:process.pid};
  try{
   const captain=ctx.agents.get('session-bdf4fe75-fc8d-4cde-90d7-78f7d84ffd0f');
   if(!captain)throw Error('Original captain not live');
   captain.followup(createUserMessage({content:[{type:'text',text:'用户要求修复完。T16 原子换绑已经成功：attempt 2，point_figures=t20；23:31:17 真实新 checker-output.json 三项全 passed，report.pdf 已重生成。23:31:44 宿主被其他操作重启（非本次恢复动作），阿妙执行中会话冷停；当前 durable T16 active/attempt 2，但 member activation 仍指向重启前一轮且无 live agent。请先核对 T16 input manifest、已生成产物与当前成员 runtime，然后使用正式 expert_teams_resume_member(member="巧手·阿妙", reason=重启后续做已核验的第2轮提交...) 恢复原成员；若先被调度标记 HOST_RESTART_UNCONFIRMED，带当前 expected_block_id 精确恢复。保持 attempt 2 和新 T20 输入，勿再次换绑或新建任务。让阿妙继续发布五件套再正式独立审核/集成推进 T17/T18。不要代审或代用户放行；后续有具体工具错误请发共享任务信箱。'}],source:{kind:'plugin',plugin:name}}));
   result.accepted=true;
  }catch(e){result.error=String(e)}
  writeFileSync(receipt,JSON.stringify(result,null,2),{mode:0o600});
 },12000);ctx.effect(()=>()=>clearTimeout(timer));
}
