import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, chown, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const moduleUrl = new URL(process.env.PACK_CONNECTION_SOURCE === '1'
  ? '../src/host/pack-center-connection.ts' : '../lib/host/pack-center-connection.js', import.meta.url).href
const { createPackCenterConnectionStore, publicView, signingKeyFingerprints } = await import(moduleUrl)
const keys = generateKeyPairSync('ed25519')
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const token = `dpc_token_${'a'.repeat(43)}`
const keyFingerprint = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')

function connection(overrides = {}) {
  return {
    origin: 'https://center.example', centerId: 'center-test', organizationId: 'organization-test',
    deploymentId: 'deployment-test', credentialId: 'credential-test', credentialToken: token,
    credentialExpiresAt: '2026-10-20T12:00:00.000Z', boundAt: '2026-09-20T12:00:00.000Z',
    trustedSigningKeys: { 'signing-key-1': publicPem }, ...overrides,
  }
}

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pack-connection-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function rejectsCode(promise, code) {
  return assert.rejects(promise, error => { assert.equal(error.code, code); return true })
}

async function child(script, args = []) {
  const process = spawn(globalThis.process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''; let stderr = ''
  process.stdout.on('data', data => { stdout += data })
  process.stderr.on('data', data => { stderr += data })
  const exitCode = await new Promise((resolve, reject) => {
    process.once('error', reject); process.once('close', resolve)
  })
  return { exitCode, stdout, stderr }
}

test('private connection read is side-effect free; atomic write creates 0700 directories and 0600 files', async t => {
  const parent = await scratch(t)
  const root = join(parent, 'new', 'private-center')
  const store = createPackCenterConnectionStore(root)
  assert.deepEqual(await store.read(), { revision: 0, connection: null })
  await assert.rejects(lstat(join(parent, 'new')), { code: 'ENOENT' })
  const saved = await store.write(connection({ origin: 'https://center.example/' }), 0)
  assert.equal(saved.revision, 1)
  assert.equal(saved.connection.origin, 'https://center.example')
  assert.equal((await lstat(root)).mode & 0o7777, 0o700)
  for (const name of ['connection.json', '.connection.lock']) {
    const info = await lstat(join(root, name))
    assert.equal(info.mode & 0o7777, 0o600)
    assert.equal(info.uid, process.getuid())
    assert.equal(info.nlink, 1)
  }
  assert.deepEqual(await createPackCenterConnectionStore(root).read(), saved)
  assert.deepEqual((await readdir(root)).sort(), ['.connection.lock', 'connection.json'])
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(root, 'connection.json'), 'utf8'))).sort(), ['connection', 'revision', 'schemaVersion'])
})

test('public view explicitly projects metadata and SPKI hashes, never credentials, key text, or paths', async t => {
  const root = await scratch(t)
  const store = createPackCenterConnectionStore(root)
  const saved = await store.write(connection(), 0)
  const result = store.publicView(saved)
  assert.deepEqual(result, publicView(saved))
  assert.deepEqual(Object.keys(result).sort(), ['connection', 'revision'])
  assert.deepEqual(Object.keys(result.connection).sort(), ['bound', 'boundAt', 'centerId', 'credentialExpiresAt', 'credentialId',
    'deploymentId', 'organizationId', 'origin', 'signingKeyFingerprints'].sort())
  assert.equal(result.connection.bound, true)
  assert.deepEqual(result.connection.signingKeyFingerprints, { 'signing-key-1': keyFingerprint })
  const serialized = JSON.stringify(result)
  for (const secret of [token, publicPem.trim(), 'BEGIN PUBLIC KEY', 'credentialToken', 'trustedSigningKeys', root]) assert.equal(serialized.includes(secret), false)
  assert.deepEqual(publicView({ revision: 0, connection: null }), { revision: 0, connection: null })
})

test('local unbind preserves offline identity and signing pins and advances CAS revision', async t => {
  const root = await scratch(t)
  const store = createPackCenterConnectionStore(root)
  const first = await store.write(connection(), 0)
  const unbound = await store.write({ ...first.connection, credentialToken: null }, 1)
  assert.equal(unbound.revision, 2)
  assert.equal(unbound.connection.credentialToken, null)
  assert.equal(publicView(unbound).connection.bound, false)
  assert.deepEqual(unbound.connection.trustedSigningKeys, first.connection.trustedSigningKeys)
  assert.equal(unbound.connection.centerId, first.connection.centerId)
  assert.equal((await readFile(join(root, 'connection.json'), 'utf8')).includes(token), false)
  await rejectsCode(store.write(first.connection, 1), 'REVISION_CONFLICT')
  await rejectsCode(store.write(null, 2), 'CONNECTION_INVALID')
  assert.deepEqual(await store.read(), unbound)
  const rebound = await store.write(connection({ credentialId: 'replacement', credentialToken: `dpc_token_${'b'.repeat(43)}` }), 2)
  assert.equal(rebound.revision, 3)
  assert.equal(publicView(rebound).connection.bound, true)
})

test('strict input rejects extra fields, accessors, proxies, invalid ids, tokens, timestamps, and key maps before writes', async t => {
  const root = join(await scratch(t), 'absent')
  const store = createPackCenterConnectionStore(root)
  let accessed = 0
  const accessor = connection()
  Object.defineProperty(accessor, 'credentialToken', { enumerable: true, get() { accessed++; return token } })
  const proxy = new Proxy(connection(), { ownKeys() { accessed++; return [] } })
  const invalid = [accessor, proxy, { ...connection(), extra: true }, connection({ deploymentId: '../escape' }),
    connection({ centerId: 'constructor' }), connection({ credentialToken: 'plain-secret' }),
    connection({ boundAt: 'September 20 2026' }), connection({ credentialExpiresAt: '2026-09-19T12:00:00.000Z' }),
    connection({ trustedSigningKeys: {} }), connection({ trustedSigningKeys: { constructor: publicPem } }),
    connection({ trustedSigningKeys: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`key-${index}`, publicPem])) })]
  for (const value of invalid) await rejectsCode(store.write(value, 0), 'CONNECTION_INVALID')
  for (const revision of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) await rejectsCode(store.write(connection(), revision), 'CONNECTION_INVALID')
  assert.equal(accessed, 0)
  await assert.rejects(lstat(root), { code: 'ENOENT' })
})

test('origin accepts only canonical HTTPS origins or explicitly enabled exact HTTP loopback', async t => {
  const root = await scratch(t)
  const store = createPackCenterConnectionStore(root)
  for (const origin of ['http://center.example', 'https://center.example/path', 'https://user:secret@center.example',
    'https://center.example?token=secret', 'https://center.example#secret', 'https://center.example\\hidden',
    'https://CENTER.example', 'https://center.example:443', ' http://localhost:1234', 'http://127.0.0.1:1234']) {
    await rejectsCode(store.write(connection({ origin }), 0), 'CONNECTION_INVALID')
  }
  const local = createPackCenterConnectionStore(root, { allowLoopbackHttp: true })
  for (const origin of ['http://127.0.0.2:1234', 'http://localhost.attacker.example', 'http://2130706433:1234', 'http://[::ffff:127.0.0.1]:1234']) {
    await rejectsCode(local.write(connection({ origin }), 0), 'CONNECTION_INVALID')
  }
  await local.write(connection({ origin: 'http://127.0.0.1:1234' }), 0)
  assert.equal((await local.read()).connection.origin, 'http://127.0.0.1:1234')
  await rejectsCode(store.read(), 'CONNECTION_CORRUPT')
})

test('only Ed25519 SPKI public PEM is accepted, normalized, and hashed by DER bytes', () => {
  assert.deepEqual(signingKeyFingerprints({ k1: publicPem.replaceAll('\n', '\r\n') }), { k1: keyFingerprint })
  const otherKeys = generateKeyPairSync('x25519')
  for (const pem of [keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    otherKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), `${publicPem}${publicPem}`,
    `${publicPem}secret`, '-----BEGIN PUBLIC KEY-----\naaaa\n-----END PUBLIC KEY-----\n']) {
    assert.throws(() => signingKeyFingerprints({ k1: pem }), { code: 'CONNECTION_INVALID' })
  }
})

test('expired credentials remain readable for management; persistence does not silently renew or authenticate them', async t => {
  const root = await scratch(t)
  const store = createPackCenterConnectionStore(root)
  const value = connection({ boundAt: '2020-01-01T00:00:00.000Z', credentialExpiresAt: '2020-02-01T00:00:00.000Z' })
  await store.write(value, 0)
  assert.deepEqual((await store.read()).connection, value)
})

test('broad or relative roots, unsafe directory modes, symlink roots and parent aliases fail without chmod', async t => {
  for (const root of ['/', '/root', '/tmp', '/var/lib', homedir(), process.cwd(), 'relative', '/tmp/../tmp/store', '/tmp/store/']) {
    assert.throws(() => createPackCenterConnectionStore(root), { code: 'CONNECTION_UNSAFE_PATH' })
  }
  const parent = await scratch(t)
  const unsafe = join(parent, 'unsafe')
  await mkdir(unsafe, { mode: 0o755 })
  await chmod(unsafe, 0o755)
  const unsafeStore = createPackCenterConnectionStore(unsafe)
  await rejectsCode(unsafeStore.read(), 'CONNECTION_UNSAFE_PATH')
  await rejectsCode(unsafeStore.write(connection(), 0), 'CONNECTION_UNSAFE_PATH')
  assert.equal((await lstat(unsafe)).mode & 0o7777, 0o755)
  const alias = join(parent, 'alias')
  await symlink(unsafe, alias)
  for (const path of [alias, join(alias, 'absent-child')]) {
    await rejectsCode(createPackCenterConnectionStore(path).read(), 'CONNECTION_UNSAFE_PATH')
    await rejectsCode(createPackCenterConnectionStore(path).write(connection(), 0), 'CONNECTION_UNSAFE_PATH')
  }
  assert.deepEqual(await readdir(unsafe), [])
})

test('private document rejects symlinks, hardlinks, nonregular files and insecure file modes while preserving targets', async t => {
  const parent = await scratch(t)
  const root = join(parent, 'private')
  await mkdir(root, { mode: 0o700 })
  const file = join(root, 'connection.json')
  const outside = join(parent, 'outside')
  await writeFile(outside, 'target sentinel', { mode: 0o600 })
  for (const make of [() => symlink(outside, file), () => link(outside, file), () => mkdir(file, { mode: 0o700 })]) {
    await make()
    const store = createPackCenterConnectionStore(root)
    await rejectsCode(store.read(), 'CONNECTION_UNSAFE_PATH')
    await rejectsCode(store.write(connection(), 0), 'CONNECTION_UNSAFE_PATH')
    assert.equal(await readFile(outside, 'utf8'), 'target sentinel')
    await rm(file, { recursive: true })
  }
  const store = createPackCenterConnectionStore(root)
  await store.write(connection(), 0)
  const original = await readFile(file, 'utf8')
  for (const mode of [0o644, 0o640, 0o400, 0o660, 0o4600]) {
    await chmod(file, mode)
    await rejectsCode(store.read(), 'CONNECTION_UNSAFE_PATH')
    await rejectsCode(store.write(connection(), 1), 'CONNECTION_UNSAFE_PATH')
    assert.equal((await lstat(file)).mode & 0o7777, mode)
    assert.equal(await readFile(file, 'utf8'), original)
  }
})

test('foreign-owner private directories and files are refused when ownership changes are supported', async t => {
  const root = await scratch(t)
  const store = createPackCenterConnectionStore(root)
  await store.write(connection(), 0)
  assert.equal((await lstat(root)).uid, process.getuid())
  // Non-root CI cannot chown to another user; mode and inode tests above remain unconditional.
  if (process.getuid() !== 0) return
  const file = join(root, 'connection.json')
  await chown(file, 65534, 65534)
  await rejectsCode(store.read(), 'CONNECTION_UNSAFE_PATH')
  await rejectsCode(store.write(connection(), 1), 'CONNECTION_UNSAFE_PATH')
  await chown(file, 0, 0)
  await chown(root, 65534, 65534)
  await rejectsCode(store.read(), 'CONNECTION_UNSAFE_PATH')
  await rejectsCode(store.write(connection(), 1), 'CONNECTION_UNSAFE_PATH')
  await chown(root, 0, 0)
})

test('lock file cannot alias other files or use insecure permissions', async t => {
  const root = await scratch(t)
  const store = createPackCenterConnectionStore(root)
  const target = join(root, 'sentinel')
  const lockPath = join(root, '.connection.lock')
  await writeFile(target, 'preserve', { mode: 0o600 })
  await symlink(target, lockPath)
  await rejectsCode(store.write(connection(), 0), 'LOCK_UNAVAILABLE')
  await unlink(lockPath)
  await link(target, lockPath)
  await rejectsCode(store.write(connection(), 0), 'CONNECTION_UNSAFE_PATH')
  await unlink(lockPath)
  await writeFile(lockPath, '', { mode: 0o644 })
  await rejectsCode(store.write(connection(), 0), 'CONNECTION_UNSAFE_PATH')
  assert.equal(await readFile(target, 'utf8'), 'preserve')
  await assert.rejects(lstat(join(root, 'connection.json')), { code: 'ENOENT' })
})

test('malformed, oversized, noncanonical, duplicate-key, unknown-schema documents are preserved and never reset', async t => {
  const root = await scratch(t)
  const store = createPackCenterConnectionStore(root)
  await store.write(connection(), 0)
  const path = join(root, 'connection.json')
  const initial = await readFile(path, 'utf8')
  const damaged = ['{truncated secret value', 'x'.repeat(65537), initial.replace('"revision":1', '"revision":1,"revision":1'),
    initial.replace('"schemaVersion":1', '"schemaVersion":2'), JSON.stringify(JSON.parse(initial), null, 2),
    initial.replace('"revision":1', '"revision":0'), initial.replace('"schemaVersion":1', '"extra":true,"schemaVersion":1')]
  for (const raw of damaged) {
    await writeFile(path, raw)
    await rejectsCode(store.read(), 'CONNECTION_CORRUPT')
    await rejectsCode(store.write(connection({ credentialId: 'replacement' }), 1), 'CONNECTION_CORRUPT')
    assert.equal(await readFile(path, 'utf8'), raw)
  }
  assert.deepEqual((await readdir(root)).sort(), ['.connection.lock', 'connection.json'])
})

test('input is detached before lock acquisition and returned values cannot mutate stored credentials', async t => {
  const root = await scratch(t)
  const store = createPackCenterConnectionStore(root)
  const input = connection()
  const pending = store.write(input, 0)
  input.credentialToken = `dpc_token_${'z'.repeat(43)}`
  input.trustedSigningKeys['signing-key-1'] = 'broken'
  const saved = await pending
  assert.equal(saved.connection.credentialToken, token)
  saved.connection.credentialToken = null
  assert.equal((await store.read()).connection.credentialToken, token)
})

test('cross-process revision CAS admits exactly one writer and does not expose credentials to subprocess output', async t => {
  const root = await scratch(t)
  const script = `
    const { createPackCenterConnectionStore } = await import(process.argv[1]);
    const { readFile } = await import('node:fs/promises');
    const input = JSON.parse(await readFile(process.argv[3], 'utf8'));
    try { const result = await createPackCenterConnectionStore(process.argv[2]).write(input, 0); process.stdout.write('revision:' + result.revision); }
    catch (error) { process.stdout.write(error.code); }
  `
  const inputPath = join(root, 'input-fixture.json')
  await writeFile(inputPath, JSON.stringify(connection()), { mode: 0o600 })
  const results = await Promise.all(Array.from({ length: 4 }, () => child(script, [moduleUrl, root, inputPath])))
  assert.equal(results.filter(result => result.stdout === 'revision:1').length, 1)
  assert.equal(results.filter(result => result.stdout === 'REVISION_CONFLICT').length, 3)
  for (const result of results) {
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.includes(token) || result.stderr.includes(token), false)
  }
  assert.equal((await createPackCenterConnectionStore(root).read()).revision, 1)
})

test('live lock is never stolen on timeout; terminating its holder releases the kernel lock and preserves old binding', async t => {
  const root = await scratch(t)
  const store = createPackCenterConnectionStore(root, { lockTimeoutMs: 50 })
  const original = await store.write(connection(), 0)
  const holder = spawn('flock', ['--exclusive', '--no-fork', join(root, '.connection.lock'), process.execPath, '-e',
    'process.stdout.write("locked\\n");setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => holder.kill('SIGKILL'))
  await new Promise((resolve, reject) => {
    holder.once('error', reject)
    holder.stdout.once('data', resolve)
  })
  await rejectsCode(store.write(connection({ credentialId: 'replacement' }), 1), 'LOCK_TIMEOUT')
  assert.deepEqual(await store.read(), original)
  // --no-fork means this exact child PID owns the inherited lock; no descendant is left behind.
  holder.kill('SIGTERM')
  await new Promise(resolve => holder.once('close', resolve))
  const replacement = await store.write(connection({ credentialId: 'replacement' }), 1)
  assert.equal(replacement.revision, 2)
  assert.equal(replacement.connection.credentialId, 'replacement')
})

test('failed validation, CAS conflict and corruption errors omit credentials, public keys, raw JSON and local paths', async t => {
  const root = await scratch(t)
  const store = createPackCenterConnectionStore(root)
  await store.write(connection(), 0)
  const operations = [() => store.write(connection({ extra: token }), 1), () => store.write(connection(), 0),
    async () => {
      assert.equal((await store.read()).connection.credentialId, 'credential-test')
      await writeFile(join(root, 'connection.json'), `{ corrupt: ${token}`)
      return store.read()
    }]
  for (const operation of operations) {
    try { await operation(); assert.fail('must reject') } catch (error) {
      const visible = `${String(error)} ${JSON.stringify(error)} ${error.stack}`
      for (const forbidden of [token, publicPem, root, '"credentialToken"', '"trustedSigningKeys"']) assert.equal(visible.includes(forbidden), false)
      assert.equal(error.cause, undefined)
    }
  }
  assert.equal(await readFile(join(root, 'connection.json'), 'utf8'), `{ corrupt: ${token}`)
})

test('withRevision holds the connection lock until host work finishes; other instances wait to unbind or replace credentials', async t => {
  const root = await scratch(t)
  const holder = createPackCenterConnectionStore(root)
  const writer = createPackCenterConnectionStore(root)
  let current = await holder.write(connection(), 0)
  for (const credentialToken of [null, `dpc_token_${'b'.repeat(43)}`]) {
    const events = []
    let entered; let finish
    const started = new Promise(resolve => { entered = resolve })
    const finishWork = new Promise(resolve => { finish = resolve })
    const guarded = holder.withRevision(current.revision, async function () {
      assert.equal(arguments.length, 0)
      events.push('host-started')
      entered()
      await finishWork
      events.push('host-committed')
      return { installed: true }
    })
    await started
    let settled = false
    const pendingWrite = writer.write({ ...current.connection, credentialToken }, current.revision)
      .then(value => { settled = true; events.push('connection-written'); return value })
    try {
      // A separate store cannot steal this active lock, even with an immediate deadline.
      await rejectsCode(createPackCenterConnectionStore(root, { lockTimeoutMs: 20 })
        .write({ ...current.connection, credentialToken }, current.revision), 'LOCK_TIMEOUT')
      assert.equal(settled, false)
      assert.deepEqual(await writer.read(), current)
    } finally { finish() }
    assert.deepEqual(await guarded, { installed: true })
    current = await pendingWrite
    assert.equal(current.connection.credentialToken, credentialToken)
    assert.deepEqual(events, ['host-started', 'host-committed', 'connection-written'])
  }
  assert.equal(current.revision, 3)
})

test('withRevision propagates callback failure unchanged and releases its lock without changing credentials', async t => {
  const root = await scratch(t)
  const store = createPackCenterConnectionStore(root)
  const original = await store.write(connection(), 0)
  const failure = new Error('local inventory transaction failed')
  await assert.rejects(store.withRevision(1, async () => { throw failure }), error => error === failure)
  assert.deepEqual(await store.read(), original)
  const next = await createPackCenterConnectionStore(root, { lockTimeoutMs: 50 })
    .write({ ...original.connection, credentialToken: null }, 1)
  assert.equal(next.revision, 2)
  assert.equal(next.connection.credentialToken, null)
})

test('withRevision rechecks revision under lock and never invokes stale or invalid callbacks', async t => {
  const root = await scratch(t)
  const store = createPackCenterConnectionStore(root)
  const original = await store.write(connection(), 0)
  let invoked = 0
  const action = async () => { invoked++; return 'not reached' }
  await rejectsCode(store.withRevision(0, action), 'REVISION_CONFLICT')
  for (const revision of [-1, 0.5, NaN, Infinity]) await rejectsCode(store.withRevision(revision, action), 'CONNECTION_INVALID')
  await rejectsCode(store.withRevision(1, null), 'CONNECTION_INVALID')
  assert.equal(invoked, 0)
  assert.deepEqual(await store.read(), original)
  const next = await store.write({ ...original.connection, credentialToken: null }, 1)
  await rejectsCode(store.withRevision(1, action), 'REVISION_CONFLICT')
  assert.equal(invoked, 0)
  assert.deepEqual(await store.read(), next)
})
