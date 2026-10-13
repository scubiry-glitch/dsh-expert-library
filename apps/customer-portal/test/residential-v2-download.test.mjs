import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { AccountStore } from '../account-store.mjs'
import { readConfig } from '../config.mjs'
import { createPortalServer } from '../server.mjs'

test('frozen demo DOCX download requires C login and checks upstream bytes', async t => {
  const store = new AccountStore()
  t.after(() => store.close())
  const c = store.provisionAccount({ slug: 'zhijian' })
  const b = store.provisionAccount({ slug: 'other' })
  for (const [id, ref, subject] of [[c, 'zhijian-demo-c', 'c'], [b, 'other', 'b']]) {
    store.bindWorkspace(id, `${subject}-workspace`)
    store.bindBackend(id, ref)
    store.provisionMember({ accountId: id, issuer: 'https://id.example', subject, displayName: subject })
  }
  const cLogin = store.issueBrowserSession({ accountId: c, issuer: 'https://id.example', subject: 'c' })
  const bLogin = store.issueBrowserSession({ accountId: b, issuer: 'https://id.example', subject: 'b' })
  const session = store.createResearchSession({ principal: cLogin.principal, requestId: 'demo-file-test' })
  const share = store.createShareLink(cLogin.principal, session.id, { permission: 'read', days: 7 })
  const bytes = Buffer.from('PK\u0003\u0004demo-docx')
  const digest = createHash('sha256').update(bytes).digest('hex')
  let fetched = 0
  const config = readConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:18460', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    DSH_BACKENDS_JSON: JSON.stringify({ 'zhijian-demo-c': 'http://127.0.0.1:3103', other: 'http://127.0.0.1:3102' }),
    RESEARCH_ENABLED_BACKENDS: 'zhijian-demo-c,other', OIDC_ISSUER: 'https://id.example', OIDC_CLIENT_ID: 'portal',
    ACCOUNT_DB_PATH: '/tmp/residential-v2-download-test.sqlite', DSH_GATEWAY_TOKEN_DIR: '/tmp/residential-v2-download-test-tokens' })
  const server = createPortalServer(config, { store, oidc: {}, residentialV2Fetch: async () => {
    fetched++
    return new Response(bytes, { status: 200,
      headers: { 'content-length': String(bytes.length), 'x-content-sha256': digest } })
  } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/api/residential-v2/files/rv2-1234567890abcdef12345678/price_full-1234567890ab`
  const cookie = login => ({ cookie: `__Host-zhijian-session=${login.token}` })
  assert.equal((await fetch(url)).status, 401)
  assert.equal((await fetch(url, { headers: cookie(bLogin) })).status, 404)
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${share.token}` } })).status, 404)
  assert.equal(fetched, 0)
  const response = await fetch(url, { headers: cookie(cLogin) })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  assert.equal(fetched, 1)
})
