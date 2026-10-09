#!/usr/bin/env node
/** Host-side T2.2 runner. Never changes/restarts DSH. Never fabricates sessions.
 * No SQL mutations except the application's migrate/bootstrap commands.
 * Re-runs reuse owned services and confirmed bindings; ambiguous exchanges stop.
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { openSync, closeSync } from 'node:fs'
import { mkdir, readFile, writeFile, chmod, lstat, readlink, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const tree = fileURLToPath(new URL('../../', import.meta.url))
const dag = join(tree, 'artifacts/pack-center/phase2-20260923/dag')
const root = '/tmp/p2-20260923', secrets = join(root, 'secrets'), runtime = join(root, 't22')
const origin = 'https://127.0.0.1:18431', centerId = 'phase2-center-20260923', keyId = 'phase2-key'
const image = 'postgres@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995'
const name = 'dsh.pack-center.phase2-20260923-t22', label = 'dsh.pack-center.phase2', tag = '20260923-T2.2'
const app = join(tree, 'apps/pack-center'), prefix = '/plugins/dsh-expert-library/manage/center'
const instances = [{ id: 'A', port: 18281 }, { id: 'B', port: 18282 }]
const report = { node: 'T2.2', capturedAt: new Date().toISOString(), center: { origin, centerId }, instances: [] }
let stage = 'preflight', state = {}, secretsToScan = [], scanTargets = []
const fail = message => { throw new Error(message) }
const check = (value, message) => { if (!value) fail(message) }
const json = value => JSON.stringify(value, null, 2) + '\n'
async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return fallback; throw e } }
async function privateWrite(path, bytes) { await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600) }
async function evidence(file, bytes) {
  for (const secret of secretsToScan) check(!String(bytes).includes(secret), 'Secret found in pending evidence; refused to write it')
  await privateWrite(join(dag, file), bytes)
}
async function save() { await privateWrite(join(runtime, 'state.json'), json(state)) }
function cmd(binary, args, env) {
  const r = spawnSync(binary, args, { encoding: 'utf8', env, cwd: app, timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', errorCode: r.error?.code }
}
const baseEnv = () => Object.fromEntries(['PATH', 'LANG', 'HOME', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
async function request(url, options = {}) {
  const r = await fetch(url, { redirect: 'manual', ...options, signal: AbortSignal.timeout(15000) })
  const body = await r.text(); let data
  try { data = JSON.parse(body) } catch {}
  return { status: r.status, data, body, headers: r.headers }
}
async function local(i, route, body) {
  const r = await request(`http://127.0.0.1:${i.port}${prefix}${route}`, { method: body ? 'POST' : 'GET', headers: { 'X-Pack-Center-UI': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: r.data }
}
async function portProbe(port) {
  return new Promise(resolveProbe => {
    const s = createServer()
    s.once('error', e => resolveProbe({ port, code: e.code }))
    s.listen(port, '127.0.0.1', () => s.close(() => resolveProbe({ port, free: true })))
  })
}
async function ownedProcess(key, args, env) {
  const prior = state.processes?.[key]
  if (prior) {
    try {
      const actual = (await readFile(`/proc/${prior.pid}/cmdline`, 'utf8')).split('\0')
      check(args.every(a => actual.includes(a)), `Recorded ${key} PID was reused; refusing action`)
      process.kill(prior.pid, 0); return prior.pid
    } catch { fail(`Recorded ${key} process is unavailable; inspect owned runtime before restarting`) }
  }
  const log = join(dag, `T2.2.center-${key}.log`)
  const fd = openSync(log, 'a', 0o600)
  const child = spawn(process.execPath, args, { cwd: app, env, detached: true, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  await new Promise((ok, no) => { child.once('spawn', ok); child.once('error', no) }); child.unref()
  state.processes ??= {}; state.processes[key] = { pid: child.pid, log, args }; await save()
  return child.pid
}
async function until(action, message) {
  for (let n = 0; n < 60; n++) { try { if (await action()) return } catch {} await delay(500) }
  fail(message)
}
async function main() {
  for (const p of [dag, runtime, secrets]) await mkdir(p, { recursive: true, mode: 0o700 })
  await chmod(secrets, 0o700)
  state = await readJson(join(runtime, 'state.json'), {})
  const dockerProbe = cmd('docker', ['ps', '--format', '{{.ID}}'])
  const tcpProbe = await portProbe(18430)
  const localProbe = []
  for (const i of instances) {
    try { const r = await local(i, '/connection'); localProbe.push({ id: i.id, ...r }) }
    catch (e) { localProbe.push({ id: i.id, errorCode: e.cause?.code || e.code || 'FETCH_FAILED' }) }
  }
  await evidence('T2.2.preflight.log', json({ commands: ['docker ps --format {{.ID}}', 'net.Server.listen(18430,127.0.0.1)', ...instances.map(i => `GET http://127.0.0.1:${i.port}${prefix}/connection; X-Pack-Center-UI: 1`)], docker: { exitCode: dockerProbe.status, stderr: dockerProbe.stderr }, tcp: tcpProbe, local: localProbe }))
  check(dockerProbe.status === 0, 'Docker socket access denied/unavailable; host-side execution required')
  check(!['EPERM', 'EACCES'].includes(tcpProbe.code), 'TCP LISTEN denied; host-side execution required')
  stage = 'postgres'
  state.owner ??= randomBytes(12).toString('hex'); await save()
  let inspect = cmd('docker', ['inspect', name])
  if (inspect.status !== 0) {
    check(!state.containerId, 'Previously created PostgreSQL container is missing; refuse to recreate data')
    const password = randomBytes(32).toString('hex'); secretsToScan.push(password)
    await privateWrite(join(secrets, 't22-postgres-password'), password)
    await privateWrite(join(secrets, 't22-postgres.env'), `POSTGRES_PASSWORD=${password}\nPOSTGRES_DB=postgres\n`)
    const r = cmd('docker', ['run', '-d', '--name', name, '--label', `${label}=${tag}`, '--label', `dsh.pack-center.owner=${state.owner}`, '--env-file', join(secrets, 't22-postgres.env'), '-p', '127.0.0.1::5432', image])
    check(r.status === 0, 'docker run failed; no unrelated resources touched')
    state.containerId = r.stdout.trim(); await save(); inspect = cmd('docker', ['inspect', name])
  }
  check(inspect.status === 0, 'Cannot inspect owned PostgreSQL container')
  const container = JSON.parse(inspect.stdout)[0]
  check(container.Config.Labels[label] === tag && container.Config.Labels['dsh.pack-center.owner'] === state.owner && container.Config.Image === image, 'Container ownership/image mismatch')
  check(!state.containerId || state.containerId === container.Id, 'Container ID mismatch')
  state.containerId = container.Id; await save()
  if (!container.State.Running) check(cmd('docker', ['start', container.Id]).status === 0, 'Owned PostgreSQL failed to start')
  const ports = JSON.parse(cmd('docker', ['inspect', name]).stdout)[0].NetworkSettings.Ports['5432/tcp']
  check(ports.length === 1 && ports[0].HostIp === '127.0.0.1', 'PostgreSQL must bind exclusively to IPv4 loopback')
  report.center.container = { id: container.Id, name, label: { [label]: tag }, image, port: ports[0].HostPort, cleanup: `Verify ID and labels, then docker rm -f -v ${container.Id}` }
  await evidence('T2.2.resources.json', json(report.center))
  await until(() => cmd('docker', ['exec', container.Id, 'pg_isready', '-U', 'postgres']).status === 0, 'PostgreSQL readiness timeout')
  const password = await readFile(join(secrets, 't22-postgres-password'), 'utf8'); secretsToScan.push(password)
  if (!state.keysCreated) {
    const pair = generateKeyPairSync('ed25519')
    await privateWrite(join(secrets, 't22-signing.pem'), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
    await privateWrite(join(secrets, 't22-trusted.json'), json({ [keyId]: pair.publicKey.export({ type: 'spki', format: 'pem' }) }))
    await privateWrite(join(secrets, 't22-login.key'), randomBytes(32)); state.keysCreated = true; await save()
  }
  const trusted = await readJson(join(secrets, 't22-trusted.json'))
  const fp = createHash('sha256').update(createPublicKey(trusted[keyId]).export({ type: 'spki', format: 'der' })).digest('hex')
  report.center.pubkeyFingerprint = fp
  for (const p of ['artifacts', 'scratch']) { await mkdir(join(runtime, p), { recursive: true, mode: 0o700 }); await chmod(join(runtime, p), 0o700) }
  const common = { ...baseEnv(), PACK_CENTER_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${ports[0].HostPort}/postgres`, PACK_CENTER_DATABASE_SCHEMA: 'pack_center_phase2', PACK_CENTER_ID: centerId, PACK_CENTER_PUBLIC_ORIGIN: origin, PACK_CENTER_ALLOW_LOOPBACK_HTTP: 'true' }
  stage = 'migrate'
  const migrate = cmd(process.execPath, ['dist/main.js', 'migrate'], common)
  await evidence('T2.2.migrate.log', migrate.stdout + migrate.stderr); check(migrate.status === 0, 'Application migrate failed')
  stage = 'oidc'
  await ownedProcess('oidc', [join(tree, 'scripts/phase2/t22-oidc.mjs')], baseEnv())
  await until(async () => !!(await readJson(join(runtime, 'issuer.json')))?.issuer, 'OIDC issuer startup timeout')
  const issuerInfo = await readJson(join(runtime, 'issuer.json'))
  await until(async () => (await request(`${issuerInfo.issuer}.well-known/openid-configuration`)).status === 200, 'OIDC discovery unavailable')
  const identityEnv = { PACK_CENTER_OIDC_ISSUER: issuerInfo.issuer, PACK_CENTER_OIDC_CLIENT_ID: 'test-pack-center', PACK_CENTER_LOGIN_KEY_FILE: join(secrets, 't22-login.key') }
  stage = 'bootstrap-admin'
  const bootstrap = cmd(process.execPath, ['dist/main.js', 'bootstrap-admin'], { ...common, ...identityEnv, PACK_CENTER_BOOTSTRAP_SUBJECT: 'phase2-admin', PACK_CENTER_BOOTSTRAP_DISPLAY_NAME: 'Phase2 Admin' })
  await evidence('T2.2.bootstrap-admin.log', bootstrap.stdout + bootstrap.stderr); check(bootstrap.status === 0, 'Application bootstrap-admin failed')
  const storeEnv = { PACK_CENTER_ARTIFACT_ROOT: join(runtime, 'artifacts'), PACK_CENTER_SCRATCH_ROOT: join(runtime, 'scratch') }
  stage = 'services'
  await ownedProcess('api', ['dist/main.js', 'api'], { ...common, ...identityEnv, ...storeEnv, PACK_CENTER_LISTEN_HOST: '127.0.0.1', PACK_CENTER_LISTEN_PORT: '18430', PACK_CENTER_GIT_ALLOWED_HOSTS: 'github.com', PACK_CENTER_TRUSTED_SIGNING_KEYS_FILE: join(secrets, 't22-trusted.json') })
  await ownedProcess('validate-worker', ['dist/main.js', 'validate-worker'], { ...common, ...storeEnv, PACK_CENTER_GIT_ALLOWED_HOSTS: 'github.com' })
  await ownedProcess('publish-worker', ['dist/main.js', 'publish-worker'], { ...common, ...storeEnv, PACK_CENTER_SIGNING_KEY_ID: keyId, PACK_CENTER_SIGNING_KEY_FILE: join(secrets, 't22-signing.pem') })
  await until(async () => (await request(`${origin}/health`)).status === 200, 'Center health timeout')
  report.center.processes = state.processes; report.center.issuer = issuerInfo.issuer
  await evidence('T2.2.resources.json', json(report.center))
  stage = 'real-oidc-login'
  const cookies = new Map(); let csrf
  const http = []
  async function admin(path, method = 'GET', body, expected = 200, operationKey) {
    const r = await request(`${origin}${path}`, { method, headers: { Origin: origin, Cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; '), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json', ...(operationKey ? { 'Idempotency-Key': operationKey } : {}) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    for (const cookie of r.headers.getSetCookie()) { const [pair] = cookie.split(';'), n = pair.indexOf('='); cookies.set(pair.slice(0,n), pair.slice(n+1)); if (pair.slice(n+1)) secretsToScan.push(pair.slice(n+1)) }
    http.push({ path: path.split('?')[0], method, status: r.status })
    check(r.status === expected, `Center ${method} ${path.split('?')[0]} returned ${r.status} ${r.data?.error?.code || ''}`)
    csrf = r.data?.csrfToken || csrf; return r.data
  }
  const begin = await admin('/api/auth/login', 'POST', {})
  check(new URL(begin.authorizationUrl).origin === new URL(issuerInfo.issuer).origin, 'Unexpected OIDC authorization origin')
  const authorize = await request(begin.authorizationUrl, { headers: { 'x-test-identity': Buffer.from(JSON.stringify({ subject: 'phase2-admin' })).toString('base64url') } })
  check(authorize.status === 302, 'OIDC authorization failed')
  const callback = new URL(authorize.headers.get('location')); check(callback.origin === origin, 'OIDC callback origin mismatch')
  const login = await admin(callback.pathname + callback.search); check(login.principal.platformAdmin, 'OIDC identity is not administrator')
  stage = 'deployments'
  const orgs = await admin('/api/organizations')
  if (!orgs.items.some(o => o.id === 'phase2')) await admin('/api/organizations', 'POST', { id: 'phase2', slug: 'phase2', name: 'Phase2 isolated' }, 201)
  for (const i of instances) {
    const dep = await admin('/api/v1/deployments', 'POST', { organizationId: 'phase2', name: `DSH ${i.id}` }, 201, `t22-create-${i.id}`)
    report.instances.push({ id: i.id, deploymentId: dep.id, expectedCenterId: centerId, http: {} })
  }
  // Origin is NOT part of the local bind DTO. Do not silently configure/restart
  // DSH, patch transport security, forge a session, or use a substitute manager.
  stage = 'local-prerequisites'
  for (const row of report.instances) {
    const i = instances.find(i => i.id === row.id), r = await local(i, '/connection'); row.http.before = r
    check(r.status === 200 && r.body?.ok, `DSH ${i.id} local connection unavailable`)
    check(r.body.data.configured && r.body.data.configuredOrigin === origin && !r.body.data.errorCode, `DSH ${i.id}: configured origin is absent/different or needs restart; cannot bind under no-stop boundary`)
  }
  stage = 'bind'
  for (const row of report.instances) {
    const i = instances.find(i => i.id === row.id), current = row.http.before.body.data
    const meta = await admin(`/api/v1/deployments/${row.deploymentId}`)
    if (!current.connection?.bound) {
      check(!meta.credentials.some(c => !c.revokedAt), `DSH ${i.id}: unconfirmed center credential exists; manual reconciliation required`)
      check(!state.uncertain?.[i.id], `DSH ${i.id}: prior bind was ambiguous; reconcile first`)
      const code = await admin(`/api/v1/deployments/${row.deploymentId}/binding-codes`, 'POST', {}, 201)
      secretsToScan.push(code.bindingCode)
      await privateWrite(join(secrets, `t22-binding-${i.id}.json`), json(code))
      state.uncertain ??= {}; state.uncertain[i.id] = true; await save()
      row.http.bind = await local(i, '/bind', { bindingCode: code.bindingCode, expectedRevision: current.revision, expectedCenterId: centerId, trustedSigningKeys: trusted })
      check(row.http.bind.status === 200 && row.http.bind.body?.ok, `DSH ${i.id} bind failed; inspect revision and center credentials before retrying`)
    }
    row.http.after = await local(i, '/connection')
    const c = row.http.after.body?.data?.connection
    check(row.http.after.status === 200 && c?.bound && c.deploymentId === row.deploymentId && c.centerId === centerId && c.signingKeyFingerprints[keyId] === fp && Date.parse(c.credentialExpiresAt) > Date.now(), `DSH ${i.id} connection metadata mismatch`)
    Object.assign(row, { centerId: c.centerId, pubkeyFingerprint: c.signingKeyFingerprints[keyId], credentialExpiresAt: c.credentialExpiresAt, credentialId: c.credentialId })
    const privatePath = join(root, `pack-center-${i.id.toLowerCase()}`, 'private/connection.json')
    const st = await lstat(privatePath); check(st.isFile() && (st.mode & 0o777) === 0o600, 'Private credential file permissions invalid')
    const stored = await readJson(privatePath); check(/^dpc_token_[A-Za-z0-9_-]{43}$/.test(stored.connection?.credentialToken), 'Machine credential unavailable for exact secret scan')
    secretsToScan.push(stored.connection.credentialToken)
    const metadata = await admin(`/api/v1/deployments/${row.deploymentId}`)
    check(metadata.credentials.some(x => x.id === c.credentialId && !x.revokedAt) && metadata.bindingCodes.some(x => x.consumedAt), 'Center binding record not confirmed')
    row.http.centerMetadata = metadata
    state.uncertain ??= {}; delete state.uncertain[i.id]; await save()
    row.http.catalog = await local(i, '/catalog'); check(row.http.catalog.status === 200 && !row.http.catalog.body?.data?.errorCode, 'Machine catalog authentication failed')
  }
  check(new Set(report.instances.map(i => i.deploymentId)).size === 2 && new Set(report.instances.map(i => i.credentialId)).size === 2, 'A/B identities must differ')
  stage = 'capture-and-scan'
  await evidence('T2.2.http.log', json(http))
  // Browser capture must contain the actual connection panel and its deployment
  // ID. Capturing the SPA shell or synthesizing HTML is not accepted.
  const capture = cmd(process.execPath, [join(tree, 'scripts/phase2/t22-capture.mjs')], { ...process.env })
  await evidence('T2.2.capture.log', `${capture.stdout}${capture.stderr}`)
  check(capture.status === 0, 'Browser capture of the connection panel failed; inspect dag/T2.2.capture.log')
  scanTargets.push(...instances.map(i => join(dag, `T2.2.connection-${i.id}.html`)))
  for (const i of instances) {
    // Copy only task-local log sources. An absent raw DSH log fails the scan gate.
    const path = join(dag, `T2.1.${i.id.toLowerCase()}.log`), bytes = await readFile(path, 'utf8')
    check(bytes.length > 0, `Missing raw DSH ${i.id} log`)
    await evidence(`T2.2.local-${i.id}.log`, bytes); scanTargets.push(join(dag, `T2.2.local-${i.id}.log`))
  }
  scanTargets.push(...Object.values(state.processes).map(p => p.log))
  await privateWrite(join(secrets, 't22-scan-patterns'), [...new Set(secretsToScan)].join('\n') + '\n')
  const scan = cmd('grep', ['-F', '-l', '-f', join(secrets, 't22-scan-patterns'), ...scanTargets])
  await evidence('T2.2.secret-scan.txt', `Command: grep -F -l -f ${join(secrets, 't22-scan-patterns')} ${scanTargets.join(' ')}\nExit: ${scan.status}\nExact pattern set includes both machine credentials, issued codes, DB password, and admin cookies; values excluded.\n${scan.status === 1 ? 'PASS: no matches\n' : 'FAIL: match or scan error; output suppressed\n'}`)
  check(scan.status === 1, 'Secret scan failed')
  for (const p of Object.values(state.processes)) process.kill(p.pid, 0)
  await evidence('T2.2.bind.json', json(report))
  await evidence('T2.2.verdict.json', json({ node: 'T2.2', passed: true, reasons: ['Real PostgreSQL, real OIDC login and admin APIs; independent local bindings match trusted key, identities, and expiry; rendered local connection pages and raw logs pass exact secret scan; owned services left running.'] }))
  console.log(JSON.stringify({ node: 'T2.2', passed: true }))
}
main().catch(async error => {
  // Exception text may contain a secret: only our fixed stage and code go into evidence.
  const reason = String(error.message || '').replace(/postgres(?:ql)?:\/\/\S+/g, '[database URL redacted]').replace(/dpc_(?:token|bind)_[A-Za-z0-9_-]+/g, '[secret redacted]')
  const safeReason = secretsToScan.some(s => reason.includes(s)) ? 'Sensitive exception suppressed' : reason.slice(0, 500)
  await mkdir(dag, { recursive: true })
  await evidence('T2.2.bind.json', json(report))
  await evidence('T2.2.secret-scan.txt', `NOT COMPLETED: stage ${stage} did not finish. No clean secret-scan claim is made.\n`)
  await evidence('T2.2.verdict.json', json({ node: 'T2.2', passed: false, stage, reasons: [safeReason, 'No DSH process was stopped, restarted, or modified by this runner.'], resources: state.containerId ? { containerId: state.containerId, processes: state.processes } : { created: false } }))
  console.log(JSON.stringify({ node: 'T2.2', passed: false })); process.exitCode = 2
})
