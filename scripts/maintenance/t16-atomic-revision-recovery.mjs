/** One-shot recovery notice to the already-owned original captain. No state edits. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createUserMessage} from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
export const name='t16-atomic-revision-recovery';
export const inject=['agents','tools'];
const receipt='/tmp/t16-atomic-revision-recovery-20261006.json';
const path='/root/.openclaw/workspace/98wiki/expert-teams/98wiki-上海与一线租赁市场见底研判-v3-1-材料绑定修正版/team.json';
export function apply(ctx){
 const timer=setTimeout(()=>{
  if(existsSync(receipt))return;
  const result={at:new Date().toISOString(),pid:process.pid};
  try{
   const fields=Object.keys(ctx.tools.get('expert_teams_revise_inputs')?.parameters?.properties??{});
   if(!fields.includes('expected_wait_reason'))throw Error('Atomic input revision tool is not loaded');
   const team=JSON.parse(readFileSync(path,'utf8'));const task=team.tasks.find(t=>t.id==='t16');
   const captain=ctx.agents.get(team.captainSessionId);
   if(!captain)throw Error('Original captain is not live; no replacement owner created');
   const args={task_id:'t16',source_task_id:'t15',replacement_task_id:'t20',expected_attempt:task.attempt,
    expected_attempt_id:task.attemptId,expected_wait_reason:task.waitReason,event_id:'t16-figures-t20-atomic-20261006',
    reason:'用户要求修复 T16 卡住：将已独立评审并集成的 T20 图卡替换旧 T15 输入，与解除这次输入阻塞同一事务完成，保留旧输入和质量历史。'};
   const text='用户明确要求继续修复完。T16 的 resume→revise 竞态已在核心修复上线，39 项定向测试通过，真实输入只读预演通过。expert_teams_revise_inputs 新参数 expected_wait_reason 可在同一原子操作中解除匹配的外部等待并换绑；无需先 resume_task。请使用你自己的原队长身份直接调用该工具：'+JSON.stringify(args)+'。调用前检查当前状态，若已成功换绑则勿重复新事件；若 owner 忙，等其停止而非抢占；若状态变化应重新核对原因，不跳过 runtime/human/quality 门。成功后 T16 为 attempt 2，新 attempt_id 由调度器派发；请核对 manifest 包含 T19 正文、T13 评审、T20 两份图卡和 T6 提纲。通知阿妙用新钉扎材料重跑 build_t16/build_ledger/run_checker、发布五件套、真实独立评审集成后推进 T17/T18。冻结工艺 Python 一律 python3 -B -I，防止再次生成 __pycache__。旧 DAG、旧输入和旧评审不修改、不迁移 v4。若有下一处运行错误，提供具体 tool error / finding，勿把通知已送达当完成。';
   captain.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'plugin',plugin:name}}));
   result.accepted=true;result.captainSessionId=captain.id;result.status=captain.status;result.fields=fields;
  }catch(e){result.error=String(e)}
  writeFileSync(receipt,JSON.stringify(result,null,2),{mode:0o600});
 },18000);ctx.effect(()=>()=>clearTimeout(timer));
}
