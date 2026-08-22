/**
 * Zhijian pack `skillPackages` inventory tests (audit gap "declared but not
 * served" — the pack becomes the inventory of record for the plugin's bundled
 * local skills).
 *
 * Covers: 10 bundled skill-package entities (finesse-ui, 8× GSAP, video-
 * shotcraft) with id/name/version/source-root convention; validator-clean
 * (fields checked by `validateDomainPack`); the real generated pack dir loads
 * with 10 entities; deterministic rebuild; and `--check` stays clean after
 * regeneration. All offline. Runs against the built `lib/` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { buildZhijianDomainPack, validateDomainPack, packFromJson, loadPackFromDir } from '../lib/v2/index.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The deterministic inventory order declared by the pack builder. */
const EXPECTED_SKILL_IDS = [
  'finesse-ui',
  'gsap-core',
  'gsap-frameworks',
  'gsap-performance',
  'gsap-plugins',
  'gsap-react',
  'gsap-scrolltrigger',
  'gsap-timeline',
  'gsap-utils',
  'video-shotcraft',
]

function build() {
  return buildZhijianDomainPack()
}

/* ---------------------------------------------------------------------------
 * Builder shape
 * ------------------------------------------------------------------------- */

test('zhijian pack carries 10 bundled skill-package entities with id/name/version', () => {
  const packages = build().skillPackages
  assert.equal(packages.length, 10)
  assert.deepEqual(packages.map(entity => entity.id), EXPECTED_SKILL_IDS)
  for (const entity of packages) {
    assert.equal(entity.name, entity.id, 'display name recorded for every entry')
    assert.equal(entity.schemaVersion, 2)
    assert.ok(entity.version.length > 0, 'version must be non-empty (validator requires it)')
  }
  // Known upstream version vs local baseline convention.
  assert.equal(packages.find(entity => entity.id === 'finesse-ui').version, '0.20.0')
  for (const entity of packages.filter(item => item.id !== 'finesse-ui')) {
    assert.equal(entity.version, '0.0.0-local', `${entity.id}: SKILL.md declares no version — local baseline`)
  }
})

test('every skill package declares local availability + the source-root convention, not content', () => {
  for (const entity of build().skillPackages) {
    assert.equal(entity.source.kind, 'builtin', 'bundled skills are builtin-local')
    assert.equal(entity.source.root, entity.id, 'source.root is the folder name under knowledge/skills/')
    assert.ok(entity.source.digest.length === 64, 'declaration digest is a sha256 hex')
    assert.deepEqual(entity.contributions, {}, 'availability declarations contribute no pack entities')
    assert.deepEqual(entity.permissions.execScripts, [], 'no exec scripts are declared')
  }
  // Licensed skills stay non-internal; the unlicensed one (video-shotcraft)
  // defaults to internalOnly per §3.7.
  for (const entity of build().skillPackages.filter(item => item.id !== 'video-shotcraft')) {
    assert.equal(entity.source.license, 'MIT')
    assert.notEqual(entity.permissions.internalOnly, true)
  }
  const video = build().skillPackages.find(entity => entity.id === 'video-shotcraft')
  assert.equal(video.source.license, undefined, 'video-shotcraft declares no license')
  assert.equal(video.permissions.internalOnly, true, 'unlicensed ⇒ outputs stay internal')
})

test('pack with skillPackages validates clean (in-memory and through the loader)', () => {
  const pack = build()
  const result = validateDomainPack(pack)
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics.filter(d => d.severity === 'error')))
  assert.equal(result.diagnostics.filter(d => d.severity === 'error').length, 0)
  const loaded = packFromJson(pack, { layer: 'domain-pack', label: 'test' })
  assert.equal(loaded.ok, true)
  assert.equal(loaded.pack?.skillPackages.length, 10)
})

test('two builds are byte-identical (deterministic inventory)', () => {
  assert.deepEqual(build().skillPackages, build().skillPackages)
})

/* ---------------------------------------------------------------------------
 * Generated pack dir
 * ------------------------------------------------------------------------- */

test('the generated domain-packs/zhijian-realestate loads with 10 skill packages', async () => {
  const loaded = await loadPackFromDir(join(REPO_ROOT, 'domain-packs', 'zhijian-realestate'))
  assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics.filter(d => d.severity === 'error')))
  assert.equal(loaded.pack?.skillPackages.length, 10)
  assert.deepEqual(loaded.pack?.skillPackages.map(entity => entity.id), EXPECTED_SKILL_IDS)
})

/* ---------------------------------------------------------------------------
 * Generator --check
 * ------------------------------------------------------------------------- */

test('scripts/build-zhijian-pack.mjs --check stays clean after regeneration', async () => {
  const result = await new Promise((resolve) => {
    execFile(process.execPath, [join(REPO_ROOT, 'scripts', 'build-zhijian-pack.mjs'), '--check'], { cwd: REPO_ROOT, timeout: 180_000 }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr })
    })
  })
  assert.equal(result.error, null, `--check failed: ${result.stderr || result.stdout}`)
  assert.match(result.stdout, /CHECK CLEAN/)
})
