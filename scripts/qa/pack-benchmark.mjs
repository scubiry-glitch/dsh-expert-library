#!/usr/bin/env node
// Runs a pack scenario ten times in independent sessions and scores evidence receipts.
// The adapter owns session creation, polling and artifact/gate collection; this tool
// verifies receipts and aggregates reliability. A fixture run is never a live score.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

function arg(name) { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const configPath = arg('--config') && resolve(arg('--config'))
const outDir = arg('--out') && resolve(arg('--out'))
if (!configPath || !outDir || existsSync(outDir)) {
  console.error('用法: node scripts/qa/pack-benchmark.mjs --config <JSON> --out <新目录>')
  process.exit(2)
}
const config = JSON.parse(readFileSync(configPath, 'utf8'))
if (!config.case?.id || !config.case?.prompt || !Array.isArray(config.case.requiredArtifacts)
  || !config.case.requiredArtifacts.length || !Array.isArray(config.case.requiredGates)
  || !config.case.requiredGates.length || !config.runner?.command || !Array.isArray(config.runner.args)) {
  throw Error('CONFIG_SCHEMA: case{id,prompt,requiredArtifacts[],requiredGates[]} + runner{command,args[]}')
}
if (config.runs !== undefined && config.runs !== 10) throw Error('本工具固定跑 10 次；runs 必须为 10')
mkdirSync(outDir, { recursive: false })
const caseFile = join(outDir, 'case.json')
writeFileSync(caseFile, JSON.stringify(config.case, null, 2) + '\n')
const bound = (n, max = 1) => Math.max(0, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : 0))
const ratio = (a, b) => Number(b) > 0 ? bound(Number(a) / Number(b)) : 0
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const maxRepairRounds = 2
const scores = [], seen = new Set()
for (let trial = 1; trial <= 10; trial++) {
  const runId = `${config.case.id}-${String(trial).padStart(2, '0')}`
  const receiptPath = join(outDir, `run-${String(trial).padStart(2, '0')}.json`)
  const substitutions = { '{runId}': runId, '{trial}': String(trial), '{caseFile}': caseFile, '{receipt}': receiptPath }
  const replace = s => Object.entries(substitutions).reduce((v, [k, x]) => v.replaceAll(k, x), s)
  const started = Date.now()
  const child = spawnSync(config.runner.command, config.runner.args.map(replace), {
    cwd: config.runner.cwd ? resolve(config.runner.cwd) : process.cwd(),
    timeout: Math.min(Math.max(Number(config.timeoutMs) || 1800000, 1000), 3600000),
    encoding: 'utf8', maxBuffer: 1024 * 1024,
  })
  let receipt = {}
  if (existsSync(receiptPath)) {
    try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) } catch { receipt = {} }
  }
  const failure = []
  if (child.status !== 0) failure.push(child.error?.code ?? `RUNNER_EXIT_${child.status}`)
  if (!receipt.sessionId || seen.has(receipt.sessionId)) failure.push('SESSION_NOT_UNIQUE')
  if (receipt.sessionId) seen.add(receipt.sessionId)
  if (receipt.mode !== 'live' && receipt.mode !== 'fixture') failure.push('MODE_MISSING')
  if (receipt.status !== 'completed') failure.push('INCOMPLETE')
  const artifacts = (Array.isArray(receipt.artifacts) ? receipt.artifacts : []).map(a => {
    const path = typeof a?.path === 'string' ? resolve(a.path) : null
    const valid = path && existsSync(path) && statSync(path).isFile() && statSync(path).size > 0
    return { kind: a.kind, valid: Boolean(valid), bytes: valid ? statSync(path).size : 0,
      sha256: valid ? sha256(path) : null }
  })
  const artifactsOk = config.case.requiredArtifacts.every(kind => artifacts.some(a => a.kind === kind && a.valid))
  if (!artifactsOk) failure.push('ARTIFACT_MISSING')
  const hardGates = Array.isArray(receipt.gates) ? receipt.gates : []
  const gateVerified = g => g?.pass === true && typeof g.evidencePath === 'string' && existsSync(resolve(g.evidencePath))
    && statSync(resolve(g.evidencePath)).isFile() && statSync(resolve(g.evidencePath)).size > 0
  const gatesOk = config.case.requiredGates.every(id => hardGates.some(g => g.id === id && g.hard === true && gateVerified(g)))
    && hardGates.filter(g => g.hard === true).every(g => gateVerified(g))
  if (!gatesOk) failure.push('HARD_GATE_FAILED_OR_MISSING')
  const data = receipt.dataChecks ?? {}, format = receipt.formatChecks ?? {}, task = receipt.taskChecks ?? {}
  if (Number(data.driftCount) > 0) failure.push('DATA_DRIFT')
  const repairRoundsValid = Number.isInteger(receipt.repairRounds) && receipt.repairRounds >= 0
  const repairRoundsOk = repairRoundsValid && receipt.repairRounds <= maxRepairRounds
  if (!repairRoundsValid) failure.push('REPAIR_ROUNDS_INVALID')
  else if (!repairRoundsOk) failure.push('REPAIR_LIMIT_EXCEEDED')
  const durationMs = receipt.startedAt && receipt.endedAt ? Date.parse(receipt.endedAt) - Date.parse(receipt.startedAt) : Date.now() - started
  const score = Math.round(
    (receipt.status === 'completed' ? 15 : 0) + (artifactsOk ? 10 : 0)
    + 20 * ratio(data.verifiedClaims, data.totalClaims)
    + (gatesOk ? 15 : 0) + (repairRoundsOk ? 5 : 0)
    + 15 * ratio(format.passed, format.total)
    + 10 * ratio(task.completed, task.total)
    + 10 * ratio(receipt.expertRubric?.score, 100)
  )
  if (score < 85) failure.push('SCORE_BELOW_85')
  scores.push({ trial, runId, sessionId: receipt.sessionId ?? null, mode: receipt.mode ?? null,
    score, pass: failure.length === 0, failure, durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null,
    repairRounds: receipt.repairRounds ?? null,
    artifacts, gateResults: hardGates.map(g => ({ id: g.id, hard: g.hard, pass: g.pass })),
    dataChecks: data, formatChecks: format, taskChecks: task, expertRubric: receipt.expertRubric ?? null })
  console.error(`${runId}: ${scores.at(-1).pass ? 'PASS' : 'FAIL'} ${score}/100`)
}
const sortedTimes = scores.map(x => x.durationMs).filter(x => x !== null).sort((a, b) => a - b)
const percentile = p => sortedTimes.length ? sortedTimes[Math.ceil(p * sortedTimes.length) - 1] : null
const live = scores.every(x => x.mode === 'live')
const report = { tool: 'partner-pack-benchmark', caseId: config.case.id, runs: 10,
  mode: live ? 'live' : 'non-live-or-mixed', passed: scores.filter(x => x.pass).length,
  meanScore: Math.round(scores.reduce((n, x) => n + x.score, 0) / 10 * 10) / 10,
  p50Ms: percentile(0.5), p95Ms: percentile(0.95),
  stableForRelease: live && scores.every(x => x.pass),
  acceptance: `10/10 独立真实会话完成、硬门禁全过、产物可读、修复轮次必须为 0–${maxRepairRounds} 的整数、单次 >=85 分，才视为稳定`,
  trials: scores }
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ caseId: report.caseId, mode: report.mode, passed: report.passed,
  meanScore: report.meanScore, p50Ms: report.p50Ms, p95Ms: report.p95Ms,
  stableForRelease: report.stableForRelease, summary: join(outDir, 'summary.json') }))
process.exit(report.stableForRelease ? 0 : 1)
