import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { createCatalogService } from '../dist/catalog.js'
import { canonicalBytes, sha256 } from '../../../packages/pack-contract/index.mjs'
import { createDatabaseFixture } from './support/database-fixture.mjs'
import { createTestIssuer } from './support/identity-fixture.mjs'
import { setupCatalog, seedCatalogRelease, narrowCatalogScope, consumeDownload } from './support/catalog-fixture.mjs'

let fixture, provider
before(async () => { fixture = await createDatabaseFixture('catalog'); provider = await createTestIssuer() })
after(async () => { await provider?.close(); await fixture?.close() })
const code = expected => error => { assert.equal(error.code, expected); return true }
const setup = (t, options) => setupCatalog(t, fixture, provider, options)
const ids = result => result.items.map(item => item.releaseId)

test('organization catalogs include only live members/deployments; platform-admin power does not bypass private distribution', async t => {
  const c = await setup(t), point = await c.point('Owner point'), other = await c.point('Other point', 'other')
  const release = await seedCatalogRelease(c)
  for (const actor of [c.owner, point.principal]) assert.deepEqual(ids(await c.catalog.list(actor)), [release.id])
  for (const actor of [c.admin, c.outsider, c.reviewer, other.principal]) {
    assert.deepEqual(ids(await c.catalog.list(actor)), [])
    await assert.rejects(c.catalog.get(actor, release.id), code('NOT_FOUND'))
    await assert.rejects(c.catalog.issueDownloadGrant(actor, release.id), code('NOT_FOUND'))
  }
  assert.equal((await c.governance.get(c.admin, release.id)).id, release.id, 'administration is separate from catalog entitlement')
  await c.identity.setMembership(c.admin, { organizationId: 'demo', userId: c.owner.userId, roles: ['admin'], status: 'disabled' })
  await assert.rejects(c.catalog.list(c.owner), code('INVITATION_REQUIRED'))
})

test('selected scope is an explicit union and does not implicitly include author, owner organization or administrators', async t => {
  const c = await setup(t), selected = await c.point('Selected'), sibling = await c.point('Sibling'), outside = await c.point('Other', 'other')
  const release = await seedCatalogRelease(c, { scope: { kind: 'selected', organizationIds: ['other'], deploymentIds: [selected.deployment.id] } })
  for (const actor of [selected.principal, outside.principal, c.outsider, c.reviewer]) assert.equal((await c.catalog.get(actor, release.id)).releaseId, release.id)
  for (const actor of [c.owner, c.admin, sibling.principal]) {
    assert.deepEqual(ids(await c.catalog.list(actor)), [])
    await assert.rejects(c.catalog.get(actor, release.id), code('NOT_FOUND'))
  }
  const selectedOnly = await seedCatalogRelease(c, { scope: { kind: 'selected', organizationIds: [], deploymentIds: [selected.deployment.id] } })
  await assert.rejects(c.catalog.get(c.outsider, selectedOnly.id), code('NOT_FOUND'))
})

test('authenticated distribution requires an actual current principal, never a copied or caller-invented identity', async t => {
  const c = await setup(t), point = await c.point('Point'), release = await seedCatalogRelease(c, { scope: { kind: 'authenticated' } })
  for (const actor of [c.admin, c.owner, c.outsider, point.principal]) assert.equal((await c.catalog.get(actor, release.id)).releaseId, release.id)
  for (const actor of [undefined, {}, { ...c.owner }, { ...point.principal }, { kind: 'human', userId: c.owner.userId, platformAdmin: true, memberships: [] }]) {
    await assert.rejects(c.catalog.list(actor), code('UNAUTHENTICATED'))
    await assert.rejects(c.catalog.issueDownloadGrant(actor, release.id), code('UNAUTHENTICATED'))
  }
  await c.identity.revokeSession(c.outsiderLogin.sessionToken)
  await assert.rejects(c.catalog.get(c.outsider, release.id), code('UNAUTHENTICATED'))
})

test('authorization filtering precedes LIMIT and private rows do not dilute pages or change public cursors', async t => {
  const c = await setup(t)
  for (const [id, scope] of [
    ['release-z-private', { kind: 'organization' }], ['release-y-public', { kind: 'authenticated' }],
    ['release-x-private', { kind: 'organization' }], ['release-w-public', { kind: 'authenticated' }],
    ['release-v-private', { kind: 'organization' }], ['release-u-public', { kind: 'authenticated' }],
  ]) await seedCatalogRelease(c, { id, scope })
  const first = await c.catalog.list(c.outsider, { limit: 2 })
  assert.deepEqual(ids(first), ['release-y-public', 'release-w-public']); assert.equal(first.nextCursor, 'release-w-public')
  const next = await c.catalog.list(c.outsider, { limit: 2, beforeId: first.nextCursor })
  assert.deepEqual(ids(next), ['release-u-public']); assert.equal(next.nextCursor, null)
  assert.deepEqual(ids(await c.catalog.list(c.outsider, { packId: 'demo.release-y-public' })), ['release-y-public'])
})

test('download grants bind exact deployment credential, release and manifest; secrets are hashed and unaudited', async t => {
  const c = await setup(t), point = await c.point('Point'), second = await c.point('Second'), release = await seedCatalogRelease(c)
  const otherRelease = await seedCatalogRelease(c)
  const binding = await c.deployments.issueBindingCode(c.admin, point.deployment.id)
  const rotated = await c.deployments.exchange({ bindingCode: binding.bindingCode })
  const rotatedPrincipal = await c.deployments.authenticateToken(rotated.credentialToken)
  const grant = await c.catalog.issueDownloadGrant(point.principal, release.id)
  assert.equal(grant.signedManifest.manifest.artifactSha256, release.artifact.artifactSha256)
  for (const actor of [rotatedPrincipal, second.principal, c.owner]) await assert.rejects(c.catalog.openDownload(actor, release.id, grant.grantToken), code('DOWNLOAD_GRANT_INVALID'))
  await assert.rejects(c.catalog.openDownload(point.principal, otherRelease.id, grant.grantToken), code('DOWNLOAD_GRANT_INVALID'))
  const result = await c.catalog.openDownload(point.principal, release.id, grant.grantToken), bytes = await consumeDownload(result)
  assert.equal(sha256(bytes), release.artifact.artifactSha256); assert.deepEqual(bytes, await readFile(release.archive))
  assert.equal(result.manifestSha256, sha256(canonicalBytes(release.signed)))
  const row = (await c.database.query('SELECT * FROM download_grants')).rows[0]
  assert.equal(row.token_sha256, sha256(grant.grantToken)); assert.equal(row.credential_id, point.principal.credentialId)
  assert.ok(!JSON.stringify(row).includes(grant.grantToken))
  const audit = JSON.stringify((await c.database.query('SELECT * FROM audit_events')).rows)
  assert.ok(!audit.includes(grant.grantToken)); assert.ok(!audit.includes(point.token))
  await assert.rejects(c.database.query("UPDATE download_grants SET expires_at=expires_at+interval '1 hour'"), code('23514'))
})

test('revoked machine credentials and revoked human sessions invalidate already-issued grants', async t => {
  const c = await setup(t), point = await c.point('Point'), release = await seedCatalogRelease(c)
  const machineGrant = await c.catalog.issueDownloadGrant(point.principal, release.id)
  const humanGrant = await c.catalog.issueDownloadGrant(c.owner, release.id)
  await c.deployments.revokeCredential(c.admin, point.deployment.id, point.principal.credentialId, randomUUID())
  await assert.rejects(c.catalog.openDownload(point.principal, release.id, machineGrant.grantToken), code('UNAUTHENTICATED'))
  await c.identity.revokeSession(c.ownerLogin.sessionToken)
  await assert.rejects(c.catalog.openDownload(c.owner, release.id, humanGrant.grantToken), code('UNAUTHENTICATED'))
})

test('a dependency yank invalidates old parent grants while keeping authorized parent metadata with unavailable marker', async t => {
  const c = await setup(t), point = await c.point('Point'), dependency = await seedCatalogRelease(c)
  const parent = await seedCatalogRelease(c, { dependencies: [dependency.lock] })
  const grant = await c.catalog.issueDownloadGrant(point.principal, parent.id)
  await c.governance.yank(c.owner, dependency.id, { expectedVersion: 2, reason: 'Withdraw fixed dependency' }, randomUUID())
  await assert.rejects(c.catalog.openDownload(point.principal, parent.id, grant.grantToken), code('DEPENDENCY_UNAVAILABLE'))
  await assert.rejects(c.catalog.issueDownloadGrant(point.principal, parent.id), code('DEPENDENCY_UNAVAILABLE'))
  assert.deepEqual((await c.catalog.get(point.principal, parent.id)).downloadAvailability, { available: false, code: 'DEPENDENCY_UNAVAILABLE' })
  assert.deepEqual(ids(await c.catalog.list(point.principal)), [parent.id])
  await assert.rejects(c.catalog.get(point.principal, dependency.id), code('RELEASE_YANKED'))
})

test('dependency scope is checked again at old-grant use, including nested dependency closure', async t => {
  const c = await setup(t), allowed = await c.point('Allowed'), excluded = await c.point('Excluded')
  const leaf = await seedCatalogRelease(c), middle = await seedCatalogRelease(c, { dependencies: [leaf.lock] })
  const parent = await seedCatalogRelease(c, { dependencies: [middle.lock] })
  const grantA = await c.catalog.issueDownloadGrant(allowed.principal, parent.id)
  const grantB = await c.catalog.issueDownloadGrant(excluded.principal, parent.id)
  await narrowCatalogScope(c, leaf.id, { kind: 'selected', organizationIds: [], deploymentIds: [allowed.deployment.id] })
  await assert.rejects(c.catalog.openDownload(excluded.principal, parent.id, grantB.grantToken), code('DEPENDENCY_UNAVAILABLE'))
  assert.deepEqual((await c.catalog.get(excluded.principal, parent.id)).downloadAvailability, { available: false, code: 'DEPENDENCY_UNAVAILABLE' })
  const bytes = await consumeDownload(await c.catalog.openDownload(allowed.principal, parent.id, grantA.grantToken))
  assert.equal(sha256(bytes), parent.artifact.artifactSha256)
  assert.deepEqual((await c.catalog.get(allowed.principal, parent.id)).downloadAvailability, { available: true })
})

test('root scope narrowing, yanking and publisher organization disable invalidate old grants without signature mutation', async t => {
  const c = await setup(t), allowed = await c.point('Allowed'), excluded = await c.point('Excluded')
  const release = await seedCatalogRelease(c), grant = await c.catalog.issueDownloadGrant(excluded.principal, release.id)
  await narrowCatalogScope(c, release.id, { kind: 'selected', organizationIds: [], deploymentIds: [allowed.deployment.id] })
  await assert.rejects(c.catalog.openDownload(excluded.principal, release.id, grant.grantToken), code('NOT_FOUND'))
  assert.deepEqual((await c.catalog.get(allowed.principal, release.id)).signedManifest, release.signed)
  const permitted = await c.catalog.issueDownloadGrant(allowed.principal, release.id)
  await c.governance.yank(c.owner, release.id, { expectedVersion: 2, reason: 'Withdraw reviewed release' }, randomUUID())
  await assert.rejects(c.catalog.openDownload(allowed.principal, release.id, permitted.grantToken), code('RELEASE_YANKED'))
  const publicRelease = await seedCatalogRelease(c, { scope: { kind: 'authenticated' } })
  const outsiderGrant = await c.catalog.issueDownloadGrant(c.outsider, publicRelease.id)
  await c.identity.setOrganizationStatus(c.admin, { organizationId: 'demo', status: 'disabled' })
  await assert.rejects(c.catalog.openDownload(c.outsider, publicRelease.id, outsiderGrant.grantToken), code('NOT_FOUND'))
})

test('untrusted or corrupted signatures fail closed in list, details and grant issuance', async t => {
  const c = await setup(t)
  const bad = await seedCatalogRelease(c, { corruptSignature: true })
  for (const action of [() => c.catalog.list(c.owner), () => c.catalog.get(c.owner, bad.id), () => c.catalog.issueDownloadGrant(c.owner, bad.id)]) await assert.rejects(action(), code('RELEASE_INTEGRITY'))
  const valid = await seedCatalogRelease(c)
  const wrong = createCatalogService({ ...c.config, trustedSigningKeys: { 'test-key': generateKeyPairSync('ed25519').publicKey } })
  await assert.rejects(wrong.get(c.owner, valid.id), code('RELEASE_INTEGRITY'))
  const missing = createCatalogService({ ...c.config, trustedSigningKeys: { 'other-key': c.keys.publicKey } })
  await assert.rejects(missing.get(c.owner, valid.id), code('RELEASE_INTEGRITY'))
})

test('even a valid signature cannot substitute another center, snapshot identity, archive digest or fixed dependency lock', async t => {
  const c = await setup(t)
  for (const manifestOverrides of [{ centerId: 'another-center' }, { sourceCommit: 'b'.repeat(40) }, { artifactSha256: '0'.repeat(64) }, { sizeBytes: 1024 }]) {
    const bad = await seedCatalogRelease(c, { manifestOverrides })
    await assert.rejects(c.catalog.get(c.owner, bad.id), code('RELEASE_INTEGRITY'))
    await assert.rejects(c.catalog.issueDownloadGrant(c.owner, bad.id), code('RELEASE_INTEGRITY'))
  }
  const dependency = await seedCatalogRelease(c)
  const wrongLock = await seedCatalogRelease(c, { dependencies: [{ ...dependency.lock, contentTreeSha256: '0'.repeat(64) }] })
  await assert.rejects(c.catalog.get(c.owner, wrongLock.id), code('RELEASE_INTEGRITY'))
  await assert.rejects(c.catalog.issueDownloadGrant(c.owner, wrongLock.id), code('RELEASE_INTEGRITY'))
})

test('real CAS tampering rejects new grants and previously minted grants before exposing a download stream', async t => {
  const c = await setup(t), release = await seedCatalogRelease(c)
  const grant = await c.catalog.issueDownloadGrant(c.owner, release.id)
  const original = await readFile(release.artifactPath), changed = Buffer.from(original); changed[0] ^= 1
  await chmod(release.artifactPath, 0o600); await writeFile(release.artifactPath, changed); await chmod(release.artifactPath, 0o400)
  await assert.rejects(c.catalog.issueDownloadGrant(c.owner, release.id), code('STORAGE_HASH_MISMATCH'))
  await assert.rejects(c.catalog.openDownload(c.owner, release.id, grant.grantToken), code('STORAGE_HASH_MISMATCH'))
  assert.equal((await c.database.query("SELECT count(*)::int AS n FROM audit_events WHERE action='release.download_authorized'")).rows[0].n, 0)
})

test('real clock expiry rejects grants; token syntax, absence and actor mismatch are not authentication substitutes', async t => {
  const c = await setup(t, { downloadGrantTtlMs: 1000 }), release = await seedCatalogRelease(c)
  const grant = await c.catalog.issueDownloadGrant(c.owner, release.id)
  for (const value of ['', 'invalid', randomBytes(32).toString('base64url')]) await assert.rejects(c.catalog.openDownload(c.owner, release.id, value), code('DOWNLOAD_GRANT_INVALID'))
  await setTimeout(1100)
  await assert.rejects(c.catalog.openDownload(c.owner, release.id, grant.grantToken), code('DOWNLOAD_GRANT_INVALID'))
  const fresh = await c.catalog.issueDownloadGrant(c.owner, release.id)
  assert.equal(sha256(await consumeDownload(await c.catalog.openDownload(c.owner, release.id, fresh.grantToken))), release.artifact.artifactSha256)
})

test('catalog configuration accepts only bounded public Ed25519 keys and exposes stable public fingerprints', async t => {
  const c = await setup(t)
  const info = c.catalog.centerInfo()
  assert.equal(info.centerId, 'center-test'); assert.equal(info.signingKeys[0].keyId, 'test-key')
  assert.equal(info.signingKeys[0].fingerprintSha256, sha256(c.keys.publicKey.export({ type: 'spki', format: 'der' })))
  assert.match(info.signingKeys[0].publicKeyPem, /BEGIN PUBLIC KEY/); assert.ok(!JSON.stringify(info).includes('PRIVATE KEY'))
  for (const trustedSigningKeys of [{}, { 'test-key': c.keys.privateKey }, { 'test-key': c.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, { 'test-key': generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey }]) {
    assert.throws(() => createCatalogService({ ...c.config, trustedSigningKeys }), code('CATALOG_CONFIG'))
  }
  for (const downloadGrantTtlMs of [0, 999, 300001, NaN]) assert.throws(() => createCatalogService({ ...c.config, downloadGrantTtlMs }), code('CATALOG_CONFIG'))
  for (const input of [{ limit: 0 }, { limit: 101 }, { beforeId: '../invalid' }, { packId: '../invalid' }]) await assert.rejects(c.catalog.list(c.owner, input), code('INVALID_INPUT'))
})

test('public current-release diff cannot leak private baseline file paths, entity IDs or release identity', async t => {
  const c = await setup(t), previous = await seedCatalogRelease(c, { id: 'private-baseline', packId: 'demo.history' })
  const diff = { baseline: { releaseId: previous.id, snapshotId: previous.snapshotId },
    files: { added: ['public.md'], removed: ['private/internal_strategy.md'], changed: [] },
    entities: { experts: { added: [], removed: ['private.sensitive.expert'], changed: [], unverifiedPrevious: [] } },
    permissions: { before: { execScripts: ['private/secret_command.sh'], internalOnly: true }, after: { execScripts: [], internalOnly: false } } }
  const current = await seedCatalogRelease(c, { packId: 'demo.history', version: '1.1.0', scope: { kind: 'authenticated' }, diff })
  const authorized = await c.catalog.get(c.owner, current.id)
  assert.deepEqual(authorized.diff, diff); assert.deepEqual(authorized.diffAvailability, { available: true })
  for (const actor of [c.outsider, c.admin]) {
    const response = await c.catalog.get(actor, current.id)
    assert.equal(response.diff, null); assert.deepEqual(response.diffAvailability, { available: false, code: 'BASELINE_UNAVAILABLE' })
    for (const secret of [previous.id, previous.snapshotId, 'private/internal_strategy.md', 'private.sensitive.expert', 'private/secret_command.sh']) assert.ok(!JSON.stringify(response).includes(secret))
    assert.deepEqual(response.downloadAvailability, { available: true }, 'unavailable historical diff must not block current public archive')
  }
})

test('a previously visible diff is suppressed after baseline scope withdrawal or yank; first-version diff remains available', async t => {
  const c = await setup(t), point = await c.point('Point'), sibling = await c.point('Sibling')
  const previous = await seedCatalogRelease(c, { packId: 'demo.diffhistory' })
  const diff = { baseline: { releaseId: previous.id, snapshotId: previous.snapshotId }, files: { removed: ['old-private.md'], added: [], changed: [] } }
  const current = await seedCatalogRelease(c, { packId: 'demo.diffhistory', version: '1.1.0', diff })
  assert.deepEqual((await c.catalog.get(point.principal, current.id)).diff, diff)
  await narrowCatalogScope(c, previous.id, { kind: 'selected', organizationIds: [], deploymentIds: [sibling.deployment.id] })
  const hidden = await c.catalog.get(point.principal, current.id)
  assert.equal(hidden.diff, null); assert.equal(hidden.diffAvailability.code, 'BASELINE_UNAVAILABLE')
  assert.deepEqual((await c.catalog.get(sibling.principal, current.id)).diff, diff)
  await c.governance.yank(c.owner, previous.id, { expectedVersion: 2, reason: 'Old baseline withdrawn' }, randomUUID())
  const yanked = await c.catalog.get(sibling.principal, current.id)
  assert.equal(yanked.diff, null); assert.equal(yanked.diffAvailability.code, 'BASELINE_UNAVAILABLE')
  const first = await seedCatalogRelease(c, { diff: { baseline: null, files: { added: ['new.md'], removed: [], changed: [] } } })
  assert.deepEqual((await c.catalog.get(point.principal, first.id)).diffAvailability, { available: true })
})
