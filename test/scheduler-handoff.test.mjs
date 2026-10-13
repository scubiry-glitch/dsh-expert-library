import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {installTeamScheduler, HANDOFF_CHECK_MS, HANDOFF_ALERT_MS} from '../lib/scheduler.js'
import {createTeamDir, readTeam, writeTeam, appendMailbox, createMessage, readMailbox} from '../lib/state.js'
const protocol = Symbol.for('dsh.subagent.deliverPrompt')
const pendingTask = () => ({id:'t18',subject:'final QA',status:'pending',attempt:0,assignee:'worker',dependencies:['t17'],createdAt:1,updatedAt:1})
const completedTask = () => ({id:'t17',subject:'review',status:'completed',assignee:'worker',dependencies:[],createdAt:1,updatedAt:2})
async function eventually(fn) { for(let i=0;i<300;i++){if(await fn())return;await new Promise(r=>setTimeout(r,5))}assert.fail('did not settle') }
async function fixture(t) {
 const workspace=await mkdtemp(join(tmpdir(),'handoff-')),root=join(workspace,'.teams')
 let now=Date.now();const timers=new Map(),callbacks=new Map(),disposers=[],calls=[],interrupts=[]
 const clock={now:()=>now,setTimeout(fn,ms){const id={unref(){}};timers.set(id,{fn,at:now+ms});return id},clearTimeout(id){timers.delete(id)}}
 const agent=id=>({id,status:'idle',session:{header:{id,cwd:workspace},events:[]},inbox:{nextTurn:[],nextStep:[],get hasPending(){return this.nextTurn.length+this.nextStep.length>0}},steer(message){this.inbox.nextStep.push(message)}})
 const captain=agent('captain'),worker=agent('worker'),agents=new Map([['captain',captain],['worker',worker]])
 const ctx={agents:{get:id=>agents.get(id)},logger:{warn(){}},on(name,fn){callbacks.set(name,fn)},effect(setup){disposers.push(setup())},subagents:{
  async [protocol](parent,id,content,source,signal,mode){assert.equal(parent,captain);assert.equal(signal.aborted,false);const message={content,source};calls.push({id,mode,message});agents.get(id).inbox[mode==='steer'?'nextStep':'nextTurn'].push(message)},
  interrupt(...args){interrupts.push(args)}
 }}
 await createTeamDir(root,{id:'team',name:'team',captainSessionId:'captain',createdAt:1,members:[{id:'worker',name:'worker',joinedAt:1,status:'idle'}],tasks:[completedTask(),pendingTask()],taskSeq:18})
 const reload=()=>installTeamScheduler(ctx,{stateDir:'.teams',maxActiveMembers:1,clock})
 let scheduler=reload()
 t.after(async()=>{for(const dispose of disposers)dispose();await rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:20})})
 return {root,workspace,ctx,agents,captain,worker,calls,interrupts,callbacks,clock,timers,reload,scheduler,
  read:()=>readTeam(root,'team'), async edit(fn){const d=await readTeam(root,'team');fn(d);await writeTeam(root,d)},
  advance(ms){now+=ms;for(const [id,item]of [...timers])if(item.at<=now){timers.delete(id);item.fn()}},
  async consume(){const messages=[...worker.inbox.nextStep.splice(0),...worker.inbox.nextTurn.splice(0)];for(const data of messages){const event={type:'user/message',data,time:now,seq:worker.session.events.length};worker.session.events.push(event);callbacks.get('session/event')({...worker.session,id:worker.id},event)}await eventually(async()=> (await readMailbox(root,'team','worker')).every(m=>m.consumedAt!==undefined))},
  dispose(){for(const dispose of disposers)dispose()}
 }
}
test('busy member receives queued mail at full capacity without a second task or activation; receipt tracks real consumption',async t=>{
 const f=await fixture(t);f.worker.status='running'
 await f.edit(d=>{d.members[0].activation={id:'original',sessionId:'worker',reservedAt:1,taskAttempts:[]}})
 const m=await appendMailbox(f.root,'team','worker',createMessage('captain','worker','Please start t18'))
 await f.scheduler.kickTeam(f.workspace,'team')
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].mode,'queue')
 let d=await f.read();assert.equal(d.tasks[1].status,'pending');assert.equal(d.tasks[1].attempt,0);assert.equal(d.members[0].activation.id,'original')
 let mail=(await readMailbox(f.root,'team','worker')).find(x=>x.id===m.id);assert.ok(mail.deliveredAt);assert.equal(mail.readAt,undefined);assert.equal(mail.consumedAt,undefined)
 await f.scheduler.kickTeam(f.workspace,'team');assert.equal(f.calls.length,1,'accepted IDs never duplicate')
 await f.consume();mail=(await readMailbox(f.root,'team','worker')).find(x=>x.id===m.id);assert.ok(mail.consumedAt)
})
test('accepted mail is not queued twice while a running member has spliced its inbox',async t=>{
 const f=await fixture(t);f.worker.status='running'
 await f.scheduler.kickTeam(f.workspace,'team')
 assert.equal(f.calls.length,1)
 f.worker.inbox.nextTurn.length=0
 await f.scheduler.kickTeam(f.workspace,'team')
 assert.equal(f.calls.length,1)
})
test('ready task notification does not need captain prompting and overdue alarm does not kill healthy long-running work',async t=>{
 const f=await fixture(t);f.worker.status='running';await f.scheduler.kickTeam(f.workspace,'team')
 assert.equal(f.calls.length,1);assert.match(f.calls[0].message.content[0].text,/t18 is ready/)
 const since=(await f.read()).tasks[1].scheduling.since
 f.advance(HANDOFF_ALERT_MS);await eventually(async()=> (await readMailbox(f.root,'team','captain')).some(m=>m.content.includes('has not started')))
 for(let i=0;i<3;i++){f.advance(HANDOFF_CHECK_MS);await f.scheduler.kickTeam(f.workspace,'team')}
 assert.equal((await readMailbox(f.root,'team','captain')).filter(m=>m.content.includes('has not started')).length,1)
 assert.equal(f.interrupts.length,0);const d=await f.read();assert.equal(d.tasks[1].attempt,0);assert.equal(d.tasks[1].scheduling.since,since)
 assert.equal(d.tasks[1].scheduling.reason,'member_busy')
})
test('periodic reconciliation recovers a missed idle edge and dispatches one attempt after old work ends',async t=>{
 const f=await fixture(t);f.worker.status='running';await f.scheduler.kickTeam(f.workspace,'team');await f.consume()
 f.worker.status='idle';f.advance(HANDOFF_CHECK_MS)
 await eventually(async()=> (await f.read()).tasks[1].status==='claimed')
 await eventually(()=>f.calls.some(c=>c.mode==='queue'))
 const id=(await f.read()).tasks[1].attemptId;await f.scheduler.kickTeam(f.workspace,'team')
 assert.equal((await f.read()).tasks[1].attemptId,id);assert.equal(f.calls.filter(c=>c.mode==='queue').length,2)
})
test('restart after upstream commit and delayed captain restore reconstructs dispatch intent from durable tasks',async t=>{
 const f=await fixture(t);f.agents.delete('captain');f.dispose();const scheduler=f.reload()
 await scheduler.recoverWorkspace(f.workspace)
 assert.equal(f.calls.length,0);assert.equal((await f.read()).tasks[1].scheduling.reason,'captain_unavailable')
 f.agents.set('captain',f.captain);f.advance(HANDOFF_CHECK_MS)
 await eventually(async()=> (await f.read()).tasks[1].status==='claimed')
 assert.equal((await f.read()).tasks[1].attempt,1)
})
test('ack loss followed by scheduler restart deduplicates accepted mail and reconciles child-owned consumption',async t=>{
 const f=await fixture(t);f.worker.status='running';await f.scheduler.kickTeam(f.workspace,'team')
 const message=f.worker.inbox.nextTurn.shift();f.worker.session.events.push({type:'user/message',data:message,time:Date.now()})
 f.dispose();const scheduler=f.reload();await scheduler.recoverWorkspace(f.workspace)
 assert.equal(f.calls.length,1);assert.ok((await readMailbox(f.root,'team','worker'))[0].consumedAt)
})
test('handoff tracking preserves user gates, explicit blocks, halt and removed member boundaries',async t=>{
 for(const kind of ['human','blocked','runtime','halt','removed','dependency']){
  const f=await fixture(t);f.worker.status='running'
  await f.edit(d=>{const task=d.tasks[1];if(kind==='human'){task.assignee='captain';task.humanChoice={sourceTaskId:'t17',artifact:'report.md',options:['yes']}};if(kind==='blocked')task.executionState='blocked_external';if(kind==='runtime')task.reassigning=true;if(kind==='halt')d.halted=true;if(kind==='removed')d.members[0].status='removed';if(kind==='dependency')d.tasks[0].status='in_progress'})
  await f.scheduler.kickTeam(f.workspace,'team').catch(e=>{throw new Error(kind+': '+e.message)});assert.equal(f.calls.length,0,kind);assert.equal((await f.read()).tasks[1].attempt,0,kind)
 }
})
test('notification cannot admit a second idle worker while all execution slots are occupied',async t=>{
 const f=await fixture(t);f.worker.status='running'
 const other={id:'other',status:'idle',inbox:{hasPending:false,nextTurn:[],nextStep:[]},session:{header:{cwd:f.workspace},events:[]}}
 f.agents.set('other',other);await f.edit(d=>d.members.push({id:'other',name:'other',joinedAt:1,status:'idle'}))
 await appendMailbox(f.root,'team','other',createMessage('captain','other','Review'))
 await f.scheduler.kickTeam(f.workspace,'team');assert.ok(f.calls.every(c=>c.id==='worker'))
 assert.equal((await readMailbox(f.root,'team','other'))[0].deliveredAt,undefined)
})
test('handoff observation does not bypass the bounded mailbox transport retry limit',async t=>{
 const f=await fixture(t);f.worker.status='running';let attempts=0
 f.ctx.subagents[protocol]=async()=>{attempts++;throw new Error('transport offline')}
 for(let i=0;i<12;i++)await f.scheduler.kickTeam(f.workspace,'team')
 assert.equal(attempts,4);assert.equal((await f.read()).tasks[1].attempt,0)
 assert.equal((await readMailbox(f.root,'team','worker'))[0].deliveredAt,undefined)
})
test('delayed handoff notification is discarded after the target task becomes terminal',async t=>{
 const f=await fixture(t);f.worker.status='running';await f.scheduler.kickTeam(f.workspace,'team')
 await f.edit(d=>{d.tasks[1].status='completed'})
 f.worker.inbox.nextTurn.length=0;await f.scheduler.kickMember(f.workspace,'team','worker')
 const mail=(await readMailbox(f.root,'team','worker'))[0]
 assert.ok(mail.discardedAt);assert.equal(f.calls.length,1)
})
test('captain reconnecting directly into running reconstructs handoff without startup workspace discovery',async t=>{
 const f=await fixture(t);f.worker.status='running';f.captain.status='running'
 f.callbacks.get('agent/status')({agent:f.captain,status:'running'})
 await eventually(()=>f.calls.length===1)
 assert.equal(f.calls[0].mode,'queue');assert.equal((await f.read()).tasks[1].scheduling.reason,'member_busy')
 assert.equal((await f.read()).tasks[1].attempt,0)
})
test('late idle captain session-start recovers a workspace without any status transition or user message',async t=>{
 const f=await fixture(t)
 f.callbacks.get('agent/session-start')({agent:f.captain,source:'resume'})
 await eventually(async()=> (await f.read()).tasks[1].status==='claimed')
 await eventually(()=>f.calls.length===1)
 assert.equal(f.calls[0].mode,'queue');assert.equal((await f.read()).tasks[1].attempt,1)
})
