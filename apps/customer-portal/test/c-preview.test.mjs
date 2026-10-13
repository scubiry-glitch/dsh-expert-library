import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AccountStore } from '../account-store.mjs'
import { readConfig } from '../config.mjs'
import { createCustomerPreview, C_PREVIEW_SESSION_ID } from '../c-preview.mjs'
import { createPortalServer } from '../server.mjs'

test('external snapshot is visible only to C and never accepts team writes', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'customer-c-preview-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  await mkdir(join(folder, 'documents'))
  const item = { taskId: 't14', id: 'formal-html', name: 'report.html', mediaType: 'text/html', formal: true }
  const state = { plan: { planId: 'plan-e8c5a4c2d6a34409c5ab29429a6fe977' },
    team: { id: '贵州租金与旅居市场分析-v5' }, documents: [item], preview: { kind: 'external-read-only' } }
  await writeFile(join(folder, 'workspace.json'), JSON.stringify(state))
  await writeFile(join(folder, 'documents', 't14-formal-html.json'), JSON.stringify({
    name: 'report.html', mediaType: 'text/html', content: '<h1>Snapshot</h1>' }))
  const store = new AccountStore()
  t.after(() => store.close())
  const c = store.provisionAccount({ slug: 'zhijian' }), b = store.provisionAccount({ slug: 'other' })
  store.bindWorkspace(c, 'c-workspace'); store.bindWorkspace(b, 'b-workspace')
  store.bindBackend(c, 'zhijian-demo-c'); store.bindBackend(b, 'other')
  for (const [accountId, subject] of [[c, 'c'], [b, 'b']])
    store.provisionMember({ accountId, issuer: 'https://id.example', subject, displayName: subject })
  const loginC = store.issueBrowserSession({ accountId: c, issuer: 'https://id.example', subject: 'c' })
  const loginB = store.issueBrowserSession({ accountId: b, issuer: 'https://id.example', subject: 'b' })
  const config = readConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:18460', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    DSH_BACKENDS_JSON: JSON.stringify({ 'zhijian-demo-c': 'http://127.0.0.1:3103', other: 'http://127.0.0.1:3102' }),
    RESEARCH_ENABLED_BACKENDS: 'zhijian-demo-c,other', OIDC_ISSUER: 'https://id.example', OIDC_CLIENT_ID: 'portal',
    ACCOUNT_DB_PATH: '/tmp/injected-preview-test.sqlite', DSH_GATEWAY_TOKEN_DIR: '/tmp/injected-preview-tokens' })
  const preview = createCustomerPreview(pathToFileURL(`${folder}/`))
  const server = createPortalServer(config, { store, oidc: {}, preview })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = login => ({ cookie: `__Host-zhijian-session=${login.token}` })
  const path = `/api/sessions/${C_PREVIEW_SESSION_ID}`
  assert.equal((await fetch(`${base}/api/sessions`)).status, 401)
  assert.equal((await (await fetch(`${base}/api/sessions`, { headers: headers(loginC) })).json()).sessions.at(-1).preview, true)
  assert.equal((await (await fetch(`${base}/api/sessions`, { headers: headers(loginB) })).json()).sessions.length, 0)
  assert.equal((await fetch(`${base}${path}/workspace`)).status, 401)
  assert.equal((await fetch(`${base}${path}/workspace`, { headers: headers(loginB) })).status, 404)
  assert.equal((await (await fetch(`${base}${path}/workspace`, { headers: headers(loginC) })).json()).team.id, state.team.id)
  assert.equal((await fetch(`${base}${path}/workspace/action`, { method: 'POST', headers: headers(loginC) })).status, 405)
  assert.equal((await fetch(`${base}${path}/messages`, { method: 'POST', headers: headers(loginC) })).status, 405)
  assert.equal((await fetch(`${base}${path}/workspace/documents/t14/formal-html`, { headers: headers(loginB) })).status, 404)
  assert.equal((await fetch(`${base}${path}/workspace/documents/t14/other`, { headers: headers(loginC) })).status, 404)
  const html = await fetch(`${base}${path}/workspace/documents/t14/formal-html/preview`, { headers: headers(loginC) })
  assert.equal(html.status, 200)
  assert.match(html.headers.get('content-security-policy'), /sandbox;.*script-src 'none'/)
  assert.match(await html.text(), /Snapshot/)
})
