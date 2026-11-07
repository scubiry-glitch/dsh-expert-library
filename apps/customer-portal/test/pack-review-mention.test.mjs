import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountStore } from '../account-store.mjs'
import { readConfig } from '../config.mjs'
import { createPortalServer } from '../server.mjs'

test('only account C admins can select the session pack review mention', async t => {
  const store = new AccountStore()
  t.after(() => store.close())
  const account = store.provisionAccount({ slug: 'account-c' })
  store.bindWorkspace(account, 'workspace-c')
  store.bindBackend(account, 'zhijian-demo-c')
  for (const role of ['admin', 'member'])
    store.provisionMember({ accountId: account, issuer: 'https://id.example', subject: role, displayName: role, role })
  const admin = store.issueBrowserSession({ accountId: account, issuer: 'https://id.example', subject: 'admin' })
  const member = store.issueBrowserSession({ accountId: account, issuer: 'https://id.example', subject: 'member' })
  const config = readConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:18460', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    DSH_BACKENDS_JSON: JSON.stringify({ 'zhijian-demo-c': 'http://127.0.0.1:3103' }),
    RESEARCH_ENABLED_BACKENDS: 'zhijian-demo-c', OIDC_ISSUER: 'https://id.example', OIDC_CLIENT_ID: 'portal',
    ACCOUNT_DB_PATH: '/tmp/injected-test.sqlite', DSH_GATEWAY_TOKEN_DIR: '/tmp/injected-tokens' })
  const review = { kind: 'pack-review', id: 'city.pack', version: '2.5.1',
    name: '领域包优化顾问', packName: '城市月报', description: '检查领域包' }
  const assistant = { kind: 'expert', id: 'host.domain-pack-assistant', version: '1.0.0',
    name: '领域包助手', description: '创建、更新、检查和下载领域包' }
  const sent = []
  const gateway = { mentions: async () => ({ items: [review, assistant] }),
    sendMessage: async (...args) => { sent.push(args); return { accepted: true } } }
  const server = createPortalServer(config, { store, oidc: {}, gateway })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = login => ({ cookie: `__Host-zhijian-session=${login.token}`, origin: config.publicOrigin,
    'x-csrf-token': login.csrf, 'content-type': 'application/json' })
  assert.deepEqual((await (await fetch(`${base}/api/mentions`, { headers: headers(admin) })).json()).items, [assistant])
  assert.deepEqual((await (await fetch(`${base}/api/mentions`, { headers: headers(member) })).json()).items, [])
  const row = store.createResearchSession({ principal: admin.principal, requestId: 'pack-review-session' })
  store.bindDshSession(admin.principal, row.id, `session-${row.id}`)
  const memberRow = store.createResearchSession({ principal: member.principal, requestId: 'member-review-session' })
  store.bindDshSession(member.principal, memberRow.id, `session-${memberRow.id}`)
  const url = `${base}/api/sessions/${row.id}/messages`
  const memberUrl = `${base}/api/sessions/${memberRow.id}/messages`
  const body = JSON.stringify({ text: `@${review.name} 检查`, requestId: 'review-request-1',
    mentions: [{ kind: review.kind, id: review.id, version: review.version, name: review.name }] })
  assert.equal((await fetch(memberUrl, { method: 'POST', headers: headers(member), body })).status, 403)
  assert.equal((await fetch(url, { method: 'POST', headers: headers(admin), body })).status, 202)
  const assistantBody = JSON.stringify({ text: `@${assistant.name} 创建新领域包`, requestId: 'assistant-request-1',
    mentions: [{ kind: assistant.kind, id: assistant.id, version: assistant.version, name: assistant.name }] })
  assert.equal((await fetch(memberUrl, { method: 'POST', headers: headers(member), body: assistantBody })).status, 403)
  assert.equal((await fetch(url, { method: 'POST', headers: headers(admin), body: assistantBody })).status, 202)
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0][4], [{ kind: review.kind, id: review.id, version: review.version, name: review.name }])
  assert.deepEqual(sent[1][4], [{ kind: assistant.kind, id: assistant.id, version: assistant.version, name: assistant.name }])
})
