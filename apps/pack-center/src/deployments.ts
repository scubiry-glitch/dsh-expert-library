/** Human-managed deployment identity and read-only machine capabilities. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { canonicalJson } from '../../../packages/pack-contract/index.mjs'
import type { CenterDatabase } from './database.js'
import { IdentityError, type createIdentityService, type HumanPrincipal } from './auth.js'

type IdentityPort = Pick<ReturnType<typeof createIdentityService>, 'requireOrgRole'>
export type MachineScope = 'catalog:read' | 'release:download'
export interface MachinePrincipal {
  readonly kind: 'deployment'
  readonly deploymentId: string
  readonly organizationId: string
  readonly credentialId: string
  readonly scopes: readonly MachineScope[]
}
interface DeploymentRow extends QueryResultRow {
  id: string; organization_id: string; name: string; status: 'active' | 'disabled'
  created_by: string; created_at: Date; updated_at: Date; state_version: number
}
export class DeploymentError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message); this.name = 'DeploymentError'
  }
}
const scopes: readonly MachineScope[] = Object.freeze(['catalog:read', 'release:download'])
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const secret = (prefix: 'dpc_bind_' | 'dpc_token_') => `${prefix}${randomBytes(32).toString('base64url')}`
function id(value: unknown, name = 'identifier'): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || value.includes('..') || ['constructor', 'prototype', '__proto__'].includes(value)) {
    throw new DeploymentError('INVALID_INPUT', `${name} is invalid`)
  }
}
function human(actor: HumanPrincipal) {
  if (!actor || actor.kind !== 'human') throw new DeploymentError('HUMAN_REQUIRED', 'A human administrator session is required', 403)
  id(actor.userId)
}
function interval(value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new DeploymentError('INVALID_INPUT', 'Invalid expiry interval')
  return value
}
function inputObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DeploymentError('INVALID_INPUT', 'A request object is required')
}
function view(row: DeploymentRow) {
  return { id: row.id, organizationId: row.organization_id, name: row.name, status: row.status,
    stateVersion: row.state_version, createdBy: row.created_by, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }
}
function unauthorized(): never { throw new DeploymentError('UNAUTHENTICATED', 'Deployment credential is unavailable', 401) }

export function createDeploymentService(options: {
  database: CenterDatabase; identity: IdentityPort; centerId: string; credentialTtlMs?: number
}) {
  const { database, identity, centerId } = options
  id(centerId, 'centerId')
  const credentialTtlMs = interval(options.credentialTtlMs ?? 30 * 86400000, 1000, 365 * 86400000)
  const authenticated = new WeakMap<MachinePrincipal, string>()

  async function deployment(client: PoolClient, deploymentId: string, lock = false): Promise<DeploymentRow> {
    const row = (await client.query<DeploymentRow>(`SELECT * FROM deployments WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [deploymentId])).rows[0]
    if (!row) throw new DeploymentError('NOT_FOUND', 'Deployment was not found', 404)
    return row
  }
  async function admin(client: PoolClient, actor: HumanPrincipal, deploymentId: string) {
    const row = await deployment(client, deploymentId)
    try { await identity.requireOrgRole(actor, row.organization_id, ['admin'], client) }
    catch (error) {
      // Administrative IDs are private too: a foreign existing deployment must
      // be indistinguishable from an unknown one. Preserve expired/revoked
      // authentication and operational errors instead of hiding every failure.
      if (error instanceof IdentityError && error.code === 'FORBIDDEN') throw new DeploymentError('NOT_FOUND', 'Deployment was not found', 404)
      throw error
    }
    return row
  }
  async function audit(client: PoolClient, actor: HumanPrincipal | MachinePrincipal, row: DeploymentRow, action: string, details: object = {}) {
    await client.query(`INSERT INTO audit_events(actor_kind,actor_id,organization_id,action,object_kind,object_id,outcome,details)
      VALUES ($1,$2,$3,$4,'deployment',$5,'succeeded',$6::jsonb)`, [actor.kind,
    actor.kind === 'human' ? actor.userId : actor.deploymentId, row.organization_id, action, row.id, canonicalJson(details)])
  }
  async function idempotent<T>(client: PoolClient, actor: HumanPrincipal, operationKey: string, request: object, action: () => Promise<T>): Promise<T> {
    if (typeof operationKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationKey)) throw new DeploymentError('INVALID_INPUT', 'An operation key is required')
    const principalKey = `human:${actor.userId}`
    const requestSha256 = digest(canonicalJson(request))
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [principalKey, operationKey])
    const prior = (await client.query('SELECT request_sha256,result FROM request_idempotency WHERE principal_key=$1 AND operation_key=$2', [principalKey, operationKey])).rows[0]
    if (prior) {
      if (prior.request_sha256 !== requestSha256) throw new DeploymentError('IDEMPOTENCY_CONFLICT', 'Operation key was used for a different request', 409)
      return prior.result as T
    }
    const result = await action()
    await client.query('INSERT INTO request_idempotency(principal_key,operation_key,request_sha256,result) VALUES ($1,$2,$3,$4::jsonb)', [principalKey, operationKey, requestSha256, canonicalJson(result)])
    return result
  }
  /** Always lock organization -> deployment -> credential, also for revocation. */
  async function machineFor(tokenHash: string, client: PoolClient): Promise<MachinePrincipal> {
    const locator = (await client.query(`SELECT c.id,c.deployment_id,d.organization_id FROM deployment_credentials c JOIN deployments d ON d.id=c.deployment_id WHERE c.token_sha256=$1`, [tokenHash])).rows[0]
    if (!locator) unauthorized()
    const organization = (await client.query(`SELECT id FROM organizations WHERE id=$1 AND status='active' FOR SHARE`, [locator.organization_id])).rows[0]
    if (!organization) unauthorized()
    const point = (await client.query(`SELECT id FROM deployments WHERE id=$1 AND organization_id=$2 AND status='active' FOR SHARE`, [locator.deployment_id, locator.organization_id])).rows[0]
    if (!point) unauthorized()
    const credential = (await client.query(`SELECT id,scopes FROM deployment_credentials WHERE id=$1 AND deployment_id=$2 AND token_sha256=$3
      AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR SHARE`, [locator.id, locator.deployment_id, tokenHash])).rows[0]
    if (!credential || !Array.isArray(credential.scopes) || !credential.scopes.length || credential.scopes.some((scope: unknown) => !scopes.includes(scope as MachineScope))) unauthorized()
    const result: MachinePrincipal = Object.freeze({ kind: 'deployment', deploymentId: locator.deployment_id,
      organizationId: locator.organization_id, credentialId: credential.id, scopes: Object.freeze([...credential.scopes]) })
    authenticated.set(result, tokenHash)
    return result
  }

  return {
    async create(actor: HumanPrincipal, input: { organizationId: string; name: string }, operationKey: string) {
      human(actor); inputObject(input)
      const { organizationId, name } = input
      id(organizationId, 'organizationId')
      if (Object.keys(input).some(key => !['organizationId', 'name'].includes(key)) || typeof name !== 'string' || !name.trim() || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) throw new DeploymentError('INVALID_INPUT', 'Deployment name is invalid')
      return database.transaction(async client => {
        await identity.requireOrgRole(actor, organizationId, ['admin'], client)
        return idempotent(client, actor, operationKey, { operation: 'deployment.create', organizationId, name }, async () => {
          const row = (await client.query<DeploymentRow>('INSERT INTO deployments(id,organization_id,name,created_by) VALUES ($1,$2,$3,$4) RETURNING *', [randomUUID(), organizationId, name, actor.userId])).rows[0]!
          await audit(client, actor, row, 'deployment_created')
          return view(row)
        })
      })
    },
    async list(actor: HumanPrincipal, organizationId: string, input: { limit?: number; beforeId?: string } = {}) {
      human(actor); id(organizationId, 'organizationId'); inputObject(input)
      if (Object.keys(input).some(key => !['limit', 'beforeId'].includes(key))) throw new DeploymentError('INVALID_INPUT', 'Unknown pagination option')
      const limit = interval(input.limit ?? 50, 1, 100)
      const beforeId = input.beforeId ?? null
      if (beforeId !== null) id(beforeId, 'beforeId')
      return database.transaction(async client => {
        await identity.requireOrgRole(actor, organizationId, ['admin'], client)
        const rows = (await client.query<DeploymentRow>(`SELECT * FROM deployments WHERE organization_id=$1 AND ($2::text IS NULL OR id<$2) ORDER BY id DESC LIMIT $3`, [organizationId, beforeId, limit])).rows
        return { deployments: rows.map(view), nextCursor: rows.length === limit ? rows.at(-1)!.id : null }
      })
    },
    async get(actor: HumanPrincipal, deploymentId: string) {
      human(actor); id(deploymentId, 'deploymentId')
      return database.transaction(async client => {
        await admin(client, actor, deploymentId)
        // A coherent management receipt: disable/rebind cannot interleave while
        // credential and binding metadata are being read for this deployment.
        const row = (await client.query<DeploymentRow>('SELECT * FROM deployments WHERE id=$1 FOR SHARE', [deploymentId])).rows[0]!
        // Hashes are authentication material and never reach management views.
        const credentials = (await client.query(`SELECT id,scopes,expires_at AS "expiresAt",revoked_at AS "revokedAt",created_at AS "createdAt"
          FROM deployment_credentials WHERE deployment_id=$1 ORDER BY created_at DESC,id DESC`, [deploymentId])).rows
        const bindingCodes = (await client.query(`SELECT id,expires_at AS "expiresAt",consumed_at AS "consumedAt",revoked_at AS "revokedAt",created_at AS "createdAt"
          FROM deployment_binding_codes WHERE deployment_id=$1 ORDER BY created_at DESC,id DESC`, [deploymentId])).rows
        return { deployment: view(row), credentials, bindingCodes }
      })
    },
    /** Secret issuance is deliberately NOT idempotent; reissue revokes older unconsumed codes. */
    async issueBindingCode(actor: HumanPrincipal, deploymentId: string, input: { expiresInMs?: number } = {}) {
      human(actor); id(deploymentId, 'deploymentId'); inputObject(input)
      const expiresInMs = interval(input.expiresInMs ?? 600000, 1000, 900000)
      if (Object.keys(input).some(key => key !== 'expiresInMs')) throw new DeploymentError('INVALID_INPUT', 'Unknown binding code option')
      return database.transaction(async client => {
        await admin(client, actor, deploymentId)
        const row = await deployment(client, deploymentId, true)
        if (row.status !== 'active') throw new DeploymentError('DEPLOYMENT_DISABLED', 'Deployment is disabled', 409)
        const bindingCodeId = randomUUID(); const bindingCode = secret('dpc_bind_')
        await client.query(`UPDATE deployment_binding_codes SET revoked_at=clock_timestamp() WHERE deployment_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL`, [deploymentId])
        const issued = (await client.query(`INSERT INTO deployment_binding_codes(id,deployment_id,code_sha256,created_by,expires_at)
          VALUES ($1,$2,$3,$4,clock_timestamp()+($5::bigint * interval '1 millisecond')) RETURNING expires_at`, [bindingCodeId, deploymentId, digest(bindingCode), actor.userId, expiresInMs])).rows[0]!
        await audit(client, actor, row, 'deployment_binding_issued', { bindingCodeId })
        return { centerId, deploymentId, bindingCodeId, bindingCode, expiresAt: issued.expires_at.toISOString() }
      })
    },
    /** No replay returns a token: lost responses require a fresh code and optional credential revocation. */
    async exchange(input: { bindingCode: string }) {
      const bindingCode = input?.bindingCode
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'bindingCode') || typeof bindingCode !== 'string' || !/^dpc_bind_[A-Za-z0-9_-]{43}$/.test(bindingCode)) throw new DeploymentError('BINDING_CODE_INVALID', 'Binding code is unavailable', 401)
      const hash = digest(bindingCode)
      return database.transaction(async client => {
        const locator = (await client.query(`SELECT b.deployment_id,d.organization_id FROM deployment_binding_codes b JOIN deployments d ON d.id=b.deployment_id WHERE b.code_sha256=$1`, [hash])).rows[0]
        if (!locator) throw new DeploymentError('BINDING_CODE_INVALID', 'Binding code is unavailable', 401)
        const organization = (await client.query(`SELECT id FROM organizations WHERE id=$1 AND status='active' FOR SHARE`, [locator.organization_id])).rows[0]
        if (!organization) throw new DeploymentError('BINDING_CODE_INVALID', 'Binding code is unavailable', 401)
        const row = await deployment(client, locator.deployment_id, true)
        const code = (await client.query(`SELECT id FROM deployment_binding_codes WHERE code_sha256=$1 AND deployment_id=$2 AND consumed_at IS NULL
          AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`, [hash, row.id])).rows[0]
        if (row.status !== 'active' || !code) throw new DeploymentError('BINDING_CODE_INVALID', 'Binding code is unavailable', 401)
        const credentialId = randomUUID(); const credentialToken = secret('dpc_token_')
        const credential = (await client.query(`INSERT INTO deployment_credentials(id,deployment_id,token_sha256,scopes,expires_at)
          VALUES ($1,$2,$3,$4,clock_timestamp()+($5::bigint * interval '1 millisecond')) RETURNING expires_at`, [credentialId, row.id, digest(credentialToken), [...scopes], credentialTtlMs])).rows[0]!
        await client.query('UPDATE deployment_binding_codes SET consumed_at=clock_timestamp() WHERE id=$1', [code.id])
        await audit(client, { kind: 'deployment', deploymentId: row.id, organizationId: row.organization_id, credentialId, scopes }, row, 'deployment_bound', { bindingCodeId: code.id, credentialId })
        return { centerId, deployment: view(row), credential: { id: credentialId, scopes: [...scopes], expiresAt: credential.expires_at.toISOString() }, credentialToken }
      })
    },
    async authenticateToken(token: string, client?: PoolClient): Promise<MachinePrincipal> {
      if (typeof token !== 'string' || !/^dpc_token_[A-Za-z0-9_-]{43}$/.test(token)) unauthorized()
      const hash = digest(token)
      return client ? machineFor(hash, client) : database.transaction(tx => machineFor(hash, tx))
    },
    async requireScope(principal: MachinePrincipal, scope: MachineScope, client?: PoolClient): Promise<MachinePrincipal> {
      const hash = authenticated.get(principal)
      if (!hash || principal.kind !== 'deployment') unauthorized()
      if (!scopes.includes(scope)) throw new DeploymentError('FORBIDDEN', 'Machine credentials are read-only', 403)
      const check = async (tx: PoolClient) => {
        const fresh = await machineFor(hash, tx)
        if (!fresh.scopes.includes(scope)) throw new DeploymentError('FORBIDDEN', 'Credential does not allow this operation', 403)
        return fresh
      }
      return client ? check(client) : database.transaction(check)
    },
    async revokeBindingCode(actor: HumanPrincipal, deploymentId: string, bindingCodeId: string, operationKey: string) {
      human(actor); id(deploymentId, 'deploymentId'); id(bindingCodeId, 'bindingCodeId')
      return database.transaction(async client => {
        await admin(client, actor, deploymentId)
        return idempotent(client, actor, operationKey, { operation: 'deployment.revokeBindingCode', deploymentId, bindingCodeId }, async () => {
          const row = await deployment(client, deploymentId, true)
          const result = (await client.query(`UPDATE deployment_binding_codes SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND deployment_id=$2 RETURNING id,revoked_at`, [bindingCodeId, deploymentId])).rows[0]
          if (!result) throw new DeploymentError('NOT_FOUND', 'Binding code was not found', 404)
          await audit(client, actor, row, 'deployment_binding_revoked', { bindingCodeId })
          return { bindingCodeId, revokedAt: result.revoked_at.toISOString() }
        })
      })
    },
    async revokeCredential(actor: HumanPrincipal, deploymentId: string, credentialId: string, operationKey: string) {
      human(actor); id(deploymentId, 'deploymentId'); id(credentialId, 'credentialId')
      return database.transaction(async client => {
        await admin(client, actor, deploymentId)
        return idempotent(client, actor, operationKey, { operation: 'deployment.revokeCredential', deploymentId, credentialId }, async () => {
          const row = await deployment(client, deploymentId, true)
          const result = (await client.query(`UPDATE deployment_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND deployment_id=$2 RETURNING id,revoked_at`, [credentialId, deploymentId])).rows[0]
          if (!result) throw new DeploymentError('NOT_FOUND', 'Credential was not found', 404)
          await audit(client, actor, row, 'deployment_credential_revoked', { credentialId })
          return { credentialId, revokedAt: result.revoked_at.toISOString() }
        })
      })
    },
    async setStatus(actor: HumanPrincipal, deploymentId: string, input: { status: 'active' | 'disabled'; expectedVersion: number }, operationKey: string) {
      human(actor); id(deploymentId, 'deploymentId'); inputObject(input)
      const { status, expectedVersion } = input
      if (Object.keys(input).some(key => !['status', 'expectedVersion'].includes(key)) || !['active', 'disabled'].includes(status) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new DeploymentError('INVALID_INPUT', 'Invalid status or state version')
      return database.transaction(async client => {
        await admin(client, actor, deploymentId)
        return idempotent(client, actor, operationKey, { operation: 'deployment.setStatus', deploymentId, status, expectedVersion }, async () => {
          const row = await deployment(client, deploymentId, true)
          if (row.state_version !== expectedVersion) throw new DeploymentError('STATE_CONFLICT', 'Deployment state has changed; reload before retrying', 409)
          const updated = (await client.query<DeploymentRow>(`UPDATE deployments SET status=$2,state_version=state_version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [deploymentId, status])).rows[0]!
          if (status === 'disabled') {
            await client.query('UPDATE deployment_credentials SET revoked_at=clock_timestamp() WHERE deployment_id=$1 AND revoked_at IS NULL', [deploymentId])
            await client.query('UPDATE deployment_binding_codes SET revoked_at=clock_timestamp() WHERE deployment_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL', [deploymentId])
          }
          await audit(client, actor, updated, 'deployment_status_changed', { status, stateVersion: updated.state_version })
          return view(updated)
        })
      })
    },
  }
}
