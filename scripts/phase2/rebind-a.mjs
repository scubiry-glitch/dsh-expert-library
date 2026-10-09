#!/usr/bin/env node
/** One-off: re-bind DSH A with a fresh deployment credential. */
import { readFile } from 'node:fs/promises'
const origin = 'https://127.0.0.1:18431'
const cookies = new Map(); let csrf
async function call(path, method = 'GET', body, expected = 200, opKey) {
  const r = await fetch(origin + path, { method, headers: { Origin: origin, Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json', ...(opKey ? { 'Idempotency-Key': opKey } : {}) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  for (const c of r.headers.getSetCookie()) { const p = c.split(';', 1)[0], i = p.indexOf('='); cookies.set(p.slice(0, i), p.slice(i + 1)) }
  const data = await r.json().catch(() => undefined)
  if (r.status !== expected) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data)?.slice(0, 200)}`)
  if (data?.csrfToken) csrf = data.csrfToken
  return data
}
const local = (path, method = 'GET', body) => fetch(`http://127.0.0.1:18281/plugins/dsh-expert-library/manage/center${path}`, { method, headers: { 'X-Pack-Center-UI': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async r => ({ status: r.status, body: await r.json().catch(() => undefined) }))
const begin = await call('/api/auth/login', 'POST', {})
if (!begin?.authorizationUrl) { console.error('login response:', JSON.stringify(begin)); process.exit(1) }
const authorize = await fetch(begin.authorizationUrl, { redirect: 'manual', headers: { 'x-test-identity': Buffer.from(JSON.stringify({ subject: 'phase2-admin' })).toString('base64url') } })
if (authorize.status !== 302) { console.error('authorize status', authorize.status, (await authorize.text()).slice(0,200)); process.exit(1) }
const callback = new URL(authorize.headers.get('location'))
const login = await call(callback.pathname + callback.search)
if (!login.principal?.platformAdmin) throw new Error('not admin')
const depId = '40187cbf-ece2-4065-b797-157fadfe5be4'
const trusted = JSON.parse(await readFile('/tmp/p2-20260923/secrets/t22-trusted.json', 'utf8'))
const code = await call(`/api/v1/deployments/${depId}/binding-codes`, 'POST', {}, 201, `rebind-a-${Date.now()}`)
const conn = await local('/connection')
const bind = await local('/bind', 'POST', { bindingCode: code.bindingCode, expectedRevision: conn.body?.data?.revision ?? 0, expectedCenterId: 'phase2-center-20260923', trustedSigningKeys: trusted })
console.log('bind', bind.status, bind.body?.ok, bind.body?.error?.code || '')
const cat = await local('/catalog?packId=macro-capital-analyst')
console.log('catalog items:', cat.body?.data?.items?.length, 'err:', cat.body?.data?.errorCode || 'none')
