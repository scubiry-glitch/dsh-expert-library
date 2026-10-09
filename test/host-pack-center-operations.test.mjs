import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const moduleUrl = new URL(process.env.PACK_OPERATIONS_SOURCE === '1'
  ? '../src/host/pack-center-operations.ts' : '../lib/host/pack-center-operations.js', import.meta.url).href
const { createPackOperationQueue, validatePackOperationRequest, sanitizePackOperationError, MAX_PACK_OPERATIONS } = await import(moduleUrl)

function request(overrides = {}) {
  return { operationKey: 'install-test-1', kind: 'install', expectedGeneration: 0, releaseId: 'release-1', connectionRevision: 1,
    target: { manifestSha256: 'a'.repeat(64), artifactSha256: 'b'.repeat(64), contentTreeSha256: 'c'.repeat(64) }, ...overrides }
}
function success(overrides = {}) { return { generation: 1, outcome: 'succeeded', releaseId: 'release-1', activated: false, ...overrides } }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'pack-operations-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
function queue(t, root, overrides = {}) {
  const value = createPackOperationQueue({ root, execute: async () => success(), recover: async () => null, ...overrides })
  t.after(() => value.close())
  return value
}
async function rejectsCode(promise, code) {
  return assert.rejects(promise, error => { assert.equal(error.code, code); assert.equal(error.message, code); return true })
}
async function waitFor(predicate, message = 'condition', milliseconds = 12_000) {
  const until = Date.now() + milliseconds
  while (Date.now() < until) {
    const result = await predicate()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error(`Timed out waiting for ${message}`)
}
async function terminal(value, id) {
  return waitFor(async () => { const job = await value.get(id); return job && ['succeeded', 'failed', 'interrupted'].includes(job.status) && job }, 'terminal job')
}

test('enqueue is durable before return, detached, private, and does not execute until start', async t => {
  const parent = await scratch(t), root = join(parent, 'nested', 'operations')
  let calls = 0
  const value = queue(t, root, { execute: async () => { calls++; return success() } })
  assert.deepEqual(await value.list(), [])
  await assert.rejects(lstat(join(parent, 'nested')), { code: 'ENOENT' })
  const input = request(), job = await value.enqueue(input)
  assert.equal(job.status, 'queued'); assert.equal(job.phase, 'queued'); assert.equal(calls, 0)
  input.target.manifestSha256 = 'd'.repeat(64); job.request.target.artifactSha256 = 'e'.repeat(64)
  const disk = JSON.parse(await readFile(join(root, 'operations.json'), 'utf8'))
  assert.equal(disk.schemaVersion, 1); assert.equal(disk.revision, 1); assert.equal(disk.jobs.length, 1)
  assert.deepEqual(disk.jobs[0].request, request())
  assert.deepEqual(await queue(t, root).get(job.operationId), disk.jobs[0])
  assert.equal((await lstat(root)).mode & 0o7777, 0o700)
  for (const file of await readdir(root)) {
    const info = await lstat(join(root, file))
    assert.equal(info.mode & 0o7777, 0o600); assert.equal(info.nlink, 1); assert.equal(info.uid, process.getuid())
  }
  await value.start()
  assert.equal((await terminal(value, job.operationId)).status, 'succeeded')
  assert.equal(calls, 1)
})

test('enqueue returns while executor runs and reports only actual durable phases', async t => {
  const root = await scratch(t), entered = deferred(), release = deferred()
  const value = queue(t, root, { execute: async (input, report) => {
    assert.deepEqual(input, request())
    await report('authorizing'); await report('downloading'); entered.resolve()
    await release.promise; await report('verifying'); await report('installing')
    return success()
  } })
  t.after(() => release.resolve())
  await value.start()
  const job = await value.enqueue(request())
  await entered.promise
  const running = await value.get(job.operationId)
  assert.equal(running.status, 'running'); assert.equal(running.phase, 'downloading')
  assert.equal(JSON.parse(await readFile(join(root, 'operations.json'), 'utf8')).jobs[0].phase, 'downloading')
  assert.equal(Object.hasOwn(running, 'percent'), false)
  release.resolve()
  const done = await terminal(value, job.operationId)
  assert.equal(done.phase, 'completed'); assert.deepEqual(done.result, success())
})

test('request fields, IDs, generation, target digests and JSON shape are strict before any write', async t => {
  const root = join(await scratch(t), 'absent'), value = queue(t, root)
  let accessed = 0
  const accessor = request()
  Object.defineProperty(accessor, 'credentialToken', { enumerable: true, get() { accessed++; return 'secret' } })
  const proxy = new Proxy(request(), { ownKeys() { accessed++; return [] } })
  const bad = [accessor, proxy, request({ bindingCode: 'secret' }), request({ credentialToken: 'secret' }),
    request({ authorization: 'secret' }), request({ url: 'https://example.test' }), request({ archiveFile: '/private/archive' }),
    request({ phase: 'downloading' }), request({ operationKey: 'dpc_token_' + 'a'.repeat(43) }), request({ operationKey: 'constructor' }),
    request({ operationKey: 'bad/key' }), request({ operationKey: 'x'.repeat(129) }), request({ operationKey: undefined }),
    request({ expectedGeneration: -1 }), request({ expectedGeneration: 0.1 }), request({ expectedGeneration: Infinity }),
    request({ expectedGeneration: -0 }), request({ releaseId: '../escape' }), request({ releaseId: 'a..b' }),
    request({ releaseId: 'x'.repeat(65) }), request({ packId: 'extra' }), request({ kind: 'delete_everything' }),
    request({ connectionRevision: undefined }), request({ connectionRevision: -1 }), request({ target: undefined }),
    request({ target: { manifestSha256: 'a'.repeat(64) } }),
    request({ target: { ...request().target, manifestSha256: 'A'.repeat(64) } }),
    request({ target: { ...request().target, token: 'secret' } }),
    { operationKey: 'local-1', kind: 'enable', expectedGeneration: 0, releaseId: 'release-1', packId: 'pack-1' },
    { operationKey: 'local-1', kind: 'disable', expectedGeneration: 0, packId: 'pack-1', releaseId: 'release-1' },
    { operationKey: 'local-1', kind: 'uninstall', expectedGeneration: 0, releaseId: 'release-1', connectionRevision: 1 },
    { operationKey: 'local-1', kind: 'rollback', expectedGeneration: 0, releaseId: 'release-1' },
  ]
  for (const input of bad) await rejectsCode(value.enqueue(input), 'OPERATION_INVALID')
  assert.equal(accessed, 0)
  await assert.rejects(lstat(root), { code: 'ENOENT' })
  for (const input of [request(), request({ kind: 'update_enable' }),
    { operationKey: 'enable-1', kind: 'enable', expectedGeneration: 0, releaseId: 'r1' },
    { operationKey: 'disable-1', kind: 'disable', expectedGeneration: 1, packId: 'p1' },
    { operationKey: 'rollback-1', kind: 'rollback', expectedGeneration: 2, packId: 'p1', releaseId: 'r0' },
    { operationKey: 'uninstall-1', kind: 'uninstall', expectedGeneration: 3, releaseId: 'r1' },
  ]) assert.deepEqual(validatePackOperationRequest(input), input)
})

test('same-key identical request replays; different immutable request conflicts across queue instances', async t => {
  const root = await scratch(t), first = queue(t, root), second = queue(t, root)
  const [a, b] = await Promise.all([first.enqueue(request()), second.enqueue(request())])
  assert.deepEqual(a, b)
  assert.equal((await first.list()).length, 1)
  for (const changed of [request({ expectedGeneration: 1 }), request({ connectionRevision: 2 }), request({ releaseId: 'r2' }),
    request({ target: { ...request().target, manifestSha256: 'd'.repeat(64) } }), request({ kind: 'update_enable' })]) {
    await rejectsCode(second.enqueue(changed), 'IDEMPOTENCY_CONFLICT')
  }
  assert.deepEqual((await first.get(a.operationId)).request, request())
})

test('fixed failures and partial activation results are public; arbitrary exception payloads never persist', async t => {
  const root = await scratch(t)
  const value = queue(t, root, { execute: async input => {
    if (input.operationKey === 'failed-known') throw Object.assign(new Error('secret /private/credential'), { code: 'DEPENDENCY_BLOCKED', details: { token: 'secret' } })
    if (input.operationKey === 'failed-unknown') throw Object.assign(new Error('raw token dpc_token_secret'), { code: 'SECRET_VALUE' })
    return success({ outcome: 'installed_not_enabled', activated: false, errorCode: 'GENERATION_CONFLICT' })
  } })
  await value.start()
  const known = await value.enqueue(request({ operationKey: 'failed-known' })), unknown = await value.enqueue(request({ operationKey: 'failed-unknown' }))
  const partial = await value.enqueue(request({ operationKey: 'partial' }))
  assert.equal((await terminal(value, known.operationId)).errorCode, 'DEPENDENCY_BLOCKED')
  assert.equal((await terminal(value, unknown.operationId)).errorCode, 'OPERATION_FAILED')
  const done = await terminal(value, partial.operationId)
  assert.equal(done.status, 'failed'); assert.equal(done.result.outcome, 'installed_not_enabled')
  assert.equal(done.errorCode, 'GENERATION_CONFLICT')
  const raw = await readFile(join(root, 'operations.json'), 'utf8')
  for (const text of ['secret', '/private', 'SECRET_VALUE', 'details', 'dpc_token']) assert.equal(raw.includes(text), false)
  assert.equal(sanitizePackOperationError({ code: 'REVISION_CONFLICT', message: 'secret' }), 'REVISION_CONFLICT')
  let read = false
  assert.equal(sanitizePackOperationError({ get code() { read = true; return 'REVISION_CONFLICT' } }), 'OPERATION_FAILED')
  assert.equal(read, false)
})

test('invalid executor results and unknown progress cannot enter the journal', async t => {
  const root = await scratch(t)
  const value = queue(t, root, { execute: async (input, report) => {
    if (input.operationKey === 'invalid-phase') await report('secret-token-92%')
    if (input.operationKey === 'invalid-result') return { ...success(), credentialToken: 'secret' }
    return success({ errorCode: 'SECRET_CODE' })
  } })
  await value.start()
  for (const key of ['invalid-phase', 'invalid-result', 'invalid-code']) {
    const job = await value.enqueue(request({ operationKey: key }))
    const done = await terminal(value, job.operationId)
    assert.equal(done.status, key === 'invalid-phase' ? 'failed' : 'interrupted')
    assert.equal(done.errorCode, key === 'invalid-phase' ? 'OPERATION_INVALID' : 'OPERATION_INVALID_RESULT')
  }
  const raw = await readFile(join(root, 'operations.json'), 'utf8')
  for (const text of ['secret-token', '92%', 'credentialToken', 'SECRET_CODE']) assert.equal(raw.includes(text), false)
})

test('progress called without await is serialized and flushed before final success', async t => {
  const root = await scratch(t)
  let late
  const value = queue(t, root, { execute: async (_input, report) => {
    report('downloading'); report('verifying'); report('installing'); late = report
    return success()
  } })
  await value.start()
  const job = await value.enqueue(request())
  assert.equal((await terminal(value, job.operationId)).status, 'succeeded')
  const before = await readFile(join(root, 'operations.json'), 'utf8')
  await late('downloading')
  assert.equal(await readFile(join(root, 'operations.json'), 'utf8'), before)
})

test('explicit retry retains exact target and key, while repeated enqueue never retries a failure', async t => {
  const root = await scratch(t)
  let calls = 0
  const value = queue(t, root, { execute: async input => {
    assert.deepEqual(input, request()); calls++
    if (calls === 1) throw Object.assign(new Error(), { code: 'CENTER_REQUEST_FAILED' })
    return success()
  } })
  await value.start()
  const job = await value.enqueue(request())
  assert.equal((await terminal(value, job.operationId)).status, 'failed')
  assert.equal((await value.enqueue(request())).status, 'failed')
  assert.equal(calls, 1)
  const retried = await value.retry(job.operationId)
  assert.equal(retried.operationId, job.operationId); assert.deepEqual(retried.request, request())
  assert.equal((await terminal(value, job.operationId)).status, 'succeeded')
  assert.equal(calls, 2)
  assert.equal((await value.retry(job.operationId)).status, 'succeeded')
  assert.equal(calls, 2)
  await rejectsCode(value.retry(`op_${'f'.repeat(64)}`), 'OPERATION_NOT_FOUND')
})

test('partial committed update remains failed on retry; new activation requires a new operation and generation', async t => {
  const root = await scratch(t)
  let calls = 0, committed = false
  const partial = success({ outcome: 'installed_not_enabled', activated: false, errorCode: 'GENERATION_CONFLICT' })
  const value = queue(t, root, {
    execute: async input => {
      calls++
      if (input.kind === 'update_enable') { committed = true; return partial }
      assert.equal(input.kind, 'enable'); assert.equal(input.expectedGeneration, 1)
      return success({ generation: 2, activated: true })
    },
    recover: async input => input.kind === 'update_enable' && committed ? partial : null,
  })
  await value.start()
  const job = await value.enqueue(request({ kind: 'update_enable' }))
  assert.deepEqual((await terminal(value, job.operationId)).result, partial)
  await value.retry(job.operationId)
  const retried = await terminal(value, job.operationId)
  assert.equal(retried.status, 'failed'); assert.deepEqual(retried.result, partial); assert.equal(calls, 1)
  const activation = await value.enqueue({ operationKey: 'explicit-new-activation', kind: 'enable', expectedGeneration: 1, releaseId: 'release-1' })
  assert.equal((await terminal(value, activation.operationId)).result.activated, true)
  assert.equal(calls, 2)
})

test('failed local receipt recovery never invokes executor or exposes exception data', async t => {
  const root = await scratch(t)
  let calls = 0
  const value = queue(t, root, {
    execute: async () => { calls++; return success() },
    recover: async () => { throw Object.assign(new Error('private /inventory/path'), { code: 'STATE_CORRUPT', details: 'token' }) },
  })
  await value.start()
  const job = await value.enqueue(request())
  const done = await terminal(value, job.operationId)
  assert.equal(done.status, 'interrupted'); assert.equal(done.errorCode, 'STATE_CORRUPT'); assert.equal(calls, 0)
  assert.equal((await readFile(join(root, 'operations.json'), 'utf8')).includes('/inventory/path'), false)
})

test('local receipt resolves a thrown post-commit exception and a queued replay without re-executing', async t => {
  const root = await scratch(t)
  let committed = false, calls = 0
  const value = queue(t, root, {
    execute: async () => { calls++; committed = true; throw Object.assign(new Error('private path'), { code: 'STATE_COMMIT_UNCERTAIN' }) },
    recover: async () => committed ? success() : null,
  })
  await value.start()
  const first = await value.enqueue(request())
  assert.equal((await terminal(value, first.operationId)).status, 'succeeded')
  const replay = await value.enqueue(request({ operationKey: 'known-local-receipt' }))
  assert.equal((await terminal(value, replay.operationId)).status, 'succeeded')
  assert.equal(calls, 1)
})

test('ambiguous commit without receipt is interrupted and never auto-retried after restart', async t => {
  const root = await scratch(t)
  let calls = 0
  const first = queue(t, root, { execute: async () => { calls++; throw Object.assign(new Error(), { code: 'STATE_COMMIT_UNCERTAIN' }) } })
  await first.start()
  const job = await first.enqueue(request())
  assert.equal((await terminal(first, job.operationId)).status, 'interrupted')
  await first.close()
  const second = queue(t, root, { execute: async () => { calls++; return success() } })
  await second.start()
  assert.equal((await terminal(second, job.operationId)).status, 'interrupted')
  assert.equal(calls, 1)
  await second.retry(job.operationId)
  assert.equal((await terminal(second, job.operationId)).status, 'succeeded')
  assert.equal(calls, 2)
})

test('single runner across instances does not interrupt another live job and picks up follower enqueues', async t => {
  const root = await scratch(t), entered = deferred(), release = deferred()
  let firstCalls = 0, secondCalls = 0
  const first = queue(t, root, { execute: async () => { firstCalls++; entered.resolve(); await release.promise; return success() } })
  const second = queue(t, root, { execute: async () => { secondCalls++; return success() } })
  t.after(() => release.resolve())
  await first.start()
  const firstJob = await first.enqueue(request())
  await entered.promise
  await second.start()
  const secondJob = await second.enqueue(request({ operationKey: 'second-job' }))
  assert.equal((await second.get(firstJob.operationId)).status, 'running')
  assert.equal((await second.get(secondJob.operationId)).status, 'queued')
  release.resolve()
  assert.equal((await terminal(second, firstJob.operationId)).status, 'succeeded')
  assert.equal((await terminal(second, secondJob.operationId)).status, 'succeeded')
  assert.equal(firstCalls, 2); assert.equal(secondCalls, 0)
  await first.close()
  const takeover = await second.enqueue(request({ operationKey: 'third-job' }))
  assert.equal((await terminal(second, takeover.operationId)).status, 'succeeded')
  assert.equal(secondCalls, 1)
})

test('close drains an in-flight operation but leaves queued jobs for the next runner', async t => {
  const root = await scratch(t), entered = deferred(), release = deferred()
  let calls = 0
  const value = queue(t, root, { execute: async () => { calls++; entered.resolve(); await release.promise; return success() } })
  t.after(() => release.resolve())
  await value.start()
  const first = await value.enqueue(request())
  await entered.promise
  const second = await value.enqueue(request({ operationKey: 'remaining' }))
  let closed = false
  const closing = value.close().then(() => { closed = true })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(closed, false)
  await rejectsCode(value.enqueue(request({ operationKey: 'too-late' })), 'OPERATION_CLOSED')
  release.resolve(); await closing
  assert.equal((await value.get(first.operationId)).status, 'succeeded')
  assert.equal((await value.get(second.operationId)).status, 'queued'); assert.equal(calls, 1)
  await rejectsCode(value.start(), 'OPERATION_CLOSED')
  const next = queue(t, root)
  await next.start()
  assert.equal((await terminal(next, second.operationId)).status, 'succeeded')
})

test('corrupt, duplicate-key, oversized, missing initialized journal and secret properties preserve disk and refuse writes', async t => {
  const parent = await scratch(t)
  for (const [index, change] of [
    () => '{broken',
    text => text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    () => 'x'.repeat(2 * 1024 * 1024 + 1),
    text => text.replace('"kind":"install"', '"kind":"install","credentialToken":"private"'),
    text => text.replace('"status":"queued"', '"status":"succeeded"'),
    () => null,
  ].entries()) {
    const root = join(parent, `case-${index}`), value = queue(t, root)
    await value.enqueue(request())
    const path = join(root, 'operations.json'), changed = change(await readFile(path, 'utf8'))
    if (changed === null) await unlink(path)
    else await writeFile(path, changed, { mode: 0o600 })
    await rejectsCode(value.list(), 'OPERATION_STORAGE_CORRUPT')
    await rejectsCode(value.enqueue(request({ operationKey: 'new-op' })), 'OPERATION_STORAGE_CORRUPT')
    await rejectsCode(value.start(), 'OPERATION_STORAGE_CORRUPT')
    if (changed === null) await assert.rejects(lstat(path), { code: 'ENOENT' })
    else assert.equal(await readFile(path, 'utf8'), changed)
  }
})

test('private storage rejects broad roots, insecure modes, symlink components, hardlinks and nonregular files', async t => {
  for (const root of ['/', '/root', '/tmp', '/var/lib', homedir(), process.cwd(), 'relative', '/tmp/../tmp/private', '/tmp/queue/']) {
    assert.throws(() => createPackOperationQueue({ root, execute: async () => success(), recover: async () => null }), { code: 'OPERATION_STORAGE_UNSAFE' })
  }
  const parent = await scratch(t), unsafe = join(parent, 'unsafe')
  await mkdir(unsafe, { mode: 0o755 }); await chmod(unsafe, 0o755)
  await rejectsCode(queue(t, unsafe).enqueue(request()), 'OPERATION_STORAGE_UNSAFE')
  assert.equal((await lstat(unsafe)).mode & 0o7777, 0o755)
  const alias = join(parent, 'alias')
  await symlink(unsafe, alias)
  await rejectsCode(queue(t, alias).list(), 'OPERATION_STORAGE_UNSAFE')
  await rejectsCode(queue(t, join(alias, 'child')).enqueue(request()), 'OPERATION_STORAGE_UNSAFE')
  for (const [index, type] of ['symlink', 'hardlink', 'mode', 'directory'].entries()) {
    const root = join(parent, `case-${index}`), value = queue(t, root)
    await value.enqueue(request())
    const path = join(root, 'operations.json'), contents = await readFile(path, 'utf8'), target = join(parent, `outside-${index}`)
    await writeFile(target, contents, { mode: 0o600 })
    if (type === 'mode') await chmod(path, 0o644)
    else {
      await unlink(path)
      if (type === 'symlink') await symlink(target, path)
      else if (type === 'hardlink') await link(target, path)
      else await mkdir(path, { mode: 0o700 })
    }
    await rejectsCode(value.list(), 'OPERATION_STORAGE_UNSAFE')
    await rejectsCode(value.enqueue(request({ operationKey: 'other' })), 'OPERATION_STORAGE_UNSAFE')
    assert.equal(await readFile(target, 'utf8'), contents)
  }
})

test('unsafe lock and initialized marker aliases are rejected without replacing targets', async t => {
  const parent = await scratch(t)
  for (const name of ['.operations.lock', '.operations.runner.lock', '.operations.initialized']) {
    const root = join(parent, name.slice(1)), value = queue(t, root)
    await value.enqueue(request())
    const path = join(root, name), target = join(parent, `target-${name}`)
    await writeFile(target, '', { mode: 0o600 })
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error })
    await symlink(target, path)
    if (name === '.operations.runner.lock') {
      await rejectsCode(value.start(), 'OPERATION_STORAGE_UNSAFE')
      await rejectsCode(value.list(), 'OPERATION_STORAGE_UNSAFE')
      await rejectsCode(value.get(`op_${'a'.repeat(64)}`), 'OPERATION_STORAGE_UNSAFE')
    } else await rejectsCode(value.list(), 'OPERATION_STORAGE_UNSAFE')
    assert.equal(await readFile(target, 'utf8'), '')
    assert.equal((await lstat(path)).isSymbolicLink(), true)
  }
})

test('background runner storage failure surfaces a fixed code on reads and preserves unfinished durable state', async t => {
  const root = await scratch(t), entered = deferred(), release = deferred()
  const value = queue(t, root, { execute: async (_request, report) => {
    entered.resolve(); await release.promise; await report('verifying'); return success()
  } })
  t.after(() => release.resolve())
  await value.start()
  const job = await value.enqueue(request())
  await entered.promise
  const before = await readFile(join(root, 'operations.json'), 'utf8')
  await chmod(join(root, '.operations.runner.lock'), 0o644)
  release.resolve()
  await waitFor(async () => {
    try { await value.get(job.operationId); return false } catch (error) { return error.code === 'OPERATION_STORAGE_UNSAFE' }
  }, 'safe surfaced runner failure')
  await rejectsCode(value.list(), 'OPERATION_STORAGE_UNSAFE')
  await rejectsCode(value.enqueue(request({ operationKey: 'must-not-run' })), 'OPERATION_STORAGE_UNSAFE')
  assert.equal(await readFile(join(root, 'operations.json'), 'utf8'), before)
})

test('bounded retained operation history fails explicitly and never silently prunes or replaces requests', async t => {
  const root = await scratch(t), value = queue(t, root)
  for (let index = 0; index < MAX_PACK_OPERATIONS; index++) {
    await value.enqueue({ operationKey: `op-${index}`, kind: 'disable', expectedGeneration: index, packId: 'pack-1' })
  }
  const before = await readFile(join(root, 'operations.json'), 'utf8')
  await rejectsCode(value.enqueue({ operationKey: 'one-too-many', kind: 'disable', expectedGeneration: 0, packId: 'pack-1' }), 'OPERATION_LIMIT')
  assert.equal(await readFile(join(root, 'operations.json'), 'utf8'), before)
  assert.equal((await value.list()).length, MAX_PACK_OPERATIONS)
  assert.equal((await value.enqueue({ operationKey: 'op-0', kind: 'disable', expectedGeneration: 0, packId: 'pack-1' })).status, 'queued')
})

const childScript = `
import { createPackOperationQueue } from ${JSON.stringify(moduleUrl)};
import { appendFile, readFile } from 'node:fs/promises';
const [root, events, receipts, mode] = process.argv.slice(1);
const queue = createPackOperationQueue({ root,
  execute: async (request, progress) => {
    await appendFile(events, request.operationKey + '\\n', { mode: 0o600 });
    await progress('downloading');
    process.send({ type: 'executing', key: request.operationKey });
    if (mode === 'hang') await new Promise(() => {});
    return { generation: 1, outcome: 'succeeded', releaseId: request.releaseId, activated: false };
  },
  recover: async request => {
    let data; try { data = JSON.parse(await readFile(receipts, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return data[request.operationKey] ?? null;
  }
});
process.on('message', async message => {
  try {
    if (message.type === 'enqueue') process.send({ type: 'enqueued', tag: message.tag, job: await queue.enqueue(message.request) });
    if (message.type === 'close') { await queue.close(); process.send({ type: 'closed' }); process.disconnect(); }
  } catch (error) { process.send({ type: 'error', code: error.code, tag: message.tag }); }
});
await queue.start(); process.send({ type: 'ready' });
`

function worker(t, args) {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', childScript, ...args],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const messages = []
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  child.on('message', message => messages.push(message))
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('close', resolve))
  })
  return {
    child,
    async message(type, tag) {
      return waitFor(() => {
        const index = messages.findIndex(item => item.type === type && (tag === undefined || item.tag === tag))
        if (index !== -1) return messages.splice(index, 1)[0]
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker exited: ${child.exitCode ?? child.signalCode}: ${stderr}`)
        return null
      }, `child ${type}`)
    },
    async kill() {
      const closed = new Promise(resolve => child.once('close', resolve))
      child.kill('SIGKILL'); await closed
    },
  }
}

test('cross-process runner lock prevents duplicate execution; killed work without a receipt needs explicit retry', async t => {
  const parent = await scratch(t), root = join(parent, 'operations'), events = join(parent, 'events'), receipts = join(parent, 'receipts')
  const value = queue(t, root)
  const job = await value.enqueue(request())
  const first = worker(t, [root, events, receipts, 'hang'])
  await first.message('ready'); await first.message('executing')
  const second = worker(t, [root, events, receipts, 'finish'])
  await second.message('ready')
  second.child.send({ type: 'enqueue', tag: 'same', request: request() })
  assert.equal((await second.message('enqueued', 'same')).job.status, 'running')
  assert.equal((await value.get(job.operationId)).phase, 'downloading')
  assert.equal(await readFile(events, 'utf8'), 'install-test-1\n')
  await first.kill()
  const interrupted = await terminal(value, job.operationId)
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.errorCode, 'OPERATION_INTERRUPTED')
  assert.equal(await readFile(events, 'utf8'), 'install-test-1\n')
  await value.retry(job.operationId)
  assert.equal((await terminal(value, job.operationId)).status, 'succeeded')
  assert.equal(await readFile(events, 'utf8'), 'install-test-1\ninstall-test-1\n')
  second.child.send({ type: 'close' }); await second.message('closed')
})

test('killed process with a durable local receipt recovers success without executing or changing target', async t => {
  const parent = await scratch(t), root = join(parent, 'operations'), events = join(parent, 'events'), receipts = join(parent, 'receipts')
  const value = queue(t, root), job = await value.enqueue(request())
  const first = worker(t, [root, events, receipts, 'hang'])
  await first.message('ready'); await first.message('executing')
  await writeFile(receipts, JSON.stringify({ 'install-test-1': success() }), { mode: 0o600 })
  await first.kill()
  const second = worker(t, [root, events, receipts, 'finish'])
  await second.message('ready')
  const done = await terminal(value, job.operationId)
  assert.equal(done.status, 'succeeded'); assert.deepEqual(done.result, success()); assert.deepEqual(done.request, request())
  assert.equal(await readFile(events, 'utf8'), 'install-test-1\n')
  second.child.send({ type: 'close' }); await second.message('closed')
})

test('cross-process enqueue serializes identical keys and rejects concurrent different requests', async t => {
  const parent = await scratch(t), root = join(parent, 'operations'), events = join(parent, 'events'), receipts = join(parent, 'receipts')
  const first = worker(t, [root, events, receipts, 'hang']), second = worker(t, [root, events, receipts, 'hang'])
  await first.message('ready'); await second.message('ready')
  first.child.send({ type: 'enqueue', tag: 'first', request: request() })
  second.child.send({ type: 'enqueue', tag: 'second', request: request() })
  const [a, b] = await Promise.all([first.message('enqueued', 'first'), second.message('enqueued', 'second')])
  assert.equal(a.job.operationId, b.job.operationId)
  second.child.send({ type: 'enqueue', tag: 'different', request: request({ connectionRevision: 2 }) })
  assert.equal((await second.message('error', 'different')).code, 'IDEMPOTENCY_CONFLICT')
  await waitFor(async () => (await queue(t, root).get(a.job.operationId)).status === 'running')
  await waitFor(async () => { try { return (await readFile(events, 'utf8')).length > 0 } catch { return false } })
  assert.equal(await readFile(events, 'utf8'), 'install-test-1\n')
})
