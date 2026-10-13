import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { handleTeamRoutes } from '../lib/host/team-routes.js'

function request({ method = 'GET', url = '/plugins/dsh-expert-library/teams?captainSessionId=captain', headers = {}, body: payload } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080', ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  process.nextTick(() => {
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)))
    req.emit('end')
  })
  return req
}
function response() {
  return { status: 0, body: '', writeHead(status) { this.status = status }, end(value = '') { this.body += value } }
}
const runtime = {
  hostAuth: () => undefined,
  resolve: async (captainSessionId, teamId, planId) => ({ stateRoot: '/tmp', teamId, planId, captainSessionId, archived: false }),
  read: async () => ({ version: 1, team: null, plan: null, archived: false }),
  action: async (_target, input) => ({ version: 1, team: null, plan: null, archived: false, action: input.action }),
}

test('native host rejection is returned before plugin fallback auth', async () => {
  const res = response()
  await handleTeamRoutes(request(), res, new URL('http://x/plugins/dsh-expert-library/teams'), { ...runtime, hostAuth: () => 401 })
  assert.equal(res.status, 401)
  assert.match(res.body, /TEAM_UNAUTHORIZED/)
})

test('Origin null is rejected for POST', async () => {
  const res = response()
  await handleTeamRoutes(request({ method: 'POST', headers: { origin: 'null' }, body: { action: 'halt', captainSessionId: 'captain', teamId: 'team', reason: 'pause' } }), res, new URL('http://x/plugins/dsh-expert-library/teams'), runtime)
  assert.equal(res.status, 403)
  assert.match(res.body, /TEAM_CSRF_REJECTED/)
})

for (const action of ['edit', 'approve', 'discard']) {
  test(`${action} rejects missing CAS fields`, async () => {
    const res = response()
    await handleTeamRoutes(request({ method: 'POST', body: { action, captainSessionId: 'captain', teamId: 'team', planId: 'plan' } }), res, new URL('http://x/plugins/dsh-expert-library/teams'), runtime)
    assert.equal(res.status, 400)
    assert.match(res.body, /TEAM_INVALID_INPUT/)
  })
}

test('cold GET does not require a live-agent callback', async () => {
  const res = response()
  await handleTeamRoutes(request(), res, new URL('http://x/plugins/dsh-expert-library/teams?captainSessionId=captain'), runtime)
  assert.equal(res.status, 200)
})

test('model catalog stays readable for a staged plan after its agent is unloaded, with native Host auth', async () => {
  const url = new URL('http://x/plugins/dsh-expert-library/teams?captainSessionId=captain&planId=plan&models=1')
  const cold = response()
  await handleTeamRoutes(request({ url: url.pathname + url.search }), cold, url, {
    ...runtime, modelCatalog: async () => [{ provider: 'fixture', model: 'stub', name: 'Stub' }],
  })
  assert.equal(cold.status, 200)
  assert.deepEqual(JSON.parse(cold.body).models, [{ provider: 'fixture', model: 'stub', name: 'Stub' }])
  const denied = response()
  await handleTeamRoutes(request({ url: url.pathname + url.search }), denied, url, { ...runtime, hostAuth: () => 401 })
  assert.equal(denied.status, 401)
})

test('native authenticated public authority does not require a manage token', async () => {
  const res = response()
  const req = request()
  req.headers.host = 'public.example.test'
  req.socket.remoteAddress = '127.0.0.1'
  await handleTeamRoutes(req, res, new URL('http://public.example.test/plugins/dsh-expert-library/teams?captainSessionId=captain'), runtime)
  assert.equal(res.status, 200)
})

test('human choice requires native Host auth, exact task and source digest', async () => {
  const source = 'a'.repeat(64)
  const payload = { action: 'choose', captainSessionId: 'captain', teamId: 'team', taskId: 't2', choice: 'B', expectedSha256: source }
  const legacy = response()
  await handleTeamRoutes(request({ method: 'POST', body: payload }), legacy, new URL('http://x/plugins/dsh-expert-library/teams'), { ...runtime, hostAuth: undefined, getToken: () => 'token' })
  assert.equal(legacy.status, 403)
  const malformed = response()
  await handleTeamRoutes(request({ method: 'POST', body: { ...payload, expectedSha256: 'stale' } }), malformed, new URL('http://x/plugins/dsh-expert-library/teams'), runtime)
  assert.equal(malformed.status, 400)
  const accepted = response()
  await handleTeamRoutes(request({ method: 'POST', body: payload }), accepted, new URL('http://x/plugins/dsh-expert-library/teams'), runtime)
  assert.equal(accepted.status, 200)
  assert.equal(JSON.parse(accepted.body).action, 'choose')
})
