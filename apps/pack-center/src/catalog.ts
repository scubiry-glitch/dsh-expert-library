/** Authorized metadata and short-lived download grants; no public object-store URL. */
import { createPublicKey, KeyObject, randomBytes, randomUUID, type KeyLike } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import type { CenterDatabase } from './database.js'
import type { HumanPrincipal, IdentityService } from './auth.js'
import type { MachinePrincipal, createDeploymentService } from './deployments.js'
import type { LocalArtifactStore, VerifiedArtifactStream } from './storage.js'
import { assertContract, canonicalBytes, canonicalJson, sha256, verifyReleaseManifest,
  type DistributionScope, type ReleaseManifest, type SignedReleaseManifest, type DependencyLock } from '../../../packages/pack-contract/index.mjs'

export type CatalogPrincipal = HumanPrincipal | MachinePrincipal
type DeploymentService = ReturnType<typeof createDeploymentService>
export interface CatalogOptions {
  database: CenterDatabase
  identity: Pick<IdentityService, 'requireSession'>
  deployments: Pick<DeploymentService, 'requireScope'>
  store: Pick<LocalArtifactStore, 'verify' | 'openStream'>
  centerId: string
  trustedSigningKeys: Readonly<Record<string, KeyLike>>
  downloadGrantTtlMs?: number
}
export class CatalogError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message); this.name = 'CatalogError' }
}
interface ReleaseRow extends QueryResultRow {
  id: string; pack_id: string; owner_org_id: string; version: string; status: string; signed_manifest: SignedReleaseManifest
  approved_submission_id: string; snapshot_id: string; published_at: Date | null; name: string; scope: DistributionScope
  artifact_sha256: string; content_tree_sha256: string; report_sha256: string; source_commit: string; artifact_key: string
  size_bytes: string; file_count: number; report: unknown; diff: unknown; notes: string; license: string
}
interface GrantRow extends QueryResultRow {
  id: string; release_id: string; actor_kind: 'human' | 'deployment'; actor_id: string; credential_id: string | null
  artifact_sha256: string; manifest_sha256: string
}
export interface ReleaseView {
  releaseId: string; packId: string; ownerOrgId: string; name: string; version: string; publishedAt: string
  manifest: ReleaseManifest; distribution: DistributionScope
  downloadAvailability: { available: boolean; code?: string }
}
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !safeId.test(value) || value.includes('..') || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new CatalogError('INVALID_INPUT', 'Invalid identifier')
}
function fail(code: string, message: string, status = 409): never { throw new CatalogError(code, message, status) }
const selectRelease = `SELECT r.id,r.pack_id,r.owner_org_id,r.version,r.status,r.signed_manifest,r.approved_submission_id,r.snapshot_id,r.published_at,
  p.name,d.scope,s.artifact_sha256,s.content_tree_sha256,s.report_sha256,s.source_commit,s.artifact_key,s.size_bytes,s.file_count,s.report,s.diff,
  sub.notes,sub.license FROM releases r JOIN packages p ON p.pack_id=r.pack_id JOIN release_distribution d ON d.release_id=r.id
  JOIN organizations o ON o.id=r.owner_org_id JOIN submission_snapshots s ON s.id=r.snapshot_id JOIN submissions sub ON sub.id=r.approved_submission_id`

export function createCatalogService(options: CatalogOptions) {
  id(options.centerId)
  const { database, identity, deployments, store } = options
  const ttl = options.downloadGrantTtlMs ?? 60000
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 300000) throw new CatalogError('CATALOG_CONFIG', 'Download grant lifetime must be from one second to five minutes', 500)
  const trustedKeys: Record<string, KeyObject> = Object.create(null)
  for (const [keyId, value] of Object.entries(options.trustedSigningKeys)) {
    id(keyId)
    // Never accept a private key in the API process's public verification configuration.
    if (value instanceof KeyObject && value.type !== 'public') fail('CATALOG_CONFIG', 'Catalog requires public verification keys', 500)
    if (!(value instanceof KeyObject) && Buffer.from(value as string | Buffer).toString('utf8').includes('PRIVATE KEY')) fail('CATALOG_CONFIG', 'Catalog requires public verification keys', 500)
    let key: KeyObject
    try { key = value instanceof KeyObject ? value : createPublicKey(value) } catch { return fail('CATALOG_CONFIG', 'Invalid public verification key', 500) }
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') fail('CATALOG_CONFIG', 'Catalog verification keys must be Ed25519', 500)
    trustedKeys[keyId] = key
  }
  if (!Object.keys(trustedKeys).length || Object.keys(trustedKeys).length > 100) fail('CATALOG_CONFIG', 'At least one bounded public verification key must be configured', 500)

  async function refresh(tx: PoolClient, actor: CatalogPrincipal, permission: 'catalog:read' | 'release:download') {
    if (actor?.kind === 'human') return identity.requireSession(actor, tx)
    if (actor?.kind === 'deployment') return deployments.requireScope(actor, permission, tx)
    return fail('UNAUTHENTICATED', 'A current authenticated identity is required', 401)
  }
  function orgs(actor: CatalogPrincipal): string[] { return actor.kind === 'human' ? actor.memberships.map(member => member.organizationId) : [actor.organizationId] }
  // Distribution axis: a tenant visibility grant ("all" or a listed subset)
  // widens what the tenant's humans and deployments may see, independently of
  // each release's distribution scope.
  interface VisibilityGrant { all: boolean; packs: Set<string> }
  const emptyGrant: VisibilityGrant = { all: false, packs: new Set() }
  /** Resolved at most once per public call and threaded through row/dependency
   * recursion; never cached on the pooled client, which outlives transactions. */
  async function visibilityFor(tx: PoolClient, actor: CatalogPrincipal): Promise<VisibilityGrant> {
    const orgList = orgs(actor)
    if (!orgList.length) return emptyGrant
    const rows = (await tx.query<{ scope: string; pack_ids: string[] | null }>(`SELECT v.scope,
      (SELECT array_agg(i.pack_id)::text[] FROM pack_visibility_items i WHERE i.visibility_id=v.id) AS pack_ids
      FROM pack_visibilities v JOIN organizations o ON o.id=v.organization_id
      WHERE v.organization_id=ANY($1::text[]) AND v.status='active' AND o.status='active'`, [orgList])).rows
    const grant: VisibilityGrant = { all: false, packs: new Set() }
    for (const row of rows) {
      if (row.scope === 'all') grant.all = true
      else for (const packId of row.pack_ids ?? []) grant.packs.add(packId)
    }
    return grant
  }
  async function visible(actor: CatalogPrincipal, row: ReleaseRow, grant: VisibilityGrant) {
    const scope = assertContract('scope', row.scope)
    if (scope.kind === 'authenticated') return true
    if (grant.all || grant.packs.has(row.pack_id)) return true
    if (scope.kind === 'organization') return orgs(actor).includes(row.owner_org_id)
    return scope.organizationIds.some(org => orgs(actor).includes(org)) || (actor.kind === 'deployment' && scope.deploymentIds.includes(actor.deploymentId))
  }
  function verified(row: ReleaseRow): ReleaseManifest {
    try {
      const manifest = verifyReleaseManifest(row.signed_manifest, trustedKeys)
      if (manifest.centerId !== options.centerId || manifest.releaseId !== row.id || manifest.packId !== row.pack_id
        || manifest.ownerOrgId !== row.owner_org_id || manifest.version !== row.version || manifest.approvedSubmissionId !== row.approved_submission_id
        || manifest.sourceCommit !== row.source_commit || manifest.artifactSha256 !== row.artifact_sha256 || manifest.contentTreeSha256 !== row.content_tree_sha256
        || manifest.reportSha256 !== row.report_sha256 || manifest.sizeBytes !== Number(row.size_bytes) || manifest.fileCount !== row.file_count
        || row.artifact_key !== `sha256/${manifest.artifactSha256}` || !row.published_at) throw new Error('Snapshot identity mismatch')
      return manifest
    } catch { return fail('RELEASE_INTEGRITY', 'Published release failed integrity verification', 503) }
  }
  async function rowFor(tx: PoolClient, actor: CatalogPrincipal, releaseId: string, grant: VisibilityGrant): Promise<ReleaseRow> {
    id(releaseId)
    const row = (await tx.query<ReleaseRow>(`${selectRelease} WHERE r.id=$1 AND o.status='active' FOR SHARE OF r,d,o`, [releaseId])).rows[0]
    if (!row || !(await visible(actor, row, grant))) fail('NOT_FOUND', 'Release is not available', 404)
    if (row.status === 'yanked') fail('RELEASE_YANKED', 'Release is no longer distributed', 410)
    if (row.status !== 'published') fail('NOT_FOUND', 'Release is not available', 404)
    return row
  }
  async function dependencies(tx: PoolClient, actor: CatalogPrincipal, manifest: ReleaseManifest, grant: VisibilityGrant): Promise<void> {
    const seen = new Map<string, string>([[manifest.packId, manifest.releaseId]])
    const visiting = new Set<string>([manifest.releaseId]), visited = new Set<string>()
    async function visit(lock: DependencyLock) {
      if (visiting.size > 100 || seen.size >= 1000) fail('RELEASE_INTEGRITY', 'Dependency graph exceeds limits', 503)
      let row: ReleaseRow
      try { row = await rowFor(tx, actor, lock.releaseId, grant) } catch (error) {
        if (error instanceof CatalogError && ['NOT_FOUND', 'RELEASE_YANKED'].includes(error.code)) fail('DEPENDENCY_UNAVAILABLE', 'A fixed dependency is no longer available to this identity')
        throw error
      }
      const next = verified(row)
      const actual = { packId: next.packId, ownerOrgId: next.ownerOrgId, releaseId: next.releaseId, version: next.version,
        artifactSha256: next.artifactSha256, contentTreeSha256: next.contentTreeSha256 }
      if (canonicalJson(actual) !== canonicalJson(lock) || visiting.has(next.releaseId) || (seen.has(next.packId) && seen.get(next.packId) !== next.releaseId)) fail('RELEASE_INTEGRITY', 'Fixed dependency graph is inconsistent', 503)
      seen.set(next.packId, next.releaseId)
      if (visited.has(next.releaseId)) return
      visiting.add(next.releaseId)
      for (const nested of next.dependencyLock) await visit(nested)
      visiting.delete(next.releaseId); visited.add(next.releaseId)
    }
    for (const lock of manifest.dependencyLock) await visit(lock)
  }
  async function availability(tx: PoolClient, actor: CatalogPrincipal, manifest: ReleaseManifest, grant: VisibilityGrant) {
    try { await dependencies(tx, actor, manifest, grant); return { available: true } }
    catch (error) {
      if (error instanceof CatalogError && error.code === 'DEPENDENCY_UNAVAILABLE') return { available: false, code: error.code }
      throw error
    }
  }
  async function visibleDiff(tx: PoolClient, actor: CatalogPrincipal, row: ReleaseRow, grant: VisibilityGrant) {
    const diff = row.diff as { baseline?: { releaseId?: unknown; snapshotId?: unknown } | null } | null
    if (diff?.baseline) {
      // Historical removed filenames, entities and permissions are private too.
      // A newly public release does not authorize disclosure of its old baseline.
      const baseline = diff.baseline
      if (typeof baseline.releaseId !== 'string' || typeof baseline.snapshotId !== 'string') fail('RELEASE_INTEGRITY', 'Invalid change baseline', 503)
      try {
        const previous = await rowFor(tx, actor, baseline.releaseId, grant)
        verified(previous)
        if (previous.pack_id !== row.pack_id || previous.snapshot_id !== baseline.snapshotId) fail('RELEASE_INTEGRITY', 'Change baseline does not match its release', 503)
      } catch (error) {
        if (error instanceof CatalogError && ['NOT_FOUND', 'RELEASE_YANKED'].includes(error.code)) {
          return { diff: null, diffAvailability: { available: false, code: 'BASELINE_UNAVAILABLE' } }
        }
        throw error
      }
    }
    return { diff: row.diff, diffAvailability: { available: true } }
  }
  function view(row: ReleaseRow, manifest: ReleaseManifest, downloadAvailability: ReleaseView['downloadAvailability']): ReleaseView {
    return { releaseId: row.id, packId: row.pack_id, ownerOrgId: row.owner_org_id, name: row.name, version: row.version,
      publishedAt: row.published_at!.toISOString(), manifest, distribution: row.scope, downloadAvailability }
  }
  function actorId(actor: CatalogPrincipal) { return actor.kind === 'human' ? actor.userId : actor.deploymentId }
  async function audit(tx: PoolClient, actor: CatalogPrincipal, row: ReleaseRow, action: string, details: object) {
    await tx.query(`INSERT INTO audit_events(actor_kind,actor_id,organization_id,action,object_kind,object_id,outcome,details)
      VALUES ($1,$2,$3,$4,'release',$5,'succeeded',$6::jsonb)`, [actor.kind, actorId(actor), row.owner_org_id, action, row.id, canonicalJson(details)])
  }
  async function verifyObject(row: ReleaseRow, manifest: ReleaseManifest) {
    const object = await store.verify(row.artifact_key, { maxBytes: manifest.sizeBytes })
    if (object.sha256 !== manifest.artifactSha256 || object.sizeBytes !== manifest.sizeBytes) fail('RELEASE_INTEGRITY', 'Stored archive differs from approved release', 503)
  }

  return {
    /** Informational only. A deployment must independently pin these fingerprints. */
    centerInfo() {
      return { schemaVersion: 1 as const, centerId: options.centerId, signingKeys: Object.entries(trustedKeys).map(([keyId, key]) => ({ keyId,
        publicKeyPem: key.export({ type: 'spki', format: 'pem' }).toString(), fingerprintSha256: sha256(key.export({ type: 'spki', format: 'der' })) })) }
    },
    async list(actor: CatalogPrincipal, input: { limit?: number; beforeId?: string; packId?: string } = {}) {
      const { limit = 50, beforeId, packId } = input
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_INPUT', 'Invalid page size', 400)
      if (beforeId !== undefined) id(beforeId)
      if (packId !== undefined) id(packId)
      return database.transaction(async tx => {
        const fresh = await refresh(tx, actor, 'catalog:read')
        const grant = await visibilityFor(tx, fresh)
        // Filter before paging; a private row cannot affect visible page counts.
        // A tenant visibility grant widens the SQL filter the same way `visible`
        // widens the per-row decision.
        const packList = grant.packs.size ? [...grant.packs] : null
        const rows = (await tx.query<ReleaseRow>(`${selectRelease} WHERE r.status='published' AND o.status='active'
          AND ($1::text IS NULL OR r.id<$1) AND ($2::text IS NULL OR r.pack_id=$2)
          AND ($6::boolean OR r.pack_id=ANY($7::text[]) OR (d.scope->>'kind')='authenticated'
            OR ((d.scope->>'kind')='organization' AND r.owner_org_id=ANY($3::text[]))
            OR ((d.scope->>'kind')='selected' AND ((d.scope->'organizationIds') ?| $3::text[] OR ($4::text IS NOT NULL AND (d.scope->'deploymentIds') ? $4))))
          ORDER BY r.id DESC LIMIT $5 FOR SHARE OF r,d,o`, [beforeId ?? null, packId ?? null, orgs(fresh), fresh.kind === 'deployment' ? fresh.deploymentId : null, limit, grant.all, packList])).rows
        const items: ReleaseView[] = []
        for (const row of rows) {
          if (!(await visible(fresh, row, grant))) fail('RELEASE_INTEGRITY', 'Catalog authorization metadata is inconsistent', 503)
          const manifest = verified(row)
          items.push(view(row, manifest, await availability(tx, fresh, manifest, grant)))
        }
        return { schemaVersion: 1 as const, centerId: options.centerId, items, nextCursor: rows.length === limit ? rows.at(-1)!.id : null }
      })
    },
    async get(actor: CatalogPrincipal, releaseId: string) {
      return database.transaction(async tx => {
        const fresh = await refresh(tx, actor, 'catalog:read'), grant = await visibilityFor(tx, fresh)
        const row = await rowFor(tx, fresh, releaseId, grant), manifest = verified(row)
        const report = assertContract('report', row.report)
        if (!report.valid || sha256(canonicalBytes(report)) !== manifest.reportSha256) fail('RELEASE_INTEGRITY', 'Published report is inconsistent', 503)
        return { ...view(row, manifest, await availability(tx, fresh, manifest, grant)), signedManifest: row.signed_manifest, validationReport: report,
          ...await visibleDiff(tx, fresh, row, grant), notes: row.notes, license: row.license }
      })
    },
    async issueDownloadGrant(actor: CatalogPrincipal, releaseId: string) {
      return database.transaction(async tx => {
        const fresh = await refresh(tx, actor, 'release:download'), grant = await visibilityFor(tx, fresh)
        const row = await rowFor(tx, fresh, releaseId, grant), manifest = verified(row)
        await dependencies(tx, fresh, manifest, grant)
        await verifyObject(row, manifest)
        await refresh(tx, actor, 'release:download')
        const grantToken = randomBytes(32).toString('base64url'), grantId = randomUUID()
        const result = (await tx.query<{ expires_at: Date }>(`INSERT INTO download_grants(id,token_sha256,release_id,actor_kind,actor_id,credential_id,artifact_sha256,manifest_sha256,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+($9::integer*interval '1 millisecond')) RETURNING expires_at`,
        [grantId, sha256(grantToken), row.id, fresh.kind, actorId(fresh), fresh.kind === 'deployment' ? fresh.credentialId : null,
          manifest.artifactSha256, sha256(canonicalBytes(row.signed_manifest)), ttl])).rows[0]!
        await audit(tx, fresh, row, 'release.download_grant_issued', { grantId, artifactSha256: manifest.artifactSha256 })
        return { schemaVersion: 1 as const, centerId: options.centerId, releaseId: row.id, signedManifest: row.signed_manifest,
          grantToken, expiresAt: result.expires_at.toISOString(), artifactPath: `/api/v1/releases/${row.id}/artifact` }
      })
    },
    async openDownload(actor: CatalogPrincipal, releaseId: string, grantToken: string) {
      if (typeof grantToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grantToken)) fail('DOWNLOAD_GRANT_INVALID', 'A valid download grant is required', 403)
      let opened: VerifiedArtifactStream | undefined
      try {
        return await database.transaction(async tx => {
          const fresh = await refresh(tx, actor, 'release:download'), grant = await visibilityFor(tx, fresh)
          const row = await rowFor(tx, fresh, releaseId, grant), manifest = verified(row)
          const grant_ = (await tx.query<GrantRow>('SELECT * FROM download_grants WHERE token_sha256=$1 AND expires_at>clock_timestamp() FOR SHARE', [sha256(grantToken)])).rows[0]
          const manifestSha256 = sha256(canonicalBytes(row.signed_manifest))
          if (!grant_ || grant_.release_id !== row.id || grant_.actor_kind !== fresh.kind || grant_.actor_id !== actorId(fresh)
            || grant_.credential_id !== (fresh.kind === 'deployment' ? fresh.credentialId : null)
            || grant_.artifact_sha256 !== manifest.artifactSha256 || grant_.manifest_sha256 !== manifestSha256) fail('DOWNLOAD_GRANT_INVALID', 'Download grant is unavailable for this request', 403)
          await dependencies(tx, fresh, manifest, grant)
          opened = await store.openStream(row.artifact_key, { maxBytes: manifest.sizeBytes })
          if (opened.sha256 !== manifest.artifactSha256 || opened.sizeBytes !== manifest.sizeBytes) fail('RELEASE_INTEGRITY', 'Stored archive differs from approved release', 503)
          if (!(await tx.query('SELECT 1 FROM download_grants WHERE id=$1 AND expires_at>clock_timestamp()', [grant_.id])).rowCount) fail('DOWNLOAD_GRANT_INVALID', 'Download grant expired before authorization completed', 403)
          // Check session/credential expiry again after bounded storage verification.
          await refresh(tx, actor, 'release:download')
          await audit(tx, fresh, row, 'release.download_authorized', { grantId: grant_.id, artifactSha256: manifest.artifactSha256,
            ...(fresh.kind === 'deployment' ? { credentialId: fresh.credentialId } : {}) })
          return { stream: opened.stream, sizeBytes: manifest.sizeBytes, sha256: manifest.artifactSha256,
            contentType: 'application/x-tar' as const, filename: 'domain-pack.tar', releaseId: row.id, manifestSha256 }
        })
      } catch (error) { opened?.stream.destroy(); throw error }
    },
  }
}
