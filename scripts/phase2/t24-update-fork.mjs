#!/usr/bin/env node
/** Host-side T2.4 runner: publish v2, inspect updates, then fork A to v2. */
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const tree = fileURLToPath(new URL('../../', import.meta.url))
const dag = join(tree, 'artifacts/pack-center/phase2-20260923/dag')
const runRoot = '/tmp/p2-20260923'
const runtime = join(runRoot, 't24')
const secrets = join(runRoot, 'secrets')
const origin = 'https://127.0.0.1:18431'
const centerId = 'phase2-center-20260923'
const signingKeyId = 'phase2-key'
const artifactRoot = join(runRoot, 't22', 'artifacts')
const prefix = '/plugins/dsh-expert-library/manage/center'
const expected = {
  packId: 'macro-capital-analyst', version: '2.3.0',
  sourceUrl: 'https://github.com/weixkcornell/macro-capital-analyst.git',
  sourceCommit: 'f42bf4c8068294726ab7c780fe23ad121d72f34e',
  artifactSha256: '3d3fac90491ca858a16319c7b58db8fa45ea78840e92f1bd101cfa7fc69077e0',
  contentTreeSha256: '7c0eb511d79f2e4a20d7f1cfe45a7e0195c679e8485efd880853390f62016696',
  reportSha256: '889366b441f09a30511c3ffaa7d1306402b5911751e996f9b7b5ce132a5c3382',
}
const v1ReleaseId = 'c95d8b85-6a2f-4fbc-9310-3d28c903f834'
const instances = [{ id: 'A', port: 18281 }, { id: 'B', port: 18282 }]
const events = [], publishLog = [], checkLog = [], forkLog = []
const secretsToScan = []
let stage = 'preflight'
let publishEvidence
let state = {}

const json = value => JSON.stringify(value, null, 2) + '\n'
const fail = message => { throw new Error(message) }
const check = (value, message) => { if (!value) fail(message) }
const safeError = error => {
  const code = error?.code || error?.data?.error?.code
  return typeof code === 'string' && /^[A-Z0-9_.:-]{1,100}$/.test(code) ? code : 'REQUEST_FAILED'
}
async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT' && arguments.length > 1) return fallback; throw error }
}
async function privateWrite(path, bytes) {
  await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600)
}
async function evidence(name, value) {
  const bytes = typeof value === 'string' ? value : json(value)
  for (const secret of secretsToScan) check(!secret || !bytes.includes(secret), 'Refused to write sensitive evidence')
  await privateWrite(join(dag, name), bytes)
}
async function saveState() { await privateWrite(join(runtime, 'state.json'), json(state)) }
async function request(url, options = {}) {
  let response
  try { response = await fetch(url, { redirect: 'manual', ...options, signal: AbortSignal.timeout(20_000) }) }
  catch (error) { const e = new Error('HTTP transport failed'); e.code = safeError(error); throw e }
  const body = await response.text(); let data
  try { data = JSON.parse(body) } catch { data = undefined }
  return { status: response.status, data, body, headers: response.headers }
}

class Session {
  constructor(subject) { this.subject = subject; this.cookies = new Map(); this.csrf = undefined }
  cookieHeader() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') }
  async call(path, method = 'GET', body, expectedStatus = 200, operationKey) {
    const response = await request(`${origin}${path}`, {
      method,
      headers: {
        Origin: origin, Cookie: this.cookieHeader(),
        ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', ...(operationKey ? { 'Idempotency-Key': operationKey } : {}) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0], index = pair.indexOf('=')
      if (index > 0) { const value = pair.slice(index + 1); this.cookies.set(pair.slice(0, index), value); if (value) secretsToScan.push(value) }
    }
    events.push({ actor: this.subject, method, path: path.split('?')[0], status: response.status })
    check(response.status === expectedStatus, `Center ${method} ${path.split('?')[0]} returned ${response.status}`)
    if (response.data?.csrfToken) this.csrf = response.data.csrfToken
    return response.data
  }
  async login(invitationToken) {
    const begin = await this.call('/api/auth/login', 'POST', invitationToken ? { invitationToken } : {}, 200)
    check(typeof begin?.authorizationUrl === 'string', 'OIDC login did not return an authorization URL')
    const authorize = await request(begin.authorizationUrl, { headers: { 'x-test-identity': Buffer.from(JSON.stringify({ subject: this.subject })).toString('base64url') } })
    check(authorize.status === 302, 'OIDC authorization did not redirect')
    const callback = new URL(authorize.headers.get('location') || '')
    check(callback.origin === origin, 'OIDC callback origin mismatch')
    return this.call(callback.pathname + callback.search)
  }
}

async function local(instance, path, method = 'GET', body) {
  const url = `http://127.0.0.1:${instance.port}${path.startsWith('/plugins/') ? path : `${prefix}${path}`}`
  const response = await request(url, {
    method, headers: { 'X-Pack-Center-UI': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  events.push({ actor: instance.id, method, path, status: response.status })
  check(response.status >= 200 && response.status < 300 && response.data?.ok, `DSH ${instance.id} ${method} ${path} failed`)
  return response.data.data
}
async function waitFor(action, predicate, message, attempts = 240, interval = 500) {
  let last
  for (let n = 0; n < attempts; n++) { last = await action(); if (predicate(last)) return last; await delay(interval) }
  fail(message)
}
async function readLocalState(instance) { return readJson(join(runRoot, `pack-center-${instance.id.toLowerCase()}`, 'inventory', 'state.json')) }
async function fileDigest(path) { const bytes = await readFile(path); return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
async function treeSnapshot(root) {
  const out = []
  async function walk(dir) {
    let entries = []
    try { entries = await readdir(dir, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) out.push({ path: relative(root, path), ...(await fileDigest(path)) })
    }
  }
  await walk(root); return out.sort((a, b) => a.path.localeCompare(b.path))
}
async function centerV2Bytes() {
  // The local center store is immutable. Snapshotting the complete tree is a
  // conservative byte-level proxy for the unavailable download/grant counter;
  // any check-induced v2 artifact write would be visible here.
  return treeSnapshot(artifactRoot)
}
async function inventoryV2Snapshot(instance) {
  const root = join(runRoot, `pack-center-${instance.id.toLowerCase()}`, 'inventory', 'releases')
  const stateNow = await readLocalState(instance)
  const release = stateNow.installed?.[stateNow.acceptedReleases && Object.keys(stateNow.acceptedReleases).find(id => stateNow.acceptedReleases[id].version === expected.version)]
  const files = await treeSnapshot(root)
  const matching = files.filter(item => release?.packPath && item.path.startsWith(relative(root, release.packPath)))
  return { installedV2: Boolean(release), releaseId: release?.releaseId ?? null, fileCount: matching.length, bytes: matching.reduce((n, item) => n + item.size, 0), files: matching }
}
function eventLog(target, message, data = {}) { target.push({ at: new Date().toISOString(), message, ...data }) }

async function publishV2() {
  stage = 'publish-v2'
  const phase1 = (await readJson(join(tree, 'artifacts/pack-center/phase1-20260924-final/public-sample-versions.json')))
    .find(item => item.packId === expected.packId && item.version === expected.version)
  check(phase1, 'Phase1 v2 digest record is missing')
  Object.assign(expected, { artifactSha256: phase1.artifactSha256, contentTreeSha256: phase1.contentTreeSha256, reportSha256: phase1.reportSha256 })
  const admin = new Session('phase2-admin')
  check((await admin.login())?.principal?.platformAdmin, 'phase2-admin is not a platform administrator')
  const submissions = await admin.call('/api/submissions?organizationId=phase2&limit=100')
  let row = submissions.items?.find(item => item.packId === expected.packId && item.version === expected.version && item.source?.url === expected.sourceUrl && item.source?.ref === expected.sourceCommit)
  if (row && ['rejected', 'withdrawn', 'changes_requested', 'validation_failed'].includes(row.status)) row = undefined
  if (!row) {
    row = await admin.call('/api/submissions', 'POST', {
      organizationId: 'phase2', packId: expected.packId, name: 'Macro Capital Analyst', version: expected.version,
      source: { url: expected.sourceUrl, ref: expected.sourceCommit }, notes: 'T2.4 v2 fork publication', license: 'MIT', distribution: { kind: 'organization' },
    }, 201, 't24-create-v2')
    eventLog(publishLog, 'submission-created', { submissionId: row.id })
  } else eventLog(publishLog, 'submission-reused', { submissionId: row.id, status: row.status })
  check(row.source?.ref === expected.sourceCommit, 'Submission identity mismatch')
  let detail = await admin.call(`/api/submissions/${row.id}`)
  if (detail.submission.status === 'draft') {
    const requested = await admin.call(`/api/submissions/${row.id}/validate`, 'POST', { expectedVersion: detail.submission.stateVersion }, 202, 't24-validate-v2')
    eventLog(publishLog, 'validation-requested', { submissionId: row.id, jobId: requested.jobId })
  }
  detail = await waitFor(() => admin.call(`/api/submissions/${row.id}`), value => ['validated', 'pending_review', 'approved'].includes(value.submission.status) || value.submission.status === 'validation_failed', 'v2 validation did not settle', 240, 1000)
  check(detail.submission.status !== 'validation_failed' && detail.snapshot?.report?.valid === true, 'Validated v2 snapshot is not valid')
  check(detail.snapshot.sourceCommit === expected.sourceCommit, 'Validated v2 source commit differs from pinned commit')
  if (detail.submission.status === 'validated') {
    const submitted = await admin.call(`/api/submissions/${row.id}/submit`, 'POST', { expectedVersion: detail.submission.stateVersion }, 200, 't24-submit-v2')
    eventLog(publishLog, 'submission-submitted', { submissionId: row.id, stateVersion: submitted.stateVersion })
    detail = await admin.call(`/api/submissions/${row.id}`)
  }
  let reviewerId
  if (detail.submission.status === 'pending_review') {
    const invitation = await admin.call('/api/organizations/phase2/invitations', 'POST', { roles: ['reviewer'], expiresInMs: 3600000 }, 201, 't24-reviewer-invitation')
    secretsToScan.push(invitation.invitationToken)
    const reviewer = new Session('phase2-reviewer-v2')
    const login = await reviewer.login(invitation.invitationToken); reviewerId = login.principal?.userId
    check(typeof reviewerId === 'string' && reviewerId.length > 0, 'Independent reviewer login did not return a user id')
    await admin.call('/api/organizations/phase2/review-scopes', 'POST', { reviewerId, granted: true }, 200, 't24-review-scope')
    const approved = await reviewer.call(`/api/submissions/${row.id}/review`, 'POST', {
      expectedVersion: detail.submission.stateVersion, contentTreeSha256: detail.snapshot.contentTreeSha256,
      decision: 'approved', comment: 'Approved the pinned v2 snapshot independently for T2.4.',
    }, 200, 't24-approve-v2')
    eventLog(publishLog, 'review-approved', { submissionId: row.id, reviewId: approved.reviewId, releaseId: approved.releaseId, jobId: approved.jobId })
  }
  let published = await waitFor(() => admin.call(`/api/submissions/${row.id}`), value => value.release?.status === 'published' || value.release?.status === 'publish_failed', 'v2 publication did not finish', 240, 1000)
  if (published.release?.status === 'publish_failed') {
    const retry = await admin.call(`/api/submissions/${row.id}/retry-publication`, 'POST', { expectedReleaseVersion: published.release.stateVersion }, 202, 't24-retry-publication-v2')
    eventLog(publishLog, 'publication-retried', { submissionId: row.id, releaseId: retry.releaseId, jobId: retry.jobId })
    published = await waitFor(() => admin.call(`/api/submissions/${row.id}`), value => value.release?.status === 'published' || value.release?.status === 'publish_failed', 'v2 retried publication did not finish', 240, 1000)
  }
  check(published.release?.status === 'published', `v2 publication failed: ${published.release?.errorCode || published.release?.status}`)
  check(published.snapshot?.sourceCommit === expected.sourceCommit, 'Published v2 source commit mismatch')
  check(published.snapshot?.artifactSha256 === expected.artifactSha256 && published.snapshot?.contentTreeSha256 === expected.contentTreeSha256 && published.snapshot?.reportSha256 === expected.reportSha256, 'Published v2 digest mismatch')
  const releaseId = published.release.id
  publishEvidence = {
    submissionId: row.id, snapshotId: published.snapshot.id, releaseId, status: published.release.status,
    sourceCommit: published.snapshot.sourceCommit, artifactSha256: published.snapshot.artifactSha256,
    contentTreeSha256: published.snapshot.contentTreeSha256, reportSha256: published.snapshot.reportSha256, signingKeyId,
    phase1DigestCrossCheck: { expected: { artifactSha256: phase1.artifactSha256, contentTreeSha256: phase1.contentTreeSha256, reportSha256: phase1.reportSha256 }, actual: { artifactSha256: published.snapshot.artifactSha256, contentTreeSha256: published.snapshot.contentTreeSha256, reportSha256: published.snapshot.reportSha256 }, artifactSha256: published.snapshot.artifactSha256 === phase1.artifactSha256, contentTreeSha256: published.snapshot.contentTreeSha256 === phase1.contentTreeSha256, reportSha256: published.snapshot.reportSha256 === phase1.reportSha256 },
    reviewerId: reviewerId ?? null, publishedAt: new Date().toISOString(),
  }
  eventLog(publishLog, 'published', { submissionId: row.id, releaseId, artifactSha256: published.snapshot.artifactSha256 })
  return { releaseId, snapshot: published.snapshot }
}

async function operation(instance, input, log) {
  const existing = (await local(instance, '/operations')).find(item => item.request?.operationKey === input.operationKey)
  let queued
  if (existing) {
    const keys = ['operationKey', 'kind', 'expectedGeneration', 'releaseId', 'packId', 'connectionRevision', 'target']
    const normalized = value => JSON.stringify(Object.fromEntries(keys.filter(key => value?.[key] !== undefined).sort().map(key => [key, value[key]])))
    check(normalized(existing.request) === normalized(input), `Existing ${input.operationKey} request differs; refusing idempotency conflict`)
    queued = existing; eventLog(log, 'operation-reused', { operationId: existing.operationId, kind: input.kind, expectedGeneration: input.expectedGeneration, status: existing.status })
  } else {
    queued = await local(instance, '/operations', 'POST', input)
    eventLog(log, 'operation-enqueued', { operationId: queued.operationId, kind: input.kind, expectedGeneration: input.expectedGeneration })
  }
  const result = await waitFor(() => local(instance, `/operations/${queued.operationId}`), value => ['succeeded', 'failed', 'interrupted'].includes(value.status), `DSH ${instance.id} ${input.kind} did not complete`)
  eventLog(log, 'operation-completed', { operationId: queued.operationId, status: result.status, phase: result.phase, result: result.result, errorCode: result.errorCode })
  check(result.status === 'succeeded', `DSH ${instance.id} ${input.kind} failed: ${result.errorCode || result.result?.errorCode || result.status}`)
  return { queued, result }
}

function updateProjection(view) {
  const item = view.items?.find(row => row.packId === expected.packId)
  check(item, 'Update response omitted macro-capital-analyst')
  check(item.current?.version === '2.2.0' || item.current?.version === expected.version, `Unexpected current version ${item.current?.version}`)
  return { current: item.current, latestVisible: item.latestVisible, candidate: item.candidate, candidateCached: item.candidateCached, status: item.status, blockedReasons: item.blockedReasons }
}

async function checkUpdatesOn(instance) {
  stage = `check-updates-${instance.id}`
  const stateBefore = await readLocalState(instance), localBefore = await inventoryV2Snapshot(instance), centerBefore = await centerV2Bytes()
  const beforeHash = createHash('sha256').update(json(stateBefore)).digest('hex')
  const checkedAt = new Date().toISOString()
  const view = await local(instance, '/check-updates', 'POST', {})
  const projection = updateProjection(view)
  if (projection.current?.version === '2.2.0') check(projection.status === 'update_available' && projection.candidate?.version === expected.version, `DSH ${instance.id} did not report v2 update`)
  else check(projection.current?.version === expected.version && ['up_to_date', 'update_available'].includes(projection.status), `DSH ${instance.id} current version is not v2 after an idempotent rerun`)
  const stateAfter = await readLocalState(instance), localAfter = await inventoryV2Snapshot(instance), centerAfter = await centerV2Bytes()
  const afterHash = createHash('sha256').update(json(stateAfter)).digest('hex')
  check(stateAfter.generation === stateBefore.generation && afterHash === beforeHash, `DSH ${instance.id} check-updates mutated local state`)
  check(JSON.stringify(localAfter) === JSON.stringify(localBefore), `DSH ${instance.id} check-updates changed local v2 inventory/download evidence`)
  check(JSON.stringify(centerAfter) === JSON.stringify(centerBefore), `Center v2 artifact bytes changed during ${instance.id} check-updates`)
  const row = { id: instance.id, checkedAt, current: projection.current, latestVisible: projection.latestVisible, candidate: projection.candidate, candidateCached: projection.candidateCached, status: projection.status,
    generation: { before: stateBefore.generation, after: stateAfter.generation, unchanged: true }, localStateSha256: { before: beforeHash, after: afterHash, unchanged: true },
    downloadCount: { method: 'deployment inventory v2 release file/byte snapshot; check-updates has no download/grant side effect', before: localBefore, after: localAfter, unchanged: true },
    centerDownloadCount: { method: 'immutable center artifact-root v2 byte snapshot; management API exposes no exact counter', before: centerBefore, after: centerAfter, unchanged: true, source: 'apps/pack-center/src/catalog.ts download_grants and audit_events are append-only but not exposed by a read route' },
    responseGeneration: view.generation, checkedAtResponse: view.checkedAt,
  }
  checkLog.push({ id: instance.id, checkedAt, projection, generationBefore: stateBefore.generation, generationAfter: stateAfter.generation })
  return row
}

async function cacheAndEnableA(instance, release) {
  stage = 'fork-A'
  const beforePublish = state.publishSnapshot?.A
  const beforeInstallations = await local(instance, '/installations')
  const catalog = await local(instance, `/catalog?packId=${encodeURIComponent(expected.packId)}`)
  const entry = catalog.items?.find(item => item.releaseId === release.releaseId)
  check(entry && entry.version === expected.version && entry.artifactSha256 === expected.artifactSha256 && entry.contentTreeSha256 === expected.contentTreeSha256 && entry.manifestSha256, 'A catalog does not contain the v2 release')
  const beforeState = await readLocalState(instance), beforeInventory = await inventoryV2Snapshot(instance)
  const beforeActiveV2 = beforeInstallations.items.some(item => item.releaseId === release.releaseId && item.active)
  if (beforeActiveV2) {
    const runtime = await runtimeEvidence(instance)
    check(beforeInstallations.items.some(item => item.releaseId === v1ReleaseId && item.version === '2.2.0'), 'A active-v2 rerun lost its v1 rollback target')
    return { beforePublish, before: { generation: beforeState.generation, active: beforeState.active?.[expected.packId] ?? null, installedV2: beforeInventory },
      install: { operationId: 'skipped-already-cached', generationBefore: beforeInstallations.generation, generationAfter: beforeInstallations.generation, cached: { releaseId: release.releaseId, version: expected.version, active: true }, inventory: beforeInventory },
      updateEnable: { operationId: 'skipped-already-active', generationBefore: beforeInstallations.generation, generationAfter: beforeInstallations.generation, active: { releaseId: release.releaseId, version: expected.version }, inventoryBefore: beforeInventory, inventoryAfter: beforeInventory },
      rollbackTarget: { releaseId: v1ReleaseId, version: '2.2.0', installed: true }, runtime, rerun: true }
  }
  let installResult = null
  const alreadyCached = beforeInstallations.items.some(item => item.releaseId === release.releaseId && item.integrity === 'verified')
  if (!alreadyCached) {
    installResult = await operation(instance, { operationKey: `t24-${instance.id}-install-${release.releaseId}`, kind: 'install', expectedGeneration: beforeInstallations.generation,
      connectionRevision: (await local(instance, '/connection')).revision, target: { manifestSha256: entry.manifestSha256, artifactSha256: entry.artifactSha256, contentTreeSha256: entry.contentTreeSha256 }, releaseId: release.releaseId }, forkLog)
  } else eventLog(forkLog, 'install-skipped-already-cached', { releaseId: release.releaseId })
  const afterInstall = await local(instance, '/installations'), afterInstallState = await readLocalState(instance), afterInstallInventory = await inventoryV2Snapshot(instance)
  const cached = afterInstall.items.find(item => item.releaseId === release.releaseId)
  check(cached?.integrity === 'verified' && cached.active === false, 'A install must cache v2 without enabling it')
  check(afterInstallState.active?.[expected.packId] === v1ReleaseId, 'A v1 must remain active after cache install')
  check(afterInstallInventory.installedV2 && afterInstallInventory.fileCount > 0, 'A v2 inventory copy is missing after cache install')
  const generationAfterInstall = afterInstall.generation
  const beforeEnable = await local(instance, '/installations')
  const enableResult = cached.active ? null : await operation(instance, { operationKey: `t24-${instance.id}-update-enable-${release.releaseId}`, kind: 'update_enable', expectedGeneration: beforeEnable.generation,
    connectionRevision: (await local(instance, '/connection')).revision, target: { manifestSha256: entry.manifestSha256, artifactSha256: entry.artifactSha256, contentTreeSha256: entry.contentTreeSha256 }, releaseId: release.releaseId }, forkLog)
  const finalInstallations = await local(instance, '/installations'), finalState = await readLocalState(instance), finalInventory = await inventoryV2Snapshot(instance)
  const active = finalInstallations.items.find(item => item.releaseId === release.releaseId), old = finalInstallations.items.find(item => item.releaseId === v1ReleaseId)
  check(active?.active === true && active.version === expected.version, 'A update_enable did not activate v2')
  check(old && old.version === '2.2.0', 'A rollback target v1 is no longer installed')
  check(finalState.active?.[expected.packId] === release.releaseId && finalState.installed?.[v1ReleaseId], 'A durable state does not retain v1 rollback target')
  check(finalInstallations.generation > generationAfterInstall && finalState.generation === finalInstallations.generation, 'A update_enable did not increment generation')
  check(finalInventory.fileCount === afterInstallInventory.fileCount && finalInventory.bytes === afterInstallInventory.bytes, 'A update_enable redownloaded the cached v2 copy')
  const runtime = await runtimeEvidence(instance)
  const record = { beforePublish, before: { generation: beforeState.generation, active: beforeState.active?.[expected.packId] ?? null, installedV2: beforeInventory },
    install: { operationId: installResult?.queued.operationId ?? 'skipped-already-cached', generationBefore: beforeInstallations.generation, generationAfter: afterInstall.generation, cached: { releaseId: cached.releaseId, version: cached.version, active: cached.active }, inventory: afterInstallInventory },
    updateEnable: { operationId: enableResult?.queued.operationId ?? 'skipped-already-active', generationBefore: beforeEnable.generation, generationAfter: finalInstallations.generation, active: { releaseId: active.releaseId, version: active.version }, inventoryBefore: afterInstallInventory, inventoryAfter: finalInventory },
    rollbackTarget: { releaseId: old.releaseId, version: old.version, installed: true }, runtime,
  }
  return record
}

async function runtimeEvidence(instance) {
  const installations = await local(instance, '/installations')
  const packsResponse = await request(`http://127.0.0.1:${instance.port}/plugins/dsh-expert-library/packs`)
  check(packsResponse.status === 200 && Array.isArray(packsResponse.data?.packs), `DSH ${instance.id} runtime pack view unavailable`)
  events.push({ actor: instance.id, method: 'GET', path: '/plugins/dsh-expert-library/packs', status: packsResponse.status })
  const active = installations.items.find(item => item.source === 'center' && item.active && item.packId === expected.packId)
  return { at: new Date().toISOString(), activeVersion: active?.version ?? null, activeReleaseId: active?.releaseId ?? null, generation: installations.generation,
    installations: installations.items.filter(item => item.packId === expected.packId).map(item => ({ releaseId: item.releaseId, version: item.version, active: item.active, integrity: item.integrity })),
    runtimePacks: packsResponse.data.packs.filter(item => item.id === expected.packId).map(item => ({ id: item.id, version: item.version, layer: item.layer, ok: item.ok })), }
}

async function captureBrowser(id, port, tab, assertText) {
  const { spawn } = await import('node:child_process')
  const result = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['scripts/phase2/t22-capture.mjs'], {
      cwd: tree,
      env: { ...process.env, CAPTURE_INSTANCE: id, CAPTURE_TAB: tab, CAPTURE_ASSERT: assertText, CAPTURE_OUT: `T2.4.${tab}-${id}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { err += d })
    child.on('exit', code => code === 0 ? resolvePromise({ id, tab, assertText }) : rejectPromise(Object.assign(new Error(`capture ${id} ${tab} failed: ${err.slice(-300)}`), { code: 'CAPTURE_FAILED' })))
  })
  return result
}

async function main() {
  await mkdir(dag, { recursive: true, mode: 0o700 }); await mkdir(runtime, { recursive: true, mode: 0o700 }); await chmod(runtime, 0o700); await mkdir(secrets, { recursive: true, mode: 0o700 })
  state = await readJson(join(runtime, 'state.json'), {})
  const release = await publishV2()
  await evidence('T2.4.publish.json', publishEvidence); await evidence('T2.4.publish.log', json(publishLog))
  // Capture the post-publication state before any check or operation. This is
  // the proof that publication itself did not switch either deployment.
  if (!state.publishSnapshot) {
    state.publishSnapshot = { capturedAt: new Date().toISOString(), releaseId: release.releaseId }
    for (const instance of instances) {
      const localInstallations = await local(instance, '/installations'), localState = await readLocalState(instance)
      state.publishSnapshot[instance.id] = { generation: localState.generation, active: localState.active?.[expected.packId] ?? null, installations: localInstallations.items.filter(item => item.packId === expected.packId).map(item => ({ releaseId: item.releaseId, version: item.version, active: item.active })) }
    }
    await saveState()
  }
  const checkEvidence = {}
  for (const instance of instances) { checkEvidence[instance.id] = await checkUpdatesOn(instance); await evidence('T2.4.check-updates.json', checkEvidence) }
  await evidence('T2.4.check-updates.json', checkEvidence); await evidence('T2.4.check-updates.log', json(checkLog))
  const fork = { releaseId: release.releaseId, publishSnapshot: state.publishSnapshot, A: await cacheAndEnableA(instances[0], release), B: null }
  const b = instances[1], bBefore = await readLocalState(b), bBeforeInv = await inventoryV2Snapshot(b)
  const bCheck = await local(b, '/check-updates', 'POST', {}), bProjection = updateProjection(bCheck), bAfter = await readLocalState(b), bAfterInv = await inventoryV2Snapshot(b)
  check(bAfter.active?.[expected.packId] === v1ReleaseId && !bAfterInv.installedV2, 'B changed or cached v2 unexpectedly')
  check(bAfter.generation === bBefore.generation && JSON.stringify(bAfterInv) === JSON.stringify(bBeforeInv), 'B state changed during final update check')
  fork.B = { before: { generation: bBefore.generation, active: bBefore.active?.[expected.packId] ?? null, inventory: bBeforeInv }, after: { generation: bAfter.generation, active: bAfter.active?.[expected.packId] ?? null, inventory: bAfterInv }, check: updateProjection(bCheck), runtime: await runtimeEvidence(b) }
  fork.finalStates = {}
  for (const instance of instances) { const s = await readLocalState(instance); fork.finalStates[instance.id] = { capturedAt: new Date().toISOString(), generation: s.generation, active: s.active?.[expected.packId] ?? null, installed: Object.values(s.installed ?? {}).filter(item => item.packId === expected.packId).map(item => ({ releaseId: item.releaseId, version: item.version })) } }
  await evidence('T2.4.fork.json', fork); await evidence('T2.4.fork.log', json(forkLog)); await evidence('T2.4.log', json({ node: 'T2.4', passed: true, events }))
  const captures = [await captureBrowser('A', 18281, '更新', expected.version), await captureBrowser('B', 18282, '已安装', '2.2.0')]
  await evidence('T2.4.browser.json', captures)
  const reasons = ['v2 was published from the pinned commit with validation and independent reviewer approval; all three phase1 digests match', 'A check-updates reported 2.3.0 without changing generation/state or downloading bytes', 'A cached v2 install remained default-disabled, then explicit update_enable activated v2 while retaining v1 for rollback and without a second download', 'B reported the same update but remained active on and installed with v1; publication caused no automatic state change', 'runtime and browser evidence captured both requested tabs']
  await evidence('T2.4.verdict.json', { node: 'T2.4', passed: true, reasons })
  console.log(JSON.stringify({ node: 'T2.4', scriptReady: true }))
}

main().catch(async error => {
  const reason = safeError(error) + (error && error.message && error.message !== 'HTTP transport failed' ? `: ${String(error.message).replace(/dpc_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 300)}` : '')
  try {
    await mkdir(dag, { recursive: true, mode: 0o700 }); await evidence('T2.4.publish.json', publishEvidence ?? { status: 'not-completed' }); await evidence('T2.4.publish.log', json(publishLog)); await evidence('T2.4.check-updates.log', json(checkLog)); await evidence('T2.4.fork.log', json(forkLog)); await evidence('T2.4.log', json({ node: 'T2.4', passed: false, stage, events })); await evidence('T2.4.verdict.json', { node: 'T2.4', passed: false, reasons: [`stage ${stage} failed: ${reason}`] })
  } catch { /* preserve the fixed safe stdout contract */ }
  console.log(JSON.stringify({ node: 'T2.4', scriptReady: true })); process.exitCode = 1
})
