#!/usr/bin/env node
/** T2.3 host runner: publish macro-capital-analyst v1, then exercise A/B. */
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { canonicalBytes, sha256, verifyReleaseManifest } from '../../packages/pack-contract/index.mjs'

const tree = fileURLToPath(new URL('../../', import.meta.url))
const dag = join(tree, 'artifacts/pack-center/phase2-20260923/dag')
const runRoot = '/tmp/p2-20260923'
const secrets = join(runRoot, 'secrets')
const origin = 'https://127.0.0.1:18431'
const centerId = 'phase2-center-20260923'
const signingKeyId = 'phase2-key'
const expected = {
  packId: 'macro-capital-analyst', version: '2.2.0',
  sourceUrl: 'https://github.com/weixkcornell/macro-capital-analyst.git',
  sourceCommit: '96548f280d7bdeab8f5167a6c21b429d1a7153f3',
  artifactSha256: '63279f9fe60412169806ababfddf026c0d473190ce1bbfdb930e40ef2b72b8ff',
}
const instances = [{ id: 'A', port: 18281 }, { id: 'B', port: 18282 }]

const events = []
const publishLog = []
const installLogs = { A: [], B: [] }
const secretsToScan = []
let stage = 'preflight'
let publishEvidence
const installEvidence = {}

const fail = (message, code = 'T23_FAILED') => {
  const error = new Error(message)
  error.code = code
  throw error
}
const check = (value, message) => { if (!value) fail(message) }
const safeError = error => {
  const code = error?.code || error?.data?.error?.code
  if (typeof code === 'string' && /^[A-Z0-9_.:-]{1,100}$/.test(code)) return code
  return 'REQUEST_FAILED'
}
const json = value => JSON.stringify(value, null, 2) + '\n'

async function writeEvidence(name, value) {
  const bytes = typeof value === 'string' ? value : json(value)
  for (const secret of secretsToScan) check(!secret || !bytes.includes(secret), 'Refused to write sensitive value to evidence')
  const path = join(dag, name)
  await writeFile(path, bytes, { mode: 0o600 })
  await chmod(path, 0o600)
}
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function request(url, options = {}) {
  let response
  try { response = await fetch(url, { redirect: 'manual', ...options, signal: AbortSignal.timeout(20_000) }) }
  catch (error) { const e = new Error('HTTP transport failed'); e.code = safeError(error); throw e }
  const body = await response.text()
  let data
  try { data = JSON.parse(body) } catch { data = undefined }
  return { status: response.status, data, body, headers: response.headers }
}

class Session {
  constructor(subject) { this.subject = subject; this.cookies = new Map(); this.csrf = undefined }
  cookieHeader() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') }
  async call(path, method = 'GET', body, expectedStatus = 200, idempotencyKey) {
    const response = await request(`${origin}${path}`, {
      method,
      headers: {
        Origin: origin, Cookie: this.cookieHeader(),
        ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0]
      const index = pair.indexOf('=')
      if (index > 0) { const value = pair.slice(index + 1); this.cookies.set(pair.slice(0, index), value); if (value) secretsToScan.push(value) }
    }
    events.push({ actor: this.subject, method, path: path.split('?')[0], status: response.status })
    if (response.status !== expectedStatus) fail(`Center ${method} ${path.split('?')[0]} returned ${response.status}`, response.data?.error?.code || 'CENTER_HTTP_ERROR')
    if (response.data?.csrfToken) this.csrf = response.data.csrfToken
    return response.data
  }
  async login(invitationToken) {
    const begin = await this.call('/api/auth/login', 'POST', invitationToken ? { invitationToken } : {}, 200)
    check(begin && typeof begin.authorizationUrl === 'string', 'OIDC login did not return an authorization URL')
    const authorize = await request(begin.authorizationUrl, { headers: { 'x-test-identity': Buffer.from(JSON.stringify({ subject: this.subject })).toString('base64url') } })
    check(authorize.status === 302, 'OIDC authorization did not redirect')
    const callback = new URL(authorize.headers.get('location') || '')
    check(callback.origin === origin, 'OIDC callback origin mismatch')
    return this.call(callback.pathname + callback.search, 'GET', undefined, 200)
  }
}

async function local(instance, path, method = 'GET', body) {
  const url = `http://127.0.0.1:${instance.port}${path.startsWith('/plugins/') ? path : '/plugins/dsh-expert-library/manage/center' + path}`
  const response = await request(url, {
    method,
    headers: { 'X-Pack-Center-UI': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  events.push({ actor: instance.id, method, path, status: response.status })
  if (response.status < 200 || response.status >= 300 || !response.data?.ok) {
    fail(`DSH ${instance.id} ${method} ${path} failed`, response.data?.error?.code || 'LOCAL_HTTP_ERROR')
  }
  return response.data.data
}
async function waitFor(action, predicate, message, attempts = 180, interval = 1000) {
  let last
  for (let n = 0; n < attempts; n++) {
    last = await action()
    if (predicate(last)) return last
    await delay(interval)
  }
  fail(message + (last?.status ? ` (${last.status})` : ''))
}
async function hash(value) { return sha256(canonicalBytes(value)) }
function eventLog(target, message, data = {}) { target.push({ at: new Date().toISOString(), message, ...data }) }

async function listPacks(instance) {
  const response = await request(`http://127.0.0.1:${instance.port}/plugins/dsh-expert-library/packs`)
  events.push({ actor: instance.id, method: 'GET', path: '/plugins/dsh-expert-library/packs', status: response.status })
  check(response.status === 200 && Array.isArray(response.data?.packs), `DSH ${instance.id} pack inventory unavailable`)
  return response.data
}
function builtinWorkspaceListing(value) {
  return value.packs.filter(item => item.layer === 'builtin' || item.layer === 'workspace')
    .sort((a, b) => `${a.layer}:${a.id}`.localeCompare(`${b.layer}:${b.id}`))
}
async function operation(instance, input, log) {
  const queued = await local(instance, '/operations', 'POST', input)
  eventLog(log, 'operation-enqueued', { operationId: queued.operationId, kind: input.kind, expectedGeneration: input.expectedGeneration })
  const result = await waitFor(
    () => local(instance, `/operations/${queued.operationId}`),
    value => ['succeeded', 'failed', 'interrupted'].includes(value.status),
    `DSH ${instance.id} operation did not complete`, 240, 500,
  )
  eventLog(log, 'operation-completed', { operationId: queued.operationId, status: result.status, phase: result.phase, result: result.result, errorCode: result.errorCode })
  check(result.status === 'succeeded', `DSH ${instance.id} operation ${input.kind} failed: ${result.errorCode || result.result?.errorCode || result.status}`)
  return { queued, result }
}
async function readLocalState(instance) {
  const path = join(runRoot, `pack-center-${instance.id.toLowerCase()}`, 'inventory', 'state.json')
  return readJson(path)
}
async function findSignedManifest(instance, releaseId) {
  const root = join(runRoot, `pack-center-${instance.id.toLowerCase()}`, 'inventory')
  async function walk(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { const found = await walk(path); if (found) return found }
      else if (entry.isFile() && entry.name === 'release.json') {
        const envelope = await readJson(path)
        if (envelope?.manifest?.releaseId === releaseId) return { path, envelope }
      }
    }
    return undefined
  }
  return walk(root)
}

async function publishV1() {
  stage = 'publish-v1'
  const admin = new Session('phase2-admin')
  const adminLogin = await admin.login()
  check(adminLogin?.principal?.platformAdmin, 'phase2-admin is not a platform administrator')
  const submissions = await admin.call('/api/submissions?organizationId=phase2&limit=100')
  let row = submissions.items?.find(item => item.packId === expected.packId && item.version === expected.version && item.source?.url === expected.sourceUrl && item.source?.ref === expected.sourceCommit)
  if (row && ['rejected', 'withdrawn', 'changes_requested', 'validation_failed'].includes(row.status)) {
    eventLog(publishLog, 'prior-submission-terminal', { submissionId: row.id, status: row.status })
    row = undefined
  }
  if (!row) {
    row = await admin.call('/api/submissions', 'POST', {
      organizationId: 'phase2', packId: expected.packId, name: 'Macro Capital Analyst', version: expected.version,
      source: { url: expected.sourceUrl, ref: expected.sourceCommit }, notes: 'T2.3 v1 acceptance publication', license: 'MIT',
      distribution: { kind: 'organization' },
    }, 201, 't23-create-v1')
    eventLog(publishLog, 'submission-created', { submissionId: row.id })
  } else eventLog(publishLog, 'submission-reused', { submissionId: row.id, status: row.status })
  check(row.packId === expected.packId && row.version === expected.version && row.source.ref === expected.sourceCommit, 'Submission identity mismatch')

  let detail = await admin.call(`/api/submissions/${row.id}`)
  if (detail.submission.status === 'draft') {
    const requested = await admin.call(`/api/submissions/${row.id}/validate`, 'POST', { expectedVersion: detail.submission.stateVersion }, 202, 't23-validate-v1')
    eventLog(publishLog, 'validation-requested', { submissionId: row.id, jobId: requested.jobId })
  }
  detail = await waitFor(
    () => admin.call(`/api/submissions/${row.id}`),
    value => ['validated', 'pending_review', 'approved'].includes(value.submission.status) || value.submission.status === 'validation_failed',
    'Validation did not reach a settled state', 240, 1000,
  )
  check(detail.submission.status !== 'validation_failed' && detail.snapshot?.report?.valid === true, 'Validated snapshot is not valid')
  check(detail.snapshot.sourceCommit === expected.sourceCommit, 'Validated source commit differs from pinned v1 commit')
  if (detail.submission.status === 'validated') {
    const submitted = await admin.call(`/api/submissions/${row.id}/submit`, 'POST', { expectedVersion: detail.submission.stateVersion }, 200, 't23-submit-v1')
    eventLog(publishLog, 'submission-submitted', { submissionId: row.id, stateVersion: submitted.stateVersion })
    detail = await admin.call(`/api/submissions/${row.id}`)
  }

  const invitation = await admin.call('/api/organizations/phase2/invitations', 'POST', { roles: ['reviewer'], expiresInMs: 3600000 }, 201, 't23-reviewer-invitation')
  secretsToScan.push(invitation.invitationToken)
  const reviewer = new Session('phase2-reviewer')
  const reviewerLogin = await reviewer.login(invitation.invitationToken)
  const reviewerId = reviewerLogin.principal?.userId
  check(typeof reviewerId === 'string' && reviewerId.length > 0, 'Reviewer login did not return a user id')
  await admin.call('/api/organizations/phase2/review-scopes', 'POST', { reviewerId, granted: true }, 200, 't23-review-scope')
  detail = await admin.call(`/api/submissions/${row.id}`)
  if (detail.submission.status === 'pending_review') {
    const approved = await reviewer.call(`/api/submissions/${row.id}/review`, 'POST', {
      expectedVersion: detail.submission.stateVersion, contentTreeSha256: detail.snapshot.contentTreeSha256,
      decision: 'approved', comment: 'Approved the pinned v1 snapshot independently for T2.3.',
    }, 200, 't23-approve-v1')
    eventLog(publishLog, 'review-approved', { submissionId: row.id, reviewId: approved.reviewId, releaseId: approved.releaseId, jobId: approved.jobId })
    detail = await admin.call(`/api/submissions/${row.id}`)
  }
  let published = await waitFor(
    () => admin.call(`/api/submissions/${row.id}`),
    value => value.release?.status === 'published' || value.release?.status === 'publish_failed',
    'Publish worker did not finish', 240, 1000,
  )
  if (published.release?.status === 'publish_failed') {
    const retry = await admin.call(`/api/submissions/${row.id}/retry-publication`, 'POST', { expectedReleaseVersion: published.release.stateVersion }, 202, 't23-retry-publication-v1')
    eventLog(publishLog, 'publication-retried', { submissionId: row.id, releaseId: retry.releaseId, jobId: retry.jobId })
    published = await waitFor(
      () => admin.call(`/api/submissions/${row.id}`),
      value => value.release?.status === 'published' || value.release?.status === 'publish_failed',
      'Retried publish worker did not finish', 240, 1000,
    )
  }
  check(published.release?.status === 'published', `Publication failed: ${published.release?.errorCode || published.release?.status}`)
  check(published.snapshot?.artifactSha256 === expected.artifactSha256, 'Published artifact digest differs from phase1 v1 digest')
  check(published.snapshot?.contentTreeSha256 && published.snapshot?.reportSha256, 'Published snapshot digests are incomplete')
  const phase1 = (await readJson(join(tree, 'artifacts/pack-center/phase1-20260924-final/public-sample-versions.json')))
    .find(item => item.packId === expected.packId && item.version === expected.version)
  check(phase1 && published.snapshot.artifactSha256 === phase1.artifactSha256
    && published.snapshot.contentTreeSha256 === phase1.contentTreeSha256
    && published.snapshot.reportSha256 === phase1.reportSha256, 'Published v1 snapshot does not match the recorded phase1 digests')
  const releaseId = published.release.id
  publishEvidence = {
    submissionId: row.id, snapshotId: published.snapshot.id, releaseId,
    status: published.release.status, sourceCommit: published.snapshot.sourceCommit,
    artifactSha256: published.snapshot.artifactSha256, contentTreeSha256: published.snapshot.contentTreeSha256,
    reportSha256: published.snapshot.reportSha256, signingKeyId,
    artifactDigestCrossCheck: { expectedPhase1: expected.artifactSha256, actual: published.snapshot.artifactSha256, matched: published.snapshot.artifactSha256 === expected.artifactSha256 },
    phase1DigestCrossCheck: { artifactSha256: published.snapshot.artifactSha256 === phase1.artifactSha256, contentTreeSha256: published.snapshot.contentTreeSha256 === phase1.contentTreeSha256, reportSha256: published.snapshot.reportSha256 === phase1.reportSha256 },
    reviewerId,
  }
  eventLog(publishLog, 'published', { submissionId: row.id, releaseId, artifactSha256: published.snapshot.artifactSha256, signingKeyId })
  return { releaseId, snapshot: published.snapshot }
}

async function installOn(instance, release) {
  stage = `install-${instance.id}`
  const log = installLogs[instance.id]
  const beforePacks = await listPacks(instance)
  const beforeBuiltin = builtinWorkspaceListing(beforePacks)
  const beforeInstallations = await local(instance, '/installations')
  const connection = await local(instance, '/connection')
  check(connection.connection?.centerId === centerId && connection.activationAvailable, `DSH ${instance.id} connection is not ready`)
  check(Number.isSafeInteger(connection.revision), `DSH ${instance.id} connection revision is invalid`)
  const catalog = await local(instance, `/catalog?packId=${encodeURIComponent(expected.packId)}`)
  const entry = catalog.items?.find(item => item.releaseId === release.releaseId)
  check(entry && entry.ownerOrgId === 'phase2' && entry.version === expected.version && entry.artifactSha256 === release.snapshot.artifactSha256, `DSH ${instance.id} catalog does not contain the published v1 release`)
  check(entry.contentTreeSha256 === release.snapshot.contentTreeSha256 && entry.manifestSha256, `DSH ${instance.id} catalog digest set is incomplete`)
  eventLog(log, 'catalog-visible', { releaseId: entry.releaseId, version: entry.version, artifactSha256: entry.artifactSha256, contentTreeSha256: entry.contentTreeSha256, manifestSha256: entry.manifestSha256 })

  let installations = beforeInstallations
  const prior = installations.items.find(item => item.releaseId === entry.releaseId)
  if (prior?.active) {
    const disabled = await operation(instance, { operationKey: `t23-${instance.id}-preinstall-disable`, kind: 'disable', expectedGeneration: installations.generation, packId: entry.packId }, log)
    installations = await local(instance, '/installations')
    eventLog(log, 'preexisting-active-release-disabled', { operationId: disabled.queued.operationId })
  }
  check(!installations.items.some(item => item.releaseId === entry.releaseId && item.active), `DSH ${instance.id} v1 was active before default-disabled install`)
  const alreadyInstalled = installations.items.some(item => item.releaseId === entry.releaseId && item.integrity === 'verified')
  if (alreadyInstalled) eventLog(log, 'install-skipped-already-installed', { releaseId: entry.releaseId })
  const install = alreadyInstalled ? null : await operation(instance, {
    operationKey: `t23-${instance.id}-install-${release.releaseId}`, kind: 'install', expectedGeneration: installations.generation,
    connectionRevision: connection.revision,
    target: { manifestSha256: entry.manifestSha256, artifactSha256: entry.artifactSha256, contentTreeSha256: entry.contentTreeSha256 },
    releaseId: release.releaseId,
  }, log)
  installations = await local(instance, '/installations')
  const installed = installations.items.find(item => item.releaseId === release.releaseId)
  check(installed && installed.active === false, `DSH ${instance.id} install did not remain default-disabled`)
  check(installed.integrity === 'verified' && installed.artifactSha256 === entry.artifactSha256 && installed.contentTreeSha256 === entry.contentTreeSha256, `DSH ${instance.id} installed integrity/digest mismatch`)
  const stateAfterInstall = await readLocalState(instance)
  const record = stateAfterInstall.installed?.[release.releaseId]
  check(record?.artifactSha256 === entry.artifactSha256 && record?.contentTreeSha256 === entry.contentTreeSha256, `DSH ${instance.id} durable state digest mismatch`)
  check(stateAfterInstall.active?.[entry.packId] === undefined, `DSH ${instance.id} durable state unexpectedly enabled v1`)
  const signed = await findSignedManifest(instance, release.releaseId)
  check(signed, `DSH ${instance.id} signed release envelope is missing`)
  const trusted = await readJson(join(secrets, 't22-trusted.json'))
  const manifest = verifyReleaseManifest(signed.envelope, trusted)
  check(manifest.releaseId === release.releaseId && manifest.centerId === centerId && manifest.packId === expected.packId
    && manifest.version === expected.version && manifest.signingKeyId === signingKeyId
    && manifest.artifactSha256 === entry.artifactSha256 && manifest.contentTreeSha256 === entry.contentTreeSha256, `DSH ${instance.id} Ed25519 manifest verification mismatch`)
  check(sha256(canonicalBytes(manifest)) === entry.manifestSha256, `DSH ${instance.id} manifest digest mismatch`)
  eventLog(log, 'installed-default-disabled', { operationId: install ? install.queued.operationId : 'skipped-already-installed', generation: installations.generation, releaseId: installed.releaseId, artifactSha256: installed.artifactSha256, manifestSha256: entry.manifestSha256, signatureVerified: true })

  const enable = await operation(instance, { operationKey: `t23-${instance.id}-enable-${release.releaseId}`, kind: 'enable', expectedGeneration: installations.generation, releaseId: release.releaseId }, log)
  installations = await local(instance, '/installations')
  const enabled = installations.items.find(item => item.releaseId === release.releaseId)
  check(enabled?.active === true && enabled.version === expected.version && installations.generation === enable.result.result.generation
    && installations.generation > stateAfterInstall.generation, `DSH ${instance.id} explicit enable did not activate v1 or increment generation`)
  const enabledGeneration = installations.generation
  const disable = await operation(instance, { operationKey: `t23-${instance.id}-disable-${release.releaseId}`, kind: 'disable', expectedGeneration: installations.generation, packId: entry.packId }, log)
  installations = await local(instance, '/installations')
  check(!installations.items.some(item => item.source === 'center' && item.active), `DSH ${instance.id} explicit disable left a center pack active`)
  const disableAll = []
  const packIds = [...new Set(installations.items.filter(item => item.source === 'center').map(item => item.packId))]
  for (const packId of packIds) {
    const result = await operation(instance, { operationKey: `t23-${instance.id}-disable-all-${packId}`, kind: 'disable', expectedGeneration: installations.generation, packId }, log)
    disableAll.push({ packId, operationId: result.queued.operationId, generation: result.result.result.generation })
    installations = await local(instance, '/installations')
  }
  check(!installations.items.some(item => item.source === 'center' && item.active), `DSH ${instance.id} disable-all left a center pack active`)
  const finalEnable = await operation(instance, { operationKey: `t23-${instance.id}-final-enable-${release.releaseId}`, kind: 'enable', expectedGeneration: installations.generation, releaseId: release.releaseId }, log)
  installations = await local(instance, '/installations')
  const final = installations.items.find(item => item.releaseId === release.releaseId)
  check(final?.active === true && final.version === expected.version, `DSH ${instance.id} final enable did not leave v1 active`)

  const afterPacks = await listPacks(instance)
  const afterBuiltin = builtinWorkspaceListing(afterPacks)
  check(JSON.stringify(beforeBuiltin) === JSON.stringify(afterBuiltin), `DSH ${instance.id} builtin/workspace inventory changed during center operations`)
  const beforeHash = await hash(beforeBuiltin), afterHash = await hash(afterBuiltin)
  check(beforeHash === afterHash, `DSH ${instance.id} builtin/workspace listing hash changed`)
  const stateFinal = await readLocalState(instance)
  installEvidence[instance.id] = {
    catalogEntry: entry,
    operationIds: {
      install: install ? install.queued.operationId : 'skipped-already-installed', enable: enable.queued.operationId, disable: disable.queued.operationId,
      disableAll: disableAll.map(item => item.operationId), finalEnable: finalEnable.queued.operationId,
    },
    state: { installedReleaseId: release.releaseId, artifactSha256: record.artifactSha256, contentTreeSha256: record.contentTreeSha256, manifestSha256: entry.manifestSha256, generationAfterInstall: stateAfterInstall.generation, generationAfterEnable: enabledGeneration, generationFinal: stateFinal.generation },
    enabledFlags: { beforeInstall: Boolean(prior?.active), afterInstall: Boolean(installed.active), afterEnable: Boolean(enabled.active), afterDisable: false, afterDisableAll: false, final: Boolean(final.active) },
    disableAll: { operationIds: disableAll.map(item => item.operationId), noneActive: true },
    signature: { verified: true, signingKeyId: manifest.signingKeyId },
    builtinWorkspace: { before: beforeBuiltin, after: afterBuiltin, beforeHash, afterHash, unchanged: beforeHash === afterHash },
  }
  eventLog(log, 'final-enabled', { releaseId: release.releaseId, generation: installations.generation, builtinWorkspaceHash: afterHash })
}

async function main() {
  await mkdir(dag, { recursive: true })
  const release = await publishV1()
  await writeEvidence('T2.3.publish.json', publishEvidence)
  await writeEvidence('T2.3.publish.log', json(publishLog))
  for (const instance of instances) {
    await installOn(instance, release)
    await writeEvidence(`T2.3.install-${instance.id}.json`, installEvidence[instance.id])
    await writeEvidence(`T2.3.install-${instance.id}.log`, json(installLogs[instance.id]))
  }
  const reasons = ['v1 published from the pinned Git commit with an independent reviewer and async worker completion', 'artifact digest matches the phase1 v1 digest', 'A/B installs verified signed manifests, default-disabled behavior, explicit enable/disable/disable-all/final-enable flows', 'builtin/workspace pack inventories are unchanged']
  await writeEvidence('T2.3.verdict.json', { node: 'T2.3', passed: true, reasons })
  await writeEvidence('T2.3.log', json({ node: 'T2.3', passed: true, events }))
  console.log(JSON.stringify({ node: 'T2.3', scriptReady: true, howToRun: 'NODE_EXTRA_CA_CERTS=... node scripts/phase2/t23-install-v1.mjs' }))
}

main().catch(async error => {
  const reason = safeError(error)
  try {
    await mkdir(dag, { recursive: true })
    if (publishEvidence) await writeEvidence('T2.3.publish.json', publishEvidence)
    for (const [id, value] of Object.entries(installEvidence)) await writeEvidence(`T2.3.install-${id}.json`, value)
    await writeEvidence('T2.3.publish.log', json(publishLog))
    for (const instance of instances) await writeEvidence(`T2.3.install-${instance.id}.log`, json(installLogs[instance.id]))
    await writeEvidence('T2.3.log', json({ node: 'T2.3', passed: false, stage, events }))
    await writeEvidence('T2.3.verdict.json', { node: 'T2.3', passed: false, reasons: [`stage ${stage} failed: ${reason}`] })
  } catch { /* Evidence failure must not expose or print sensitive state. */ }
  console.log(JSON.stringify({ node: 'T2.3', scriptReady: true, howToRun: 'NODE_EXTRA_CA_CERTS=... node scripts/phase2/t23-install-v1.mjs' }))
  process.exitCode = 1
})
