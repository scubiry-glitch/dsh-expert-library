import assert from 'node:assert/strict'
import { mkdtempSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AccountStore } from '../account-store.mjs'
import { readConfig } from '../config.mjs'
import { createPortalServer } from '../server.mjs'

/** Real two-host BFF smoke. It creates only blank sessions; no model requests. */
const origins = [process.env.DSH_SMOKE_BACKEND_A, process.env.DSH_SMOKE_BACKEND_B]
const tokenFiles = [process.env.DSH_SMOKE_TOKEN_A, process.env.DSH_SMOKE_TOKEN_B]
if (origins.some(value => !value) || tokenFiles.some(value => !value)) {
  throw new Error('Set DSH_SMOKE_BACKEND_A/B and DSH_SMOKE_TOKEN_A/B')
}

const tokenDir = mkdtempSync(join(tmpdir(), 'zhijian-gateway-smoke-'))
const store = new AccountStore()
let server
try {
  symlinkSync(tokenFiles[0], join(tokenDir, 'a.token'))
  symlinkSync(tokenFiles[1], join(tokenDir, 'b.token'))
  const config = readConfig({
    PUBLIC_ORIGIN: 'http://127.0.0.1:18461',
    DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    DSH_BACKENDS_JSON: JSON.stringify({ a: origins[0], b: origins[1] }),
    RESEARCH_ENABLED_BACKENDS: 'a,b',
    DSH_GATEWAY_TOKEN_DIR: tokenDir,
    OIDC_ISSUER: 'https://identity.test',
    OIDC_CLIENT_ID: 'smoke',
    ACCOUNT_DB_PATH: '/tmp/unused-injected-account-store.sqlite',
  })
  const accounts = ['a', 'b'].map(name => store.provisionCustomerAccount({
    slug: `smoke-${name}-${randomUUID().slice(0, 8)}`,
    workspaceId: `smoke-workspace-${name}`,
    backendRef: name,
  }))
  const logins = accounts.map((accountId, index) => {
    const subject = `smoke-${index}-${randomUUID()}`
    store.provisionMember({ accountId, issuer: 'https://identity.test', subject, displayName: `Smoke ${index}` })
    return store.issueBrowserSession({ accountId, issuer: 'https://identity.test', subject })
  })
  server = createPortalServer(config, { store, oidc: {} })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = login => ({ cookie: `__Host-zhijian-session=${login.token}`,
    origin: config.publicOrigin, 'x-csrf-token': login.csrf, 'content-type': 'application/json' })
  const create = async login => {
    const response = await fetch(`${base}/api/sessions`, { method: 'POST', headers: headers(login),
      body: JSON.stringify({ requestId: randomUUID(), title: '隔离验收空白会话' }) })
    assert.equal(response.status, 201, `create returned ${response.status}`)
    return (await response.json()).session.id
  }
  const [aId, bId] = await Promise.all(logins.map(create))
  const read = (login, id) => fetch(`${base}/api/sessions/${id}/messages`, { headers: headers(login) })
  assert.equal((await read(logins[0], aId)).status, 200)
  assert.equal((await read(logins[1], bId)).status, 200)
  assert.equal((await read(logins[0], bId)).status, 404)
  assert.equal((await read(logins[1], aId)).status, 404)
  const lists = await Promise.all(logins.map(async login => (await (await fetch(`${base}/api/sessions`, { headers: headers(login) })).json()).sessions))
  assert.deepEqual(lists.map(items => items.length), [1, 1])
  const missingCsrf = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { cookie: headers(logins[0]).cookie, origin: config.publicOrigin },
    body: JSON.stringify({ requestId: randomUUID() }) })
  assert.equal(missingCsrf.status, 403)
  process.stdout.write(JSON.stringify({ status: 'PASS', hosts: 2, ownRead: 200, foreignRead: 404, missingCsrf: 403 }) + '\n')
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  store.close()
  for (const name of ['a.token', 'b.token']) {
    try { unlinkSync(join(tokenDir, name)) } catch { /* absent */ }
  }
  rmdirSync(tokenDir)
}
