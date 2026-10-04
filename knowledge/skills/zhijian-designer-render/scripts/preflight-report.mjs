#!/usr/bin/env node
/** Read-only local preflight using the installed Host checker. Never a quality receipt. */
import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))
const LIMITS = { md: 2 * 1024 * 1024, html: 2 * 1024 * 1024, pdf: 20 * 1024 * 1024, ledger: 256 * 1024 }
const FIELDS = ['md', 'html', 'pdf', 'ledger', 'style', 'material-pack-id', 'material-digest']
const USAGE = 'node preflight-report.mjs --md /absolute/report.md --html /absolute/report.html --pdf /absolute/report.pdf --ledger /absolute/craft-evidence.json --style credit-policy|designer-paper --material-pack-id zhijian-report-craft-v2 --material-digest <task-material-digest>\nExit 0: all seven machine checks passed for these bytes; 1: a machine check failed; 2: unverified, missing dependency, changed inputs, or invalid invocation. This local result is not a Host receipt, independent review, or delivery approval.'
const hash = raw => createHash('sha256').update(raw).digest('hex')
const need = (condition, message) => { if (!condition) throw new Error(message) }
const disclaimer = {
  kind: 'report-craft-local-preflight', schemaVersion: 1, authoritative: false,
  hostReceipt: false, independentReview: false, qualityApproved: false, requiresHostRecheck: true,
  writes: 'No report, ledger, team or session writes. The shared checker may retain PNGs in its controlled screenshot cache; JSON is written to stdout only.',
}

export function parsePreflightArgs(args) {
  const values = {}
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].startsWith('--') ? args[i].slice(2) : ''
    need(FIELDS.includes(name), `Unknown argument: ${args[i]}`)
    need(!(name in values), `Duplicate argument: --${name}`)
    need(typeof args[i + 1] === 'string' && args[i + 1] !== '' && !args[i + 1].startsWith('--'), `Missing value: --${name}`)
    values[name] = args[i + 1]
  }
  for (const name of FIELDS) need(name in values, `Required argument: --${name}`)
  for (const name of Object.keys(LIMITS)) need(isAbsolute(values[name]) && !values[name].includes('\0'), `--${name} must be an absolute file path`)
  need(['credit-policy', 'designer-paper'].includes(values.style), 'Unknown style')
  return values
}

async function snapshot(path, maxBytes) {
  const resolved = await realpath(path)
  const handle = await open(resolved, 'r')
  try {
    const before = await handle.stat()
    need(before.isFile() && before.size <= maxBytes, `Expected a regular file within ${maxBytes} bytes: ${path}`)
    const raw = await handle.readFile(), after = await handle.stat()
    need(raw.length <= maxBytes && raw.length === after.size && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `Input changed during reading: ${path}`)
    return { path: resolved, suppliedPath: path, raw, bytes: raw.length, sha256: hash(raw), fileIdentity: `${after.dev}:${after.ino}` }
  } finally { await handle.close() }
}

export async function runPreflight(args, signal) {
  const values = parsePreflightArgs(args)
  // Use this installed package's engine only. An exported standalone skill still
  // needs the packaged checker; never search old work folders or alternate code.
  const load = name => import(pathToFileURL(resolve(ROOT, 'lib', name)).href)
  let materials, checker, quality
  try { [materials, checker, quality] = await Promise.all([load('report-craft-materials.js'), load('report-craft-checker-v2.js'), load('quality-run.js')]) }
  catch { throw new Error('Installed checker unavailable. Run the packaged CLI under the absolute sourceRoot from the Host materials; no alternate checker is selected.') }
  const identity = { materialPackId: values['material-pack-id'], materialDigest: values['material-digest'], style: values.style }
  materials.validateCraftMaterialIdentity(identity)
  const inputs = []
  for (const [name, limit] of Object.entries(LIMITS)) inputs.push({ name, ...await snapshot(values[name], limit) })
  need(new Set(inputs.map(input => input.fileIdentity)).size === inputs.length, 'MD, HTML, PDF and ledger must be four distinct files')
  const idFor = name => `local-preflight:${name}`
  const artifacts = inputs.map(input => ({ id: idFor(input.name), taskId: 'local-preflight-only', attempt: 0, path: input.path, sha256: input.sha256, encoding: 'base64', content: input.raw.toString('base64') }))
  const check = { id: 'zhijian-report-craft-core-v2', md: idFor('md'), html: idFor('html'), pdf: idFor('pdf'), craftEvidence: idFor('ledger'), ...identity }
  const results = await checker.evaluateReportCraftV2(artifacts, check, { signal })
  need(results.length === quality.REPORT_CRAFT_V2_RESULT_IDS.length && results.every((result, index) => result.id === quality.REPORT_CRAFT_V2_RESULT_IDS[index] && ['passed', 'failed', 'unverified'].includes(result.status)), 'Installed checker returned an incomplete result set')
  let inputFilesUnchanged = true
  for (const input of inputs) {
    try {
      const current = await snapshot(input.suppliedPath, LIMITS[input.name])
      if (current.path !== input.path || current.fileIdentity !== input.fileIdentity || current.sha256 !== input.sha256) inputFilesUnchanged = false
    } catch { inputFilesUnchanged = false }
  }
  const status = !inputFilesUnchanged ? 'unverified' : results.some(result => result.status === 'failed') ? 'failed'
    : results.every(result => result.status === 'passed') ? 'passed' : 'unverified'
  return { ...disclaimer, status, checkerVersion: quality.REPORT_CRAFT_V2_CHECKER_VERSION,
    materialIdentity: identity, inspectedAt: new Date().toISOString(), inputFilesUnchanged,
    artifacts: inputs.map(({ name, path, bytes, sha256 }) => ({ name, path, bytes, sha256 })), results,
    summary: Object.fromEntries(['passed', 'failed', 'unverified'].map(status => [status, results.filter(result => result.status === status).length])),
    nextAction: status === 'passed' ? 'Publish the checked current bytes through the normal task protocol; Host rechecks and independent review remain required.'
      : 'Fix the listed findings or missing prerequisites, regenerate affected files and ledger hashes, then rerun this command before republishing. Use the current task attempt and remaining repair budget; this command does not reset either.' }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') { console.log(USAGE); return 0 }
  const controller = new AbortController(), abort = () => controller.abort()
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  let report
  try { report = await runPreflight(args, controller.signal) }
  catch (error) { report = { ...disclaimer, status: 'unverified', results: [], error: error instanceof Error ? error.message : String(error), nextAction: USAGE } }
  finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
  console.log(JSON.stringify(report, null, 2))
  return report.status === 'passed' ? 0 : report.status === 'failed' ? 1 : 2
}
const entrypoint = process.argv[1] ? await realpath(process.argv[1]).catch(() => resolve(process.argv[1])) : undefined
if (entrypoint === fileURLToPath(import.meta.url)) process.exitCode = await main()
