import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AccountStore } from '../account-store.mjs'
import { readConfig } from '../config.mjs'
import { createPortalServer } from '../server.mjs'

test('session pin, favorite, archive and title stay account scoped and persist across restarts', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'zhijian-session-metadata-'))
  const path = join(folder, 'accounts.sqlite')
  const store = new AccountStore(path)
  t.after(() => { store.close(); rmSync(folder, { recursive: true, force: true }) })
  const accountA = store.provisionAccount({ slug: 'a' })
  const accountB = store.provisionAccount({ slug: 'b' })
  store.provisionMember({ accountId: accountA, issuer: 'https://id.test', subject: 'a', displayName: 'A' })
  store.provisionMember({ accountId: accountB, issuer: 'https://id.test', subject: 'b', displayName: 'B' })
  const loginA = store.issueBrowserSession({ accountId: accountA, issuer: 'https://id.test', subject: 'a' })
  const loginB = store.issueBrowserSession({ accountId: accountB, issuer: 'https://id.test', subject: 'b' })
  const first = store.createResearchSession({ principal: loginA.principal, requestId: 'first-session', title: '初始标题' })
  const second = store.createResearchSession({ principal: loginA.principal, requestId: 'second-session', title: '较新会话' })
  store.bindDshSession(loginA.principal, first.id, `session-${first.id}`)
  store.bindDshSession(loginA.principal, second.id, `session-${second.id}`)
  const previewSession = { id: 'a22587ef-d99f-4123-b032-ea9a121a170d', title: '原始预览', createdAt: 1, preview: true }
  const preview = { session: previewSession, visible: principal => principal.accountId === accountA,
    available: async () => true }
  const config = readConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:18460', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    OIDC_ISSUER: 'https://id.test', OIDC_CLIENT_ID: 'portal', ACCOUNT_DB_PATH: path })
  const server = createPortalServer(config, { store, oidc: {}, preview, historicalPreviews: [], gateway: {} })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = login => ({ cookie: `__Host-zhijian-session=${login.token}`, origin: config.publicOrigin,
    'x-csrf-token': login.csrf, 'content-type': 'application/json' })
  const patch = (id, login, changes, customHeaders = headers(login)) => fetch(`${base}/api/sessions/${id}`,
    { method: 'PATCH', headers: customHeaders, body: JSON.stringify(changes) })
  assert.equal((await patch(first.id, loginB, { pinned: true })).status, 404)
  assert.equal((await patch(first.id, loginB, { archived: true })).status, 404)
  assert.equal((await patch(first.id, loginA, { pinned: true }, { cookie: headers(loginA).cookie })).status, 403)
  assert.equal((await patch(first.id, loginA, { archived: true }, { cookie: headers(loginA).cookie })).status, 403)
  assert.equal((await patch(first.id, loginA, { archived: 'yes' })).status, 400)
  assert.equal((await patch(first.id, loginA, { title: '  新标题  ', pinned: true, favorite: true, archived: true })).status, 200)
  assert.equal((await patch(first.id, loginA, { title: 'bad\ntitle' })).status, 400)
  const list = (await (await fetch(`${base}/api/sessions`, { headers: headers(loginA) })).json()).sessions
  assert.deepEqual(list.map(item => item.id), [first.id, second.id, previewSession.id])
  assert.deepEqual({ title: list[0].title, pinned: list[0].pinned, favorite: list[0].favorite, archived: list[0].archived },
    { title: '新标题', pinned: true, favorite: true, archived: true })
  assert.equal((await patch(previewSession.id, loginA, { title: '我的预览', favorite: true, archived: true })).status, 200)
  assert.equal(previewSession.title, '原始预览')
  assert.equal((await patch(previewSession.id, loginB, { favorite: true })).status, 404)
  assert.equal(store.getResearchSession(loginA.principal, first.id).title, '初始标题')
  const reopened = new AccountStore(path)
  try {
    assert.deepEqual({ ...reopened.sessionPreference(loginA.principal, first.id) },
      { titleOverride: '新标题', pinned: 1, favorite: 1, archived: 1, groupId: null })
    assert.equal(reopened.sessionPreference(loginB.principal, first.id), undefined)
  } finally { reopened.close() }
  assert.equal((await patch(first.id, loginA, { archived: false })).status, 200)
  assert.equal((await (await fetch(`${base}/api/sessions`, { headers: headers(loginA) })).json()).sessions[0].archived, false)
})

test('existing preference database gains archive column without losing rows', () => {
  const folder = mkdtempSync(join(tmpdir(), 'zhijian-session-archive-upgrade-'))
  try {
    const path = join(folder, 'accounts.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`CREATE TABLE session_preferences (
      account_id TEXT NOT NULL, session_id TEXT NOT NULL, title_override TEXT,
      pinned INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account_id,session_id));
      INSERT INTO session_preferences(account_id,session_id,title_override,pinned,favorite)
      VALUES ('a','s','已有标题',1,1);`)
    legacy.close()
    const upgraded = new AccountStore(path)
    try {
      assert.equal(upgraded.db.prepare("SELECT archived FROM session_preferences WHERE account_id='a' AND session_id='s'").get().archived, 0)
      assert.equal(upgraded.db.prepare("SELECT title_override FROM session_preferences WHERE account_id='a' AND session_id='s'").get().title_override, '已有标题')
    } finally { upgraded.close() }
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
