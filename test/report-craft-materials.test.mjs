import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync, realpathSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
const sourceMode = process.env.CRAFT_MATERIAL_TEST_SOURCE === '1'
const { REPORT_CRAFT_PACK_ID, REPORT_CRAFT_MATERIAL_DIGEST, REPORT_CRAFT_MAX_ROLE_BYTES, resolveCraftMaterials, verifyCraftMaterials, isCraftMaterialIdentity, validateCraftMaterialIdentity } = await import(sourceMode ? '../src/report-craft-materials.ts' : '../lib/report-craft-materials.js')

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CRAFT = 'knowledge/skills/zhijian-report-craft'
const RENDER = 'knowledge/skills/zhijian-designer-render'
const MANIFEST = `${CRAFT}/materials.v2.json`
const hash = raw => createHash('sha256').update(raw).digest('hex')
const identity = { materialPackId: REPORT_CRAFT_PACK_ID, materialDigest: REPORT_CRAFT_MATERIAL_DIGEST, style: 'credit-policy' }
const bundle = root => resolveCraftMaterials({ style: 'credit-policy', role: 'renderer', root })
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'craft-material-test-'))
  for (const path of [CRAFT, RENDER]) cpSync(join(ROOT, path), join(root, path), { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function editManifest(root, fn) {
  const value = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')); fn(value)
  writeFileSync(join(root, MANIFEST), JSON.stringify(value))
}
function runPython(args, cwd = ROOT) {
  return spawnSync('python3', args, { cwd, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
}

for (const style of ['credit-policy', 'designer-paper']) for (const role of ['writer', 'renderer', 'reviewer']) {
  test(`${style}/${role}: full required material bodies, real paths, fixed identity and bounded injection`, () => {
    const result = resolveCraftMaterials({ style, role })
    assert.equal(result.materialDigest, REPORT_CRAFT_MATERIAL_DIGEST)
    assert.equal(result.sourceRoot, realpathSync(ROOT))
    assert.ok(result.content.includes(`Source root: ${result.sourceRoot}`))
    assert.equal(result.bytes, Buffer.byteLength(result.content))
    assert.ok(result.bytes <= REPORT_CRAFT_MAX_ROLE_BYTES)
    if (role === 'renderer') assert.ok(result.bytes <= REPORT_CRAFT_MAX_ROLE_BYTES - 512, 'retain 512 bytes of room for a longer installation path')
    assert.equal(result.entries.length, { writer: 7, renderer: 12, reviewer: 9 }[role])
    assert.equal(new Set(result.entries.map(item => item.id)).size, result.entries.length)
    for (const entry of result.entries) {
      const raw = readFileSync(join(result.sourceRoot, entry.path))
      assert.equal(entry.content, raw.toString('utf8')); assert.equal(entry.bytes, raw.length)
      assert.equal(entry.sha256, hash(raw)); assert.ok(result.content.includes(entry.content))
      assert.ok(!entry.path.endsWith('-v1.html'), 'historical business HTML not mandatory injection')
    }
    for (const name of ['core-v2.md', 'data-v2.md', 'acceptance-v2.md', 'evidence-ledger-v2.md', 'writing-v2.md', `style-${style}-v2.md`]) {
      assert.ok(result.entries.some(entry => entry.path.endsWith(`/references/${name}`)), name)
    }
    assert.doesNotMatch(result.content, /(?:1\.8%|2\.0%|2\.2%|11\.11%|9\.09%)/, 'no previous business answer injected')
    if (role === 'reviewer') {
      assert.match(result.content, /prepare_only/); assert.match(result.content, /independent_review/)
      for (const domain of ['chapter-substance', 'facts-and-uncertainty', 'calculations-and-coverage', 'visual-and-format']) assert.ok(result.content.includes(domain))
    }
  })
}

test('identity guard is strict and verifier confirms live package bytes', () => {
  assert.ok(isCraftMaterialIdentity(identity)); assert.deepEqual(validateCraftMaterialIdentity(identity), identity)
  assert.deepEqual(verifyCraftMaterials(identity), identity)
  for (const value of [null, {}, { ...identity, style: 'invented' }, { ...identity, materialDigest: '0'.repeat(64) }, { ...identity, materialPackId: 'old-pack' }]) {
    assert.equal(isCraftMaterialIdentity(value), false)
    assert.throws(() => validateCraftMaterialIdentity(value), /CRAFT_MATERIAL_IDENTITY_MISMATCH/)
  }
  assert.throws(() => resolveCraftMaterials({ style: 'credit-policy', role: 'author' }), /SELECTION_INVALID/)
  assert.throws(() => resolveCraftMaterials({ style: 'invented', role: 'writer' }), /SELECTION_INVALID/)
})
test('missing required document fails closed', t => {
  const root = fixture(t); rmSync(join(root, CRAFT, 'references/writing-v2.md'))
  assert.throws(() => bundle(root), /CRAFT_MATERIAL_MISSING/)
})
test('required file byte drift fails closed', t => {
  const root = fixture(t); writeFileSync(join(root, CRAFT, 'references/core-v2.md'), 'replaced')
  assert.throws(() => bundle(root), /CRAFT_MATERIAL_DRIFT/)
})
test('optional full reference drift also invalidates complete package identity', t => {
  const root = fixture(t); writeFileSync(join(root, CRAFT, 'references/zhijian-designer-v1.html'), '<html>changed</html>')
  assert.throws(() => bundle(root), /CRAFT_MATERIAL_DRIFT/)
})
test('generated render-copy drift cannot be silently trusted', t => {
  const root = fixture(t); writeFileSync(join(root, RENDER, 'assets/base-v2.css'), 'body{}')
  assert.throws(() => bundle(root), /CRAFT_MATERIAL_DRIFT/)
})
test('edited manifest is not adopted as authority', t => {
  const root = fixture(t); editManifest(root, value => { value.entries[0].sha256 = 'a'.repeat(64) })
  assert.throws(() => bundle(root), /CRAFT_MATERIAL_MANIFEST_DRIFT/)
})
for (const field of ['id', 'path']) test(`duplicate ${field} rejected before digest admission`, t => {
  const root = fixture(t); editManifest(root, value => { value.entries[1][field] = value.entries[0][field] })
  assert.throws(() => bundle(root), /CRAFT_MATERIAL_DUPLICATE/)
})
for (const path of ['../outside.md', '/etc/hosts', 'knowledge\\escape.md', 'knowledge//escape.md']) test(`escaping/ambiguous manifest path is rejected: ${path}`, t => {
  const root = fixture(t); editManifest(root, value => { value.entries[0].path = path })
  assert.throws(() => bundle(root), /CRAFT_MATERIAL_PATH_ESCAPE/)
})
test('external symlink fails before reading outside package', t => {
  const root = fixture(t); const path = join(root, CRAFT, 'references/core-v2.md')
  rmSync(path); symlinkSync('/etc/hosts', path)
  assert.throws(() => bundle(root), /CRAFT_MATERIAL_PATH_ESCAPE/)
})
test('even in-package symlink alias is rejected', t => {
  const root = fixture(t); const path = join(root, CRAFT, 'references/core-v2.md')
  rmSync(path); symlinkSync(join(root, CRAFT, 'references/writing-v2.md'), path)
  assert.throws(() => bundle(root), /CRAFT_MATERIAL_PATH_ALIAS/)
})
test('oversize required document rejects rather than truncating', t => {
  const root = fixture(t); writeFileSync(join(root, CRAFT, 'references/core-v2.md'), 'x'.repeat(REPORT_CRAFT_MAX_ROLE_BYTES + 1))
  assert.throws(() => bundle(root), /CRAFT_MATERIAL_BUDGET_EXCEEDED/)
})

test('build --check reproduces full manifest; standalone export verifies outside the package', t => {
  const parent = mkdtempSync(join(tmpdir(), 'craft-render-export-')); t.after(() => rmSync(parent, { recursive: true, force: true }))
  const output = join(parent, 'standalone-render')
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/build-report-craft-materials.mjs', '--export-render', output], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).materialDigest, REPORT_CRAFT_MATERIAL_DIGEST)
  const verify = () => runPython([join(output, 'scripts/verify_material_copy.py')], parent)
  const checked = verify(); assert.equal(checked.status, 0, checked.stdout)
  assert.equal(JSON.parse(checked.stdout).completeQualityApproved, false)
  const raw = JSON.parse(readFileSync(join(output, 'materials.generated.json'), 'utf8'))
  for (const entry of raw.entries) assert.ok(existsSync(join(output, entry.path)))
  writeFileSync(join(output, 'references/core-v2.md'), 'drift')
  assert.equal(verify().status, 1)
})
test('builder cannot regenerate around a missing required source', t => {
  const root = fixture(t); mkdirSync(join(root, 'src')); cpSync(join(ROOT, 'src/report-craft-materials.ts'), join(root, 'src/report-craft-materials.ts'))
  rmSync(join(root, CRAFT, 'references/writing-v2.md'))
  const result = spawnSync(process.execPath, ['--experimental-strip-types', join(root, CRAFT, 'scripts/build-materials.mjs'), '--write'], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /writing-v2.md/)
})
test('installed package validates through bundled builder and compiled module without src', t => {
  const root = fixture(t); mkdirSync(join(root, 'lib'))
  if (sourceMode) writeFileSync(join(root, 'lib/report-craft-materials.js'), stripTypeScriptTypes(readFileSync(join(ROOT, 'src/report-craft-materials.ts'), 'utf8')))
  else cpSync(join(ROOT, 'lib/report-craft-materials.js'), join(root, 'lib/report-craft-materials.js'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  const result = spawnSync(process.execPath, [join(root, CRAFT, 'scripts/build-materials.mjs'), '--check'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).materialDigest, REPORT_CRAFT_MATERIAL_DIGEST)
})
test('export refuses source-root children through ordinary and symlinked parent paths', t => {
  const root = fixture(t); mkdirSync(join(root, 'src')); cpSync(join(ROOT, 'src/report-craft-materials.ts'), join(root, 'src/report-craft-materials.ts'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  const outside = mkdtempSync(join(tmpdir(), 'craft-export-alias-')); t.after(() => rmSync(outside, { recursive: true, force: true }))
  symlinkSync(root, join(outside, 'source-alias'))
  for (const destination of [join(root, 'forbidden-copy'), join(outside, 'source-alias', 'forbidden-copy')]) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', join(root, CRAFT, 'scripts/build-materials.mjs'), '--export-render', destination], { encoding: 'utf8' })
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Export outside source package only/)
    assert.equal(existsSync(destination), false)
  }
})
test('mandatory document links resolve from their own directory in an isolated package', t => {
  const root = fixture(t)
  const paths = new Set([`${RENDER}/SKILL.md`, `${CRAFT}/SKILL.md`])
  for (const style of ['credit-policy', 'designer-paper']) for (const role of ['writer', 'renderer', 'reviewer']) {
    for (const entry of resolveCraftMaterials({ style, role, root }).entries) if (entry.path.endsWith('.md')) paths.add(entry.path)
  }
  for (const path of paths) for (const match of readFileSync(join(root, path), 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1]
    if (/^https?:|^#/.test(target)) continue
    assert.ok(existsSync(resolve(dirname(join(root, path)), target)), `${path} -> ${target}`)
  }
})

function preflight(t, html, options = []) {
  const root = mkdtempSync(join(tmpdir(), 'craft-preflight-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'report.html'); writeFileSync(path, html)
  const result = runPython([join(ROOT, RENDER, 'scripts/html_preflight.py'), path, '--min-chars', '10', ...options])
  return { ...result, report: JSON.parse(result.stdout) }
}
test('empty or invisible chapters cannot report partial precheck pass', t => {
  for (const html of ['<h1>Empty</h1>', '<section class="chapter"><p hidden>Enough hidden text for a misleading pass.</p></section>', '<section class="chapter" style="display:none">Enough hidden text.</section>']) {
    const result = preflight(t, html); assert.equal(result.status, 1); assert.equal(result.report.completeQualityApproved, false)
  }
})
test('real same-line figure elements are counted; comments and CSS are not', t => {
  const good = preflight(t, '<section class="chapter">Sufficient visible body text.<figure>A</figure><figure>B</figure></section>', ['--min-figures', '2'])
  assert.equal(good.status, 0); assert.equal(good.report.figureElements, 2); assert.equal(good.report.completeQualityApproved, false)
  const bad = preflight(t, '<style>/* figure figure */</style><!-- <figure>fake</figure> --><section class="chapter">Sufficient visible body text.</section>', ['--min-figures', '1'])
  assert.equal(bad.status, 1); assert.equal(bad.report.figureElements, 0)
})
test('process artifacts reject but ordinary version labels are not prohibited', t => {
  assert.equal(preflight(t, '<section class="chapter">Internal attempt_id leaked into business prose.</section>').status, 1)
  const clean = preflight(t, '<section class="chapter">Document version v2 and sufficient explanatory prose.</section>')
  assert.equal(clean.status, 0); assert.equal(clean.report.completeQualityApproved, false)
})

function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2]
}
for (const style of ['credit-policy', 'designer-paper']) test(`${style}: supplied normal-text color pairs satisfy numeric AA contrast`, () => {
  const css = readFileSync(join(ROOT, CRAFT, `references/components/${style}-v2.css`), 'utf8')
  const tokens = Object.fromEntries([...css.matchAll(/--([a-z-]+):(#[a-f0-9]{6})/g)].map(match => [match[1], match[2]]))
  const ratio = (a, b) => (Math.max(luminance(tokens[a]), luminance(tokens[b])) + .05) / (Math.min(luminance(tokens[a]), luminance(tokens[b])) + .05)
  for (const text of ['ink', 'muted', 'accent-text', 'warning-text']) for (const bg of ['paper', 'card', 'panel']) assert.ok(ratio(text, bg) >= 4.5, `${text}/${bg}`)
  assert.ok(ratio('on-accent', 'accent') >= 4.5)
})

test('source archives and preserved historical reference hashes are independently truthful', () => {
  const provenance = JSON.parse(readFileSync(join(ROOT, CRAFT, 'references/source-provenance-v2.json'), 'utf8'))
  assert.equal(provenance.sources.length, 2)
  for (const source of provenance.sources) {
    const archived = readFileSync(join(ROOT, CRAFT, source.archivePath)); const canonical = readFileSync(join(ROOT, CRAFT, source.canonicalPath))
    assert.equal(hash(archived), source.archiveSha256); assert.equal(hash(canonical), source.canonicalSha256)
    assert.equal(archived.length, source.archiveBytes); assert.equal(canonical.length, source.canonicalBytes)
    assert.equal(archived.equals(canonical), source.sameBytes); assert.equal(source.historicalContentIsTaskEvidence, false)
  }
})
