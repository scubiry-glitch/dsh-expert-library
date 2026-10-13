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
  for(const m of fresh.members){if(m.runtimeBlock?.code==='HOST_RESTART_UNCONFIRMED'||(!m.runtimeBlock&&!ctx.agents.get(m.id)&&fresh.tasks.some(t=>t.assignee===m.name&&['claimed','in_progress'].includes(t.status))))await call('expert_teams_resume_member',{member:m.name,...(m.runtimeBlock?{expected_block_id:m.runtimeBlock.id}:{}),reason:'User-authorized deployment recovery. Restore this original member and current task/attempt; preserve frozen inputs and all previous evidence.'})}
  const current=JSON.parse(readFileSync(`${root}/${teamId}/team.json`,'utf8'));
  const render=current.tasks.find(t=>t.id==='t7');
  const eventId='v4-t7-reviewed-t10-release-rebind-20261007';
  const owner=current.members.find(m=>m.name===render?.assignee);
  const live=owner&&ctx.agents.get(owner.id);
  if(render?.dependencies.includes('t5')&&render.attempt===1&&live?.status==='idle'&&!live.inbox?.hasPending&&!owner.activation&&!owner.runtimeBlock){
   await call('expert_teams_revise_inputs',{task_id:'t7',source_task_id:'t5',replacement_task_id:'t10',expected_attempt:render.attempt,expected_attempt_id:render.attemptId,...(render.executionState==='blocked_external'?{expected_wait_reason:render.waitReason}:{}),event_id:eventId,reason:'Use independently reviewed six-chapter T10 republication of T9, preserving source T5 lineage and all prior review history.'});
  }
  captain.followup(createUserMessage({source:{kind:'plugin',plugin:name},content:[{type:'text',text:'用户要求修复 V4 新稿换绑并恢复成品制作。Host 已部署 authorized input revision 清除旧 researchInputReleases 并重钉补丁；37 项回归通过，真实 T7→T10 只读预演通过，新 deps=[t6,t10,t1]，T10 release digest=6323d88df3948d6f9f0b85b52a7e32eea7e984faa99c17fd2c18f41bdb908dc2。请读取当前状态：若维护回执已换绑，则继续新 attempt；否则等巧手·阿妙 idle 后用 expert_teams_revise_inputs(task_id=t7,source_task_id=t5,replacement_task_id=t10,expected_attempt=当前值,expected_attempt_id=当前值,event_id=v4-t7-reviewed-t10-release-rebind-20261007,reason=Use independently reviewed six-chapter T10 republication of T9, preserving source T5 lineage and all prior review history.)。如 blocked_external 则同时传完整 expected_wait_reason，不先 resume_task。旧 T7 等待评审的产物是旧稿，勿交旧稿评审。T10 是已独立评审的六章定稿，保留 T6 用户确认历史和 T5 谱系。换绑后由原作者制作六章六图 HTML/PDF，独立评审按真实结果提交；不重建团队、不重新取数、不代审或修改冻结件。模型/配额故障如有则报告精确阻塞，勿反复重启。'}]}));
  record.complete=true;save();clearInterval(timer);
 }catch(e){record.error=String(e);save();clearInterval(timer)}finally{busy=false}
 },3000);ctx.effect(()=>()=>clearInterval(timer));}
