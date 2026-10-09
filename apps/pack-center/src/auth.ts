import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import type { CenterDatabase } from './database.js'
import { createOidcClient, IdentityError, type OidcConfig } from './oidc.js'
export { IdentityError } from './oidc.js'

/** Organization membership is functional only: tenant administration,
 * review participation, or plain membership. Creation authority lives in
 * pack_ownerships and review reach in review_scopes. */
export type OrganizationRole = 'admin' | 'reviewer' | 'member'
export type PackRole = 'owner' | 'maintainer'
export interface HumanPrincipal {
  kind: 'human'
  userId: string
  displayName: string
  platformAdmin: boolean
  /** Account-level creation capability: may create packs and be granted
   * pack_ownerships. Per-pack write authority still lives there. */
  developer: boolean
  memberships: { organizationId: string; roles: OrganizationRole[] }[]
  reviewScopes: string[]
}
export interface IdentityConfig {
  database: CenterDatabase
  oidc: OidcConfig
  loginEncryptionKey: Uint8Array
  sessionTtlMs?: number
  loginTtlMs?: number
}
interface Db { query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> }
type UserRow = QueryResultRow & { id: string; display_name: string; platform_admin: boolean; status: string }
const allRoles: OrganizationRole[] = ['admin', 'reviewer', 'member']
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const token = () => randomBytes(32).toString('base64url')
function equal(a: string, b: string) { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right) }
function string(value: string, name: string, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new IdentityError('INVALID_INPUT', `${name} is invalid`, 400)
  return value
}
function id(value: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || value.includes('..')) throw new IdentityError('INVALID_INPUT', 'Invalid identifier', 400)
  return value
}
function roles(value: OrganizationRole[]) {
  if (!Array.isArray(value) || !value.length || value.some(role => !allRoles.includes(role)) || new Set(value).size !== value.length) throw new IdentityError('INVALID_INPUT', 'Invalid roles', 400)
  return value
}
function ttl(value: number, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new IdentityError('INVALID_INPUT', 'Invalid expiry interval', 400)
  return value
}
function secret(value: string | undefined) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new IdentityError('UNAUTHENTICATED', 'Authentication is required', 401); return value }
async function audit(db: Db, actorId: string, action: string, objectKind: string, objectId: string, organizationId?: string) {
  await db.query(`INSERT INTO audit_events(actor_kind,actor_id,organization_id,action,object_kind,object_id,outcome)
    VALUES ('human',$1,$2,$3,$4,$5,'succeeded')`, [actorId, organizationId ?? null, action, objectKind, objectId])
}
/** Shared actor/key operation lock namespace with submissions and deployments:
 * take this before any business row locks. */
async function lockIdentityOperation(client: PoolClient, principal: HumanPrincipal, operationKey: string) {
  if (typeof operationKey !== 'string' || !operationKey.trim() || operationKey.length > 200 || /[\u0000-\u001f\u007f]/.test(operationKey)) throw new IdentityError('INVALID_INPUT', 'Idempotency key is invalid', 400)
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [`human:${principal.userId}`, operationKey])
}
async function idempotentIdentity<T>(client: PoolClient, principal: HumanPrincipal, operationKey: string, request: object, action: () => Promise<T>): Promise<T> {
  const principalKey = `human:${principal.userId}`
  const fingerprint = createHash('sha256').update(canonicalIdentityJson(request)).digest('hex')
  const existing = (await client.query<{ request_sha256: string; result: T }>('SELECT request_sha256,result FROM request_idempotency WHERE principal_key=$1 AND operation_key=$2', [principalKey, operationKey])).rows[0]
  if (existing) {
    if (existing.request_sha256 !== fingerprint) throw new IdentityError('IDEMPOTENCY_CONFLICT', 'Idempotency key identifies another request', 409)
    return existing.result
  }
  const result = await action()
  await client.query('INSERT INTO request_idempotency(principal_key,operation_key,request_sha256,result) VALUES ($1,$2,$3,$4::jsonb)',
    [principalKey, operationKey, fingerprint, JSON.stringify(result)])
  return result
}
/** Deterministic JSON for idempotency fingerprints; objects only at the top level. */
function canonicalIdentityJson(value: object): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalIdentityJson(item as object)).join(',')}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${typeof (value as Record<string, unknown>)[key] === 'object' && (value as Record<string, unknown>)[key] !== null ? canonicalIdentityJson((value as Record<string, unknown>)[key] as object) : JSON.stringify((value as Record<string, unknown>)[key])}`).join(',')}}`
}

export function createIdentityService(options: IdentityConfig) {
  const db = options.database
  const oidc = createOidcClient(options.oidc)
  const key = Buffer.from(options.loginEncryptionKey)
  if (key.length !== 32) throw new IdentityError('IDENTITY_CONFIG_INVALID', 'Login encryption requires a 32-byte key', 500)
  const sessionTtl = ttl(options.sessionTtlMs ?? 28800000, 1000, 604800000)
  const loginTtl = ttl(options.loginTtlMs ?? 600000, 1000, 900000)
  // Principal objects are capabilities issued only by this service instance.
  // A request must not forge a userId or carry authorization cached in the cookie.
  const authenticated = new WeakMap<HumanPrincipal, string>()

  async function principalFor(userId: string, connection: Db): Promise<HumanPrincipal> {
    const user = (await connection.query<UserRow>(`SELECT id,display_name,platform_admin,developer,status FROM users WHERE id=$1`, [userId])).rows[0]
    if (!user || user.status !== 'active') throw new IdentityError('UNAUTHENTICATED', 'Account is unavailable', 401)
    const memberships = (await connection.query<{ organization_id: string; roles: OrganizationRole[] }>(`SELECT m.organization_id,m.roles FROM memberships m
      JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 AND m.status='active' AND o.status='active' ORDER BY m.organization_id`, [userId])).rows
    if (!user.platform_admin && !memberships.length) throw new IdentityError('INVITATION_REQUIRED', 'An active organization membership is required')
    const scopes = (await connection.query<{ organization_id: string }>(`SELECT r.organization_id FROM review_scopes r JOIN organizations o ON o.id=r.organization_id
      WHERE r.reviewer_id=$1 AND o.status='active' ORDER BY r.organization_id`, [userId])).rows
    return { kind: 'human', userId: user.id, displayName: user.display_name, platformAdmin: user.platform_admin, developer: user.developer === true,
      memberships: memberships.map(row => ({ organizationId: row.organization_id, roles: row.roles })), reviewScopes: scopes.map(row => row.organization_id) }
  }
  async function refresh(principal: HumanPrincipal, client?: PoolClient): Promise<HumanPrincipal> {
    const hash = authenticated.get(principal)
    if (!hash) throw new IdentityError('UNAUTHENTICATED', 'A current authenticated session is required', 401)
    const connection: Db = client ?? db
    // FOR SHARE keeps status/role/session writers behind a business transaction
    // whose authorization decision has already been made. No stale cached roles.
    const row = (await connection.query(`SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_sha256=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.status='active'
      ${client ? 'FOR SHARE OF s,u' : ''}`, [hash, principal.userId])).rows[0]
    if (!row) throw new IdentityError('UNAUTHENTICATED', 'Session is expired or revoked', 401)
    if (client) {
      await client.query(`SELECT m.user_id FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 FOR SHARE OF m,o`, [principal.userId])
      await client.query('SELECT reviewer_id FROM review_scopes WHERE reviewer_id=$1 FOR SHARE', [principal.userId])
    }
    const fresh = await principalFor(principal.userId, connection)
    authenticated.set(fresh, hash)
    return fresh
  }
  async function requireAdmin(principal: HumanPrincipal, client?: PoolClient) {
    const fresh = await refresh(principal, client)
    if (!fresh.platformAdmin) throw new IdentityError('FORBIDDEN', 'Platform administrator permission is required')
    return fresh
  }
  async function requireOrgRole(principal: HumanPrincipal, organizationId: string, permitted: OrganizationRole[], client?: PoolClient) {
    id(organizationId); roles(permitted)
    const fresh = await refresh(principal, client)
    const connection: Db = client ?? db
    const organization = (await connection.query(`SELECT id FROM organizations WHERE id=$1 AND status='active' ${client ? 'FOR SHARE' : ''}`, [organizationId])).rows[0]
    if (!organization || (!fresh.platformAdmin && !fresh.memberships.some(member => member.organizationId === organizationId && member.roles.some(role => permitted.includes(role))))) throw new IdentityError('FORBIDDEN', 'Organization permission is required')
    return fresh
  }
  async function requireReviewAccess(principal: HumanPrincipal, organizationId: string, authorId?: string,
    client?: PoolClient, options: { adminSelfReview?: boolean } = {}) {
    id(organizationId)
    const fresh = await refresh(principal, client)
    // Self-review stays denied for ordinary reviewers, but the platform
    // administrator and the owning tenant's admin may review their own
    // submissions: accountability comes from the audit trail, and no other
    // reviewer may exist (single-reviewer tenants, emergency fixes). Governance
    // approvals pass adminSelfReview:false: widening distribution is an
    // expansion of download authority and always demands an independent decider.
    const adminSelfReview = options.adminSelfReview !== false
    const isTenantAdmin = fresh.memberships.some(member => member.organizationId === organizationId && member.roles.includes('admin'))
    const selfReview = authorId === fresh.userId
    if (selfReview && !(adminSelfReview && (fresh.platformAdmin || isTenantAdmin))) {
      throw new IdentityError('SELF_REVIEW_DENIED', 'An author cannot review their own submission')
    }
    const connection: Db = client ?? db
    const target = (await connection.query(`SELECT id FROM organizations WHERE id=$1 AND status='active' ${client ? 'FOR SHARE' : ''}`, [organizationId])).rows[0]
    // Administrators (platform, or the owning tenant's admin) hold full review
    // authority, including self-review; no scope assignment is required.
    const tenantAdmin = !!target && fresh.memberships.some(member => member.organizationId === organizationId && member.roles.includes('admin'))
    if (adminSelfReview ? (fresh.platformAdmin || tenantAdmin) : false) return fresh
    if (!target || !fresh.reviewScopes.includes(organizationId) || !fresh.memberships.some(member => member.roles.includes('reviewer'))) throw new IdentityError('FORBIDDEN', 'An assigned review scope and reviewer role are required')
    return fresh
  }
  /** Creation axis: pack management authority comes from pack_ownerships, not
   * from organization membership. A disabled user never passes (refresh). */
  async function requirePackRole(principal: HumanPrincipal, packId: string, permitted: PackRole[], client?: PoolClient) {
    id(packId)
    if (!Array.isArray(permitted) || !permitted.length || permitted.some(role => !['owner', 'maintainer'].includes(role))) throw new IdentityError('INVALID_INPUT', 'Invalid pack roles', 400)
    const fresh = await refresh(principal, client)
    const connection: Db = client ?? db
    if (!fresh.platformAdmin) {
      const owned = (await connection.query(`SELECT 1 FROM pack_ownerships po
        JOIN users u ON u.id=po.user_id WHERE po.pack_id=$1 AND po.user_id=$2 AND po.role=ANY($3::text[])
        AND u.status='active' ${client ? 'FOR SHARE OF po,u' : ''}`, [packId, fresh.userId, permitted])).rows[0]
      if (!owned) throw new IdentityError('FORBIDDEN', 'Pack ownership is required')
    }
    return fresh
  }
  function encrypt(payload: object, stateHash: string) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(stateHash))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
    return `v1.${iv.toString('base64url')}.${encrypted.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`
  }
  function decrypt(value: string, stateHash: string): { verifier: string; nonce: string } {
    try {
      const [version, iv, encrypted, tag, extra] = value.split('.')
      if (version !== 'v1' || !iv || !encrypted || !tag || extra) throw new Error('Invalid envelope')
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
      decipher.setAAD(Buffer.from(stateHash)); decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      const result = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8'))
      secret(result.verifier); secret(result.nonce)
      return result
    } catch { throw new IdentityError('OIDC_LOGIN_FAILED', 'Login attempt could not be verified', 401) }
  }

  return {
    requireOrgRole, requireReviewAccess, requireAdmin, requireSession: refresh, requirePackRole,
    /** OFFLINE operator command only. Must never be exposed as an HTTP route. */
    async bootstrapAdmin(input: { issuer: string; subject: string; displayName: string }) {
      if (input.issuer !== oidc.issuer) throw new IdentityError('INVALID_INPUT', 'Bootstrap issuer must exactly match configured OIDC issuer', 400)
      string(input.subject, 'subject', 512); string(input.displayName, 'displayName')
      return db.transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()),hashtext('identity-bootstrap'))")
        const existing = (await client.query<UserRow & { oidc_subject: string; oidc_issuer: string }>('SELECT * FROM users WHERE platform_admin=true')).rows
        if (existing.length) {
          const same = existing.find(user => user.oidc_issuer === input.issuer && user.oidc_subject === input.subject && user.status === 'active')
          if (same) return { userId: same.id, created: false }
          throw new IdentityError('BOOTSTRAP_ALREADY_COMPLETED', 'An administrator is already configured', 409)
        }
        const userId = randomUUID()
        await client.query(`INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,platform_admin) VALUES ($1,$2,$3,$4,true)`, [userId, input.issuer, input.subject, input.displayName])
        await audit(client, userId, 'administrator_bootstrapped', 'user', userId)
        return { userId, created: true }
      })
    },
    async beginLogin(input: { invitationToken?: string } = {}) {
      const state = token(); const nonce = token(); const verifier = token(); const loginCookie = token()
      const authorizationUrl = await oidc.authorizationUrl({ state, nonce, verifier })
      const expiresAt = new Date(Date.now() + loginTtl)
      await db.transaction(async client => {
        let invitationId: string | null = null
        if (input.invitationToken !== undefined) {
          secret(input.invitationToken)
          const invitation = (await client.query(`SELECT i.id FROM invitations i JOIN organizations o ON o.id=i.organization_id
            WHERE i.token_sha256=$1 AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at>clock_timestamp() AND o.status='active' FOR SHARE OF i,o`, [digest(input.invitationToken)])).rows[0]
          if (!invitation) throw new IdentityError('INVITATION_INVALID', 'Invitation is unavailable', 403)
          invitationId = invitation.id
        }
        await client.query(`INSERT INTO oidc_login_attempts(state_sha256,nonce_sha256,encrypted_verifier,invitation_id,expires_at,browser_sha256)
          VALUES ($1,$2,$3,$4,$5,$6)`, [digest(state), digest(nonce), encrypt({ nonce, verifier }, digest(state)), invitationId, expiresAt, digest(loginCookie)])
      })
      return { authorizationUrl, loginCookie, expiresAt }
    },
    async finishLogin(input: { callbackUrl: string; loginCookie: string }) {
      secret(input.loginCookie)
      let state: string
      try {
        const callback = new URL(input.callbackUrl)
        if (callback.searchParams.getAll('state').length !== 1) throw new Error('Invalid state')
        state = secret(callback.searchParams.get('state') ?? undefined)
      } catch { throw new IdentityError('OIDC_LOGIN_FAILED', 'Login callback state is invalid', 401) }
      // Consume in a committed statement BEFORE token network I/O. A failed code
      // exchange requires a new login; concurrency/replay cannot mint sessions.
      const attempt = (await db.query(`UPDATE oidc_login_attempts SET consumed_at=clock_timestamp()
        WHERE state_sha256=$1 AND browser_sha256=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING *`, [digest(state), digest(input.loginCookie)])).rows[0]
      if (!attempt) throw new IdentityError('OIDC_LOGIN_FAILED', 'Login attempt is expired, consumed or belongs to another browser', 401)
      const material = decrypt(attempt.encrypted_verifier, digest(state))
      if (!equal(digest(material.nonce), attempt.nonce_sha256)) throw new IdentityError('OIDC_LOGIN_FAILED', 'Login nonce is invalid', 401)
      const identity = await oidc.finish({ callbackUrl: input.callbackUrl, state, ...material })
      return db.transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [identity.issuer, identity.subject])
        let user = (await client.query<UserRow>(`SELECT * FROM users WHERE oidc_issuer=$1 AND oidc_subject=$2 FOR UPDATE`, [identity.issuer, identity.subject])).rows[0]
        if (user?.status === 'disabled') throw new IdentityError('ACCOUNT_DISABLED', 'Account is disabled')
        if (attempt.invitation_id) {
          const invitation = (await client.query(`SELECT i.* FROM invitations i JOIN organizations o ON o.id=i.organization_id
            WHERE i.id=$1 AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at>clock_timestamp() AND o.status='active' FOR UPDATE OF i FOR SHARE OF o`, [attempt.invitation_id])).rows[0]
          if (!invitation) throw new IdentityError('INVITATION_INVALID', 'Invitation is unavailable')
          if (!user) {
            user = (await client.query<UserRow>(`INSERT INTO users(id,oidc_issuer,oidc_subject,display_name) VALUES ($1,$2,$3,$4) RETURNING *`, [randomUUID(), identity.issuer, identity.subject, identity.displayName])).rows[0]!
          }
          // A re-invitation can re-enable a membership only through a fresh admin
          // grant. It does not override a globally disabled user account.
          await client.query(`INSERT INTO memberships(organization_id,user_id,roles) VALUES ($1,$2,$3)
            ON CONFLICT (organization_id,user_id) DO UPDATE SET roles=EXCLUDED.roles,status='active'`, [invitation.organization_id, user.id, invitation.roles])
          await client.query('UPDATE invitations SET accepted_by=$2,accepted_at=clock_timestamp() WHERE id=$1', [invitation.id, user.id])
          await audit(client, user.id, 'invitation_accepted', 'invitation', invitation.id, invitation.organization_id)
        }
        if (!user) throw new IdentityError('INVITATION_REQUIRED', 'This account has not been invited')
        const principal = await principalFor(user.id, client)
        const sessionToken = token(); const csrfToken = token(); const expiresAt = new Date(Date.now() + sessionTtl)
        await client.query(`INSERT INTO sessions(token_sha256,user_id,csrf_sha256,expires_at) VALUES ($1,$2,$3,$4)`, [digest(sessionToken), user.id, digest(csrfToken), expiresAt])
        await audit(client, user.id, 'session_created', 'user', user.id)
        authenticated.set(principal, digest(sessionToken))
        return { principal, sessionToken, csrfToken, expiresAt }
      })
    },
    async authenticateSession(sessionToken: string, input: { csrfToken?: string; requireCsrf?: boolean } = {}) {
      secret(sessionToken)
      const hash = digest(sessionToken)
      const session = (await db.query(`SELECT user_id,csrf_sha256 FROM sessions WHERE token_sha256=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [hash])).rows[0]
      if (!session) throw new IdentityError('UNAUTHENTICATED', 'Session is expired or revoked', 401)
      if (input.requireCsrf && (typeof input.csrfToken !== 'string' || input.csrfToken.length > 200 || !equal(digest(input.csrfToken), session.csrf_sha256))) throw new IdentityError('CSRF_INVALID', 'Write request protection is missing or invalid')
      const principal = await principalFor(session.user_id, db)
      authenticated.set(principal, hash)
      return principal
    },
    async revokeSession(sessionToken: string) {
      secret(sessionToken)
      await db.query('UPDATE sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE token_sha256=$1', [digest(sessionToken)])
    },
    async createOrganization(principal: HumanPrincipal, input: { id: string; slug: string; name: string }) {
      id(input.id); string(input.name, 'name')
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.slug)) throw new IdentityError('INVALID_INPUT', 'Invalid organization slug', 400)
      return db.transaction(async client => {
        await requireAdmin(principal, client)
        await client.query('INSERT INTO organizations(id,slug,name) VALUES ($1,$2,$3)', [input.id, input.slug, input.name])
        await audit(client, principal.userId, 'organization_created', 'organization', input.id, input.id)
        return input
      })
    },
    async listOrganizations(principal: HumanPrincipal) {
      return db.transaction(async client => {
        const fresh = await refresh(principal, client)
        return (await client.query(`SELECT id,slug,name,status,created_at AS "createdAt" FROM organizations
          WHERE $1::boolean OR id=ANY($2::text[]) ORDER BY name,id`, [fresh.platformAdmin, fresh.memberships.map(member => member.organizationId)])).rows
      })
    },
    async listMemberships(principal: HumanPrincipal, organizationId: string) {
      return db.transaction(async client => {
        await requireOrgRole(principal, organizationId, ['admin'], client)
        return (await client.query(`SELECT m.organization_id AS "organizationId",m.user_id AS "userId",m.roles,m.status,
          u.display_name AS "displayName",u.status AS "userStatus",u.developer AS "developer" FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY u.display_name,u.id`, [organizationId])).rows
      })
    },
    async listInvitations(principal: HumanPrincipal, organizationId: string) {
      return db.transaction(async client => {
        await requireOrgRole(principal, organizationId, ['admin'], client)
        return (await client.query(`SELECT id,organization_id AS "organizationId",roles,expires_at AS "expiresAt",
          accepted_at AS "acceptedAt",accepted_by AS "acceptedBy",revoked_at AS "revokedAt",created_at AS "createdAt"
          FROM invitations WHERE organization_id=$1 ORDER BY created_at DESC,id`, [organizationId])).rows
      })
    },
    async setOrganizationStatus(principal: HumanPrincipal, input: { organizationId: string; status: 'active' | 'disabled' }) {
      id(input.organizationId)
      if (!['active', 'disabled'].includes(input.status)) throw new IdentityError('INVALID_INPUT', 'Invalid organization status', 400)
      return db.transaction(async client => {
        await requireAdmin(principal, client)
        const updated = await client.query('UPDATE organizations SET status=$2 WHERE id=$1', [input.organizationId, input.status])
        if (!updated.rowCount) throw new IdentityError('NOT_FOUND', 'Organization not found', 404)
        await audit(client, principal.userId, 'organization_status_updated', 'organization', input.organizationId, input.organizationId)
      })
    },
    async createInvitation(principal: HumanPrincipal, input: { organizationId: string; roles: OrganizationRole[]; expiresInMs?: number }) {
      roles(input.roles); const lifetime = ttl(input.expiresInMs ?? 86400000, 1000, 604800000)
      return db.transaction(async client => {
        await requireOrgRole(principal, input.organizationId, ['admin'], client)
        const invitationToken = token(); const invitationId = randomUUID(); const expiresAt = new Date(Date.now() + lifetime)
        await client.query(`INSERT INTO invitations(id,organization_id,created_by,token_sha256,roles,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, [invitationId, input.organizationId, principal.userId, digest(invitationToken), input.roles, expiresAt])
        await audit(client, principal.userId, 'invitation_created', 'invitation', invitationId, input.organizationId)
        return { invitationId, invitationToken, organizationId: input.organizationId, roles: input.roles, expiresAt }
      })
    },
    async revokeInvitation(principal: HumanPrincipal, invitationId: string) {
      id(invitationId)
      return db.transaction(async client => {
        const row = (await client.query('SELECT organization_id FROM invitations WHERE id=$1', [invitationId])).rows[0]
        if (!row) throw new IdentityError('NOT_FOUND', 'Invitation not found', 404)
        await requireOrgRole(principal, row.organization_id, ['admin'], client)
        await client.query('UPDATE invitations SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1', [invitationId])
        await audit(client, principal.userId, 'invitation_revoked', 'invitation', invitationId, row.organization_id)
      })
    },
    async setMembership(principal: HumanPrincipal, input: { organizationId: string; userId: string; roles: OrganizationRole[]; status: 'active' | 'disabled' }) {
      id(input.userId); roles(input.roles)
      if (!['active', 'disabled'].includes(input.status)) throw new IdentityError('INVALID_INPUT', 'Invalid membership status', 400)
      return db.transaction(async client => {
        await requireOrgRole(principal, input.organizationId, ['admin'], client)
        const existing = await client.query('SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2', [input.organizationId, input.userId])
        if (existing.rowCount) {
          await client.query('UPDATE memberships SET roles=$3,status=$4 WHERE organization_id=$1 AND user_id=$2', [input.organizationId, input.userId, input.roles, input.status])
          await audit(client, principal.userId, 'membership_updated', 'user', input.userId, input.organizationId)
          return
        }
        // Direct add bypasses the invitation flow; platform administrator only.
        await requireAdmin(principal, client)
        await principalFor(input.userId, client) // validates the account exists and is active
        await client.query('INSERT INTO memberships(organization_id,user_id,roles,status) VALUES ($1,$2,$3,$4)',
          [input.organizationId, input.userId, input.roles, input.status])
        await audit(client, principal.userId, 'membership_added', 'user', input.userId, input.organizationId)
      })
    },
    /** Creation-axis grant: only a current pack owner or the platform
     * administrator may add or change collaborators. The last owner cannot be
     * demoted, so a pack always keeps at least one accountable owner. */
    async grantPackRole(principal: HumanPrincipal, input: { packId: string; userId: string; role: PackRole }, operationKey: string) {
      id(input.packId); id(input.userId)
      if (!['owner', 'maintainer'].includes(input.role)) throw new IdentityError('INVALID_INPUT', 'Invalid pack role', 400)
      return db.transaction(async client => {
        await lockIdentityOperation(client, principal, operationKey)
        await requirePackRole(principal, input.packId, ['owner'], client)
        if (input.userId !== principal.userId) {
          const target = await principalFor(input.userId, client)
          if (!target.memberships.length && !target.platformAdmin) throw new IdentityError('INVALID_INPUT', 'A collaborator must hold an active account', 400)
          if (!target.developer && !target.platformAdmin) throw new IdentityError('INVALID_INPUT', 'A collaborator must hold the developer capability', 400)
        } else if (!principal.developer && !principal.platformAdmin) {
          throw new IdentityError('INVALID_INPUT', 'Granting pack roles requires the developer capability', 403)
        }
        return idempotentIdentity(client, principal, operationKey, { operation: 'pack.grantRole', ...input }, async () => {
          const pack = (await client.query('SELECT 1 FROM packages WHERE pack_id=$1', [input.packId])).rows[0]
          if (!pack) throw new IdentityError('NOT_FOUND', 'Package not found', 404)
          await client.query(`INSERT INTO pack_ownerships(pack_id,user_id,role,granted_by) VALUES ($1,$2,$3,$4)
            ON CONFLICT (pack_id,user_id) DO UPDATE SET role=EXCLUDED.role,granted_by=EXCLUDED.granted_by`,
          [input.packId, input.userId, input.role, principal.userId])
          await audit(client, principal.userId, 'pack_role_granted', 'package', input.packId)
          return { packId: input.packId, userId: input.userId, role: input.role }
        })
      })
    },
    async revokePackRole(principal: HumanPrincipal, input: { packId: string; userId: string }, operationKey: string) {
      id(input.packId); id(input.userId)
      return db.transaction(async client => {
        await lockIdentityOperation(client, principal, operationKey)
        await requirePackRole(principal, input.packId, ['owner'], client)
        return idempotentIdentity(client, principal, operationKey, { operation: 'pack.revokeRole', ...input }, async () => {
          const row = (await client.query<{ role: PackRole }>('SELECT role FROM pack_ownerships WHERE pack_id=$1 AND user_id=$2 FOR UPDATE', [input.packId, input.userId])).rows[0]
          if (!row) throw new IdentityError('NOT_FOUND', 'Pack ownership not found', 404)
          if (row.role === 'owner') {
            const owners = (await client.query(`SELECT count(*) AS total FROM pack_ownerships po JOIN users u ON u.id=po.user_id
              WHERE po.pack_id=$1 AND po.role='owner' AND u.status='active'`, [input.packId])).rows[0]!
            if (Number(owners.total) <= 1) throw new IdentityError('LAST_OWNER_DENIED', 'A package must keep one active owner', 409)
          }
          await client.query('DELETE FROM pack_ownerships WHERE pack_id=$1 AND user_id=$2', [input.packId, input.userId])
          await audit(client, principal.userId, 'pack_role_revoked', 'package', input.packId)
          return { packId: input.packId, userId: input.userId }
        })
      })
    },
    async listPackOwnerships(principal: HumanPrincipal, packId: string) {
      id(packId)
      return db.transaction(async client => {
        await refresh(principal, client)
        return (await client.query(`SELECT po.pack_id AS "packId",po.user_id AS "userId",po.role,u.display_name AS "displayName",
          po.granted_by AS "grantedBy",po.created_at AS "createdAt" FROM pack_ownerships po JOIN users u ON u.id=po.user_id
          WHERE po.pack_id=$1 ORDER BY po.role, u.display_name`, [packId])).rows
      })
    },
    /** Distribution-axis grant: only the platform administrator defines what a
     * tenant may see. Disabled grants are retained for audit. */
    async setPackVisibility(principal: HumanPrincipal, input: { organizationId: string; scope: 'all' | 'list'; packIds?: readonly string[] }, operationKey: string) {
      id(input.organizationId)
      if (!['all', 'list'].includes(input.scope)) throw new IdentityError('INVALID_INPUT', 'Invalid visibility scope', 400)
      const packIds = [...new Set(input.packIds ?? [])]
      if (input.scope === 'all' && packIds.length) throw new IdentityError('INVALID_INPUT', 'An "all" grant must not carry a pack list', 400)
      if (input.scope === 'list' && !packIds.length) throw new IdentityError('INVALID_INPUT', 'A "list" grant requires at least one pack', 400)
      for (const packId of packIds) id(packId)
      return db.transaction(async client => {
        await requireAdmin(principal, client)
        await lockIdentityOperation(client, principal, operationKey)
        return idempotentIdentity(client, principal, operationKey, { operation: 'pack.setVisibility', organizationId: input.organizationId, scope: input.scope, packIds }, async () => {
          const organization = (await client.query('SELECT id FROM organizations WHERE id=$1 AND status=\'active\' FOR UPDATE', [input.organizationId])).rows[0]
          if (!organization) throw new IdentityError('NOT_FOUND', 'Organization not found', 404)
          const packs = (await client.query('SELECT pack_id FROM packages WHERE pack_id=ANY($1::text[])', [packIds])).rows
          if (packs.length !== packIds.length) throw new IdentityError('INVALID_INPUT', 'Visibility list contains an unknown package', 400)
          const existing = (await client.query<{ id: string; scope: string }>('SELECT id,scope FROM pack_visibilities WHERE organization_id=$1 AND status=\'active\' FOR UPDATE', [input.organizationId])).rows[0]
          let visibilityId: string
          if (existing) {
            visibilityId = existing.id
            await client.query(`UPDATE pack_visibilities SET scope=$2,updated_at=clock_timestamp() WHERE id=$1`, [existing.id, input.scope])
            await client.query('DELETE FROM pack_visibility_items WHERE visibility_id=$1', [existing.id])
          } else {
            visibilityId = randomUUID()
            await client.query(`INSERT INTO pack_visibilities(id,organization_id,scope,granted_by) VALUES ($1,$2,$3,$4)`, [visibilityId, input.organizationId, input.scope, principal.userId])
          }
          if (input.scope === 'list') {
            for (const packId of packIds) await client.query('INSERT INTO pack_visibility_items(visibility_id,pack_id) VALUES ($1,$2)', [visibilityId, packId])
          }
          await audit(client, principal.userId, 'pack_visibility_set', 'organization', input.organizationId, input.organizationId)
          return { organizationId: input.organizationId, scope: input.scope, packIds: input.scope === 'list' ? packIds : [] }
        })
      })
    },
    async disablePackVisibility(principal: HumanPrincipal, input: { organizationId: string }, operationKey: string) {
      id(input.organizationId)
      return db.transaction(async client => {
        await requireAdmin(principal, client)
        await lockIdentityOperation(client, principal, operationKey)
        return idempotentIdentity(client, principal, operationKey, { operation: 'pack.disableVisibility', organizationId: input.organizationId }, async () => {
          const updated = await client.query(`UPDATE pack_visibilities SET status='disabled',updated_at=clock_timestamp()
            WHERE organization_id=$1 AND status='active'`, [input.organizationId])
          if (!updated.rowCount) throw new IdentityError('NOT_FOUND', 'No active visibility grant', 404)
          await audit(client, principal.userId, 'pack_visibility_disabled', 'organization', input.organizationId, input.organizationId)
          return { organizationId: input.organizationId, scope: null }
        })
      })
    },
    async getPackVisibility(principal: HumanPrincipal, organizationId: string) {
      id(organizationId)
      return db.transaction(async client => {
        await requireOrgRole(principal, organizationId, ['admin', 'reviewer', 'member'], client)
        const row = (await client.query(`SELECT v.id,v.scope,v.status,v.granted_by AS "grantedBy",v.created_at AS "createdAt",v.updated_at AS "updatedAt",
          (SELECT array_agg(i.pack_id ORDER BY i.pack_id) FROM pack_visibility_items i WHERE i.visibility_id=v.id) AS "packIds"
          FROM pack_visibilities v WHERE v.organization_id=$1 AND v.status='active'`, [organizationId])).rows[0]
        return row ? { organizationId, scope: row.scope as 'all' | 'list', packIds: row.packIds ?? [], grantedBy: row.grantedBy, createdAt: row.createdAt, updatedAt: row.updatedAt } : null
      })
    },
    async setReviewScope(principal: HumanPrincipal, input: { organizationId: string; reviewerId: string; granted: boolean }) {
      id(input.organizationId); id(input.reviewerId)
      if (typeof input.granted !== 'boolean') throw new IdentityError('INVALID_INPUT', 'Invalid review grant', 400)
      return db.transaction(async client => {
        await requireAdmin(principal, client)
        if (input.granted) {
          const reviewer = await principalFor(input.reviewerId, client)
          if (!reviewer.memberships.some(member => member.roles.includes('reviewer'))) throw new IdentityError('INVALID_INPUT', 'An active reviewer role is required', 400)
          await client.query(`INSERT INTO review_scopes(reviewer_id,organization_id,granted_by) VALUES ($1,$2,$3)
            ON CONFLICT (reviewer_id,organization_id) DO NOTHING`, [input.reviewerId, input.organizationId, principal.userId])
        } else await client.query('DELETE FROM review_scopes WHERE reviewer_id=$1 AND organization_id=$2', [input.reviewerId, input.organizationId])
        await audit(client, principal.userId, input.granted ? 'review_scope_granted' : 'review_scope_revoked', 'user', input.reviewerId, input.organizationId)
      })
    },
    /** Permission-center listing: platform admin only. Returns functional
     * grants (platform/developer/status) for account management. */
    async listUsers(principal: HumanPrincipal, input: { query?: string; limit?: number; beforeId?: string } = {}) {
      return db.transaction(async client => {
        await requireAdmin(principal, client)
        const limit = input.limit ?? 50
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new IdentityError('INVALID_INPUT', 'limit must be between 1 and 100', 400)
        if (input.beforeId !== undefined) id(input.beforeId)
        const query = input.query !== undefined ? String(input.query).trim().slice(0, 100) : ''
        const pattern = query ? `%${query.replace(/[\\%_]/g, character => `\\${character}`)}%` : null
        return (await client.query(`SELECT u.id AS "userId", u.display_name AS "displayName", u.platform_admin AS "platformAdmin",
          u.developer AS "developer", u.status, u.created_at AS "createdAt",
          (SELECT count(*)::int FROM memberships m WHERE m.user_id=u.id AND m.status='active') AS "tenants",
          (SELECT count(*)::int FROM pack_ownerships po WHERE po.user_id=u.id) AS "packs"
          FROM users u WHERE ($1::text IS NULL OR u.display_name ILIKE $1::text OR u.id::text ILIKE $1::text) AND ($2::text IS NULL OR u.id<$2)
          ORDER BY u.id DESC LIMIT $3`, [pattern, input.beforeId ?? null, limit])).rows
      })
    },
    /** Account-level developer capability. Platform-admin managed; takes
     * effect on the next live principal refresh, no session revocation. */
    async setDeveloper(principal: HumanPrincipal, input: { userId: string; developer: boolean }) {
      id(input.userId)
      if (typeof input.developer !== 'boolean') throw new IdentityError('INVALID_INPUT', 'Invalid developer capability', 400)
      return db.transaction(async client => {
        await requireAdmin(principal, client)
        const updated = await client.query('UPDATE users SET developer=$2 WHERE id=$1', [input.userId, input.developer])
        if (!updated.rowCount) throw new IdentityError('NOT_FOUND', 'User not found', 404)
        await audit(client, principal.userId, input.developer ? 'developer_capability_granted' : 'developer_capability_revoked', 'user', input.userId)
      })
    },
    async setUserStatus(principal: HumanPrincipal, input: { userId: string; status: 'active' | 'disabled' }) {
      id(input.userId)
      if (!['active', 'disabled'].includes(input.status)) throw new IdentityError('INVALID_INPUT', 'Invalid account status', 400)
      return db.transaction(async client => {
        await requireAdmin(principal, client)
        if (input.userId === principal.userId) throw new IdentityError('SELF_DISABLE_DENIED', 'Administrator cannot disable their own account')
        const updated = await client.query('UPDATE users SET status=$2 WHERE id=$1', [input.userId, input.status])
        if (!updated.rowCount) throw new IdentityError('NOT_FOUND', 'User not found', 404)
        if (input.status === 'disabled') await client.query('UPDATE sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1', [input.userId])
        await audit(client, principal.userId, 'user_status_updated', 'user', input.userId)
      })
    },
    /** Platform-admin flag management. Self-change is denied so an
     * administrator cannot silently drop their own oversight; the last
     * platform admin cannot be revoked. Takes effect on next principal
     * refresh, no session revocation. */
    async setPlatformAdmin(principal: HumanPrincipal, input: { userId: string; platformAdmin: boolean }) {
      id(input.userId)
      if (typeof input.platformAdmin !== 'boolean') throw new IdentityError('INVALID_INPUT', 'Invalid platform admin flag', 400)
      return db.transaction(async client => {
        const actor = await requireAdmin(principal, client)
        if (actor.userId === input.userId) throw new IdentityError('SELF_PLATFORM_ADMIN_DENIED', 'Platform administrators cannot change their own flag')
        if (!input.platformAdmin) {
          const remaining = (await client.query('SELECT count(*)::int AS n FROM users WHERE platform_admin=true AND id<>$1', [input.userId])).rows[0]?.n ?? 0
          if (!remaining) throw new IdentityError('LAST_PLATFORM_ADMIN', 'At least one platform administrator must remain', 409)
        }
        const updated = await client.query('UPDATE users SET platform_admin=$2 WHERE id=$1', [input.userId, input.platformAdmin])
        if (!updated.rowCount) throw new IdentityError('NOT_FOUND', 'User not found', 404)
        await audit(client, principal.userId, input.platformAdmin ? 'platform_admin_granted' : 'platform_admin_revoked', 'user', input.userId)
      })
    },
    /** Aggregated data permissions for one account: organization
     * memberships with roles, review scopes and pack collaboration roles.
     * Platform-admin read-only view; changes happen in their owning pages. */
    async listUserPermissions(principal: HumanPrincipal, userId: string) {
      id(userId)
      return db.transaction(async client => {
        await requireAdmin(principal, client)
        const user = (await client.query(`SELECT id AS "userId", display_name AS "displayName", platform_admin AS "platformAdmin",
          developer, status FROM users WHERE id=$1`, [userId])).rows[0]
        if (!user) throw new IdentityError('NOT_FOUND', 'User not found', 404)
        const memberships = (await client.query(`SELECT m.organization_id AS "organizationId", o.name AS "organizationName",
          m.roles, m.status, m.created_at AS "createdAt"
          FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 ORDER BY o.name, m.organization_id`, [userId])).rows
        const reviewScopes = (await client.query(`SELECT r.organization_id AS "organizationId", o.name AS "organizationName",
          r.granted_by AS "grantedBy", r.created_at AS "createdAt"
          FROM review_scopes r JOIN organizations o ON o.id=r.organization_id WHERE r.reviewer_id=$1 ORDER BY o.name, r.organization_id`, [userId])).rows
        const packRoles = (await client.query(`SELECT po.pack_id AS "packId", p.name AS "packName", p.owner_org_id AS "organizationId",
          o.name AS "organizationName", po.role, po.created_at AS "createdAt"
          FROM pack_ownerships po JOIN packages p ON p.pack_id=po.pack_id JOIN organizations o ON o.id=p.owner_org_id
          WHERE po.user_id=$1 ORDER BY p.pack_id`, [userId])).rows
        return { user, memberships, reviewScopes, packRoles }
      })
    },
    /** Platform-wide audit trail, newest first. Read-only, platform admin
     * only; filterable by actor with cursor pagination on the event id. */
    async listAuditEvents(principal: HumanPrincipal, input: { limit?: number; beforeId?: string; actorId?: string } = {}) {
      return db.transaction(async client => {
        await requireAdmin(principal, client)
        const limit = input.limit ?? 50
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new IdentityError('INVALID_INPUT', 'limit must be between 1 and 200', 400)
        if (input.beforeId !== undefined && !/^[0-9]+$/.test(input.beforeId)) throw new IdentityError('INVALID_INPUT', 'Invalid pagination cursor', 400)
        if (input.actorId !== undefined) id(input.actorId)
        const rows = await client.query(`SELECT a.id, a.actor_kind AS "actorKind", a.actor_id AS "actorId", u.display_name AS "actorName",
          a.organization_id AS "organizationId", o.name AS "organizationName", a.action, a.object_kind AS "objectKind",
          a.object_id AS "objectId", a.outcome, a.details, a.created_at AS "createdAt"
          FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN organizations o ON o.id=a.organization_id
          WHERE ($1::center_id IS NULL OR a.actor_id=$1::center_id) AND ($2::bigint IS NULL OR a.id<$2::bigint)
          ORDER BY a.id DESC LIMIT $3`, [input.actorId ?? null, input.beforeId ?? null, limit])
        return { items: rows.rows }
      })
    },
  }
}
export type IdentityService = ReturnType<typeof createIdentityService>
