import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountStore } from '../account-store.mjs'
import { readConfig } from '../config.mjs'
import { createPortalServer } from '../server.mjs'

test('space creation, session binding and preset changes stay in the account', async t => {
  const store = new AccountStore()
  t.after(() => store.close())
  const a = store.provisionAccount({ slug: 'space-a' })
  const b = store.provisionAccount({ slug: 'space-b' })
  store.bindWorkspace(a, 'workspace-a'); store.bindWorkspace(b, 'workspace-b')
  store.bindBackend(a, 'a'); store.bindBackend(b, 'b')
  store.provisionMember({ accountId: a, issuer: 'https://issuer.test', subject: 'a', displayName: 'A' })
  store.provisionMember({ accountId: b, issuer: 'https://issuer.test', subject: 'b', displayName: 'B' })
  const la = store.issueBrowserSession({ accountId: a, issuer: 'https://issuer.test', subject: 'a' })
  const lb = store.issueBrowserSession({ accountId: b, issuer: 'https://issuer.test', subject: 'b' })
  const config = readConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:18460', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    DSH_BACKENDS_JSON: JSON.stringify({ a: 'http://127.0.0.1:3101', b: 'http://127.0.0.1:3102' }),
    RESEARCH_ENABLED_BACKENDS: 'a,b', OIDC_ISSUER: 'https://issuer.test', OIDC_CLIENT_ID: 'portal',
    ACCOUNT_DB_PATH: '/tmp/injected-test.sqlite', DSH_GATEWAY_TOKEN_DIR: '/tmp/injected-tokens' })
  const calls = []
  const gateway = {
    presets: async () => ({ presets: [{ id: 'zhijian', name: '智见' }, { id: 'standard', name: '标准' }], defaultId: 'zhijian' }),
    createSpace: async (runtime, path) => { calls.push(['space', runtime.backendRef, path]); return { path } },
    createSession: async (runtime, sessionId, options) => { calls.push(['session', runtime.backendRef, options]); return { sessionId, presetId: options.presetId ?? 'zhijian' } },
    sessionPreset: async () => ({ presetId: 'zhijian', canSwitch: true }),
    selectSessionPreset: async (runtime, sessionId, presetId) => { calls.push(['preset', runtime.backendRef, sessionId, presetId]); return { presetId, canSwitch: true } },
  }
  const server = createPortalServer(config, { store, oidc: {}, gateway })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const auth = login => ({ cookie: `__Host-zhijian-session=${login.token}`, origin: config.publicOrigin,
    'x-csrf-token': login.csrf, 'content-type': 'application/json' })
  const post = (path, login, body) => fetch(base + path, { method: 'POST', headers: auth(login), body: JSON.stringify(body) })
  assert.equal((await post('/api/spaces', la, { name: '../escape' })).status, 400)
  assert.equal((await post('/api/spaces', la, { parentId: '11111111-1111-4111-8111-111111111111', name: '子目录' })).status, 404)
  const root = (await (await post('/api/spaces', la, { name: '研究' })).json()).space
  const child = (await (await post('/api/spaces', la, { parentId: root.id, name: '报告' })).json()).space
  assert.equal(child.relativePath, 'spaces/研究/报告')
  assert.equal((await post('/api/sessions', lb, { requestId: 'foreign-space', spaceId: child.id })).status, 404)
  const session = (await (await post('/api/sessions', la,
    { requestId: 'space-session', spaceId: child.id, presetId: 'standard' })).json()).session
  assert.equal(session.spaceId, child.id)
  assert.deepEqual(calls.find(call => call[0] === 'session')[2], { spacePath: child.relativePath, presetId: 'standard' })
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/preset`, { headers: auth(lb) })).status, 404)
  assert.equal((await post(`/api/sessions/${session.id}/preset`, lb, { presetId: 'zhijian' })).status, 404)
  assert.equal((await post(`/api/sessions/${session.id}/preset`, la, { presetId: 'zhijian' })).status, 200)
  assert.equal(store.listResearchSessions(la.principal)[0].presetId, 'zhijian')
  assert.deepEqual((await (await fetch(`${base}/api/spaces`, { headers: auth(lb) })).json()).spaces, [])
})
