import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertReviewedArtifactsCurrent } from '../lib/quality-artifacts.js'

async function fixture(t, bytes = Buffer.from('reviewed report')) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'quality-artifacts-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  await mkdir(join(stateRoot, 'team', 'output'), { recursive: true })
  const path = 'team/output/report.md'
  await writeFile(join(stateRoot, path), bytes)
  const artifact = { id: 'report', taskId: 't1', attempt: 1, path, content: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') }
  return { stateRoot, path, run: { latestEvidence: { taskId: 't1', attempt: 1, artifacts: [artifact], changedPaths: [path], acceptanceResults: [], commandsRun: [] } } }
}

test('admission rereads file bytes rather than trusting the reviewed snapshot', async t => {
  const f = await fixture(t)
  await assertReviewedArtifactsCurrent(f)
  await writeFile(join(f.stateRoot, f.path), 'changed after review')
  await assert.rejects(assertReviewedArtifactsCurrent(f), error => error.code === 'artifact_changed' && error.details.path === f.path)
  // The stored content and its stored hash still agree; that is insufficient.
  assert.equal(f.run.latestEvidence.artifacts[0].content, 'reviewed report')
})

test('missing and non-file reviewed artifacts fail closed', async t => {
  const f = await fixture(t)
  await rm(join(f.stateRoot, f.path))
  await assert.rejects(assertReviewedArtifactsCurrent(f), error => error.code === 'artifact_missing')
  await mkdir(join(f.stateRoot, f.path))
  await assert.rejects(assertReviewedArtifactsCurrent(f), error => error.code === 'artifact_invalid')
})

test('binary artifacts are checked using their original bytes', async t => {
  const f = await fixture(t, Buffer.from([0, 255, 254, 128, 42]))
  await assertReviewedArtifactsCurrent(f)
  await writeFile(join(f.stateRoot, f.path), Buffer.from([0, 255, 254, 128, 43]))
  await assert.rejects(assertReviewedArtifactsCurrent(f), error => error.code === 'artifact_changed')
})

test('artifact traversal and symlink escapes cannot read beyond the state root', async t => {
  const f = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), 'quality-artifacts-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'outside.md'), 'reviewed report')
  await rm(join(f.stateRoot, f.path))
  await symlink(join(outside, 'outside.md'), join(f.stateRoot, f.path))
  await assert.rejects(assertReviewedArtifactsCurrent(f), error => error.code === 'path_out_of_scope')
  for (const path of ['../outside.md', '/etc/passwd', 'C:\\outside.md', '..\\outside.md', 'team/../report.md']) {
    const run = { latestEvidence: { ...f.run.latestEvidence, artifacts: [{ ...f.run.latestEvidence.artifacts[0], path }] } }
    await assert.rejects(assertReviewedArtifactsCurrent({ ...f, run }), error => error.code === 'path_out_of_scope')
  }
})

test('only the exact Host output envelope is exempt from byte identity', async t => {
  const f = await fixture(t, Buffer.from(JSON.stringify({ output: 'summary', status: 'in_progress' })))
  f.run.latestEvidence.artifacts[0].id = 'task-output'
  await writeFile(join(f.stateRoot, f.path), JSON.stringify({ output: 'updated summary', status: 'completed', updatedAt: 100 }))
  await assertReviewedArtifactsCurrent({ ...f, taskOutputPath: f.path })
  await assert.rejects(assertReviewedArtifactsCurrent(f), error => error.code === 'artifact_changed')
  await assert.rejects(assertReviewedArtifactsCurrent({ ...f, taskOutputPath: 'team/output/other.json' }), error => error.code === 'artifact_changed')
  f.run.latestEvidence.artifacts[0].id = 'report'
  await assert.rejects(assertReviewedArtifactsCurrent({ ...f, taskOutputPath: f.path }), error => error.code === 'artifact_changed')
  f.run.latestEvidence.artifacts[0].id = 'task-output'
  await rm(join(f.stateRoot, f.path))
  await assert.rejects(assertReviewedArtifactsCurrent({ ...f, taskOutputPath: f.path }), error => error.code === 'artifact_missing')
})

test('an allowed internal symlink still checks the target bytes', async t => {
  const f = await fixture(t)
  const target = join(f.stateRoot, 'team', 'reviewed.md')
  await writeFile(target, 'reviewed report')
  await rm(join(f.stateRoot, f.path))
  await symlink(target, join(f.stateRoot, f.path))
  await assertReviewedArtifactsCurrent(f)
  await writeFile(target, 'revised report')
  await assert.rejects(assertReviewedArtifactsCurrent(f), error => error.code === 'artifact_changed')
})

test('reviewed evidence and a readable state root are required', async t => {
  const f = await fixture(t)
  await assert.rejects(assertReviewedArtifactsCurrent({ stateRoot: f.stateRoot, run: {} }), error => error.code === 'evidence_missing')
  await assert.rejects(assertReviewedArtifactsCurrent({ ...f, stateRoot: join(f.stateRoot, 'missing') }), error => error.code === 'workspace_invalid')
})
