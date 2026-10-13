import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore } from '../account-store.mjs'
import { readConfig } from '../config.mjs'
import { createPortalServer } from '../server.mjs'
import { createSessionDeliverables, publishSessionDeliverable } from '../session-deliverables.mjs'

test('conversation reports are session scoped, readable to an authorized share, and cannot import files outside the workspace', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'portal-deliverables-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const source = join(folder, 'workspace')
  const archive = join(folder, 'archive')
  await mkdir(source)
  const report = join(source, '五城租金分析报告-2页.md')
  await writeFile(report, '# 五城租金分析报告\n')
  const outside = join(folder, 'outside.md')
  await writeFile(outside, 'not part of this workspace')
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
  const session = store.createResearchSession({ principal: loginA.principal, requestId: 'report-session-1' })
  const otherSession = store.createResearchSession({ principal: loginA.principal, requestId: 'report-session-2' })
  store.bindDshSession(loginA.principal, session.id, `session-${session.id}`)
  store.bindDshSession(loginA.principal, otherSession.id, `session-${otherSession.id}`)
  await publishSessionDeliverable({ root: archive, account: 'account-a', sessionId: session.id,
    id: 'five-city-rent-md', resultKey: 'five-city-rent', resultLabel: '五城租金分析报告', workspace: source, source: report })
  await assert.rejects(publishSessionDeliverable({ root: archive, account: 'account-a', sessionId: session.id,
    id: 'outside', resultKey: 'five-city-rent', resultLabel: '越界', workspace: source, source: outside }),
  /DELIVERABLE_OUTSIDE_WORKSPACE/)
  const config = readConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:18460', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    DSH_BACKENDS_JSON: JSON.stringify({ a: 'http://127.0.0.1:3101', b: 'http://127.0.0.1:3102' }),
    RESEARCH_ENABLED_BACKENDS: 'a,b', DSH_GATEWAY_TOKEN_DIR: join(folder, 'tokens'),
    OIDC_ISSUER: 'https://id.example', OIDC_CLIENT_ID: 'portal', ACCOUNT_DB_PATH: join(folder, 'accounts.sqlite') })
  const server = createPortalServer(config, { store, oidc: {}, deliverables: createSessionDeliverables(archive),
    preview: { session: { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }, visible: () => false, available: async () => false },
    historicalPreviews: [], gateway: { workspace: async () => ({ plan: null, team: null, documents: [] }),
      document: async () => { throw Error('local report must not fall through to DSH') } } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/sessions`
  const owner = login => ({ cookie: `__Host-zhijian-session=${login.token}` })
  const workspace = await (await fetch(`${base}/${session.id}/workspace`, { headers: owner(loginA) })).json()
  assert.deepEqual(workspace.documents.map(item => item.name), ['五城租金分析报告-2页.md'])
  assert.equal(workspace.documents[0].formal, false)
  const path = `${base}/${session.id}/workspace/documents/conversation/five-city-rent-md`
  const loaded = await (await fetch(path, { headers: owner(loginA) })).json()
  assert.equal(Buffer.from(loaded.document.content, 'base64').toString('utf8'), '# 五城租金分析报告\n')
  assert.equal((await fetch(path, { headers: owner(loginB) })).status, 404)
  assert.equal((await fetch(`${base}/${otherSession.id}/workspace/documents/conversation/five-city-rent-md`, { headers: owner(loginA) })).status, 404)
  const share = store.createShareLink(loginA.principal, session.id, { permission: 'read', days: 7 })
  assert.equal((await fetch(path, { headers: { authorization: `Bearer ${share.token}` } })).status, 200)
})
