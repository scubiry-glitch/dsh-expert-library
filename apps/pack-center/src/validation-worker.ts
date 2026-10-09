/** Durable validation worker: Git never runs in a request/review/publish transaction. */
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { PoolClient } from 'pg'
import { assertContract, canonicalJson, canonicalBytes, sha256, compareSemVer, parseSemVer,
  type ValidationReport, type VersionInterval, type DependencyLock, type BuiltinDependency, type DistributionScope,
  type ReleaseManifest } from '../../../packages/pack-contract/index.mjs'
import type { CenterDatabase, JobLease } from './database.js'
import type { LocalArtifactStore } from './storage.js'
import type { SubmissionRow } from './submissions.js'
import { fetchGitSnapshot, type GitSnapshot, type SnapshotPreview } from './git-snapshot.js'

export interface SnapshotDelivery {
  requiresPlugin: VersionInterval
  dependencyLock: DependencyLock[]
  builtinDependencies: BuiltinDependency[]
}
export interface ValidationWorkerOptions {
  database: CenterDatabase
  store: Pick<LocalArtifactStore, 'putFile' | 'putJson'>
  fetchSnapshot?: typeof fetchGitSnapshot
  allowedGitHosts: readonly string[]
  scratchRoot: string
  validatorVersion: string
  workerId: string
  leaseMs?: number
  /** Authoritative shipped-builtin inventory, independent of developer submissions. */
  builtinPackVersions?: Readonly<Record<string, string>>
}
class WorkerError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ValidationWorkerError' }
}
function fail(code: string, message: string): never { throw new WorkerError(code, message) }
function interval(value: VersionInterval) {
  if (!value || Object.keys(value).some(key => !['minVersion', 'maxVersionExclusive'].includes(key))) fail('COMPATIBILITY_INVALID', 'Invalid plugin or built-in version interval')
  parseSemVer(value.minVersion)
  if (value.maxVersionExclusive !== undefined && compareSemVer(value.minVersion, value.maxVersionExclusive) >= 0) fail('COMPATIBILITY_INVALID', 'Compatibility interval must be nonempty')
}
function safeError(error: unknown) {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : ''
  return { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'VALIDATION_FAILED', message: 'Validation attempt could not complete; retry or ask an administrator to inspect the task code' }
}
async function lockedLease(tx: PoolClient, lease: JobLease) {
  const valid = await tx.query(`SELECT 1 FROM jobs WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_token=$3::uuid
    AND lease_expires_at>clock_timestamp() FOR UPDATE`, [lease.id, lease.leaseOwner, lease.leaseToken])
  if (!valid.rowCount) fail('LEASE_LOST', 'Validation worker no longer owns its lease')
}
async function audit(tx: PoolClient, worker: string, submission: SubmissionRow, action: string, outcome: 'succeeded' | 'failed', details: object) {
  await tx.query(`INSERT INTO audit_events(actor_kind,actor_id,organization_id,action,object_kind,object_id,outcome,details)
    VALUES ('system',$1,$2,$3,'submission',$4,$5,$6::jsonb)`, [worker, submission.owner_org_id, action, submission.id, outcome, canonicalJson(details)])
}

interface ReleaseRow { id: string; pack_id: string; owner_org_id: string; version: string; signed_manifest: { manifest: unknown }; scope: DistributionScope }
function lockOf(manifest: ReleaseManifest): DependencyLock {
  return { packId: manifest.packId, ownerOrgId: manifest.ownerOrgId, releaseId: manifest.releaseId, version: manifest.version,
    artifactSha256: manifest.artifactSha256, contentTreeSha256: manifest.contentTreeSha256 }
}
/** Compare exact recipient sets; selected never implicitly includes the owner organization. */
async function scopeSubset(tx: PoolClient, child: DistributionScope, childOwner: string, parent: DistributionScope, parentOwner: string): Promise<boolean> {
  assertContract('scope', child); assertContract('scope', parent)
  if (parent.kind === 'authenticated') return true
  if (child.kind === 'authenticated') return false
  const childOrgs = child.kind === 'organization' ? [childOwner] : child.organizationIds
  const parentOrgs = parent.kind === 'organization' ? [parentOwner] : parent.organizationIds
  if (childOrgs.some(org => !parentOrgs.includes(org))) return false
  const deployments = child.kind === 'selected' ? child.deploymentIds : []
  const allowedDeployments = parent.kind === 'selected' ? parent.deploymentIds : []
  for (const deploymentId of deployments) {
    if (allowedDeployments.includes(deploymentId)) continue
    const deployment = (await tx.query<{ organization_id: string }>('SELECT organization_id FROM deployments WHERE id=$1 AND status=\'active\' FOR SHARE', [deploymentId])).rows[0]
    if (!deployment || !parentOrgs.includes(deployment.organization_id)) return false
  }
  return true
}

async function frozenDelivery(tx: PoolClient, submission: SubmissionRow, dependsOn: readonly string[], builtins: Readonly<Record<string, string>>): Promise<SnapshotDelivery> {
  interval(submission.requires_plugin)
  const builtinDependencies = submission.builtin_dependencies
  const wanted = new Set(dependsOn)
  if (wanted.size !== dependsOn.length || wanted.has(submission.pack_id)) fail('DEPENDENCY_CYCLE', 'Package dependency list contains duplicates or itself')
  function checkBuiltin(dependency: BuiltinDependency) {
    const { packId, ...requirement } = dependency
    interval(requirement)
    const version = Object.hasOwn(builtins, packId) ? builtins[packId] : undefined
    if (!version || compareSemVer(version, requirement.minVersion) < 0
      || (requirement.maxVersionExclusive !== undefined && compareSemVer(version, requirement.maxVersionExclusive) >= 0)) {
      fail('BUILTIN_DEPENDENCY_UNAVAILABLE', 'Built-in dependency is not in the configured shipped inventory or is incompatible')
    }
    if (packId === submission.pack_id) fail('DEPENDENCY_CONFLICT', 'Built-in dependency conflicts with the submitted package')
  }
  const dependencyLock: DependencyLock[] = []
  for (const releaseId of submission.dependency_release_ids) {
    const row = (await tx.query<{ signed_manifest: { manifest: unknown } }>('SELECT signed_manifest FROM releases WHERE id=$1 AND status=\'published\' FOR SHARE', [releaseId])).rows[0]
    if (!row) fail('DEPENDENCY_UNAVAILABLE', 'A fixed dependency is not currently published')
    dependencyLock.push(lockOf(assertContract('release', row.signed_manifest?.manifest)))
  }
  await validateFrozenDependencies(tx, { ownerOrgId: submission.owner_org_id, packId: submission.pack_id, distribution: submission.distribution,
    dependencyLock, builtinDependencies, checkBuiltin })
  for (const dependency of builtinDependencies) checkBuiltin(dependency)
  const declared = [...dependencyLock.map(value => value.packId), ...builtinDependencies.map(value => value.packId)]
  if (new Set(declared).size !== declared.length || declared.length !== wanted.size || declared.some(value => !wanted.has(value))) {
    fail('DEPENDENCY_DECLARATION_MISMATCH', 'Every pack.dependsOn entry must match exactly one fixed release or known built-in dependency')
  }
  return JSON.parse(canonicalJson({ requiresPlugin: submission.requires_plugin, dependencyLock, builtinDependencies })) as SnapshotDelivery
}

/** Recheck an already-frozen graph; never resolves a floating or replacement release. */
export async function validateFrozenDependencies(tx: PoolClient, input: {
  ownerOrgId: string; packId: string; distribution: DistributionScope; dependencyLock: readonly DependencyLock[]
  builtinDependencies?: readonly BuiltinDependency[]; checkBuiltin?: (dependency: BuiltinDependency) => void
}): Promise<void> {
  const seenPacks = new Map<string, string>(), visiting = new Set<string>(), visited = new Set<string>(), builtinIds = new Set<string>()
  function builtin(dependency: BuiltinDependency) { builtinIds.add(dependency.packId); input.checkBuiltin?.(dependency) }
  for (const dependency of input.builtinDependencies ?? []) builtin(dependency)
  async function visit(expected: DependencyLock): Promise<void> {
    if (visiting.size > 100 || seenPacks.size >= 1000) fail('DEPENDENCY_GRAPH_LIMIT', 'Dependency graph exceeds reviewable limits')
    const row = (await tx.query<ReleaseRow>(`SELECT r.id,r.pack_id,r.owner_org_id,r.version,r.signed_manifest,d.scope
      FROM releases r JOIN release_distribution d ON d.release_id=r.id JOIN organizations o ON o.id=r.owner_org_id
      WHERE r.id=$1 AND r.status='published' AND o.status='active' FOR SHARE OF r,d,o`, [expected.releaseId])).rows[0]
    if (!row) fail('DEPENDENCY_UNAVAILABLE', 'A fixed dependency is not currently published')
    const manifest = assertContract('release', row.signed_manifest?.manifest)
    if (manifest.releaseId !== row.id || manifest.packId !== row.pack_id || manifest.ownerOrgId !== row.owner_org_id || manifest.version !== row.version
      || canonicalJson(expected) !== canonicalJson(lockOf(manifest))) fail('DEPENDENCY_INTEGRITY', 'Dependency differs from the approved identity or fixed lock')
    if (row.pack_id === input.packId || visiting.has(row.id)) fail('DEPENDENCY_CYCLE', 'Dependency graph contains a cycle')
    const existing = seenPacks.get(row.pack_id)
    if (existing && existing !== row.id) fail('DEPENDENCY_CONFLICT', 'Dependency graph requires multiple releases of one package')
    seenPacks.set(row.pack_id, row.id)
    if (!await scopeSubset(tx, { kind: 'organization' }, input.ownerOrgId, row.scope, row.owner_org_id)
      || !await scopeSubset(tx, input.distribution, input.ownerOrgId, row.scope, row.owner_org_id)) {
      fail('DEPENDENCY_FORBIDDEN', 'Dependency is not available to the author organization and every proposed recipient')
    }
    if (visited.has(row.id)) return
    visiting.add(row.id)
    for (const dependency of manifest.dependencyLock) await visit(dependency)
    for (const dependency of manifest.builtinDependencies) builtin(dependency)
    visiting.delete(row.id); visited.add(row.id)
  }
  for (const dependency of input.dependencyLock) await visit(dependency)
  if ([...builtinIds].some(packId => packId === input.packId || seenPacks.has(packId))) fail('DEPENDENCY_CONFLICT', 'Built-in dependency conflicts with a center package')
}

function diffOf(current: GitSnapshot, previous?: { release_id: string; snapshot_id: string; preview: SnapshotPreview; report: ValidationReport }) {
  const beforeFiles = Array.isArray(previous?.preview.files) ? previous.preview.files : []
  const before = new Map(beforeFiles.map(file => [file.path, file.sha256]))
  const after = new Map(current.preview.files.map(file => [file.path, file.sha256]))
  const entities: Record<string, { added: string[]; removed: string[]; changed: string[]; unverifiedPrevious: string[] }> = {}
  const rawEntities = previous?.preview.entities
  const oldEntities = rawEntities && typeof rawEntities === 'object' && !Array.isArray(rawEntities) ? rawEntities : {}
  for (const key of new Set([...Object.keys(oldEntities), ...Object.keys(current.preview.entities)])) {
    const candidate = oldEntities[key]
    const knownPrevious = !previous || (Array.isArray(candidate) && candidate.every(id => typeof id === 'string'))
    const oldIds = knownPrevious && candidate ? candidate : [], newIds = current.preview.entities[key] ?? []
    const shared = newIds.filter(id => oldIds.includes(id))
    const oldDigest = (id: string): string | undefined => {
      const value = previous?.preview.entityDigests?.[key]?.[id]
      return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined
    }
    entities[key] = { added: knownPrevious ? newIds.filter(id => !oldIds.includes(id)) : [], removed: oldIds.filter(id => !newIds.includes(id)),
      changed: shared.filter(id => oldDigest(id) !== undefined && oldDigest(id) !== current.preview.entityDigests?.[key]?.[id]),
      unverifiedPrevious: knownPrevious ? shared.filter(id => oldDigest(id) === undefined) : [...newIds] }
  }
  return {
    baseline: previous ? { releaseId: previous.release_id, snapshotId: previous.snapshot_id } : null,
    files: { added: [...after.keys()].filter(path => !before.has(path)), removed: [...before.keys()].filter(path => !after.has(path)),
      changed: [...after.keys()].filter(path => before.has(path) && before.get(path) !== after.get(path)) },
    entities, permissions: { before: previous?.report.permissions ?? { execScripts: [], internalOnly: false }, after: current.report.permissions ?? { execScripts: [], internalOnly: false } },
  }
}

export function createValidationWorker(options: ValidationWorkerOptions) {
  const { database, store } = options, fetchSnapshot = options.fetchSnapshot ?? fetchGitSnapshot
  const leaseMs = options.leaseMs ?? 30000
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.workerId) || options.workerId.includes('..')) fail('WORKER_CONFIG', 'Worker identity must be a safe identifier')
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 50 || leaseMs > 3600000) fail('WORKER_CONFIG', 'Worker lease is invalid')
  parseSemVer(options.validatorVersion)
  const builtins = Object.freeze({ ...options.builtinPackVersions })

  async function reconcile() {
    // failJob and claimJob own queue transitions. A later process reconciles any
    // crash between their commit and this business-state repair, using no stale lease.
    await database.transaction(async tx => {
      await tx.query(`UPDATE validation_attempts v SET status='failed',error_code=coalesce(a.error_code,'LEASE_EXPIRED'),
        error_message='Validation worker attempt did not complete',finished_at=coalesce(a.finished_at,clock_timestamp())
        FROM jobs j JOIN job_attempts a ON a.job_id=j.id
        WHERE j.kind='validate_submission' AND j.payload->>'submissionId'=v.submission_id AND a.attempt=v.attempt
          AND a.outcome IN ('failed','lease_expired') AND v.status='running'`)
      const failed = (await tx.query<{ id: string; payload: { submissionId: string }; error_code: string }>(`SELECT j.id,j.payload,j.error_code FROM jobs j
        JOIN submissions s ON s.id=j.payload->>'submissionId' WHERE j.kind='validate_submission' AND j.status='failed'
          AND s.status='validating' ORDER BY j.id FOR UPDATE OF j SKIP LOCKED LIMIT 100`)).rows
      for (const job of failed) {
        const row = (await tx.query<SubmissionRow>(`UPDATE submissions SET status='validation_failed',state_version=state_version+1,updated_at=clock_timestamp()
          WHERE id=$1 AND status='validating' RETURNING *`, [job.payload.submissionId])).rows[0]
        if (row) await audit(tx, options.workerId, row, 'submission.validation_failed', 'failed', { jobId: job.id, errorCode: job.error_code })
      }
    })
  }

  return {
    reconcile,
    async runOnce(): Promise<{ worked: boolean; jobId?: string; status: string; errorCode?: string; snapshotId?: string }> {
      const lease = await database.claimJob(options.workerId, { kinds: ['validate_submission'], leaseMs })
      await reconcile()
      if (!lease) return { worked: false, status: 'idle' }
      const controller = new AbortController()
      let heartbeat: Promise<void> | undefined, leaseLost = false, snapshot: GitSnapshot | undefined
      const timer = setInterval(() => {
        if (heartbeat) return
        heartbeat = database.renewJob(lease, leaseMs).then(() => {}, () => { leaseLost = true; controller.abort() }).finally(() => { heartbeat = undefined })
      }, Math.max(10, Math.floor(leaseMs / 3)))
      timer.unref()
      async function stopHeartbeat() { clearInterval(timer); await heartbeat }
      try {
        const submission = await database.transaction(async tx => {
          await lockedLease(tx, lease)
          const row = (await tx.query<SubmissionRow>('SELECT * FROM submissions WHERE id=$1 FOR UPDATE', [lease.payload.submissionId])).rows[0]
          if (!row || row.status !== 'validating' || row.snapshot_id) fail('SUBMISSION_STATE', 'Validation job is not attached to a validating submission')
          await tx.query(`INSERT INTO validation_attempts(id,submission_id,attempt,status) VALUES ($1,$2,$3,'running')`, [randomUUID(), row.id, lease.attempt])
          return row
        })
        snapshot = await fetchSnapshot({ url: submission.source_url, ref: submission.source_ref, outputParent: options.scratchRoot,
          allowedHosts: options.allowedGitHosts, validatorVersion: options.validatorVersion, signal: controller.signal })
        if (leaseLost) fail('LEASE_LOST', 'Validation worker lost its lease')
        assertContract('report', snapshot.report)
        if (sha256(canonicalBytes(snapshot.report)) !== snapshot.reportSha256 || snapshot.report.validatorVersion !== options.validatorVersion) fail('REPORT_INTEGRITY', 'Validation report does not match its content digest')
        const report = JSON.parse(canonicalJson(snapshot.report)) as ValidationReport
        const addError = (code: string, message: string) => { report.valid = false; report.diagnostics.push({ severity: 'error', code, message }) }
        if (snapshot.packMeta?.id !== submission.pack_id || snapshot.packMeta?.version !== submission.version) addError('package-identity-mismatch', 'Fetched package identity or version does not match this submission')
        let delivery: SnapshotDelivery | undefined
        const previous = await database.transaction(async tx => {
          if (report.valid) {
            try { delivery = await frozenDelivery(tx, submission, snapshot!.packMeta?.dependsOn ?? [], builtins) }
            catch (error) { const safe = safeError(error); addError(safe.code, error instanceof WorkerError ? error.message : 'Dependency or compatibility metadata was invalid') }
          }
          return (await tx.query<{ release_id: string; snapshot_id: string; preview: SnapshotPreview; report: ValidationReport }>(`SELECT r.id AS release_id,s.id AS snapshot_id,s.preview,s.report
            FROM releases r JOIN submission_snapshots s ON s.id=r.snapshot_id WHERE r.pack_id=$1 AND r.status IN ('published','yanked')
            ORDER BY r.published_at DESC,r.id DESC LIMIT 1`, [submission.pack_id])).rows[0]
        })
        if (delivery?.builtinDependencies.length) report.diagnostics.push({ severity: 'warning', code: 'builtin-target-check-required',
          message: 'Built-in dependencies were checked against the configured trusted inventory; each deployment must still verify its actual plugin and built-in versions before activation' })
        assertContract('report', report)
        const artifact = await store.putFile(snapshot.archiveFile, snapshot.artifact.artifactSha256, { maxBytes: snapshot.artifact.sizeBytes })
        if (artifact.sizeBytes !== snapshot.artifact.sizeBytes) fail('ARTIFACT_INTEGRITY', 'Stored archive length differs from snapshot')
        const storedReport = await store.putJson(report)
        if (storedReport.sha256 !== sha256(canonicalBytes(report))) fail('REPORT_INTEGRITY', 'Stored report differs from validated report')
        const preview = { ...snapshot.preview, ...(snapshot.packMeta ? { packMeta: snapshot.packMeta } : {}), ...(delivery ? { delivery } : {}) }
        const diff = diffOf({ ...snapshot, report }, previous)
        await stopHeartbeat()
        if (leaseLost) fail('LEASE_LOST', 'Validation worker lost its lease')
        return await database.withJobTransaction(lease, async tx => {
          const row = (await tx.query<SubmissionRow>('SELECT * FROM submissions WHERE id=$1 FOR UPDATE', [submission.id])).rows[0]
          if (!row || row.status !== 'validating' || row.state_version !== submission.state_version || row.snapshot_id) fail('SUBMISSION_STATE', 'Submission changed during validation')
          if (delivery && canonicalJson(await frozenDelivery(tx, row, snapshot!.packMeta?.dependsOn ?? [], builtins)) !== canonicalJson(delivery)) fail('DEPENDENCY_CHANGED', 'Dependencies changed during validation; create a new attempt')
          const snapshotId = randomUUID()
          await tx.query(`INSERT INTO submission_snapshots(id,submission_id,source_commit,artifact_sha256,content_tree_sha256,report_sha256,artifact_key,report_key,
            validator_version,normalization_version,pack_schema_version,size_bytes,file_count,report,preview,diff)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,2,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb)`,
          [snapshotId, row.id, snapshot!.sourceCommit, artifact.sha256, snapshot!.artifact.contentTreeSha256, storedReport.sha256,
            artifact.key, storedReport.key, options.validatorVersion, artifact.sizeBytes, snapshot!.artifact.fileCount,
            canonicalJson(report), canonicalJson(preview), canonicalJson(diff)])
          await tx.query(`UPDATE submissions SET status=$2,snapshot_id=$3,state_version=state_version+1,updated_at=clock_timestamp() WHERE id=$1`,
            [row.id, report.valid ? 'validated' : 'validation_failed', snapshotId])
          await tx.query(`UPDATE validation_attempts SET status=$3,snapshot_id=$4,error_code=$5,finished_at=clock_timestamp() WHERE submission_id=$1 AND attempt=$2 AND status='running'`,
            [row.id, lease.attempt, report.valid ? 'succeeded' : 'failed', snapshotId, report.valid ? null : 'VALIDATION_INVALID'])
          await audit(tx, options.workerId, row, report.valid ? 'submission.validated' : 'submission.validation_failed', report.valid ? 'succeeded' : 'failed',
            { jobId: lease.id, snapshotId, sourceCommit: snapshot!.sourceCommit, contentTreeSha256: snapshot!.artifact.contentTreeSha256 })
          return { worked: true, jobId: lease.id, status: report.valid ? 'validated' : 'validation_failed', snapshotId }
        })
      } catch (error) {
        await stopHeartbeat()
        const safe = safeError(error)
        if (leaseLost || safe.code === 'LEASE_LOST') return { worked: true, jobId: lease.id, status: 'lease_lost', errorCode: 'LEASE_LOST' }
        try {
          const retry = /^(?:GIT_FETCH_FAILED|GIT_DNS_FAILED|GIT_TIMEOUT|STORAGE_|VALIDATION_FAILED|DEPENDENCY_CHANGED)/.test(safe.code)
          const failed = await database.failJob(lease, safe, { retry, delayMs: 1000 })
          await reconcile()
          return { worked: true, jobId: lease.id, status: failed.status === 'queued' ? 'retry_queued' : 'validation_failed', errorCode: safe.code }
        } catch (failure) {
          if ((failure as { code?: string }).code === 'LEASE_LOST') return { worked: true, jobId: lease.id, status: 'lease_lost', errorCode: 'LEASE_LOST' }
          throw failure
        }
      } finally {
        await stopHeartbeat()
        // Only the exact owned snapshot result is removed; CAS objects are retained.
        if (snapshot && dirname(resolve(snapshot.snapshotDir)) === resolve(options.scratchRoot)
          && /^snapshot-[A-Za-z0-9]+$/.test(basename(snapshot.snapshotDir))) await rm(snapshot.snapshotDir, { recursive: true, force: true })
      }
    },
  }
}
