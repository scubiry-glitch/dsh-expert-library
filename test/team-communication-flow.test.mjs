import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerExpertTeamsTools } from '../lib/tools.js'
import { createQualityContract, createQualityRun } from '../lib/quality-run.js'
import { appendMailbox, createMessage, readMailbox, readUnreadMailbox } from '../lib/state.js'

const artifactChanged = error => error?.code === 'artifact_changed'
  || /QUALITY_(?:ARTIFACT|OUTPUT)_MISMATCH/.test(error?.message ?? '')

// Exercise the real registered tools, scheduler, filesystem and verifier. Only
// the Host transport/agents are substituted; no model or business API is used.
function fakeHost(workspace) {
  const tools = new Map()
  const agents = new Map()
  const deliveries = []
  const deliveryAttempts = []
  const faults = { rejectDelivery: false }
  for (const name of ['captain', 'worker', 'reviewer', 'replacement', 'publisher']) {
    agents.set(`${name}-id`, {
      id: `${name}-id`, status: 'idle', whenIdle: async () => {},
      session: { header: { cwd: workspace }, events: [], append() {}, steer() {} },
    })
  }
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool) } },
    agents: { get(id) { return agents.get(id) } },
    logger: { debug() {}, info() {}, warn() {} },
    subagents: {
      registerContinuableSetup() { return () => undefined }, list: () => [], listChildren: async () => [], listDescendants: async () => [],
      async followup(_parent, childId, content) {
        deliveryAttempts.push({ childId })
        if (faults.rejectDelivery) throw new Error('injected transport outage')
        deliveries.push({ childId, text: content.map(block => block.text ?? '').join('\n') })
      },
      getProvider: () => undefined,
      startContinuable: async () => { throw new Error('unexpected model spawn') },
      interrupt() {},
    },
    effect() {}, on() {},
  }
  const { scheduler } = registerExpertTeamsTools(ctx, {
    stateDir: '.expert-teams', memberProvider: 'spawn', maxMembers: 8,
    knowledgeDir: 'knowledge', packsDir: 'domain-packs',
  })
  return {
    agents, deliveries, deliveryAttempts, faults, scheduler,
    schema(name) { return tools.get(`expert_teams_${name}`).parameters },
    render(name, value) {
      return tools.get(`expert_teams_${name}`).output.render({}, value).map(block => block.text ?? '').join('\n')
    },
    async call(name, args, caller = 'captain') {
      const tool = tools.get(`expert_teams_${name}`)
      assert.ok(tool, `registered tool expert_teams_${name}`)
      const agent = agents.get(`${caller}-id`)
      return tool.execute(args, { agent, session: agent.session, signal: new AbortController().signal })
    },
  }
}

async function fixture(t, { realArtifact = true } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'team-communication-flow-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const stateRoot = join(workspace, '.expert-teams')
  const teamId = 'communication-flow'
  const teamRoot = join(stateRoot, teamId)
  const tasks = [['t1', 'worker', []], ['t2', 'publisher', ['t1']]].map(([id, assignee, dependencies]) => ({
    id, subject: id === 't1' ? 'Prepare verified data' : 'Publish the approved data',
    status: 'pending', assignee, dependencies, attempt: 0, createdAt: 1, updatedAt: 1,
    project: {
      path: `expert-tasks/${id}`, inputPath: `expert-tasks/${id}/input/task.json`,
      outputPath: `expert-tasks/${id}/output/result.json`, artifactsPath: `expert-tasks/${id}/artifacts`, version: 1,
    },
  }))
  const qualityRuns = {}
  for (const task of tasks) {
    const scope = `${teamId}/${task.project.path}`
    const paths = [`${scope}/output/result.json`, ...(realArtifact ? [`${scope}/artifacts/report.txt`] : [])]
    const contract = createQualityContract({
      id: `flow-${task.id}-contract`, taskId: task.id, attempt: 1, assignee: task.assignee,
      kind: 'implementation', objective: task.subject, inScope: [`${scope}/**`],
      acceptance: [{ id: 'present', statement: 'The required artifact exists and is independently reviewed' }],
      verify: ['node --version'], deliverables: realArtifact ? ['task-output', 'report'] : ['task-output'],
      changedPaths: paths, maxRepairRounds: 2,
    })
    qualityRuns[task.id] = createQualityRun(contract, `flow-${task.id}-run`)
    for (const directory of ['input', 'output', 'artifacts']) {
      await mkdir(join(teamRoot, task.project.path, directory), { recursive: true })
    }
    await writeFile(join(teamRoot, task.project.inputPath), JSON.stringify({ taskId: task.id }))
    await writeFile(join(teamRoot, task.project.outputPath), JSON.stringify({ taskId: task.id, status: 'pending', attempt: 0 }))
    if (realArtifact) await writeFile(join(teamRoot, task.project.artifactsPath, 'report.txt'), `data-${task.id}-v1\n`)
  }
  await mkdir(join(teamRoot, 'inbox'), { recursive: true })
  await writeFile(join(teamRoot, 'team.json'), JSON.stringify({
    id: teamId, name: teamId, captainSessionId: 'captain-id', createdAt: 1,
    members: ['worker', 'reviewer', 'replacement', 'publisher'].map(name => ({ id: `${name}-id`, name, joinedAt: 1, status: 'idle' })),
    tasks, taskSeq: tasks.length, qualityRun: qualityRuns.t1, qualityRuns,
  }))
  const f = {
    workspace, stateRoot, teamId, teamRoot, realArtifact, host: fakeHost(workspace),
    read: async () => JSON.parse(await readFile(join(teamRoot, 'team.json'), 'utf8')),
    artifact: id => join(teamRoot, `expert-tasks/${id}/artifacts/report.txt`),
    output: async id => JSON.parse(await readFile(join(teamRoot, `expert-tasks/${id}/output/result.json`), 'utf8')),
    async submit(id = 't1', summary = 'Ready for independent review') {
      const task = (await f.read()).tasks.find(item => item.id === id)
      return f.host.call('update_task', {
        task_id: id, attempt_id: task.attemptId, status: 'in_progress', output: summary,
        execution_state: 'awaiting_review', wait_reason: 'Independent reviewer must verify the artifact',
      }, task.assignee)
    },
    async review(id, eventId, verdict = 'pass') {
      const state = await f.read()
      const task = state.tasks.find(item => item.id === id)
      const prefix = `${teamId}/${task.project.path}`
      return f.host.call('quality_review', {
        task_id: id, event_id: eventId, reviewer: 'reviewer', verdict,
        artifacts: [
          { id: 'task-output', path: `${prefix}/output/result.json` },
          ...(realArtifact ? [{ id: 'report', path: `${prefix}/artifacts/report.txt` }] : []),
        ],
        acceptance_results: [{ id: 'present', passed: true }],
        changed_paths: state.qualityRuns[id].contract.changedPaths,
        findings: verdict === 'pass' ? [] : [{
          id: `${eventId}-finding`, code: 'needs-correction', severity: 'hard',
          message: 'Correct the data before publication', taskId: id, attempt: task.attempt,
        }],
      }, 'reviewer')
    },
    integrate: (id, eventId, completeTask = true) => f.host.call('quality_integrate', {
      task_id: id, event_id: eventId, actor: 'captain', complete_task: completeTask,
    }),
  }
  return f
}

test('multi-member flow waits across restart, repairs once, integrates and unlocks its dependent task', async t => {
  const f = await fixture(t)
  await f.host.scheduler.kickTeam(f.workspace, f.teamId)
  let state = await f.read()
  assert.equal(state.tasks[0].status, 'claimed')
  assert.equal(state.tasks[1].status, 'pending')
  const firstAttempt = state.tasks[0].attemptId
  assert.equal(f.host.deliveries.filter(item => item.childId === 'worker-id').length, 1)
  assert.equal(f.host.deliveries.filter(item => item.childId === 'publisher-id').length, 0)

  await f.submit()
  state = await f.read()
  assert.equal(state.tasks[0].executionState, 'awaiting_review')
  assert.ok(state.tasks[0].waitReason)
  await assert.rejects(() => f.host.call('claim_task', { task_id: 't2' }, 'publisher'), /dependencies/)

  // A fresh runtime has no cooldown memory. Waiting must be durable, rather
  // than appearing correct only while the original dispatch timer is warm.
  f.host = fakeHost(f.workspace)
  for (let i = 0; i < 3; i++) await f.host.scheduler.recoverWorkspace(f.workspace)
  assert.equal(f.host.deliveries.length, 0)
  assert.equal((await f.read()).tasks[0].attemptId, firstAttempt)

  assert.equal((await f.review('t1', 'reject-data-v1', 'needs_revision')).status, 'blocked')
  await f.host.call('quality_repair', { task_id: 't1', event_id: 'repair-data-v1', actor: 'captain' })
  state = await f.read()
  assert.equal(state.qualityRuns.t1.attempt, 2)
  assert.equal(state.tasks[0].attempt, state.qualityRuns.t1.attempt)
  assert.notEqual(state.tasks[0].attemptId, firstAttempt)
  await assert.rejects(() => f.host.call('update_task', {
    task_id: 't1', attempt_id: firstAttempt, output: 'late obsolete data',
  }, 'worker'), /stale attempt/)

  await writeFile(f.artifact('t1'), 'data-t1-v2-corrected\n')
  await f.submit('t1', 'Corrected data ready')
  assert.equal((await f.review('t1', 'accept-data-v2')).status, 'passed')
  // A summary-only edit does not invalidate reviewed real artifact bytes.
  await f.submit('t1', 'Corrected data ready; review has passed')
  await f.integrate('t1', 'integrate-data-v2')
  state = await f.read()
  assert.equal(state.qualityRuns.t1.status, 'integrated')
  assert.equal(state.tasks[0].status, 'completed')
  assert.equal(state.tasks[0].attemptId, undefined)
  assert.equal((await f.output('t1')).status, 'completed')
  assert.equal(state.tasks[1].status, 'claimed')
  assert.equal(f.host.deliveries.filter(item => item.childId === 'publisher-id').length, 1)

  await f.submit('t2', 'Publication prepared from the approved data')
  await f.review('t2', 'accept-publication')
  await f.integrate('t2', 'integrate-publication')
  // Replayed completion must not re-dispatch a finished team.
  const deliveries = f.host.deliveries.length
  await f.integrate('t2', 'integrate-publication')
  await f.host.scheduler.kickTeam(f.workspace, f.teamId)
  state = await f.read()
  assert.ok(state.tasks.every(task => task.status === 'completed'))
  assert.ok(Object.values(state.qualityRuns).every(run => run.status === 'integrated'))
  assert.equal(f.host.deliveries.length, deliveries)
})

test('reviewed artifact changes block both integration and completion; reopen and reassignment restore a valid review path', async t => {
  const f = await fixture(t)
  await f.host.scheduler.kickTeam(f.workspace, f.teamId)
  await f.submit()
  await f.review('t1', 'original-review')
  await writeFile(f.artifact('t1'), 'changed-after-review\n')
  await assert.rejects(() => f.integrate('t1', 'reject-stale-integration'), artifactChanged)
  assert.equal((await f.read()).qualityRuns.t1.status, 'passed')

  await f.host.call('quality_reopen', { task_id: 't1', event_id: 'reopen-passed', reason: 'Incorporate corrected source data' })
  await f.submit('t1', 'Corrected source data')
  await f.review('t1', 'corrected-review')
  await f.integrate('t1', 'integrate-before-last-correction', false)
  await writeFile(f.artifact('t1'), 'changed-after-integration\n')
  const before = await f.read()
  await assert.rejects(() => f.host.call('update_task', {
    task_id: 't1', attempt_id: before.tasks[0].attemptId, status: 'completed',
  }, 'worker'), artifactChanged)
  assert.notEqual((await f.read()).tasks[0].status, 'completed')

  await f.host.call('reassign_task', { task_id: 't1', assignee: 'replacement', reason: 'A different worker validates the final correction' })
  let state = await f.read()
  assert.equal(state.tasks[0].assignee, 'replacement')
  assert.equal(state.qualityRuns.t1.contract.assignee, 'replacement')
  assert.equal(state.qualityRuns.t1.attempt, state.tasks[0].attempt)
  assert.notEqual(state.qualityRuns.t1.status, 'integrated')
  assert.match(JSON.stringify(state), /original-review/, 'prior independent evidence remains auditable')
  await assert.rejects(() => f.host.call('update_task', {
    task_id: 't1', attempt_id: before.tasks[0].attemptId, output: 'old worker writes late',
  }, 'worker'), /assigned to|stale attempt/)
  await f.submit('t1', 'Replacement worker validated the final correction')
  await f.review('t1', 'replacement-review')
  await f.integrate('t1', 'integrate-replacement')
  state = await f.read()
  assert.equal(state.tasks[0].status, 'completed')
  assert.equal(state.qualityRuns.t1.status, 'integrated')
  assert.equal(state.tasks[1].status, 'claimed')
})

test('legacy task-output-only evidence still protects the reviewed summary', async t => {
  const f = await fixture(t, { realArtifact: false })
  await f.host.scheduler.kickTeam(f.workspace, f.teamId)
  await f.submit('t1', 'Legacy reviewed result')
  await f.review('t1', 'legacy-review')
  await f.submit('t1', 'Different legacy result')
  await assert.rejects(() => f.integrate('t1', 'legacy-invalid-integration'), /QUALITY_OUTPUT_MISMATCH/)
  assert.equal((await f.read()).qualityRuns.t1.status, 'passed')
  assert.notEqual((await f.read()).tasks[0].status, 'completed')
})

test('failed live delivery survives runtime restart and a duplicate send does not repeat the message', async t => {
  const f = await fixture(t)
  f.host.faults.rejectDelivery = true
  const args = { to: 'reviewer', content: 'Please review the durable data artifact', idempotency_key: 'review-request-1' }
  const first = await f.host.call('send_message', args)
  assert.equal(first.delivered, 'mailbox')
  assert.equal((await readUnreadMailbox(f.stateRoot, f.teamId, 'reviewer')).length, 1)

  f.host = fakeHost(f.workspace)
  await f.host.scheduler.kickMember(f.workspace, f.teamId, 'reviewer')
  assert.equal(f.host.deliveries.length, 1)
  assert.match(f.host.deliveries[0].text, /Please review the durable data artifact/)
  assert.equal((await readUnreadMailbox(f.stateRoot, f.teamId, 'reviewer')).length, 0)
  const repeated = await f.host.call('send_message', args)
  assert.equal(repeated.message_id, first.message_id)
  await f.host.scheduler.kickMember(f.workspace, f.teamId, 'reviewer')
  assert.equal(f.host.deliveries.length, 1)
  const mailbox = await readMailbox(f.stateRoot, f.teamId, 'reviewer')
  assert.equal(mailbox.length, 1)
  assert.equal(mailbox[0].id, first.message_id)
})

test('captain and member status acknowledge only the visible first page and render complete message text', async t => {
  const f = await fixture(t)
  await f.host.call('halt', { reason: 'Inspect mailbox pagination without scheduler delivery' })
  const contents = Array.from({ length: 12 }, (_, index) => `message-${index}: ${'long text '.repeat(35)}END-${index}`)
  for (const recipient of ['captain', 'worker']) {
    for (const content of contents) await appendMailbox(f.stateRoot, f.teamId, recipient, createMessage('reviewer', recipient, content))
  }
  for (const recipient of ['captain', 'worker']) {
    const first = await f.host.call('status', {}, recipient)
    assert.equal(first.inbox_pending_count, 12)
    assert.deepEqual(first.inbox.map(message => message.content), contents.slice(0, 10))
    assert.ok(f.host.render('status', first).includes(contents[0]), 'render must include text after the first 200 characters')
    assert.deepEqual((await readUnreadMailbox(f.stateRoot, f.teamId, recipient)).map(message => message.content), contents.slice(10))
    if (recipient === 'captain') assert.equal((await readUnreadMailbox(f.stateRoot, f.teamId, 'worker')).length, 12)
    const second = await f.host.call('status', {}, recipient)
    assert.equal(second.inbox_pending_count, 2)
    assert.deepEqual(second.inbox.map(message => message.content), contents.slice(10))
    assert.ok(f.host.render('status', second).includes(contents[11]))
    assert.equal((await readUnreadMailbox(f.stateRoot, f.teamId, recipient)).length, 0)
  }
  assert.equal(f.host.deliveries.length, 0)
})

test('chat retries preserve one round and one delivery across restart, and conflicting reuse is rejected', async t => {
  const f = await fixture(t)
  const args = { member: 'reviewer', content: 'Explain the source of the corrected value', idempotency_key: 'clarification-1' }
  const first = await f.host.call('chat', args)
  assert.equal(first.round, 1)
  assert.equal(first.delivered, 'wake')
  assert.equal(f.host.deliveries.length, 1)
  const repeated = await f.host.call('chat', args)
  assert.equal(repeated.message_id, first.message_id)
  assert.equal(repeated.round, 1)
  assert.equal(f.host.deliveries.length, 1)

  f.host = fakeHost(f.workspace)
  const recoveredRetry = await f.host.call('chat', args)
  assert.equal(recoveredRetry.message_id, first.message_id)
  assert.equal(recoveredRetry.round, 1)
  assert.equal(f.host.deliveries.length, 0)
  await assert.rejects(() => f.host.call('chat', { ...args, content: 'A different question with the same retry key' }), /idempotency|conflict/i)
  assert.equal((await f.read()).members.find(member => member.name === 'reviewer').chatRounds, 1)
  assert.equal((await readMailbox(f.stateRoot, f.teamId, 'reviewer')).length, 1)
})

test('published versions retain their bytes and only an authorized downstream task can page through its pinned input', async t => {
  const f = await fixture(t)
  await f.host.scheduler.kickTeam(f.workspace, f.teamId)
  const task = (await f.read()).tasks[0]
  const args = { task_id: 't1', attempt_id: task.attemptId, source_path: 'artifacts/report.txt', name: 'shared-data.txt', media_type: 'text/plain' }
  await assert.rejects(() => f.host.call('publish_artifact', args, 'reviewer'), /ARTIFACT_STALE_OWNER/)
  await assert.rejects(() => f.host.call('publish_artifact', { ...args, attempt_id: 'stale-attempt' }, 'worker'), /ARTIFACT_STALE_OWNER/)
  await assert.rejects(() => f.host.call('publish_artifact', { ...args, source_path: '../output/result.json' }, 'worker'), /relative project path/)

  const firstContent = 'old version: αβγ and reproducible evidence\n'
  await writeFile(f.artifact('t1'), firstContent)
  const first = await f.host.call('publish_artifact', args, 'worker')
  await writeFile(f.artifact('t1'), 'new version: corrected evidence\n')
  const second = await f.host.call('publish_artifact', args, 'worker')
  assert.notEqual(first.artifact_id, second.artifact_id)
  assert.notEqual(first.path, second.path)
  assert.equal(await readFile(join(f.stateRoot, first.path), 'utf8'), firstContent)
  assert.equal(await readFile(join(f.stateRoot, second.path), 'utf8'), 'new version: corrected evidence\n')

  const pin = { source_task_id: 't1', artifact_id: first.artifact_id, purpose: 'Compare the previous evidence version' }
  await assert.rejects(() => f.host.call('create_task', { subject: 'Invalid undeclared dependency', assignee: 'replacement', input_artifacts: [pin] }), /dependency/)
  await assert.rejects(() => f.host.call('create_task', {
    subject: 'Invalid unknown artifact', assignee: 'replacement', dependencies: ['t1'],
    input_artifacts: [{ ...pin, artifact_id: 'missing-publication' }],
  }), /unknown published input artifact/)
  const downstream = await f.host.call('create_task', {
    subject: 'Read the pinned old evidence', assignee: 'replacement', dependencies: ['t1'], input_artifacts: [pin],
  })
  const readArgs = { task_id: downstream.task_id, source_task_id: 't1', artifact_id: first.artifact_id, offset: 0, limit: 8 }
  await assert.rejects(() => f.host.call('read_artifact', readArgs, 'replacement'), /not completed/)
  await f.submit()
  await assert.rejects(() => f.host.call('publish_artifact', args, 'worker'), /waiting for review/)
  await f.review('t1', 'publication-review')
  await f.integrate('t1', 'publication-integration')

  assert.equal((await f.read()).tasks.find(item => item.id === downstream.task_id).status, 'claimed')
  await assert.rejects(() => f.host.call('read_artifact', readArgs, 'reviewer'), /another task project/)
  await assert.rejects(() => f.host.call('read_artifact', { ...readArgs, artifact_id: second.artifact_id }, 'replacement'), /allowlisted/)
  await assert.rejects(() => f.host.call('read_artifact', { ...readArgs, limit: 16001 }, 'replacement'), /pagination/)
  const page1 = await f.host.call('read_artifact', readArgs, 'replacement')
  assert.equal(page1.content, firstContent.slice(0, 8))
  assert.equal(page1.next_offset, 8)
  const page2 = await f.host.call('read_artifact', { ...readArgs, offset: page1.next_offset, limit: 16000 }, 'replacement')
  assert.equal(page1.content + page2.content, firstContent)
  assert.equal(page2.next_offset, null)
  assert.equal(page2.sha256, first.sha256)
})

test('default output-only contracts automatically review the latest publication and require fresh publication after repair', async t => {
  const f = await fixture(t, { realArtifact: false })
  await f.host.scheduler.kickTeam(f.workspace, f.teamId)
  const source = join(f.teamRoot, 'expert-tasks/t1/artifacts/metrics.csv')
  const publish = async content => {
    await writeFile(source, content)
    const task = (await f.read()).tasks[0]
    return f.host.call('publish_artifact', {
      task_id: 't1', attempt_id: task.attemptId, source_path: 'artifacts/metrics.csv', name: 'metrics.csv', media_type: 'text/csv',
    }, task.assignee)
  }
  const first = await publish('value\n10\n')
  const latest = await publish('value\n20\n')
  assert.notEqual(first.artifact_id, latest.artifact_id)
  assert.ok((await f.read()).qualityRuns.t1.contract.deliverables.includes('published:metrics.csv'))
  assert.ok(!(f.host.schema('quality_review').required ?? []).includes('artifacts'), 'artifact discovery must also be optional in the actual tool schema')
  const review = async (eventId, verdict = 'pass', artifacts) => {
    const task = (await f.read()).tasks[0]
    return f.host.call('quality_review', {
      task_id: 't1', event_id: eventId, reviewer: 'reviewer', verdict,
      acceptance_results: [{ id: 'present', passed: true }],
      ...(artifacts === undefined ? {} : { artifacts }),
      findings: verdict === 'pass' ? [] : [{ id: `${eventId}-finding`, code: 'correct-source', severity: 'hard', message: 'Validate the corrected source', taskId: 't1', attempt: task.attempt }],
    }, 'reviewer')
  }
  await f.submit('t1', 'Latest published metrics ready for review')
  await assert.rejects(() => review('review-superseded-same-attempt', 'pass', [
    { id: 'published:metrics.csv', path: first.path },
  ]), /PUBLISHED_EVIDENCE_MISMATCH/)
  await review('review-published-v2', 'needs_revision')
  let state = await f.read()
  let evidence = state.qualityRuns.t1.latestEvidence.artifacts.find(artifact => artifact.id === 'published:metrics.csv')
  assert.equal(evidence.path, latest.path)
  assert.equal(evidence.sha256, latest.sha256)
  assert.equal(evidence.content, 'value\n20\n')
  await f.host.call('quality_repair', { task_id: 't1', event_id: 'repair-publication', actor: 'captain' })
  state = await f.read()
  assert.equal(state.qualityRuns.t1.attempt, 2)
  assert.equal(state.tasks[0].attempt, 2, 'an explicit repair must dispatch its new generation despite the old generation cooldown')
  const missingCurrentPublication = error => /publish|publication|artifact|attempt/i.test(error?.message ?? '')
  await assert.rejects(() => review('review-missing-current-publication'), missingCurrentPublication)
  await assert.rejects(() => review('review-explicit-old-publication', 'pass', [
    { id: 'task-output', path: `${f.teamId}/expert-tasks/t1/output/result.json` },
    { id: 'published:metrics.csv', path: latest.path },
  ]), missingCurrentPublication)

  const corrected = await publish('value\n30\n')
  assert.equal(corrected.attempt, 2)
  await f.submit('t1', 'Corrected metrics republished under the current attempt')
  await review('review-current-publication')
  state = await f.read()
  evidence = state.qualityRuns.t1.latestEvidence.artifacts.find(artifact => artifact.id === 'published:metrics.csv')
  assert.equal(evidence.path, corrected.path)
  assert.equal(evidence.sha256, corrected.sha256)
  assert.equal(evidence.attempt, 2)
  await f.integrate('t1', 'integrate-current-publication')
  assert.equal((await f.read()).tasks[0].status, 'completed')
})

test('members cannot clear review or external waiting with a plain active update', async t => {
  const f = await fixture(t)
  await f.host.scheduler.kickTeam(f.workspace, f.teamId)
  let task = (await f.read()).tasks[0]
  await f.host.call('update_task', {
    task_id: 't1', attempt_id: task.attemptId, status: 'in_progress',
    execution_state: 'blocked_external', wait_reason: 'Await a verified source from the captain',
  }, 'worker')
  await assert.rejects(() => f.host.call('update_task', {
    task_id: 't1', attempt_id: task.attemptId, execution_state: 'active',
  }, 'worker'), /captain|resume|waiting|blocked_external/i)
  assert.equal((await f.read()).tasks[0].executionState, 'blocked_external')
  await f.host.call('resume_task', { task_id: 't1', reason: 'The verified source has arrived' })
  task = (await f.read()).tasks[0]
  assert.equal(task.executionState, 'active')
  await f.submit()
  await assert.rejects(() => f.host.call('update_task', {
    task_id: 't1', attempt_id: task.attemptId, execution_state: 'active',
  }, 'worker'), /captain|review|resume|waiting/i)
  assert.equal((await f.read()).tasks[0].executionState, 'awaiting_review')
})

test('captain can resume a pending input-blocked task only after its artifact preflight succeeds', async t => {
  const f = await fixture(t, { realArtifact: false })
  await f.host.scheduler.kickTeam(f.workspace, f.teamId)
  const original = 'verified source data\n'
  await writeFile(f.artifact('t1'), original)
  const upstream = (await f.read()).tasks[0]
  const published = await f.host.call('publish_artifact', {
    task_id: 't1', attempt_id: upstream.attemptId, source_path: 'artifacts/report.txt', name: 'input.txt', media_type: 'text/plain',
  }, 'worker')
  await f.submit()
  await f.review('t1', 'review-input-producer')
  await f.integrate('t1', 'integrate-input-producer')
  // Fault injection targets only this temporary published snapshot.
  await writeFile(join(f.stateRoot, published.path), 'corrupted bytes\n')
  const downstream = await f.host.call('create_task', {
    subject: 'Consume verified input', assignee: 'replacement', dependencies: ['t1'],
    input_artifacts: [{ source_task_id: 't1', artifact_id: published.artifact_id }],
  })
  const taskState = async () => (await f.read()).tasks.find(task => task.id === downstream.task_id)
  let task = await taskState()
  assert.equal(task.status, 'pending')
  assert.equal(task.executionState, 'blocked_external')
  assert.equal(task.attempt, 0)
  assert.equal(f.host.deliveries.filter(item => item.childId === 'replacement-id').length, 0)
  await f.host.call('resume_task', { task_id: downstream.task_id, reason: 'Recheck the externally blocked input' })
  task = await taskState()
  assert.equal(task.status, 'pending')
  assert.equal(task.executionState, 'blocked_external')
  assert.equal(task.attempt, 0)
  assert.equal(f.host.deliveries.filter(item => item.childId === 'replacement-id').length, 0)

  await writeFile(join(f.stateRoot, published.path), original)
  await f.host.call('resume_task', { task_id: downstream.task_id, reason: 'The original verified artifact bytes have been restored' })
  task = await taskState()
  assert.equal(task.status, 'claimed')
  assert.equal(task.executionState, 'active')
  assert.equal(task.attempt, 1)
  const delivered = f.host.deliveries.filter(item => item.childId === 'replacement-id')
  assert.equal(delivered.length, 1)
  assert.ok(delivered[0].text.includes(published.artifact_id))
  assert.ok(delivered[0].text.includes(published.sha256))
})

test('a refused first assignment keeps one durable generation through repeated kicks and restart', async t => {
  const f = await fixture(t)
  f.host.faults.rejectDelivery = true
  await f.host.scheduler.kickTeam(f.workspace, f.teamId)
  const first = (await f.read()).tasks[0]
  assert.equal(first.status, 'claimed', 'transport rejection must not rewind the task into a fresh-attempt loop')
  assert.equal(first.attempt, 1)
  assert.ok(first.attemptId)
  for (let i = 0; i < 4; i++) await f.host.scheduler.kickTeam(f.workspace, f.teamId)
  assert.equal((await f.read()).tasks[0].attempt, 1)
  assert.equal((await f.read()).tasks[0].attemptId, first.attemptId)
  assert.equal(f.host.deliveryAttempts.length, 1)

  f.host = fakeHost(f.workspace)
  await f.host.scheduler.recoverWorkspace(f.workspace)
  assert.equal((await f.read()).tasks[0].attemptId, first.attemptId)
  assert.equal(f.host.deliveryAttempts.length, 0, 'restart must retain the failed attempt retry cooldown')
  await f.host.call('resume_task', { task_id: 't1', reason: 'The assignment transport is available again' })
  const resumed = (await f.read()).tasks[0]
  assert.equal(resumed.attempt, 1)
  assert.equal(resumed.attemptId, first.attemptId)
  assert.equal(f.host.deliveryAttempts.length, 1)
  assert.equal(f.host.deliveries.length, 1)
})
