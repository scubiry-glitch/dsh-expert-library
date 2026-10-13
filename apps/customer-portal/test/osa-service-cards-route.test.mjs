import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountStore } from '../account-store.mjs'
import { readConfig } from '../config.mjs'
import { createPortalServer } from '../server.mjs'

test('only an account-scoped synthetic OSA session receives cards through the conversation API', async t => {
  const store = new AccountStore()
  t.after(() => store.close())
  const accountId = store.provisionAccount({ slug: 'demo-c' })
  store.bindWorkspace(accountId, 'workspace-c')
  store.bindBackend(accountId, 'zhijian-demo-c')
  store.provisionMember({ accountId, issuer: 'https://id.example', subject: 'c', displayName: 'C' })
  const login = store.issueBrowserSession({ accountId, issuer: 'https://id.example', subject: 'c' })
  const synthetic = store.createResearchSession({ principal: login.principal, requestId: 'osa-demo', title: '客户专家Agent · 林女士置换咨询' })
  const normal = store.createResearchSession({ principal: login.principal, requestId: 'normal-chat', title: '普通客户会话' })
  for (const row of [synthetic, normal]) store.bindDshSession(login.principal, row.id, `session-${row.id}`)
  const config = readConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:18460', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    DSH_BACKENDS_JSON: JSON.stringify({ 'zhijian-demo-c': 'http://127.0.0.1:3193' }),
    RESEARCH_ENABLED_BACKENDS: 'zhijian-demo-c', OIDC_ISSUER: 'https://id.example',
    OIDC_CLIENT_ID: 'portal', ACCOUNT_DB_PATH: '/tmp/injected-test.sqlite', DSH_GATEWAY_TOKEN_DIR: '/tmp/injected-tokens' })
  const conversation = [
    { role: 'user', text: '【CAgent 场景初始化】\nOSA 客户计划：林女士置换（只读合成模板 lin-case）。', seq: 0 },
    { role: 'assistant', text: '请说说您的需求', seq: 1 },
    { role: 'user', text: '新房首付先到、旧房款未回', seq: 2 },
    { role: 'assistant', text: '先核对资金时间', seq: 3 },
    { role: 'assistant', text: '补充说明', seq: 4 },
  ]
  let firstReads = 0
  const gateway = { conversation: async (_runtime, _id, after, latest, before) => {
    if (after === -1 && !latest) { firstReads++; return { messages: conversation.slice(0, 2), nextCursor: 1, hasMore: true } }
    if (latest && before === 3) return { messages: conversation.slice(2, 3), nextCursor: 2, hasMore: false }
    if (latest && before === 4) return { messages: conversation.slice(2, 4), nextCursor: 3, hasMore: false }
    if (after === 2) return { messages: conversation.slice(3, 4), nextCursor: 3, hasMore: true }
    if (after === 3) return { messages: conversation.slice(4), nextCursor: 4, hasMore: false }
    return { messages: conversation.slice(2, 4), nextCursor: 3, hasMore: false, hasEarlier: true }
  } }
  const server = createPortalServer(config, { store, oidc: {}, gateway })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { cookie: `__Host-zhijian-session=${login.token}` }
  const route = id => `${base}/api/sessions/${id}/messages?latest=1`
  assert.equal((await fetch(route(synthetic.id))).status, 401)
  const demoPage = await (await fetch(route(synthetic.id), { headers })).json()
  assert.deepEqual(demoPage.messages[1].serviceCards.map(card => card.id), ['demo-housing-plan', 'demo-jsb-housing-loan'])
  assert.equal(firstReads, 1)
  const splitPage = await (await fetch(`${base}/api/sessions/${synthetic.id}/messages?after=2`, { headers })).json()
  assert.deepEqual(splitPage.messages[0].serviceCards.map(card => card.id), ['demo-housing-plan', 'demo-jsb-housing-loan'])
  const continuation = await (await fetch(`${base}/api/sessions/${synthetic.id}/messages?after=3`, { headers })).json()
  assert.equal(continuation.messages[0].serviceCards, undefined)
  const demoReads = firstReads
  const normalPage = await (await fetch(route(normal.id), { headers })).json()
  assert.equal(normalPage.messages[1].serviceCards, undefined)
  assert.equal(firstReads, demoReads)
})
