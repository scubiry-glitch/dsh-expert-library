import { createPrivateKey, createPublicKey, KeyObject, type KeyLike } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { PoolClient, QueryResultRow } from 'pg'
import { assertContract, canonicalBytes, canonicalJson, sha256, signReleaseManifest, verifyReleaseManifest, compareSemVer,
  type ReleaseManifest, type SignedReleaseManifest } from '../../../packages/pack-contract/index.mjs'
import { extractArtifact } from '../../../packages/pack-artifact/index.mjs'
import type * as Validator from '../../../lib/types/pack-validator.js'
import type { CenterDatabase, JobLease } from './database.js'
import type { LocalArtifactStore } from './storage.js'
import { validateFrozenDependencies } from './validation-worker.js'

export class PublisherError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'PublisherError' }
}
export interface PublisherOptions {
  database: CenterDatabase
  store: Pick<LocalArtifactStore, 'getBytes' | 'openStream' | 'putJson' | 'verify'>
  centerId: string; signingKeyId: string; signingPrivateKey: KeyLike; workerId: string; leaseMs?: number
  /** Explicit private quota-volume parent; never silently use system /tmp. */
  scratchRoot: string
  builtinPackVersions?: Readonly<Record<string, string>>
  /** Test-only process failure seam; never supplied by HTTP requests. */
  fault?: (point: 'after-freeze' | 'after-manifest-store' | 'before-commit') => void | Promise<void>
}
interface ReleaseRow { id: string; pack_id: string; owner_org_id: string; version: string; approved_submission_id: string;
  snapshot_id: string; status: string; state_version: number; signed_manifest: SignedReleaseManifest | null }
interface SnapshotRow { id: string; submission_id: string; source_commit: string; artifact_sha256: string; content_tree_sha256: string;
  report_sha256: string; artifact_key: string; report_key: string; validator_version: string; normalization_version: number;
  pack_schema_version: number; size_bytes: number; file_count: number; report: unknown; preview: Record<string, unknown> }
interface SubmissionRow { id: string; owner_org_id: string; pack_id: string; author_id: string; version: string; status: string; snapshot_id: string;
  requires_plugin: unknown; builtin_dependencies: unknown; dependency_release_ids: string[] }
interface ReviewRow { decision: string; snapshot_id: string; submission_id: string; reviewer_id: string; content_tree_sha256: string }
interface Bundle extends QueryResultRow { release: ReleaseRow; submission: SubmissionRow; snapshot: SnapshotRow; review: ReviewRow }
export type PublisherResult = { status: 'idle' } | { jobId: string; releaseId?: string; status: 'published' | 'yanked' | 'failed' | 'retrying' | 'lease_lost'; errorCode?: string; manifestKey?: string }
function fail(code: string, message: string): never { throw new PublisherError(code, message) }
function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes('..')
    && !['__proto__', 'constructor', 'prototype'].includes(value)
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b) }

export function createPublisher(options: PublisherOptions) {
  const { database, store } = options
  if (typeof options.scratchRoot !== 'string' || !isAbsolute(options.scratchRoot) || options.scratchRoot.includes('\0')) fail('PUBLISH_CONFIG', 'Publisher requires an explicit private scratch directory')
  for (const field of ['centerId', 'signingKeyId', 'workerId'] as const) {
    if (!safeId(options[field])) fail('PUBLISH_CONFIG', 'Publisher identifiers must be safe identifiers')
    if (field !== 'workerId' && options[field].length > 64) fail('PUBLISH_CONFIG', 'Manifest identifiers must fit the publication protocol')
  }
  const leaseMs = options.leaseMs ?? 30000
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 50 || leaseMs > 3600000) fail('PUBLISH_CONFIG', 'Invalid publisher lease duration')
  const privateKey = options.signingPrivateKey instanceof KeyObject ? options.signingPrivateKey : createPrivateKey(options.signingPrivateKey)
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') fail('PUBLISH_KEY_ALGORITHM', 'Publisher requires an Ed25519 private key')
  const publicKey = createPublicKey(privateKey)

  async function fence(tx: PoolClient, lease: JobLease): Promise<void> {
    const result = await tx.query(`SELECT id FROM jobs WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_token=$3::uuid
      AND lease_expires_at>clock_timestamp() FOR UPDATE`, [lease.id, lease.leaseOwner, lease.leaseToken])
    if (result.rowCount !== 1) fail('LEASE_LOST', 'Publisher no longer owns its job lease')
  }
  async function bundle(releaseId: string, snapshotId: string): Promise<Bundle> {
    const result = (await database.query<Bundle>(`SELECT row_to_json(r) AS release,row_to_json(s) AS submission,
      row_to_json(ss) AS snapshot,row_to_json(rv) AS review FROM releases r
      JOIN submissions s ON s.id=r.approved_submission_id JOIN submission_snapshots ss ON ss.id=r.snapshot_id
      JOIN reviews rv ON rv.submission_id=s.id WHERE r.id=$1 AND r.snapshot_id=$2`, [releaseId, snapshotId])).rows[0]
    if (!result) fail('PUBLISH_SNAPSHOT_MISSING', 'Release does not identify an approved fixed snapshot')
    const { release: r, submission: s, snapshot: ss, review: rv } = result
    // Self-review is only acceptable when the reviewer holds admin authority
    // (platform admin, or the owning tenant's admin) — the same exemption the
    // review guards enforce. Authority is checked live, at publication time.
    const selfReviewAllowed = rv.reviewer_id === s.author_id && !!(await database.query(
      `SELECT 1 FROM users u WHERE u.id=$1 AND u.status='active' AND u.platform_admin
        UNION ALL
       SELECT 1 FROM memberships m WHERE m.user_id=$1 AND m.organization_id=$2 AND m.status='active' AND m.roles @> ARRAY['admin']::text[]
       LIMIT 1`, [rv.reviewer_id, r.owner_org_id])).rows[0]
    if (s.status !== 'approved' || s.snapshot_id !== ss.id || ss.submission_id !== s.id || r.approved_submission_id !== s.id
      || r.pack_id !== s.pack_id || r.owner_org_id !== s.owner_org_id || r.version !== s.version
      || rv.decision !== 'approved' || rv.snapshot_id !== ss.id || rv.submission_id !== s.id
      || (rv.reviewer_id === s.author_id && !selfReviewAllowed) || rv.content_tree_sha256 !== ss.content_tree_sha256) {
      fail('PUBLISH_APPROVAL_MISMATCH', 'Approval, release and snapshot identities do not agree')
    }
    if (!['publishing', 'publish_failed', 'published', 'yanked'].includes(r.status)) fail('PUBLISH_STATE', 'Release is not publishable')
    if (ss.normalization_version !== 1 || ss.pack_schema_version !== 2) fail('PUBLISH_PROTOCOL', 'Snapshot protocol is unsupported')
    if (ss.artifact_key !== `sha256/${ss.artifact_sha256}` || ss.report_key !== `sha256/${ss.report_sha256}`) fail('PUBLISH_STORAGE_KEY', 'Snapshot keys do not match frozen byte hashes')
    return result
  }
  function manifestFor(value: Bundle): ReleaseManifest {
    const { release: r, snapshot: ss } = value
    const delivery = ss.preview.delivery as Partial<Pick<ReleaseManifest, 'requiresPlugin' | 'dependencyLock' | 'builtinDependencies'>> | undefined
    if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)
      || Object.keys(delivery).sort().join(',') !== 'builtinDependencies,dependencyLock,requiresPlugin') {
      fail('PUBLISH_DELIVERY_MISSING', 'Snapshot has no complete reviewed delivery requirements')
    }
    const manifest = {
      schemaVersion: 1, protocolVersion: 1, normalizationVersion: 1, digestAlgorithmVersion: 1,
      signatureAlgorithm: 'Ed25519', archiveFormat: 'tar', centerId: options.centerId,
      releaseId: r.id, packId: r.pack_id, ownerOrgId: r.owner_org_id, version: r.version,
      sourceCommit: ss.source_commit, artifactSha256: ss.artifact_sha256, contentTreeSha256: ss.content_tree_sha256,
      reportSha256: ss.report_sha256, validatorVersion: ss.validator_version, packSchemaVersion: ss.pack_schema_version,
      requiresPlugin: delivery.requiresPlugin, dependencyLock: delivery.dependencyLock, builtinDependencies: delivery.builtinDependencies,
      sizeBytes: Number(ss.size_bytes), fileCount: ss.file_count, approvedSubmissionId: r.approved_submission_id,
      signingKeyId: options.signingKeyId,
    }
    const checked = assertContract('release', manifest)
    if (!same(checked.requiresPlugin, value.submission.requires_plugin) || !same(checked.builtinDependencies, value.submission.builtin_dependencies)
      || !same(checked.dependencyLock.map(item => item.releaseId), value.submission.dependency_release_ids)) {
      fail('PUBLISH_DELIVERY_CONFLICT', 'Snapshot requirements differ from the frozen author submission')
    }
    return checked
  }
  function existingSignature(envelope: SignedReleaseManifest, expected: ReleaseManifest): SignedReleaseManifest {
    if (envelope.manifest?.signingKeyId !== options.signingKeyId) fail('PUBLISH_KEY_MISMATCH', 'A frozen release requires its original signing key configuration')
    try { verifyReleaseManifest(envelope, { [options.signingKeyId]: publicKey }) }
    catch { fail('PUBLISH_KEY_MISMATCH', 'Frozen signature does not verify with the configured publishing key') }
    if (!same(envelope.manifest, expected)) fail('PUBLISH_IMMUTABLE_CONFLICT', 'Frozen signed manifest does not match the approved snapshot')
    return envelope
  }
  async function verifySnapshot(value: Bundle, manifest: ReleaseManifest): Promise<void> {
    const { snapshot } = value
    const reportBytes = await store.getBytes(snapshot.report_key, { maxBytes: 16 * 1024 * 1024 })
    let reportJson: unknown
    try { reportJson = JSON.parse(reportBytes.toString('utf8')) } catch { fail('PUBLISH_REPORT_INVALID', 'Frozen validation report is invalid JSON') }
    const report = assertContract('report', reportJson)
    if (!report.valid || report.validatorVersion !== snapshot.validator_version || report.packSchemaVersion !== snapshot.pack_schema_version
      || !canonicalBytes(report).equals(reportBytes) || sha256(reportBytes) !== snapshot.report_sha256 || !same(report, snapshot.report)) {
      fail('PUBLISH_REPORT_INVALID', 'Frozen report does not prove this approved snapshot is valid')
    }
    const parent = await lstat(options.scratchRoot)
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o7777) !== 0o700
      || (process.geteuid && parent.uid !== process.geteuid()) || await realpath(options.scratchRoot) !== options.scratchRoot) fail('PUBLISH_SCRATCH_UNSAFE', 'Publisher scratch parent must be real, owned and private (0700)')
    const scratch = await mkdtemp(join(options.scratchRoot, 'pack-center-publish-'))
    try {
      await chmod(scratch, 0o700)
      const archive = join(scratch, 'artifact.tar'), content = join(scratch, 'content')
      const download = await store.openStream(snapshot.artifact_key, { maxBytes: manifest.sizeBytes })
      if (download.sha256 !== manifest.artifactSha256 || download.sizeBytes !== manifest.sizeBytes) {
        download.stream.destroy(); fail('PUBLISH_ARTIFACT_MISMATCH', 'Archive metadata differs from approved snapshot')
      }
      await pipeline(download.stream, createWriteStream(archive, { flags: 'wx', mode: 0o600 }))
      await extractArtifact(archive, content, { artifactSha256: manifest.artifactSha256, contentTreeSha256: manifest.contentTreeSha256,
        sizeBytes: manifest.sizeBytes, fileCount: manifest.fileCount })
      const { loadPackFromDir } = await import(new URL('../../../lib/pack-validator.js', import.meta.url).href) as typeof Validator
      const loaded = await loadPackFromDir(content)
      if (!loaded.ok || !loaded.pack || loaded.pack.pack.id !== manifest.packId || loaded.pack.pack.version !== manifest.version
        || loaded.pack.pack.schemaVersion !== manifest.packSchemaVersion) fail('PUBLISH_PACK_INVALID', 'Frozen artifact is not the approved domain pack')
      const actual = [...(loaded.pack.pack.dependsOn ?? [])].sort()
      const locked = [...manifest.dependencyLock.map(item => item.packId), ...manifest.builtinDependencies.map(item => item.packId)].sort()
      if (new Set(locked).size !== locked.length || !same(actual, locked)) fail('PUBLISH_DEPENDENCY_MISMATCH', 'Frozen dependency locks do not match the actual domain pack')
    } finally { await rm(scratch, { recursive: true, force: true }) }
  }
  async function verifyDependencies(tx: PoolClient, manifest: ReleaseManifest): Promise<void> {
    const row = (await tx.query(`SELECT d.scope FROM release_distribution d JOIN organizations o ON o.id=$2
      WHERE d.release_id=$1 AND o.status='active' FOR SHARE OF d,o`, [manifest.releaseId, manifest.ownerOrgId])).rows[0]
    if (!row) fail('PUBLISH_OWNER_UNAVAILABLE', 'Publishing organization or release distribution is unavailable')
    await validateFrozenDependencies(tx, { ownerOrgId: manifest.ownerOrgId, packId: manifest.packId,
      distribution: assertContract('scope', row.scope), dependencyLock: manifest.dependencyLock,
      builtinDependencies: manifest.builtinDependencies,
      checkBuiltin(dependency) {
        const inventory = options.builtinPackVersions ?? {}
        const version = Object.hasOwn(inventory, dependency.packId) ? inventory[dependency.packId] : undefined
        if (!version || compareSemVer(version, dependency.minVersion) < 0
          || (dependency.maxVersionExclusive !== undefined && compareSemVer(version, dependency.maxVersionExclusive) >= 0)) {
          fail('BUILTIN_DEPENDENCY_UNAVAILABLE', 'Reviewed built-in dependency is unavailable in the configured inventory')
        }
      },
    })
  }
  async function freeze(lease: JobLease, value: Bundle, expected: ReleaseManifest): Promise<SignedReleaseManifest> {
    return database.transaction(async tx => {
      await fence(tx, lease)
      const r = (await tx.query<ReleaseRow & QueryResultRow>('SELECT * FROM releases WHERE id=$1 FOR UPDATE', [value.release.id])).rows[0]!
      if (r.snapshot_id !== value.snapshot.id || r.approved_submission_id !== value.submission.id) fail('PUBLISH_IMMUTABLE_CONFLICT', 'Release snapshot changed')
      if (r.status === 'publishing' || r.status === 'publish_failed') await verifyDependencies(tx, expected)
      const envelope = r.signed_manifest ? existingSignature(r.signed_manifest, expected) : signReleaseManifest(expected, privateKey)
      if (!r.signed_manifest || r.status === 'publish_failed') {
        await tx.query(`UPDATE releases SET signed_manifest=$2::jsonb,status='publishing',error_code=NULL,state_version=state_version+1 WHERE id=$1`, [r.id, canonicalJson(envelope)])
      }
      // Check the DB clock after all business writes as well as before them. An expired lease rolls back.
      await fence(tx, lease)
      return envelope
    })
  }
  async function recordFailure(lease: JobLease, releaseId: string | undefined, error: unknown): Promise<PublisherResult> {
    const raw = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'PUBLISH_INTERNAL'
    const code = /^[A-Z0-9_]{1,100}$/.test(raw) ? raw : 'PUBLISH_INTERNAL'
    if (code === 'LEASE_LOST') return { jobId: lease.id, ...(releaseId ? { releaseId } : {}), status: 'lease_lost', errorCode: code }
    const transient = ['EIO', 'ENOSPC', 'ECONNRESET', 'ECONNREFUSED', '57P01', 'PUBLISH_INTERNAL'].includes(code)
    const retry = transient && lease.attempt < lease.maxAttempts
    try {
      return await database.transaction(async tx => {
        await fence(tx, lease)
        if (releaseId && !retry) {
          await tx.query(`UPDATE releases SET status='publish_failed',error_code=$2,state_version=state_version+1
            WHERE id=$1 AND status='publishing'`, [releaseId, code])
          await tx.query(`INSERT INTO audit_events(actor_kind,actor_id,action,object_kind,object_id,outcome,details)
            VALUES ('system',$1,'release.publish_failed','release',$2,'failed',$3::jsonb)`, [options.workerId, releaseId, canonicalJson({ jobId: lease.id, errorCode: code })])
        }
        const updated = await tx.query(`UPDATE jobs SET status=$4,error_code=$5,error_message='Release publication failed; inspect the error code',
          available_at=clock_timestamp()+interval '1 second',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_token=$3::uuid AND lease_expires_at>clock_timestamp()`,
        [lease.id, lease.leaseOwner, lease.leaseToken, retry ? 'queued' : 'failed', code])
        if (updated.rowCount !== 1) fail('LEASE_LOST', 'Publication failure could not be committed by an expired worker')
        await tx.query(`UPDATE job_attempts SET outcome='failed',error_code=$3,finished_at=clock_timestamp() WHERE job_id=$1 AND attempt=$2`, [lease.id, lease.attempt, code])
        return { jobId: lease.id, ...(releaseId ? { releaseId } : {}), status: retry ? 'retrying' : 'failed', errorCode: code }
      })
    } catch (failure) {
      if ((failure as { code?: string }).code === 'LEASE_LOST') return { jobId: lease.id, ...(releaseId ? { releaseId } : {}), status: 'lease_lost', errorCode: 'LEASE_LOST' }
      throw failure
    }
  }
  async function reconcileExhausted(): Promise<void> {
    await database.transaction(async tx => {
      const rows = (await tx.query<{ id: string; job_id: string }>(`SELECT r.id,j.id AS job_id FROM releases r JOIN jobs j
        ON j.payload->>'releaseId'=r.id AND j.payload->>'snapshotId'=r.snapshot_id
        WHERE j.kind='publish_release' AND j.status='failed' AND r.status='publishing'
        AND NOT EXISTS (SELECT 1 FROM jobs other WHERE other.kind='publish_release' AND other.payload->>'releaseId'=r.id
          AND other.status IN ('queued','running','succeeded')) ORDER BY r.id FOR UPDATE OF r SKIP LOCKED LIMIT 20`)).rows
      for (const row of rows) {
        const changed = await tx.query(`UPDATE releases SET status='publish_failed',error_code='PUBLISH_JOB_EXHAUSTED',state_version=state_version+1 WHERE id=$1 AND status='publishing'`, [row.id])
        if (changed.rowCount) await tx.query(`INSERT INTO audit_events(actor_kind,actor_id,action,object_kind,object_id,outcome,details)
          VALUES ('system',$1,'release.publish_failed','release',$2,'failed',$3::jsonb)`, [options.workerId, row.id, canonicalJson({ jobId: row.job_id, errorCode: 'PUBLISH_JOB_EXHAUSTED' })])
      }
    })
  }

  return {
    async runOnce(): Promise<PublisherResult> {
      const lease = await database.claimJob(options.workerId, { kinds: ['publish_release'], leaseMs })
      await reconcileExhausted()
      if (!lease) return { status: 'idle' }
      let renewal: Promise<void> | undefined, leaseLost = false, releaseId: string | undefined
      const timer = setInterval(() => {
        if (renewal) return
        renewal = database.renewJob(lease, leaseMs).then(() => {}, () => { leaseLost = true }).finally(() => { renewal = undefined })
      }, Math.max(15, Math.floor(leaseMs / 3)))
      timer.unref()
      const current = () => { if (leaseLost) fail('LEASE_LOST', 'Publisher lease could not be renewed') }
      try {
        if (!safeId(lease.payload.releaseId) || !safeId(lease.payload.snapshotId) || Object.keys(lease.payload).length !== 2) fail('PUBLISH_JOB_INVALID', 'Publication job requires fixed release and snapshot identifiers')
        const value = await bundle(lease.payload.releaseId, lease.payload.snapshotId)
        releaseId = value.release.id
        const manifest = manifestFor(value)
        if (value.release.signed_manifest) existingSignature(value.release.signed_manifest, manifest)
        await verifySnapshot(value, manifest)
        current()
        const signed = await freeze(lease, value, manifest)
        await options.fault?.('after-freeze'); current()
        const stored = await store.putJson(signed, { maxBytes: 1024 * 1024 })
        if (stored.sha256 !== sha256(canonicalBytes(signed))) fail('PUBLISH_MANIFEST_STORAGE', 'Stored manifest hash differs from the frozen signature')
        await store.verify(stored.key, { maxBytes: 1024 * 1024 })
        await options.fault?.('after-manifest-store'); current()
        const result = await database.withJobTransaction(lease, async tx => {
          const row = (await tx.query<ReleaseRow & QueryResultRow>('SELECT * FROM releases WHERE id=$1 FOR UPDATE', [releaseId])).rows[0]!
          if (!row.signed_manifest || !same(row.signed_manifest, signed)) fail('PUBLISH_IMMUTABLE_CONFLICT', 'Release signature changed')
          if (!['publishing', 'published', 'yanked'].includes(row.status)) fail('PUBLISH_STATE', 'Release state no longer permits publication')
          if (row.status === 'publishing') {
            await verifyDependencies(tx, manifest)
            await tx.query(`UPDATE releases SET status='published',published_at=clock_timestamp(),state_version=state_version+1,error_code=NULL WHERE id=$1`, [releaseId])
            await tx.query(`INSERT INTO audit_events(actor_kind,actor_id,organization_id,action,object_kind,object_id,outcome,details)
              VALUES ('system',$1,$2,'release.published','release',$3,'succeeded',$4::jsonb)`, [options.workerId, manifest.ownerOrgId, releaseId,
              canonicalJson({ jobId: lease.id, snapshotId: value.snapshot.id, manifestKey: stored.key, manifestSha256: stored.sha256,
                artifactSha256: manifest.artifactSha256, contentTreeSha256: manifest.contentTreeSha256, signingKeyId: manifest.signingKeyId })])
          }
          await options.fault?.('before-commit'); current()
          return { jobId: lease.id, releaseId: value.release.id, status: row.status === 'yanked' ? 'yanked' as const : 'published' as const, manifestKey: stored.key }
        })
        return result
      } catch (error) { return await recordFailure(lease, releaseId, error) }
      finally { clearInterval(timer); await renewal }
    },
  }
}
