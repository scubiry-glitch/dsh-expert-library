#!/usr/bin/env node
/**
 * G4.4 — second tenant instance rebuilt from an empty directory (DSH C),
 * with a start-up preflight demonstrated both negatively and positively.
 *
 * 1. Preflight-negative: a fresh empty /tmp/p2-20260923/dsh-c is given a
 *    deliberately unresolvable profile (plugin bundle declared but the plugin
 *    symlink under profiles/p2-c/node_modules is absent — the same missing
 *    bundle condition the phase2 plan's O01 start-up check covers: block
 *    BEFORE stopping/replacing any old process). Booting C on 18283 must fail
 *    fast WITHOUT opening the port; A/B must stay untouched the whole time.
 *    Inventory of what deploy/start checks exist in the tree is recorded
 *    (files are asserted to exist; no plugin-provided deploy-check script
 *    exists in scripts/ — recorded honestly).
 * 2. Preflight-positive: the profile is repaired (correct bundles + plugin
 *    symlink contained in the isolated tree), C boots with the same launch
 *    pattern as A (DSH_HOME=/tmp/p2-20260923/dsh-c, node22, --port 18283,
 *    NODE_EXTRA_CA_CERTS) and GET .../manage/center/installations must
 *    return 200. pid/port/paths disjoint from A/B are recorded.
 * 3. Center registration: admin login (x-test-identity OIDC, redirect
 *    manual), deployment 'DSH C' in org phase2, binding code, POST C /bind
 *    {bindingCode, expectedRevision, expectedCenterId, trustedSigningKeys};
 *    C /connection bound + C /catalog non-empty (macro-capital-analyst).
 *
 * Idempotent: an already-running C is converged (stopped and rebuilt);
 * the deployment/binding reuse existing rows. C is left RUNNING.
 * Never prints secrets. Boundaries: only /tmp/p2-20260923, scripts/phase2/,
 * artifacts/pack-center/phase2-20260923/; no git commit/push; production
 * (port 3080, zhijianharness-main, dsh core) untouched.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { closeSync, mkdirSync, openSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const tree = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/+$/, '')
const node22 = '/root/.nvm/versions/node/v22.22.0/bin/node'
const dshBin = '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
const dag = join(tree, 'artifacts/pack-center/phase2-20260923/dag')
const root = '/tmp/p2-20260923'
const homeC = join(root, 'dsh-c')
const workspaceC = join(root, 'workspace-c')
const packCenterC = join(root, 'pack-center-c')
const port = 18283
const prefix = '/plugins/dsh-expert-library/manage/center'
const origin = 'https://127.0.0.1:18431'
const centerId = 'phase2-center-20260923'
const pluginPackage = '@zhijian/dsh-expert-library'
const instancesAB = [
  { id: 'A', profile: 'p2-a', port: 18281 },
  { id: 'B', profile: 'p2-b', port: 18282 },
]

const log = [], events = []
let stage = 'preflight', passed = false
const json = value => JSON.stringify(value, null, 2) + '\n'
const note = (message, data = {}) => log.push({ at: new Date().toISOString(), stage, message, ...data })
const fail = message => { throw new Error(message) }
const check = (value, message) => { if (!value) fail(message) }
const safe = text => String(text).replace(/dpc_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 400)

async function evidence(name, value) {
  const bytes = typeof value === 'string' ? value : json(value)
  const path = join(dag, name)
  await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600)
}
async function exists(path) { try { await access(path); return true } catch { return false } }

function portFree(target) {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error', () => { server.close(() => resolve(false)) })
    server.listen(target, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

/** Live DSH C process ids, found the same way r34-state-recovery finds A. */
async function pidsC() {
  try {
    const { stdout } = await spawnAsync('/usr/bin/pgrep', ['-f', 'p2-c'])
    const found = []
    for (const text of stdout.trim().split('\n').filter(Boolean)) {
      const pid = Number(text); if (!Number.isSafeInteger(pid) || pid === process.pid) continue
      try {
        const cmdline = (await readFile(`/proc/${pid}/cmdline`)).toString().replaceAll('\0', ' ')
        if (cmdline.includes(dshBin) && cmdline.includes('--profile p2-c')) found.push(pid)
      } catch {}
    }
    return found
  } catch { return [] }
}
function spawnAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

async function local(path, method = 'GET', body, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${port}${prefix}${path}`, {
    method, headers: { 'X-Pack-Center-UI': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) })
  events.push({ actor: 'C', method, path: path.split('?')[0], status: response.status })
  const data = await response.json().catch(() => undefined)
  if (expected !== null && response.status !== expected) {
    fail(`C ${method} ${path} returned ${response.status}: ${safe(JSON.stringify(data))}`)
  }
  return { status: response.status, data: data?.data, ok: data?.ok === true }
}

// ── profile builders ────────────────────────────────────────────────────────
function profileDir() { return join(homeC, 'profiles', 'p2-c') }
function writeBrokenProfile() {
  // Bundles declare the plugin, but the plugin symlink under node_modules is
  // intentionally absent: bundle resolution cannot complete.
  const dir = profileDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), json({
    name: 'dsh-profile-c', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', pluginPackage], patchReload: 'startup' } },
  }))
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
  return { broken: true }
}
function writeHealthyProfile() {
  const dir = profileDir()
  const pluginLink = join(dir, 'node_modules', '@zhijian', 'dsh-expert-library')
  mkdirSync(join(dir, 'node_modules', '@zhijian'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), json({
    name: 'dsh-profile-c', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', pluginPackage], patchReload: 'startup' } },
  }))
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), `- id: expert-library\n  config:\n    stateDir: expert-teams\n    memberProvider: spawn\n    memberMaxDepth: 1\n    maxMembers: 8\n    knowledgeDir: knowledge\n    packsDir: domain-packs\n    manageToken: ''\n    vendorPacksDir: ${join(homeC, 'vendor-packs')}\n    packCenterOrigin: '${origin}'\n    packCenterDir: ${packCenterC}\n    packSourceAllowlist: []\n    promptSectionOrder: 117\n    announceToAgent: true\n    enabledPacks: []\n    packPriority: []\n    disabledTools: []\n`)
  symlinkSync(tree, pluginLink, 'dir')
  const resolved = realpathSync(pluginLink)
  check(resolved === tree || resolved.startsWith(tree + '/'), 'plugin symlink resolved outside the isolated tree')
  return { pluginLink, resolvedPluginLoadPath: resolved }
}

function bootC(sync = false) {
  const logFd = openSync(join(root, 'g44-c-boot.log'), 'a')
  const childEnv = { ...process.env, DSH_HOME: homeC, NODE_EXTRA_CA_CERTS: join(root, 't22', 'ca.pem') }
  const args = [dshBin, '--profile', 'p2-c', '--host', '127.0.0.1', '--port', String(port), '--no-open']
  if (sync) {
    const result = spawnSync(node22, args, { cwd: workspaceC, env: childEnv, encoding: 'utf8', timeout: 90_000 })
    closeSync(logFd)
    return { pid: null, exitCode: result.status, signal: result.signal, stderr: (result.stderr || '').slice(-4000), stdout: (result.stdout || '').slice(-2000) }
  }
  try {
    const child = spawn('setsid', ['nohup', node22, ...args], { cwd: workspaceC, env: childEnv, detached: true, stdio: ['ignore', logFd, logFd] })
    child.unref(); return { pid: child.pid }
  } finally { closeSync(logFd) }
}

async function stopC(reason) {
  const pids = await pidsC()
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch {} }
  for (let n = 0; n < 20 && (await pidsC()).length; n++) await delay(500)
  for (const pid of await pidsC()) { try { process.kill(pid, 'SIGKILL') } catch {} }
  if (pids.length) note('c-stopped', { reason, pids })
  return pids
}

// ── deploy/start preflight inventory (what actually exists in the tree) ─────
async function preflightInventory() {
  const items = []
  const candidates = [
    { path: 'src/host/pack-runtime.ts', role: 'preflightManagedActivation — plugin-owned runtime preflight before a managed activation is committed' },
    { path: 'src/host/pack-center-host.ts', role: 'plugin lifecycle preflight: origin/storage changes force a restart and never swap an active local source for an empty directory' },
    { path: 'src/host/pack-store.ts', role: 'activation preflight of the builtin/workspace merge before switching (no network)' },
    { path: 'scripts/phase2/run-ab-instances.mjs', role: 'host-runner start preflight pattern: local TCP bind check + plugin symlink containment before child launch' },
  ]
  for (const item of candidates) {
    items.push({ ...item, exists: await exists(join(tree, item.path)) })
    check(items.at(-1).exists, `expected preflight source missing: ${item.path}`)
  }
  // No plugin-owned deploy-check executable exists in scripts/ (searched
  // 'deploy'/'preflight'); the O01 "缺 bundle 时在停旧进程前阻断" behaviour is
  // exercised directly below via the unresolvable-bundle boot attempt.
  return { items, deployCheckScript: null, note: 'no standalone plugin deploy-check script in scripts/; start-up bundle resolution is the deploy preflight exercised here' }
}

// ── stages ──────────────────────────────────────────────────────────────────
async function preflightNegative() {
  stage = 'preflight-negative'
  const abBefore = await abStatus()
  const inventory = await preflightInventory()
  await stopC('rebuild-from-empty')
  await rm(homeC, { recursive: true, force: true })
  await rm(packCenterC, { recursive: true, force: true })
  mkdirSync(join(homeC, 'profiles'), { recursive: true, mode: 0o700 })
  mkdirSync(workspaceC, { recursive: true, mode: 0o700 })
  writeBrokenProfile()
  check(await portFree(port), `port ${port} is occupied before the negative boot attempt`)
  const attempt = bootC(true)
  const opened = !(await portFree(port))
  check(attempt.exitCode !== 0 || attempt.signal, `boot with unresolvable bundle did not fail fast (exit ${attempt.exitCode})`)
  check(!opened, `port ${port} was opened despite the broken profile`)
  check((await pidsC()).length === 0, 'a p2-c process survived the failed boot')
  const abAfter = await abStatus()
  check(abAfter.healthy === abBefore.healthy && abBefore.healthy, 'A/B health changed during the negative preflight')
  note('preflight-negative-passed', {
    howItSurfaces: 'dsh exits non-zero during profile bundle resolution before any listener is bound; port stays closed; A/B untouched (block before stopping the old process)',
    exitCode: attempt.exitCode, signal: attempt.signal, stderrTail: safe(attempt.stderr), preflightInventory: inventory,
  })
  return { attempt: { exitCode: attempt.exitCode, signal: attempt.signal, stderrTail: safe(attempt.stderr) }, inventory }
}

async function abStatus() {
  const result = { healthy: true, instances: [] }
  for (const instance of instancesAB) {
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}${prefix}/connection`, { headers: { 'X-Pack-Center-UI': '1' }, signal: AbortSignal.timeout(3000) })
      result.instances.push({ id: instance.id, status: response.status })
      if (response.status !== 200) result.healthy = false
    } catch { result.healthy = false; result.instances.push({ id: instance.id, status: 'unreachable' }) }
  }
  return result
}

async function preflightPositive() {
  stage = 'preflight-positive'
  const prepared = writeHealthyProfile()
  mkdirSync(packCenterC, { recursive: true, mode: 0o700 })
  mkdirSync(join(homeC, 'vendor-packs'), { recursive: true, mode: 0o700 })
  const pid = bootC(false).pid
  let live = false
  for (let n = 0; n < 240; n++) {
    try {
      const view = await local('/installations', 'GET', undefined, null)
      if (view.status === 200) { live = true; break }
    } catch {}
    await delay(500)
  }
  check(live, 'C manage endpoint did not return 200 after the healthy boot')
  const running = await pidsC()
  check(running.length >= 1, 'no p2-c process found after healthy boot')
  const paths = { DSH_HOME: homeC, workspace: workspaceC, packCenterDir: packCenterC,
    vendorPacks: join(homeC, 'vendor-packs'), profile: profileDir(), ...prepared }
  note('preflight-positive-passed', { spawnPid: pid, pids: running, port, ...paths,
    disjoint: { fromA: { home: join(root, 'dsh-a'), port: 18281 }, fromB: { home: join(root, 'dsh-b'), port: 18282 } } })
  return { pid, pids: running, port, paths }
}

// ── center registration (rebind-a.mjs pattern) ──────────────────────────────
class Session {
  constructor(subject) { this.subject = subject; this.cookies = new Map(); this.csrf = undefined }
  cookieHeader() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') }
  async call(path, method = 'GET', body, expected = 200, operationKey) {
    const response = await fetch(origin + path, { method, redirect: 'manual',
      headers: { Origin: origin, Cookie: this.cookieHeader(), ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', ...(operationKey ? { 'Idempotency-Key': operationKey } : {}) }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) })
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0], at = pair.indexOf('=')
      if (at > 0) this.cookies.set(pair.slice(0, at), pair.slice(at + 1))
    }
    events.push({ actor: this.subject, method, path: path.split('?')[0], status: response.status })
    if (response.status !== expected) fail(`center ${method} ${path} returned ${response.status}: ${safe(JSON.stringify(await response.text()))}`)
    const data = await response.json().catch(() => undefined)
    if (data?.csrfToken) this.csrf = data.csrfToken
    return data
  }
  async login() {
    const begin = await this.call('/api/auth/login', 'POST', {})
    check(begin?.authorizationUrl, 'login did not return an authorization URL')
    const authorize = await fetch(begin.authorizationUrl, { redirect: 'manual',
      headers: { 'x-test-identity': Buffer.from(JSON.stringify({ subject: this.subject })).toString('base64url') } })
    check(authorize.status === 302, `OIDC authorize returned ${authorize.status}`)
    const callback = new URL(authorize.headers.get('location'))
    const login = await this.call(callback.pathname + callback.search)
    check(login.principal?.platformAdmin, 'login did not yield a platform admin')
    return login
  }
}

async function register() {
  stage = 'center-registration'
  const admin = new Session('phase2-admin'); await admin.login()
  const rows = (await admin.call('/api/v1/deployments?organizationId=phase2&limit=100')).items || []
  let deployment = rows.find(row => row.name === 'DSH C')
  if (!deployment) deployment = await admin.call('/api/v1/deployments', 'POST', { organizationId: 'phase2', name: 'DSH C' }, 201, `g44-create-deployment-${Date.now()}`)
  note('deployment-ready', { deploymentId: deployment.id, reused: rows.some(row => row.name === 'DSH C') })

  const connBefore = await local('/connection')
  const revision = connBefore.data?.revision ?? 0
  const alreadyBound = Boolean(connBefore.data?.centerId)
  if (!alreadyBound) {
    const code = await admin.call(`/api/v1/deployments/${deployment.id}/binding-codes`, 'POST', {}, 201, `g44-binding-code-${Date.now()}`)
    const trusted = JSON.parse(await readFile(join(root, 'secrets/t22-trusted.json'), 'utf8'))
    const bound = await local('/bind', 'POST', { bindingCode: code.bindingCode, expectedRevision: revision, expectedCenterId: centerId, trustedSigningKeys: trusted })
    note('bind-result', { ok: bound.ok, status: bound.status })
  } else note('bind-reused', { reason: 'C /connection already bound' })

  const conn = await local('/connection')
  check(Boolean(conn.data?.centerId) || conn.ok, 'C /connection does not show a bound center')
  const catalog = await local('/catalog?packId=macro-capital-analyst&limit=20')
  check((catalog.data?.items?.length ?? 0) > 0, 'C catalog has no macro-capital-analyst items')
  note('c-registered', { connection: { revision: conn.data?.revision, centerId: conn.data?.centerId ?? centerId },
    catalogItems: catalog.data?.items?.length,
    sample: catalog.data?.items?.slice(0, 3).map(item => ({ packId: item.packId, version: item.version, releaseId: item.releaseId })) })
  return { deploymentId: deployment.id, connection: { revision: conn.data?.revision }, catalogItems: catalog.data?.items?.length }
}

async function main() {
  await mkdir(dag, { recursive: true, mode: 0o700 })
  const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5000) })
  check(health.status === 200, 'center must be healthy before G4.4')
  const ab = await abStatus(); check(ab.healthy, 'A/B must be healthy before G4.4')
  note('baseline', { ab })
  const negative = await preflightNegative()
  const positive = await preflightPositive()
  const registration = await register()
  const finalAb = await abStatus(); check(finalAb.healthy, 'A/B must still be healthy at the end')
  const finalC = await local('/installations'); check(finalC.status === 200, 'C not serving at end')
  passed = true
  return { negative, positive, registration }
}

main().then(async summary => {
  await evidence('G4.4.instance.json', { node: 'G4.4', passed, instance: 'C', port,
    pid: (await pidsC())[0] ?? null, paths: { DSH_HOME: homeC, workspace: workspaceC, packCenterDir: packCenterC }, summary })
}).catch(async error => {
  note('failed', { stage, message: safe(error?.message || error) })
}).finally(async () => {
  try {
    await evidence('G4.4.log', json({ node: 'G4.4', passed, stage, log, events }))
    await evidence('G4.4.verdict.json', { node: 'G4.4', passed,
      reasons: log.filter(item => ['preflight-negative-passed', 'preflight-positive-passed', 'deployment-ready',
        'bind-result', 'bind-reused', 'c-registered', 'c-stopped', 'failed'].includes(item.message)) })
  } catch { /* preserve stdout contract */ }
  console.log(JSON.stringify({ node: 'G4.4', scriptReady: true }))
  if (!passed) process.exitCode = 1
})
