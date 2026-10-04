import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const pack = fileURLToPath(new URL('../domain-packs/zhijian-realestate/', import.meta.url))
const digest = raw => createHash('sha256').update(raw).digest('hex')
const contentId = 'zhijian-report-craft', renderId = 'zhijian-designer-render'
const selections = [
  { packId: 'zhijian-realestate', skillId: contentId, reason: '需要报告内容工艺' },
  { packId: 'zhijian-realestate', skillId: renderId, variant: 'credit-policy', reason: '需要响应式HTML/PDF工艺' },
]

async function exported(t) {
  const temp = await mkdtemp(join(tmpdir(), 'zhijian-craft-export-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const root = join(temp, 'installed-domain-pack')
  await cp(pack, root, { recursive: true })
  return { temp, root }
}

async function invalidArtifacts(temp) {
  const rows = { md: '# Example\n\nNo accepted report evidence.\n', html: '<html><body><p>Incomplete</p></body></html>', pdf: '%PDF-invalid-fixture', evidence: '{}' }
  const artifacts = {}
  for (const [role, raw] of Object.entries(rows)) {
    const bytes = Buffer.from(raw)
    const file = join(temp, role === 'evidence' ? 'craft-evidence.json' : `report.${role}`)
    await writeFile(file, bytes)
    artifacts[role] = { id: role, sha256: digest(bytes), content: bytes.toString(role === 'pdf' ? 'base64' : 'utf8'), encoding: role === 'pdf' ? 'base64' : 'utf8' }
  }
  return artifacts
}

test('the real-estate pack owns both independently declared skills and both reference sources', async () => {
  const metadata = JSON.parse(await readFile(join(pack, 'pack.json'), 'utf8'))
  assert.equal(metadata.id, 'zhijian-realestate')
  const write = JSON.parse(await readFile(join(pack, 'craft', `${contentId}.json`), 'utf8'))
  const render = JSON.parse(await readFile(join(pack, 'craft', `${renderId}.json`), 'utf8'))
  assert.deepEqual(render.requires, [contentId])
  assert.deepEqual(Object.keys(render.variants).sort(), ['credit-policy', 'designer-paper'])
  const ids = [...write.checks, ...render.checks].flatMap(row => row.resultIds)
  assert.equal(ids.length, 8)
  assert.equal(new Set(ids).size, 8)
  assert.equal(digest(await readFile(join(pack, 'references/zhijian-credit-policy-v1.html'))), 'd145f887cfd918dfa7e021029feb109211871fd8adfeddfd2715060b148f5f86')
  assert.equal(digest(await readFile(join(pack, 'references/zhijian-designer-v1.html'))), 'b25f9db892c52a78555f4016ad534714216ba2dd80c2966a40d0498106c3d408')
})

test('an exported pack executes its own checks without plugin lib or global knowledge/skills', async t => {
  const { temp, root } = await exported(t)
  const artifacts = await invalidArtifacts(temp)
  for (const id of [contentId, renderId]) {
    const declaration = JSON.parse(await readFile(join(root, 'craft', `${id}.json`), 'utf8'))
    const check = declaration.checks[0]
    const child = spawnSync(process.execPath, [join(root, check.entrypoint)], {
      cwd: root, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024,
      input: JSON.stringify({ protocolVersion: 1, selections, resultIds: check.resultIds, artifacts, host: {} }),
    })
    assert.equal(child.status, 0, child.stderr)
    const results = JSON.parse(child.stdout)
    assert.deepEqual(results.map(row => row.id), check.resultIds)
    assert.ok(results.every(row => ['failed', 'unverified'].includes(row.status)), 'invalid fixtures must never pass')
  }
})

test('pack-local preflight rejects invalid bytes and never produces an approval receipt', async t => {
  const { temp, root } = await exported(t)
  const artifacts = await invalidArtifacts(temp)
  const selectionFile = join(temp, 'selections.json')
  await writeFile(selectionFile, JSON.stringify(selections))
  const args = [join(root, 'scripts/preflight-report.mjs'), '--md', join(temp, 'report.md'), '--html', join(temp, 'report.html'), '--pdf', join(temp, 'report.pdf'), '--ledger', join(temp, 'craft-evidence.json'), '--selections', selectionFile]
  const child = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024 })
  assert.equal(child.status, 1, child.stderr)
  const report = JSON.parse(child.stdout)
  assert.equal(report.results.length, 8)
  assert.equal(report.hostReceipt, false)
  assert.equal(report.qualityApproved, false)
  assert.equal(report.inputFilesUnchanged, true)
  for (const row of report.artifacts) assert.equal(row.sha256, artifacts[row.role].sha256)
  await writeFile(selectionFile, JSON.stringify([selections[1]]))
  const dependencyFailure = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 5000 })
  assert.equal(dependencyFailure.status, 2)
  assert.match(JSON.parse(dependencyFailure.stdout).error, /explicitly selected/)
})

test('both installed render variants deliver complete bounded materials to every role', async t => {
  const { root } = await exported(t)
  const { resolveSelectedSkillContract, resolveSelectedSkillMaterials } = await import('../lib/skill-craft.js')
  // A real discovery root, including the copied package and ordinary path overhead.
  const { cp: copy, mkdir } = await import('node:fs/promises')
  const workspace = join(root, '..', 'workspace')
  await mkdir(join(workspace, 'domain-packs'), { recursive: true })
  await copy(root, join(workspace, 'domain-packs', 'zhijian-realestate'), { recursive: true })
  for (const variant of ['credit-policy', 'designer-paper']) {
    const choice = selections.map(s => s.skillId === renderId ? { ...s, variant } : s)
    const contract = await resolveSelectedSkillContract({}, { packsDir: 'domain-packs', enabledPacks: ['zhijian-realestate'] }, workspace, choice)
    for (const role of ['writer', 'renderer', 'reviewer']) {
      const bundle = resolveSelectedSkillMaterials(contract, role)
      assert.equal(bundle.bytes, Buffer.byteLength(bundle.content))
      assert.ok(bundle.bytes <= 24 * 1024)
      for (const entry of bundle.entries) assert.ok(bundle.content.includes(entry.content), 'full material included, never truncated')
      t.diagnostic(JSON.stringify({ variant, role, bytes: bundle.bytes }))
    }
  }
})
