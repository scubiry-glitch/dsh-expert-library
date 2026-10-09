import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { canonicalBytes } from '../../../packages/pack-contract/index.mjs'
import { createLocalArtifactStore, DEFAULT_ARTIFACT_MAX_BYTES, HARD_ARTIFACT_MAX_BYTES } from '../dist/storage.js'

const exec = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const hasCode = (...codes) => error => { assert.ok(codes.includes(error.code), `Unexpected code: ${error.code}; ${error.message}`); return true }
const storageModule = new URL('../dist/storage.js', import.meta.url).href
async function setup(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'pack-center-storage-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'objects')
  const store = await createLocalArtifactStore(root, options)
  return { base, root, store, object: digest => join(root, 'sha256', digest, 'data') }
}

test('local adapter stores canonical JSON and private immutable content-addressed files', async t => {
  const { root, store, object } = await setup(t)
  assert.equal(store.maxBytes, DEFAULT_ARTIFACT_MAX_BYTES)
  const value = { b: ['领域包', 3], a: true }
  const bytes = canonicalBytes(value)
  const result = await store.putJson(value)
  assert.deepEqual(result, { key: `sha256/${sha(bytes)}`, sha256: sha(bytes), sizeBytes: bytes.length })
  assert.deepEqual(await store.getBytes(result.key), bytes)
  assert.deepEqual(await store.verify(result.key), result)
  for (const path of [root, join(root, '.incoming'), join(root, 'sha256'), join(root, 'sha256', result.sha256)]) {
    assert.equal((await stat(path)).mode & 0o777, 0o700)
  }
  assert.equal((await stat(object(result.sha256))).mode & 0o777, 0o400)
  assert.equal((await stat(object(result.sha256))).nlink, 1)
  assert.deepEqual(await readdir(join(root, '.incoming')), [])
})

test('file copy is streamed, expected hash is enforced, and equal content is reused without inode replacement', async t => {
  const { base, store, object } = await setup(t)
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 37, 0xa3)
  const source = join(base, 'pack.tar')
  await writeFile(source, bytes)
  const result = await store.putFile(source, sha(bytes))
  const before = await stat(object(result.sha256))
  assert.deepEqual(await store.putFile(source, sha(bytes)), result)
  const after = await stat(object(result.sha256))
  assert.equal(before.ino, after.ino)
  assert.equal(before.mtimeMs, after.mtimeMs)
  assert.deepEqual(await store.getBytes(result.key), bytes)
  const { stream, ...descriptor } = await store.openStream(result.key)
  let count = 0
  const hash = createHash('sha256')
  for await (const chunk of stream) { count += chunk.length; hash.update(chunk) }
  assert.equal(count, bytes.length)
  assert.equal(hash.digest('hex'), result.sha256)
  assert.deepEqual(descriptor, result)
})

test('24 concurrent writers converge on one immutable object and independent keys remain independent', async t => {
  const { root, store } = await setup(t)
  const value = { pack: 'org.demo', version: '1.0.0' }
  const descriptors = await Promise.all(Array.from({ length: 24 }, () => store.putJson(value)))
  assert.equal(new Set(descriptors.map(row => row.key)).size, 1)
  assert.equal((await readdir(join(root, 'sha256'))).length, 1)
  const other = await Promise.all(Array.from({ length: 12 }, (_, index) => store.putJson({ index })))
  assert.equal(new Set(other.map(row => row.key)).size, 12)
  assert.equal((await readdir(join(root, 'sha256'))).length, 13)
  assert.deepEqual(await readdir(join(root, '.incoming')), [])
})

test('independent processes publish the same key without locks, overwrite, or temporary hard links', async t => {
  const { root, store } = await setup(t)
  const script = `import {createLocalArtifactStore} from ${JSON.stringify(storageModule)};
    const store=await createLocalArtifactStore(process.argv[1]);
    for(let i=0;i<8;i++) await store.putJson({value:'cross-process'});`
  await Promise.all(Array.from({ length: 6 }, () => exec(process.execPath, ['--input-type=module', '-e', script, root])))
  const key = `sha256/${sha(canonicalBytes({ value: 'cross-process' }))}`
  assert.deepEqual(await store.getBytes(key), canonicalBytes({ value: 'cross-process' }))
  assert.equal((await readdir(join(root, 'sha256'))).length, 1)
  assert.deepEqual(await readdir(join(root, '.incoming')), [])
})

test('source digest mismatch and excessive file/JSON input never publish or leave owned staging', async t => {
  const { root, base, store } = await setup(t, { maxBytes: 100 })
  const source = join(base, 'source')
  await writeFile(source, 'bytes')
  await assert.rejects(store.putFile(source, '0'.repeat(64)), hasCode('STORAGE_HASH_MISMATCH'))
  await assert.rejects(store.putFile(source, `${sha('bytes')}\n`), hasCode('STORAGE_BAD_KEY'))
  await assert.rejects(store.putJson({ over: 'x'.repeat(120) }), hasCode('STORAGE_LIMIT'))
  await writeFile(source, Buffer.alloc(1024))
  await assert.rejects(store.putFile(source), hasCode('STORAGE_LIMIT'))
  assert.deepEqual(await readdir(join(root, '.incoming')), [])
  assert.deepEqual(await readdir(join(root, 'sha256')), [])
})

test('per-request limits can tighten but never relax store limits; empty files work', async t => {
  const { base, store } = await setup(t, { maxBytes: 64 })
  const source = join(base, 'source')
  await writeFile(source, Buffer.alloc(65))
  await assert.rejects(store.putFile(source, undefined, { maxBytes: 100 }), hasCode('STORAGE_LIMIT'))
  const result = await store.putJson({ a: '12345' })
  for (const method of ['verify', 'getBytes', 'openStream']) {
    await assert.rejects(store[method](result.key, { maxBytes: result.sizeBytes - 1 }), hasCode('STORAGE_LIMIT'))
  }
  assert.equal((await store.getBytes(result.key, { maxBytes: result.sizeBytes })).length, result.sizeBytes)
  await writeFile(source, '')
  const empty = await store.putFile(source, sha(''), { maxBytes: 0 })
  assert.equal(empty.sizeBytes, 0)
  assert.deepEqual(await store.getBytes(empty.key, { maxBytes: 0 }), Buffer.alloc(0))
  for (const maxBytes of [-1, 1.5, NaN, Infinity, HARD_ARTIFACT_MAX_BYTES + 1]) {
    await assert.rejects(store.getBytes(empty.key, { maxBytes }), hasCode('STORAGE_LIMIT'))
  }
})

test('fixed keys reject traversal, encoded paths, uppercase hashes, NUL, and trailing newline', async t => {
  const { store } = await setup(t)
  for (const key of ['../outside', '/tmp/secret', 'sha256/../../secret', `sha256/${'a'.repeat(64)}/data`,
    `sha256/${'A'.repeat(64)}`, `sha256/${'a'.repeat(64)}\n`, `sha256/${'a'.repeat(64)}\0`,
    `sha256/%2e%2e`, null, {}, '', 'https://example.invalid/file']) {
    for (const method of ['verify', 'getBytes', 'openStream']) await assert.rejects(store[method](key), hasCode('STORAGE_BAD_KEY'))
  }
})

test('store refuses public/symlink roots and parent symlinks, without changing existing permissions', async t => {
  const { base } = await setup(t)
  const publicRoot = join(base, 'public')
  await mkdir(publicRoot, { mode: 0o755 })
  await assert.rejects(createLocalArtifactStore(publicRoot), hasCode('STORAGE_UNSAFE_PATH'))
  assert.equal((await stat(publicRoot)).mode & 0o777, 0o755)
  const destination = join(base, 'actual')
  await mkdir(destination, { mode: 0o700 })
  const linked = join(base, 'linked')
  await symlink(destination, linked)
  await assert.rejects(createLocalArtifactStore(linked), hasCode('STORAGE_UNSAFE_PATH'))
  await assert.rejects(createLocalArtifactStore(join(linked, 'new')), hasCode('STORAGE_UNSAFE_PATH'))
  assert.deepEqual(await readdir(destination), [])
})

test('source symbolic/hard links and nonregular files are rejected', async t => {
  const { base, store } = await setup(t)
  const source = join(base, 'source')
  await writeFile(source, 'real')
  const linked = join(base, 'linked')
  await symlink(source, linked)
  await assert.rejects(store.putFile(linked), hasCode('STORAGE_UNSAFE_PATH'))
  const hard = join(base, 'hard')
  await link(source, hard)
  await assert.rejects(store.putFile(source), hasCode('STORAGE_UNSAFE_PATH'))
  await assert.rejects(store.putFile(hard), hasCode('STORAGE_UNSAFE_PATH'))
  await assert.rejects(store.putFile(base), hasCode('STORAGE_UNSAFE_PATH'))
  await assert.rejects(store.putFile('/dev/null'), hasCode('STORAGE_UNSAFE_PATH'))
})

test('existing corrupt objects cannot be downloaded or overwritten by an otherwise valid retry', async t => {
  const { store, object } = await setup(t)
  const value = { approved: true }
  const result = await store.putJson(value)
  const file = object(result.sha256)
  await chmod(file, 0o600)
  await writeFile(file, Buffer.alloc(result.sizeBytes, 'x'))
  await chmod(file, 0o400)
  const inode = (await stat(file)).ino
  await assert.rejects(store.verify(result.key), hasCode('STORAGE_HASH_MISMATCH'))
  await assert.rejects(store.getBytes(result.key), hasCode('STORAGE_HASH_MISMATCH'))
  await assert.rejects(store.putJson(value), hasCode('STORAGE_HASH_MISMATCH'))
  assert.equal((await stat(file)).ino, inode)
  assert.deepEqual(await readFile(file), Buffer.alloc(result.sizeBytes, 'x'))
})

test('invalid existing empty object directories are not repaired or replaced silently', async t => {
  const { root, store } = await setup(t)
  const value = { reserved: true }
  const digest = sha(canonicalBytes(value))
  const target = join(root, 'sha256', digest)
  await mkdir(target, { mode: 0o700 })
  const before = await stat(target)
  await assert.rejects(store.putJson(value), hasCode('ENOENT'))
  assert.equal((await stat(target)).ino, before.ino)
  assert.deepEqual(await readdir(target), [])
})

test('stored symlinks, hardlinks and writable blobs fail closed', async t => {
  const { base, store, object } = await setup(t)
  const one = await store.putJson({ n: 1 })
  const two = await store.putJson({ n: 2 })
  const three = await store.putJson({ n: 3 })
  await rename(object(one.sha256), join(base, 'original'))
  await symlink(join(base, 'original'), object(one.sha256))
  await assert.rejects(store.getBytes(one.key), hasCode('ELOOP'))
  await link(object(two.sha256), join(base, 'hardlink'))
  await assert.rejects(store.getBytes(two.key), hasCode('STORAGE_UNSAFE_PATH'))
  await chmod(object(three.sha256), 0o600)
  await assert.rejects(store.getBytes(three.key), hasCode('STORAGE_UNSAFE_PATH'))
})

test('an opened stream stays on its verified FD and rejects post-verification mutation', async t => {
  const { base, store, object } = await setup(t)
  const value = { original: true }
  const result = await store.putJson(value)
  const first = await store.openStream(result.key)
  // Replacing the path cannot redirect this stream to different content; the old FD is checked.
  await rename(object(result.sha256), join(base, 'old-blob'))
  await writeFile(object(result.sha256), Buffer.alloc(result.sizeBytes, 'z'), { mode: 0o400 })
  await assert.rejects(async () => { for await (const _ of first.stream) {} }, hasCode('STORAGE_HASH_MISMATCH'))
  await rm(object(result.sha256))
  await rename(join(base, 'old-blob'), object(result.sha256))
  const next = await store.openStream(result.key)
  await chmod(object(result.sha256), 0o600)
  await writeFile(object(result.sha256), Buffer.alloc(result.sizeBytes, 'x'))
  await chmod(object(result.sha256), 0o400)
  await assert.rejects(async () => { for await (const _ of next.stream) {} }, hasCode('STORAGE_HASH_MISMATCH'))
})

test('crash before publish leaves no visible object; crash after publish leaves a complete verified object', async t => {
  for (const point of ['after-data-sync', 'after-publish', 'after-directory-sync']) {
    const { root, store } = await setup(t)
    const value = { crash: point }
    const key = `sha256/${sha(canonicalBytes(value))}`
    const script = `import {createLocalArtifactStore} from ${JSON.stringify(storageModule)};
      const store=await createLocalArtifactStore(process.argv[1],{fault(point){if(point===process.argv[2])process.exit(42)}});
      await store.putJson({crash:process.argv[2]});`
    await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', script, root, point]), error => error.code === 42)
    const reopened = await createLocalArtifactStore(root)
    if (point === 'after-data-sync') {
      await assert.rejects(reopened.verify(key), hasCode('ENOENT'))
      assert.equal((await readdir(join(root, '.incoming'))).length, 1, 'Orphan staging is private and never auto-published')
    } else assert.deepEqual(await reopened.getBytes(key), canonicalBytes(value))
    const retried = await store.putJson(value)
    assert.equal(retried.key, key)
    assert.deepEqual(await reopened.getBytes(key), canonicalBytes(value))
    assert.equal((await readdir(join(root, 'sha256'))).length, 1)
  }
})

test('thrown publish fault preserves committed object and retry is idempotent', async t => {
  const { root, store } = await setup(t, { fault(point) { if (point === 'after-publish') throw new Error('injected crash') } })
  const value = { complete: true }
  await assert.rejects(store.putJson(value), /injected crash/)
  const reopened = await createLocalArtifactStore(root)
  const result = await reopened.putJson(value)
  assert.deepEqual(await reopened.getBytes(result.key), canonicalBytes(value))
  assert.deepEqual(await readdir(join(root, '.incoming')), [])
})

test('JSON contract rejects ambiguous noncanonical payloads before storing', async t => {
  const { root, store } = await setup(t)
  for (const payload of [{ bad: undefined }, { n: 1.1 }, { n: NaN }, new Date(), { n: -0 }]) {
    await assert.rejects(store.putJson(payload))
  }
  assert.deepEqual(await readdir(join(root, 'sha256')), [])
})
