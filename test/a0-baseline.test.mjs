import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const fixtureUrl = new URL('./fixtures/expert-teams-snapshots.json', import.meta.url)

test('A0 baseline fixture keeps every audit scenario and its identifying invariants', async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'))
  assert.equal(fixture.schemaVersion, 1)
  assert.deepEqual(Object.keys(fixture.teams).sort(), [
    'archive',
    'dag',
    'empty',
    'failedAttempt',
    'mailboxBurst',
    'qualityFinding',
    'staged',
  ])
  assert.deepEqual(fixture.teams.dag.tasks, [
    { id: 't1', dependencies: [] },
    { id: 't2', dependencies: ['t1'] },
  ])
  assert.equal(fixture.teams.failedAttempt.task.attemptId, 'attempt-2')
  assert.equal(fixture.teams.qualityFinding.code, 'artifact_missing')
})
