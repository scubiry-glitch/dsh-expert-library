import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AccountStore } from '../account-store.mjs'
import { readConfig } from '../config.mjs'
import { createCustomerHistoricalPreviews } from '../c-historical-previews.mjs'
import { createPortalServer } from '../server.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const sources = [
  ['chengdu', 'dd2c8815-287c-4bcf-8925-e9cb76ebc747', '智见报告-成都数据集团合作',
    'session-aec3fc2a-285d-4c57-b987-901ac5a3d58b', '20260905-cddg-coop-report-v2-designer.html'],
  ['roles', '8a3d657f-335c-40ad-aafc-41c6ff465f29', '智见点评-十二主体角色重写',
    'session-6d6dad49-4b0f-4e9a-afb1-ba3dba1a684e', 'role-rewrite-12-v54.html'],
  ['haixing', 'e1e6186d-8600-4a2f-8be5-f503b6964d57', '智见点评-海兴雅苑一居室租金定价',
    'session-397808a7-36a6-45c5-8572-606524ca54fa', 'rent-pricing.html'],
]

test('original sessions are separate, account-scoped, read-only, and retain source messages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'customer-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [folder, id, teamId, captainSessionId, sourceFile] of sources) {
    const dir = join(root, folder)
    await mkdir(dir)
    const report = Buffer.from(`<h1>${teamId}</h1>`)
    const workspace = Buffer.from(JSON.stringify({ team: { id: teamId, captainSessionId, tasks: [] },
      plan: null, documents: [{ taskId: 't7', id: 'source-html', name: sourceFile, formal: true }],
      preview: { kind: 'external-read-only', source: 'original-session', reportScripts: folder === 'haixing' } }))
    const messages = Buffer.from(JSON.stringify([{ seq: 0, role: 'user', text: '原始需求', time: 1 },
      { seq: 1, role: 'assistant', text: '原始交付', time: 2 }]))
    const manifest = { version: 1, kind: 'original-session', session: { id }, teamId, captainSessionId,
      sourceFile, workspaceSha256: sha(workspace), messagesSha256: sha(messages),
      report: { taskId: 't7', id: 'source-html', name: sourceFile, mediaType: 'text/html',
        sizeBytes: report.length, sha256: sha(report) } }
    for (const [name, value] of Object.entries({ 'manifest.json': JSON.stringify(manifest),
      'workspace.json': workspace, 'messages.json': messages, 'report.html': report }))
      await writeFile(join(dir, name), value)
  }
  const previews = createCustomerHistoricalPreviews(pathToFileURL(`${root}/`))
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
    ACCOUNT_DB_PATH: '/tmp/injected-history-test.sqlite', DSH_GATEWAY_TOKEN_DIR: '/tmp/injected-history-tokens' })
  const server = createPortalServer(config, { store, oidc: {}, historicalPreviews: previews })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = login => ({ cookie: `__Host-zhijian-session=${login.token}` })
  const listC = await (await fetch(`${base}/api/sessions`, { headers: headers(loginC) })).json()
  const listB = await (await fetch(`${base}/api/sessions`, { headers: headers(loginB) })).json()
  assert.deepEqual(listC.sessions.filter(item => item.previewKind === 'historical-session').map(item => item.id),
    [sources[2][1], sources[0][1], sources[1][1]])
  assert.equal(listB.sessions.some(item => item.previewKind === 'historical-session'), false)
  for (const [, id, teamId] of sources) {
    const path = `${base}/api/sessions/${id}`
    assert.equal((await fetch(`${path}/workspace`)).status, 401)
    assert.equal((await fetch(`${path}/workspace`, { headers: headers(loginB) })).status, 404)
    const response = await fetch(`${path}/workspace`, { headers: headers(loginC) })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).team.id, teamId)
    const messageResponse = await fetch(`${path}/messages?after=-1`, { headers: headers(loginC) })
    assert.deepEqual((await messageResponse.json()).messages.map(item => item.text), ['原始需求', '原始交付'])
    const latestResponse = await fetch(`${path}/messages?latest=1`, { headers: headers(loginC) })
    assert.deepEqual((await latestResponse.json()).messages.map(item => item.text), ['原始需求', '原始交付'])
    const olderResponse = await fetch(`${path}/messages?latest=1&before=1`, { headers: headers(loginC) })
    assert.deepEqual((await olderResponse.json()).messages.map(item => item.text), ['原始需求'])
    assert.equal((await fetch(`${path}/messages?latest=1&before=-1`, { headers: headers(loginC) })).status, 400)
    const reportResponse = await fetch(`${path}/workspace/documents/t7/source-html/preview`, { headers: headers(loginC) })
    assert.equal(reportResponse.status, 200)
    assert.equal(reportResponse.headers.get('content-security-policy').includes('sandbox allow-scripts'), id === sources[2][1])
    assert.equal((await fetch(`${path}/workspace/action`, { method: 'POST', headers: headers(loginC) })).status, 405)
  }
  assert.equal((await fetch(`${base}/api/sessions/b7d9e3c9-3f21-4dd8-9535-3b30c09ed5d5/workspace`,
    { headers: headers(loginC) })).status, 404)
  await writeFile(join(root, 'roles', 'report.html'), '<h1>changed</h1>')
  assert.equal((await fetch(`${base}/api/sessions/${sources[1][1]}/workspace`, { headers: headers(loginC) })).status, 503)
})
