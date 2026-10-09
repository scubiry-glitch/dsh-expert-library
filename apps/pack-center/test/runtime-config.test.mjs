import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, symlink, link, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { allowedGitHosts, builtinPackVersions, developmentHttp, identityConfiguration, privateFile, scratchDirectory, trustedSigningKeys } from '../dist/runtime-config.js'

async function root(t) {
  const path = await mkdtemp(join(tmpdir(), 'pack-center-config-test-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
test('credential files are explicit, private, bounded regular files; no links or permissive files', async t => {
  const dir = await root(t), file = join(dir, 'ephemeral-test-key')
  const bytes = randomBytes(32)
  await writeFile(file, bytes, { mode: 0o600 })
  assert.deepEqual(await privateFile(file, 32), bytes)
  await assert.rejects(privateFile(file, 31))
  await chmod(file, 0o644); await assert.rejects(privateFile(file))
  await chmod(file, 0o600)
  await symlink(file, join(dir, 'symlink')); await assert.rejects(privateFile(join(dir, 'symlink')))
  await link(file, join(dir, 'hardlink')); await assert.rejects(privateFile(file))
  await assert.rejects(privateFile(dir)); await assert.rejects(privateFile('relative'))
})
test('Git host allowlist is exact, no wildcards/addresses/ports, and HTTP needs explicit development opt-in', () => {
  assert.deepEqual(allowedGitHosts({ PACK_CENTER_GIT_ALLOWED_HOSTS: 'github.com,git.example.test,github.com' }), ['github.com', 'git.example.test'])
  for (const value of ['', '*.github.com', 'github.com:443', '127.0.0.1', 'GITHUB.com', 'github.com,']) assert.throws(() => allowedGitHosts({ PACK_CENTER_GIT_ALLOWED_HOSTS: value }))
  assert.equal(developmentHttp({}), false)
  assert.equal(developmentHttp({ PACK_CENTER_ALLOW_LOOPBACK_HTTP: 'true' }), true)
  assert.throws(() => developmentHttp({ PACK_CENTER_ALLOW_LOOPBACK_HTTP: 'yes' }))
})
test('identity process uses a fixed callback and raw encryption key, never a signing key', async t => {
  const dir = await root(t), key = join(dir, 'ephemeral-login-key')
  await writeFile(key, randomBytes(32), { mode: 0o600 })
  const env = { PACK_CENTER_DATABASE_URL: 'postgresql://fixture:unused@127.0.0.1/test_only', PACK_CENTER_ID: 'test-center',
    PACK_CENTER_PUBLIC_ORIGIN: 'https://center.example.test', PACK_CENTER_LOGIN_KEY_FILE: key,
    PACK_CENTER_OIDC_ISSUER: 'https://identity.example.test/realm', PACK_CENTER_OIDC_CLIENT_ID: 'test-center' }
  const config = await identityConfiguration(env)
  assert.equal(config.oidc.redirectUri, 'https://center.example.test/api/auth/callback')
  assert.equal(config.oidc.allowLoopbackHttp, false)
  assert.equal(config.loginEncryptionKey.byteLength, 32)
  assert.equal(config.signingPrivateKey, undefined)
  await writeFile(key, 'too short'); await assert.rejects(identityConfiguration(env))
})
test('worker scratch is private; authoritative builtin inventory is explicit and strict', async t => {
  const dir = await root(t)
  assert.equal(await scratchDirectory({ PACK_CENTER_SCRATCH_ROOT: dir }), dir)
  await mkdir(join(dir, 'public'), { mode: 0o755 })
  await assert.rejects(scratchDirectory({ PACK_CENTER_SCRATCH_ROOT: join(dir, 'public') }))
  assert.deepEqual(builtinPackVersions({}), {})
  assert.deepEqual(builtinPackVersions({ PACK_CENTER_BUILTIN_VERSIONS: '{"builtin.demo":"1.0.0"}' }), { 'builtin.demo': '1.0.0' })
  for (const json of ['[]', 'null', '{"__proto__":"1.0.0"}', '{"builtin.demo":"latest"}']) assert.throws(() => builtinPackVersions({ PACK_CENTER_BUILTIN_VERSIONS: json }))
})
test('API verification inventory loads only explicit owned Ed25519 public keys, never publisher private keys', async t => {
  const dir = await root(t), path = join(dir, 'public-signing-keys.json')
  const env = { PACK_CENTER_TRUSTED_SIGNING_KEYS_FILE: path }
  const pair = generateKeyPairSync('ed25519'), publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  await writeFile(path, JSON.stringify({ 'fixture-key': publicPem }), { mode: 0o600 })
  const keys = await trustedSigningKeys(env)
  assert.equal(keys['fixture-key'], publicPem); assert.equal(Object.isFrozen(keys), true); assert.equal(Object.getPrototypeOf(keys), null)
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
  for (const value of [null, [], {}, { key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    { key: rsa }, { constructor: publicPem }, { 'bad..id': publicPem }, { key: 5 }, { key: `${publicPem}extra` }]) {
    await writeFile(path, JSON.stringify(value)); await assert.rejects(trustedSigningKeys(env))
  }
  await assert.rejects(trustedSigningKeys({}))
})
