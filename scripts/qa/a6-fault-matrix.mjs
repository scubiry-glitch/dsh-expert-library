/**
 * A6 hermetic fault-injection matrix.
 *
 * This runner only writes under a temporary directory and uses sentinel
 * values.  It exercises the durable state/quality primitives without a real
 * provider, model, DSH profile, network, or credential.  The output is a
 * machine-readable evidence receipt so a host run can be attached later.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  admitTeamMessage,
  archiveTeamDir,
  assertTeamRunnable,
  beginTaskAttempt,
  createMessage,
  createTeamDir,
  haltTeam,
  readArchivedTeam,
  readMailbox,
  readTeam,
  resumeTeam,
  appendMailbox,
  withTeamLock,
  writeTeam,
} from '../../lib/state.js'
import {
  createStagedPlan,
  editStagedPlan,
  recoverStagedPlans,
  transitionStagedPlan,
  writeStagedPlan,
} from '../../lib/staged-plan.js'
import {
  createQualityContract,
  createQualityRun,
  integrateQualityRun,
  requestQualityRepair,
  reviewQualityRun,
} from '../../lib/quality-run.js'
import { canonicalDigest } from '../../lib/v2/digest.js'

const now = 1_700_000_000_000

function result(id, passed, detail) {
  return { id, passed, ...(detail === undefined ? {} : { detail }) }
}

function fakePlan(planId = 'plan-a6') {
  const digest = canonicalDigest({ planId, templateId: 'a6-fixture', tasks: ['t1'] })
  return {
    planId,
    templateId: 'a6-fixture',
    templateVersion: '1.0.0',
    digest,
    roster: [],
    tasks: [],
    inputs: [],
    deliverables: [],
    gates: [],
  }
}

function baseTeam(id = 'team-a6') {
  return {
    name: 'A6 fault matrix', id, captainSessionId: 'captain-a6', createdAt: now,
    members: [],
    tasks: [{ id: 't1', subject: 'fault target', status: 'pending', dependencies: [], createdAt: now, updatedAt: now }],
    taskSeq: 1,
  }
}

function evidence(taskId, attempt) {
  const content = `evidence-${attempt}`
  return {
    taskId,
    attempt,
    artifacts: [{
      id: 'report', taskId, attempt, path: 'src/result.txt', content,
      sha256: createHash('sha256').update(content).digest('hex'),
    }],
    acceptanceResults: [{ id: 'a1', passed: true }],
    commandsRun: [{ command: 'node --version', exitCode: 0, passed: true }],
    changedPaths: ['src/result.txt'],
  }
}

function qualityContract(maxRepairRounds = 1) {
  return createQualityContract({
    id: 'a6-quality', taskId: 't1', attempt: 1, assignee: 'worker', kind: 'verification',
    objective: 'verify a local artifact', inScope: ['src/**'], outOfScope: ['secrets/**'],
    acceptance: [{ id: 'a1', statement: 'artifact is verified' }], verify: ['node --version'],
    deliverables: ['report'], changedPaths: ['src/result.txt'], maxRepairRounds,
  })
}

async function runWorker(root, workerId) {
  const stateModule = new URL('../../lib/state.js', import.meta.url).href
  const code = `import { readFile, writeFile } from 'node:fs/promises'; import { withTeamLock } from ${JSON.stringify(stateModule)}; const root=process.argv[1]; const id=process.argv[2]; await withTeamLock('team:'+root+':claim', async()=>{ const file=root+'/claim.json'; const state=JSON.parse(await readFile(file,'utf8')); state.attempts+=1; await new Promise(r=>setTimeout(r,15)); if(state.status==='pending'){state.status='claimed'; state.winner=id;} await writeFile(file,JSON.stringify(state)); }); process.stdout.write(id);`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, root, workerId], { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', codeValue => codeValue === 0 ? resolve() : reject(new Error(`worker ${workerId} exited ${codeValue}: ${stderr}`)))
  })
}

async function commandInjectionProbe(root) {
  const marker = join(root, 'injected-marker')
  const argument = `safe;touch ${marker}`
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', argument], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`command probe exited ${code}`)))
  })
  assert.equal(output, argument)
  await assert.rejects(readFile(marker), error => error?.code === 'ENOENT')
}

/** Execute all offline A6 cases and return a durable evidence summary. */
export async function runFaultMatrix() {
  const root = await mkdtemp(join(tmpdir(), 'expert-library-a6-fault-'))
  const cases = []
  try {
    // Approval CAS conflict: an edit changes both digest and revision, so an
    // approval receipt for the old snapshot cannot be reused.
    const staged = createStagedPlan({ planId: 'a6-cas', plan: fakePlan('a6-cas'), request: { scenarioId: 'fixture' }, runtime: { teamName: 'A6', description: 'fixture' }, createdBy: 'qa', expiresAt: now + 60_000, now })
    const approved = transitionStagedPlan(staged, 'approved', { actor: 'qa', now: now + 1 })
    const edited = editStagedPlan(staged, { plan: fakePlan('a6-cas-edit'), request: { scenarioId: 'fixture', revision: 'changed' }, runtime: { teamName: 'A6', description: 'fixture' }, fields: ['request.revision'], actor: 'qa', now: now + 2 })
    assert.notEqual(edited.digest, approved.approval.digest)
    assert.notEqual(edited.revision, approved.approval.revision)
    cases.push(result('approve-cas-conflict', true))

    // Cross-process claim/commit serialization.
    await writeFile(join(root, 'claim.json'), JSON.stringify({ status: 'pending', winner: null, attempts: 0 }))
    await Promise.all(['one', 'two', 'three', 'four'].map(id => runWorker(root, id)))
    const claim = JSON.parse(await readFile(join(root, 'claim.json'), 'utf8'))
    assert.equal(claim.status, 'claimed')
    assert.match(claim.winner, /^(one|two|three|four)$/)
    assert.equal(claim.attempts, 4)
    cases.push(result('concurrent-claim-lock', true))

    // Old attempt provenance is rejected after a retry opens a new generation.
    const team = baseTeam('attempt-team')
    const firstAttempt = beginTaskAttempt(team.tasks[0], 'worker')
    const old = createMessage('worker', 'captain', 'old', { sourceTaskId: 't1', sourceAttemptId: firstAttempt, sourceTaskStatus: 'claimed' })
    beginTaskAttempt(team.tasks[0], 'worker-2')
    assert.deepEqual(admitTeamMessage(team, old), { accepted: false, reason: 'stale_attempt' })
    cases.push(result('old-attempt-rejected', true))

    // A malformed mailbox line is retained for diagnostics but does not block
    // valid messages from being read or appended.
    await mkdir(join(root, 'mail-team', 'inbox'), { recursive: true })
    await writeFile(join(root, 'mail-team', 'inbox', 'worker.jsonl'), '{not-json}\n')
    await appendMailbox(root, 'mail-team', 'worker', createMessage('captain', 'worker', 'valid'))
    const malformed = []
    const mailbox = await readMailbox(root, 'mail-team', 'worker', line => malformed.push(line))
    assert.equal(mailbox.length, 1)
    assert.deepEqual(malformed, [1])
    cases.push(result('bad-mailbox-recovery', true))

    // Restart recovery turns an orphan running plan into an explicit failure;
    // it is never silently re-spawned.
    const running = transitionStagedPlan(staged, 'approved', { actor: 'qa', now: now + 1 })
    const runningPlan = transitionStagedPlan(running, 'running', { now: now + 2 })
    await writeStagedPlan(root, runningPlan)
    const recovered = await recoverStagedPlans(root, now + 3)
    assert.equal(recovered.find(item => item.planId === 'a6-cas')?.status, 'failed')
    cases.push(result('kill-restart-recovery', true))

    // Halt is durable and explicit resume is required before task mutation.
    const haltedTeam = baseTeam('halt-team')
    await createTeamDir(root, haltedTeam)
    const halted = await haltTeam(root, haltedTeam.id, 'fault injection pause')
    assert.throws(() => assertTeamRunnable(halted), /TEAM_HALTED/)
    const resumed = await resumeTeam(root, haltedTeam.id, 'fault injection resume')
    assert.doesNotThrow(() => assertTeamRunnable(resumed))
    cases.push(result('halt-resume', true))

    // Independent review failure -> repair -> budget exhaustion is explicit;
    // duplicate events are idempotent and cannot add another round.
    let quality = createQualityRun(qualityContract(1), 'a6-quality-run')
    const rejected = reviewQualityRun(quality, {
      eventId: 'review-1', reviewer: 'reviewer', verdict: 'needs_revision',
      findings: [{ id: 'finding-1', code: 'missing-proof', severity: 'hard', message: 'proof missing', taskId: 't1', attempt: 1 }],
      evidence: evidence('t1', 1), at: now,
    })
    quality = rejected.run
    assert.equal(quality.status, 'blocked')
    assert.equal(reviewQualityRun(quality, {
      eventId: 'review-1', reviewer: 'reviewer', verdict: 'needs_revision',
      findings: [{ id: 'finding-1', code: 'missing-proof', severity: 'hard', message: 'proof missing', taskId: 't1', attempt: 1 }],
      evidence: evidence('t1', 1), at: now,
    }).applied, false)
    quality = requestQualityRepair(quality, { eventId: 'repair-1', actor: 'worker', at: now + 1 }).run
    assert.equal(quality.status, 'repairing')
    const escalated = reviewQualityRun(quality, {
      eventId: 'review-2', reviewer: 'reviewer', verdict: 'reject',
      findings: [{ id: 'finding-2', code: 'still-broken', severity: 'hard', message: 'still broken', taskId: 't1', attempt: 2 }],
      evidence: evidence('t1', 2), at: now + 2,
    }).run
    assert.equal(escalated.status, 'escalated')
    assert.throws(() => requestQualityRepair(escalated, { eventId: 'repair-2', actor: 'worker' }), /only blocked runs|repair budget is exhausted/)
    assert.throws(() => integrateQualityRun(escalated, { eventId: 'integrate-1', actor: 'captain' }), /requires a passed review/)
    cases.push(result('quality-review-repair-budget-idempotency', true))

    // Archive is a durable move, preserving the complete team record.
    const archiveTeam = baseTeam('archive-team')
    await createTeamDir(root, archiveTeam)
    await writeTeam(root, archiveTeam)
    await archiveTeamDir(root, archiveTeam.id)
    assert.equal(await readTeam(root, archiveTeam.id), undefined)
    assert.equal((await readArchivedTeam(root, archiveTeam.id))?.id, archiveTeam.id)
    cases.push(result('archive-receipt', true))

    await commandInjectionProbe(root)
    cases.push(result('short-process-command-injection', true))

    return { schemaVersion: 1, kind: 'a6-fault-matrix', generatedAt: new Date().toISOString(), root, cases, passed: cases.length }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFaultMatrix().then(summary => {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
