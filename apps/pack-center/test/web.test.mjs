import test from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserFixture } from './support/browser-fixture.mjs'

test('real HTTP serves a finite CSP-safe web shell without exposing server files, and OIDC callback negotiates only a fixed redirect', async t => {
  const { raw, publicOrigin, provider } = await createBrowserFixture(t)
  const shell = await raw('/')
  assert.equal(shell.status, 200)
  assert.match(shell.headers['content-type'], /^text\/html\b/)
  assert.equal(shell.headers['cache-control'], 'no-store')
  assert.equal(shell.headers['x-content-type-options'], 'nosniff')
  assert.equal(shell.headers['x-frame-options'], 'DENY')
  const csp = shell.headers['content-security-policy']
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(directive), `Missing ${directive}`)
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/)
  assert.match(shell.text, /<script[^>]+src="\/assets\/app\.js"[^>]*><\/script>/)
  assert.doesNotMatch(shell.text, /<script(?![^>]*\bsrc=)|\son[a-z]+\s*=|<style[\s>]/i)
  for (const asset of ['app.js', 'shared.js', 'submissions.js', 'admin.js', 'style.css']) {
    const response = await raw(`/assets/${asset}`)
    assert.equal(response.status, 200, asset)
    assert.match(response.headers['content-type'], asset.endsWith('.css') ? /^text\/css\b/ : /(?:javascript|ecmascript)/)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
    assert.ok(response.text.length > 50)
  }
  const head = await raw('/', { method: 'HEAD' })
  assert.equal(head.status, 200); assert.equal(head.text, '')
  const afterIssuer = await raw('/', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Accept: 'text/html' } })
  assert.equal(afterIssuer.status, 200, 'The fixed post-OIDC document redirect must render the public shell')
  assert.match(afterIssuer.headers['content-type'], /^text\/html\b/)
  const crossSiteApi = await raw('/api/me', { headers: { 'Sec-Fetch-Site': 'cross-site' } })
  assert.equal(crossSiteApi.status, 403, 'Cross-site document allowance must not expand to APIs')
  // Raw node:http preserves dot segments and escapes that fetch normalizes.
  for (const path of ['/src/server.ts', '/dist/server.js', '/package.json', '/.env', '/assets/server.js', '/assets/app.js.map',
    '/assets/../src/server.ts', '/assets/%2e%2e/src/server.ts', '/assets/%252e%252e/server.ts', '/assets/%2fetc%2fpasswd',
    '/assets/%5c..%5cserver.ts', '/assets/app.js%00', '/assets/%', '/api/not-present', '/submissions/new']) {
    const response = await raw(path)
    assert.ok([400, 404].includes(response.status), `Unsafe/unlisted path unexpectedly served: ${path} (${response.status})`)
    assert.match(response.headers['content-type'], /application\/json/)
    assert.doesNotMatch(response.text, /createCenterServer|root:x:|loginEncryptionKey|DATABASE_URL|<!doctype/i)
    assert.equal(response.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
  }
  const denied = await raw('/api/me')
  assert.equal(denied.status, 401)
  assert.equal(denied.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
  assert.equal((await raw('/assets/app.js', { method: 'POST', headers: { Origin: publicOrigin } })).status, 404)

  async function callback(accept) {
    const started = await raw('/api/auth/login', { method: 'POST', headers: { Origin: publicOrigin, 'Content-Type': 'application/json' }, body: {} })
    assert.equal(started.status, 200)
    const url = new URL(await provider.authorize(JSON.parse(started.text).authorizationUrl, { subject: 'admin' }))
    const cookie = started.headers['set-cookie'][0].split(';')[0]
    return raw(url.pathname + url.search, { headers: { Cookie: cookie, Accept: accept, Host: 'untrusted.example', 'X-Forwarded-Host': 'untrusted.example' } })
  }
  const json = await callback('application/json')
  assert.equal(json.status, 200); assert.equal(json.headers.location, undefined)
  assert.equal(JSON.parse(json.text).principal.platformAdmin, true)
  assert.ok(JSON.parse(json.text).csrfToken)
  const html = await callback('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
  assert.equal(html.status, 303); assert.equal(html.headers.location, '/')
  assert.doesNotMatch(html.text, /csrfToken|sessionToken|principal|untrusted/)
  assert.equal(html.headers['set-cookie'].filter(value => /pack-center-dev-session=.+/.test(value)).length, 1)
  assert.equal(html.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
  const failure = await raw('/api/auth/callback?code=invalid&state=invalid&redirect=https%3A%2F%2Fevil.example', { headers: { Accept: 'text/html' } })
  assert.equal(failure.status, 303); assert.equal(failure.headers.location, '/#/login-error')
  assert.doesNotMatch(failure.text, /invalid|evil|csrfToken|sessionToken/)
  const jsonFailure = await raw('/api/auth/callback?code=invalid&state=invalid', { headers: { Accept: 'application/json' } })
  assert.equal(jsonFailure.status, 401); assert.equal(jsonFailure.headers.location, undefined)
  assert.match(jsonFailure.headers['content-type'], /application\/json/)
  assert.ok(provider.requests.authorize >= 2 && provider.requests.token >= 2 && provider.requests.jwks >= 1)
})
