import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { prepareDependencyInputs } from '../lib/dependency-inputs.js'
import { createQualityRun, integrateQualityRun, reviewQualityRun } from '../lib/quality-run.js'
import { createTaskProject, createTeamDir, publishTaskArtifact, readTeam, taskInputWarnings, writeTeam } from '../lib/state.js'
import { qualityPublicationFixture } from './support/quality-publication-fixture.mjs'

// Real immutable publications and pure quality transitions; no model, provider,
// live tenant or network. Corruptions below are deliberately injected fixtures.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pinned-input-boundaries-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = { id: 't1', subject: 'Source', status: 'in_progress', attempt: 1,
    assignee: 'source', dependencies: [], createdAt: 1, updatedAt: 1 }
  const consumer = { id: 't2', subject: 'Consumer', status: 'pending', attempt: 0,
    assignee: 'consumer', dependencies: ['t1'], createdAt: 1, updatedAt: 1 }
  const team = { id: 'pins', name: 'pins', captainSessionId: 'captain',
    members: ['source', 'consumer'].map(name => ({ id: `${name}-id`, name, status: 'idle', joinedAt: 1 })),
    tasks: [source, consumer], taskSeq: 2, createdAt: 1 }
  await createTeamDir(root, team)
  source.project = await createTaskProject(root, team.id, source)
  consumer.project = await createTaskProject(root, team.id, consumer)
  await writeTeam(root, team)
  assert.ok(await readTeam(root, team.id), 'fixture itself must satisfy the durable state contract')
  const path = artifact => join(root, team.id, source.project.artifactsPath, artifact.relativePath)
  async function publish(content, name = 'report.md') {
    const artifact = await publishTaskArtifact(root, team, source, { name, content })
    source.publishedArtifacts = [...(source.publishedArtifacts ?? []), artifact]
    return artifact
  }
  async function integrate(artifacts) {
    const contract = {
      id: 'source-contract', taskId: source.id, attempt: source.attempt, assignee: source.assignee,
      kind: 'implementation', objective: source.subject, inScope: [`${team.id}/**`],
      acceptance: [{ id: 'present', statement: 'Fixture bytes are reviewable' }],
      verify: ['fixture-byte-check'], deliverables: artifacts.map(item => item.reviewId),
      changedPaths: [`${team.id}/**`], maxRepairRounds: 2,
    }
    const evidence = { taskId: source.id, attempt: source.attempt, artifacts: await Promise.all(artifacts.map(async artifact => ({
      id: artifact.reviewId, taskId: source.id, attempt: artifact.attempt,
      path: `${team.id}/${source.project.artifactsPath}/${artifact.relativePath}`,
      sha256: artifact.sha256, content: await readFile(path(artifact), 'utf8'),
    }))), acceptanceResults: [{ id: 'present', passed: true }],
    commandsRun: [{ command: 'fixture-byte-check', exitCode: 0, passed: true }],
    changedPaths: artifacts.map(artifact => `${team.id}/${source.project.artifactsPath}/${artifact.relativePath}`) }
    let run = createQualityRun(contract)
    run = reviewQualityRun(run, { eventId: 'review-source', reviewer: 'reviewer', verdict: 'pass', evidence }).run
    run = integrateQualityRun(run, { eventId: 'integrate-source', actor: 'captain' }).run
    team.qualityRuns = { t1: run }
    source.status = 'completed'
    return run
  }
  return { root, team, source, consumer, path, publish, integrate,
    prepare: attempt => prepareDependencyInputs(root, team, consumer, attempt) }
}

async function legacyManualFixture(t, { deliverable = 'manual-report', attempt = 1 } = {}) {
  const f = await fixture(t)
  f.source.attempt = attempt
  const path = `${f.team.id}/${f.source.project.artifactsPath}/manual-report.md`
  const content = 'Legacy manually reviewed evidence; no publication identity exists'
  await writeFile(join(f.root, path), content)
  const contract = {
    id: 'manual-contract', taskId: f.source.id, attempt, assignee: f.source.assignee,
    kind: 'implementation', objective: f.source.subject, inScope: [`${f.team.id}/**`],
    acceptance: [{ id: 'present', statement: 'Manual evidence is reviewable' }],
    verify: ['fixture-byte-check'], deliverables: [deliverable], changedPaths: [path], maxRepairRounds: 2,
  }
  const evidence = { taskId: f.source.id, attempt,
    artifacts: [{ id: deliverable, taskId: f.source.id, attempt, path, content,
      sha256: createHash('sha256').update(content).digest('hex') }],
    acceptanceResults: [{ id: 'present', passed: true }],
    commandsRun: [{ command: 'fixture-byte-check', exitCode: 0, passed: true }], changedPaths: [path] }
  let run = createQualityRun(contract)
  run = reviewQualityRun(run, { eventId: 'manual-review', reviewer: 'reviewer', verdict: 'pass', evidence }).run
  run = integrateQualityRun(run, { eventId: 'manual-integrate', actor: 'captain' }).run
  f.team.qualityRuns = { t1: run }
  f.source.status = 'completed'
  return { ...f, run }
}

const markStructured = {
  'team-policy': f => { f.team.structuredQualityPolicy = { required: true, maxRepairRounds: 2 } },
  'planned-consumer': f => { f.consumer.planTask = { logicalId: 'consume', fanOutIndex: 0 } },
  'planned-source': f => { f.source.planTask = { logicalId: 'produce', fanOutIndex: 0 } },
}

for (const [marker, mark] of Object.entries(markStructured)) {
  test(`legacy manual-file compatibility cannot waive missing publications for ${marker}`, async t => {
    const f = await legacyManualFixture(t)
    mark(f)
    await assert.rejects(f.prepare(1), /INPUT_PUBLICATION_MISSING/)
    assert.equal(f.consumer.inputArtifactBinding, undefined)
  })

  test(`a ${marker} dependency without any quality run cannot use the legacy no-publication early return`, async t => {
    const f = await fixture(t)
    f.source.status = 'completed'
    mark(f)
    await assert.rejects(f.prepare(1), /INPUT_DEPENDENCY_NOT_REVIEWED/)
    assert.equal(f.consumer.inputArtifacts, undefined)
    assert.equal(f.consumer.inputArtifactBinding, undefined)
  })
}

test('prior-attempt publication history excludes the legacy never-published exception', async t => {
  const f = await legacyManualFixture(t, { attempt: 2 })
  f.source.attempt = 1
  await f.publish('historical published input')
  f.source.attempt = 2
  await assert.rejects(f.prepare(1), /INPUT_PUBLICATION_MISSING/)
  assert.equal(f.consumer.inputArtifactBinding, undefined)
})

test('manual evidence named published:* does not replace the missing immutable publication manifest', async t => {
  const f = await legacyManualFixture(t, { deliverable: 'published:report.md' })
  await assert.rejects(f.prepare(1), /INPUT_PUBLICATION_MISSING/)
  assert.equal(f.consumer.inputArtifactBinding, undefined)
})

test('legacy manual compatibility revalidates passed acceptance instead of trusting integrated status alone', async t => {
  const f = await legacyManualFixture(t)
  f.run.latestEvidence.acceptanceResults[0].passed = false
  await assert.rejects(f.prepare(1), error => error.code === 'acceptance_failed')
  assert.equal(f.consumer.inputArtifactBinding, undefined)
})

test('explicitly disabled review preserves the declared contract with and without publications and records its limitation', async t => {
  for (const withPublication of [false, true]) {
    const f = await fixture(t)
    if (withPublication) await f.publish('Unreviewed because the contract explicitly disables review')
    f.source.status = 'completed'
    f.team.structuredQualityPolicy = { required: false, maxRepairRounds: 2 }
    f.source.planTask = { logicalId: 'produce', fanOutIndex: 0 }
    f.consumer.planTask = { logicalId: 'consume', fanOutIndex: 0 }
    assert.deepEqual(await f.prepare(1), [])
    assert.deepEqual(f.consumer.inputArtifacts, [])
    assert.equal(f.consumer.inputArtifactBinding.reviewDisabled, true)
    assert.equal(f.consumer.inputArtifactBinding.legacyUnpinnedSources, undefined)
    await writeTeam(f.root, f.team)
    const cold = await readTeam(f.root, f.team.id)
    assert.equal(cold.tasks[1].inputArtifactBinding.reviewDisabled, true)
    assert.match(taskInputWarnings(cold.tasks[1]).join('\n'), /explicitly disabled.*no reviewed.version guarantee/is)
  }
})

test('explicitly disabled review never bypasses byte validation for an explicit pinned ref', async t => {
  const f = await fixture(t)
  const artifact = await f.publish('Explicitly pinned original bytes')
  f.source.status = 'completed'
  f.team.structuredQualityPolicy = { required: false, maxRepairRounds: 2 }
  f.consumer.inputArtifacts = [{ sourceTaskId: 't1', artifactId: artifact.id }]
  const manifest = structuredClone(await f.prepare(1))
  assert.equal(f.consumer.inputArtifactBinding, undefined, 'an explicit ref cannot be relabeled as an automatic opt-out')
  await writeFile(f.path(artifact), 'Corrupted while review was disabled')
  await writeTeam(f.root, f.team)
  const cold = await readTeam(f.root, f.team.id)
  await assert.rejects(prepareDependencyInputs(f.root, cold, cold.tasks[1], 1), /hash mismatch/)
  assert.deepEqual(cold.tasks[1].inputArtifactManifest, manifest)
})

test('automatic input chooses the reviewed current version, never an older same-name publication', async t => {
  const f = await fixture(t)
  const old = await f.publish('old version')
  const latest = await f.publish('reviewed current version')
  await f.integrate([latest])
  const manifest = await f.prepare(1)
  assert.deepEqual(f.consumer.inputArtifacts, [{ sourceTaskId: 't1', artifactId: latest.id }])
  assert.notEqual(manifest[0].artifactId, old.id)
  assert.equal(manifest[0].versionPath, f.path(latest))
  assert.equal(manifest[0].sha256, latest.sha256)
})

test('a newer unreviewed publication is rejected instead of silently using it or falling back', async t => {
  const f = await fixture(t)
  const approved = await f.publish('approved')
  await f.integrate([approved])
  await f.publish('unreviewed late publication') // Inject an inconsistent source fixture.
  await assert.rejects(f.prepare(1), /INPUT_PUBLICATION_NOT_REVIEWED/)
  assert.equal(f.consumer.inputArtifacts, undefined)
})

for (const field of ['taskId', 'attempt', 'path', 'sha256']) {
  test(`automatic selection rejects integrated evidence with a mismatched ${field}`, async t => {
    const f = await fixture(t)
    const artifact = await f.publish('reviewed bytes')
    const run = await f.integrate([artifact])
    const mutations = { taskId: 'other-task', attempt: 2, path: 'pins/unreviewed.md', sha256: '0'.repeat(64) }
    run.latestEvidence.artifacts[0][field] = mutations[field]
    await assert.rejects(f.prepare(1), /INPUT_PUBLICATION_NOT_REVIEWED/)
    assert.equal(f.consumer.inputArtifacts, undefined)
  })
}

test('passed but not integrated evidence cannot automatically unlock a dependency input', async t => {
  const f = await fixture(t)
  const artifact = await f.publish('reviewed but not integrated')
  const run = await f.integrate([artifact])
  run.status = 'passed' // Deliberately inconsistent completed-task fixture.
  await assert.rejects(f.prepare(1), /INPUT_DEPENDENCY_NOT_REVIEWED/)
})

test('explicit empty inputs remain empty even when default selection would reject an unreviewed publication', async t => {
  const f = await fixture(t)
  await f.publish('unreviewed source')
  f.source.status = 'completed'
  f.consumer.inputArtifacts = []
  assert.deepEqual(await f.prepare(1), [])
  assert.deepEqual(await f.prepare(2), [])
  assert.deepEqual(f.consumer.inputArtifacts, [])
  assert.equal(f.consumer.inputArtifactBinding, undefined)
})

test('explicit older refs remain explicit across consumer attempts and never expand to all publications', async t => {
  const f = await fixture(t)
  const old = await f.publish('explicitly chosen version')
  const latest = await f.publish('reviewed latest')
  await f.integrate([latest])
  f.consumer.inputArtifacts = [{ sourceTaskId: 't1', artifactId: old.id, purpose: 'Explicit historical comparison' }]
  const first = await f.prepare(1)
  assert.equal(first[0].artifactId, old.id)
  assert.deepEqual(await f.prepare(2), first)
  assert.equal(f.consumer.inputArtifactBinding, undefined)
  assert.equal(f.consumer.inputArtifacts[0].purpose, 'Explicit historical comparison')
})

test('the same consumer attempt preserves its pins after a real durable reload despite a later publication', async t => {
  const f = await fixture(t)
  const first = await f.publish('frozen input')
  await f.integrate([first])
  const manifest = await f.prepare(1)
  f.consumer.status = 'claimed'
  f.consumer.attempt = 1
  f.consumer.attemptId = 'consumer-attempt-1'
  f.consumer.dispatch = { id: 'dispatch-1', attemptId: 'consumer-attempt-1', dispatchedAt: 1 }
  await f.publish('late source must not replace existing consumer input')
  await writeTeam(f.root, f.team)
  const cold = await readTeam(f.root, f.team.id)
  assert.ok(cold)
  assert.deepEqual(await prepareDependencyInputs(f.root, cold, cold.tasks[1], 1), manifest)
  assert.deepEqual(cold.tasks[1].inputArtifacts, [{ sourceTaskId: 't1', artifactId: first.id }])
})

test('persisted input identity compares fields rather than JSON property insertion order', async t => {
  const f = await fixture(t)
  const artifact = await f.publish('same identity')
  await f.integrate([artifact])
  const expected = structuredClone(await f.prepare(1))
  f.consumer.inputArtifactManifest = expected.map(item => Object.fromEntries(Object.entries(item).reverse()))
  assert.deepEqual(await f.prepare(1), expected)
})

for (const corruption of ['missing-entry', 'duplicate-entry', 'changed-artifact-id']) {
  test(`a persisted ${corruption} manifest is rejected instead of rebuilt from refs`, async t => {
    const f = await fixture(t)
    const artifact = await f.publish('frozen identity')
    await f.integrate([artifact])
    const [item] = await f.prepare(1)
    if (corruption === 'missing-entry') f.consumer.inputArtifactManifest = []
    if (corruption === 'duplicate-entry') f.consumer.inputArtifactManifest = [item, { ...item }]
    if (corruption === 'changed-artifact-id') f.consumer.inputArtifactManifest = [{ ...item, artifactId: 'different-version' }]
    const corrupted = structuredClone(f.consumer.inputArtifactManifest)
    await assert.rejects(f.prepare(1), /INPUT_VERSION_CHANGED/)
    assert.deepEqual(f.consumer.inputArtifactManifest, corrupted, 'do not silently heal ambiguous identity')
  })
}

for (const fault of ['replaced', 'missing']) {
  test(`a ${fault} fixed file keeps its original pin until those exact bytes are restored`, async t => {
    const f = await fixture(t)
    const artifact = await f.publish('required original bytes')
    await f.integrate([artifact])
    const expected = structuredClone(await f.prepare(1))
    if (fault === 'replaced') await writeFile(f.path(artifact), 'wrong bytes')
    else await rm(f.path(artifact))
    await assert.rejects(f.prepare(1), /hash mismatch|ENOENT/)
    assert.deepEqual(f.consumer.inputArtifactManifest, expected)
    assert.deepEqual(f.consumer.inputArtifacts, [{ sourceTaskId: 't1', artifactId: artifact.id }])
    await writeFile(f.path(artifact), 'required original bytes')
    assert.deepEqual(await f.prepare(1), expected)
  })
}

test('a failed initial byte check still freezes the selected version before any consumer attempt is dispatched', async t => {
  const f = await fixture(t)
  const artifact = await f.publish('initial reviewed input')
  await f.integrate([artifact])
  await rm(f.path(artifact))
  await assert.rejects(f.prepare(1), /ENOENT/)
  assert.equal(f.consumer.attempt, 0)
  assert.deepEqual(f.consumer.inputArtifactBinding, { mode: 'dependency-default', consumerAttempt: 1 })
  assert.deepEqual(f.consumer.inputArtifacts, [{ sourceTaskId: 't1', artifactId: artifact.id }])
  await f.publish('replacement must not be chosen on the same dispatch retry')
  await writeTeam(f.root, f.team)
  const cold = await readTeam(f.root, f.team.id)
  await assert.rejects(prepareDependencyInputs(f.root, cold, cold.tasks[1], 1), /ENOENT/)
  assert.deepEqual(cold.tasks[1].inputArtifacts, [{ sourceTaskId: 't1', artifactId: artifact.id }])
})

for (const fault of ['missing', 'corrupt']) {
  test(`first ${fault} bytes cannot authorize same-UUID metadata drift on a cold dispatch retry`, async t => {
    const f = await fixture(t)
    const artifact = await f.publish('reviewed original')
    await f.integrate([artifact])
    const reviewedSha = artifact.sha256
    if (fault === 'missing') await rm(f.path(artifact))
    else await writeFile(f.path(artifact), 'bad initial bytes')
    await assert.rejects(f.prepare(1), /ENOENT|hash mismatch/)
    // Change the source's manifest and file together without another review.
    // The UUID is unchanged; the independent latestEvidence still binds the
    // original SHA. Cold retry must not turn this pair into a new authority.
    const replacement = 'different, never-reviewed content'
    await writeFile(f.path(artifact), replacement)
    artifact.sha256 = createHash('sha256').update(replacement).digest('hex')
    artifact.sizeBytes = Buffer.byteLength(replacement)
    assert.notEqual(artifact.sha256, reviewedSha)
    assert.equal(f.team.qualityRuns.t1.latestEvidence.artifacts[0].sha256, reviewedSha)
    await writeTeam(f.root, f.team)
    const cold = await readTeam(f.root, f.team.id)
    await assert.rejects(prepareDependencyInputs(f.root, cold, cold.tasks[1], 1), /INPUT_VERSION_CHANGED|INPUT_PUBLICATION_NOT_REVIEWED/)
  })
}

test('failure reading the first input still freezes every later input identity before a cold retry', async t => {
  const f = await fixture(t)
  const first = await f.publish('first reviewed file', 'first.md')
  const second = await f.publish('second reviewed file', 'second.md')
  await f.integrate([first, second])
  await rm(f.path(first))
  await assert.rejects(f.prepare(1), /ENOENT/)
  assert.deepEqual(f.consumer.inputArtifactManifest.map(item => item.artifactId), [first.id, second.id])
  assert.equal(f.consumer.inputArtifactManifest[1].sha256, second.sha256)
  await writeFile(f.path(first), 'first reviewed file')
  const changed = 'unreviewed second file after first-file failure'
  await writeFile(f.path(second), changed)
  second.sha256 = createHash('sha256').update(changed).digest('hex')
  second.sizeBytes = Buffer.byteLength(changed)
  await writeTeam(f.root, f.team)
  const cold = await readTeam(f.root, f.team.id)
  await assert.rejects(prepareDependencyInputs(f.root, cold, cold.tasks[1], 1), /INPUT_VERSION_CHANGED|INPUT_PUBLICATION_NOT_REVIEWED/)
})

async function completedToolFixture(t) {
  const f = await qualityPublicationFixture(t)
  const artifact = await f.publish('completed source version')
  const waiting = await f.read()
  waiting.tasks[0].executionState = 'awaiting_review'
  await f.write(waiting)
  await f.review('independent-pass')
  await f.call('quality_integrate', { task_id: 't1', event_id: 'integrate-final', actor: 'captain', complete_task: true }, 'captain')
  return { ...f, artifact }
}

test('registered tools cannot reopen or reassign a completed integrated source to roll downstream inputs', async t => {
  const f = await completedToolFixture(t)
  const completed = await f.read()
  assert.equal(completed.tasks[0].status, 'completed')
  await assert.rejects(f.call('quality_reopen', { task_id: 't1', event_id: 'illegal-reopen', reason: 'Change an upstream file' }, 'captain'), /Only unfinished|completed|terminal/i)
  await assert.rejects(f.call('reassign_task', { task_id: 't1', assignee: 'worker' }, 'captain'), /completed|terminal/i)
  assert.deepEqual(await f.read(), completed)
})

test('a direct captain claim freezes reviewed dependency inputs before opening its first attempt', async t => {
  const f = await completedToolFixture(t)
  const created = await f.call('create_task', { subject: 'Captain consumes reviewed source', dependencies: ['t1'], assignee: 'captain' }, 'captain')
  const before = (await f.read()).tasks.find(task => task.id === created.task_id)
  assert.equal(before.status, 'pending')
  assert.equal(before.attemptId, undefined)
  const claimed = await f.call('claim_task', { task_id: created.task_id }, 'captain')
  const durable = (await f.read()).tasks.find(task => task.id === created.task_id)
  assert.equal(claimed.attempt, 1)
  assert.deepEqual(durable.inputArtifacts, [{ sourceTaskId: 't1', artifactId: f.artifact.artifact_id }])
  assert.equal(durable.inputArtifactManifest[0].sha256, f.artifact.sha256)
  const input = JSON.parse(await readFile(join(f.teamRoot, durable.project.inputPath), 'utf8'))
  assert.deepEqual(input.inputArtifactManifest, durable.inputArtifactManifest)
  assert.deepEqual(input.inputArtifactBinding, { mode: 'dependency-default', consumerAttempt: 1 })
})

test('a direct captain claim with corrupt input persists a blocker without an attempt and requires explicit resume', async t => {
  const f = await completedToolFixture(t)
  const created = await f.call('create_task', { subject: 'Input must be verified first', dependencies: ['t1'], assignee: 'captain' }, 'captain')
  const artifactPath = join(f.stateRoot, f.artifact.path)
  await writeFile(artifactPath, 'corrupt version')
  await assert.rejects(f.call('claim_task', { task_id: created.task_id }, 'captain'), /INPUT_ARTIFACT_BLOCKED|hash mismatch/)
  const blocked = (await f.read()).tasks.find(task => task.id === created.task_id)
  assert.equal(blocked.status, 'pending')
  assert.equal(blocked.attempt ?? 0, 0)
  assert.equal(blocked.attemptId, undefined)
  assert.equal(blocked.executionState, 'blocked_external')
  assert.deepEqual(blocked.inputArtifacts, [{ sourceTaskId: 't1', artifactId: f.artifact.artifact_id }])
  await writeFile(artifactPath, 'completed source version')
  await assert.rejects(f.call('claim_task', { task_id: created.task_id }, 'captain'), /blocked|resume/i)
  await f.call('resume_task', { task_id: created.task_id, reason: 'Restored exact reviewed bytes' }, 'captain')
  const claimed = await f.call('claim_task', { task_id: created.task_id }, 'captain')
  assert.equal(claimed.attempt, 1)
  const restored = (await f.read()).tasks.find(task => task.id === created.task_id)
  assert.equal(restored.inputArtifactManifest[0].artifactId, f.artifact.artifact_id)
})
