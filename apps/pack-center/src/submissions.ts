/** Business transactions for fixed-content submissions. No Git or signing keys here. */
import { randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import {
  assertContract, canonicalJson, compareSemVer, parseSemVer, sha256,
  type BuiltinDependency, type DistributionScope, type VersionInterval,
} from '../../../packages/pack-contract/index.mjs'
import { enqueueJob, type CenterDatabase } from './database.js'
import { IdentityError, type HumanPrincipal, type createIdentityService } from './auth.js'

type IdentityPort = Pick<ReturnType<typeof createIdentityService>, 'requireOrgRole' | 'requireReviewAccess' | 'requirePackRole' | 'requireSession'>
export class SubmissionError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message); this.name = 'SubmissionError'
  }
}
export interface SubmissionInput {
  organizationId: string
  packId: string
  name: string
  version: string
  source: { url: string; ref: string }
  notes?: string
  license?: string
  distribution: DistributionScope
  previousSubmissionId?: string
  requiresPlugin?: VersionInterval
  dependencyReleaseIds?: string[]
  builtinDependencies?: BuiltinDependency[]
}
export interface SubmissionRow extends QueryResultRow {
  id: string; owner_org_id: string; pack_id: string; author_id: string; version: string
  source_url: string; source_ref: string; notes: string; license: string; distribution: DistributionScope
  status: string; state_version: number; snapshot_id: string | null; previous_submission_id: string | null
  requires_plugin: VersionInterval; dependency_release_ids: string[]; builtin_dependencies: BuiltinDependency[]
  created_at: Date; updated_at: Date
}
interface SnapshotRow extends QueryResultRow {
  id: string; submission_id: string; source_commit: string; artifact_sha256: string; content_tree_sha256: string
  report_sha256: string; artifact_key: string; report_key: string; validator_version: string
  normalization_version: number; pack_schema_version: number; size_bytes: string; file_count: number
  report: unknown; preview: unknown; diff: unknown
}
// Publication protocol identifiers are at most 64 characters, even though the
// storage domain is wider. Reject impossible-to-publish identities at the edge.
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const submissionStatuses = new Set(['draft', 'validating', 'validated', 'validation_failed', 'pending_review', 'approved', 'changes_requested', 'rejected', 'withdrawn'])
function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !safeId.test(value) || value.includes('..') || ['__proto__', 'constructor', 'prototype'].includes(value)) {
    throw new SubmissionError('INVALID_INPUT', `${label} is invalid`)
  }
}
function text(value: unknown, label: string, maximum: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > maximum || value.includes('\0')) {
    throw new SubmissionError('INVALID_INPUT', `${label} is invalid`)
  }
}
function versionInterval(value: VersionInterval): void {
  if (!value || Object.keys(value).some(key => !['minVersion', 'maxVersionExclusive'].includes(key))) throw new SubmissionError('INVALID_INPUT', 'Invalid plugin compatibility interval')
  parseSemVer(value.minVersion)
  if (value.maxVersionExclusive !== undefined && compareSemVer(value.minVersion, value.maxVersionExclusive) >= 0) {
    throw new SubmissionError('INVALID_INPUT', 'Plugin compatibility interval is empty')
  }
}
function expectedVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new SubmissionError('INVALID_INPUT', 'expectedVersion must be a positive integer')
}
function human(actor: HumanPrincipal): void {
  if (!actor || actor.kind !== 'human') throw new SubmissionError('HUMAN_REQUIRED', 'This action requires a human session', 403)
  id(actor.userId, 'userId')
}
function view(row: SubmissionRow) {
  return {
    id: row.id, ownerOrgId: row.owner_org_id, packId: row.pack_id, authorId: row.author_id, version: row.version,
    source: { url: row.source_url, ref: row.source_ref }, notes: row.notes, license: row.license,
    distribution: row.distribution, status: row.status, stateVersion: row.state_version,
    snapshotId: row.snapshot_id, previousSubmissionId: row.previous_submission_id,
    requiresPlugin: row.requires_plugin, dependencyReleaseIds: row.dependency_release_ids, builtinDependencies: row.builtin_dependencies,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  }
}
export async function submissionAudit(tx: PoolClient, actor: HumanPrincipal, row: SubmissionRow, action: string, details: object = {}) {
  await tx.query(`INSERT INTO audit_events(actor_kind,actor_id,organization_id,action,object_kind,object_id,outcome,details)
    VALUES ('human',$1,$2,$3,'submission',$4,'succeeded',$5::jsonb)`,
  [actor.userId, row.owner_org_id, action, row.id, canonicalJson(details)])
}

export function createSubmissionService(database: CenterDatabase, identity: IdentityPort, options: { allowedGitHosts: readonly string[]; scratchRoot: string }) {
  const allowedHosts = new Set(options.allowedGitHosts.map(host => host.toLowerCase()))
  function normalizeInput(input: SubmissionInput): Required<Omit<SubmissionInput, 'previousSubmissionId'>> & { previousSubmissionId: string | null } {
    // JSON roundtrip detaches all input before asynchronous authorization/SQL.
    const value = JSON.parse(canonicalJson(input)) as SubmissionInput
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['organizationId', 'packId', 'name', 'version', 'source', 'notes', 'license', 'distribution', 'previousSubmissionId', 'requiresPlugin', 'dependencyReleaseIds', 'builtinDependencies'].includes(key))) {
      throw new SubmissionError('INVALID_INPUT', 'Unknown submission field')
    }
    id(value.organizationId, 'organizationId'); id(value.packId, 'packId'); text(value.name, 'name', 200)
    parseSemVer(value.version)
    assertContract('scope', value.distribution)
    if (!value.source || Object.keys(value.source).some(key => !['url', 'ref'].includes(key))) throw new SubmissionError('INVALID_SOURCE', 'A Git HTTPS URL and ref are required')
    text(value.source.url, 'source.url', 2048); text(value.source.ref, 'source.ref', 256)
    let url: URL
    try { url = new URL(value.source.url) } catch { throw new SubmissionError('INVALID_SOURCE', 'Git URL is invalid') }
    // Test-only fixture allowance mirrors validateGitSource: one exact
    // "hostname:port" loopback origin exported through
    // PACK_CENTER_GIT_ALLOW_LOOPBACK_FIXTURE is admitted with its explicit
    // port. Unset (production default) requires port 443.
    const fixturePair = process.env.PACK_CENTER_GIT_ALLOW_LOOPBACK_FIXTURE
    const fixtureOrigin = fixturePair === undefined || !fixturePair.includes(':') ? null
      : { hostname: fixturePair.slice(0, fixturePair.lastIndexOf(':')).toLowerCase(), port: fixturePair.slice(fixturePair.lastIndexOf(':') + 1) }
    const fixtureMatch = fixtureOrigin !== null && url.hostname.toLowerCase() === fixtureOrigin.hostname && url.port === fixtureOrigin.port
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || (url.port !== '' && !fixtureMatch) || !allowedHosts.has(url.hostname.toLowerCase())) {
      throw new SubmissionError('SOURCE_NOT_ALLOWED', 'Only configured public HTTPS Git hosts without credentials, query, or custom ports are accepted')
    }
    if (value.source.ref.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(value.source.ref)) throw new SubmissionError('INVALID_SOURCE', 'Git ref is invalid')
    value.source.url = url.href
    const notes = value.notes ?? ''; const license = value.license ?? ''
    text(notes, 'notes', 20000, true); text(license, 'license', 1000, true)
    const requiresPlugin = value.requiresPlugin ?? { minVersion: '0.1.0' }
    versionInterval(requiresPlugin)
    const dependencyReleaseIds = value.dependencyReleaseIds ?? []
    if (!Array.isArray(dependencyReleaseIds) || dependencyReleaseIds.length > 100 || new Set(dependencyReleaseIds).size !== dependencyReleaseIds.length) throw new SubmissionError('INVALID_INPUT', 'Invalid fixed dependency list')
    for (const releaseId of dependencyReleaseIds) id(releaseId, 'dependencyReleaseId')
    const builtinDependencies = value.builtinDependencies ?? []
    if (!Array.isArray(builtinDependencies) || builtinDependencies.length > 100 || builtinDependencies.some(item => !item || typeof item !== 'object' || Array.isArray(item))
      || new Set(builtinDependencies.map(item => item.packId)).size !== builtinDependencies.length) throw new SubmissionError('INVALID_INPUT', 'Invalid built-in dependency list')
    for (const dependency of builtinDependencies) {
      id(dependency.packId, 'builtinDependency.packId')
      const { packId: _, ...interval } = dependency
      versionInterval(interval)
    }
    if (value.previousSubmissionId !== undefined) id(value.previousSubmissionId, 'previousSubmissionId')
    return { ...value, notes, license, requiresPlugin, dependencyReleaseIds, builtinDependencies, previousSubmissionId: value.previousSubmissionId ?? null }
  }
  async function rowFor(tx: PoolClient, submissionId: string, lock = false): Promise<SubmissionRow> {
    id(submissionId, 'submissionId')
    const row = (await tx.query<SubmissionRow>(`SELECT * FROM submissions WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [submissionId])).rows[0]
    if (!row) throw new SubmissionError('NOT_FOUND', 'Submission not found', 404)
    return row
  }
  // Creation axis: editing authority follows pack_ownerships, not tenant
  // membership. Organization admin no longer implies write access to a pack.
  async function authorAccess(tx: PoolClient, actor: HumanPrincipal, row: SubmissionRow) {
    human(actor)
    await identity.requirePackRole(actor, row.pack_id, ['owner', 'maintainer'], tx)
  }
  async function readAccess(tx: PoolClient, actor: HumanPrincipal, row: SubmissionRow) {
    human(actor)
    // The author fast path still refreshes the session: a disabled account or
    // revoked session must never read, even its own submissions.
    if (row.author_id === actor.userId) return identity.requireSession(actor, tx)
    try { await identity.requirePackRole(actor, row.pack_id, ['owner', 'maintainer'], tx); return } catch (error) {
      if (!(error instanceof IdentityError) || error.code !== 'FORBIDDEN') throw error
    }
    try { await identity.requireReviewAccess(actor, row.owner_org_id, row.author_id, tx) } catch (error) {
      if (!(error instanceof IdentityError) || !['FORBIDDEN', 'SELF_REVIEW_DENIED'].includes(error.code)) throw error
      throw new SubmissionError('NOT_FOUND', 'Submission not found', 404)
    }
  }
  async function lockOperation(tx: PoolClient, actor: HumanPrincipal, operationKey: string) {
    human(actor)
    text(operationKey, 'idempotencyKey', 200)
    // Shared actor/key namespace with release governance: take this before any
    // business row locks, including failed-publication retries on a release.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [`human:${actor.userId}`, operationKey])
  }
  async function idempotent<T>(tx: PoolClient, actor: HumanPrincipal, operationKey: string, request: object, action: () => Promise<T>): Promise<T> {
    // Live authorization has already been checked, after lockOperation.
    const principalKey = `human:${actor.userId}`
    const fingerprint = sha256(canonicalJson(request))
    const existing = (await tx.query<{ request_sha256: string; result: T }>('SELECT request_sha256,result FROM request_idempotency WHERE principal_key=$1 AND operation_key=$2', [principalKey, operationKey])).rows[0]
    if (existing) {
      if (existing.request_sha256 !== fingerprint) throw new SubmissionError('IDEMPOTENCY_CONFLICT', 'Idempotency key identifies another request', 409)
      return existing.result
    }
    const result = await action()
    await tx.query('INSERT INTO request_idempotency(principal_key,operation_key,request_sha256,result) VALUES ($1,$2,$3,$4::jsonb)', [principalKey, operationKey, fingerprint, canonicalJson(result)])
    return result
  }
  function requireState(row: SubmissionRow, version: number, statuses: readonly string[]) {
    if (row.state_version !== version) throw new SubmissionError('VERSION_CONFLICT', 'Submission changed; reload before deciding', 409)
    if (!statuses.includes(row.status)) throw new SubmissionError('INVALID_TRANSITION', `Submission is ${row.status}`, 409)
  }
  async function distributionTargets(tx: PoolClient, scope: DistributionScope) {
    if (scope.kind !== 'selected') return
    const organizations = await tx.query("SELECT id FROM organizations WHERE id=ANY($1::text[]) AND status='active' FOR SHARE", [scope.organizationIds])
    const deployments = await tx.query(`SELECT d.id FROM deployments d JOIN organizations o ON o.id=d.organization_id
      WHERE d.id=ANY($1::text[]) AND d.status='active' AND o.status='active' FOR SHARE OF d,o`, [scope.deploymentIds])
    if (organizations.rowCount !== scope.organizationIds.length || deployments.rowCount !== scope.deploymentIds.length) throw new SubmissionError('DISTRIBUTION_TARGET_INVALID', 'Selected recipients must identify active organizations or deployments')
  }

  return {
    async create(actor: HumanPrincipal, input: SubmissionInput, operationKey: string) {
      human(actor)
      const value = normalizeInput(input)
      return database.transaction(async tx => {
        await lockOperation(tx, actor, operationKey)
        // Creation is an account-level developer capability; per-pack write
        // authority is checked below against pack_ownerships. Read it from a
        // live principal refresh: the flag may change after this session began.
        const live = await identity.requireSession(actor, tx)
        if (!live.developer && !live.platformAdmin) throw new SubmissionError('FORBIDDEN', 'Developer capability is required', 403)
        // Tenant membership gates only a NEW pack under the tenant's namespace.
        // A revision of an existing pack follows pack ownership exclusively, so
        // a maintainer may collaborate across tenants.
        if (!value.previousSubmissionId) await identity.requireOrgRole(actor, value.organizationId, ['member', 'admin'], tx)
        return idempotent(tx, actor, operationKey, { action: 'create', input: value }, async () => {
          await distributionTargets(tx, value.distribution)
          const organization = (await tx.query<{ slug: string }>('SELECT slug FROM organizations WHERE id=$1 AND status=\'active\' FOR SHARE', [value.organizationId])).rows[0]
          if (!organization) throw new SubmissionError('FORBIDDEN', 'Organization is unavailable', 403)
          // New packages are encouraged to use `orgslug.packslug`, but the
          // center also admits existing safe, unscoped domain-pack IDs such as
          // `macro-capital-analyst`. Dotted IDs remain explicitly namespaced;
          // the global packages key and owner check below still prevent an
          // unscoped ID from being claimed by two organizations.
          if (value.packId.includes('.') && !value.packId.startsWith(`${organization.slug}.`)) {
            throw new SubmissionError('PACK_NAMESPACE', 'Dotted package IDs must use the owning organization slug prefix')
          }
          if (value.previousSubmissionId) {
            const previous = await rowFor(tx, value.previousSubmissionId)
            await authorAccess(tx, actor, previous)
            if (previous.pack_id !== value.packId || ['draft', 'validating', 'pending_review'].includes(previous.status)) {
              throw new SubmissionError('INVALID_REVISION', 'Revision must preserve ownership and refer to a settled submission', 409)
            }
          }
          await tx.query('INSERT INTO packages(pack_id,owner_org_id,created_by,name) VALUES ($1,$2,$3,$4) ON CONFLICT (pack_id) DO NOTHING', [value.packId, value.organizationId, actor.userId, value.name])
          const pack = (await tx.query<{ owner_org_id: string; created_by: string }>('SELECT owner_org_id,created_by FROM packages WHERE pack_id=$1 FOR UPDATE', [value.packId])).rows[0]!
          if (pack.owner_org_id !== value.organizationId) throw new SubmissionError('PACK_OWNER_CONFLICT', 'Package ID belongs to another organization', 409)
          // Creation-axis authority: an existing pack may be extended only by
          // its owner or an explicit maintainer, never by tenant membership.
          // A brand-new pack has no ownership rows yet; its creator seeds the
          // first owner grant (backfill parity with migration 007).
          const ownership = (await tx.query('SELECT 1 FROM pack_ownerships WHERE pack_id=$1 LIMIT 1', [value.packId])).rows[0]
          if (ownership) await identity.requirePackRole(actor, value.packId, ['owner', 'maintainer'], tx)
          else if (pack.created_by !== actor.userId) throw new SubmissionError('PACK_OWNER_CONFLICT', 'Package has no accountable owner; only its creator may claim it', 409)
          await tx.query(`INSERT INTO pack_ownerships(pack_id,user_id,role,granted_by) VALUES ($1,$2,'owner',$3)
            ON CONFLICT (pack_id,user_id) DO NOTHING`, [value.packId, actor.userId, actor.userId])
          if ((await tx.query('SELECT 1 FROM releases WHERE pack_id=$1 AND version=$2', [value.packId, value.version])).rowCount) throw new SubmissionError('VERSION_EXISTS', 'This package version is already reserved by an approved release; use a new version', 409)
          const row = (await tx.query<SubmissionRow>(`INSERT INTO submissions
            (id,owner_org_id,pack_id,author_id,version,source_url,source_ref,notes,license,distribution,previous_submission_id,requires_plugin,dependency_release_ids,builtin_dependencies)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14::jsonb) RETURNING *`,
          [randomUUID(), value.organizationId, value.packId, actor.userId, value.version, value.source.url, value.source.ref, value.notes, value.license,
            canonicalJson(value.distribution), value.previousSubmissionId, canonicalJson(value.requiresPlugin), value.dependencyReleaseIds, canonicalJson(value.builtinDependencies)])).rows[0]!
          await submissionAudit(tx, actor, row, 'submission.created')
          return view(row)
        })
      })
    },

    async updateDraft(actor: HumanPrincipal, submissionId: string, version: number,
      input: Omit<SubmissionInput, 'organizationId' | 'packId' | 'name' | 'previousSubmissionId'>, operationKey: string) {
      human(actor); expectedVersion(version)
      const editable = JSON.parse(canonicalJson(input)) as typeof input
      if (!editable || Object.keys(editable).some(key => !['version', 'source', 'notes', 'license', 'distribution', 'requiresPlugin', 'dependencyReleaseIds', 'builtinDependencies'].includes(key))) {
        throw new SubmissionError('INVALID_INPUT', 'Only draft content fields may be edited')
      }
      return database.transaction(async tx => {
        await lockOperation(tx, actor, operationKey)
        const row = await rowFor(tx, submissionId, true)
        await authorAccess(tx, actor, row)
        const value = normalizeInput({ ...editable, organizationId: row.owner_org_id, packId: row.pack_id, name: row.pack_id })
        return idempotent(tx, actor, operationKey, { action: 'edit', submissionId, version, input: value }, async () => {
          requireState(row, version, ['draft'])
          await distributionTargets(tx, value.distribution)
          if ((await tx.query('SELECT 1 FROM releases WHERE pack_id=$1 AND version=$2', [row.pack_id, value.version])).rowCount) throw new SubmissionError('VERSION_EXISTS', 'This package version already has an approved release', 409)
          const next = (await tx.query<SubmissionRow>(`UPDATE submissions SET version=$2,source_url=$3,source_ref=$4,notes=$5,license=$6,distribution=$7::jsonb,
            requires_plugin=$8::jsonb,dependency_release_ids=$9,builtin_dependencies=$10::jsonb,state_version=state_version+1,updated_at=clock_timestamp()
            WHERE id=$1 RETURNING *`, [row.id, value.version, value.source.url, value.source.ref, value.notes, value.license, canonicalJson(value.distribution),
            canonicalJson(value.requiresPlugin), value.dependencyReleaseIds, canonicalJson(value.builtinDependencies)])).rows[0]!
          await submissionAudit(tx, actor, next, 'submission.draft_updated')
          return view(next)
        })
      })
    },

    async fetchPreview(actor: HumanPrincipal, submissionId: string, ref: string) {
      const base = await database.transaction(async tx => {
        const row = await rowFor(tx, submissionId)
        await readAccess(tx, actor, row)
        const snapshot = row.snapshot_id ? (await tx.query<SnapshotRow>('SELECT source_commit, content_tree_sha256 FROM submission_snapshots WHERE id=$1', [row.snapshot_id])).rows[0] : undefined
        return { url: row.source_url, snapshotCommit: snapshot?.source_commit ?? null, snapshotTree: snapshot?.content_tree_sha256 ?? null }
      })
      const { createGitSnapshotFetcher } = await import('./git-snapshot.js')
      const fetchSnapshot = createGitSnapshotFetcher()
      const snap = await fetchSnapshot({ url: base.url, ref, outputParent: options.scratchRoot, allowedHosts: options.allowedGitHosts, validatorVersion: '0.1.0' })
      const treeSha = snap.artifact.contentTreeSha256
      return { resolvedCommit: snap.sourceCommit, requestedRef: ref, valid: snap.report.valid, fileCount: snap.preview.files.length, sizeBytes: snap.artifact.sizeBytes ?? null, contentTreeSha256: treeSha, sameAsCurrentSnapshot: !!base.snapshotTree && treeSha === base.snapshotTree, snapshotCommit: base.snapshotCommit, packVersion: snap.packMeta?.version ?? null }
    },
    async upstreamCheck(actor: HumanPrincipal, submissionId: string) {
      return database.transaction(async tx => {
        const row = await rowFor(tx, submissionId)
        await readAccess(tx, actor, row)
        const snapshot = row.snapshot_id ? (await tx.query<SnapshotRow>('SELECT source_commit FROM submission_snapshots WHERE id=$1', [row.snapshot_id])).rows[0] : undefined
        const { gitLsRemoteHead } = await import('./git-snapshot.js')
        const head = await gitLsRemoteHead(row.source_url, row.source_ref, options.allowedGitHosts)
        return { sourceUrl: row.source_url, ref: row.source_ref, snapshotCommit: snapshot?.source_commit ?? null, upstreamHead: head, matches: head === (snapshot?.source_commit ?? null) }
      })
    },
    async get(actor: HumanPrincipal, submissionId: string) {
      return database.transaction(async tx => {
        const row = await rowFor(tx, submissionId)
        await readAccess(tx, actor, row)
        const snapshot = row.snapshot_id ? (await tx.query<SnapshotRow>('SELECT * FROM submission_snapshots WHERE id=$1', [row.snapshot_id])).rows[0] : undefined
        const reviews = (await tx.query('SELECT id,reviewer_id,decision,comment,created_at FROM reviews WHERE submission_id=$1 ORDER BY created_at', [row.id])).rows
        const attempts = (await tx.query('SELECT attempt,status,error_code,error_message,started_at,finished_at FROM validation_attempts WHERE submission_id=$1 ORDER BY attempt', [row.id])).rows
        const release = (await tx.query(`SELECT id,status,state_version AS "stateVersion",error_code AS "errorCode",
          published_at AS "publishedAt",yanked_at AS "yankedAt",yank_reason AS "yankReason" FROM releases WHERE approved_submission_id=$1`, [row.id])).rows[0] ?? null
        const pack = (await tx.query<{ auto_approve: boolean }>('SELECT auto_approve FROM packages WHERE pack_id=$1 AND owner_org_id=$2', [row.pack_id, row.owner_org_id])).rows[0]
        return { submission: { ...view(row), autoApprove: pack?.auto_approve ?? false }, snapshot: snapshot ? {
          id: snapshot.id, sourceCommit: snapshot.source_commit, artifactSha256: snapshot.artifact_sha256,
          contentTreeSha256: snapshot.content_tree_sha256, reportSha256: snapshot.report_sha256,
          validatorVersion: snapshot.validator_version, sizeBytes: Number(snapshot.size_bytes), fileCount: snapshot.file_count,
          report: snapshot.report, preview: snapshot.preview, diff: snapshot.diff,
        } : null, reviews, attempts, release }
      })
    },

    async list(actor: HumanPrincipal, organizationId: string, options: { limit?: number; beforeId?: string; status?: readonly string[]; packId?: string; groupBy?: 'pack'; afterPack?: string } = {}) {
      human(actor); id(organizationId, 'organizationId')
      const limit = options.limit ?? 50
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SubmissionError('INVALID_INPUT', 'limit must be between 1 and 100')
      if (options.beforeId !== undefined) id(options.beforeId, 'beforeId')
      const statusFilter = options.status && options.status.length ? [...new Set(options.status)] : undefined
      if (statusFilter && statusFilter.some(value => !submissionStatuses.has(value))) throw new SubmissionError('INVALID_INPUT', 'status filter contains an unknown submission status')
      let packIdFilter: string | undefined
      if (options.packId !== undefined) {
        const trimmed = options.packId.trim()
        if (trimmed.length > 64) throw new SubmissionError('INVALID_INPUT', 'packId filter is too long')
        if (trimmed.length) packIdFilter = '%' + trimmed.replace(/[\\%_]/g, character => `\\${character}`) + '%'
      }
      return database.transaction(async tx => {
        // Listing is filtered per row by readAccess (pack ownership, authorship
        // or review scope); tenant membership alone no longer implies access.
        await identity.requireSession(actor, tx)
        const parameters: unknown[] = [organizationId, options.beforeId ?? null]
        let filters = ''
        if (statusFilter) { parameters.push(statusFilter); filters += ` AND status = ANY($${parameters.length}::text[])` }
        if (packIdFilter) { parameters.push(packIdFilter); filters += ` AND pack_id LIKE $${parameters.length}` }
        parameters.push(limit)
        const rows = (await tx.query<SubmissionRow>(`SELECT * FROM submissions WHERE owner_org_id=$1 AND ($2::text IS NULL OR id<$2)${filters} ORDER BY id DESC LIMIT $${parameters.length}`, parameters)).rows
        if (options.groupBy === 'pack') {
          // Pack rollup: one entry per pack entity (latest matching submission),
          // plus the pack's total matching submission count and published release.
          if (options.afterPack !== undefined) id(options.afterPack, 'afterPack')
          const packParameters: unknown[] = [organizationId, options.afterPack ?? null]
          let packFilters = ''
          if (statusFilter) { packParameters.push(statusFilter); packFilters += ` AND status = ANY($${packParameters.length}::text[])` }
          if (packIdFilter) { packParameters.push(packIdFilter); packFilters += ` AND pack_id LIKE $${packParameters.length}` }
          packParameters.push(limit)
          // "Latest" means the most recent submission that is still meaningful:
          // withdrawn records are superseded history and only surface when a
          // pack has nothing else.
          const latestQuery = (excludeWithdrawn: boolean) => `SELECT DISTINCT ON (pack_id) * FROM submissions WHERE owner_org_id=$1 AND ($2::text IS NULL OR pack_id>$2)${excludeWithdrawn ? " AND status<>'withdrawn'" : ''}${packFilters} ORDER BY pack_id, created_at DESC, id DESC LIMIT $${packParameters.length}`
          const activeLatest = await tx.query<SubmissionRow>(latestQuery(true), packParameters)
          const anyLatest = await tx.query<SubmissionRow>(latestQuery(false), packParameters)
          const latestPerPack = new Map(activeLatest.rows.map(row => [row.pack_id, row]))
          const latest = [...anyLatest.rows].sort((a, b) => a.pack_id < b.pack_id ? -1 : a.pack_id > b.pack_id ? 1 : 0).map(row => latestPerPack.get(row.pack_id) ?? row)
          const countParameters: unknown[] = [organizationId]
          let countFilters = ''
          if (statusFilter) { countParameters.push(statusFilter); countFilters += ` AND status = ANY($${countParameters.length}::text[])` }
          if (packIdFilter) { countParameters.push(packIdFilter); countFilters += ` AND pack_id LIKE $${countParameters.length}` }
          const counts = new Map((await tx.query<{ pack_id: string; total: string }>(`SELECT pack_id, count(*) AS total FROM submissions WHERE owner_org_id=$1${countFilters} GROUP BY pack_id`, countParameters)).rows.map(row => [row.pack_id, Number(row.total)]))
          const names = new Map((await tx.query<{ pack_id: string; name: string }>('SELECT pack_id, name FROM packages WHERE owner_org_id=$1', [organizationId])).rows.map(row => [row.pack_id, row.name]))
          const releaseRows = (await tx.query<{ pack_id: string; id: string; version: string }>(`SELECT DISTINCT ON (pack_id) pack_id, id, version FROM releases WHERE owner_org_id=$1 AND status='published' ORDER BY pack_id, created_at DESC`, [organizationId])).rows
          const releaseByPack = new Map(releaseRows.map(row => [row.pack_id, { id: row.id, version: row.version }]))
          const items: Array<{ packId: string; name: string; submissionCount: number; submission: ReturnType<typeof view>; release: { id: string; version: string } | null }> = []
          for (const row of latest) {
            try { await readAccess(tx, actor, row) } catch (error) { if (!(error instanceof SubmissionError) || error.code !== 'NOT_FOUND') throw error; continue }
            items.push({ packId: row.pack_id, name: names.get(row.pack_id) ?? row.pack_id, submissionCount: counts.get(row.pack_id) ?? 1, submission: view(row), release: releaseByPack.get(row.pack_id) ?? null })
          }
          return { items, nextCursor: latest.length === limit ? latest.at(-1)!.pack_id : null }
        }
        const visible: ReturnType<typeof view>[] = []
        for (const row of rows) { try { await readAccess(tx, actor, row); visible.push(view(row)) } catch (error) { if (!(error instanceof SubmissionError) || error.code !== 'NOT_FOUND') throw error } }
        return { items: visible, nextCursor: rows.length === limit ? rows.at(-1)!.id : null }
      })
    },

    async listReviewQueue(actor: HumanPrincipal, organizationId: string, options: { limit?: number; beforeId?: string } = {}) {
      human(actor); id(organizationId, 'organizationId')
      const limit = options.limit ?? 50
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SubmissionError('INVALID_INPUT', 'limit must be between 1 and 100')
      if (options.beforeId !== undefined) id(options.beforeId, 'beforeId')
      return database.transaction(async tx => {
        const fresh = await identity.requireReviewAccess(actor, organizationId, undefined, tx)
        // Administrators may self-review, so their own pending submissions must
        // be visible in the queue too.
        const self = fresh.platformAdmin || fresh.memberships.some(member => member.organizationId === organizationId && member.roles.includes('admin'))
        const rows = (await tx.query<SubmissionRow>(`SELECT * FROM submissions WHERE owner_org_id=$1 AND status='pending_review' AND ($4::boolean OR author_id<>$2)
          AND ($3::text IS NULL OR id<$3) ORDER BY id DESC LIMIT $5`, [organizationId, actor.userId, options.beforeId ?? null, self, limit])).rows
        return { items: rows.map(view), nextCursor: rows.length === limit ? rows.at(-1)!.id : null }
      })
    },

    async startValidation(actor: HumanPrincipal, submissionId: string, version: number, operationKey: string) {
      expectedVersion(version)
      return database.transaction(async tx => {
        await lockOperation(tx, actor, operationKey)
        const row = await rowFor(tx, submissionId, true)
        await authorAccess(tx, actor, row)
        return idempotent(tx, actor, operationKey, { action: 'validate', submissionId, version }, async () => {
          requireState(row, version, ['draft'])
          const next = (await tx.query<SubmissionRow>('UPDATE submissions SET status=\'validating\',state_version=state_version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *', [row.id])).rows[0]!
          const { job } = await enqueueJob(tx, { kind: 'validate_submission', idempotencyKey: `validate:${row.id}`, payload: { submissionId: row.id }, maxAttempts: 3 })
          await submissionAudit(tx, actor, next, 'submission.validation_requested', { jobId: job.id })
          return { submission: view(next), jobId: job.id }
        })
      })
    },

    async submit(actor: HumanPrincipal, submissionId: string, version: number, operationKey: string) {
      expectedVersion(version)
      return database.transaction(async tx => {
        await lockOperation(tx, actor, operationKey)
        const row = await rowFor(tx, submissionId, true)
        await authorAccess(tx, actor, row)
        return idempotent(tx, actor, operationKey, { action: 'submit', submissionId, version }, async () => {
          requireState(row, version, ['validated'])
          await distributionTargets(tx, row.distribution)
          const snapshot = (await tx.query<SnapshotRow>('SELECT * FROM submission_snapshots WHERE id=$1 AND submission_id=$2', [row.snapshot_id, row.id])).rows[0]
          if (!snapshot) throw new SubmissionError('SNAPSHOT_MISSING', 'Validated snapshot is unavailable', 409)
          const report = assertContract('report', snapshot.report)
          if (!report.valid || sha256(canonicalJson(report)) !== snapshot.report_sha256) throw new SubmissionError('REPORT_INVALID', 'Only an unchanged valid report may be sent for review', 409)
          // 免审核：包开启 auto_approve 后，送审即视为通过，直接进入发布流程。
          const pack = (await tx.query<{ auto_approve: boolean }>('SELECT auto_approve FROM packages WHERE pack_id=$1 AND owner_org_id=$2', [row.pack_id, row.owner_org_id])).rows[0]
          const autoApprove = pack?.auto_approve === true
          if (!autoApprove) {
            const next = (await tx.query<SubmissionRow>('UPDATE submissions SET status=\'pending_review\',state_version=state_version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *', [row.id])).rows[0]!
            await submissionAudit(tx, actor, next, 'submission.submitted', { snapshotId: snapshot.id, contentTreeSha256: snapshot.content_tree_sha256 })
            return view(next)
          }
          // 免审核路径与人工审核一样经过 pending_review（状态机两次跃迁，
          // 每次状态版本 +1），审核记录带 auto_approve 标记以豁免自审 guard。
          await tx.query('UPDATE submissions SET status=\'pending_review\',state_version=state_version+1,updated_at=clock_timestamp() WHERE id=$1', [row.id])
          const reviewId = randomUUID()
          await tx.query(`INSERT INTO reviews(id,submission_id,snapshot_id,reviewer_id,decision,expected_state_version,content_tree_sha256,comment,auto_approve)
            VALUES ($1,$2,$3,$4,'approved',$5,$6,$7,true)`, [reviewId, row.id, snapshot.id, actor.userId, row.state_version + 1, snapshot.content_tree_sha256, '免审核配置生效，自动审核通过。'])
          const next = (await tx.query<SubmissionRow>('UPDATE submissions SET status=\'approved\',state_version=state_version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *', [row.id])).rows[0]!
          const releaseId = randomUUID()
          try {
            await tx.query('INSERT INTO releases(id,pack_id,owner_org_id,version,approved_submission_id,snapshot_id) VALUES ($1,$2,$3,$4,$5,$6)', [releaseId, row.pack_id, row.owner_org_id, row.version, row.id, snapshot.id])
          } catch (error) {
            if ((error as { code?: string }).code === '23505') throw new SubmissionError('VERSION_EXISTS', 'Package version already has an approved release', 409)
            throw error
          }
          await tx.query('INSERT INTO release_distribution(release_id,scope) VALUES ($1,$2::jsonb)', [releaseId, canonicalJson(row.distribution)])
          const jobId = (await enqueueJob(tx, { kind: 'publish_release', idempotencyKey: `publish:${releaseId}`, payload: { releaseId, snapshotId: snapshot.id }, maxAttempts: 3 })).job.id
          await submissionAudit(tx, actor, next, 'submission.submitted', { snapshotId: snapshot.id, contentTreeSha256: snapshot.content_tree_sha256, autoApproved: true, reviewId, releaseId, jobId })
          return { ...view(next), autoApproved: true, releaseId, jobId }
        })
      })
    },

    async withdraw(actor: HumanPrincipal, submissionId: string, version: number, operationKey: string) {
      expectedVersion(version)
      return database.transaction(async tx => {
        await lockOperation(tx, actor, operationKey)
        const row = await rowFor(tx, submissionId, true)
        await authorAccess(tx, actor, row)
        return idempotent(tx, actor, operationKey, { action: 'withdraw', submissionId, version }, async () => {
          requireState(row, version, ['pending_review'])
          const next = (await tx.query<SubmissionRow>('UPDATE submissions SET status=\'withdrawn\',state_version=state_version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *', [row.id])).rows[0]!
          await submissionAudit(tx, actor, next, 'submission.withdrawn')
          return view(next)
        })
      })
    },

    async retryPublication(actor: HumanPrincipal, submissionId: string, releaseVersion: number, operationKey: string) {
      human(actor); expectedVersion(releaseVersion)
      return database.transaction(async tx => {
        await lockOperation(tx, actor, operationKey)
        const row = await rowFor(tx, submissionId, true)
        try { await identity.requirePackRole(actor, row.pack_id, ['owner'], tx) } catch (error) {
          if (!(error instanceof IdentityError) || error.code !== 'FORBIDDEN') throw error
          await identity.requireReviewAccess(actor, row.owner_org_id, row.author_id, tx)
        }
        const release = (await tx.query<{ id: string; snapshot_id: string; state_version: number; status: string }>(
          'SELECT id,snapshot_id,state_version,status FROM releases WHERE approved_submission_id=$1 FOR UPDATE', [row.id])).rows[0]
        return idempotent(tx, actor, operationKey, { action: 'retry-publication', submissionId, releaseVersion }, async () => {
          if (row.status !== 'approved' || !release || release.snapshot_id !== row.snapshot_id) throw new SubmissionError('INVALID_TRANSITION', 'Only the original approved release can be retried', 409)
          if (release.state_version !== releaseVersion) throw new SubmissionError('VERSION_CONFLICT', 'Release changed; reload before retrying', 409)
          if (release.status !== 'publish_failed') throw new SubmissionError('INVALID_TRANSITION', 'Only a failed publication can be retried', 409)
          const approved = await tx.query('SELECT 1 FROM reviews WHERE submission_id=$1 AND snapshot_id=$2 AND decision=\'approved\'', [row.id, row.snapshot_id])
          if (!approved.rowCount) throw new SubmissionError('APPROVAL_MISSING', 'This snapshot has no approval', 409)
          await tx.query("UPDATE releases SET status='publishing',state_version=state_version+1,error_code=NULL WHERE id=$1", [release.id])
          const { job } = await enqueueJob(tx, { kind: 'publish_release', idempotencyKey: `publish-retry:${release.id}:${releaseVersion}`,
            payload: { releaseId: release.id, snapshotId: release.snapshot_id }, maxAttempts: 3 })
          await submissionAudit(tx, actor, row, 'submission.publication_retry_requested', { releaseId: release.id, snapshotId: release.snapshot_id, jobId: job.id })
          return { releaseId: release.id, status: 'publishing', stateVersion: releaseVersion + 1, jobId: job.id }
        })
      })
    },

    async review(actor: HumanPrincipal, submissionId: string, input: { expectedVersion: number; contentTreeSha256: string; decision: 'approved' | 'changes_requested' | 'rejected'; comment: string }, operationKey: string) {
      human(actor)
      const request = JSON.parse(canonicalJson(input)) as typeof input
      if (!request || Object.keys(request).some(key => !['expectedVersion', 'contentTreeSha256', 'decision', 'comment'].includes(key))) throw new SubmissionError('INVALID_INPUT', 'Unknown review field')
      expectedVersion(request.expectedVersion); text(request.comment, 'comment', 20000)
      if (!['approved', 'changes_requested', 'rejected'].includes(request.decision) || !/^[a-f0-9]{64}$/.test(request.contentTreeSha256)) throw new SubmissionError('INVALID_INPUT', 'Review decision or snapshot digest is invalid')
      return database.transaction(async tx => {
        await lockOperation(tx, actor, operationKey)
        const row = await rowFor(tx, submissionId, true)
        await identity.requireReviewAccess(actor, row.owner_org_id, row.author_id, tx)
        return idempotent(tx, actor, operationKey, { action: 'review', submissionId, ...request }, async () => {
          requireState(row, request.expectedVersion, ['pending_review'])
          if (request.decision === 'approved') await distributionTargets(tx, row.distribution)
          const snapshot = (await tx.query<SnapshotRow>('SELECT * FROM submission_snapshots WHERE id=$1 AND submission_id=$2', [row.snapshot_id, row.id])).rows[0]
          if (!snapshot || snapshot.content_tree_sha256 !== request.contentTreeSha256) throw new SubmissionError('SNAPSHOT_CONFLICT', 'Review refers to different content', 409)
          const report = assertContract('report', snapshot.report)
          if (!report.valid || sha256(canonicalJson(report)) !== snapshot.report_sha256) throw new SubmissionError('REPORT_INVALID', 'Review report failed integrity verification', 409)
          const reviewId = randomUUID()
          await tx.query(`INSERT INTO reviews(id,submission_id,snapshot_id,reviewer_id,decision,expected_state_version,content_tree_sha256,comment)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [reviewId, row.id, snapshot.id, actor.userId, request.decision, request.expectedVersion, request.contentTreeSha256, request.comment])
          const next = (await tx.query<SubmissionRow>('UPDATE submissions SET status=$2,state_version=state_version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *', [row.id, request.decision])).rows[0]!
          let releaseId: string | null = null; let jobId: string | null = null
          if (request.decision === 'approved') {
            releaseId = randomUUID()
            try {
              await tx.query('INSERT INTO releases(id,pack_id,owner_org_id,version,approved_submission_id,snapshot_id) VALUES ($1,$2,$3,$4,$5,$6)', [releaseId, row.pack_id, row.owner_org_id, row.version, row.id, snapshot.id])
            } catch (error) {
              if ((error as { code?: string }).code === '23505') throw new SubmissionError('VERSION_EXISTS', 'Package version already has an approved release', 409)
              throw error
            }
            await tx.query('INSERT INTO release_distribution(release_id,scope) VALUES ($1,$2::jsonb)', [releaseId, canonicalJson(row.distribution)])
            jobId = (await enqueueJob(tx, { kind: 'publish_release', idempotencyKey: `publish:${releaseId}`, payload: { releaseId, snapshotId: snapshot.id }, maxAttempts: 3 })).job.id
          }
          await submissionAudit(tx, actor, next, `submission.${request.decision}`, { reviewId, releaseId, jobId, snapshotId: snapshot.id })
          return { submission: view(next), reviewId, releaseId, jobId }
        })
      })
    },

    // 免审核配置：包 owner 或组织审核人可开启/关闭；只影响该包之后的送审。
    async setAutoReview(actor: HumanPrincipal, submissionId: string, enabled: unknown, operationKey: string) {
      human(actor)
      if (typeof enabled !== 'boolean') throw new SubmissionError('INVALID_INPUT', 'enabled must be a boolean')
      return database.transaction(async tx => {
        await lockOperation(tx, actor, operationKey)
        const row = await rowFor(tx, submissionId, true)
        try { await identity.requirePackRole(actor, row.pack_id, ['owner'], tx) } catch (error) {
          if (!(error instanceof IdentityError) || error.code !== 'FORBIDDEN') throw error
          await identity.requireReviewAccess(actor, row.owner_org_id, row.author_id, tx)
        }
        return idempotent(tx, actor, operationKey, { action: 'set-auto-review', submissionId, enabled }, async () => {
          const updated = (await tx.query<{ pack_id: string; auto_approve: boolean }>(
            'UPDATE packages SET auto_approve=$2 WHERE pack_id=$1 AND owner_org_id=$3 RETURNING pack_id,auto_approve', [row.pack_id, enabled, row.owner_org_id])).rows[0]
          if (!updated) throw new SubmissionError('NOT_FOUND', 'Package does not exist in this organization', 404)
          await submissionAudit(tx, actor, row, 'pack.auto_review_configured', { packId: row.pack_id, autoApprove: enabled })
          return { packId: updated.pack_id, autoApprove: updated.auto_approve }
        })
      })
    },
  }
}
