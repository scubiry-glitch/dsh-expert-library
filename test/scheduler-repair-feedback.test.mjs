import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installTeamScheduler } from '../lib/scheduler.js'
import { createQualityRun, reviewQualityRun, requestQualityRepair, qualityContractDigest, REPORT_CRAFT_RESULT_IDS, INDEPENDENT_REVIEW_AREA_IDS } from '../lib/quality-run.js'
import { createTaskProject, createTeamDir, readTeam, writeTeam } from '../lib/state.js'
import { qualityPublicationFixture } from './support/quality-publication-fixture.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

function repairingRun({ rounds = 1, message = 'Replace the wrong denominator and regenerate the report.', checks = false } = {}) {
  const ids = checks ? ['report.md', 'report.html', 'report.pdf'] : ['report.md']
  let run = createQualityRun({ id: 'contract', taskId: 't1', assignee: 'worker', attempt: 1,
    objective: 'Deliver correct work', kind: 'implementation', inScope: ids, changedPaths: ids,
    acceptance: [{ id: 'correct', statement: 'The denominator is verified' }], verify: ['check-result'],
    deliverables: ids, maxRepairRounds: 2,
    ...(checks ? { artifactChecks: [{ id: 'zhijian-report-craft-core-v1', md: ids[0], html: ids[1], pdf: ids[2] }] } : {}),
  }, 'repair-run')
  for (let attempt = 1; attempt <= rounds; attempt++) {
    const artifacts = ids.map(id => ({ id, taskId: 't1', attempt, path: id,
      content: 'Original rejected content, not needed in the assignment', sha256: hash('Original rejected content, not needed in the assignment') }))
    const evidence = { taskId: 't1', attempt, artifacts,
      acceptanceResults: [{ id: 'correct', passed: false, detail: `Acceptance failure ${attempt}` }],
      commandsRun: [{ command: 'check-result', exitCode: 1, passed: false, output: `Verification failure ${attempt}` }], changedPaths: ids,
      ...(checks ? {
        artifactCheckReceipts: [{ version: 1, checkId: 'zhijian-report-craft-core-v1', contractDigest: qualityContractDigest(run.contract),
          taskId: 't1', attempt, artifacts: artifacts.map(({ id, sha256 }) => ({ id, sha256 })),
          results: REPORT_CRAFT_RESULT_IDS.map((id, index) => ({ id, status: ['failed', 'unverified', 'passed'][index], detail: `Machine result ${index}` })),
        }],
        independentReview: { materialReceiptId: 'test-preparation', reviewerSessionId: 'reviewer-id',
          areas: INDEPENDENT_REVIEW_AREA_IDS.map((id, index) => ({ id, status: ['failed', 'unverified', 'passed', 'passed'][index],
            coverage: `Review area ${index}`, evidence: [{ artifactId: 'report.md', quote: 'Original rejected content', reason: `Correction reason ${index}` }] })),
        },
      } : {}),
    }
    run = reviewQualityRun(run, { eventId: `review-${attempt}`, reviewer: 'reviewer', verdict: 'needs_revision',
      findings: [{ id: `finding-${attempt}`, taskId: 't1', attempt, code: 'wrong-number', severity: 'hard', message: attempt === 1 ? message : 'Another necessary correction' }], evidence }).run
    run = requestQualityRepair(run, { eventId: `repair-${attempt}`, actor: 'captain' }).run
  }
  return run
}

async function fixture(t, options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'repair-feedback-'))
  const stateRoot = join(workspace, '.expert-teams')
  const run = options.ordinary ? undefined : repairingRun(options)
  const task = { id: 't1', subject: 'Correct report', status: 'pending', assignee: 'worker',
    attempt: run ? run.attempt - 1 : 0, dependencies: [], createdAt: 1, updatedAt: 1 }
  task.project = await createTaskProject(stateRoot, 'team', task)
  const captain = { id: 'captain-id', status: 'idle', session: { header: { cwd: workspace }, events: [] }, inbox: { nextTurn: [], nextStep: [] } }
  const worker = { id: 'worker-id', status: 'idle', session: { header: { cwd: workspace }, events: [] }, inbox: { hasPending: false } }
  const calls = [], disposers = []
  const ctx = {
    agents: { get: id => id === captain.id ? captain : id === worker.id ? worker : undefined },
    subagents: { async followup(_captain, id, content) { calls.push({ id, content: content.map(part => part.type === 'text' ? part.text : '').join('\n') }); worker.inbox.hasPending = true } },
    logger: { warn() {} }, effect(setup) { disposers.push(setup()) }, on() {},
  }
  await createTeamDir(stateRoot, { id: 'team', name: 'team', captainSessionId: captain.id, createdAt: 1,
    members: [{ id: worker.id, name: 'worker', status: 'idle', joinedAt: 1 }], tasks: [task], taskSeq: 1,
    ...(run ? { qualityRun: run, qualityRuns: { t1: run } } : {}),
  })
  t.after(async () => { disposers.forEach(dispose => dispose?.()); await rm(workspace, { recursive: true, force: true }) })
  const load = () => installTeamScheduler(ctx, { stateDir: '.expert-teams' })
  return { workspace, stateRoot, run, worker, calls, load, captain,
    read: () => readTeam(stateRoot, 'team'), input: async () => JSON.parse(await readFile(join(stateRoot, 'team', task.project.inputPath), 'utf8')),
    kick: scheduler => scheduler.kickMember(workspace, 'team', 'worker', captain),
  }
}

function inlineFeedback(text) {
  const line = text.split('\n').find(line => line.startsWith('{"version":1,"taskId":"t1","runId":'))
  assert.ok(line, 'accepted assignment must include durable repair feedback, without waiting for a later captain message')
  return JSON.parse(line)
}

test('actual repair dispatch carries findings, failed checks, immutable evidence IDs and full input before any captain mail', async t => {
  const f = await fixture(t, { checks: true })
  await f.kick(f.load())
  assert.equal(f.calls.length, 1)
  const feedback = inlineFeedback(f.calls[0].content)
  const team = await f.read()
  assert.deepEqual(feedback, (await f.input()).repairFeedback)
  assert.equal(feedback.targetAttempt, team.tasks[0].attempt)
  assert.equal(feedback.reviewedAttempt, 1)
  assert.equal(feedback.findings[0].message, f.run.findings[0].message)
  assert.equal(feedback.failedAcceptance[0].statement, f.run.contract.acceptance[0].statement)
  assert.equal(feedback.failedVerification[0].output, 'Verification failure 1')
  assert.deepEqual(feedback.artifactChecks[0].results.map(row => row.status), ['failed', 'unverified'])
  assert.deepEqual(feedback.independentReview.map(row => row.status), ['failed', 'unverified'])
  assert.equal(feedback.independentReview[0].evidence[0].reason, 'Correction reason 0')
  assert.deepEqual(feedback.reviewedArtifacts, f.run.latestEvidence.artifacts.map(({ id, path, sha256, attempt }) => ({ id, path, sha256, attempt })))
  assert.equal(f.calls[0].content.includes('Original rejected content, not needed in the assignment'), false)
  assert.deepEqual(team.qualityRuns.t1, JSON.parse(JSON.stringify(f.run)), 'handoff never performs another repair/review or spends budget')
})

test('cold interrupted redelivery retains exact feedback and the same attempt capability without another repair', async t => {
  const f = await fixture(t)
  await f.kick(f.load())
  const original = await f.read()
  const first = inlineFeedback(f.calls[0].content)
  original.tasks[0].executionState = 'interrupted'
  original.tasks[0].dispatch = undefined
  await writeTeam(f.stateRoot, original)
  f.worker.inbox.hasPending = false
  await f.load().recoverWorkspace(f.workspace)
  assert.equal(f.calls.length, 2)
  assert.deepEqual(inlineFeedback(f.calls[1].content), first)
  assert.equal((await f.read()).tasks[0].attemptId, original.tasks[0].attemptId)
  assert.equal((await f.read()).qualityRuns.t1.repairRounds, 1)
})

test('a later repair retains earlier hard findings as history and binds the latest rejected attempt', async t => {
  const f = await fixture(t, { rounds: 2 })
  await f.kick(f.load())
  const feedback = inlineFeedback(f.calls[0].content)
  assert.equal(feedback.targetAttempt, 3)
  assert.equal(feedback.reviewedAttempt, 2)
  assert.deepEqual(feedback.findings.map(row => row.id), ['finding-2'])
  assert.deepEqual(feedback.priorFindings.map(row => row.id), ['finding-1'])
  assert.equal(feedback.failedAcceptance[0].detail, 'Acceptance failure 2')
  assert.equal(feedback.remainingRepairRounds, 0)
})

test('large repair feedback is delivered whole in task input with an exact bounded file receipt, never a truncated blocker', async t => {
  const message = '必须修复。'.repeat(3500) + 'CRITICAL-TAIL-INSTRUCTION'
  const f = await fixture(t, { message })
  await f.kick(f.load())
  const prompt = f.calls[0].content
  const input = await f.input(), raw = JSON.stringify(input.repairFeedback)
  assert.equal(input.repairFeedback.findings[0].message, message)
  assert.ok(prompt.includes(input.project.inputPath))
  assert.ok(prompt.includes(`sha256=${hash(raw)}`))
  assert.ok(prompt.includes(`${Buffer.byteLength(raw)} UTF-8 bytes`))
  assert.ok(Buffer.byteLength(prompt) < 10_000, 'the full file remains available without injecting all its bytes into the prompt')
  assert.match(prompt, /Read the complete feedback before/)
})

test('ordinary tasks carry no repair payload or unnecessary history', async t => {
  const f = await fixture(t, { ordinary: true })
  await f.kick(f.load())
  assert.equal((await f.input()).repairFeedback, undefined)
  assert.equal(f.calls[0].content.includes('Repair feedback for task'), false)
})

test('registered manual claim and status expose identical repair feedback and preserve real negative-review gates', async t => {
  const f = await qualityPublicationFixture(t)
  await f.publish('Rejected output')
  await f.call('quality_review', {
    task_id: 't1', event_id: 'review-negative', reviewer: 'reviewer', verdict: 'needs_revision',
    acceptance_results: [{ id: 'present', passed: false, detail: 'Needs the missing conclusion' }],
    findings: [{ id: 'missing-conclusion', code: 'missing', severity: 'hard', message: 'Add the source-backed conclusion before publishing.', taskId: 't1', attempt: 1 }],
  }, 'reviewer')
  await f.call('quality_repair', { task_id: 't1', event_id: 'repair-negative', actor: 'captain' }, 'captain')
  const claim = await f.call('claim_task', { task_id: 't1' }, 'worker')
  assert.ok(claim.repair_feedback?.includes('Add the source-backed conclusion before publishing.'))
  const status = await f.call('status', {}, 'worker')
  assert.equal(status.tasks[0].repair_feedback, claim.repair_feedback)
  const rendered = f.registered.get('expert_teams_status').output.render({}, status)
  assert.ok(JSON.stringify(rendered).includes('Add the source-backed conclusion before publishing.'))
  const input = JSON.parse(await readFile(join(f.teamRoot, 'expert-tasks/t1/input/task.json'), 'utf8'))
  assert.equal(input.repairFeedback.targetAttempt, claim.attempt)
  assert.equal(input.repairFeedback.findings[0].id, 'missing-conclusion')
  assert.equal((await f.read()).qualityRuns.t1.repairRounds, 1)
  await assert.rejects(f.call('quality_integrate', { task_id: 't1', event_id: 'illegal-integrate', actor: 'captain' }, 'captain'), /passed review/)
})

test('a stale task generation cannot receive another generation’s feedback on the registered status path', async t => {
  const f = await qualityPublicationFixture(t)
  const team = await f.read()
  team.qualityRuns.t1 = repairingRun()
  team.qualityRun = team.qualityRuns.t1
  team.tasks[0].attempt = 4
  await f.write(team)
  const snapshot = await f.call('status', {}, 'worker')
  assert.equal(snapshot.tasks[0].repair_feedback, undefined)
})
