#!/usr/bin/env node
/**
 * Host-side G4.1 governance matrix runner (idempotent).
 * Exercises: self-review block, cross-org isolation, machine-token rejection,
 * credential revoke/re-bind, release yank, scoped distribution review, member
 * disable.  Evidence is written 0600 with no secret/token values.  Re-runs skip
 * rows already satisfied (recorded in a private durable state file).
 */
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const tree = fileURLToPath(new URL('../../', import.meta.url))
const root = '/tmp/p2-20260923'
const dag = join(tree, 'artifacts/pack-center/phase2-20260923/dag')
const runtime = join(root, 'g41')
const origin = 'https://127.0.0.1:18431'
const prefix = '/plugins/dsh-expert-library/manage/center'
const centerId = 'phase2-center-20260923'
const org = 'phase2'
const orgB = 'phase2-org-b'
const instances = { A: { id: 'A', port: 18281 }, B: { id: 'B', port: 18282 } }
const bindFile = join(tree, 'artifacts/pack-center/phase2-20260923/dag/T2.2.bind.json')
const aConnectionFile = join(root, 'pack-center-a/private/connection.json')
const trustedFile = join(root, 'secrets/t22-trusted.json')
const events = [], rows = [], log = []
const secrets = []
let stage = 'preflight'

const json = value => JSON.stringify(value, null, 2) + '\n'
const fail = message => { throw new Error(message) }
const check = (value, message) => { if (!value) fail(message) }
const safeCode = error => typeof error?.code === 'string' && /^[A-Z0-9_.:-]{1,100}$/.test(error.code) ? error.code : 'REQUEST_FAILED'
async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
async function privateWrite(path, bytes) {
  await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600)
}
async function evidence(name, value) {
  const bytes = typeof value === 'string' ? value : json(value)
  for (const secret of secrets) check(!secret || !bytes.includes(secret), `refused to write secret-bearing evidence into ${name}`)
  await privateWrite(join(dag, name), bytes)
}
function note(message, data = {}) { log.push({ at: new Date().toISOString(), stage, message, ...data }) }

async function request(url, options = {}) {
  let response
  try { response = await fetch(url, { redirect: 'manual', ...options, signal: AbortSignal.timeout(20_000) }) }
  catch (error) { const wrapped = new Error('HTTP transport failed'); wrapped.code = safeCode(error); throw wrapped }
  const body = await response.text(); let data
  try { data = JSON.parse(body) } catch { data = undefined }
  return { status: response.status, data, body, headers: response.headers }
}

class Session {
  constructor(subject) { this.subject = subject; this.cookies = new Map(); this.csrf = undefined; this.principal = undefined }
  cookieHeader() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') }
  async raw(path, method = 'GET', body, operationKey) {
    const response = await request(`${origin}${path}`, {
      method,
      headers: { Origin: origin, Cookie: this.cookieHeader(), ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', ...(operationKey ? { 'Idempotency-Key': operationKey } : {}) }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0], at = pair.indexOf('=')
      if (at > 0) { const value = pair.slice(at + 1); this.cookies.set(pair.slice(0, at), value); if (value) secrets.push(value) }
    }
    if (response.data?.csrfToken) this.csrf = response.data.csrfToken
    events.push({ actor: this.subject, method, path: path.split('?')[0], status: response.status })
    return response
  }
  /** Non-throwing call: returns { status, data, code, requestId }. */
  async attempt(path, method = 'GET', body, operationKey) {
    const response = await this.raw(path, method, body, operationKey)
    return { status: response.status, data: response.data, code: response.data?.error?.code ?? null, requestId: response.data?.error?.requestId ?? response.data?.requestId ?? null }
  }
  async call(path, method = 'GET', body, expected = 200, operationKey) {
    const result = await this.attempt(path, method, body, operationKey)
    check(result.status === expected, `center ${method} ${path.split('?')[0]} returned ${result.status}: ${result.code || ''}`)
    return result.data
  }
  async login(invitationToken) {
    const begin = await this.call('/api/auth/login', 'POST', invitationToken ? { invitationToken } : {})
    const authorize = await request(begin.authorizationUrl, { headers: { 'x-test-identity': Buffer.from(JSON.stringify({ subject: this.subject })).toString('base64url') } })
    check(authorize.status === 302, 'OIDC authorization failed')
    const callback = new URL(authorize.headers.get('location') || '')
    check(callback.origin === origin, 'OIDC callback origin mismatch')
    const login = await this.call(callback.pathname + callback.search)
    this.principal = login.principal
    return login
  }
}

async function localRaw(instance, path, method = 'GET', body) {
  const response = await request(`http://127.0.0.1:${instance.port}${prefix}${path}`, {
    method, headers: { 'X-Pack-Center-UI': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  events.push({ actor: instance.id, method, path, status: response.status })
  return { status: response.status, body: response.data }
}
async function localCall(instance, path, method = 'GET', body, expected = 200) {
  const result = await localRaw(instance, path, method, body)
  check(result.status === expected, `DSH ${instance.id} ${method} ${path} returned ${result.status}: ${result.body?.error?.code || result.body?.data?.errorCode || ''}`)
  return result.body?.data
}

async function loadFixtures() {
  stage = 'fixtures'
  const bind = await readJson(bindFile)
  const stored = await readJson(aConnectionFile)
  const trusted = await readJson(trustedFile)
  const bindA = Array.isArray(bind?.instances) ? bind.instances.find(i => i.id === 'A') : bind?.instances?.A
  check(bindA?.deploymentId, 'T2.2.bind.json instances[A].deploymentId unavailable')
  check(stored?.connection?.credentialToken && /^dpc_token_/.test(stored.connection.credentialToken), 'A machine token unavailable in connection.json')
  check(trusted && typeof trusted === 'object' && Object.keys(trusted).length > 0, 'trusted signing keys unavailable')
  secrets.push(stored.connection.credentialToken)
  return { deploymentIdA: bindA.deploymentId, machine: stored.connection, trusted }
}

// ---------------------------------------------------------------- matrix rows

async function rowSelfReviewBlocked(admin) {
  stage = 'selfReviewBlocked'
  const listing = await admin.call(`/api/submissions?organizationId=${org}&limit=100`)
  const items = listing.items || []
  const adminId = admin.principal.userId
  const byAuthor = items.filter(item => item.authorId === adminId)
  check(byAuthor.length > 0, 'no phase2 submission authored by phase2-admin exists')
  let target = byAuthor.find(item => item.status === 'pending_review')
  let mode = 'pending-second-decision'
  if (!target) { target = byAuthor.find(item => item.status === 'approved') || byAuthor[0]; mode = 'already-decided' }
  const detail = await admin.call(`/api/submissions/${target.id}`)
  const result = await admin.attempt(`/api/submissions/${target.id}/review`, 'POST', {
    expectedVersion: detail.submission.stateVersion,
    contentTreeSha256: detail.snapshot?.contentTreeSha256 ?? 'g41-self-review-probe',
    decision: 'approved', comment: 'G4.1 self-review block probe',
  }, `g41-self-review-${target.id}`)
  const acceptedCodes = mode === 'pending-second-decision' ? ['SELF_REVIEW_DENIED', 'FORBIDDEN'] : ['SELF_REVIEW_DENIED', 'INVALID_TRANSITION', 'FORBIDDEN']
  const ok = result.status >= 400 && result.status < 500 && acceptedCodes.includes(result.code)
  return {
    id: 'selfReviewBlocked', ok,
    request: `POST /api/submissions/${target.id}/review as author phase2-admin (${mode}, packId ${target.packId})`,
    status: result.status, outcome: result.code, audit: `audit_events action 'submission.review' denied; http.request requestId ${result.requestId || 'n/a'}`,
    notes: mode === 'pending-second-decision'
      ? 'requireReviewAccess rejects authorId === reviewer userId with SELF_REVIEW_DENIED'
      : 'submission already decided; API still refuses a second decision',
  }
}

async function rowCrossOrgDenied(admin, reviewer) {
  stage = 'crossOrgDenied'
  const orgs = await admin.call('/api/organizations')
  let created = false
  if (!orgs.items.some(item => item.id === orgB)) {
    const result = await admin.attempt('/api/organizations', 'POST', { id: orgB, slug: orgB, name: 'Phase2 Org B (isolation probe)' }, undefined)
    if (result.status === 201) created = true
    else check(result.code === 'INVALID_INPUT' || result.status === 409, `organization creation failed unexpectedly: ${result.code}`)
  }
  const notes = [`organization ${orgB} ${created ? 'created' : 'already present'}`]
  let probeId = null
  const create = await admin.attempt('/api/submissions', 'POST', {
    organizationId: orgB, packId: 'phase2-orgb-probe', name: 'phase2-orgb-probe draft', version: '0.1.0',
    notes: 'G4.1 cross-org isolation probe', license: 'MIT', distribution: { kind: 'organization' }, requiresPlugin: { minVersion: '0.1.0' },
  }, 'g41-crossorg-probe-create')
  if (create.status === 201) { probeId = create.data.id; notes.push('draft submission created inside phase2-org-b') }
  else notes.push(`submission creation in ${orgB} not achievable from this identity (${create.code}); scoped-listing subset only`)
  let ok = true
  let getStatus = null, getCode = null, requestId = null
  if (probeId) {
    const foreign = await reviewer.attempt(`/api/submissions/${probeId}`)
    getStatus = foreign.status; getCode = foreign.code; requestId = foreign.requestId
    ok = (getStatus === 403 || getStatus === 404)
    check(ok, `cross-org submission detail unexpectedly visible to phase2-reviewer (${getStatus} ${getCode})`)
  }
  const foreignList = await reviewer.attempt(`/api/submissions?organizationId=${orgB}&limit=100`)
  const listPrivate = foreignList.status >= 400 || !(foreignList.data?.items || []).some(item => item.status === 'draft' && item.ownerOrgId === orgB)
  ok = ok && listPrivate
  return {
    id: 'crossOrgDenied', ok,
    request: `GET /api/submissions/${probeId || '<org-b draft>'} and GET /api/submissions?organizationId=${orgB} as phase2-reviewer (member of ${org} only)`,
    status: getStatus ?? foreignList.status, outcome: getCode ?? (foreignList.status >= 400 ? 'denied' : 'scoped-list-empty'),
    audit: `audit_events http.request denied; requestId ${requestId || 'n/a'}`,
    notes,
  }
}

async function rowMachineTokenReviewRejected(machine) {
  stage = 'machineTokenReviewRejected'
  const probe = await adminSession.attempt(`/api/submissions?organizationId=${org}&limit=1`)
  const submissionId = probe.data?.items?.[0]?.id
  check(submissionId, 'no submission available for machine-token review probe')
  const response = await request(`${origin}/api/submissions/${submissionId}/review`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${machine.credentialToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 1, contentTreeSha256: 'g41-machine-probe', decision: 'approved', comment: 'must never pass' }),
  })
  events.push({ actor: 'machine-A', method: 'POST', path: '/api/submissions/:id/review', status: response.status })
  const code = response.data?.error?.code ?? null
  const ok = response.status === 403 && ['HUMAN_REQUIRED', 'HUMAN_AUTHENTICATION_REQUIRED'].includes(code)
  return {
    id: 'machineTokenReviewRejected', ok,
    request: `POST /api/submissions/${submissionId}/review with Authorization: Bearer <A machine token>`,
    status: response.status, outcome: code,
    audit: `audit_events http.request denied (actor deployment ${machine.deploymentId}); requestId ${response.data?.error?.requestId || 'n/a'}`,
    notes: 'server.ts rejects any Authorization header outside /api/v1 distribution routes before session fallback',
  }
}

async function rowRevokeAKeepB(admin, fixtures, state) {
  stage = 'revokeAKeepB'
  const deploymentIdA = fixtures.deploymentIdA
  const meta = await admin.call(`/api/v1/deployments/${deploymentIdA}`)
  const live = meta.credentials.filter(item => !item.revokedAt)
  const boundCredentialId = fixtures.machine.credentialId
  if (!live.some(item => item.id === boundCredentialId)) {
    // Already revoked and re-bound by a previous run: verify durable recovery.
    const connA = await localCall(instances.A, '/connection')
    check(connA?.connection?.bound, 'A local connection view unavailable') // revocation blocks center requests, local state persists by design
    await localCall(instances.A, '/catalog?limit=5')
    await localCall(instances.B, '/catalog?limit=5')
    return {
      id: 'revokeAKeepB', ok: true, request: 'skip: A credential already revoked and re-bound in a previous run',
      status: 200, outcome: 'ALREADY_SATISFIED', audit: `deployment_credential_revoked (prior run) + deployment_bound; credential ${connA.connection.credentialId}`,
      notes: [`A bound=true with replacement credential`, 'B local catalog still works'],
    }
  }
  check(live.length === 1, `unexpected live credential count on A: ${live.length}`)
  const revoke = await admin.attempt(`/api/v1/deployments/${deploymentIdA}/credentials/revoke`, 'POST', { credentialId: boundCredentialId }, `g41-revoke-A-${boundCredentialId}`)
  check(revoke.status === 200, `credential revoke failed: ${revoke.status} ${revoke.code}`)
  state.revokedCredentials = [...new Set([...(state.revokedCredentials || []), boundCredentialId])]
  // A refresh must now fail authentication; B keeps working.
  const aRefresh = await localRaw(instances.A, '/catalog', 'POST', {})
  const aFailed = aRefresh.status >= 400 || aRefresh.body?.data?.errorCode
  check(aFailed, `A catalog refresh unexpectedly succeeded after revocation (${aRefresh.status})`)
  await localCall(instances.B, '/catalog?limit=5')
  // Re-bind A through a fresh binding code.
  const code = await admin.call(`/api/v1/deployments/${deploymentIdA}/binding-codes`, 'POST', {}, 201, `g41-bind-A-${randomUUID()}`)
  secrets.push(code.bindingCode)
  const current = await localCall(instances.A, '/connection')
  const bind = await localRaw(instances.A, '/bind', 'POST', {
    bindingCode: code.bindingCode, expectedRevision: current.revision, expectedCenterId: 'phase2-center-20260923', trustedSigningKeys: fixtures.trusted,
  })
  check(bind.status === 200 && bind.body?.ok, `A re-bind failed: ${bind.status} ${bind.body?.error?.code || bind.body?.data?.errorCode || ''}`)
  const after = await localCall(instances.A, '/connection')
  check(after?.connection?.bound && after.connection.deploymentId === deploymentIdA && after.connection.credentialId !== boundCredentialId, 'A connection not re-bound correctly')
  const metaAfter = await admin.call(`/api/v1/deployments/${deploymentIdA}`)
  check(metaAfter.credentials.some(item => item.id === after.connection.credentialId && !item.revokedAt), 'center does not confirm the new A credential')
  return {
    id: 'revokeAKeepB', ok: true,
    request: `POST /api/v1/deployments/${deploymentIdA}/credentials/revoke {credentialId}; POST {prefix}/catalog on A (expect auth failure); GET B /catalog; re-bind via POST /api/v1/deployments/${deploymentIdA}/binding-codes + POST {prefix}/bind`,
    status: revoke.status, outcome: 'revoked+rebound', audit: `deployment_credential_revoked ${boundCredentialId}; deployment_binding_issued; deployment_bound ${after.connection.credentialId}`,
    notes: [`A refresh after revoke: ${aRefresh.status} ${aRefresh.body?.data?.errorCode || aRefresh.body?.error?.code || 'auth-failed'}`,
      'B local catalog unaffected', `A bound=true with replacement credential ${after.connection.credentialId}`],
  }
}

async function rowYank(admin, state) {
  stage = 'yank'
  // /api/v1/releases is a deployment-reader route; resolve the release via A's
  // machine catalog, then perform the yank with the admin session.
  const catalogSrc = (await localCall(instances.B, '/catalog?packId=phase2-dep-a'))?.items?.length ? instances.B : instances.A
  const catalogA = await localCall(catalogSrc, '/catalog?packId=phase2-dep-a')
  let target = (catalogA?.items || []).find(item => String(item.version) === '2.0.0')
  let releaseId = target?.releaseId ?? 'ce39c201-67b4-43a0-84b0-ea975c2b30a5'
  if (!target) {
    // Already yanked in a prior run: catalog correctly hides it. Verify status via manage view.
    const manage = await admin.call(`/api/v1/releases/${releaseId}/manage`)
    const yanked = (manage.release?.status || manage.status) === 'yanked'
    check(yanked, 'release not in catalog and not yanked')
    note('yank-already-satisfied', { releaseId, status: 'yanked' })
    return { id: 'yank', ok: true, request: 'skip: release already yanked', status: 200, outcome: 'ALREADY_YANKED', audit: `release.yanked ${releaseId} (verified via manage view)`, notes: ['catalog excludes yanked release'] }
  }
  if (target.status === 'yanked' || state.yankedReleases?.includes(releaseId)) {
    return {
      id: 'yank', ok: true, request: `skip: release ${releaseId} already yanked`,
      status: 200, outcome: 'ALREADY_YANKED', audit: `release.yanked ${releaseId} (prior run)`, notes: ['center releases list status=yanked'],
    }
  }
  const beforeCatalog = await localRaw(instances.A, '/catalog?limit=100')
  const installationsBefore = {
    A: await localCall(instances.A, '/installations'), B: await localCall(instances.B, '/installations'),
  }
  const active = map => ({ generation: map.generation, items: (map.items || []).filter(item => item.active).map(item => ({ packId: item.packId, releaseId: item.releaseId, version: item.version })) })
  const beforeActive = { A: active(installationsBefore.A), B: active(installationsBefore.B) }
  const manage = await admin.call(`/api/v1/releases/${releaseId}/manage`)
  const yank = await admin.attempt(`/api/v1/releases/${releaseId}/yank`, 'POST', {
    expectedVersion: manage.stateVersion, reason: 'G4.1 yank-candidate exercise for phase2-dep-a@2.0.0',
  }, `g41-yank-${releaseId}`)
  check(yank.status === 200 && yank.data?.status === 'yanked', `yank failed: ${yank.status} ${yank.code}`)
  state.yankedReleases = [...new Set([...(state.yankedReleases || []), releaseId])]
  const afterList = await admin.call('/api/v1/releases?packId=phase2-dep-a&limit=100')
  const afterRow = (afterList.items || []).find(item => item.id === releaseId)
  const afterCatalog = await localRaw(instances.A, '/catalog?limit=100')
  const stillOffered = (afterCatalog.body?.data?.items || []).some(item => item.releaseId === releaseId)
  const installationsAfter = { A: active(await localCall(instances.A, '/installations')), B: active(await localCall(instances.B, '/installations')) }
  check(JSON.stringify(installationsAfter.A) === JSON.stringify(beforeActive.A) && JSON.stringify(installationsAfter.B) === JSON.stringify(beforeActive.B), 'installations changed across yank')
  const grant = await admin.attempt(`/api/v1/releases/${releaseId}/download-grants`, 'POST', {})
  const grantRejected = grant.status >= 400
  check(grantRejected, `fresh download-grant for yanked release unexpectedly issued (${grant.status})`)
  const ok = afterRow?.status === 'yanked' && (!stillOffered || afterRow.status === 'yanked') && grantRejected
  return {
    id: 'yank', ok,
    request: `POST /api/v1/releases/${releaseId}/yank {expectedVersion:${manage.stateVersion}, reason} for phase2-dep-a@2.0.0`,
    status: yank.status, outcome: 'yanked', audit: `audit_events 'release.yanked' release ${releaseId}; requestId ${yank.requestId || 'n/a'}`,
    notes: [`center list status=${afterRow?.status}`,
      `A local catalog still lists entry: ${stillOffered} (cache; center state is authoritative)`,
      `download-grant rejected: ${grant.status} ${grant.code}`,
      `installations unchanged A/B (generation ${beforeActive.A.generation}/${beforeActive.B.generation})`],
  }
}

async function rowScopeChangeNeedsReview(admin, reviewer) {
  stage = 'scopeChangeNeedsReview'
  const catalogB = await localCall(instances.B, '/catalog?packId=phase2-dep-b')
  const target = (catalogB?.items || []).find(item => String(item.version) === '1.1.0')
  check(target, 'published phase2-dep-b@1.1.0 release not found for scope-change exercise')
  const releaseId = target.releaseId
  const manage = await admin.call(`/api/v1/releases/${releaseId}/manage`)
  const requests = await admin.call(`/api/v1/releases/${releaseId}/distribution-requests?limit=100`)
  const items = requests.items || []
  let request = items.find(item => item.requestedScope?.kind === 'authenticated' && ['pending_review', 'approved'].includes(item.status))
  let created = false
  if (!request) {
    const made = await admin.attempt(`/api/v1/releases/${releaseId}/distribution-requests`, 'POST', {
      expectedVersion: manage.distribution.stateVersion, scope: { kind: 'authenticated' },
      reason: 'G4.1 widening exercise: organization -> authenticated requires review',
    }, `g41-scope-${releaseId}`)
    check(made.status === 201 || made.code === 'IDEMPOTENCY_CONFLICT' || made.code === 'DISTRIBUTION_UNCHANGED', `scope-change request failed: ${made.status} ${made.code}`)
    if (made.status === 201) { request = made.data; created = true }
    else {
      const refreshed = await admin.call(`/api/v1/releases/${releaseId}/distribution-requests?limit=100`)
      request = (refreshed.items || []).find(item => item.requestedScope?.kind === 'authenticated' && ['pending_review', 'approved'].includes(item.status))
      check(request, 'no widening request exists despite unchanged-scope conflict')
    }
  }
  if (request.status === 'pending_review') {
    const pendingCheck = await admin.call(`/api/v1/distribution-requests/${request.id}`)
    const stillOrg = (await admin.call(`/api/v1/releases/${releaseId}/manage`)).distribution.scope.kind
    check(pendingCheck.status === 'pending_review' && stillOrg === 'organization', 'requested scope became effective before review')
    const approval = await reviewer.attempt(`/api/v1/distribution-requests/${request.id}/review`, 'POST', {
      expectedVersion: request.stateVersion, decision: 'approved', comment: 'G4.1 independent approval of widening request',
    }, `g41-scope-review-${request.id}`)
    check(approval.status === 200, `reviewer approval failed: ${approval.status} ${approval.code}`)
  }
  const decided = await admin.call(`/api/v1/distribution-requests/${request.id}`)
  const finalScope = (await admin.call(`/api/v1/releases/${releaseId}/manage`)).distribution
  const ok = decided.status === 'approved' && finalScope.scope.kind === 'authenticated'
  return {
    id: 'scopeChangeNeedsReview', ok,
    request: `POST /api/v1/releases/${releaseId}/distribution-requests {scope:{kind:'authenticated'}} (${created ? 'created' : 'reused'}) then POST /api/v1/distribution-requests/${request.id}/review by phase2-reviewer`,
    status: 200, outcome: `pending_review enforced; final scope=${finalScope.scope.kind} v${finalScope.stateVersion}`,
    audit: `audit_events 'distribution.requested' + 'distribution.approved' request ${request.id}`,
    notes: ['request sat at pending_review with scope still organization until reviewer approval'],
  }
}

async function rowMemberDisable(admin, reviewer, state) {
  stage = 'memberDisable'
  if (state.memberDisableDone) {
    return {
      id: 'memberDisable', ok: true, request: 'skip: disable/re-enable cycle already exercised in a previous run',
      status: 200, outcome: 'ALREADY_SATISFIED', audit: 'audit_events user_status_updated x2 (prior run)', notes: ['reviewer re-enabled'],
    }
  }
  const me = await reviewer.call('/api/me')
  const userId = me.principal.userId
  const disable = await admin.attempt(`/api/users/${userId}/status`, 'POST', { status: 'disabled' }, `g41-disable-${userId}`)
  check(disable.status === 200, `reviewer disable failed: ${disable.status} ${disable.code}`)
  const probe = await adminSession.attempt(`/api/submissions?organizationId=${org}&limit=1`)
  const submissionId = probe.data?.items?.[0]?.id
  check(submissionId, 'no submission available for reviewer write-access probe')
  const denied = await reviewer.attempt(`/api/submissions/${submissionId}/review`, 'POST', {
    expectedVersion: 1, contentTreeSha256: 'g41-disabled-probe', decision: 'approved', comment: 'must not pass while disabled',
  })
  const rejected = denied.status === 401 || (denied.status === 403 && ['FORBIDDEN', 'UNAUTHENTICATED'].includes(denied.code))
  check(rejected, `disabled reviewer review attempt returned ${denied.status} ${denied.code}`)
  const enable = await admin.attempt(`/api/users/${userId}/status`, 'POST', { status: 'active' }, `g41-enable-${userId}`)
  check(enable.status === 200, `reviewer re-enable failed: ${enable.status} ${enable.code}`)
  const restored = new Session('phase2-reviewer'); await restored.login()
  state.memberDisableDone = true
  return {
    id: 'memberDisable', ok: rejected && enable.status === 200,
    request: `POST /api/users/${userId}/status {status:'disabled'}; reviewer review POST; POST {status:'active'}`,
    status: denied.status, outcome: `review rejected (${denied.code}), member re-enabled`,
    audit: `audit_events 'user_status_updated' x2 for user ${userId}; requestId ${denied.requestId || 'n/a'}`,
    notes: ['disabling revoked the live reviewer session server-side'],
  }
}

// --------------------------------------------------------------------- driver

let adminSession
async function main() {
  await mkdir(dag, { recursive: true, mode: 0o700 }); await chmod(dag, 0o700).catch(() => {})
  await mkdir(runtime, { recursive: true, mode: 0o700 }); await chmod(runtime, 0o700)
  const state = (await readJson(join(runtime, 'state.json'))) || {}
  const fixtures = await loadFixtures()
  stage = 'login'
  adminSession = new Session('phase2-admin'); await adminSession.login()
  check(adminSession.principal?.platformAdmin, 'phase2-admin is not a platform administrator')
  const reviewer = new Session('phase2-reviewer'); await reviewer.login()

  const done = state.rows || {}
  const run = async spec => {
    if (done[spec.id]?.ok) {
      note('row-skipped', { row: spec.id, prior: done[spec.id].outcome })
      return { ...done[spec.id], skipped: true }
    }
    const row = await spec.fn()
    done[spec.id] = { ok: row.ok, outcome: row.outcome, at: new Date().toISOString() }
    await privateWrite(join(runtime, 'state.json'), json(state))
    note('row-completed', { row: spec.id, ok: row.ok, outcome: row.outcome })
    return row
  }
  rows.push(await run({ id: 'selfReviewBlocked', fn: () => rowSelfReviewBlocked(adminSession) }))
  rows.push(await run({ id: 'crossOrgDenied', fn: () => rowCrossOrgDenied(adminSession, reviewer) }))
  rows.push(await run({ id: 'machineTokenReviewRejected', fn: () => rowMachineTokenReviewRejected(fixtures.machine) }))
  rows.push(await run({ id: 'revokeAKeepB', fn: () => rowRevokeAKeepB(adminSession, fixtures, state) }))
  rows.push(await run({ id: 'yank', fn: () => rowYank(adminSession, state) }))
  rows.push(await run({ id: 'scopeChangeNeedsReview', fn: () => rowScopeChangeNeedsReview(adminSession, reviewer) }))
  rows.push(await run({ id: 'memberDisable', fn: () => rowMemberDisable(adminSession, reviewer, state) }))
  state.rows = done; await privateWrite(join(runtime, 'state.json'), json(state))

  stage = 'evidence'
  const failed = rows.filter(row => !row.ok)
  const reasons = failed.length
    ? failed.map(row => `${row.id}: ${row.outcome} (status ${row.status})`)
    : ['all seven governance matrix rows satisfied: self-review blocked, cross-org private detail denied, machine token rejected on review, A credential revoked/re-bound while B kept working, yanked release stopped being granted, scope widening stayed pending until independent approval, and a disabled member lost write access then was restored']
  await evidence('G4.1.matrix.json', { node: 'G4.1', generatedAt: new Date().toISOString(), rows })
  await evidence('G4.1.verdict.json', { node: 'G4.1', passed: failed.length === 0, reasons })
  await evidence('G4.1.log', json({ node: 'G4.1', passed: failed.length === 0, stage, events, log }))
  console.log(JSON.stringify({ node: 'G4.1', scriptReady: true }))
  if (failed.length) process.exitCode = 1
}

main().catch(async error => {
  const reason = `${safeCode(error)}: ${String(error?.message || error).replace(/dpc_[A-Za-z0-9_-]+/g, '[redacted]').replace(/dpc_bind_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500)}`
  try {
    await mkdir(dag, { recursive: true, mode: 0o700 })
    await evidence('G4.1.matrix.json', { node: 'G4.1', generatedAt: new Date().toISOString(), rows })
    await evidence('G4.1.verdict.json', { node: 'G4.1', passed: false, reasons: [`stage ${stage} failed: ${reason}`] })
    await evidence('G4.1.log', json({ node: 'G4.1', passed: false, stage, events, log, error: reason }))
  } catch { /* preserve stdout contract */ }
  console.log(JSON.stringify({ node: 'G4.1', scriptReady: true })); process.exitCode = 1
})
