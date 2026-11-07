import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('ten isolated fixture runs verify aggregation without claiming live reliability', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-bench-'))
  const configPath = join(root, 'config.json'), out = join(root, 'results')
  writeFileSync(configPath, JSON.stringify({ runs: 10,
    case: { id: 'fixture-check', prompt: '验证计分器', requiredArtifacts: ['report'], requiredGates: ['data', 'format'] },
    runner: { command: process.execPath, args: [resolve('test/fixtures/pack-benchmark-runner.mjs'),
      '{caseFile}', '{receipt}', '{runId}'] } }))
  const run = spawnSync(process.execPath, ['scripts/qa/pack-benchmark.mjs', '--config', configPath, '--out', out], {
    cwd: resolve('.'), encoding: 'utf8' })
  assert.equal(run.status, 1, run.stderr)
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))
  assert.equal(summary.runs, 10)
  assert.equal(summary.passed, 10)
  assert.equal(summary.meanScore, 100)
  assert.equal(new Set(summary.trials.map(x => x.sessionId)).size, 10)
  assert.equal(summary.mode, 'non-live-or-mixed')
  assert.equal(summary.stableForRelease, false)
})

test('repair round limit is a hard gate even when every other check earns full marks', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-bench-repair-'))
  const configPath = join(root, 'config.json'), out = join(root, 'results')
  const cases = [
    { repairRounds: 0 }, { repairRounds: 2 }, { repairRounds: 3 },
    { repairRounds: -1 }, {}, { repairRounds: 1.5 },
    { repairRounds: '2' }, { repairRounds: null }, { repairRounds: 1 }, { repairRounds: 4 },
  ]
  writeFileSync(configPath, JSON.stringify({
    case: { id: 'repair-limit', prompt: '验证修复轮次硬门禁', requiredArtifacts: ['report'],
      requiredGates: ['data', 'format'], fixtureRepairRoundCases: cases },
    runner: { command: process.execPath, args: [resolve('test/fixtures/pack-benchmark-runner.mjs'),
      '{caseFile}', '{receipt}', '{runId}', '{trial}'] },
  }))
  const run = spawnSync(process.execPath, ['scripts/qa/pack-benchmark.mjs', '--config', configPath, '--out', out], {
    cwd: resolve('.'), encoding: 'utf8',
  })
  assert.equal(run.status, 1, run.stderr)
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))
  assert.equal(summary.passed, 3)
  assert.equal(summary.stableForRelease, false)
  assert.match(summary.acceptance, /修复轮次必须为 0–2 的整数/)
  for (const [index, receipt] of cases.entries()) {
    const result = summary.trials[index]
    const valid = [0, 1, 8].includes(index)
    assert.equal(result.repairRounds, receipt.repairRounds ?? null)
    assert.equal(result.pass, valid)
    assert.equal(result.score, valid ? 100 : 95)
    assert.deepEqual(result.failure, valid ? [] : [
      [2, 9].includes(index) ? 'REPAIR_LIMIT_EXCEEDED' : 'REPAIR_ROUNDS_INVALID',
    ])
  }
})
