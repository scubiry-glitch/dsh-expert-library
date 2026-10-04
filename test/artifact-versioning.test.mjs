import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTaskProject, publishTaskArtifact, readAllowedTaskArtifact, resolveAllowedArtifact } from '../lib/state.js'

async function fixture(t) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'artifact-versions-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const source = { id: 't1', subject: 'source', status: 'in_progress', attempt: 1, assignee: 'worker', dependencies: [], createdAt: 1, updatedAt: 1 }
  const consumer = { id: 't2', subject: 'consumer', status: 'pending', dependencies: ['t1'], createdAt: 1, updatedAt: 1 }
  const team = { id: 'version-team', name: 'version team', captainSessionId: 'captain', tasks: [source, consumer], members: [], taskSeq: 2, createdAt: 1 }
  source.project = await createTaskProject(stateRoot, team.id, source)
  const publish = async content => {
    const artifact = await publishTaskArtifact(stateRoot, team, source, { name: 'report.md', content })
    source.publishedArtifacts = [...(source.publishedArtifacts ?? []), artifact]
    return artifact
  }
  const pin = artifact => {
    source.status = 'completed'
    const ref = { sourceTaskId: source.id, artifactId: artifact.id }
    consumer.inputArtifacts = [ref]
    return ref
  }
  const path = artifact => join(stateRoot, team.id, source.project.artifactsPath, artifact.relativePath)
  return { stateRoot, source, consumer, team, publish, pin, path }
}

test('same-name publications preserve both versions and a consumer keeps its original pin', async t => {
  const f = await fixture(t)
  const first = await f.publish('version one')
  const ref = f.pin(first)
  f.source.attempt = 2
  f.source.status = 'in_progress'
  const second = await f.publish('version two')
  f.source.status = 'completed'
  assert.notEqual(first.id, second.id)
  assert.equal(first.reviewId, 'published:report.md')
  assert.equal(first.reviewId, second.reviewId)
  assert.notEqual(first.relativePath, second.relativePath)
  assert.equal(await readFile(f.path(first), 'utf8'), 'version one')
  assert.equal(await readFile(f.path(second), 'utf8'), 'version two')
  assert.equal((await readAllowedTaskArtifact(f.stateRoot, f.team, f.consumer, ref)).content, 'version one')
  assert.throws(() => resolveAllowedArtifact(f.team, f.consumer, { sourceTaskId: 't1', artifactId: second.id }), /not explicitly allowlisted/)
})

test('two publications in the same attempt never share a writable path', async t => {
  const f = await fixture(t)
  const first = await f.publish('first')
  const second = await f.publish('second')
  assert.equal(first.attempt, second.attempt)
  assert.notEqual(first.relativePath, second.relativePath)
  assert.equal(await readFile(f.path(first), 'utf8'), 'first')
})

test('published binary bytes survive publication and pinned hash verification', async t => {
  const f = await fixture(t)
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0x80])
  const artifact = await f.publish(bytes)
  assert.deepEqual(await readFile(f.path(artifact)), bytes)
  assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'))
  const result = await readAllowedTaskArtifact(f.stateRoot, f.team, f.consumer, f.pin(artifact))
  assert.equal(result.encoding, 'base64')
  assert.deepEqual(Buffer.from(result.content, 'base64'), bytes)
})

test('a pinned publication fails when its real bytes are replaced or removed', async t => {
  const f = await fixture(t)
  const artifact = await f.publish('original')
  const ref = f.pin(artifact)
  await writeFile(f.path(artifact), 'modified')
  await assert.rejects(readAllowedTaskArtifact(f.stateRoot, f.team, f.consumer, ref), /hash mismatch/)
  await rm(f.path(artifact))
  await assert.rejects(readAllowedTaskArtifact(f.stateRoot, f.team, f.consumer, ref), /ENOENT/)
})

test('published identity, dependency, path and symlink boundaries are enforced', async t => {
  const f = await fixture(t)
  const artifact = await f.publish('original')
  const ref = f.pin(artifact)
  const outside = await mkdtemp(join(tmpdir(), 'artifact-versions-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'report.md'), 'original')
  await rm(f.path(artifact))
  await symlink(join(outside, 'report.md'), f.path(artifact))
  await assert.rejects(readAllowedTaskArtifact(f.stateRoot, f.team, f.consumer, ref), /escapes/)
  f.source.publishedArtifacts = [{ ...artifact, relativePath: '../report.md' }]
  assert.throws(() => resolveAllowedArtifact(f.team, f.consumer, ref), /invalid manifest/)
  f.source.publishedArtifacts = [artifact, { ...artifact }]
  assert.throws(() => resolveAllowedArtifact(f.team, f.consumer, ref), /ambiguous publication identity/)
  f.source.publishedArtifacts = [artifact]
  f.consumer.dependencies = []
  assert.throws(() => resolveAllowedArtifact(f.team, f.consumer, ref), /not a dependency/)
})

test('legacy publications without a logical review id remain readable', async t => {
  const f = await fixture(t)
  const published = await f.publish('legacy readable')
  const { reviewId, ...legacy } = published
  f.source.publishedArtifacts = [legacy]
  assert.equal((await readAllowedTaskArtifact(f.stateRoot, f.team, f.consumer, f.pin(legacy))).content, 'legacy readable')
})
