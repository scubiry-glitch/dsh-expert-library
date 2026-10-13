import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { createOidcClient } from '../oidc-client.mjs'

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')

test('OIDC client verifies a real signed code flow and rejects wrong audience', async t => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: 'portal-test' }
  const codes = new Map()
  let issuer, wrongAudience = false
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, issuer)
    const reply = (status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)) }
    if (url.pathname === '/.well-known/openid-configuration') return reply(200, {
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
    })
    if (url.pathname === '/jwks') return reply(200, { keys: [jwk] })
    if (url.pathname === '/authorize') {
      const code = randomBytes(24).toString('base64url')
      codes.set(code, new URLSearchParams(url.search))
      const callback = new URL(url.searchParams.get('redirect_uri'))
      callback.searchParams.set('code', code)
      callback.searchParams.set('state', url.searchParams.get('state'))
      res.writeHead(302, { location: callback.href }); return res.end()
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const form = new URLSearchParams(Buffer.concat(chunks).toString())
      const grant = codes.get(form.get('code')); codes.delete(form.get('code'))
      if (!grant || form.get('client_id') !== 'portal-test' || form.get('redirect_uri') !== grant.get('redirect_uri')
        || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== grant.get('code_challenge')) return reply(400, { error: 'invalid_grant' })
      const now = Math.floor(Date.now() / 1000)
      const header = encode({ alg: 'RS256', kid: 'portal-test' })
      const payload = encode({ iss: issuer, sub: 'customer-a', aud: wrongAudience ? 'another-client' : 'portal-test',
        iat: now, exp: now + 300, nonce: grant.get('nonce'), name: 'Customer A' })
      const body = `${header}.${payload}`
      const signature = sign('sha256', Buffer.from(body), privateKey).toString('base64url')
      return reply(200, { token_type: 'Bearer', access_token: randomBytes(24).toString('base64url'),
        id_token: `${body}.${signature}`, expires_in: 300 })
    }
    reply(404, { error: 'not_found' })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  issuer = `http://127.0.0.1:${server.address().port}`
  const client = createOidcClient({ issuer, clientId: 'portal-test', redirectUri: 'http://127.0.0.1:39999/api/auth/callback' })
  const grant = async () => {
    const state = randomBytes(32).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const location = await client.start({ state, nonce, verifier })
    const redirect = await fetch(location, { redirect: 'manual' })
    return { callbackUrl: redirect.headers.get('location'), state, nonce, verifier }
  }
  assert.deepEqual(await client.finish(await grant()), { issuer, subject: 'customer-a', displayName: 'Customer A' })
  wrongAudience = true
  await assert.rejects(client.finish(await grant()))
})
