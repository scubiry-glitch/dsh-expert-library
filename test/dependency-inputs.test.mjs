import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { prepareDependencyInputs } from '../lib/dependency-inputs.js'
import { installTeamScheduler } from '../lib/scheduler.js'
import { createQualityRun, reviewQualityRun, integrateQualityRun } from '../lib/quality-run.js'
import { createTeamDir, createTaskProject, publishTaskArtifact, readAllowedTaskArtifact, readMailbox, readTeam, writeTeam } from '../lib/state.js'
import { qualityPublicationFixture } from './support/quality-publication-fixture.mjs'

const sha = text => createHash('sha256').update(text).digest('hex')
function reviewedRun(team, source, artifact, content) {
  const path = artifact ? `${team.id}/${source.project.artifactsPath}/${artifact.relativePath}` : `${team.id}/${source.project.outputPath}`
  const id = artifact?.reviewId ?? 'task-output'
  const run = createQualityRun({ id: `contract-${source.id}-${source.attempt}`, taskId: source.id, attempt: source.attempt,
    assignee: source.assignee, kind: 'implementation', objective: source.subject, inScope: [`${team.id}/**`],
    acceptance: [{ id: 'verified', statement: 'Independently verified' }], verify: ['node --version'], deliverables: [id], changedPaths: [`${team.id}/**`] })
  return integrateQualityRun(reviewQualityRun(run, { eventId: 'review', reviewer: 'independent', verdict: 'pass',
    evidence: { taskId: source.id, attempt: source.attempt, artifacts: [{ id, path, taskId: source.id, attempt: source.attempt, content, sha256: sha(content) }],
      acceptanceResults: [{ id: 'verified', passed: true }], commandsRun: [{ command: 'node --version', exitCode: 0, passed: true }], changedPaths: [path] } }).run,
  { eventId: 'integrate', actor: 'captain' }).run
}
async function fixture(t, { summaryOnly = false, manualEvidence = false } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'dependency-input-dispatch-'))
  const stateRoot = join(workspace, '.expert-teams'), calls = [], disposers = []
  const source = { id: 't1', subject: 'reviewed source', status: 'completed', assignee: 'captain', attempt: 1, dependencies: [], createdAt: 1, updatedAt: 1 }
  const consumer = { id: 't2', subject: 'consumer', status: 'pending', assignee: 'worker', dependencies: ['t1'], createdAt: 1, updatedAt: 1 }
  const team = { id: 'team', name: 'team', captainSessionId: 'captain', createdAt: 1,
    members: [{ id: 'worker', name: 'worker', joinedAt: 1, status: 'idle' }], tasks: [source, consumer], taskSeq: 2 }
  await createTeamDir(stateRoot, team)
  source.project = await createTaskProject(stateRoot, team.id, source)
  consumer.project = await createTaskProject(stateRoot, team.id, consumer)
  const content = summaryOnly ? JSON.stringify({ output: 'Control dependency complete' }) : 'independently reviewed version'
  const artifact = summaryOnly || manualEvidence ? undefined : await publishTaskArtifact(stateRoot, team, source, { name: 'report.md', content })
  if (artifact) source.publishedArtifacts = [artifact]
  if (manualEvidence) await writeFile(join(stateRoot, team.id, source.project.artifactsPath, 'report.md'), content)
  team.qualityRuns = { t1: reviewedRun(team, source, manualEvidence ? { reviewId: 'manual-report', relativePath: 'report.md' } : artifact, content) }
  await writeTeam(stateRoot, team)
  const agents = new Map(['captain', 'worker'].map(id => [id, { id, status: 'idle', session: { header: { id, cwd: workspace }, events: [] },
    inbox: { hasPending: false, nextStep: [], nextTurn: [] }, steer(message) { this.inbox.nextStep.push(message) } }]))
  const ctx = { agents: { get: id => agents.get(id) }, logger: { warn() {} }, on() {},
    effect(setup) { disposers.push(setup()) }, subagents: { async followup(_captain, id, messages) { calls.push({ id, messages }); agents.get(id).inbox.hasPending = true } } }
  const reload = () => installTeamScheduler(ctx, { stateDir: '.expert-teams' })
  t.after(async () => { for (const dispose of disposers) dispose(); await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) })
  return { workspace, stateRoot, team, source, consumer, artifact, content, calls, agents, reload, scheduler: reload(),
    read: () => readTeam(stateRoot, team.id), path: artifact && join(stateRoot, team.id, source.project.artifactsPath, artifact.relativePath),
    async edit(fn) { const fresh = await readTeam(stateRoot, team.id); await fn(fresh, fresh.tasks[1]); await writeTeam(stateRoot, fresh) },
    async readyForRetry() { agents.get('worker').inbox.hasPending = false; await this.edit((fresh, task) => { fresh.members[0].activation = undefined; task.dispatch = undefined; task.executionState = 'interrupted' }) },
  }
}

test('actual first dispatch pins reviewed versions in durable task, input JSON and assignment; cold retry keeps them', async t => {
  const f = await fixture(t)
  await f.scheduler.kickMember(f.workspace, 'team', 'worker')
  assert.equal(f.calls.length, 1)
  const task = (await f.read()).tasks[1]
  assert.deepEqual(task.inputArtifactBinding, { mode: 'dependency-default', consumerAttempt: 1 })
  assert.deepEqual(task.inputArtifacts, [{ sourceTaskId: 't1', artifactId: f.artifact.id }])
  const manifest = task.inputArtifactManifest
  assert.equal(manifest[0].sha256, f.artifact.sha256)
  assert.equal(manifest[0].versionPath, f.path)
  assert.ok(isAbsolute(manifest[0].versionPath))
  const input = JSON.parse(await readFile(join(f.stateRoot, 'team', task.project.inputPath), 'utf8'))
  assert.deepEqual(input.inputArtifactManifest, manifest)
  assert.deepEqual(input.inputArtifactBinding, task.inputArtifactBinding)
  const prompt = f.calls[0].messages.map(item => item.text ?? '').join('\n')
  for (const expected of [f.artifact.id, f.artifact.sha256, f.path, 'expert_teams_read_artifact(task_id="t2"']) assert.ok(prompt.includes(expected), expected)
  // A mutable working copy is not this publication. A spurious later published
  // version also cannot move a previously dispatched consumer's pins.
  await writeFile(join(f.stateRoot, 'team', f.source.project.path, 'artifacts/report.md'), 'later working copy')
  await f.edit(async fresh => {
    const source = fresh.tasks[0]
    source.publishedArtifacts.push(await publishTaskArtifact(f.stateRoot, fresh, source, { name: 'report.md', content: 'later publication' }))
  })
  await f.readyForRetry()
  await f.reload().kickMember(f.workspace, 'team', 'worker')
  const retried = (await f.read()).tasks[1]
  assert.equal(f.calls.length, 2)
  assert.equal(retried.attemptId, task.attemptId)
  assert.deepEqual(retried.inputArtifactManifest, manifest)
  assert.equal((await readAllowedTaskArtifact(f.stateRoot, await f.read(), retried, retried.inputArtifacts[0])).content, f.content)
})

test('corrupt first input persists a blocker and chosen identity; idle kicks and cold restart do not deliver or notify repeatedly', async t => {
  const f = await fixture(t)
  await writeFile(f.path, 'corrupted')
  await f.scheduler.kickMember(f.workspace, 'team', 'worker')
  let task = (await f.read()).tasks[1]
  assert.equal(task.executionState, 'blocked_external')
  assert.match(task.waitReason, /INPUT_ARTIFACT_BLOCKED:.*hash mismatch/)
  assert.equal(task.attemptId, undefined)
  assert.equal(task.inputArtifacts[0].artifactId, f.artifact.id)
  assert.deepEqual(JSON.parse(await readFile(join(f.stateRoot, 'team', task.project.inputPath), 'utf8')).inputArtifacts, task.inputArtifacts)
  for (let i = 0; i < 3; i++) await f.reload().kickMember(f.workspace, 'team', 'worker')
  assert.equal(f.calls.length, 0)
  assert.equal((await readMailbox(f.stateRoot, 'team', 'captain')).filter(message => message.content.includes('INPUT_ARTIFACT_BLOCKED')).length, 1)
  await writeFile(f.path, f.content)
  await f.edit((_team, task) => { task.executionState = 'active'; task.waitReason = undefined }) // explicit captain resume boundary
  await f.reload().kickMember(f.workspace, 'team', 'worker')
  task = (await f.read()).tasks[1]
  assert.equal(f.calls.length, 1)
  assert.equal(task.inputArtifactManifest[0].artifactId, f.artifact.id)
})

test('corruption after dispatch is caught at read and redispatch; durable manifest survives the blocker', async t => {
  const f = await fixture(t)
  await f.scheduler.kickMember(f.workspace, 'team', 'worker')
  const before = (await f.read()).tasks[1]
  await writeFile(f.path, 'different bytes')
  await assert.rejects(readAllowedTaskArtifact(f.stateRoot, await f.read(), before, before.inputArtifacts[0]), /hash mismatch/)
  await f.readyForRetry()
  await f.reload().kickMember(f.workspace, 'team', 'worker')
  const blocked = (await f.read()).tasks[1]
  assert.equal(blocked.executionState, 'blocked_external')
  assert.deepEqual(blocked.inputArtifactManifest, before.inputArtifactManifest)
  await f.reload().recoverWorkspace(f.workspace)
  assert.equal(f.calls.length, 1)
})

test('a reviewed summary-only dependency dispatches without invented file inputs', async t => {
  const f = await fixture(t, { summaryOnly: true })
  await f.scheduler.kickMember(f.workspace, 'team', 'worker')
  assert.equal(f.calls.length, 1)
  assert.deepEqual((await f.read()).tasks[1].inputArtifacts, [])
})

test('missing promised published deliverable cannot be mistaken for a summary-only dependency', async t => {
  const f = await fixture(t)
  await f.edit(fresh => { fresh.tasks[0].publishedArtifacts = [] })
  await f.scheduler.kickMember(f.workspace, 'team', 'worker')
  const task = (await f.read()).tasks[1]
  assert.equal(f.calls.length, 0)
  assert.equal(task.executionState, 'blocked_external')
  assert.match(task.waitReason, /INPUT_PUBLICATION_MISSING/)
})

test('a real quality repair opens a new consumer generation and refreshes only automatic binding generation', async t => {
  const f = await qualityPublicationFixture(t)
  const team = await f.read(), task = team.tasks[0]
  // No dependencies is a legitimate empty automatic manifest; the generation
  // must still survive the registered review -> repair lifecycle.
  await prepareDependencyInputs(f.stateRoot, team, task, 1)
  task.inputArtifacts = []
  task.inputArtifactBinding = { mode: 'dependency-default', consumerAttempt: 1 }
  task.inputArtifactManifest = []
  await f.write(team)
  await f.call('quality_review', { task_id: 't1', event_id: 'needs-repair', reviewer: 'reviewer', verdict: 'needs_revision',
    acceptance_results: [{ id: 'present', passed: false }], findings: [{ id: 'missing', code: 'MISSING', severity: 'hard',
      message: 'The task output needs correction', taskId: 't1', attempt: 1 }] }, 'reviewer')
  const repair = await f.call('quality_repair', { task_id: 't1', event_id: 'repair', actor: 'captain' }, 'captain')
  assert.equal(repair.attempt, 2)
  const repaired = await f.read()
  assert.equal(repaired.tasks[0].inputArtifactBinding.consumerAttempt, 2, 'actual scheduler opens attempt 2 and refreshes automatic binding before accepted delivery')
  assert.equal(repaired.tasks[0].attempt, 2)
})


test('legacy integrated manual-file evidence retains its prior workflow with durable unpinned warnings', async t => {
  const f = await fixture(t, { manualEvidence: true })
  await f.scheduler.kickMember(f.workspace, 'team', 'worker')
  const task = (await f.read()).tasks[1]
  assert.equal(f.calls.length, 1)
  assert.equal(task.status, 'claimed')
  assert.deepEqual(task.inputArtifacts, [])
  assert.deepEqual(task.inputArtifactManifest, [])
  assert.deepEqual(task.inputArtifactBinding.legacyUnpinnedSources, ['t1'])
  const input = JSON.parse(await readFile(join(f.stateRoot, 'team', task.project.inputPath), 'utf8'))
  assert.deepEqual(input.inputArtifactBinding, task.inputArtifactBinding)
  assert.match(input.inputArtifactWarnings.join(' '), /no immutable publication pin/)
  assert.match(f.calls[0].messages.map(item => item.text ?? '').join(' '), /no immutable publication pin/)
})

test('the same manual-file contract stays blocked in a structured team and cannot claim fixed publication protection', async t => {
  const f = await fixture(t, { manualEvidence: true })
  await f.edit(team => { team.structuredQualityPolicy = { required: true, maxRepairRounds: 2 } })
  await f.scheduler.kickMember(f.workspace, 'team', 'worker')
  const task = (await f.read()).tasks[1]
  assert.equal(f.calls.length, 0)
  assert.equal(task.status, 'pending')
  assert.equal(task.executionState, 'blocked_external')
  assert.match(task.waitReason, /INPUT_PUBLICATION_MISSING/)
  assert.equal(task.inputArtifactBinding?.legacyUnpinnedSources, undefined)
})


for (const published of [false, true]) test(`explicit review opt-out preserves default workflow without reviewed-pin claims (published=${published})`, async t => {
  const f = await fixture(t)
  await f.edit(team => {
    team.structuredQualityPolicy = { required: false, maxRepairRounds: 2 }
    delete team.qualityRuns
    if (!published) delete team.tasks[0].publishedArtifacts
  })
  await f.scheduler.kickMember(f.workspace, 'team', 'worker')
  const task = (await f.read()).tasks[1]
  assert.equal(f.calls.length, 1)
  assert.equal(task.status, 'claimed')
  assert.deepEqual(task.inputArtifacts, [])
  assert.equal(task.inputArtifactBinding.reviewDisabled, true)
  assert.equal(task.inputArtifactBinding.legacyUnpinnedSources, undefined)
  const input = JSON.parse(await readFile(join(f.stateRoot, 'team', task.project.inputPath), 'utf8'))
  assert.equal(input.inputArtifactBinding.reviewDisabled, true)
  assert.match(input.inputArtifactWarnings.join(' '), /explicitly disabled.*no reviewed-version guarantee/)
  assert.match(f.calls[0].messages.map(item => item.text ?? '').join(' '), /explicitly disabled/)
})

test('review opt-out does not bypass explicit publication pins or their hash validation', async t => {
  const f = await fixture(t)
  await f.edit((team, task) => {
    team.structuredQualityPolicy = { required: false, maxRepairRounds: 2 }
    delete team.qualityRuns
    task.inputArtifacts = [{ sourceTaskId: 't1', artifactId: f.artifact.id }]
  })
  await writeFile(f.path, 'corrupted explicit publication')
  await f.scheduler.kickMember(f.workspace, 'team', 'worker')
  const task = (await f.read()).tasks[1]
  assert.equal(f.calls.length, 0)
  assert.equal(task.executionState, 'blocked_external')
  assert.match(task.waitReason, /hash mismatch/)
  assert.equal(task.inputArtifactBinding, undefined)
  assert.equal(task.inputArtifactManifest[0].sha256, f.artifact.sha256)
})
