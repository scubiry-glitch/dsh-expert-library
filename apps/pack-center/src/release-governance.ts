/** Human release administration; content/signatures never change here. */
import { randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { assertContract, canonicalJson, sha256, type DistributionScope, type ReleaseManifest } from '../../../packages/pack-contract/index.mjs'
import { IdentityError, type HumanPrincipal, type createIdentityService } from './auth.js'
import type { CenterDatabase } from './database.js'
import { validateFrozenDependencies } from './validation-worker.js'

type IdentityPort = Pick<ReturnType<typeof createIdentityService>, 'requireOrgRole' | 'requireReviewAccess'>
export class ReleaseGovernanceError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message); this.name = 'ReleaseGovernanceError' }
}
interface ReleaseRow extends QueryResultRow {
  id: string; pack_id: string; owner_org_id: string; version: string; status: string; state_version: number
  signed_manifest: { manifest: unknown } | null; approved_submission_id: string; snapshot_id: string
  created_at: Date; published_at: Date | null; yanked_at: Date | null; yank_reason: string | null
}
interface DistributionRow extends QueryResultRow { release_id: string; scope: DistributionScope; state_version: number }
interface RequestRow extends QueryResultRow {
  id: string; release_id: string; requested_by: string; requested_scope: DistributionScope; expected_state_version: number
  status: 'pending_review' | 'approved' | 'rejected' | 'withdrawn'; state_version: number; reason: string
  reviewed_by: string | null; comment: string | null; created_at: Date; reviewed_at: Date | null
}
export interface GovernancePagination { limit?: number; beforeId?: string }
export interface GovernanceQueueOptions extends GovernancePagination { status?: RequestRow['status'] }
export interface DistributionRequestView {
  id: string; releaseId: string; requestedBy: string; requestedScope: DistributionScope; expectedDistributionVersion: number
  status: RequestRow['status']; stateVersion: number; reason: string; reviewedBy: string | null; comment: string | null
  createdAt: string; reviewedAt: string | null
}
export interface GovernanceReleaseView {
  id: string; packId: string; ownerOrgId: string; version: string; status: string; stateVersion: number
  approvedSubmissionId: string; snapshotId: string; createdAt: string; publishedAt: string | null; yankedAt: string | null
  yankReason: string | null; distribution: { scope: DistributionScope; stateVersion: number }
}
function fail(code: string, message: string, status = 400): never { throw new ReleaseGovernanceError(code, message, status) }
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || value.includes('..')
    || ['__proto__', 'constructor', 'prototype'].includes(value)) fail('INVALID_INPUT', 'Invalid identifier')
}
function human(actor: HumanPrincipal): void {
  if (!actor || actor.kind !== 'human') fail('HUMAN_REQUIRED', 'This action requires a human session', 403)
  id(actor.userId)
}
function version(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail('INVALID_INPUT', 'expectedVersion must be a positive integer')
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000 || value.includes('\0')) fail('INVALID_INPUT', 'A nonempty reason or comment up to 4000 characters is required')
}
function capture<T>(value: T, fields: readonly string[]): T {
  const copy = JSON.parse(canonicalJson(value)) as T
  if (!copy || typeof copy !== 'object' || Array.isArray(copy) || Object.keys(copy).some(field => !fields.includes(field))) fail('INVALID_INPUT', 'Unknown request field')
  return copy
}
function pagination(input: GovernancePagination) {
  const value = capture(input, ['limit', 'beforeId']), limit = value.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_INPUT', 'limit must be between 1 and 100')
  if (value.beforeId !== undefined) id(value.beforeId)
  return { limit, beforeId: value.beforeId ?? null }
}
function requestView(row: RequestRow): DistributionRequestView {
  return { id: row.id, releaseId: row.release_id, requestedBy: row.requested_by, requestedScope: row.requested_scope,
    expectedDistributionVersion: row.expected_state_version, status: row.status, stateVersion: row.state_version, reason: row.reason,
    reviewedBy: row.reviewed_by, comment: row.comment, createdAt: row.created_at.toISOString(), reviewedAt: row.reviewed_at?.toISOString() ?? null }
}
function releaseView(row: ReleaseRow, distribution: DistributionRow): GovernanceReleaseView {
  return { id: row.id, packId: row.pack_id, ownerOrgId: row.owner_org_id, version: row.version, status: row.status, stateVersion: row.state_version,
    approvedSubmissionId: row.approved_submission_id, snapshotId: row.snapshot_id, createdAt: row.created_at.toISOString(),
    publishedAt: row.published_at?.toISOString() ?? null, yankedAt: row.yanked_at?.toISOString() ?? null, yankReason: row.yank_reason,
    distribution: { scope: distribution.scope, stateVersion: distribution.state_version } }
}

export function createReleaseGovernance(options: { database: CenterDatabase; identity: IdentityPort }) {
  const { database, identity } = options
  async function release(tx: PoolClient, releaseId: string, lock: 'SHARE' | 'UPDATE' = 'SHARE'): Promise<ReleaseRow> {
    const row = (await tx.query<ReleaseRow>(`SELECT * FROM releases WHERE id=$1 FOR ${lock}`, [releaseId])).rows[0]
    if (!row) fail('NOT_FOUND', 'Release is unavailable', 404)
    return row
  }
  async function distribution(tx: PoolClient, releaseId: string, lock: 'SHARE' | 'UPDATE' = 'SHARE'): Promise<DistributionRow> {
    const row = (await tx.query<DistributionRow>(`SELECT * FROM release_distribution WHERE release_id=$1 FOR ${lock}`, [releaseId])).rows[0]
    if (!row) fail('NOT_FOUND', 'Distribution is unavailable', 404)
    assertContract('scope', row.scope)
    return row
  }
  async function request(tx: PoolClient, requestId: string, lock: 'SHARE' | 'UPDATE' = 'SHARE'): Promise<RequestRow> {
    const row = (await tx.query<RequestRow>(`SELECT * FROM distribution_reviews WHERE id=$1 FOR ${lock}`, [requestId])).rows[0]
    if (!row) fail('NOT_FOUND', 'Distribution request is unavailable', 404)
    return row
  }
  async function readAccess(tx: PoolClient, actor: HumanPrincipal, row: ReleaseRow) {
    try { await identity.requireOrgRole(actor, row.owner_org_id, ['admin'], tx); return }
    catch (error) { if (!(error instanceof IdentityError) || error.code !== 'FORBIDDEN') throw error }
    try { await identity.requireReviewAccess(actor, row.owner_org_id, undefined, tx) }
    catch (error) { if (!(error instanceof IdentityError) || error.code !== 'FORBIDDEN') throw error; fail('NOT_FOUND', 'Release is unavailable', 404) }
  }
  async function targets(tx: PoolClient, scope: DistributionScope): Promise<void> {
    if (scope.kind !== 'selected') return
    const orgs = await tx.query("SELECT id FROM organizations WHERE id=ANY($1::text[]) AND status='active' ORDER BY id FOR SHARE", [scope.organizationIds])
    const deployments = await tx.query(`SELECT d.id FROM deployments d JOIN organizations o ON o.id=d.organization_id
      WHERE d.id=ANY($1::text[]) AND d.status='active' AND o.status='active' ORDER BY d.id FOR SHARE OF d,o`, [scope.deploymentIds])
    if (orgs.rowCount !== scope.organizationIds.length || deployments.rowCount !== scope.deploymentIds.length) fail('DISTRIBUTION_TARGET_INVALID', 'Selected recipients must be active organizations or deployments')
  }
  function manifest(row: ReleaseRow): ReleaseManifest {
    const value = assertContract('release', row.signed_manifest?.manifest)
    if (value.releaseId !== row.id || value.packId !== row.pack_id || value.ownerOrgId !== row.owner_org_id || value.version !== row.version
      || value.approvedSubmissionId !== row.approved_submission_id) fail('RELEASE_INTEGRITY', 'Frozen release identity does not match its signed manifest', 409)
    return value
  }
  async function scopeAllowed(tx: PoolClient, row: ReleaseRow, scope: DistributionScope) {
    await targets(tx, scope)
    const frozen = manifest(row)
    try {
      await validateFrozenDependencies(tx, { ownerOrgId: row.owner_org_id, packId: row.pack_id, distribution: scope,
        dependencyLock: frozen.dependencyLock, builtinDependencies: frozen.builtinDependencies })
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      if (typeof code === 'string' && code.startsWith('DEPENDENCY_')) fail(code, 'The fixed dependency graph does not permit this distribution scope', 409)
      throw error
    }
  }
  async function audit(tx: PoolClient, actor: HumanPrincipal, row: ReleaseRow, action: string, objectKind: string, objectId: string, details: object) {
    await tx.query(`INSERT INTO audit_events(actor_kind,actor_id,organization_id,action,object_kind,object_id,outcome,details)
      VALUES ('human',$1,$2,$3,$4,$5,'succeeded',$6::jsonb)`, [actor.userId, row.owner_org_id, action, objectKind, objectId, canonicalJson(details)])
  }
  async function lockOperation(tx: PoolClient, actor: HumanPrincipal, operationKey: string): Promise<void> {
    if (typeof operationKey !== 'string' || !operationKey.trim() || operationKey.length > 200 || /[\u0000-\u001f\u007f]/.test(operationKey)) fail('INVALID_INPUT', 'A valid operation key is required')
    // Always precedes release/request/dependency row locks. If two different
    // requests accidentally reuse a key, the loser must not hold a dependency
    // row while waiting for the winner's operation lock.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [`human:${actor.userId}`, operationKey])
  }
  async function idempotent<T>(tx: PoolClient, actor: HumanPrincipal, operationKey: string, input: object, action: () => Promise<T>): Promise<T> {
    // Callers hold lockOperation and have checked live authorization in this
    // transaction. A forged or revoked principal can never read a cached result.
    const principalKey = `human:${actor.userId}`, fingerprint = sha256(canonicalJson(input))
    const old = (await tx.query<{ request_sha256: string; result: T }>('SELECT request_sha256,result FROM request_idempotency WHERE principal_key=$1 AND operation_key=$2', [principalKey, operationKey])).rows[0]
    if (old) { if (old.request_sha256 !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'Operation key identifies another request', 409); return old.result }
    const result = await action()
    await tx.query('INSERT INTO request_idempotency(principal_key,operation_key,request_sha256,result) VALUES ($1,$2,$3,$4::jsonb)', [principalKey, operationKey, fingerprint, canonicalJson(result)])
    return result
  }
  function published(row: ReleaseRow) { if (row.status !== 'published') fail('INVALID_TRANSITION', 'Only a published release permits this operation', 409) }
  function expected(actual: number, wanted: number) { if (actual !== wanted) fail('VERSION_CONFLICT', 'State changed; reload before deciding', 409) }

  return {
    async listOrganization(actor: HumanPrincipal, organizationId: string, input: GovernancePagination = {}) {
      human(actor); id(organizationId); const page = pagination(input)
      return database.transaction(async tx => {
        try { await identity.requireOrgRole(actor, organizationId, ['admin'], tx) }
        catch (error) {
          if (!(error instanceof IdentityError) || error.code !== 'FORBIDDEN') throw error
          await identity.requireReviewAccess(actor, organizationId, undefined, tx)
        }
        const rows = (await tx.query<ReleaseRow>(`SELECT r.* FROM releases r WHERE r.owner_org_id=$1
          AND ($2::text IS NULL OR r.id<$2) ORDER BY r.id DESC LIMIT $3 FOR SHARE OF r`, [organizationId, page.beforeId, page.limit])).rows
        const items = []
        for (const row of rows) items.push(releaseView(row, await distribution(tx, row.id)))
        return { items, nextCursor: rows.length === page.limit ? rows.at(-1)!.id : null }
      })
    },
    async get(actor: HumanPrincipal, releaseId: string): Promise<GovernanceReleaseView> {
      human(actor); id(releaseId)
      return database.transaction(async tx => {
        const row = await release(tx, releaseId); await readAccess(tx, actor, row)
        return releaseView(row, await distribution(tx, releaseId))
      })
    },
    async getRequest(actor: HumanPrincipal, requestId: string): Promise<DistributionRequestView> {
      human(actor); id(requestId)
      return database.transaction(async tx => {
        const locator = (await tx.query<{ release_id: string }>('SELECT release_id FROM distribution_reviews WHERE id=$1', [requestId])).rows[0]
        if (!locator) fail('NOT_FOUND', 'Distribution request is unavailable', 404)
        const parent = await release(tx, locator.release_id), row = await request(tx, requestId)
        await readAccess(tx, actor, parent); return requestView(row)
      })
    },
    async listReleaseRequests(actor: HumanPrincipal, releaseId: string, input: GovernancePagination = {}) {
      human(actor); id(releaseId); const page = pagination(input)
      return database.transaction(async tx => {
        const row = await release(tx, releaseId); await readAccess(tx, actor, row)
        const rows = (await tx.query<RequestRow>(`SELECT * FROM distribution_reviews WHERE release_id=$1 AND ($2::text IS NULL OR id<$2)
          ORDER BY id DESC LIMIT $3`, [releaseId, page.beforeId, page.limit])).rows
        return { items: rows.map(requestView), nextCursor: rows.length === page.limit ? rows.at(-1)!.id : null }
      })
    },
    async listReviewQueue(actor: HumanPrincipal, organizationId: string, input: GovernanceQueueOptions = {}) {
      human(actor); id(organizationId)
      const value = capture(input, ['limit', 'beforeId', 'status']), { status = 'pending_review', ...pageInput } = value, page = pagination(pageInput)
      if (!['pending_review', 'approved', 'rejected', 'withdrawn'].includes(status)) fail('INVALID_INPUT', 'Invalid queue status')
      return database.transaction(async tx => {
        await identity.requireReviewAccess(actor, organizationId, undefined, tx)
        const rows = (await tx.query<RequestRow>(`SELECT q.* FROM distribution_reviews q JOIN releases r ON r.id=q.release_id
          WHERE r.owner_org_id=$1 AND q.status=$2 AND ($3::text IS NULL OR q.id<$3) ORDER BY q.id DESC LIMIT $4`,
        [organizationId, status, page.beforeId, page.limit])).rows
        return { items: rows.map(requestView), nextCursor: rows.length === page.limit ? rows.at(-1)!.id : null }
      })
    },
    async yank(actor: HumanPrincipal, releaseId: string, input: { expectedVersion: number; reason: string }, operationKey: string): Promise<GovernanceReleaseView> {
      human(actor); id(releaseId); const value = capture(input, ['expectedVersion', 'reason']); version(value.expectedVersion); text(value.reason)
      return database.transaction(async tx => {
        await lockOperation(tx, actor, operationKey)
        const row = await release(tx, releaseId, 'UPDATE'); await identity.requireOrgRole(actor, row.owner_org_id, ['admin'], tx)
        return idempotent(tx, actor, operationKey, { action: 'release.yank', releaseId, ...value }, async () => {
          expected(row.state_version, value.expectedVersion); published(row)
          const updated = (await tx.query<ReleaseRow>(`UPDATE releases SET status='yanked',state_version=state_version+1,
            yank_reason=$2,yanked_at=clock_timestamp() WHERE id=$1 RETURNING *`, [releaseId, value.reason])).rows[0]!
          await audit(tx, actor, row, 'release.yanked', 'release', releaseId, { reason: value.reason, previousStateVersion: row.state_version })
          return releaseView(updated, await distribution(tx, releaseId))
        })
      })
    },
    async requestDistribution(actor: HumanPrincipal, releaseId: string, input: { expectedVersion: number; scope: DistributionScope; reason: string }, operationKey: string): Promise<DistributionRequestView> {
      human(actor); id(releaseId); const value = capture(input, ['expectedVersion', 'scope', 'reason'])
      version(value.expectedVersion); text(value.reason); assertContract('scope', value.scope)
      return database.transaction(async tx => {
        await lockOperation(tx, actor, operationKey)
        const row = await release(tx, releaseId, 'UPDATE'); await identity.requireOrgRole(actor, row.owner_org_id, ['admin'], tx)
        return idempotent(tx, actor, operationKey, { action: 'distribution.request', releaseId, ...value }, async () => {
          published(row); const current = await distribution(tx, releaseId, 'UPDATE'); expected(current.state_version, value.expectedVersion)
          if (canonicalJson(current.scope) === canonicalJson(value.scope)) fail('DISTRIBUTION_UNCHANGED', 'The proposed distribution scope is unchanged', 409)
          await scopeAllowed(tx, row, value.scope)
          const created = (await tx.query<RequestRow>(`INSERT INTO distribution_reviews(id,release_id,requested_by,requested_scope,expected_state_version,reason)
            VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING *`, [randomUUID(), releaseId, actor.userId, canonicalJson(value.scope), current.state_version, value.reason])).rows[0]!
          await audit(tx, actor, row, 'distribution.requested', 'distribution_request', created.id,
            { releaseId, previousScope: current.scope, proposedScope: value.scope, expectedDistributionVersion: current.state_version, reason: value.reason })
          return requestView(created)
        })
      })
    },
    async reviewDistribution(actor: HumanPrincipal, requestId: string, input: { expectedVersion: number; decision: 'approved' | 'rejected'; comment: string }, operationKey: string) {
      human(actor); id(requestId); const value = capture(input, ['expectedVersion', 'decision', 'comment'])
      version(value.expectedVersion); text(value.comment)
      if (!['approved', 'rejected'].includes(value.decision)) fail('INVALID_INPUT', 'Decision must be approved or rejected')
      return database.transaction(async tx => {
        await lockOperation(tx, actor, operationKey)
        // Unlocked lookup reveals no data to caller; lock release before review for
        // consistent ordering with management/read methods and competing decisions.
        const locator = (await tx.query<{ release_id: string }>('SELECT release_id FROM distribution_reviews WHERE id=$1', [requestId])).rows[0]
        if (!locator) fail('NOT_FOUND', 'Distribution request is unavailable', 404)
        const parent = await release(tx, locator.release_id, 'UPDATE'), row = await request(tx, requestId, 'UPDATE')
        await identity.requireReviewAccess(actor, parent.owner_org_id, row.requested_by, tx)
        return idempotent(tx, actor, operationKey, { action: 'distribution.review', requestId, ...value }, async () => {
          expected(row.state_version, value.expectedVersion)
          if (row.status !== 'pending_review') fail('INVALID_TRANSITION', 'This request has already been decided', 409)
          const current = await distribution(tx, parent.id, 'UPDATE')
          if (value.decision === 'approved') {
            published(parent); expected(current.state_version, row.expected_state_version)
            await scopeAllowed(tx, parent, row.requested_scope)
          }
          const updated = (await tx.query<RequestRow>(`UPDATE distribution_reviews SET status=$2,reviewed_by=$3,comment=$4,
            reviewed_at=clock_timestamp(),state_version=state_version+1 WHERE id=$1 RETURNING *`, [requestId, value.decision, actor.userId, value.comment])).rows[0]!
          const final = value.decision === 'approved' ? (await tx.query<DistributionRow>(`UPDATE release_distribution SET scope=$2::jsonb,
            state_version=state_version+1,updated_at=clock_timestamp() WHERE release_id=$1 RETURNING *`, [parent.id, canonicalJson(row.requested_scope)])).rows[0]! : current
          await audit(tx, actor, parent, `distribution.${value.decision}`, 'distribution_request', requestId,
            { releaseId: parent.id, requestedBy: row.requested_by, expectedDistributionVersion: row.expected_state_version,
              previousScope: current.scope, proposedScope: row.requested_scope, distributionVersion: final.state_version, comment: value.comment })
          return { request: requestView(updated), distribution: { scope: final.scope, stateVersion: final.state_version } }
        })
      })
    },
  }
}
