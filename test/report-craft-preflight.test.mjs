import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { evaluateReportCraftV2, REPORT_CRAFT_V2_DEFAULT_BROWSER } from '../lib/report-craft-checker-v2.js'
import { REPORT_CRAFT_PACK_ID, REPORT_CRAFT_MATERIAL_DIGEST } from '../lib/report-craft-materials.js'
import { createCraftV2Fixture } from './support/report-craft-v2-fixture.mjs'
import { parsePreflightArgs } from '../knowledge/skills/zhijian-report-craft/scripts/preflight-report.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'knowledge/skills/zhijian-designer-render/scripts/preflight-report.mjs')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function prepared(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'craft-official-preflight-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fixture = createCraftV2Fixture(options)
  const names = { md: 'report.md', html: 'report.html', pdf: 'report.pdf', ledger: 'craft-evidence.json' }
  for (const [name, file] of Object.entries(names)) writeFileSync(join(root, file), name === 'ledger' ? fixture.craftEvidence : fixture[name])
  const args = Object.entries(names).flatMap(([name, file]) => ['--' + name, join(root, file)])
  args.push('--style', fixture.check.style, '--material-pack-id', REPORT_CRAFT_PACK_ID, '--material-digest', REPORT_CRAFT_MATERIAL_DIGEST)
  const artifacts = Object.entries(names).map(([name, file]) => {
    const raw = readFileSync(join(root, file))
    return { id: 'local-preflight:' + name, taskId: 'local-preflight-only', attempt: 0, path: join(root, file), sha256: sha(raw), encoding: 'base64', content: raw.toString('base64') }
  })
  const check = { ...fixture.check, md: 'local-preflight:md', html: 'local-preflight:html', pdf: 'local-preflight:pdf', craftEvidence: 'local-preflight:ledger', materialPackId: REPORT_CRAFT_PACK_ID, materialDigest: REPORT_CRAFT_MATERIAL_DIGEST }
  const snapshot = () => readdirSync(root).sort().map(name => ({ name, sha256: sha(readFileSync(join(root, name))), mtimeMs: statSync(join(root, name)).mtimeMs }))
  return { root, fixture, args, artifacts, check, snapshot }
}
function run(args) {
  const process = spawnSync(globalThis.process.execPath, [CLI, ...args], { cwd: tmpdir(), encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024 })
  assert.equal(process.error, undefined, process.error?.message)
  return { ...process, report: JSON.parse(process.stdout) }
}
function nonAuthoritative(report) {
  assert.equal(report.kind, 'report-craft-local-preflight')
  for (const name of ['authoritative', 'hostReceipt', 'independentReview', 'qualityApproved']) assert.equal(report[name], false)
  assert.equal(report.requiresHostRecheck, true)
  assert.equal('runId' in report, false); assert.equal('taskId' in report, false)
}

test('CLI rejects ambiguous flags, relative paths and material defaults rather than guessing', () => {
  assert.throws(() => parsePreflightArgs([]), /Required argument/)
  assert.throws(() => parsePreflightArgs(['--passed', 'true']), /Unknown argument/)
  assert.throws(() => parsePreflightArgs(['--md', '/a', '--md', '/b']), /Duplicate/)
  assert.throws(() => parsePreflightArgs(['--md', 'relative.md', '--html', '/h', '--pdf', '/p', '--ledger', '/l', '--style', 'credit-policy', '--material-pack-id', REPORT_CRAFT_PACK_ID, '--material-digest', REPORT_CRAFT_MATERIAL_DIGEST]), /absolute file path/)
  const invalid = run([]); assert.equal(invalid.status, 2); nonAuthoritative(invalid.report)
})
test('symlink entrypoint runs validation rather than silently exiting successfully', t => {
  const root = mkdtempSync(join(tmpdir(), 'craft-cli-symlink-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const link = join(root, 'preflight.mjs'); symlinkSync(CLI, link)
  const result = spawnSync(process.execPath, [link], { cwd: tmpdir(), encoding: 'utf8', timeout: 10000 })
  assert.equal(result.error, undefined); assert.equal(result.status, 2)
  const report = JSON.parse(result.stdout); nonAuthoritative(report); assert.match(report.error, /Required argument/)
})
test('standalone export is resource-complete but reports missing installed checker as unverified', t => {
  const root = mkdtempSync(join(tmpdir(), 'craft-cli-export-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const exported = join(root, 'render')
  const built = spawnSync(process.execPath, ['--experimental-strip-types', join(ROOT, 'scripts/build-report-craft-materials.mjs'), '--export-render', exported], { encoding: 'utf8', timeout: 10000 })
  assert.equal(built.status, 0, built.stderr)
  const args = ['--md', '/abs/report.md', '--html', '/abs/report.html', '--pdf', '/abs/report.pdf', '--ledger', '/abs/ledger.json', '--style', 'credit-policy', '--material-pack-id', REPORT_CRAFT_PACK_ID, '--material-digest', REPORT_CRAFT_MATERIAL_DIGEST]
  const result = spawnSync(process.execPath, [join(exported, 'scripts/preflight-report.mjs'), ...args], { cwd: tmpdir(), encoding: 'utf8', timeout: 10000 })
  assert.equal(result.error, undefined); assert.equal(result.status, 2)
  const report = JSON.parse(result.stdout); nonAuthoritative(report)
  assert.match(report.error, /Installed checker unavailable.*sourceRoot/); assert.deepEqual(report.results, [])
})
test('official CLI returns exactly the seven shared-checker results and never edits business inputs', { skip: !existsSync(REPORT_CRAFT_V2_DEFAULT_BROWSER) }, async t => {
  const f = prepared(t), before = f.snapshot()
  const result = run(f.args), direct = await evaluateReportCraftV2(f.artifacts, f.check)
  assert.equal(result.status, 0, JSON.stringify(result.report)); nonAuthoritative(result.report)
  assert.equal(result.report.results.length, 7); assert.equal(result.report.inputFilesUnchanged, true)
  assert.deepEqual(result.report.results, direct)
  assert.deepEqual(f.snapshot(), before, 'same file list, hashes and mtimes after both read-only checks')
})
test('a real arithmetic failure produces exit 1, exact findings and no business writes', async t => {
  const f = prepared(t, { wrongCalculation: true }), before = f.snapshot()
  const result = run(f.args), direct = await evaluateReportCraftV2(f.artifacts, f.check)
  assert.equal(result.status, 1, JSON.stringify(result.report)); nonAuthoritative(result.report)
  assert.equal(result.report.results.length, 7)
  assert.deepEqual(result.report.results, direct)
  assert.equal(result.report.results.find(row => row.id === 'report-craft-calculations').status, 'failed')
  assert.deepEqual(f.snapshot(), before)
})
test('wrong material identity fails before inspection and cannot yield a trusted receipt', t => {
  const f = prepared(t), before = f.snapshot(), args = [...f.args]
  args[args.indexOf('--material-digest') + 1] = 'a'.repeat(64)
  const result = run(args); assert.equal(result.status, 2); nonAuthoritative(result.report)
  assert.match(result.report.error, /IDENTITY_MISMATCH/); assert.deepEqual(result.report.results, [])
  assert.deepEqual(f.snapshot(), before)
})
test('missing input is unverified with exit 2 and no replacement file', t => {
  const f = prepared(t); rmSync(join(f.root, 'report.pdf')); const before = f.snapshot()
  const result = run(f.args); assert.equal(result.status, 2); nonAuthoritative(result.report)
  assert.match(result.report.error, /ENOENT/); assert.deepEqual(f.snapshot(), before)
})
test('concurrent external changes cannot produce a passing result for stale input snapshots', async t => {
  const f = prepared(t), untouched = ['report.html', 'report.pdf', 'craft-evidence.json'].map(name => [name, sha(readFileSync(join(f.root, name)))])
  const child = spawn(process.execPath, [CLI, ...f.args], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000, killSignal: 'SIGKILL' })
  let stdout = '', stderr = '', writes = 0
  child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  // This writer is test code acting on disposable fixtures, not the CLI. Keep
  // changing bytes until it closes so a snapshot cannot represent current work.
  const mutator = setInterval(() => { appendFileSync(join(f.root, 'report.md'), '\n'); writes++ }, 10)
  t.after(() => { clearInterval(mutator); if (child.exitCode === null) child.kill('SIGKILL') })
  let code
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }) }
  finally { clearInterval(mutator) }
  assert.ok(writes > 0); assert.equal(code, 2, stderr + stdout)
  const report = JSON.parse(stdout); nonAuthoritative(report)
  assert.ok(report.inputFilesUnchanged === false || /Input changed during reading/.test(report.error ?? ''), JSON.stringify(report))
  assert.deepEqual(untouched, untouched.map(([name]) => [name, sha(readFileSync(join(f.root, name)))]))
})
