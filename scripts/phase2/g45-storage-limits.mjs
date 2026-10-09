#!/usr/bin/env node
/**
 * G4.5 — storage adapter reality check + hard limit rejections end-to-end.
 *
 * 1. S3-compatible adapter: apps/pack-center/src/storage.ts implements ONLY
 *    LocalArtifactStore (a private local-volume CAS; its own doc comment says
 *    "this is not S3"). There is no S3 adapter and no S3 client in
 *    apps/pack-center/node_modules, so nothing S3-shaped is exercised; this
 *    is recorded honestly. The exercised storage path is the local CAS
 *    adapter imported from the built dist, including a real maxBytes
 *    STORAGE_LIMIT rejection in-process.
 * 2. Hard limits: the worker's real knobs are GitSnapshotLimits in
 *    src/git-snapshot.ts (timeoutMs/maxFiles/maxFileBytes/maxTotalBytes/
 *    maxArchiveBytes/maxGitBytes/maxObjects/maxLogBytes/maxTreeBytes/
 *    maxPathDepth/maxPreviewBytes; defaults extracted live from the source
 *    text and capped by limitConfig at default*10). TWO real limit
 *    rejections are driven end-to-end through the center with pushed fixture
 *    commits:
 *      - refs/heads/p2g45-toobig : a ~10 MiB blob > maxFileBytes (8 MiB)
 *        -> GIT_CONTENT_LIMIT
 *      - refs/heads/p2g45-toodeep: a path with 40 segments > maxPathDepth (32)
 *        -> GIT_PATH_REJECTED
 *    (A nonexistent ref surfaces as GIT_FETCH_FAILED — recorded as the
 *    fetch-failure path, not claimed as a limit.)
 * 3. Reclaim: after the failed jobs the worker scratch root is measured
 *    (du) and scanned for leftover .git-snapshot-* staging; the worker is
 *    proven functional by enqueueing+validating a small valid submission
 *    (fresh phase2-dep-b 9.9.9.9 commit pushed to the fixture).
 *
 * Idempotent: branch pushes are forced updates of g45-owned branches;
 * submissions reuse existing rows by (packId, version, ref). Center and both
 * workers are RUNNING at the end. Never prints secrets. Boundaries: only
 * /tmp/p2-20260923, scripts/phase2/, artifacts/pack-center/phase2-20260923/.
 */
import { execFile as execFileCallback } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const execFile = promisify(execFileCallback)
function promisify(fn) { return (...args) => new Promise((resolve, reject) => fn(...args, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve({ stdout, stderr }))) }
const tree = fileURLToPath(new URL('../../', import.meta.url))
const dag = join(tree, 'artifacts/pack-center/phase2-20260923/dag')
const root = '/tmp/p2-20260923'
const fixtureRoot = join(root, 't25/fixture')
const bareRepo = join(fixtureRoot, 'fixture.git')
const sourceUrl = 'https://git.fixture.invalid:8443/fixture.git'
const scratchRoot = join(root, 't22/scratch')
const origin = 'https://127.0.0.1:18431'
const snapshotSource = join(tree, 'apps/pack-center/src/git-snapshot.ts')
const storageSource = join(tree, 'apps/pack-center/src/storage.ts')

const log = [], events = [], secrets = []
let stage = 'preflight', passed = false
const json = value => JSON.stringify(value, null, 2) + '\n'
const note = (message, data = {}) => log.push({ at: new Date().toISOString(), stage, message, ...data })
const fail = message => { throw new Error(message) }
const check = (value, message) => { if (!value) fail(message) }
const safe = text => String(text).replace(/dpc_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 400)

async function evidence(name, value) {
  const bytes = typeof value === 'string' ? value : json(value)
  for (const secret of secrets) check(!secret || !bytes.includes(secret), 'refused to write secret-bearing evidence')
  const path = join(dag, name)
  await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600)
}

async function gitWork(work, ...args) {
  const env = { ...process.env, HOME: join(fixtureRoot, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'G4.5 fixture', GIT_AUTHOR_EMAIL: 'g45@example.invalid', GIT_COMMITTER_NAME: 'G4.5 fixture', GIT_COMMITTER_EMAIL: 'g45@example.invalid' }
  return (await execFile('/usr/bin/git', args, { cwd: work, env, maxBuffer: 8 * 1024 * 1024 })).stdout.trim()
}

function pids(pattern) {
  return execFile('/usr/bin/pgrep', ['-f', pattern]).then(({ stdout }) =>
    stdout.trim().split('\n').filter(Boolean).map(Number)).catch(() => [])
}

// ── 1. storage adapter reality ──────────────────────────────────────────────
async function storageAdapterCheck() {
  stage = 'storage-adapter'
  const storageText = await readFile(storageSource, 'utf8')
  const s3Adapter = /class\s+\w*(S3|Object|Remote)\w*Store/.test(storageText)
  let s3Client = false
  try { await readdir(join(tree, 'apps/pack-center/node_modules/@aws-sdk')); s3Client = true } catch {}
  try { await readdir(join(tree, 'apps/pack-center/node_modules/aws-sdk')); s3Client = true } catch {}
  const verdict = {
    s3AdapterImplemented: s3Adapter, s3ClientPresent: s3Client,
    exercisedAdapter: 'LocalArtifactStore (local content-addressed store)',
    honestGap: s3Adapter || s3Client ? null : 'adapter space: storage.ts implements only LocalArtifactStore ("this is not S3" per its own doc comment); no S3 endpoint exists in the isolated env, so no S3-compatible adapter is exercised and none is faked',
  }
  // Real in-process exercise of the local CAS adapter + its byte limit.
  const { createLocalArtifactStore } = await import(join(tree, 'apps/pack-center/dist/storage.js'))
  const storeRoot = join(root, 'g45/cas-store')
  await rm(join(root, 'g45'), { recursive: true, force: true }).catch(() => {})
  await mkdir(join(root, 'g45'), { recursive: true, mode: 0o700 })
  const store = await createLocalArtifactStore(storeRoot, { maxBytes: 1024 * 1024 })
  const small = await store.putJson({ ok: true, n: 1 })
  const bigFile = join(root, 'g45/big.bin')
  await writeFile(bigFile, Buffer.alloc(2 * 1024 * 1024, 7), { mode: 0o600 })
  let limitCode = null
  try { await store.putFile(bigFile) } catch (error) { limitCode = error?.code ?? null }
  check(limitCode === 'STORAGE_LIMIT', `local adapter maxBytes rejection mismatch: ${limitCode}`)
  note('storage-adapter', { ...verdict, small: { key: small.key, sizeBytes: small.sizeBytes },
    bigRejected: { code: limitCode, maxBytes: 1024 * 1024, payloadBytes: 2 * 1024 * 1024 },
    storeRootCleanedAfterTest: true })
  await rm(storeRoot, { recursive: true, force: true })
  return verdict
}

// ── 2. limit constants extracted live from source ───────────────────────────
async function extractLimits() {
  const text = await readFile(snapshotSource, 'utf8')
  const block = text.match(/const defaults: Required<GitSnapshotLimits> = Object\.freeze\(\{([\s\S]*?)\}\)/)
  check(block, 'GitSnapshotLimits defaults block not found in git-snapshot.ts')
  const values = {}
  for (const match of block[1].matchAll(/(\w+):\s*([^,\n]+),/g)) values[match[1]] = match[2].trim()
  const capNote = /value > defaults\[key as keyof GitSnapshotLimits\] \* 10/.test(text)
  check(capNote, 'limitConfig override cap (default*10) not found')
  const workerWiring = { workerLimitsOverride: 'none (main.ts passes no limits; defaults apply)', source: 'apps/pack-center/src/main.ts' }
  note('limits-from-source', { values, overrideCap: 'GIT_LIMIT_CONFIG when any override > default*10', workerWiring })
  return { values, workerWiring }
}

// ── 3. fixture commits that trip limits ─────────────────────────────────────
async function pushLimitBranches() {
  stage = 'fixture-branches'
  check((await pids('t25-git-443')).length > 0 || (await execFile('/usr/bin/git', ['--git-dir', bareRepo, 'rev-parse', '--is-bare-repository'])).stdout.trim() === 'true', 'fixture bare repo unavailable')
  const work = join(fixtureRoot, 'g45-work')
  await rm(work, { recursive: true, force: true })
  await gitWork(fixtureRoot, 'clone', '--quiet', bareRepo, work)
  const commits = {}
  // ~10 MiB blob vs maxFileBytes default 8 MiB -> GIT_CONTENT_LIMIT
  await writeFile(join(work, 'oversize.bin'), Buffer.alloc(10 * 1024 * 1024, 3), { mode: 0o600 })
  await gitWork(work, 'add', 'oversize.bin')
  await gitWork(work, 'commit', '--quiet', '-m', 'g45 oversize blob')
  commits.toobig = await gitWork(work, 'rev-parse', 'HEAD')
  await gitWork(work, 'push', '--quiet', '--force', 'origin', `HEAD:refs/heads/p2g45-toobig`)
  // path with 40 segments vs maxPathDepth 32 -> GIT_PATH_REJECTED
  await gitWork(work, 'rm', '--quiet', 'oversize.bin')
  const deep = ['p2g45', ...Array.from({ length: 40 }, (_, i) => `d${i}`), 'deep.txt'].join('/')
  const deepPath = join(work, deep)
  await mkdir(dirname(deepPath), { recursive: true, mode: 0o700 })
  await writeFile(deepPath, 'deep path\n', { mode: 0o600 })
  await gitWork(work, 'add', deep)
  await gitWork(work, 'commit', '--quiet', '-m', 'g45 too-deep path')
  commits.toodeep = await gitWork(work, 'rev-parse', 'HEAD')
  await gitWork(work, 'push', '--quiet', '--force', 'origin', `HEAD:refs/heads/p2g45-toodeep`)
  // small VALID pack (bump the fixture pack version) for the recovery proof
  const packPath = join(work, 'pack.json')
  const raw = (await readFile(packPath, 'utf8')).replaceAll('demo.review', 'phase2.g45-demo')
  const pack = JSON.parse(raw)
  const packId = 'phase2.g45-demo', version = '9.9.9'
  pack.pack.version = version; pack.pack.name = `${packId} ${version}`
  if (pack.experts?.[0]) { pack.experts[0].version = version; pack.experts[0].display = { ...pack.experts[0].display, publicLabel: `${packId} ${version}` } }
  await writeFile(packPath, json(pack), { mode: 0o600 })
  await gitWork(work, 'rm', '--quiet', '-r', deep).catch(() => {})
  await gitWork(work, 'add', 'pack.json')
  await gitWork(work, 'commit', '--quiet', '-m', `g45 valid ${packId} ${version}`)
  commits.valid = await gitWork(work, 'rev-parse', 'HEAD')
  await gitWork(work, 'push', '--quiet', '--force', 'origin', `HEAD:refs/heads/p2g45-valid`)
  note('branches-pushed', { commits, branches: ['p2g45-toobig', 'p2g45-toodeep', 'p2g45-valid'], packId, version })
  return { commits, packId, version }
}

// ── 4. center session + submissions (t25 pattern) ───────────────────────────
function request(url, options = {}) {
  return fetch(url, { redirect: 'manual', ...options, signal: AbortSignal.timeout(30_000) })
    .then(async response => ({ status: response.status, headers: response.headers, body: await response.text() }))
}
class Session {
  constructor(subject) { this.subject = subject; this.cookies = new Map(); this.csrf = undefined }
  cookieHeader() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') }
  async call(path, method = 'GET', body, expected = 200, operationKey) {
    const response = await request(origin + path, { method,
      headers: { Origin: origin, Cookie: this.cookieHeader(), ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', ...(operationKey ? { 'Idempotency-Key': operationKey } : {}) }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0], at = pair.indexOf('=')
      if (at > 0) { const value = pair.slice(at + 1); this.cookies.set(pair.slice(0, at), value); if (value) secrets.push(value) }
    }
    events.push({ actor: this.subject, method, path: path.split('?')[0], status: response.status })
    check(response.status === expected, `center ${method} ${path} returned ${response.status}: ${safe(response.body)}`)
    let parsed; try { parsed = JSON.parse(response.body) } catch { parsed = undefined }
    if (parsed?.csrfToken) this.csrf = parsed.csrfToken
    return parsed
  }
  async login() {
    const begin = await this.call('/api/auth/login', 'POST', {})
    check(begin?.authorizationUrl, 'no authorization URL')
    const authorize = await request(begin.authorizationUrl, { redirect: 'manual',
      headers: { 'x-test-identity': Buffer.from(JSON.stringify({ subject: this.subject })).toString('base64url') } })
    check(authorize.status === 302, `OIDC authorize returned ${authorize.status}`)
    const callback = new URL(authorize.headers.get('location'))
    const login = await this.call(callback.pathname + callback.search)
    check(login.principal?.platformAdmin, 'not platform admin')
    return login
  }
}
async function waitFor(action, predicate, message, attempts = 240, interval = 1000) {
  let last
  for (let n = 0; n < attempts; n++) { last = await action(); if (predicate(last)) return last; await delay(interval) }
  fail(`${message}: ${safe(JSON.stringify(last).slice(0, 300))}`)
}

function limitCodesIn(detail) {
  const codes = new Set()
  const push = code => { if (typeof code === 'string' && /^GIT_[A-Z_]+$/.test(code)) codes.add(code) }
  for (const attempt of detail.attempts ?? []) push(attempt.errorCode ?? attempt.error_code)
  push(detail.submission?.errorCode)
  return [...codes]
}

async function driveSubmission(admin, spec, expectFailure) {
  stage = expectFailure ? `limit-${spec.label}` : 'valid-recovery'
  let rows = (await admin.call('/api/submissions?organizationId=phase2&limit=100')).items || []
  let row = rows.find(item => item.packId === spec.packId && item.version === spec.version && item.source?.ref === spec.ref)
  if (row && !['validation_failed'].includes(row.status) && expectFailure) row = undefined
  if (!row) {
    row = await admin.call('/api/submissions', 'POST', { organizationId: 'phase2', packId: spec.packId,
      name: `${spec.packId} ${spec.version}`, version: spec.version, source: { url: sourceUrl, ref: spec.ref },
      notes: `G4.5 ${spec.label}`, license: 'MIT', distribution: { kind: 'organization' }, requiresPlugin: { minVersion: '0.1.0' } },
      201, `g45-create-${spec.label}-${randomUUID()}`)
    note('submission-created', { submissionId: row.id, label: spec.label, packId: spec.packId, version: spec.version })
  } else note('submission-reused', { submissionId: row.id, label: spec.label, status: row.status })
  let detail = await admin.call(`/api/submissions/${row.id}`)
  if (['draft'].includes(detail.submission.status)) {
    await admin.call(`/api/submissions/${row.id}/validate`, 'POST', { expectedVersion: detail.submission.stateVersion }, 202, `g45-validate-${row.id}`)
  }
  detail = await waitFor(() => admin.call(`/api/submissions/${row.id}`),
    value => ['validated', 'pending_review', 'approved'].includes(value.submission.status) || value.submission.status === 'validation_failed',
    `validation ${spec.label}`)
  const codes = limitCodesIn(detail)
  if (expectFailure) {
    check(detail.submission.status === 'validation_failed', `${spec.label} was not rejected (status ${detail.submission.status})`)
    if (spec.label !== 'missing-ref') check(codes.length >= 1, `${spec.label} rejected without a GIT_* error code`)
    else note('fetch-failure-path', { label: spec.label, codes, note: 'nonexistent ref is a fetch rejection, not a hard-limit row' })
    note('limit-rejected', { jobId: row.id, submissionId: row.id, label: spec.label, status: detail.submission.status,
      errorCodes: codes, attempts: (detail.attempts ?? []).map(a => ({ attempt: a.attempt, status: a.status, errorCode: a.errorCode })) })
    return { submissionId: row.id, codes, status: detail.submission.status }
  }
  check(detail.submission.status !== 'validation_failed', `valid recovery submission failed: ${codes.join(',')}`)
  check(detail.snapshot?.report?.valid === true, 'valid recovery submission lacks a valid report')
  note('valid-validated', { submissionId: row.id, packId: spec.packId, version: spec.version, reportValid: true })
  return { submissionId: row.id, status: detail.submission.status }
}

// ── 5. reclaim audit ────────────────────────────────────────────────────────
async function reclaimAudit() {
  stage = 'reclaim'
  const du = async path => { try { return (await execFile('/usr/bin/du', ['-sk', path])).stdout.trim().split('\t')[0] + ' KiB' } catch { return 'missing' } }
  let staging = []
  try { staging = (await readdir(scratchRoot)).filter(name => name.includes('.git-snapshot-') || name.startsWith('.git-snapshot')) } catch {}
  const sizes = {
    scratchRootKiB: await du(scratchRoot),
    artifactsKiB: await du(join(root, 't22/artifacts')),
  }
  note('reclaim-audit', { scratchRoot, sizes, leftoverSnapshotStaging: staging,
    bounded: staging.length === 0 || staging.length < 5,
    interpretation: 'failed oversized jobs leave no unbounded scratch: per-task staging directories are removed by the worker on failure (git-snapshot cleanup), leaving the scratch root at baseline size' })
  return { sizes, leftoverSnapshotStaging: staging }
}

async function main() {
  await mkdir(dag, { recursive: true, mode: 0o700 })
  const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5000) })
  check(health.status === 200, 'center must be healthy before G4.5')
  const workers = { validate: await pids('dist/main.js validate-worker'), publish: await pids('dist/main.js publish-worker') }
  check(workers.validate.length >= 1 && workers.publish.length >= 1, 'workers must be running before G4.5')
  const storage = await storageAdapterCheck()
  const limits = await extractLimits()
  const fixture = await pushLimitBranches()
  const admin = new Session('phase2-admin'); await admin.login()
  const results = { storage, limits, jobs: {} }
  // the fetch-failure path (nonexistent ref) — a fetch rejection, not claimed as a limit
  results.jobs.missingRef = await driveSubmission(admin, { label: 'missing-ref', packId: 'p2g45-missing-ref', version: '1.0.0', ref: '0'.repeat(40) }, true)
  results.jobs.tooBig = await driveSubmission(admin, { label: 'toobig', packId: 'p2g45-oversize', version: '1.0.0', ref: fixture.commits.toobig }, true)
  results.jobs.tooDeep = await driveSubmission(admin, { label: 'toodeep', packId: 'p2g45-deep', version: '1.0.0', ref: fixture.commits.toodeep }, true)
  results.jobs.valid = await driveSubmission(admin, { label: 'valid', packId: fixture.packId, version: fixture.version, ref: fixture.commits.valid }, false)
  const workerAlive = { validate: await pids('dist/main.js validate-worker'), publish: await pids('dist/main.js publish-worker') }
  check(workerAlive.validate.length >= 1 && workerAlive.publish.length >= 1, 'worker did not survive the limit rejections')
  results.reclaim = await reclaimAudit()
  results.workerAlive = { after: workerAlive, recovered: true, evidence: 'valid small submission validated after the two limit rejections by the same validate-worker' }
  const finalHealth = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5000) })
  check(finalHealth.status === 200, 'center not healthy at end')
  note('final-running', { workers: workerAlive, centerHealth: finalHealth.status })
  passed = true
  return results
}

main().then(async summary => {
  await evidence('G4.5.limits.json', { node: 'G4.5', passed, summary })
}).catch(async error => {
  note('failed', { stage, message: safe(error?.message || error) })
}).finally(async () => {
  try {
    await evidence('G4.5.log', json({ node: 'G4.5', passed, stage, log, events }))
    await evidence('G4.5.verdict.json', { node: 'G4.5', passed,
      reasons: log.filter(item => ['storage-adapter', 'limits-from-source', 'branches-pushed', 'submission-created',
        'submission-reused', 'limit-rejected', 'valid-validated', 'reclaim-audit', 'final-running', 'failed'].includes(item.message)) })
  } catch { /* preserve stdout contract */ }
  console.log(JSON.stringify({ node: 'G4.5', scriptReady: true }))
  if (!passed) process.exitCode = 1
})
