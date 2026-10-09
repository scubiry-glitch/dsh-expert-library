/** Loopback-only protocol test issuer. Real HTTP discovery, authorize/code+PKCE,
 * token endpoint and asymmetric JWKS signatures; no fake center sessions. */
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'

export async function createTestIssuer() {
  const key = await generateKeyPair('RS256')
  const wrongKey = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(key.publicKey), alg: 'RS256', use: 'sig', kid: 'test-issuer-key' }
  const codes = new Map()
  const requests = { discovery: 0, authorize: 0, token: 0, jwks: 0 }
  let issuer
  const server = createServer(async (request, response) => {
    function json(status, object) {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(object))
    }
    try {
      const url = new URL(request.url, issuer)
      if (url.pathname === '/.well-known/openid-configuration') {
        requests.discovery++
        return json(200, { issuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}token`, jwks_uri: `${issuer}jwks`,
          response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post'], code_challenge_methods_supported: ['S256'] })
      }
      if (url.pathname === '/jwks') { requests.jwks++; return json(200, { keys: [jwk] }) }
      if (url.pathname === '/authorize') {
        requests.authorize++
        const p = url.searchParams
        if (!p.get('client_id') || p.get('response_type') !== 'code' || !p.get('scope')?.split(' ').includes('openid') || p.get('code_challenge_method') !== 'S256' || !p.get('nonce')) return json(400, { error: 'invalid_request' })
        const directive = JSON.parse(Buffer.from(String(request.headers['x-test-identity'] ?? ''), 'base64url').toString('utf8'))
        const code = randomBytes(32).toString('base64url')
        codes.set(code, { p, directive })
        const callback = new URL(p.get('redirect_uri'))
        callback.searchParams.set('code', code); callback.searchParams.set('state', p.get('state'))
        callback.searchParams.set('iss', issuer)
        response.writeHead(302, { location: callback.href }); return response.end()
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        requests.token++
        const chunks = []; for await (const chunk of request) chunks.push(chunk)
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
        const code = codes.get(params.get('code')); codes.delete(params.get('code'))
        if (!code || params.get('grant_type') !== 'authorization_code' || params.get('client_id') !== code.p.get('client_id') || params.get('redirect_uri') !== code.p.get('redirect_uri')
          || createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url') !== code.p.get('code_challenge')) return json(400, { error: 'invalid_grant' })
        const claims = { iss: issuer, sub: code.directive.subject, aud: params.get('client_id'), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
          nonce: code.p.get('nonce'), name: `Test ${code.directive.subject}`, email: 'same-address@example.test', ...code.directive.claims }
        const idToken = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).sign(code.directive.wrongSignature ? wrongKey.privateKey : key.privateKey)
        return json(200, { access_token: randomBytes(32).toString('base64url'), token_type: 'Bearer', expires_in: 300, id_token: idToken })
      }
      json(404, { error: 'not_found' })
    } catch { json(500, { error: 'test_issuer_error' }) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${server.address().port}/`
  return {
    issuer, requests,
    config: { issuer, clientId: 'test-pack-center', redirectUri: 'http://127.0.0.1:39999/auth/callback', allowLoopbackHttp: true },
    async authorize(authorizationUrl, directive = { subject: 'admin' }) {
      const response = await fetch(authorizationUrl, { redirect: 'manual', headers: { 'x-test-identity': Buffer.from(JSON.stringify(directive)).toString('base64url') } })
      if (response.status !== 302) throw new Error(`Test issuer authorization failed: ${response.status}`)
      return response.headers.get('location')
    },
    async login(service, subject = 'admin', options = {}) {
      const begin = await service.beginLogin({ invitationToken: options.invitationToken })
      const callbackUrl = await this.authorize(begin.authorizationUrl, { subject, ...options })
      return service.finishLogin({ callbackUrl, loginCookie: begin.loginCookie })
    },
    async close() { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  }
}
