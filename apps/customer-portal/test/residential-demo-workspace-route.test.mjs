import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountStore } from '../account-store.mjs'
import { readConfig } from '../config.mjs'
import { createPortalServer } from '../server.mjs'

test('C session workspace includes verified demo projection without creating a formal team plan', async t => {
  const store = new AccountStore()
  t.after(() => store.close())
  const account = store.provisionAccount({ slug: 'zhijian' })
  store.bindWorkspace(account, 'c-workspace')
  store.bindBackend(account, 'zhijian-demo-c')
  store.provisionMember({ accountId: account, issuer: 'https://id.example', subject: 'c', displayName: 'c' })
  const login = store.issueBrowserSession({ accountId: account, issuer: 'https://id.example', subject: 'c' })
  const session = store.createResearchSession({ principal: login.principal, requestId: 'demo-workspace-route' })
  store.bindDshSession(login.principal, session.id, `session-${session.id}`)
  const config = readConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:18460', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    DSH_BACKENDS_JSON: JSON.stringify({ 'zhijian-demo-c': 'http://127.0.0.1:3103' }),
    RESEARCH_ENABLED_BACKENDS: 'zhijian-demo-c', OIDC_ISSUER: 'https://id.example', OIDC_CLIENT_ID: 'portal',
    ACCOUNT_DB_PATH: '/tmp/residential-demo-workspace-route.sqlite', DSH_GATEWAY_TOKEN_DIR: '/tmp/residential-demo-workspace-route-tokens' })
  const projected = { kind: 'fuzhou-golden-demo', files: [{ role: 'price_full' }] }
  const gateway = { workspace: async () => ({ version: 1, plan: null, team: null, documents: [] }) }
  const residentialDemoWorkspace = { forSession: async scope => {
    assert.equal(scope.backendRef, 'zhijian-demo-c')
    assert.equal(scope.sessionId, session.id)
    return projected
  } }
  const server = createPortalServer(config, { store, oidc: {}, gateway, residentialDemoWorkspace })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/api/sessions/${session.id}/workspace`
  assert.equal((await fetch(url)).status, 401)
  const response = await fetch(url, { headers: { cookie: `__Host-zhijian-session=${login.token}` } })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.plan, null)
  assert.equal(body.team, null)
  assert.deepEqual(body.residentialDemo, projected)
})
