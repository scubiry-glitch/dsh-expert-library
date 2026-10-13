import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolLoopBudget, toolLoopCallKey, toolLoopResultKey, installToolLoopGuard, toolLoopReadKeys, toolLoopReportObservationKey } from '../lib/tool-loop-guard.js'
import { createTeamDir, writeTeam } from '../lib/state.js'
import { captureRuntimeTurn, recordRuntimeFailure, runtimeRecoveryGuidance } from '../lib/runtime-failure.js'

const result = text => ({ isError: false, value: { text }, content: [{ type: 'text', text }] })
const unchanged = result('Already inspected')
test('pinned artifact EOF reads stop despite changing offsets, while new pages remain usable', async t => {
  const f = await fixture(t); await f.enter()
  const args = offset => ({ task_id: 'consumer', source_task_id: 'source', artifact_id: 'artifact', offset, limit: 100 })
  const page = (offset, eof = false) => {
    const value = { artifact_id: 'artifact', sha256: 'a'.repeat(64), size_bytes: 2000,
      offset, total_characters: 2000, returned_characters: eof ? 0 : 100,
      content: eof ? '' : 'x'.repeat(100), eof, next_offset: eof ? null : offset + 100 }
    return { isError: false, value, content: [{ type: 'text', text: JSON.stringify(value) }] }
  }
  const read = (offset, value) => f.execute({}, value, f.agent,
    { name: 'expert_teams_read_artifact', arguments: args(offset) })
  for (let offset = 0; offset < 2000; offset += 100) {
    assert.equal((await read(offset, page(offset))).kind, 'allow', 'distinct identical-text pages are progress')
    await f.enter()
  }
  for (let offset = 2000; offset <= 2900; offset += 100) await read(offset, page(offset, true))
  const denied = await read(3000, page(3000, true))
  assert.equal(denied.kind, 'deny', 'new offsets beyond EOF must not manufacture progress')
  const changed = { ...page(0), value: { ...page(0).value, artifact_id: 'new-artifact', sha256: 'b'.repeat(64) } }
  assert.equal((await f.execute({}, changed, f.agent, {
    name: 'expert_teams_read_artifact', arguments: { ...args(0), artifact_id: 'new-artifact' },
  })).kind, 'allow', 'another pinned artifact remains readable after a corrective rejection')
})
function reportObservation(kind, revision, contentHash = 'a'.repeat(64)) {
  const reportSha256 = { md: contentHash, html: 'b'.repeat(64), pdf: 'c'.repeat(64) }
  const value = kind === 'assembly'
    ? { status: 'BOUND_DRAFT', qualityApproved: false, hostReceipt: false, reportSha256,
        evidenceSha256: 'd'.repeat(64), output: `/work/evidence-v${revision}.json`, notice: 'Only exact span assembly.' }
    : { status: 'failed', qualityApproved: false, hostReceipt: false, inputFilesUnchanged: true,
        packId: 'fixture', packVersion: '1', selections: [],
        artifacts: [...Object.entries(reportSha256).map(([role, sha256]) => ({ role, sha256, path: `/work/report.${role}` })),
          { role: 'evidence', sha256: 'd'.repeat(64), path: `/work/evidence-v${revision}.json` }],
        results: [{ id: 'report-craft-calculations', status: 'failed', detail: 'Quantity binding is invalid.' }] }
  const text = JSON.stringify(value)
  return { isError: false, value: { exitCode: kind === 'assembly' ? 0 : 1, stdout: { text, truncated: false } },
    content: [{ type: 'text', text }] }
}

test('identical report bytes under new ledger filenames do not reset a repair cycle', async t => {
  const f = await fixture(t); await f.enter()
  let rejections = 0, stopped = false
  for (let revision = 1; revision <= 12 && !stopped; revision++) {
    for (const [command, observation] of [
      ['read fixed anchors', result('same anchors')],
      ['write fixed bindings', result('same bindings written')],
      [`assemble --out evidence-v${revision}.json`, reportObservation('assembly', revision)],
      [`preflight --ledger evidence-v${revision}.json`, reportObservation('preflight', revision)],
    ]) {
      try { await f.enter() } catch (error) { assert.match(String(error), /TOOL_LOOP_DETECTED/); stopped = true; break }
      if ((await f.execute({ command }, observation)).kind === 'deny') rejections++
    }
  }
  assert.equal(rejections, 3)
  assert.equal(stopped, true, 'versioned filenames must not manufacture progress')
})

test('report observation accounting preserves changes and rejects incomplete or unrelated envelopes', () => {
  const key = value => toolLoopReportObservationKey({ name: 'bash' }, value)
  for (const kind of ['assembly', 'preflight']) {
    assert.equal(key(reportObservation(kind, 1)), key(reportObservation(kind, 2)))
    assert.notEqual(key(reportObservation(kind, 1)), key(reportObservation(kind, 1, 'e'.repeat(64))))
    const changedLedger = reportObservation(kind, 1)
    const parsed = JSON.parse(changedLedger.value.stdout.text)
    if (kind === 'assembly') parsed.evidenceSha256 = 'f'.repeat(64)
    else parsed.artifacts.find(a => a.role === 'evidence').sha256 = 'f'.repeat(64)
    changedLedger.value.stdout.text = JSON.stringify(parsed)
    assert.notEqual(key(reportObservation(kind, 1)), key(changedLedger))
    assert.equal(key({ ...changedLedger, isError: true }), undefined)
    assert.equal(key({ ...changedLedger, value: { ...changedLedger.value, timedOut: true } }), undefined)
    assert.equal(key({ ...changedLedger, value: { ...changedLedger.value, stdout: { ...changedLedger.value.stdout, truncated: true } } }), undefined)
    assert.equal(toolLoopReportObservationKey({ name: 'read' }, changedLedger), undefined)
  }
  const value = reportObservation('preflight', 1), parsed = JSON.parse(value.value.stdout.text)
  parsed.results[0].detail = 'A newly discovered failure'
  value.value.stdout.text = JSON.stringify(parsed)
  assert.notEqual(key(value), key(reportObservation('preflight', 1)))
  parsed.qualityApproved = true; value.value.stdout.text = JSON.stringify(parsed)
  assert.equal(key(value), undefined)
  value.value.stdout.text = 'Some prose ' + JSON.stringify(parsed)
  assert.equal(key(value), undefined)
})

test('real report revisions keep the loop budget open even with recurring checker diagnostics', async t => {
  const f = await fixture(t); await f.enter()
  for (let i = 0; i < 20; i++) {
    const contentHash = i.toString(16).padStart(64, '0')
    assert.equal((await f.execute({ command: `preflight revision${i}` }, reportObservation('preflight', i, contentHash))).kind, 'allow')
    await f.enter()
  }
})
test('eight identical observations trigger correction; changed arguments or output reset the streak', () => {
  const b = new ToolLoopBudget(), a = {}, other = {}; b.enter(a, 1); b.enter(other, 1)
  for (let i = 0; i < 8; i++) b.settled(a, 'call', 'output', 'bash')
  assert.match(b.reason(a, 'call'), /not dispatched/)
  assert.equal(b.reason(other, 'call'), undefined)
  assert.equal(b.reason(a, 'changed'), undefined)
  b.settled(a, 'call', 'new output', 'bash'); assert.equal(b.reason(a, 'call'), undefined)
  for (let i = 0; i < 7; i++) b.settled(a, 'call', 'new output', 'bash')
  b.settled(a, 'other-call', 'new output', 'bash'); assert.equal(b.reason(a, 'call'), undefined)
})
test('three rejected repetitions exhaust only that turn; explicit new turn can recover', () => {
  const b = new ToolLoopBudget(), a = {}; b.enter(a, 3)
  for (let i = 0; i < 8; i++) b.settled(a, 'call', 'output', 'bash')
  for (let i = 0; i < 3; i++) b.rejected(a)
  assert.equal(b.exhausted(a), true); b.enter(a, 3); assert.equal(b.exhausted(a), true)
  b.enter(a, 4); assert.equal(b.exhausted(a), false); assert.equal(b.reason(a, 'call'), undefined)
})
test('identity ignores shell description and runtime timing, but preserves cwd, command and errors', () => {
  const key = extra => toolLoopCallKey({ name: 'bash', arguments: { command: 'read already-known.json', ...extra } })
  assert.equal(key({}), key({ description: 'new wording', timeout: 100 }))
  assert.notEqual(key({}), key({ workdir: '/other' }))
  assert.notEqual(key({}), key({ command: 'calculate actual result' }))
  assert.equal(toolLoopResultKey(unchanged), toolLoopResultKey({ ...unchanged, meta: { elapsed: 1 } }))
  assert.notEqual(toolLoopResultKey(unchanged), toolLoopResultKey({ ...unchanged, isError: true }))
})
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'tool-loop-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const team = { id: 'loop-team', name: 'loop-team', captainSessionId: 'captain', createdAt: 1, members: [{ id: 'worker', name: 'Worker', status: 'working', joinedAt: 1 }], tasks: [], taskSeq: 0 }
  const root = join(cwd, 'expert-teams'); await createTeamDir(root, team)
  const hooks = {}, guards = [], disposers = []
  installToolLoopGuard({ on(name, hook) { hooks[name] = hook }, effect(fn) { disposers.push(fn()) }, tools: { guard(fn) { guards.push(fn); return () => {} } } }, { stateDir: 'expert-teams' })
  t.after(() => disposers.forEach(fn => fn?.()))
  const agent = { id: 'worker', session: { header: { cwd } } }, signal = new AbortController().signal
  const enter = (who = agent, turn = 1, next = async () => ({ kind: 'enter', messages: [] })) => hooks['agent/pre-step']({ agent: who, turn, signal }, next)
  const execute = async (args = {}, value = unchanged, who = agent, extra = {}) => {
    const exec = { agent: who, name: 'bash', arguments: { command: 'read already-known.json', ...args }, signal, token: Symbol(), ...extra }
    const decision = await hooks['tools/pre-execute'](exec, async () => ({ kind: 'allow' }))
    if (decision.kind === 'deny') assert.equal(guards[0](exec), decision.reason)
    hooks['tools/result'](exec, decision.kind === 'deny' ? { isError: true, content: [{ type: 'text', text: decision.reason }] } : value)
    assert.equal(guards[0](exec), undefined, 'execution-local guard entry is released')
    return decision
  }
  return { team, root, hooks, agent, enter, execute }
}
test('team pipeline bounds the 47-call reproduction to eight dispatches and three corrective errors', async t => {
  const f = await fixture(t); await f.enter()
  for (let i = 0; i < 8; i++) assert.equal((await f.execute()).kind, 'allow')
  for (let i = 0; i < 3; i++) { assert.equal((await f.execute({ description: String(i) })).kind, 'deny'); if (i < 2) await f.enter() }
  await assert.rejects(f.enter(), /TOOL_LOOP_DETECTED/)
  await f.enter(f.agent, 2); assert.equal((await f.execute()).kind, 'allow')
})
test('genuine changing observations, other sessions, nested transport calls and halted teams are not blocked', async t => {
  const f = await fixture(t); await f.enter()
  for (let i = 0; i < 47; i++) assert.equal((await f.execute({}, result(String(i)))).kind, 'allow')
  const outside = { ...f.agent, id: 'unrelated' }; await f.enter(outside)
  for (let i = 0; i < 12; i++) assert.equal((await f.execute({}, unchanged, outside)).kind, 'allow')
  for (let i = 0; i < 12; i++) assert.equal((await f.execute({}, unchanged, f.agent, { parent: Symbol() })).kind, 'allow')
  f.team.halted = true; await writeTeam(f.root, f.team); await f.enter()
  for (let i = 0; i < 12; i++) assert.equal((await f.execute()).kind, 'allow')
})
test('existing pre-step denial is preserved and corrected work remains possible after a repetition denial', async t => {
  const f = await fixture(t), rejected = { kind: 'reject' }
  assert.equal(await f.enter(f.agent, 1, async () => rejected), rejected)
  await f.enter(); for (let i = 0; i < 8; i++) await f.execute()
  assert.equal((await f.execute()).kind, 'deny')
  assert.equal((await f.execute({ command: 'produce assigned deliverable' })).kind, 'allow')
  await f.enter(); assert.equal((await f.execute()).kind, 'allow')
})
test('native loop failure preserves task generation and review state, with local recovery guidance', () => {
  const team = { captainSessionId: 'captain', members: [{ id: 'worker', name: 'Worker', status: 'working' }], tasks: [{ id: 't1', assignee: 'Worker', status: 'in_progress', attemptId: 'stable', executionState: 'awaiting_review', output: 'published', publishedArtifacts: [{ id: 'immutable' }] }] }
  captureRuntimeTurn(team, 'worker', 1)
  const block = recordRuntimeFailure(team, 'worker', 1, { code: 'TOOL_LOOP_DETECTED', message: 'bounded repetition' }, 100)
  assert.equal(block.code, 'TOOL_LOOP_DETECTED'); assert.equal(team.tasks[0].attemptId, 'stable')
  assert.equal(team.tasks[0].executionState, 'awaiting_review'); assert.equal(team.tasks[0].output, 'published')
  assert.deepEqual(team.tasks[0].publishedArtifacts, [{ id: 'immutable' }])
  assert.match(runtimeRecoveryGuidance(block.code), /different operation/)
  assert.doesNotMatch(runtimeRecoveryGuidance(block.code), /provider/)
})


test('alternating already observed calls are bounded and interleaving does not erase corrective rejections', () => {
  const b = new ToolLoopBudget(), a = {}; b.enter(a, 1)
  for (let i = 0; i < 11; i++) b.settled(a, 'call-' + i % 3, 'output-' + i % 3, 'read')
  assert.match(b.reason(a, 'call-0'), /multi-call cycles/)
  assert.equal(b.reason(a, 'new-operation'), undefined)
  b.rejected(a); b.settled(a, 'call-1', 'output-1', 'read'); b.rejected(a)
  b.settled(a, 'call-2', 'output-2', 'read'); b.rejected(a)
  assert.equal(b.exhausted(a), true)
  b.settled(a, 'call-1', 'changed contents', 'read')
  assert.equal(b.exhausted(a), false); assert.equal(b.reason(a, 'call-0'), undefined)
})

test('native read pagination over already inspected lines is not mistaken for new evidence', () => {
  const b = new ToolLoopBudget(), a = {}; b.enter(a, 1)
  const window = (offset, count, changed = false) => ({isError:false,content:[],value:{path:'/supplied/material',offset,totalLines:100,lines:Array.from({length:count},(_,i)=>({number:offset+i,text:changed?'changed-'+i:'line-'+(offset+i)}))}})
  const observe = (call, value) => b.settled(a, call, toolLoopResultKey(value), 'read', toolLoopReadKeys({name:'read'},value))
  observe('whole',window(1,100))
  for(let i=0;i<8;i++) observe('slice-'+i,window(1+i,3+i))
  assert.match(b.reason(a,'slice-0'),/already observed/)
  observe('slice-0',window(1,3,true)); assert.equal(b.reason(a,'slice-0'),undefined)
  assert.equal(toolLoopReadKeys({name:'read'},{isError:false,value:{path:'/x',offset:1,totalLines:2,lines:[{number:3,text:'invalid'}]},content:[]}),undefined)
})

test('explicitly admitted pre-team planning is guarded and its terminal block survives a new turn', async t => {
  const {authorizePlanExecution,PLAN_AUTHORIZATION_SCOPE,planInputSha256}=await import('../lib/plan-authorization.js')
  const {captureSharedTaskContext}=await import('../lib/shared-task-context.js')
  const {readPlanningLoopStop}=await import('../lib/planning-loop-stop.js')
  const {planExecutionDenial}=await import('../lib/plan-execution-boundary.js')
  const f=await fixture(t),events=[{type:'user/message',seq:1,data:{id:'input',role:'user',source:{kind:'user'},content:[{type:'text',text:'Prepare the synthetic report plan.'}]}}]
  const a={id:'pre-team-captain',session:{header:f.agent.session.header,ownEvents:()=>events}}
  const context=captureSharedTaskContext(a)
  await authorizePlanExecution(f.root,a.id,context,{requestId:'unit-planning',expectedInputSha256:planInputSha256(context),reason:'Synthetic fixture',scope:PLAN_AUTHORIZATION_SCOPE,requireReviewedReport:true})
  assert.equal(await planExecutionDenial({agent:a,name:'todo_write'},{stateDir:'expert-teams'}),undefined)
  assert.match(await planExecutionDenial({agent:a,name:'bash'},{stateDir:'expert-teams'}),/expert_teams_plan_stage/)
  await f.enter(a)
  for(let i=0;i<11;i++)assert.equal((await f.execute({command:'synthetic '+i%3},result('unchanged '+i%3),a)).kind,'allow')
  for(let i=0;i<3;i++)assert.equal((await f.execute({command:'synthetic '+i},result('unchanged '+i),a)).kind,'deny')
  await assert.rejects(f.enter(a),/pre-team planning stopped/)
  const stored=await readPlanningLoopStop(f.root,a.id,context.sha256);assert.equal(stored.code,'TOOL_LOOP_DETECTED')
  f.hooks['agent/disposed']({agent:a})
  await assert.rejects(f.enter(a,2),/new direct user instruction/)
  const newInput={id:'new-input',role:'user',source:{kind:'user'},content:[{type:'text',text:'Stop that approach; review a new scope.'}]}
  await f.enter(a,3,async()=>({kind:'enter',messages:[newInput]}))
  assert.equal((await readPlanningLoopStop(f.root,a.id,context.sha256)).code,'TOOL_LOOP_DETECTED','pending user admission must retain the old audit block')
  events.push({type:'user/message',seq:2,data:newInput})
  assert.equal(await readPlanningLoopStop(f.root,a.id,captureSharedTaskContext(a).sha256),undefined)
  await f.enter(a,3)
})

test('planning loop stop pauses only an armed active Goal and preserves manual Goal state', async t => {
  const {persistPlanningLoopStop,readPlanningLoopStop}=await import('../lib/planning-loop-stop.js')
  const f=await fixture(t),context='a'.repeat(64);let pauses=0,flushes=0
  let goal={id:'goal',revision:1,phase:'active',activation:'armed'}
  const goals={get:()=>goal,pause:(_a,ref)=>{assert.equal(ref.revision,goal.revision);pauses++;goal={...goal,revision:goal.revision+1,phase:'paused',activation:'disarmed'};return goal},resume:()=>assert.fail('must not automatically resume a stopped planning Goal')}
  const ctx={get:name=>name==='goals'?goals:name==='sessions'?{flush:async()=>{flushes++;return true}}:undefined,agents:{withInitiator:(_a,fn)=>fn()}}
  await persistPlanningLoopStop(ctx,f.agent,f.root,context,1)
  assert.equal(pauses,1);assert.equal(flushes,1)
  const stored=await readPlanningLoopStop(f.root,f.agent.id,context);assert.equal(stored.goalWait.pausedRevision,2)
  goal={...goal,revision:3};await persistPlanningLoopStop(ctx,f.agent,f.root,context,2)
  assert.equal(pauses,1);assert.equal(goal.revision,3)
  assert.equal((await readPlanningLoopStop(f.root,f.agent.id,context)).goalWait,undefined)
})


test('argument key order cannot disguise an already observed operation', () => {
  assert.equal(toolLoopCallKey({name:'read',arguments:{file_path:'/x',offset:1,limit:10}}),toolLoopCallKey({name:'read',arguments:{limit:10,offset:1,file_path:'/x'}}))
})
