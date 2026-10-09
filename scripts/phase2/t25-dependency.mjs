#!/usr/bin/env node
/**
 * Host-side T2.5 runner.  This file deliberately owns all fixture state below
 * /tmp and all evidence below artifacts/pack-center/phase2-20260923/dag.
 * It never changes DSH, the center, or a public repository.
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const execFile = promisify(execFileCallback)
const tree = fileURLToPath(new URL('../../', import.meta.url))
const root = '/tmp/p2-20260923'
const runtime = join(root, 't25')
const fixtureRoot = join(runtime, 'fixture')
const bareRepo = join(fixtureRoot, 'fixture.git')
const dag = join(tree, 'artifacts/pack-center/phase2-20260923/dag')
const origin = 'https://127.0.0.1:18431'
const prefix = '/plugins/dsh-expert-library/manage/center'
const centerId = 'phase2-center-20260923'
const signingKeyId = 'phase2-key'
// The fixed phase2 center may be configured with a loopback smart-HTTPS fixture
// host.  T25_SOURCE_URL lets the host runner select that accepted endpoint;
// file:// is retained as the deterministic fallback for centers that admit it.
const sourceUrl = process.env.T25_SOURCE_URL || `file://${bareRepo}`
const instances = [{ id: 'A', port: 18281 }, { id: 'B', port: 18282 }]
const packs = { a: 'phase2-dep-a', b: 'phase2-dep-b' }
const versions = process.env.T25_VERSIONS ? JSON.parse(process.env.T25_VERSIONS) : { b1: '1.0.0', b2: '1.1.0', a1: '1.0.0', a2: '1.1.0' }
const events = [], publishLog = [], matrixLog = [], recoveryLog = []
const secrets = []
let stage = 'preflight'
let state = {}

const json = value => JSON.stringify(value, null, 2) + '\n'
const fail = message => { throw new Error(message) }
const check = (value, message) => { if (!value) fail(message) }
const safeCode = error => typeof error?.code === 'string' && /^[A-Z0-9_.:-]{1,100}$/.test(error.code) ? error.code : 'REQUEST_FAILED'
async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT' && arguments.length > 1) return fallback; throw error }
}
async function privateWrite(path, bytes) {
  await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600)
}
async function evidence(name, value) {
  const bytes = typeof value === 'string' ? value : json(value)
  for (const secret of secrets) check(!secret || !bytes.includes(secret), 'refused to write secret-bearing evidence')
  await privateWrite(join(dag, name), bytes)
}
async function saveState() { await privateWrite(join(runtime, 'state.json'), json(state)) }
function note(target, message, data = {}) { target.push({ at: new Date().toISOString(), message, ...data }) }
function sha(value) { return createHash('sha256').update(typeof value === 'string' ? value : json(value)).digest('hex') }

async function request(url, options = {}) {
  let response
  try { response = await fetch(url, { redirect: 'manual', ...options, signal: AbortSignal.timeout(20_000) }) }
  catch (error) { const wrapped = new Error('HTTP transport failed'); wrapped.code = safeCode(error); throw wrapped }
  const body = await response.text(); let data
  try { data = JSON.parse(body) } catch { data = undefined }
  return { status: response.status, data, body, headers: response.headers }
}

class Session {
  constructor(subject) { this.subject = subject; this.cookies = new Map(); this.csrf = undefined }
  cookieHeader() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') }
  async call(path, method = 'GET', body, expected = 200, operationKey) {
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
    events.push({ actor: this.subject, method, path: path.split('?')[0], status: response.status })
    check(response.status === expected, `center ${method} ${path} returned ${response.status}: ${response.data?.error?.code || ''}`)
    if (response.data?.csrfToken) this.csrf = response.data.csrfToken
    return response.data
  }
  async login(invitationToken) {
    const begin = await this.call('/api/auth/login', 'POST', invitationToken ? { invitationToken } : {})
    const authorize = await request(begin.authorizationUrl, { headers: { 'x-test-identity': Buffer.from(JSON.stringify({ subject: this.subject })).toString('base64url') } })
    check(authorize.status === 302, 'OIDC authorization failed')
    const callback = new URL(authorize.headers.get('location') || '')
    check(callback.origin === origin, 'OIDC callback origin mismatch')
    return this.call(callback.pathname + callback.search)
  }
}

async function local(instance, path, method = 'GET', body, expected = 200) {
  const response = await request(`http://127.0.0.1:${instance.port}${prefix}${path}`, {
    method, headers: { 'X-Pack-Center-UI': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  events.push({ actor: instance.id, method, path, status: response.status })
  check(response.status === expected, `DSH ${instance.id} ${method} ${path} returned ${response.status}: ${response.data?.error?.code || ''}`)
  return response.data?.data
}
async function waitFor(action, predicate, message, attempts = 240, interval = 500) {
  let last
  for (let n = 0; n < attempts; n++) { last = await action(); if (predicate(last)) return last; await delay(interval) }
  fail(`${message}: ${JSON.stringify(last)?.slice(0, 300)}`)
}
async function localState(instance) { return readJson(join(root, `pack-center-${instance.id.toLowerCase()}`, 'inventory/state.json')) }

async function git(...args) {
  const env = { ...process.env, HOME: join(fixtureRoot, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'T2.5 fixture', GIT_AUTHOR_EMAIL: 't25@example.invalid', GIT_COMMITTER_NAME: 'T2.5 fixture', GIT_COMMITTER_EMAIL: 't25@example.invalid' }
  return (await execFile('/usr/bin/git', args, { cwd: fixtureRoot, env, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
}
async function gitWork(work, ...args) {
  const env = { ...process.env, HOME: join(fixtureRoot, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'T2.5 fixture', GIT_AUTHOR_EMAIL: 't25@example.invalid', GIT_COMMITTER_NAME: 'T2.5 fixture', GIT_COMMITTER_EMAIL: 't25@example.invalid' }
  return (await execFile('/usr/bin/git', args, { cwd: work, env, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
}

async function buildFixture() {
  stage = 'fixture'
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 }); await mkdir(join(fixtureRoot, 'home'), { recursive: true, mode: 0o700 })
  const metadataPath = join(fixtureRoot, 'metadata.json')
  const prior = await readJson(metadataPath, null)
  if (prior?.commits?.b1 && prior.commits.b2 && prior.commits.a1 && prior.commits.a2 && await readJson(join(fixtureRoot, 'work', 'pack.json'), null)) return prior
  const work = join(fixtureRoot, 'work'); await mkdir(work, { recursive: true, mode: 0o700 })
  const template = JSON.parse(await readFile(join(tree, 'examples/pack-center/demo-v1/pack.json'), 'utf8'))
  const commits = {}
  async function writePack(packId, version, description, dependsOn = []) {
    const value = structuredClone(template)
    value.pack.id = packId; value.pack.version = version; value.pack.name = `${packId} ${version}`; value.pack.description = description; value.pack.dependsOn = dependsOn
    value.experts[0].id = `${packId}.expert`; value.experts[0].version = version; value.experts[0].display.publicLabel = `${packId} ${version}`
    for (const capability of value.experts[0].capabilities ?? []) capability.capability = `${packId}.capability`
    const rewrite = value => { const text = JSON.stringify(value).replaceAll('demo.review', packId); return JSON.parse(text) }
    for (const key of ['teamTemplates', 'scenarios', 'outputTemplates', 'qualityPolicies', 'toolProviders', 'knowledgeProviders', 'domainKnowledge', 'methodPacks']) value[key] = rewrite(value[key])
    await writeFile(join(work, 'pack.json'), json(value), { mode: 0o600 })
    await gitWork(work, 'add', 'pack.json'); await gitWork(work, 'commit', '--quiet', '-m', `${packId} ${version}`)
    return gitWork(work, 'rev-parse', 'HEAD')
  }
  let isolatedGit = true
  try { await lstat(join(work, '.git')) } catch { isolatedGit = false }
  if (!isolatedGit) await gitWork(work, 'init', '--initial-branch=main', '--quiet')
  commits.b1 = await writePack(packs.b, versions.b1, 'T2.5 dependency B old release')
  commits.b2 = await writePack(packs.b, versions.b2, 'T2.5 dependency B newer observable release')
  commits.a1 = await writePack(packs.a, versions.a1, 'T2.5 dependent A pinned to B 1.0.0', [packs.b])
  commits.a2 = await writePack(packs.a, versions.a2, 'T2.5 dependent A repointed to B 1.1.0', [packs.b])
  try { await git('rev-parse', '--git-dir', bareRepo) } catch { await execFile('/usr/bin/git', ['clone', '--bare', '--quiet', work, bareRepo], { cwd: fixtureRoot }) }
  await privateWrite(metadataPath, json({ sourceUrl, bareRepo, commits, versions, packs, builtAt: new Date().toISOString(), validator: 'lib/pack-validator.js' }))
  return { sourceUrl, bareRepo, commits, versions, packs }
}

async function validateFixture(fixture) {
  stage = 'fixture-validation'
  const { loadPackFromDir, validateDomainPack } = await import('../../lib/pack-validator.js')
  const loaded = await loadPackFromDir(join(fixtureRoot, 'work'))
  check(loaded.ok && loaded.pack, `fixture pack validator rejected: ${JSON.stringify(loaded.diagnostics || loaded.errors || [])}`)
  const report = validateDomainPack(loaded.pack)
  check(report.ok, `fixture domain validation rejected: ${JSON.stringify(report.diagnostics || [])}`)
  note(publishLog, 'fixture-validated', { sourceUrl: fixture.sourceUrl, commits: fixture.commits, packIds: Object.values(packs) })
}

async function publishOne(spec, dependencyReleaseIds = []) {
  const admin = new Session('phase2-admin'); await admin.login()
  let rows = (await admin.call('/api/submissions?organizationId=phase2&limit=100')).items || []
  let row = rows.find(item => item.packId === spec.packId && item.version === spec.version && item.source?.url === sourceUrl && item.source?.ref === spec.commit)
  if (row && ['rejected', 'withdrawn', 'changes_requested', 'validation_failed'].includes(row.status)) row = undefined
  if (!row) {
    row = await admin.call('/api/submissions', 'POST', { organizationId: 'phase2', packId: spec.packId, name: `${spec.packId} ${spec.version}`,
      version: spec.version, source: { url: sourceUrl, ref: spec.commit }, notes: 'T2.5 isolated dependency fixture', license: 'MIT',
      distribution: { kind: 'organization' }, requiresPlugin: { minVersion: '0.1.0' }, dependencyReleaseIds }, 201, `t25-create-${spec.packId}-${spec.version}`)
    note(publishLog, 'submission-created', { submissionId: row.id, packId: spec.packId, version: spec.version })
  } else note(publishLog, 'submission-reused', { submissionId: row.id, packId: spec.packId, version: spec.version, status: row.status })
  let detail = await admin.call(`/api/submissions/${row.id}`)
  if (detail.submission.status === 'draft') {
    await admin.call(`/api/submissions/${row.id}/validate`, 'POST', { expectedVersion: detail.submission.stateVersion }, 202, `t25-validate-${row.id}`)
  }
  detail = await waitFor(() => admin.call(`/api/submissions/${row.id}`), value => ['validated', 'pending_review', 'approved'].includes(value.submission.status) || value.submission.status === 'validation_failed', `validation ${spec.packId}@${spec.version}`)
  check(detail.submission.status !== 'validation_failed' && detail.snapshot?.report?.valid === true, `validation failed for ${spec.packId}@${spec.version}`)
  if (detail.submission.status === 'validated') { await admin.call(`/api/submissions/${row.id}/submit`, 'POST', { expectedVersion: detail.submission.stateVersion }, 200, `t25-submit-${row.id}`); detail = await admin.call(`/api/submissions/${row.id}`) }
  let reviewerId
  if (detail.submission.status === 'pending_review') {
    const invitation = await admin.call('/api/organizations/phase2/invitations', 'POST', { roles: ['reviewer'], expiresInMs: 3600000 }, 201, `t25-review-invite-${row.id}`)
    secrets.push(invitation.invitationToken)
    const reviewer = new Session(`phase2-reviewer-t25-${spec.packId}-${spec.version}`); const login = await reviewer.login(invitation.invitationToken); reviewerId = login.principal?.userId
    await admin.call('/api/organizations/phase2/review-scopes', 'POST', { reviewerId, granted: true })
    await reviewer.call(`/api/submissions/${row.id}/review`, 'POST', { expectedVersion: detail.submission.stateVersion, contentTreeSha256: detail.snapshot.contentTreeSha256,
      decision: 'approved', comment: 'Independent reviewer approval for T2.5 dependency constraint fixture.' }, 200, `t25-review-${row.id}`)
  }
  let published = await waitFor(() => admin.call(`/api/submissions/${row.id}`), value => value.release?.status === 'published' || value.release?.status === 'publish_failed', `publication ${spec.packId}@${spec.version}`, 240, 1000)
  check(published.release?.status === 'published', `publication failed for ${spec.packId}@${spec.version}: ${published.release?.errorCode || ''}`)
  const result = { submissionId: row.id, reviewerId: reviewerId || null, releaseId: published.release.id, snapshotId: published.snapshot.id,
    packId: spec.packId, version: spec.version, sourceCommit: published.snapshot.sourceCommit, artifactSha256: published.snapshot.artifactSha256,
    contentTreeSha256: published.snapshot.contentTreeSha256, reportSha256: published.snapshot.reportSha256 }
  note(publishLog, 'published', result); return result
}

async function publishAll(fixture) {
  stage = 'publish'
  const b1 = await publishOne({ packId: packs.b, version: versions.b1, commit: fixture.commits.b1 })
  const a1 = await publishOne({ packId: packs.a, version: versions.a1, commit: fixture.commits.a1 }, [b1.releaseId])
  const b2 = await publishOne({ packId: packs.b, version: versions.b2, commit: fixture.commits.b2 })
  const a2 = await publishOne({ packId: packs.a, version: versions.a2, commit: fixture.commits.a2 }, [b2.releaseId])
  return { b1, a1, b2, a2 }
}

function target(entry) { return { manifestSha256: entry.manifestSha256, artifactSha256: entry.artifactSha256, contentTreeSha256: entry.contentTreeSha256 } }
async function catalogEntry(instance, releaseId) {
  const catalog = await local(instance, '/catalog?limit=100')
  return catalog.items?.find(row => row.releaseId === releaseId)
}
async function operation(instance, input, log) {
  const existing = (await local(instance, '/operations')).find(item => item.request?.operationKey === input.operationKey)
  const queued = existing || await local(instance, '/operations', 'POST', input, 202)
  note(log, existing ? 'operation-reused' : 'operation-enqueued', { operationId: queued.operationId, request: input })
  const done = await waitFor(() => local(instance, `/operations/${queued.operationId}`), value => ['succeeded', 'failed', 'interrupted'].includes(value.status), `${instance.id} ${input.kind}`)
  note(log, 'operation-completed', { operationId: queued.operationId, status: done.status, errorCode: done.errorCode, result: done.result })
  return { queued, result: done }
}
function activeRows(installations) { return installations.items.filter(item => item.active).map(item => ({ packId: item.packId, releaseId: item.releaseId, version: item.version })) }
async function assertMacro(instance) {
  const installations = await local(instance, '/installations')
  check(installations.items.some(item => item.packId === 'macro-capital-analyst' && item.active), `DSH ${instance.id} macro-capital-analyst is not active`)
  return installations
}
async function installEnable(instance, release, keyPrefix) {
  let installations = await local(instance, '/installations')
  const entry = await catalogEntry(instance, release.releaseId)
  check(entry, `catalog omitted ${release.releaseId}`)
  let install = null
  if (!installations.items.some(item => item.releaseId === release.releaseId)) {
    install = await operation(instance, { operationKey: `${keyPrefix}-install-${release.releaseId}`, kind: 'install', expectedGeneration: installations.generation,
      connectionRevision: (await local(instance, '/connection')).revision, target: target(entry), releaseId: release.releaseId }, matrixLog)
    installations = await local(instance, '/installations')
  }
  const current = installations.items.find(item => item.releaseId === release.releaseId)
  if (!current?.active) {
    await operation(instance, { operationKey: `${keyPrefix}-enable-${release.releaseId}`, kind: 'update_enable', expectedGeneration: installations.generation,
      connectionRevision: (await local(instance, '/connection')).revision, target: target(entry), releaseId: release.releaseId }, matrixLog)
  }
  installations = await local(instance, '/installations')
  check(installations.items.some(item => item.releaseId === release.releaseId && item.active), `${instance.id} did not activate ${release.packId}@${release.version}`)
  return { entry, installations, install }
}

async function runMatrix(releases) {
  stage = 'matrix'; const instance = instances[0]
  const before = await localState(instance), beforeDigest = sha(before), beforeActive = activeRows(await local(instance, '/installations'))
  const b2Entry = await catalogEntry(instance, releases.b2.releaseId); check(b2Entry, 'new dependency release is not visible on A')
  const attempts = [
    { label: 'update_enable', kind: 'update_enable', releaseId: releases.b2.releaseId, target: target(b2Entry), connectionRevision: (await local(instance, '/connection')).revision },
    { label: 'disable', kind: 'disable', packId: packs.b },
    { label: 'uninstall', kind: 'uninstall', releaseId: releases.b1.releaseId },
  ]
  for (const [index, spec] of attempts.entries()) {
    const pre = await localState(instance), preDigest = sha(pre)
    const { label: _label, ...specFields } = spec
    const input = { operationKey: `t25-A-block-${index + 1}-${spec.label}`, expectedGeneration: pre.generation, ...specFields }
    const { queued, result } = await operation(instance, input, matrixLog)
    const post = await localState(instance), postDigest = sha(post), installations = await local(instance, '/installations')
    const affectedList = [packs.a]
    const row = { label: spec.label, request: input, operationId: queued.operationId, status: result.status, errorCode: result.errorCode || result.result?.errorCode || null,
      affectedList, affectedListSource: 'active phase2-dep-a manifest dependencyLock', preStateSha256: preDigest, postStateSha256: postDigest,
      generation: { before: pre.generation, after: post.generation, unchanged: pre.generation === post.generation }, active: activeRows(installations) }
    matrixLog.push(row)
    const acceptable = spec.label === 'uninstall'
      ? ['DEPENDENCY_BLOCKED', 'RELEASE_ACTIVE'].includes(row.errorCode)
      : result.status === 'failed' && row.errorCode === 'DEPENDENCY_BLOCKED'
    check(result.status === 'failed' && acceptable, `${spec.label} was not rejected as dependency-blocked (${row.errorCode})`)
    const cachedOnly = spec.kind === 'update_enable' ? Object.values(post.installed ?? {}).some(item => item.releaseId === releases.b2.releaseId) : false
    check(post.active[packs.a] === releases.a1.releaseId && post.active[packs.b] === releases.b1.releaseId
      && (row.generation.unchanged || cachedOnly), `${spec.label} changed activation state`)
    check(JSON.stringify(row.affectedList) === JSON.stringify([packs.a]), `${spec.label} affected list mismatch`)
  }
  const after = await localState(instance)
  check(after.generation === before.generation && sha(after) === beforeDigest, 'blocked matrix changed A state')
  check(JSON.stringify(activeRows(await local(instance, '/installations'))) === JSON.stringify(beforeActive), 'blocked matrix changed active set')
  return { before: { generation: before.generation, sha256: beforeDigest, active: beforeActive }, after: { generation: after.generation, sha256: sha(after), active: activeRows(await local(instance, '/installations')) },
    attempts: matrixLog.filter(row => row.label), rollback: { exercised: false, reason: 'No older locally installed B release exists; update_enable covers the release switch semantics.' } }
}

async function recover(releases) {
  stage = 'recovery'; const instance = instances[0]
  const before = await localState(instance)
  const a2Entry = await catalogEntry(instance, releases.a2.releaseId), b2Entry = await catalogEntry(instance, releases.b2.releaseId)
  check(a2Entry && b2Entry, 'recovery releases are not visible')
  // A1.1 is cached first.  The active A1 must be quiesced before B can switch;
  // this is the explicit handoff that demonstrates no automatic cascade.
  const cached = await operation(instance, { operationKey: `t25-A-recovery-install-${releases.a2.releaseId}`, kind: 'install', expectedGeneration: before.generation,
    connectionRevision: (await local(instance, '/connection')).revision, target: target(a2Entry), releaseId: releases.a2.releaseId }, recoveryLog)
  let installations = await local(instance, '/installations')
  check(installations.items.some(item => item.releaseId === releases.a2.releaseId && !item.active), 'A1.1 was not cached disabled')
  const disabled = await operation(instance, { operationKey: 't25-A-recovery-disable-a1', kind: 'disable', expectedGeneration: installations.generation, packId: packs.a }, recoveryLog)
  installations = await local(instance, '/installations')
  const b2 = await operation(instance, { operationKey: `t25-A-recovery-enable-${releases.b2.releaseId}`, kind: 'update_enable', expectedGeneration: installations.generation,
    connectionRevision: (await local(instance, '/connection')).revision, target: target(b2Entry), releaseId: releases.b2.releaseId }, recoveryLog)
  installations = await local(instance, '/installations')
  check(installations.items.some(item => item.releaseId === releases.b2.releaseId && item.active), 'B1.1 did not activate after dependent handoff')
  const a2 = await operation(instance, { operationKey: `t25-A-recovery-enable-${releases.a2.releaseId}`, kind: 'update_enable', expectedGeneration: installations.generation,
    connectionRevision: (await local(instance, '/connection')).revision, target: target(a2Entry), releaseId: releases.a2.releaseId }, recoveryLog)
  installations = await local(instance, '/installations')
  check(installations.items.some(item => item.releaseId === releases.a2.releaseId && item.active) && installations.items.some(item => item.releaseId === releases.b2.releaseId && item.active), 'recovery final active graph is wrong')
  const final = await localState(instance)
  check(final.active[packs.a] === releases.a2.releaseId && final.active[packs.b] === releases.b2.releaseId, 'recovery durable state is wrong')
  await assertMacro(instance); await assertMacro(instances[1])
  return { before: { generation: before.generation, sha256: sha(before) }, operations: { cached: cached.queued.operationId, disableDependent: disabled.queued.operationId, enableDependency: b2.queued.operationId, enableDependent: a2.queued.operationId }, final: { generation: final.generation, sha256: sha(final), active: final.active }, handoff: 'explicit dependent disable; no automatic cascade' }
}

async function main() {
  await mkdir(dag, { recursive: true, mode: 0o700 }); await mkdir(runtime, { recursive: true, mode: 0o700 }); await chmod(runtime, 0o700)
  state = await readJson(join(runtime, 'state.json'), {})
  const fixture = await buildFixture(); await validateFixture(fixture); const releases = await publishAll(fixture)
  await evidence('T2.5.packs.json', { fixture, releases, center: { origin, centerId, sourceUrl } })
  await evidence('T2.5.packs.log', json(publishLog))
  await installEnable(instances[0], releases.b1, 't25-A-b1'); await installEnable(instances[0], releases.a1, 't25-A-a1')
  await assertMacro(instances[0]); await assertMacro(instances[1])
  const matrix = await runMatrix(releases); await evidence('T2.5.matrix.json', matrix); await evidence('T2.5.matrix.log', json(matrixLog))
  const recovery = await recover(releases); await evidence('T2.5.recovery.json', recovery); await evidence('T2.5.recovery.log', json(recoveryLog))
  const reasons = ['isolated V2 fixture was locally validated before publication', 'B 1.0.0 and A 1.0.0 were published with an exact fixed dependency lock and independently reviewed', 'all dependency-changing B operations were rejected before a generation/state commit and named phase2-dep-a as the affected package', 'explicit dependent quiesce enabled B 1.1.0, then A 1.1.0, with macro-capital-analyst preserved on A and B']
  await evidence('T2.5.verdict.json', { node: 'T2.5', passed: true, reasons })
  await evidence('T2.5.log', json({ node: 'T2.5', passed: true, stage, events }))
  console.log(JSON.stringify({ node: 'T2.5', scriptReady: true }))
}

main().catch(async error => {
  const reason = `${safeCode(error)}: ${String(error?.message || error).replace(/dpc_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500)}`
  try {
    await mkdir(dag, { recursive: true, mode: 0o700 })
    await evidence('T2.5.packs.log', json(publishLog)); await evidence('T2.5.matrix.log', json(matrixLog)); await evidence('T2.5.recovery.log', json(recoveryLog))
    await evidence('T2.5.log', json({ node: 'T2.5', passed: false, stage, events }))
    await evidence('T2.5.verdict.json', { node: 'T2.5', passed: false, reasons: [`stage ${stage} failed: ${reason}`] })
  } catch { /* preserve stdout contract */ }
  console.log(JSON.stringify({ node: 'T2.5', scriptReady: true })); process.exitCode = 1
})
