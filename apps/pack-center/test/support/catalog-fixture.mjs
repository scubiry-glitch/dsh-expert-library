/** Signed immutable fixture, not a substitute for Git/validator/publisher flow tests.
 * Every identity is obtained through real OIDC and all archives use real CAS. */
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIdentityService } from '../../dist/auth.js'
import { createDeploymentService } from '../../dist/deployments.js'
import { createCatalogService } from '../../dist/catalog.js'
import { createReleaseGovernance } from '../../dist/release-governance.js'
import { createLocalArtifactStore } from '../../dist/storage.js'
import { packDirectory } from '../../../../packages/pack-artifact/index.mjs'
import { canonicalJson, canonicalBytes, signReleaseManifest } from '../../../../packages/pack-contract/index.mjs'

export async function setupCatalog(t, fixture, provider, options = {}) {
  const database = await fixture.database(t)
  const root = await mkdtemp(join(tmpdir(), 'pack-center-catalog-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const keys = generateKeyPairSync('ed25519'), store = await createLocalArtifactStore(join(root, 'store'))
  const identity = createIdentityService({ database, oidc: provider.config, loginEncryptionKey: randomBytes(32) })
  await identity.bootstrapAdmin({ issuer: provider.issuer, subject: 'admin', displayName: 'Admin' })
  const adminLogin = await provider.login(identity), admin = adminLogin.principal
  for (const name of ['demo', 'other']) await identity.createOrganization(admin, { id: name, slug: name, name })
  async function invite(subject, organizationId, roles) {
    const invitation = await identity.createInvitation(admin, { organizationId, roles })
    return provider.login(identity, subject, { invitationToken: invitation.invitationToken })
  }
  const ownerLogin = await invite('owner', 'demo', ['admin', 'member'])
  const outsiderLogin = await invite('outsider', 'other', ['admin'])
  const reviewerLogin = await invite('reviewer', 'other', ['reviewer'])
  const owner = ownerLogin.principal, outsider = outsiderLogin.principal, reviewer = reviewerLogin.principal
  await identity.setReviewScope(admin, { organizationId: 'demo', reviewerId: reviewer.userId, granted: true })
  const deployments = createDeploymentService({ database, identity, centerId: 'center-test' })
  const governance = createReleaseGovernance({ database, identity })
  const config = { database, identity, deployments, store, centerId: 'center-test', trustedSigningKeys: { 'test-key': keys.publicKey }, ...options }
  const catalog = createCatalogService(config)
  async function point(name, organizationId = 'demo') {
    const deployment = await deployments.create(admin, { organizationId, name }, randomUUID())
    const binding = await deployments.issueBindingCode(admin, deployment.id)
    const exchange = await deployments.exchange({ bindingCode: binding.bindingCode })
    return { deployment, binding, exchange, token: exchange.credentialToken, principal: await deployments.authenticateToken(exchange.credentialToken) }
  }
  const c = { database, root, keys, store, identity, admin, adminLogin, owner, ownerLogin, outsider, outsiderLogin,
    reviewer, reviewerLogin, deployments, governance, catalog, config, point }
  return c
}

export async function seedCatalogRelease(c, options = {}) {
  const id = options.id ?? `release-${randomBytes(6).toString('hex')}`, packId = options.packId ?? `demo.${id}`
  const version = options.version ?? '1.0.0', scope = options.scope ?? { kind: 'organization' }, dependencyLock = options.dependencies ?? []
  const submissionId = `s-${id}`, snapshotId = `ss-${id}`, reviewId = `rv-${id}`
  const directory = join(c.root, `content-${id}`), archive = join(c.root, `${id}.tar`)
  await mkdir(directory)
  const sample = JSON.parse(await readFile(new URL('../../../../examples/pack-center/demo-v1/pack.json', import.meta.url), 'utf8'))
  sample.pack.id = packId; sample.pack.version = version; sample.pack.dependsOn = dependencyLock.map(row => row.packId)
  await writeFile(join(directory, 'pack.json'), canonicalBytes(sample))
  const artifact = await packDirectory(directory, archive), stored = await c.store.putFile(archive, artifact.artifactSha256)
  const report = { schemaVersion: 1, validatorVersion: '0.1.0', packSchemaVersion: 2, valid: true, diagnostics: [], entityCounts: {} }
  const storedReport = await c.store.putJson(report)
  const delivery = { requiresPlugin: { minVersion: '0.1.0' }, dependencyLock, builtinDependencies: [] }
  await c.database.query("INSERT INTO packages(pack_id,owner_org_id,created_by,name) VALUES ($1,'demo',$2,'Catalog sample') ON CONFLICT DO NOTHING", [packId, c.owner.userId])
  // Raw seeding bypasses the submission service, so the creation-axis owner
  // grant must mirror migration 007's backfill explicitly.
  await c.database.query(`INSERT INTO pack_ownerships(pack_id,user_id,role,granted_by) VALUES ($1,$2,'owner',$2)
    ON CONFLICT (pack_id,user_id) DO NOTHING`, [packId, c.owner.userId])
  await c.database.query(`INSERT INTO submissions(id,owner_org_id,pack_id,author_id,version,source_url,source_ref,distribution,dependency_release_ids)
    VALUES ($1,'demo',$2,$3,$4,'https://unreachable.invalid/fixture.git','main',$5::jsonb,$6)`,
  [submissionId, packId, c.owner.userId, version, canonicalJson(scope), dependencyLock.map(row => row.releaseId)])
  await c.database.query("UPDATE submissions SET status='validating',state_version=2 WHERE id=$1", [submissionId])
  await c.database.query(`INSERT INTO submission_snapshots(id,submission_id,source_commit,artifact_sha256,content_tree_sha256,report_sha256,
    artifact_key,report_key,validator_version,normalization_version,pack_schema_version,size_bytes,file_count,report,preview,diff)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'0.1.0',1,2,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb)`,
  [snapshotId, submissionId, 'a'.repeat(40), artifact.artifactSha256, artifact.contentTreeSha256, storedReport.sha256,
    stored.key, storedReport.key, artifact.sizeBytes, artifact.fileCount, canonicalJson(report), canonicalJson({ delivery }), canonicalJson(options.diff ?? { baseline: null })])
  await c.database.query("UPDATE submissions SET status='validated',snapshot_id=$2,state_version=3 WHERE id=$1", [submissionId, snapshotId])
  await c.database.query("UPDATE submissions SET status='pending_review',state_version=4 WHERE id=$1", [submissionId])
  await c.database.query(`INSERT INTO reviews(id,submission_id,snapshot_id,reviewer_id,decision,expected_state_version,content_tree_sha256,comment)
    VALUES ($1,$2,$3,$4,'approved',4,$5,'Fixture fixed content approved')`, [reviewId, submissionId, snapshotId, c.reviewer.userId, artifact.contentTreeSha256])
  await c.database.query("UPDATE submissions SET status='approved',state_version=5 WHERE id=$1", [submissionId])
  await c.database.query(`INSERT INTO releases(id,pack_id,owner_org_id,version,approved_submission_id,snapshot_id)
    VALUES ($1,$2,'demo',$3,$4,$5)`, [id, packId, version, submissionId, snapshotId])
  const manifest = { schemaVersion: 1, protocolVersion: 1, normalizationVersion: 1, digestAlgorithmVersion: 1,
    signatureAlgorithm: 'Ed25519', archiveFormat: 'tar', centerId: 'center-test', releaseId: id, packId, ownerOrgId: 'demo',
    version, sourceCommit: 'a'.repeat(40), artifactSha256: artifact.artifactSha256, contentTreeSha256: artifact.contentTreeSha256,
    reportSha256: storedReport.sha256, validatorVersion: '0.1.0', packSchemaVersion: 2, ...delivery,
    sizeBytes: artifact.sizeBytes, fileCount: artifact.fileCount, approvedSubmissionId: submissionId, signingKeyId: 'test-key', ...options.manifestOverrides }
  const signed = signReleaseManifest(manifest, c.keys.privateKey)
  if (options.corruptSignature) {
    const bytes = Buffer.from(signed.signature, 'base64'); bytes[0] ^= 1; signed.signature = bytes.toString('base64')
  }
  await c.store.putJson(signed)
  await c.database.query("UPDATE releases SET signed_manifest=$2::jsonb,status='published',published_at=clock_timestamp(),state_version=2 WHERE id=$1", [id, canonicalJson(signed)])
  await c.database.query('INSERT INTO release_distribution(release_id,scope) VALUES ($1,$2::jsonb)', [id, canonicalJson(scope)])
  return { id, snapshotId, manifest, signed, artifact, archive, report, artifactPath: join(c.store.root, 'sha256', artifact.artifactSha256, 'data'),
    lock: { packId, ownerOrgId: 'demo', releaseId: id, version, artifactSha256: artifact.artifactSha256, contentTreeSha256: artifact.contentTreeSha256 } }
}

export async function narrowCatalogScope(c, releaseId, scope) {
  const current = await c.governance.get(c.owner, releaseId)
  const request = await c.governance.requestDistribution(c.owner, releaseId, { scope, expectedVersion: current.distribution.stateVersion, reason: 'Explicit fixture audience change' }, randomUUID())
  return c.governance.reviewDistribution(c.reviewer, request.id, { expectedVersion: request.stateVersion, decision: 'approved', comment: 'Independent audience review' }, randomUUID())
}

export async function consumeDownload(download) {
  const chunks = []
  for await (const chunk of download.stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
