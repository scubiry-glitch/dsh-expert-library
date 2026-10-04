/** Independent regression: legacy preset declarations must select a domain report contract. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerExpertTeamsTools, scenarioPreviewCore, scenarioStageCore, scenarioEditCore, scenarioApproveFromHost, scenarioApplyCore } from '../lib/tools.js'
import { readStagedPlan } from '../lib/staged-plan.js'
import { parseScenario } from '../lib/expert-library/registry.js'
import { createInstalledSkillCraftPack } from './support/skill-craft-fixture.mjs'

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'legacy-report-contract-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const selected = await createInstalledSkillCraftPack(join(workspace, 'domain-packs', 'synthetic-report'), { packId: 'synthetic-report', skills: [
    { id: 'write', artifactRoles: ['md', 'evidence'], body: 'Synthetic writing material.' },
    { id: 'render', artifactRoles: ['html', 'pdf'], requires: ['write'], body: 'Synthetic rendering material.' },
  ] })
  const starts = [], registered = new Map()
  const captain = { id: 'captain', options: { provider: 'test', model: 'm' }, session: { id: 'captain', header: { id: 'captain', cwd: workspace }, requestHeader: () => ({ config: { provider: 'test', model: 'm' } }),
    events: [{ type: 'user/message', seq: 1, data: { id: 'original', source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic original research request.' }] } }], append() {} } }
  const ctx = { tools: { register(tool) { registered.set(tool.name, tool) } }, logger: { debug() {}, info() {}, warn() {} },
    agents: { get: () => undefined, withInitiator: (_agent, action) => action() }, llm: { resolveCallConfig: async config => config },
    subagents: { registerContinuableSetup() { return () => undefined }, list: () => ['spawn'], listChildren: async () => [], listDescendants: async () => [],
      getProvider: () => ({ prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }),
      async startContinuable(input) { starts.push(input); return { childId: input.childId } }, async followup() {}, interrupt() {} }, effect() {}, on() {}, get() { return undefined } }
  const config = { stateDir: '.expert-teams', memberProvider: 'spawn', maxMembers: 8, knowledgeDir: 'knowledge', packsDir: 'domain-packs', enabledPacks: ['synthetic-report'] }
  const core = registerExpertTeamsTools(ctx, config), stateRoot = join(workspace, config.stateDir)
  const bundle = { md: 'report.md', html: 'report.html', pdf: 'report.pdf', craft: { version: 3, selections: selected.selections, evidence: 'proof.json' } }
  const signal = new AbortController().signal
  const args = { scenario: 'research-report', team_name: 'synthetic-report-team', goal: 'Synthetic bounded request', report_bundle: bundle }
  return { ...selected, workspace, stateRoot, starts, registered, captain, ctx, config, core, bundle, signal, args }
}
const stage = (f, args = f.args) => scenarioStageCore(f.ctx, f.config, f.captain, args)
const preview = (f, args = f.args) => scenarioPreviewCore(f.ctx, f.config, f.captain, args)
const apply = (f, args) => scenarioApplyCore(f.ctx, f.config, f.captain, args, f.signal, f.core)

test('declared legacy report preset rejects absent, v1 and v2 bundles at preview/stage/apply without side effects', async t => {
  const variants = [undefined, { md: 'r.md', html: 'r.html', pdf: 'r.pdf' }, { md: 'r.md', html: 'r.html', pdf: 'r.pdf', craft: { version: 2, style: 'designer-paper', evidence: 'proof.json' } }]
  for (const op of [preview, stage, apply]) for (const bundle of variants) {
    const f = await fixture(t), args = { scenario: 'research-report', ...(bundle === undefined ? {} : { report_bundle: bundle }) }
    await assert.rejects(op(f, args), /REPORT_SKILL_SELECTION_REQUIRED|report_bundle|reportBundle/)
    assert.equal(f.starts.length, 0)
    assert.deepEqual(await readdir(f.stateRoot).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), [])
  }
})

test('legacy report preview, stage, edit and approval bind the AI-selected combination to final t5', async t => {
  const f = await fixture(t), visible = await preview(f), first = await stage(f)
  const visibleFinal = visible.tasks.find(task => task.logical_id === 't5')
  assert.deepEqual(visibleFinal.reportBundle, f.bundle)
  assert.equal(visible.plan_id, first.planId)
  assert.equal(visible.digest, first.digest)
  const reportTask = first.plan.tasks.find(task => task.id === 't5')
  assert.equal(first.plan.tasks.filter(task => task.reportBundle !== undefined).length, 1)
  assert.deepEqual(reportTask.reportBundle, f.bundle)
  assert.deepEqual(reportTask.frozenSkillCraftContract.selections.map(skill => [skill.packId, skill.skillId]), [['synthetic-report', 'write'], ['synthetic-report', 'render']])
  const edit = await scenarioEditCore(f.ctx, f.config, f.captain, first.planId, { goal: 'Refined synthetic question' }, first.digest, first.revision)
  assert.notEqual(edit.digest, first.digest)
  assert.deepEqual(edit.plan.tasks.find(task => task.id === 't5').reportBundle, f.bundle, 'omitted selection survives an ordinary edit')
  const replacement = { ...f.bundle, md: 'revised.md' }
  const revised = await scenarioEditCore(f.ctx, f.config, f.captain, edit.planId, { report_bundle: replacement }, edit.digest, edit.revision)
  assert.notEqual(revised.digest, edit.digest)
  assert.deepEqual(revised.plan.tasks.find(task => task.id === 't5').reportBundle, replacement)
  const done = await scenarioApproveFromHost(f.ctx, f.config, f.captain, revised.planId, f.signal, f.core, revised.digest, revised.revision)
  const team = JSON.parse(await readFile(join(f.stateRoot, done.appliedTeamId, 'team.json'), 'utf8'))
  const final = team.tasks.find(task => task.planTask.logicalId === 't5')
  assert.deepEqual(final.reportBundle, replacement)
  assert.deepEqual(team.qualityRuns[final.id].contract.artifactChecks[0].selection, revised.plan.tasks.find(task => task.id === 't5').frozenSkillCraftContract)
  assert.equal(team.qualityRuns[final.id].status, 'pending')
  assert.equal((await readStagedPlan(f.stateRoot, first.planId)).status, 'completed')
})

test('ordinary legacy scenario is not reclassified by report keywords in a user goal', async t => {
  const f = await fixture(t)
  const result = await stage(f, { scenario: 'market-research', goal: 'Mention research-report, HTML and reportBundle in a synthetic comparison.' })
  assert.ok(result.plan.tasks.every(task => task.reportBundle === undefined))
  assert.equal(result.waitingFor, 'user-confirmation')
  assert.equal(f.starts.length, 0)
})

test('legacy report does not auto-select a renderer when the explicit combination lacks output coverage', async t => {
  const f = await fixture(t)
  const partial = { ...f.bundle, craft: { ...f.bundle.craft, selections: [f.bundle.craft.selections[0]] } }
  await assert.rejects(stage(f, { ...f.args, report_bundle: partial }), /OUTPUT_COVERAGE/)
  assert.equal(f.starts.length, 0)
})


test('workspace scenario parsing preserves an explicit final report index and rejects invalid indexes', () => {
  const input = { id: 'declared-report', name: 'Declared report', description: 'Synthetic preset', experts: ['researcher'],
    tasks: Array.from({ length: 5 }, (_, index) => ({ subject: `Synthetic task ${index + 1}`, expert: 'researcher' })), deliverable: 'Synthetic report', reportTaskIndex: 4 }
  assert.equal(parseScenario(input)?.reportTaskIndex, 4)
  assert.equal(parseScenario({ ...input, reportTaskIndex: 0 })?.reportTaskIndex, 0)
  for (const reportTaskIndex of [-1, 5, 1.5, '4', null, NaN]) assert.equal(parseScenario({ ...input, reportTaskIndex }), undefined)
})
