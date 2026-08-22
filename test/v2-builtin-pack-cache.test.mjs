/**
 * Builtin pack cache invalidation + mtime staleness (audit gap #6 runtime
 * half): `builtinLegacyPack()` is keyed per pack dir with an mtime
 * fingerprint, `invalidateBuiltinLegacyPack()` drops the cache eagerly, and a
 * stable fingerprint returns the SAME object (identity preserved for compile
 * speed). Pack-first / loud-failure semantics are unchanged (covered by
 * test/v2-builtin-pack.test.mjs — this file only covers the cache behavior).
 *
 * All tests are hermetic: temp pack dirs (copies of the shipped builtin pack)
 * and explicit `utimes` bumps so mtime changes are deterministic regardless
 * of filesystem timestamp granularity.
 *
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  builtinLegacyPack,
  invalidateBuiltinLegacyPack,
} from '../lib/v2/index.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACK_DIR = join(REPO_ROOT, 'domain-packs/builtin-library')

/** Copy the shipped builtin pack into a fresh temp dir. */
async function tempPackDir(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  await cp(PACK_DIR, root, { recursive: true })
  return root
}

test('a stable pack dir mtime returns the same cached object (identity preserved)', () => {
  const first = builtinLegacyPack()
  const second = builtinLegacyPack()
  assert.equal(second, first, 'stable fingerprint must serve the cached object')
})

test('invalidateBuiltinLegacyPack() drops the cache; the next access rebuilds', () => {
  const first = builtinLegacyPack()
  invalidateBuiltinLegacyPack()
  const second = builtinLegacyPack()
  assert.notEqual(second, first, 'invalidation must force a rebuild')
  assert.equal(builtinLegacyPack(), second, 'post-invalidation access is cached again')
})

test('invalidateBuiltinLegacyPack(dir) drops only that dir entry', async () => {
  const rootA = await tempPackDir('builtin-cache-a-')
  const rootB = await tempPackDir('builtin-cache-b-')
  try {
    const a1 = builtinLegacyPack(rootA)
    const b1 = builtinLegacyPack(rootB)
    invalidateBuiltinLegacyPack(rootA)
    const a2 = builtinLegacyPack(rootA)
    const b2 = builtinLegacyPack(rootB)
    assert.notEqual(a2, a1, 'invalidated dir must rebuild')
    assert.equal(b2, b1, 'other dir entries stay cached')
  } finally {
    await rm(rootA, { recursive: true, force: true })
    await rm(rootB, { recursive: true, force: true })
  }
})

test('mtime staleness: touching pack.json rebuilds lazily on the next access', async () => {
  const root = await tempPackDir('builtin-mtime-')
  try {
    const first = builtinLegacyPack(root)
    // Deterministic mtime bump (explicit future timestamp).
    const future = new Date(Date.now() + 60_000)
    await utimes(join(root, 'pack.json'), future, future)
    const rebuilt = builtinLegacyPack(root)
    assert.notEqual(rebuilt, first, 'changed mtime must trigger a lazy rebuild')
    const settled = builtinLegacyPack(root)
    assert.equal(settled, rebuilt, 'after the rebuild the new object is cached again')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mtime staleness: touching generated/pack.sha256 also rebuilds', async () => {
  const root = await tempPackDir('builtin-mtime-sha-')
  try {
    const first = builtinLegacyPack(root)
    const future = new Date(Date.now() + 120_000)
    await utimes(join(root, 'generated', 'pack.sha256'), future, future)
    assert.notEqual(builtinLegacyPack(root), first, 'pack.sha256 mtime is part of the fingerprint')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a missing pack dir stays a loud failure after invalidation (no silent fallback)', async () => {
  const missing = join(tmpdir(), `builtin-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  assert.throws(
    () => builtinLegacyPack(missing),
    (error) => {
      assert.match(error.message, /could not be loaded/)
      assert.match(error.message, /pnpm build:builtin/)
      return true
    },
  )
  // The loud failure is not cached — a subsequent access fails the same way.
  assert.throws(() => builtinLegacyPack(missing))
})
