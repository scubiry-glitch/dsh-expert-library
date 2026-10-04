import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  collectTaskEvidence,
  assertDurableQualityRun,
  readQualityRunJSON,
  writeQualityRunAtomic,
} from '../lib/quality-runtime.js'
import { createQualityContract, createQualityRun, reviewQualityRun } from '../lib/quality-run.js'

function contract(overrides = {}) {
  return createQualityContract({
    id: 'runtime-contract', taskId: 'task-runtime', attempt: 1,
    assignee: 'worker', kind: 'verification', objective: 'verify artifact',
    inScope: ['src/**'], outOfScope: ['secrets/**'],
    acceptance: [{ id: 'a1', statement: 'passes' }], verify: ['node -e "process.stdout.write(\'ok\')"'],
    deliverables: ['report'], changedPaths: ['src/report.txt'], maxRepairRounds: 2,
    ...overrides,
  })
}

test('runtime evidence reads and hashes the real artifact and records command receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-runtime-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/report.txt'), 'real artifact\n')
  const evidence = await collectTaskEvidence({
    workspaceRoot: root,
    contract: contract(),
    artifacts: [{ id: 'report', path: 'src/report.txt' }],
    acceptanceResults: [{ id: 'a1', passed: true }],
  })
  assert.equal(evidence.artifacts[0].content, 'real artifact\n')
  assert.equal(evidence.artifacts[0].sha256.length, 64)
  assert.equal(evidence.commandsRun[0].exitCode, 0)
  assert.equal(evidence.commandsRun[0].passed, true)
  assert.equal(typeof evidence.commandsRun[0].startedAt, 'number')
})

test('binary evidence retains raw bytes through collection, review and JSON restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-runtime-binary-'))
  await mkdir(join(root, 'src'))
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00, 0x80])
  await writeFile(join(root, 'src/report.pdf'), bytes)
  const binaryContract = contract({ verify: ['true'], changedPaths: ['src/report.pdf'] })
  const evidence = await collectTaskEvidence({
    workspaceRoot: root, contract: binaryContract,
    artifacts: [{ id: 'report', path: 'src/report.pdf' }],
    acceptanceResults: [{ id: 'a1', passed: true }],
  })
  assert.equal(evidence.artifacts[0].encoding, 'base64')
  assert.deepEqual(Buffer.from(evidence.artifacts[0].content, 'base64'), bytes)
  assert.equal(evidence.artifacts[0].sha256, createHash('sha256').update(bytes).digest('hex'))
  const run = reviewQualityRun(createQualityRun(binaryContract, 'run-binary'), {
    eventId: 'binary-review', reviewer: 'reviewer', verdict: 'pass', evidence,
  }).run
  assert.equal(run.status, 'passed')
  assert.doesNotThrow(() => assertDurableQualityRun(JSON.parse(JSON.stringify(run))))
})

test('runtime evidence records the repaired task attempt rather than the frozen contract attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-runtime-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/report.txt'), 'repaired artifact\n')
  const evidence = await collectTaskEvidence({
    workspaceRoot: root,
    contract: contract(),
    attempt: 2,
    artifacts: [{ id: 'report', path: 'src/report.txt' }],
    acceptanceResults: [{ id: 'a1', passed: true }],
  })
  assert.equal(evidence.attempt, 2)
  assert.equal(evidence.artifacts[0].attempt, 2)
})

test('runtime rejects command substitutions and filesystem escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-runtime-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/report.txt'), 'real')
  const outside = await mkdtemp(join(tmpdir(), 'quality-runtime-outside-'))
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(join(outside, 'secret.txt'), join(root, 'src/link.txt'))
  await assert.rejects(
    collectTaskEvidence({
      workspaceRoot: root, contract: contract({ changedPaths: ['src/link.txt'] }), artifacts: [{ id: 'report', path: 'src/link.txt' }],
      acceptanceResults: [{ id: 'a1', passed: true }],
    }),
    error => error.code === 'path_out_of_scope',
  )
  await assert.rejects(
    collectTaskEvidence({
      workspaceRoot: root, contract: contract(), artifacts: [{ id: 'report', path: '../report.txt' }],
      acceptanceResults: [{ id: 'a1', passed: true }],
    }),
    error => error.code === 'path_out_of_scope',
  )
  await assert.rejects(
    collectTaskEvidence({
      workspaceRoot: root, contract: contract(), artifacts: [{ id: 'report', path: 'src/report.txt' }],
      acceptanceResults: [{ id: 'a1', passed: true }], commands: ['node -e "process.exit(1)"'],
    }),
    error => error.code === 'verification_contract_mismatch',
  )
})

test('strict durable validator rejects impossible status counters and survives atomic restart', async () => {
  const run = createQualityRun(contract(), 'runtime-run')
  assert.doesNotThrow(() => assertDurableQualityRun(run))
  assert.throws(() => assertDurableQualityRun({ ...run, status: 'passed' }), error => error.code === 'quality_state_invalid')
  const root = await mkdtemp(join(tmpdir(), 'quality-runtime-'))
  const file = join(root, 'quality.json')
  await writeQualityRunAtomic(file, run)
  const restored = await readQualityRunJSON(file)
  assert.deepEqual(restored, JSON.parse(JSON.stringify(run)))
  const reviewed = reviewQualityRun(run, {
    eventId: 'review-1', reviewer: 'reviewer', verdict: 'pass',
    evidence: {
      taskId: 'task-runtime', attempt: 1,
      artifacts: [{ id: 'report', taskId: 'task-runtime', attempt: 1, path: 'src/report.txt', content: 'x', sha256: createHash('sha256').update('x').digest('hex') }],
      acceptanceResults: [{ id: 'a1', passed: true }], commandsRun: [{ command: 'verify', exitCode: 0, passed: true }], changedPaths: ['src/report.txt'],
    },
  }).run
  assert.doesNotThrow(() => assertDurableQualityRun(reviewed))
})
