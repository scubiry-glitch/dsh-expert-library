import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { CUSTOMER_GATEWAY_PREFIX, handleCustomerGateway } from '../src/host/customer-gateway.ts'

test('customer service gateway rejects unauthenticated and foreign-session access', async t => {
  const owned = 'session-11111111-1111-4111-8111-111111111111'
  const foreign = 'session-22222222-2222-4222-8222-222222222222'
  const calls = []
  let mentionReads = 0
  const runtime = {
    token: async () => 'server-only-test-token-with-32-bytes-minimum',
    createSession: async sessionId => { calls.push(['create', sessionId]); return { sessionId } },
    ownsSession: async sessionId => sessionId === owned,
    sendMessage: async (sessionId, text, requestId) => { calls.push(['message', sessionId, text, requestId]); return { accepted: true } },
    uploadAttachment: async (sessionId, name, data) => { calls.push(['upload', sessionId, name, data]);
      return { name, path: `customer-uploads/${sessionId}/stored.txt`, sizeBytes: 5 } },
    removeAttachment: async (sessionId, path) => { calls.push(['remove', sessionId, path]) },
    conversation: async (sessionId, after, latest, before) => {
      calls.push(['conversation', sessionId, after, latest, before])
      return { messages: [{ role: 'assistant', text: sessionId }], nextCursor: 1, hasMore: false }
    },
    listDatasets: async sessionId => ({ items: [{ id: '1234567890123-11111111-1111-4111-8111-111111111111', sessionId }], hasMore: false }),
    readDataset: async (sessionId, id) => ({ sessionId, id, rows: [[1]] }),
    activity: async () => ({ running: true }),
    activityBatch: async sessionIds => { calls.push(['activity-batch', [...sessionIds]]);
      return { items: sessionIds.map(sessionId => ({ sessionId, running: true })) } },
    workspace: async sessionId => ({ sessionId, plan: null, team: null, documents: [] }),
    models: async () => [{ provider: 'sample', model: 'sample-model', name: 'Sample' }],
    conversationModel: async () => ({ selected: { provider: 'sample', model: 'sample-model' }, models: [{ provider: 'sample', model: 'sample-model' }] }),
    selectConversationModel: async (sessionId, provider, model) => { calls.push(['select-model', sessionId, provider, model]); return { selected: { provider, model } } },
    workspaceAction: async (sessionId, action) => { calls.push(['workspace-action', sessionId, action.action]); return { sessionId, action: action.action } },
    document: async (sessionId, taskId, artifactId) => ({ document: { name: `${taskId}-${artifactId}.md`, content: sessionId } }),
    mentions: async () => { mentionReads++; return [{ name: '智见', kind: 'data-source', provider: 'zyt' }] },
    pendingQuestion: sessionId => sessionId === owned ? { requestId: '11111111-1111-4111-8111-111111111111',
      questions: [{ id: 'scope', question: '研究哪个范围？', options: [{ label: '贵阳' }], multiSelect: false }] } : null,
    answerQuestion: (sessionId, requestId, answers) => sessionId === owned
      && requestId === '11111111-1111-4111-8111-111111111111' && answers?.[0]?.selected?.[0] === '贵阳',
    adminSettings: async () => ({ writable: true, revision: 3, value: { providers: {} } }),
    adminModels: async () => [{ provider: 'sample', model: 'sample-model', name: 'Sample', reasoningEfforts: [{ id: 'low', name: 'Low' }] }],
    adminUsage: async days => ({ days, rankings: { expert: [{ id: 'e', calls: 2, sessions: 1 }] } }),
    updateAdminSettings: async (section, value, revision) => { calls.push(['admin-settings', section, value, revision]); return { revision: revision + 1 } },
  }
  const server = createServer((req, res) => { void handleCustomerGateway(req, res, runtime) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}${CUSTOMER_GATEWAY_PREFIX}`
  const auth = { authorization: 'Bearer server-only-test-token-with-32-bytes-minimum' }
  assert.equal((await fetch(`${base}/health`)).status, 401)
  assert.equal((await fetch(`${base}/health`, { headers: { authorization: 'Bearer wrong' } })).status, 401)
  assert.equal((await fetch(`${base}/health`, { headers: auth })).status, 200)
  assert.equal((await fetch(`${base}/admin/settings`)).status, 401)
  assert.equal((await (await fetch(`${base}/admin/settings`, { headers: auth })).json()).revision, 3)
  assert.equal((await fetch(`${base}/admin/models`)).status, 401)
  assert.deepEqual((await (await fetch(`${base}/admin/models`, { headers: auth })).json()).models,
    [{ provider: 'sample', model: 'sample-model', name: 'Sample', reasoningEfforts: [{ id: 'low', name: 'Low' }] }])
  assert.equal((await fetch(`${base}/admin/usage?days=30`)).status, 401)
  assert.equal((await fetch(`${base}/admin/usage?days=31`, { headers: auth })).status, 400)
  assert.deepEqual((await (await fetch(`${base}/admin/usage?days=30`, { headers: auth })).json()).rankings.expert,
    [{ id: 'e', calls: 2, sessions: 1 }])
  assert.equal((await fetch(`${base}/admin/settings`, { method: 'PUT', headers: auth,
    body: JSON.stringify({ section: 'arbitrary', value: {}, revision: 3 }) })).status, 400)
  assert.equal((await fetch(`${base}/admin/settings`, { method: 'PUT', headers: auth,
    body: JSON.stringify({ section: 'providers', value: {}, revision: 3 }) })).status, 200)
  assert.equal((await fetch(`${base}/admin/settings`, { method: 'PUT', headers: auth,
    body: JSON.stringify({ section: 'runtime', value: { maxMembers: 4 }, revision: 4 }) })).status, 200)
  assert.equal((await fetch(`${base}/mentions`)).status, 401)
  assert.deepEqual((await (await fetch(`${base}/mentions`, { headers: auth })).json()).items,
    [{ name: '智见', kind: 'data-source', provider: 'zyt' }])
  const invalid = await fetch(`${base}/sessions`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: '../other' }) })
  assert.equal(invalid.status, 400)
  const created = await fetch(`${base}/sessions`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: owned, workspace: '/other' }) })
  assert.equal(created.status, 200)
  assert.equal((await fetch(`${base}/sessions/${foreign}/messages`, { headers: auth })).status, 404)
  assert.equal((await fetch(`${base}/sessions/${foreign}/attachments`, { method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'notes.txt', data: 'aGVsbG8=' }) })).status, 404)
  assert.equal((await fetch(`${base}/sessions/${owned}/attachments`, { method: 'POST',
    body: JSON.stringify({ name: 'notes.txt', data: 'aGVsbG8=' }) })).status, 401)
  assert.equal((await fetch(`${base}/sessions/${owned}/attachments`, { method: 'POST', headers: auth,
    body: JSON.stringify({ name: '../notes.txt', data: 'aGVsbG8=' }) })).status, 400)
  assert.equal((await fetch(`${base}/sessions/${owned}/attachments`, { method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'notes.exe', data: 'aGVsbG8=' }) })).status, 400)
  assert.equal((await fetch(`${base}/sessions/${owned}/attachments`, { method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'notes.txt', data: 'aGVsbG8=' }) })).status, 201)
  assert.equal((await fetch(`${base}/sessions/${foreign}/attachments`, { method: 'DELETE', headers: auth,
    body: JSON.stringify({ path: 'customer-uploads/other/stored.txt' }) })).status, 404)
  assert.equal((await fetch(`${base}/sessions/${owned}/attachments`, { method: 'DELETE', headers: auth,
    body: JSON.stringify({ path: `customer-uploads/${owned}/stored.txt` }) })).status, 200)
  assert.equal((await fetch(`${base}/sessions/${foreign}/datasets`, { headers: auth })).status, 404)
  assert.equal((await fetch(`${base}/sessions/${foreign}/question`, { headers: auth })).status, 404)
  assert.equal((await fetch(`${base}/sessions/${foreign}/workspace`, { headers: auth })).status, 404)
  assert.equal((await fetch(`${base}/sessions/${foreign}/activity`, { headers: auth })).status, 404)
  const batch = (sessionIds, headers = auth) => fetch(`${base}/sessions/activity-batch`, { method: 'POST', headers,
    body: JSON.stringify({ sessionIds }) })
  assert.equal((await batch([owned], {})).status, 401)
  assert.equal((await batch([owned, foreign])).status, 404)
  assert.equal((await batch([owned, owned])).status, 400)
  assert.deepEqual((await (await batch([owned])).json()).items, [{ sessionId: owned, running: true }])
  assert.equal((await fetch(`${base}/sessions/${foreign}/workspace/models`, { headers: auth })).status, 404)
  assert.equal((await fetch(`${base}/sessions/${foreign}/model`, { headers: auth })).status, 404)
  assert.equal((await fetch(`${base}/sessions/${foreign}/model`, { method: 'POST', headers: auth,
    body: JSON.stringify({ provider: 'sample', model: 'sample-model' }) })).status, 404)
  assert.equal((await fetch(`${base}/sessions/${foreign}/workspace/action`, { method: 'POST', headers: auth,
    body: JSON.stringify({ action: 'halt' }) })).status, 404)
  assert.equal((await fetch(`${base}/sessions/${foreign}/workspace/documents/task-1/output`, { headers: auth })).status, 404)
  assert.equal((await fetch(`${base}/sessions/${foreign}/question`, { method: 'POST', headers: auth,
    body: JSON.stringify({ requestId: '11111111-1111-4111-8111-111111111111', answers: [] }) })).status, 404)
  const card = await (await fetch(`${base}/sessions/${owned}/question`, { headers: auth })).json()
  assert.equal(card.question.questions[0].question, '研究哪个范围？')
  assert.equal((await fetch(`${base}/sessions/${owned}/question`, { method: 'POST', headers: auth,
    body: JSON.stringify({ requestId: card.question.requestId, answers: [{ id: 'scope', selected: ['贵阳'] }] }) })).status, 200)
  assert.equal((await fetch(`${base}/sessions/${owned}/question`, { method: 'POST', headers: auth,
    body: JSON.stringify({ requestId: '22222222-2222-4222-8222-222222222222', answers: [] }) })).status, 409)
  assert.equal((await fetch(`${base}/sessions/${owned}/datasets`, { headers: auth })).status, 200)
  assert.equal((await fetch(`${base}/sessions/${owned}/workspace`, { headers: auth })).status, 200)
  assert.deepEqual((await (await fetch(`${base}/sessions/${owned}/activity`, { headers: auth })).json()), { running: true })
  assert.equal((await (await fetch(`${base}/sessions/${owned}/workspace/models`, { headers: auth })).json()).models[0].model, 'sample-model')
  assert.equal((await (await fetch(`${base}/sessions/${owned}/model`, { headers: auth })).json()).selected.model, 'sample-model')
  assert.equal((await fetch(`${base}/sessions/${owned}/model`, { method: 'POST', headers: auth,
    body: JSON.stringify({ provider: 'sample', model: 'sample-model', sessionId: foreign }) })).status, 400)
  assert.equal((await fetch(`${base}/sessions/${owned}/model`, { method: 'POST', headers: auth,
    body: JSON.stringify({ provider: 'sample', model: 'sample-model' }) })).status, 200)
  assert.equal((await fetch(`${base}/sessions/${owned}/workspace/action`, { method: 'POST', headers: auth,
    body: JSON.stringify({ action: 'edit', expectedDigest: 'a'.repeat(64), expectedRevision: 1,
      patch: { secret_path: '/other' } }) })).status, 400)
  assert.equal((await fetch(`${base}/sessions/${owned}/workspace/action`, { method: 'POST', headers: auth,
    body: JSON.stringify({ action: 'approve', expectedDigest: 'a'.repeat(64), expectedRevision: 1 }) })).status, 200)
  assert.equal((await fetch(`${base}/sessions/${owned}/workspace/action`, { method: 'POST', headers: auth,
    body: JSON.stringify({ action: 'sync-context', expectedDigest: 'a'.repeat(64), expectedRevision: 1,
      expectedContextSha256: 'b'.repeat(64), patch: { goal: 'unreviewed' } }) })).status, 400)
  assert.equal((await fetch(`${base}/sessions/${owned}/workspace/action`, { method: 'POST', headers: auth,
    body: JSON.stringify({ action: 'sync-context', expectedDigest: 'a'.repeat(64), expectedRevision: 1,
      expectedContextSha256: 'b'.repeat(64) }) })).status, 200)
  assert.equal((await fetch(`${base}/sessions/${owned}/workspace/documents/task-1/output`, { headers: auth })).status, 200)
  assert.equal((await fetch(`${base}/sessions/${owned}/workspace/documents/..%2Fother/output`, { headers: auth })).status, 404)
  assert.equal((await fetch(`${base}/sessions/${owned}/datasets/1234567890123-11111111-1111-4111-8111-111111111111`, { headers: auth })).status, 200)
  assert.equal((await fetch(`${base}/sessions/${foreign}/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'steal', requestId: 'request-foreign' }) })).status, 404)
  assert.equal((await fetch(`${base}/sessions/${owned}/messages?after=-1`, { headers: auth })).status, 200)
  assert.equal((await fetch(`${base}/sessions/${owned}/messages?latest=1`, { headers: auth })).status, 200)
  assert.equal((await fetch(`${base}/sessions/${owned}/messages?latest=1&before=12`, { headers: auth })).status, 200)
  assert.equal((await fetch(`${base}/sessions/${owned}/messages?latest=1&before=-1`, { headers: auth })).status, 400)
  assert.equal((await fetch(`${base}/sessions/${owned}/messages?latest=1&after=1`, { headers: auth })).status, 400)
  assert.equal((await fetch(`${base}/sessions/${foreign}/messages?latest=1`, { headers: auth })).status, 404)
  const readsBeforePlainMessage = mentionReads
  assert.equal((await fetch(`${base}/sessions/${owned}/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'First question', requestId: 'request-11111111' }) })).status, 202)
  assert.equal(mentionReads, readsBeforePlainMessage)
  assert.equal((await fetch(`${base}/sessions/${owned}/messages`, { method: 'POST', headers: auth,
    body: JSON.stringify({ text: '@未知 查询数据', requestId: 'request-22222222' }) })).status, 400)
  assert.equal((await fetch(`${base}/sessions/${owned}/messages`, { method: 'POST', headers: auth,
    body: JSON.stringify({ text: '@智见 查询数据', requestId: 'request-33333333' }) })).status, 202)
  assert.equal(mentionReads, readsBeforePlainMessage + 2)
  assert.deepEqual(calls, [['admin-settings', 'providers', {}, 3], ['admin-settings', 'runtime', { maxMembers: 4 }, 4], ['create', owned], ['upload', owned, 'notes.txt', 'aGVsbG8='], ['remove', owned, `customer-uploads/${owned}/stored.txt`], ['activity-batch', [owned]], ['select-model', owned, 'sample', 'sample-model'], ['workspace-action', owned, 'approve'], ['workspace-action', owned, 'sync-context'],
    ['conversation', owned, -1, false, Number.MAX_SAFE_INTEGER], ['conversation', owned, -1, true, Number.MAX_SAFE_INTEGER], ['conversation', owned, -1, true, 12],
    ['message', owned, 'First question', 'request-11111111'], ['message', owned, '@智见 查询数据', 'request-33333333']])
})
