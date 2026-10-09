import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { createDeploymentService } from '../dist/deployments.js'
import { createIdentityService } from '../dist/auth.js'
import { createTestIssuer } from './support/identity-fixture.mjs'
import { createDatabaseFixture } from './support/database-fixture.mjs'

let fixture
let provider
before(async () => { fixture = await createDatabaseFixture('deployments'); provider = await createTestIssuer() })
after(async () => { await provider?.close(); await fixture?.close() })
const hash = value => createHash('sha256').update(value).digest('hex')
const code = expected => error => { assert.equal(error.code, expected); return true }
async function setup(t, options = {}) {
  const database = await fixture.database(t)
  const identity = createIdentityService({ database, oidc: provider.config, loginEncryptionKey: randomBytes(32) })
  await identity.bootstrapAdmin({ issuer: provider.issuer, subject: 'admin', displayName: 'Admin' })
  const login = await provider.login(identity)
  await identity.createOrganization(login.principal, { id: 'org-a', slug: 'org-a', name: 'A' })
  await identity.createOrganization(login.principal, { id: 'org-b', slug: 'org-b', name: 'B' })
  const service = createDeploymentService({ database, identity, centerId: 'test-center', ...options })
  return { database, identity, service, admin: login.principal }
}
async function invite(identity, admin, subject, organizationId = 'org-a', roles = ['admin']) {
  const invitation = await identity.createInvitation(admin, { organizationId, roles })
  return (await provider.login(identity, subject, { invitationToken: invitation.invitationToken })).principal
}
async function bound(service, admin, name = 'Point A') {
  const deployment = await service.create(admin, { organizationId: 'org-a', name }, `create:${name.replaceAll(' ', '-')}`)
  const binding = await service.issueBindingCode(admin, deployment.id)
  const exchanged = await service.exchange({ bindingCode: binding.bindingCode })
  return { deployment, binding, exchanged, principal: await service.authenticateToken(exchanged.credentialToken) }
}

test('creation uses current administrator permission; concurrent idempotency creates exactly one deployment', async t => {
  const { service, admin, database } = await setup(t)
  const input = { organizationId: 'org-a', name: 'Production A' }
  const results = await Promise.all(Array.from({ length: 3 }, () => service.create(admin, input, 'create-once')))
  assert.deepEqual(results[1], results[0]); assert.deepEqual(results[2], results[0])
  assert.equal(results[0].stateVersion, 1); assert.equal(results[0].status, 'active')
  assert.equal((await database.query('SELECT count(*)::int AS n FROM deployments')).rows[0].n, 1)
  assert.equal((await database.query("SELECT count(*)::int AS n FROM audit_events WHERE action='deployment_created'")).rows[0].n, 1)
  await assert.rejects(service.create(admin, { ...input, name: 'Different' }, 'create-once'), code('IDEMPOTENCY_CONFLICT'))
  await assert.rejects(service.create({ ...admin }, input, 'forged'), code('UNAUTHENTICATED'))
})

test('cross-tenant administrators, developers and machine principals cannot manage deployments', async t => {
  const { service, identity, admin } = await setup(t)
  const adminA = await invite(identity, admin, 'admin-a')
  const developer = await invite(identity, admin, 'developer', 'org-a', ['member'])
  const a = await bound(service, admin)
  const b = await service.create(admin, { organizationId: 'org-b', name: 'B' }, 'create-b')
  await assert.rejects(service.create(developer, { organizationId: 'org-a', name: 'D' }, 'developer-create'), code('FORBIDDEN'))
  await assert.rejects(service.create(adminA, { organizationId: 'org-b', name: 'B2' }, 'cross-create'), code('FORBIDDEN'))
  await assert.rejects(service.get(adminA, b.id), code('NOT_FOUND'))
  await assert.rejects(service.list(adminA, 'org-b'), code('FORBIDDEN'))
  await assert.rejects(service.issueBindingCode(adminA, b.id), code('NOT_FOUND'))
  await assert.rejects(service.setStatus(adminA, b.id, { status: 'disabled', expectedVersion: 1 }, 'cross-disable'), code('NOT_FOUND'))
  await assert.rejects(service.create(a.principal, { organizationId: 'org-a', name: 'D' }, 'machine-create'), code('HUMAN_REQUIRED'))
  await assert.rejects(identity.requireReviewAccess(a.principal, 'org-a'), code('UNAUTHENTICATED'))
  assert.equal((await service.list(adminA, 'org-a')).deployments.length, 1)
})

test('unauthorized deployment management cannot distinguish existing foreign IDs from unknown IDs', async t => {
  const { service, identity, admin } = await setup(t)
  const adminA = await invite(identity, admin, 'admin-a')
  const point = await service.create(admin, { organizationId: 'org-b', name: 'Private point' }, 'create-private')
  const binding = await service.issueBindingCode(admin, point.id)
  const exchanged = await service.exchange({ bindingCode: binding.bindingCode })
  const unknownId = '00000000-0000-0000-0000-000000000000'
  const operations = [
    id => service.get(adminA, id),
    id => service.issueBindingCode(adminA, id),
    id => service.revokeBindingCode(adminA, id, binding.bindingCodeId, 'revoke-code'),
    id => service.revokeCredential(adminA, id, exchanged.credential.id, 'revoke-credential'),
    id => service.setStatus(adminA, id, { status: 'disabled', expectedVersion: 1 }, 'disable'),
  ]
  for (const operation of operations) {
    const errors = []
    for (const id of [point.id, unknownId]) await assert.rejects(operation(id), error => {
      errors.push({ name: error.name, code: error.code, message: error.message, statusCode: error.statusCode }); return true
    })
    assert.deepEqual(errors[0], errors[1])
    assert.deepEqual(errors[0], { name: 'DeploymentError', code: 'NOT_FOUND', message: 'Deployment was not found', statusCode: 404 })
  }
  await assert.rejects(service.get({ ...adminA }, point.id), code('UNAUTHENTICATED'))
  await identity.setUserStatus(admin, { userId: adminA.userId, status: 'disabled' })
  await assert.rejects(service.get(adminA, point.id), code('UNAUTHENTICATED'))
})

test('binding exchange is atomically one-shot; secrets are hashed, never audited, listed or cached for replay', async t => {
  const { service, admin, database } = await setup(t)
  const deployment = await service.create(admin, { organizationId: 'org-a', name: 'A' }, 'create')
  const binding = await service.issueBindingCode(admin, deployment.id)
  const before = (await database.query('SELECT count(*)::int AS n FROM request_idempotency')).rows[0].n
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => service.exchange({ bindingCode: binding.bindingCode })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.deepEqual(results.filter(result => result.status === 'rejected').map(result => result.reason.code), ['BINDING_CODE_INVALID', 'BINDING_CODE_INVALID'])
  const exchange = results.find(result => result.status === 'fulfilled').value
  assert.equal(exchange.centerId, 'test-center'); assert.equal(exchange.deployment.id, deployment.id)
  assert.deepEqual(exchange.credential.scopes, ['catalog:read', 'release:download'])
  assert.match(exchange.credentialToken, /^dpc_token_[A-Za-z0-9_-]{43}$/)
  const bindingRow = (await database.query('SELECT * FROM deployment_binding_codes')).rows[0]
  const credentialRow = (await database.query('SELECT * FROM deployment_credentials')).rows[0]
  assert.equal(bindingRow.code_sha256, hash(binding.bindingCode)); assert.ok(bindingRow.consumed_at)
  assert.equal(credentialRow.token_sha256, hash(exchange.credentialToken))
  const persisted = JSON.stringify([bindingRow, credentialRow, (await database.query('SELECT * FROM audit_events')).rows, (await database.query('SELECT * FROM request_idempotency')).rows])
  assert.ok(!persisted.includes(binding.bindingCode)); assert.ok(!persisted.includes(exchange.credentialToken))
  const management = JSON.stringify(await service.get(admin, deployment.id))
  for (const value of [binding.bindingCode, exchange.credentialToken, hash(binding.bindingCode), hash(exchange.credentialToken)]) assert.ok(!management.includes(value))
  assert.equal((await database.query('SELECT count(*)::int AS n FROM request_idempotency')).rows[0].n, before)
})

test('issuing a replacement code cancels unconsumed predecessors; expiry and explicit cancellation fail closed', async t => {
  const { service, admin, database } = await setup(t)
  const deployment = await service.create(admin, { organizationId: 'org-a', name: 'A' }, 'create')
  const first = await service.issueBindingCode(admin, deployment.id)
  const second = await service.issueBindingCode(admin, deployment.id)
  await assert.rejects(service.exchange({ bindingCode: first.bindingCode }), code('BINDING_CODE_INVALID'))
  const revoked = await service.revokeBindingCode(admin, deployment.id, second.bindingCodeId, 'revoke')
  assert.deepEqual(await service.revokeBindingCode(admin, deployment.id, second.bindingCodeId, 'revoke'), revoked)
  await assert.rejects(service.exchange({ bindingCode: second.bindingCode }), code('BINDING_CODE_INVALID'))
  const third = await service.issueBindingCode(admin, deployment.id)
  await database.query("UPDATE deployment_binding_codes SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [third.bindingCodeId])
  await assert.rejects(service.exchange({ bindingCode: third.bindingCode }), code('BINDING_CODE_INVALID'))
  assert.equal((await database.query('SELECT count(*)::int AS n FROM deployment_credentials')).rows[0].n, 0)
  const fourth = await service.issueBindingCode(admin, deployment.id)
  assert.ok((await service.exchange({ bindingCode: fourth.bindingCode })).credentialToken)
})

test('machine capabilities are service-issued, immutable, current and scoped only to catalog/download', async t => {
  const { service, admin, database, identity } = await setup(t)
  const { principal, exchanged } = await bound(service, admin)
  assert.equal(principal.kind, 'deployment'); assert.equal(principal.organizationId, 'org-a')
  assert.ok(Object.isFrozen(principal)); assert.ok(Object.isFrozen(principal.scopes))
  assert.equal((await service.requireScope(principal, 'catalog:read')).credentialId, principal.credentialId)
  await assert.rejects(service.requireScope({ ...principal }, 'catalog:read'), code('UNAUTHENTICATED'))
  await assert.rejects(service.requireScope(admin, 'catalog:read'), code('UNAUTHENTICATED'))
  await assert.rejects(service.requireScope(principal, 'release:publish'), code('FORBIDDEN'))
  const otherInstance = createDeploymentService({ database, identity, centerId: 'test-center' })
  await assert.rejects(otherInstance.requireScope(principal, 'catalog:read'), code('UNAUTHENTICATED'))
  await otherInstance.requireScope(await otherInstance.authenticateToken(exchanged.credentialToken), 'release:download')
  await database.query("UPDATE deployment_credentials SET scopes=ARRAY['catalog:read'] WHERE id=$1", [principal.credentialId])
  await assert.rejects(service.requireScope(principal, 'release:download'), code('FORBIDDEN'))
  assert.deepEqual((await service.requireScope(principal, 'catalog:read')).scopes, ['catalog:read'])
  await assert.rejects(database.query("UPDATE deployment_credentials SET scopes=ARRAY['release:publish'] WHERE id=$1", [principal.credentialId]), /check constraint/)
})

test('credential revocation is idempotent, immediate for old principals and does not revoke unrelated points', async t => {
  const { service, admin } = await setup(t)
  const a = await bound(service, admin)
  const b = await bound(service, admin, 'Point B')
  const revoked = await service.revokeCredential(admin, a.deployment.id, a.principal.credentialId, 'revoke')
  assert.deepEqual(await service.revokeCredential(admin, a.deployment.id, a.principal.credentialId, 'revoke'), revoked)
  await assert.rejects(service.authenticateToken(a.exchanged.credentialToken), code('UNAUTHENTICATED'))
  await assert.rejects(service.requireScope(a.principal, 'catalog:read'), code('UNAUTHENTICATED'))
  await service.requireScope(b.principal, 'catalog:read')
  await assert.rejects(service.revokeCredential(admin, b.deployment.id, a.principal.credentialId, 'wrong-point'), code('NOT_FOUND'))
})

test('credential expiry and organization disable reject both token authentication and already-issued principals', async t => {
  const { service, admin, identity, database } = await setup(t)
  const a = await bound(service, admin)
  await database.query("UPDATE deployment_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [a.principal.credentialId])
  await assert.rejects(service.authenticateToken(a.exchanged.credentialToken), code('UNAUTHENTICATED'))
  await assert.rejects(service.requireScope(a.principal, 'catalog:read'), code('UNAUTHENTICATED'))
  const b = await bound(service, admin, 'Point B')
  const unconsumed = await service.issueBindingCode(admin, b.deployment.id)
  await identity.setOrganizationStatus(admin, { organizationId: 'org-a', status: 'disabled' })
  await assert.rejects(service.authenticateToken(b.exchanged.credentialToken), code('UNAUTHENTICATED'))
  await assert.rejects(service.requireScope(b.principal, 'catalog:read'), code('UNAUTHENTICATED'))
  await assert.rejects(service.exchange({ bindingCode: unconsumed.bindingCode }), code('BINDING_CODE_INVALID'))
})

test('deployment disable revokes all credentials/codes; optimistic re-enable never resurrects old secrets', async t => {
  const { service, admin } = await setup(t)
  const a = await bound(service, admin)
  const pending = await service.issueBindingCode(admin, a.deployment.id)
  const disableInput = { status: 'disabled', expectedVersion: 1 }
  const disabled = await service.setStatus(admin, a.deployment.id, disableInput, 'disable')
  assert.equal(disabled.stateVersion, 2); assert.equal(disabled.status, 'disabled')
  assert.deepEqual(await service.setStatus(admin, a.deployment.id, disableInput, 'disable'), disabled)
  await assert.rejects(service.authenticateToken(a.exchanged.credentialToken), code('UNAUTHENTICATED'))
  await assert.rejects(service.issueBindingCode(admin, a.deployment.id), code('DEPLOYMENT_DISABLED'))
  await assert.rejects(service.setStatus(admin, a.deployment.id, { status: 'active', expectedVersion: 1 }, 'stale'), code('STATE_CONFLICT'))
  const enabled = await service.setStatus(admin, a.deployment.id, { status: 'active', expectedVersion: 2 }, 'enable')
  assert.equal(enabled.stateVersion, 3)
  await assert.rejects(service.authenticateToken(a.exchanged.credentialToken), code('UNAUTHENTICATED'))
  await assert.rejects(service.exchange({ bindingCode: pending.bindingCode }), code('BINDING_CODE_INVALID'))
  const fresh = await service.issueBindingCode(admin, a.deployment.id)
  assert.ok((await service.exchange({ bindingCode: fresh.bindingCode })).credentialToken)
})

test('concurrent status updates produce one new state version, not last-writer-wins', async t => {
  const { service, admin } = await setup(t)
  const deployment = await service.create(admin, { organizationId: 'org-a', name: 'A' }, 'create')
  const results = await Promise.allSettled(['disable-1', 'disable-2'].map(key => service.setStatus(admin, deployment.id, { status: 'disabled', expectedVersion: 1 }, key)))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'STATE_CONFLICT')
  assert.equal((await service.get(admin, deployment.id)).deployment.stateVersion, 2)
})

test('live administrator/session revocation blocks previously authorized management and idempotent replay', async t => {
  const { service, identity, admin } = await setup(t)
  const orgAdmin = await invite(identity, admin, 'org-admin')
  const input = { organizationId: 'org-a', name: 'A' }
  const deployment = await service.create(orgAdmin, input, 'create')
  await identity.setMembership(admin, { organizationId: 'org-a', userId: orgAdmin.userId, roles: ['member'], status: 'active' })
  await assert.rejects(service.create(orgAdmin, input, 'create'), code('FORBIDDEN'))
  await assert.rejects(service.get(orgAdmin, deployment.id), code('NOT_FOUND'))
  await assert.rejects(service.issueBindingCode(orgAdmin, deployment.id), code('NOT_FOUND'))
})

test('authorized transaction fences revocation until commit; following request immediately denies', async t => {
  const { service, admin, database } = await setup(t)
  const a = await bound(service, admin)
  let authorized
  let release
  const ready = new Promise(resolve => { authorized = resolve })
  const finish = new Promise(resolve => { release = resolve })
  const downloadAuthorization = database.transaction(async client => {
    const authenticated = await service.authenticateToken(a.exchanged.credentialToken, client)
    await service.requireScope(authenticated, 'release:download', client)
    authorized(); await finish
  })
  await ready
  let revoked = false
  const revocation = service.revokeCredential(admin, a.deployment.id, a.principal.credentialId, 'revoke').then(() => { revoked = true })
  await setTimeout(50); assert.equal(revoked, false)
  release(); await downloadAuthorization; await revocation
  await assert.rejects(service.requireScope(a.principal, 'release:download'), code('UNAUTHENTICATED'))
})

test('concurrent binding exchange and deployment disable cannot leave a usable credential', async t => {
  const { service, admin } = await setup(t)
  const deployment = await service.create(admin, { organizationId: 'org-a', name: 'A' }, 'create')
  const binding = await service.issueBindingCode(admin, deployment.id)
  const [exchange, disabled] = await Promise.allSettled([
    service.exchange({ bindingCode: binding.bindingCode }),
    service.setStatus(admin, deployment.id, { status: 'disabled', expectedVersion: 1 }, 'disable'),
  ])
  assert.equal(disabled.status, 'fulfilled')
  if (exchange.status === 'fulfilled') await assert.rejects(service.authenticateToken(exchange.value.credentialToken), code('UNAUTHENTICATED'))
  else assert.equal(exchange.reason.code, 'BINDING_CODE_INVALID')
})

test('deployment identity is immutable in PostgreSQL and version increments cannot be skipped', async t => {
  const { service, admin, database } = await setup(t)
  const deployment = await service.create(admin, { organizationId: 'org-a', name: 'A' }, 'create')
  await assert.rejects(database.query("UPDATE deployments SET organization_id='org-b',state_version=state_version+1 WHERE id=$1", [deployment.id]), /deployment identity is immutable/)
  await assert.rejects(database.query("UPDATE deployments SET status='disabled' WHERE id=$1", [deployment.id]), /state version must advance exactly once/)
  assert.equal((await service.get(admin, deployment.id)).deployment.organizationId, 'org-a')
})

test('list pagination is bounded, tenant-filtered and metadata-only', async t => {
  const { service, admin } = await setup(t)
  for (let n = 0; n < 3; n++) await service.create(admin, { organizationId: 'org-a', name: `A${n}` }, `create-${n}`)
  await service.create(admin, { organizationId: 'org-b', name: 'B' }, 'create-b')
  const first = await service.list(admin, 'org-a', { limit: 2 })
  assert.equal(first.deployments.length, 2); assert.ok(first.nextCursor)
  const next = await service.list(admin, 'org-a', { limit: 2, beforeId: first.nextCursor })
  assert.equal(next.deployments.length, 1); assert.equal(next.nextCursor, null)
  assert.equal(new Set([...first.deployments, ...next.deployments].map(row => row.id)).size, 3)
  assert.ok([...first.deployments, ...next.deployments].every(row => row.organizationId === 'org-a'))
})

test('invalid identifiers, bounds, scope-injection and malformed secrets are rejected before any credential mint', async t => {
  const { service, admin, database, identity } = await setup(t)
  for (const token of ['', 'abc', randomBytes(32).toString('base64url'), `dpc_token_${'a'.repeat(44)}`]) await assert.rejects(service.authenticateToken(token), code('UNAUTHENTICATED'))
  for (const bindingCode of ['', 'abc', randomBytes(32).toString('base64url')]) await assert.rejects(service.exchange({ bindingCode }), code('BINDING_CODE_INVALID'))
  await assert.rejects(service.create(admin, { organizationId: '../org-a', name: 'A' }, 'create'), code('INVALID_INPUT'))
  await assert.rejects(service.create(admin, { organizationId: 'org-a', name: '\nA' }, 'create'), code('INVALID_INPUT'))
  await assert.rejects(service.create(admin, { organizationId: 'org-a', name: 'A', id: 'fixed' }, 'create'), code('INVALID_INPUT'))
  const deployment = await service.create(admin, { organizationId: 'org-a', name: 'A' }, 'create')
  for (const expiresInMs of [0, -1, 900001, NaN, Infinity]) await assert.rejects(service.issueBindingCode(admin, deployment.id, { expiresInMs }), code('INVALID_INPUT'))
  await assert.rejects(service.issueBindingCode(admin, deployment.id, { scopes: ['release:publish'] }), code('INVALID_INPUT'))
  const binding = await service.issueBindingCode(admin, deployment.id)
  await assert.rejects(service.exchange({ bindingCode: binding.bindingCode, scopes: ['release:publish'] }), code('BINDING_CODE_INVALID'))
  await assert.rejects(service.list(admin, 'org-a', { limit: 101 }), code('INVALID_INPUT'))
  await assert.rejects(service.list(admin, 'org-a', { unexpected: true }), code('INVALID_INPUT'))
  for (const input of [null, [], 'invalid']) {
    await assert.rejects(service.create(admin, input, 'invalid-create'), code('INVALID_INPUT'))
    await assert.rejects(service.setStatus(admin, deployment.id, input, 'invalid-status'), code('INVALID_INPUT'))
    await assert.rejects(service.issueBindingCode(admin, deployment.id, input), code('INVALID_INPUT'))
    await assert.rejects(service.exchange(input), code('BINDING_CODE_INVALID'))
  }
  assert.throws(() => createDeploymentService({ database, identity, centerId: 'bad/center' }), code('INVALID_INPUT'))
  assert.throws(() => createDeploymentService({ database, identity, centerId: 'center', credentialTtlMs: 0 }), code('INVALID_INPUT'))
  assert.equal((await database.query('SELECT count(*)::int AS n FROM deployment_credentials')).rows[0].n, 0)
})
