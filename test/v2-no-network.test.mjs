/**
 * Source-level "no network" guarantee for the V2 loader surface, plus the
 * audit-only `upstreamProvenance` behavior (NEXT-GENERATION-ARCHITECTURE.md
 * §3.7 / §11 Phase 1).
 *
 * Hard rule: SkillPackage loading is LOCAL ONLY — the loader must never
 * perform network access, and a manifest's `upstreamProvenance` is a pure
 * audit string the runtime never contacts. These tests enforce that at the
 * source level (scanning the built `lib/` output for network APIs and import
 * specifiers) and behaviorally (a package with a provenance URL still loads
 * locally and verifies cleanly). Runs against the built `lib/` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  loadSkillPackageFromDir,
  canonicalSkillDigest,
  sha256Of,
  DEFAULT_SKILL_MANIFEST_NAMES,
} from '../lib/v2/index.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ── 1. Source-level guarantee: no network APIs in the loader surface ─────────

/** Files whose import surface must be network-free (the §3.7 loader chain). */
const NETWORK_FREE_MODULES = [
  'lib/v2/pack-loader.js',
  'lib/v2/validate.js',
  'lib/v2/types.js',
  'lib/knowledge.js',
]

const NETWORK_PATTERNS = [
  [/\bfetch\s*\(/, 'must not call fetch()'],
  [/\bhttps?:\/\//, 'must not contain remote endpoint URLs'],
  [/node:(https?|net|dns|tls|http2|undici)\b/, 'must not import Node network modules'],
  [/\bWebSocket\b/, 'must not use WebSocket'],
  [/\bXMLHttpRequest\b/, 'must not use XMLHttpRequest'],
  // NOTE: 'got' is deliberately NOT in this list — it is an ordinary English
  // word in validator messages ("must be X, got Y"). Only unambiguous client
  // library names are checked.
  [/\b(axios|superagent|node-fetch|undici)\b/, 'must not import HTTP client libraries'],
]

test('V2 loader modules contain no network APIs (source-level)', async () => {
  for (const rel of NETWORK_FREE_MODULES) {
    const source = await readFile(join(repoRoot, rel), 'utf8')
    for (const [pattern, message] of NETWORK_PATTERNS) {
      assert.equal(pattern.test(source), false, `${rel} ${message}`)
    }
  }
})

test('pack-loader imports only builtins and local modules (no remote specifiers)', async () => {
  const source = await readFile(join(repoRoot, 'lib/v2/pack-loader.js'), 'utf8')
  // Only actual `import ... from '...'` statements count — plain strings like
  // `loaded from "${dirReal}"` inside template literals must not match.
  const specifiers = source
    .split('\n')
    .filter(line => line.trimStart().startsWith('import'))
    .flatMap(line => [...line.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]))
  assert.ok(specifiers.length > 0, 'pack-loader must import something')
  for (const specifier of specifiers) {
    const local = specifier.startsWith('.') || specifier.startsWith('/')
    const builtin = specifier.startsWith('node:')
    assert.ok(local || builtin, `pack-loader import "${specifier}" is neither local nor a Node builtin`)
  }
})

test('no network-adjacent modules exist in the v2 loader chain', async () => {
  // Scoped to the §3.7 loader chain: URL *data* is legitimate elsewhere in
  // lib/v2 (e.g. builtin-gates style-lint phrase lists carry 'http://'
  // literals, provider manifests carry endpoint strings) — those are data,
  // not network APIs. The loader chain itself must stay network-free.
  const loaderChain = ['lib/v2/pack-loader.js', 'lib/v2/validate.js', 'lib/v2/types.js']
  for (const rel of loaderChain) {
    const source = await readFile(join(repoRoot, rel), 'utf8')
    for (const [pattern, message] of NETWORK_PATTERNS) {
      assert.equal(pattern.test(source), false, `${rel} ${message}`)
    }
  }
})

// ── 2. Behavioral: upstreamProvenance is audit-only, never contacted ─────────

async function writeSkillPackage(root, { license, upstream, internalOnly, extraFiles = {} }) {
  const files = { ...extraFiles, 'README.md': '# demo skill\nlocal content\n' }
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    const slash = rel.lastIndexOf('/')
    if (slash !== -1) await mkdir(file.slice(0, file.length - (rel.length - slash)), { recursive: true })
    await writeFile(file, content, 'utf8')
  }
  const manifestName = DEFAULT_SKILL_MANIFEST_NAMES[0]
  // Canonical package digest: content tree (excluding the manifest) + the
  // canonicalized manifest (source.digest omitted, keys sorted) — manifest
  // tampering (contributions/permissions/root) is detected too.
  const manifestBase = {
    schemaVersion: 2,
    id: 'demo-skill',
    version: '1.0.0',
    source: {
      kind: 'workspace',
      root: 'skills/demo-skill',
      ...(license !== undefined ? { license } : {}),
      ...(upstream !== undefined ? { upstreamProvenance: upstream } : {}),
    },
    contributions: {},
    permissions: { execScripts: [], ...(internalOnly !== undefined ? { internalOnly } : {}) },
  }
  const digest = await canonicalSkillDigest(root, manifestBase, { manifestName })
  const manifest = { ...manifestBase, source: { ...manifestBase.source, digest } }
  await writeFile(join(root, manifestName), JSON.stringify(manifest, null, 2), 'utf8')
  return root
}

test('upstreamProvenance is a pure audit string: package still loads and verifies locally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-no-net-'))
  try {
    await writeSkillPackage(root, {
      license: 'MIT',
      upstream: { repository: 'https://github.com/owner/demo-skill', revision: 'v1.0.0' },
      extraFiles: { 'references/guide.md': 'guide content' },
    })
    const result = await loadSkillPackageFromDir(root)
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
    assert.equal(result.manifest?.source.upstreamProvenance?.repository, 'https://github.com/owner/demo-skill')
    assert.equal(result.manifest?.source.upstreamProvenance?.revision, 'v1.0.0')
    assert.equal(result.manifest?.source.license, 'MIT')
    assert.equal(result.manifest?.permissions.internalOnly, undefined, 'licensed package keeps internalOnly unforced')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a digest mismatch is rejected even when the package declares a provenance URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-tamper-'))
  try {
    await writeSkillPackage(root, {
      license: 'MIT',
      upstream: { repository: 'https://example.com/audit-only', revision: 'abc123' },
    })
    // Tamper with a tracked file after the digest was computed.
    await writeFile(join(root, 'README.md'), '# tampered\n', 'utf8')
    const result = await loadSkillPackageFromDir(root)
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some(diag => diag.code === 'digest-mismatch'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a missing license forces internalOnly even when a provenance URL is present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-nolic-'))
  try {
    await writeSkillPackage(root, { upstream: { repository: 'https://example.com/no-license', revision: 'v1' } })
    const result = await loadSkillPackageFromDir(root)
    assert.equal(result.ok, true) // warning-level default, not a failure
    assert.equal(result.manifest?.permissions.internalOnly, true, 'unlicensed ⇒ internalOnly materialized')
    assert.ok(result.diagnostics.some(diag => diag.code === 'unlicensed-internal-only-default'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('lazy media entries are verified by bytes and sha256 (no network involved)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-lazy-'))
  try {
    const mediaContent = 'video-bytes'
    const sha256 = sha256Of(Buffer.from(mediaContent))
    await writeSkillPackage(root, {
      license: 'MIT',
      extraFiles: { 'media/sample.bin': mediaContent },
    })
    // Rewrite the manifest to add a lazyMedia entry with correct metadata.
    const manifestName = DEFAULT_SKILL_MANIFEST_NAMES[0]
    const manifest = JSON.parse(await readFile(join(root, manifestName), 'utf8'))
    manifest.lazyMedia = [{ path: 'media/sample.bin', bytes: mediaContent.length, sha256 }]
    // Digest must cover the tree (without the manifest) PLUS the canonicalized
    // manifest; source.digest is omitted from the manifest part.
    manifest.source.digest = await canonicalSkillDigest(root, manifest, { manifestName })
    await writeFile(join(root, manifestName), JSON.stringify(manifest, null, 2), 'utf8')

    const ok = await loadSkillPackageFromDir(root)
    assert.equal(ok.ok, true, JSON.stringify(ok.diagnostics))

    // Wrong byte count → size-mismatch diagnostic.
    manifest.lazyMedia = [{ path: 'media/sample.bin', bytes: 999, sha256 }]
    manifest.source.digest = await canonicalSkillDigest(root, manifest, { manifestName })
    await writeFile(join(root, manifestName), JSON.stringify(manifest, null, 2), 'utf8')
    const badSize = await loadSkillPackageFromDir(root)
    assert.ok(badSize.diagnostics.some(diag => diag.code === 'lazy-media-size-mismatch'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
