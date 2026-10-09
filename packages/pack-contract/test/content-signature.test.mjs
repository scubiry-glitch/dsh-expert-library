import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, symlink, link, chmod, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalJson, canonicalBytes, sha256, assertSafePath, hashContentTree, hashContentDirectory,
  manifestSigningBytes, signReleaseManifest, verifyReleaseManifest,
} from '../index.mjs'
import { manifest, dependency, errorCode } from './fixtures.mjs'

test('canonical JSON fixes UTF-8 key order, nested keys, ordered arrays and exact UTF-8 bytes', () => {
  // U+E000 precedes U+10000 by UTF-8 bytes, unlike JavaScript UTF-16 string sort.
  const value = { '\u{10000}': 'supplementary', '\ue000': 'bmp', z: { b: 2, a: 1 }, a: [true, null, '汉字\n"'] }
  const expected = '{"a":[true,null,"汉字\\n\\\""],"z":{"a":1,"b":2},"\ue000":"bmp","\u{10000}":"supplementary"}'
  assert.equal(canonicalJson(value), expected)
  assert.deepEqual(canonicalBytes(value), Buffer.from(expected, 'utf8'))
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }))
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]))
  assert.equal(canonicalJson(Object.assign(Object.create(null), { a: 1 })), '{"a":1}')
  const shared = { x: 1 }; assert.equal(canonicalJson([shared, shared]), '[{"x":1},{"x":1}]')
})

test('canonical JSON rejects ambiguous or non-JSON values, including array symbols', () => {
  const cyclic = {}; cyclic.self = cyclic
  const symbolKey = { [Symbol('secret')]: 1 }
  const hiddenKey = {}; Object.defineProperty(hiddenKey, 'secret', { value: 1 })
  const decorated = [1]; decorated.note = 'ignored'
  const arraySymbol = [1]; arraySymbol[Symbol('secret')] = 'ignored'
  const hiddenArray = [1]; Object.defineProperty(hiddenArray, 'secret', { value: 1 })
  for (const value of [undefined, NaN, Infinity, -Infinity, -0, 1.5, Number.MAX_SAFE_INTEGER + 1, 1n, () => {}, Symbol('x'), new Date(), new Set(), new Uint8Array([1]), cyclic, symbolKey, hiddenKey, [undefined], Array(1), decorated, arraySymbol, hiddenArray, '\ud800', '\udfff', { '\ud800': 'bad' }]) {
    assert.throws(() => canonicalJson(value), errorCode('INVALID_CONTRACT'))
  }
})

test('SHA-256 and normalized tree digest match fixed independent vectors and ignore entry input order', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  const entries = [{ path: '空.txt', bytes: Buffer.alloc(0) }, { path: 'a.txt', bytes: Buffer.from('abc') }]
  const expected = {
    contentTreeSha256: 'c67b2ff3694233cebc1436bf425bee124125151ed6b3d7c5e177ad5db50f6544', fileCount: 2, sizeBytes: 3,
    files: [
      { path: 'a.txt', sizeBytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
      { path: '空.txt', sizeBytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    ],
  }
  assert.deepEqual(hashContentTree(entries), expected)
  assert.deepEqual(hashContentTree([...entries].reverse()), expected)
  assert.equal(entries[0].path, '空.txt', 'Caller entries must not be sorted in place')
  assert.notEqual(hashContentTree([{ path: 'a.txt', bytes: Buffer.from('ab') }, { path: '空.txt', bytes: Buffer.from('c') }]).contentTreeSha256, expected.contentTreeSha256)
  assert.notEqual(hashContentTree([{ path: 'b.txt', bytes: Buffer.from('abc') }, entries[0]]).contentTreeSha256, expected.contentTreeSha256)
  assert.notEqual(hashContentTree([{ path: 'a.txt', bytes: Buffer.from('abc\n') }, entries[0]]).contentTreeSha256, expected.contentTreeSha256)
})

test('tree ordering is UTF-8 byte order and covers generated files without boundary collisions', () => {
  const files = hashContentTree(['\u{10000}.txt', '\ue000.txt', '汉字.txt', 'generated/result.json', 'a.txt'].map(path => ({ path, bytes: Buffer.from(path) }))).files
  assert.deepEqual(files.map(file => file.path), ['a.txt', 'generated/result.json', '汉字.txt', '\ue000.txt', '\u{10000}.txt'])
  const left = [{ path: 'a', bytes: Buffer.from('bc') }]
  const right = [{ path: 'ab', bytes: Buffer.from('c') }]
  assert.notEqual(hashContentTree(left).contentTreeSha256, hashContentTree(right).contentTreeSha256)
  assert.notEqual(hashContentTree([]).contentTreeSha256, hashContentTree([{ path: 'empty', bytes: Buffer.alloc(0) }]).contentTreeSha256)
})

test('unsafe, non-normalized and colliding paths are rejected before content hashing', () => {
  for (const path of ['', '/', '/abs/file', '../escape', 'a/../b', './a', 'a/./b', 'a//b', 'a/', 'C:/file', 'a\\b', 'a\0b', 'a\nb', 'a\u007fb', '.git/config', 'folder/.GIT/config', 'e\u0301.txt', '\ud800']) {
    assert.throws(() => assertSafePath(path), errorCode('INVALID_PATH'), JSON.stringify(path))
    assert.throws(() => hashContentTree([{ path, bytes: Buffer.from('x') }]), errorCode('INVALID_PATH'))
  }
  for (const path of ['pack.json', 'skills/é.txt', '生成/结果.md', '.github/workflows/check.yml']) assert.equal(assertSafePath(path), path)
  assert.throws(() => hashContentTree([{ path: 'a', bytes: Buffer.alloc(0) }, { path: 'a', bytes: Buffer.alloc(0) }]), errorCode('INVALID_PATH'))
  assert.throws(() => hashContentTree([{ path: 'a', bytes: Buffer.alloc(0) }, { path: 'a/b', bytes: Buffer.alloc(0) }]), errorCode('INVALID_PATH'))
  assert.throws(() => hashContentTree([{ path: 'a/b/c', bytes: Buffer.alloc(0) }, { path: 'a', bytes: Buffer.alloc(0) }]), errorCode('INVALID_PATH'))
  assert.throws(() => hashContentTree([{ path: 'a', bytes: 'not bytes' }]), errorCode('INVALID_CONTRACT'))
})

test('filesystem hashing matches transport entries, keeps generated content and ignores mode, time and empty dirs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pack-contract-tree-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'generated'))
  await mkdir(join(root, 'empty'))
  await writeFile(join(root, 'pack.json'), Buffer.from('{"schemaVersion":2}'))
  await writeFile(join(root, 'generated', 'report.bin'), Buffer.from([0, 1, 255]))
  const entries = [{ path: 'pack.json', bytes: Buffer.from('{"schemaVersion":2}') }, { path: 'generated/report.bin', bytes: Buffer.from([0, 1, 255]) }]
  const before = await hashContentDirectory(root)
  assert.deepEqual(before, hashContentTree(entries))
  await chmod(join(root, 'pack.json'), 0o600)
  await utimes(join(root, 'pack.json'), new Date(0), new Date(0))
  assert.deepEqual(await hashContentDirectory(root), before)
  await writeFile(join(root, 'generated', 'report.bin'), Buffer.from([0, 2, 255]))
  assert.notEqual((await hashContentDirectory(root)).contentTreeSha256, before.contentTreeSha256)
})

test('filesystem hashing rejects links, git metadata, linked roots and non-directory roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pack-contract-reject-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const clean = join(root, 'clean'); await mkdir(clean); await writeFile(join(clean, 'file.txt'), 'content')
  const linked = join(root, 'linked'); await symlink(clean, linked)
  await assert.rejects(hashContentDirectory(linked), errorCode('UNSUPPORTED_FILE'))
  await assert.rejects(hashContentDirectory(join(clean, 'file.txt')), errorCode('UNSUPPORTED_FILE'))
  const withSymlink = join(root, 'symlink'); await mkdir(withSymlink); await symlink(join(clean, 'file.txt'), join(withSymlink, 'alias'))
  await assert.rejects(hashContentDirectory(withSymlink), errorCode('UNSUPPORTED_FILE'))
  const withHardlink = join(root, 'hardlink'); await mkdir(withHardlink); await link(join(clean, 'file.txt'), join(withHardlink, 'alias'))
  await assert.rejects(hashContentDirectory(withHardlink), errorCode('UNSUPPORTED_FILE'))
  const withGit = join(root, 'git'); await mkdir(join(withGit, '.git'), { recursive: true }); await writeFile(join(withGit, '.git', 'config'), 'metadata')
  await assert.rejects(hashContentDirectory(withGit), errorCode('INVALID_PATH'))
})

test('Ed25519 signatures cover canonical manifest bytes and verify with pinned public keys', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const value = manifest()
  const envelope = signReleaseManifest(value, privateKey)
  assert.equal(Buffer.from(envelope.signature, 'base64').byteLength, 64)
  assert.deepEqual(manifestSigningBytes(value), canonicalBytes(value))
  assert.equal(sha256(manifestSigningBytes(value)), '8048b99e6e10b8a2dc4ec2eb07f2f998f8560b9cf87fe86d9aa0888571bace97', 'Frozen manifest signing-byte vector')
  assert.deepEqual(verifyReleaseManifest(envelope, new Map([['key-1', publicKey]])), value)
  assert.deepEqual(verifyReleaseManifest(envelope, { 'key-1': publicKey.export({ type: 'spki', format: 'pem' }) }), value)
  assert.deepEqual(signReleaseManifest(value, privateKey.export({ type: 'pkcs8', format: 'pem' })), envelope)
  assert.equal(sign(null, Buffer.from(canonicalJson(value)), privateKey).toString('base64'), envelope.signature)
  const reverseKeyOrder = Object.fromEntries(Object.entries(value).reverse())
  assert.deepEqual(verifyReleaseManifest({ ...envelope, manifest: reverseKeyOrder }, { 'key-1': publicKey }), reverseKeyOrder)
  // SHA wrapper is independently checked against the platform hash over the specified bytes.
  assert.equal(sha256(manifestSigningBytes(value)), createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'))
})

test('all identity, compatibility, dependency and digest changes invalidate a signed release', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const original = manifest()
  const envelope = signReleaseManifest(original, privateKey)
  const mutations = {
    centerId: 'other-center', releaseId: 'other-release', packId: 'org.other', ownerOrgId: 'other-org', version: '1.0.1',
    sourceCommit: 'e'.repeat(40), artifactSha256: 'e'.repeat(64), contentTreeSha256: 'e'.repeat(64), reportSha256: 'e'.repeat(64),
    validatorVersion: '1.0.1', requiresPlugin: { minVersion: '2.0.0' }, dependencyLock: [dependency()],
    builtinDependencies: [{ packId: 'builtin', minVersion: '1.0.0' }], sizeBytes: 2049, fileCount: 2,
    approvedSubmissionId: 'other-submission', signingKeyId: 'key-2',
  }
  for (const [key, value] of Object.entries(mutations)) {
    assert.throws(() => verifyReleaseManifest({ ...envelope, manifest: { ...original, [key]: value } }, { 'key-1': publicKey, 'key-2': publicKey }), errorCode('SIGNATURE_INVALID'), key)
  }
})

test('verification rejects unknown keys, wrong keys, extra envelope data and malformed signature encodings', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const envelope = signReleaseManifest(manifest(), privateKey)
  assert.throws(() => verifyReleaseManifest(envelope, {}), errorCode('UNKNOWN_SIGNING_KEY'))
  assert.throws(() => verifyReleaseManifest(envelope, Object.create({ 'key-1': publicKey })), errorCode('UNKNOWN_SIGNING_KEY'))
  assert.throws(() => verifyReleaseManifest(envelope, { 'key-1': generateKeyPairSync('ed25519').publicKey }), errorCode('SIGNATURE_INVALID'))
  for (const signature of ['', envelope.signature.slice(0, -2), `${envelope.signature}\n`, 'A'.repeat(88), Buffer.alloc(64).toString('base64'), null]) assert.throws(() => verifyReleaseManifest({ ...envelope, signature }, { 'key-1': publicKey }), errorCode('SIGNATURE_INVALID'))
  assert.throws(() => verifyReleaseManifest({ ...envelope, signingKey: publicKey }, { 'key-1': publicKey }), errorCode('INVALID_CONTRACT'))
  assert.throws(() => verifyReleaseManifest({ ...envelope, [Symbol('extra')]: true }, { 'key-1': publicKey }), errorCode('INVALID_CONTRACT'))
  assert.throws(() => verifyReleaseManifest({ signature: envelope.signature }, { 'key-1': publicKey }), errorCode('INVALID_CONTRACT'))
})

test('actual KeyObject algorithms are checked: a 64-byte RSA512 signature cannot impersonate Ed25519', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 512 })
  const value = manifest()
  // RSA512 signatures have the same byte count/base64 shape as Ed25519; encoding checks are insufficient.
  const forged = { manifest: value, signature: sign(null, manifestSigningBytes(value), rsa.privateKey).toString('base64') }
  assert.equal(Buffer.from(forged.signature, 'base64').length, 64)
  assert.throws(() => signReleaseManifest(value, rsa.privateKey), errorCode('UNSUPPORTED_ALGORITHM'))
  assert.throws(() => verifyReleaseManifest(forged, { 'key-1': rsa.publicKey }), errorCode('UNSUPPORTED_ALGORITHM'))
  assert.throws(() => verifyReleaseManifest(forged, { 'key-1': rsa.publicKey.export({ format: 'pem', type: 'spki' }) }), errorCode('UNSUPPORTED_ALGORITHM'))
  const ed = generateKeyPairSync('ed25519')
  assert.throws(() => signReleaseManifest(value, ed.publicKey), errorCode('UNSUPPORTED_ALGORITHM'))
  assert.throws(() => verifyReleaseManifest(signReleaseManifest(value, ed.privateKey), { 'key-1': ed.privateKey }), errorCode('UNSUPPORTED_ALGORITHM'))
})

test('unsupported algorithms and protocols are rejected before signing or verification', () => {
  const keys = generateKeyPairSync('ed25519')
  for (const overrides of [{ protocolVersion: 2 }, { schemaVersion: 2 }, { packSchemaVersion: 3 }, { normalizationVersion: 2 }, { digestAlgorithmVersion: 2 }, { signatureAlgorithm: 'Ed448' }, { archiveFormat: 'zip' }]) {
    const value = manifest(overrides)
    const expected = Object.keys(overrides).some(key => ['normalizationVersion', 'digestAlgorithmVersion', 'signatureAlgorithm', 'archiveFormat'].includes(key)) ? 'UNSUPPORTED_ALGORITHM' : 'UNSUPPORTED_PROTOCOL'
    assert.throws(() => manifestSigningBytes(value), errorCode(expected))
    assert.throws(() => signReleaseManifest(value, keys.privateKey), errorCode(expected))
    assert.throws(() => verifyReleaseManifest({ manifest: value, signature: 'A'.repeat(86) + '==' }, {}), errorCode(expected))
  }
})
