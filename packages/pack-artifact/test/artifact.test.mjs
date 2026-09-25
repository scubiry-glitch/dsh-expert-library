import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, readdir, lstat, symlink, link, chmod, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packDirectory, extractArtifact } from '../index.mjs'
import { hashContentDirectory, hashContentTree, sha256 } from '../../pack-contract/index.mjs'

const examples = fileURLToPath(new URL('../../../examples/pack-center/', import.meta.url))
const BLOCK = 512
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pack-artifact-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function absent(path) {
  await assert.rejects(lstat(path), { code: 'ENOENT' })
}
function checksum(header) {
  header.fill(32, 148, 156)
  const sum = header.reduce((total, value) => total + value, 0)
  header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  header[154] = 0; header[155] = 32
  return header
}
function number(header, offset, width, value) {
  header.fill(0, offset, offset + width)
  header.write(value.toString(8).padStart(width - 1, '0'), offset, width - 1, 'ascii')
}
function tarHeader(name, bytes = Buffer.alloc(0), type = '0') {
  const header = Buffer.alloc(BLOCK)
  header.write(name, 0, 100, 'utf8')
  for (const [offset, width, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, bytes.length], [136, 12, 0], [329, 8, 0], [337, 8, 0]]) number(header, offset, width, value)
  header[156] = type.charCodeAt(0)
  header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii')
  return checksum(header)
}
function rawTar(entries) {
  const chunks = []
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes ?? '')
    const header = entry.header ?? tarHeader(entry.path, bytes, entry.type ?? '0')
    chunks.push(header, bytes, Buffer.alloc((BLOCK - bytes.length % BLOCK) % BLOCK))
  }
  return Buffer.concat([...chunks, Buffer.alloc(2 * BLOCK)])
}
function description(bytes, entries = []) {
  const tree = hashContentTree(entries.map(entry => ({ path: entry.path, bytes: Buffer.from(entry.bytes ?? '') })))
  return { artifactSha256: sha256(bytes), sizeBytes: bytes.length, contentTreeSha256: tree.contentTreeSha256, fileCount: tree.fileCount }
}
async function rejectsArchive(t, bytes, code, entries = [], limits) {
  const root = await fixture(t)
  const artifact = join(root, 'bad.tar'); const destination = join(root, 'destination')
  await writeFile(artifact, bytes)
  await assert.rejects(extractArtifact(artifact, destination, description(bytes, entries), limits), error => error.code === code)
  await absent(destination)
  assert.deepEqual(await readdir(root), ['bad.tar'], 'failure removes owned staging and leaves no output tree')
}

for (const version of ['demo-v1', 'demo-v2']) test(`real ${version} roundtrip matches pack-contract hashes`, async t => {
  const root = await fixture(t)
  const source = join(root, 'source'); const artifact = join(root, 'pack.tar'); const destination = join(root, 'installed')
  await cp(join(examples, version), source, { recursive: true })
  const expectedTree = await hashContentDirectory(source)
  const packed = await packDirectory(source, artifact)
  assert.equal(packed.contentTreeSha256, expectedTree.contentTreeSha256)
  assert.equal(packed.contentSizeBytes, expectedTree.sizeBytes)
  assert.equal(packed.fileCount, expectedTree.fileCount)
  assert.equal(packed.artifactSha256, sha256(await readFile(artifact)))
  assert.equal(packed.sizeBytes, (await lstat(artifact)).size)
  assert.ok(packed.sizeBytes > packed.contentSizeBytes)
  const extracted = await extractArtifact(artifact, destination, packed)
  assert.deepEqual(extracted, packed)
  assert.deepEqual(await hashContentDirectory(destination), expectedTree)
})

test('deterministic bytes ignore source mode, time, creation order; UTF-8 and empty directories survive', async t => {
  const root = await fixture(t)
  const a = join(root, 'a'); const b = join(root, 'b')
  await mkdir(a); await mkdir(b)
  const paths = ['nested/中文.md', 'z.txt', 'á.txt', 'a.txt']
  for (const [tree, list] of [[a, paths], [b, [...paths].reverse()]]) {
    await mkdir(join(tree, 'nested')); await mkdir(join(tree, 'empty'))
    for (const path of list) await writeFile(join(tree, path), `${path}\n`)
  }
  await chmod(join(b, 'z.txt'), 0o777); await utimes(join(b, 'z.txt'), 1000000, 1000000)
  const first = await packDirectory(a, join(root, 'a.tar'))
  const second = await packDirectory(b, join(root, 'b.tar'))
  assert.deepEqual(second, first)
  assert.deepEqual(await readFile(join(root, 'a.tar')), await readFile(join(root, 'b.tar')))
  await extractArtifact(join(root, 'a.tar'), join(root, 'out'), first)
  assert.ok((await lstat(join(root, 'out/empty'))).isDirectory())
  assert.equal((await lstat(join(root, 'out/z.txt'))).mode & 0o777, 0o644)
})

test('empty tree has valid two-block tar and canonical empty hash', async t => {
  const root = await fixture(t); await mkdir(join(root, 'empty'))
  const summary = await packDirectory(join(root, 'empty'), join(root, 'empty.tar'))
  assert.equal(summary.sizeBytes, 1024); assert.equal(summary.fileCount, 0)
  assert.equal(summary.contentTreeSha256, hashContentTree([]).contentTreeSha256)
  await extractArtifact(join(root, 'empty.tar'), join(root, 'out'), summary)
  assert.deepEqual(await readdir(join(root, 'out')), [])
})

test('ustar prefix supports long paths without truncating', async t => {
  const root = await fixture(t); const source = join(root, 'source'); await mkdir(source)
  const prefix = '界'.repeat(30); const name = `${'文'.repeat(30)}.txt`
  await mkdir(join(source, prefix)); await writeFile(join(source, prefix, name), 'long-path')
  const summary = await packDirectory(source, join(root, 'archive.tar'))
  await extractArtifact(join(root, 'archive.tar'), join(root, 'out'), summary)
  assert.equal(await readFile(join(root, 'out', prefix, name), 'utf8'), 'long-path')
})

test('rejects paths that cannot fit ustar rather than truncate', async t => {
  const root = await fixture(t); const source = join(root, 'source'); await mkdir(source)
  await writeFile(join(source, 'a'.repeat(101)), 'no')
  await assert.rejects(packDirectory(source, join(root, 'archive.tar')), { code: 'INVALID_PATH' })
  await absent(join(root, 'archive.tar'))
})

test('no overwrite or implicit parent creation; output cannot be inside input', async t => {
  const root = await fixture(t); const source = join(root, 'source'); await mkdir(source)
  await writeFile(join(source, 'data'), 'safe')
  const artifact = join(root, 'archive.tar'); const summary = await packDirectory(source, artifact)
  const original = await readFile(artifact)
  await assert.rejects(packDirectory(source, artifact), { code: 'STATE_CONFLICT' })
  assert.deepEqual(await readFile(artifact), original)
  await mkdir(join(root, 'existing'))
  await assert.rejects(extractArtifact(artifact, join(root, 'existing'), summary), { code: 'STATE_CONFLICT' })
  await assert.rejects(packDirectory(source, join(root, 'missing/archive.tar')), { code: 'SOURCE_FAILED' })
  await assert.rejects(extractArtifact(artifact, join(root, 'missing/out'), summary), { code: 'SOURCE_FAILED' })
  await assert.rejects(packDirectory(source, join(source, 'inside.tar')), { code: 'INVALID_PATH' })
  await absent(join(root, 'missing'))
})

test('concurrent extraction to one destination has a single winner', async t => {
  const root = await fixture(t); await mkdir(join(root, 'source'))
  await writeFile(join(root, 'source/data'), Buffer.alloc(150000, 11))
  const artifact = join(root, 'archive.tar'); const summary = await packDirectory(join(root, 'source'), artifact)
  const result = await Promise.allSettled([extractArtifact(artifact, join(root, 'out'), summary), extractArtifact(artifact, join(root, 'out'), summary)])
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(result.find(item => item.status === 'rejected').reason.code, 'STATE_CONFLICT')
  assert.equal((await hashContentDirectory(join(root, 'out'))).contentTreeSha256, summary.contentTreeSha256)
})

test('raw-byte tamper, signed size/tree/count mismatch never publish a partial tree', async t => {
  const root = await fixture(t); const source = join(root, 'source'); await mkdir(source)
  await writeFile(join(source, 'data'), 'known-bytes')
  const artifact = join(root, 'archive.tar'); const summary = await packDirectory(source, artifact)
  for (const [key, value] of [['artifactSha256', '0'.repeat(64)], ['contentTreeSha256', '0'.repeat(64)], ['fileCount', summary.fileCount + 1], ['sizeBytes', summary.sizeBytes + 512]]) {
    await assert.rejects(extractArtifact(artifact, join(root, 'out'), { ...summary, [key]: value }), { code: 'INTEGRITY_MISMATCH' })
    await absent(join(root, 'out'))
  }
  const bytes = await readFile(artifact); bytes[512] ^= 1; await writeFile(artifact, bytes)
  await assert.rejects(extractArtifact(artifact, join(root, 'out'), summary), { code: 'INTEGRITY_MISMATCH' })
  await absent(join(root, 'out'))
  assert.deepEqual((await readdir(root)).sort(), ['archive.tar', 'source'])
})

for (const path of ['../escape', '/absolute', 'a/../../escape', 'a\\b', 'C:escape', '.git/config', 'a/.GIT/config', 'a//b', './relative', 'a/./b', 'cafe\u0301.txt', 'a\nb']) test(`reject unsafe tar path ${JSON.stringify(path)}`, t => rejectsArchive(t, rawTar([{ path }]), 'INVALID_PATH'))

for (const type of ['1', '2', '3', '4', '6', '7', 'x', 'g', 'L', 'K', 'S']) test(`reject tar link/special/extension type ${type}`, t => rejectsArchive(t, rawTar([{ path: 'item', type }]), 'UNSUPPORTED_FILE'))

test('rejects duplicate file names', t => rejectsArchive(t, rawTar([{ path: 'x' }, { path: 'x' }]), 'INVALID_PATH', [{ path: 'x' }]))
test('rejects duplicate directory names', t => rejectsArchive(t, rawTar([{ path: 'dir', type: '5' }, { path: 'dir/', type: '5' }]), 'INVALID_PATH'))
test('rejects file ancestor followed by descendant', t => rejectsArchive(t, rawTar([{ path: 'dir' }, { path: 'dir/child' }]), 'INVALID_PATH', [{ path: 'dir' }]))
test('rejects descendant followed by file ancestor', t => rejectsArchive(t, rawTar([{ path: 'dir/child' }, { path: 'dir' }]), 'INVALID_PATH', [{ path: 'dir/child' }]))
test('rejects file/directory collision', t => rejectsArchive(t, rawTar([{ path: 'dir', type: '5' }, { path: 'dir' }]), 'INVALID_PATH'))

test('accepts explicit directory after implicit parent without treating it as a duplicate', async t => {
  const root = await fixture(t); const files = [{ path: 'dir/child', bytes: 'data' }]
  const bytes = rawTar([...files, { path: 'dir/', type: '5' }]); const expected = description(bytes, files)
  await writeFile(join(root, 'archive.tar'), bytes)
  await extractArtifact(join(root, 'archive.tar'), join(root, 'out'), expected)
  assert.equal(await readFile(join(root, 'out/dir/child'), 'utf8'), 'data')
})

test('rejects invalid UTF-8 header name and hidden bytes after NUL', async t => {
  const badUtf8 = tarHeader('good'); badUtf8[0] = 0xff; checksum(badUtf8)
  await rejectsArchive(t, rawTar([{ header: badUtf8 }]), 'INVALID_PATH')
  const hidden = tarHeader('good'); hidden[8] = 97; checksum(hidden)
  await rejectsArchive(t, rawTar([{ header: hidden }]), 'INTEGRITY_MISMATCH')
})

test('rejects header checksum, malformed octal, oversized values and non-ustar format', async t => {
  const broken = tarHeader('data'); broken[0] = 98
  await rejectsArchive(t, rawTar([{ header: broken }]), 'INTEGRITY_MISMATCH')
  const base256 = tarHeader('data'); base256[124] = 128; checksum(base256)
  await rejectsArchive(t, rawTar([{ header: base256 }]), 'INTEGRITY_MISMATCH')
  const huge = tarHeader('data'); number(huge, 124, 12, 0o77777777777); checksum(huge)
  await rejectsArchive(t, rawTar([{ header: huge }]), 'LIMIT_EXCEEDED')
  const legacy = tarHeader('data'); legacy.fill(0, 257, 265); checksum(legacy)
  await rejectsArchive(t, rawTar([{ header: legacy }]), 'UNSUPPORTED_FILE')
})

test('rejects directory data and forbidden link name even on ordinary file', async t => {
  await rejectsArchive(t, rawTar([{ path: 'directory', type: '5', bytes: 'data' }]), 'INTEGRITY_MISMATCH')
  const header = tarHeader('file'); header.write('elsewhere', 157); checksum(header)
  await rejectsArchive(t, rawTar([{ header }]), 'UNSUPPORTED_FILE')
})

test('rejects truncation, nonzero file padding, missing second end block and concatenated tar', async t => {
  const entries = [{ path: 'file', bytes: 'x' }]; const raw = rawTar(entries)
  const padding = Buffer.from(raw); padding[513] = 1
  await rejectsArchive(t, padding, 'INTEGRITY_MISMATCH', entries)
  await rejectsArchive(t, raw.subarray(0, raw.length - 512), 'INTEGRITY_MISMATCH', entries)
  await rejectsArchive(t, raw.subarray(0, raw.length - 1), 'INTEGRITY_MISMATCH', entries)
  await rejectsArchive(t, Buffer.concat([raw, raw]), 'INTEGRITY_MISMATCH', entries)
  const truncated = tarHeader('file'); number(truncated, 124, 12, 2000); checksum(truncated)
  await rejectsArchive(t, rawTar([{ header: truncated }]), 'INTEGRITY_MISMATCH', entries)
})

for (const [label, setup] of [
  ['symlink', async source => symlink('/etc/passwd', join(source, 'evil'))],
  ['directory symlink', async source => symlink('/tmp', join(source, 'evil'))],
  ['hardlink', async source => { await writeFile(join(source, 'one'), 'x'); await link(join(source, 'one'), join(source, 'two')) }],
  ['Git metadata', async source => mkdir(join(source, '.git'))],
  ['invalid filename UTF-8', async source => writeFile(Buffer.concat([Buffer.from(`${source}/`), Buffer.from([255])]), 'x')],
]) test(`packing refuses ${label}`, async t => {
  const root = await fixture(t); const source = join(root, 'source'); await mkdir(source); await setup(source)
  await assert.rejects(packDirectory(source, join(root, 'archive.tar')), error => ['UNSUPPORTED_FILE', 'INVALID_PATH'].includes(error.code))
  await absent(join(root, 'archive.tar'))
})

test('archive symlinks, input root links and output parent links are refused', async t => {
  const root = await fixture(t); await mkdir(join(root, 'source'))
  const summary = await packDirectory(join(root, 'source'), join(root, 'archive.tar'))
  await symlink(join(root, 'archive.tar'), join(root, 'link.tar'))
  await symlink(join(root, 'source'), join(root, 'link-root'))
  await assert.rejects(extractArtifact(join(root, 'link.tar'), join(root, 'out'), summary), { code: 'UNSUPPORTED_FILE' })
  await assert.rejects(packDirectory(join(root, 'link-root'), join(root, 'out.tar')), { code: 'UNSUPPORTED_FILE' })
  await assert.rejects(packDirectory(join(root, 'source'), join(root, 'link-root/out.tar')), { code: 'INVALID_PATH' })
})

test('limits are enforced for both writer and reader without residual output', async t => {
  const root = await fixture(t); const source = join(root, 'source'); await mkdir(source); await mkdir(join(source, 'nested'))
  await writeFile(join(source, 'nested/data'), '12345678'); await writeFile(join(source, 'other'), 'ab')
  const artifact = join(root, 'archive.tar'); const summary = await packDirectory(source, artifact)
  const limited = [{ maxArchiveBytes: 1024 }, { maxFileBytes: 7 }, { maxTotalBytes: 9 }, { maxFiles: 1 }, { maxEntries: 2 }, { maxPathDepth: 1 }]
  for (const limits of limited) {
    await assert.rejects(packDirectory(source, join(root, 'limited.tar'), limits), { code: 'LIMIT_EXCEEDED' })
    await assert.rejects(extractArtifact(artifact, join(root, 'out'), summary, limits), { code: 'LIMIT_EXCEEDED' })
    await absent(join(root, 'limited.tar')); await absent(join(root, 'out'))
  }
  for (const limits of [{ maxFiles: -1 }, { maxFiles: 1.5 }, { maxFiles: Infinity }, { unknown: 3 }]) await assert.rejects(packDirectory(source, join(root, 'bad.tar'), limits), { code: 'INVALID_CONTRACT' })
})

test('script files are passive content and never executed or granted executable mode', async t => {
  const root = await fixture(t); const source = join(root, 'source'); await mkdir(source)
  const marker = join(root, 'must-not-exist')
  await writeFile(join(source, 'install.sh'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  const summary = await packDirectory(source, join(root, 'archive.tar'))
  await extractArtifact(join(root, 'archive.tar'), join(root, 'out'), summary)
  await absent(marker)
  assert.equal((await lstat(join(root, 'out/install.sh'))).mode & 0o777, 0o644)
})
