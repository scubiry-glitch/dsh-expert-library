import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore } from '../account-store.mjs'
import { readConfig } from '../config.mjs'
import { createPortalServer } from '../server.mjs'

test('expiring session links grant only their session and chosen permission', async t => {
  const store = new AccountStore()
  t.after(() => store.close())
  const accountA = store.provisionAccount({ slug: 'account-a' })
  const accountB = store.provisionAccount({ slug: 'account-b' })
  store.bindWorkspace(accountA, 'workspace-a'); store.bindBackend(accountA, 'a')
  store.bindWorkspace(accountB, 'workspace-b'); store.bindBackend(accountB, 'b')
  store.provisionMember({ accountId: accountA, issuer: 'https://id.example', subject: 'a', displayName: 'A' })
  store.provisionMember({ accountId: accountB, issuer: 'https://id.example', subject: 'b', displayName: 'B' })
  const loginA = store.issueBrowserSession({ accountId: accountA, issuer: 'https://id.example', subject: 'a' })
  const loginB = store.issueBrowserSession({ accountId: accountB, issuer: 'https://id.example', subject: 'b' })
  const first = store.createResearchSession({ principal: loginA.principal, requestId: 'share-session-first' })
  const second = store.createResearchSession({ principal: loginA.principal, requestId: 'share-session-second' })
  store.bindDshSession(loginA.principal, first.id, `session-${first.id}`)
  store.bindDshSession(loginA.principal, second.id, `session-${second.id}`)
  const config = readConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:18460', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    DSH_BACKENDS_JSON: JSON.stringify({ a: 'http://127.0.0.1:3101', b: 'http://127.0.0.1:3102' }),
    RESEARCH_ENABLED_BACKENDS: 'a,b', DSH_GATEWAY_TOKEN_DIR: '/tmp/portal-share-test-tokens',
    OIDC_ISSUER: 'https://id.example', OIDC_CLIENT_ID: 'portal', ACCOUNT_DB_PATH: '/tmp/portal-share-test.sqlite' })
  const calls = []
  const previewId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const preview = { session: { id: previewId, title: '历史预览', createdAt: Date.now(), preview: true },
    visible: principal => principal?.slug === 'account-a', available: async () => true,
    workspace: async () => ({ plan: null, team: null, documents: [] }),
    messages: async () => ({ messages: [], nextCursor: 0, hasMore: false }),
    document: async () => undefined }
  const gateway = {
    mentions: async () => ({ items: [{ kind: 'data-source', name: 'sample' }] }),
    conversation: async (runtime, id) => { calls.push(['read', runtime.backendRef, id]); return { messages: [], nextCursor: 0, hasMore: false } },
    sendMessage: async (runtime, id) => { calls.push(['send', runtime.backendRef, id]); return { accepted: true } },
    workspace: async (runtime, id) => { calls.push(['workspace', runtime.backendRef, id]); return { plan: null, team: null, datasets: [] } },
    workspaceAction: async (runtime, id) => { calls.push(['action', runtime.backendRef, id]); return { plan: null, team: null } },
    models: async () => ({ models: [] }),
    conversationModel: async () => ({ selected: { provider: 'sample', model: 'sample-model' }, models: [] }),
    selectConversationModel: async (runtime, id, selection) => { calls.push(['select-model', runtime.backendRef, id]); return { selected: selection } },
    pendingQuestion: async () => ({ question: null }),
    answerQuestion: async (runtime, id) => { calls.push(['answer', runtime.backendRef, id]); return { accepted: true } },
    listDatasets: async () => ({ items: [], hasMore: false }),
    readDataset: async () => ({ rows: [] }),
    document: async () => ({ document: { name: 'report.md', content: 'shared', mediaType: 'text/markdown' } }),
  }
  const server = createPortalServer(config, { store, oidc: {}, gateway, preview, historicalPreviews: [] })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const owner = login => ({ cookie: `__Host-zhijian-session=${login.token}`, origin: config.publicOrigin,
    'x-csrf-token': login.csrf, 'content-type': 'application/json' })
  const bearer = token => ({ authorization: `Bearer ${token}`, origin: config.publicOrigin, 'content-type': 'application/json' })
  const create = (id, login, permission, days = 7) => fetch(`${base}/api/sessions/${id}/shares`, {
    method: 'POST', headers: owner(login), body: JSON.stringify({ permission, days }),
  })
  assert.equal((await create(first.id, loginB, 'read')).status, 404)
  assert.equal((await create(first.id, loginA, 'read', 0)).status, 400)
  const readResponse = await create(first.id, loginA, 'read')
  assert.equal(readResponse.status, 201)
  const read = await readResponse.json()
  assert.equal(read.share.expiresAt - read.share.createdAt, 7 * 24 * 60 * 60 * 1000)
  assert.equal(read.token.length, 43)
  assert.notEqual(store.db.prepare('SELECT token_hash FROM session_share_links WHERE id=?').get(read.share.id).token_hash, read.token)
  const listed = await (await fetch(`${base}/api/sessions/${first.id}/shares`, { headers: owner(loginA) })).json()
  assert.equal(listed.shares.length, 1)
  assert.equal(JSON.stringify(listed).includes(read.token), false)
  assert.equal((await (await fetch(`${base}/api/bootstrap`, { headers: bearer(read.token) })).json()).share.permission, 'read')
  const sharedSessions = await (await fetch(`${base}/api/sessions`, { headers: bearer(read.token) })).json()
  assert.deepEqual(sharedSessions.sessions.map(item => item.id), [first.id])
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/messages`, { headers: bearer(read.token) })).status, 200)
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/workspace`, { headers: bearer(read.token) })).status, 200)
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/model`, { headers: bearer(read.token) })).status, 200)
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/model`, { method: 'POST', headers: bearer(read.token),
    body: JSON.stringify({ provider: 'sample', model: 'sample-model' }) })).status, 403)
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/datasets`, { headers: bearer(read.token) })).status, 200)
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/workspace/documents/t1/report`, { headers: bearer(read.token) })).status, 200)
  assert.equal((await fetch(`${base}/api/sessions/${second.id}/messages`, { headers: bearer(read.token) })).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/messages`, { method: 'POST', headers: bearer(read.token),
    body: JSON.stringify({ text: 'not allowed', requestId: 'share-read-request' }) })).status, 403)
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/question`, { method: 'POST', headers: bearer(read.token),
    body: JSON.stringify({ requestId: '11111111-1111-4111-8111-111111111111', answers: [] }) })).status, 403)
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/workspace/action`, { method: 'POST', headers: bearer(read.token),
    body: JSON.stringify({ action: 'approve' }) })).status, 403)
  assert.equal((await fetch(`${base}/api/sessions/${first.id}`, { method: 'PATCH', headers: bearer(read.token),
    body: JSON.stringify({ title: 'stolen' }) })).status, 403)
  const collabResponse = await create(first.id, loginA, 'collaborate', 3)
  assert.equal(collabResponse.status, 201)
  const collab = await collabResponse.json()
  assert.equal(collab.share.expiresAt - collab.share.createdAt, 3 * 24 * 60 * 60 * 1000)
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/messages`, { method: 'POST', headers: bearer(collab.token),
    body: JSON.stringify({ text: 'hello', requestId: 'share-collab-request' }) })).status, 202)
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/model`, { method: 'POST', headers: bearer(collab.token),
    body: JSON.stringify({ provider: 'sample', model: 'sample-model' }) })).status, 200)
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/question`, { method: 'POST', headers: bearer(collab.token),
    body: JSON.stringify({ requestId: '11111111-1111-4111-8111-111111111111', answers: [] }) })).status, 200)
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/workspace/action`, { method: 'POST', headers: bearer(collab.token),
    body: JSON.stringify({ action: 'approve' }) })).status, 200)
  assert.equal((await fetch(`${base}/api/sessions/${second.id}/messages`, { method: 'POST', headers: bearer(collab.token),
    body: JSON.stringify({ text: 'blocked', requestId: 'share-other-request' }) })).status, 404)
  const noOrigin = { ...bearer(collab.token) }; delete noOrigin.origin
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/messages`, { method: 'POST', headers: noOrigin,
    body: JSON.stringify({ text: 'blocked', requestId: 'share-no-origin-request' }) })).status, 403)
  assert.deepEqual(calls.filter(call => ['send', 'select-model', 'answer', 'action'].includes(call[0])).map(call => call[1]), ['a', 'a', 'a', 'a'])
  assert.equal((await fetch(`${base}/api/shares/${read.share.id}`, { method: 'DELETE', headers: owner(loginA) })).status, 200)
  assert.equal((await (await fetch(`${base}/api/bootstrap`, { headers: bearer(read.token) })).json()).authenticated, false)
  store.db.prepare('UPDATE session_share_links SET expires_at=? WHERE id=?').run(Date.now() - 1, collab.share.id)
  assert.equal((await (await fetch(`${base}/api/bootstrap`, { headers: bearer(collab.token) })).json()).authenticated, false)
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/messages`, { headers: bearer(collab.token) })).status, 401)
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/messages`, { headers: owner(loginA) })).status, 200)
  assert.equal((await create(previewId, loginA, 'collaborate')).status, 400)
  const previewShare = await (await create(previewId, loginA, 'read')).json()
  assert.deepEqual((await (await fetch(`${base}/api/sessions`, { headers: bearer(previewShare.token) })).json())
    .sessions.map(item => item.id), [previewId])
  assert.equal((await fetch(`${base}/api/sessions/${previewId}/workspace`, { headers: bearer(previewShare.token) })).status, 200)
  assert.equal((await fetch(`${base}/api/sessions/${first.id}/messages`, { headers: bearer(previewShare.token) })).status, 404)
})

test('share link survives service restart and revocation persists', t => {
  const dir = mkdtempSync(join(tmpdir(), 'zhijian-share-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'accounts.sqlite')
  let store = new AccountStore(path)
  const accountId = store.provisionAccount({ slug: 'owner' })
  store.provisionMember({ accountId, issuer: 'https://id.example', subject: 'owner', displayName: 'Owner' })
  const login = store.issueBrowserSession({ accountId, issuer: 'https://id.example', subject: 'owner' })
  const session = store.createResearchSession({ principal: login.principal, requestId: 'persistent-share' })
  store.bindDshSession(login.principal, session.id, `session-${session.id}`)
  const share = store.createShareLink(login.principal, session.id, { permission: 'read', days: 7 })
  store.close()
  store = new AccountStore(path)
  assert.equal(store.resolveShareLink(share.token)?.sessionId, session.id)
  assert.equal(store.revokeShareLink(login.principal, share.id), true)
  store.close()
  store = new AccountStore(path)
  assert.equal(store.resolveShareLink(share.token), undefined)
  store.close()
})
