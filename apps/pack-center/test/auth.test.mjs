import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { createIdentityService } from '../dist/auth.js'
import { createTestIssuer } from './support/identity-fixture.mjs'
import { createDatabaseFixture } from './support/database-fixture.mjs'

let fixture
let provider
before(async () => { fixture = await createDatabaseFixture('auth'); provider = await createTestIssuer() })
after(async () => { await provider?.close(); await fixture?.close() })
const code = expected => error => { assert.equal(error.code, expected); return true }
const hash = value => createHash('sha256').update(value).digest('hex')
async function setup(t, options = {}) {
  const database = await fixture.database(t)
  const key = randomBytes(32)
  const service = createIdentityService({ database, oidc: provider.config, loginEncryptionKey: key, ...options })
  const admin = await service.bootstrapAdmin({ issuer: provider.issuer, subject: 'admin', displayName: 'Administrator' })
  const login = await provider.login(service)
  await service.createOrganization(login.principal, { id: 'org-a', slug: 'org-a', name: 'Organization A' })
  await service.createOrganization(login.principal, { id: 'org-b', slug: 'org-b', name: 'Organization B' })
  return { database, service, key, admin, login }
}
async function invite(service, admin, subject, organizationId = 'org-a', roles = ['member']) {
  const invitation = await service.createInvitation(admin, { organizationId, roles })
  return provider.login(service, subject, { invitationToken: invitation.invitationToken })
}

test('OIDC requires HTTPS unless explicitly loopback; no arbitrary HTTP issuer/callback', () => {
  const database = {}
  const options = { database, loginEncryptionKey: randomBytes(32), oidc: provider.config }
  assert.throws(() => createIdentityService({ ...options, oidc: { ...provider.config, allowLoopbackHttp: false } }), code('OIDC_CONFIG_INVALID'))
  assert.throws(() => createIdentityService({ ...options, oidc: { ...provider.config, issuer: 'http://identity.example/' } }), code('OIDC_CONFIG_INVALID'))
  assert.throws(() => createIdentityService({ ...options, oidc: { ...provider.config, redirectUri: 'http://app.example/auth/callback' } }), code('OIDC_CONFIG_INVALID'))
  assert.throws(() => createIdentityService({ ...options, loginEncryptionKey: randomBytes(16) }), code('IDENTITY_CONFIG_INVALID'))
})

test('bootstrap is explicit issuer+subject, first uninvited login cannot create user/admin, and invite consumption is atomic', async t => {
  const database = await fixture.database(t)
  const service = createIdentityService({ database, oidc: provider.config, loginEncryptionKey: randomBytes(32) })
  await assert.rejects(provider.login(service, 'first-visitor'), code('INVITATION_REQUIRED'))
  assert.equal((await database.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0)
  await assert.rejects(service.bootstrapAdmin({ issuer: 'https://wrong.example/', subject: 'admin', displayName: 'Admin' }), code('INVALID_INPUT'))
  const admin = await service.bootstrapAdmin({ issuer: provider.issuer, subject: 'admin', displayName: 'Admin' })
  assert.equal(admin.created, true)
  assert.deepEqual(await service.bootstrapAdmin({ issuer: provider.issuer, subject: 'admin', displayName: 'Admin' }), { ...admin, created: false })
  await assert.rejects(service.bootstrapAdmin({ issuer: provider.issuer, subject: 'attacker', displayName: 'Admin' }), code('BOOTSTRAP_ALREADY_COMPLETED'))
  const login = await provider.login(service)
  await service.createOrganization(login.principal, { id: 'org-a', slug: 'org-a', name: 'A' })
  const invitation = await service.createInvitation(login.principal, { organizationId: 'org-a', roles: ['member'] })
  const starts = await Promise.all([service.beginLogin({ invitationToken: invitation.invitationToken }), service.beginLogin({ invitationToken: invitation.invitationToken })])
  const callbacks = await Promise.all(starts.map((start, i) => provider.authorize(start.authorizationUrl, { subject: `invitee-${i}` })))
  const results = await Promise.allSettled(starts.map((start, i) => service.finishLogin({ callbackUrl: callbacks[i], loginCookie: start.loginCookie })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'INVITATION_INVALID')
  assert.equal((await database.query('SELECT count(*)::int AS n FROM memberships')).rows[0].n, 1)
  assert.equal((await database.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 2)
  await assert.rejects(service.beginLogin({ invitationToken: invitation.invitationToken }), code('INVITATION_INVALID'))
})

test('login is browser-bound, one-shot and encrypted; invalid cookie cannot consume a legitimate flow', async t => {
  const { service, database, key } = await setup(t)
  const begin = await service.beginLogin()
  const state = new URL(begin.authorizationUrl).searchParams.get('state')
  const nonce = new URL(begin.authorizationUrl).searchParams.get('nonce')
  const row = (await database.query('SELECT * FROM oidc_login_attempts WHERE state_sha256=$1', [hash(state)])).rows[0]
  assert.equal(row.browser_sha256, hash(begin.loginCookie)); assert.equal(row.nonce_sha256, hash(nonce))
  assert.match(row.encrypted_verifier, /^v1\./)
  assert.ok(!JSON.stringify(row).includes(nonce)); assert.ok(!JSON.stringify(row).includes(begin.loginCookie))
  const callbackUrl = await provider.authorize(begin.authorizationUrl)
  await assert.rejects(service.finishLogin({ callbackUrl, loginCookie: randomBytes(32).toString('base64url') }), code('OIDC_LOGIN_FAILED'))
  const results = await Promise.allSettled([service.finishLogin({ callbackUrl, loginCookie: begin.loginCookie }), service.finishLogin({ callbackUrl, loginCookie: begin.loginCookie })])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'OIDC_LOGIN_FAILED')
  const startWrongKey = await service.beginLogin()
  const wrongKeyService = createIdentityService({ database, oidc: provider.config, loginEncryptionKey: randomBytes(32) })
  await assert.rejects(wrongKeyService.finishLogin({ callbackUrl: await provider.authorize(startWrongKey.authorizationUrl), loginCookie: startWrongKey.loginCookie }), code('OIDC_LOGIN_FAILED'))
  assert.equal(key.length, 32)
})

test('OIDC checks issuer, audience, nonce, expiry, signature and PKCE with real token requests', async t => {
  const { service, database } = await setup(t)
  const startSessions = (await database.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n
  for (const claims of [{ iss: 'https://wrong.example/' }, { aud: 'other-client' }, { nonce: 'wrong' }, { exp: 1 }, { exp: Math.floor(Date.now() / 1000) - 1 }, { nbf: Math.floor(Date.now() / 1000) + 300 }, { sub: '' }]) {
    await assert.rejects(provider.login(service, 'admin', { claims }), code('OIDC_LOGIN_FAILED'))
  }
  await assert.rejects(provider.login(service, 'admin', { wrongSignature: true }), code('OIDC_LOGIN_FAILED'))
  const begin = await service.beginLogin()
  const tampered = new URL(begin.authorizationUrl); tampered.searchParams.set('code_challenge', 'different-challenge')
  await assert.rejects(service.finishLogin({ callbackUrl: await provider.authorize(tampered.href), loginCookie: begin.loginCookie }), code('OIDC_LOGIN_FAILED'))
  const wrongState = await service.beginLogin()
  const callback = new URL(await provider.authorize(wrongState.authorizationUrl)); callback.searchParams.append('state', 'duplicate')
  await assert.rejects(service.finishLogin({ callbackUrl: callback.href, loginCookie: wrongState.loginCookie }), code('OIDC_LOGIN_FAILED'))
  assert.equal((await database.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, startSessions)
  assert.ok(provider.requests.jwks > 0)
})

test('callback origin/path, login expiry and encrypted-envelope tampering are rejected without new sessions', async t => {
  const { service, database } = await setup(t)
  const sessionsBefore = (await database.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n
  for (const change of ['origin', 'path', 'expired', 'ciphertext']) {
    const begin = await service.beginLogin()
    const callback = new URL(await provider.authorize(begin.authorizationUrl))
    const stateHash = hash(callback.searchParams.get('state'))
    if (change === 'origin') callback.hostname = 'other.example'
    if (change === 'path') callback.pathname = '/other-callback'
    if (change === 'expired') await database.query("UPDATE oidc_login_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE state_sha256=$1", [stateHash])
    if (change === 'ciphertext') await database.query("UPDATE oidc_login_attempts SET encrypted_verifier=encrypted_verifier || 'x' WHERE state_sha256=$1", [stateHash])
    await assert.rejects(service.finishLogin({ callbackUrl: callback.href, loginCookie: begin.loginCookie }), code('OIDC_LOGIN_FAILED'))
  }
  assert.equal((await database.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, sessionsBefore)
})

test('sessions and CSRF are hashed, revoked/expired accounts rejected, no cleartext audit/idempotency', async t => {
  const { service, database, login } = await setup(t)
  const row = (await database.query('SELECT * FROM sessions WHERE token_sha256=$1', [hash(login.sessionToken)])).rows[0]
  assert.equal(row.csrf_sha256, hash(login.csrfToken))
  await assert.rejects(service.authenticateSession(login.sessionToken, { requireCsrf: true }), code('CSRF_INVALID'))
  await assert.rejects(service.authenticateSession(login.sessionToken, { requireCsrf: true, csrfToken: 'wrong' }), code('CSRF_INVALID'))
  assert.equal((await service.authenticateSession(login.sessionToken, { requireCsrf: true, csrfToken: login.csrfToken })).userId, login.principal.userId)
  const audit = JSON.stringify((await database.query('SELECT * FROM audit_events')).rows)
  assert.ok(!audit.includes(login.sessionToken)); assert.ok(!audit.includes(login.csrfToken))
  assert.equal((await database.query('SELECT count(*)::int AS n FROM request_idempotency')).rows[0].n, 0)
  const another = await provider.login(service)
  await database.query('UPDATE sessions SET expires_at=clock_timestamp()-interval \'1 second\' WHERE token_sha256=$1', [hash(another.sessionToken)])
  await assert.rejects(service.authenticateSession(another.sessionToken), code('UNAUTHENTICATED'))
  await service.revokeSession(login.sessionToken)
  await assert.rejects(service.authenticateSession(login.sessionToken), code('UNAUTHENTICATED'))
  await assert.rejects(service.requireOrgRole(login.principal, 'org-a', ['admin']), code('UNAUTHENTICATED'))
})

test('organization roles are live, emails do not identify accounts, review needs assigned scope and prohibits self-review', async t => {
  const { service, login } = await setup(t)
  const developer = await invite(service, login.principal, 'developer')
  const reviewer = await invite(service, login.principal, 'reviewer', 'org-b', ['reviewer'])
  assert.notEqual(developer.principal.userId, reviewer.principal.userId)
  await service.requireOrgRole(developer.principal, 'org-a', ['member'])
  await assert.rejects(service.requireOrgRole(developer.principal, 'org-b', ['member']), code('FORBIDDEN'))
  await assert.rejects(service.createInvitation(developer.principal, { organizationId: 'org-a', roles: ['admin'] }), code('FORBIDDEN'))
  await assert.rejects(service.requireReviewAccess(reviewer.principal, 'org-a', developer.principal.userId), code('FORBIDDEN'))
  await service.setReviewScope(login.principal, { organizationId: 'org-a', reviewerId: reviewer.principal.userId, granted: true })
  await service.requireReviewAccess(reviewer.principal, 'org-a', developer.principal.userId)
  await assert.rejects(service.requireReviewAccess(reviewer.principal, 'org-a', reviewer.principal.userId), code('SELF_REVIEW_DENIED'))
  // Platform administrators hold full review authority without a scope,
  // including self-review (database guard mirrors the exemption).
  await service.requireReviewAccess(login.principal, 'org-a', developer.principal.userId)
  await service.requireReviewAccess(login.principal, 'org-a', login.principal.userId)
  await assert.rejects(service.requireOrgRole({ ...login.principal }, 'org-a', ['admin']), code('UNAUTHENTICATED'))
  await service.setReviewScope(login.principal, { organizationId: 'org-a', reviewerId: reviewer.principal.userId, granted: false })
  await assert.rejects(service.requireReviewAccess(reviewer.principal, 'org-a', developer.principal.userId), code('FORBIDDEN'))
  await service.setMembership(login.principal, { organizationId: 'org-a', userId: developer.principal.userId, roles: ['member'], status: 'disabled' })
  await assert.rejects(service.requireOrgRole(developer.principal, 'org-a', ['member']), code('INVITATION_REQUIRED'))
  await service.setUserStatus(login.principal, { userId: reviewer.principal.userId, status: 'disabled' })
  await assert.rejects(service.authenticateSession(reviewer.sessionToken), code('UNAUTHENTICATED'))
  await assert.rejects(provider.login(service, 'reviewer'), code('ACCOUNT_DISABLED'))
})

test('invitation revocation/expiry and disabled organization take effect before callback membership admission', async t => {
  const { service, login, database } = await setup(t)
  for (const revoke of ['revoke', 'expire', 'disable_org']) {
    const invitation = await service.createInvitation(login.principal, { organizationId: 'org-a', roles: ['member'] })
    const begin = await service.beginLogin({ invitationToken: invitation.invitationToken })
    const callbackUrl = await provider.authorize(begin.authorizationUrl, { subject: revoke })
    if (revoke === 'revoke') await service.revokeInvitation(login.principal, invitation.invitationId)
    if (revoke === 'expire') await database.query("UPDATE invitations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [invitation.invitationId])
    if (revoke === 'disable_org') await database.query("UPDATE organizations SET status='disabled' WHERE id='org-a'")
    await assert.rejects(service.finishLogin({ callbackUrl, loginCookie: begin.loginCookie }), code('INVITATION_INVALID'))
  }
  assert.equal((await database.query('SELECT count(*)::int AS n FROM memberships')).rows[0].n, 0)
})

test('transactional permission locks prevent revoke racing a business commit; next request denies immediately', async t => {
  const { service, login, database } = await setup(t)
  const developer = await invite(service, login.principal, 'developer')
  let authorized
  let release
  const authorizedPromise = new Promise(resolve => { authorized = resolve })
  const releasePromise = new Promise(resolve => { release = resolve })
  const business = database.transaction(async client => {
    await service.requireOrgRole(developer.principal, 'org-a', ['member'], client)
    authorized(); await releasePromise
    await client.query("INSERT INTO packages(pack_id,owner_org_id,created_by,name) VALUES ('org-a.demo','org-a',$1,'Demo')", [developer.principal.userId])
  })
  await authorizedPromise
  let disabled = false
  const revoke = service.setMembership(login.principal, { organizationId: 'org-a', userId: developer.principal.userId, roles: ['member'], status: 'disabled' }).then(() => { disabled = true })
  await setTimeout(50); assert.equal(disabled, false)
  release(); await business; await revoke
  await assert.rejects(service.requireOrgRole(developer.principal, 'org-a', ['member']), code('INVITATION_REQUIRED'))
})

test('member/invitation lists respect tenant roles and redact secrets; organization disable invalidates access', async t => {
  const { service, login } = await setup(t)
  const developer = await invite(service, login.principal, 'developer')
  const orgAdmin = await invite(service, login.principal, 'organization-admin', 'org-a', ['admin'])
  const invitation = await service.createInvitation(orgAdmin.principal, { organizationId: 'org-a', roles: ['reviewer'] })
  assert.deepEqual((await service.listOrganizations(developer.principal)).map(org => org.id), ['org-a'])
  assert.equal((await service.listOrganizations(login.principal)).length, 2)
  assert.equal((await service.listMemberships(orgAdmin.principal, 'org-a')).length, 2)
  const invitationList = JSON.stringify(await service.listInvitations(orgAdmin.principal, 'org-a'))
  assert.ok(!invitationList.includes(invitation.invitationToken)); assert.ok(!invitationList.includes(hash(invitation.invitationToken)))
  await assert.rejects(service.listMemberships(developer.principal, 'org-a'), code('FORBIDDEN'))
  await assert.rejects(service.listInvitations(orgAdmin.principal, 'org-b'), code('FORBIDDEN'))
  await assert.rejects(service.setOrganizationStatus(orgAdmin.principal, { organizationId: 'org-b', status: 'disabled' }), code('FORBIDDEN'))
  await service.setOrganizationStatus(login.principal, { organizationId: 'org-a', status: 'disabled' })
  await assert.rejects(service.authenticateSession(developer.sessionToken), code('INVITATION_REQUIRED'))
  await assert.rejects(service.requireOrgRole(login.principal, 'org-a', ['admin']), code('FORBIDDEN'))
  await service.setOrganizationStatus(login.principal, { organizationId: 'org-a', status: 'active' })
  await service.requireOrgRole(developer.principal, 'org-a', ['member'])
})

test('setMembership adds a missing membership for platform admin only; update still works for org admin', async t => {
  const { service, login, database } = await setup(t)
  const member = await invite(service, login.principal, 'member', 'org-b', ['member'])
  const orgAdmin = await invite(service, login.principal, 'org-admin', 'org-b', ['admin'])
  // Org admin updating an existing membership still works.
  await service.setMembership(orgAdmin.principal, { organizationId: 'org-b', userId: member.principal.userId, roles: ['reviewer'], status: 'active' })
  // Org admin cannot add a brand-new membership; platform admin can.
  await assert.rejects(service.setMembership(orgAdmin.principal, { organizationId: 'org-a', userId: login.principal.userId, roles: ['member'], status: 'active' }), code('FORBIDDEN'))
  await service.setMembership(login.principal, { organizationId: 'org-a', userId: member.principal.userId, roles: ['admin', 'member'], status: 'active' })
  const row = (await database.query("SELECT roles,status FROM memberships WHERE organization_id='org-a' AND user_id=$1", [member.principal.userId])).rows[0]
  assert.deepEqual(row.roles, ['admin', 'member']); assert.equal(row.status, 'active')
  const audit = (await database.query("SELECT action FROM audit_events WHERE object_id=$1 AND action LIKE 'membership%'", [member.principal.userId])).rows.map(r => r.action)
  assert.ok(audit.includes('membership_added')); assert.ok(audit.includes('membership_updated'))
  await assert.rejects(service.setMembership(login.principal, { organizationId: 'org-a', userId: 'ghost.user', roles: ['member'], status: 'active' }), code('UNAUTHENTICATED'))
})

test('listUsers returns all accounts by default and filters by query', async t => {
  const { service, login } = await setup(t)
  const member = await invite(service, login.principal, 'member')
  const all = await service.listUsers(login.principal, {})
  assert.ok(all.length >= 2)
  assert.ok(all.some(item => item.userId === login.principal.userId))
  assert.ok(all.some(item => item.userId === member.principal.userId))
  assert.ok(all.every(item => 'packs' in item && 'tenants' in item))
  const filtered = await service.listUsers(login.principal, { query: 'member' })
  assert.deepEqual(filtered.map(item => item.userId), [member.principal.userId])
  const paged = await service.listUsers(login.principal, { limit: 1 })
  assert.equal(paged.length, 1)
})

test('platform admin flags: grant/revoke audited, self-change denied, non-admin callers forbidden', async t => {
  const { service, login, database } = await setup(t)
  const developer = await invite(service, login.principal, 'developer')
  await assert.rejects(service.setPlatformAdmin(developer.principal, { userId: login.principal.userId, platformAdmin: false }), code('FORBIDDEN'))
  await service.setPlatformAdmin(login.principal, { userId: developer.principal.userId, platformAdmin: true })
  const flags = (await database.query('SELECT platform_admin FROM users WHERE id=$1', [developer.principal.userId])).rows[0]
  assert.equal(flags.platform_admin, true)
  await assert.rejects(service.setPlatformAdmin(developer.principal, { userId: developer.principal.userId, platformAdmin: false }), code('SELF_PLATFORM_ADMIN_DENIED'))
  await service.setPlatformAdmin(login.principal, { userId: developer.principal.userId, platformAdmin: false })
  await assert.rejects(service.setPlatformAdmin(login.principal, { userId: 'missing.user', platformAdmin: true }), code('NOT_FOUND'))
  const audit = (await database.query("SELECT action FROM audit_events WHERE object_kind='user' AND object_id=$1 ORDER BY id", [developer.principal.userId])).rows.map(row => row.action)
  assert.ok(audit.includes('platform_admin_granted')); assert.ok(audit.includes('platform_admin_revoked'))
})

test('listUserPermissions aggregates memberships, review scopes and pack roles; admin-only', async t => {
  const { service, login, database } = await setup(t)
  const reviewer = await invite(service, login.principal, 'reviewer', 'org-a', ['reviewer'])
  await service.setReviewScope(login.principal, { organizationId: 'org-a', reviewerId: reviewer.principal.userId, granted: true })
  await database.query("INSERT INTO packages(pack_id,owner_org_id,created_by,name) VALUES ('org-a.demo','org-a',$1,'Demo')", [reviewer.principal.userId])
  await database.query("INSERT INTO pack_ownerships(pack_id,user_id,role,granted_by) VALUES ('org-a.demo',$1,'maintainer',$2)", [reviewer.principal.userId, login.principal.userId])
  const view = await service.listUserPermissions(login.principal, reviewer.principal.userId)
  assert.equal(view.user.userId, reviewer.principal.userId)
  assert.deepEqual(view.memberships.map(item => item.organizationId), ['org-a'])
  assert.deepEqual(view.memberships[0].roles, ['reviewer'])
  assert.deepEqual(view.reviewScopes.map(item => item.organizationId), ['org-a'])
  assert.deepEqual(view.packRoles.map(item => [item.packId, item.role]), [['org-a.demo', 'maintainer']])
  await assert.rejects(service.listUserPermissions(reviewer.principal, login.principal.userId), code('FORBIDDEN'))
  await assert.rejects(service.listUserPermissions(login.principal, 'missing.user'), code('NOT_FOUND'))
  await assert.rejects(service.listUserPermissions(login.principal, 'bad id!'), code('INVALID_INPUT'))
})

test('listAuditEvents returns newest-first trail with actor filter and cursor validation; admin-only', async t => {
  const { service, login, database } = await setup(t)
  const developer = await invite(service, login.principal, 'developer')
  await service.setDeveloper(login.principal, { userId: developer.principal.userId, developer: true })
  await service.setPlatformAdmin(login.principal, { userId: developer.principal.userId, platformAdmin: true })
  const all = await service.listAuditEvents(login.principal, {})
  assert.ok(all.items.length >= 2)
  assert.deepEqual(all.items, [...all.items].sort((left, right) => right.id - left.id))
  const filtered = await service.listAuditEvents(login.principal, { actorId: login.principal.userId })
  assert.ok(filtered.items.length >= 2)
  assert.ok(filtered.items.every(item => item.actorId === login.principal.userId))
  assert.ok(filtered.items.some(item => item.action === 'platform_admin_granted'))
  assert.ok(filtered.items[0].actorName)
  const paged = await service.listAuditEvents(login.principal, { limit: 1 })
  assert.equal(paged.items.length, 1)
  const older = await service.listAuditEvents(login.principal, { limit: 1, beforeId: String(paged.items[0].id) })
  assert.equal(older.items[0].id, all.items[1].id)
  await service.setPlatformAdmin(login.principal, { userId: developer.principal.userId, platformAdmin: false })
  await assert.rejects(service.listAuditEvents(developer.principal, {}), code('FORBIDDEN'))
  await assert.rejects(service.listAuditEvents(login.principal, { beforeId: 'abc' }), code('INVALID_INPUT'))
  await assert.rejects(service.listAuditEvents(login.principal, { limit: 0 }), code('INVALID_INPUT'))
  void database
})
