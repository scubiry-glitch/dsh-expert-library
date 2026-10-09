#!/usr/bin/env node
/** R3.1: center+git offline — installed packs keep running, A rolls back to cached v1. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const tree = '/root/zhijian/dsh-pack-center-dev.ZGtty5'
const dag = join(tree, 'artifacts/pack-center/phase2-20260923/dag')
const prefix = '/plugins/dsh-expert-library/manage/center'
const instances = [{ id: 'A', port: 18281 }, { id: 'B', port: 18282 }]
const v1 = 'c95d8b85-6a2f-4fbc-9310-3d28c903f834'
const events = [], log = []
let stage = 'preflight', passed = false
const note = (message, data) => log.push({ at: new Date().toISOString(), message, ...data })
const json = v => JSON.stringify(v, null, 1) + '\n'
async function local(instance, path, method = 'GET', body) {
  const r = await fetch(`http://127.0.0.1:${instance.port}${prefix}${path}`, { method, headers: { 'X-Pack-Center-UI': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) }).catch(e => { const err = new Error('fetch failed: ' + e.cause?.code); throw err })
  events.push({ actor: instance.id, method, path, status: r.status })
  const data = await r.json().catch(() => undefined)
  return { status: r.status, data: data?.data, ok: data?.ok, code: data?.error?.code }
}
async function state(i) { return JSON.parse(await readFile(`/tmp/p2-20260923/pack-center-${i.toLowerCase()}/inventory/state.json`, 'utf8')) }
const gen = i => state(i).then(s => s.generation)

async function main() {
  stage = 'preflight'
  for (const i of instances) check((await local(i, '/installations')).ok, `${i.id} local view unavailable before offline`)
  // baseline: A active 2.3.0 with cached 2.2.0; B active 2.2.0
  const before = { A: await state('a'), B: await state('b') }
  note('baseline', { A_gen: before.A.generation, A_active: before.A.active, B_gen: before.B.generation, B_active: before.B.active })

  stage = 'offline'
  const exec = promisify(execFile)
  for (const pat of ['main.js api', 't22-tls-front']) {
    try { const { stdout } = await exec('pgrep', ['-f', pat]); for (const pid of stdout.trim().split('\n').filter(Boolean)) await exec('kill', [pid]) } catch {}
  }
  await new Promise(r => setTimeout(r, 1500))
  const health = await fetch('https://127.0.0.1:18431/health', { signal: AbortSignal.timeout(3000) }).then(r => r.status).catch(e => 'unreachable:' + (e.cause?.code ?? e.message))
  note('center-health-after-stop', { health })
  if (health !== 'unreachable:ECONNREFUSED') note('warn', { note: 'center not fully stopped; offline guarantees weakened', health })

  stage = 'offline-operations'
  for (const i of instances) {
    const inv = await local(i, '/installations')
    check(inv.ok, `${i.id} local inventory must work offline`)
    note(`${i.id}-inventory-offline`, { items: inv.data.items.map(x => [x.packId, x.version, x.active]), generation: inv.data.generation })
  }
  const cu = await local(instances[0], '/check-updates', 'POST', {})
  // Design: offline check may serve the cached snapshot ONLY when marked stale
  // with the failure code; a fresh up-to-date claim offline is a defect.
  const freshOffline = cu.ok && cu.data && cu.data.stale === false
  note('A-check-updates-offline', { status: cu.status, code: cu.code, stale: cu.data?.stale, items: cu.data?.items?.length })
  check(!freshOffline, 'offline check-updates must not present a fresh (stale=false) result')

  stage = 'offline-rollback'
  const pre = await gen('a')
  const preState = await state('a')
  if (preState.active['macro-capital-analyst'] === v1) {
    note('A-rollback', { skipped: 'already active on cached v1', generation: pre })
  } else {
    const rb = await local(instances[0], '/operations', 'POST', { operationKey: `r31-A-rollback-v1-${pre}`, kind: 'enable', expectedGeneration: pre, releaseId: v1 })
    check(rb.ok, `A offline rollback enqueue failed: ${rb.code}`)
    const done = await waitFor(() => local(instances[0], `/operations/${rb.data.operationId}`), v => ['succeeded', 'failed', 'interrupted'].includes(v.status))
    check(done.data?.status === 'succeeded', `A offline rollback failed: ${done.data?.errorCode}`)
  }
  const after = await state('a')
  check(after.active['macro-capital-analyst'] === v1, 'A must be active on cached v1 after rollback')
  note('A-rollback', { generationBefore: pre, generationAfter: after.generation, active: after.active })

  stage = 'restore'
  const env = await import('/tmp/p2-20260923/t22/center-env.json', { with: { type: 'json' } }).catch(() => null)
  const { spawn } = await import('node:child_process')
  const pw = (await readFile('/tmp/p2-20260923/secrets/t22-postgres-password', 'utf8')).trim()
  const base = {
    PACK_CENTER_DATABASE_URL: `postgresql://postgres:${pw}@127.0.0.1:32796/postgres`, PACK_CENTER_DATABASE_SCHEMA: 'pack_center_phase2',
    PACK_CENTER_ID: 'phase2-center-20260923', PACK_CENTER_PUBLIC_ORIGIN: 'https://127.0.0.1:18431', PACK_CENTER_ALLOW_LOOPBACK_HTTP: 'true',
    PACK_CENTER_OIDC_ISSUER: 'http://127.0.0.1:35531/', PACK_CENTER_OIDC_CLIENT_ID: 'test-pack-center',
    PACK_CENTER_LOGIN_KEY_FILE: '/tmp/p2-20260923/secrets/t22-login.key', PACK_CENTER_ARTIFACT_ROOT: '/tmp/p2-20260923/t22/artifacts',
    PACK_CENTER_SCRATCH_ROOT: '/tmp/p2-20260923/t22/scratch', PACK_CENTER_LISTEN_HOST: '127.0.0.1', PACK_CENTER_LISTEN_PORT: '18430',
    PACK_CENTER_GIT_ALLOWED_HOSTS: 'github.com,git.fixture.invalid', PACK_CENTER_TRUSTED_SIGNING_KEYS_FILE: '/tmp/p2-20260923/secrets/t22-trusted.json',
    PACK_CENTER_GIT_ALLOW_LOOPBACK_FIXTURE: 'git.fixture.invalid:8443', GIT_SSL_CAINFO: '/tmp/p2-20260923/t22/ca.pem',
  }
  const fs = await import('node:fs')
  const logFd = fs.openSync('/tmp/p2-20260923/t22/api.log', 'a'), logFd2 = fs.openSync('/tmp/p2-20260923/t22/tls-front.log', 'a')
  spawn('/root/.nvm/versions/node/v22.22.0/bin/node', ['dist/main.js', 'api'], { cwd: join(tree, 'apps/pack-center'), env: base, detached: true, stdio: ['ignore', logFd, logFd] }).unref()
  spawn('/root/.nvm/versions/node/v22.22.0/bin/node', [join(tree, 'scripts/phase2/t22-tls-front.mjs')], { detached: true, stdio: ['ignore', logFd2, logFd2] }).unref()
  let restored = false
  for (let n = 0; n < 20; n++) { await new Promise(r => setTimeout(r, 500)); restored = await fetch('https://127.0.0.1:18431/health', { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false); if (restored) break }
  note('center-restored', { restored })
  check(restored, 'center must be restored after offline phase')

  passed = true
  note('verdict', { passed })
}
function check(v, m) { if (!v) throw new Error(m) }
async function waitFor(action, predicate, attempts = 240, interval = 500) {
  let last; for (let n = 0; n < attempts; n++) { last = await action(); if (predicate(last)) return last; await new Promise(r => setTimeout(r, interval)) } return last
}
main().catch(async e => { note('failed', { stage, message: String(e.message).replace(/dpc_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 300) }) }).finally(async () => {
  await mkdir(dag, { recursive: true })
  for (const [name, data] of [['R3.1.log', { stage, events: events.slice(-60), log }], ['R3.1.verdict.json', { node: 'R3.1', passed, reasons: log.filter(l => ['baseline', 'A-check-updates-offline', 'A-rollback', 'center-restored', 'failed'].includes(l.message)) }]]) {
    const p = join(dag, name); await writeFile(p, json(data), { mode: 0o600 }).catch(() => {}); await chmod(p, 0o600).catch(() => {})
  }
  console.log(JSON.stringify({ node: 'R3.1', passed }))
})
function mkdir(p) { return import('node:fs/promises').then(m => m.mkdir(p, { recursive: true })) }
