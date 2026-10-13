import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQualityRun, reviewQualityRun, integrateQualityRun } from '../lib/quality-run.js'
import { completeHumanChoice, readHumanChoice } from '../lib/human-choice.js'
import { prepareDependencyInputs } from '../lib/dependency-inputs.js'
import { planDispatch } from '../lib/scheduler.js'
import { createTeamDir, createTaskProject, publishTaskArtifact, readTeam, syncTaskProjectInput, unsatisfiedDependencies, writeTeam } from '../lib/state.js'
import { parseProfile, profileToExecutionPlan } from '../lib/profiles.js'
import { expandExecutionPlan } from '../lib/apply.js'
import { outlineTaskGuidance, requireReportOutline } from '../lib/plan-review.js'

const digest = text => createHash('sha256').update(text).digest('hex')

test('plan approval accepts an outline produced and reviewed before every report task', () => {
  const source = { id: 'draft', dependsOn: [], produces: ['outline.md'], artifactInputs: [] }
  const gate = { id: 'review', dependsOn: ['draft'], humanChoice: { sourceTaskId: 'draft', artifact: 'outline.md', options: ['确认', '修改'] }, artifactInputs: [{ fromTask: 'draft', artifact: 'outline.md', purpose: 'review' }] }
  const writer = { id: 'write', dependsOn: ['review'], artifactInputs: [{ fromTask: 'review', artifact: 'task-output', purpose: 'approved outline' }] }
  const report = { id: 'report', dependsOn: ['write'], reportBundle: {}, artifactInputs: [{ fromTask: 'write', artifact: 'draft.md', purpose: 'render' }] }
  const plan = { template: { version: '1' }, tasks: [source, gate, writer, report] }
  assert.doesNotThrow(() => requireReportOutline(plan))
  assert.throws(() => requireReportOutline({ ...plan, tasks: [source, gate, { ...writer, dependsOn: [] }, report] }), /PLAN_OUTLINE_REQUIRED/)
  assert.throws(() => requireReportOutline({ ...plan, tasks: [{ ...source, produces: [] }, gate, writer, report] }), /PLAN_OUTLINE_REQUIRED/)
  assert.throws(() => requireReportOutline({ ...plan, tasks: [source, gate, writer, { ...report, artifactInputs: undefined }] }), /PLAN_ARTIFACT_INPUTS_REQUIRED/)
})

test('deep research profile contains a user gate and figure-to-render artifact dependency', async () => {
  const draft = JSON.parse(await readFile('/root/.openclaw/workspace/98wiki/projects/深度研究团队DAG-v1.json', 'utf8'))
  const plan = profileToExecutionPlan(parseProfile(draft.profile))
  const choice = plan.tasks.find(task => task.id === 'outline_choice')
  const figures = plan.tasks.find(task => task.id === 'point_figures')
  const render = plan.tasks.find(task => task.id === 'renderer')
  const stagedPlan = { ...plan, reportOutline: draft.report_outline }
  requireReportOutline(stagedPlan)
  assert.match(outlineTaskGuidance(stagedPlan, 'renderer'), /provisional.*OUTLINE\.md/u)
  assert.doesNotMatch(outlineTaskGuidance(stagedPlan, 'renderer'), /Approved report outline/u)
  assert.deepEqual(choice.humanChoice.options, ['A', 'B', 'C', 'A+C'])
  assert.deepEqual(figures.produces, ['figure-spec.md', 'figure-fragments.html'])
  assert.ok(render.dependsOn.includes('point_figures'))
  assert.deepEqual(render.artifactInputs.filter(input => input.fromTask === 'point_figures').map(input => input.artifact), ['figure-spec.md', 'figure-fragments.html'])
  // Skill craft is frozen by stage/Host. Strip only the bundle to exercise the
  // pure physical DAG expansion before that Host material step.
  const physical = expandExecutionPlan({ ...plan, tasks: plan.tasks.map(task => task.id === 'renderer'
    ? { ...task, reportBundle: undefined, produces: ['report.md', 'report.html', 'report.pdf', 'craft-evidence.json', 'reference-map.json'] }
    : task) }, { teamName: 'test', description: 'test' })
  assert.ok(physical.tasks.find(task => task.logicalId === 'renderer').dependsOn.includes(physical.tasks.find(task => task.logicalId === 'point_figures').id))
})

test('reviewed candidate stays blocked until Host choice binds its SHA and unlocks downstream', async t => {
  const root = await mkdtemp(join(tmpdir(), 'human-choice-dag-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, '.expert-teams')
  const now = Date.now()
  const source = { id: 't1', subject: 'candidate outlines', status: 'completed', assignee: 'captain', attempt: 1, dependencies: [], createdAt: now, updatedAt: now }
  const gate = { id: 't2', subject: 'choose', status: 'pending', assignee: 'captain', attempt: 0, dependencies: ['t1'], humanChoice: { sourceTaskId: 't1', artifact: 'outline-candidates.md', options: ['A', 'B', 'C'] }, createdAt: now, updatedAt: now }
  const downstream = { id: 't3', subject: 'research', status: 'pending', assignee: 'captain', attempt: 0, dependencies: ['t1', 't2'], plannedArtifactInputs: [
    { fromTask: 't1', artifact: 'outline-candidates.md', purpose: 'candidate', phase: 'work' },
    { fromTask: 't2', artifact: 'task-output', purpose: 'choice', phase: 'work' },
  ], createdAt: now, updatedAt: now }
  const team = { id: 'team', name: 'team', captainSessionId: 'captain', createdAt: now, members: [], tasks: [source, gate, downstream], taskSeq: 3, structuredQualityPolicy: { required: true, maxRepairRounds: 2 } }
  await createTeamDir(stateRoot, team)
  for (const task of team.tasks) task.project = await createTaskProject(stateRoot, team.id, task)
  const content = '# A\nMain line\n# B\nRisk line\n# C\nTimeline'
  const artifact = await publishTaskArtifact(stateRoot, team, source, { name: 'outline-candidates.md', content })
  source.publishedArtifacts = [artifact]
  const path = `${team.id}/${source.project.artifactsPath}/${artifact.relativePath}`
  const base = createQualityRun({ id: 'candidate-review', taskId: source.id, attempt: 1, assignee: 'captain', kind: 'implementation', objective: 'review outlines', inScope: [`${team.id}/**`], acceptance: [{ id: 'verified', statement: 'verified' }], verify: ['node --version'], deliverables: [artifact.reviewId], changedPaths: [path] })
  const reviewed = reviewQualityRun(base, { eventId: 'review-candidates', reviewer: 'independent', verdict: 'pass', evidence: { taskId: source.id, attempt: 1, artifacts: [{ id: artifact.reviewId, path, taskId: source.id, attempt: 1, content, sha256: digest(content) }], acceptanceResults: [{ id: 'verified', passed: true }], commandsRun: [{ command: 'node --version', exitCode: 0, passed: true }], changedPaths: [path] } }).run
  team.qualityRuns = { t1: integrateQualityRun(reviewed, { eventId: 'integrate-candidates', actor: 'captain' }).run }
  await writeTeam(stateRoot, team)
  assert.deepEqual(unsatisfiedDependencies(team.tasks, downstream.dependencies), ['t2'])
  assert.deepEqual(planDispatch(gate, 'captain', undefined), { blocked: true })
  const preview = await readHumanChoice(stateRoot, team, gate)
  assert.equal(preview.content, content)
  const unreviewed = await publishTaskArtifact(stateRoot, team, source, { name: 'outline-candidates.md', content: `${content}\n# revision` })
  source.publishedArtifacts.push(unreviewed)
  await assert.rejects(readHumanChoice(stateRoot, team, gate), /HUMAN_CHOICE_SOURCE_NOT_REVIEWED/)
  source.publishedArtifacts.pop()
  await assert.rejects(completeHumanChoice(stateRoot, team, gate, 'A', digest('stale')), /HUMAN_CHOICE_STALE_SOURCE/)
  await assert.rejects(completeHumanChoice(stateRoot, team, gate, 'D', artifact.sha256), /HUMAN_CHOICE_INVALID_OPTION/)
  await completeHumanChoice(stateRoot, team, gate, 'B', artifact.sha256)
  const restored = await readTeam(stateRoot, team.id)
  assert.equal(restored.tasks[1].status, 'completed')
  assert.equal(restored.tasks[1].humanChoiceReceipt.choice, 'B')
  assert.equal(restored.tasks[1].humanChoiceReceipt.sourceSha256, artifact.sha256)
  assert.deepEqual(unsatisfiedDependencies(restored.tasks, restored.tasks[2].dependencies), [])
  await prepareDependencyInputs(stateRoot, restored, restored.tasks[2], 1)
  await syncTaskProjectInput(stateRoot, restored, restored.tasks[2])
  const input = JSON.parse(await readFile(join(stateRoot, team.id, restored.tasks[2].project.inputPath), 'utf8'))
  assert.equal(input.humanChoices[0].choice, 'B')
  assert.equal(input.inputArtifactManifest[0].sha256, artifact.sha256)
  await assert.rejects(completeHumanChoice(stateRoot, restored, restored.tasks[1], 'A', artifact.sha256), /HUMAN_CHOICE_ALREADY_DECIDED/)
})
