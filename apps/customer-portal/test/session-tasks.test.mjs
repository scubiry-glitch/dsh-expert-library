import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountStore } from '../account-store.mjs'
import { readConfig } from '../config.mjs'
import { createPortalServer } from '../server.mjs'

test('tasks are scoped, idempotent, and a Word download appears only with an actual document', async t => {
  const store = new AccountStore()
  t.after(() => store.close())
  const accountA = store.provisionAccount({ slug: 'task-a' })
  const accountB = store.provisionAccount({ slug: 'task-b' })
  for (const [id, slug] of [[accountA, 'a'], [accountB, 'b']]) {
    store.bindWorkspace(id, `workspace-${slug}`)
    store.bindBackend(id, slug === 'a' ? 'zhijian-demo-c' : slug)
    store.provisionMember({ accountId: id, issuer: 'https://id.example', subject: slug, displayName: slug })
  }
  const loginA = store.issueBrowserSession({ accountId: accountA, issuer: 'https://id.example', subject: 'a' })
  const loginB = store.issueBrowserSession({ accountId: accountB, issuer: 'https://id.example', subject: 'b' })
  const config = readConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:18461', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    DSH_BACKENDS_JSON: JSON.stringify({ 'zhijian-demo-c': 'http://127.0.0.1:3101', b: 'http://127.0.0.1:3102' }),
    RESEARCH_ENABLED_BACKENDS: 'zhijian-demo-c,b', OIDC_ISSUER: 'https://id.example', OIDC_CLIENT_ID: 'portal',
    ACCOUNT_DB_PATH: '/tmp/injected-task-test.sqlite', DSH_GATEWAY_TOKEN_DIR: '/tmp/injected-tokens' })
  const messages = []
  const documents = []
  let sends = 0
  const gateway = {
    createSession: async (_runtime, sessionId) => ({ sessionId }),
    sendMessage: async (_runtime, _sessionId, text) => {
      sends++
      messages.push({ role: 'user', seq: messages.length + 1, text })
      return { accepted: true }
    },
    conversation: async () => ({ messages, nextCursor: messages.length, hasMore: false }),
    workspace: async () => ({ plan: null, team: null, datasets: [], documents }),
    activity: async () => ({ running: false }),
    document: async (_runtime, _sessionId, _taskId, artifactId) => ({ document: {
      name: `${artifactId}.docx`, mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: Buffer.from('PK\x03\x04word/document.xml').toString('base64'), encoding: 'base64',
    } }),
  }
  const server = createPortalServer(config, { store, oidc: {}, gateway })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const auth = login => ({ cookie: `__Host-zhijian-session=${login.token}`, origin: config.publicOrigin,
    'x-csrf-token': login.csrf, 'content-type': 'application/json' })
  const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: auth(loginA),
    body: JSON.stringify({ requestId: 'create-task-session' }) })
  assert.equal(created.status, 201)
  const sessionId = (await created.json()).session.id
  const endpoint = `${base}/api/sessions/${sessionId}/tasks`
  const input = { requestId: 'task-request-123', kind: 'bank-property-value', city: '北京',
    community: '望京西园三区', area: 90, branch: '', firm: '' }
  assert.equal((await fetch(endpoint, { method: 'POST', headers: auth(loginB), body: JSON.stringify(input) })).status, 404)
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { cookie: auth(loginA).cookie, origin: config.publicOrigin },
    body: JSON.stringify(input) })).status, 403)
  const first = await fetch(endpoint, { method: 'POST', headers: auth(loginA), body: JSON.stringify(input) })
  assert.equal(first.status, 202)
  const task = (await first.json()).task
  assert.equal((await fetch(endpoint, { method: 'POST', headers: auth(loginA), body: JSON.stringify(input) })).status, 202)
  assert.equal(sends, 1)
  assert.equal((await (await fetch(endpoint, { headers: auth(loginA) })).json()).tasks[0].status, 'running')
  messages.push({ role: 'assistant', seq: messages.length + 1, text: '已完成报告，但文件尚未登记。' })
  assert.equal((await (await fetch(endpoint, { headers: auth(loginA) })).json()).tasks[0].status, 'needs_file')
  documents.push({ taskId: 'conversation', id: 'pdf-1', name: '估值报告.pdf',
    resultKey: `conversation:${task.requestId}`, source: 'conversation', mediaType: 'application/pdf' })
  assert.equal((await (await fetch(endpoint, { headers: auth(loginA) })).json()).tasks[0].status, 'needs_file')
  documents.push({ taskId: 'conversation', id: 'word-1', name: '估值报告.docx',
    resultKey: `conversation:${task.requestId}`, source: 'conversation', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  const delivered = (await (await fetch(endpoint, { headers: auth(loginA) })).json()).tasks[0]
  assert.equal(delivered.status, 'delivered')
  const word = delivered.files.find(item => item.name.endsWith('.docx'))
  assert.equal(word.href, `/api/sessions/${sessionId}/workspace/documents/conversation/word-1/download`)
  assert.equal((await fetch(`${base}${word.href}`)).status, 401)
  assert.equal((await fetch(`${base}${word.href}`, { headers: auth(loginB) })).status, 404)
  const download = await fetch(`${base}${word.href}`, { headers: auth(loginA) })
  assert.equal(download.status, 200)
  assert.match(download.headers.get('content-disposition'), /^attachment;/)
  assert.equal((await download.arrayBuffer()).byteLength, Buffer.byteLength('PK\x03\x04word/document.xml'))
})
