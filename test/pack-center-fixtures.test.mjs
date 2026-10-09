import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { loadPackFromDir, mergePackLayers, validateDomainPack } from '../lib/pack-validator.js'
import { loadPackFromDir as existingLoader } from '../lib/v2/pack-loader.js'
import { hashContentDirectory, hashContentTree, validateReport } from '../packages/pack-contract/index.mjs'

const fixture = name => fileURLToPath(new URL(`../examples/pack-center/${name}`, import.meta.url))

test('standalone validator is the existing implementation, not a fork', () => {
  assert.equal(loadPackFromDir, existingLoader)
})

test('both center samples contain real, valid, version-distinguishable scenario content', async () => {
  for (const [dir, version, label] of [['demo-v1', '1.0.0', '样例 V1'], ['demo-v2', '1.1.0', '样例 V2']]) {
    const loaded = await loadPackFromDir(fixture(dir))
    assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics))
    assert.equal(loaded.pack.pack.id, 'demo.review')
    assert.equal(loaded.pack.pack.version, version)
    assert.equal(loaded.pack.experts[0].display.publicLabel, label)
    assert.equal(loaded.pack.scenarios.length, 1)
    assert.equal(loaded.pack.teamTemplates.length, 1)
    assert.equal(loaded.pack.skillPackages.length, 0)
    assert.equal(validateDomainPack(loaded.pack).ok, true)
  }
})

test('invalid sample produces schema and identity diagnostics and no usable pack', async () => {
  const loaded = await loadPackFromDir(fixture('invalid'))
  assert.equal(loaded.ok, false)
  assert.equal(loaded.pack, undefined)
  const errors = new Set(loaded.diagnostics.filter(d => d.severity === 'error').map(d => d.code))
  assert.ok(errors.has('unsafe-id'))
  assert.ok(errors.has('schema-version-mismatch'))
})

test('sample overlay changes future selection without mutating the previous pack', async () => {
  const v1 = await loadPackFromDir(fixture('demo-v1'))
  const v2 = await loadPackFromDir(fixture('demo-v2'))
  const merged = mergePackLayers([
    { pack: v1.pack, layer: 'builtin', label: 'v1' },
    { pack: v2.pack, layer: 'workspace', label: 'v2' },
  ])
  assert.equal(merged.ok, true, JSON.stringify(merged.diagnostics))
  assert.equal(merged.pack.experts[0].display.publicLabel, '样例 V2')
  assert.equal(v1.pack.experts[0].display.publicLabel, '样例 V1')
})

test('filesystem and transport entries match the frozen fixture digest vectors', async () => {
  const vectors = JSON.parse(await readFile(new URL('../examples/pack-center/digest-vectors.json', import.meta.url), 'utf8'))
  for (const [name, expected] of Object.entries(vectors.fixtures)) {
    const tree = await hashContentDirectory(fixture(name))
    const { contentTreeSha256, fileCount, sizeBytes } = tree
    assert.deepEqual({ contentTreeSha256, fileCount, sizeBytes }, expected, name)
    const entries = await Promise.all(tree.files.map(async file => ({
      path: file.path,
      bytes: await readFile(`${fixture(name)}/${file.path}`),
    })))
    assert.equal(hashContentTree(entries.reverse()).contentTreeSha256, expected.contentTreeSha256)
    const changed = entries.map((file, index) => index === 0 ? { ...file, bytes: Buffer.concat([file.bytes, Buffer.from('\n')]) } : file)
    assert.notEqual(hashContentTree(changed).contentTreeSha256, expected.contentTreeSha256)
  }
})

test('existing loader diagnostics fit the shared report contract for success and failure', async () => {
  for (const name of ['demo-v1', 'demo-v2', 'invalid']) {
    const loaded = await loadPackFromDir(fixture(name))
    const report = {
      schemaVersion: 1,
      validatorVersion: '0.1.0',
      packSchemaVersion: 2,
      valid: loaded.ok,
      diagnostics: loaded.diagnostics,
      entityCounts: { experts: loaded.pack?.experts.length ?? 0, scenarios: loaded.pack?.scenarios.length ?? 0 },
    }
    const check = validateReport(report)
    assert.equal(check.ok, true, JSON.stringify(check.issues))
  }
})

test('standalone validation dependency graph imports no Harness or network runtime', async () => {
  const visited = new Set()
  async function inspect(url) {
    if (visited.has(url.href)) return
    visited.add(url.href)
    const source = await readFile(url, 'utf8')
    assert.doesNotMatch(source, /\b(?:fetch|require)\s*\(/, url.href)
    assert.doesNotMatch(source, /\bimport\s*\(/, url.href)
    for (const [, specifier] of source.matchAll(/(?:import|export)\s[^;]*?\bfrom\s*['"]([^'"]+)['"]/g)) {
      if (specifier.startsWith('node:')) {
        assert.ok(['node:fs', 'node:fs/promises', 'node:path', 'node:crypto'].includes(specifier), specifier)
      } else {
        assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), specifier)
        await inspect(new URL(specifier, url))
      }
    }
  }
  await inspect(new URL('../lib/pack-validator.js', import.meta.url))
  assert.ok(visited.size >= 4, 'the entry must be checked together with its local dependencies')
})
