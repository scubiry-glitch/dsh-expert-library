import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createCenterServer } from '../dist/server.js'
import { createIdentityService } from '../dist/auth.js'
import { createSubmissionService } from '../dist/submissions.js'
import { createDatabaseFixture } from './support/database-fixture.mjs'
import { createTestIssuer } from './support/identity-fixture.mjs'

let fixture
let provider
before(async () => { fixture = await createDatabaseFixture('http'); provider = await createTestIssuer() })
after(async () => { await provider?.close(); await fixture?.close() })

async function setup(t, options = {}) {
  const database = await fixture.database(t)
  const publicOrigin = options.publicOrigin ?? 'http://127.0.0.1:39999'
  const identity = createIdentityService({ database, oidc: { ...provider.config, redirectUri: `${publicOrigin}/api/auth/callback` }, loginEncryptionKey: randomBytes(32) })
  await identity.bootstrapAdmin({ issuer: provider.issuer, subject: 'admin', displayName: 'Administrator' })
  const submissions = createSubmissionService(database, identity, { allowedGitHosts: ['github.com'] })
  const server = createCenterServer({ database, identity, submissions, publicOrigin, allowLoopbackHttp: true, ...options })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  const transport = `http://127.0.0.1:${server.address().port}`
  function browser() {
    const cookies = new Map()
    return {
      cookies,
      async call(path, { method = 'GET', body, headers = {}, raw, defaults = true } = {}) {
        const csrf = [...cookies].find(([key]) => key.endsWith('-csrf'))?.[1]
        const base = defaults ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
          ...(!['GET', 'HEAD'].includes(method) ? { origin: publicOrigin, 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) } : {}) } : {}
        const response = await fetch(`${transport}${path}`, { method, headers: { ...base, ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' })
        const setCookies = response.headers.getSetCookie()
        for (const value of setCookies) {
          const [pair] = value.split(';'); const separator = pair.indexOf('='); const name = pair.slice(0, separator); const token = pair.slice(separator + 1)
          if (token) cookies.set(name, token); else cookies.delete(name)
        }
        return { status: response.status, headers: response.headers, cookies: setCookies, body: await response.json() }
      },
      async login(subject = 'admin', invitationToken) {
        const start = await this.call('/api/auth/login', { method: 'POST', body: invitationToken ? { invitationToken } : {} })
        assert.equal(start.status, 200)
        const callback = new URL(await provider.authorize(start.body.authorizationUrl, { subject }))
        const response = await this.call(`${callback.pathname}${callback.search}`)
        assert.equal(response.status, 200, JSON.stringify(response.body))
        return response
      },
    }
  }
  const admin = browser(); const login = await admin.login()
  for (const org of ['org-a', 'org-b']) {
    assert.equal((await admin.call('/api/organizations', { method: 'POST', body: { id: org, slug: org, name: org } })).status, 201)
  }
  async function invite(subject, org = 'org-a', roles = ['member']) {
    const invitation = await admin.call(`/api/organizations/${org}/invitations`, { method: 'POST', body: { roles } })
    assert.equal(invitation.status, 201)
    const user = browser(); const signedIn = await user.login(subject, invitation.body.invitationToken)
    await admin.call(`/api/users/${signedIn.body.principal.userId}/developer`, { method: 'POST', body: { developer: true } })
    return { user, principal: signedIn.body.principal, invitationToken: invitation.body.invitationToken }
  }
  return { database, identity, submissions, server, publicOrigin, transport, browser, admin, login, invite }
}
const input = (overrides = {}) => ({ organizationId: 'org-a', packId: 'org-a.example', name: 'Example', version: '1.0.0',
  source: { url: 'https://github.com/example/domain-pack.git', ref: 'main' }, distribution: { kind: 'organization' }, ...overrides })
function failure(response, status, code) { assert.equal(response.status, status, JSON.stringify(response.body)); assert.equal(response.body.error.code, code) }

test('HTTP transport configuration rejects insecure non-loopback and implicit development settings', () => {
  const base = { database: {}, identity: {}, submissions: {} }
  for (const publicOrigin of ['http://center.example', 'https://user:password@center.example', 'https://center.example/extra', 'http://127.0.0.1:4310']) {
    assert.throws(() => createCenterServer({ ...base, publicOrigin }))
  }
  assert.throws(() => createCenterServer({ ...base, publicOrigin: 'http://center.example', allowLoopbackHttp: true }))
})

test('HTTP uses real OIDC sessions, production host-only Secure cookies and readable CSRF; logout revokes', async t => {
  const { admin, login, browser, database } = await setup(t, { publicOrigin: 'https://center.example.test' })
  const sessionCookie = login.cookies.find(value => value.startsWith('__Host-pack-center-session='))
  const csrfCookie = login.cookies.find(value => value.startsWith('__Host-pack-center-csrf='))
  assert.match(sessionCookie, /; Secure/); assert.match(sessionCookie, /; HttpOnly/); assert.match(sessionCookie, /; Path=\//); assert.match(sessionCookie, /; SameSite=Lax/)
  assert.doesNotMatch(sessionCookie, /Domain=/); assert.doesNotMatch(csrfCookie, /HttpOnly/)
  assert.equal(login.body.sessionToken, undefined)
  const me = await admin.call('/api/me')
  assert.equal(me.status, 200); assert.equal(me.body.principal.userId, login.body.principal.userId)
  assert.equal(me.body.csrfCookieName, '__Host-pack-center-csrf')
  const stolenCookie = [...admin.cookies].map(([key, value]) => `${key}=${value}`).join('; ')
  const logout = await admin.call('/api/auth/logout', { method: 'POST', body: {} })
  assert.equal(logout.status, 200); assert.equal(admin.cookies.size, 0)
  failure(await browser().call('/api/me', { headers: { cookie: stolenCookie } }), 401, 'UNAUTHENTICATED')
  const audit = JSON.stringify((await database.query('SELECT * FROM audit_events')).rows)
  for (const value of [login.body.csrfToken, sessionCookie.split(';')[0].split('=')[1]]) assert.ok(!audit.includes(value))
})

test('HTTP refuses missing/cross Origin, missing/wrong CSRF, preflight and machine-style anonymous writes', async t => {
  const { admin, browser, publicOrigin } = await setup(t)
  failure(await browser().call('/api/auth/login', { method: 'POST', body: {}, defaults: false, headers: { 'content-type': 'application/json' } }), 403, 'ORIGIN_DENIED')
  failure(await browser().call('/api/auth/login', { method: 'POST', body: {}, headers: { origin: 'https://attacker.example' } }), 403, 'ORIGIN_DENIED')
  failure(await admin.call('/api/organizations', { method: 'POST', body: { id: 'no', slug: 'no', name: 'No' }, headers: { 'x-csrf-token': '' } }), 403, 'CSRF_INVALID')
  failure(await admin.call('/api/organizations', { method: 'POST', body: { id: 'no', slug: 'no', name: 'No' }, headers: { 'x-csrf-token': 'wrong' } }), 403, 'CSRF_INVALID')
  const options = await admin.call('/api/submissions', { method: 'OPTIONS', headers: { origin: publicOrigin } })
  failure(options, 403, 'CORS_DENIED'); assert.equal(options.headers.get('access-control-allow-origin'), null)
  failure(await browser().call('/api/submissions', { method: 'POST', body: input(), headers: { authorization: 'Bearer fake-machine-token' } }), 400, 'AMBIGUOUS_AUTHENTICATION')
  failure(await browser().call('/api/submissions', { method: 'POST', body: input(), defaults: false,
    headers: { authorization: 'Bearer fake-machine-token', 'content-type': 'application/json' } }), 403, 'HUMAN_AUTHENTICATION_REQUIRED')
  failure(await admin.call('/api/me', { headers: { origin: 'https://attacker.example' } }), 403, 'ORIGIN_DENIED')
  failure(await browser().call('/api/bootstrap', { method: 'POST', body: { subject: 'attacker' } }), 404, 'NOT_FOUND')
})

test('callback is browser-bound and never derives origin from spoofed Host or forwarded headers', async t => {
  const { browser, publicOrigin } = await setup(t)
  const first = browser(); const second = browser()
  const start = await first.call('/api/auth/login', { method: 'POST', body: {}, headers: { host: 'attacker.example', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' } })
  assert.equal(new URL(start.body.authorizationUrl).searchParams.get('redirect_uri'), `${publicOrigin}/api/auth/callback`)
  const callback = new URL(await provider.authorize(start.body.authorizationUrl, { subject: 'admin' }))
  failure(await second.call(`${callback.pathname}${callback.search}`), 401, 'OIDC_LOGIN_FAILED')
  const finished = await first.call(`${callback.pathname}${callback.search}`, { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } })
  assert.equal(finished.status, 200)
  failure(await first.call(`${callback.pathname}${callback.search}`), 401, 'OIDC_LOGIN_FAILED')
})

test('request size/JSON/content-type errors are safe, no-store and secret-free even in failure audit', async t => {
  const { browser, admin, database, transport, publicOrigin } = await setup(t, { maxBodyBytes: 1024 })
  const anonymous = browser()
  failure(await anonymous.call('/api/auth/login', { method: 'POST', raw: '{bad' }), 400, 'JSON_INVALID')
  failure(await anonymous.call('/api/auth/login', { method: 'POST', raw: '[]' }), 400, 'JSON_INVALID')
  failure(await anonymous.call('/api/auth/login', { method: 'POST', raw: '{}', headers: { 'content-type': 'text/plain' } }), 415, 'JSON_REQUIRED')
  failure(await anonymous.call('/api/auth/login', { method: 'POST', body: { oversized: 'x'.repeat(2048) } }), 413, 'BODY_TOO_LARGE')
  const chunked = await fetch(`${transport}/api/auth/login`, { method: 'POST', headers: { origin: publicOrigin, 'content-type': 'application/json' },
    body: new ReadableStream({ start(controller) { for (let i = 0; i < 6; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(512))); controller.close() } }), duplex: 'half' })
  assert.equal(chunked.status, 413); assert.equal((await chunked.json()).error.code, 'BODY_TOO_LARGE')
  const secret = randomBytes(32).toString('base64url')
  const error = await anonymous.call(`/api/auth/login?invitationToken=${secret}`, { method: 'POST', body: {} })
  failure(error, 400, 'INVALID_INPUT')
  assert.equal(error.headers.get('cache-control'), 'no-store'); assert.equal(error.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(error.headers.get('referrer-policy'), 'no-referrer'); assert.equal(error.headers.get('x-frame-options'), 'DENY')
  assert.ok(!JSON.stringify(error.body).includes(secret))
  assert.ok(!JSON.stringify((await database.query('SELECT * FROM audit_events')).rows).includes(secret))
  const goodCookie = [...admin.cookies].map(([key, value]) => `${key}=${value}`).join('; ')
  const duplicate = `${goodCookie}; pack-center-dev-session=another-token`
  failure(await admin.call('/api/me', { headers: { cookie: duplicate } }), 400, 'COOKIE_INVALID')
  assert.deepEqual((await anonymous.call('/health')).body, { status: 'ok' })
})

test('developer HTTP create/edit/validate is idempotent, requires versions, and prevents cross-organization access', async t => {
  const { invite, database } = await setup(t)
  const { user } = await invite('developer')
  const other = await invite('other', 'org-b')
  failure(await user.call('/api/submissions', { method: 'POST', body: input() }), 400, 'IDEMPOTENCY_KEY_REQUIRED')
  failure(await user.call('/api/submissions', { method: 'POST', body: input({ version: 'not-semver' }), headers: { 'idempotency-key': randomUUID() } }), 400, 'INVALID_VERSION')
  failure(await user.call('/api/submissions', { method: 'POST', body: input({ packId: 'org-a.' + 'p'.repeat(60) }), headers: { 'idempotency-key': randomUUID() } }), 400, 'INVALID_INPUT')
  for (const item of [null, [], 'not-an-object', 10]) {
    failure(await user.call('/api/submissions', { method: 'POST', body: input({ builtinDependencies: [item] }), headers: { 'idempotency-key': randomUUID() } }), 400, 'INVALID_INPUT')
  }
  const operationKey = randomUUID()
  const created = await user.call('/api/submissions', { method: 'POST', body: input(), headers: { 'idempotency-key': operationKey } })
  assert.equal(created.status, 201); assert.equal(created.body.status, 'draft')
  assert.deepEqual((await user.call('/api/submissions', { method: 'POST', body: input(), headers: { 'idempotency-key': operationKey } })).body, created.body)
  failure(await user.call('/api/submissions', { method: 'POST', body: input({ version: '1.1.0' }), headers: { 'idempotency-key': operationKey } }), 409, 'IDEMPOTENCY_CONFLICT')
  const path = `/api/submissions/${created.body.id}`
  failure(await other.user.call(path), 404, 'NOT_FOUND')
  // Listing is session-gated and row-filtered: another tenant sees no items,
  // and the empty page does not leak that org-a exists.
  const crossTenant = await other.user.call('/api/submissions?organizationId=org-a')
  assert.equal(crossTenant.status, 200); assert.deepEqual(crossTenant.body, { items: [], nextCursor: null })
  assert.equal((await user.call('/api/submissions?organizationId=org-a')).body.items.length, 1)
  const editKey = randomUUID()
  const edited = await user.call(path, { method: 'PATCH', body: { expectedVersion: 1, version: '1.0.1', source: input().source, distribution: { kind: 'organization' } }, headers: { 'idempotency-key': editKey } })
  assert.equal(edited.status, 200); assert.equal(edited.body.version, '1.0.1'); assert.equal(edited.body.stateVersion, 2)
  failure(await user.call(`${path}/validate`, { method: 'POST', body: {}, headers: { 'idempotency-key': randomUUID() } }), 400, 'INVALID_INPUT')
  failure(await user.call(`${path}/validate`, { method: 'POST', body: { expectedVersion: 1 }, headers: { 'idempotency-key': randomUUID() } }), 409, 'VERSION_CONFLICT')
  const validateKey = randomUUID()
  const validation = await user.call(`${path}/validate`, { method: 'POST', body: { expectedVersion: 2 }, headers: { 'idempotency-key': validateKey } })
  assert.equal(validation.status, 202); assert.equal(validation.body.submission.status, 'validating')
  assert.deepEqual((await user.call(`${path}/validate`, { method: 'POST', body: { expectedVersion: 2 }, headers: { 'idempotency-key': validateKey } })).body, validation.body)
  assert.equal((await database.query("SELECT count(*)::int AS n FROM jobs WHERE kind='validate_submission'")).rows[0].n, 1)
  failure(await user.call(`${path}/submit`, { method: 'POST', body: { expectedVersion: 3 }, headers: { 'idempotency-key': randomUUID() } }), 409, 'INVALID_TRANSITION')
  failure(await user.call(`${path}/withdraw`, { method: 'POST', body: { expectedVersion: 3 }, headers: { 'idempotency-key': randomUUID() } }), 409, 'INVALID_TRANSITION')
})

test('admin membership/scope routes are enforced live; reviewer queue works across organizations and self-review is denied', async t => {
  const { admin, invite } = await setup(t)
  const developer = await invite('developer', 'org-a', ['member', 'reviewer'])
  const reviewer = await invite('reviewer', 'org-b', ['reviewer'])
  failure(await developer.user.call('/api/organizations/org-a/members'), 403, 'FORBIDDEN')
  failure(await reviewer.user.call('/api/reviews?organizationId=org-a'), 403, 'FORBIDDEN')
  for (const principal of [developer.principal, reviewer.principal]) {
    assert.equal((await admin.call('/api/organizations/org-a/review-scopes', { method: 'POST', body: { reviewerId: principal.userId, granted: true } })).status, 200)
  }
  assert.deepEqual((await reviewer.user.call('/api/reviews?organizationId=org-a')).body.items, [])
  const created = await developer.user.call('/api/submissions', { method: 'POST', body: input(), headers: { 'idempotency-key': randomUUID() } })
  failure(await developer.user.call(`/api/submissions/${created.body.id}/review`, { method: 'POST', body: { expectedVersion: 1, contentTreeSha256: 'a'.repeat(64), decision: 'approved', comment: 'Self review' }, headers: { 'idempotency-key': randomUUID() } }), 403, 'SELF_REVIEW_DENIED')
  assert.equal((await admin.call('/api/organizations/org-a/members')).body.items.length, 1)
  assert.equal((await admin.call('/api/organizations/org-a/invitations')).body.items.length, 1)
  assert.equal((await admin.call('/api/organizations/org-a/members', { method: 'POST', body: { userId: developer.principal.userId, roles: ['member'], status: 'disabled' } })).status, 200)
  failure(await developer.user.call('/api/me'), 403, 'INVITATION_REQUIRED')
  assert.equal((await admin.call(`/api/users/${reviewer.principal.userId}/status`, { method: 'POST', body: { status: 'disabled' } })).status, 200)
  failure(await reviewer.user.call('/api/me'), 401, 'UNAUTHENTICATED')
})
