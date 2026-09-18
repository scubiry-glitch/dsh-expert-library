/**
 * Supply-chain tests for the vendored-pack onboarding pipeline.
 *
 * The load-bearing cases are the refusals: a secret riding along in pack
 * content, an id that would shadow an installed pack, a declared dependency
 * nothing resolves, and an install that would clobber locally-modified
 * content. Fetching is exercised against a **local** git repository, so the
 * whole pipeline runs without network.
 *
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  fetchPackSource,
  installStagedPack,
  isAllowlistedLocator,
  locatorHost,
  validateStagedPack,
} from '../lib/host/pack-source.js'
import {
  emptyRegistry,
  findEntry,
  parseRegistry,
  readRegistry,
  removeEntry,
  upsertEntry,
  writeRegistry,
} from '../lib/host/pack-registry.js'
import { hashPackageTree } from '../lib/v2/pack-loader.js'

/** A scratch dir removed when the test ends. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pack-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Write a minimal valid pack (pack.json only) under `root`. */
function writePack(root, { id = 'partner-pack', extra = {} } = {}) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'pack.json'), JSON.stringify({
    id, version: '1.0.0', schemaVersion: 2, name: id, ...extra,
  }, null, 2))
  return root
}

/** Initialise a git repo at `root` and commit everything. */
function commitAll(root, message = 'fixture') {
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'user.name', 'fixture')
  git('add', '-A')
  git('commit', '-q', '-m', message)
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: 'pipe' }).toString().trim()
}

// ── 1. Locator parsing and the host allowlist ───────────────────────────────

test('locatorHost reads https, ssh, scp-shorthand, userinfo and ports', () => {
  assert.equal(locatorHost('https://github.com/acme/pack.git'), 'github.com')
  assert.equal(locatorHost('https://user:tok@gitlab.example.com:8443/a/b.git'), 'gitlab.example.com')
  assert.equal(locatorHost('ssh://git@git.example.com/acme/pack.git'), 'git.example.com')
  assert.equal(locatorHost('git@git.example.com:acme/pack.git'), 'git.example.com')
  assert.equal(locatorHost('  https://Example.COM/a  '), 'example.com')
  assert.equal(locatorHost('not a locator'), undefined)
})

test('isAllowlistedLocator only admits listed hosts, and nothing when empty', () => {
  const allow = ['git.example.com']
  assert.equal(isAllowlistedLocator('https://git.example.com/a/b.git', allow), true)
  assert.equal(isAllowlistedLocator('https://evil.example.net/a/b.git', allow), false)
  assert.equal(isAllowlistedLocator('https://git.example.com/a/b.git', []), false)
  // A suffix must not be mistaken for the host itself.
  assert.equal(isAllowlistedLocator('https://git.example.com.evil.net/a.git', allow), false)
})

test('an empty or whitespace locator is refused before any process is spawned', async (t) => {
  const dir = scratch(t)
  for (const locator of ['', '   ', 'has space']) {
    const outcome = await fetchPackSource({ locator, into: join(dir, 'out') })
    assert.equal(outcome.ok, false)
  }
})

// ── 2. Fetch against a local repository ─────────────────────────────────────

test('fetchPackSource clones a local repo and resolves a 40-hex revision', async (t) => {
  const dir = scratch(t)
  const origin = writePack(join(dir, 'origin'))
  const expected = commitAll(origin)
  const into = join(dir, 'clone')

  const outcome = await fetchPackSource({ locator: origin, into })
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error)
  assert.equal(outcome.revision, expected)
  // Only the content tree survives — nothing for the runtime to read back.
  assert.equal(existsSync(join(into, '.git')), false)
  assert.equal(existsSync(join(into, 'pack.json')), true)
})

test('fetchPackSource pins to a tag when one is requested', async (t) => {
  const dir = scratch(t)
  const origin = writePack(join(dir, 'origin'))
  commitAll(origin)
  execFileSync('git', ['tag', 'v1.0.0'], { cwd: origin, stdio: 'pipe' })
  writeFileSync(join(origin, 'extra.md'), '# later\n')
  const tagged = commitAll(origin, 'second')

  const into = join(dir, 'clone')
  const outcome = await fetchPackSource({ locator: origin, ref: 'v1.0.0', into })
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error)
  assert.notEqual(outcome.revision, tagged, 'the requested tag must not resolve to a later commit')
})

test('fetchPackSource reports a bad ref instead of throwing', async (t) => {
  const dir = scratch(t)
  const origin = writePack(join(dir, 'origin'))
  commitAll(origin)
  const outcome = await fetchPackSource({ locator: origin, ref: 'no-such-ref', into: join(dir, 'clone') })
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /clone failed/)
})

// ── 3. Validation refusals ──────────────────────────────────────────────────

test('a valid staged pack validates and yields section counts and a digest', async (t) => {
  const dir = scratch(t)
  const staged = writePack(join(dir, 'pack'))
  const result = await validateStagedPack(staged)
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
  assert.equal(result.packId, 'partner-pack')
  assert.equal(result.entityCounts.experts, 0)
  assert.match(result.digest, /^[0-9a-f]{64}$/)
})

test('an id that would shadow an installed pack is refused', async (t) => {
  const dir = scratch(t)
  const staged = writePack(join(dir, 'pack'))
  const result = await validateStagedPack(staged, ['partner-pack'])
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(d => d.code === 'pack-id-collision'))
})

test('a declared dependency that nothing resolves is refused', async (t) => {
  const dir = scratch(t)
  const staged = writePack(join(dir, 'pack'), { extra: { dependsOn: ['missing-pack'] } })
  const result = await validateStagedPack(staged, [])
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(d => d.code === 'pack-dependency-missing'))
})

test('credentials or internal endpoints in pack content are refused', async (t) => {
  const dir = scratch(t)
  for (const [label, content] of [
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\n'],
    ['cloud key id', 'AKIAIOSFODNN7EXAMPLE\n'],
    ['internal endpoint', 'http://10.20.30.40:8080/api\n'],
  ]) {
    const root = writePack(join(dir, label.replace(/\s+/g, '-')))
    writeFileSync(join(root, 'notes.md'), content)
    const result = await validateStagedPack(root)
    assert.equal(result.ok, false, `${label} must be refused`)
    assert.ok(result.diagnostics.some(d => d.code === 'pack-secret-scan'), `${label} must report pack-secret-scan`)
  }
})

test('a structurally broken pack is refused', async (t) => {
  const dir = scratch(t)
  const root = join(dir, 'broken')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'pack.json'), '{ "id": "x" }')
  const result = await validateStagedPack(root)
  assert.equal(result.ok, false)
})

// ── 4. Install and the drift gate ───────────────────────────────────────────

test('install swaps the pack in and the result hashes clean', async (t) => {
  const dir = scratch(t)
  const vendor = join(dir, 'vendor')
  const staged = writePack(join(dir, 'staged'))

  const result = await installStagedPack(staged, vendor, 'partner-pack')
  assert.equal(result.ok, true, result.ok ? '' : result.error)
  assert.equal(existsSync(join(vendor, 'partner-pack', 'pack.json')), true)
  assert.equal(result.digest, await hashPackageTree(join(vendor, 'partner-pack'), { exclude: ['generated/'] }))
  // No staging leftovers.
  assert.deepEqual(
    execFileSync('ls', [vendor]).toString().trim().split('\n').filter(n => n.includes('staging')),
    [],
  )
})

test('install refuses to clobber a pack whose content has drifted', async (t) => {
  const dir = scratch(t)
  const vendor = join(dir, 'vendor')
  const installed = writePack(join(vendor, 'partner-pack'))
  // A reference digest that no longer matches the tree = local modification.
  mkdirSync(join(installed, 'generated'), { recursive: true })
  writeFileSync(join(installed, 'generated', 'pack.sha256'), `${'0'.repeat(64)}\n`)

  const staged = writePack(join(dir, 'staged'))
  const result = await installStagedPack(staged, vendor, 'partner-pack')
  assert.equal(result.ok, false)
  assert.match(result.error, /drift=dirty/)
  // The installed copy is untouched.
  assert.equal(existsSync(join(vendor, 'partner-pack', 'pack.json')), true)
})

test('install rejects an unsafe pack id', async (t) => {
  const dir = scratch(t)
  const staged = writePack(join(dir, 'staged'))
  for (const id of ['../escape', 'a/b', '', '.hidden']) {
    const result = await installStagedPack(staged, join(dir, 'vendor'), id)
    assert.equal(result.ok, false, `id ${JSON.stringify(id)} must be refused`)
  }
})

// ── 5. Ledger ───────────────────────────────────────────────────────────────

test('a malformed or unknown-version ledger reads as empty rather than throwing', () => {
  assert.deepEqual(parseRegistry(null), emptyRegistry())
  assert.deepEqual(parseRegistry('nonsense'), emptyRegistry())
  assert.deepEqual(parseRegistry({ schemaVersion: 99, packs: [{}] }), emptyRegistry())
  // An entry missing required fields is dropped, valid siblings survive.
  const mixed = parseRegistry({
    schemaVersion: 1,
    packs: [
      { id: 'a', locator: 'l', revision: 'r', digest: 'd', trust: 'reviewed', installedAt: 'i' },
      { id: 'b' },
      { id: 'c', locator: 'l', revision: 'r', digest: 'd', trust: 'not-a-tier', installedAt: 'i' },
    ],
  })
  assert.deepEqual(mixed.packs.map(p => p.id), ['a'])
})

test('upsert carries the replaced revision forward as the rollback anchor', () => {
  let registry = emptyRegistry()
  registry = upsertEntry(registry, {
    id: 'p', locator: 'l', revision: 'r1', digest: 'd1', trust: 'reviewed', installedAt: 't1',
  })
  assert.equal(findEntry(registry, 'p').previous, undefined, 'a first install has no anchor')

  registry = upsertEntry(registry, {
    id: 'p', locator: 'l', revision: 'r2', digest: 'd2', trust: 'reviewed', installedAt: 't2',
  })
  assert.equal(registry.packs.length, 1)
  assert.deepEqual(findEntry(registry, 'p').previous, { revision: 'r1', digest: 'd1', installedAt: 't1' })

  registry = removeEntry(registry, 'p')
  assert.deepEqual(registry.packs, [])
})

test('the ledger round-trips through an atomic write', async (t) => {
  const vendor = scratch(t)
  assert.deepEqual(await readRegistry(vendor), emptyRegistry(), 'a missing ledger reads as empty')

  const registry = upsertEntry(emptyRegistry(), {
    id: 'p', locator: 'l', revision: 'r', digest: 'd', trust: 'community', installedAt: 't',
  })
  await writeRegistry(vendor, registry)
  assert.deepEqual(await readRegistry(vendor), registry)
  assert.equal(existsSync(join(vendor, 'registry.json.tmp')), false)
})
