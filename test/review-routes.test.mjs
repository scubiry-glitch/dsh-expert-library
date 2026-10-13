import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleReviewRoutes, REVIEW_PREFIX } from '../src/host/review-routes.ts'
import { issueReviewAccess } from '../src/host/review-access.ts'
import { createStagedPlan, writeStagedPlan } from '../src/staged-plan.ts'
import { captureSharedTaskContextFromEvents } from '../src/shared-task-context.ts'
import { EXPERT_PORTRAIT_IDS, PORTRAIT_POSES } from '../src/review-portraits.ts'

function request(path, { method = 'GET', headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = path
  req.headers = { host: 'example.test', origin: 'https://example.test', ...headers }
  return req
}
function response() {
  return { status: 0, headers: {}, body: '', writeHead(status, headers = {}) { this.status = status; this.headers = headers }, end(value = '') { this.body += value } }
}
async function invoke(runtime, path, options) {
  const res = response()
  await handleReviewRoutes(request(path, options), res, new URL(`https://example.test${path}`), runtime)
  return { ...res, data: res.headers['content-type']?.includes('json') ? JSON.parse(res.body) : undefined }
}

test('signed Host issues a scoped link; cookie reads state and permits only approval and human choice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-review-route-'))
  const actions = []
  const digest = 'a'.repeat(64)
  const source = 'b'.repeat(64)
  const runtime = {
    hostAuth: () => undefined,
    stateRoots: () => [root],
    resolve: async (captain, teamId, planId) => captain === 'captain' && (teamId === undefined || teamId === 'team') && (planId === undefined || planId === 'plan')
      ? { stateRoot: root, captainSessionId: captain, teamId, planId: planId || 'plan', archived: false } : undefined,
    read: async target => ({ version: 1, team: target.teamId ? { id: 'team', tasks: [] } : null, plan: { planId: 'plan', appliedTeamId: 'team' }, archived: false }),
    action: async (_target, action) => { actions.push(action); return { version: 1, team: null, plan: null, archived: false } },
  }
  try {
    const denied = await invoke({ ...runtime, hostAuth: () => 401 }, `${REVIEW_PREFIX}/api/issue`, { method: 'POST', body: { captainSessionId: 'captain', planId: 'plan' } })
    assert.equal(denied.status, 401)
    const csrf = await invoke(runtime, `${REVIEW_PREFIX}/api/issue`, { method: 'POST', headers: { origin: 'https://other.test' }, body: { captainSessionId: 'captain', planId: 'plan' } })
    assert.equal(csrf.status, 403)
    const downgrade = await invoke(runtime, `${REVIEW_PREFIX}/api/issue`, { method: 'POST', headers: { origin: 'http://example.test' }, body: { captainSessionId: 'captain', planId: 'plan' } })
    assert.equal(downgrade.status, 403)
    const issue = await invoke(runtime, `${REVIEW_PREFIX}/api/issue`, { method: 'POST', body: { captainSessionId: 'captain', planId: 'plan' } })
    assert.equal(issue.status, 200)
    assert.match(issue.data.token, /^rvl_[a-f0-9]{24}_[A-Za-z0-9_-]{43}$/)
    assert.equal((await invoke(runtime, `${REVIEW_PREFIX}/api/state`)).status, 401)
    const exchange = await invoke(runtime, `${REVIEW_PREFIX}/api/exchange`, { method: 'POST', body: { token: issue.data.token } })
    assert.equal(exchange.status, 200)
    assert.match(exchange.headers['set-cookie'], /HttpOnly; Secure; SameSite=Strict/)
    assert.match(exchange.data.accessId, /^[a-f0-9]{24}$/)
    const scoped = suffix => `${REVIEW_PREFIX}/api/${suffix}?access=${exchange.data.accessId}`
    const headers = { cookie: exchange.headers['set-cookie'].split(';')[0] }
    assert.equal((await invoke(runtime, `${REVIEW_PREFIX}/api/state`, { headers })).status, 401)
    const scopedState = await invoke(runtime, scoped('state'), { headers })
    assert.equal(scopedState.status, 200)
    assert.equal(scopedState.data.captainSessionId, 'captain')
    const forbidden = await invoke(runtime, scoped('action'), { method: 'POST', headers, body: { action: 'halt', teamId: 'team' } })
    assert.equal(forbidden.status, 400)
    assert.equal(actions.length, 0)
    const approve = await invoke(runtime, scoped('action'), { method: 'POST', headers, body: { action: 'approve', expectedDigest: digest, expectedRevision: 2 } })
    assert.equal(approve.status, 200)
    assert.equal(actions[0].actor, 'scoped-review-token')
    assert.match(actions[0].reviewTokenId, /^[a-f0-9]{24}$/)
    for (const code of ['REVIEW_SESSION_UNAVAILABLE', 'PLAN_CAPTAIN_MODEL_SWITCH_REQUIRED', 'PLAN_MODEL_UNAVAILABLE', 'PLAN_OUTLINE_REQUIRED', 'SHARED_TASK_CONTEXT_CHANGED']) {
      const blocked = await invoke({ ...runtime, action: async () => { throw new Error(`${code}: details`) } }, scoped('action'),
        { method: 'POST', headers, body: { action: 'approve', expectedDigest: digest, expectedRevision: 2 } })
      assert.equal(blocked.status, code === 'SHARED_TASK_CONTEXT_CHANGED' ? 409 : 400)
      assert.equal(blocked.data.error, code)
    }
    for (const cause of ['staged plan "plan" digest is stale', 'staged plan "plan" revision is stale']) {
      const stale = await invoke({ ...runtime, action: async () => { throw new Error(cause) } }, scoped('action'),
        { method: 'POST', headers, body: { action: 'approve', expectedDigest: digest, expectedRevision: 2 } })
      assert.equal(stale.status, 409)
      assert.equal(stale.data.error, 'REVIEW_PLAN_STALE')
    }
    const choose = await invoke(runtime, scoped('action'), { method: 'POST', headers, body: { action: 'choose', taskId: 't4', choices: ['主观点', '补充观点'], expectedSha256: source } })
    assert.equal(choose.status, 200)
    assert.equal(actions[1].action, 'choose')
    assert.equal(actions[1].teamId, 'team')
    assert.deepEqual(actions[1].choices, ['主观点', '补充观点'])
    const taskStart = await invoke(runtime, scoped('action'), { method: 'POST', headers,
      body: { action: 'task-start', taskId: 't4', expectedAttemptId: 'attempt-12345678' } })
    assert.equal(taskStart.status, 200)
    assert.equal(actions[2].action, 'task-start')
    assert.equal(actions[2].teamId, 'team')
    assert.equal(actions[2].expectedAttemptId, 'attempt-12345678')
    const recoveryReason = 'RUNTIME_HOST_RESTART_UNCONFIRMED: Unconfirmed delivery'
    const recover = await invoke(runtime, scoped('action'), { method: 'POST', headers,
      body: { action: 'task-recover', taskId: 't8', expectedAttemptId: 'attempt-12345678', expectedWaitReason: recoveryReason } })
    assert.equal(recover.status, 200)
    assert.equal(actions[3].expectedWaitReason, recoveryReason)
    const extra = await invoke(runtime, scoped('action'), { method: 'POST', headers,
      body: { action: 'task-pause', taskId: 't4', expectedAttemptId: 'attempt-12345678', teamId: 'foreign' } })
    assert.equal(extra.status, 400)
    const logout = await invoke(runtime, scoped('logout'), { method: 'POST', headers, body: {} })
    assert.equal(logout.status, 200)
    assert.equal((await invoke(runtime, scoped('state'), { headers })).status, 401)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('standalone page serves assets at its canonical absolute paths with a restrictive policy', async () => {
  const runtime = { hostAuth: () => 401, stateRoots: () => [], resolve: async () => undefined, read: async () => { throw Error() }, action: async () => { throw Error() } }
  const page = await invoke(runtime, REVIEW_PREFIX)
  assert.equal(page.status, 200)
  assert.match(page.body, /\/plugins\/dsh-expert-library\/review\/review\.js/)
  assert.equal(page.headers['cache-control'], 'no-store')
  assert.doesNotMatch(page.body, /data:image\/png;base64/)
  for (const name of ['market', 'finance', 'coordinator']) assert.match(page.body, new RegExp(`${REVIEW_PREFIX}/portraits/${name}\\.webp`))
  assert.match(page.headers['content-security-policy'], /default-src 'none'/)
  assert.equal(page.headers['referrer-policy'], 'no-referrer')
  for (const name of ['review.js', 'review.css']) {
    const version = page.body.match(new RegExp(`${name.replace('.', '\\.')}\\?v=([a-f0-9]{64})`))?.[1]
    assert.ok(version, `${name} content version`)
    const current = await invoke(runtime, `${REVIEW_PREFIX}/${name}?v=${version}`)
    assert.equal(current.status, 200)
    assert.equal(current.headers['cache-control'], 'public, max-age=31536000, immutable')
    const old = await invoke(runtime, `${REVIEW_PREFIX}/${name}?v=old`)
    assert.equal(old.headers['cache-control'], 'no-store')
  }
  for(const name of ['coordinator','finance','policy','market','engineer','reviewer']){const portrait=await invoke(runtime,`${REVIEW_PREFIX}/portraits/${name}.webp`);assert.equal(portrait.status,200);assert.equal(portrait.headers['content-type'],'image/webp')}
  assert.equal((await invoke(runtime,`${REVIEW_PREFIX}/portraits/unknown.webp`)).status,404)
  assert.equal((await invoke(runtime,`${REVIEW_PREFIX}/portraits/source/finance.png`)).status,404)
  for (const id of [...EXPERT_PORTRAIT_IDS,...PORTRAIT_POSES.map(p=>p.id)]) for (const suffix of ['', '-avatar']) {
    const portrait=await invoke(runtime,`${REVIEW_PREFIX}/portraits/${id}${suffix}.webp`)
    assert.equal(portrait.status,200,`${id}${suffix}`)
    assert.equal(portrait.headers['content-type'],'image/webp')
  }
  assert.equal((await invoke(runtime,`${REVIEW_PREFIX}/portraits/expert-unknown.webp`)).status,404)
  assert.equal((await invoke(runtime,`${REVIEW_PREFIX}/portraits/expert-bk-025-avatar-avatar.webp`)).status,404)
})

test('two independent windows keep their own team scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-review-windows-'))
  const runtime = {
    hostAuth: () => 401,
    stateRoots: () => [root],
    resolve: async (captain, teamId) => ({ stateRoot: root, captainSessionId: captain, teamId, archived: false }),
    read: async target => ({ version: 1, team: { id: target.teamId, tasks: [] }, plan: null, archived: false }),
    action: async () => { throw Error('unexpected action') },
  }
  try {
    const a = await issueReviewAccess(root, { captainSessionId: 'captain', teamId: 'team-a' })
    const b = await issueReviewAccess(root, { captainSessionId: 'captain', teamId: 'team-b' })
    const first = await invoke(runtime, `${REVIEW_PREFIX}/api/exchange`, { method: 'POST', body: { token: a.token } })
    const second = await invoke(runtime, `${REVIEW_PREFIX}/api/exchange`, { method: 'POST', body: { token: b.token } })
    const headers = { cookie: `${first.headers['set-cookie'].split(';')[0]}; ${second.headers['set-cookie'].split(';')[0]}` }
    const stateA = await invoke(runtime, `${REVIEW_PREFIX}/api/state?access=${first.data.accessId}`, { headers })
    const stateB = await invoke(runtime, `${REVIEW_PREFIX}/api/state?access=${second.data.accessId}`, { headers })
    assert.equal(stateA.data.team.id, 'team-a')
    assert.equal(stateB.data.team.id, 'team-b')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('scoped staged-plan editing uses version checks, fixed targets and a bounded patch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-edit-'))
  let plan = {planId:'plan',status:'staged',digest:'a'.repeat(64),revision:1}
  const actions=[]
  const runtime={hostAuth:()=>401,stateRoots:()=>[root],
    resolve:async(captain,teamId,planId)=>({stateRoot:root,captainSessionId:captain,teamId,planId,archived:false}),
    read:async target=>({version:1,team:target.teamId?{id:target.teamId,tasks:[]}:null,plan,archived:false}),
    modelCatalog:async()=>[{provider:'p',model:'m',name:'Model',secret:'must-not-leak'}],
    action:async(target,input)=>{actions.push(input);plan={...plan,revision:plan.revision+1,digest:'b'.repeat(64)};return {version:1,team:null,plan,archived:false}}}
  try{
    const issued=await issueReviewAccess(root,{captainSessionId:'captain',planId:'plan'})
    const exchange=await invoke(runtime,`${REVIEW_PREFIX}/api/exchange`,{method:'POST',body:{token:issued.token}})
    const headers={cookie:exchange.headers['set-cookie'].split(';')[0]}
    const path=`${REVIEW_PREFIX}/api/action?access=${exchange.data.accessId}`
    const statePath=`${REVIEW_PREFIX}/api/state?access=${exchange.data.accessId}`
    assert.equal((await invoke(runtime,statePath,{headers})).data.canEditPlan,true)
    const catalog=await invoke(runtime,statePath+'&catalog=models',{headers})
    assert.deepEqual(catalog.data.models,[{provider:'p',model:'m',name:'Model'}])
    const body={action:'edit',expectedDigest:plan.digest,expectedRevision:1,patch:{plan_models:{expert:{provider:'p',model:'m'}}},captainSessionId:'foreign',planId:'foreign'}
    assert.equal((await invoke(runtime,path,{method:'POST',headers:{...headers,origin:'https://foreign.test'},body})).status,403)
    assert.equal((await invoke(runtime,path,{method:'POST',headers,body:{...body,patch:{profile:'arbitrary'}}})).status,400)
    assert.equal((await invoke(runtime,path,{method:'POST',headers,body:{...body,expectedRevision:0}})).status,409)
    const saved=await invoke(runtime,path,{method:'POST',headers,body})
    assert.equal(saved.status,200);assert.equal(saved.data.plan.revision,2)
    assert.equal(actions[0].captainSessionId,'captain');assert.equal(actions[0].planId,'plan');assert.equal(actions[0].actor,'scoped-review-token')
    assert.equal((await invoke(runtime,path,{method:'POST',headers,body})).status,409)
    plan={...plan,status:'applied'}
    assert.equal((await invoke(runtime,path,{method:'POST',headers,body:{...body,expectedDigest:plan.digest,expectedRevision:2}})).status,409)
    assert.equal((await invoke(runtime,statePath+'&catalog=models',{headers})).status,403)
    assert.equal(actions.length,1)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('scoped context recovery shows only new direct-user input and requires an exact reviewed snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-context-'))
  const human = (seq, text) => ({ seq, type: 'user/message', data: { id: `human-${seq}`, source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  const previous = captureSharedTaskContextFromEvents('captain', [human(1, '原始要求')])
  const latest = captureSharedTaskContextFromEvents('captain', [human(1, '原始要求'), human(2, '新增约束')], previous)
  const staged = createStagedPlan({ planId: 'plan', plan: { planId: 'plan', digest: 'compiled', template: { id: 'demo', version: '1.0.0' }, tasks: [], roster: [] },
    request: { scenario: 'demo' }, runtime: { teamName: 'Demo', description: 'goal', sharedTaskContext: previous },
    createdBy: 'captain', expiresAt: Date.now() + 60000 })
  const actions = []
  const runtime = { stateRoots: () => [root],
    resolve: async (captainSessionId, teamId, planId) => ({ stateRoot: root, captainSessionId, teamId, planId, archived: false }),
    read: async () => ({ version: 1, team: null, plan: { planId: 'plan', status: 'staged', digest: staged.digest, revision: staged.revision }, archived: false }),
    contextSnapshot: async (captain, frozen) => { assert.equal(captain, 'captain'); assert.equal(frozen.sha256, previous.sha256); return latest },
    action: async (_target, action) => { actions.push(action); return { version: 1, team: null, plan: null, archived: false } } }
  try {
    await writeStagedPlan(root, staged)
    const issued = await issueReviewAccess(root, { captainSessionId: 'captain', planId: 'plan' })
    const exchanged = await invoke(runtime, `${REVIEW_PREFIX}/api/exchange`, { method: 'POST', body: { token: issued.token } })
    const headers = { cookie: exchanged.headers['set-cookie'].split(';')[0] }
    const statePath = `${REVIEW_PREFIX}/api/state?view=context&access=${exchanged.data.accessId}`
    const actionPath = `${REVIEW_PREFIX}/api/action?access=${exchanged.data.accessId}`
    assert.equal((await invoke(runtime, statePath)).status, 401)
    const state = await invoke(runtime, statePath, { headers })
    assert.equal(state.status, 200)
    assert.equal(state.data.context.changed, true)
    assert.deepEqual(state.data.context.newMessages.map(item => item.text), ['新增约束'])
    assert.equal(state.data.context.currentSha256, latest.sha256)
    const sync = { action: 'sync-context', expectedDigest: staged.digest, expectedRevision: staged.revision, expectedContextSha256: latest.sha256 }
    assert.equal((await invoke(runtime, actionPath, { method: 'POST', headers, body: { ...sync, expectedRevision: 1 } })).data.error, 'REVIEW_PLAN_STALE')
    assert.equal((await invoke(runtime, actionPath, { method: 'POST', headers, body: { ...sync, expectedContextSha256: 'bad' } })).status, 400)
    assert.equal((await invoke(runtime, actionPath, { method: 'POST', headers, body: { ...sync, planId: 'foreign' } })).status, 400)
    assert.equal(actions.length, 0)
    const result = await invoke(runtime, actionPath, { method: 'POST', headers, body: sync })
    assert.equal(result.status, 200)
    assert.equal(actions[0].action, 'edit')
    assert.deepEqual(actions[0].patch, {})
    assert.equal(actions[0].expectedContextSha256, latest.sha256)
    assert.equal(actions[0].captainSessionId, 'captain')
    assert.equal(actions[0].reviewTokenId, issued.id)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('conversation reads only the token-bound captain and rejects unauthenticated or malformed requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-conversation-'))
  const calls = []
  const runtime = {
    stateRoots: () => [root],
    resolve: async (captainSessionId, teamId) => ({ stateRoot: root, captainSessionId, teamId, archived: false }),
    read: async () => ({}), action: async () => { throw Error('unexpected') },
    conversation: async (captain, after) => { calls.push([captain, after]); return { messages: [], nextCursor: after, hasMore: false } },
  }
  try {
    assert.equal((await invoke(runtime, `${REVIEW_PREFIX}/api/state?view=conversation`)).status, 401)
    const issued = await issueReviewAccess(root, { captainSessionId: 'captain', teamId: 'team' })
    const exchanged = await invoke(runtime, `${REVIEW_PREFIX}/api/exchange`, { method: 'POST', body: { token: issued.token } })
    const headers = { cookie: exchanged.headers['set-cookie'].split(';')[0] }
    const path = `${REVIEW_PREFIX}/api/state?view=conversation&access=${exchanged.data.accessId}`
    assert.equal((await invoke(runtime, path + '&captain=foreign&team=foreign&after=10', { headers })).status, 200)
    assert.deepEqual(calls, [['captain', 10]])
    for (const after of ['-2', '1.5', 'Infinity', '9007199254740992', '']) assert.equal((await invoke(runtime, path + '&after=' + after, { headers })).status, 400)
    assert.equal((await invoke(runtime, path, { headers, method: 'POST', body: {} })).status, 405)
    assert.equal((await invoke({ ...runtime, resolve: async () => undefined }, path, { headers })).status, 404)
    assert.equal((await invoke({ ...runtime, conversation: undefined }, path, { headers })).status, 503)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('scoped conversation sending requires same-origin POST, valid text and an active bound main session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-message-'))
  const sent = []
  const runtime = {
    stateRoots: () => [root],
    resolve: async (captainSessionId, teamId) => ({ stateRoot: root, captainSessionId, teamId, archived: false }),
    read: async () => ({}), action: async () => { throw Error('not a plan action') },
    sendMessage: async (...args) => { sent.push(args); return { accepted: true } },
  }
  try {
    const issued = await issueReviewAccess(root, { captainSessionId: 'captain', teamId: 'team' })
    const exchanged = await invoke(runtime, `${REVIEW_PREFIX}/api/exchange`, { method: 'POST', body: { token: issued.token } })
    const headers = { cookie: exchanged.headers['set-cookie'].split(';')[0] }
    const path = `${REVIEW_PREFIX}/api/action?access=${exchanged.data.accessId}`
    const body = { action: 'message', text: '请补充供给侧分析', requestId: 'a'.repeat(32) }
    assert.equal((await invoke(runtime, path, { method: 'POST', body })).status, 401)
    assert.equal((await invoke(runtime, path, { method: 'POST', headers: { ...headers, origin: 'https://other.test' }, body })).status, 403)
    assert.equal((await invoke(runtime, path, { headers })).status, 403)
    for (const change of [{ text: '  ' }, { text: 'a'.repeat(8001) }, { text: 5 }, { requestId: '../x' }, { sessionId: 'foreign' }]) {
      assert.equal((await invoke(runtime, path, { method: 'POST', headers, body: { ...body, ...change } })).status, 400)
    }
    const archived = { ...runtime, resolve: async () => ({ stateRoot: root, captainSessionId: 'captain', teamId: 'team', archived: true }) }
    assert.equal((await invoke(archived, path, { method: 'POST', headers, body })).status, 403)
    assert.equal(sent.length, 0)
    const result = await invoke(runtime, path + '&captain=foreign&team=foreign', { method: 'POST', headers, body })
    assert.equal(result.status, 200)
    assert.equal(result.data.accepted, true)
    assert.deepEqual(sent, [['captain', body.text, `review-${issued.id}-${body.requestId}`]])
    assert.equal((await invoke({ ...runtime, sendMessage: undefined }, path, { method: 'POST', headers, body })).status, 503)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('scoped event stream resumes by durable cursor and releases its subscription on close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-events-'))
  let listener
  let unsubscribed = 0
  const reads = []
  const runtime = {
    stateRoots: () => [root],
    resolve: async captainSessionId => ({ stateRoot: root, captainSessionId, teamId: 'team', archived: false }),
    read: async () => ({}), action: async () => { throw Error('unexpected') },
    conversation: async (captain, after) => { reads.push([captain, after]); return { messages: [{ id: 'a9', seq: 9, role: 'assistant', text: '补齐' }], nextCursor: 9, hasMore: false } },
    subscribeSession: (captain, callback) => { assert.equal(captain, 'captain'); listener = callback; return () => { unsubscribed++ } },
  }
  try {
    const issued = await issueReviewAccess(root, { captainSessionId: 'captain', teamId: 'team' })
    const exchanged = await invoke(runtime, `${REVIEW_PREFIX}/api/exchange`, { method: 'POST', body: { token: issued.token } })
    const headers = { cookie: exchanged.headers['set-cookie'].split(';')[0] }
    const path = `${REVIEW_PREFIX}/api/events?access=${exchanged.data.accessId}&after=4`
    assert.equal((await invoke(runtime, path, { headers: { ...headers, 'last-event-id': 'bad' } })).status, 400)
    assert.equal((await invoke(runtime, path)).status, 401)
    const res = Object.assign(new EventEmitter(), {
      status: 0, headers: {}, frames: [], destroyed: false,
      writeHead(status, headers) { this.status = status; this.headers = headers },
      write(frame) { this.frames.push(frame); return true },
      end() { this.emit('close') },
    })
    await handleReviewRoutes(request(path, { headers: { ...headers, 'last-event-id': '7' } }), res, new URL(`https://example.test${path}`), runtime)
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8')
    assert.deepEqual(reads, [['captain', 7]])
    assert.match(res.frames.join(''), /id: 9\nevent: conversation/)
    listener({ type: 'conversation', message: { id: 'a10', seq: 10, role: 'assistant', text: '新回复' } })
    assert.match(res.frames.join(''), /id: 10\nevent: conversation/)
    res.emit('close')
    assert.equal(unsubscribed, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
