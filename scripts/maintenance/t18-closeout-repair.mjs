/** User-authorized author correction via original captain tools; no review verdicts or state-file writes. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {requireTaskMaterialDelivery} from '../../lib/task-material-binding.js';
import {createUserMessage} from '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
export const name='t18-closeout-repair'; export const inject=['agents','tools'];
const base='/root/.openclaw/workspace/98wiki/expert-teams/98wiki-上海与一线租赁市场见底研判-v3-1-材料绑定修正版';
const receipt='/tmp/t18-closeout-repair-20261007.json', control='/tmp/t18-closeout-control-20261007.json';
const sha=v=>createHash('sha256').update(v).digest('hex');
const readTeam=()=>JSON.parse(readFileSync(`${base}/team.json`,'utf8'));
export function apply(ctx){let busy=false;const timer=setInterval(async()=>{
 if(busy||!existsSync(control))return;
 const c=JSON.parse(readFileSync(control,'utf8'));if(!c.verified||c.beforePid===process.pid)return;
 let record=existsSync(receipt)?JSON.parse(readFileSync(receipt,'utf8')):{steps:[]};if(record.complete){clearInterval(timer);return;}
 const save=()=>writeFileSync(receipt,JSON.stringify(record,null,2),{mode:0o600});
 let team=readTeam(),task=team.tasks.find(t=>t.id==='t18');const captain=ctx.agents.get(team.captainSessionId);
 if(!captain||captain.status!=='idle'||captain.inbox?.hasPending||!ctx.tools.get('expert_teams_publish_artifact'))return;
 busy=true;
 try{
  if(task.assignee!=='captain'||task.attemptId!==c.attemptId)throw Error('Current ownership/attempt changed; preserve it');
  if(team.halted&&team.haltReason!=='t18-material-fix-20261007: verified producer identity fix; pause new work for safe deployment')throw Error('Unrelated halt retained');
  if(['completed','failed','cancelled'].includes(task.status))throw Error('Task is terminal; preserve reviewed publications');
  requireTaskMaterialDelivery(task,captain.id,task.attempt,'producer');
  record.producerReceipt=task.taskMaterialDeliveries.find(r=>r.sessionId===captain.id&&r.role==='producer'&&r.attempt===task.attempt);
  const call=async(name,args)=>{const result=await ctx.tools.execute({callId:`t18-fix-${randomUUID()}`,name,arguments:args,agent:captain,signal:new AbortController().signal});record.steps.push({at:new Date().toISOString(),pid:process.pid,name,args,result});save();if(result.isError)throw Error(`${name} rejected`);return result;};
  if(team.halted)await call('expert_teams_resume',{reason:'T18 captain 作者材料校验修复已通过 11 项回归并上线，恢复原轮次清单更正与独立评审。'});
  const pubs=task.publishedArtifacts.filter(a=>a.attempt===task.attempt&&a.reviewId==='published:delivery-check.md');const current=pubs.at(-1);if(!current)throw Error('No published checklist');
  const raw=readFileSync(`${base}/${task.project.artifactsPath}/${current.relativePath}`);if(sha(raw)!==current.sha256)throw Error('Published source bytes mismatch');
  let text=raw.toString('utf8');const before=text;
  for(const id of ['t1','t2','t3']){
   const events=team.qualityRuns[id].events,review=events.filter(e=>e.type==='review').at(-1),integration=events.filter(e=>e.type==='integration').at(-1);
   const line=text.split('\n').find(l=>l.startsWith(`| ${id} `));if(!line||!review||!integration)throw Error(`Missing audit row ${id}`);
   const cells=line.split('|');cells[3]=` \`${review.id}\` `;cells[5]=` \`${integration.id}\` `;text=text.replace(line,cells.join('|'));
  }
  const line=text.split('\n').find(l=>l.startsWith('评审人身份'));if(!line)throw Error('Reviewer paragraph missing');
  const rows=team.tasks.filter(t=>t.id!=='t18').flatMap(t=>{const review=team.qualityRuns?.[t.id]?.events.filter(e=>e.type==='review').at(-1);return review?[`${t.id}（${review.actor}）`]:[]});
  text=text.replace(line,'评审人身份（逐项核对 Host 已入账 review 事件）：'+rows.join('；')+'。t5、t14 为用户门回执，不冒充专家独立评审；t16 评审人毒舌·尖尖符合 design-critic 角色要求。');
  record.sourceSha256=current.sha256;record.correctedSha256=sha(text);record.attemptId=task.attemptId;save();
  if(text!==before){
   if(!['pending','repairing'].includes(team.qualityRuns.t18.status))throw Error('Reviewed verdict exists; use its formal repair flow');
   if(task.executionState==='awaiting_review')await call('expert_teams_quality_reopen',{task_id:'t18',event_id:'t18-audit-author-correction-20261007',reason:'用户要求更正 T1/T2/T3 六个事件 ID 与评审人归属；尚无正式评审入账，撤回未审提交，保留同一轮次、预算和旧发布件。'});
   team=readTeam();task=team.tasks.find(t=>t.id==='t18');if(task.attemptId!==c.attemptId||task.executionState==='awaiting_review'||task.publishedArtifacts.at(-1).id!==current.id)throw Error('Concurrent task/publication change; retry after inspection');
   writeFileSync(`${base}/${task.project.artifactsPath}/delivery-check.corrected.md`,text);
   await call('expert_teams_publish_artifact',{task_id:'t18',attempt_id:task.attemptId,source_path:'artifacts/delivery-check.corrected.md',name:'delivery-check.md',media_type:'text/markdown',description:'按 Host 权威事件记录更正 T1–T3 六个事件 ID，并逐节点列明真实评审人；保留视觉/实印待验收。'});
  }
  team=readTeam();task=team.tasks.find(t=>t.id==='t18');
  if(task.executionState!=='awaiting_review')await call('expert_teams_update_task',{task_id:'t18',attempt_id:task.attemptId,status:'in_progress',execution_state:'awaiting_review',output:`终检清单审计链更正完成。delivery-check.md 当前修正版 SHA256 ${record.correctedSha256}，T1/T2/T3 六个 review/integration ID 及逐节点评审人来自 Host 已入账事件。原成品、历史发布版本和当前 attempt 保留；图像审美与实印仍待验收。请非作者对新发布版本独立复核。`});
  const reviewer=team.members.find(m=>m.name==='能级参谋·城市分化');if(reviewer?.runtimeBlock){if(reviewer.runtimeBlock.code!=='HOST_RESTART_UNCONFIRMED')throw Error('Reviewer has unrelated runtime blocker');await call('expert_teams_resume_member',{member:reviewer.name,expected_block_id:reviewer.runtimeBlock.id,reason:'已核对本次部署重启中断；续接 T18 同轮独立评审，清单修正版已发布，先读当前发布哈希再准备材料。'});}
  await call('expert_teams_send_message',{to:'能级参谋·城市分化',idempotency_key:'t18-corrected-audit-review-20261007',content:`用户要求的两项已处理：Host 评审入口原先以空 sessionId 校验 captain 作者，现在已修复；生产者真实材料回执保留有效。T18 六个事件 ID 与评审人段按已入账事件更正并正式重发，新 delivery-check.md SHA256 ${record.correctedSha256}。请重新 quality_review(task_id=t18,prepare_only=true)，读取返回材料和精确新文件，核对审计链后按真实结果提交独立 verdict；不要沿用旧材料回执，不代签视觉/实印。当前 attempt_id ${task.attemptId}。`});
  captain.steer(createUserMessage({source:{kind:'plugin',plugin:name},content:[{type:'text',text:'用户要求的 T18 两项修复已完成：captain 作者材料校验遗漏已修复并通过回归，原真实回执保留；审计清单已按 Host 事件修正、通过你所属原生工具重发并送交能级参谋独立评审。请查看当前状态，勿重复重发或改派；等待非作者正式 verdict 后按原流程集成。视觉/实印继续待验收。'}]}));
  record.complete=true;record.pid=process.pid;record.at=new Date().toISOString();delete record.error;save();clearInterval(timer);
 }catch(e){record.error=String(e);record.errorAt=new Date().toISOString();save();clearInterval(timer);}
 finally{busy=false;}
 },3000);ctx.effect(()=>()=>clearInterval(timer));}
