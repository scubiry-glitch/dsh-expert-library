/**
 * Pure tests for the ExecutionPlan → TeamRuntime expansion boundary
 * (`expandExecutionPlan` in src/apply.ts): logical tasks fan out into one
 * physical task per expertId, dependencies map to ALL physical ids of the
 * upstream logical tasks, no-expert tasks stay unassigned (shared pool),
 * interpolation covers plan.params + adapter interpolations + per-expert
 * derived keys, members dedupe by expertId with an optional strict
 * memberOrder, and the same plan always expands identically. Runs against
 * the built `lib/` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { compileExecutionPlan, buildLegacyDomainPack } from '../lib/v2/index.js'
import { expandExecutionPlan, compileErrorOf } from '../lib/apply.js'

/** Minimal V1 Expert fixture (same shape as the bridge tests). */
function expert(id) {
  return { id, name: `Expert ${id}`, role: 'research', background: '背景', principles: ['结论先行'], deliverables: ['研判稿'] }
}

/** Base validator-clean pack over a small expert set (no scenarios). */
function basePack() {
  return buildLegacyDomainPack({
    experts: ['researcher', 'data-analyst', 'designer'].map(expert),
    scenarios: [],
  })
}

/** Append a custom template + its output/quality refs to the pack. */
function pushTemplate(pack, template) {
  pack.teamTemplates.push(template)
  pack.outputTemplates.push({
    id: 'out', version: '1.0.0', schemaVersion: 2, media: ['markdown'],
    sections: [{ id: 's', required: true }], renderModes: { final: { anonymize: false } },
  })
  pack.qualityPolicies.push({ id: 'q', version: '1.0.0', schemaVersion: 2, gates: [], maxRepairRounds: 0 })
  return template
}

/** A template with single-expert, multi-expert and no-expert logical tasks. */
function fanoutTemplate(pack) {
  return pushTemplate(pack, {
    id: 'tpl-fanout', version: '1.0.0', schemaVersion: 2,
    slots: [
      { id: 'role.a', capabilities: [], cardinality: { min: 1, max: 1 } },
      { id: 'role.b', capabilities: [], cardinality: { min: 0, max: 3 } },
      { id: 'role.shared', capabilities: [], cardinality: { min: 0, max: 1 } },
    ],
    tasks: [
      { id: 't1', role: 'role.a', dependsOn: [], inputs: [], allowedCapabilities: [], outputSchema: 'out', retryPolicy: 'never', subject: '单专家任务（{expertId}）', description: '主题：{topic}' },
      { id: 't2', role: 'role.b', dependsOn: ['t1'], inputs: [], allowedCapabilities: [], outputSchema: 'out', retryPolicy: 'never', subject: '多专家任务（{expertId}）', description: '依赖上游：{dependencies}' },
      { id: 't3', role: 'role.shared', dependsOn: ['t1', 't2'], inputs: [], allowedCapabilities: [], outputSchema: 'out', retryPolicy: 'never', subject: '共享任务', description: '无专家' },
    ],
    gates: [],
    deliverables: [{ id: 'd1', outputTemplate: 'out', fromTasks: ['t1', 't2', 't3'] }],
  })
}

function compileFanout(assignments, params = { topic: 'T' }) {
  const pack = basePack()
  const template = fanoutTemplate(pack)
  return compileExecutionPlan({
    pack,
    templateId: template.id,
    params,
    binding: { assignments },
  })
}

// ── 1. Fan-out: one physical task per expertId, ids sequential ─────────────

test('single-expert task expands 1:1; multi-expert task fans out in roster order; no-expert task stays shared', () => {
  const result = compileFanout({ 'role.a': ['researcher'], 'role.b': ['data-analyst', 'designer'] })
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors))
  if (!result.ok) return
  const expanded = expandExecutionPlan(result.plan, { teamName: 'T', description: '' })

  // Physical ids t1..t4 in executionOrder, exactly the runtime convention.
  assert.deepEqual(expanded.tasks.map(task => task.id), ['t1', 't2', 't3', 't4'])
  // Fan-out: t2/t3 derive from the same logical task with fanOutIndex 0/1;
  // single-expert logical tasks also carry fanOutIndex 0; only zero-expert
  // (shared) tasks carry none.
  assert.deepEqual(expanded.tasks.map(task => task.logicalId), ['t1', 't2', 't2', 't3'])
  assert.deepEqual(expanded.tasks.map(task => task.fanOutIndex), [0, 0, 1, undefined])
  // Assignees: t1 researcher, t2 data-analyst, t3 designer, t4 shared (none).
  assert.deepEqual(expanded.tasks.map(task => task.assigneeExpertId), ['researcher', 'data-analyst', 'designer', undefined])
})

// ── 2. Dependencies map to ALL physical ids of upstream logical tasks ───────

test('physical dependencies cover every physical id of every upstream logical task, in creation order', () => {
  const result = compileFanout({ 'role.a': ['researcher'], 'role.b': ['data-analyst', 'designer'] })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const expanded = expandExecutionPlan(result.plan, { teamName: 'T', description: '' })
  assert.deepEqual(expanded.tasks[0]?.dependsOn, []) // t1: no deps
  assert.deepEqual(expanded.tasks[1]?.dependsOn, ['t1']) // t2 (data-analyst) ← t1
  assert.deepEqual(expanded.tasks[2]?.dependsOn, ['t1']) // t3 (designer) ← t1
  // t4 (shared) ← t1 + BOTH physical ids of logical t2.
  assert.deepEqual(expanded.tasks[3]?.dependsOn, ['t1', 't2', 't3'])
})

// ── 3. Interpolation ────────────────────────────────────────────────────────

test('interpolation merges plan.params + opts.interpolations + per-expert keys + {dependencies}', () => {
  const result = compileFanout({ 'role.a': ['researcher'], 'role.b': ['data-analyst', 'designer'] }, { topic: 'T', extra: 'X' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const expanded = expandExecutionPlan(result.plan, {
    teamName: 'T',
    description: '',
    interpolations: { extra: 'OVERRIDE' },
    expertDisplay: new Map([['researcher', { name: '王研', field: '宏观', initials: 'WY' }]]),
  })
  // plan.params topic; opts.interpolations override the params extra.
  assert.equal(expanded.tasks[0]?.subject, '单专家任务（researcher）')
  assert.equal(expanded.tasks[0]?.description, '主题：T')
  // Per-expert keys come from expertDisplay (name) or fall back to the id.
  assert.equal(expanded.tasks[1]?.subject, '多专家任务（data-analyst）')
  assert.equal(expanded.tasks[2]?.subject, '多专家任务（designer）')
  // {dependencies} = comma-joined physical dep ids of the upstream logical task.
  assert.equal(expanded.tasks[1]?.description, '依赖上游：t1')
  assert.equal(expanded.tasks[3]?.description, '无专家')
  // Per-expert name/field/initials placeholders (used by the review templates).
  const withDisplay = expandExecutionPlan(result.plan, {
    teamName: 'T', description: '',
    expertDisplay: new Map([['researcher', { name: '王研', field: '宏观', initials: 'WY' }]]),
  })
  assert.equal(withDisplay.tasks[0]?.subject, '单专家任务（researcher）')
})

test('unknown {key} tokens are left verbatim; non-string params are skipped', () => {
  const pack = basePack()
  const template = pushTemplate(pack, {
    id: 'tpl-tokens', version: '1.0.0', schemaVersion: 2,
    slots: [{ id: 'role.a', capabilities: [], cardinality: { min: 1, max: 1 } }],
    tasks: [
      { id: 't1', role: 'role.a', dependsOn: [], inputs: [], allowedCapabilities: [], outputSchema: 'out', retryPolicy: 'never',
        subject: '主题：{topic} 未知：{missing}',
        description: '列表：{list} 空：{empty}' },
    ],
    gates: [],
    deliverables: [{ id: 'd1', outputTemplate: 'out', fromTasks: ['t1'] }],
  })
  const result = compileExecutionPlan({
    pack,
    templateId: template.id,
    params: { topic: 'T', list: ['a', 'b'] },
    binding: { assignments: { 'role.a': ['researcher'] } },
  })
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors))
  if (!result.ok) return
  const expanded = expandExecutionPlan(result.plan, {
    teamName: 'T',
    description: '',
    interpolations: { empty: '' },
  })
  // {topic} resolves from params; {missing} stays verbatim; {list} is a
  // non-string param and is skipped; {empty} resolves to ''.
  assert.equal(expanded.tasks[0]?.subject, '主题：T 未知：{missing}')
  assert.equal(expanded.tasks[0]?.description, '列表：{list} 空：')
})

// ── 3b. compileErrorOf surfaces structured compile failures ────────────────

test('compileErrorOf turns a failed CompileResult into a structured Error', () => {
  const result = compileFanout({ 'role.a': ['ghost'], 'role.b': [] })
  assert.equal(result.ok, false)
  if (result.ok) return
  const error = compileErrorOf(result)
  assert.ok(error instanceof Error)
  assert.match(error.message, /编译团队方案失败/)
  assert.match(error.message, /roster/)
  assert.match(error.message, /unknown-expert/)
  assert.match(error.message, /ghost/)
})

// ── 4. Members: dedup by expertId, optional strict memberOrder ──────────────

test('members dedupe by expertId (first occurrence wins) across slots', () => {
  const result = compileFanout({ 'role.a': ['researcher'], 'role.b': ['researcher', 'designer'] })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const expanded = expandExecutionPlan(result.plan, { teamName: 'T', description: '' })
  assert.deepEqual(expanded.members.map(member => member.expertId), ['researcher', 'designer'])
})

test('memberOrder reorders members and validates coverage/uniqueness', () => {
  const result = compileFanout({ 'role.a': ['researcher'], 'role.b': ['data-analyst', 'designer'] })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const reordered = expandExecutionPlan(result.plan, { teamName: 'T', description: '', memberOrder: ['designer', 'researcher', 'data-analyst'] })
  assert.deepEqual(reordered.members.map(member => member.expertId), ['designer', 'researcher', 'data-analyst'])
  // Missing a roster expert → loud failure.
  assert.throws(() => expandExecutionPlan(result.plan, { teamName: 'T', description: '', memberOrder: ['researcher'] }), /missing roster expert/)
  // Duplicates → loud failure.
  assert.throws(() => expandExecutionPlan(result.plan, { teamName: 'T', description: '', memberOrder: ['researcher', 'researcher', 'data-analyst', 'designer'] }), /must not contain duplicates/)
  // Unknown expert → loud failure.
  assert.throws(() => expandExecutionPlan(result.plan, { teamName: 'T', description: '', memberOrder: ['researcher', 'data-analyst', 'designer', 'ghost'] }), /unknown expert/)
})

// ── 5. planRef provenance ───────────────────────────────────────────────────

test('planRef carries planId/digest/template; scenarioId only when the plan has one', () => {
  const noScenario = compileFanout({ 'role.a': ['researcher'], 'role.b': [] })
  assert.equal(noScenario.ok, true)
  if (!noScenario.ok) return
  const plan = noScenario.plan
  const expanded = expandExecutionPlan(plan, { teamName: 'T', description: '' })
  assert.equal(expanded.planRef.planId, plan.planId)
  assert.equal(expanded.planRef.digest, plan.digest)
  assert.equal(expanded.planRef.templateId, 'tpl-fanout')
  assert.equal(expanded.planRef.templateVersion, '1.0.0')
  assert.equal(expanded.planRef.scenarioId, undefined)

  // With a scenario bound, scenarioId is carried through.
  const pack = basePack()
  const template = fanoutTemplate(pack)
  pack.scenarios.push({
    id: 'scn', version: '1.0.0', schemaVersion: 2, domain: 'd',
    intents: ['i'], requiredCapabilities: [], routingPolicy: { candidateHints: [] },
    teamTemplate: template.id, outputTemplate: 'out', qualityPolicy: 'q',
    knowledgePolicy: { required: [] }, toolPolicy: { allowed: [] },
  })
  const withScenario = compileExecutionPlan({
    pack,
    templateId: template.id,
    scenarioId: 'scn',
    params: { topic: 'T' },
    binding: { assignments: { 'role.a': ['researcher'], 'role.b': [] } },
  })
  assert.equal(withScenario.ok, true)
  if (!withScenario.ok) return
  assert.equal(expandExecutionPlan(withScenario.plan, { teamName: 'T', description: '' }).planRef.scenarioId, 'scn')
})

// ── 6. Determinism ──────────────────────────────────────────────────────────

test('the same plan expands byte-identically every time', () => {
  const result = compileFanout({ 'role.a': ['researcher'], 'role.b': ['data-analyst', 'designer'] })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const opts = { teamName: 'T', description: '', expertDisplay: new Map([['researcher', { name: '王研' }]]) }
  const a = expandExecutionPlan(result.plan, opts)
  const b = expandExecutionPlan(result.plan, opts)
  assert.deepEqual(a, b)
})

// ── 7. taskSuffixes (skill blocks) ──────────────────────────────────────────

test('taskSuffixes append after interpolation (suffix-as-description covered by the V1 golden test)', () => {
  const result = compileFanout({ 'role.a': ['researcher'], 'role.b': ['data-analyst', 'designer'] })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const expanded = expandExecutionPlan(result.plan, {
    teamName: 'T',
    description: '',
    taskSuffixes: {
      t1: '\n\nskill block',
      t4: 'bare block', // t4 (shared task) has a description → appended verbatim
    },
  })
  assert.equal(expanded.tasks[0]?.description, '主题：T\n\nskill block')
  assert.equal(expanded.tasks[3]?.description, '无专家bare block')
})
