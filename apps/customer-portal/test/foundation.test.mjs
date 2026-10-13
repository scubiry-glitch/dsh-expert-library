import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { readConfig } from '../config.mjs'
import { probeBackend } from '../dsh-backend.mjs'
import { createPortalServer } from '../server.mjs'

test('DSH backend and public origin are independent, validated configuration', () => {
  const config = readConfig({ PUBLIC_ORIGIN: 'https://zhijian.meizu.life', DSH_BACKEND_URL: 'http://10.0.0.12:3080' })
  assert.equal(config.publicOrigin, 'https://zhijian.meizu.life')
  assert.equal(config.dshBackendUrl, 'http://10.0.0.12:3080')
  assert.throws(() => readConfig({ PUBLIC_ORIGIN: 'https://zhijian.meizu.life', DSH_BACKEND_URL: '' }), /DSH_BACKEND_URL is required/)
  assert.throws(() => readConfig({ PUBLIC_ORIGIN: 'https://zhijian.meizu.life', DSH_BACKEND_URL: 'http://user:pass@host/' }), /without credentials/)
  assert.throws(() => readConfig({ PUBLIC_ORIGIN: 'http://zhijian.meizu.life', DSH_BACKEND_URL: 'http://127.0.0.1:3080' }), /HTTPS/)
  assert.deepEqual(config.researchEnabledBackends, [])
  assert.throws(() => readConfig({ PUBLIC_ORIGIN: 'https://zhijian.meizu.life', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    DSH_BACKENDS_JSON: '{"a":"http://127.0.0.1:3101"}', RESEARCH_ENABLED_BACKENDS: 'a' }), /DSH_GATEWAY_TOKEN_DIR/)
  assert.throws(() => readConfig({ PUBLIC_ORIGIN: 'https://zhijian.meizu.life', DSH_BACKEND_URL: 'http://127.0.0.1:3080',
    DSH_BACKENDS_JSON: '{"a":"http://127.0.0.1:3101"}', DSH_GATEWAY_TOKEN_DIR: '/tmp/tokens', RESEARCH_ENABLED_BACKENDS: 'b' }), /RESEARCH_ENABLED_BACKENDS/)
})

test('backend probe uses configured address, without browser or logged credentials', async () => {
  let requested
  const config = readConfig({ PUBLIC_ORIGIN: 'https://zhijian.meizu.life', DSH_BACKEND_URL: 'http://10.0.0.12:3080' })
  const result = await probeBackend(config, async (url, options) => {
    requested = { url: url.href, options }
    return { status: 401 }
  })
  assert.equal(requested.url, 'http://10.0.0.12:3080/plugins/dsh-expert-library/review')
  assert.equal(requested.options.redirect, 'manual')
  assert.equal(result.reachable, true)
  assert.equal(result.reviewRouteAvailable, true)
})

test('S0 server exposes only public shell, with no backend URL or customer data', async t => {
  const config = readConfig({ PUBLIC_ORIGIN: 'https://zhijian.meizu.life', DSH_BACKEND_URL: 'http://10.0.0.12:3080', PORT: '0' })
  const server = createPortalServer(config)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const health = await fetch(`${base}/healthz`)
  assert.deepEqual(await health.json(), { ok: true, phase: 'S0' })
  const bootstrap = await fetch(`${base}/api/bootstrap`)
  const payload = await bootstrap.text()
  assert.equal(JSON.parse(payload).authenticated, false)
  assert.doesNotMatch(payload, /10\.0\.0\.12|3080/)
  const preview = await fetch(`${base}/preview`)
  assert.equal(preview.status, 200)
  assert.match(await preview.text(), /会话.*工作区.*数据/s)
  const forbidden = await fetch(`${base}/api/bootstrap`, { method: 'POST' })
  assert.equal(forbidden.status, 405)
  const missing = await fetch(`${base}/api/private/sessions`)
  assert.equal(missing.status, 404)
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = request(`${base}/healthz`, { headers: { host: 'other.example' } }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(wrongHostStatus, 421)
})

test('built assets use content versions for long browser caching while HTML stays fresh', async t => {
  const config = readConfig({ PUBLIC_ORIGIN: 'https://zhijian.meizu.life', DSH_BACKEND_URL: 'http://127.0.0.1:3080', PORT: '0' })
  const server = createPortalServer(config)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const page = await fetch(`${base}/preview`)
  const html = await page.text()
  assert.equal(page.headers.get('cache-control'), 'no-store')
  const versioned = /src="(\/assets\/app\.js\?v=[0-9a-f]{12})"/.exec(html)?.[1]
  assert.ok(versioned)
  const asset = await fetch(`${base}${versioned}`)
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  const etag = asset.headers.get('etag')
  assert.match(etag, /^"[0-9a-f]{64}"$/)
  assert.equal((await fetch(`${base}${versioned}`, { headers: { 'if-none-match': etag } })).status, 304)
  const unversioned = await fetch(`${base}/assets/app.js`)
  assert.equal(unversioned.headers.get('cache-control'), 'public, no-cache')
})
