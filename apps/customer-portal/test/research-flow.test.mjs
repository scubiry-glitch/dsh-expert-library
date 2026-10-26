import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountStore } from '../account-store.mjs'
import { readConfig } from '../config.mjs'
import { createPortalServer } from '../server.mjs'

test('account A creates and asks in its DSH instance; account B cannot open or send to it', async t => {
  const store = new AccountStore()
  t.after(() => store.close())
  const accountA = store.provisionAccount({ slug: 'account-a' })
  const accountB = store.provisionAccount({ slug: 'account-b' })
  store.bindWorkspace(accountA, 'workspace-a'); store.bindWorkspace(accountB, 'workspace-b')
  store.bindBackend(accountA, 'a'); store.bindBackend(accountB, 'b')
  store.provisionMember({ accountId: accountA, issuer: 'https://id.example', subject: 'a', displayName: 'A' })
  store.provisionMember({ accountId: accountB, issuer: 'https://id.example', subject: 'b', displayName: 'B' })
  const loginA = store.issueBrowserSession({ accountId: accountA, issuer: 'https://id.example', subject: 'a' })
  const loginB = store.issueBrowserSession({ accountId: accountB, issuer: 'https://id.example', subject: 'b' })
  const config = readConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:18460', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    DSH_BACKENDS_JSON: JSON.stringify({ a: 'http://127.0.0.1:3101', b: 'http://127.0.0.1:3102' }),
    RESEARCH_ENABLED_BACKENDS: 'a,b',
    OIDC_ISSUER: 'https://id.example', OIDC_CLIENT_ID: 'portal', ACCOUNT_DB_PATH: '/tmp/injected-test.sqlite',
    DSH_GATEWAY_TOKEN_DIR: '/tmp/injected-tokens' })
  const calls = []
  const gateway = {
    mentions: async runtime => { calls.push(['mentions', runtime.origin]); return { items: runtime.backendRef === 'a'
      ? [{ name: '智见', kind: 'data-source', provider: 'zyt' }] : [] } },
    createSession: async (runtime, sessionId) => { calls.push(['create', runtime.origin, sessionId]); return { sessionId } },
    sendMessage: async (runtime, sessionId, text) => {
      if (text.includes('@未知')) throw Object.assign(new Error('unavailable'), { code: 'MENTION_UNAVAILABLE' })
      calls.push(['message', runtime.origin, sessionId, text]); return { accepted: true }
    },
    uploadAttachment: async (runtime, sessionId, name, data) => { calls.push(['upload', runtime.origin, sessionId, name, data]);
      return { name, path: `customer-uploads/${sessionId}/stored.txt`, sizeBytes: 5 } },
    removeAttachment: async (runtime, sessionId, path) => { calls.push(['remove', runtime.origin, sessionId, path]); return { removed: true } },
    conversation: async (runtime, sessionId) => { calls.push(['read', runtime.origin, sessionId]); return { messages: [], nextCursor: -1, hasMore: false } },
    listDatasets: async (runtime, sessionId) => { calls.push(['datasets', runtime.origin, sessionId]); return { items: [{ id: '1234567890123-11111111-1111-4111-8111-111111111111' }], hasMore: false } },
    readDataset: async (runtime, sessionId, id) => { calls.push(['table', runtime.origin, sessionId, id]); return { id, rows: [[1]] } },
    workspace: async (runtime, sessionId) => { calls.push(['workspace', runtime.origin, sessionId]); return { plan: null,
      team: { halted: false, tasks: [{ id: 'research', status: 'in_progress' }] }, datasets: [] } },
    activityBatch: async (runtime, sessionIds) => { calls.push(['activity-batch', runtime.origin, [...sessionIds]]);
      if (runtime.backendRef === 'b') throw Object.assign(new Error('legacy gateway'), { status: 404 })
      return { items: sessionIds.map(sessionId => ({ sessionId, running: true })) } },
    activity: async (runtime, sessionId) => { calls.push(['activity', runtime.origin, sessionId]); return { running: true } },
    models: async (runtime, sessionId) => { calls.push(['models', runtime.origin, sessionId]); return { models: [{ provider: 'sample', model: 'sample-model' }] } },
    conversationModel: async (runtime, sessionId) => { calls.push(['conversation-model', runtime.origin, sessionId]); return { selected: { provider: 'sample', model: 'sample-model' }, models: [{ provider: 'sample', model: 'sample-model' }] } },
    selectConversationModel: async (runtime, sessionId, selection) => { calls.push(['select-model', runtime.origin, sessionId, selection.model]); return { selected: selection } },
    workspaceAction: async (runtime, sessionId, action) => { calls.push(['workspace-action', runtime.origin, sessionId, action.action]); return { plan: null, team: null, action: action.action } },
    document: async (runtime, sessionId, taskId, artifactId) => { calls.push(['document', runtime.origin, sessionId, taskId, artifactId]); return { document: artifactId === 'html'
      ? { name: 'report.html', mediaType: 'text/html', content: '<style>body{color:green}</style><script>alert(1)</script><h1>Private report</h1>' }
      : artifactId === 'pdf' ? { name: '研究报告.pdf', mediaType: 'application/pdf', encoding: 'base64', content: Buffer.from('%PDF-1.7\nprivate report\n%%EOF').toString('base64') }
        : { name: 'report.md', mediaType: 'text/markdown', content: 'Private report' } } },
    pendingQuestion: async (runtime, sessionId) => { calls.push(['question', runtime.origin, sessionId]); return { question: {
      requestId: '11111111-1111-4111-8111-111111111111', questions: [{ id: 'scope', question: '研究哪个范围？', options: [], multiSelect: false }] } } },
    answerQuestion: async (runtime, sessionId, requestId, answers) => { calls.push(['answer', runtime.origin, sessionId, requestId, answers]); return { accepted: true } },
  }
  const usageCalls = []
  const usage = async accountId => { usageCalls.push(accountId); return { day: '2026-10-08', timezone: 'UTC', dailyQuota: 1000,
    chargedTokens: 100, remainingTokens: 900, calls: 1, days: [] } }
  const server = createPortalServer(config, { store, oidc: {}, gateway, usage })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal((await (await fetch(`${base}/healthz`)).json()).phase, 'S1-research')
  const as = login => ({ cookie: `__Host-zhijian-session=${login.token}`, origin: config.publicOrigin, 'x-csrf-token': login.csrf, 'content-type': 'application/json' })
  assert.equal((await fetch(`${base}/api/usage`)).status, 401)
  assert.equal((await fetch(`${base}/api/usage`, { method: 'POST', headers: as(loginA) })).status, 405)
  assert.equal((await (await fetch(`${base}/api/usage`, { headers: as(loginA) })).json()).accountName, 'account-a')
  assert.equal((await (await fetch(`${base}/api/usage`, { headers: as(loginB) })).json()).accountName, 'account-b')
  assert.deepEqual(usageCalls, ['a', 'b'])
  const create = await fetch(`${base}/api/sessions`, { method: 'POST', headers: as(loginA), body: JSON.stringify({ requestId: 'stable-request-1' }) })
  assert.equal(create.status, 201)
  const session = (await create.json()).session
  assert.equal((await fetch(`${base}/api/session-groups`, { method: 'POST', headers: as(loginB),
    body: JSON.stringify({ name: 'A 的分组' }) })).status, 201)
  assert.equal((await fetch(`${base}/api/session-groups`, { method: 'POST', headers: { cookie: as(loginA).cookie },
    body: JSON.stringify({ name: '无 CSRF' }) })).status, 403)
  assert.equal((await fetch(`${base}/api/session-groups`, { method: 'POST', headers: as(loginA),
    body: JSON.stringify({ name: 42 }) })).status, 400)
  const groupResponse = await fetch(`${base}/api/session-groups`, { method: 'POST', headers: as(loginA),
    body: JSON.stringify({ name: '市场研究' }) })
  assert.equal(groupResponse.status, 201)
  const group = (await groupResponse.json()).group
  assert.equal((await fetch(`${base}/api/session-groups/${group.id}`, { method: 'PATCH', headers: as(loginB),
    body: JSON.stringify({ name: '越权' }) })).status, 404)
  const moved = await fetch(`${base}/api/sessions/${session.id}`, { method: 'PATCH', headers: as(loginA),
    body: JSON.stringify({ groupId: group.id }) })
  assert.equal(moved.status, 200)
  assert.equal((await moved.json()).session.groupId, group.id)
  const grouped = await (await fetch(`${base}/api/sessions`, { headers: as(loginA) })).json()
  assert.equal(grouped.groups.some(item => item.id === group.id), true)
  assert.equal(grouped.sessions.find(item => item.id === session.id).groupId, group.id)
  assert.equal((await fetch(`${base}/api/session-groups/${group.id}`, { method: 'DELETE', headers: as(loginA) })).status, 200)
  assert.equal((await (await fetch(`${base}/api/sessions`, { headers: as(loginA) })).json()).sessions
    .find(item => item.id === session.id).groupId, null)
  const duplicate = await fetch(`${base}/api/sessions`, { method: 'POST', headers: as(loginA), body: JSON.stringify({ requestId: 'stable-request-1' }) })
  assert.equal((await duplicate.json()).session.id, session.id)
  const listB = await (await fetch(`${base}/api/sessions`, { headers: as(loginB) })).json()
  assert.equal(listB.sessions.length, 0)
  assert.equal((await fetch(`${base}/api/sessions/activity`)).status, 401)
  assert.equal((await fetch(`${base}/api/sessions/activity`, { headers: { authorization: `Bearer ${'a'.repeat(43)}` } })).status, 403)
  assert.deepEqual((await (await fetch(`${base}/api/sessions/activity`, { headers: as(loginB) })).json()).items, [])
  assert.deepEqual((await (await fetch(`${base}/api/sessions/activity`, { headers: as(loginA) })).json()).items,
    [{ id: session.id, running: true }])
  assert.deepEqual(calls.filter(call => call[0] === 'activity-batch').map(call => call[1]), ['http://127.0.0.1:3101'])
  const legacy = store.createResearchSession({ principal: loginB.principal, requestId: 'legacy-activity' })
  store.bindDshSession(loginB.principal, legacy.id, `session-${legacy.id}`)
  assert.deepEqual((await (await fetch(`${base}/api/sessions/activity`, { headers: as(loginB) })).json()).items,
    [{ id: legacy.id, running: true }])
  assert.deepEqual(calls.filter(call => call[0] === 'activity').map(call => call[1]), ['http://127.0.0.1:3102'])
  assert.equal((await fetch(`${base}/api/mentions`)).status, 401)
  assert.deepEqual((await (await fetch(`${base}/api/mentions`, { headers: as(loginA) })).json()).items,
    [{ name: '智见', kind: 'data-source', provider: 'zyt' }])
  assert.deepEqual((await (await fetch(`${base}/api/mentions`, { headers: as(loginB) })).json()).items, [])
  const foreignRead = await fetch(`${base}/api/sessions/${session.id}/messages`, { headers: as(loginB) })
  assert.equal(foreignRead.status, 404)
  const attachmentUrl = `${base}/api/sessions/${session.id}/attachments`
  const attachmentBody = JSON.stringify({ name: 'notes.txt', data: 'aGVsbG8=' })
  assert.equal((await fetch(attachmentUrl, { method: 'POST', headers: as(loginB), body: attachmentBody })).status, 404)
  assert.equal((await fetch(attachmentUrl, { method: 'POST', headers: { cookie: as(loginA).cookie, origin: config.publicOrigin },
    body: attachmentBody })).status, 403)
  assert.equal((await fetch(attachmentUrl, { method: 'POST', headers: as(loginA), body: attachmentBody })).status, 201)
  const removeBody = JSON.stringify({ path: `customer-uploads/session-${session.id}/stored.txt` })
  assert.equal((await fetch(attachmentUrl, { method: 'DELETE', headers: as(loginB), body: removeBody })).status, 404)
  assert.equal((await fetch(attachmentUrl, { method: 'DELETE', headers: as(loginA), body: removeBody })).status, 200)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/datasets`, { headers: as(loginB) })).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/workspace`, { headers: as(loginB) })).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/workspace/models`, { headers: as(loginB) })).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/model`, { headers: as(loginB) })).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/model`, { method: 'POST', headers: as(loginB),
    body: JSON.stringify({ provider: 'sample', model: 'sample-model' }) })).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/workspace/action`, { method: 'POST', headers: as(loginB),
    body: JSON.stringify({ action: 'approve' }) })).status, 404)
  const syncContext = { action: 'sync-context', expectedDigest: 'a'.repeat(64), expectedRevision: 1,
    expectedContextSha256: 'b'.repeat(64) }
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/workspace/action`, { method: 'POST', headers: as(loginB),
    body: JSON.stringify(syncContext) })).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/workspace/documents/task-1/output`, { headers: as(loginB) })).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/workspace/documents/task-1/html/preview`, { headers: as(loginB) })).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/workspace/documents/task-1/pdf/download`, { headers: as(loginB) })).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/workspace/documents/task-1/pdf/preview`, { headers: as(loginB) })).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/question`, { headers: as(loginB) })).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/question`, { method: 'POST', headers: as(loginB),
    body: JSON.stringify({ requestId: '11111111-1111-4111-8111-111111111111', answers: [] }) })).status, 404)
  assert.equal((await (await fetch(`${base}/api/sessions/${session.id}/question`, { headers: as(loginA) })).json()).question.questions[0].question, '研究哪个范围？')
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/question`, { method: 'POST', headers: { cookie: as(loginA).cookie, origin: config.publicOrigin },
    body: JSON.stringify({ requestId: '11111111-1111-4111-8111-111111111111', answers: [] }) })).status, 403)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/question`, { method: 'POST', headers: as(loginA),
    body: JSON.stringify({ requestId: '11111111-1111-4111-8111-111111111111', answers: [{ id: 'scope', selected: [], custom: '贵阳' }] }) })).status, 200)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/datasets/1234567890123-11111111-1111-4111-8111-111111111111`, { headers: as(loginB) })).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/datasets`, { headers: as(loginA) })).status, 200)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/workspace`, { headers: as(loginA) })).status, 200)
  assert.equal((await (await fetch(`${base}/api/sessions/${session.id}/workspace/models`, { headers: as(loginA) })).json()).models[0].model, 'sample-model')
  assert.equal((await (await fetch(`${base}/api/sessions/${session.id}/model`, { headers: as(loginA) })).json()).selected.model, 'sample-model')
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/model`, { method: 'POST',
    headers: { cookie: as(loginA).cookie, origin: config.publicOrigin },
    body: JSON.stringify({ provider: 'sample', model: 'sample-model' }) })).status, 403)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/model`, { method: 'POST', headers: as(loginA),
    body: JSON.stringify({ provider: 'sample', model: 'sample-model' }) })).status, 200)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/workspace/action`, { method: 'POST', headers: { cookie: as(loginA).cookie, origin: config.publicOrigin },
    body: JSON.stringify({ action: 'approve' }) })).status, 403)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/workspace/action`, { method: 'POST', headers: as(loginA),
    body: JSON.stringify({ action: 'approve', expectedDigest: 'a'.repeat(64), expectedRevision: 1 }) })).status, 200)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/workspace/action`, { method: 'POST', headers: { cookie: as(loginA).cookie, origin: config.publicOrigin },
    body: JSON.stringify(syncContext) })).status, 403)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/workspace/action`, { method: 'POST', headers: as(loginA),
    body: JSON.stringify(syncContext) })).status, 200)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/workspace/documents/task-1/output`, { headers: as(loginA) })).status, 200)
  const downloadUrl = `${base}/api/sessions/${session.id}/workspace/documents/task-1/pdf/download`
  assert.equal((await fetch(downloadUrl)).status, 401)
  const download = await fetch(downloadUrl, { headers: as(loginA) })
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('content-type'), 'application/pdf')
  assert.equal(download.headers.get('content-length'), String(Buffer.byteLength('%PDF-1.7\nprivate report\n%%EOF')))
  assert.match(download.headers.get('content-disposition'), /^attachment; filename="_+\.pdf"; filename\*=UTF-8''/)
  assert.equal(Buffer.from(await download.arrayBuffer()).toString(), '%PDF-1.7\nprivate report\n%%EOF')
  const pdfPreviewUrl = `${base}/api/sessions/${session.id}/workspace/documents/task-1/pdf/preview`
  assert.equal((await fetch(pdfPreviewUrl)).status, 401)
  const pdfPreview = await fetch(pdfPreviewUrl, { headers: as(loginA) })
  assert.equal(pdfPreview.status, 200)
  assert.equal(pdfPreview.headers.get('content-type'), 'application/pdf')
  assert.match(pdfPreview.headers.get('content-disposition'), /^inline; filename="_+\.pdf"; filename\*=UTF-8''/)
  assert.equal(pdfPreview.headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.equal(Buffer.from(await pdfPreview.arrayBuffer()).toString(), '%PDF-1.7\nprivate report\n%%EOF')
  const preview = await fetch(`${base}/api/sessions/${session.id}/workspace/documents/task-1/html/preview`, { headers: as(loginA) })
  assert.equal(preview.status, 200)
  assert.match(preview.headers.get('content-security-policy'), /sandbox;.*script-src 'none'; style-src 'unsafe-inline'/)
  assert.equal(preview.headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.match(await preview.text(), /Private report/)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/workspace/documents/task-1/output/preview`, { headers: as(loginA) })).status, 404)
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/datasets/1234567890123-11111111-1111-4111-8111-111111111111`, { headers: as(loginA) })).status, 200)
  const foreignSend = await fetch(`${base}/api/sessions/${session.id}/messages`, { method: 'POST', headers: as(loginB), body: JSON.stringify({ text: 'steal', requestId: 'request-foreign' }) })
  assert.equal(foreignSend.status, 404)
  const sent = await fetch(`${base}/api/sessions/${session.id}/messages`, { method: 'POST', headers: as(loginA), body: JSON.stringify({ text: '研究贵州租金', requestId: 'request-first' }) })
  assert.equal(sent.status, 202)
  assert.equal((await sent.json()).sessionTitle, '研究贵州租金')
  assert.equal((await (await fetch(`${base}/api/sessions`, { headers: as(loginA) })).json()).sessions[0].title, '研究贵州租金')
  const unavailable = await fetch(`${base}/api/sessions/${session.id}/messages`, { method: 'POST', headers: as(loginA),
    body: JSON.stringify({ text: '@未知 查数据', requestId: 'request-unknown' }) })
  assert.equal(unavailable.status, 400)
  assert.equal((await unavailable.json()).error, 'MENTION_UNAVAILABLE')
  assert.equal((await fetch(`${base}/api/sessions/${session.id}/messages`, { headers: as(loginA) })).status, 200)
  assert.equal(calls.filter(call => call[0] === 'create').length, 2)
  assert.deepEqual(calls.filter(call => ['message', 'upload', 'remove'].includes(call[0])).map(call => call[1]),
    ['http://127.0.0.1:3101', 'http://127.0.0.1:3101', 'http://127.0.0.1:3101'])
  assert.deepEqual(calls.filter(call => call[0] === 'read').map(call => call[1]), ['http://127.0.0.1:3101'])
  assert.deepEqual(calls.filter(call => call[0] === 'datasets' || call[0] === 'table').map(call => call[1]), ['http://127.0.0.1:3101', 'http://127.0.0.1:3101'])
  assert.deepEqual(calls.filter(call => call[0] === 'question' || call[0] === 'answer').map(call => call[1]), ['http://127.0.0.1:3101', 'http://127.0.0.1:3101'])
  assert.deepEqual(calls.filter(call => call[0] === 'workspace-action' || call[0] === 'document').map(call => call[1]),
    Array(7).fill('http://127.0.0.1:3101'))
  assert.deepEqual(calls.filter(call => call[0] === 'workspace-action').map(call => call[3]), ['approve', 'sync-context'])
  assert.deepEqual(calls.filter(call => call[0] === 'models').map(call => call[1]), ['http://127.0.0.1:3101'])

  const earlier = store.createResearchSession({ principal: loginA.principal, requestId: 'earlier-session' })
  store.bindDshSession(loginA.principal, earlier.id, `session-${earlier.id}`)
  gateway.conversation = async () => ({ messages: [{ role: 'user', text: '请帮我分析苏州租赁市场变化', seq: 0 }],
    nextCursor: 0, hasMore: false })
  const history = await (await fetch(`${base}/api/sessions/${earlier.id}/messages?after=-1`, { headers: as(loginA) })).json()
  assert.equal(history.sessionTitle, '分析苏州租赁市场变化')
  assert.equal(store.getResearchSession(loginA.principal, earlier.id).title, '分析苏州租赁市场变化')

  const longSession = store.createResearchSession({ principal: loginA.principal, requestId: 'long-session' })
  store.bindDshSession(loginA.principal, longSession.id, `session-${longSession.id}`)
  const pageReads = []
  gateway.conversation = async (_runtime, _sessionId, after, latest, before) => {
    pageReads.push([after, latest, before])
    return { messages: [{ role: 'user', text: '旧会话里的请求', seq: 50 }],
      nextCursor: 50, hasMore: false, hasEarlier: true }
  }
  const longPath = `${base}/api/sessions/${longSession.id}/messages`
  assert.equal((await fetch(`${longPath}?latest=1`, { headers: as(loginA) })).status, 200)
  assert.equal((await fetch(`${longPath}?latest=1&before=50`, { headers: as(loginA) })).status, 200)
  assert.deepEqual(pageReads, [[-1, true, undefined], [-1, true, 50]])
  assert.equal(store.getResearchSession(loginA.principal, longSession.id).title, '新会话')
})
