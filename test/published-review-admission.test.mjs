import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { qualityPublicationFixture } from './support/quality-publication-fixture.mjs'

test('review rejects publication bytes changed before evidence collection', async t => {
  const f = await qualityPublicationFixture(t)
  const published = await f.publish('approved publication bytes')
  await writeFile(join(f.stateRoot, published.path), 'changed before evidence collection')
  await assert.rejects(f.review('changed-publication-review'), /PUBLISHED_EVIDENCE_MISMATCH/)
  assert.equal((await f.read()).qualityRuns.t1.status, 'pending')
  assert.equal((await f.read()).qualityRuns.t1.latestEvidence, undefined)
})

test('a concurrent same-name publication invalidates an in-flight review', async t => {
  const f = await qualityPublicationFixture(t, { verify: ['node verify-publication.mjs'] })
  // The real verification subprocess pauses after artifact collection, so
  // publication can commit while review still holds an older candidate.
  await writeFile(join(f.stateRoot, 'verify-publication.mjs'), `
import { existsSync, writeFileSync } from 'node:fs'
writeFileSync('review-ready', '1')
const deadline = setTimeout(() => process.exit(2), 10000)
const timer = setInterval(() => {
  if (existsSync('review-go')) {
    clearInterval(timer)
    clearTimeout(deadline)
  }
}, 10)
`)
  const first = await f.publish('version one')
  const before = (await f.read()).qualityRuns.t1
  const inflight = f.review('concurrent-publication-review').then(() => undefined, error => error)
  let latest
  try {
    let ready = false
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      try { await readFile(join(f.stateRoot, 'review-ready')); ready = true; break }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      await delay(10)
    }
    assert.ok(ready, 'verification reached the controlled pause')
    latest = await f.publish('version two')
    const after = (await f.read()).qualityRuns.t1
    assert.equal(after.runId, before.runId)
    assert.deepEqual(after.contract, before.contract, 'the guard must notice publication changes even without a contract revision')
  } finally {
    await writeFile(join(f.stateRoot, 'review-go'), '1')
    await inflight
  }
  assert.match((await inflight)?.message ?? '', /PUBLISHED_EVIDENCE_MISMATCH/)
  assert.equal((await f.read()).qualityRuns.t1.status, 'pending')
  assert.equal(await readFile(join(f.stateRoot, first.path), 'utf8'), 'version one')
  await f.review('fresh-latest-publication-review')
  const evidence = (await f.read()).qualityRuns.t1.latestEvidence.artifacts.find(item => item.id === 'published:report.txt')
  assert.equal(evidence.path, latest.path)
  assert.equal(evidence.sha256, latest.sha256)
})
