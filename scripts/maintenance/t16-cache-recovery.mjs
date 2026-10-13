/** Notify the already-owned original captain after verifying its frozen craft bytes. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {verifyFrozenSkillCraftContract} from '../../lib/skill-craft.js';
import {createUserMessage} from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
export const name='t16-cache-recovery';
export const inject=['agents'];
const receipt='/tmp/t16-cache-recovery-receipt-20261006.json';
const path='/root/.openclaw/workspace/98wiki/expert-teams/98wiki-上海与一线租赁市场见底研判-v3-1-材料绑定修正版/team.json';
export function apply(ctx){
 const timer=setTimeout(()=>{
  if(existsSync(receipt))return;
  const result={at:new Date().toISOString()};
  try{
   const team=JSON.parse(readFileSync(path,'utf8'));const task=team.tasks.find(t=>t.id==='t16');
   verifyFrozenSkillCraftContract(task.frozenSkillCraftContract);
   const captain=ctx.agents.get(team.captainSessionId);if(!captain)throw Error('Original captain is not live; do not create a replacement owner');
   captain.followup(createUserMessage({content:[{type:'text',text:'用户问任务是否又卡住，已定位旧流程 T16 blocked_external 原因：SKILL_CRAFT_PATH scripts/__pycache__。该目录仅含 Python 自动生成 build-report.cpython-311.pyc，现已隔离至 /tmp/t16-python-cache-quarantine-20261006-2316；verifyFrozenSkillCraftContract(T16) 已通过，原 frozen treeDigest 4504bbb23651b13a8a7c04e5f823dfd494798b76f02d7095a1b4a5ca38d8dd59 完全恢复，未改工艺与验收。请继续原团队当前流程，用正式任务工具解除已消失的输入阻塞并推进。注意 T20 已 completed/integrated，但 T16 的 point_figures 输入目前尚未从 T15 改绑到 T20；须按正式输入修订流程处理并核对当前 owner/attempt，勿让渲染再次采用旧图卡。若 resume_task 立即派发妨碍改绑，应如实报告这一原子操作缺口，不直接改 team.json。Python 导入冻结包工具必须使用 python3 -B（包括 -I 时也显式加 -B），不能在发布包内生成 __pycache__。不要新建替代队长、代审或代用户放行；完成 T16 正式审核后再推进 T17/T18。'}],source:{kind:'plugin',plugin:name}}));
   result.accepted=true;result.captainSessionId=captain.id;result.status=captain.status;
  }catch(e){result.error=String(e)}
  writeFileSync(receipt,JSON.stringify(result,null,2),{mode:0o600});
 },12000);ctx.effect(()=>()=>clearTimeout(timer));
}
