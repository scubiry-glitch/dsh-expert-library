/** Continue the original review after a verified Host-only transport repair. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createUserMessage} from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
export const name='host-transport-recovery';
export const inject=['agents','tools'];
const receipt='/tmp/host-transport-recovery-20261007.json';
const teamPath='/root/.openclaw/workspace/98wiki/expert-teams/98wiki-上海与一线租赁市场见底研判-v3-1-材料绑定修正版/team.json';
export function apply(ctx){
 const started=Date.now();
 const timer=setInterval(()=>{
  if(existsSync(receipt)&&JSON.parse(readFileSync(receipt,'utf8')).accepted){clearInterval(timer);return;}
  if(Date.now()-started>120000){clearInterval(timer);return;}
  const result={at:new Date().toISOString(),pid:process.pid};
  try{
   if(!ctx.tools.get('expert_teams_quality_host_recheck'))return;
   const team=JSON.parse(readFileSync(teamPath,'utf8')),run=team.qualityRuns.t16;
   const captain=ctx.agents.get(team.captainSessionId);if(!captain)return;
   const args={task_id:'t16',expected_run_id:run.runId,expected_review_event_id:run.events.filter(e=>e.type==='review').at(-1).id,
    event_id:'host-transport-recheck-t16-20261007',reason:'Host UTF-8 stdin transport repaired; exact published bytes verified with full Host collector.'};
   const text='用户要求修复 T16 Host 机检通道并继续原流程。根因已确认：冻结包 CLI 对每个 stdin Buffer 单独转字符串，中文跨 chunk 被损坏；直接 import runner 不经过此通道才通过。Host 已上线 base64 原字节传输＋JSON ASCII 元数据转义，冻结包和产物均未修改。真实 before/after：旧通道8/8字节哈希失败，新通道8/8 passed，完整 collectTaskEvidence + recheck 只读预演通过。新增正式 captain-only 工具 expert_teams_quality_host_recheck；请读取当前状态后用你的原队长身份调用 '+JSON.stringify(args)+'。它会再次对原发布字节跑 Host 检查，全部通过才把 blocked 改 reviewing，保留原失败评审与 findings、同一 task attempt 和原修复预算；失败保持原状态。不要 quality_repair，不要 quality_reopen，不要要求作者重发。成功后叫绑定 design-critic 毒舌·尖尖用 prepare_only 更新材料回执，读取本次真实机检，独立复审并用新 review event_id 记录原 f1 的解除依据；通过后你再 quality_integrate(complete_task=true)，继续 T17/T18。不得自动将旧 acceptance=false 改为true，必须由原独立评审者重新判定。T17 视觉仍须补真实宽/窄屏和PDF首中末证据；无图像能力就明确待验收，不得把几何通过当审美通过。旧DAG、旧记录保留。';
   captain.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'plugin',plugin:name}}));
   result.accepted=true;result.runId=run.runId;result.fields=Object.keys(ctx.tools.get('expert_teams_quality_host_recheck').parameters?.properties??{});
  }catch(e){result.error=String(e)}
  writeFileSync(receipt,JSON.stringify(result,null,2),{mode:0o600});
 },5000);ctx.effect(()=>()=>clearInterval(timer));
}
