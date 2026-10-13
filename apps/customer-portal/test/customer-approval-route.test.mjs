import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountStore } from '../account-store.mjs'
import { readConfig } from '../config.mjs'
import { createPortalServer } from '../server.mjs'

test('C report approval is session scoped and requires write access', async t => {
  const store = new AccountStore()
  t.after(() => store.close())
  const c = store.provisionAccount({ slug: 'zhijian' })
  const b = store.provisionAccount({ slug: 'other' })
  for (const [id, backend, subject] of [[c, 'zhijian-demo-c', 'c'], [b, 'other', 'b']]) {
    store.bindWorkspace(id, `${subject}-workspace`)
    store.bindBackend(id, backend)
    store.provisionMember({ accountId: id, issuer: 'https://id.example', subject, displayName: subject })
  }
  const cLogin = store.issueBrowserSession({ accountId: c, issuer: 'https://id.example', subject: 'c' })
  const bLogin = store.issueBrowserSession({ accountId: b, issuer: 'https://id.example', subject: 'b' })
  const session = store.createResearchSession({ principal: cLogin.principal, requestId: 'approval-route-test' })
  store.bindDshSession(cLogin.principal, session.id, `session-${session.id}`)
  const share = store.createShareLink(cLogin.principal, session.id, { permission: 'read', days: 7 })
  const approval = { id: '11111111-1111-4111-8111-111111111111', toolName: 'expert_provider_call', reason: '生成福州脱敏样例的四份 Word 报告' }
  const answers = []
  const gateway = { pendingApproval: async () => ({ approval }), answerApproval: async (...args) => {
    answers.push(args); return { accepted: true }
  } }
  const config = readConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:18460', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    DSH_BACKENDS_JSON: JSON.stringify({ 'zhijian-demo-c': 'http://127.0.0.1:3103', other: 'http://127.0.0.1:3102' }),
    RESEARCH_ENABLED_BACKENDS: 'zhijian-demo-c,other', OIDC_ISSUER: 'https://id.example', OIDC_CLIENT_ID: 'portal',
    ACCOUNT_DB_PATH: '/tmp/customer-approval-route-test.sqlite', DSH_GATEWAY_TOKEN_DIR: '/tmp/customer-approval-route-tokens' })
  const server = createPortalServer(config, { store, oidc: {}, gateway })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/api/sessions/${session.id}/approval`
  const as = login => ({ cookie: `__Host-zhijian-session=${login.token}`, origin: config.publicOrigin,
    'x-csrf-token': login.csrf, 'content-type': 'application/json' })
  const body = JSON.stringify({ id: approval.id, decision: 'allowed-once' })
  assert.equal((await fetch(url)).status, 401)
  assert.equal((await fetch(url, { headers: as(bLogin) })).status, 404)
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${share.token}` } })).status, 200)
  assert.equal((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${share.token}`, origin: config.publicOrigin }, body })).status, 403)
  assert.equal((await fetch(url, { method: 'POST', headers: { ...as(cLogin), 'x-csrf-token': 'wrong' }, body })).status, 403)
  assert.deepEqual((await (await fetch(url, { headers: as(cLogin) })).json()).approval, approval)
  assert.equal((await fetch(url, { method: 'POST', headers: as(cLogin), body })).status, 200)
  assert.equal(answers.length, 1)
  assert.equal(answers[0][1], `session-${session.id}`)
})
