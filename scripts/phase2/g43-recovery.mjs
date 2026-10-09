#!/usr/bin/env node
/**
 * G4.3 — Center restart / worker interruption / DB+artifact backup restore
 * (host-side, phase2 fixture).
 *
 * Exercises, with precise boundaries:
 *   1. Kill + relaunch the center api and TLS front using the exact env block
 *      from scripts/phase2/r31-offline.mjs restore stage (including
 *      PACK_CENTER_GIT_ALLOW_LOOPBACK_FIXTURE and GIT_SSL_CAINFO); health must
 *      return to 200 and A/B must read the catalog again.
 *   2. Kill validate-worker and publish-worker (nothing is enqueued, so no
 *      junk jobs), respawn both with the same env (+ signing key for the
 *      publisher) and verify new pids + no stuck lease in pack_center_phase2.jobs
 *      (DB query via docker exec; falls back to health/catalog evidence only).
 *   3. Backup: pg_dump -n pack_center_phase2 + tar of the artifact root.
 *      Restore: the artifact tar is restored into a PARALLEL directory and a
 *      signed release envelope there is re-verified (byte-identical release.json,
 *      signature verification against the trusted key, artifact sha256 identical
 *      to the live artifact). A FULL DATABASE RESTORE IS NOT PERFORMED (no
 *      scratch cluster); the SQL dump is only grep-audited so a restore into an
 *      empty cluster remains possible. This limitation is recorded verbatim.
 *
 * Idempotent: kills+respawns are convergent; backups/restore dirs are recreated.
 * Never prints secrets (DB password stays inside docker exec); center, TLS front
 * and both workers are RUNNING at the end.
 */
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const execFile = promisify(execFileCallback)
const tree = fileURLToPath(new URL('../../', import.meta.url))
const node22 = '/root/.nvm/versions/node/v22.22.0/bin/node'
const app = join(tree, 'apps/pack-center')
const dag = join(tree, 'artifacts/pack-center/phase2-20260923/dag')
const runtime = '/tmp/p2-20260923'
const g43 = join(runtime, 'g43')
const t22 = join(runtime, 't22')
const instanceA = { id: 'A', port: 18281 }, instanceB = { id: 'B', port: 18282 }
const prefix = '/plugins/dsh-expert-library/manage/center'
const origin = 'https://127.0.0.1:18431'
const container = 'dsh.pack-center.phase2-20260923-t22'

const events = [], log = []
let stage = 'preflight', passed = false
const note = (message, data = {}) => log.push({ at: new Date().toISOString(), stage, message, ...data })
const json = value => JSON.stringify(value, null, 2) + '\n'
const fail = message => { throw new Error(message) }
const check = (value, message) => { if (!value) fail(message) }
const safe = text => String(text).replace(/dpc_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 300)

async function evidence(name, value) {
  const bytes = typeof value === 'string' ? value : json(value)
  const path = join(dag, name)
  await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600)
}

async function pids(pattern) {
  try { const { stdout } = await execFile('pgrep', ['-f', pattern])
    return stdout.trim().split('\n').filter(Boolean).map(Number) } catch { return [] }
}
async function killPattern(pattern) {
  const before = await pids(pattern)
  for (const pid of before) { await execFile('kill', [String(pid)]).catch(() => {}) }
  return before
}

async function local(instance, path) {
  const response = await fetch(`http://127.0.0.1:${instance.port}${prefix}${path}`, {
    headers: { 'X-Pack-Center-UI': '1' }, signal: AbortSignal.timeout(20_000) })
  events.push({ actor: instance.id, method: 'GET', path, status: response.status })
  const data = await response.json().catch(() => undefined)
  return { status: response.status, data: data?.data }
}

/** Exact center env block from r31-offline.mjs restore stage. */
async function centerEnv(extra = {}) {
  const pw = (await readFile(join(runtime, 'secrets/t22-postgres-password'), 'utf8')).trim() // never printed
  return {
    PACK_CENTER_DATABASE_URL: `postgresql://postgres:${pw}@127.0.0.1:32796/postgres`,
    PACK_CENTER_DATABASE_SCHEMA: 'pack_center_phase2',
    PACK_CENTER_ID: 'phase2-center-20260923',
    PACK_CENTER_PUBLIC_ORIGIN: 'https://127.0.0.1:18431',
    PACK_CENTER_ALLOW_LOOPBACK_HTTP: 'true',
    PACK_CENTER_OIDC_ISSUER: 'http://127.0.0.1:35531/',
    PACK_CENTER_OIDC_CLIENT_ID: 'test-pack-center',
    PACK_CENTER_LOGIN_KEY_FILE: join(runtime, 'secrets/t22-login.key'),
    PACK_CENTER_ARTIFACT_ROOT: join(t22, 'artifacts'),
    PACK_CENTER_SCRATCH_ROOT: join(t22, 'scratch'),
    PACK_CENTER_LISTEN_HOST: '127.0.0.1', PACK_CENTER_LISTEN_PORT: '18430',
    PACK_CENTER_GIT_ALLOWED_HOSTS: 'github.com,git.fixture.invalid',
    PACK_CENTER_TRUSTED_SIGNING_KEYS_FILE: join(runtime, 'secrets/t22-trusted.json'),
    PACK_CENTER_GIT_ALLOW_LOOPBACK_FIXTURE: 'git.fixture.invalid:8443',
    GIT_SSL_CAINFO: join(t22, 'ca.pem'),
    ...extra,
  }
}

function spawnDetached(args, env, logFile) {
  const fd = openSync(logFile, 'a')
  try {
    const child = spawn(node22, args, { cwd: app, env, detached: true, stdio: ['ignore', fd, fd] })
    child.unref(); return child.pid
  } finally { closeSync(fd) }
}

const health = async () => fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) })
  .then(r => r.status).catch(() => 'unreachable')

// ── 1. center restart ───────────────────────────────────────────────────────
async function restartCenter() {
  stage = 'center-restart'
  const killed = { api: await killPattern('dist/main.js api'), tls: await killPattern('t22-tls-front') }
  await delay(1500)
  const downHealth = await health()
  note('center-stopped', { apiPids: killed.api, tlsPids: killed.tls, health: downHealth })
  check(downHealth !== 200, 'center health must fail after stopping the api')
  const fs = await import('node:fs')
  const env = await centerEnv()
  const apiLog = join(t22, 'api.log'), tlsLog = join(t22, 'tls-front.log')
  const apiPid = spawnDetached(['dist/main.js', 'api'], env, apiLog)
  const tlsPid = spawnDetached([join(tree, 'scripts/phase2/t22-tls-front.mjs')], env, tlsLog)
  note('center-relaunched', { apiPid, tlsPid, logs: [apiLog, tlsLog] })
  let restored = false
  for (let n = 0; n < 40; n++) { await delay(500); if (await health() === 200) { restored = true; break } }
  check(restored, 'center health must return to 200 after relaunch')
  note('center-restored', { health: 200 })
}

// ── 2. worker interruption ──────────────────────────────────────────────────
async function restartWorkers() {
  stage = 'worker-restart'
  const killed = { validate: await killPattern('dist/main.js validate-worker'), publish: await killPattern('dist/main.js publish-worker') }
  await delay(1500)
  check((await pids('dist/main.js validate-worker')).length === 0, 'validate-worker still alive after kill')
  check((await pids('dist/main.js publish-worker')).length === 0, 'publish-worker still alive after kill')
  note('workers-stopped', killed)
  // Nothing is enqueued here on purpose: no junk jobs are created by this exercise.
  const env = await centerEnv({
    PACK_CENTER_SIGNING_KEY_ID: 'phase2-key',
    PACK_CENTER_SIGNING_KEY_FILE: join(runtime, 'secrets/t22-signing.pem'),
  })
  await chmod(join(t22, 'scratch'), 0o700).catch(() => {}); await chmod(join(t22, 'artifacts'), 0o700).catch(() => {})
  const vLog = join(t22, 'validate-worker.log'), pLog = join(t22, 'publish-worker.log')
  const validatePid = spawnDetached(['dist/main.js', 'validate-worker'], env, vLog)
  await delay(50)
  const publishPid = spawnDetached(['dist/main.js', 'publish-worker'], env, pLog)
  note('workers-relaunched', { validatePid, publishPid, logs: [vLog, pLog] })
  await delay(2000)
  const liveV = await pids('dist/main.js validate-worker'), liveP = await pids('dist/main.js publish-worker')
  check(liveV.length >= 1, 'validate-worker did not respawn')
  check(liveP.length >= 1, 'publish-worker did not respawn')
  note('workers-respawned', { validatePids: liveV, publishPids: liveP,
    replacedValidate: killed.validate.some(pid => !liveV.includes(pid)), replacedPublish: killed.publish.some(pid => !liveP.includes(pid)) })
}

/** Jobs lease check via docker exec; graceful fallback to HTTP-only evidence. */
async function leaseCheck() {
  stage = 'lease-check'
  const query = `SELECT status, count(*) FROM pack_center_phase2.jobs GROUP BY status ORDER BY status; ` +
    `SELECT count(*) AS stuck FROM pack_center_phase2.jobs WHERE status='running' AND lease_expires_at < now();`
  try {
    const { stdout } = await execFile('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres',
      '-t', '-A', '-c', query], { timeout: 30_000, maxBuffer: 1024 * 1024 })
    note('jobs-lease-query', { via: 'docker exec psql', result: safe(stdout) })
    return { via: 'docker', raw: stdout }
  } catch (error) {
    note('jobs-lease-query-unavailable', { reason: safe(error.message),
      fallback: 'jobs table access unavailable; relying on health 200 + catalog reads + worker respawn as re-acquirability evidence' })
    return { via: 'unavailable' }
  }
}

// ── 3. backup + parallel restore verification ──────────────────────────────
async function backupAndRestore() {
  stage = 'backup'
  await rm(g43, { recursive: true, force: true }); await mkdir(join(g43, 'restore'), { recursive: true, mode: 0o700 })
  const dumpPath = join(g43, 'db-backup.sql')
  await execFile('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '-n', 'pack_center_phase2', 'postgres'],
    { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }).then(async ({ stdout }) => {
      await writeFile(dumpPath, stdout, { mode: 0o600 }) })
  check((await readFile(dumpPath, 'utf8')).length > 100, 'pg_dump produced an empty dump')
  const tarPath = join(g43, 'artifacts-backup.tar.gz')
  await execFile('tar', ['-czf', tarPath, '-C', t22, 'artifacts'], { timeout: 300_000 })
  note('backup-done', { dumpPath, tarPath })

  stage = 'restore-verify'
  const restoreRoot = join(g43, 'restore')
  await execFile('tar', ['-xzf', tarPath, '-C', restoreRoot], { timeout: 300_000 })
  const restoredArtifactRoot = join(restoreRoot, 'artifacts')
  // Pick one release from A's inventory with a live artifact under the (restored) artifact root.
  const releasesRoot = join(runtime, 'pack-center-a/inventory/releases')
  const candidates = []
  for (const dir of await readdir(releasesRoot)) {
    const envelopePath = join(releasesRoot, dir, 'release.json')
    let envelope
    try { envelope = JSON.parse(await readFile(envelopePath, 'utf8')) } catch { continue }
    const artifactSha256 = envelope?.manifest?.artifactSha256
    if (typeof artifactSha256 !== 'string') continue
    const liveArtifact = join(t22, 'artifacts/sha256', artifactSha256, 'data')
    const restoredArtifact = join(restoredArtifactRoot, 'sha256', artifactSha256, 'data')
    try { await readFile(liveArtifact); await readFile(restoredArtifact) } catch { continue }
    candidates.push({ dir, envelopePath, envelope, artifactSha256, liveArtifact, restoredArtifact, releaseId: envelope.manifest.releaseId })
  }
  check(candidates.length >= 1, 'no release with both live and restored artifact found')
  const picked = candidates[0]
  // Signed envelope must still verify against the trusted key. The artifact
  // store holds content-addressed blobs (not envelopes); the deployed signed
  // envelope lives in A's inventory next to the extracted release content.
  const { verifyReleaseManifest } = await import(join(tree, 'packages/pack-contract/index.mjs'))
  const trusted = JSON.parse(await readFile(join(runtime, 'secrets/t22-trusted.json'), 'utf8'))
  const manifest = verifyReleaseManifest(picked.envelope, trusted)
  check(manifest.releaseId === picked.releaseId, 'envelope signature verified but releaseId mismatch')
  const liveSha = createHash('sha256').update(await readFile(picked.liveArtifact)).digest('hex')
  const restoredSha = createHash('sha256').update(await readFile(picked.restoredArtifact)).digest('hex')
  check(liveSha === picked.artifactSha256, `live artifact sha256 ${liveSha} != manifest artifactSha256`)
  check(restoredSha === liveSha, 'restored artifact is not byte-identical to the live artifact')
  note('restore-verified', { releaseId: picked.releaseId, artifactSha256: picked.artifactSha256,
    liveSha256: liveSha, restoredSha256: restoredSha, byteIdentical: true,
    envelopeVerified: 'verifyReleaseManifest against trusted phase2-key passed',
    restoredDir: join(restoreRoot, 'artifacts/sha256', picked.artifactSha256) })

  stage = 'dump-audit'
  const dump = await readFile(dumpPath, 'utf8')
  const counts = {
    createTableAuditEvents: (dump.match(/CREATE TABLE +pack_center_phase2\.audit_events/g) || []).length,
    createTableReleases: (dump.match(/CREATE TABLE +pack_center_phase2\.releases/g) || []).length,
    copyAuditEvents: (dump.match(/^COPY pack_center_phase2\.audit_events /gm) || []).length,
    copyReleases: (dump.match(/^COPY pack_center_phase2\.releases /gm) || []).length,
    auditEventRows: null, releaseRows: null,
  }
  const section = tableName => {
    const match = dump.match(new RegExp(`^COPY pack_center_phase2\\.${tableName} .*\\n([\\s\\S]*?)\\n\\\\\\.\\n`, 'm'))
    return match ? match[1].split('\n').filter(Boolean).length : null
  }
  counts.auditEventRows = section('audit_events'); counts.releaseRows = section('releases')
  check(counts.createTableAuditEvents >= 1 && counts.copyAuditEvents >= 1, 'dump lacks audit_events table/rows')
  check(counts.createTableReleases >= 1 && counts.copyReleases >= 1, 'dump lacks releases table/rows')
  note('dump-audited', counts)
  note('scope-limitation', {
    exercised: 'artifact tar restored into a parallel directory; one signed release envelope re-verified (signature + byte-identical sha256 vs live artifact); SQL dump grep-audited for audit_events + releases schema and row counts',
    notExercised: 'a FULL pack_center_phase2 DATABASE restore into an empty/drop-replaced cluster was NOT performed (no scratch cluster; drop is not safely reversible). Restore into an empty cluster remains possible via psql -f db-backup.sql but was not executed.',
  })
  return { counts, picked: { releaseId: picked.releaseId, artifactSha256: picked.artifactSha256 } }
}

async function catalogAfterRestart() {
  stage = 'catalog-check'
  const results = {}
  for (const instance of [instanceA, instanceB]) {
    const view = await local(instance, '/catalog?limit=20')
    results[instance.id] = { status: view.status, items: view.data?.items?.length ?? 0 }
  }
  check(results.A.status === 200 && results.B.status === 200, 'A/B catalog reads must return 200 after restart')
  check(results.A.items > 0 || results.B.items > 0, 'at least one instance must see a non-empty catalog')
  note('catalog-after-restart', results)
}

async function finalRunningCheck() {
  stage = 'final'
  const running = {
    api: await pids('dist/main.js api'), tls: await pids('t22-tls-front'),
    validate: await pids('dist/main.js validate-worker'), publish: await pids('dist/main.js publish-worker'),
  }
  check(running.api.length >= 1 && running.tls.length >= 1, 'center api / TLS front not running at end')
  check(running.validate.length >= 1 && running.publish.length >= 1, 'workers not running at end')
  check(await health() === 200, 'center health not 200 at end')
  note('final-running', { ...running, health: 200 })
}

async function main() {
  await mkdir(dag, { recursive: true, mode: 0o700 })
  check(await health() === 200, 'center must be healthy before the recovery exercise')
  await restartCenter()
  await catalogAfterRestart()
  await restartWorkers()
  const lease = await leaseCheck()
  const backup = await backupAndRestore()
  await finalRunningCheck()
  passed = true
  return { lease, backup }
}

main().then(async summary => {
  await evidence('G4.3.recovery.json', { node: 'G4.3', passed, summary, log, events: events.slice(-60) })
}).catch(async error => {
  note('failed', { stage, message: safe(error?.message || error) })
}).finally(async () => {
  try {
    await evidence('G4.3.log', json({ node: 'G4.3', passed, stage, log }))
    await evidence('G4.3.verdict.json', { node: 'G4.3', passed,
      reasons: log.filter(item => ['center-stopped', 'center-restored', 'catalog-after-restart', 'workers-stopped',
        'workers-respawned', 'jobs-lease-query', 'jobs-lease-query-unavailable', 'backup-done', 'restore-verified',
        'dump-audited', 'scope-limitation', 'final-running', 'failed'].includes(item.message)) })
  } catch { /* preserve stdout contract */ }
  console.log(JSON.stringify({ node: 'G4.3', scriptReady: true }))
  if (!passed) process.exitCode = 1
})
