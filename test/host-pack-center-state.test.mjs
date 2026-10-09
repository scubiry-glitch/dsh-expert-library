import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, unlink, symlink, link, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const moduleUrl = new URL(process.env.PACK_STATE_SOURCE === '1' ? '../src/host/pack-center-state.ts' : '../lib/host/pack-center-state.js', import.meta.url).href
const {
  createPackCenterStateStore, canonicalStateJson, fingerprintStateRequest,
  emptyPackCenterState, validatePackCenterState,
} = await import(moduleUrl)

const isoDate = '2026-09-19T00:00:00.000Z'
const hash = 'a'.repeat(64)
const request = (key, generation = 0, body = { action: 'install', releaseId: 'r1' }) => ({ operationKey: key, expectedGeneration: generation, request: body })

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'pack-state-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function record(root, releaseId = 'r1', packId = 'acme.notes') {
  return {
    releaseId, packId, version: '1.0.0', artifactSha256: hash, contentTreeSha256: hash,
    packPath: join(root, 'store', hash, 'pack'), manifestPath: join(root, 'manifests', `${releaseId}.json`),
    installedAt: isoDate, source: 'center', centerId: 'center-test', ownerOrgId: 'org-acme',
  }
}

const rejectsCode = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code); return true })

test('empty state is read without writes; explicit initialization is durable and idempotent', async t => {
  const parent = await scratch(t)
  const root = join(parent, 'new-store')
  const store = createPackCenterStateStore(root)
  assert.deepEqual(await store.readState(), { mode: 'normal', state: emptyPackCenterState() })
  await assert.rejects(readFile(join(root, 'state.json')), { code: 'ENOENT' })
  await store.initialize()
  const raw = await readFile(join(root, 'state.json'), 'utf8')
  assert.equal(JSON.parse(raw).generation, 0)
  assert.deepEqual(await store.initialize(), emptyPackCenterState())
  assert.equal(await readFile(join(root, 'state.json'), 'utf8'), raw)
})

test('install is atomic with its operation and does not implicitly activate', async t => {
  const root = await scratch(t)
  const store = createPackCenterStateStore(root)
  const result = await store.transact(request('install-1'), draft => {
    draft.installed.r1 = record(root)
    return { releaseId: 'r1', installed: true }
  })
  assert.equal(result.replayed, false)
  assert.equal(result.state.generation, 1)
  assert.deepEqual(result.state.active, {})
  assert.equal(result.operation.committedGeneration, 1)
  assert.deepEqual(result.operation.result, { releaseId: 'r1', installed: true })
  assert.equal(JSON.parse(await readFile(join(root, 'state.prev.json'), 'utf8')).generation, 0)
  const reload = await createPackCenterStateStore(root).readState()
  assert.deepEqual(reload.state, result.state)
  assert.equal((await readdir(root)).some(name => name.endsWith('.tmp')), false)
})

test('idempotent retries survive later commits and canonical key order, but key reuse is refused', async t => {
  const root = await scratch(t)
  const store = createPackCenterStateStore(root)
  await store.transact(request('op'), draft => { draft.installed.r1 = record(root); return 'installed' })
  await store.transact(request('enable', 1, { action: 'enable' }), draft => { draft.active['acme.notes'] = 'r1' })
  const retry = await store.transact(request('op', 0, { releaseId: 'r1', action: 'install' }), () => { throw new Error('must not repeat mutation') })
  assert.equal(retry.replayed, true)
  assert.equal(retry.state.generation, 2)
  assert.equal(retry.operation.committedGeneration, 1)
  assert.equal(retry.operation.result, 'installed')
  assert.equal(retry.operation.requestFingerprint, fingerprintStateRequest({ action: 'install', releaseId: 'r1' }, 0))
  await rejectsCode(store.transact(request('op', 0, { action: 'uninstall' }), () => {}), 'IDEMPOTENCY_CONFLICT')
  await rejectsCode(store.transact(request('op', 2), () => {}), 'IDEMPOTENCY_CONFLICT')
})

test('concurrent generation compare-and-swap admits exactly one writer', async t => {
  const root = await scratch(t)
  const stores = [createPackCenterStateStore(root), createPackCenterStateStore(root)]
  const results = await Promise.allSettled(stores.map((store, index) => store.transact(request(`op-${index}`), async draft => {
    await new Promise(resolve => setTimeout(resolve, 40))
    draft.installed.r1 = record(root)
  })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'GENERATION_CONFLICT')
  const state = (await stores[0].readState()).state
  assert.equal(state.generation, 1)
  assert.equal(Object.keys(state.operations).length, 1)
})

test('mutation is isolated and invalid mapping or metadata rewrite cannot touch durable state', async t => {
  const root = await scratch(t)
  const store = createPackCenterStateStore(root)
  await store.initialize()
  const baseline = await readFile(join(root, 'state.json'), 'utf8')
  await rejectsCode(store.transact(request('bad-map'), draft => { draft.active.other = 'missing' }), 'STATE_INVALID')
  await rejectsCode(store.transact(request('bad-history'), draft => { draft.generation = 8 }), 'STATE_INVALID')
  await assert.rejects(store.transact(request('throws'), (draft, current) => { current.generation = 7 }), TypeError)
  await rejectsCode(store.transact(request('relative'), draft => { draft.installed.r1 = { ...record(root), packPath: 'relative' } }), 'STATE_INVALID')
  await rejectsCode(store.transact(request('center-id'), draft => { const item = record(root); delete item.centerId; draft.installed.r1 = item }), 'STATE_INVALID')
  await rejectsCode(store.transact(request('wrong-pack'), draft => { draft.installed.r1 = record(root); draft.active.other = 'r1' }), 'STATE_INVALID')
  assert.equal(await readFile(join(root, 'state.json'), 'utf8'), baseline)
})

test('request hashing refuses undefined, sparse arrays, NaN, cycles, and prototype-bearing values', () => {
  const cycle = {}; cycle.self = cycle
  for (const bad of [undefined, { absent: undefined }, NaN, -0, [undefined], Array(1), cycle, new Date(), { integer: 1n }]) {
    assert.throws(() => canonicalStateJson(bad), { code: 'INVALID_REQUEST' })
  }
  assert.equal(canonicalStateJson({ b: [1, null], a: true }), '{"a":true,"b":[1,null]}')
})

test('canonical request hashing refuses ignored decorations and accessors without invoking them', () => {
  let invoked = 0
  const accessor = { get action() { invoked++; return 'install' } }
  const arrayAccessor = [1]
  Object.defineProperty(arrayAccessor, '0', { enumerable: true, get() { invoked++; return 1 } })
  const symbolArray = [1]; symbolArray[Symbol('hidden')] = 'ignored'
  const symbolObject = { [Symbol('hidden')]: 'ignored' }
  const hiddenObject = Object.defineProperty({}, 'ignored', { value: 'hidden' })
  const hiddenArray = Object.defineProperty([1], 'ignored', { value: 'hidden' })
  const hiddenEntry = Object.defineProperty([1], '0', { value: 1, enumerable: false })
  const proxy = new Proxy({}, { ownKeys() { invoked++; return [] } })
  class SpecialArray extends Array {}
  for (const value of [accessor, arrayAccessor, Object.assign([1], { action: 'update' }), symbolArray, symbolObject, hiddenObject, hiddenArray, hiddenEntry, proxy, new SpecialArray(1, 2)]) {
    assert.throws(() => canonicalStateJson(value), { code: 'INVALID_REQUEST' })
  }
  const state = emptyPackCenterState()
  Object.defineProperty(state, 'generation', { enumerable: true, get() { invoked++; return 0 } })
  assert.throws(() => validatePackCenterState(state), { code: 'STATE_INVALID' })
  assert.equal(invoked, 0)
  assert.equal(canonicalStateJson(Object.freeze({ list: Object.freeze([1, 'x']) })), '{"list":[1,"x"]}')
})

test('transaction captures immutable request identity before awaiting a lock', async t => {
  const root = await scratch(t)
  const store = createPackCenterStateStore(root)
  const input = request('original')
  const pending = store.transact(input, () => 'committed')
  input.operationKey = 'changed'
  input.expectedGeneration = 100
  input.request.action = 'disable'
  const result = await pending
  assert.equal(result.operation.operationKey, 'original')
  assert.equal(result.operation.expectedGeneration, 0)
  assert.equal(result.operation.requestFingerprint, fingerprintStateRequest({ action: 'install', releaseId: 'r1' }, 0))
  assert.equal(result.state.operations.changed, undefined)
  await rejectsCode(store.transact({ ...request('extra', 1), ignored: 'metadata' }, () => {}), 'INVALID_REQUEST')
})

test('retained mutation references and getters cannot alter the verified commit snapshot', async t => {
  const root = await scratch(t)
  let retained
  let getterCalls = 0
  const store = createPackCenterStateStore(root, { fault(point) {
    if (point === 'before-prev-write') {
      retained.generation = 100
      retained.active.other = 'missing'
    }
  } })
  const result = await store.transact(request('snapshot'), draft => { retained = draft })
  assert.equal(result.state.generation, 1)
  assert.deepEqual(result.state.active, {})
  assert.equal(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')).generation, 1)
  await rejectsCode(store.transact(request('getter', 1), draft => {
    Object.defineProperty(draft, 'generation', { enumerable: true, get() { getterCalls++; return 1 } })
  }), 'STATE_INVALID')
  const withAccessor = request('input-getter', 1)
  Object.defineProperty(withAccessor, 'operationKey', { enumerable: true, get() { getterCalls++; return 'wrong' } })
  await rejectsCode(store.transact(withAccessor, () => {}), 'INVALID_REQUEST')
  assert.equal(getterCalls, 0)
})

test('invalid requests fail before creating files and reject prototype operation keys', async t => {
  const root = join(await scratch(t), 'absent')
  const store = createPackCenterStateStore(root)
  for (const input of [request('__proto__'), request('constructor'), request('bad', -1), request('bad', 0, { x: undefined })]) {
    await rejectsCode(store.transact(input, () => {}), 'INVALID_REQUEST')
  }
  await assert.rejects(readdir(root), { code: 'ENOENT' })
})

test('corrupt state is preserved and never interpreted as empty, even with a valid previous file', async t => {
  const root = await scratch(t)
  const store = createPackCenterStateStore(root)
  await store.transact(request('install'), draft => { draft.installed.r1 = record(root) })
  await writeFile(join(root, 'state.json'), '{truncated')
  await rejectsCode(store.readState(), 'STATE_CORRUPT')
  await rejectsCode(store.initialize(), 'STATE_CORRUPT')
  await rejectsCode(store.transact(request('danger'), () => {}), 'STATE_CORRUPT')
  assert.equal(await readFile(join(root, 'state.json'), 'utf8'), '{truncated')
})

test('recovery requires snapshot integrity callback and remains read-only with corrupt bytes retained', async t => {
  const root = await scratch(t)
  const store = createPackCenterStateStore(root)
  await store.transact(request('install'), draft => { draft.installed.r1 = record(root); draft.active['acme.notes'] = 'r1' })
  await store.transact(request('disable', 1), draft => { delete draft.active['acme.notes'] })
  await writeFile(join(root, 'state.json'), 'bad state bytes')
  let validations = 0
  const recovered = createPackCenterStateStore(root, { validateSnapshot(state) {
    validations++
    assert.equal(state.generation, 1)
    assert.equal(state.active['acme.notes'], 'r1')
    assert.equal(state.installed.r1.manifestPath, join(root, 'manifests/r1.json'))
    assert.throws(() => { state.active['acme.notes'] = 'different' }, TypeError)
    // Production caller verifies these references; this unit only asserts gating.
  } })
  const read = await recovered.readState()
  assert.equal(read.mode, 'recovered-read-only')
  assert.equal(read.warning.code, 'STATE_CORRUPT')
  assert.equal(read.state.generation, 1)
  await rejectsCode(recovered.transact(request('cannot-write', 1), () => {}), 'STATE_READ_ONLY')
  await rejectsCode(recovered.initialize(), 'STATE_READ_ONLY')
  assert.equal(validations, 3)
  assert.equal(await readFile(join(root, 'state.json'), 'utf8'), 'bad state bytes')
  const invalid = createPackCenterStateStore(root, { validateSnapshot() { throw new Error('signature invalid') } })
  await rejectsCode(invalid.readState(), 'STATE_RECOVERY_INVALID')
})

test('unsupported schema refuses fallback instead of silently downgrading', async t => {
  const root = await scratch(t)
  await writeFile(join(root, 'state.json'), JSON.stringify({ ...emptyPackCenterState(), schemaVersion: 2 }))
  await writeFile(join(root, 'state.prev.json'), JSON.stringify(emptyPackCenterState()))
  let verified = false
  const store = createPackCenterStateStore(root, { validateSnapshot() { verified = true } })
  await rejectsCode(store.readState(), 'STATE_UNSUPPORTED_VERSION')
  await rejectsCode(store.initialize(), 'STATE_UNSUPPORTED_VERSION')
  assert.equal(verified, false)
})

test('missing state with previous state or inventory fails closed; verified previous state is only read-only', async t => {
  const root = await scratch(t)
  for (const kind of ['releases', 'legacy', 'store', 'manifests', 'operations']) {
    const path = join(root, kind)
    await mkdir(path)
    await writeFile(join(path, 'material'), 'orphan')
    await rejectsCode(createPackCenterStateStore(root).readState(), 'STATE_MISSING')
    await rejectsCode(createPackCenterStateStore(root).initialize(), 'STATE_MISSING')
    await rejectsCode(createPackCenterStateStore(root).transact(request('must-not-write'), () => {}), 'STATE_MISSING')
    await unlink(join(path, 'material'))
  }
  await writeFile(join(root, 'state.prev.json'), JSON.stringify(emptyPackCenterState()))
  await rejectsCode(createPackCenterStateStore(root).readState(), 'STATE_MISSING')
  const recovered = await createPackCenterStateStore(root, { validateSnapshot() {} }).readState()
  assert.equal(recovered.mode, 'recovered-read-only')
  assert.equal(recovered.warning.code, 'STATE_MISSING')
  await assert.rejects(readFile(join(root, 'state.json')), { code: 'ENOENT' })
})

test('recovery rejects damaged previous state and retains both files', async t => {
  const root = await scratch(t)
  await writeFile(join(root, 'state.json'), 'bad-current')
  await writeFile(join(root, 'state.prev.json'), 'bad-previous')
  await rejectsCode(createPackCenterStateStore(root, { validateSnapshot() {} }).readState(), 'STATE_RECOVERY_INVALID')
  assert.equal(await readFile(join(root, 'state.json'), 'utf8'), 'bad-current')
  assert.equal(await readFile(join(root, 'state.prev.json'), 'utf8'), 'bad-previous')
})

for (const point of ['before-prev-write', 'after-prev-write', 'before-state-rename', 'after-state-rename', 'after-state-sync']) {
  test(`fault at ${point} preserves old state or resolves committed operation by identical retry`, async t => {
    const root = await scratch(t)
    const normal = createPackCenterStateStore(root)
    await normal.transact(request('install'), draft => { draft.installed.r1 = record(root); draft.active['acme.notes'] = 'r1' })
    const crashing = createPackCenterStateStore(root, { fault(observed) { if (observed === point) throw new Error('simulated storage failure') } })
    const afterCommit = point === 'after-state-rename' || point === 'after-state-sync'
    const nextRequest = request('disable', 1, { action: 'disable' })
    await rejectsCode(crashing.transact(nextRequest, draft => { delete draft.active['acme.notes']; return 'disabled' }), afterCommit ? 'STATE_COMMIT_UNCERTAIN' : 'STATE_WRITE_FAILED')
    const afterFault = (await normal.readState()).state
    assert.equal(afterFault.generation, afterCommit ? 2 : 1)
    assert.equal(afterFault.active['acme.notes'], afterCommit ? undefined : 'r1')
    assert.equal(afterFault.installed.r1.releaseId, 'r1')
    let mutations = 0
    const retry = await normal.transact(nextRequest, draft => { mutations++; delete draft.active['acme.notes']; return 'disabled' })
    assert.equal(retry.replayed, afterCommit)
    assert.equal(mutations, afterCommit ? 0 : 1)
    assert.equal(retry.state.generation, 2)
    assert.equal((await readdir(root)).some(name => name.endsWith('.tmp')), false)
  })
}

test('first transaction precommit crash leaves durable initial state and can retry', async t => {
  const root = await scratch(t)
  const failing = createPackCenterStateStore(root, { fault(point) { if (point === 'after-prev-write') throw new Error('fail') } })
  await rejectsCode(failing.transact(request('first'), () => {}), 'STATE_WRITE_FAILED')
  assert.equal((await createPackCenterStateStore(root).readState()).state.generation, 0)
  assert.equal((await createPackCenterStateStore(root).transact(request('first'), () => {})).state.generation, 1)
})

function runWriter(root, script) {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import { createPackCenterStateStore } from ${JSON.stringify(moduleUrl)};
    const root = ${JSON.stringify(root)};
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    ${script}
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const done = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })))
  async function waitFor(text) {
    const end = Date.now() + 10_000
    while (!stdout.includes(text)) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() >= end) throw new Error(`Writer did not emit ${text}: ${stdout} ${stderr}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  return { child, done, waitFor }
}

test('different processes share one compare-and-swap lock', async t => {
  const root = await scratch(t)
  await createPackCenterStateStore(root).initialize()
  const writers = [0, 1].map(index => runWriter(root, `
    try {
      await createPackCenterStateStore(root).transact({ operationKey: 'process-${index}', expectedGeneration: 0, request: { action: 'test' } }, async () => { await sleep(80); return ${index}; });
      console.log('success');
    } catch (error) { console.log(error.code); }
  `))
  const results = await Promise.all(writers.map(writer => writer.done))
  assert.ok(results.every(result => result.code === 0), JSON.stringify(results))
  assert.equal(results.filter(result => result.stdout.includes('success')).length, 1)
  assert.equal(results.filter(result => result.stdout.includes('GENERATION_CONFLICT')).length, 1)
  assert.equal((await createPackCenterStateStore(root).readState()).state.generation, 1)
})

test('simultaneous identical operations from different processes mutate once and replay once', async t => {
  const root = await scratch(t)
  const writers = [0, 1].map(() => runWriter(root, `
    const result = await createPackCenterStateStore(root).transact({ operationKey: 'same-operation', expectedGeneration: 0, request: { action: 'test' } }, async () => {
      console.log('MUTATED'); await sleep(80); return 'one-result';
    });
    console.log(JSON.stringify({ replayed: result.replayed, generation: result.state.generation, result: result.operation.result }));
  `))
  for (const writer of writers) t.after(async () => { writer.child.kill('SIGKILL'); await writer.done })
  const outputs = await Promise.all(writers.map(writer => writer.done))
  assert.ok(outputs.every(output => output.code === 0), JSON.stringify(outputs))
  assert.equal(outputs.filter(output => output.stdout.includes('MUTATED')).length, 1)
  const results = outputs.map(output => JSON.parse(output.stdout.trim().split('\n').at(-1)))
  assert.equal(results.filter(result => result.replayed).length, 1)
  assert.ok(results.every(result => result.generation === 1 && result.result === 'one-result'))
  assert.equal(Object.keys((await createPackCenterStateStore(root).readState()).state.operations).length, 1)
})

test('a live competing writer produces a bounded LOCK_TIMEOUT without state mutation', async t => {
  const root = await scratch(t)
  const writer = runWriter(root, `
    await createPackCenterStateStore(root).transact({ operationKey: 'holding', expectedGeneration: 0, request: {} }, async () => { console.log('holding'); await sleep(600); });
  `)
  t.after(async () => { writer.child.kill('SIGKILL'); await writer.done })
  await writer.waitFor('holding')
  await rejectsCode(createPackCenterStateStore(root, { lockTimeoutMs: 30 }).transact(request('blocked'), () => {}), 'LOCK_TIMEOUT')
  assert.equal((await writer.done).code, 0)
  assert.equal((await createPackCenterStateStore(root).readState()).state.generation, 1)
})

test('SIGKILL of writer releases kernel lock automatically and preserves old state', async t => {
  const root = await scratch(t)
  const writer = runWriter(root, `
    await createPackCenterStateStore(root).transact({ operationKey: 'killed', expectedGeneration: 0, request: {} }, async () => { console.log('holding'); await sleep(60000); });
  `)
  t.after(async () => { writer.child.kill('SIGKILL'); await writer.done })
  await writer.waitFor('holding')
  // flock has already exited: the only holder is the writer's open fd.
  const children = (await readFile(`/proc/${writer.child.pid}/task/${writer.child.pid}/children`, 'utf8')).trim()
  assert.equal(children, '')
  const lockInode = (await stat(join(root, '.state.lock'))).ino
  writer.child.kill('SIGKILL')
  assert.equal((await writer.done).signal, 'SIGKILL')
  const store = createPackCenterStateStore(root, { lockTimeoutMs: 1500 })
  assert.equal((await store.readState()).state.generation, 0)
  const result = await store.transact(request('after-kill'), () => 'new operation')
  assert.equal(result.state.generation, 1)
  assert.equal(result.state.operations.killed, undefined)
  assert.equal((await stat(join(root, '.state.lock'))).ino, lockInode)
})

for (const point of ['before-prev-write', 'after-prev-write', 'before-state-rename', 'after-state-rename', 'after-state-sync']) {
  test(`real process SIGKILL at ${point} leaves an old-or-new state and retry resolves once`, async t => {
    const root = await scratch(t)
    const store = createPackCenterStateStore(root)
    await store.transact(request('installed'), draft => { draft.installed.r1 = record(root); draft.active['acme.notes'] = 'r1' })
    const writer = runWriter(root, `
      await createPackCenterStateStore(root, { async fault(point) {
        if (point === ${JSON.stringify(point)}) { console.log('kill-here'); await sleep(60000); }
      } }).transact({ operationKey: 'killed-disable', expectedGeneration: 1, request: { action: 'disable' } }, draft => {
        delete draft.active['acme.notes']; return 'disabled';
      });
    `)
    t.after(async () => { writer.child.kill('SIGKILL'); await writer.done })
    await writer.waitFor('kill-here')
    writer.child.kill('SIGKILL')
    assert.equal((await writer.done).signal, 'SIGKILL')
    const committed = point === 'after-state-rename' || point === 'after-state-sync'
    const afterKill = (await store.readState()).state
    assert.equal(afterKill.generation, committed ? 2 : 1)
    assert.equal(afterKill.active['acme.notes'], committed ? undefined : 'r1')
    assert.equal(afterKill.installed.r1.releaseId, 'r1')
    let mutations = 0
    const retry = await store.transact(request('killed-disable', 1, { action: 'disable' }), draft => {
      mutations++; delete draft.active['acme.notes']; return 'disabled'
    })
    assert.equal(retry.replayed, committed)
    assert.equal(mutations, committed ? 0 : 1)
    assert.equal(retry.state.generation, 2)
    assert.equal(retry.operation.result, 'disabled')
    assert.deepEqual(Object.keys(retry.state.operations).sort(), ['installed', 'killed-disable'])
  })
}

test('unexpected acquisition-child exit fails closed while the real parent-fd holder retains its lock', async t => {
  const root = await scratch(t)
  const holder = runWriter(root, `
    import { access } from 'node:fs/promises';
    await createPackCenterStateStore(root).transact({ operationKey: 'holding', expectedGeneration: 0, request: {} }, async () => {
      console.log('holding');
      while (true) { try { await access(root + '/proceed'); break; } catch { await sleep(10); } }
    });
  `)
  t.after(async () => { holder.child.kill('SIGKILL'); await holder.done })
  await holder.waitFor('holding')
  const writer = runWriter(root, `
    try {
      console.log('acquiring');
      await createPackCenterStateStore(root).transact({ operationKey: 'failed-acquire', expectedGeneration: 0, request: {} }, () => { console.log('BAD-MUTATE'); });
      console.log('BAD-COMMIT');
    } catch (error) { console.log(error.code); }
  `)
  t.after(async () => { writer.child.kill('SIGKILL'); await writer.done })
  await writer.waitFor('acquiring')
  const childrenOf = async pid => (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number)
  let flockPid
  for (let attempt = 0; attempt < 100 && !flockPid; attempt++) {
    ;[flockPid] = await childrenOf(writer.child.pid)
    if (!flockPid) await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(flockPid)
  process.kill(flockPid, 'SIGKILL')
  const result = await writer.done
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /LOCK_UNAVAILABLE/)
  assert.doesNotMatch(result.stdout, /BAD-(MUTATE|COMMIT)/)
  assert.equal((await createPackCenterStateStore(root).readState()).state.generation, 0)
  await rejectsCode(createPackCenterStateStore(root, { lockTimeoutMs: 30 }).transact(request('still-blocked'), () => {}), 'LOCK_TIMEOUT')
  await writeFile(join(root, 'proceed'), '')
  assert.equal((await holder.done).code, 0)
  assert.equal((await createPackCenterStateStore(root).readState()).state.generation, 1)
})

test('lock refuses symbolic/hard links, non-files, and aliased roots without deleting lock material', async t => {
  const parent = await scratch(t)
  const root = join(parent, 'root')
  await mkdir(root)
  const target = join(parent, 'target')
  await writeFile(target, 'do-not-change')
  const lockPath = join(root, '.state.lock')
  await symlink(target, lockPath)
  await rejectsCode(createPackCenterStateStore(root).initialize(), 'LOCK_UNAVAILABLE')
  assert.equal(await readFile(target, 'utf8'), 'do-not-change')
  await unlink(lockPath)
  await link(target, lockPath)
  await rejectsCode(createPackCenterStateStore(root).initialize(), 'LOCK_UNAVAILABLE')
  assert.equal(await readFile(target, 'utf8'), 'do-not-change')
  await unlink(lockPath)
  await mkdir(lockPath)
  await rejectsCode(createPackCenterStateStore(root).initialize(), 'LOCK_UNAVAILABLE')
  await rm(lockPath, { recursive: true })
  await symlink(root, join(parent, 'alias'))
  await rejectsCode(createPackCenterStateStore(join(parent, 'alias')).initialize(), 'LOCK_UNAVAILABLE')
  await assert.rejects(readFile(join(root, 'state.json')), { code: 'ENOENT' })
})

test('generation/history and exact legacy path invariants are checked', async t => {
  const root = await scratch(t)
  const valid = emptyPackCenterState()
  valid.installed.r1 = record(root)
  valid.installed.r2 = { ...record(root, 'r2'), previousReleaseId: 'r1' }
  valid.legacySuppressions[join(root, 'vendor', 'notes')] = {
    packId: 'acme.notes', releaseId: 'r1', backupPath: join(root, 'legacy-backup'), contentTreeSha256: hash, suppressedAt: isoDate,
  }
  validatePackCenterState(valid)
  const invalid = structuredClone(valid)
  invalid.installed.r2.previousReleaseId = 'absent'
  assert.throws(() => validatePackCenterState(invalid), { code: 'STATE_INVALID' })
  invalid.installed.r2.previousReleaseId = 'r1'
  invalid.legacySuppressions['relative'] = invalid.legacySuppressions[join(root, 'vendor', 'notes')]
  assert.throws(() => validatePackCenterState(invalid), { code: 'STATE_INVALID' })
})

test('accepted release receipts survive uninstall and cannot be removed, rewritten, or rebound', async t => {
  const root = await scratch(t)
  const store = createPackCenterStateStore(root)
  const accepted = { releaseId: 'r1', packId: 'acme.notes', version: '1.0.0', centerId: 'center-test', ownerOrgId: 'org-acme', manifestSha256: hash }
  await store.transact(request('install-receipt'), draft => {
    draft.installed.r1 = record(root)
    draft.acceptedReleases.r1 = accepted
  })
  await store.transact(request('uninstall', 1), draft => { delete draft.installed.r1 })
  const afterUninstall = (await store.readState()).state
  assert.equal(afterUninstall.installed.r1, undefined)
  assert.deepEqual(afterUninstall.acceptedReleases.r1, accepted)
  await rejectsCode(store.transact(request('delete-receipt', 2), draft => { delete draft.acceptedReleases.r1 }), 'STATE_INVALID')
  await rejectsCode(store.transact(request('rewrite-receipt', 2), draft => { draft.acceptedReleases.r1.manifestSha256 = 'b'.repeat(64) }), 'STATE_INVALID')
  await rejectsCode(store.transact(request('rebind-version', 2), draft => { draft.acceptedReleases.r2 = { ...accepted, releaseId: 'r2' } }), 'STATE_INVALID')
  const invalid = structuredClone(afterUninstall)
  invalid.acceptedReleases.r1.releaseId = 'different'
  assert.throws(() => validatePackCenterState(invalid), { code: 'STATE_INVALID' })
  invalid.acceptedReleases.r1.releaseId = 'r1'
  invalid.acceptedReleases.r1.manifestSha256 = 'not-a-sha'
  assert.throws(() => validatePackCenterState(invalid), { code: 'STATE_INVALID' })
  delete invalid.acceptedReleases
  assert.throws(() => validatePackCenterState(invalid), { code: 'STATE_INVALID' })
  assert.deepEqual((await store.readState()).state, afterUninstall)
})
