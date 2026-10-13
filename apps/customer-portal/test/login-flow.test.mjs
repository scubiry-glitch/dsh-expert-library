import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountStore } from '../account-store.mjs'
import { readConfig } from '../config.mjs'
import { createPortalServer } from '../server.mjs'

const cookie = (response, name) => response.headers.getSetCookie().find(item => item.startsWith(`${name}=`))?.split(';')[0]

test('OIDC callback is browser bound; only provisioned account sessions are listed', async t => {
  const store = new AccountStore()
  t.after(() => store.close())
  const a = store.provisionAccount({ slug: 'account-a' })
  const b = store.provisionAccount({ slug: 'account-b' })
  store.provisionMember({ accountId: a, issuer: 'https://issuer.example', subject: 'alice', displayName: 'Alice' })
  store.provisionMember({ accountId: b, issuer: 'https://issuer.example', subject: 'bob', displayName: 'Bob' })
  const alice = store.issueBrowserSession({ issuer: 'https://issuer.example', subject: 'alice', accountId: a })
  store.createResearchSession({ principal: alice.principal, requestId: 'alice-1', title: 'Alice private' })
  const config = readConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:18460', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    OIDC_ISSUER: 'https://issuer.example/oidc', OIDC_CLIENT_ID: 'zhijian-customer-portal', ACCOUNT_DB_PATH: '/tmp/unused-in-injected-test.sqlite' })
  const oidc = {
    async start({ state }) { return `https://issuer.example/oidc/authorize?state=${state}` },
    async finish() { return { issuer: 'https://issuer.example', subject: 'bob' } },
  }
  const server = createPortalServer(config, { store, oidc })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const start = await fetch(`${base}/api/auth/start`, { redirect: 'manual' })
  assert.equal(start.status, 302)
  const state = new URL(start.headers.get('location')).searchParams.get('state')
  const pending = cookie(start, '__Host-zhijian-login')
  assert.ok(pending)
  const bad = await fetch(`${base}/api/auth/callback?state=${state}&code=fake`, { redirect: 'manual' })
  assert.equal(bad.status, 401)
  const callback = await fetch(`${base}/api/auth/callback?state=${state}&code=fake`, { redirect: 'manual', headers: { cookie: pending } })
  assert.equal(callback.status, 302)
  const session = cookie(callback, '__Host-zhijian-session')
  assert.ok(session)
  const bootstrap = await fetch(`${base}/api/bootstrap`, { headers: { cookie: session } })
  assert.deepEqual((await bootstrap.json()).user, { displayName: 'Bob', accountName: 'account-b', role: 'member' })
  assert.equal((await fetch(`${base}/api/sessions`)).status, 401)
  const listing = await fetch(`${base}/api/sessions`, { headers: { cookie: session } })
  assert.deepEqual((await listing.json()).sessions, [])
  const forbiddenLogout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: session, origin: config.publicOrigin, 'x-csrf-token': 'wrong' } })
  assert.equal(forbiddenLogout.status, 403)
  assert.equal((await fetch(`${base}/api/sessions`, { headers: { cookie: session } })).status, 200)
  const csrf = cookie(callback, '__Host-zhijian-csrf').split('=')[1]
  const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: session, origin: config.publicOrigin, 'x-csrf-token': csrf } })
  assert.equal(logout.status, 200)
  assert.equal((await fetch(`${base}/api/sessions`, { headers: { cookie: session } })).status, 401)
})

test('identity configuration is all-or-none and issuer may have a path', () => {
  assert.throws(() => readConfig({ PUBLIC_ORIGIN: 'https://zhijian.meizu.life', DSH_BACKEND_URL: 'http://127.0.0.1:3080', OIDC_ISSUER: 'https://packs.meizu.life/oidc' }), /must be set together/)
  const config = readConfig({ PUBLIC_ORIGIN: 'https://zhijian.meizu.life', DSH_BACKEND_URL: 'http://127.0.0.1:3080', OIDC_ISSUER: 'https://packs.meizu.life/oidc', OIDC_CLIENT_ID: 'zhijian-customer-portal', ACCOUNT_DB_PATH: '/var/lib/zhijian/accounts.sqlite' })
  assert.equal(config.oidcIssuer, 'https://packs.meizu.life/oidc')
})

test('verified but unassigned identity enters pending queue without receiving a browser session', async t => {
  const store = new AccountStore()
  t.after(() => store.close())
  const config = readConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:18460', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    OIDC_ISSUER: 'https://issuer.example/oidc', OIDC_CLIENT_ID: 'zhijian-customer-portal', ACCOUNT_DB_PATH: '/tmp/unused-in-injected-test.sqlite' })
  const oidc = {
    async start({ state }) { return `https://issuer.example/oidc/authorize?state=${state}` },
    async finish() { return { issuer: 'https://issuer.example/oidc', subject: 'new-customer', displayName: 'New Customer' } },
  }
  const server = createPortalServer(config, { store, oidc })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const start = await fetch(`${base}/api/auth/start`, { redirect: 'manual' })
  const state = new URL(start.headers.get('location')).searchParams.get('state')
  const callback = await fetch(`${base}/api/auth/callback?state=${state}&code=fake`, { redirect: 'manual',
    headers: { cookie: cookie(start, '__Host-zhijian-login') } })
  assert.equal(callback.status, 302)
  assert.equal(callback.headers.get('location'), '/login?status=pending')
  assert.equal(cookie(callback, '__Host-zhijian-session'), undefined)
  assert.equal((await fetch(`${base}/api/sessions`)).status, 401)
  assert.deepEqual(store.listPendingIdentities().map(({ issuer, subject }) => ({ issuer, subject })),
    [{ issuer: 'https://issuer.example/oidc', subject: 'new-customer' }])
})
