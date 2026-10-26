import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore } from '../account-store.mjs'
import { createCapabilityManagement } from '../capability-management.mjs'
import { readConfig } from '../config.mjs'
import { createPortalServer } from '../server.mjs'

test('capability adapter fixes destination, route, and local account backend', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'capability-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'a.token'), 'a'.repeat(48))
  const config = { gatewayTokenDir: dir, dshBackends: { a: 'http://127.0.0.1:3101' }, researchEnabledBackends: ['a'] }
  const seen = []
  const manager = createCapabilityManagement(config, async (url, options) => {
    seen.push([url.href, options.method, options.headers.authorization, options.redirect])
    return { status: 200, text: async () => JSON.stringify({ ok: true, items: [] }) }
  })
  const runtime = { backendRef: 'a', origin: config.dshBackends.a }
  assert.equal((await manager.call(runtime, 'GET', 'center-installations')).status, 200)
  assert.equal((await manager.call(runtime, 'GET', 'pack-preview', undefined, '智见房产')).status, 200)
  assert.equal((await manager.call(runtime, 'DELETE', 'managed-experts', undefined, 'expert-one')).status, 200)
  assert.equal((await manager.uploadSkill(runtime, 'skill-one', Buffer.from('PK sample').toString('base64'))).status, 200)
  assert.deepEqual(seen.map(item => item.slice(0, 2)), [
    ['http://127.0.0.1:3101/plugins/dsh-expert-library/manage/center/installations', 'GET'],
    ['http://127.0.0.1:3101/plugins/dsh-expert-library/packs?id=%E6%99%BA%E8%A7%81%E6%88%BF%E4%BA%A7', 'GET'],
    ['http://127.0.0.1:3101/plugins/dsh-expert-library/manage/experts?id=expert-one', 'DELETE'],
    ['http://127.0.0.1:3101/plugins/dsh-expert-library/manage/skills', 'POST'],
  ])
  assert.equal(seen.every(item => item[2] === `Bearer ${'a'.repeat(48)}` && item[3] === 'manual'), true)
  await assert.rejects(manager.call({ ...runtime, origin: 'http://127.0.0.1:3102' }, 'GET', 'health'))
  await assert.rejects(manager.call(runtime, 'GET', 'arbitrary-path'))
  await assert.rejects(manager.call(runtime, 'DELETE', 'managed-experts', undefined, '../bad'))
  await assert.rejects(manager.uploadSkill(runtime, '../bad', 'AAAA'))
  await assert.rejects(manager.uploadSkill(runtime, 'skill-two', 'not base64!'))
  assert.equal(seen.length, 4)
})

test('capability API requires account admin and CSRF, without accepting share access', async t => {
  const store = new AccountStore()
  t.after(() => store.close())
  const account = store.provisionAccount({ slug: 'account-a' })
  store.bindWorkspace(account, 'workspace-a'); store.bindBackend(account, 'a')
  for (const [subject, role] of [['member', 'member'], ['admin', 'admin']])
    store.provisionMember({ accountId: account, issuer: 'https://id.example', subject, displayName: subject, role })
  const member = store.issueBrowserSession({ accountId: account, issuer: 'https://id.example', subject: 'member' })
  const admin = store.issueBrowserSession({ accountId: account, issuer: 'https://id.example', subject: 'admin' })
  const config = readConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:18460', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    DSH_BACKENDS_JSON: JSON.stringify({ a: 'http://127.0.0.1:3101' }), RESEARCH_ENABLED_BACKENDS: 'a',
    OIDC_ISSUER: 'https://id.example', OIDC_CLIENT_ID: 'portal', ACCOUNT_DB_PATH: '/tmp/injected-test.sqlite',
    DSH_GATEWAY_TOKEN_DIR: '/tmp/injected-tokens' })
  const calls = []
  const capabilityManagement = {
    readable: name => ['health', 'pack-preview'].includes(name), writable: (name, method) => name === 'managed-experts' && method === 'PUT',
    call: async (runtime, method, name, body, id) => { calls.push([runtime.backendRef, method, name, id]); return { status: 200, data: { ok: true } } },
  }
  const gateway = { adminSettings: async runtime => { calls.push([runtime.backendRef, 'GET', 'settings']); return { writable: true, revision: 2 } },
    adminModels: async runtime => { calls.push([runtime.backendRef, 'GET', 'models']); return { models: [{ provider: 'sample', model: 'sample-model' }] } },
    updateAdminSettings: async runtime => { calls.push([runtime.backendRef, 'PUT', 'settings']); return { revision: 3 } } }
  const server = createPortalServer(config, { store, oidc: {}, capabilityManagement, gateway })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = login => ({ cookie: `__Host-zhijian-session=${login.token}`, origin: config.publicOrigin,
    'x-csrf-token': login.csrf, 'content-type': 'application/json' })
  assert.equal((await fetch(`${base}/api/capabilities/health`)).status, 401)
  assert.equal((await fetch(`${base}/api/capabilities/health`, { headers: headers(member) })).status, 403)
  assert.equal((await fetch(`${base}/api/capabilities/health`, { headers: { authorization: `Bearer ${'a'.repeat(43)}` } })).status, 403)
  assert.equal((await fetch(`${base}/api/capabilities/health`, { headers: headers(admin) })).status, 200)
  assert.equal((await fetch(`${base}/api/capabilities/pack-preview`, { headers: headers(admin) })).status, 400)
  assert.equal((await fetch(`${base}/api/capabilities/pack-preview?id=one`, { headers: headers(admin) })).status, 200)
  assert.equal((await fetch(`${base}/api/capabilities/settings`, { headers: headers(admin) })).status, 200)
  assert.equal((await fetch(`${base}/api/capabilities/models`, { headers: headers(member) })).status, 403)
  assert.equal((await fetch(`${base}/api/capabilities/models`, { method: 'POST', headers: headers(admin), body: '{}' })).status, 405)
  assert.deepEqual((await (await fetch(`${base}/api/capabilities/models`, { headers: headers(admin) })).json()).models,
    [{ provider: 'sample', model: 'sample-model' }])
  assert.equal((await fetch(`${base}/api/capabilities/managed-experts`, { method: 'PUT', headers: { cookie: headers(admin).cookie,
    origin: config.publicOrigin }, body: '{}' })).status, 403)
  assert.equal((await fetch(`${base}/api/capabilities/managed-experts`, { method: 'PUT', headers: headers(admin),
    body: JSON.stringify({ id: 'one' }) })).status, 200)
  assert.equal((await fetch(`${base}/api/capabilities/anything`, { headers: headers(admin) })).status, 404)
  assert.deepEqual(calls, [['a', 'GET', 'health', undefined], ['a', 'GET', 'pack-preview', 'one'], ['a', 'GET', 'settings'], ['a', 'GET', 'models'],
    ['a', 'PUT', 'managed-experts', undefined]])
})
